/**
 * Open Grunker — developer mode.
 *
 * A stack of read-only overlays, unlocked at DEV_MODE_LEVEL, that say what the
 * client is doing while you play: how long frames take, what the socket is
 * carrying, where the movement code thinks you are, and how far its guess was
 * from the server's.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 *
 * **Nothing here may show a player one fact about anybody else that their own
 * screen was not already about to show them.**
 *
 * That is not a stylistic preference, it is the difference between a debugging
 * tool and a cheat that shipped with the game. It is why there is no enemy
 * hitbox overlay, no "where is everyone" list, and no through-wall anything:
 * the reconciliation trace is of *your own* body, the collision overlay is of
 * the *map* — static data every client downloaded before the match started —
 * and the wire inspector counts opcodes and bytes without ever drawing what is
 * inside one. A panel that would have needed this comment to argue its way past
 * the rule is a panel that does not exist.
 *
 * The client already holds every other player's position; that is unavoidable
 * in a game that draws them, and it is what the anti-cheat on the server exists
 * to make useless. None of that is a reason to build a nicer window onto it.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * The overlays redraw at DRAW_HZ rather than per frame, and everything they
 * read is a counter something else was already keeping. With every panel open
 * this is a few DOM writes a second; with the mode off, `update()` returns on
 * its first line and the samplers are never even called.
 */
import * as K from '/shared/constants.js';
import { settings } from './settings.js';

/** Overlay redraws per second. Fast enough to read, slow enough to be free. */
const DRAW_HZ = 8;
/** Frame times kept for the histogram and the percentiles, ~4 s at 144 Hz. */
const FRAME_WINDOW = 600;
/** Reconciliation corrections kept for the trace. */
const RECON_WINDOW = 160;
/** Buckets the frame histogram is drawn in, in milliseconds. */
const FRAME_BUCKETS = [4, 6, 8, 11, 14, 17, 21, 26, 33, 50, 1e9];

