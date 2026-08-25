// ==UserScript==
// @name         Open Grunker — Grunker.exe
// @namespace    open-grunker-cheat
// @version      3.0
// @description  Client-trust testing suite for Open Grunker. Silent aim, seed-grind no-spread, backtrack, ESP, wallhack, movement — with a dark, minimalist menu. Client-only; the server is never modified.
// @author       g0x
// @match        https://grunker.g0x.dev/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @match        http://*:7499/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Drives the Open Grunker client from the outside to probe what the server
 * accepts on trust. It hooks `window.game` (client/js/main.js) and reuses the
 * server's own maths by dynamically importing the same `/shared/*` modules the
 * client loads, so every computed shot is byte-identical to what the server
 * will re-simulate.
 *
 * Nothing here touches the server. Every advantage comes from what the
 * authoritative room already chooses to believe about a client:
 *
 *   • Silent aim   — onShoot() traces from the yaw/pitch in the shoot packet
 *                    and never checks they match your view.
 *   • No spread    — the shot's seq seeds a deterministic cone; we search seqs
 *                    for the one that lands dead-centre.
 *   • Backtrack    — the reported RTT sets how far the room rewinds enemies;
 *                    we aim at exactly that rewound position.
 *   • Speed hack   — the tick drains up to 3 inputs/tick with no time budget;
 *                    we feed the extra steps and mirror them in prediction.
 *
 * P — open / close the menu.  END — panic (everything off).
 * Default hotkeys: F1 wallhack · F2 silent aim · F3 triggerbot · F4 no-spread
 *                  F5 ESP · F6 bhop · F7 speed.
 */

