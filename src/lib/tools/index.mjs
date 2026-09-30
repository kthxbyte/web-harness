import { ToolError, asToolError, GuardrailError } from '../errors.mjs';
import { log } from '../log.mjs';
import { browserTools } from './browser-tools.mjs';
import { pageTools } from './page-tools.mjs';

export const ALL_TOOLS = [...browserTools, ...pageTools];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name) {
  return BY_NAME.get(name) ?? null;
}

export function toolNames() {
  return ALL_TOOLS.map((t) => t.name);
}

/** JSON-Schema description of the tool catalogue, as MCP expects it. */
export function listTools() {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

/** Minimal required-field validation with an error the agent can act on. */
function validate(tool, args) {
  const schema = tool.inputSchema ?? {};
  const required = schema.required ?? [];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length) {
    throw new ToolError(`${tool.name} is missing required argument(s): ${missing.join(', ')}`, {
      hint: `Expected shape: ${JSON.stringify(schema.properties ? Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, v.type ?? 'any'])) : {})}`,
      details: { required, received: Object.keys(args) },
    });
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter((k) => !(schema.properties ?? {})[k]);
    if (unknown.length) {
      throw new ToolError(`${tool.name} received unknown argument(s): ${unknown.join(', ')}`, {
        hint: `Valid arguments: ${Object.keys(schema.properties ?? {}).join(', ')}`,
      });
    }
  }
  return args;
}

/**
 * Run one tool. Never throws: always resolves to a uniform result so both front ends
 * (and the agent) get a predictable shape.
 *
 *   { ok, text, data?, image?, error?, hint?, guardrail?, durationMs }
 */
export async function invoke(harness, name, args = {}, { quiet = false } = {}) {
  const started = Date.now();
  const tool = getTool(name);
  if (!tool) {
    const guess = suggest(name);
    return {
      ok: false,
      error: `Unknown tool "${name}".`,
      hint: guess ? `Did you mean "${guess}"? Available tools: ${toolNames().join(', ')}` : `Available tools: ${toolNames().join(', ')}`,
      durationMs: Date.now() - started,
    };
  }

  const input = args && typeof args === 'object' ? args : {};
  try {
    validate(tool, input);
    if (!quiet) log.debug(`invoke ${name} ${JSON.stringify(input).slice(0, 300)}`);
    const result = await tool.handler(input, { harness });
    const out = {
      ok: true,
      text: result?.text ?? '',
      durationMs: Date.now() - started,
    };
    if (result?.data !== undefined) out.data = result.data;
    if (result?.image) out.image = result.image;
    return out;
  } catch (err) {
    const e = asToolError(err);
    log.debug(`tool ${name} failed: ${e.message}`);
    return {
      ok: false,
      error: e.message,
      hint: e.hint,
      guardrail: e instanceof GuardrailError ? e.rule : undefined,
      details: e.details,
      durationMs: Date.now() - started,
    };
  }
}

function suggest(name) {
  const needle = String(name).toLowerCase();
  let best = null;
  let bestScore = 3;
  for (const toolName of toolNames()) {
    const d = levenshtein(needle, toolName.toLowerCase());
    if (d < bestScore) { bestScore = d; best = toolName; }
  }
  return best;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
