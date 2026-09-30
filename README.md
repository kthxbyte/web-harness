# web-harness

Give a coding agent a **live browser session** instead of a pile of source files.

When an agent works on HTML/CSS/JS it normally reads the files, guesses how they render,
and asks you what happened. This harness attaches to a real Chromium over the Chrome
DevTools Protocol and exposes the things that actually answer the question: the live DOM,
computed styles with the winning CSS rule, console errors with stacks, network failures,
pixels via screenshots, and real mouse/keyboard interaction.

**Zero runtime dependencies.** Node 22.4+ (developed on 24) has `fetch` and a browser-grade
`WebSocket` built in, and CDP is just WebSocket + JSON, so nothing needs installing.

---

## The loop this changes

Before — the agent reasons about text:

> "The hero has `display: none` in the source. I'll change it to `block`."

After — the agent interrogates the running page:

```console
$ webh page_computed_style --selector "#hero" --properties display
section#hero — 0x0 at 0,0
computed:
  display: none
matching rules (1):
  #hero { display: none }
```

Then it tries the fix without editing anything, sees the result, and only then writes code:

```console
$ webh page_set_style --selector "#hero" --properties '{"display":"block"}'
Styled section#hero: display: block
$ webh page_screenshot          # ← returns the actual rendered PNG
$ webh page_set_style --selector "#hero" --revert
Reverted section#hero to its original inline style (none)
```

## Install

```console
$ cd web-harness
$ npm link          # optional: puts `webh` on your PATH
```

No `npm install` is required. If your npm cache is read-only (sandboxed agents), nothing
here needs it anyway.

## Four ways to use it

### 1. Browser side panel — a control surface beside the page

A Brave/Chrome side panel that stays beside the tab you are working on and drives it. It
survives navigation, tab switches and reloads, because it is a browser UI element rather
than something injected into the page.

Bring everything up with one command, from inside the project you are working on:

```console
$ cd ~/Code/my-site
$ webh start
```

That starts a browser with the extension loaded and a daemon that owns it, and keeps all
state in `./.webh`:

```
  web-harness — started

  project   /home/you/Code/my-site
            project (package.json, index.html)
            resuming: 42 recorded action(s), last page http://localhost:5173/pricing
  state     /home/you/Code/my-site/.webh
  browser   /usr/bin/brave-browser
            debug port 9222, extension loaded
  opened    http://localhost:5173/pricing
  daemon    http://127.0.0.1:8790

  Next: open the side panel (Brave toolbar icon) and paste the token:

      webh token
```

Then load the panel once: `brave://extensions` → **Developer mode** → **Load unpacked** →
`extension/`. Click the toolbar icon and paste the token into ⚙. The status line should read
`daemon ok · <browser>` with your active tab named beneath it.

Running `webh start` again is safe — it detects what is already running for that project and
reuses it rather than starting a second browser, which matters because only one process can
hold the CDP connection.

**State is per project.** The session, audit trail and browser profile live in
`<project>/.webh`, so two projects never share a browser profile or an audit log, and you can
tell at a glance whether a project has been used before. `webh start` classifies the
directory as it finds it:

| Directory | What happens |
|---|---|
| empty | a new project; starts on `about:blank` |
| has `package.json`, `index.html`, `.git`, … | a project; starts on `about:blank` |
| already has `.webh` with an audit trail | **resumes** — reopens the last page you were on |

The `.webh` directory writes its own `.gitignore`, so it never shows up in `git status` even
in projects whose ignore rules you do not control.

Full setup, architecture and security model: [extension/README.md](extension/README.md).

### 2. CLI — for you, and for agents that only have a shell

```console
$ webh tools                                  # list all 22 tools
$ webh help page_interact                     # arguments for one tool
$ webh page_navigate --url http://localhost:5173
$ webh page_snapshot --includeHtml
$ webh dom_query --selector ".card" --limit 5
$ webh page_computed_style --selector "#nav a" --properties color,font-weight
$ webh page_eval --expression "document.querySelectorAll('.card').length"
$ webh page_console --level error
$ webh page_network --failedOnly
$ webh page_interact --action click --text "Sign in"
$ webh page_interact --action type --selector "#email" --value me@example.com
$ webh page_wait_for --for element --selector "#results"
$ webh page_screenshot --fullPage --out shot.png
$ webh audit                                  # everything the agent changed
```

