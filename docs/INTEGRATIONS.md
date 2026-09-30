# Wiring the harness into your agent

The harness speaks **MCP over stdio**, which Claude Code, OpenCode and DSH all support,
and every tool is also a `webh` subcommand for anything that only has a shell.

Replace `/abs/path/to/web-harness` below with this checkout's real path
(`pwd` inside it). `node` must be on `PATH` — Node 22.4+.

---

## Claude Code

Project-scoped `.mcp.json` in the repo you are working on:

```json
{
  "mcpServers": {
    "web-harness": {
      "command": "node",
      "args": ["/abs/path/to/web-harness/src/mcp.mjs"]
    }
  }
}
```

Or register it once, globally:

```console
$ claude mcp add web-harness -- node /abs/path/to/web-harness/src/mcp.mjs
```

Then, inside a session, `/mcp` should list `web-harness` with 22 tools.

**Prompt that gets the most out of it.** Agents default to reading files; nudge them at
the live page:

```text
You have a live browser via the web-harness MCP tools. Before changing any HTML/CSS/JS,
call page_snapshot to see the real document. Diagnose with page_computed_style and
dom_query instead of guessing from source. Verify visual changes with page_screenshot.
Exercise the UI with page_interact. Check page_console and page_network when something
fails. Do not submit forms or perform destructive actions without asking me.
```

---

## OpenCode

`~/.config/opencode/opencode.json` (global) or `opencode.json` in the project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "web-harness": {
      "type": "local",
      "command": ["node", "/abs/path/to/web-harness/src/mcp.mjs"],
      "enabled": true
    }
  }
}
```

The array form is deliberate — `command` is `[executable, ...args]`, not a shell string.

---

## DSH

Add the server to your DSH MCP configuration with the same `command`/`args` pair:

```json
{
  "command": "node",
  "args": ["/abs/path/to/web-harness/src/mcp.mjs"]
}
```

Because the MCP catalogue and the `webh` CLI expose the identical 22 tools, a DSH session
can also just shell out — `webh page_snapshot` — and get the same results. That is handy
when you want the agent to *show* you raw tool output rather than summarise a tool call.

---

## Any agent with only a shell

No MCP needed. Point the agent at the CLI and tell it the session survives between calls:

```console
$ webh tools
$ webh page_navigate --url http://localhost:3000
$ webh page_snapshot
```

Useful for agent frameworks that only support command execution, and for CI. `--json`
gives a stable machine-readable payload on stdout, and a non-zero exit code signals a
refused or failed action with the reason on stderr.

---

## Choosing a browser

`webh` attaches to a browser already listening on `127.0.0.1:9222`,
otherwise launches its own on `:9333`.

**Use your real session** (logins, extensions, the tab you are looking at):

```console
$ chromium --remote-debugging-port=9222 --user-data-dir=/tmp/webh-debug
```

The harness attaches and never kills it. `browser_list_pages` + `page_select` choose the tab.

**Use an isolated browser** (nothing of yours can be disturbed):

```console
$ webh --fresh page_navigate --url http://localhost:3000
```

This is the safer default when the agent is doing exploratory edits.

---

## Recommended workflow

1. `page_snapshot` — what is actually on the page, and what is already broken.
2. Reproduce with `page_interact` / `page_navigate` rather than assuming.
3. Diagnose with `page_computed_style` (which rule wins), `dom_query` (real geometry),
   `page_console` / `page_network` (what failed).
4. Try the fix live with `page_set_style` — instant, reversible, no rebuild.
5. Confirm with `page_screenshot`; a screenshot beats any amount of CSS reasoning.
6. Only now edit the source files.
7. `page_reload` and confirm the real fix matches the experiment.
8. `webh audit` to review everything that was touched.

## Notes and gotchas

- **Point the harness at a dedicated debugging profile, not your daily browser.**
  `--remote-debugging-port` opens a local control socket and exposes the profile behind
  it. Use a separate `--user-data-dir` (as above) for anything you care about, and keep it
  bound to localhost. Log into the sites you need inside *that* profile.
- **Dev-server source of truth.** Point the harness at your dev server (Vite, Next, etc.),
  not at `file://`, or you will be inspecting a page without HMR or bundling.
- **Enable-time matters for console/network.** Buffers record from the moment the harness
  attaches; `page_reload` after attaching if you need the page's startup output.
- **Iframes are covered** by the guard hooks via CDP auto-attach, but console/network
  buffers are per-tab, so an error inside a cross-origin ads frame may not appear.
- **Screenshots return an image block** to the model plus a file under `.webh/screenshots`.
- **`WEBH_KEEP_ALIVE=false`** makes every CLI call tear the browser down — useful for CI,
  wrong for interactive work.
- **Stale profile locks.** If Chromium dies uncleanly, its `SingletonLock` inside the
  profile dir can block the next launch. `browser_open --fresh` or deleting
  `.webh/profile/SingletonLock` clears it.
