import fsp from 'node:fs/promises';
import { config } from './config.mjs';
import { log } from './log.mjs';

/**
 * The session file is what makes the CLI usable.
 *
 * Without it, every `webh` invocation is a fresh process that would launch its own
 * browser and land on about:blank, so `webh page_navigate ...` followed by
 * `webh page_snapshot` would describe two different browsers. We persist the browser we
 * launched (pid + port) and the last page we were on, so the next invocation reattaches
 * to the same browser and the same URL — making a sequence of commands behave like one
 * continuous session.
 */

const DEFAULTS = { version: 1, pid: null, port: null, host: null, browser: null, wsUrl: null, lastUrl: null, launchedAt: null, profileDir: null };

export async function readSessionFile() {
  try {
    const raw = await fsp.readFile(config.sessionFile, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return null;
  }
}

export async function writeSessionFile(patch) {
  await fsp.mkdir(config.stateDir, { recursive: true });
  const current = (await readSessionFile()) ?? { ...DEFAULTS };
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await fsp.writeFile(config.sessionFile, JSON.stringify(next, null, 2));
  return next;
}

export async function patchSession(patch) {
  try {
    return await writeSessionFile(patch);
  } catch (err) {
    log.debug(`session file update failed: ${err.message}`);
    return null;
  }
}

export async function clearSessionFile() {
  try { await fsp.rm(config.sessionFile, { force: true }); } catch {}
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
