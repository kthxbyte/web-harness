import { config } from '../config.mjs';
import { ToolError, GuardrailError } from '../errors.mjs';
import { audit } from '../audit.mjs';
import { assertClickable, assertEvalAllowed, assertNoDestructiveEval, assertDownloadAllowed, assertNavigable } from '../guardrails.mjs';
import { truncate, ensureDir } from '../util.mjs';
import * as S from '../page-scripts.mjs';

function ok(text, data) {
  return { text, data };
}

export const pageTools = [
  {
    name: 'page_snapshot',
    title: 'Page snapshot',
    description:
      'One-call orientation: document facts, framework detection, accessibility/interactive element map, headings, recent console errors and failed requests. Call this before changing anything so you know what you are working with.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        includeHtml: { type: 'boolean', description: 'Include the outer HTML of the body (truncated). Useful on small pages.' },
        maxElements: { type: 'integer', description: `Cap on interactive elements listed. Default ${Math.min(config.maxDomNodes, 120)}.` },
        includeConsole: { type: 'boolean', description: 'Include buffered console output. Default true.' },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      await ctx.harness.preparePage(page);

      const info = await page.eval_(S.PAGE_INFO);
      const a11y = await page.eval_(S.A11Y(args.maxElements ?? Math.min(config.maxDomNodes, 120)));
      const guard = await page.eval_(S.GUARD_EVENTS).catch(() => ({ value: null }));
      const errors = page.consoleEntries({ limit: 25 });
      const net = page.networkEntries({ failedOnly: true, limit: 20 });

      const html = args.includeHtml
        ? (await page.eval_(`document.body ? document.body.outerHTML : ''`)).value
        : null;

      const data = {
        page: info.value,
        interactive: a11y.value.items,
        headings: a11y.value.headings,
        counts: a11y.value.counts,
        consoleErrors: errors.entries.filter((e) => e.level === 'error'),
        networkFailures: net.entries,
        blockedSubmits: guard.value ?? null,
        dialogs: ctx.harness.dialogs ?? [],
      };

      const meta = info.value;
      const lines = [
        `${meta.title || '(untitled)'} — ${meta.url}`,
        `readyState=${meta.readyState} viewport=${meta.viewport.innerWidth}x${meta.viewport.innerHeight} dpr=${meta.viewport.dpr} pageHeight=${meta.scrollHeight} scrollY=${meta.viewport.scrollY}`,
        `elements=${meta.counts.elements} forms=${meta.counts.forms} images=${meta.counts.images} scripts=${meta.counts.scripts} iframes=${meta.counts.iframes} stylesheets=${meta.counts.stylesheets}`,
        `frameworks: ${Object.entries(meta.frameworks).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none detected'}`,
        `headings: ${data.headings.length ? data.headings.join(' | ') : 'none'}`,
        `interactive elements: ${data.counts.matched}${data.counts.returned < data.counts.matched ? ` (showing ${data.counts.returned})` : ''}`,
      ];
      if (data.consoleErrors.length) lines.push(`console errors (${data.consoleErrors.length}): ${data.consoleErrors.slice(-3).map((e) => e.text).join(' || ')}`);
      if (data.networkFailures.length) lines.push(`failed requests (${data.networkFailures.length}): ${data.networkFailures.slice(-3).map((r) => `${r.status ?? 'FAIL'} ${r.url}`).join(' || ')}`);
      if (data.dialogs.length) lines.push(`dialogs seen: ${data.dialogs.map((d) => `${d.type}:${d.message}`).join(' || ')}`);
      if (guard.value?.blockedCount) {
        lines.push(
          `blocked form submits: ${guard.value.blockedCount} — ${guard.value.blocked.map((b) => `${b.how} → ${b.method?.toUpperCase()} ${b.action}`).join(' || ')}. Submits are disabled; enable with WEBH_ALLOW_FORM_SUBMIT=1 or pass force:true.`,
        );
      }

      if (html) {
        const t = truncate(html, Math.floor(config.maxResultChars / 3));
        data.bodyHtml = t.text;
        data.bodyHtmlTruncated = t.truncated;
        lines.push('', '--- body HTML ---', t.text);
      }

      return ok(lines.join('\n'), data);
    },
  },

  {
    name: 'dom_query',
    title: 'Query DOM',
    description:
      'Find elements by CSS selector and return structured facts for each: geometry, visibility, computed role, text, attributes and outer HTML. Use this instead of guessing what the markup looks like.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector, e.g. "#nav > ul li.active" or "[data-testid=submit]".' },
        limit: { type: 'integer', description: `Max elements returned. Default 25.` },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      if (typeof args.selector !== 'string' || !args.selector.trim()) {
        throw new ToolError('dom_query needs a non-empty `selector`.', { hint: 'Example: { "selector": "nav a" }' });
      }
      const limit = Math.min(Number(args.limit) || 25, config.maxDomNodes);
      const res = await page.eval_(S.QUERY(args.selector, limit));
      const r = res.value;
      if (r.error) {
        throw new ToolError(`Invalid selector: ${r.error}`, { hint: 'Fix the CSS selector syntax and retry.' });
      }
      if (r.matches === 0) {
        return ok(`No elements match "${args.selector}".`, { ...r, selector: args.selector, suggestion: 'Call page_snapshot to see what is actually present, or try a simpler selector.' });
      }
      const lines = r.elements.map((e) => {
        const box = `${e.rect.w}x${e.rect.h}@${e.rect.x},${e.rect.y}`;
        const state = [e.visible ? 'visible' : 'HIDDEN', e.disabled ? 'disabled' : null, e.checked === null ? null : `checked=${e.checked}`].filter(Boolean).join(' ');
        const txt = e.text ? ` "${e.text.slice(0, 80)}"` : '';
        return `${e.name} [${box}] ${state}${txt}`;
      });
      return ok(`${r.matches} match(es) for "${args.selector}"${r.returned < r.matches ? ` (showing ${r.returned})` : ''}:\n${lines.join('\n')}`, {
        selector: args.selector,
        ...r,
      });
    },
  },

  {
    name: 'dom_structure',
    title: 'DOM structure',
    description: 'Print the element tree of a subtree as an indented outline. Good for understanding layout nesting without dumping raw HTML.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Subtree root. Defaults to "body".' },
        depth: { type: 'integer', description: 'How many levels deep to descend. Default 4.' },
        limit: { type: 'integer', description: `Max nodes to visit. Default ${config.maxDomNodes}.` },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const selector = args.selector ?? 'body';
      const depth = Math.min(Number(args.depth) || 4, 12);
      const limit = Math.min(Number(args.limit) || config.maxDomNodes, 2000);
      const res = await page.eval_(S.STRUCTURE(selector, depth, limit));
      if (res.value.error) {
        throw new ToolError(res.value.error, { hint: 'Check the selector, or call page_snapshot first.' });
      }
      const lines = [];
      const walk = (node, indent) => {
        if (!node) return;
        const text = node.text ? ` "${node.text}"` : '';
        lines.push(`${'  '.repeat(indent)}${node.name}${text}`);
        if (node.more) lines.push(`${'  '.repeat(indent + 1)}…${node.more}`);
        for (const kid of node.children ?? []) walk(kid, indent + 1);
      };
      walk(res.value.root, 0);
      return ok(lines.join('\n'), { selector, depth, ...res.value });
    },
  },

  {
    name: 'page_computed_style',
    title: 'Computed style',
    description:
      'The effective computed style of one element plus the CSS rules that matched it (in stylesheet order) and any inline style. This answers "why does it look like that" without reasoning from source files.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Target element selector.' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Specific CSS properties to report. Omit for a useful default set.' },
        pseudo: { type: 'string', enum: ['::before', '::after', '::first-line', '::placeholder'], description: 'Inspect a pseudo-element.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const res = await page.eval_(S.COMPUTED_STYLE(args.selector, args.properties ?? null));
      if (res.value.error) {
        throw new ToolError(res.value.error, { hint: 'Verify the selector with dom_query, or call page_snapshot.' });
      }
      const v = res.value;
      const styleLines = Object.entries(v.computed).map(([k, val]) => `  ${k}: ${val}`);
      const ruleLines = (v.matchedRules ?? []).slice(0, 20).map((r) => `  ${r.selector} { ${Object.entries(r.declarations).map(([k, val]) => `${k}: ${val}`).join('; ')} }`);
      const text = [
        `${v.element.name} — ${v.element.rect.w}x${v.element.rect.h} at ${v.element.rect.x},${v.element.rect.y}`,
        'computed:',
        ...styleLines,
        v.inlineStyle ? `inline style: ${v.inlineStyle}` : 'inline style: none',
        `matching rules (${(v.matchedRules ?? []).length}):`,
        ...(ruleLines.length ? ruleLines : ['  (none matched from stylesheets — values come from UA styles or inline)']),
      ].join('\n');
      return ok(text, v);
    },
  },

  {
    name: 'page_eval',
    title: 'Evaluate JavaScript',
    description:
      'Run a JavaScript expression in the page and return its value as JSON. The escape hatch for everything the other tools do not cover. Use `return` inside an IIFE for multi-statement code. Code that submits a form is refused by default.',
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript to run. Example: "(() => ({ links: document.links.length }))()".' },
        awaitPromise: { type: 'boolean', description: 'Await a returned promise. Default true.' },
        userGesture: { type: 'boolean', description: 'Treat as a user gesture, enabling APIs like clipboard or fullscreen.' },
        force: { type: 'boolean', description: 'Override the destructive-click guardrail for this expression. Recorded in the audit log.' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      if (typeof args.expression !== 'string' || !args.expression.trim()) {
        throw new ToolError('page_eval needs a non-empty `expression`.');
      }
      assertEvalAllowed(args.expression);
      // Closing the loop on the click guard: an eval that clicks a submit/destructive
      // control would otherwise sidestep assertClickable entirely.
      const destructive = assertNoDestructiveEval(args.expression);
      if (destructive && !args.force) {
        throw new GuardrailError(
          `Refusing to run an expression that clicks something destructive ("${destructive}").`,
          {
            rule: 'eval-destructive-click',
            hint: 'Use page_interact with force: true for a deliberate click, or rewrite the expression to avoid the destructive target.',
            details: { matched: destructive, expression: args.expression.slice(0, 240) },
          },
        );
      }
      const res = await page.eval_(args.expression, {
        awaitPromise: args.awaitPromise !== false,
        userGesture: Boolean(args.userGesture),
      });
      const serialized = safeStringify(res.value);
      await audit('page.eval', { expression: args.expression.slice(0, 500), resultType: res.type });
      return ok(`→ ${serialized}`, { value: res.value, type: res.type, subtype: res.subtype, expression: args.expression });
    },
  },

  {
    name: 'page_console',
    title: 'Console output',
    description:
      'Buffered console messages, uncaught exceptions and browser log entries for the current page, with stacks. The fastest way to see why the page is broken.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['log', 'info', 'warn', 'warning', 'error', 'debug'], description: 'Only return this level.' },
        limit: { type: 'integer', description: 'Max entries. Default 50.' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const res = page.consoleEntries({ level: args.level ?? null, limit: Math.min(Number(args.limit) || 50, 500) });
      const errs = page.consoleEntries({ level: 'error', limit: 500 });
      if (!res.entries.length) {
        return ok(`No console output buffered${args.level ? ` at level ${args.level}` : ''}. (Enable-time matters: only messages after the harness attached are captured.)`, {
          ...res,
          errorCount: errs.total,
        });
      }
      const lines = res.entries.map((e) => {
        const loc = e.url ? ` (${e.url}${e.line !== undefined ? `:${e.line + 1}` : ''})` : '';
        const stack = e.stack?.length ? `\n${e.stack.join('\n')}` : '';
        return `[${e.level}] ${e.text}${loc}${stack}`;
      });
      if (args.clear) page.clearBuffers();
      return ok(`${res.total} buffered (showing ${res.entries.length}), ${errs.total} error(s):\n${lines.join('\n')}`, {
        ...res,
        errorCount: errs.total,
        cleared: Boolean(args.clear),
      });
    },
  },

  {
    name: 'page_network',
    title: 'Network activity',
    description: 'Requests the page made since the harness attached: method, URL, status, timing and failures. Use failedOnly to jump straight to what broke.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Only URLs containing this substring.' },
        failedOnly: { type: 'boolean', description: 'Only failures and 4xx/5xx responses.' },
        limit: { type: 'integer', description: 'Max rows. Default 50.' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const res = page.networkEntries({
        filter: args.filter ?? null,
        failedOnly: Boolean(args.failedOnly),
        limit: Math.min(Number(args.limit) || 50, 500),
      });
      const lines = res.entries.map((r) => {
        const status = r.failed ? 'FAILED' : r.status ?? 'pending';
        const dur = r.durationMs !== undefined ? ` ${r.durationMs}ms` : '';
        return `${status} ${r.method ?? ''} ${r.url}${dur}${r.errorText ? ` — ${r.errorText}` : ''}`;
      });
      if (args.clear) page.clearBuffers();
      return ok(res.entries.length ? `${res.total} request(s), showing ${res.entries.length}:\n${lines.join('\n')}` : 'No matching requests buffered.', { ...res });
    },
  },

  {
    name: 'page_a11y',
    title: 'Accessibility map',
    description: 'Headings, landmarks and interactive elements with their accessible names. Use it to check labeling, tab order and that controls are reachable.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: `Max elements. Default ${Math.min(config.maxDomNodes, 150)}.` } },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const limit = Math.min(Number(args.limit) || Math.min(config.maxDomNodes, 150), 1000);
      const res = await page.eval_(S.A11Y(limit));
      const v = res.value;
      const lines = v.items.map((i) => {
        const flags = [i.visible ? null : 'HIDDEN', i.disabled ? 'disabled' : null, i.tabIndex >= 0 ? `tabindex=${i.tabIndex}` : null].filter(Boolean).join(' ');
        return `${i.name}${i.href ? ` → ${i.href}` : ''} — name: ${i.accessibleName ?? '(none)'}${flags ? ` [${flags}]` : ''}`;
      });
      const unlabeled = v.items.filter((i) => !i.accessibleName && ['a', 'button', 'input', 'select', 'textarea'].includes(i.tag)).length;
      const text = [
        `headings: ${v.headings.length ? v.headings.join(' | ') : 'none'}`,
        `${v.counts.matched} interactive element(s)${unlabeled ? `, ${unlabeled} WITHOUT an accessible name` : ''}`,
        ...lines,
      ].join('\n');
      return ok(text, v);
    },
  },

  {
    name: 'page_interact',
    title: 'Interact with the page',
    description:
      'Click, type, hover, scroll, focus or press keys on real elements. Clicks use real mouse events at the element center, so they hit whatever is actually on top and trigger the same handlers a human would. Form submits and irreversible-looking buttons are refused unless force: true.',
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'hover', 'scroll', 'focus', 'key'], description: 'What to do.' },
        selector: { type: 'string', description: 'CSS selector for the target.' },
        text: { type: 'string', description: 'Selector text to match instead of CSS, e.g. "Sign in". Matches exact or substring on visible text.' },
        value: { type: 'string', description: 'For type: text to insert. For scroll: "top"|"bottom" or pixel amount.' },
        key: { type: 'string', description: 'For key: key name, e.g. Enter, Tab, Escape, ArrowDown, or a single character.' },
        append: { type: 'boolean', description: 'For type: append instead of replacing the field contents.' },
        force: { type: 'boolean', description: 'Override the destructive-action guardrail. Recorded in the audit log.' },
        timeoutMs: { type: 'integer', description: 'How long to wait for the element. Default 5000.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const spec = args.selector ? { css: args.selector } : args.text ? { text: args.text } : null;
      if (!spec && args.action !== 'scroll' && args.action !== 'key') {
        throw new ToolError('page_interact needs `selector` or `text` for this action.', {
          hint: 'Example: { "action": "click", "selector": "button.save" } or { "action": "click", "text": "Save" }.',
        });
      }

      if (spec) {
        const found = await waitForElement(page, spec, args.timeoutMs ?? 5000);
        if (!found) {
          throw new ToolError(`Element not found: ${args.selector ?? args.text}`, {
            hint: 'Call dom_query or page_snapshot to see what is on the page. For text matching, pass the visible text without extra whitespace.',
          });
        }
      }

      switch (args.action) {
        case 'click': {
          const prepared = await page.eval_(S.SCROLL_INTO_VIEW(spec));
          const p = prepared.value;
          if (!p.ok) throw new ToolError(`Cannot click: ${p.error}`);
          if (p.occluded && !args.force) {
            throw new ToolError(`Element ${args.selector ?? args.text} is covered by ${p.topElementAtCenter}.`, {
              hint: 'A modal or overlay is in front of it. Close the overlay first, or click the covering element, or pass force: true to click by coordinates anyway.',
              details: { target: p.element, covering: p.topElementAtCenter, center: p.center },
            });
          }
          const tag = p.element?.tag;
          const type = p.element?.type;
          if (!args.force) {
            // Prefer the element's own concise text; fall back to what the agent typed.
            // Using the descriptor text avoids matching destructive words that merely
            // appear elsewhere on the page.
            const label = (p.element?.text ?? '').trim() || String(args.text ?? '');
            assertClickable({ selector: args.selector ?? args.text, tagName: tag, type, text: label });
            if (tag === 'a' && p.element?.attributes?.download !== undefined) {
              assertDownloadAllowed({ selector: args.selector, download: p.element.attributes.download });
            }
          }
          await dispatchMouse(page, 'mousePressed', p.center.x, p.center.y);
          await dispatchMouse(page, 'mouseReleased', p.center.x, p.center.y);
          await sleep(120);
          await audit('page.interact.click', { target: args.selector ?? args.text, element: p.element?.name, at: p.center, force: Boolean(args.force) });
          return ok(`Clicked ${p.element?.name ?? args.selector ?? args.text} at ${p.center.x},${p.center.y}`, {
            action: 'click', target: p.element, center: p.center, forced: Boolean(args.force),
          });
        }

        case 'type': {
          if (typeof args.value !== 'string') {
            throw new ToolError('page_interact type needs `value` as a string.', { hint: 'Example: { "action": "type", "selector": "#email", "value": "a@b.c" }' });
          }
          const focused = await page.eval_(S.FOCUS(spec));
          if (!focused.value.ok) throw new ToolError(`Cannot focus ${args.selector ?? args.text}: ${focused.value.error}`);
          const before = await page.eval_(S.READ_VALUE(spec));
          if (!args.append) {
            // Select-all then type over it, so pre-filled fields are replaced not appended.
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' });
          }
          await page.send('Input.insertText', { text: args.value });
          await sleep(60);
          const after = await page.eval_(S.READ_VALUE(spec));
          await audit('page.interact.type', { target: args.selector ?? args.text, value: args.value.slice(0, 200), append: Boolean(args.append) });
          return ok(`Typed ${args.value.length} char(s) into ${after.value.element?.name}: "${after.value.value}"`, {
            action: 'type', target: after.value.element, valueBefore: before.value.value, valueAfter: after.value.value,
          });
        }

        case 'hover': {
          const prepared = await page.eval_(S.SCROLL_INTO_VIEW(spec));
          const p = prepared.value;
          if (!p.ok) throw new ToolError(`Cannot hover: ${p.error}`);
          await dispatchMouse(page, 'mouseMoved', p.center.x, p.center.y);
          await sleep(120);
          await audit('page.interact.hover', { target: args.selector ?? args.text });
          return ok(`Hovering ${p.element?.name} at ${p.center.x},${p.center.y}`, { action: 'hover', target: p.element, center: p.center });
        }

        case 'focus': {
          const res = await page.eval_(S.FOCUS(spec));
          if (!res.value.ok) throw new ToolError(`Cannot focus: ${res.value.error}`);
          await audit('page.interact.focus', { target: args.selector ?? args.text });
          return ok(`Focused ${res.value.element?.name}; activeElement is ${res.value.activeElement}`, { action: 'focus', ...res.value });
        }

        case 'scroll': {
          let payload;
          if (args.value === 'bottom') {
            payload = await page.eval_(`(() => { window.scrollTo(0, document.documentElement.scrollHeight); return { scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight }; })()`);
          } else if (args.value === 'top') {
            payload = await page.eval_(`(() => { window.scrollTo(0, 0); return { scrollY: 0, scrollHeight: document.documentElement.scrollHeight }; })()`);
          } else if (spec) {
            payload = await page.eval_(S.SCROLL_INTO_VIEW(spec));
          } else {
            const px = Number(args.value);
            if (!Number.isFinite(px)) {
              throw new ToolError('page_interact scroll needs `value` as a number, "top", "bottom", or a `selector`.');
            }
            payload = await page.eval_(S.SCROLL_BY(0, px));
          }
          await audit('page.interact.scroll', { target: args.selector ?? args.value ?? null });
          return ok(`Scrolled: ${safeStringify(payload.value)}`, { action: 'scroll', ...payload.value });
        }

        case 'key': {
          if (!args.key) throw new ToolError('page_interact key needs `key`, e.g. "Enter" or "Tab".');
          if (spec) {
            const focused = await page.eval_(S.FOCUS(spec));
            if (!focused.value.ok) throw new ToolError(`Cannot focus ${args.selector ?? args.text}: ${focused.value.error}`);
          }
          const def = keyDefinition(args.key);
          // Printable characters need `keyDown` + text so the browser generates input;
          // non-printables need `rawKeyDown`. The two shapes are built separately because
          // JSON.stringify silently drops `undefined` fields.
          const base = { windowsVirtualKeyCode: def.code, nativeVirtualKeyCode: def.code, key: def.key, code: def.domCode };
          const withText = def.text ? { ...base, text: def.text, unmodifiedText: def.text } : null;
          await page.send('Input.dispatchKeyEvent', { type: withText ? 'keyDown' : 'rawKeyDown', ...base, ...(withText ?? {}) });
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
          await sleep(60);
          await audit('page.interact.key', { key: args.key, target: args.selector ?? args.text ?? 'focused element' });
          const active = await page.eval_(`document.activeElement ? document.activeElement.tagName.toLowerCase() + (document.activeElement.id ? '#' + document.activeElement.id : '') : null`);
          return ok(`Pressed ${args.key}; activeElement is ${active.value ?? 'none'}`, { action: 'key', key: args.key, activeElement: active.value });
        }

        default:
          throw new ToolError(`Unknown action "${args.action}".`, {
            hint: 'Valid actions: click, type, hover, scroll, focus, key.',
          });
      }
    },
  },

  {
    name: 'page_set_style',
    title: 'Set inline style',
    description:
      'Apply CSS properties directly to an element for a quick visual experiment, or revert your overrides. Changes are per-element inline styles, recorded in the audit log, and reversible with revert: true — ideal for "what if this were a different color" without touching source files.',
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Target element.' },
        properties: { type: 'object', description: 'CSS property/value pairs, e.g. { "background-color": "red" }.' },
        revert: { type: 'boolean', description: 'Restore the element to how it was before this harness first styled it.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      if (!args.revert && (!args.properties || typeof args.properties !== 'object')) {
        throw new ToolError('page_set_style needs `properties` (an object of CSS declarations) or revert: true.');
      }
      const res = await page.eval_(`(() => {
        const el = document.querySelector(${JSON.stringify(args.selector)});
        if (!el) return { ok: false, error: 'no element matches ' + ${JSON.stringify(args.selector)} };
        window.__webhOverrides = window.__webhOverrides || new WeakMap();
        const tracked = window.__webhOverrides.has(el);
        if (!tracked) window.__webhOverrides.set(el, el.getAttribute('style') || '');
        const original = window.__webhOverrides.get(el);

        ${args.revert
          ? `el.setAttribute('style', original);`
          : `const decls = ${JSON.stringify(args.properties)};
        for (const k of Object.keys(decls)) el.style.setProperty(k, decls[k]);`}
        const cs = getComputedStyle(el);
        const applied = {};
        ${args.revert ? '' : `for (const k of Object.keys(${JSON.stringify(args.properties ?? {})})) applied[k] = cs.getPropertyValue(k);`}
        return {
          ok: true,
          element: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,3).join('.') : ''),
          applied,
          styleAttribute: el.getAttribute('style') || null,
          previouslyTracked: tracked
        };
      })()`);
      const v = res.value;
      if (!v.ok) throw new ToolError(v.error, { hint: 'Check the selector with dom_query first.' });
      await audit(args.revert ? 'page.style.revert' : 'page.style.set', {
        selector: args.selector,
        properties: args.revert ? undefined : args.properties,
        element: v.element,
      });
      return ok(
        args.revert
          ? `Reverted ${v.element} to its original inline style${v.styleAttribute ? ` (${v.styleAttribute})` : ' (none)'}`
          : `Styled ${v.element}: ${Object.entries(v.applied).map(([k, val]) => `${k}: ${val}`).join('; ')}`,
        v,
      );
    },
  },

  {
    name: 'page_wait_for',
    title: 'Wait for something',
    description:
      'Block until a condition holds: an element appears/leaves, a URL matches, the network goes quiet, or an arbitrary JS predicate becomes truthy. Use after clicks that trigger async work instead of guessing with fixed sleeps.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        for: { type: 'string', enum: ['element', 'no-element', 'url', 'network-idle', 'predicate'], description: 'Condition kind.' },
        selector: { type: 'string', description: 'For element/no-element.' },
        urlMatch: { type: 'string', description: 'For url: substring the location must contain.' },
        expression: { type: 'string', description: 'For predicate: JS that evaluates truthy when done.' },
        timeoutMs: { type: 'integer', description: 'Max wait. Default 10000.' },
        pollMs: { type: 'integer', description: 'Poll interval. Default 150.' },
      },
      required: ['for'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const page = await ctx.harness.currentPage();
      const timeoutMs = args.timeoutMs ?? 10_000;
      const pollMs = Math.max(30, args.pollMs ?? 150);
      const deadline = Date.now() + timeoutMs;
      const started = Date.now();

      const check = async () => {
        switch (args.for) {
          case 'element':
            return (await page.eval_(`!!document.querySelector(${JSON.stringify(args.selector)})`)).value;
          case 'no-element':
            return !(await page.eval_(`!!document.querySelector(${JSON.stringify(args.selector)})`)).value;
          case 'url':
            return String(page.url).includes(args.urlMatch ?? '');
          case 'predicate':
            if (!args.expression) throw new ToolError('page_wait_for predicate needs `expression`.');
            return Boolean((await page.eval_(`!!(${args.expression})`)).value);
          case 'network-idle': {
            const recent = page.networkEntries({ limit: 500 }).entries.filter((r) => r.status === undefined && !r.failed);
            return recent.length === 0;
          }
          default:
            throw new ToolError(`Unknown wait condition "${args.for}".`, {
              hint: 'Valid: element, no-element, url, network-idle, predicate.',
            });
        }
      };

      let satisfied = false;
      while (Date.now() < deadline) {
        if (await check()) { satisfied = true; break; }
        await sleep(pollMs);
      }
      const waitedMs = Date.now() - started;
      if (!satisfied) {
        throw new ToolError(`Timed out after ${waitedMs}ms waiting for ${args.for}${args.selector ? ` (${args.selector})` : ''}${args.urlMatch ? ` (${args.urlMatch})` : ''}.`, {
          hint: 'The condition never became true. Call page_snapshot and page_console to see what the page is actually doing.',
          details: { waitedMs, url: page.url },
        });
      }
      return ok(`Condition "${args.for}" satisfied after ${waitedMs}ms.`, { for: args.for, waitedMs, url: page.url });
    },
  },
];

