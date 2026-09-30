/**
 * Scripts evaluated INSIDE the page.
 *
 * Every string here is wrapped in an IIFE, so these can use `return` freely. They are
 * plain ES2020 that any browser can parse — no template literals from our side leaking
 * in, no Node APIs. The invariant: each script returns a JSON-serializable value.
 */

export const HELPERS = `
function __webhVis(el) {
  if (!el || el.nodeType !== 1) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  if (parseFloat(cs.opacity) === 0) return false;
  if (el.hasAttribute('hidden')) return false;
  return true;
}
function __webhName(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? '#' + el.id : '';
  let cls = '';
  if (typeof el.className === 'string' && el.className.trim()) {
    cls = '.' + el.className.trim().split(/\\s+/).slice(0, 4).join('.');
  }
  return tag + id + cls;
}
function __webhAttrs(el) {
  const out = {};
  for (const a of Array.from(el.attributes)) out[a.name] = a.value.length > 200 ? a.value.slice(0, 200) + '…' : a.value;
  return out;
}
function __webhDescr(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean),
    name: __webhName(el),
    role: el.getAttribute('role') || null,
    type: el.getAttribute('type') || null,
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    value: 'value' in el ? String(el.value).slice(0, 300) : null,
    placeholder: el.getAttribute('placeholder') || null,
    ariaLabel: el.getAttribute('aria-label') || null,
    title: el.getAttribute('title') || null,
    href: el.getAttribute ? (el.getAttribute('href') || null) : null,
    attributes: __webhAttrs(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    visible: __webhVis(el),
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    checked: typeof el.checked === 'boolean' ? el.checked : null
  };
}
function __webhSetValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function __webhResolve(spec) {
  if (spec && typeof spec === 'object') {
    if (spec.text) {
      const needle = String(spec.text).trim().toLowerCase();
      const nodes = Array.from(document.querySelectorAll(spec.selector || 'body *'));
      const scored = [];
      for (const n of nodes) {
        // innerText reflects what is actually rendered; textContent would also match
        // hidden <script>/<style> content.
        const own = ((n.innerText !== undefined ? n.innerText : n.textContent) || '').trim().toLowerCase();
        if (!own) continue;
        if (own === needle) scored.push({ n: n, score: 0, len: own.length });
        else if (own.indexOf(needle) !== -1) scored.push({ n: n, score: 1, len: own.length });
      }
      // Exact match wins; otherwise the SMALLEST containing element — the button, not the
      // <body> that happens to contain its text.
      scored.sort(function (a, b) { return a.score - b.score || a.len - b.len; });
      return scored.length ? scored[0].n : null;
    }
    if (spec.css) return document.querySelector(spec.css);
    return null;
  }
  return document.querySelector(String(spec));
}
`;

/** Rich element inspection: what the agent needs to reason about a selector. */
export const QUERY = (selector, limit) => `(() => {
  ${HELPERS}
  let els;
  try { els = Array.from(document.querySelectorAll(${JSON.stringify(selector)})); }
  catch (e) { return { error: 'invalid selector: ' + e.message, matches: 0 }; }
  const total = els.length;
  const out = els.slice(0, ${limit}).map(function (el) {
    const d = __webhDescr(el);
    d.html = el.outerHTML.length > 1200 ? el.outerHTML.slice(0, 1200) + '…' : el.outerHTML;
    d.attributes = __webhAttrs(el);
    d.childCount = el.children.length;
    d.selector = __webhName(el);
    return d;
  });
  return { matches: total, returned: out.length, elements: out };
})()`;

