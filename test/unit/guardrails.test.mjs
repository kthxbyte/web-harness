/**
 * Unit tests for src/lib/guardrails.mjs.
 *
 * The guardrails protect a *live* browser: the agent may rearrange the page, but may not
 * leave the machine (remote navigation) or do things a human would want to approve
 * (form submits, downloads, destructive clicks). These tests pin the policy and, just as
 * importantly, pin the *false-positive* boundary so the guard does not become an obstacle.
 *
 * Environment model: config.mjs snapshots process.env at import time. Default/restrictive
 * behavior is therefore asserted in-process, while the permissive overrides
 * (WEBH_ALLOW_*) are asserted in fresh `node --input-type=module -e` child processes whose
 * environment has every WEBH_* variable stripped first. That keeps the suite deterministic
 * even if the caller exported one of the flags.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  isLocalUrl,
  assertNavigable,
  assertEvalAllowed,
  assertNoDestructiveEval,
  assertClickable,
  assertDownloadAllowed,
  guardrailSummary,
} from '../../src/lib/guardrails.mjs';
import { GuardrailError, ToolError } from '../../src/lib/errors.mjs';
import { config } from '../../src/lib/config.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GUARDRAILS_URL = pathToFileURL(path.join(ROOT, 'src', 'lib', 'guardrails.mjs')).href;

/** Child env with every WEBH_* override removed, so defaults really are defaults. */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('WEBH_')),
);

/** Run the call and return whatever it threw; fail loudly if it returned normally. */
function captureThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to throw, but it returned normally');
  return undefined;
}

function runChild(source, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', source],
      { cwd: ROOT, env: { ...CLEAN_ENV, ...env }, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          status: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout).trim(),
          stderr: String(stderr).trim(),
        });
      },
    );
  });
}

/**
 * Run a probe body in a fresh process that has imported guardrails.mjs. The body gets `g`
 * (the module) and `out` plus an `attempt(key, fn)` helper that records either the return
 * value or the thrown error's class/rule. The body must not use template literals.
 */
function probeChild(bodySource, env = {}) {
  const source = [
    `const g = await import(${JSON.stringify(GUARDRAILS_URL)});`,
    'const out = {};',
    'const attempt = (key, fn) => {',
    '  try { out[key] = { ok: true, value: fn() }; }',
    '  catch (err) { out[key] = { ok: false, name: err.name, rule: err.rule, payload: typeof err.toPayload === "function" ? err.toPayload() : null }; }',
    '};',
    bodySource,
    'console.log(JSON.stringify(out));',
  ].join('\n');
  return runChild(source, env);
}

