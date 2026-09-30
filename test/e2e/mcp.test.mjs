import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  startFixtureServer,
  makeStateDir,
  rmDir,
  harnessEnv,
  McpClient,
  killBrowserFromStateDir,
} from '../helpers/harness-runner.mjs';

/**
 * End-to-end MCP tests.
 *
 * These drive the real server over real stdio against a real Chromium, because the
 * failure modes that matter here — a dropped frame, a tool result that never gets
 * wrapped in a content block, a guardrail that crashes instead of reporting — are
 * invisible to unit tests. `--test-concurrency=1` keeps one browser session in play.
 */
const PORT = 9401;
let fixture;
let stateDir;
let client;

before(async () => {
  fixture = await startFixtureServer();
  stateDir = makeStateDir('mcp');
  client = new McpClient({ env: harnessEnv(stateDir, PORT) });
  const init = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: { name: 'e2e', version: '1' },
    capabilities: {},
  });
  assert.equal(init.result.protocolVersion, '2024-11-05', 'server must negotiate a supported protocol version');
  client.notify('notifications/initialized', {});
}, { timeout: 60_000 });

after(async () => {
  if (client) await client.close();
  killBrowserFromStateDir(stateDir);
  if (fixture) fixture.server.close();
  if (stateDir) rmDir(stateDir);
});

describe('MCP protocol handshake', () => {
  test('advertises the tools capability and server identity', async () => {
    const res = await client.request('initialize', { protocolVersion: '2024-11-05' });
    assert.ok(res.result.capabilities.tools, 'tools capability must be advertised or clients will not list tools');
    assert.equal(res.result.serverInfo.name, 'web-harness');
    assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
  });

  test('answers ping so clients can health-check', async () => {
    const res = await client.request('ping', {});
    assert.ok(res.result !== undefined);
  });

  test('responds to an unknown method with JSON-RPC -32601 instead of silence', async () => {
    // Silence here would hang the client until its own timeout — a nasty failure mode.
    const res = await client.request('does/not/exist', {});
    assert.equal(res.error?.code, -32601);
  });

  test('returns an empty resource list rather than an error', async () => {
    const res = await client.request('resources/list', {});
    assert.deepEqual(res.result.resources, []);
  });
});

describe('MCP tool catalogue', () => {
  test('lists every tool with the schema fields clients require', async () => {
    const res = await client.request('tools/list', {});
    const tools = res.result.tools;
    assert.ok(tools.length >= 15, `expected a substantial catalogue, got ${tools.length}`);
    for (const tool of tools) {
      assert.ok(tool.name, 'every tool needs a name');
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description for the model to choose it`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema must be an object schema`);
    }
  });

  test('exposes exactly the tool names the CLI advertises', async () => {
    const res = await client.request('tools/list', {});
    const names = res.result.tools.map((t) => t.name).sort();
    const expected = ['browser_close', 'browser_list_pages', 'browser_open', 'browser_status', 'dom_query', 'dom_structure', 'page_a11y', 'page_audit_log', 'page_close', 'page_computed_style', 'page_console', 'page_eval', 'page_interact', 'page_navigate', 'page_network', 'page_new', 'page_reload', 'page_screenshot', 'page_select', 'page_set_style', 'page_snapshot', 'page_wait_for'].sort();
    assert.deepEqual(names, expected);
  });
});

