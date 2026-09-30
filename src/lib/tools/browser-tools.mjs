import path from 'node:path';
import fsp from 'node:fs/promises';
import { config } from '../config.mjs';
import { audit, readAudit, clearAudit } from '../audit.mjs';
import { ToolError } from '../errors.mjs';
import { assertNavigable } from '../guardrails.mjs';
import { ensureDir, nowIso, slug, truncate, resolveWorkspacePath } from '../util.mjs';

function ok(text, data) {
  return { text, data };
}

export const browserTools = [
  {
    name: 'browser_status',
    title: 'Browser status',
    description:
      'Report the live state of the harness: whether a browser is attached, which page is current, guardrail policy, and where state/logs live. Call this first when anything behaves unexpectedly.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const status = await ctx.harness.status();
      return ok(status.connected ? 'Browser attached.' : 'No browser attached yet.', status);
    },
  },

  {
    name: 'browser_open',
    title: 'Open browser',
    description:
      'Attach to a Chromium already running with remote debugging, or launch a fresh one if none is found. Optionally navigate straight to a URL. This is usually unnecessary — other tools connect on demand.',
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open, e.g. http://localhost:3000. Local URLs only by default.' },
        port: { type: 'integer', description: `DevTools port to attach to or launch on. Defaults to ${config.attachPort} for attach, ${config.launchPort} for launch.` },
        fresh: { type: 'boolean', description: 'Ignore any running browser and launch a clean one (closes the harness-owned browser first).' },
        headed: { type: 'boolean', description: 'Launch with a visible window instead of headless. Ignored when attaching.' },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const url = args.url ? assertNavigable(args.url) : null;
      await ctx.harness.ensure({
        url,
        fresh: Boolean(args.fresh),
        port: args.port ?? null,
        headless: args.headed === undefined ? null : !args.headed,
      });
      const page = await ctx.harness.currentPage();
      await ctx.harness.preparePage(page);
      await audit('browser.open', { url, fresh: Boolean(args.fresh), owned: ctx.harness.browser?.owned });
      return ok(`Attached to ${ctx.harness.browser.version}. Current page: ${page.url}`, {
        browser: ctx.harness.browser.version,
        ownedByHarness: ctx.harness.browser.owned,
        url: page.url,
        targetId: page.targetId,
      });
    },
  },

  {
    name: 'browser_close',
    title: 'Close browser',
    description:
      'Close the browser. If the harness launched it, the process is shut down and its profile removed from the session. If you started it yourself, the harness only detaches and your browser keeps running.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Also shut down a browser the harness did not launch. Use only when you mean it.' },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const res = await ctx.harness.shutdown({ force: Boolean(args.force) });
      return ok(
        res.closed ? 'Browser closed.' : res.detached ? 'Detached; your browser is still running.' : 'Nothing to close.',
        res,
      );
    },
  },

  {
    name: 'browser_list_pages',
    title: 'List pages',
    description: 'List every open page (tab) with its target id, URL and title, marking which one is current.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const res = await ctx.harness.pages();
      const lines = res.pages.map(
        (p) => `${p.current ? '*' : ' '} ${p.targetId}  ${p.url}${p.title ? `  — ${p.title}` : ''}`,
      );
      return ok(lines.length ? `${res.pages.length} page(s) (* = current):\n${lines.join('\n')}` : 'No pages.', res);
    },
  },

  {
    name: 'page_select',
    title: 'Select page',
    description: 'Attach to a specific open page by target id, URL substring, or index. Use after browser_list_pages.',
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Exact target id from browser_list_pages.' },
        urlMatch: { type: 'string', description: 'Case-insensitive substring of the page URL.' },
        index: { type: 'integer', description: 'Position in the page list, 0-based.' },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      if (!args.targetId && !args.urlMatch && args.index === undefined) {
        throw new ToolError('page_select needs one of targetId, urlMatch or index.', {
          hint: 'Call browser_list_pages first to see what is available.',
        });
      }
      const res = await ctx.harness.selectPage(args);
      return ok(`Selected ${res.url}`, res);
    },
  },

  {
    name: 'page_new',
    title: 'New page',
    description: 'Open a new tab at a URL and make it current.',
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open. Defaults to about:blank.' } },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      if (!ctx.harness.connected) await ctx.harness.ensure();
      const url = args.url ? assertNavigable(args.url) : 'about:blank';
      const page = await ctx.harness.browser.newPage(url);
      ctx.harness.page = page;
      await ctx.harness.preparePage(page);
      await audit('page.new', { url, targetId: page.targetId });
      await sleep(150);
      return ok(`Opened ${url}`, { targetId: page.targetId, url: page.url });
    },
  },

  {
    name: 'page_close',
    title: 'Close page',
    description: 'Close a page (tab). Defaults to the current page.',
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { targetId: { type: 'string', description: 'Target id to close. Defaults to the current page.' } },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      if (!ctx.harness.connected) throw new ToolError('No browser attached.');
      const res = await ctx.harness.browser.closePage(args.targetId ?? null);
      await audit('page.close', res);
      return ok(res.closed ? `Closed ${res.targetId}` : `Nothing closed: ${res.reason}`, res);
    },
  },

  {
    name: 'page_navigate',
    title: 'Navigate',
    description:
      'Navigate the current page to a URL and wait for it to load. Local URLs (localhost, 127.0.0.1, file://, data:) are allowed; the public internet is blocked unless the harness was started with WEBH_ALLOW_REMOTE_NAVIGATION=1.',
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute or relative URL. Relative paths resolve against the current page.' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'When to consider navigation finished. Default load.' },
        timeoutMs: { type: 'integer', description: `How long to wait. Default ${config.defaultWaitMs}.` },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const raw = String(args.url);
      let url = raw;
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
        // Relative path: resolve against the page so the agent can say "/pricing".
        try { url = new URL(raw, page.url).href; } catch { url = raw; }
      }
      assertNavigable(url);
      await ctx.harness.ensure();
      const res = await ctx.harness.navigate(url, {
        waitUntil: args.waitUntil ?? 'load',
        timeoutMs: args.timeoutMs ?? config.defaultWaitMs,
      });
      const page2 = await ctx.harness.currentPage();
      return ok(`Navigated to ${res.url}`, { ...res, title: page2.title });
    },
  },

  {
    name: 'page_reload',
    title: 'Reload',
    description: 'Reload the current page, optionally bypassing the HTTP cache.',
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ignoreCache: { type: 'boolean', description: 'Bypass the cache, like Ctrl+Shift+R.' },
        timeoutMs: { type: 'integer', description: 'How long to wait for load.' },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const loaded = page.waitForEvent('Page.loadEventFired', { timeoutMs: args.timeoutMs ?? config.defaultWaitMs }).catch(() => null);
      await page.send('Page.reload', { ignoreCache: Boolean(args.ignoreCache) });
      await loaded;
      await sleep(150);
      await ctx.harness.preparePage(page);
      await audit('page.reload', { url: page.url, ignoreCache: Boolean(args.ignoreCache) });
      return ok(`Reloaded ${page.url}`, { url: page.url, ignoreCache: Boolean(args.ignoreCache) });
    },
  },

  {
    name: 'page_screenshot',
    title: 'Screenshot',
    description:
      'Capture the rendered page as a PNG and return the image. This is the ground truth for layout and visual bugs — far more reliable than reasoning about CSS text. Saves a copy under .webh/screenshots.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Capture only this element instead of the viewport.' },
        fullPage: { type: 'boolean', description: 'Capture the entire scrollable page instead of just the viewport.' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. Default png.' },
        quality: { type: 'integer', description: 'JPEG quality 0-100. Ignored for png.' },
        save: { type: 'boolean', description: 'Also write the file to disk (always true for the CLI). Default true.' },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const format = args.format === 'jpeg' ? 'jpeg' : 'png';
      const params = { format, captureBeyondViewport: Boolean(args.fullPage || args.selector), fromSurface: true };
      if (format === 'jpeg') params.quality = Number.isFinite(args.quality) ? args.quality : 80;

      if (args.selector) {
        const metrics = await page.eval_(`(() => {
          const el = document.querySelector(${JSON.stringify(args.selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`);
        const box = metrics.value;
        if (!box) {
          throw new ToolError(`No element matches ${args.selector}`, {
            hint: 'Verify the selector with page_dom_query, or drop `selector` to capture the viewport.',
          });
        }
        if (box.width < 1 || box.height < 1) {
          throw new ToolError(`Element ${args.selector} has zero size (${box.width}x${box.height})`, {
            hint: 'It is probably hidden or collapsed. Check page_computed_style for display/visibility.',
          });
        }
        params.clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
      }

      const { data: b64 } = await page.send('Page.captureScreenshot', params);
      if (!b64) throw new ToolError('Screenshot capture returned no data.');

      const bytes = Buffer.from(b64, 'base64');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(config.screenshotsDir, `${stamp}-${slug(args.selector ?? page.url, 40)}.${format === 'jpeg' ? 'jpg' : 'png'}`);
      await ensureDir(config.screenshotsDir);
      await fsp.writeFile(file, bytes);

      const info = await page.eval_(`(() => ({
        url: location.href,
        title: document.title,
        w: window.innerWidth, h: window.innerHeight,
        scrollH: document.documentElement.scrollHeight,
        scrollY: Math.round(window.scrollY)
      }))()`);
      ctx.harness.lastScreenshot = { path: file, at: nowIso(), bytes: bytes.length };
      await audit('page.screenshot', { path: file, selector: args.selector ?? null, fullPage: Boolean(args.fullPage) });

      const summary = `Screenshot ${bytes.length} bytes${args.fullPage ? ' (full page)' : ''}${args.selector ? ` of ${args.selector}` : ''} — saved to ${path.relative(config.root, file)}`;
      return {
        text: summary,
        image: { data: b64, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' },
        data: {
          path: file,
          bytes: bytes.length,
          format,
          viewport: { width: info.value.w, height: info.value.h },
          pageHeight: info.value.scrollH,
          scrollY: info.value.scrollY,
          url: info.value.url,
          title: info.value.title,
          selector: args.selector ?? null,
        },
      };
    },
  },

  {
    name: 'page_audit_log',
    title: 'Audit log',
    description: 'Read or clear the append-only log of everything the agent changed in the browser (navigations, clicks, typed text, JS mutations, CSS edits).',
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many recent entries. Default 50.' },
        clear: { type: 'boolean', description: 'Delete the log instead of reading it.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      if (args.clear) {
        await clearAudit();
        return ok('Audit log cleared.', { cleared: true });
      }
      const res = await readAudit({ limit: args.limit ?? 50 });
      const lines = res.entries.map((e) => `${e.at}  ${e.event}  ${JSON.stringify({ ...e, at: undefined, event: undefined })}`);
      return ok(`${res.total} entries (showing ${res.entries.length}):\n${lines.join('\n')}`, { ...res, logPath: resolveWorkspacePath(config.auditLog) });
    },
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
