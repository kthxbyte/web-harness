import { EventEmitter } from 'node:events';
import { config } from './config.mjs';
import { ConnectionError, ToolError } from './errors.mjs';
import { log } from './log.mjs';

/**
 * Minimal Chrome DevTools Protocol client over the built-in global WebSocket.
 *
 * The browser-level connection is a single socket that multiplexes many page
 * "sessions" (flatten mode): every message carries an optional sessionId. We keep one
 * id counter for the whole socket, which is what the protocol expects.
 */
export class Connection extends EventEmitter {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #closeReason = null;

  constructor(wsUrl, { label = 'browser' } = {}) {
    super();
    this.setMaxListeners(0);
    this.wsUrl = wsUrl;
    this.label = label;
  }

  static async connect(wsUrl, opts) {
    const conn = new Connection(wsUrl, opts);
    await conn.#open();
    return conn;
  }

  get connected() {
    return this.#ws !== null && this.#ws.readyState === 1 && !this.#closed;
  }

  get closeReason() {
    return this.#closeReason;
  }

  async #open() {
    const ws = new WebSocket(this.wsUrl);
    this.#ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try { ws.close(); } catch {}
        reject(new ConnectionError(`Timed out opening DevTools socket ${this.wsUrl}`, {
          hint: 'The browser may have exited. Call browser_status, then browser_open to start a fresh one.',
        }));
      }, config.requestTimeoutMs);
      const cleanup = () => { clearTimeout(timer); ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onError); };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (ev) => {
        cleanup();
        reject(new ConnectionError(`Cannot open DevTools socket ${this.wsUrl}: ${ev?.message ?? 'connection refused'}`, {
          hint: 'Nothing is listening there. Start a browser with --remote-debugging-port, or use browser_open to launch one.',
        }));
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });

    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close', () => this.#onClose('socket closed by browser'));
    ws.addEventListener('error', (ev) => log.debug(`cdp ${this.label} socket error: ${ev?.message ?? ''}`));
    log.debug(`cdp connected to ${this.wsUrl}`);
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch (err) {
      log.warn(`cdp ${this.label}: unparseable frame (${err.message})`);
      return;
    }

    if (msg.id !== undefined) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(
          new ToolError(`CDP ${entry.method} failed: ${msg.error.message}`, {
            details: { code: msg.error.code, data: msg.error.data },
          }),
        );
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }

    if (msg.method) {
      // sessionId present => event belongs to one page; otherwise it is browser-scoped.
      this.emit('event', msg);
      this.emit(msg.method, msg.params ?? {}, msg.sessionId ?? null);
      if (msg.sessionId) this.emit(`session:${msg.sessionId}:${msg.method}`, msg.params ?? {});
    }
  }

  #onClose(reason) {
    const wasClosed = this.#closed;
    this.#closed = true;
    this.#closeReason = reason;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new ConnectionError(`DevTools connection closed while awaiting ${entry.method}`, {
          hint: 'The browser went away mid-call. Call browser_status to see the current state.',
        }),
      );
    }
    this.#pending.clear();
    if (!wasClosed) {
      log.debug(`cdp ${this.label} closed: ${reason}`);
      this.emit('disconnected', reason);
    }
  }

  /** Send one protocol command. Resolves with `result`, rejects with ToolError. */
  send(method, params = {}, sessionId = undefined) {
    if (!this.connected) {
      return Promise.reject(
        new ConnectionError(`Not connected to a browser (${this.#closeReason ?? 'never connected'})`, {
          hint: 'Call browser_status, then browser_open.',
        }),
      );
    }
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new ToolError(`CDP ${method} timed out after ${config.requestTimeoutMs}ms`, {
            hint: 'The page may be busy or the operation fired a navigation. Try page_wait_for or a shorter action.',
          }),
        );
      }, config.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, method, timer });
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new ConnectionError(`Failed to send ${method}: ${err.message}`));
      }
    });
  }

  waitForEvent(method, { sessionId = null, timeoutMs = config.defaultWaitMs, predicate = null } = {}) {
    return new Promise((resolve, reject) => {
      const onEvent = (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        if (predicate && !predicate(params)) return;
        cleanup();
        resolve(params);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ToolError(`Timed out after ${timeoutMs}ms waiting for ${method}`, {
          hint: 'The event never fired. Re-check page state with page_snapshot.',
        }));
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off(method, onEvent); };
      this.on(method, onEvent);
    });
  }

  close() {
    if (this.#ws && this.#ws.readyState <= 1) {
      try { this.#ws.close(); } catch {}
    }
    this.#onClose('closed locally');
  }
}

