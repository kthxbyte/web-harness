#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) stdio server.
 *
 * Claude Code, OpenCode, DSH and friends launch this as a child process and speak
 * newline-delimited JSON-RPC 2.0 over stdin/stdout. One long-lived process owns one
 * browser, which is exactly what an agent wants: open a page, then poke at it across many
 * turns without paying browser startup each time.
 *
 * Framing rules that matter:
 *   - stdout carries ONLY protocol frames. Diagnostics go to stderr via log.mjs.
 *   - every request gets exactly one response, including unknown methods (JSON-RPC says
 *     -32601) — silence makes the client hang until its own timeout.
 */
import { Harness } from './lib/harness.mjs';
import { invoke, listTools } from './lib/tools/index.mjs';
import { config } from './lib/config.mjs';
import { guardrailSummary } from './lib/guardrails.mjs';
import { flushAudit } from './lib/audit.mjs';
import { log } from './lib/log.mjs';

const SERVER_INFO = { name: 'web-harness', version: '0.1.0' };

/**
 * Protocol revisions we understand, newest first. The client sends its own; we answer
 * with a revision we actually implement rather than echoing its value blindly, because
 * echoing an unknown version is how servers end up claiming support they do not have.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2024-10-07', '2025-03-26', '2025-06-18'];

const harness = new Harness();
let initialized = false;
let clientInfo = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

/** Translate a uniform tool result into MCP content blocks. */
function toContent(result) {
  const content = [];
  const text = result.ok
    ? result.text || '(no output)'
    : [`Error: ${result.error}`, result.hint ? `Hint: ${result.hint}` : null, result.guardrail ? `Guardrail: ${result.guardrail}` : null, result.details ? `Details: ${JSON.stringify(result.details)}` : null]
        .filter(Boolean)
        .join('\n');

  content.push({ type: 'text', text });

  // A screenshot is returned as an image block so a vision-capable model sees pixels
  // directly instead of having to read a file back in.
  if (result.image?.data) {
    content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType ?? 'image/png' });
  }

  // Structured payload as a fenced JSON block: clients that only render text still get it.
  if (result.ok && result.data !== undefined) {
    let json;
    try {
      json = JSON.stringify(result.data, null, 2);
    } catch {
      json = String(result.data);
    }
    if (json && json.length < config.maxResultChars) {
      content.push({ type: 'text', text: '```json\n' + json + '\n```' });
    }
  }
  return content;
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      clientInfo = params?.clientInfo ?? null;
      initialized = true;
      log.info(`MCP client: ${clientInfo?.name ?? 'unknown'} ${clientInfo?.version ?? ''} (protocol ${protocolVersion})`);
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: [
          'Live browser access for web development. Prefer these tools over reading source files when you need to know what the page actually renders or does.',
          'Typical loop: page_snapshot to orient, dom_query/page_computed_style to diagnose, page_set_style to try a fix cheaply, page_screenshot to see the truth, page_interact to exercise the UI, page_console/page_network to explain failures.',
          'The browser is attached on demand; you do not need to call browser_open first.',
          `Guardrails: ${JSON.stringify(guardrailSummary())}`,
        ].join(' '),
      });
      return;
    }

    case 'notifications/initialized':
    case 'initialized':
      return; // notification: no response

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: listTools() });
      return;

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!name) {
        replyError(id, -32602, 'tools/call requires a `name`');
        return;
      }
      const result = await invoke(harness, name, args);
      reply(id, { content: toContent(result), isError: !result.ok, ...(result.ok ? {} : { _meta: { guardrail: result.guardrail } }) });
      return;
    }

    case 'resources/list':
      reply(id, { resources: [] });
      return;

    case 'prompts/list':
      reply(id, { prompts: [] });
      return;

    case 'shutdown':
      reply(id, {});
      return;

    case 'exit':
      await shutdown(0);
      return;

    default:
      // Unknown notifications must not be answered; unknown requests must be.
      if (id === undefined) {
        log.debug(`ignoring notification ${method}`);
        return;
      }
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down');
  try {
    // A browser this server launched is torn down on exit; one you started is left alone.
    await harness.shutdown();
  } catch (err) {
    log.warn(`shutdown error: ${err.message}`);
  }
  await flushAudit().catch(() => {});
  process.exit(code);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log.warn(`dropping unparseable frame: ${err.message}`);
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Serialise handling so two tool calls cannot interleave browser state.
    handleRequest(msg).catch((err) => {
      log.error(`handler crashed: ${err?.stack ?? err}`);
      if (msg?.id !== undefined) {
        replyError(msg.id, -32603, `Internal error: ${err?.message ?? err}`);
      }
    });
  }
});

process.stdin.on('end', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => {
  log.error(`uncaught: ${err?.stack ?? err}`);
});
process.on('unhandledRejection', (err) => {
  log.error(`unhandled rejection: ${err?.stack ?? err}`);
});

log.info(`web-harness MCP server ready (${listTools().length} tools, state ${config.stateDir})`);