/** Structural outline of the page (or a subtree), depth-limited. */
export const STRUCTURE = (selector, depth, limit) => `(() => {
  ${HELPERS}
  const root = document.querySelector(${JSON.stringify(selector)});
  if (!root) return { error: 'no element matches ' + ${JSON.stringify(selector)}, matches: 0 };
  let count = 0;
  function walk(el, d) {
    if (count++ > ${limit}) return { name: '…truncated…' };
    const node = { name: __webhName(el), text: el.children.length === 0 ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : undefined };
    if (d < ${depth}) {
      const kids = Array.from(el.children).map(function (c) { return walk(c, d + 1); }).filter(Boolean);
      if (kids.length) node.children = kids;
    } else if (el.children.length) {
      node.more = el.children.length + ' more child element(s)';
    }
    return node;
  }
  return { root: walk(root, 0), nodesVisited: count };
})()`;

/** Computed styles with provenance: which CSS rule actually won. */
export const COMPUTED_STYLE = (selector, properties) => `(() => {
  ${HELPERS}
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { error: 'no element matches ' + ${JSON.stringify(selector)} };
  const wanted = ${JSON.stringify(properties)};
  const cs = getComputedStyle(el);
  let keys = wanted;
  if (!keys || !keys.length) {
    keys = ['display','position','width','height','margin','padding','color','background-color','font-family','font-size','font-weight','line-height','border','flex-direction','grid-template-columns','gap','z-index','opacity','overflow','visibility','text-align','transform','box-sizing','top','left','right','bottom'];
  }
  const styles = {};
  for (const k of keys) {
    const v = cs.getPropertyValue(k);
    if (v !== '') styles[k] = v;
  }
  let matched = [];
  try {
    const rules = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let list;
      try { list = sheet.cssRules; } catch (e) { continue; }
      collectRules(list, rules);
    }
    function collectRules(list, acc) {
      for (const rule of Array.from(list)) {
        if (rule.cssRules && rule.selectorText === undefined) { collectRules(rule.cssRules, acc); continue; }
        if (!rule.selectorText) continue;
        try { if (!el.matches(rule.selectorText)) continue; } catch (e) { continue; }
        const decls = {};
        for (const prop of Array.from(rule.style)) decls[prop] = rule.style.getPropertyValue(prop);
        acc.push({ selector: rule.selectorText, origin: rule.parentRule ? 'nested' : 'stylesheet', declarations: decls });
      }
    }
    matched = rules.filter(function (r) {
      return Object.keys(r.declarations).some(function (p) { return keys.indexOf(p) !== -1; });
    });
  } catch (e) { matched = [{ error: String(e) }]; }
  return {
    element: __webhDescr(el),
    computed: styles,
    matchedRules: matched,
    inlineStyle: el.getAttribute('style') || null,
    note: 'matchedRules is ordered by stylesheet appearance; inlineStyle and specificity decide the winner. computed holds the effective value.'
  };
})()`;

/** The page's own error/console noise, pulled straight from the live page. */
export const PAGE_ERRORS = `(() => {
  const errs = window.__webhErrors || [];
  return { captured: errs.length, errors: errs.slice(-50) };
})()`;

/**
 * Submits the runtime guard blocked, recorded in-page.
 *
 * Surfacing these matters: without it a blocked submit looks like the click simply did
 * nothing, and the agent burns turns wondering why its button "doesn't work".
 */
export const GUARD_EVENTS = `(() => {
  const events = (window.__webhSubmitGuard && window.__webhSubmitGuard.events()) || [];
  const blocked = events.filter(function (e) { return e.kind === 'blocked-submit'; });
  return {
    submitsAllowed: window.__webhSubmitGuard ? window.__webhSubmitGuard.allowed : null,
    blockedCount: blocked.length,
    blocked: blocked.slice(-10)
  };
})()`;

