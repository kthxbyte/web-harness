/**
 * Side panel controller.
 *
 * Design rule: this file knows NOTHING about the DOM of the page being controlled. It
 * sends tool names and arguments to the daemon and renders what comes back. All CDP work,
 * guardrails and auditing stay in the daemon, which is why the panel has no page
 * permissions beyond asking the service worker which tab is active.
 */

const DEFAULTS = { daemonUrl: 'http://127.0.0.1:8790', token: '' };

const el = (id) => document.getElementById(id);
const ui = {
  connDot: el('conn-dot'),
  connText: el('conn-text'),
  tabChip: el('tab-chip'),
  tabText: el('tab-text'),
  settings: el('settings'),
  daemonUrl: el('daemon-url'),
  daemonToken: el('daemon-token'),
  settingsNote: el('settings-note'),
  toolSelect: el('tool-select'),
  toolDesc: el('tool-desc'),
  toolArgs: el('tool-args'),
  run: el('run'),
  clear: el('clear'),
  log: el('log'),
  logCount: el('log-count'),
};

let state = {
  daemonUrl: DEFAULTS.daemonUrl,
  token: '',
  tools: [],
  tool: null,
  entries: 0,
  daemonReachable: false,
  browserConnected: false,
  activeTab: null,
};

// ── settings ────────────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  state.daemonUrl = stored.daemonUrl || DEFAULTS.daemonUrl;
  state.token = stored.token || '';
  ui.daemonUrl.value = state.daemonUrl;
  ui.daemonToken.value = state.token;
  if (!state.token) ui.settings.hidden = false;
}

async function saveSettings() {
  state.daemonUrl = ui.daemonUrl.value.trim().replace(/\/$/, '') || DEFAULTS.daemonUrl;
  state.token = ui.daemonToken.value.trim();
  await chrome.storage.local.set({ daemonUrl: state.daemonUrl, token: state.token });
  setNote('saved', 'ok');
  // The service worker owns tab announcements; nudge it now that we have a token.
  chrome.runtime.sendMessage({ type: 'announce' }).catch(() => {});
  await refreshTools();
  await poll();
}

function setNote(text, kind = '') {
  ui.settingsNote.textContent = text;
  ui.settingsNote.className = `note ${kind}`;
}

