import { config } from './config.mjs';
import { GuardrailError } from './errors.mjs';

/**
 * Guardrails exist because the agent is attached to a *live* browser that may be your
 * real session. The policy is: the agent may rearrange the page freely, but it may not
 * do things that are hard to undo or that leave the machine.
 *
 * Defense is layered, because a single chokepoint is trivially bypassed — an agent that
 * is refused a submit *click* can simply call `form.submit()` through page_eval:
 *
 *   1. syntax guard   — refuse submit-shaped JS before it runs
 *   2. tool guard     — refuse submit/destructive *clicks* by tag, type or label
 *   3. runtime guard  — a page-side listener that cancels any submit that still slips through
 *
 * Every rule produces a GuardrailError whose message teaches the agent the correct next
 * move, so a blocked action becomes a retry rather than a dead end.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal']);

export function isLocalUrl(rawUrl) {
  if (!rawUrl) return true;
  const trimmed = String(rawUrl).trim();

  // URL() happily resolves these against a base the caller does not have, so normalise
  // the three shapes browsers accept before parsing:
  //   1. protocol-relative "//example.com/x"  -> scheme of the current page
  //   2. backslash variants "\/evil.com"      -> browsers treat "\" as "/"
  //   3. bare "host[:port]"                   -> http
  // Getting this wrong is a real bypass, not a cosmetic issue: "//evil.com" would look
  // like an unparseable relative path and be allowed straight through.
  const slashNormalised = trimmed.replace(/\\/g, '/');
  const isProtocolRelative = /^\/\//.test(slashNormalised);

  // A bare host needs positive evidence that it IS a host rather than a relative path:
  // a dot ("example.com"), a port ("localhost:3000"), or a path/query/fragment
  // ("example.com/x"). A bare word like "settings" must stay a relative path — treating it
  // as a host would refuse same-origin navigation the browser resolves happily.
  const bareHost =
    /^(localhost|127[.\d]*|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:\d+)?([/?#]|$)/i.test(trimmed) ||
    /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?([/?#]|$)/.test(trimmed) ||
    /^[a-zA-Z0-9][a-zA-Z0-9.-]*:\d+([/?#]|$)/.test(trimmed);
  const explicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);

  let candidate;
  if (isProtocolRelative) candidate = `http:${slashNormalised}`;
  else if (bareHost) candidate = `http://${trimmed}`;
  else candidate = slashNormalised;

  let u;
  try {
    u = new URL(candidate);
  } catch {
    // A truly relative URL ("/pricing", "#top", "./sibling") resolves against the current
    // page, so it stays on whatever origin we are already on.
    return true;
  }
  if (['file:', 'data:', 'blob:', 'about:'].includes(u.protocol)) return true;
  if (['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return LOCAL_HOSTS.has(u.hostname);
  return false;
}

/** Rule: navigation stays on the machine unless explicitly allowed. */
export function assertNavigable(url) {
  if (isLocalUrl(url) || config.allowRemoteNavigation) return url;
  throw new GuardrailError(`Refusing to navigate to non-local URL: ${url}`, {
    rule: 'local-navigation',
    hint: 'This harness is scoped to your local dev server so the agent cannot wander onto the public internet. If you really want this, restart with WEBH_ALLOW_REMOTE_NAVIGATION=1.',
    details: { url, allowedHosts: [...LOCAL_HOSTS] },
  });
}

/**
 * Rule: code that submits a form is off by default.
 *
 * Submitting is the classic "agent triggered a real POST to my API / wiped my dev DB"
 * accident. Clicking and filling are fine; submitting is a decision the human makes.
 *
 * These patterns deliberately over-match: a false positive costs the agent one retry and
 * a clear hint, while a false negative can hit a real endpoint.
 */
