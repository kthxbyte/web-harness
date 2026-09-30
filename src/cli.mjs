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
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Harness } from './lib/harness.mjs';
import { invoke, listTools, getTool, toolNames } from './lib/tools/index.mjs';
import { config } from './lib/config.mjs';
import { flushAudit } from './lib/audit.mjs';

const VERSION = '0.1.0';

const USAGE = `webh ${VERSION} — give an agent a live browser session

USAGE
  webh <tool> [--flag value ...]        run one tool
  webh tools [--json]                   list every tool
  webh help [tool]                      describe one tool
  webh status                           browser + guardrail status
  webh screenshot [--out FILE]          shortcut for page_screenshot
  webh audit [--limit N] [--clear]      inspect what the agent changed
  webh close [--force]                  close the browser

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