function parsed(result, label) {
  assert.equal(result.status, 0, `${label}: child exited ${result.status}\nstderr:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------

describe('test environment assumptions', () => {
  it('runs with the default restrictive guardrail policy', () => {
    // If this fails, the suite was launched with WEBH_ALLOW_* exported by the caller.
    // The in-process default-behavior tests below would then be meaningless.
    assert.equal(config.allowRemoteNavigation, false, 'unset WEBH_ALLOW_REMOTE_NAVIGATION before running this suite');
    assert.equal(config.allowFormSubmit, false, 'unset WEBH_ALLOW_FORM_SUBMIT before running this suite');
    assert.equal(config.allowDownloads, false, 'unset WEBH_ALLOW_DOWNLOADS before running this suite');
  });
});

describe('isLocalUrl — host allowlist', () => {
  const LOCAL = [
    'http://localhost',
    'http://localhost:3000',
    'https://localhost:8443/app?x=1#y',
    'http://127.0.0.1',
    'http://127.0.0.1:8080/',
    'https://127.0.0.1:9333/json/version',
    'http://[::1]',
    'http://[::1]:5173/',
    'http://0.0.0.0:3000',
    'http://host.docker.internal:9222/json',
    'ws://localhost:9333/devtools/browser/abc',
    'wss://127.0.0.1:9333/devtools/browser/abc',
    'file:///Users/me/project/index.html',
    'file://localhost/tmp/x.html',
    'data:text/html,<h1>hi</h1>',
    'blob:http://localhost:3000/abc',
    'about:blank',
    '/relative/path',
    './sibling',
    '../up',
    '?query=1',
    '#fragment',
    '',
  ];

  it('accepts loopback hosts, docker host aliases, and every local port', () => {
    for (const url of LOCAL) {
      assert.equal(isLocalUrl(url), true, `expected local: ${JSON.stringify(url)}`);
    }
  });

  it('accepts relative strings, which resolve against the current page origin', () => {
    // A relative URL cannot leave the origin, so treating it as local is safe: these all
    // resolve against whatever page is already open.
    for (const url of ['/dashboard', './sibling', '../up', '/pricing', '?tab=1', '?q=1', '#top', '#fragment', '  ']) {
      assert.equal(isLocalUrl(url), true, `expected local: ${JSON.stringify(url)}`);
    }
  });

  it('normalises a scheme-less host, so host/path and numeric host:port stay local', () => {
    // "localhost/foo" cannot be parsed as an absolute URL on its own, and "127.0.0.1:8080"
    // parses as a bogus scheme "127.0.0.1:". Prefixing http:// before parsing keeps both on
    // the allowlist instead of letting them fail open or closed by accident.
    for (const url of ['localhost/foo', 'localhost?x=1', 'localhost#top', '127.0.0.1:8080', '0.0.0.0:3000']) {
      assert.equal(isLocalUrl(url), true, `expected local: ${JSON.stringify(url)}`);
    }
  });

  it('treats a scheme-less public hostname as remote once it is normalised', () => {
    // Fail closed: "www.example.com" is a public name. The old parser fell back to "local" for
    // anything it could not parse, so a bare domain was waved through as a relative path.
    for (const url of ['www.example.com', 'www.example.com:8443/app', 'example.com/path']) {
      assert.equal(isLocalUrl(url), false, `expected remote: ${JSON.stringify(url)}`);
    }
  });

  it('accepts empty and nullish input (no navigation requested)', () => {
    for (const value of ['', null, undefined]) {
      assert.equal(isLocalUrl(value), true, `expected local: ${JSON.stringify(value)}`);
    }
  });

  it('is case-insensitive about host names', () => {
    assert.equal(isLocalUrl('http://LOCALHOST:3000/'), true);
    assert.equal(isLocalUrl('http://LocalHost.Evil.com/'), false);
  });

  it('rejects look-alike hosts that merely contain an allowed host', () => {
    // Real accident this prevents: "localhost.evil.com" is a *public* name an attacker (or a
    // typo'd dev tunnel) controls. A naive startsWith/includes check would wave it through.
    const traps = [
      'http://localhost.evil.com',
      'http://localhost.evil.com:3000/',
      'http://127.0.0.1.evil.com',
      'https://notlocalhost',
      'https://notlocalhost:443/',
      'http://example.com#localhost',
      'http://example.com?next=localhost',
      'http://sub.localhost.evil.test',
      'http://host.docker.internal.evil.test',
      'http://evil-localhost',
    ];
    for (const url of traps) {
      assert.equal(isLocalUrl(url), false, `expected remote: ${JSON.stringify(url)}`);
    }
  });

  it('rejects unambiguous remote http, https, ws, and wss hosts', () => {
    const remote = [
      'http://example.com',
      'https://example.com/path',
      'https://evil.test',
      'ws://remote:9000',
      'wss://remote.example.com/socket',
      'http://169.254.169.254/latest/meta-data/',
    ];
    for (const url of remote) {
      assert.equal(isLocalUrl(url), false, `expected remote: ${JSON.stringify(url)}`);
    }
  });

  it('rejects non-web schemes it cannot vouch for, even when the host looks local', () => {
    // Scheme confusion: "ftp://localhost" and "javascript:..." are not scoped by the host
    // allowlist, so they must not be treated as local just because they mention localhost.
    for (const url of ['ftp://localhost', 'mailto:admin@localhost', 'javascript:void(0)', 'javascript:alert(location.host)']) {
      assert.equal(isLocalUrl(url), false, `expected remote: ${JSON.stringify(url)}`);
    }
  });
});

describe('assertNavigable — navigation stays on the machine', () => {
  it('returns the URL unchanged for local URLs', () => {
    for (const url of ['http://localhost:3000/app', 'https://127.0.0.1:8443/x', '/relative', 'file:///tmp/a.html']) {
      assert.equal(assertNavigable(url), url);
    }
  });

  it('throws a GuardrailError with rule "local-navigation" for a remote URL', () => {
    const err = captureThrow(() => assertNavigable('https://evil.test/pwn'));
    assert.ok(err instanceof GuardrailError, `expected GuardrailError, got ${err?.name}`);
    assert.equal(err.name, 'GuardrailError');
    assert.equal(err.rule, 'local-navigation');
  });

  it('throws for a look-alike host such as localhost.evil.com', () => {
    const err = captureThrow(() => assertNavigable('http://localhost.evil.com/'));
    assert.ok(err instanceof GuardrailError);
    assert.equal(err.rule, 'local-navigation');
  });

  it('names the offending URL in the message', () => {
    const url = 'https://very-evil.test/steal';
    const err = captureThrow(() => assertNavigable(url));
    assert.match(err.message, /non-local/i);
    assert.ok(err.message.includes(url), `message should include the URL, got: ${err.message}`);
  });

  it('carries a self-correcting hint that names the override flag', () => {
    const err = captureThrow(() => assertNavigable('https://evil.test'));
    assert.equal(typeof err.hint, 'string');
    assert.match(err.hint, /WEBH_ALLOW_REMOTE_NAVIGATION=1/);
  });

  it('exposes a complete payload for the MCP layer', () => {
    const err = captureThrow(() => assertNavigable('https://evil.test'));
    const payload = err.toPayload();
    assert.deepEqual(Object.keys(payload).sort(), ['details', 'error', 'guardrail', 'hint']);
    assert.equal(payload.guardrail, 'local-navigation');
    assert.equal(typeof payload.hint, 'string');
    assert.equal(payload.details.url, 'https://evil.test');
    assert.ok(Array.isArray(payload.details.allowedHosts));
    for (const host of ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']) {
      assert.ok(payload.details.allowedHosts.includes(host), `allowedHosts should include ${host}`);
    }
  });
});

describe('assertEvalAllowed — submit-shaped code is refused', () => {
  const ALLOWED = [
    'document.title',
    "el.classList.add('x')",
    "document.querySelector('form')",
    'document.querySelectorAll("input").length',
    'event.preventDefault()',
    'localStorage.getItem("submit")',
  ];

  it('returns ordinary DOM expressions unchanged', () => {
    for (const expr of ALLOWED) {
      assert.equal(assertEvalAllowed(expr), expr);
    }
  });

  it('allows selectors and strings that merely contain the word "submit"', () => {
    // False positive this pins: the word "submit" appears constantly in selector names and
    // copy. Blocking these would make the guard unusable and push agents to work around it.
    const nearMisses = [
      "document.querySelector('#submit-btn')",
      'document.querySelector(\'[name="submit"]\')',
      '"please submit"',
      "'Submit your answer'",
      'submitForm()',                 // a differently-named helper, no form method call
      'form.submit',                  // property read, not a call
      'document.querySelector("form").requestSubmit', // reference, not a call
      'new FormData(form)',           // constructing FormData alone does nothing
      'x.requestSubmitButton',
      'event.submitter.name',
    ];
    for (const expr of nearMisses) {
      assert.equal(assertEvalAllowed(expr), expr, `should be allowed: ${expr}`);
    }
  });

  it('stringifies non-string input before matching', () => {
    assert.equal(assertEvalAllowed(42), '42');
    assert.equal(assertEvalAllowed(null), '');
    assert.equal(assertEvalAllowed(undefined), '');
    assert.equal(assertEvalAllowed(), '');
  });

  // Every entry in SUBMIT_PATTERNS, plus realistic variants. The third element is the
  // `details.matched` label the module reports for that pattern.
  const REJECTED = [
    // pattern: /\brequestSubmit\s*(?:\.\s*call\s*)?\(/
    ['form.requestSubmit()', 'form.requestSubmit()'],
    ['form.requestSubmit ( )', 'form.requestSubmit()'],
    ['document.querySelector("form").requestSubmit()', 'form.requestSubmit()'],
    ['form.requestSubmit.call(form)', 'form.requestSubmit()'],
    // pattern: /\.\s*submit\s*(?:\.\s*call\s*)?\(/
    ['form.submit()', '.submit()'],
    ['form.submit( )', '.submit()'],
    ['form.submit(\n)', '.submit()'],
    ['document.querySelector("form").submit()', '.submit()'],
    ['.submit()', '.submit()'],
    // Indirection and an explicit argument no longer evade the empty-paren call pattern.
    ['form.submit.call(form)', '.submit()'],
    ['form.submit(undefined)', '.submit()'],
    ['document.forms[0].submit(undefined)', '.submit()'],
    // pattern: /\bHTMLFormElement\s*\.\s*prototype\s*\.\s*\[?\s*['"]?submit/
    // (the .submit() pattern matches first whenever the call itself is present)
    ['HTMLFormElement.prototype.submit.call(form)', '.submit()'],
    ['if (HTMLFormElement.prototype.submit) {}', 'direct HTMLFormElement submit'],
    // pattern: /\bnew\s+(?:Custom)?Event\s*\(\s*['"]submit['"]/
    ["form.dispatchEvent(new Event('submit'))", 'synthetic submit event'],
    ['dispatchEvent( new Event( "submit" ) )', 'synthetic submit event'],
    ["el.dispatchEvent(new CustomEvent('submit', { bubbles: true }))", 'synthetic submit event'],
    // pattern: /\bnew\s+FormData\b[\s\S]{0,300}?\b(?:fetch|XMLHttpRequest|axios|\.post)\b/
    ["const fd = new FormData(form); fetch('/api', { method: 'POST', body: fd })", 'FormData POST'],
    ["const body = new FormData(el.form); await fetch('/api', { method: 'POST', body })", 'FormData POST'],
    // pattern: /\bmethod\s*:\s*['"]POST['"]/i — catches the idiomatic inline-body spelling where
    // "new FormData" comes *after* fetch(...), which the FormData pattern cannot see.
    ["fetch('/api', { method: 'POST', body: new FormData(form) })", 'POST request'],
  ];

  it('rejects every submit-shaped pattern the module defines', () => {
    for (const [expr, expectedLabel] of REJECTED) {
      const err = captureThrow(() => assertEvalAllowed(expr));
      assert.ok(err instanceof GuardrailError, `expected GuardrailError for: ${expr}`);
      assert.equal(err.rule, 'no-form-submit', `wrong rule for: ${expr}`);
      assert.equal(err.toPayload().details.matched, expectedLabel, `wrong label for: ${expr}`);
    }
  });

  it('rejects an inline FormData body even though it appears after fetch(...)', () => {
    // Accident this closes: the idiomatic POST spelling puts the body after the URL, so a
    // "new FormData before fetch" scan missed the most common shape of an unintended real POST.
    const expr = "fetch('/api', { method: 'POST', body: new FormData(form) })";
    const err = captureThrow(() => assertEvalAllowed(expr));
    assert.ok(err instanceof GuardrailError, `expected GuardrailError for: ${expr}`);
    assert.equal(err.rule, 'no-form-submit');
    assert.equal(err.toPayload().details.matched, 'POST request');
  });

  it('rejects indirect submit spellings and a synthetic CustomEvent submit', () => {
    // Each of these previously slipped through the empty-paren regexes: .submit.call(...) and
    // .submit(undefined) never matched "submit()", and a CustomEvent named "submit" was not
    // recognised as a synthetic trigger event at all.
    for (const [expr, label] of [
      ['form.submit.call(form)', '.submit()'],
      ['form.submit(undefined)', '.submit()'],
      ['document.forms[0].submit(undefined)', '.submit()'],
      ['form.requestSubmit.call(form)', 'form.requestSubmit()'],
      ['HTMLFormElement.prototype.submit.call(form)', '.submit()'],
      ["el.dispatchEvent(new CustomEvent('submit'))", 'synthetic submit event'],
    ]) {
      const err = captureThrow(() => assertEvalAllowed(expr));
      assert.ok(err instanceof GuardrailError, `expected GuardrailError for: ${expr}`);
      assert.equal(err.rule, 'no-form-submit', `wrong rule for: ${expr}`);
      assert.equal(err.toPayload().details.matched, label, `wrong label for: ${expr}`);
    }
  });

  it('reports the matched label in a self-correcting payload', () => {
    const err = captureThrow(() => assertEvalAllowed('form.submit()'));
    const payload = err.toPayload();
    assert.equal(payload.guardrail, 'no-form-submit');
    assert.match(payload.hint, /WEBH_ALLOW_FORM_SUBMIT=1/);
    assert.equal(payload.details.expression, 'form.submit()');
    assert.equal(payload.details.matched, '.submit()');
  });

  it('truncates the recorded expression to 240 characters', () => {
    const expr = `${'x'.repeat(300)}.submit()`;
    const err = captureThrow(() => assertEvalAllowed(expr));
    assert.equal(err.toPayload().details.expression.length, 240);
    assert.ok(expr.startsWith(err.toPayload().details.expression));
  });
});

describe('assertNoDestructiveEval — clicked selectors and labels are scanned too', () => {
  it('returns undefined for code that never clicks', () => {
    // The rule only applies when the expression actually clicks. Reading a destructive-looking
    // node has to stay allowed, otherwise merely inspecting a page would be impossible.
    for (const code of [
      "document.querySelector('.a').textContent",
      "document.querySelector('#danger').textContent",
      "getComputedStyle(document.querySelector('#delete'))",
    ]) {
      assert.equal(assertNoDestructiveEval(code), undefined, `should not fire on: ${code}`);
    }
  });

  it('returns undefined when the click target is harmless', () => {
    // False positive this pins: a "save" or "add" control is ordinary interaction, not damage.
    for (const code of [
      "document.querySelector('#save').click()",
      "document.querySelector('.add').click()",
    ]) {
      assert.equal(assertNoDestructiveEval(code), undefined, `should not fire on: ${code}`);
    }
  });

  it('returns the offending matched string when the click target is destructive', () => {
    // page_eval can click what the tool guard would have refused, so the clicked selector is
    // scanned as the second syntax layer. The matched selector is returned for reporting.
    const cases = [
      ["document.querySelector('#danger').click()", '#danger'],
      ["document.querySelector('#submit-order').click()", '#submit-order'],
      ["document.getElementById('delete-account').click()", 'delete-account'],
      ["[...document.querySelectorAll('.remove')].forEach(el => el.click())", '.remove'],
    ];
    for (const [code, expected] of cases) {
      assert.equal(assertNoDestructiveEval(code), expected, `wrong match for: ${code}`);
    }
  });

  it('catches whitespace, argument, chaining, and literal-label variants', () => {
    // These shapes previously broke a single combined regex: the whitespace before .click(),
    // the space inside the call, an extra chained querySelector, and a destructive label that
    // is a bare string rather than a selector. Collecting "does it click" and "names something
    // destructive" independently is what keeps all four visible.
    const cases = [
      ["document.querySelector('#danger') .click()", '#danger'],
      ["document.querySelector('#danger').click( )", '#danger'],
      ["document.querySelector('#a').querySelector('#delete').click()", '#delete'],
      ["document.querySelector('[data-testid=delete]') && something.click()", '[data-testid=delete]'],
      ["something.click('Delete account')", 'Delete account'],
      ["const label = 'Delete account'; el.click()", 'Delete account'],
    ];
    for (const [code, expected] of cases) {
      assert.equal(assertNoDestructiveEval(code), expected, `wrong match for: ${code}`);
    }
  });
});

describe('assertClickable — irreversible controls are refused', () => {
  it('allows an ordinary button and an ordinary anchor', () => {
    assert.doesNotThrow(() => assertClickable({ selector: 'button.primary', tagName: 'button', text: 'Save changes' }));
    assert.doesNotThrow(() => assertClickable({ selector: 'a.docs', tagName: 'a', text: 'Read the docs' }));
  });

  it('allows an element with no metadata at all', () => {
    // page_interact may legitimately have nothing but a selector; absence must not throw.
    assert.doesNotThrow(() => assertClickable());
    assert.doesNotThrow(() => assertClickable({}));
    assert.doesNotThrow(() => assertClickable({ tagName: 'button', text: '' }));
    assert.doesNotThrow(() => assertClickable({ tagName: 'button', text: null }));
  });

  it('rejects input[type=submit] and input[type=image], case-insensitively', () => {
    for (const candidate of [
      { selector: '#go', tagName: 'input', type: 'submit' },
      { selector: '#go', tagName: 'INPUT', type: 'SUBMIT' },
      { selector: '#img', tagName: 'input', type: 'image' },
      { selector: '#img', tagName: 'Input', type: 'Image' },
    ]) {
      const err = captureThrow(() => assertClickable(candidate));
      assert.ok(err instanceof GuardrailError, `expected GuardrailError for ${JSON.stringify(candidate)}`);
      assert.equal(err.rule, 'no-form-submit');
      assert.ok(err.message.includes(candidate.selector), 'message should name the selector');
    }
  });

  it('rejects a <button type="submit"> even when its label is harmless', () => {
    // Accident this closes: only input[type=submit|image] used to be recognised by tag/type, so
    // a submit <button> labelled "Save changes" sailed through on its innocent text.
    for (const candidate of [
      { selector: '#save', tagName: 'button', type: 'submit', text: 'Save changes' },
      { selector: '#save', tagName: 'BUTTON', type: 'SUBMIT', text: 'Save changes' },
    ]) {
      const err = captureThrow(() => assertClickable(candidate));
      assert.ok(err instanceof GuardrailError, `expected GuardrailError for ${JSON.stringify(candidate)}`);
      assert.equal(err.rule, 'no-form-submit');
      assert.ok(err.message.includes(candidate.selector), 'message should name the selector');
    }
  });

  it('allows a plain input[type=button] or input[type=reset]', () => {
    assert.doesNotThrow(() => assertClickable({ tagName: 'input', type: 'button', text: 'Save' }));
    assert.doesNotThrow(() => assertClickable({ tagName: 'input', type: 'reset' }));
  });

  const DESTRUCTIVE = [
    'Submit',
    'submit',
    'SUBMIT',
    // NOTE: "Send" is deliberately NOT here. Sending a message or applying a filter is
    // routine and reversible; blocking it would push agents to reach for force:true
    // reflexively, which weakens every other rule. Real submit risk is covered by the
    // form-submit patterns and the page-side runtime blocker.
    '  Delete',
    '\tDelete account',
    '\n  Deploy production',
    'Publish',
    'publish post',
    'Destroy everything',
    'Purchase now',
    'Buy',
    'Pay',
    'Pay invoice',
    'Confirm order',
    'CONFIRM ORDER',
    // Bare "confirm" is deliberately in the verb list, so it over-matches an innocent "Confirm".
    'Confirm',
    // Inflections the \b boundary used to hide behind ("deleting"/"deleted" are distinct words).
    'Deleting account',
    'Deleted items',
    // Synonyms that were simply absent from the old verb list.
    'Remove item',
    'Removing items',
    'Cancel subscription',
    'Unsubscribe',
    'Reset workspace',
    'Danger zone',
    'Destructive action',
    'Checkout',
    'Logout',
  ];

  it('rejects labels that begin with a destructive verb', () => {
    for (const text of DESTRUCTIVE) {
      const err = captureThrow(() => assertClickable({ selector: '#btn', tagName: 'button', text }));
      assert.ok(err instanceof GuardrailError, `expected GuardrailError for label ${JSON.stringify(text)}`);
      assert.equal(err.rule, 'irreversible-action', `wrong rule for label ${JSON.stringify(text)}`);
    }
  });

  it('rejects destructive text on an anchor too, not just buttons', () => {
    const err = captureThrow(() => assertClickable({ tagName: 'a', text: 'Publish' }));
    assert.equal(err.rule, 'irreversible-action');
  });

  it('allows near-miss words that only share a prefix with a destructive verb', () => {
    // Real false positives this prevents: "Sender", "Publisher", "Buyer", "Payment history"
    // are navigation/informational labels. The \b boundary is what keeps them clickable.
    const nearMisses = [
      { tagName: 'button', text: 'Sender' },
      { tagName: 'button', text: 'Publisher' },
      { tagName: 'button', text: 'Deletegate' }, // nonsense word, but it must not match "delete"
      { tagName: 'button', text: 'Buyer' },
      { tagName: 'button', text: 'Payment history' },
      { tagName: 'button', text: 'Sending receipts' },
      { tagName: 'button', text: 'Confirmation code' }, // "confirm" needs a word boundary after it
      { tagName: 'button', text: 'Submitters' },
    ];
    for (const candidate of nearMisses) {
      assert.doesNotThrow(() => assertClickable(candidate), `should be clickable: ${JSON.stringify(candidate)}`);
    }
  });

  it('exposes a force/report-audit hint on the irreversible-action error', () => {
    const err = captureThrow(() => assertClickable({ selector: '#del', tagName: 'button', text: 'Delete account' }));
    const payload = err.toPayload();
    assert.equal(payload.guardrail, 'irreversible-action');
    assert.ok(typeof payload.hint === 'string' && payload.hint.length > 0);
    assert.match(payload.hint, /force/i);
  });
});

describe('assertDownloadAllowed — downloads write outside the page', () => {
  it('throws when a download attribute is present', () => {
    for (const download of ['report.pdf', 'report.pdf"', '', false, 0]) {
      const err = captureThrow(() => assertDownloadAllowed({ selector: 'a#dl', download }));
      assert.ok(err instanceof GuardrailError, `expected GuardrailError for download=${JSON.stringify(download)}`);
      assert.equal(err.rule, 'no-downloads');
    }
  });

  it('presence alone triggers the rule, so an empty download="" is still blocked', () => {
    // Real accident this prevents: CDP often serializes the attribute as "" rather than a
    // filename. A truthiness check would silently let that download through.
    const err = captureThrow(() => assertDownloadAllowed({ href: 'https://localhost:3000/export.csv', download: '' }));
    assert.equal(err.rule, 'no-downloads');
  });

  it('passes when the download attribute is absent, undefined, or null', () => {
    assert.doesNotThrow(() => assertDownloadAllowed({ href: '/page', selector: 'a' }));
    assert.doesNotThrow(() => assertDownloadAllowed({ download: undefined }));
    assert.doesNotThrow(() => assertDownloadAllowed({ download: null }));
    assert.doesNotThrow(() => assertDownloadAllowed());
    assert.doesNotThrow(() => assertDownloadAllowed({}));
  });

  it('names the selector when present and falls back to the href', () => {
    const withSelector = captureThrow(() => assertDownloadAllowed({ selector: 'a#export', href: '/x', download: 'x.csv' }));
    assert.match(withSelector.message, /a#export/);

    const withHref = captureThrow(() => assertDownloadAllowed({ href: '/firmware.bin', download: true }));
    assert.match(withHref.message, /firmware\.bin/);
  });

  it('carries the override hint in its payload', () => {
    const err = captureThrow(() => assertDownloadAllowed({ download: 'x' }));
    assert.equal(err.toPayload().guardrail, 'no-downloads');
    assert.match(err.toPayload().hint, /WEBH_ALLOW_DOWNLOADS=1/);
  });
});

describe('guardrailSummary — reports the active policy', () => {
  it('returns exactly the documented keys with string values', () => {
    const summary = guardrailSummary();
    assert.deepEqual(Object.keys(summary).sort(), ['audit', 'downloads', 'formSubmit', 'navigation']);
    for (const [key, value] of Object.entries(summary)) {
      assert.equal(typeof value, 'string', `${key} should be a string`);
      assert.ok(value.length > 0, `${key} should not be empty`);
    }
  });

  it('describes the restrictive default policy', () => {
    const summary = guardrailSummary();
    assert.match(summary.navigation, /local/i);
    assert.match(summary.formSubmit, /blocked/i);
    assert.equal(summary.downloads, 'blocked');
  });

  it('reports the audit log path when mutation auditing is on', () => {
    assert.equal(config.auditMutations, true);
    assert.equal(guardrailSummary().audit, config.auditLog);
    assert.match(guardrailSummary().audit, /audit\.jsonl$/);
  });
});

describe('GuardrailError payload contract', () => {
  it('is a GuardrailError/ToolError/Error carrying rule, hint, details, and guardrail', () => {
    const err = new GuardrailError('nope', { rule: 'demo-rule', hint: 'do the safer thing', details: { a: 1 } });
    assert.ok(err instanceof GuardrailError);
    assert.ok(err instanceof ToolError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'GuardrailError');
    assert.equal(err.rule, 'demo-rule');
    assert.deepEqual(err.toPayload(), {
      error: 'nope',
      hint: 'do the safer thing',
      guardrail: 'demo-rule',
      details: { a: 1 },
    });
  });

  it('omits details (rather than fabricating one) when none were supplied', () => {
    // Some guardrail throws carry no details; the payload must stay honest about that.
    const payload = new GuardrailError('nope', { rule: 'r', hint: 'h' }).toPayload();
    assert.deepEqual(Object.keys(payload).sort(), ['error', 'guardrail', 'hint']);
  });
});

describe('permissive mode (fresh child processes)', () => {
  it('WEBH_ALLOW_FORM_SUBMIT=1 allows submit-shaped eval and submit/destructive clicks', async () => {
    const result = await probeChild(
      [
        `attempt('evalSubmit', () => g.assertEvalAllowed('document.querySelector("form").submit()'));`,
        `attempt('clickInputSubmit', () => g.assertClickable({ tagName: 'input', type: 'submit', selector: '#go' }));`,
        `attempt('clickDestructive', () => g.assertClickable({ tagName: 'button', text: 'Delete account' }));`,
        'out.summary = g.guardrailSummary();',
      ].join('\n'),
      { WEBH_ALLOW_FORM_SUBMIT: '1' },
    );
    const out = parsed(result, 'WEBH_ALLOW_FORM_SUBMIT=1');
    assert.equal(out.evalSubmit.ok, true);
    assert.equal(out.evalSubmit.value, 'document.querySelector("form").submit()');
    assert.equal(out.clickInputSubmit.ok, true);
    assert.equal(out.clickDestructive.ok, true);
    assert.equal(out.summary.formSubmit, 'allowed');
    // Other rules must stay enforced when only the submit flag is set.
    assert.equal(out.summary.downloads, 'blocked');
    assert.match(out.summary.navigation, /local/i);
  });

  it('WEBH_ALLOW_FORM_SUBMIT=0 and =false stay restrictive', async () => {
    for (const value of ['0', 'false', 'no', 'off']) {
      const result = await probeChild(
        `attempt('evalSubmit', () => g.assertEvalAllowed('form.submit()'));`,
        { WEBH_ALLOW_FORM_SUBMIT: value },
      );
      const out = parsed(result, `WEBH_ALLOW_FORM_SUBMIT=${value}`);
      assert.equal(out.evalSubmit.ok, false, `WEBH_ALLOW_FORM_SUBMIT=${value} must not enable submits`);
      assert.equal(out.evalSubmit.rule, 'no-form-submit');
    }
  });

  it('WEBH_ALLOW_REMOTE_NAVIGATION=1 allows a remote URL', async () => {
    const result = await probeChild(
      [
        `attempt('navigate', () => g.assertNavigable('https://example.com/'));`,
        `attempt('stillLocal', () => g.assertNavigable('http://localhost:3000/'));`,
        'out.summary = g.guardrailSummary();',
      ].join('\n'),
      { WEBH_ALLOW_REMOTE_NAVIGATION: '1' },
    );
    const out = parsed(result, 'WEBH_ALLOW_REMOTE_NAVIGATION=1');
    assert.equal(out.navigate.ok, true);
    assert.equal(out.navigate.value, 'https://example.com/');
    assert.equal(out.stillLocal.ok, true);
    assert.equal(out.summary.navigation, 'any URL');
    // Remote navigation must not implicitly unlock submits or downloads.
    assert.match(out.summary.formSubmit, /blocked/i);
    assert.equal(out.summary.downloads, 'blocked');
  });

  it('WEBH_ALLOW_DOWNLOADS=1 allows a download', async () => {
    const result = await probeChild(
      [
        `attempt('download', () => g.assertDownloadAllowed({ selector: 'a#dl', download: 'report.pdf' }));`,
        'out.summary = g.guardrailSummary();',
      ].join('\n'),
      { WEBH_ALLOW_DOWNLOADS: '1' },
    );
    const out = parsed(result, 'WEBH_ALLOW_DOWNLOADS=1');
    assert.equal(out.download.ok, true);
    assert.equal(out.summary.downloads, 'allowed');
    assert.match(out.summary.formSubmit, /blocked/i);
  });

  it('WEBH_AUDIT_MUTATIONS=0 reports the audit trail as disabled', async () => {
    const result = await probeChild('out.summary = g.guardrailSummary();', { WEBH_AUDIT_MUTATIONS: '0' });
    const out = parsed(result, 'WEBH_AUDIT_MUTATIONS=0');
    assert.equal(out.summary.audit, 'disabled');
  });

  it('a clean process blocks remote navigation by default with a non-zero exit code', async () => {
    // The guard must fail the tool call, not silently continue: an uncaught throw from the
    // module has to surface as a failed process carrying the GuardrailError rule.
    const result = await runChild(
      `const g = await import(${JSON.stringify(GUARDRAILS_URL)});\ng.assertNavigable('https://example.com');`,
    );
    assert.equal(result.status, 1, `expected exit code 1, got ${result.status}: ${result.stdout}`);
    assert.match(result.stderr, /GuardrailError/);
    assert.match(result.stderr, /local-navigation/);
  });
});

