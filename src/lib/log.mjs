import { config } from './config.mjs';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/**
 * All logging goes to stderr. stdout belongs to the MCP stdio transport — a stray
 * console.log on stdout corrupts the JSON-RPC framing and breaks the agent connection.
 */
function write(level, args) {
  if ((LEVELS[level] ?? 99) > threshold) return;
  const line = `[webh:${level}] ${args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}\n`;
  process.stderr.write(line);
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  error: (...a) => write('error', a),
  warn: (...a) => write('warn', a),
  info: (...a) => write('info', a),
  debug: (...a) => write('debug', a),
  trace: (...a) => write('trace', a),
};
