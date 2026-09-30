#!/usr/bin/env node
/**
 * `webh` — the command-line face of the harness.
 *
 * Every MCP tool is reachable as a subcommand, which means agents that only have a shell
 * (or you, debugging the harness itself) get the same capability without MCP wiring:
 *
 *   webh tools
 *   webh status
 *   webh navigate --url http://localhost:5173
 *   webh dom_query --selector "#app .card" --limit 5
 *   webh screenshot --fullPage --out shot.png
 *   webh eval --expression "document.title"
 *
 * PROJECT SCOPING. `webh start` puts a project's browser, token and audit trail in
 * <project>/.webh, but that is useless if a later `webh page_eval`, run from the same
 * directory, quietly writes to the harness checkout's state instead — you would be
 * inspecting the right browser and recording it in the wrong project. So when the working
 * directory looks like a project that has been started already (it has a .webh), every
 * command is scoped there.
 *
 * The detection runs BEFORE the imports below, via a re-exec, because config.mjs caches
 * process.env at import time and ESM imports are hoisted — by the time module code could
 * set the variable, config would already have read it.
 */
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath as __fileURLToPath } from 'node:url';

/**
 * Everything that reads config must be imported DYNAMICALLY, below the scoping check.
 * ESM hoists static imports and evaluates them before any module body runs, so a static
 * `import { config } from './lib/config.mjs'` here would read process.env before the
 * re-exec below could ever set it — leaving the scoping silently ineffective.
 */
let Harness;
let invoke;
let listTools;
let getTool;
let toolNames;
let config;
let flushAudit;

if (!process.env.WEBH_PROJECT_DIR && !process.env.WEBH_STATE_DIR && !process.env.WEBH_SCOPED) {
  const cwd = process.cwd();
  const harnessRoot = path.resolve(path.dirname(__fileURLToPath(import.meta.url)), '..');
  // Only adopt the cwd when it is NOT the harness checkout itself (which has its own .webh)
  // and it already carries project state, which is the signal `webh start` was run here.
  if (cwd !== harnessRoot && fs.existsSync(path.join(cwd, '.webh'))) {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [__fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, WEBH_PROJECT_DIR: cwd, WEBH_SCOPED: '1' },
    });
    process.exit(res.status ?? 1);
  }
}

({ Harness } = await import('./lib/harness.mjs'));
({ invoke, listTools, getTool, toolNames } = await import('./lib/tools/index.mjs'));
({ config } = await import('./lib/config.mjs'));
({ flushAudit } = await import('./lib/audit.mjs'));

const VERSION = '0.1.0';

const USAGE = `webh ${VERSION} — give an agent a live browser session

USAGE
  webh <tool> [--flag value ...]        run one tool
  webh start [--dir DIR] [--url URL]    one-command setup for a project: browser + daemon
  webh tools [--json]                   list every tool
  webh help [tool]                      describe one tool
  webh status                           browser + guardrail status
  webh screenshot [--out FILE]          shortcut for page_screenshot
  webh audit [--limit N] [--clear]      inspect what the agent changed
  webh close [--force]                  close the browser
  webh daemon                           run the local daemon for the browser side panel
  webh token [--copy]                   print the daemon token for the side panel

COMMON FLAGS
  --json              print only the machine-readable result payload
  --quiet             suppress the human summary
  --cdp PORT          talk to a browser on PORT instead of discovering one
  --headed            launch with a visible window
  --fresh             launch a new browser even if one is running
  --close             shut the browser down when this command finishes
  --url URL           navigate after connecting

SESSION BEHAVIOUR
  The browser is deliberately left running between commands so page state accumulates:
  click a button with one command, inspect the result with the next. Use \`webh close\`
  (or --close) when you are done. Set WEBH_KEEP_ALIVE=0 to close after every command.

EXAMPLES
  webh page_snapshot --includeHtml
  webh dom_query --selector "nav a" --limit 10
  webh page_computed_style --selector "#hero" --properties display,color
  webh page_interact --action click --text "Sign in"
  webh page_interact --action type --selector "#email" --value me@example.com
  webh page_eval --expression "(() => document.querySelectorAll('.card').length)()"
  webh page_console --level error
  webh page_network --failedOnly

Environment: WEBH_HEADLESS=0 for a visible browser, WEBH_STATE_DIR to relocate state,
WEBH_ALLOW_FORM_SUBMIT=1 / WEBH_ALLOW_REMOTE_NAVIGATION=1 to relax guardrails.`;

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/** Coerce a CLI string into the type the tool's schema declares. */
function coerce(value, schema = {}) {
  if (value === true) return schema.type === 'boolean' ? true : true;
  if (Array.isArray(value)) return value;
  const s = String(value);
  switch (schema.type) {
    case 'integer': {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : s;
    }
    case 'number': {
      const n = Number(s);
      return Number.isFinite(n) ? n : s;
    }
    case 'boolean':
      return !['false', '0', 'no', 'off', ''].includes(s.toLowerCase());
    case 'array':
      return s.split(',').map((x) => x.trim()).filter(Boolean);
    case 'object':
      try { return JSON.parse(s); } catch { return s; }
    default:
      return s;
  }
}