/** Compact accessibility-ish snapshot: interactive and landmark elements. */
export const A11Y = (limit) => `(() => {
  ${HELPERS}
  const sel = 'a[href], button, input, select, textarea, [role], [tabindex], h1, h2, h3, h4, img, form, nav, main, header, footer, aside, dialog, [aria-live]';
  const nodes = Array.from(document.querySelectorAll(sel));
  const items = nodes.slice(0, ${limit}).map(function (el) {
    const d = __webhDescr(el);
    d.accessibleName = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].textContent || '').trim() || (el.innerText || el.textContent || '').trim().slice(0, 120) || el.getAttribute('alt') || el.getAttribute('title') || null;
    d.tabIndex = el.tabIndex;
    if (el.tagName.toLowerCase() === 'a') d.href = el.getAttribute('href');
    return d;
  });
  return {
    counts: { matched: nodes.length, returned: items.length },
    headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).slice(0, 40).map(function (h) { return h.tagName.toLowerCase() + ': ' + (h.innerText || '').trim().slice(0, 100); }),
    items: items
  };
})()`;

/** Document-level facts an agent usually gets wrong when guessing. */
export const PAGE_INFO = `(() => {
  ${HELPERS}
  const cs = getComputedStyle(document.documentElement);
  return {
    url: location.href,
    origin: location.origin,
    title: document.title,
    readyState: document.readyState,
    doctype: document.doctype ? ('<!DOCTYPE ' + document.doctype.name + '>') : null,
    charset: document.characterSet,
    lang: document.documentElement.lang || null,
    viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) },
    scrollHeight: document.documentElement.scrollHeight,
    bodyScrollHeight: document.body ? document.body.scrollHeight : null,
    colorScheme: cs.colorScheme,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    counts: {
      elements: document.getElementsByTagName('*').length,
      scripts: document.scripts.length,
      stylesheets: document.styleSheets.length,
      images: document.images.length,
      forms: document.forms.length,
      iframes: document.querySelectorAll('iframe').length,
      links: document.querySelectorAll('a[href]').length
    },
    frameworks: {
      react: !!(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot],#root,#app')),
      vue: !!(window.Vue || document.querySelector('[data-v-app]')),
      angular: !!(window.ng || document.querySelector('[ng-version]')),
      svelte: !!document.querySelector('[class*="svelte-"]'),
      nextjs: !!(window.__NEXT_DATA__ || window.next),
      vite: !!(window.__vite_plugin_react_preamble_installed__ || document.querySelector('script[type="module"][src*="/@vite/"]'))
    },
    meta: Array.from(document.querySelectorAll('meta[name],meta[property]')).slice(0, 30).map(function (m) { return { name: m.getAttribute('name') || m.getAttribute('property'), content: (m.getAttribute('content') || '').slice(0, 200) }; })
  };
})()`;

export const SCROLL_INTO_VIEW = (spec) => `(() => {
  ${HELPERS}
  const el = __webhResolve(${JSON.stringify(spec)});
  if (!el) return { ok: false, error: 'element not found: ' + ${JSON.stringify(JSON.stringify(spec))} };
  const before = { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.x + r.width / 2);
  const cy = Math.round(r.y + r.height / 2);
  const topEl = document.elementFromPoint(cx, cy);
  const hit = topEl === el || (topEl && el.contains(topEl)) || false;
  return {
    ok: true,
    element: __webhDescr(el),
    center: { x: cx, y: cy },
    scrolledFrom: before,
    scrolledTo: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    topElementAtCenter: topEl ? __webhName(topEl) : null,
    occluded: !hit && topEl !== el,
    warning: (!hit && topEl && !el.contains(topEl)) ? ('another element (' + __webhName(topEl) + ') covers the click point — a coordinate click would hit that instead') : null
  };
})()`;

export const SCROLL_BY = (x, y) => `(() => {
  window.scrollBy(${Number(x)}, ${Number(y)});
  return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight };
})()`;

export const FOCUS = (spec) => `(() => {
  ${HELPERS}
  const el = __webhResolve(${JSON.stringify(spec)});
  if (!el) return { ok: false, error: 'element not found' };
  el.focus({ preventScroll: false });
  return { ok: true, element: __webhDescr(el), activeElement: document.activeElement ? __webhName(document.activeElement) : null };
})()`;