/**
 * One attached page (a CDP session). All page-scoped operations live here so callers
 * never hand-manage session ids.
 */
export class PageSession extends EventEmitter {
  #console = [];
  #network = [];
  #domainsReady = false;

  constructor(conn, { sessionId, targetId, url = '', title = '' }) {
    super();
    this.setMaxListeners(0);
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.url = url;
    this.title = title;
    this.createdAt = Date.now();

    conn.on(`session:${sessionId}:Runtime.consoleAPICalled`, (p) => this.#pushConsole(p, 'log'));
    conn.on(`session:${sessionId}:Runtime.exceptionThrown`, (p) => this.#pushConsole(p, 'exception'));
    conn.on(`session:${sessionId}:Log.entryAdded`, (p) => this.#pushConsole(p, 'browser'));
    conn.on(`session:${sessionId}:Network.requestWillBeSent`, (p) => this.#pushNetwork(p, 'request'));
    conn.on(`session:${sessionId}:Network.responseReceived`, (p) => this.#pushNetwork(p, 'response'));
    conn.on(`session:${sessionId}:Network.loadingFailed`, (p) => this.#pushNetwork(p, 'failed'));
    conn.on(`session:${sessionId}:Page.frameNavigated`, (p) => {
      if (!p.frame?.parentId) this.url = p.frame.url;
    });

    /**
     * Re-emit session-scoped protocol events locally.
     *
     * Connection emits `session:<id>:<Method>` for every event, but consumers of a page
     * naturally write `page.on('Page.loadEventFired', ...)` / `page.on('Page.javascriptDialogOpening', ...)`.
     * Without this bridge those listeners never fire — which silently broke dialog
     * auto-dismissal and left alert() free to hang the renderer.
     *
     * The listener is stored as a named function because `EventEmitter.on()` returns the
     * emitter, not the listener; passing that return value to `off()` later throws.
     */
    this._onConnEvent = (msg) => {
      if (msg.sessionId !== this.sessionId || !msg.method) return;
      this.emit(msg.method, msg.params ?? {});
    };
    conn.on('event', this._onConnEvent);
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  /** Wait for a page-scoped protocol event (e.g. Page.loadEventFired). */
  waitForEvent(method, opts = {}) {
    return this.conn.waitForEvent(method, { ...opts, sessionId: this.sessionId });
  }

  /** Evaluate an expression in the page, returning the FULL protocol result. */
  async evalRaw(expression, { awaitPromise = true, returnByValue = true, userGesture = false } = {}) {
    return this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture,
      allowUnsafeEvalBlockedByCSP: true,
      includeCommandLineAPI: false,
    });
  }

  /**
   * Evaluate and unwrap to a plain JS value, throwing a self-correcting ToolError when the
   * page throws. Injected scripts build their own error handling, so a throw here almost
   * always means the expression itself was wrong.
   */
  async eval_(expression, opts = {}) {
    return parseJsonResult(await this.evalRaw(expression, opts));
  }

  /** Detach page-scoped listeners; called when the page is closed. */
  dispose() {
    if (this._onConnEvent) {
      this.conn.off('event', this._onConnEvent);
      this._onConnEvent = null;
    }
    this.removeAllListeners();
  }

  /** Subscribe to DOM + console + network + lifecycle. Idempotent. */
  async enableDomains({ network = true } = {}) {
    if (this.#domainsReady) return;
    await Promise.all([
      this.send('Page.enable').catch(() => {}),
      this.send('Runtime.enable').catch(() => {}),
      this.send('Log.enable').catch(() => {}),
      network ? this.send('Network.enable').catch(() => {}) : Promise.resolve(),
      this.send('DOM.enable').catch(() => {}),
      this.send('CSS.enable').catch(() => {}),
    ]);
    this.#domainsReady = true;
  }

  #pushConsole(params, kind) {
    const entry = normalizeConsole(params, kind);
    if (!entry) return;
    this.#console.push(entry);
    if (this.#console.length > config.maxConsoleEntries) this.#console.shift();
    this.emit('console', entry);
    if (entry.level === 'error') this.emit('console:error', entry);
  }

  #pushNetwork(params, kind) {
    if (kind === 'request') {
      this.#network.push({
        kind,
        requestId: params.requestId,
        method: params.request?.method,
        url: params.request?.url,
        type: params.type,
        startedAt: Date.now(),
      });
    } else {
      // Attach the response/failure to the originating request so the agent sees one row.
      const row = [...this.#network].reverse().find((r) => r.requestId === params.requestId && r.kind === 'request');
      const extra =
        kind === 'response'
          ? { status: params.response?.status, statusText: params.response?.statusText, mimeType: params.response?.mimeType, fromCache: params.response?.fromDiskCache || params.response?.fromServiceWorker }
          : { failed: true, errorText: params.errorText, canceled: params.canceled };
      if (row) {
        Object.assign(row, extra, { durationMs: Date.now() - row.startedAt });
      } else {
        this.#network.push({ kind, requestId: params.requestId, ...extra });
      }
    }
    if (this.#network.length > config.maxNetworkEntries) this.#network.shift();
    this.emit('network', params);
  }

  consoleEntries({ level = null, since = null, limit = 100 } = {}) {
    let rows = this.#console;
    if (level) rows = rows.filter((e) => e.level === level);
    if (since) rows = rows.filter((e) => e.at > since);
    return { entries: rows.slice(-limit), total: rows.length, buffered: this.#console.length };
  }

  networkEntries({ filter = null, failedOnly = false, limit = 100 } = {}) {
    let rows = this.#network.filter((r) => r.kind === 'request');
    if (failedOnly) rows = rows.filter((r) => r.failed || (r.status ?? 0) >= 400);
    if (filter) {
      const needle = String(filter).toLowerCase();
      rows = rows.filter((r) => String(r.url ?? '').toLowerCase().includes(needle));
    }
    return { entries: rows.slice(-limit), total: rows.length, buffered: this.#network.length };
  }

  clearBuffers() {
    this.#console = [];
    this.#network = [];
  }
}

function normalizeConsole(params, kind) {
  if (kind === 'browser') {
    if (!params.entry) return null;
    return {
      at: Date.now(),
      source: params.entry.source ?? 'browser',
      level: params.entry.level ?? 'info',
      text: params.entry.text ?? '',
      url: params.entry.url,
      line: params.entry.lineNumber,
    };
  }
  if (kind === 'exception') {
    const d = params.exceptionDetails ?? {};
    return {
      at: Date.now(),
      source: 'javascript',
      level: 'error',
      text: d.exception?.description ?? d.text ?? 'Uncaught exception',
      url: d.url,
      line: d.lineNumber,
      column: d.columnNumber,
      stack: d.stackTrace?.callFrames?.slice(0, 10).map((f) => `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`),
    };
  }
  const args = (params.args ?? []).map(describeRemoteObject);
  return {
    at: Date.now(),
    source: 'console',
    level: params.type === 'warning' ? 'warn' : params.type,
    text: args.join(' '),
    args,
    stack: params.stackTrace?.callFrames?.slice(0, 5).map((f) => `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber + 1})`),
  };
}

/**
 * Unwrap a Runtime.evaluate result. Distinguishes "the page threw" from "the value is
 * undefined" — an agent that cannot tell those apart will chase phantom bugs.
 */
export function parseJsonResult(result, { what = 'expression' } = {}) {
  const details = result?.exceptionDetails;
  if (details) {
    const text = details.exception?.description ?? details.text ?? 'unknown error';
    const err = new ToolError(`${what} threw: ${text}`, {
      hint: 'Fix the expression and retry. Use page_console for errors the page raised on its own.',
      details: { url: details.url, line: details.lineNumber, column: details.columnNumber },
    });
    err.threw = true;
    return Promise.reject(err);
  }
  const remote = result?.result ?? {};
  if (remote.type === 'undefined') return { value: undefined, type: 'undefined' };
  if (remote.subtype === 'null') return { value: null, type: 'object', subtype: 'null' };
  if ('value' in remote) return { value: remote.value, type: remote.type, subtype: remote.subtype };
  return {
    value: remote.description ?? remote.className ?? `[${remote.type}]`,
    type: remote.type,
    subtype: remote.subtype,
  };
}

function describeRemoteObject(o) {  if (o == null) return String(o);
  if (o.type === 'string') return o.value;
  if ('value' in o && typeof o.value !== 'object') return String(o.value);
  if (o.type === 'object' && o.subtype === 'null') return 'null';
  if (o.preview?.properties) {
    const body = o.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ');
    return `${o.className || o.subtype || 'Object'} { ${body}${o.preview.overflow ? ', …' : ''} }`;
  }
  return o.description ?? `${o.type}${o.subtype ? `:${o.subtype}` : ''}`;
}