/**
 * Flags the CLI consumes itself and must NOT forward to the tool. `url` is deliberately
 * absent: it is a real tool argument (browser_open, page_navigate), and swallowing it here
 * meant those tools reported it as missing.
 */
const META_FLAGS = new Set(['json', 'quiet', 'cdp', 'headed', 'fresh', 'out', 'close', 'help', 'h']);

function buildArgs(tool, flags) {
  const props = tool?.inputSchema?.properties ?? {};
  const args = {};
  for (const [k, v] of Object.entries(flags)) {
    if (META_FLAGS.has(k)) continue;
    args[k] = coerce(v, props[k] ?? {});
  }
  return args;
}

function printTools(json) {
  const tools = listTools();
  if (json) {
    process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
    return;
  }
  for (const t of tools) {
    const props = t.inputSchema?.properties ?? {};
    const req = new Set(t.inputSchema?.required ?? []);
    const argList = Object.entries(props)
      .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}:${v.type ?? 'any'}`)
      .join(' ');
    process.stdout.write(`${t.name}\n    ${t.description}\n    args: ${argList || '(none)'}\n\n`);
  }
}

function printToolHelp(name) {
  const tool = getTool(name);
  if (!tool) {
    process.stderr.write(`Unknown tool "${name}".\nRun \`webh tools\` to see all ${toolNames().length} tools.\n`);
    return 1;
  }
  const props = tool.inputSchema?.properties ?? {};
  const req = new Set(tool.inputSchema?.required ?? []);
  process.stdout.write(`${tool.name}\n\n${tool.description}\n\nARGUMENTS\n`);
  for (const [k, v] of Object.entries(props)) {
    const bits = [v.type ?? 'any'];
    if (v.enum) bits.push(`one of: ${v.enum.join(' | ')}`);
    process.stdout.write(`  --${k}${req.has(k) ? ' (required)' : ''}  [${bits.join(', ')}]\n      ${v.description ?? ''}\n`);
  }
  return 0;
}

function render(result, { json, quiet, out }) {
  const imageData = result.image?.data;
  const wantsFile = out || (!json && imageData);
  if (imageData && wantsFile) {
    const file = path.resolve(out ?? defaultShotPath(result));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(imageData, 'base64'));
    result.data = { ...(result.data ?? {}), savedTo: file };
  }

  if (json) {
    const { image, ...rest } = result;
    process.stdout.write(JSON.stringify({ ...rest, image: image ? { mimeType: image.mimeType, bytes: imageData ? Math.round((imageData.length * 3) / 4) : 0 } : undefined }, null, 2) + '\n');
    return;
  }
  if (result.ok) {
    if (!quiet && result.text) process.stdout.write(result.text + '\n');
    if (imageData && result.data?.savedTo) process.stdout.write(`\n[screenshot written to ${result.data.savedTo}]\n`);
  } else {
    process.stderr.write(`✗ ${result.error}\n`);
    if (result.hint) process.stderr.write(`  hint: ${result.hint}\n`);
    if (result.guardrail) process.stderr.write(`  guardrail: ${result.guardrail}\n`);
    if (result.details) process.stderr.write(`  details: ${JSON.stringify(result.details)}\n`);
  }
}

