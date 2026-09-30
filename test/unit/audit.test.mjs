/**
 * Unit tests for src/lib/audit.mjs.
 *
 * IMPORTANT: config.mjs caches process.env at import time, so WEBH_STATE_DIR must be set
 * BEFORE the modules are imported. That is why the imports below are dynamic and why this
 * happens at the very top of the file, above every test. Pointing WEBH_STATE_DIR at a fresh
 * temp dir guarantees the real project audit log (<root>/.webh/audit.jsonl) is never touched.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP_ROOT = path.join(PROJECT_ROOT, 'test', 'tmp');
fsSync.mkdirSync(TMP_ROOT, { recursive: true });

// Must precede the dynamic imports: config reads these exactly once, at import time.
const STATE_DIR = await fs.mkdtemp(path.join(TMP_ROOT, 'audit-state-'));
process.env.WEBH_STATE_DIR = STATE_DIR;
process.env.WEBH_LOG_LEVEL = 'error'; // audit warnings go to stderr; keep test output clean
delete process.env.WEBH_AUDIT_MUTATIONS; // make sure auditing is enabled in this process

const { config } = await import('../../src/lib/config.mjs');
const { audit, readAudit, flushAudit, clearAudit } = await import('../../src/lib/audit.mjs');

const AUDIT_URL = pathToFileURL(path.join(PROJECT_ROOT, 'src', 'lib', 'audit.mjs')).href;

/** Raw non-empty lines currently on disk, in file order. */
async function onDiskLines() {
  const raw = await fs.readFile(config.auditLog, 'utf8');
  return raw.split('\n').filter(Boolean);
}

before(() => {
  // The whole file must be isolated from the real project state dir.
  assert.equal(config.auditLog, path.join(STATE_DIR, 'audit.jsonl'));
});

beforeEach(async () => {
  // config is cached, so we cannot swap stateDir per test; instead every test starts from
  // an empty log so assertions on `total` and ordering are unambiguous.
  await clearAudit();
});

after(async () => {
  await fs.rm(STATE_DIR, { recursive: true, force: true });
});

describe('audit()', () => {
  it('appends one JSON line with an ISO timestamp, event and merged fields', async () => {
    await audit('event.name', { a: 1, nested: { x: 2 } });
    await flushAudit();

    const { entries, total } = await readAudit();
    assert.equal(total, 1);
    assert.equal(entries.length, 1);

    const [entry] = entries;
    assert.equal(entry.event, 'event.name');
    assert.equal(entry.a, 1);
    assert.deepEqual(entry.nested, { x: 2 }); // extra fields are merged, not dropped
    assert.equal(typeof entry.at, 'string');
    // `at` must be real ISO-8601 that Date can round-trip.
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(entry.at).toISOString(), entry.at);

    // The file is JSON Lines: exactly one parseable line, newline terminated.
    const lines = await onDiskLines();
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), entry);
  });

  it('defaults missing data to an object without inventing fields', async () => {
    await audit('no.data');
    const { entries } = await readAudit();
    assert.equal(entries[0].event, 'no.data');
    assert.ok(!('a' in entries[0]));
  });

  it('returns a promise that resolves only after the record is on disk', async () => {
    // Callers rely on `await audit(...)` being enough to make the record durable, without
    // a separate flushAudit(). If audit() ever fired-and-forgot, this would race and fail.
    const returned = audit('durable', { ok: true });
    assert.ok(returned && typeof returned.then === 'function', 'audit() should return a thenable');
    await returned;

    const { entries, total } = await readAudit();
    assert.equal(total, 1);
    assert.equal(entries[0].event, 'durable');
    assert.equal(entries[0].ok, true);
  });

  it('serializes rapid calls through the internal queue, preserving call order', async () => {
    // Key property under test: audit() enqueues on a promise chain, so firing many writes
    // without awaiting them must not interleave or reorder appends on disk. The ~8KB payload
    // makes a non-serialized implementation produce torn/overlapping JSON lines, which shows
    // up here as unparseable entries or cross-contaminated payloads.
    const COUNT = 25;
    const payloadFor = (i) => `${i}:`.repeat(2000);
    for (let i = 0; i < COUNT; i += 1) audit('seq', { i, payload: payloadFor(i) }); // not awaited
    await flushAudit();

    const { entries, total } = await readAudit({ limit: 1000 });
    assert.equal(total, COUNT);
    assert.deepEqual(
      entries.map((e) => e.i),
      Array.from({ length: COUNT }, (_, i) => i),
    );
    for (const entry of entries) {
      assert.equal(entry.payload, payloadFor(entry.i), `payload for i=${entry.i} was torn`);
    }

    // On-disk order must match too, not just the parsed read.
    const diskOrder = (await onDiskLines()).map((l) => JSON.parse(l).i);
    assert.deepEqual(diskOrder, Array.from({ length: COUNT }, (_, i) => i));
  });
});

