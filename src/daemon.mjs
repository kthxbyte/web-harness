#!/usr/bin/env node
/**
 * `webh daemon` — long-lived harness process for the browser side panel.
 *
 * Unlike the MCP server (one client over stdio) this listens on a local port so the
 * extension can reach it. It owns the single CDP connection; the extension is a UI shell.
 */
import { Harness } from './lib/harness.mjs';
import { Daemon } from './lib/daemon.mjs';
import { config } from './lib/config.mjs';
import { flushAudit } from './lib/audit.mjs';
import { log } from './lib/log.mjs';
import { toolNames } from './lib/tools/index.mjs';

const port = Number(process.env.WEBH_DAEMON_PORT ?? 8790);
const host = process.env.WEBH_DAEMON_HOST ?? '127.0.0.1';
const token = process.env.WEBH_DAEMON_TOKEN ?? null;

const harness = new Harness();
const daemon = new Daemon({ harness, host, port, token });

async function main() {
  // Connect eagerly so the panel shows a live browser immediately rather than on first
  // command. A failure here is not fatal: the daemon still starts and reports why.
  await harness.ensure().catch((err) => {
    log.warn(`no browser attached at startup: ${err.message}`);
  });

  await daemon.start();

  const addr = daemon.address;
  process.stderr.write(
    `\n  web-harness daemon\n` +
      `  endpoint : http://${addr?.host ?? host}:${addr?.port ?? port}\n` +
      `  token    : ${daemon.token.slice(0, 8)}… (full value in ${config.stateDir}/daemon.json)\n` +
      `  browser  : ${harness.connected ? harness.browser.version : 'not attached'}\n` +
      `  tools    : ${toolNames().length}\n\n`,
  );
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`daemon stopping (${signal})`);
  await daemon.stop().catch(() => {});
  await harness.shutdown().catch(() => {});
  await flushAudit().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => log.error(`uncaught: ${err?.stack ?? err}`));
process.on('unhandledRejection', (err) => log.error(`unhandled rejection: ${err?.stack ?? err}`));

main().catch(async (err) => {
  process.stderr.write(`webh daemon failed to start: ${err?.stack ?? err}\n`);
  await flushAudit().catch(() => {});
  process.exit(1);
});
