import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { config } from './config.mjs';
import { ToolError } from './errors.mjs';

export function sha1(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

export function slug(input, max = 48) {
  return String(input)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'page';
}

/**
 * Trim a payload for an agent's context window. We keep BOTH ends: the start usually
 * holds the structure and the end often holds the newest console/network lines that
 * explain a failure. Dropping the tail silently is a classic source of agent confusion.
 */
export function truncate(text, limit = config.maxResultChars) {
  const s = String(text ?? '');
  if (s.length <= limit) return { text: s, truncated: false, originalChars: s.length };
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return {
    text: `${s.slice(0, head)}\n\n… [truncated ${s.length - limit} of ${s.length} chars] …\n\n${s.slice(-tail)}`,
    truncated: true,
    originalChars: s.length,
  };
}

export function parseJsonResult(result, { what = 'expression' } = {}) {
  const details = result?.exceptionDetails;
  if (details) {
    const err = new ToolError(`${what} threw: ${details.exception?.description ?? details.text ?? 'unknown error'}`, {
      hint: 'Fix the expression and retry, or use page_console to see errors the page itself raised.',
      details: { url: details.url, line: details.lineNumber, column: details.columnNumber },
    });
    err.threw = true;
    throw err;
  }
  const remote = result?.result ?? {};
  if (remote.type === 'undefined') return { value: undefined, type: 'undefined' };
  if (remote.subtype === 'null') return { value: null, type: 'object', subtype: 'null' };
  if ('value' in remote) return { value: remote.value, type: remote.type, subtype: remote.subtype };
  return { value: remote.description ?? remote.className ?? `[${remote.type}]`, type: remote.type, subtype: remote.subtype };
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export function nowIso() {
  return new Date().toISOString();
}

export function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`\`${name}\` must be a non-empty string.`, { hint: `Pass a valid ${name}.` });
  }
  return value;
}

export function resolveWorkspacePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(config.root, filePath);
}
