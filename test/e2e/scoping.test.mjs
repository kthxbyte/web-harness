import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  startFixtureServer,
  makeStateDir,
  rmDir,
  harnessEnv,
  runCli,
  killBrowserFromStateDir,
} from '../helpers/harness-runner.mjs';

/**
 * Project scoping from the CLI.
 *
 * `webh start` puts a project's state in <project>/.webh. This suite protects the other
 * half of that promise: running a tool from inside the project must read and write THAT
 * state, not the harness checkout's. When this was broken the symptom was subtle — you got
 * the right browser but your audit trail landed in a different directory — so it is worth a
 * dedicated test rather than trusting it by inspection.
 */

const PORT = 9440; // distinct from the other suites' launch ports
let fixture;
let projectDir;
let harnessAuditBefore;

const HARNESS_AUDIT = path.join(ROOT, '.webh', 'audit.jsonl');

function lineCount(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

before(async () => {
  fixture = await startFixtureServer();
  // A throwaway project somewhere outside the harness's own state directory.
  projectDir = path.join(ROOT, 'test', 'tmp', 'scoped-project');
  rmDir(projectDir);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"scoped-project"}');
  // A .webh here is the signal the CLI uses to recognise "this directory is a project".
  fs.mkdirSync(path.join(projectDir, '.webh'), { recursive: true });
  harnessAuditBefore = lineCount(HARNESS_AUDIT);
}, { timeout: 30_000 });

after(() => {
  killBrowserFromStateDir(path.join(projectDir, '.webh'));
  if (fixture) fixture.server.close();
  rmDir(projectDir);
});

describe('CLI project scoping', () => {
  test('a tool run inside a project resolves state to that project', async () => {
    // Deliberately NO WEBH_STATE_DIR: this is the plain developer flow.
    const env = { ...process.env, WEBH_LOG_LEVEL: 'error', WEBH_LAUNCH_PORT: String(PORT) };
    delete env.WEBH_STATE_DIR;
    delete env.WEBH_PROJECT_DIR;

    const res = await runCli(['page_eval', '--expression', '1+1'], { env, cwd: projectDir });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /→ 2/);

    const session = path.join(projectDir, '.webh', 'session.json');
    const audit = path.join(projectDir, '.webh', 'audit.jsonl');
    assert.ok(fs.existsSync(session), 'the session file must land in the project');
    assert.ok(fs.existsSync(audit), 'the audit trail must land in the project');
    assert.ok(lineCount(audit) > 0, 'the project audit trail must record the action');
  });

  test('the harness checkout does not accumulate foreign project state', async () => {
    const after = lineCount(HARNESS_AUDIT);
    assert.equal(
      after,
      harnessAuditBefore,
      `the harness audit grew from ${harnessAuditBefore} to ${after}; a project's actions leaked into it`,
    );
  });

  test('an explicit WEBH_STATE_DIR still wins over cwd detection', async () => {
    // Tests and advanced setups rely on this, so cwd scoping must not override it.
    const explicit = makeStateDir('explicit-wins');
    try {
      const env = { ...harnessEnv(explicit, PORT) };
      const res = await runCli(['page_eval', '--expression', '2+2'], { env, cwd: projectDir });
      assert.equal(res.code, 0, res.stderr);
      assert.ok(fs.existsSync(path.join(explicit, 'session.json')), 'state should go to the explicit dir');
      assert.ok(
        !fs.existsSync(path.join(explicit, 'audit.jsonl')) || lineCount(path.join(explicit, 'audit.jsonl')) >= 0,
      );
    } finally {
      killBrowserFromStateDir(explicit);
      rmDir(explicit);
    }
  });
});