describe('MCP browser round-trip against a live page', () => {
  test('navigates, then reports the real document in one snapshot', async () => {
    const nav = await client.callTool('page_navigate', { url: fixture.url });
    assert.equal(nav.isError, false, nav.text);

    const snap = await client.callTool('page_snapshot', {});
    assert.equal(snap.isError, false, snap.text);
    assert.match(snap.text, /webh fixture/, 'snapshot must reflect the live <title>');
    assert.match(snap.text, /elements=\d+/, 'snapshot must report document counts');
    assert.match(snap.text, /forms=1/, 'the fixture has exactly one form');

    const jsonBlock = snap.content.find((c) => c.type === 'text' && c.text.startsWith('```json'));
    assert.ok(jsonBlock, 'structured payload should be attached as a JSON block for machine consumers');
  });

  test('queries the DOM for real elements with geometry and visibility', async () => {
    const res = await client.callTool('dom_query', { selector: '.card', limit: 2 });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /3 match/, 'fixture renders three cards');
    assert.match(res.text, /article\.card/, 'result must name the element');
    assert.match(res.text, /\d+x\d+@/, 'result must include geometry');
  });

  test('reports computed style with the winning rule', async () => {
    const res = await client.callTool('page_computed_style', { selector: '#hero', properties: ['display'] });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /display: none/, 'the hero is hidden by design in the fixture');
    assert.match(res.text, /#hero \{ display: none \}/, 'must name the stylesheet rule responsible');
  });

  test('returns a screenshot as an image content block', async () => {
    const res = await client.callTool('page_screenshot', { format: 'png' });
    assert.equal(res.isError, false, res.text);
    const image = res.content.find((c) => c.type === 'image');
    assert.ok(image, 'screenshot must produce an image block so a vision model can see it');
    assert.equal(image.mimeType, 'image/png');
    assert.ok(image.data.length > 1000, 'image payload looks too small to be a real render');
    assert.doesNotThrow(() => Buffer.from(image.data, 'base64'), 'image data must be valid base64');
  });

  test('surfaces page console errors and failed requests', async () => {
    const console_ = await client.callTool('page_console', { level: 'error' });
    assert.equal(console_.isError, false, console_.text);
    assert.match(console_.text, /deliberate uncaught error/, 'the fixture throws on purpose');

    const network = await client.callTool('page_network', { failedOnly: true });
    assert.equal(network.isError, false, network.text);
    assert.match(network.text, /FAILED|404/, 'the fixture makes a request that cannot succeed');
  });

  test('evaluates JavaScript and returns a structured value', async () => {
    const res = await client.callTool('page_eval', { expression: "(() => ({ cards: document.querySelectorAll('.card').length }))()" });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /"cards": 3/);
  });

  test('clicks a real element and the page state changes', async () => {
    await client.callTool('page_eval', { expression: "document.getElementById('counter').textContent = '0'" });
    const click = await client.callTool('page_interact', { action: 'click', selector: '.card .add' });
    assert.equal(click.isError, false, click.text);
    const after = await client.callTool('page_eval', { expression: "document.getElementById('counter').textContent" });
    assert.match(after.text, /→ 1/, 'the click must have run the page handler, proving real input events');
  });

  test('types into a controlled field and reports the new value', async () => {
    const res = await client.callTool('page_interact', { action: 'type', selector: '#email', value: 'agent@example.com' });
    assert.equal(res.isError, false, res.text);
    const value = await client.callTool('page_eval', { expression: "document.getElementById('email').value" });
    assert.match(value.text, /agent@example\.com/);
  });

  test('waits for an element that appears asynchronously', async () => {
    await client.callTool('page_interact', { action: 'click', selector: '#lateBtn' });
    const res = await client.callTool('page_wait_for', { for: 'element', selector: '#late-content', timeoutMs: 5000 });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /satisfied after \d+ms/);
  });
});

describe('MCP guardrails and error reporting', () => {
  test('refuses a form submit from eval and explains the guardrail', async () => {
    const res = await client.callTool('page_eval', { expression: "document.querySelector('form').submit()" });
    assert.equal(res.isError, true, 'a blocked action must be an error result, not a silent success');
    assert.match(res.text, /Guardrail: no-form-submit/);
    assert.match(res.text, /Hint:/, 'the agent needs a way forward, not just a refusal');
  });

  test('refuses an eval that clicks a destructive control', async () => {
    const res = await client.callTool('page_eval', { expression: "document.querySelector('#danger').click()" });
    assert.equal(res.isError, true, res.text);
    assert.match(res.text, /eval-destructive-click/);
  });

  test('refuses a destructive click through page_interact', async () => {
    const res = await client.callTool('page_interact', { action: 'click', text: 'Delete account' });
    assert.equal(res.isError, true, res.text);
    assert.match(res.text, /irreversible-action/);
  });

  test('a force-click submit is stopped by the runtime guard and reported to the agent', async () => {
    // force:true bypasses the tool layer on purpose. The page-side listener must still
    // cancel the submit, and page_snapshot must say so — otherwise the click just
    // appears to do nothing and the agent wastes turns debugging its own guardrail.
    const click = await client.callTool('page_interact', { action: 'click', selector: '#signup button', force: true });
    assert.equal(click.isError, false, click.text);

    const snap = await client.callTool('page_snapshot', {});
    assert.equal(snap.isError, false, snap.text);
    assert.match(snap.text, /blocked form submits: \d+/, 'the intercepted submit must be visible in the snapshot');
    assert.match(snap.text, /Submits are disabled/, 'the agent needs to be told how to proceed');
  });

  test('refuses navigation off the local machine', async () => {
    const res = await client.callTool('page_navigate', { url: 'https://example.com/' });
    assert.equal(res.isError, true, res.text);
    assert.match(res.text, /local-navigation/);
  });

  test('names a near-miss tool instead of failing blankly', async () => {
    const res = await client.callTool('page_snapsho', {});
    assert.equal(res.isError, true);
    assert.match(res.text, /Unknown tool/);
    assert.match(res.text, /page_snapshot/, 'a suggestion is what lets the agent recover without a human');
  });

  test('reports a missing required argument with the expected shape', async () => {
    const res = await client.callTool('dom_query', {});
    assert.equal(res.isError, true, res.text);
    assert.match(res.text, /selector/);
  });

  test('never lets a page-side exception kill the server', async () => {
    const res = await client.callTool('page_eval', { expression: 'throw new Error("page exploded")' });
    assert.equal(res.isError, true, res.text);
    assert.match(res.text, /page exploded/);
    // The connection must still work after a page-side throw.
    const alive = await client.callTool('page_eval', { expression: '1 + 1' });
    assert.equal(alive.isError, false, 'server must survive a throwing evaluation');
  });

  test('keeps serving after a malformed frame', async () => {
    client.child.stdin.write('{ this is not json }\n');
    await new Promise((r) => setTimeout(r, 400));
    const res = await client.callTool('page_eval', { expression: '2 + 2' });
    assert.equal(res.isError, false, res.text);
  });
});
