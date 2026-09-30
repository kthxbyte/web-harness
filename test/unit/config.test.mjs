/**
 * Unit tests for src/lib/config.mjs.
 *
 * config.mjs reads process.env exactly ONCE, at import time, and caches every derived
 * value in the exported `config` object. That means we cannot flip env vars and re-import
 * inside this process to observe different behavior (the module cache would hand back the
 * first evaluation). Instead every env-dependent assertion runs a tiny child process with
 * a controlled environment and parses the JSON it prints on stdout. `hostDescription` and
 * `ROOT` are env-independent, so they are checked in-process.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ROOT, hostDescription } from '../../src/lib/config.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP_ROOT = path.join(PROJECT_ROOT, 'test', 'tmp');
fsSync.mkdirSync(TMP_ROOT, { recursive: true });

const CONFIG_URL = pathToFileURL(path.join(PROJECT_ROOT, 'src', 'lib', 'config.mjs')).href;
const CHILD_SCRIPT = `
import { config, hostDescription } from ${JSON.stringify(CONFIG_URL)};
process.stdout.write(JSON.stringify({ config, hostDescription }));
`;

/** Every temp dir this file creates, removed in after(). */
const tempDirs = [];

async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(TMP_ROOT, prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Build a child environment that cannot be polluted by WEBH_* vars inherited from the
 * invoking shell — otherwise the "defaults" test would silently test the runner's env.
 */
function cleanEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('WEBH_')) env[key] = value;
  }
  return { ...env, ...overrides };
}

/** Evaluate config.mjs in a fresh process with `overrides` applied and return its JSON. */
function readConfig(overrides = {}) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', CHILD_SCRIPT], {
      env: cleanEnv(overrides),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    err.message = `config child process failed: ${err.message}\nstderr: ${err.stderr ?? ''}`;
    throw err;
  }
  return JSON.parse(stdout).config;
}

const PATH_KEYS = ['root', 'stateDir', 'profileDir', 'auditLog', 'sessionFile', 'screenshotsDir', 'tmpDir'];
// `root` is the project dir, not derived from stateDir, so it is excluded from nesting checks.
const DERIVED_PATH_KEYS = PATH_KEYS.filter((key) => key !== 'root');

