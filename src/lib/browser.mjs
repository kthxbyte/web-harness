import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';
import { Connection, PageSession } from './cdp.mjs';
import { ConnectionError, ToolError } from './errors.mjs';
import { log } from './log.mjs';
import { readSessionFile, writeSessionFile, patchSession, clearSessionFile, pidAlive } from './session.mjs';

export { readSessionFile, writeSessionFile, patchSession, clearSessionFile, pidAlive };

export const CANDIDATE_BROWSERS = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
  'msedge',
  'brave-browser',
];

const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

export function resolveBrowserPath() {
  if (config.browserPath) return config.browserPath;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of CANDIDATE_BROWSERS) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  for (const p of MAC_PATHS) if (isExecutable(p)) return p;
  return null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function httpJson(url, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe an HTTP endpoint for a live remote-debugging browser. */
export async function probe(port = config.attachPort, host = config.attachHost) {
  const base = `http://${host}:${port}`;
  const version = await httpJson(`${base}/json/version`);
  if (!version?.webSocketDebuggerUrl) return null;
  return { base, port, host, version, wsUrl: version.webSocketDebuggerUrl };
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Ensure the directories Chromium and our screenshots need actually exist. */
async function ensureDirs() {
  const fsp = await import('node:fs/promises');
  await fsp.mkdir(config.stateDir, { recursive: true });
  await fsp.mkdir(config.profileDir, { recursive: true });
  await fsp.mkdir(config.tmpDir, { recursive: true });
}

/**
 * Find a browser to talk to. Order of preference:
 *   1. a browser we previously launched that is still alive  (reuse our own)
 *   2. a browser you started yourself with --remote-debugging-port  (your real session)
 * Returns null when nothing is listening.
 */
export async function discover({ preferPort = null } = {}) {
  const prior = await readSessionFile();

  if (prior?.pid) {
    const found = await probe(prior.port);
    if (found) {
      return { ...found, owned: true, pid: prior.pid, launchedAt: prior.launchedAt, lastUrl: prior.lastUrl };
    }
    // The browser we launched is gone. Clear only the stale process fields — we must KEEP
    // lastUrl, because that is what lets the next invocation restore the user's page.
    log.debug(`browser pid ${prior.pid} on port ${prior.port} is gone; keeping remembered url`);
    await patchSession({ pid: null, port: null, wsUrl: null, browser: null });
  }

  const ports = preferPort ? [preferPort] : [config.attachPort, config.launchPort];
  for (const port of ports) {
    const found = await probe(port);
    if (found) return { ...found, owned: false, pid: null, lastUrl: prior?.lastUrl ?? null };
  }
  return null;
}

export async function launch({ port = config.launchPort, browserPath = null, headless = config.headless, url = 'about:blank' } = {}) {
  const bin = browserPath ?? resolveBrowserPath();
  if (!bin) {
    throw new ConnectionError('No Chromium-based browser found on this machine.', {
      hint: `Install one, or point WEBH_BROWSER_PATH at its binary. Looked for: ${CANDIDATE_BROWSERS.join(', ')}.`,
    });
  }

  // Refuse to launch if one is already listening here — avoids two browsers fighting over a port.
  const existing = await probe(port);
  if (existing) return { ...existing, owned: false, pid: null, reused: true };

  await ensureDirs();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${config.profileDir}`,
    `--window-size=${config.viewport.width},${config.viewport.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-component-update',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-dev-shm-usage',
  ];
  if (!config.allowDownloads) args.push('--download-dir=' + path.join(config.tmpDir, 'downloads'));
  if (process.env.WEBH_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  if (headless) args.push('--headless=new');
  if (process.platform === 'linux' && !process.env.DISPLAY && !headless) {
    log.warn('no DISPLAY set; launching headless anyway');
    args.push('--headless=new');
  }
  args.push(url || 'about:blank');

  log.info(`launching ${bin} (port ${port}, headless=${headless || (!process.env.DISPLAY && process.platform === 'linux')})`);
  const child = spawn(bin, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
    env: { ...process.env, WEBH_LAUNCHED: '1' },
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });

  let exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = { code, signal }; });
  child.unref();

  const deadline = Date.now() + config.launchTimeoutMs;
  while (Date.now() < deadline) {
    if (exitInfo) break;
    const found = await probe(port);
    if (found) {
      await writeSessionFile({
        pid: child.pid,
        port,
        host: config.attachHost,
        browser: found.version?.Browser ?? 'unknown',
        wsUrl: found.wsUrl,
        profileDir: config.profileDir,
        launchedAt: new Date().toISOString(),
      });
      // Only an explicit non-blank URL updates what we remember; launching a blank
      // browser must not erase the page the previous invocation was on.
      if (url && url !== 'about:blank') await patchSession({ lastUrl: url });
      log.info(`browser ready: ${found.version?.Browser} (pid ${child.pid}, port ${port})`);
      return { ...found, owned: true, pid: child.pid, browserPath: bin };
    }
    await sleep(150);
  }

  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  const tail = stderr.trim().split('\n').slice(-6).join('\n');
  throw new ConnectionError(
    exitInfo
      ? `Browser exited during startup (code ${exitInfo.code}${exitInfo.signal ? `, signal ${exitInfo.signal}` : ''}).`
      : `Browser did not open a DevTools port on ${port} within ${config.launchTimeoutMs}ms.`,
    {
      hint: process.platform === 'linux'
        ? 'Headless Chromium in containers commonly needs extra flags. Retry with WEBH_NO_SANDBOX=1 if you are in a container, or set WEBH_BROWSER_PATH.'
        : 'Set WEBH_BROWSER_PATH if the default binary is wrong.',
      details: tail ? { browserStderr: tail } : undefined,
    },
  );
}

