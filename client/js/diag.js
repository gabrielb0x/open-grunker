/**
 * Open Grunker — what this browser tells the server about itself.
 *
 * The server can measure its own tick and nothing beyond it. Whether the game
 * is drawing at a hundred and forty frames a second on one machine and at nine
 * on another is completely invisible from the other end of the socket — and
 * "it is unplayably slow" is not a report anybody can act on without knowing
 * *which* machine, on *which* map, at *which* settings, on *which* GPU.
 *
 * So the client says so. Three kinds of line, and nothing else ever leaves:
 *
 *   boot    once, when the game first draws: the GPU string, the screen, the
 *           quality preset. The baseline every later line is read against.
 *   perf    a rolling window of frame times, sent on a slow timer while
 *           playing — and sent *immediately*, once, when the frame rate
 *           collapses, because that is the report worth having and waiting a
 *           minute for it is waiting a minute too long.
 *   error   an uncaught exception or a rejected promise, with its stack.
 *
 * ── What is not in it ───────────────────────────────────────────────────────
 *
 * No position, no aim, no input, nothing about anybody else in the match, and
 * no identifier this file invents. The account it belongs to is whatever the
 * request's own session says — the same one every other API call carries — and
 * a guest sends the same lines with no account on them at all.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * One number pushed into a ring per frame. The percentiles are computed only
 * when a report is actually sent, which is at most once a minute, and every
 * send is fire-and-forget: a failed post is dropped, never retried, and never
 * surfaces to the player.
 */
import { api } from './api.js';
import { settings } from './settings.js';
import { GAME_VERSION } from '/shared/patchnotes.js';

/** How many frames the window holds — about eight seconds at 120 fps. */
const WINDOW = 1000;
/** How often a healthy client reports, in seconds. */
const EVERY = 120;
/** Below this many frames a second, the game is a slideshow rather than slow. */
const COLLAPSE_FPS = 15;
/** How long the frame rate has to stay down before that is worth reporting. */
const COLLAPSE_SEC = 5;
/** And how long before it is worth reporting again. */
const COLLAPSE_COOLDOWN = 300;

export class Diagnostics {
  constructor() {
    /** Frame times in milliseconds, newest last. */
    this.frames = new Float32Array(WINDOW);
    this.n = 0;
    this.head = 0;
    this.sinceReport = 0;
    this.badFor = 0;
    this.lastCollapseAt = -1e9;
    this.booted = false;
    this.enabled = true;
    /** Set by the game so a report knows where it was taken. */
    this.context = { map: null, mode: null, room: null, playing: false };
    this.gpu = null;
    this.info = null;
  }

  /**
   * Which GPU this is, as the driver describes itself.
   *
   * `WEBGL_debug_renderer_info` is the only way to tell an integrated chip from
   * a discrete card, and it is the single most useful field in the whole
   * report: "10 fps" means one thing on a laptop's integrated graphics and
   * something quite different on a desktop card. Browsers that withhold the
   * extension simply leave it null.
   */
  attach(renderer) {
    this.info = renderer?.info ?? null;
    try {
      const gl = renderer?.getContext?.();
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      this.gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)).slice(0, 120) : null;
    } catch { this.gpu = null; }
  }

  /** Where the game currently is, so a report can say so. */
  setContext(next) { Object.assign(this.context, next); }

  /* ── Sampling ──────────────────────────────────────────────────────────── */

  /**
   * One frame, in milliseconds. Called from the render loop and nowhere else.
   *
   * Everything here is O(1) and allocation-free — a diagnostic that costs frame
   * time is a diagnostic that changes the thing it is measuring.
   */
  frame(ms, dt) {
    if (!this.enabled || !(ms > 0)) return;
    this.frames[this.head] = ms;
    this.head = (this.head + 1) % WINDOW;
    if (this.n < WINDOW) this.n++;
    this.sinceReport += dt;

    // A collapse is measured on the clock rather than on frame count: five
    // seconds is five seconds whether that is three hundred frames or forty.
    if (ms > 1000 / COLLAPSE_FPS) this.badFor += dt;
    else this.badFor = 0;

    const now = performance.now() / 1000;
    if (this.badFor >= COLLAPSE_SEC && now - this.lastCollapseAt > COLLAPSE_COOLDOWN) {
      this.lastCollapseAt = now;
      this.badFor = 0;
      this.report('perf');
      return;
    }
    if (this.sinceReport >= EVERY && this.context.playing) this.report('perf');
  }

  /** The window, as the three numbers that describe a frame rate honestly. */
  summary() {
    if (!this.n) return null;
    const sorted = Array.from(this.frames.subarray(0, this.n)).sort((a, b) => a - b);
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    // The 99th percentile frame, which is what "1% low" means: the stutter you
    // actually feel, as opposed to the average that hides it.
    const low = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
    return {
      fps: mean > 0 ? Math.round(1000 / mean) : 0,
      fpsLow: low > 0 ? Math.round(1000 / low) : 0,
      worstMs: Math.round(sorted[sorted.length - 1]),
      sampleSec: Math.round(sorted.reduce((s, v) => s + v, 0) / 1000),
    };
  }

  /* ── Reporting ─────────────────────────────────────────────────────────── */

  /** The line, built and posted. Never throws, never retries, never waits. */
  report(kind = 'perf') {
    if (!this.enabled) return;
    this.sinceReport = 0;
    const s = this.summary();
    if (kind !== 'boot' && !s) return;
    const render = this.info?.render ?? null;
    this.send({
      kind,
      ...(s ?? {}),
      map: this.context.map,
      mode: this.context.mode,
      room: this.context.room,
      quality: settings.quality,
      resolution: settings.resolution,
      pixelRatio: Math.round((window.devicePixelRatio ?? 1) * 100) / 100,
      shadows: !!settings.shadows,
      post: Number(settings.postProcessing ?? 1) > 0,
      draws: render?.calls ?? null,
      triangles: render?.triangles ?? null,
      programs: this.info?.programs?.length ?? null,
      gpu: this.gpu,
      screen: `${window.innerWidth}x${window.innerHeight}`,
      build: GAME_VERSION,
      ua: navigator.userAgent,
    });
  }

  /** Once, on the first frame the game ever draws. */
  boot() {
    if (this.booted) return;
    this.booted = true;
    this.report('boot');
  }

  /** An uncaught exception, with as much of its stack as is worth sending. */
  error(message, source = null, line = null, stack = null) {
    if (!this.enabled) return;
    this.send({
      kind: 'error',
      message: String(message ?? '').slice(0, 200),
      source: source ? String(source).slice(0, 160) : null,
      line: line ?? null,
      stack: stack ? String(stack).slice(0, 300) : null,
      map: this.context.map,
      room: this.context.room,
      gpu: this.gpu,
      build: GAME_VERSION,
      ua: navigator.userAgent,
    });
  }

  send(body) {
    try { api.post('/diag', body).catch(() => {}); } catch { /* offline */ }
  }

  /**
   * Catches what the game itself never sees.
   *
   * An exception thrown inside a `requestAnimationFrame` callback stops the
   * loop and leaves a frozen picture with nothing on screen to say why. This is
   * the only way that ever reaches anybody who could fix it.
   */
  listen() {
    window.addEventListener('error', (e) => {
      this.error(e.message, e.filename, e.lineno, e.error?.stack);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      this.error(r?.message ?? String(r), null, null, r?.stack);
    });
  }
}

export const diag = new Diagnostics();
export default diag;