// ── daemon API ──────────────────────────────────────────────────────────────────────

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${state.daemonUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-webh-token': state.token },
    body: body ? JSON.stringify(body) : null,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Poll daemon state. A long-poll or WebSocket would be tidier, but at a 2s cadence this
 * keeps the failure modes obvious: if this loop stops, you can see exactly why.
 */
async function poll() {
  if (!state.token) {
    setConn(false, 'no token — open settings ⚙');
    return;
  }
  try {
    const { data } = await api('/state');
    state.daemonReachable = true;
    state.browserConnected = Boolean(data.browserConnected);
    state.activeTab = data.activeTab;
    setConn(
      state.browserConnected,
      state.browserConnected
        ? `daemon ok · ${data.browser?.product ?? 'browser'}`
        : 'daemon ok · no browser attached',
    );
    renderTab();
  } catch (err) {
    state.daemonReachable = false;
    setConn(false, err.status === 401 ? 'bad token — check settings ⚙' : `daemon unreachable (${err.message})`);
  }
}

function setConn(ok, text) {
  ui.connDot.className = `dot ${ok ? 'ok' : 'err'}`;
  ui.connText.textContent = text;
}

function renderTab() {
  const tab = state.activeTab;
  if (!tab) {
    ui.tabText.textContent = 'no active tab announced';
    ui.tabChip.style.opacity = '.6';
    return;
  }
  ui.tabChip.style.opacity = '1';
  const label = tab.title || tab.url || tab.targetId || 'unknown';
  ui.tabText.textContent = label.length > 64 ? `${label.slice(0, 61)}…` : label;
  ui.tabChip.title = `${tab.title ?? ''}\n${tab.url ?? ''}`;
}

// ── tools ───────────────────────────────────────────────────────────────────────────

async function refreshTools() {
  if (!state.token) return;
  try {
    const { data } = await api('/tools');
    state.tools = data.tools ?? [];
    ui.toolSelect.innerHTML = '';
    for (const tool of state.tools) {
      const opt = document.createElement('option');
      opt.value = tool.name;
      opt.textContent = tool.name;
      ui.toolSelect.appendChild(opt);
    }
    // Default to the orientation tool: it is the safest way to see what you are looking at.
    const preferred = 'page_snapshot';
    if (state.tools.some((t) => t.name === preferred)) ui.toolSelect.value = preferred;
    selectTool(ui.toolSelect.value);
  } catch {
    // poll() already reports the connection problem; keep the log quiet here.
  }
}

function selectTool(name) {
  state.tool = state.tools.find((t) => t.name === name) ?? null;
  ui.toolDesc.textContent = state.tool?.description ?? '';
  renderArgs();
}

/**
 * Build one input per declared argument.
 *
 * Schemas are the single source of truth, so adding a tool in the daemon makes it
 * immediately usable here with no panel changes.
 */
function renderArgs() {
  ui.toolArgs.innerHTML = '';
  const props = state.tool?.inputSchema?.properties ?? {};
  const required = new Set(state.tool?.inputSchema?.required ?? []);

  for (const [name, spec] of Object.entries(props)) {
    const wrap = document.createElement('div');
    wrap.className = 'arg';

    if (spec.type === 'boolean') {
      const label = document.createElement('label');
      label.className = 'arg-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.arg = name;
      input.dataset.kind = 'boolean';
      const text = document.createElement('span');
      text.textContent = name;
      label.append(input, text);
      wrap.appendChild(label);
    } else {
      const label = document.createElement('label');
      label.className = 'arg-label';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = name;
      if (required.has(name)) {
        const req = document.createElement('span');
        req.className = 'req';
        req.textContent = 'required';
        nameSpan.appendChild(document.createTextNode(' '));
        nameSpan.appendChild(req);
      }
      const typeSpan = document.createElement('span');
      typeSpan.className = 'type';
      typeSpan.textContent = spec.enum ? spec.enum.join('|') : (spec.type ?? 'any');
      label.append(nameSpan, typeSpan);
      wrap.appendChild(label);

      let input;
      if (spec.enum && spec.enum.length <= 6) {
        input = document.createElement('select');
        for (const value of spec.enum) {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = value;
          input.appendChild(opt);
        }
      } else if (name === 'expression' || name === 'properties' || name === 'text') {
        input = document.createElement('textarea');
        input.rows = name === 'expression' ? 3 : 2;
      } else {
        input = document.createElement('input');
        input.type = spec.type === 'integer' ? 'number' : 'text';
      }
      input.dataset.arg = name;
      input.dataset.kind = spec.type ?? 'string';
      input.placeholder = spec.description ? spec.description.slice(0, 90) : '';
      input.spellcheck = false;
      input.title = spec.description ?? '';
      wrap.appendChild(input);
    }
    ui.toolArgs.appendChild(wrap);
  }
}

function collectArgs() {
  const args = {};
  for (const input of ui.toolArgs.querySelectorAll('[data-arg]')) {
    const name = input.dataset.arg;
    if (input.dataset.kind === 'boolean') {
      args[name] = input.checked;
      continue;
    }
    const raw = input.value.trim();
    if (raw === '') continue; // omit rather than send an empty string
    if (input.dataset.kind === 'integer') {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) args[name] = n;
      continue;
    }
    if (input.dataset.kind === 'array') {
      args[name] = raw.split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    args[name] = raw;
  }
  return args;
}

// ── running ─────────────────────────────────────────────────────────────────────────

async function run() {
  if (!state.tool) return;
  ui.run.disabled = true;
  const started = Date.now();
  try {
    const { data } = await api('/command', { method: 'POST', body: { tool: state.tool.name, args: collectArgs() } });
    addEntry({
      tool: data.tool,
      // Read the daemon's verdict directly rather than re-deriving it from the payload.
      ok: data.ok,
      text: data.text,
      error: data.error,
      hint: data.hint,
      guardrail: data.guardrail,
      targetNote: data.targetNote,
      image: data.image,
      ms: data.durationMs ?? Date.now() - started,
    });
  } catch (err) {
    addEntry({ tool: state.tool.name, ok: false, error: err.message, ms: Date.now() - started });
  } finally {
    ui.run.disabled = false;
    poll();
  }
}

// ── log rendering ───────────────────────────────────────────────────────────────────

function addEntry(entry) {
  const node = document.createElement('div');
  const kind = entry.error ? 'err' : entry.targetNote ? 'warn' : 'ok';
  node.className = `entry ${kind}`;

  const head = document.createElement('div');
  head.className = 'entry-head';
  const tool = document.createElement('span');
  tool.className = 'tool';
  tool.textContent = entry.tool;
  head.appendChild(tool);
  if (entry.guardrail) {
    const badge = document.createElement('span');
    badge.className = 'badge guard';
    badge.textContent = entry.guardrail;
    head.appendChild(badge);
  }
  const ms = document.createElement('span');
  ms.className = 'ms';
  ms.textContent = `${entry.ms ?? 0}ms`;
  head.appendChild(ms);
  node.appendChild(head);

  const body = document.createElement('div');
  body.className = 'entry-body';

  if (entry.error) {
    const pre = document.createElement('pre');
    pre.textContent = entry.error;
    body.appendChild(pre);
  } else if (entry.text) {
    const pre = document.createElement('pre');
    pre.textContent = entry.text;
    body.appendChild(pre);
  }

  if (entry.hint) {
    const hint = document.createElement('p');
    hint.className = 'hint-line';
    hint.textContent = `hint: ${entry.hint}`;
    body.appendChild(hint);
  }
  if (entry.targetNote) {
    const note = document.createElement('p');
    note.className = 'hint-line';
    note.textContent = `note: ${entry.targetNote}`;
    body.appendChild(note);
  }
  if (entry.image?.data) {
    const img = document.createElement('img');
    img.src = `data:${entry.image.mimeType ?? 'image/png'};base64,${entry.image.data}`;
    img.alt = 'screenshot';
    body.appendChild(img);
  }

  node.appendChild(body);
  ui.log.prepend(node);
  state.entries += 1;
  ui.logCount.textContent = String(state.entries);
}

function clearLog() {
  ui.log.innerHTML = '<div class="empty">No activity yet.</div>';
  state.entries = 0;
  ui.logCount.textContent = '0';
}

// ── wiring ──────────────────────────────────────────────────────────────────────────

el('settings-toggle').addEventListener('click', () => {
  ui.settings.hidden = !ui.settings.hidden;
});
el('save-settings').addEventListener('click', saveSettings);
el('test-conn').addEventListener('click', async () => {
  setNote('testing…');
  // Save first so the test uses what is actually typed.
  state.daemonUrl = ui.daemonUrl.value.trim().replace(/\/$/, '') || DEFAULTS.daemonUrl;
  state.token = ui.daemonToken.value.trim();
  try {
    const res = await fetch(`${state.daemonUrl}/health`);
    const json = await res.json();
    setNote(`reachable — ${json.tools} tools`, 'ok');
  } catch (err) {
    setNote(`unreachable: ${err.message}`, 'err');
  }
});
ui.toolSelect.addEventListener('change', () => selectTool(ui.toolSelect.value));
ui.run.addEventListener('click', run);
ui.clear.addEventListener('click', clearLog);

clearLog();

// Wrapped rather than using top-level await: extension pages are modules, but a parse
// failure here would leave a silently blank panel, which is a miserable thing to debug.
// An explicit async entry point keeps the surface simple and the failure visible.
(async function init() {
  try {
    await loadSettings();
    await refreshTools();
    await poll();
    setInterval(poll, 2000);
  } catch (err) {
    setConn(false, `panel failed to start: ${err.message}`);
  }
})();
