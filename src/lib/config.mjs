import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function envStr(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

/**
 * State directory. MUST live somewhere writable: Chromium refuses to start without a
 * writable --user-data-dir, and a sandboxed agent workspace is the one place we are
 * always allowed to write.
 */
const stateDir = path.resolve(envStr('WEBH_STATE_DIR', path.join(ROOT, '.webh')));

export const config = {
  root: ROOT,
  stateDir,
  profileDir: path.join(stateDir, 'profile'),
  auditLog: path.join(stateDir, 'audit.jsonl'),
  sessionFile: path.join(stateDir, 'session.json'),
  screenshotsDir: path.join(stateDir, 'screenshots'),
  tmpDir: path.join(stateDir, 'tmp'),

  /** Where to find a browser already running with remote debugging enabled. */
  attachPort: envInt('WEBH_ATTACH_PORT', 9222),
  attachHost: envStr('WEBH_ATTACH_HOST', '127.0.0.1'),
  /** Port used when we launch our own browser. Picked off the default port to avoid clashing. */
  launchPort: envInt('WEBH_LAUNCH_PORT', 9333),

  browserPath: envStr('WEBH_BROWSER_PATH', null),
  headless: envBool('WEBH_HEADLESS', true),
  viewport: {
    width: envInt('WEBH_VIEWPORT_WIDTH', 1280),
    height: envInt('WEBH_VIEWPORT_HEIGHT', 800),
  },

  /** Guardrails. See src/lib/guardrails.mjs — turning these off is deliberate, logged, and discouraged. */
  allowRemoteNavigation: envBool('WEBH_ALLOW_REMOTE_NAVIGATION', false),
  allowFormSubmit: envBool('WEBH_ALLOW_FORM_SUBMIT', false),
  allowDownloads: envBool('WEBH_ALLOW_DOWNLOADS', false),
  auditMutations: envBool('WEBH_AUDIT_MUTATIONS', true),

  /** Console/network buffers kept per page. Old entries are dropped. */
  maxConsoleEntries: envInt('WEBH_MAX_CONSOLE', 500),
  maxNetworkEntries: envInt('WEBH_MAX_NETWORK', 500),

  /** Protocol calls that hang forever are a stuck agent; fail them. */
  requestTimeoutMs: envInt('WEBH_REQUEST_TIMEOUT_MS', 30_000),
  launchTimeoutMs: envInt('WEBH_LAUNCH_TIMEOUT_MS', 20_000),
  defaultWaitMs: envInt('WEBH_DEFAULT_WAIT_MS', 15_000),

  logLevel: envStr('WEBH_LOG_LEVEL', 'info'),
  /**
   * Keep the launched browser alive after the tool that started it finishes.
   *
   * Essential for the CLI: without it every `webh` call would tear the browser down and
   * page state (a counter you just clicked, a form you just filled) could never
   * accumulate across commands. MCP servers are long-lived, so this only affects one-shot
   * usage. `webh close` is the explicit way to shut down.
   */
  keepAlive: envBool('WEBH_KEEP_ALIVE', true),
  /** Truncation limits keep DOM dumps from swallowing an agent's whole context window. */
  maxResultChars: envInt('WEBH_MAX_RESULT_CHARS', 60_000),
  maxDomNodes: envInt('WEBH_MAX_DOM_NODES', 300),
};

export const hostDescription = {
  platform: os.platform(),
  release: os.release(),
  node: process.version,
};
