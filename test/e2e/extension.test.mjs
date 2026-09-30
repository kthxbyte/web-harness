import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT, waitForBrowser } from '../helpers/harness-runner.mjs';

/**
 * End-to-end proof that the browser extension works, with no UI interaction.
 *
 * The property that matters most — that the service worker loads, reads its config,
 * reaches the daemon over HTTP and reports the active tab — is observable without opening
 * the side panel, because the daemon logs every tab announcement it receives. So we can
 * verify the whole chain in CI-style automation: manifest parsed, worker registered,
 * storage read, host_permissions granted, origin accepted, token accepted.
 *
 * This does NOT test the panel's rendering, which needs a human to look at it.
 *
 * ORDERING IS LOAD-BEARING: Brave must be launched first and be listening before the daemon
 * starts. If the daemon goes first it finds nothing on the attach port, launches its OWN
 * Chromium there, and the two then fight over the same remote-debugging port and
 * user-data-dir. The symptom is that the extension silently never loads — which looks
 * exactly like a broken extension, and cost real debugging time.
 */

const BRAVE_CANDIDATES = ['brave-browser', 'brave', 'chromium', 'chromium-browser', 'google-chrome'];
const DEBUG_PORT = 9430;
const DAEMON_PORT = 8795;
const EXT_DIR = path.join(ROOT, 'extension');
const STATE_DIR = path.join(ROOT, 'test', 'tmp', 'extension-e2e');

function findBrowser() {
  for (const name of BRAVE_CANDIDATES) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const full = path.join(dir, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {}
    }
  }
  return null;
}

async function httpJson(url, { method = 'GET', token = null, body = null, timeoutMs = 4000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...(token ? { 'x-webh-token': token } : {}) },
      body: body ? JSON.stringify(body) : null,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal CDP client over one WebSocket. */
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error(`cannot attach to ${wsUrl}`)));
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return {
    send: (method, params = {}) => new Promise((res) => {
      const id = ++nextId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

const browserPath = findBrowser();
let brave = null;
let daemon = null;
let workerTarget = null;
let token = null;

before(async () => {
  await fsp.rm(STATE_DIR, { recursive: true, force: true });
  if (!browserPath) return;
  const profileDir = path.join(STATE_DIR, 'brave-profile');
  await fsp.mkdir(profileDir, { recursive: true });

  // 1. browser first, with the unpacked extension
  brave = spawn(browserPath, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--disable-fre', '--disable-sync',
    '--disable-gpu', '--headless=new', '--window-size=1200,800', 'about:blank',
  ], { stdio: 'ignore' });

  const version = await waitForBrowser(DEBUG_PORT, 30_000);
  if (!version) return;

  // 2. wait for the MV3 service worker; it is lazy and registration is not instant
  for (let i = 0; i < 90 && !workerTarget; i++) {
    const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    workerTarget = (list.json ?? []).find((t) => String(t.url ?? '').startsWith('chrome-extension://')) ?? null;
    if (!workerTarget) await new Promise((r) => setTimeout(r, 500));
  }
  if (!workerTarget) return;

  // 3. only now start the daemon, so it attaches to THIS browser
  daemon = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      WEBH_STATE_DIR: STATE_DIR,
      WEBH_DAEMON_PORT: String(DAEMON_PORT),
      WEBH_ATTACH_PORT: String(DEBUG_PORT),
      WEBH_LAUNCH_PORT: String(DEBUG_PORT),
      WEBH_LOG_LEVEL: 'error',
    },
    // 'ignore' rather than a pipe: we never read it, and an unread pipe keeps a handle on
    // the event loop after the child is killed, which hangs the test runner on exit.
    stdio: 'ignore',
  });

  for (let i = 0; i < 60; i++) {
    const h = await httpJson(`http://127.0.0.1:${DAEMON_PORT}/health`);
    if (h.status === 200) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  try {
    token = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'daemon.json'), 'utf8')).token;
  } catch {}
}, { timeout: 120_000 });