describe('readAudit()', () => {
  it('returns at most `limit` entries: the most recent tail, with the full total', async () => {
    for (let i = 0; i < 5; i += 1) audit('item', { i });
    await flushAudit();

    const { entries, total } = await readAudit({ limit: 2 });
    assert.equal(total, 5); // total counts every line, not just the tail
    assert.deepEqual(
      entries.map((e) => e.i),
      [3, 4], // tail, newest last
    );

    const all = await readAudit(); // default limit (100) is larger than the file
    assert.equal(all.total, 5);
    assert.deepEqual(
      all.entries.map((e) => e.i),
      [0, 1, 2, 3, 4],
    );
  });

  it('returns empty rather than throwing when the log does not exist', async () => {
    await clearAudit();
    assert.equal(fsSync.existsSync(config.auditLog), false);
    assert.deepEqual(await readAudit(), { entries: [], total: 0 });
  });

  it('survives a malformed line and still returns the valid entries', async () => {
    await clearAudit();
    const good1 = JSON.stringify({ at: new Date().toISOString(), event: 'ok.one' });
    const good2 = JSON.stringify({ at: new Date().toISOString(), event: 'ok.two' });
    // A torn/partial write or a hand-edited file must not take down the reader.
    await fs.writeFile(config.auditLog, `${good1}\nnot json at all\n${good2}\n`);

    const { entries, total } = await readAudit();
    assert.equal(total, 3);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].event, 'ok.one');
    assert.equal(entries[1].raw, 'not json at all'); // unparseable lines surface as { raw }
    assert.equal(entries[2].event, 'ok.two');
  });
});

describe('clearAudit()', () => {
  it('removes the log file and leaves readAudit() empty without throwing', async () => {
    await audit('to.be.cleared');
    await flushAudit();
    assert.equal(fsSync.existsSync(config.auditLog), true);

    await clearAudit();
    assert.equal(fsSync.existsSync(config.auditLog), false);
    assert.deepEqual(await readAudit(), { entries: [], total: 0 });
  });

  it('is safe to call when no log exists', async () => {
    await clearAudit();
    await assert.doesNotReject(clearAudit());
  });
});

describe('WEBH_AUDIT_MUTATIONS=0', () => {
  it('disables writing entirely', async () => {
    // config.auditMutations is fixed at import time, so this needs a child process with the
    // env var set before the import.
    const stateDir = await fs.mkdtemp(path.join(TMP_ROOT, 'audit-disabled-'));
    const script = `
import { audit, flushAudit } from ${JSON.stringify(AUDIT_URL)};
await audit('should.not.be.written', { a: 1 });
await flushAudit();
process.stdout.write('done');
`;
    try {
      const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        env: {
          ...process.env,
          WEBH_STATE_DIR: stateDir,
          WEBH_AUDIT_MUTATIONS: '0',
          WEBH_LOG_LEVEL: 'error',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(stdout, 'done');
      assert.equal(fsSync.existsSync(path.join(stateDir, 'audit.jsonl')), false);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
