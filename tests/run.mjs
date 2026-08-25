#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/** Open Grunker — test runner. `npm test` */
process.env.LOG_LEVEL ??= 'error';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { report } from './harness.mjs';

/**
 * Every suite runs against a throwaway database.
 *
 * This has to be set before any suite is loaded: `server/config.js` reads
 * DB_PATH once, at import time, and a suite that touches the db module would
 * otherwise write into the live accounts file.
 */
const dbDir = mkdtempSync(join(tmpdir(), 'og-test-'));
process.env.DB_PATH = join(dbDir, 'test.db');

// The client's modules resolve `three` and `/shared/…` the way a browser does;
// this hook teaches Node the same two rules so they can be tested unmodified.
register('./client-loader.mjs', import.meta.url);

// `client` and `gamepad` install the browser shim, which stubs `fetch` and
// `WebSocket` — so both run last, after every suite that talks to a real socket.
const suites = ['movement', 'combat', 'lagcomp', 'simulation', 'keybinds', 'modes', 'rooms',
  'moderation', 'accounts', 'clans', 'client', 'gamepad', 'charts', 'admin'];
const only = process.argv[2];

for (const name of suites) {
  if (only && name !== only) continue;
  const mod = await import(`./${name}.test.mjs`);
  await mod.default();
}

const passed = report();
rmSync(dbDir, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
