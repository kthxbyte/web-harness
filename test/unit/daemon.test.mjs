import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Daemon tests.
 *
 * These are primarily SECURITY tests. The daemon executes arbitrary JavaScript in the
 * user's browser, so the properties worth pinning are the ones that stop a web page from
 * doing the same. A regression here is not a broken feature, it is a compromised browser.
 *
 * The daemon is constructed in-process with a stub harness: these tests are about the HTTP
 * contract and the auth gate, not about CDP, which the e2e suites already cover.
 */

const { Daemon, safeEqual, isAllowedOrigin } = await import('../../src/lib/daemon.mjs');

/** Minimal harness stand-in: only what the routes we exercise actually touch. */
function stubHarness() {
  return {
    connected: true,
    page: null,
    browser: {
      version: 'Stub/1.0',
      listTargets: async () => [
        { targetId: 'target-github', url: 'https://github.com/kthxbyte/web-harness', title: 'GitHub' },
        { targetId: 'target-local', url: 'http://127.0.0.1:5173/', title: 'Dev server' },
      ],
      attachTo: async (t) => ({ targetId: t.targetId, url: t.url, title: t.title, sessionId: 'sess-' + t.targetId, enableDomains: async () => {}, on: () => {} }),
    },
    ensure: async () => {},
    status: async () => ({ browser: { product: 'Stub/1.0' }, currentPage: { url: 'about:blank' }, guardrails: { navigation: 'local only' } }),
    pages: async () => ({ current: null, pages: [{ targetId: 'target-github', url: 'https://github.com/kthxbyte/web-harness' }] }),
    shutdown: async () => {},
  };
}

let daemon;
let base;
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

before(async () => {
  daemon = new Daemon({ harness: stubHarness(), host: '127.0.0.1', port: 0, token: TOKEN });
  await daemon.start();
  base = `http://127.0.0.1:${daemon.address.port}`;
});

after(async () => {
  await daemon.stop();
});

async function call(path, { method = 'GET', headers = {}, body = null } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : null,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}

describe('daemon security: token gate', () => {
  test('/health is reachable without a token and leaks nothing sensitive', async () => {
    const res = await call('/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const blob = JSON.stringify(res.json);
    assert.ok(!blob.includes(TOKEN), 'the token must never appear in an unauthenticated response');
    assert.ok(!('token' in res.json), 'no token field at all');
  });

  test('every state-changing or reading route rejects a missing token', async () => {
    for (const path of ['/state', '/tools', '/pages', '/log']) {
      const res = await call(path);
      assert.equal(res.status, 401, `${path} must require a token`);
    }
    const post = await call('/command', { method: 'POST', body: { tool: 'page_eval', args: { expression: '1' } } });
    assert.equal(post.status, 401, '/command must require a token');
  });

  test('a wrong token of the same length is rejected', async () => {
    const wrong = 'x'.repeat(TOKEN.length);
    const res = await call('/state', { headers: { 'x-webh-token': wrong } });
    assert.equal(res.status, 401);
  });

  test('a token that is a prefix of the real one is rejected', async () => {
    // Guards against any future "startsWith" style comparison sneaking in.
    const res = await call('/state', { headers: { 'x-webh-token': TOKEN.slice(0, 16) } });
    assert.equal(res.status, 401);
  });

  test('the token is accepted in the x-webh-token header', async () => {
    const res = await call('/state', { headers: { 'x-webh-token': TOKEN } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });
});

describe('daemon security: the localhost-daemon attack', () => {
  test('a web page origin is refused even with the CORRECT token', async () => {
    // This is the whole point: a malicious page cannot read .webh/daemon.json, but if the
    // token ever leaked (screenshot, log, shared clipboard) origin must still stop it.
    for (const origin of ['https://evil.example.com', 'http://localhost:3000', 'https://github.com']) {
      const res = await call('/state', { headers: { 'x-webh-token': TOKEN, origin } });
      assert.equal(res.status, 403, `origin ${origin} must be refused`);
    }
  });

  test('a web origin is refused on /health too, so it cannot even probe the port', async () => {
    const res = await call('/health', { headers: { origin: 'https://evil.example.com' } });
    assert.equal(res.status, 403);
  });

  test('extension origins are allowed', async () => {
    for (const origin of ['chrome-extension://abc', 'moz-extension://abc', 'safari-web-extension://abc']) {
      const res = await call('/health', { headers: { origin } });
      assert.equal(res.status, 200, `${origin} should be allowed`);
    }
  });

  test('a request with no Origin header is allowed (service worker fetch)', async () => {
    const res = await call('/state', { headers: { 'x-webh-token': TOKEN } });
    assert.equal(res.status, 200);
  });

  test('the origin allowlist matches the parsed protocol, not a substring', async () => {
    // These look-alikes must all fail. A `startsWith('chrome-extension://')` check passes
    // the first one, because the allowed string appears inside a hostile value.
    assert.equal(isAllowedOrigin('https://evil.com/chrome-extension://x'), false);
    assert.equal(isAllowedOrigin('https://chrome-extension://evil.com'), false);
    assert.equal(isAllowedOrigin('chrome-extension://x/../..'), true, 'still an extension origin');
    assert.equal(isAllowedOrigin('file:///tmp/x.html'), false);
    assert.equal(isAllowedOrigin('not a url'), false, 'unparseable must be refused, not guessed');
    assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), false);
  });
});

describe('daemon auth helpers', () => {
  test('safeEqual is length-tolerant and never throws', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual(null, undefined), true);
    assert.equal(safeEqual('abc', null), false);
  });

  test('isAllowedOrigin treats absent Origin as allowed and unknown schemes as not', () => {
    assert.equal(isAllowedOrigin(undefined), true);
    assert.equal(isAllowedOrigin(null), true);
    assert.equal(isAllowedOrigin('chrome-extension://x'), true);
    assert.equal(isAllowedOrigin('https://example.com'), false);
  });
});

