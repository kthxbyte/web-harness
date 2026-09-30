import http from 'node:http';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { log } from './log.mjs';
import { ToolError } from './errors.mjs';
import { invoke, listTools, toolNames } from './tools/index.mjs';
import { flushAudit } from './audit.mjs';

/**
 * Local HTTP/WebSocket daemon: the bridge between a browser-extension side panel and the
 * CDP connection this process owns.
 *
 * THREAT MODEL — read before changing the auth code.
 *
 * This server executes arbitrary JavaScript in the user's browser. Binding it to
 * 127.0.0.1 is NOT sufficient protection: any web page the user visits can issue requests
 * to localhost (a "localhost daemon" attack). If we accepted those, a malicious page could
 * drive the user's own browser, read their logged-in sessions, and exfiltrate via the
 * daemon's responses.
 *
 * Three independent defences, all required:
 *
 *   1. Token      — 32 random bytes, checked with a timing-safe compare, so a page cannot
 *                   guess it and a timing oracle cannot recover it byte by byte.
 *   2. Origin     — requests carrying a web `Origin` are rejected outright. Extensions send
 *                   `chrome-extension://<id>`; browsers always attach `Origin` to
 *                   cross-origin requests, so a page cannot suppress this header.
 *   3. Bind scope — 127.0.0.1 only, never 0.0.0.0, so nothing off-host can reach it even on
 *                   a machine without a firewall.
 *
 * The token is written to a 0600 file for the extension to read during setup; it is never
 * returned by an unauthenticated endpoint.
 */

const ALLOWED_ORIGIN_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:', 'safari-web-extension:']);

/**
 * Is this request from a browser extension rather than a web page?
 *
 * Parsed, not prefix-matched. A `startsWith('chrome-extension://')` check passes
 * `https://evil.com/chrome-extension://x`, because the allowed string can appear anywhere
 * inside a hostile value. Comparing the parsed protocol removes that whole class of bug.
 *
 * An absent Origin is allowed: extension service workers and `fetch` from an extension
 * page omit it, and browsers always attach it to cross-origin requests, so a web page
 * cannot suppress it.
 */
function isAllowedOrigin(origin) {
  if (origin === undefined || origin === null || origin === '') return true;
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    return false; // unparseable: refuse rather than guess
  }
  return ALLOWED_ORIGIN_PROTOCOLS.has(parsed.protocol);
}

