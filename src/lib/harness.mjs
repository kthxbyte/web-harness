import { config } from './config.mjs';
import { ToolError, asToolError } from './errors.mjs';
import { Browser, discover, launch, openBrowser, probe, resolveBrowserPath, pidAlive } from './browser.mjs';
import { patchSession, writeSessionFile, clearSessionFile, readSessionFile } from './session.mjs';
import { guardrailSummary, submitBlockerScript } from './guardrails.mjs';
import { audit, readAudit, flushAudit, clearAudit } from './audit.mjs';
import { nowIso } from './util.mjs';
import { log } from './log.mjs';

/**
 * Everything injected into each page/frame on prepare.
 *
 * - `__webhErrors` collects uncaught errors and rejections so page_snapshot can report
 *   failures that happened before the agent looked.
 * - the submit blocker is the runtime backstop for the form-submit guardrail.
 */
function HOOKS_SCRIPT() {
  return `(() => {
    window.__webhErrors = window.__webhErrors || [];
    if (!window.__webhHookInstalled) {
      window.addEventListener('error', function (e) {
        window.__webhErrors.push({ kind: 'error', message: e.message, source: e.filename, line: e.lineno });
      });
      window.addEventListener('unhandledrejection', function (e) {
        window.__webhErrors.push({ kind: 'unhandledrejection', message: String(e.reason && e.reason.message || e.reason) });
      });
      window.__webhHookInstalled = true;
    }
    ${submitBlockerScript()};
    return { errors: window.__webhErrors.length, submitsAllowed: window.__webhSubmitGuard ? window.__webhSubmitGuard.allowed : null };
  })()`;
}

/**
 * The single owner of "which browser, which page".
 *
 * Both front ends (MCP stdio server and the `webh` CLI) drive this class, so the agent
 * and your terminal share one definition of state. The browser is connected lazily: a
 * tool call with no browser open will discover or launch one on demand rather than
 * making the agent call browser_open first.
 */
export class Harness {
  constructor() {
    this.browser = null;
    this.page = null;
    this.lastScreenshot = null;
    /**
     * WeakSets keyed by PageSession, so re-preparing a page across many tool calls is
     * cheap and listeners are never attached twice. They are weak because pages come and
     * go; holding strong references would leak across a long agent session.
     */
    this._wired = new WeakSet();        // debug logging
    this._dialogsWired = new WeakSet(); // alert()/confirm() auto-dismissal
    this._framesWired = new WeakSet();  // iframe guard injection
    this._restored = false;             // remembered-url restore runs once per process
    this.dialogs = [];
  }

  get connected() {
    return Boolean(this.browser && this.browser.conn.connected);
  }

  /** Connect to a running browser or start one. Idempotent. */
  async ensure({ url = null, fresh = false, headless = null, port = null } = {}) {
    if (this.connected) return this;

    if (fresh && this.browser) {
      await this.browser.shutdown().catch(() => {});
      this.browser = null;
      this.page = null;
    }

    let discovered = fresh ? null : await discover({ preferPort: port });

    if (!discovered) {
      discovered = await launch({ port: port ?? config.launchPort, ...(headless === null ? {} : { headless }), url: url ?? 'about:blank' });
    }

    this.browser = await Browser.attach(discovered);
    this.browser.conn.on('disconnected', (reason) => {
      log.warn(`browser disconnected: ${reason}`);
      this.browser = null;
      this.page = null;
    });

    this.page = await this.browser.usePage();
    this.#wire(this.page);

    // An explicit URL wins here; restoring a remembered page is handled in currentPage()
    // so that every tool path benefits, not just those that call ensure().
    if (url && url !== 'about:blank') {
      this._restored = true;
      await this.navigate(url);
    }
    return this;
  }

  /**
   * Get the page to act on, guaranteed ready to use.
   *
   * `preparePage` is called here rather than left to each tool because forgetting it is a
   * silent and severe failure: without the dialog listener a native alert() blocks the
   * renderer forever and every later protocol call times out. Most tools remembered;
   * page_interact did not. Making it an invariant eliminates the whole class of bug.
   */
  async currentPage({ required = true } = {}) {
    const page = await this.#resolvePage();
    await this.preparePage(page);
    return page;
  }