async function waitForElement(page, spec, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const expr = `(() => {
    ${S.HELPERS}
    return !!__webhResolve(${JSON.stringify(spec)});
  })()`;
  while (Date.now() < deadline) {
    const res = await page.eval_(expr).catch(() => ({ value: false }));
    if (res.value) return true;
    await sleep(100);
  }
  return false;
}

async function dispatchMouse(page, type, x, y) {
  await page.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: 1,
    pointerType: 'mouse',
  });
}

const KEY_DEFS = {
  Enter: { code: 13, key: 'Enter', domCode: 'Enter', text: '\r' },
  Tab: { code: 9, key: 'Tab', domCode: 'Tab' },
  Escape: { code: 27, key: 'Escape', domCode: 'Escape' },
  Backspace: { code: 8, key: 'Backspace', domCode: 'Backspace' },
  Delete: { code: 46, key: 'Delete', domCode: 'Delete' },
  ArrowUp: { code: 38, key: 'ArrowUp', domCode: 'ArrowUp' },
  ArrowDown: { code: 40, key: 'ArrowDown', domCode: 'ArrowDown' },
  ArrowLeft: { code: 37, key: 'ArrowLeft', domCode: 'ArrowLeft' },
  ArrowRight: { code: 39, key: 'ArrowRight', domCode: 'ArrowRight' },
  Home: { code: 36, key: 'Home', domCode: 'Home' },
  End: { code: 35, key: 'End', domCode: 'End' },
  PageUp: { code: 33, key: 'PageUp', domCode: 'PageUp' },
  PageDown: { code: 34, key: 'PageDown', domCode: 'PageDown' },
  Space: { code: 32, key: ' ', domCode: 'Space', text: ' ' },
};

function keyDefinition(key) {
  if (KEY_DEFS[key]) return KEY_DEFS[key];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      code: upper.charCodeAt(0),
      key,
      domCode: /[a-zA-Z]/.test(key) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : 'Unidentified',
      text: key,
    };
  }
  // Unknown multi-char name: send it as-is with no virtual key code.
  return { code: 0, key, domCode: 'Unidentified' };
}

export function safeStringify(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    try {
      return JSON.stringify(String(value));
    } catch {
      return '[unserializable]';
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