const SUBMIT_PATTERNS = [
  { re: /\brequestSubmit\s*(?:\.\s*call\s*)?\(/, label: 'form.requestSubmit()' },
  { re: /\.\s*submit\s*(?:\.\s*call\s*)?\(/, label: '.submit()' },
  // Bracket-indexed access with no dot: HTMLFormElement.prototype['submit']...
  { re: /\bHTMLFormElement\s*\.?\s*prototype\s*\.?\s*\[?\s*['"]?submit/i, label: 'direct HTMLFormElement submit' },
  { re: /\bnew\s+(?:Custom)?(?:Submit)?Event\s*\(\s*['"]submit['"]/, label: 'synthetic submit event' },
  { re: /\bnew\s+FormData\b[\s\S]{0,300}?\b(?:fetch|XMLHttpRequest|axios|\.post)\b/, label: 'FormData POST' },
  { re: /\bmethod\s*:\s*['"]POST['"]/i, label: 'POST request' },
  { re: /\baxios\s*\.\s*post\b/, label: 'axios.post' },
  { re: /\bnew\s+XMLHttpRequest\b[\s\S]{0,200}?\.\s*open\s*\(\s*['"]POST['"]/i, label: 'XHR POST' },
];

/**
 * Actions the click guard treats as destructive when they appear in a selector or label.
 *
 * `send` is deliberately absent: "Send" is a routine, reversible button (send a message,
 * apply a filter) and blocking it would train the agent to reach for `force: true`
 * reflexively, which erodes every other rule. Actual submission risk is covered by the
 * form-submit rules and the runtime blocker instead.
 */
const DESTRUCTIVE_RE = /\b(?:submit|publish|deploy|delete|deleting|deleted|destroy|destroying|destructive|danger|dangerous|remove|removing|removed|purchase|buy|buying|pay|paying|unsubscribe|cancel|resetting|reset|wipe|drop|truncate|purge|revoke|terminate|confirm|checkout|signout)\b/i;

/**
 * Squashed-token check for multi-word spellings.
 *
 * "sign out" / "log out" / "sign-out" all mean the same thing as "signout", but `\b`
 * cannot see across the space. Normalising away every non-alphanumeric character first
 * makes all of them match, including SCREAMING_CASE and hyphenated forms.
 *
 * The match is ANCHORED (the whole label must be the token), not a substring search:
 * "Send" / "Log" are genuine buttons, so a loose search for `send` would refuse them.
 * A known over-match remains: a label that is exactly "Confirm" is refused because the
 * label alone does not reveal what is being confirmed.
 */
const DESTRUCTIVE_CANONICAL = /^(?:submit|publish|deploy|delete|destroy|destructive|danger|remove|purchase|buy|pay|unsubscribe|cancel|reset|wipe|drop|truncate|purge|revoke|terminate|confirm|checkout|signout|logout)$/i;

export function namesDestructiveAction(text) {
  const s = String(text ?? '');
  if (!s) return null;

  const direct = s.match(DESTRUCTIVE_RE);
  if (direct) return direct[0];

  // Case transitions: "deleteBtn" -> "delete Btn".
  for (const part of s.split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean)) {
    if (DESTRUCTIVE_RE.test(part)) return part;
  }

  // Separator squashing: "Sign out" / "SIGN_OUT" / "log-out" -> "Signout" / "SIGNOUT".
  // Anchored so ordinary words like "Sender" or "Log" are left alone.
  const squashed = s.replace(/[^a-zA-Z0-9]+/g, '');
  const exact = squashed.match(DESTRUCTIVE_CANONICAL);
  if (exact) return exact[0];

  return null;
}

export function assertEvalAllowed(expression) {
  const code = String(expression ?? '');
  if (config.allowFormSubmit) return code;
  for (const { re, label } of SUBMIT_PATTERNS) {
    if (re.test(code)) {
      throw new GuardrailError(`Refusing to run code that submits a form or issues a POST (matched ${label}).`, {
        rule: 'no-form-submit',
        hint: 'Set fields with page_interact and let the human press submit, or start the harness with WEBH_ALLOW_FORM_SUBMIT=1.',
        details: { matched: label, expression: code.slice(0, 240) },
      });
    }
  }
  assertNoDestructiveEval(code);
  return code;
}

/**
 * Second syntax guard. `page_eval` can click anything the click guard would have refused
 * (`document.querySelector('#submit-order').click()`), so scan clicked selectors and
 * literal labels here too.
 *
 * The two facts are collected independently — "contains a click" and "names something
 * destructive" — because trying to match them in one regex is brittle: whitespace, an
 * intermediate variable, or a chained `.click()` all broke a combined pattern.
 */
export function assertNoDestructiveEval(code) {
  const src = String(code ?? '');
  const clicks = /\bclick\s*\(|\.\s*click\b/.test(src);
  if (!clicks) return undefined;

  // Selectors handed to querySelector/querySelectorAll anywhere in the expression.
  const selectors = [];
  for (const m of src.matchAll(/quer(?:y|yAll)Selector\s*\(\s*['"`]([^'"`]+)['"`]/g)) selectors.push(m[1]);

  // Destructive words appearing in selectors or in any short string literal (a label).
  const literals = [];
  for (const m of src.matchAll(/['"`]([^'"`\n]{1,80})['"`]/g)) literals.push(m[1]);

  const candidates = [...selectors, ...literals];
  if (selectors.length === 0 && literals.length === 0) candidates.push(src);
  for (const candidate of candidates) {
    const hit = namesDestructiveAction(candidate);
    if (hit) return candidate.trim().slice(0, 80);
  }
  return undefined;
}

/** Rule: never click something whose whole purpose is to submit or destroy. */
export function assertClickable({ selector, tagName, type, text } = {}) {
  if (config.allowFormSubmit) return;
  const tag = String(tagName ?? '').toLowerCase();
  const inputType = String(type ?? '').toLowerCase();
  const label = String(text ?? '').trim();

  // <input type=submit|image> and <button type=submit> are both submit controls, even
  // when their label is harmless ("Save changes").
  if (tag === 'input' && (inputType === 'submit' || inputType === 'image')) {
    throw new GuardrailError(`Refusing to click a form submit control (${selector}).`, {
      rule: 'no-form-submit',
      hint: 'Fill the form with page_interact, then ask the human to submit, or pass force: true when you are certain.',
    });
  }
  if (tag === 'button' && inputType === 'submit') {
    throw new GuardrailError(`Refusing to click <button type="submit"> (${selector}) — it submits a form.`, {
      rule: 'no-form-submit',
      hint: 'Fill the form with page_interact, then ask the human to submit, or pass force: true when you are certain.',
    });
  }
  if (label) {
    const which = namesDestructiveAction(label);
    if (which) {
      throw new GuardrailError(`Refusing to click "${label}" — "${which}" looks destructive or irreversible.`, {
        rule: 'irreversible-action',
        hint: 'If this is intentional, call page_interact again with force: true; it will be recorded in the audit log.',
        details: { matched: which, label },
      });
    }
  }
}

/** Rule: downloads write files outside the page. Off by default. */
export function assertDownloadAllowed({ href, download, selector } = {}) {
  if (config.allowDownloads) return;
  if (download !== undefined && download !== null) {
    throw new GuardrailError(`Refusing to trigger a download (${selector ?? href}).`, {
      rule: 'no-downloads',
      hint: 'Set WEBH_ALLOW_DOWNLOADS=1 if the task needs it.',
    });
  }
}

/**
 * The runtime backstop, injected into every page and frame.
 *
 * A generation counter makes the block explicit: the real `HTMLFormElement.prototype.submit`
 * is captured, then overridden to refuse. When the harness is later told to allow submits,
 * the page can be re-prepared and the real implementation restored.
 */
export function submitBlockerScript() {
  const allow = config.allowFormSubmit;
  return `(() => {
  if (window.__webhSubmitGuard) {
    window.__webhSubmitGuard.setAllowed(${allow});
    return { installed: false, already: true, allowed: window.__webhSubmitGuard.allowed };
  }
  const realSubmit = HTMLFormElement.prototype.submit;
  let allowed = ${allow};
  const record = (form, how, detail) => {
    try {
      window.__webhErrors = window.__webhErrors || [];
      (window.__webhGuardEvents = window.__webhGuardEvents || []).push({
        kind: 'blocked-submit', how: how, detail: detail || null,
        action: form && form.getAttribute ? (form.getAttribute('action') || location.href) : null,
        method: form && form.getAttribute ? (form.getAttribute('method') || 'get') : null,
        at: new Date().toISOString()
      });
    } catch (e) {}
  };
  document.addEventListener('submit', function (e) {
    const form = e.target;
    if (!allowed) {
      e.preventDefault();
      e.stopImmediatePropagation();
      record(form, 'submit-event');
      console.warn('[web-harness] blocked a form submit on ' + (form && form.id ? '#' + form.id : 'a form') + '. Enable submits with WEBH_ALLOW_FORM_SUBMIT=1 or click with force: true.');
    } else {
      record(form, 'submit-event-allowed');
    }
  }, true);
  HTMLFormElement.prototype.submit = function () {
    if (!allowed) {
      record(this, 'prototype.submit');
      console.warn('[web-harness] blocked form.submit(); submits are disabled for this harness session.');
      return;
    }
    return realSubmit.apply(this, arguments);
  };
  window.__webhSubmitGuard = {
    allowed: allowed,
    setAllowed: function (v) { allowed = !!v; this.allowed = allowed; },
    events: function () { return window.__webhGuardEvents || []; }
  };
  return { installed: true, allowed: allowed };
})()`;
}

export function guardrailSummary() {
  return {
    navigation: config.allowRemoteNavigation ? 'any URL' : 'local URLs only (localhost/127.0.0.1/file/data)',
    formSubmit: config.allowFormSubmit ? 'allowed' : 'blocked (fill and click allowed; submit refused at syntax, tool and runtime layers)',
    downloads: config.allowDownloads ? 'allowed' : 'blocked',
    audit: config.auditMutations ? config.auditLog : 'disabled',
  };
}
