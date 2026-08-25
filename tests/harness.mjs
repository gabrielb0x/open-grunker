/** Open Grunker — tiny test harness (no dependencies, no framework). */

const results = [];
let currentSuite = '';

const tty = process.stdout.isTTY;
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (tty ? `\x1b[90m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

export function suite(name) {
  currentSuite = name;
  console.log(`\n${bold(name)}`);
}

export function check(label, ok, detail = '') {
  results.push({ suite: currentSuite, label, ok: !!ok });
  const mark = ok ? green('  ok  ') : red(' FAIL ');
  console.log(`${mark} ${label}${detail ? dim(` — ${detail}`) : ''}`);
  return !!ok;
}

export const info = (text) => console.log(dim(`       ${text}`));

export function report() {
  const failed = results.filter((r) => !r.ok);
  const line = `${results.length - failed.length}/${results.length} checks passed`;
  console.log(`\n${failed.length ? red(line) : green(line)}`);
  if (failed.length) {
    for (const f of failed) console.log(red(`  · ${f.suite}: ${f.label}`));
  }
  return failed.length === 0;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Approximate equality for floating-point comparisons. */
export const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