(function () {
  'use strict';

  /* ── Small maths helpers ────────────────────────────────────────────────── */

  const DEG = Math.PI / 180;
  const HALF_PI = Math.PI / 2 - 0.001;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function angleDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Hitbox half-extents the room uses but does not export (server/game/room.js).
  const HIT_RADIUS = 0.46;

  /* ── Persisted configuration ────────────────────────────────────────────── */

  const STORE = '__og_cheat_v3';

  const DEFAULTS = {
    // Aimbot
    aimEnabled: true,
    silent: true,
    aimVisible: false,
    trigger: false,
    aimBone: 'head',        // head | body
    aimTarget: 'fov',       // fov | distance | health
    aimFov: 40,             // deg — cone the aimbot pulls from
    triggerFov: 5,          // deg — cone the triggerbot fires in
    aimSmooth: 0.55,        // 0..1 — visible-aim easing
    aimWallCheck: true,     // require line of sight (shots blocked by walls anyway)
    onlyVisible: false,     // stricter: respect the game's own visibility flag
    teamCheck: true,        // never target friendlies in team modes
    forceAds: true,         // claim ADS in the packet to tighten the cone

    // Accuracy
    noSpread: true,         // seed-grind the cone to centre
    noRecoil: true,

    // Visuals
    wallhack: true,
    chams: 'team',          // team | red | white
    esp: true,
    espBox: true,
    espHealth: true,
    espName: true,
    espDistance: true,
    espHeadDot: true,
    espSnaplines: false,
    espMaxDist: 320,
    radar: true,
    fovCircle: true,
    crosshair: false,

    // Movement / exploits
    bhop: false,
    autoStrafe: false,
    speed: false,
    speedMult: 2,           // 1..3 (server drains at most 3 inputs/tick)
    fakePing: false,
    fakePingMs: 180,        // 0..300 — reported RTT drives the rewind window
    autoRespawn: true,
    antiAfk: false,

    // Misc
    watermark: true,
    panelX: 26,
    panelY: 84,
  };

  const DEFAULT_BINDS = {
    menu: 'KeyP',
    panic: 'End',
    wallhack: 'F1',
    silent: 'F2',
    trigger: 'F3',
    noSpread: 'F4',
    esp: 'F5',
    bhop: 'F6',
    speed: 'F7',
  };

  const cfg = Object.assign({}, DEFAULTS);
  const binds = Object.assign({}, DEFAULT_BINDS);

  const SAVE_VER = 2;
  (function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
      if (raw.cfg) Object.assign(cfg, raw.cfg);
      if (raw.binds) Object.assign(binds, raw.binds);
      // One-time migration: the menu used to default to Insert; move it to P.
      if ((raw.ver | 0) < 2 && binds.menu === 'Insert') binds.menu = 'KeyP';
    } catch { /* private mode or corrupt */ }
  })();
  const save = () => {
    try { localStorage.setItem(STORE, JSON.stringify({ ver: SAVE_VER, cfg, binds })); } catch { /* ignore */ }
  };

  /* ── Toast ──────────────────────────────────────────────────────────────── */

  let toastEl;
  function toast(msg, tone = '') {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'ogx-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.dataset.tone = tone;
    toastEl.classList.add('show');
    clearTimeout(toastEl.__t);
    toastEl.__t = setTimeout(() => toastEl.classList.remove('show'), 1200);
  }

  /* ── Boot: wait for the game, then pull in the shared maths ──────────────── */

  let game, net, mv, shot, wep, K, THREE;
  let ready = false;

  function gameReady() {
    const g = window.game;
    return g && g.entities && g.entities.players && g.gfx && g.gfx.camera && g.input && g.net;
  }

  function waitForGame() {
    return new Promise((res) => {
      (function poll() {
        if (gameReady()) res(window.game);
        else requestAnimationFrame(poll);
      })();
    });
  }

  async function boot() {
    game = await waitForGame();
    net = game.net;
    try {
      [K, mv, shot, wep, THREE] = await Promise.all([
        import('/shared/constants.js'),
        import('/shared/movement.js'),
        import('/shared/shot.js'),
        import('/shared/weapons.js'),
        import('/vendor/three.module.js'),
      ]);
    } catch (e) {
      toast('cheat: failed to load shared modules', 'bad');
      // eslint-disable-next-line no-console
      console.error('[grunker.exe]', e);
      return;
    }

    installHooks();
    buildUI();
    bindKeys();
    startEsp();
    startLoop();
    ready = true;
    toast('grunker.exe ready — press P for the menu', 'good');
  }

  /* ── Aim solver ─────────────────────────────────────────────────────────── */

  const playing = () => game.state === 'playing';
  const playingOrSpec = () => game.state === 'playing' || game.state === 'spectating';
  const chatOpen = () => !!(game.hud && game.hud.chatOpen);

  let lastTarget = null;

  function myEye() {
    const l = game.local;
    return { x: l.x, y: mv.eyeY(l), z: l.z };
  }

  /** RTT we are currently telling the server we have — real, or the spoofed one. */
  function reportedRttMs() {
    return cfg.fakePing ? clamp(cfg.fakePingMs | 0, 0, 300) : Math.round((net.rtt || 0.08) * 1000);
  }
  /** Exactly the rewind the room will apply: clamp(rtt/2 + INTERP_DELAY, 0, MAX). */
  function lagSec() {
    return clamp(reportedRttMs() / 1000 / 2 + K.INTERP_DELAY, 0, K.MAX_LAG_COMP);
  }

  /**
   * Where a player was at server time `tMs`, read from the client's own
   * interpolation buffer — the same shape the room rewinds through.
   */
  function sampleAt(id, tMs) {
    const buf = game.entities.buffer;
    if (!buf || !buf.length) return null;
    let older = buf[0], newer = buf[buf.length - 1];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= tMs) { older = buf[i]; newer = buf[Math.min(i + 1, buf.length - 1)]; break; }
    }
    const a = older.entries.get(id);
    if (!a) return null;
    const b = newer.entries.get(id) || a;
    const span = newer.t - older.t;
    const al = span > 0 ? clamp((tMs - older.t) / span, 0, 1) : 0;
    const flags = b[6] | 0;
    const height = (flags & 4) || (flags & 8) ? K.PLAYER_CROUCH_HEIGHT : K.PLAYER_HEIGHT;
    return {
      x: lerp(a[1], b[1], al), y: lerp(a[2], b[2], al), z: lerp(a[3], b[3], al),
      height, hp: b[7], alive: (a[6] & 1) !== 0,
    };
  }

  /** The world point to aim at, at the precise time the server will test. */
  function aimPointFor(e) {
    const t = net.serverTime - lagSec() * 1000;
    const s = sampleAt(e.id, t);
    const px = s ? s.x : e.pos.x;
    const py = s ? s.y : e.pos.y;
    const pz = s ? s.z : e.pos.z;
    const h = s ? s.height : e.height;
    const y = cfg.aimBone === 'body' ? py + h * 0.5 : py + h - K.HEAD_HEIGHT * 0.5;
    return { x: px, y, z: pz };
  }

  function eligible(e) {
    if (!e || !e.alive || e.id === game.myId) return false;
    if (cfg.teamCheck && game.teamMode && e.profile && e.profile.team === game.myTeam) return false;
    if (cfg.onlyVisible && !e.visible) return false;
    return true;
  }

  /**
   * Best target inside `fovDeg` of the crosshair, plus the exact yaw/pitch that
   * puts a pellet on it. Priority: nearest to crosshair, nearest in the world,
   * or lowest health.
   */
  function solveAim(fovDeg) {
    if (!game.entities) return null;
    const eye = myEye();
    const maxAng = fovDeg * DEG;
    let best = null;
    for (const e of game.entities.players.values()) {
      if (!eligible(e)) continue;
      const aim = aimPointFor(e);
      const dx = aim.x - eye.x, dy = aim.y - eye.y, dz = aim.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 0.01) continue;
      if (cfg.aimWallCheck && game.world
          && !game.world.lineOfSight(eye.x, eye.y, eye.z, aim.x, aim.y, aim.z)) continue;
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.asin(clamp(dy / dist, -1, 1));
      const ang = Math.hypot(angleDiff(yaw, game.input.yaw), pitch - game.input.pitch);
      if (ang > maxAng) continue;
      const metric = cfg.aimTarget === 'distance' ? dist
        : cfg.aimTarget === 'health' ? (e.health ?? 100)
          : ang;
      if (!best || metric < best.metric) best = { e, yaw, pitch, ang, dist, metric };
    }
    return best;
  }

  /* ── Seed grind (no spread) ─────────────────────────────────────────────── */

  let seqCursor = 0;

  /**
   * Picks a shot seq whose deterministic cone lands as close to point-of-aim as
   * possible, staying strictly ahead of every seq we have sent (the server only
   * accepts `n > player.shotSeq`). Single-pellet weapons only — a shotgun's
   * spread is the point.
   */
  function grindSeq(yaw, pitch, ads, seq) {
    const w = game.weapon;
    const base = Math.max(seq | 0, seqCursor + 1);
    if (!w || w.melee || (w.pellets || 1) > 1) { seqCursor = base; return base; }

    let spread = 0;
    try {
      spread = wep.spreadFor(w, {
        moving: Math.hypot(game.local.vx, game.local.vz) > 1.5,
        airborne: !game.local.onGround,
        ads: !!ads,
        crouching: !!game.local.crouching,
        burst: game.burst || 0,
      });
    } catch { spread = 0; }
    if (!(spread > 0.0006)) { seqCursor = base; return base; }

    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
    let bestSeq = base, bestErr = Infinity;
    for (let n = base, end = base + 160; n < end; n++) {
      const d = shot.shotDirections(yaw, pitch, spread, shot.shotSeed(game.myId, n), 1)[0];
      const err = 1 - (d.x * fx + d.y * fy + d.z * fz);   // 0 = perfectly centred
      if (err < bestErr) { bestErr = err; bestSeq = n; if (err < 1e-6) break; }
    }
    seqCursor = bestSeq;
    return bestSeq;
  }

  /* ── Hooks onto the live client ─────────────────────────────────────────── */

  let origShoot, origPing, origSample, origTick, origRecoil;

  function installHooks() {
    // Silent aim + ADS spoof + seed grind, all in the one place a shot leaves.
    origShoot = net.shoot.bind(net);
    net.shoot = (yaw, pitch, ads, seq, burst) => {
      try {
        if (cfg.aimEnabled && cfg.silent && playing() && game.alive) {
          const sol = solveAim(cfg.aimFov);
          if (sol) { yaw = sol.yaw; pitch = sol.pitch; lastTarget = sol.e; }
        }
        if (cfg.forceAds) ads = true;
        if (cfg.noSpread) seq = grindSeq(yaw, pitch, ads, seq);
      } catch { /* fall through to a normal shot */ }
      return origShoot(yaw, pitch, ads, seq, burst);
    };

    // Fake latency: the reported RTT is what the room turns into rewind. The
    // real round trip is still measured from the echoed `t`, so the clock is fine.
    origPing = net.ping.bind(net);
    net.ping = () => {
      try {
        if (cfg.fakePing) {
          net.send({ o: K.C2S.PING, t: performance.now(), rtt: clamp(cfg.fakePingMs | 0, 0, 300) });
          return;
        }
      } catch { /* fall through */ }
      return origPing();
    };

    // Bunny hop + air-strafe: fold synthetic keys into the sample the tick both
    // predicts with and sends, so nothing ever desyncs.
    origSample = game.input.sample.bind(game.input);
    game.input.sample = () => {
      let keys = origSample();
      try {
        if (playing() && game.alive) {
          if (cfg.bhop && game.local.onGround) keys |= mv.KEY.JUMP;
          if (cfg.autoStrafe && !game.local.onGround) {
            const d = game.input.lookDelta.yaw;
            if (d < -1e-4) keys = (keys & ~mv.KEY.LEFT) | mv.KEY.RIGHT;
            else if (d > 1e-4) keys = (keys & ~mv.KEY.RIGHT) | mv.KEY.LEFT;
          }
        }
      } catch { /* ignore */ }
      return keys;
    };

    // Speed hack: run the extra simulation steps the drain cap will accept, and
    // step local prediction the same amount so the two stay in lock-step.
    origTick = game.simulateTick.bind(game);
    game.simulateTick = () => {
      origTick();
      try {
        if (!cfg.speed || !playing() || !game.alive) return;
        const extra = clamp(Math.round(cfg.speedMult) - 1, 0, 2);
        for (let i = 0; i < extra; i++) {
          const keys = game.input.sample();
          const seq = ++game.seq;
          const inp = { seq, keys, yaw: game.input.yaw, pitch: game.input.pitch };
          game.pending.push(inp);
          if (game.pending.length > 200) game.pending.shift();
          net.queueInput(seq, keys, inp.yaw, inp.pitch);
          mv.step(game.local, inp, game.world, K.TICK_DT, { speedMult: game.speedMultFor(keys) });
        }
      } catch { /* ignore */ }
    };

    // No recoil: the view never owes the kick back.
    origRecoil = game.input.addRecoil.bind(game.input);
    game.input.addRecoil = (p, y) => { if (cfg.noRecoil) return; return origRecoil(p, y); };
  }

  /* ── Wallhack / chams ───────────────────────────────────────────────────── */

  function chamsHex(e) {
    if (cfg.chams === 'red') return 0xff3344;
    if (cfg.chams === 'white') return 0xffffff;
    return e.teamColor ?? 0xff5a3c;
  }

  function tintMaterial(m, hex) {
    if (!m.__wh) m.__wh = { depthTest: m.depthTest, depthWrite: m.depthWrite };
    m.depthTest = false;
    m.depthWrite = false;
    if (m.emissive) {
      if (m.__we === undefined) m.__we = m.emissive.getHex();
      m.emissive.setHex(hex);
    }
    m.needsUpdate = true;
  }

  function restoreMaterial(m) {
    if (m.__wh) {
      m.depthTest = m.__wh.depthTest;
      m.depthWrite = m.__wh.depthWrite;
      delete m.__wh;
    }
    if (m.__we !== undefined && m.emissive) { m.emissive.setHex(m.__we); delete m.__we; }
    m.needsUpdate = true;
  }

  function revertGroup(group) {
    if (!group) return;
    group.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m.__wh || m.__we !== undefined) restoreMaterial(m);
      }
      if (o.__whOrder !== undefined) { o.renderOrder = o.__whOrder; delete o.__whOrder; }
    });
  }

  function applyWallhack() {
    for (const e of game.entities.players.values()) {
      const friendly = cfg.teamCheck && game.teamMode && e.profile && e.profile.team === game.myTeam;
      if (!e.alive || friendly) { revertGroup(e.group); continue; }
      const hex = chamsHex(e);
      e.group.traverse((o) => {
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) tintMaterial(m, hex);
        }
        if (o.__whOrder === undefined) o.__whOrder = o.renderOrder;
        o.renderOrder = 999;
      });
    }
  }

  function revertAllWallhack() {
    for (const e of game.entities.players.values()) revertGroup(e.group);
  }

  /* ── ESP overlay ────────────────────────────────────────────────────────── */

  let espCanvas, espCtx, DPR = 1;
  let vFwd, vTo, vProj, vTmp, vTmp2;

  function startEsp() {
    espCanvas = document.createElement('canvas');
    espCanvas.id = 'ogx-esp';
    document.body.appendChild(espCanvas);
    espCtx = espCanvas.getContext('2d');
    vFwd = new THREE.Vector3();
    vTo = new THREE.Vector3();
    vProj = new THREE.Vector3();
    vTmp = new THREE.Vector3();
    vTmp2 = new THREE.Vector3();
  }

  function project(vec3, W, H) {
    const cam = game.gfx.camera;
    vTo.copy(vec3).sub(cam.position);
    if (vTo.dot(vFwd) <= 0) return null;                // behind the camera
    vProj.copy(vec3).project(cam);
    return { x: (vProj.x * 0.5 + 0.5) * W, y: (-vProj.y * 0.5 + 0.5) * H };
  }

  function drawEsp() {
    if (!espCtx) return;
    const W = window.innerWidth, H = window.innerHeight;
    DPR = window.devicePixelRatio || 1;
    if (espCanvas.width !== Math.round(W * DPR) || espCanvas.height !== Math.round(H * DPR)) {
      espCanvas.width = Math.round(W * DPR);
      espCanvas.height = Math.round(H * DPR);
    }
    espCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    espCtx.clearRect(0, 0, W, H);

    const cam = game.gfx.camera;
    cam.getWorldDirection(vFwd);

    if (cfg.crosshair) drawCrosshair(W, H);
    if (cfg.fovCircle && cfg.aimEnabled && (cfg.silent || cfg.aimVisible)) drawFovCircle(W, H);

    if (cfg.esp && playingOrSpec()) {
      for (const e of game.entities.players.values()) {
        if (!e.alive || e.id === game.myId) continue;
        if (cfg.teamCheck && game.teamMode && e.profile && e.profile.team === game.myTeam) continue;
        const dist = cam.position.distanceTo(e.pos);
        if (dist > cfg.espMaxDist) continue;

        const foot = project(vTmp.copy(e.pos), W, H);
        const head = project(vTmp2.copy(e.pos).setY(e.pos.y + e.height + 0.28), W, H);
        if (!foot || !head) continue;
        drawEntity(e, foot, head, dist, W, H);
      }
    }

    if (cfg.radar && playingOrSpec()) drawRadar(W, H);
  }

  function drawEntity(e, foot, head, dist, W, H) {
    const ctx = espCtx;
    const seen = e.visible;
    const col = seen ? '#ff4d5e' : '#8f9bb3';
    const boxH = Math.max(8, foot.y - head.y);
    const boxW = boxH * 0.46;
    const x = (head.x + foot.x) / 2 - boxW / 2;
    const y = head.y;

    if (cfg.espSnaplines) {
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W / 2, H);
      ctx.lineTo((head.x + foot.x) / 2, foot.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (cfg.espBox) {
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      roundRectPath(ctx, x - 0.6, y - 0.6, boxW + 1.2, boxH + 1.2, 3);
      ctx.stroke();
      ctx.strokeStyle = col;
      roundRectPath(ctx, x, y, boxW, boxH, 3);
      ctx.stroke();
    }

    if (cfg.espHealth) {
      const hp = clamp((e.health ?? 100) / K.MAX_HEALTH, 0, 1);
      const bx = x - 5, bw = 3, bh = boxH;
      ctx.fillStyle = 'rgba(0,0,0,.7)';
      roundRectPath(ctx, bx - 1, y - 1, bw + 2, bh + 2, 2); ctx.fill();
      ctx.fillStyle = hp > 0.5 ? '#57e08a' : hp > 0.25 ? '#f5b03a' : '#ff4d4d';
      const fh = bh * hp;
      roundRectPath(ctx, bx, y + (bh - fh), bw, fh, 2); ctx.fill();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (cfg.espName && e.profile) {
      const nm = (e.profile.clan ? `[${e.profile.clan}] ` : '') + e.profile.name;
      ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
      label(ctx, nm, (head.x + foot.x) / 2, y - 5, '#e8edf5');
    }
    if (cfg.espDistance) {
      ctx.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
      label(ctx, `${Math.round(dist)}m`, (head.x + foot.x) / 2, foot.y + 12, '#aab6c9');
    }
    if (cfg.espHeadDot) {
      ctx.beginPath();
      ctx.arc(head.x, head.y - 1, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = seen ? '#ffd24a' : '#6f7a90';
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.lineWidth = 1;
      ctx.fill(); ctx.stroke();
    }
  }

  function label(ctx, text, x, y, color) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.9)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function drawCrosshair(W, H) {
    const ctx = espCtx, cx = W / 2, cy = H / 2, g = 4, len = 7;
    ctx.strokeStyle = '#3ad6c8';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - g - len, cy); ctx.lineTo(cx - g, cy);
    ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + len, cy);
    ctx.moveTo(cx, cy - g - len); ctx.lineTo(cx, cy - g);
    ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + len);
    ctx.stroke();
    ctx.fillStyle = '#3ad6c8';
    ctx.fillRect(cx - 0.6, cy - 0.6, 1.2, 1.2);
  }

  function drawFovCircle(W, H) {
    const ctx = espCtx;
    const fov = cfg.aimVisible ? cfg.aimFov : cfg.silent ? cfg.aimFov : cfg.triggerFov;
    const r = fov * (H / (game.gfx.camera.fov || 75));
    ctx.strokeStyle = 'rgba(120,150,255,.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, clamp(r, 6, Math.max(W, H)), 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawRadar(W, H) {
    const ctx = espCtx;
    const R = 78, pad = 20;
    const cx = pad + R, cy = H - pad - R;
    const range = 70;                                   // metres shown to the edge

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,13,19,.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.clip();

    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    const yaw = game.input.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);     // my forward (XZ)
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);      // my right (XZ)
    const l = game.local;
    for (const e of game.entities.players.values()) {
      if (!e.alive || e.id === game.myId) continue;
      if (cfg.teamCheck && game.teamMode && e.profile && e.profile.team === game.myTeam) continue;
      const ex = e.pos.x - l.x, ez = e.pos.z - l.z;
      const forward = ex * fx + ez * fz;
      const right = ex * rx + ez * rz;
      let px = cx + (right / range) * R;
      let py = cy - (forward / range) * R;
      const dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy);
      if (d > R - 3) { px = cx + (dx / d) * (R - 3); py = cy + (dy / d) * (R - 3); }
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fillStyle = e.visible ? '#ff4d5e' : '#8f9bb3';
      ctx.fill();
    }
    // Me, pointing up.
    ctx.fillStyle = '#3ad6c8';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6); ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx + 4, cy + 4);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ── Per-frame feature loop ─────────────────────────────────────────────── */

  let fps = 0, lastFrame = performance.now(), lastRespawn = 0, lastAfk = 0;

  function startLoop() {
    (function frame(now) {
      requestAnimationFrame(frame);
      const dt = Math.min(0.25, (now - lastFrame) / 1000);
      lastFrame = now;
      fps += ((1 / dt) - fps) * 0.1;

      try { tickFeatures(now); } catch { /* never let the cheat kill the frame */ }
      try { drawEsp(); } catch { /* ignore */ }
      updateWatermark();
    })(performance.now());
  }

  function tickFeatures(now) {
    if (!ready) return;

    // Wallhack / chams.
    if (cfg.wallhack && playingOrSpec()) applyWallhack();

    const canAct = playing() && game.alive && !menuOpen && !chatOpen();

    // Visible aim — eased toward the target so it reads like a steady hand.
    if (canAct && cfg.aimEnabled && cfg.aimVisible) {
      const sol = solveAim(cfg.aimFov);
      if (sol) {
        lastTarget = sol.e;
        game.input.yaw += angleDiff(sol.yaw, game.input.yaw) * cfg.aimSmooth;
        game.input.pitch = clamp(game.input.pitch + (sol.pitch - game.input.pitch) * cfg.aimSmooth,
          -HALF_PI, HALF_PI);
      }
    }

    // Triggerbot — fire the instant a target is inside the trigger cone.
    if (canAct && cfg.aimEnabled && cfg.trigger) {
      const sol = solveAim(cfg.triggerFov);
      if (sol) { lastTarget = sol.e; game.tryFire(); }
    }

    // Auto respawn.
    if (cfg.autoRespawn && playing() && !game.alive
        && performance.now() / 1000 >= (game.respawnAt || 0) && now - lastRespawn > 400) {
      lastRespawn = now;
      net.respawn();
    }

    // Anti-AFK — a heartbeat so an idle socket is never mistaken for a dead one.
    if (cfg.antiAfk && net.connected && now - lastAfk > 12000) {
      lastAfk = now;
      try { net.ping(); } catch { /* ignore */ }
    }

    if (!cfg.aimEnabled || (!cfg.silent && !cfg.aimVisible && !cfg.trigger)) lastTarget = null;
  }

  /* ── Panic ──────────────────────────────────────────────────────────────── */

  const HOT = ['silent', 'aimVisible', 'trigger', 'wallhack', 'esp', 'bhop', 'autoStrafe',
    'speed', 'fakePing', 'noSpread', 'noRecoil', 'radar', 'fovCircle', 'crosshair'];

  function panic() {
    cfg.aimEnabled = false;
    for (const k of HOT) cfg[k] = false;
    revertAllWallhack();
    save();
    syncUI();
    toast('PANIC — everything off', 'bad');
  }

  /* ─────────────────────────────────────────────────────────────────────────
   *  UI
   * ──────────────────────────────────────────────────────────────────────── */

  const TABS = [
    {
      id: 'aim', label: 'Aimbot', icon: '◎',
      items: [
        { type: 'toggle', key: 'aimEnabled', label: 'Aimbot enabled' },
        { type: 'toggle', key: 'silent', label: 'Silent aim', hint: 'server-side · crosshair stays free' },
        { type: 'toggle', key: 'aimVisible', label: 'Visible aim', hint: 'moves your actual view' },
        { type: 'toggle', key: 'trigger', label: 'Triggerbot' },
        { type: 'segment', key: 'aimBone', label: 'Target bone', options: [['head', 'Head'], ['body', 'Body']] },
        { type: 'segment', key: 'aimTarget', label: 'Priority', options: [['fov', 'Crosshair'], ['distance', 'Closest'], ['health', 'Low HP']] },
        { type: 'slider', key: 'aimFov', label: 'Aim FOV', min: 1, max: 180, step: 1, unit: '°' },
        { type: 'slider', key: 'triggerFov', label: 'Trigger FOV', min: 1, max: 30, step: 0.5, unit: '°' },
        { type: 'slider', key: 'aimSmooth', label: 'Smoothing', min: 0.02, max: 1, step: 0.02, unit: '' },
        { type: 'toggle', key: 'aimWallCheck', label: 'Visibility check', hint: 'skip targets behind walls' },
        { type: 'toggle', key: 'onlyVisible', label: 'Only rendered targets' },
        { type: 'toggle', key: 'teamCheck', label: 'Ignore teammates' },
      ],
    },
    {
      id: 'acc', label: 'Accuracy', icon: '⊹',
      items: [
        { type: 'toggle', key: 'noSpread', label: 'No spread', hint: 'seed-grinds the cone to centre' },
        { type: 'toggle', key: 'forceAds', label: 'Force ADS', hint: 'claims ADS to tighten the cone' },
        { type: 'toggle', key: 'noRecoil', label: 'No recoil' },
        { type: 'note', text: 'Spread and recoil are the only randomness on a bullet. Grinding the seed and claiming ADS collapse the cone; no-recoil keeps the view still for manual fire.' },
      ],
    },
    {
      id: 'esp', label: 'Visuals', icon: '◇',
      items: [
        { type: 'toggle', key: 'esp', label: 'ESP master' },
        { type: 'toggle', key: 'espBox', label: 'Boxes' },
        { type: 'toggle', key: 'espHealth', label: 'Health bars' },
        { type: 'toggle', key: 'espName', label: 'Names' },
        { type: 'toggle', key: 'espDistance', label: 'Distance' },
        { type: 'toggle', key: 'espHeadDot', label: 'Head dot' },
        { type: 'toggle', key: 'espSnaplines', label: 'Snaplines' },
        { type: 'slider', key: 'espMaxDist', label: 'ESP distance', min: 10, max: 500, step: 10, unit: 'm' },
        { type: 'toggle', key: 'radar', label: 'Radar' },
        { type: 'header', label: 'Chams' },
        { type: 'toggle', key: 'wallhack', label: 'Wallhack', hint: 'draw players through walls' },
        { type: 'segment', key: 'chams', label: 'Colour', options: [['team', 'Team'], ['red', 'Red'], ['white', 'White']] },
        { type: 'header', label: 'Screen' },
        { type: 'toggle', key: 'fovCircle', label: 'FOV circle' },
        { type: 'toggle', key: 'crosshair', label: 'Custom crosshair' },
      ],
    },
    {
      id: 'move', label: 'Movement', icon: '⇅',
      items: [
        { type: 'toggle', key: 'bhop', label: 'Bunny hop' },
        { type: 'toggle', key: 'autoStrafe', label: 'Auto strafe', hint: 'synced to your mouse in the air' },
        { type: 'toggle', key: 'speed', label: 'Speed hack' },
        { type: 'slider', key: 'speedMult', label: 'Speed multiplier', min: 1, max: 3, step: 0.5, unit: '×' },
        { type: 'note', text: 'The room drains at most 3 inputs per tick, so 3× is the ceiling. Prediction is stepped the same amount, so movement stays smooth — push it past the cap and the server rubberbands you back.' },
      ],
    },
    {
      id: 'expl', label: 'Exploits', icon: '⚑',
      items: [
        { type: 'toggle', key: 'fakePing', label: 'Fake latency' },
        { type: 'slider', key: 'fakePingMs', label: 'Reported ping', min: 0, max: 300, step: 10, unit: 'ms' },
        { type: 'note', text: 'Your reported RTT is what the room turns into lag-comp rewind. Inflate it and every shot — silent or manual — is aimed at exactly where the target was when the server rewinds to it.' },
        { type: 'header', label: 'Convenience' },
        { type: 'toggle', key: 'autoRespawn', label: 'Auto respawn' },
        { type: 'toggle', key: 'antiAfk', label: 'Anti-AFK' },
      ],
    },
    {
      id: 'cfg', label: 'Config', icon: '⚙',
      items: [
        { type: 'preset' },
        { type: 'header', label: 'Keybinds' },
        { type: 'keybind', action: 'menu', label: 'Menu' },
        { type: 'keybind', action: 'silent', label: 'Silent aim' },
        { type: 'keybind', action: 'trigger', label: 'Triggerbot' },
        { type: 'keybind', action: 'noSpread', label: 'No spread' },
        { type: 'keybind', action: 'wallhack', label: 'Wallhack' },
        { type: 'keybind', action: 'esp', label: 'ESP' },
        { type: 'keybind', action: 'bhop', label: 'Bunny hop' },
        { type: 'keybind', action: 'speed', label: 'Speed hack' },
        { type: 'keybind', action: 'panic', label: 'Panic (all off)' },
        { type: 'header', label: 'Interface' },
        { type: 'toggle', key: 'watermark', label: 'Watermark' },
      ],
    },
  ];

  // Which cfg keys a hotkey toggles — kept for toast labels.
  const HOTKEY_LABEL = {
    wallhack: 'Wallhack', silent: 'Silent aim', trigger: 'Triggerbot',
    noSpread: 'No spread', esp: 'ESP', bhop: 'Bhop', speed: 'Speed hack',
  };

  let panel, tabBody, tabRail, statusEl, searchEl, watermarkEl;
  let activeTab = 'aim';
  let menuOpen = false;
  let captureBind = null;

  function buildUI() {
    injectCss();

    panel = el('div', 'ogx-panel');
    panel.style.left = `${cfg.panelX}px`;
    panel.style.top = `${cfg.panelY}px`;
    panel.innerHTML = `
      <header class="ogx-head">
        <div class="ogx-brand">
          <span class="ogx-logo">◆</span>
          <div>
            <div class="ogx-title">grunker<span>.exe</span></div>
            <div class="ogx-sub">client-trust suite</div>
          </div>
        </div>
        <button class="ogx-x" title="close (P)">✕</button>
      </header>
      <div class="ogx-search"><input type="text" placeholder="Search settings…" spellcheck="false"></div>
      <div class="ogx-body">
        <nav class="ogx-rail"></nav>
        <section class="ogx-content"></section>
      </div>
      <footer class="ogx-foot"></footer>`;
    document.body.appendChild(panel);

    tabRail = panel.querySelector('.ogx-rail');
    tabBody = panel.querySelector('.ogx-content');
    statusEl = panel.querySelector('.ogx-foot');
    searchEl = panel.querySelector('.ogx-search input');

    for (const t of TABS) {
      const b = el('button', 'ogx-tab');
      b.dataset.tab = t.id;
      b.innerHTML = `<span class="ogx-ic">${t.icon}</span><span>${t.label}</span>`;
      b.addEventListener('click', () => { activeTab = t.id; searchEl.value = ''; renderContent(); });
      tabRail.appendChild(b);
    }

    panel.querySelector('.ogx-x').addEventListener('click', () => toggleMenu(false));
    searchEl.addEventListener('input', renderContent);
    makeDraggable(panel.querySelector('.ogx-head'));

    watermarkEl = el('div', 'ogx-watermark');
    document.body.appendChild(watermarkEl);

    renderContent();
    updateStatus();
    setInterval(updateStatus, 250);
  }

  function renderContent() {
    for (const b of tabRail.children) b.classList.toggle('on', b.dataset.tab === activeTab);
    tabBody.innerHTML = '';
    const q = (searchEl.value || '').trim().toLowerCase();

    let items, showHeaders = true;
    if (q) {
      items = [];
      for (const t of TABS) for (const it of t.items) {
        const text = (it.label || it.text || (it.action ? `keybind ${it.action}` : '')).toLowerCase();
        if (text.includes(q)) items.push(it);
      }
      showHeaders = false;
      if (!items.length) { tabBody.appendChild(el('div', 'ogx-empty', 'No matching setting.')); return; }
    } else {
      items = (TABS.find((t) => t.id === activeTab) || TABS[0]).items;
    }

    for (const it of items) {
      if (it.type === 'header') { if (showHeaders) tabBody.appendChild(sectionHeader(it.label)); continue; }
      if (it.type === 'note') { tabBody.appendChild(note(it.text)); continue; }
      if (it.type === 'preset') { tabBody.appendChild(presetRow()); continue; }
      tabBody.appendChild(renderItem(it));
    }
  }

  function renderItem(it) {
    if (it.type === 'toggle') return toggleRow(it);
    if (it.type === 'slider') return sliderRow(it);
    if (it.type === 'segment') return segmentRow(it);
    if (it.type === 'keybind') return keybindRow(it);
    return document.createComment('');
  }

  /* ── Controls ───────────────────────────────────────────────────────────── */

  function rowShell(label, hint) {
    const row = el('div', 'ogx-row');
    const l = el('div', 'ogx-label');
    l.appendChild(el('span', 'ogx-lname', label));
    if (hint) l.appendChild(el('span', 'ogx-hint', hint));
    row.appendChild(l);
    return row;
  }

  function toggleRow(it) {
    const row = rowShell(it.label, it.hint);
    const sw = el('button', 'ogx-switch');
    sw.dataset.key = it.key;
    const paint = () => sw.classList.toggle('on', !!cfg[it.key]);
    sw.appendChild(el('i'));
    sw.addEventListener('click', () => {
      cfg[it.key] = !cfg[it.key];
      if (it.key === 'wallhack' && !cfg.wallhack) revertAllWallhack();
      save(); paint(); updateStatus();
    });
    paint();
    row.appendChild(sw);
    return row;
  }

  function segmentRow(it) {
    const row = rowShell(it.label, it.hint);
    const seg = el('div', 'ogx-seg');
    for (const [v, lbl] of it.options) {
      const o = el('button', 'ogx-segopt', lbl);
      o.classList.toggle('on', cfg[it.key] === v);
      o.addEventListener('click', () => {
        cfg[it.key] = v; save();
        for (const c of seg.children) c.classList.toggle('on', c === o);
        updateStatus();
      });
      seg.appendChild(o);
    }
    row.appendChild(seg);
    return row;
  }

  function sliderRow(it) {
    const row = rowShell(it.label, it.hint);
    const wrap = el('div', 'ogx-slider');
    const track = el('div', 'ogx-track');
    const fill = el('div', 'ogx-fill');
    const thumb = el('div', 'ogx-thumb');
    const val = el('div', 'ogx-val');
    track.append(fill, thumb);
    wrap.append(track, val);

    const paint = () => {
      const r = (cfg[it.key] - it.min) / (it.max - it.min);
      fill.style.width = `${r * 100}%`;
      thumb.style.left = `${r * 100}%`;
      const dec = it.step < 1 ? 2 : 0;
      val.textContent = `${(+cfg[it.key]).toFixed(dec)}${it.unit}`;
    };
    const setFromX = (clientX) => {
      const b = track.getBoundingClientRect();
      let r = clamp((clientX - b.left) / b.width, 0, 1);
      let v = it.min + r * (it.max - it.min);
      v = Math.round(v / it.step) * it.step;
      v = clamp(+v.toFixed(4), it.min, it.max);
      cfg[it.key] = v; paint();
    };
    const down = (e) => {
      e.preventDefault();
      setFromX(e.clientX);
      const move = (ev) => setFromX(ev.clientX);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        save(); updateStatus();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    track.addEventListener('pointerdown', down);
    paint();
    row.appendChild(wrap);
    return row;
  }

  function keybindRow(it) {
    const row = rowShell(it.label);
    const btn = el('button', 'ogx-key', prettyKey(binds[it.action]));
    btn.addEventListener('click', () => {
      if (captureBind) return;
      captureBind = { action: it.action, btn };
      btn.classList.add('capturing');
      btn.textContent = 'press a key…';
    });
    btn.dataset.action = it.action;
    row.appendChild(btn);
    return row;
  }

  function presetRow() {
    const wrap = el('div', 'ogx-presets');
    const mk = (label, cls, fn) => {
      const b = el('button', `ogx-preset ${cls}`, label);
      b.addEventListener('click', fn);
      return b;
    };
    wrap.append(
      mk('Legit', 'ghost', () => applyPreset('legit')),
      mk('Rage', 'ghost', () => applyPreset('rage')),
      mk('Reset', 'ghost', () => { Object.assign(cfg, DEFAULTS); save(); revertAllWallhack(); renderContent(); updateStatus(); toast('config reset'); }),
    );
    return wrap;
  }

  function applyPreset(which) {
    if (which === 'legit') {
      Object.assign(cfg, {
        aimEnabled: true, silent: false, aimVisible: true, trigger: false,
        aimBone: 'head', aimTarget: 'fov', aimFov: 6, aimSmooth: 0.16,
        aimWallCheck: true, onlyVisible: true, forceAds: true,
        noSpread: true, noRecoil: true,
        wallhack: false, esp: true, espBox: true, espName: true, espHealth: true,
        espSnaplines: false, radar: true, fovCircle: false,
        bhop: false, autoStrafe: false, speed: false, fakePing: false,
      });
      toast('Legit preset', 'good');
    } else {
      Object.assign(cfg, {
        aimEnabled: true, silent: true, aimVisible: false, trigger: true,
        aimBone: 'head', aimTarget: 'fov', aimFov: 180, triggerFov: 12,
        aimWallCheck: true, onlyVisible: false, forceAds: true,
        noSpread: true, noRecoil: true,
        wallhack: true, chams: 'team', esp: true, radar: true, fovCircle: true,
        bhop: true, autoStrafe: true, speed: false, fakePing: true, fakePingMs: 180,
      });
      toast('Rage preset', 'good');
    }
    save(); renderContent(); updateStatus();
  }

  function sectionHeader(text) { return el('div', 'ogx-sechead', text); }
  function note(text) { const n = el('div', 'ogx-note'); n.textContent = text; return n; }

  /* ── Footer status + watermark ──────────────────────────────────────────── */

  function updateStatus() {
    if (!statusEl) return;
    const on = [];
    if (cfg.aimEnabled && cfg.silent) on.push('SILENT');
    if (cfg.aimEnabled && cfg.aimVisible) on.push('AIM');
    if (cfg.aimEnabled && cfg.trigger) on.push('TRIG');
    if (cfg.noSpread) on.push('NOSPR');
    if (cfg.wallhack) on.push('WH');
    if (cfg.esp) on.push('ESP');
    if (cfg.bhop) on.push('BHOP');
    if (cfg.speed) on.push('SPEED');
    if (cfg.fakePing) on.push('LAG');
    const tgt = lastTarget && lastTarget.profile ? lastTarget.profile.name : '—';
    statusEl.innerHTML =
      `<span class="ogx-stat">target <b>${escapeHtml(tgt)}</b></span>`
      + `<span class="ogx-chips">${on.map((s) => `<i>${s}</i>`).join('') || '<i class="off">idle</i>'}</span>`;
  }

  function updateWatermark() {
    if (!watermarkEl) return;
    if (!cfg.watermark) { watermarkEl.style.display = 'none'; return; }
    watermarkEl.style.display = 'flex';
    const ping = reportedRttMs();
    watermarkEl.innerHTML =
      `<span class="ogx-wm-name">grunker<b>.exe</b></span>`
      + `<span class="ogx-wm-sep"></span><span>${Math.round(fps)} fps</span>`
      + `<span class="ogx-wm-sep"></span><span>${ping} ms${cfg.fakePing ? '*' : ''}</span>`
      + (lastTarget && lastTarget.profile
        ? `<span class="ogx-wm-sep"></span><span class="ogx-wm-tgt">▸ ${escapeHtml(lastTarget.profile.name)}</span>` : '');
  }

  /* ── Menu open/close + keys ─────────────────────────────────────────────── */

  function toggleMenu(force) {
    menuOpen = force === undefined ? !menuOpen : force;
    panel.classList.toggle('open', menuOpen);
    if (menuOpen) {
      try { game.input.unlock(); } catch { /* ignore */ }
    } else if (playing()) {
      try { game.input.lock(); } catch { /* ignore */ }
    }
  }

  // Re-render the visible controls after a programmatic change (hotkey/preset/panic).
  function syncUI() {
    if (panel) renderContent();
    updateStatus();
  }

  function bindKeys() {
    window.addEventListener('keydown', (ev) => {
      // Rebinding: swallow the next key.
      if (captureBind) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        const code = ev.code === 'Escape' ? captureBind.action && binds[captureBind.action] : ev.code;
        if (ev.code !== 'Escape') binds[captureBind.action] = ev.code;
        captureBind.btn.classList.remove('capturing');
        captureBind.btn.textContent = prettyKey(binds[captureBind.action]);
        captureBind = null;
        save();
        return;
      }

      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      const code = ev.code;
      if (code === binds.menu) { toggleMenu(); return stop(ev); }
      if (menuOpen && code === 'Escape') { toggleMenu(false); return stop(ev); }
      if (code === binds.panic) { panic(); return stop(ev); }

      const map = {
        [binds.wallhack]: 'wallhack', [binds.silent]: 'silent', [binds.trigger]: 'trigger',
        [binds.noSpread]: 'noSpread', [binds.esp]: 'esp', [binds.bhop]: 'bhop', [binds.speed]: 'speed',
      };
      const key = map[code];
      if (key) {
        if (key === 'silent') cfg.aimEnabled = true;         // the hotkey means "aim now"
        cfg[key] = !cfg[key];
        if (key === 'wallhack' && !cfg.wallhack) revertAllWallhack();
        save();
        toast(`${HOTKEY_LABEL[key]} ${cfg[key] ? 'ON' : 'OFF'}`, cfg[key] ? 'good' : '');
        syncUI();
        return stop(ev);
      }
    }, true);
  }

  function stop(ev) { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); }

  /* ── Drag ───────────────────────────────────────────────────────────────── */

  function makeDraggable(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ogx-x')) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => {
        const x = clamp(ev.clientX - ox, 4, window.innerWidth - 60);
        const y = clamp(ev.clientY - oy, 4, window.innerHeight - 40);
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        cfg.panelX = Math.round(x); cfg.panelY = Math.round(y);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        save();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /* ── DOM helpers ────────────────────────────────────────────────────────── */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function prettyKey(code) {
    if (!code) return '—';
    return code
      .replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '')
      .replace('Insert', 'INS').replace('Delete', 'DEL').replace('Escape', 'ESC')
      .replace('Control', 'CTRL').replace('Space', 'SPACE');
  }

  /* ── Styles ─────────────────────────────────────────────────────────────── */

  function injectCss() {
    const css = `
:root{
  --ogx-bg:#0b0d12; --ogx-bg2:#0f1218; --ogx-panel:rgba(14,17,23,.94);
  --ogx-line:rgba(255,255,255,.07); --ogx-line2:rgba(255,255,255,.12);
  --ogx-txt:#dbe3ee; --ogx-dim:#7d879a; --ogx-dim2:#586173;
  --ogx-acc:#3ad6c8; --ogx-acc2:#2ec5f0; --ogx-red:#ff4d5e; --ogx-good:#57e08a;
  --ogx-r:16px; --ogx-r2:11px; --ogx-r3:8px;
  --ogx-font:'Inter',ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;
  --ogx-mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
}
#ogx-esp{position:fixed;inset:0;z-index:2147483000;pointer-events:none}
.ogx-watermark{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483200;
  display:flex;align-items:center;gap:9px;padding:5px 12px;border-radius:999px;
  background:rgba(11,13,18,.7);border:1px solid var(--ogx-line);backdrop-filter:blur(8px);
  font:600 11px/1 var(--ogx-mono);color:var(--ogx-dim);letter-spacing:.04em;pointer-events:none;
  box-shadow:0 6px 22px rgba(0,0,0,.4)}
.ogx-watermark .ogx-wm-name{color:var(--ogx-txt)}
.ogx-watermark .ogx-wm-name b{color:var(--ogx-acc);font-weight:800}
.ogx-watermark .ogx-wm-sep{width:1px;height:11px;background:var(--ogx-line2)}
.ogx-watermark .ogx-wm-tgt{color:var(--ogx-red)}

#ogx-toast{position:fixed;top:44px;left:50%;transform:translateX(-50%) translateY(-8px);
  z-index:2147483400;padding:8px 15px;border-radius:12px;background:rgba(11,13,18,.92);
  border:1px solid var(--ogx-line2);color:var(--ogx-txt);font:600 12px/1 var(--ogx-mono);
  letter-spacing:.03em;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;
  box-shadow:0 10px 30px rgba(0,0,0,.5)}
#ogx-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#ogx-toast[data-tone="good"]{color:var(--ogx-good)}
#ogx-toast[data-tone="bad"]{color:var(--ogx-red)}

.ogx-panel{position:fixed;z-index:2147483500;width:460px;max-height:calc(100vh - 120px);
  display:none;flex-direction:column;background:var(--ogx-panel);color:var(--ogx-txt);
  border:1px solid var(--ogx-line2);border-radius:var(--ogx-r);overflow:hidden;
  font-family:var(--ogx-font);backdrop-filter:blur(18px) saturate(1.1);
  box-shadow:0 24px 70px rgba(0,0,0,.62),0 0 0 1px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.05);
  -webkit-user-select:none;user-select:none}
.ogx-panel.open{display:flex;animation:ogx-in .16s ease}
@keyframes ogx-in{from{opacity:0;transform:translateY(-6px) scale(.99)}to{opacity:1;transform:none}}

.ogx-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;
  cursor:grab;border-bottom:1px solid var(--ogx-line);
  background:linear-gradient(180deg,rgba(255,255,255,.03),transparent)}
.ogx-head:active{cursor:grabbing}
.ogx-brand{display:flex;align-items:center;gap:11px}
.ogx-logo{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;
  background:linear-gradient(135deg,var(--ogx-acc),var(--ogx-acc2));color:#04211f;
  font-size:15px;box-shadow:0 4px 14px rgba(58,214,200,.35)}
.ogx-title{font-weight:800;font-size:15px;letter-spacing:.2px}
.ogx-title span{color:var(--ogx-acc);font-weight:800}
.ogx-sub{font:600 10px/1 var(--ogx-mono);color:var(--ogx-dim2);letter-spacing:.14em;
  text-transform:uppercase;margin-top:2px}
.ogx-x{width:26px;height:26px;border-radius:8px;border:1px solid var(--ogx-line);
  background:transparent;color:var(--ogx-dim);cursor:pointer;font-size:12px;transition:.15s}
.ogx-x:hover{background:rgba(255,80,90,.12);color:var(--ogx-red);border-color:transparent}

.ogx-search{padding:11px 14px 6px}
.ogx-search input{width:100%;box-sizing:border-box;padding:9px 12px;border-radius:var(--ogx-r2);
  border:1px solid var(--ogx-line);background:var(--ogx-bg);color:var(--ogx-txt);
  font:500 12px var(--ogx-font);outline:none;transition:.15s}
.ogx-search input:focus{border-color:rgba(58,214,200,.55);box-shadow:0 0 0 3px rgba(58,214,200,.1)}
.ogx-search input::placeholder{color:var(--ogx-dim2)}

.ogx-body{display:flex;gap:0;min-height:0;flex:1}
.ogx-rail{display:flex;flex-direction:column;gap:2px;padding:8px;width:126px;flex:none;
  border-right:1px solid var(--ogx-line)}
.ogx-tab{display:flex;align-items:center;gap:9px;padding:9px 10px;border:0;border-radius:10px;
  background:transparent;color:var(--ogx-dim);font:600 12.5px var(--ogx-font);cursor:pointer;
  text-align:left;transition:.13s;width:100%}
.ogx-tab .ogx-ic{font-size:13px;opacity:.85;width:14px;text-align:center}
.ogx-tab:hover{background:rgba(255,255,255,.04);color:var(--ogx-txt)}
.ogx-tab.on{background:linear-gradient(90deg,rgba(58,214,200,.16),rgba(58,214,200,.03));
  color:#eafffb;box-shadow:inset 2px 0 0 var(--ogx-acc)}

.ogx-content{flex:1;min-width:0;padding:10px 14px 14px;overflow-y:auto;overflow-x:hidden}
.ogx-content::-webkit-scrollbar{width:9px}
.ogx-content::-webkit-scrollbar-thumb{background:rgba(255,255,255,.09);border-radius:9px;
  border:3px solid transparent;background-clip:padding-box}
.ogx-content::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.16);background-clip:padding-box}

.ogx-row{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:9px 4px;border-bottom:1px solid var(--ogx-line)}
.ogx-row:last-child{border-bottom:0}
.ogx-label{display:flex;flex-direction:column;gap:2px;min-width:0}
.ogx-lname{font-weight:600;font-size:12.5px;color:var(--ogx-txt)}
.ogx-hint{font:500 10.5px var(--ogx-mono);color:var(--ogx-dim2);letter-spacing:.01em}

.ogx-switch{position:relative;width:38px;height:22px;border-radius:999px;flex:none;
  background:var(--ogx-bg);border:1px solid var(--ogx-line2);cursor:pointer;transition:.18s}
.ogx-switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--ogx-dim);transition:.18s}
.ogx-switch.on{background:linear-gradient(135deg,var(--ogx-acc),var(--ogx-acc2));border-color:transparent;
  box-shadow:0 2px 10px rgba(58,214,200,.4)}
.ogx-switch.on i{left:18px;background:#04211f}

.ogx-seg{display:flex;gap:3px;padding:3px;border-radius:10px;background:var(--ogx-bg);
  border:1px solid var(--ogx-line);flex:none}
.ogx-segopt{border:0;background:transparent;color:var(--ogx-dim);cursor:pointer;
  padding:5px 10px;border-radius:7px;font:600 11px var(--ogx-font);transition:.13s}
.ogx-segopt:hover{color:var(--ogx-txt)}
.ogx-segopt.on{background:rgba(58,214,200,.16);color:#eafffb;box-shadow:inset 0 0 0 1px rgba(58,214,200,.4)}

.ogx-slider{display:flex;align-items:center;gap:10px;width:186px;flex:none}
.ogx-track{position:relative;flex:1;height:5px;border-radius:999px;background:var(--ogx-bg);
  border:1px solid var(--ogx-line);cursor:pointer}
.ogx-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;
  background:linear-gradient(90deg,var(--ogx-acc2),var(--ogx-acc))}
.ogx-thumb{position:absolute;top:50%;width:14px;height:14px;border-radius:50%;
  transform:translate(-50%,-50%);background:#eafffb;border:2px solid var(--ogx-acc);
  box-shadow:0 2px 8px rgba(0,0,0,.45);pointer-events:none}
.ogx-val{width:44px;text-align:right;font:700 11px var(--ogx-mono);color:var(--ogx-acc)}

.ogx-key{min-width:64px;padding:6px 12px;border-radius:9px;border:1px solid var(--ogx-line2);
  background:var(--ogx-bg);color:var(--ogx-txt);font:700 11px var(--ogx-mono);cursor:pointer;
  letter-spacing:.05em;transition:.14s}
.ogx-key:hover{border-color:rgba(58,214,200,.5);color:var(--ogx-acc)}
.ogx-key.capturing{border-color:var(--ogx-acc);color:var(--ogx-acc);
  box-shadow:0 0 0 3px rgba(58,214,200,.14);animation:ogx-pulse 1s infinite}
@keyframes ogx-pulse{50%{opacity:.6}}

.ogx-sechead{margin:14px 4px 4px;font:700 10px var(--ogx-mono);letter-spacing:.16em;
  text-transform:uppercase;color:var(--ogx-dim2)}
.ogx-note{margin:8px 2px 4px;padding:10px 12px;border-radius:var(--ogx-r2);
  background:rgba(58,214,200,.06);border:1px solid rgba(58,214,200,.16);
  font:500 11px/1.55 var(--ogx-font);color:var(--ogx-dim)}
.ogx-empty{padding:26px 8px;text-align:center;color:var(--ogx-dim2);font:500 12px var(--ogx-font)}

.ogx-presets{display:flex;gap:8px;margin:2px 2px 6px}
.ogx-preset{flex:1;padding:10px;border-radius:var(--ogx-r2);cursor:pointer;
  font:700 11.5px var(--ogx-font);letter-spacing:.02em;transition:.14s;
  border:1px solid var(--ogx-line2);background:var(--ogx-bg);color:var(--ogx-txt)}
.ogx-preset:hover{border-color:rgba(58,214,200,.5);color:var(--ogx-acc);
  background:rgba(58,214,200,.06)}

.ogx-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:9px 14px;border-top:1px solid var(--ogx-line);
  background:linear-gradient(0deg,rgba(255,255,255,.02),transparent)}
.ogx-stat{font:600 10.5px var(--ogx-mono);color:var(--ogx-dim2);letter-spacing:.04em}
.ogx-stat b{color:var(--ogx-txt)}
.ogx-chips{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.ogx-chips i{font:800 9px var(--ogx-mono);letter-spacing:.08em;padding:3px 6px;border-radius:6px;
  background:rgba(58,214,200,.14);color:var(--ogx-acc);font-style:normal}
.ogx-chips i.off{background:rgba(255,255,255,.05);color:var(--ogx-dim2)}
`;
    const style = document.createElement('style');
    style.id = 'ogx-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ── Go ─────────────────────────────────────────────────────────────────── */

  boot();
})();