  async #resolvePage() {
    if (this.page && this.browser?.pages.has(this.page.targetId)) {
      this.#wire(this.page);
      await this.#maybeRestore();
      return this.page;
    }
    if (!this.connected) await this.ensure();
    this.page = await this.browser.currentPage();
    this.#wire(this.page);
    await this.#maybeRestore();
    return this.page;
  }

  /**
   * A fresh browser for this invocation starts on about:blank. Restore the page the
   * previous invocation left off on, so a sequence of CLI commands reads as one session.
   * Runs at most once per process and never overrides an explicit navigation.
   */
  async #maybeRestore() {
    if (this._restored) return;
    this._restored = true;
    const remembered = await readSessionFile();
    const target = remembered?.lastUrl;
    const isBlank = !this.page?.url || String(this.page.url).startsWith('about:');
    if (target && isBlank && !String(target).startsWith('about:')) {
      await this.navigate(target).catch((err) => log.warn(`could not restore ${target}: ${err.message}`));
    }
  }

  #wire(page) {
    if (this._wired.has(page)) return;
    this._wired.add(page);
    page.on('console:error', (entry) => {
      log.debug(`page error: ${String(entry.text).slice(0, 200)}`);
    });
  }

  /**
   * Attach error + guard hooks, wire dialogs, and remember that we observe this page.
   *
   * The submit blocker must reach every frame, not just the main one: `AutoAttach` with
   * flatten makes the browser hand us an isolated session per out-of-process iframe, and
   * each new session gets the same injection.
   */
  async preparePage(page) {
    await page.enableDomains();
    this.#wireDialogs(page);
    this.#wireFrameInjection(page);
    await page.eval_(HOOKS_SCRIPT()).catch(() => null);
    await this.#injectIntoChildFrames(page);
    return page;
  }

  /**
   * Subscribe once per page to new frame sessions. CDP emits Target.attachedToTarget on
   * the browser connection with the child session id; we then evaluate the hooks there.
   */
  #wireFrameInjection(page) {
    if (this._framesWired?.has(page)) return;
    this._framesWired.add(page);

    page.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => {});

    const onAttached = (params) => {
      const { sessionId, targetInfo } = params;
      if (!sessionId || targetInfo?.type !== 'iframe') return;
      if (sessionId === page.sessionId) return;
      // Child sessions share the page's event channel namespace; inject directly.
      const child = {
        send: (method, p) => this.browser.conn.send(method, p, sessionId),
      };
      Promise.all([
        child.send('Runtime.enable').catch(() => {}),
        child.send('Page.enable').catch(() => {}),
        child.send('Log.enable').catch(() => {}),
      ])
        .then(() => child.send('Runtime.evaluate', { expression: HOOKS_SCRIPT(), returnByValue: true, awaitPromise: false }))
        .then(() => log.debug(`injected guard hooks into iframe ${targetInfo?.url ?? sessionId}`))
        .catch((err) => log.debug(`iframe injection skipped: ${err.message}`));
    };

    page.on('Target.attachedToTarget', onAttached);
  }

  /** Best-effort sweep of already-loaded frames that predate auto-attach. */
  async #injectIntoChildFrames(page) {
    try {
      const { frameTree } = await page.send('Page.getFrameTree');
      const walk = (frame) => {
        const kids = frame.childFrames ?? [];
        for (const child of kids) {
          // Execution contexts for same-process frames live on the page session; for
          // out-of-process frames the auto-attach handler above covers them.
          page.send('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'webh-guard' })
            .then(({ executionContextId }) =>
              page.send('Runtime.evaluate', {
                contextId: executionContextId,
                expression: HOOKS_SCRIPT(),
                returnByValue: true,
              }),
            )
            .catch(() => {});
          walk(child);
        }
      };
      walk(frameTree);
    } catch {
      // Frames come and go; a failure here is not worth surfacing.
    }
  }

  /**
   * A native alert()/confirm() blocks the renderer and would hang the agent forever.
   * Accept-and-log is the only safe default: we keep the page moving and tell the agent
   * exactly what the page asked, so it can decide whether to re-trigger it deliberately.
   */
  #wireDialogs(page) {
    if (this._dialogsWired?.has(page)) return;
    this._dialogsWired.add(page);
    page.on('Page.javascriptDialogOpening', (params) => {
      const entry = { type: params.type, message: params.message, at: nowIso(), url: page.url, autoAccepted: true };
      this.dialogs.push(entry);
      if (this.dialogs.length > 20) this.dialogs.shift();
      log.info(`auto-dismissing ${params.type} dialog: ${params.message}`);
      audit('page.dialog.autoAccept', entry);
      page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
  }

  /** Evaluate `expression` on the current page and return the parsed value. */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const page = await this.currentPage();
    return page.eval_(expression, { awaitPromise, returnByValue });
  }

  async navigate(url, { waitUntil = 'load', timeoutMs = config.defaultWaitMs } = {}) {
    const page = await this.currentPage();
    const loaded = page.waitForEvent('Page.loadEventFired', { timeoutMs }).catch(() => null);
    const result = await page.send('Page.navigate', { url });
    if (result.errorText && !/aborted/i.test(result.errorText)) {
      throw new ToolError(`Navigation failed: ${result.errorText}`, {
        hint: 'Check the URL and that your dev server is running on that port.',
        details: { url },
      });
    }
    if (waitUntil === 'load') await loaded;
    else if (waitUntil === 'domcontentloaded' || waitUntil === 'networkidle') await page.waitForEvent('Page.domContentEventFired', { timeoutMs }).catch(() => null);
    await sleep(120); // let first paint / microtasks settle
    await this.preparePage(page);
    page.url = url;
    await audit('page.navigate', { url, targetId: page.targetId });
    await patchSession({ lastUrl: url });
    return { url, frameId: result.frameId, loaderId: result.loaderId, waitUntil };
  }

  async status() {
    const prior = await readSessionFile();
    const base = {
      connected: this.connected,
      browser: this.browser ? {
        product: this.browser.version,
        endpoint: this.browser.conn.wsUrl,
        ownedByHarness: this.browser.owned,
        pid: this.browser.meta.pid ?? prior?.pid ?? null,
        attachedPages: this.browser.pages.size,
      } : null,
      currentPage: this.page ? {
        url: this.page.url,
        title: this.page.title,
        targetId: this.page.targetId,
        sessionId: this.page.sessionId,
        ageMs: Date.now() - this.page.createdAt,
      } : null,
      lastScreenshot: this.lastScreenshot ? { path: this.lastScreenshot.path, at: this.lastScreenshot.at, bytes: this.lastScreenshot.bytes } : null,
      guardrails: guardrailSummary(),
      env: {
        stateDir: config.stateDir,
        profileDir: config.profileDir,
        auditLog: config.auditLog,
        headless: config.headless,
        viewport: config.viewport,
        attachPort: config.attachPort,
        launchPort: config.launchPort,
        browserPath: resolveBrowserPath(),
      },
      sessionFile: prior ?? null,
    };

    if (!this.connected) {
      const attachable = await probe(config.attachPort);
      const ours = await probe(config.launchPort);
      base.discovery = {
        attachableOnDefaultPort: attachable ? { port: config.attachPort, browser: attachable.version?.Browser } : null,
        browserAlreadyOnLaunchPort: ours ? { port: config.launchPort, browser: ours.version?.Browser } : null,
        hint: attachable
          ? `A browser is listening on ${config.attachPort}; the next tool call will attach to it.`
          : `Nothing is listening on ${config.attachPort} or ${config.launchPort}; the next tool call will launch a browser.`,
      };
    }

    return base;
  }

  async pages() {
    if (!this.connected) await this.ensure();
    const targets = await this.browser.listTargets();
    return {
      current: this.page?.targetId ?? null,
      pages: targets.map((t) => ({
        targetId: t.targetId,
        url: t.url,
        title: t.title,
        type: t.type,
        attached: this.browser.pages.has(t.targetId),
        current: t.targetId === this.page?.targetId,
      })),
    };
  }

  async selectPage({ targetId = null, urlMatch = null, index = null } = {}) {
    if (!this.connected) await this.ensure();
    const targets = await this.browser.listTargets();
    let chosen = null;
    if (targetId) chosen = targets.find((t) => t.targetId === targetId);
    if (!chosen && urlMatch) {
      const needle = String(urlMatch).toLowerCase();
      chosen = targets.find((t) => String(t.url).toLowerCase().includes(needle));
    }
    if (!chosen && index !== null) chosen = targets[index];
    if (!chosen && !targetId && !urlMatch && index === null) chosen = targets[0];
    if (!chosen) {
      throw new ToolError('No matching page found.', {
        hint: 'Call browser_list_pages to see the available targets and their ids.',
        details: { requested: { targetId, urlMatch, index }, available: targets.map((t) => ({ targetId: t.targetId, url: t.url })) },
      });
    }
    const page = await this.browser.attachTo(chosen);
    this.page = page;
    this.#wire(page);
    await this.preparePage(page);
    await audit('page.select', { targetId: page.targetId, url: page.url });
    return { targetId: page.targetId, url: page.url, title: page.title };
  }

  /**
   * Release the harness without necessarily killing the browser.
   *
   * The default (keepAlive) is what makes the CLI behave like a session: the browser and
   * the page — including DOM state the agent mutated — survive between invocations, and
   * the next command reattaches. Pass { close: true } (or run `webh close`) to tear down
   * a browser this harness launched.
   */
  async release({ close = false, force = false } = {}) {
    if (!this.browser) return { closed: false, reason: 'no browser attached' };

    const lastUrl = this.page?.url && !String(this.page.url).startsWith('about:') ? this.page.url : null;
    if (lastUrl) await patchSession({ lastUrl }).catch(() => {});

    if (!close && config.keepAlive && this.browser.owned) {
      // Detach only: leave the process and its state for the next command.
      this.browser.conn.close();
      this.browser = null;
      this.page = null;
      return { closed: false, detached: true, browserKeptAlive: true, lastUrl };
    }
    return this.shutdown({ force });
  }

  async shutdown({ force = false } = {}) {
    // Remember where we were so the next CLI invocation can return to it. This survives
    // the browser process itself, which is the whole point.
    const liveUrl = this.page?.url && !String(this.page.url).startsWith('about:') ? this.page.url : null;
    const priorUrl = (await readSessionFile())?.lastUrl ?? null;
    const lastUrl = liveUrl ?? priorUrl;

    if (!this.browser) {
      const prior = await readSessionFile();
      if (prior?.pid && pidAlive(prior.pid)) {
        try { process.kill(prior.pid, 'SIGTERM'); } catch {}
      }
      // Clear the stale process handle but keep the remembered URL: a dead browser in the
      // session file should not leave `webh close` looking like it has work to do.
      await writeSessionFile({ lastUrl: lastUrl ?? prior?.lastUrl ?? null, pid: null, port: null, wsUrl: null, browser: null });
      return { closed: false, reason: 'no browser attached' };
    }
    const owned = this.browser.owned;
    if (owned || force) {
      await this.browser.shutdown();
      this.browser = null;
      this.page = null;
      await audit('browser.closed', { owned, force });
      // browser.shutdown cleared the session file, so re-seed it with just the URL.
      await writeSessionFile({ lastUrl, pid: null, port: null, wsUrl: null, browser: null });
      return { closed: true, owned, lastUrl };
    }
    // A browser you started: detach politely, never kill your session.
    this.browser.conn.close();
    this.browser = null;
    this.page = null;
    await patchSession({ lastUrl });
    await audit('browser.detached', { reason: 'browser not started by harness' });
    return { closed: false, detached: true, reason: 'that browser was already running; left it alone' };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { ToolError, asToolError, audit, readAudit, flushAudit, clearAudit };