function assertPathsAbsoluteAndUnder(cfg, base) {
  for (const key of DERIVED_PATH_KEYS) {
    assert.equal(typeof cfg[key], 'string', `${key} should be a string`);
    assert.ok(path.isAbsolute(cfg[key]), `${key} should be absolute, got ${cfg[key]}`);
    assert.ok(
      cfg[key] === base || cfg[key].startsWith(base + path.sep),
      `${key} (${cfg[key]}) should live under ${base}`,
    );
  }
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('config defaults (no WEBH_* env vars)', () => {
  const cfg = readConfig();

  it('uses <projectRoot>/.webh as the state dir', () => {
    assert.ok(cfg.stateDir.endsWith('.webh'));
    assert.equal(cfg.stateDir, path.join(PROJECT_ROOT, '.webh'));
  });

  it('nests every derived path under stateDir', () => {
    assert.equal(cfg.profileDir, path.join(cfg.stateDir, 'profile'));
    assert.equal(cfg.auditLog, path.join(cfg.stateDir, 'audit.jsonl'));
    assert.equal(cfg.sessionFile, path.join(cfg.stateDir, 'session.json'));
    assert.equal(cfg.screenshotsDir, path.join(cfg.stateDir, 'screenshots'));
    assert.equal(cfg.tmpDir, path.join(cfg.stateDir, 'tmp'));
    assertPathsAbsoluteAndUnder(cfg, cfg.stateDir);
  });

  it('exposes absolute path values', () => {
    assert.equal(cfg.root, PROJECT_ROOT);
    for (const key of PATH_KEYS) {
      assert.ok(path.isAbsolute(cfg[key]), `${key} should be absolute, got ${cfg[key]}`);
    }
  });

  it('uses the documented ports and host', () => {
    assert.equal(cfg.attachPort, 9222);
    assert.equal(cfg.launchPort, 9333);
    assert.equal(cfg.attachHost, '127.0.0.1');
  });

  it('is headless by default with a 1280x800 viewport', () => {
    // headless must be a real boolean: a string "true" would be truthy in some code paths
    // and falsy in strict comparisons, which causes flaky launch behavior.
    assert.equal(cfg.headless, true);
    assert.equal(typeof cfg.headless, 'boolean');
    assert.deepEqual(cfg.viewport, { width: 1280, height: 800 });
  });

  it('keeps every guardrail on/off as documented', () => {
    assert.equal(cfg.allowRemoteNavigation, false);
    assert.equal(cfg.allowFormSubmit, false);
    assert.equal(cfg.allowDownloads, false);
    assert.equal(cfg.auditMutations, true);
  });

  it('uses the default numeric limits', () => {
    assert.equal(cfg.requestTimeoutMs, 30000);
    assert.equal(cfg.maxConsoleEntries, 500);
    assert.equal(cfg.maxNetworkEntries, 500);
  });

  it('has no browser path until one is configured', () => {
    assert.equal(cfg.browserPath, null);
  });

  it("defaults logLevel to 'info'", () => {
    assert.equal(cfg.logLevel, 'info');
  });
});

describe('WEBH_STATE_DIR override', () => {
  it('uses the override verbatim and derives every path from it', async () => {
    const tmp = await makeTempDir('config-state-');
    const cfg = readConfig({ WEBH_STATE_DIR: tmp });

    assert.equal(cfg.stateDir, tmp);
    assert.equal(cfg.profileDir, path.join(tmp, 'profile'));
    assert.equal(cfg.auditLog, path.join(tmp, 'audit.jsonl'));
    assert.equal(cfg.sessionFile, path.join(tmp, 'session.json'));
    assert.equal(cfg.screenshotsDir, path.join(tmp, 'screenshots'));
    // Regression guard: derived paths must never fall back to <root>/.webh.
    assertPathsAbsoluteAndUnder(cfg, tmp);
  });

  it('resolves a relative state dir against the process cwd', async () => {
    // Not documented explicitly, but path.resolve() is what makes CLI invocation with a
    // relative --state-dir usable; pin it so a switch to path.join (no resolve) is caught.
    const cfg = readConfig({ WEBH_STATE_DIR: 'relative-state-dir' });
    assert.ok(path.isAbsolute(cfg.stateDir));
    assert.equal(cfg.stateDir, path.resolve('relative-state-dir'));
  });
});

describe('integer parsing', () => {
  it('parses WEBH_ATTACH_PORT into a number', () => {
    const cfg = readConfig({ WEBH_ATTACH_PORT: '1234' });
    assert.equal(cfg.attachPort, 1234);
    assert.equal(typeof cfg.attachPort, 'number');
  });

  it('falls back to 9222 for a non-numeric WEBH_ATTACH_PORT instead of NaN', () => {
    const cfg = readConfig({ WEBH_ATTACH_PORT: 'abc' });
    assert.equal(cfg.attachPort, 9222);
    assert.equal(typeof cfg.attachPort, 'number');
  });

  it('falls back to 1280 for a non-numeric WEBH_VIEWPORT_WIDTH instead of NaN', () => {
    const cfg = readConfig({ WEBH_VIEWPORT_WIDTH: 'abc' });
    assert.equal(cfg.viewport.width, 1280);
    assert.equal(typeof cfg.viewport.width, 'number');
  });

  it('still honors a valid WEBH_VIEWPORT_WIDTH', () => {
    const cfg = readConfig({ WEBH_VIEWPORT_WIDTH: '640' });
    assert.equal(cfg.viewport.width, 640);
    assert.equal(cfg.viewport.height, 800);
  });

  it('treats an empty WEBH_LAUNCH_PORT as unset', () => {
    const cfg = readConfig({ WEBH_LAUNCH_PORT: '' });
    assert.equal(cfg.launchPort, 9333);
  });
});

describe('boolean parsing', () => {
  const FALSEY = ['0', 'false', 'no', 'off', 'FALSE'];
  const TRUTHY = ['1', 'true', 'TRUE'];

  for (const value of FALSEY) {
    it(`WEBH_HEADLESS=${JSON.stringify(value)} -> false`, () => {
      // headless defaults to true, so every falsey spelling is observable behavior.
      const cfg = readConfig({ WEBH_HEADLESS: value });
      assert.equal(cfg.headless, false);
      assert.equal(typeof cfg.headless, 'boolean');
    });
  }

  for (const value of TRUTHY) {
    it(`WEBH_ALLOW_FORM_SUBMIT=${JSON.stringify(value)} -> true`, () => {
      // allowFormSubmit defaults to false, so a truthy parse is observable behavior.
      const cfg = readConfig({ WEBH_ALLOW_FORM_SUBMIT: value });
      assert.equal(cfg.allowFormSubmit, true);
      assert.equal(typeof cfg.allowFormSubmit, 'boolean');
    });
  }

  for (const value of TRUTHY) {
    it(`WEBH_HEADLESS=${JSON.stringify(value)} -> true`, () => {
      const cfg = readConfig({ WEBH_HEADLESS: value });
      assert.equal(cfg.headless, true);
    });
  }

  for (const value of FALSEY) {
    it(`WEBH_ALLOW_FORM_SUBMIT=${JSON.stringify(value)} -> false`, () => {
      const cfg = readConfig({ WEBH_ALLOW_FORM_SUBMIT: value });
      assert.equal(cfg.allowFormSubmit, false);
    });
  }

  it('an empty WEBH_HEADLESS falls back to the default true, not false', () => {
    // The bug this guards: `!['0','false',...].includes('')` is true, so a naive
    // implementation would flip an unset-looking var from true to false.
    const cfg = readConfig({ WEBH_HEADLESS: '' });
    assert.equal(cfg.headless, true);
  });

  it('an empty WEBH_ALLOW_FORM_SUBMIT falls back to its default', () => {
    const cfg = readConfig({ WEBH_ALLOW_FORM_SUBMIT: '' });
    assert.equal(cfg.allowFormSubmit, false);
  });

  it('WEBH_ALLOW_DOWNLOADS=1 turns the download guardrail off', () => {
    const cfg = readConfig({ WEBH_ALLOW_DOWNLOADS: '1' });
    assert.equal(cfg.allowDownloads, true);
  });

  it('WEBH_AUDIT_MUTATIONS=0 disables mutation auditing', () => {
    const cfg = readConfig({ WEBH_AUDIT_MUTATIONS: '0' });
    assert.equal(cfg.auditMutations, false);
  });

  it('WEBH_ALLOW_REMOTE_NAVIGATION=no keeps remote navigation disabled', () => {
    const cfg = readConfig({ WEBH_ALLOW_REMOTE_NAVIGATION: 'no' });
    assert.equal(cfg.allowRemoteNavigation, false);
  });
});

describe('string options and hostDescription', () => {
  it('WEBH_BROWSER_PATH is null when unset and the exact string when set', () => {
    assert.equal(readConfig().browserPath, null);
    const p = '/opt/chromium/chrome';
    assert.equal(readConfig({ WEBH_BROWSER_PATH: p }).browserPath, p);
  });

  it('an empty WEBH_BROWSER_PATH is treated as unset', () => {
    assert.equal(readConfig({ WEBH_BROWSER_PATH: '' }).browserPath, null);
  });

  it("WEBH_LOG_LEVEL defaults to 'info' and is overridable", () => {
    assert.equal(readConfig().logLevel, 'info');
    assert.equal(readConfig({ WEBH_LOG_LEVEL: 'debug' }).logLevel, 'debug');
  });

  it('hostDescription reports platform, release and this Node version', () => {
    assert.equal(typeof hostDescription.platform, 'string');
    assert.equal(typeof hostDescription.release, 'string');
    assert.equal(typeof hostDescription.node, 'string');
    assert.equal(hostDescription.node, process.version);
  });

  it('ROOT points at the project directory', () => {
    assert.equal(ROOT, PROJECT_ROOT);
  });
});