/** Constant-time compare that tolerates differing lengths without leaking them. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  // timingSafeEqual throws on length mismatch, so hash both to a fixed width first.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

async function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new ToolError(`Request body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new ToolError(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // Belt and braces: no browser page should ever be able to read a response.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export class Daemon {
  constructor({ harness, host = '127.0.0.1', port = 8790, token = null } = {}) {    this.harness = harness;
    this.host = host;
    this.port = port;
    this.token = token ?? crypto.randomBytes(32).toString('hex');
    this.server = null;
    this.startedAt = null;
    /** Which tab tool calls target. Set by the extension; null => daemon picks. */
    this.activeTab = null;
    this.commandCount = 0;
    this.lastError = null;
    this.log = [];
  }

  get address() {
    const a = this.server?.address();
    if (!a || typeof a === 'string') return null;
    return { host: a.address, port: a.port };
  }

  #record(entry) {
    this.log.push({ at: new Date().toISOString(), ...entry });
    if (this.log.length > 200) this.log.shift();
  }

  /** Where the extension reads the token from. 0600 so other users cannot read it. */
  async writeTokenFile() {
    const file = path.join(config.stateDir, 'daemon.json');
    await fsp.mkdir(config.stateDir, { recursive: true });
    const addr = this.address;
    await fsp.writeFile(
      file,
      JSON.stringify(
        {
          version: 1,
          url: `http://${this.host}:${addr?.port ?? this.port}`,
          // `port` is recorded explicitly, not just embedded in `url`: consumers deciding
          // whether this daemon is still reachable need the number, not a string to parse.
          port: addr?.port ?? this.port,
          host: this.host,
          token: this.token,
          pid: process.pid,
          startedAt: this.startedAt,
          /**
           * The browser this daemon attached to. `webh start` reads these to decide
           * whether a project already has a browser running: the browser holds a lock on
           * its profile, so launching a second one silently forwards and exits rather
           * than opening the port we asked for.
           */
          browserPid: Number(process.env.WEBH_PROJECT_BROWSER_PID) || null,
          browserPort: this.harness?.browser?.meta?.port ?? (Number(process.env.WEBH_PROJECT_BROWSER_PORT) || null),
          projectDir: process.env.WEBH_PROJECT_DIR ?? null,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return file;
  }

  async start() {
    if (this.server) return this;
    this.startedAt = new Date().toISOString();

    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        log.error(`daemon request failed: ${err?.stack ?? err}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      });
    });

    // The panel needs long-lived state (which tab, recent results), so upgrade on demand.
    this.server.on('upgrade', (req, socket) => this.#handleUpgrade(req, socket));

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });

    await this.writeTokenFile();
    log.info(`daemon listening on http://${this.host}:${this.address?.port}`);
    return this;
  }

  async stop() {
    await flushAudit().catch(() => {});
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  /**
   * Resolve which page a command should act on.
   *
   * The extension is authoritative: it knows the browser's active tab, which CDP cannot
   * report. We match that announcement against real CDP targets rather than trusting a
   * targetId blindly, so a stale announcement cannot silently address a closed tab.
   */
  async #resolveTarget(requested) {
    const want = requested ?? this.activeTab;
    if (!want) return { page: null, reason: 'no active tab announced; using daemon default' };

    if (!this.harness.connected) return { page: null, reason: 'no browser attached yet' };

    const targets = await this.harness.browser.listTargets();
    let match = null;
    if (want.targetId) match = targets.find((t) => t.targetId === want.targetId);
    if (!match && want.url) match = targets.find((t) => t.url === want.url);
    if (!match && want.urlMatch) match = targets.find((t) => String(t.url).includes(want.urlMatch));

    if (!match) {
      return { page: null, reason: `announced tab is gone (${want.url ?? want.targetId ?? 'unknown'})`, fallenBack: true };
    }
    const page = await this.harness.browser.attachTo(match);
    this.harness.page = page;
    return { page, reason: null };
  }

  async #handle(req, res) {
    const url = new URL(req.url, `http://${this.host}`);
    const route = url.pathname;

    // --- origin gate: applies to EVERY route, including discovery -------------------
    // A web page must not even be able to probe whether the daemon is running. Doing this
    // before /health (rather than after) is deliberate: an unauthenticated endpoint that
    // answers to any origin is a port-scan oracle for a hostile page.
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      this.#record({ event: 'denied', route, reason: 'origin', origin });
      log.warn(`daemon refused request from origin ${origin}`);
      sendJson(res, 403, { ok: false, error: 'This endpoint is only reachable from the web-harness extension.' });
      return;
    }

    // --- unauthenticated: discovery only, leaks nothing sensitive -------------------
    if (route === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'web-harness-daemon',
        version: '0.1.0',
        startedAt: this.startedAt,
        browserConnected: Boolean(this.harness.connected),
        tools: toolNames().length,
      });
      return;
    }

    /**
     * Unauthenticated discovery: lets the panel tell "no daemon" apart from "daemon but
     * I have no token", which are very different problems for the user to fix.
     *
     * It reports ONLY things the panel could already infer by probing the port. It must
     * never return the token: an unauthenticated endpoint handing out a credential would
     * collapse the whole auth model to "know the port", which any web page can do.
     */
    if (route === '/manifest') {
      sendJson(res, 200, {
        ok: true,
        data: {
          service: 'web-harness-daemon',
          version: '0.1.0',
          requiresToken: true,
          hint: 'Get the token with `webh token`, then paste it into the panel settings.',
        },
      });
      return;
    }

    // CORS preflight. The origin gate above has already run, so anything reaching here is
    // either extension-originated or has no Origin at all.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin ?? '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-webh-token',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    const presented = req.headers['x-webh-token'] ?? url.searchParams.get('token');
    if (!presented || !safeEqual(presented, this.token)) {
      this.#record({ event: 'denied', route, reason: 'token' });
      log.warn(`daemon refused request with ${presented ? 'a wrong token' : 'no token'}`);
      sendJson(res, 401, { ok: false, error: 'Missing or invalid token. Read it from .webh/daemon.json.', hint: 'The extension reads this automatically; a browser page cannot.' });
      return;
    }

    const corsHeaders = origin ? { 'access-control-allow-origin': origin } : {};

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};

      switch (route) {
        case '/state': {
          const state = await this.#state();
          sendJson(res, 200, { ok: true, data: state, ...corsHeaders });
          return;
        }

        case '/tools': {
          sendJson(res, 200, { ok: true, data: { tools: listTools() }, ...corsHeaders });
          return;
        }

        case '/pages': {
          if (!this.harness.connected) await this.harness.ensure().catch(() => {});
          const pages = await this.harness.pages().catch((err) => ({ error: err.message, pages: [] }));
          sendJson(res, 200, { ok: true, data: { ...pages, activeTab: this.activeTab }, ...corsHeaders });
          return;
        }

        case '/tab': {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST required' });
            return;
          }
          this.activeTab = body.tab ?? body ?? null;
          this.#record({ event: 'tab.active', tab: this.activeTab });
          sendJson(res, 200, { ok: true, data: { activeTab: this.activeTab }, ...corsHeaders });
          return;
        }

        case '/command': {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'POST required' });
            return;
          }
          const { tool, args = {}, tab = null } = body;
          if (!tool) {
            sendJson(res, 400, { ok: false, error: '`tool` is required' });
            return;
          }

          // Point the harness at the tab the extension is showing before running.
          let targetNote = null;
          if (tool !== 'browser_status' && tool !== 'page_audit_log') {
            const resolved = await this.#resolveTarget(tab);
            targetNote = resolved.reason;
          }

          const result = await invoke(this.harness, tool, args, { quiet: true });
          this.commandCount += 1;
          if (!result.ok) this.lastError = { at: new Date().toISOString(), tool, error: result.error };
          this.#record({ event: 'command', tool, ok: result.ok, ms: result.durationMs, targetNote });

          sendJson(res, 200, {
            ok: result.ok,
            data: {
              ok: result.ok,
              tool,
              text: result.text,
              error: result.error,
              hint: result.hint,
              guardrail: result.guardrail,
              details: result.details,
              durationMs: result.durationMs,
              // Images are returned inline; the panel renders them directly.
              image: result.image ? { mimeType: result.image.mimeType, data: result.image.data } : undefined,
              targetNote,
            },
            ...corsHeaders,
          });
          return;
        }

        case '/log': {
          sendJson(res, 200, { ok: true, data: { entries: this.log.slice(-100) }, ...corsHeaders });
          return;
        }

        default:
          sendJson(res, 404, { ok: false, error: `Unknown route ${route}` });
      }
    } catch (err) {
      const status = err instanceof ToolError ? 400 : 500;
      this.lastError = { at: new Date().toISOString(), error: err.message };
      sendJson(res, status, { ok: false, error: err.message, hint: err.hint, ...corsHeaders });
    }
  }

  async #state() {
    const status = await this.harness.status().catch((err) => ({ error: err.message }));
    return {
      daemon: {
        pid: process.pid,
        startedAt: this.startedAt,
        port: this.address?.port ?? this.port,
        commandCount: this.commandCount,
        endpoint: `http://${this.host}:${this.address?.port ?? this.port}`,
      },
      activeTab: this.activeTab,
      browserConnected: Boolean(this.harness.connected),
      browser: status?.browser ?? null,
      currentPage: status?.currentPage ?? null,
      guardrails: status?.guardrails ?? null,
      lastError: this.lastError,
    };
  }

  /**
   * WebSocket upgrade for live updates.
   *
   * Deliberately minimal: we accept the socket, then only ever write JSON frames. The
   * panel's needs are small (tab / result / log), and a hand-rolled frame writer is far
   * less surface area than a full WebSocket implementation. Clients that only need
   * request/response can ignore this and poll.
   */
  #handleUpgrade(req, socket) {
    const url = new URL(req.url, `http://${this.host}`);
    const presented = url.searchParams.get('token');
    const origin = req.headers.origin;
    // Never echo the reason to an unauthenticated socket: that is an oracle.
    if (!isAllowedOrigin(origin) || !presented || !safeEqual(presented, this.token)) {
      this.#record({ event: 'denied', route: 'ws', reason: 'token-or-origin' });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const client = { socket, alive: true };
    this._clients = this._clients ?? new Set();
    this._clients.add(client);
    socket.on('close', () => this._clients.delete(client));
    socket.on('error', () => this._clients.delete(client));
    socket.on('data', () => {}); // ignore inbound frames for this milestone
    this.#sendFrame(client, { type: 'hello', state: { activeTab: this.activeTab } });
    log.debug('daemon websocket client connected');
  }

  /** Write one unmasked text frame (server-to-client frames must not be masked). */
  #sendFrame(client, obj) {
    if (!client.alive) return;
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      client.socket.write(Buffer.concat([header, payload]));
    } catch {
      client.alive = false;
      this._clients?.delete(client);
    }
  }

  /** Broadcast an event to any connected panels. */
  broadcast(obj) {
    for (const client of this._clients ?? []) this.#sendFrame(client, obj);
  }
}

export { safeEqual, isAllowedOrigin };