/** A live browser plus its page sessions. */
export class Browser {
  constructor(conn, meta = {}) {
    this.conn = conn;
    this.meta = meta;
    this.pages = new Map(); // targetId -> PageSession
    this.current = null; // targetId
    this.closed = false;
    this._targetListener = null;
  }

  static async attach(discovered) {
    const conn = await Connection.connect(discovered.wsUrl, { label: 'browser' });
    const browser = new Browser(conn, discovered);
    conn.on('Target.targetDestroyed', ({ targetId }) => {
      const page = browser.pages.get(targetId);
      if (page) {
        browser.pages.delete(targetId);
        if (browser.current === targetId) browser.current = null;
      }
    });
    conn.on('Target.targetInfoChanged', ({ targetInfo }) => {
      const page = browser.pages.get(targetInfo.targetId);
      if (page && targetInfo.url) page.url = targetInfo.url;
    });
    await conn.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    return browser;
  }

  get version() {
    return this.meta.version?.Browser ?? 'unknown';
  }

  get owned() {
    return Boolean(this.meta.owned);
  }

  async listTargets() {
    const { targetInfos = [] } = await this.conn.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'page' || t.type === 'tab' || t.type === 'webview');
  }

  /** Attach to a page. `targetId` omitted => current page, else first page, else about:blank. */
  async usePage(targetId = null) {
    if (targetId && this.pages.has(targetId)) {
      this.current = targetId;
      return this.pages.get(targetId);
    }
    const targets = await this.listTargets();
    let chosen = null;
    if (targetId) chosen = targets.find((t) => t.targetId === targetId);
    if (!chosen && this.current) chosen = targets.find((t) => t.targetId === this.current);
    if (!chosen) chosen = targets.find((t) => !String(t.url).startsWith('devtools://')) ?? targets[0];
    if (!chosen) {
      const created = await this.conn.send('Target.createTarget', { url: 'about:blank' });
      chosen = { targetId: created.targetId, url: 'about:blank', title: '' };
    }
    return this.attachTo(chosen);
  }

  async attachTo(target) {
    const existing = this.pages.get(target.targetId);
    if (existing) {
      this.current = target.targetId;
      return existing;
    }
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const page = new PageSession(this.conn, { sessionId, targetId: target.targetId, url: target.url, title: target.title });
    await page.enableDomains({ network: true });
    try {
      const info = await page.send('Target.getTargetInfo');
      page.url = info.targetInfo?.url ?? page.url;
      page.title = info.targetInfo?.title ?? page.title;
    } catch {}
    this.pages.set(target.targetId, page);
    this.current = target.targetId;
    return page;
  }

  async currentPage() {
    if (this.current && this.pages.has(this.current)) return this.pages.get(this.current);
    return this.usePage();
  }

  async newPage(url = 'about:blank') {
    const created = await this.conn.send('Target.createTarget', { url });
    return this.attachTo({ targetId: created.targetId, url });
  }

  async closePage(targetId = null) {
    const id = targetId ?? this.current;
    if (!id) return { closed: false, reason: 'no page attached' };
    const page = this.pages.get(id);
    if (page) {
      try { await this.conn.send('Target.detachFromTarget', { sessionId: page.sessionId }); } catch {}
      page.dispose();
      this.pages.delete(id);
    }
    try {
      await this.conn.send('Target.closeTarget', { targetId: id });
    } catch {}
    if (this.current === id) this.current = null;
    return { closed: true, targetId: id };
  }

  /** Shut down the browser process, but only if we were the one that started it. */
  async shutdown() {
    this.closed = true;
    try { await this.conn.send('Browser.close'); } catch {}
    this.conn.close();
    const prior = await readSessionFile();
    if (prior?.pid) {
      for (let i = 0; i < 40; i++) {
        if (!pidAlive(prior.pid)) break;
        await sleep(100);
      }
      if (pidAlive(prior.pid)) {
        try { process.kill(-prior.pid, 'SIGKILL'); } catch { try { process.kill(prior.pid, 'SIGKILL'); } catch {} }
      }
    }
    await clearSessionFile();
    this.pages.clear();
  }
}

export async function openBrowser({ port = null, url = 'about:blank', fresh = false, headless = null } = {}) {
  const targetPort = port ?? config.launchPort;
  let discovered = null;

  if (!fresh) discovered = await discover({ preferPort: port });

  if (!discovered) {
    discovered = await launch({ port: targetPort, url, ...(headless === null ? {} : { headless }) });
  } else if (url && url !== 'about:blank') {
    // Browser already running: open the requested URL in a new page.
    const browser = await Browser.attach(discovered);
    const page = await browser.newPage(url);
    return { browser, page };
  }

  const browser = await Browser.attach(discovered);
  const page = await browser.usePage();
  return { browser, page };
}
