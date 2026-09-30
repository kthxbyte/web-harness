# web-harness side panel

A lateral control surface for the tab you are looking at. The panel lives in Brave's side
panel, so it survives navigation, tab switches and reloads — the page it controls cannot
destroy it.

## Why a side panel and not an injected overlay

Any UI injected into the page dies the moment you navigate. Since the whole point is
staying beside a tab while you drive it around, the chat surface has to live somewhere the
page cannot reach. Brave's side panel is a real browser UI element anchored to the window,
not the document.

## Architecture

```
   ┌─────────────────────── Brave window ───────────────────────┐
   │   ┌──────────────┐   ┌─────────────────────────────────┐    │
   │   │  active tab  │   │  side panel                     │    │
   │   │  (the page)  │   │  panel.js  ── service-worker.js │    │
   │   └──────┬───────┘   └────────────────┬────────────────┘    │
   └──────────┼────────────────────────────┼─────────────────────┘
              │ CDP ws://127.0.0.1:9222    │ HTTP + token
              │                            │
        ┌─────▼────────────────────────────▼─────┐
        │  web-harness daemon (`webh daemon`)    │
        │  · owns the single CDP connection      │
        │  · runs the 22 tools, guardrails, audit│
        └────────────────────────────────────────┘
```

Three boundaries that matter:

- **The panel never speaks CDP.** Only one debugger can attach to a tab at a time, so the
  daemon owns that connection exclusively and the panel is a thin UI.
- **The service worker answers "which tab is active".** CDP cannot tell you this — "active
  tab" is browser-UI state. The worker pushes it to the daemon on activation, focus change,
  navigation and tab close.
- **All guardrails stay in the daemon.** The panel has no page permissions and no ability to
  bypass a rule; it can only send a tool name and arguments.

## Setup

1. **Start the daemon**

   ```sh
   webh daemon
   ```

   It prints its endpoint and a truncated token. Default endpoint is `http://127.0.0.1:8790`.

2. **Load the extension** — `brave://extensions` (or `chrome://extensions`), enable
   **Developer mode**, then **Load unpacked** and select this `extension/` directory.

3. **Open the panel** — click the web-harness toolbar icon. Brave ≥ 114 is required
   (`sidePanel` API).

4. **Paste the token** — run this and copy the output:

   ```sh
   webh token
   ```

   Paste it into the panel's settings (⚙, top right), then **Save**. The panel talks only to
   `127.0.0.1`, and the token never leaves your machine.

5. Confirm the status line reads `daemon ok · <browser>` with the active tab named below it.

### If the browser is not attached

The daemon needs a CDP endpoint. Start Brave with one:

```sh
brave-browser --remote-debugging-port=9222 --user-data-dir=/tmp/webh-debug
```

Use a **separate `--user-data-dir`** rather than your everyday profile: remote debugging
opens a local control socket, and pointing it at your real profile exposes that profile.

## Using it

Pick a tool, fill in the arguments, and press **Run on active tab**. Arguments are generated
from each tool's JSON schema, so anything the daemon exposes is immediately usable here with
no panel changes.

Good starting points:

| Goal | Tool | Arguments |
|---|---|---|
| See what is on the page | `page_snapshot` | *(none)* |
| Why does it look like that | `page_computed_style` | `selector: #hero` |
| Find elements | `dom_query` | `selector: .card` |
| See the render | `page_screenshot` | *(none)* |
| Try a fix without editing source | `page_set_style` | `selector`, `properties` |
| Why is it broken | `page_console` / `page_network` | `level: error` / `failedOnly: true` |

Screenshots render inline in the activity log. Guardrail refusals appear with the rule name
badge, so a blocked action is visibly different from a broken one.

## Security model

The daemon executes arbitrary JavaScript in your browser, so binding to `127.0.0.1` is **not**
sufficient — any web page you visit can send requests to localhost. Three independent
defences:

1. **Token** — 32 random bytes, compared with `crypto.timingSafeEqual` over SHA-256 digests
   so neither value nor length leaks through timing.
2. **Origin** — every request, including `/health`, is refused unless it comes from an
   extension origin or has no `Origin` at all. A browser always attaches `Origin` to a
   cross-origin request, so a page cannot suppress it. The check *parses* the origin rather
   than prefix-matching, so `https://evil.com/chrome-extension://x` is rejected.
3. **Loopback bind** — `127.0.0.1` only, never `0.0.0.0`.

The token is written to `.webh/daemon.json` with mode `0600`. It is never returned by any
unauthenticated endpoint, including `/manifest`.

## What is verified, and what is not

`test/e2e/extension.test.mjs` proves the whole chain without any UI interaction, by
launching a disposable Brave with the extension and reading the daemon's own log: the
manifest parses, the service worker registers, `chrome.storage` is read, `host_permissions`
is granted, the request passes the origin and token checks, the active tab is announced with
the right title, and the daemon executes a tool against it.

**Not covered by that test:** the panel's *rendering* — that the side panel opens, lays out
correctly, and shows results. That needs human eyes, and it is the reason the setup steps
above ask you to confirm the status line.

## Known limitations

- **`chrome://` and extension pages cannot be controlled.** They have no useful CDP content
  target. The worker marks them `controllable: false`.
- **No LLM in the loop yet.** This milestone is transport only: you choose the tool and
  arguments. The agent loop (natural language → tool calls → results) is the next milestone
  and will reuse this same daemon.
- **Two windows**: the panel follows `lastFocusedWindow`, so with several Brave windows open
  it targets the focused one.
- **Restarting the daemon rotates the token**, so the panel needs it re-pasted. Token
  persistence across restarts is a small follow-up.
