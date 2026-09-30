import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/harness-runner.mjs';

/**
 * Static checks on the extension.
 *
 * The panel cannot be exercised without a browser, so the failure it is most likely to ship
 * with is a broken DOM contract: `getElementById('foo')` where panel.html has no `foo`,
 * which throws on the first line and leaves a blank side panel with no clue why. That is
 * fully checkable statically, and a browser is not needed to prove it.
 */

const EXT = path.join(ROOT, 'extension');

function read(name) {
  return fs.readFileSync(path.join(EXT, name), 'utf8');
}

describe('extension manifest', () => {
  test('is valid MV3 with the permissions the code actually uses', () => {
    const manifest = JSON.parse(read('manifest.json'));
    assert.equal(manifest.manifest_version, 3);

    const combined = read('service-worker.js') + read('panel.js');
    // Every chrome.* API touched must be covered by a declared permission, or it is
    // undefined at runtime and the failure is a confusing TypeError.
    const needs = ['sidePanel', 'tabs', 'storage'];
    for (const perm of needs) {
      if (combined.includes(`chrome.${perm}.`)) {
        assert.ok(manifest.permissions.includes(perm), `code uses chrome.${perm} but the manifest does not declare "${perm}"`);
      }
    }
    assert.ok(manifest.host_permissions.some((h) => h.includes('127.0.0.1')), 'the daemon is reached over 127.0.0.1, so it must be in host_permissions');
    assert.equal(manifest.side_panel.default_path, 'panel.html');
  });

  test('every referenced asset exists', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const files = [manifest.background.service_worker, manifest.side_panel.default_path];
    const html = read('panel.html');
    for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) files.push(m[1]);
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) files.push(m[1]);

    for (const f of files) {
      assert.ok(fs.existsSync(path.join(EXT, f)), `manifest/HTML references "${f}" but it does not exist`);
    }
  });
});

describe('panel DOM contract', () => {
  test('every getElementById in panel.js has a matching element in panel.html', () => {
    const js = read('panel.js');
    const html = read('panel.html');

    const ids = new Set();
    for (const m of js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) ids.add(m[1]);
    for (const m of js.matchAll(/el\(\s*'([^']+)'\s*\)/g)) ids.add(m[1]);

    assert.ok(ids.size > 5, `expected the panel to look up several elements, found ${ids.size}`);

    const missing = [];
    for (const id of ids) {
      // Match id="x" in any attribute position.
      if (!new RegExp(`id=["']${id}["']`).test(html)) missing.push(id);
    }
    assert.deepEqual(missing, [], `panel.js looks up ids that panel.html does not define: ${missing.join(', ')}`);
  });

  test('panel references only CSS classes it actually styles', () => {
    // Not exhaustive, but catches a renamed class that silently loses its styling.
    const js = read('panel.js');
    const css = read('panel.css');
    const used = new Set();
    for (const m of js.matchAll(/className\s*=\s*[`'"]([^`'"]+)[`'"]/g)) {
      for (const cls of m[1].split(/\s+/)) {
        // Only keep tokens that actually look like class names. This drops template
        // interpolations (`${kind}`) and the stray `?`/`:` pieces of a ternary inside a
        // template literal such as `dot ${ok ? 'ok' : 'err'}`.
        if (/^[a-z][a-z0-9-]*$/i.test(cls)) used.add(cls);
      }
    }
    const unstyled = [...used].filter((c) => !css.includes(`.${c}`));
    assert.deepEqual(unstyled, [], `these classes have no CSS rule: ${unstyled.join(', ')}`);
  });
});

describe('service worker contract', () => {
  test('registers every tab event needed to track the active tab', () => {
    const sw = read('service-worker.js');
    for (const event of ['chrome.tabs.onActivated', 'chrome.tabs.onUpdated', 'chrome.tabs.onRemoved', 'chrome.windows.onFocusChanged']) {
      assert.ok(sw.includes(event), `${event} must be handled or the announced tab goes stale`);
    }
  });

  test('never hardcodes the token', () => {
    // A token in source would be committed and would defeat the whole auth model.
    const sw = read('service-worker.js');
    const panel = read('panel.js');
    for (const [name, src] of [['service-worker.js', sw], ['panel.js', panel]]) {
      assert.ok(!/[0-9a-f]{64}/.test(src), `${name} appears to contain a hardcoded 64-char token`);
    }
  });

  test('marks non-web pages as not controllable', () => {
    const sw = read('service-worker.js');
    assert.match(sw, /controllable/, 'the worker must classify pages, since chrome:// has no CDP target');
    assert.match(sw, /\^https\?:\|/, 'controllable must be derived from the URL scheme');
  });
});