const fmt = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const kb = (bytes) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes | 0} B`);

/** The p-th percentile of an already-sorted array. */
function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

export class DevMode {
  constructor() {
    /** What the server said this account may open. Replaced on every sign-in. */
    this.access = { allowed: false, pro: false, need: K.DEV_MODE_LEVEL, panels: [] };
    this.open = false;

    /* ── Samplers ──────────────────────────────────────────────────────────
     * Every one of these is fed by something that was already happening: a
     * frame ending, a packet arriving, a snapshot being reconciled. Nothing
     * here polls, and nothing here asks the server for anything. */
    this.frames = [];
    this.recon = [];
    /** opcode -> { count, bytes, last } for the wire inspector. */
    this.wire = new Map();
    this.wireTotal = { in: 0, out: 0, packetsIn: 0, packetsOut: 0 };
    /** One second's worth of counters, rolled over by `_roll`. */
    this.rate = { in: 0, out: 0, packetsIn: 0, packetsOut: 0, at: 0 };
    this.rateShown = { in: 0, out: 0, packetsIn: 0, packetsOut: 0 };

    this.drawAt = 0;
    this.lastFrameAt = 0;
    /** The node the HUD gives us to draw into, or null while the mode is shut. */
    this.el = null;
  }

  /**
   * Which panels are actually on, honouring both the gate and the settings.
   *
   * The gate first and the preference second, in that order: a panel the server
   * did not grant cannot be switched on from here whatever the settings say.
   * The stored preference is checked for being a list rather than trusted to be
   * one — it is the only array-valued setting, it round-trips through an
   * importable file, and reading `.includes` off whatever came back would be a
   * crash on the render loop.
   */
  get panels() {
    if (!this.access.allowed) return [];
    const wanted = Array.isArray(settings.devPanels) ? settings.devPanels : null;
    return wanted ? this.access.panels.filter((id) => wanted.includes(id)) : this.access.panels;
  }

  /**
   * Takes the access answer the server sent with the account.
   *
   * The client never decides this for itself. It is a level and a creator
   * status, both of which live on the server, and a client that worked it out
   * locally would be a client that could be told to work it out differently.
   */
  setAccess(access) {
    this.access = {
      allowed: !!access?.allowed,
      pro: !!access?.pro,
      need: access?.need ?? K.DEV_MODE_LEVEL,
      level: access?.level ?? 0,
      panels: Array.isArray(access?.panels) ? access.panels.filter((id) => K.DEV_PANEL_IDS.includes(id)) : [],
    };
    if (!this.access.allowed) this.open = false;
    return this.access;
  }

  /** Toggles the overlay. Returns whether it is now open. */
  toggle(on = !this.open) {
    this.open = !!on && this.access.allowed;
    if (!this.open && this.el) this.el.innerHTML = '';
    return this.open;
  }

  /* ── Samplers ───────────────────────────────────────────────────────────── */

  /** One finished frame. Called from the render loop, always — it is two adds. */
  sampleFrame(ms) {
    if (!this.access.allowed) return;
    this.frames.push(ms);
    if (this.frames.length > FRAME_WINDOW) this.frames.shift();
  }

  /**
   * One reconciliation: how far the prediction was from the server, and how
   * many inputs were still in flight when the correction landed.
   *
   * Both halves matter and neither is readable alone — a large error with an
   * empty queue is a desync, and a large error with twelve inputs queued is
   * simply a long way from the server.
   */
  sampleRecon(error, pending) {
    if (!this.access.allowed) return;
    this.recon.push({ error, pending, at: performance.now() });
    if (this.recon.length > RECON_WINDOW) this.recon.shift();
  }

  /**
   * One packet, in either direction.
   *
   * The opcode and the size, and deliberately not the body: this panel is for
   * seeing that a stream is unhealthy, and nothing about the *contents* of
   * somebody else's snapshot is a debugging question.
   */
  samplePacket(dir, opcode, bytes) {
    if (!this.access.allowed) return;
    const key = `${dir}:${opcode ?? '?'}`;
    const row = this.wire.get(key) ?? { dir, opcode: opcode ?? '?', count: 0, bytes: 0, last: 0 };
    row.count++;
    row.bytes += bytes;
    row.last = performance.now();
    this.wire.set(key, row);
    if (dir === 'in') { this.rate.in += bytes; this.rate.packetsIn++; }
    else { this.rate.out += bytes; this.rate.packetsOut++; }
  }

  /** Rolls the one-second counters over. Called from `update`. */
  _roll(now) {
    if (now - this.rate.at < 1000) return;
    this.rate.at = now;
    this.rateShown = {
      in: this.rate.in, out: this.rate.out,
      packetsIn: this.rate.packetsIn, packetsOut: this.rate.packetsOut,
    };
    this.wireTotal.in += this.rate.in;
    this.wireTotal.out += this.rate.out;
    this.wireTotal.packetsIn += this.rate.packetsIn;
    this.wireTotal.packetsOut += this.rate.packetsOut;
    this.rate.in = 0; this.rate.out = 0; this.rate.packetsIn = 0; this.rate.packetsOut = 0;
  }

  /* ── Drawing ────────────────────────────────────────────────────────────── */

  /**
   * Redraws the overlay, at most DRAW_HZ times a second.
   *
   * `game` is the one argument because every panel wants a different part of
   * it and passing seven of them would be a signature nobody could add to. It
   * is read and never written: this module has no business changing anything.
   */
  update(game) {
    if (!this.open || !this.el) return;
    const now = performance.now();
    this._roll(now);
    if (now - this.drawAt < 1000 / DRAW_HZ) return;
    this.drawAt = now;

    const panels = this.panels;
    const html = [];
    for (const id of panels) {
      const body = this._panel(id, game);
      if (body === null) continue;
      const meta = K.DEV_PANELS.find((p) => p.id === id);
      html.push(`<section class="dev-panel" data-panel="${id}">`
        + `<h6>${meta?.name ?? id}${meta?.pro ? '<i>PRO</i>' : ''}</h6>${body}</section>`);
    }
    this.el.innerHTML = html.join('');
  }

  /** One panel's body, or null when it has nothing to say yet. */
  _panel(id, game) {
    switch (id) {
      case 'perf': return this._perf(game);
      case 'net': return this._net(game);
      case 'state': return this._state(game);
      case 'render': return this._render(game);
      case 'wire': return this._wire();
      case 'recon': return this._recon();
      case 'frames': return this._frames();
      default: return null;
    }
  }

  _rows(rows) {
    return `<div class="dev-rows">${rows
      .map(([k, v, cls]) => `<span class="dev-k">${k}</span><span class="dev-v${cls ? ` ${cls}` : ''}">${v}</span>`)
      .join('')}</div>`;
  }

  _perf(game) {
    const sorted = [...this.frames].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    const info = game?.gfx?.renderer?.info;
    const mem = performance.memory;
    return this._rows([
      ['fps', fmt(1000 / p50, 0), p50 > 20 ? 'warn' : ''],
      ['frame p50', `${fmt(p50)} ms`],
      // The number that actually matters. An average frame time hides exactly
      // the frames anybody notices.
      ['frame p99', `${fmt(p99)} ms`, p99 > 33 ? 'bad' : p99 > 20 ? 'warn' : ''],
      ['draw calls', info?.render?.calls ?? '—'],
      ['triangles', (info?.render?.triangles ?? 0).toLocaleString()],
      ['geometries', info?.memory?.geometries ?? '—'],
      ['textures', info?.memory?.textures ?? '—'],
      ['programs', info?.programs?.length ?? '—'],
      ...(mem ? [['js heap', `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`]] : []),
    ]);
  }

  _net(game) {
    const net = game?.net;
    if (!net) return null;
    const buffer = game.entities?.buffer?.length ?? 0;
    const span = buffer > 1
      ? game.entities.buffer[buffer - 1].t - game.entities.buffer[0].t
      : 0;
    // Jitter as the spread of the RTT samples the client keeps anyway. A mean
    // ping says nothing about whether a connection is *steady*, which is the
    // half that decides whether the game feels right.
    const samples = net.rttSamples ?? [];
    const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
    const jitter = samples.length > 1
      ? Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length) * 1000
      : 0;
    return this._rows([
      ['rtt', `${(net.rtt * 1000).toFixed(0)} ms`, net.rtt > 0.15 ? 'warn' : ''],
      ['jitter', `${jitter.toFixed(1)} ms`, jitter > 25 ? 'warn' : ''],
      ['down', `${kb(this.rateShown.in)}/s`],
      ['up', `${kb(this.rateShown.out)}/s`],
      ['packets', `${this.rateShown.packetsIn} in · ${this.rateShown.packetsOut} out`],
      ['snapshots held', `${buffer}`, buffer < 2 ? 'warn' : ''],
      ['buffer span', `${(span).toFixed(0)} ms`],
      ['interp delay', `${(K.INTERP_DELAY * 1000).toFixed(0)} ms`],
      ['clock offset', `${(net.clockOffset ?? 0).toFixed(0)} ms`],
      ['inputs queued', `${game.pending?.length ?? 0}`],
    ]);
  }

  _state(game) {
    const p = game?.local;
    if (!p) return null;
    const speed = Math.hypot(p.vx, p.vz);
    return this._rows([
      ['position', `${fmt(p.x, 2)} ${fmt(p.y, 2)} ${fmt(p.z, 2)}`],
      ['velocity', `${fmt(p.vx, 2)} ${fmt(p.vy, 2)} ${fmt(p.vz, 2)}`],
      ['speed', `${fmt(speed, 2)} u/s`],
      ['vertical', `${fmt(p.vy, 2)} u/s`],
      ['on ground', p.onGround ? 'yes' : 'no'],
      ['height', fmt(p.height, 2)],
      ['crouching', p.crouching ? 'yes' : 'no'],
      ['sliding', p.sliding ? 'yes' : 'no'],
      ['surface', game.groundSurface ?? '—'],
      ['yaw / pitch', `${fmt(game.input?.yaw ?? 0, 2)} / ${fmt(game.input?.pitch ?? 0, 2)}`],
      ['health', `${Math.round(game.health ?? 0)}`],
      ['tick', `${game.tick ?? 0}`],
    ]);
  }

  _render(game) {
    // Buttons rather than readings: this is the one panel that writes anything,
    // and everything it writes is a local render flag. `data-dev` is what
    // hud.js delegates its clicks off, so nothing here holds a listener.
    const toggles = [
      ['wireframe', 'Wireframe', !!game?.devWireframe],
      ['nopost', 'No post-processing', !!game?.devNoPost],
      ['collision', 'Map collision volumes', !!game?.devCollision],
      ['freeze', 'Freeze the frustum', !!game?.devFreezeFrustum],
    ];
    return `<div class="dev-toggles">${toggles.map(([id, label, on]) =>
      `<button type="button" class="dev-toggle${on ? ' on' : ''}" data-dev="${id}">${label}</button>`)
      .join('')}</div>`;
  }

  _wire() {
    const rows = [...this.wire.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 12);
    if (!rows.length) return this._rows([['waiting', 'no packets yet']]);
    const now = performance.now();
    return `<div class="dev-wire">${rows.map((row) => `
      <span class="dev-op ${row.dir}">${row.dir === 'in' ? '↓' : '↑'}${row.opcode}</span>
      <span class="dev-v">${row.count.toLocaleString()}</span>
      <span class="dev-v">${kb(row.bytes)}</span>
      <span class="dev-v dim">${((now - row.last) / 1000).toFixed(1)}s</span>`).join('')}</div>`;
  }

  _recon() {
    if (!this.recon.length) return this._rows([['waiting', 'no corrections yet']]);
    const errors = this.recon.map((r) => r.error).sort((a, b) => a - b);
    const recent = this.recon.slice(-48);
    const worst = Math.max(0.02, ...recent.map((r) => r.error));
    // A sparkline of the last four dozen corrections. The shape is the reading:
    // a flat floor with occasional spikes is a healthy connection, and a
    // staircase is a client and a server disagreeing about the simulation.
    const bars = recent.map((r) => {
      const h = Math.max(2, Math.round((r.error / worst) * 26));
      const cls = r.error > 0.5 ? ' bad' : r.error > 0.15 ? ' warn' : '';
      return `<i class="dev-bar${cls}" style="height:${h}px"></i>`;
    }).join('');
    return `<div class="dev-spark">${bars}</div>${this._rows([
      ['median error', `${(percentile(errors, 50) * 100).toFixed(1)} cm`],
      ['p99 error', `${(percentile(errors, 99) * 100).toFixed(1)} cm`,
        percentile(errors, 99) > 0.5 ? 'bad' : ''],
      ['worst held', `${(errors[errors.length - 1] * 100).toFixed(1)} cm`],
      ['corrections', `${this.recon.length}`],
    ])}`;
  }

  _frames() {
    if (this.frames.length < 8) return this._rows([['waiting', 'sampling']]);
    const counts = new Array(FRAME_BUCKETS.length).fill(0);
    for (const ms of this.frames) {
      for (let i = 0; i < FRAME_BUCKETS.length; i++) {
        if (ms <= FRAME_BUCKETS[i]) { counts[i]++; break; }
      }
    }
    const peak = Math.max(1, ...counts);
    // A distribution rather than an average, because "60 fps on average" is
    // what a game that stutters twice a second also reports.
    const bars = counts.map((n, i) => {
      const h = Math.max(1, Math.round((n / peak) * 34));
      const label = FRAME_BUCKETS[i] > 1000 ? '50+' : `${FRAME_BUCKETS[i]}`;
      const cls = FRAME_BUCKETS[i] > 20 ? ' warn' : '';
      return `<i class="dev-bar${cls}" style="height:${h}px" title="${label} ms — ${n}"></i>`;
    }).join('');
    const slow = this.frames.filter((ms) => ms > 20).length;
    return `<div class="dev-spark tall">${bars}</div>${this._rows([
      ['frames held', `${this.frames.length}`],
      ['over 20 ms', `${slow} (${((slow / this.frames.length) * 100).toFixed(1)}%)`,
        slow / this.frames.length > 0.05 ? 'warn' : ''],
    ])}`;
  }
}

export default DevMode;