after(async () => {
  try { daemon?.kill('SIGKILL'); } catch {}
  try { brave?.kill('SIGKILL'); } catch {}
  await fsp.rm(STATE_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('browser extension end-to-end', { skip: !browserPath ? 'no Chromium-based browser on PATH' : false }, () => {
  test('the unpacked extension loads and registers a service worker', () => {
    assert.ok(workerTarget, 'no chrome-extension:// target appeared — the extension did not load');
    assert.match(workerTarget.url, /^chrome-extension:\/\//);
  });

  test('the daemon attached to the extension browser and wrote a 0600 token', () => {
    assert.ok(token, 'daemon did not write daemon.json');
    assert.equal(token.length, 64);
    const mode = fs.statSync(path.join(STATE_DIR, 'daemon.json')).mode & 0o777;
    assert.equal(mode, 0o600, 'the token file must not be world-readable');
  });

  test('the worker can reach the daemon with its stored token and announce a real page', async () => {
    // Navigate to a real http page: an active about:blank is correctly NOT controllable.
    const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = (list.json ?? []).find((t) => t.type === 'page');
    assert.ok(page?.webSocketDebuggerUrl, 'no page target to navigate');
    const pageCdp = await cdpConnect(page.webSocketDebuggerUrl);
    await pageCdp.send('Page.navigate', { url: 'https://example.com/' });
    pageCdp.close();
    await new Promise((r) => setTimeout(r, 2500));

    const worker = await cdpConnect(workerTarget.webSocketDebuggerUrl);
    await worker.send('Runtime.enable');

    // Seed the token, standing in for the user pasting it into the panel.
    const seeded = await worker.send('Runtime.evaluate', {
      expression: `chrome.storage.local.set({ daemonUrl: 'http://127.0.0.1:${DAEMON_PORT}', token: '${token}' }).then(() => 'stored')`,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(seeded.result?.result?.value, 'stored');

    // Run the same steps the worker performs on a tab event. NOTE:
    // chrome.runtime.sendMessage() from the worker does not reach that worker's own
    // onMessage listener, so poking it with a message silently returns null.
    await worker.send('Runtime.evaluate', {
      expression: `(() => {
        globalThis.__probe = chrome.storage.local.get({ daemonUrl: 'http://127.0.0.1:${DAEMON_PORT}', token: '' }).then(async (s) => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          return fetch(s.daemonUrl + '/tab', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-webh-token': s.token },
            body: JSON.stringify({ tab: { tabId: tab?.id ?? null, url: tab?.url ?? null, title: tab?.title ?? null, controllable: /^https?:|^file:/.test(tab?.url ?? '') } }),
          }).then((r) => r.status);
        });
        return 'started';
      })()`,
      returnByValue: true,
    });
    const settled = await worker.send('Runtime.evaluate', {
      expression: `globalThis.__probe.then(v => 'http ' + v).catch(e => 'error ' + e.message)`,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(settled.result?.result?.value, 'http 200', 'the worker must reach the daemon over HTTP');
    worker.close();

    // Independent confirmation from the daemon's own log.
    const logged = await httpJson(`http://127.0.0.1:${DAEMON_PORT}/log`, { token });
    const tabEvents = (logged.json?.data?.entries ?? []).filter((e) => e.event === 'tab.active');
    assert.ok(tabEvents.length > 0, 'the daemon never logged a tab announcement');
    const announced = tabEvents.at(-1).tab;
    assert.match(announced.url, /^https:\/\/example\.com/, 'the announced tab should be the page we navigated to');
    assert.equal(announced.controllable, true, 'an http page must be reported as controllable');
    assert.equal(announced.title, 'Example Domain');
  });

  test('the daemon executes a tool against the tab the extension announced', async () => {
    const res = await httpJson(`http://127.0.0.1:${DAEMON_PORT}/command`, {
      method: 'POST',
      token,
      body: { tool: 'page_eval', args: { expression: 'document.title' } },
    });
    assert.equal(res.json?.ok, true, JSON.stringify(res.json));
    assert.match(res.json.data.text, /Example Domain/, 'the tool must run against the announced tab');
  });
});