**Commands are a session, not isolated runs.** The browser is deliberately left running
between invocations and the current page is remembered, so a click in one command is
visible to the next:

```console
$ webh page_interact --action click --selector ".add-to-cart"
$ webh page_eval --expression "document.querySelector('#counter').textContent"
→ 1
```

Use `webh close` when finished (or `--close` on any command; `WEBH_KEEP_ALIVE=0` restores
close-after-each-call).

### 3. MCP server — for Claude Code, OpenCode, DSH

```jsonc
// e.g. .mcp.json in your project, or the equivalent in your agent's config
{
  "mcpServers": {
    "web-harness": {
      "command": "node",
      "args": ["/absolute/path/to/web-harness/src/mcp.mjs"]
    }
  }
}
```

Claude Code: `claude mcp add web-harness -- node /abs/path/web-harness/src/mcp.mjs`

OpenCode (`opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "web-harness": {
      "type": "local",
      "command": ["node", "/abs/path/web-harness/src/mcp.mjs"],
      "enabled": true
    }
  }
}
```

Verify with `webh tools` — the MCP catalogue and the CLI expose exactly the same 22 tools,
so anything you can do by hand the agent can do too.

### 4. Library

```js
import { Harness, invoke } from 'web-harness';

const harness = new Harness();
await harness.ensure({ url: 'http://localhost:5173' });

const styles = await invoke(harness, 'page_computed_style', { selector: '#hero' });
console.log(styles.text);

await harness.shutdown();
```

## Attaching to *your* browser

By default the harness looks for a browser listening on `127.0.0.1:9222`, then `:9333`,
and launches its own if it finds nothing. To drive the tab you are actually looking at,
start Chromium with remote debugging and let the harness attach:

```console
$ chromium --remote-debugging-port=9222 --user-data-dir=/tmp/webh-debug
```

Now the agent sees your logged-in state, your extensions, your open tabs — and
`browser_list_pages` / `page_select` let it pick which tab to work on. A browser **you**
started is never killed: `webh close` only detaches from it.

## Guardrails

The agent is attached to a live browser that may be your real session, so the policy is:
**rearrange the page freely, but don't do things that are hard to undo or that leave the
machine.** Three independent layers, because a single chokepoint is trivially bypassed —
an agent refused a submit *click* can just call `form.submit()` through `page_eval`:

| Layer | What it stops |
|---|---|
| Syntax | Submit-shaped JS (`form.submit()`, `requestSubmit`, `POST` fetches, `FormData` posts) refused before it runs |
| Tool | Submit controls and destructive labels (`Delete`, `Unsubscribe`, `Checkout`, `Danger`) refused as clicks; non-local navigation refused |
| Runtime | A page-side listener cancels any submit that still gets through, and records it |

Everything the agent changes is appended to `.webh/audit.jsonl` (read it with
`webh audit`). A blocked action always returns a *hint* naming the override, so a refusal
becomes a retry rather than a dead end:

```console
$ webh page_interact --action click --text "Delete account"
✗ Refusing to click "Delete account" — "Delete" looks destructive or irreversible.
  hint: If this is intentional, call page_interact again with force: true; it will be recorded in the audit log.
  guardrail: irreversible-action
```

Deliberate overrides (all logged): `force: true` on a single click, or the environment
flags `WEBH_ALLOW_FORM_SUBMIT=1`, `WEBH_ALLOW_REMOTE_NAVIGATION=1`, `WEBH_ALLOW_DOWNLOADS=1`.

Dialogs get special treatment: a native `alert()` blocks the renderer forever and would
hang the agent, so dialogs are auto-accepted and reported in `page_snapshot`.

## Tools

| Tool | Why it exists |
|---|---|
| `browser_status` | Is a browser attached, what is the current page, what are the guardrails |
| `browser_open` / `browser_close` | Attach to a running browser or launch one; never kills a browser you started |
| `browser_list_pages` / `page_select` / `page_new` / `page_close` | Work across tabs |
| `page_navigate` / `page_reload` | Go somewhere, wait for load |
| `page_snapshot` | One-call orientation: document facts, framework detection, interactive map, headings, console errors, failed requests |
| `dom_query` | Structured facts per match: geometry, visibility, role, text, attributes, outerHTML |
| `dom_structure` | Indented subtree outline — understand nesting without dumping HTML |
| `page_computed_style` | Effective values **plus which CSS rule won** — answers "why does it look like that" |
| `page_set_style` / revert | Try a visual change without touching source, fully reversible |
| `page_screenshot` | The ground truth for layout. Returns a real PNG image block |
| `page_eval` | Escape hatch: any JS, returns JSON |
| `page_console` / `page_network` | Why it is broken, with stacks and status codes |
| `page_a11y` | Headings, landmarks, accessible names, unlabeled controls |
| `page_interact` | Real mouse/keyboard: click, type, hover, scroll, focus, key |
| `page_wait_for` | Wait for element/URL/network-idle/predicate instead of guessing with sleeps |
| `page_audit_log` | Read or clear the mutation log |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WEBH_STATE_DIR` | `./.webh` | Profiles, screenshots, session and audit files |
| `WEBH_PROJECT_DIR` | — | Scope state to `<dir>/.webh` instead of the harness. Set by `webh start` |
| `WEBH_ATTACH_PORT` | `9222` | Where to look for your browser |
| `WEBH_LAUNCH_PORT` | `9333` | Port for the browser the harness launches |
| `WEBH_BROWSER_PATH` | auto | Explicit Chromium/Chrome binary |
| `WEBH_HEADLESS` | `true` | `0` for a visible window |
| `WEBH_KEEP_ALIVE` | `true` | Keep the launched browser between CLI commands |
| `WEBH_ALLOW_FORM_SUBMIT` | `false` | Allow submits (all three layers) |
| `WEBH_ALLOW_REMOTE_NAVIGATION` | `false` | Allow non-local URLs |
| `WEBH_ALLOW_DOWNLOADS` | `false` | Allow downloads |
| `WEBH_NO_SANDBOX` | `false` | Pass `--no-sandbox` (containers) |
| `WEBH_LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug`/`trace` (stderr only) |
| `WEBH_MAX_RESULT_CHARS` | `60000` | Truncation limit protecting the agent's context |
| `WEBH_DAEMON_PORT` | `8790` | Port the side panel connects to |
| `WEBH_DAEMON_HOST` | `127.0.0.1` | Bind address. Leave as loopback; the daemon executes JS in your browser |
| `WEBH_DAEMON_TOKEN` | random | Pin the daemon token instead of generating one per start |

## Tests

```console
$ npm test              # unit + end-to-end (launches a real Chromium)
$ npm run test:unit     # guardrails, config, audit — fast, no browser
$ npm run test:e2e      # MCP protocol + CLI session behaviour
```

The e2e suites run a real browser against a fixture page with deliberate bugs (thrown
error, failed request, hidden element, native `alert`, delayed content, a form, a modal),
because the failures that matter — a dropped MCP frame, a guardrail that crashes instead
of reporting, state that does not survive a process boundary — are invisible to unit tests.

## How it fits together

```
  webh (CLI) ──┐
               │
  MCP server ──┼──> Harness ──> Browser ──> CDP WebSocket ──> Chromium
               │        │          │
  daemon ──────┘        │          └── PageSession per tab: console/network buffers, events
  (side panel)          ├── tools/      22 tool definitions + handlers
                        ├── guardrails  3 layers + audit log
                        └── session.mjs persisted browser + current URL
```

Every front end drives the same `Harness`, so the tool definitions, guardrails and audit log
are shared — one audit trail covering what you did by hand and what an agent did.

**One owner per browser.** Only one debugger can attach to a tab at a time, so exactly one
process holds the CDP connection. The MCP server and CLI are short-lived and own it while
they run; the daemon owns it for as long as it runs, which is what lets the side panel stay
attached without competing with the CLI.

**Why the CLI persists state and the daemon does not.** The CLI is a sequence of separate
processes, so it writes the browser pid and current URL to disk to make them behave like one
session — that is what makes `webh page_interact` followed by `webh page_snapshot` work. The
daemon is a single long-lived process and needs none of that. It does need one thing CDP
cannot provide: the extension tells it which tab is active, because "active tab" is
browser-UI state, not a protocol property.

