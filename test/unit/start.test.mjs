import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../helpers/harness-runner.mjs';

/**
 * Tests for project scoping and the start-time helpers.
 *
 * `startProject` itself launches a browser, so these cover the two pieces that decide what
 * it does — how a project directory is classified, and how ports are chosen — plus the
 * state-directory resolution, which is what makes two projects independent.
 */

const { inspectProject, findFreePort } = await import('../../src/lib/start.mjs');
const { ensureSelfIgnoring, readSessionFile } = await import('../../src/lib/session.mjs');
const { config } = await import('../../src/lib/config.mjs');

const TMP = path.join(ROOT, 'test', 'tmp', 'start');

before(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
  await fsp.mkdir(TMP, { recursive: true });
});

after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function makeDir(name, files = {}) {
  const dir = path.join(TMP, name);
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, body);
  }
  return dir;
}

describe('project classification', () => {
  test('an empty directory is recognised as a new project', async () => {
    const dir = await makeDir('empty');
    const info = await inspectProject(dir);
    assert.equal(info.kind, 'empty');
    assert.equal(info.fileCount, 0);
    assert.equal(info.hasState, false);
    assert.equal(info.resumable, false, 'a blank directory has nothing to resume');
  });

  test('a directory with project markers is recognised as a project', async () => {
    const dir = await makeDir('real', {
      'package.json': '{"name":"demo"}',
      'index.html': '<h1>hi</h1>',
    });
    const info = await inspectProject(dir);
    assert.equal(info.kind, 'project');
    assert.deepEqual(info.markers.sort(), ['index.html', 'package.json']);
    assert.equal(info.resumable, false, 'no .webh yet, so nothing to resume');
  });

  test('a directory of loose files without markers is neither empty nor a project', async () => {
    const dir = await makeDir('loose', { 'notes.txt': 'x', 'a.md': 'y' });
    const info = await inspectProject(dir);
    assert.equal(info.kind, 'directory');
    assert.equal(info.fileCount, 2);
  });

  test('prior state makes a project resumable and reports the last page', async () => {
    const dir = await makeDir('resume', {
      'package.json': '{"name":"demo"}',
      '.webh/session.json': JSON.stringify({ version: 1, lastUrl: 'http://localhost:5173/pricing' }),
      '.webh/audit.jsonl': '{"event":"a"}\n{"event":"b"}\n{"event":"c"}\n',
    });
    const info = await inspectProject(dir);
    assert.equal(info.hasState, true);
    assert.equal(info.resumable, true);
    assert.equal(info.priorSessions, 3, 'the audit trail count is what tells you it was used');
    assert.equal(info.resumeUrl, 'http://localhost:5173/pricing');
  });

  test('state without any recorded activity is not treated as resumable', async () => {
    const dir = await makeDir('stateonly', { '.webh/.gitignore': '*' });
    const info = await inspectProject(dir);
    assert.equal(info.hasState, true);
    assert.equal(info.resumable, false, 'an empty .webh means nothing happened yet');
  });

  test('a missing directory does not throw', async () => {
    const info = await inspectProject(path.join(TMP, 'does-not-exist'));
    assert.equal(info.kind, 'empty');
    assert.equal(info.fileCount, 0);
  });
});

describe('port selection', () => {
  test('returns a port nothing is listening on', async () => {
    const port = await findFreePort(9500);
    assert.ok(port >= 9500);
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    assert.equal(free, true, `findFreePort returned ${port} but something is bound there`);
  });

  test('skips ports that are already taken', async () => {
    // Occupy three consecutive ports, then ask for that range.
    const base = 9510;
    const servers = [];
    for (let i = 0; i < 3; i++) {
      const srv = net.createServer();
      await new Promise((res) => srv.listen(base + i, '127.0.0.1', res));
      servers.push(srv);
    }
    try {
      const port = await findFreePort(base);
      assert.equal(port, base + 3, `expected the first free port after the occupied range, got ${port}`);
    } finally {
      for (const s of servers) s.close();
    }
  });
});

describe('state directory is self-ignoring', () => {
  test('writes a .gitignore that ignores everything but itself', async () => {
    const dir = path.join(TMP, 'selfignore', '.webh');
    await ensureSelfIgnoring(dir);
    const body = await fsp.readFile(path.join(dir, '.gitignore'), 'utf8');
    assert.match(body, /^\*$/m, 'the directory must ignore its own contents');
    assert.match(body, /^!\.gitignore$/m, 'but not the marker, or git would ignore the rule too');
  });

  test('is idempotent and reports whether it changed anything', async () => {
    const dir = path.join(TMP, 'selfignore2', '.webh');
    assert.equal(await ensureSelfIgnoring(dir), true, 'first call writes the marker');
    assert.equal(await ensureSelfIgnoring(dir), false, 'second call is a no-op');
  });

  test('creates the directory if it does not exist', async () => {
    const dir = path.join(TMP, 'missing-parent', 'deep', '.webh');
    await ensureSelfIgnoring(dir);
    assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
  });
});

describe('project-scoped state resolution', () => {
  test('WEBH_PROJECT_DIR puts state under that project, not the harness', () => {
    // config caches env at import, so assert on a child process instead of mutating ours.
    const project = path.join(TMP, 'scoped-project');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { config } = await import('${path.join(ROOT, 'src', 'lib', 'config.mjs')}');
       process.stdout.write(JSON.stringify({ stateDir: config.stateDir, projectDir: config.projectDir, profileDir: config.profileDir }));`,
    ], {
      env: { ...process.env, WEBH_PROJECT_DIR: project, WEBH_STATE_DIR: '' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.projectDir, project);
    assert.equal(parsed.stateDir, path.join(project, '.webh'), 'state belongs to the project being worked on');
    assert.ok(parsed.profileDir.startsWith(parsed.stateDir), 'the browser profile lives inside that state dir');
  });

  test('WEBH_STATE_DIR still wins, so tests and advanced setups can relocate state', () => {
    const explicit = path.join(TMP, 'explicit-state');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { config } = await import('${path.join(ROOT, 'src', 'lib', 'config.mjs')}');
       process.stdout.write(config.stateDir);`,
    ], {
      env: { ...process.env, WEBH_PROJECT_DIR: path.join(TMP, 'ignored'), WEBH_STATE_DIR: explicit },
      encoding: 'utf8',
    });
    assert.equal(out.trim(), explicit);
  });
});