describe('daemon tab targeting', () => {
  test('rejects a command with no tool name', async () => {
    const res = await call('/command', { method: 'POST', headers: { 'x-webh-token': TOKEN }, body: {} });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /tool/);
  });

  test('records an announced tab and echoes it back in state', async () => {
    const tab = { targetId: 'target-github', url: 'https://github.com/kthxbyte/web-harness' };
    const set = await call('/tab', { method: 'POST', headers: { 'x-webh-token': TOKEN }, body: { tab } });
    assert.equal(set.status, 200);
    assert.deepEqual(set.json.data.activeTab, tab);

    const state = await call('/state', { headers: { 'x-webh-token': TOKEN } });
    assert.deepEqual(state.json.data.activeTab, tab);
  });

  test('surfaces a note when the announced tab no longer exists', async () => {
    await call('/tab', { method: 'POST', headers: { 'x-webh-token': TOKEN }, body: { tab: { targetId: 'gone', url: 'http://gone.example/' } } });
    const res = await call('/command', {
      method: 'POST',
      headers: { 'x-webh-token': TOKEN },
      body: { tool: 'browser_list_pages', args: {} },
    });
    assert.equal(res.status, 200);
    assert.match(res.json.data.targetNote ?? '', /gone/, 'the panel must be told the tab vanished');
  });

  test('does not expose the token through /state or /log', async () => {
    const state = await call('/state', { headers: { 'x-webh-token': TOKEN } });
    const log = await call('/log', { headers: { 'x-webh-token': TOKEN } });
    assert.ok(!JSON.stringify(state.json).includes(TOKEN));
    assert.ok(!JSON.stringify(log.json).includes(TOKEN));
  });
});

describe('daemon discovery', () => {
  test('/manifest reports that a token is required without handing one out', async () => {
    const res = await call('/manifest');
    assert.equal(res.status, 200);
    assert.equal(res.json.data.requiresToken, true);
    assert.ok(!JSON.stringify(res.json).includes(TOKEN), 'discovery must never return the token');
  });

  test('unknown routes 404 rather than hanging', async () => {
    const res = await call('/nope', { headers: { 'x-webh-token': TOKEN } });
    assert.equal(res.status, 404);
  });
});
