import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'page.html'));

/**
 * Start the fixture page server on an ephemeral port.
 * Ephemeral matters: a fixed port collides with whatever the developer already has
 * running and turns a green suite red for no reason.
 */
export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(FIXTURE_HTML);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}/` });
    });
  });
}

/** A fresh, isolated state dir so tests never touch the developer's real .webh. */
export function makeStateDir(label = 'e2e') {
  const dir = path.join(ROOT, 'test', 'tmp', `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * Environment that points the harness at its own state dir and its own browser port.
 *
 * The attach port is pointed at a deliberately closed port so tests NEVER bind to a
 * browser the developer happens to have running. Without this they silently attach to it,
 * and the suite then depends on that browser's state: it fails to assert a launched pid,
 * drives whatever tabs the human had open, and navigates their real session mid-test.
 */
export function harnessEnv(stateDir, launchPort) {
  return {
    ...process.env,
    WEBH_STATE_DIR: stateDir,
    WEBH_LAUNCH_PORT: String(launchPort),
    WEBH_ATTACH_PORT: '9', // nothing listens here: force every test to launch its own
    WEBH_LOG_LEVEL: 'error',
    // Never let a developer's exported guardrail overrides leak into the tests.
    WEBH_ALLOW_FORM_SUBMIT: '',
    WEBH_ALLOW_REMOTE_NAVIGATION: '',
    WEBH_ALLOW_DOWNLOADS: '',
  };
}

/** Run the CLI once and resolve with its exit code and streams. */
export function runCli(args, { env, timeoutMs = 90_000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/**
 * A line-delimited JSON-RPC client for the MCP stdio server.
 * Buffers frames so tests can await a specific response id.
 */
export class McpClient {
  constructor({ env } = {}) {
    this.child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp.mjs')], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.child.stdout.on('data', (d) => {
      this.buffer += d;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === undefined) continue;
        const waiter = this.pending.get(msg.id);
        if (waiter) { this.pending.delete(msg.id); waiter(msg); }
      }
    });
  }

  request(method, params = {}, timeoutMs = 90_000) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** Call a tool and return the text of its first text content block. */
  async callTool(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    const content = res.result?.content ?? [];
    const text = content.find((c) => c.type === 'text')?.text ?? '';
    return { isError: res.result?.isError === true, text, content, error: res.error };
  }

  async close() {
    try { this.child.stdin.end(); } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} resolve(); }, 8000);
      this.child.on('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}

/** Poll the CDP version endpoint until the browser is up. */
export async function waitForBrowser(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** Kill any browser process started by a test, by pid from its session file. */
export function killBrowserFromStateDir(stateDir) {
  try {
    const session = JSON.parse(fs.readFileSync(path.join(stateDir, 'session.json'), 'utf8'));
    if (session?.pid) {
      try { process.kill(session.pid, 'SIGKILL'); } catch {}
    }
  } catch {}
}
