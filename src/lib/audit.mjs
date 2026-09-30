import fsp from 'node:fs/promises';
import { config } from './config.mjs';
import { log } from './log.mjs';

/**
 * Append-only record of everything the agent did that changed page or browser state.
 * When an agent "mysteriously" alters your page, this is the file that says why.
 * JSON Lines: safe to append concurrently, easy to grep and tail.
 */
let queue = Promise.resolve();

export function audit(event, data = {}) {
  if (!config.auditMutations) return;
  const row = { at: new Date().toISOString(), event, ...data };
  queue = queue
    .then(async () => {
      await fsp.mkdir(config.stateDir, { recursive: true });
      await fsp.appendFile(config.auditLog, JSON.stringify(row) + '\n');
    })
    .catch((err) => log.warn(`audit write failed: ${err.message}`));
  return queue;
}

export async function readAudit({ limit = 100 } = {}) {
  try {
    const raw = await fsp.readFile(config.auditLog, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    // `slice(-0)` is `slice(0)` — it would return everything when the caller asked for
    // nothing. Normalise the count explicitly, and treat a non-positive limit as "none".
    const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
    const tail = n > 0 ? lines.slice(-n) : [];
    return { entries: tail.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }), total: lines.length };
  } catch {
    return { entries: [], total: 0 };
  }
}

export async function flushAudit() {
  await queue;
}

export async function clearAudit() {
  await queue;
  await fsp.rm(config.auditLog, { force: true });
}
