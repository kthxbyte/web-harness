import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';
import { ensureSelfIgnoring } from './session.mjs';
import { resolveBrowserPath, probe } from './browser.mjs';
import { log } from './log.mjs';

/**
 * One command to bring up everything for a project.
 *
 * Two ideas are doing the work here:
 *
 *   1. The PROJECT is the working directory. Its state (session, audit, browser profile)
 *      lives in <project>/.webh, so two projects never share a browser profile or an audit
 *      trail, and you can tell at a glance whether a project has been used before.
 *   2. The BROWSER gets a port of its own. Reusing a well-known port would collide with a
 *      debugging browser the user already has open — and because Chromium forwards to an
 *      existing instance holding the same user-data-dir rather than erroring, that
 *      collision is silent and looks like "the extension won't load".
 */

/** Files that mean "this is somebody's actual project", not a scratch directory. */
const PROJECT_MARKERS = ['package.json', 'index.html', '.git', 'src', 'public', 'vite.config.js', 'vite.config.ts', 'next.config.js', 'README.md'];

async function dirEntries(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Describe the directory we were pointed at, so the banner can say what it found. */
export async function inspectProject(dir) {
  const entries = await dirEntries(dir);
  const names = entries.map((e) => e.name);
  const visible = names.filter((n) => !n.startsWith('.'));

  const hasState = names.includes('.webh');
  let auditEntries = 0;
  let lastUrl = null;
  if (hasState) {
    try {
      const audit = await fsp.readFile(path.join(dir, '.webh', 'audit.jsonl'), 'utf8');
      auditEntries = audit.split('\n').filter(Boolean).length;
    } catch {}
    try {
      lastUrl = JSON.parse(await fsp.readFile(path.join(dir, '.webh', 'session.json'), 'utf8')).lastUrl ?? null;
    } catch {}
  }

  const markers = names.filter((n) => PROJECT_MARKERS.includes(n));
  const kind = visible.length === 0 && !hasState ? 'empty' : markers.length ? 'project' : 'directory';

  return {
    dir,
    kind,
    fileCount: visible.length,
    markers,
    hasState,
    priorSessions: auditEntries,
    resumeUrl: lastUrl,
    /** `empty` means a scratch/new project: there is nothing to resume. */
    resumable: hasState && (auditEntries > 0 || Boolean(lastUrl)),
  };
}

/** A port of our own that nothing is listening on, so we never collide with the user's browser. */
async function findFreePort(start) {
  for (let port = start; port < start + 200; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  return start;
}

/**
 * Is a web-harness DAEMON listening here?
 *
 * Deliberately not `probe()` from browser.mjs: that talks CDP and requests /json/version,
 * which a daemon answers with 404. Using it here produced a daemon that was plainly running
 * (health checks succeeded) yet was treated as dead on every reuse check, so `webh start`
 * spawned a second daemon each time — exactly the duplicated-CDP-client situation the reuse
 * logic exists to prevent.
 */
async function daemonReachable(port) {
  if (!port) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.service === 'web-harness-daemon' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Is a BROWSER listening here with CDP? Uses the CDP endpoint, which is correct for that. */
async function browserReachable(port) {
  if (!port) return null;
  return probe(port);
}

/**
 * Start a browser with the extension loaded and a daemon that owns it.
 *
 * Idempotent: if a daemon is already serving this project, it reports that and changes
 * nothing, rather than starting a second one that would compete for the CDP connection.
 */
export async function startProject({ dir = process.cwd(), open = null, port = null } = {}) {
  const projectDir = path.resolve(dir);
  const stateDir = path.join(projectDir, '.webh');

  const report = { project: await inspectProject(projectDir), url: null, reused: false };

  await ensureSelfIgnoring(stateDir);
  report.stateDir = stateDir;

  /**
   * Reuse whatever this PROJECT already has running.
   *
   * Checking only the daemon is not enough. The browser holds a singleton lock on its
   * profile, and Chromium reacts to a second launch on that profile by forwarding to the
   * existing instance and exiting — so no new debug port ever opens. Without this check a
   * second `webh start` reports "Browser did not open a debug port", or worse, silently
   * attaches the daemon to a browser it did not start.
   *
   * The daemon records both pids and the browser port at startup, so the project's own
   * state file is the source of truth for what is already running.
   */
  const recorded = await readProjectRuntime(stateDir);

  if (recorded?.daemonPid && pidAlive(recorded.daemonPid)) {
    const alive = await daemonReachable(recorded.daemonPort);
    if (alive) {
      report.reused = true;
      report.browser = recorded.browserPid && pidAlive(recorded.browserPid)
        ? { debugPort: recorded.browserPort, pid: recorded.browserPid, profileDir: path.join(stateDir, 'profile'), extensionLoaded: null }
        : undefined;
      report.daemon = { port: recorded.daemonPort, pid: recorded.daemonPid, endpoint: `http://127.0.0.1:${recorded.daemonPort}`, tokenPresent: true };
      report.url = recorded.url ?? null;
      return report;
    }
  }

  // The daemon is gone but its browser may survive (the browser outlives a daemon restart).
  // Attaching to that browser is both faster and preserves the page you were looking at.
  let existingBrowser = null;
  if (recorded?.browserPid && pidAlive(recorded.browserPid)) {
    existingBrowser = await browserReachable(recorded.browserPort);
  }

  const debugPort = existingBrowser ? recorded.browserPort : await findFreePort(config.attachPort);
  const wantedDaemonPort = port ?? config.daemonPort;
  const daemonPort = await findFreePort(wantedDaemonPort);

  const browserPath = existingBrowser ? null : resolveBrowserPath();
  if (!existingBrowser && !browserPath) {
    report.error = 'No Chromium-based browser found. Set WEBH_BROWSER_PATH.';
    return report;
  }

  const profileDir = path.join(stateDir, 'profile');
  await fsp.mkdir(profileDir, { recursive: true });

  const url = open ?? report.project.resumeUrl ?? recorded?.url ?? 'about:blank';
  let browserPid = recorded?.browserPid ?? null;

  if (existingBrowser) {
    report.browser = {
      path: existingBrowser.version?.Browser ?? 'existing',
      debugPort,
      pid: browserPid,
      profileDir,
      extensionLoaded: null,
      reused: true,
    };
    log.info(`reusing the browser already running for this project on port ${debugPort}`);
  } else {
    const extensionDir = path.join(config.root, 'extension');
    const hasExtension = await fsp.access(extensionDir).then(() => true, () => false);

    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--password-store=basic',
      '--use-mock-keychain',
      '--mute-audio',
    ];
    if (hasExtension) args.push(`--load-extension=${extensionDir}`);
    args.push(url);

    log.info(`starting ${browserPath} (debug port ${debugPort}, profile ${profileDir})`);
    const browser = spawn(browserPath, args, { stdio: 'ignore', detached: true });
    browser.unref();
    browserPid = browser.pid;
    report.browser = { path: browserPath, debugPort, pid: browserPid, profileDir, extensionLoaded: hasExtension };
  }

  // Wait for the debug endpoint BEFORE starting the daemon, so the daemon attaches to this
  // browser instead of launching one of its own. Getting this order wrong was a real bug:
  // the daemon would take the port and the extension would silently never load.
  let browserInfo = existingBrowser;
  for (let i = 0; i < 80 && !browserInfo; i++) {
    browserInfo = await probe(debugPort);
    if (!browserInfo) await new Promise((r) => setTimeout(r, 250));
  }
  if (!browserInfo) {
    report.error = `Browser did not open a debug port on ${debugPort}. Another browser is probably holding this project's profile (${profileDir}).`;
    return report;
  }

  const daemon = spawn(process.execPath, [path.join(config.root, 'src', 'daemon.mjs')], {
    cwd: projectDir,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBH_PROJECT_DIR: projectDir,
      WEBH_PROJECT_BROWSER_PID: String(browserPid ?? ''),
      WEBH_PROJECT_BROWSER_PORT: String(debugPort),
      WEBH_DAEMON_PORT: String(daemonPort),
      WEBH_ATTACH_PORT: String(debugPort),
      WEBH_LAUNCH_PORT: String(debugPort),
    },
  });
  daemon.unref();

  // Wait for the token file the panel instructions point at.
  let token = null;
  for (let i = 0; i < 60; i++) {
    try {
      token = JSON.parse(await fsp.readFile(path.join(stateDir, 'daemon.json'), 'utf8')).token;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  report.daemon = { port: daemonPort, pid: daemon.pid, endpoint: `http://127.0.0.1:${daemonPort}`, tokenPresent: Boolean(token) };
  report.token = token;
  report.url = url;
  return report;
}

/** What a previous `webh start` left running for this project, if anything. */
async function readProjectRuntime(stateDir) {
  try {
    const info = JSON.parse(await fsp.readFile(path.join(stateDir, 'daemon.json'), 'utf8'));
    return {
      daemonPid: info.pid ?? null,
      // Older records only carried `url`; parse the port out of it so a daemon started by
      // an earlier version is still recognised as running.
      daemonPort: info.port ?? (info.url ? Number(new URL(info.url).port) || null : null),
      browserPid: info.browserPid ?? null,
      browserPort: info.browserPort ?? null,
      url: info.url ?? null,
    };
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export { findFreePort };