function defaultShotPath(result) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = result.image?.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  return path.join(config.screenshotsDir, `${stamp}.${ext}`);
}

/** Human-facing summary for `webh start`. */
function renderStart(report, { json } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const p = report.project;
  if (report.error) {
    process.stderr.write(`✗ ${report.error}\n`);
    return;
  }

  const kindText = p.kind === 'empty'
    ? 'empty directory (new project)'
    : p.kind === 'project'
      ? `project (${p.markers.slice(0, 4).join(', ')})`
      : `${p.fileCount} file(s)`;

  const lines = [];
  lines.push('');
  lines.push(`  web-harness — ${report.reused ? 'already running' : 'started'}`);
  lines.push('');
  lines.push(`  project   ${report.project.dir}`);
  lines.push(`            ${kindText}`);
  if (p.resumable) {
    lines.push(`            resuming: ${p.priorSessions} recorded action(s)${p.resumeUrl ? `, last page ${p.resumeUrl}` : ''}`);
  }
  lines.push(`  state     ${report.stateDir}`);
  if (report.browser) {
    lines.push(`  browser   ${report.browser.path}`);
    lines.push(`            debug port ${report.browser.debugPort}, extension ${report.browser.extensionLoaded ? 'loaded' : 'NOT loaded'}`);
    lines.push(`  opened    ${report.url}`);
  }
  if (report.daemon) {
    lines.push(`  daemon    ${report.daemon.endpoint}`);
  }
  lines.push('');
  if (report.reused) {
    lines.push(`  A daemon is already serving this project on port ${report.daemon.port}; left it alone.`);
  } else if (report.daemon?.tokenPresent) {
    lines.push('  Next: open the side panel (Brave toolbar icon) and paste the token:');
    lines.push('');
    lines.push('      webh token');
    lines.push('');
    lines.push('  If the panel is not installed yet: brave://extensions → Developer mode →');
    lines.push(`  Load unpacked → ${path.join(config.root, 'extension')}`);
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

/**
 * Find the subcommand, allowing meta-flags to appear before it.
 *
 * `webh page_navigate --fresh --url X` and `webh --fresh page_navigate --url X` should both
 * work; treating argv[0] as the command made the second form fail with
 * `Unknown command or tool: "--fresh"`. Flag values are skipped so that a value which
 * happens to look like a bare word is never mistaken for the command.
 */
function splitCommand(argv) {
  const FLAGS_WITH_VALUES = new Set(['cdp', 'out', 'url', 'selector', 'text', 'expression', 'value', 'key', 'action', 'limit', 'depth', 'properties', 'targetId', 'urlMatch', 'index', 'level', 'filter', 'timeoutMs', 'pollMs', 'maxElements', 'for', 'format', 'quality', 'port', 'attributes']);
  const before = [];
  let command = null;
  const after = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (command === null) {
      if (a.startsWith('--')) {
        before.push(a);
        const name = a.replace(/^--?/, '').split('=')[0];
        const hasInlineValue = a.includes('=');
        if (!hasInlineValue && FLAGS_WITH_VALUES.has(name) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
          before.push(argv[++i]);
        }
        continue;
      }
      command = a;
      continue;
    }
    after.push(a);
  }
  return { command, argv: [...before, ...after] };
}

async function main() {
  const rawArgv = process.argv.slice(2);
  if (!rawArgv.length || rawArgv[0] === 'help' || rawArgv[0] === '--help' || rawArgv[0] === '-h') {
    const topic = rawArgv[1];
    if (topic && topic !== 'help') process.exit(printToolHelp(topic));
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (rawArgv[0] === '--version' || rawArgv[0] === '-v') {
    process.stdout.write(`webh ${VERSION}\n`);
    return 0;
  }

  const split = splitCommand(rawArgv);
  let command = split.command;
  if (!command) {
    process.stderr.write(`No tool given.\n\n${USAGE}\n`);
    return 2;
  }
  const rest = split.argv;

  // `webh status` is a friendly alias; the real tool is browser_status.
  const ALIASES = {
    status: 'browser_status',
    tools: null,
    screenshot: 'page_screenshot',
    audit: 'page_audit_log',
    close: 'browser_close',
    open: 'browser_open',
    navigate: 'page_navigate',
    eval: 'page_eval',
    snapshot: 'page_snapshot',
    console: 'page_console',
    network: 'page_network',
  };

  if (command === 'tools') {
    printTools(rest.includes('--json'));
    return 0;
  }

  // `start` is the one-command setup: browser + extension + daemon for a project.
  if (command === 'start') {
    const { startProject } = await import('./lib/start.mjs');
    const { flags: startFlags } = parseArgv(rest);
    const projDir = typeof startFlags.dir === 'string' ? startFlags.dir : process.cwd();
    const report = await startProject({ dir: projDir, open: typeof startFlags.url === 'string' ? startFlags.url : null });
    renderStart(report, { json: Boolean(startFlags.json) });
    return report.error ? 1 : 0;
  }

  // `daemon` is a long-lived server, not a tool. Run it in THIS process so Ctrl-C and
  // signals reach it directly instead of through an extra child.
  if (command === 'daemon' || command === 'serve') {
    await import('./daemon.mjs');
    // The daemon installs its own signal handlers and keeps the event loop alive.
    return await new Promise(() => {});
  }

  // Print just the token so it can be piped straight into the panel: `webh token`
  if (command === 'token') {
    const file = path.join(config.stateDir, 'daemon.json');
    // Parse flags HERE: this block runs before the shared `flags` parsing below, and
    // referencing that later binding threw a ReferenceError which the catch swallowed
    // and misreported as "no daemon" — a wrong diagnosis that would send you hunting
    // for a process that was running fine.
    const { flags: tokenFlags } = parseArgv(rest);
    let info;
    try {
      info = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      process.stderr.write(`No running daemon found (${file}). Start one with \`webh daemon\`.\n`);
      return 1;
    }
    if (tokenFlags.copy && process.platform === 'linux') {
      // Best-effort clipboard: xclip/wl-copy may not exist, and that is not fatal.
      try {
        const { execFileSync } = await import('node:child_process');
        const cmd = process.env.WAYLAND_DISPLAY ? 'wl-copy' : 'xclip';
        const args = cmd === 'wl-copy' ? [] : ['-selection', 'clipboard'];
        execFileSync(cmd, args, { input: info.token });
        process.stdout.write(`copied to clipboard (${info.token.length} chars)\n`);
        return 0;
      } catch {
        process.stderr.write('(clipboard tool unavailable; printing instead)\n');
      }
    }
    process.stdout.write(info.token + '\n');
    return 0;
  }
  if (command in ALIASES && ALIASES[command]) command = ALIASES[command];

  const { flags } = parseArgv(rest);
  const tool = getTool(command);
  if (!tool) {
    process.stderr.write(`Unknown command or tool: "${command}".\n\n${USAGE}\n`);
    return 2;
  }

  const harness = new Harness();
  const args = buildArgs(tool, flags);

  // `--url` is a tool argument, but for tools that have no URL of their own it is also a
  // convenient "connect and point at this page first".
  const connectOptions = {
    url: typeof flags.url === 'string' && !(tool.inputSchema?.properties ?? {}).url ? flags.url : null,
    fresh: Boolean(flags.fresh),
    headless: flags.headed ? false : null,
    port: flags.cdp ? Number.parseInt(flags.cdp, 10) : null,
  };

  // browser_close should not first connect; it should report honestly when nothing is open.
  if (tool.name !== 'browser_close' && tool.name !== 'browser_status' && tool.name !== 'page_audit_log') {
    await harness.ensure(connectOptions).catch(() => {});
  }

  const result = await invoke(harness, tool.name, args);
  render(result, { json: Boolean(flags.json), quiet: Boolean(flags.quiet), out: typeof flags.out === 'string' ? flags.out : null });
  await flushAudit();
  // Release, don't kill: the browser keeps its page state for the next command.
  await harness.release({ close: Boolean(flags.close) || process.env.WEBH_KEEP_ALIVE === '0' }).catch(() => {});
  return result.ok ? 0 : 1;
}

main()
  .then(async (code) => {
    await flushAudit().catch(() => {});
    process.exit(code ?? 0);
  })
  .catch(async (err) => {
    process.stderr.write(`webh crashed: ${err?.stack ?? err}\n`);
    await flushAudit().catch(() => {});
    process.exit(1);
  });
