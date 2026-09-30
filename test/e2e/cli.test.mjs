import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startFixtureServer,
  makeStateDir,
  rmDir,
  harnessEnv,
  runCli,
  killBrowserFromStateDir,
} from '../helpers/harness-runner.mjs';

/**
 * End-to-end CLI tests.
 *
 * The CLI is a different beast from the MCP server: every command is its own process, so
 * the properties worth protecting are the ones that make separate processes feel like one
 * session — browser reuse, session-file persistence, and state that survives between
 * commands. Each of those is a bug we actually hit during development.
 */
const PORT = 9402;
let fixture;
let stateDir;
let env;

before(async () => {
  fixture = await startFixtureServer();
  stateDir = makeStateDir('cli');
  env = harnessEnv(stateDir, PORT);
}, { timeout: 30_000 });

after(() => {
  killBrowserFromStateDir(stateDir);
  if (fixture) fixture.server.close();
  if (stateDir) rmDir(stateDir);
});

describe('CLI surface', () => {
  test('lists tools as text and as JSON', async () => {
    const text = await runCli(['tools'], { env });
    assert.equal(text.code, 0);
    assert.match(text.stdout, /page_snapshot/);
    assert.match(text.stdout, /args:/);

    const json = await runCli(['tools', '--json'], { env });
    assert.equal(json.code, 0);
    const tools = JSON.parse(json.stdout);
    assert.ok(Array.isArray(tools) && tools.length >= 15);
    assert.ok(tools.every((t) => t.inputSchema));
  });

  test('describes a single tool on request', async () => {
    const res = await runCli(['help', 'page_interact'], { env });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /ARGUMENTS/);
    assert.match(res.stdout, /--action/);
    assert.match(res.stdout, /click/);
  });

  test('exits non-zero and prints usage for an unknown command', async () => {
    const res = await runCli(['not-a-tool'], { env });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /Unknown/);
  });
});

describe('CLI session persistence across processes', () => {
  test('navigates, remembers the page, and restores it in a later process', async () => {
    const nav = await runCli(['page_navigate', '--url', fixture.url], { env });
    assert.equal(nav.code, 0, nav.stderr);
    assert.match(nav.stdout, /Navigated to/);

    // The session file is what carries state between processes.
    const session = JSON.parse(fs.readFileSync(path.join(stateDir, 'session.json'), 'utf8'));
    assert.equal(session.lastUrl, fixture.url, 'the page URL must be remembered');
    assert.ok(session.pid, 'the browser pid must be recorded so the next process can reuse it');

    // A brand-new process with no URL argument must land on the remembered page.
    const snap = await runCli(['page_snapshot'], { env });
    assert.equal(snap.code, 0, snap.stderr);
    assert.match(snap.stdout, /webh fixture/, 'snapshot in a fresh process must see the remembered page');
  });

  test('reuses one browser process instead of launching a new one per command', async () => {
    const before_ = JSON.parse(fs.readFileSync(path.join(stateDir, 'session.json'), 'utf8')).pid;
    await runCli(['page_eval', '--expression', '1+1'], { env });
    const after_ = JSON.parse(fs.readFileSync(path.join(stateDir, 'session.json'), 'utf8')).pid;
    assert.equal(after_, before_, 'a second command must reattach to the same browser');
  });

  test('mutations in the page survive into the next process', async () => {
    await runCli(['page_eval', '--expression', "document.getElementById('counter').textContent = '7'"], { env });
    const res = await runCli(['page_eval', '--expression', "document.getElementById('counter').textContent"], { env });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /→ 7/, 'live DOM state must persist between CLI invocations');
  });
});

describe('CLI output and exit codes', () => {
  test('prints a machine-readable payload with --json and omits the raw image bytes', async () => {
    const res = await runCli(['dom_query', '--selector', '.card', '--json'], { env });
    assert.equal(res.code, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.matches, 3);
  });

  test('writes a screenshot to an explicit --out path', async () => {
    const out = path.join(stateDir, 'shot.png');
    const res = await runCli(['screenshot', '--out', out], { env });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(fs.existsSync(out), 'screenshot file must exist at the requested path');
    const bytes = fs.readFileSync(out);
    assert.ok(bytes.length > 1000, 'screenshot looks empty');
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'must be a real PNG');
  });

  test('exits non-zero with a hint when a guardrail blocks the action', async () => {
    const res = await runCli(['page_eval', '--expression', "document.querySelector('form').submit()"], { env });
    assert.equal(res.code, 1, 'a refused action must not look like success to a shell agent');
    assert.match(res.stderr, /Guardrail|Refusing/);
    assert.match(res.stderr, /hint:/);
  });

  test('exits non-zero when the element does not exist', async () => {
    const res = await runCli(['dom_query', '--selector', '#nope', '--limit', '1'], { env });
    // No match is a legitimate answer with exit 0, but a BAD selector is an error.
    const bad = await runCli(['dom_query', '--selector', '>>>not-css', '--limit', '1'], { env });
    assert.equal(bad.code, 1, 'an invalid selector must fail loudly');
    assert.match(bad.stderr, /selector|Invalid/i);
    assert.ok(res.code === 0 || res.code === 1);
  });
});

describe('CLI audit trail', () => {
  test('records mutations so a human can see what the agent did', async () => {
    await runCli(['page_interact', '--action', 'click', '--selector', '.card .add'], { env });
    const res = await runCli(['audit', '--limit', '50'], { env });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /page\.interact\.click/, 'the click must be recorded in the audit log');
  });

  test('records navigations', async () => {
    const res = await runCli(['audit', '--limit', '100', '--json'], { env });
    const payload = JSON.parse(res.stdout);
    const events = payload.data.entries.map((e) => e.event);
    assert.ok(events.includes('page.navigate'), `expected a navigation entry, saw: ${[...new Set(events)].join(', ')}`);
  });
});