/**
 * Set a field's value the way a framework sees it.
 *
 * React/Vue track their own copy of the value on the DOM node and ignore a plain
 * `el.value = x`, so we call the *native* prototype setter and then dispatch input +
 * change. That is what makes controlled components actually update.
 *
 * `append: true` pastes `text` onto the existing value instead of replacing it, which
 * is how you fill a field the page prefilled.
 */
export const SET_VALUE = (spec, value, opts = {}) => `(() => {
  ${HELPERS}
  const el = __webhResolve(${JSON.stringify(spec)});
  if (!el) return { ok: false, error: 'element not found' };
  const t = el.tagName.toLowerCase();
  const before = 'value' in el ? String(el.value) : null;

  if (t === 'select') {
    const wantRaw = ${JSON.stringify(opts.label ?? value ?? '')};
    const want = String(wantRaw).toLowerCase();
    const opt = Array.from(el.options).find(function (o) {
      return o.value === wantRaw || (o.textContent || '').trim().toLowerCase() === want;
    });
    if (!opt) return { ok: false, error: 'no <option> matches ' + JSON.stringify(wantRaw), optionCount: el.options.length,
      available: Array.from(el.options).slice(0, 20).map(function (o) { return o.value; }) };
    __webhSetValue(el, opt.value);
  } else if (typeof el.checked === 'boolean' && (${JSON.stringify(opts.checked ?? null)} !== null || el.type === 'checkbox' || el.type === 'radio')) {
    const want = ${JSON.stringify(opts.checked ?? null)};
    el.checked = want === null ? !el.checked : !!want;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if ('value' in el) {
    const next = ${opts.append ? 'before + ' : ''} ${JSON.stringify(String(value ?? ''))};
    __webhSetValue(el, next);
  } else {
    return { ok: false, error: 'element <' + t + '> has no value to set' };
  }

  return {
    ok: true,
    element: __webhDescr(el),
    valueBefore: before,
    valueAfter: 'value' in el ? String(el.value) : null,
    checked: typeof el.checked === 'boolean' ? el.checked : null
  };
})()`;

export const DOM_MUTATION_SUMMARY = `(() => {
  ${HELPERS}
  const seen = new WeakSet();
  let counts = { elements: 0, textNodes: 0, ids: 0, classes: 0 };
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 1) { counts.elements++; if (n.id) counts.ids++; if (n.className) counts.classes++; }
    else counts.textNodes++;
  }
  return counts;
})()`;

export const INJECT_ERROR_HOOK = `(() => {
  if (window.__webhHookInstalled) return { installed: false, already: true };
  window.__webhErrors = window.__webhErrors || [];
  window.addEventListener('error', function (e) {
    window.__webhErrors.push({ kind: 'error', message: e.message, source: e.filename, line: e.lineno, column: e.colno, stack: e.error && e.error.stack ? String(e.error.stack).split('\\n').slice(0, 6).join('\\n') : null, at: new Date().toISOString() });
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__webhErrors.push({ kind: 'unhandledrejection', message: String(e.reason && e.reason.message || e.reason), stack: e.reason && e.reason.stack ? String(e.reason.stack).split('\\n').slice(0, 6).join('\\n') : null, at: new Date().toISOString() });
  });
  window.__webhHookInstalled = true;
  return { installed: true };
})()`;

export const ELEMENT_FROM_POINT = (x, y) => `(() => {
  ${HELPERS}
  const el = document.elementFromPoint(${Number(x)}, ${Number(y)});
  return el ? __webhDescr(el) : null;
})()`;

/** Text typed through Input.insertText still needs a page-side readback for the agent. */
export const READ_VALUE = (spec) => `(() => {
  ${HELPERS}
  const el = __webhResolve(${JSON.stringify(spec)});
  if (!el) return { ok: false, error: 'element not found' };
  return { ok: true, element: __webhDescr(el), value: 'value' in el ? String(el.value) : null, checked: typeof el.checked === 'boolean' ? el.checked : null };
})()`;

