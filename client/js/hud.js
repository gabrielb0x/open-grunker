/**
 * Open Grunker — heads-up display.
 *
 * Pure DOM/canvas on top of the WebGL view: crosshair, health, ammo, killfeed,
 * live standings, score popups, scoreboards, chat, minimap, damage numbers,
 * objective strips and the end-of-match card.
 *
 * Nothing here ever tells the player something the world would not: nametags,
 * minimap blips and objective markers are all gated on the same visibility test
 * the renderer uses.
 */
import * as THREE from 'three';
import * as K from '/shared/constants.js';
import { WEAPON_LABEL } from '/shared/weapons.js';
import { settings } from './settings.js';
import { bindingLabel, padLabel } from './keybinds.js';
// Only for the strings this file *assembles*. Everything it writes as a plain
// sentence is translated where it lands, by the pass in i18n.js.
import { t, tf } from './i18n.js';
import { sfx } from './audio.js';

const $ = (id) => document.getElementById(id);

/** Thin-spaced thousands, so a four-figure reward reads as one. */
const fmtNum = (n) => Number(n ?? 0).toLocaleString('en-GB').replace(/,/g, '\u202f');

/** Shortest gap between two minimap redraws — see `drawMinimap`. */
const MINIMAP_INTERVAL = 1 / 60 - 0.0008;

/** A tiny glyph per weapon family for the killfeed — drawn, not fetched. */
const WEAPON_GLYPH = {
  ar: 'M2 9h13l2-3h3v3h2v3h-4l-2 3H8l-1-3H2z',
  lmg: 'M2 9h14l2-3h4v3h2v4h-5l-2 3H8l-1-3H2z',
  smg: 'M3 9h11l2-3h4v3h1v3h-4l-1 3H8l-1-3H3z',
  dmr: 'M2 10h16l3-4h3v3h-3l-2 3h-5l-2 3H6l-1-3H2z',
  sniper: 'M1 10h18l4-4v3h-3l-3 3h-5l-2 3H5l-1-3H1z',
  shotgun: 'M2 9h18v3H8l-1 3H4l-1-3H2z',
  revolver: 'M6 9h9l3-2v3h2v3h-5l-1 3H8l-1-3H6z',
  akimbo: 'M3 8h7v3H6l-1 2H3zM13 12h7v3h-4l-1 2h-2z',
  rpg: 'M2 10h16l4-2v5l-4-1H8l-2 3H3z',
  pistol: 'M6 9h9v3h-3l-1 3H8l-1-3H6z',
  knife: 'M3 16 15 4l3 3L7 19z',
  fall: 'M12 3v14l5-5m-10 0 5 5',
  void: 'M12 3a9 9 0 100 18 9 9 0 000-18z',
  // A mushroom cloud: cap, stem, and the dust ring at the bottom.
  nuke: 'M7 7a5 5 0 0110 0 3 3 0 01-1 5h-8a3 3 0 01-1-5zM10 12h4l1 5h-6zM4 19h16v2H4z',
};

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), crosshair: $('crosshair'), hitmarker: $('hitmarker'),
      hpFill: $('hpFill'), hpGhost: $('hpGhost'), hpNum: $('hpNum'),
      ammoMag: $('ammoMag'), ammoReserve: $('ammoReserve'),
      ammoWrap: document.querySelector('#bottomRight .ammo'), weaponName: $('weaponName'),
      reloadHint: $('reloadHint'), reloadFill: $('reloadFill'),
      killfeed: $('killfeed'), chatLog: $('chatLog'), chatPanel: $('chatPanel'),
      chatForm: $('chatForm'), chatInput: $('chatInput'), scoreboard: $('scoreboard'),
      chatHint: $('chatHint'), hudRight: $('hudRight'),
      sbRows: $('sbRows'), sbTitle: $('sbTitle'), sbMap: $('sbMap'), sbHint: $('sbHint'),
      sbModHead: $('sbModHead'), sbReportHead: $('sbReportHead'),
      sbAdmin: $('sbAdmin'), sbGod: $('sbGod'), godBadge: $('godBadge'),
      afkNotice: $('afkNotice'), afkNoticeText: $('afkNoticeText'),
      matchClock: $('matchClock'), matchMode: $('matchMode'), matchBar: $('matchBar'),
      scoreRed: $('scoreRed'), scoreBlue: $('scoreBlue'), objStrip: $('objStrip'),
      deathScreen: $('deathScreen'), deathKiller: $('deathKiller'), deathWeapon: $('deathWeapon'),
      deathKillerHp: $('deathKillerHp'),
      respawnIn: $('respawnIn'), floaters: $('floaters'), dirIndicators: $('dirIndicators'),
      damageFlash: $('damageFlash'), lowHealth: $('lowHealth'), scopeOverlay: $('scopeOverlay'),
      minimap: $('minimap'), minimapName: $('minimapName'), mapWrap: $('mapWrap'),
      perf: $('perf'), fps: $('fps'), ping: $('ping'), accuracy: $('accuracy'), toast: $('toast'),
      streak: $('streakBanner'), pointsFeed: $('pointsFeed'),
      liveScore: $('liveScore'), lsRows: $('lsRows'), lsMine: $('lsMine'), lsLabel: $('lsLabel'),
      matchEnd: $('matchEnd'), meWinner: $('meWinner'), meSub: $('meSub'), meRows: $('meRows'),
      meRewards: $('meRewards'), meNext: $('meNext'), meMvp: $('meMvp'), meGuest: $('meGuest'),
      meVote: $('meVote'), meVoteOptions: $('meVoteOptions'),
      ggStrip: $('ggStrip'), ggWeapon: $('ggWeapon'), ggRung: $('ggRung'),
      ggFill: $('ggFill'), ggNext: $('ggNext'),
      speedo: $('speedo'), speedVal: $('speedVal'), speedBar: $('speedBar'),
      playerNameTag: $('playerNameTag'), playerVerified: $('playerVerified'),
      playerLevel: $('playerLevel'), hintRespawn: $('hintRespawn'), hintClass: $('hintClass'),
      hintClass2: $('hintClass2'), deathHint: $('deathHint'), deathHintHeld: $('deathHintHeld'),
      killCam: $('killCam'), kcName: $('kcName'), kcTags: $('kcTags'), kcFacts: $('kcFacts'),
      kcAnthem: $('kcAnthem'), kcTrack: $('kcTrack'), kcTrackBy: $('kcTrackBy'),
      kcRemaining: $('kcRemaining'), kcSkip: $('kcSkip'), kcSkipFill: $('kcSkipFill'),
      kcSkipLabel: $('kcSkipLabel'), kcDirector: $('kcDirector'),
      kcEyebrow: $('kcEyebrow'), kcReplay: $('kcReplay'), kcReplayLabel: $('kcReplayLabel'),
      kcReplayFill: $('kcReplayFill'), kcReplayTime: $('kcReplayTime'),
      devOverlay: $('devOverlay'),
      nukePrompt: $('nukePrompt'), nukeKey: $('nukeKey'), nukeWarning: $('nukeWarning'),
      nukeBy: $('nukeBy'), nukeCount: $('nukeCount'), nukeSub: $('nukeSub'), nukeFlash: $('nukeFlash'),
      specBar: $('specBar'), specViewLabel: $('specViewLabel'), specXrayLabel: $('specXrayLabel'),
      slots: [...document.querySelectorAll('.slots .slot')],
    };

    this.mmCtx = this.el.minimap.getContext('2d');
    /** Name buttons rather than keys in every hint — set once a pad is in use. */
    this.padHints = false;
    /**
     * The last value written to each DOM property this class touches.
     *
     * `update()` runs on every frame and used to perform about thirty writes
     * on every one of them — a `style.width`, a `textContent`, a dozen
     * `classList.toggle`s — whether or not anything had changed. Every one of
     * those invalidates style for the element it touches, and at 240 Hz that is
     * seven thousand pointless invalidations a second sitting in front of the
     * renderer. Nothing below writes a value the DOM already holds.
     */
    this._dom = Object.create(null);
    this.projected = new THREE.Vector3();
    this.hitmarkerTimer = 0;
    this.scoreboardOpen = false;
    this.matchEndOpen = false;
    /**
     * Whether the kill cam's overlay is up.
     *
     * Read every frame while dead — it is what tells main.js that the cam ended
     * itself and the plain death screen has to take over — so it starts as a
     * real boolean rather than as `undefined` that happens to be falsy.
     */
    this.killCamOpen = false;
    this.fpsSamples = [];
    this.lastFpsUpdate = 0;
    this.lastLiveKey = '';
    this.lastObjKey = '';
    this.ghostHealth = 100;
    this.mode = 'ffa';
    this.practice = false;
    this.voteState = null;
    this.myVote = null;
    /** Set by the game layer: called when the player picks a map to vote for. */
    this.onVote = null;
    /** Chat standing, as the server last described it. */
    this.chatCanSend = false;
    this.chatReason = 'connecting…';
    /** Staff only: moderation buttons on the scoreboard, and who to tell. */
    this.myRole = 'player';
    this.modTools = false;
    this.onModAction = null;
    /** Admins only: the god-mode switch on the scoreboard, and who to tell. */
    this.adminTools = false;
    this.godMode = false;
    this.onGodMode = null;
    /** Anyone signed in: the report button on the scoreboard, and who to tell. */
    this.reportTool = false;
    this.onReport = null;
    /**
     * Whether this player may file right now, and the server's own sentence for
     * why not. A refusal greys the button rather than hiding it: a button that
     * disappears teaches nobody what to do about it.
     */
    this.canReport = false;
    this.reportReason = null;
    /** Which row the report card is currently asking about, if any. */
    this.reportTarget = null;
    /**
     * The last board actually drawn, and whether a click is in flight over it.
     *
     * The game layer asks for a scoreboard render every frame while the board
     * is open. Rebuilding the rows on each of those frames replaced every
     * button between a press and its release — so the click event never landed
     * on anything, and REPORT and the mute buttons did nothing at all. The key
     * skips the work when nothing has changed, and the hold covers the rest:
     * a score arriving mid-press must not pull the button out from under it.
     */
    this.lastBoardKey = '';
    this.sbHolding = false;
    /** When the minimap last redrew, in the game's seconds clock. */
    this.mmDrawnAt = -1;
    /**
     * Whose HUD this is.
     *
     * `null` while playing — the numbers are the local player's own. A
     * spectator sets it to the name of whoever the camera is on, which is what
     * turns the readouts into *their* health, *their* weapon, *their* class,
     * drawn in the same places they always were rather than in a second HUD
     * built specially for watching.
     */
    this.watching = null;
    /** Nuke: `armed` is ours to press, `countdown` is anybody's in the air. */
    this.nukeArmed = false;
    this.nukeUntil = 0;
    this.nukeFlashUntil = 0;
    this.bindScoreboard();
    this.bindAdminTools();
    this.bindReportCard();
    this.applySettings();
    this.refreshHints();
  }

  /* ── Change-gated DOM writes ───────────────────────────────────────────── */

  /** Text, written only when it differs from what is already on screen. */
  _text(el, key, value) {
    if (!el || this._dom[key] === value) return;
    this._dom[key] = value;
    el.textContent = value;
  }

  /** One inline style property, same rule. */
  _style(el, key, prop, value) {
    if (!el || this._dom[key] === value) return;
    this._dom[key] = value;
    el.style[prop] = value;
  }

  /** A custom property (`--gap`), same rule. */
  _var(el, key, prop, value) {
    if (!el || this._dom[key] === value) return;
    this._dom[key] = value;
    el.style.setProperty(prop, value);
  }

  /** A class, added or removed only on the frame it actually flips. */
  _toggle(el, key, name, on) {
    const v = !!on;
    if (!el || this._dom[key] === v) return;
    this._dom[key] = v;
    el.classList.toggle(name, v);
  }

  /** The whole className, for the elements that swap between a few states. */
  _className(el, key, value) {
    if (!el || this._dom[key] === value) return;
    this._dom[key] = value;
    el.className = value;
  }

  /**
   * Forgets every cached value.
   *
   * Anything that rewrites the HUD behind this class's back — a settings pass
   * that sets the same properties, a rebuilt element — has to invalidate, or
   * the next `update()` will decide the screen already says what it wants.
   */
  invalidateDom() { this._dom = Object.create(null); }

  show() { this.el.hud.classList.remove('hidden'); }
  hide() { this.el.hud.classList.add('hidden'); }

  applySettings() {
    // The panel writes some of the properties `update()` caches — the crosshair
    // gap most obviously. A cache that survived a settings change would decide
    // the screen already says what it wants and never write the new value.
    this.invalidateDom();
    const c = this.el.crosshair.style;
    c.setProperty('--col', settings.crosshairColor);
    c.setProperty('--len', `${settings.crosshairSize}px`);
    c.setProperty('--gap', `${settings.crosshairGap}px`);
    c.setProperty('--thick', `${settings.crosshairThickness}px`);
    this.el.crosshair.classList.toggle('outlined', !!settings.crosshairOutline);
    this.el.crosshair.querySelector('.ch-dot').style.display = settings.crosshairDot ? 'block' : 'none';
    this.el.mapWrap.classList.toggle('hidden', !settings.showMinimap);
    this.el.perf.classList.toggle('hidden', !settings.showFps);
    this.el.liveScore.classList.toggle('hidden', !settings.showLiveScore);
    this.el.killfeed.classList.toggle('hidden', !settings.showKillfeed);
    this.el.pointsFeed.classList.toggle('hidden', !settings.showPointsFeed);
    this.el.speedo.classList.toggle('hidden', !settings.showSpeed);
    this.el.hud.style.setProperty('--hud-scale', String(settings.hudScale ?? 1));
    $('grade')?.classList.toggle('on', !!settings.vignette);
  }

  /** Key hints follow the player's own bindings. */
  /**
   * Draw hints for a controller instead of a keyboard.
   *
   * The hints on the death screen and under the chat name a key — "press SPACE
   * to respawn" — which is exactly the wrong sentence in front of somebody
   * holding a pad. One flag, and every hint below asks the right table.
   */
  setPadHints(on) {
    const v = !!on;
    if (this.padHints === v) return;
    this.padHints = v;
    this.refreshHints();
  }

  /** The key or button to name for an action, given what is in the player's hands. */
  hintFor(action) {
    if (this.padHints) {
      const pad = padLabel(action);
      if (pad && pad !== '—') return pad;
    }
    return bindingLabel(action).split(' / ')[0];
  }

  refreshHints() {
    if (this.el.hintRespawn) this.el.hintRespawn.textContent = this.hintFor('jump');
    if (this.el.hintClass) this.el.hintClass.textContent = this.hintFor('classMenu');
    if (this.el.hintClass2) this.el.hintClass2.textContent = this.hintFor('classMenu');
    if (this.el.nukeKey) this.el.nukeKey.textContent = this.hintFor('nuke');
    this.setChatState({ canSend: this.chatCanSend, reason: this.chatReason });
    if (this.el.sbHint) {
      // The board is pinned open rather than held — every nickname on it opens a
      // profile, on top of the mute and report columns — so the hint names the
      // way out of it rather than telling the player to keep holding a key.
      this.el.sbHint.textContent = tf('{key} to close', { key: this.hintFor('scoreboard') });
    }
  }

  setMap(map) {
    this.map = map;
    this.mmBaseScale = 240 / (map.size ?? 100);
    this.mmLayer = null;                       // the new map has its own walls
    if (this.el.minimapName) this.el.minimapName.textContent = map.name ?? '';
  }

  /**
   * The map's walls, drawn once into an offscreen canvas.
   *
   * The minimap used to walk the level's whole box list every frame — a dressed
   * town is well over a thousand of them, so that was a thousand `fillRect`
   * calls per frame for a picture that only ever rotates and slides. None of
   * those rectangles moves, so the whole layer is rendered once per map (and
   * again if the zoom changes, which is a slider, not a frame) and afterwards
   * costs exactly one `drawImage`.
   *
   * The layer lives in the same rotated, scaled space the live blips are drawn
   * in, so nothing about the projection changed: `minX`/`minZ` are where its
   * top-left corner sits in world units.
   */
  minimapLayer(s) {
    if (this.mmLayer && this.mmLayer.map === this.map && this.mmLayer.s === s) return this.mmLayer;
    // Foliage collides now, but a tree is a canopy over your head, not a wall
    // you walk around: drawing one on a top-down map reads as a building.
    const boxes = (this.map?.boxes ?? []).filter((b) =>
      !b.decor && !b.clip && b.h >= 0.8 && b.mat !== K.SURFACE.FOLIAGE);
    if (!boxes.length) { this.mmLayer = { map: this.map, s, canvas: null }; return this.mmLayer; }

    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const b of boxes) {
      if (b.x - b.w / 2 < minX) minX = b.x - b.w / 2;
      if (b.z - b.d / 2 < minZ) minZ = b.z - b.d / 2;
      if (b.x + b.w / 2 > maxX) maxX = b.x + b.w / 2;
      if (b.z + b.d / 2 > maxZ) maxZ = b.z + b.d / 2;
    }

    // A ceiling on the bitmap, so a hand-authored level with a stray box a
    // kilometre out cannot ask for a gigabyte of canvas.
    const MAX_PX = 2400;
    const w = Math.min(MAX_PX, Math.ceil((maxX - minX) * s) + 2);
    const h = Math.min(MAX_PX, Math.ceil((maxZ - minZ) * s) + 2);
    if (w < 2 || h < 2) { this.mmLayer = { map: this.map, s, canvas: null }; return this.mmLayer; }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    for (const b of boxes) {
      // Roofs and tall walls read brighter; low cover stays quiet.
      g.fillStyle = b.h > 3.2 ? 'rgba(168,186,210,.44)' : 'rgba(126,146,176,.24)';
      g.fillRect((b.x - b.w / 2 - minX) * s, (b.z - b.d / 2 - minZ) * s, b.w * s, b.d * s);
    }
    this.mmLayer = { map: this.map, s, canvas, minX, minZ };
    return this.mmLayer;
  }

  setMode(modeId, modeName, practice = false) {
    this.mode = modeId ?? 'ffa';
    this.practice = !!practice;
    this.el.matchMode.textContent = (modeName ?? '').toUpperCase();
    this.el.matchBar.classList.toggle('ffa', !(K.MODES[this.mode]?.teams));
    this.el.matchBar.classList.toggle('practice', this.practice);
    this.el.lsLabel.textContent = this.mode === 'gg' ? 'RUNG' : 'SCORE';
    this.el.accuracy.classList.toggle('hidden', !this.practice);
  }

  /* ── Per-frame ─────────────────────────────────────────────────────────── */

  update(state, dt) {
    const { health, ammo, reserve, weapon, slot, reloading, reloadFrac, spread, scoped,
      matchTime, teamScore, teamMode, ping, name, level, verified, speed, accuracy,
      hideCrosshair = false, hasBody = true, godMode = false } = state;

    // Health, with a ghost bar that drains behind the real one after a hit.
    const pct = Math.max(0, Math.min(100, health));
    this._style(this.el.hpFill, 'hp.w', 'width', `${pct}%`);
    this._className(this.el.hpFill, 'hp.cls', pct <= 25 ? 'crit' : pct <= 55 ? 'low' : '');
    this._text(this.el.hpNum, 'hp.num', hasBody ? Math.ceil(pct) : '\u2014');
    if (pct > this.ghostHealth) this.ghostHealth = pct;
    else this.ghostHealth += (pct - this.ghostHealth) * Math.min(1, dt * 3.2);
    // The ghost drains continuously, so it is quantised: a bar 280px wide has
    // no more than 280 distinct widths, and writing four decimals of a percent
    // sixty times a second only ever repainted the same pixels.
    this._style(this.el.hpGhost, 'hp.ghost', 'width', `${Math.max(pct, this.ghostHealth).toFixed(1)}%`);
    /*
     * The red edges of nearly dying — and only of nearly dying.
     *
     * `hasBody` is false for a spectator whose camera has nobody to sit on:
     * between matches, or with everybody down at once. There is no health to
     * read there, and reading the zero it defaults to used to paint the whole
     * screen red for a watcher who was not in any danger because they were not
     * in the match.
     */
    this._style(this.el.lowHealth, 'hp.low', 'opacity',
      hasBody && pct <= 35 ? Math.min(0.85, (35 - pct) / 30).toFixed(2) : '0');

    // Ammo — reserves are unlimited, so the second number is a symbol. So is the
    // magazine for a blade, and for an admin in god mode, whose rounds the room
    // stops counting. `godMode` comes off the payload rather than the flag the
    // badge uses, because a watcher is reading somebody else's magazine.
    const endlessMag = !!weapon?.melee || godMode;
    this._text(this.el.ammoMag, 'ammo.mag', endlessMag ? '∞' : ammo);
    this._text(this.el.ammoReserve, 'ammo.res', weapon?.melee ? '' : (reserve < 0 ? '∞' : reserve));
    this._toggle(this.el.ammoWrap, 'ammo.low', 'low', !endlessMag && ammo <= (weapon?.magSize ?? 30) * 0.25);
    this._toggle(this.el.ammoWrap, 'ammo.empty', 'empty', !endlessMag && ammo === 0);
    this._text(this.el.weaponName, 'weapon.name',
      WEAPON_LABEL[weapon?.id] ?? (weapon?.name ?? '').toUpperCase());
    // `on` rather than `hidden`: the row keeps its place in the panel whether it
    // is drawn or not, so a reload cannot resize the box around it.
    this._toggle(this.el.reloadHint, 'reload.on', 'on', !!reloading);
    this._style(this.el.reloadFill, 'reload.w', 'width',
      reloading ? `${Math.round((reloadFrac ?? 0) * 100)}%` : '0%');
    if (this._dom['slot.active'] !== slot) {
      this._dom['slot.active'] = slot;
      for (const s of this.el.slots) s.classList.toggle('active', Number(s.dataset.slot) === slot);
    }

    // With no body under the camera the panel says why rather than drawing a
    // level-1 nobody on zero health.
    this._text(this.el.playerNameTag, 'me.name', hasBody ? (name ?? 'Guest') : 'NOBODY ALIVE');
    this._toggle(this.el.playerVerified, 'me.verified', 'hidden', !verified || !hasBody);
    this._text(this.el.playerLevel, 'me.level', hasBody ? `LVL ${level ?? 1}` : '');

    // Speedometer, for anyone learning the movement.
    if (settings.showSpeed) {
      const s = Math.round(speed ?? 0);
      this._text(this.el.speedVal, 'speed.val', s);
      this._style(this.el.speedBar, 'speed.w', 'width', `${Math.min(100, (s / 26) * 100).toFixed(1)}%`);
      this._toggle(this.el.speedo, 'speed.fast', 'fast', s > K.BASE_SPEED * 1.35);
    }

    // Crosshair spread
    if (settings.crosshairDynamic) {
      const px = Math.min(60, settings.crosshairGap + (spread ?? 0) * 900);
      this._var(this.el.crosshair, 'ch.gap', '--gap', `${px.toFixed(1)}px`);
    }
    // A scope hides the crosshair *and* draws its own optic over the screen;
    // `hideCrosshair` is the half of that a chase camera wants on its own,
    // where there is a view but nobody's point of aim in the middle of it.
    this._style(this.el.crosshair, 'ch.op', 'opacity', (scoped || hideCrosshair) ? '0' : '1');
    this._toggle(this.el.scopeOverlay, 'scope.on', 'on', !!scoped);

    // Match clock
    if (this.practice) {
      this._text(this.el.matchClock, 'clock.text', '∞');
      this._toggle(this.el.matchClock, 'clock.urgent', 'urgent', false);
    } else if (matchTime >= 0) {
      const m = Math.floor(matchTime / 60), s = Math.floor(matchTime % 60);
      this._text(this.el.matchClock, 'clock.text', `${m}:${String(s).padStart(2, '0')}`);
      this._toggle(this.el.matchClock, 'clock.urgent', 'urgent', matchTime <= 30);
    } else {
      this._text(this.el.matchClock, 'clock.text', '--:--');
      this._toggle(this.el.matchClock, 'clock.urgent', 'urgent', false);
    }
    if (teamMode && teamScore) {
      this._text(this.el.scoreRed, 'score.red', teamScore.red);
      this._text(this.el.scoreBlue, 'score.blue', teamScore.blue);
    }

    // Perf
    if (settings.showFps) {
      this.fpsSamples.push(dt);
      if (this.fpsSamples.length > 40) this.fpsSamples.shift();
      const nowMs = performance.now();
      if (nowMs - this.lastFpsUpdate > 320) {
        this.lastFpsUpdate = nowMs;
        let total = 0;
        for (const v of this.fpsSamples) total += v;
        const fps = Math.round(1 / Math.max(1e-4, total / this.fpsSamples.length));
        this._text(this.el.fps, 'perf.fps', `${fps} FPS`);
        this._className(this.el.fps, 'perf.fpsCls', fps < 40 ? 'bad' : fps < 55 ? 'warn' : '');
        const p = Math.round(ping ?? 0);
        this._text(this.el.ping, 'perf.ping', `${p} ms`);
        this._className(this.el.ping, 'perf.pingCls', p > 140 ? 'bad' : p > 70 ? 'warn' : '');
        if (this.practice) this._text(this.el.accuracy, 'perf.acc', `${accuracy ?? 0}% acc`);
      }
    }

    if (this.hitmarkerTimer > 0) this.hitmarkerTimer -= dt;
  }

  /* ── Objectives & Gun Game ─────────────────────────────────────────────── */

  setObjectives(points = []) {
    const show = points.length > 0;
    this.el.objStrip.classList.toggle('hidden', !show);
    if (!show) return;
    const key = points.map((p) => `${p.id}${p.owner}${Math.round((p.progress ?? 0) * 10)}${p.contested ? 'c' : ''}`).join('|');
    if (key === this.lastObjKey) return;
    this.lastObjKey = key;
    this.el.objStrip.innerHTML = points.map((p) => {
      const team = p.owner === K.TEAM.RED ? 'red' : p.owner === K.TEAM.BLUE ? 'blue' : 'none';
      const cap = p.contender && p.contender !== p.owner ? Math.round((p.progress ?? 0) * 100) : 0;
      const capTeam = p.contender === K.TEAM.RED ? 'red' : p.contender === K.TEAM.BLUE ? 'blue' : '';
      return `<div class="obj ${team}${p.contested ? ' contested' : ''}">
        <b>${escapeHtml(p.id)}</b>
        <i class="obj-cap ${capTeam}" style="width:${cap}%"></i>
      </div>`;
    }).join('');
  }

  setGunGame(gg) {
    this.el.ggStrip.classList.toggle('hidden', !gg);
    if (!gg) return;
    const total = gg.total ?? (gg.ladder?.length ?? 9);
    const rung = (gg.rung ?? 0) + 1;
    const need = gg.need ?? K.GUN_GAME_KILLS_PER_RUNG;
    const kills = gg.kills ?? 0;
    this.el.ggWeapon.textContent = (gg.classId ?? '').toUpperCase().replace(/_/g, ' ') || 'LADDER';
    this.el.ggRung.textContent = `${rung} / ${total}`;
    this.el.ggFill.style.width = `${((rung - 1) / total) * 100}%`;
    this.el.ggNext.textContent = tf('{done} / {need} kills to promote', { done: kills, need });
  }

  /* ── Map voting ────────────────────────────────────────────────────────── */

  setVote(vote) {
    this.voteState = vote;
    const show = !!vote?.options?.length;
    this.el.meVote.classList.toggle('hidden', !show);
    if (!show) { this.myVote = null; return; }
    this.el.meVoteOptions.innerHTML = vote.options.map((o) => `
      <button class="mv-opt${this.myVote === o.id ? ' picked' : ''}" data-map="${escapeHtml(o.id)}">
        <span class="mv-name">${escapeHtml(o.name)}</span>
        <span class="mv-count">${vote.tally?.[o.id] ?? 0}</span>
      </button>`).join('');
    for (const btn of this.el.meVoteOptions.querySelectorAll('.mv-opt')) {
      btn.addEventListener('click', () => {
        this.myVote = btn.dataset.map;
        sfx.ui('ok');
        this.onVote?.(btn.dataset.map);
        for (const b of this.el.meVoteOptions.querySelectorAll('.mv-opt')) {
          b.classList.toggle('picked', b === btn);
        }
      });
    }
  }

  /* ── Live standings ────────────────────────────────────────────────────── */

  /** Top-right board: nickname + score, with your own row always included. */
  renderLiveScore(rows, myId, teamMode) {
    if (!settings.showLiveScore || !rows?.length) return;
    const gg = this.mode === 'gg';
    const sorted = [...rows].sort((a, b) => (gg ? (b.rung ?? 0) - (a.rung ?? 0) : 0)
      || b.score - a.score || b.kills - a.kills);
    const top = sorted.slice(0, 5);
    const meIndex = sorted.findIndex((r) => r.id === myId);
    if (meIndex >= 5) top.push(sorted[meIndex]);

    const key = top.map((r) => `${r.id}:${r.score}:${r.rung ?? 0}`).join('|') + (meIndex + 1);
    if (key === this.lastLiveKey) return;
    this.lastLiveKey = key;

    const mine = meIndex >= 0 ? sorted[meIndex] : null;
    this.el.lsMine.textContent = gg ? ((mine?.rung ?? 0) + 1) : (mine?.score ?? 0);
    this.el.lsRows.innerHTML = top.map((r) => {
      const place = sorted.indexOf(r) + 1;
      const team = teamMode ? (r.team === K.TEAM.RED ? ' red' : ' blue') : '';
      const value = gg ? (r.rung ?? 0) + 1 : r.score;
      return `<li class="${r.id === myId ? 'me' : ''}${team}">
        <span class="ls-rank">${place}</span>
        <span class="ls-name">${playerName(r, 11, { role: false })}</span>
        <span class="ls-pts">${value}</span></li>`;
    }).join('');
  }

  /** "+50 HEADSHOT" stack, one line per event. */
  pointsPopup({ events = [], total = 0, victim = null }) {
    if (!settings.showPointsFeed || !events.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'pts-group';
    wrap.innerHTML = events.map((e, i) => `
      <div class="pts-row${e.points < 0 ? ' bad' : ''}${i === 0 ? ' first' : ''}">
        <b>${e.points > 0 ? '+' : ''}${e.points}</b><span>${escapeHtml(e.label)}</span>
      </div>`).join('')
      + (victim ? `<div class="pts-victim">${escapeHtml(victim)}</div>` : '')
      + (events.length > 1 ? `<div class="pts-total">${total > 0 ? '+' : ''}${total}</div>` : '');
    this.el.pointsFeed.appendChild(wrap);
    while (this.el.pointsFeed.children.length > 4) this.el.pointsFeed.firstChild.remove();
    setTimeout(() => { wrap.classList.add('fade'); setTimeout(() => wrap.remove(), 500); }, 1900);
  }

  /* ── Feedback ──────────────────────────────────────────────────────────── */

  hitmarker(kill = false, head = false) {
    const el = this.el.hitmarker;
    el.classList.remove('show', 'kill', 'head');
    void el.offsetWidth;                     // restart the animation
    if (kill) el.classList.add('kill');
    else if (head) el.classList.add('head');
    el.classList.add('show');
  }

  lowHealthPulse() {
    this.el.lowHealth.classList.remove('pulse');
    void this.el.lowHealth.offsetWidth;
    this.el.lowHealth.classList.add('pulse');
  }

  /** Floating damage number anchored to a world position. */
  damageNumber(worldPos, amount, camera, kind = '') {
    if (!settings.showDamageNumbers) return;
    this.projected.set(worldPos.x, worldPos.y, worldPos.z).project(camera);
    if (this.projected.z > 1) return;
    const x = (this.projected.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this.projected.y * 0.5 + 0.5) * window.innerHeight;

    const el = document.createElement('div');
    el.className = `floater ${kind}`;
    el.textContent = kind === 'kill' ? 'ELIMINATED' : Math.round(amount);
    el.style.left = `${x + (Math.random() * 26 - 13)}px`;
    el.style.top = `${y}px`;
    this.el.floaters.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  /** Red vignette + an arrow pointing at whoever shot you. */
  tookDamage(fromWorld, myPos, myYaw, amount) {
    this.el.damageFlash.classList.add('on');
    setTimeout(() => this.el.damageFlash.classList.remove('on'), 60);

    if (!fromWorld) return;
    const dx = fromWorld.x - myPos.x, dz = fromWorld.z - myPos.z;
    if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) return;
    const angle = Math.atan2(dx, -dz) - myYaw;

    const ind = document.createElement('i');
    ind.className = 'dir-ind';
    ind.style.transform = `translate(-50%, -130px) rotate(${angle}rad)`;
    ind.style.opacity = String(Math.min(1, 0.45 + amount / 70));
    this.el.dirIndicators.appendChild(ind);
    requestAnimationFrame(() => { ind.style.opacity = '0'; });
    setTimeout(() => ind.remove(), 700);
  }

  killfeedEntry({ killer, victim, weapon, head, streak }, myId) {
    if (!settings.showKillfeed) return;
    const row = document.createElement('div');
    const mine = killer?.id === myId;
    row.className = `kf-row${mine ? ' mine' : ''}${victim.id === myId ? ' victimMe' : ''}`;

    const teamClass = (t) => (t === K.TEAM.RED ? 'red' : t === K.TEAM.BLUE ? 'blue' : '');
    const kName = killer
      ? `<span class="kf-name ${teamClass(killer.team)}">${playerName(killer, 11, { role: false })}</span>`
      : '<span class="kf-name"><span class="n-text">—</span></span>';
    const vName = `<span class="kf-name ${teamClass(victim.team)}">${playerName(victim, 11, { role: false })}</span>`;
    const hs = head ? '<span class="kf-hs" title="headshot">✦</span>' : '';
    const glyph = WEAPON_GLYPH[weapon]
      ? `<svg class="kf-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${WEAPON_GLYPH[weapon]}"/></svg>`
      : `<span class="kf-w">${escapeHtml(WEAPON_LABEL[weapon] ?? weapon)}</span>`;

    row.innerHTML = `${kName} ${glyph} ${hs} ${vName}`;
    this.el.killfeed.appendChild(row);
    while (this.el.killfeed.children.length > 6) this.el.killfeed.firstChild.remove();
    setTimeout(() => { row.classList.add('fade'); setTimeout(() => row.remove(), 500); }, 5200);

    if (mine && streak) this.streakBanner(streak);
  }

  streakBanner(text) {
    const el = this.el.streak;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  /* ── Chat ──────────────────────────────────────────────────────────────── */

  /**
   * One chat line. `kind: 'ban'` (and anything else the server marks as one)
   * renders as an alert so a moderation event cannot be mistaken for banter.
   *
   * Every line goes the same way, a moderation notice included: loud while it
   * happens, then off the HUD. A ban that stayed pinned in the corner was still
   * there twenty minutes and two matches later, shouting about somebody who had
   * long since been dealt with. Nothing is deleted — the match's log still holds
   * it and opening the chat brings all of it back, which is the point of keeping
   * one.
   */
  chatMessage(msg, { replay = false } = {}) {
    const { text, team, system, kind = null } = msg;
    const row = document.createElement('div');
    const teamClass = team === K.TEAM.RED ? 'red' : team === K.TEAM.BLUE ? 'blue' : '';
    const alert = kind === 'ban' || kind === 'alert' || kind === 'mute';
    row.className = `chat-row ${system ? 'system' : teamClass}${alert ? ' alert' : ''}`
      + (replay ? ' stale' : '');
    row.innerHTML = system
      ? escapeHtml(text)
      : `<span class="chat-who">${chatLevel(msg.level)}${playerName(msg, 12, { link: true })}</span>`
        + `<span class="chat-text">${escapeHtml(text)}</span>`;
    this.el.chatLog.appendChild(row);
    while (this.el.chatLog.children.length > K.CHAT_HISTORY) this.el.chatLog.firstChild.remove();
    this.scrollChat();
    // Replayed lines arrive already off screen — they are history, not chatter.
    if (replay) return;
    setTimeout(() => {
      row.classList.add('fade');
      setTimeout(() => { row.classList.remove('fade'); row.classList.add('stale'); }, K.CHAT_FADE_MS);
    }, K.CHAT_VISIBLE_MS);
  }

  /** Replaces the log with a match's chat history — what a late arrival missed. */
  setChat({ history = [], canSend = false, reason = null } = {}) {
    this.el.chatLog.innerHTML = '';
    this.setChatState({ canSend, reason });
    // Replayed lines start off screen; they are history, not fresh chatter.
    for (const line of history) this.chatMessage(line, { replay: true });
  }

  /** The match ended: its chat goes with it. */
  purgeChat() {
    this.el.chatLog.innerHTML = '';
  }

  /**
   * Whether this player may write, and what the hint under the log says when
   * they may not — the level gate, a mute, or simply not being signed in.
   */
  setChatState({ canSend = false, reason = null } = {}) {
    this.chatCanSend = !!canSend;
    this.chatReason = reason;
    this.el.chatPanel?.classList.toggle('locked', !canSend);
    if (!this.el.chatHint) return;
    this.el.chatHint.innerHTML = canSend
      ? `Press <kbd>${escapeHtml(bindingLabel('chat').split(' / ')[0])}</kbd> to chat`
      : escapeHtml(reason ?? 'chat unavailable');
  }

  scrollChat() {
    const log = this.el.chatLog;
    if (log) log.scrollTop = log.scrollHeight ?? 0;
  }

  toast(message, kind = '') {
    const el = document.createElement('div');
    el.className = `toast-item ${kind}`;
    el.textContent = message;
    this.el.toast.appendChild(el);
    setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 400); }, 3200);
  }

  /* ── The nuke ──────────────────────────────────────────────────────────── */

  /** Ours to press, or not. Drawn as a prompt rather than a badge: it expires. */
  setNukeArmed(on) {
    this.nukeArmed = !!on;
    this.el.nukePrompt?.classList.toggle('hidden', !this.nukeArmed);
  }

  /**
   * Somebody launched one — including, possibly, us.
   *
   * The countdown is the same for everybody in the room; only the line under it
   * differs, because "kill them to stop it" is not advice you can act on when
   * *you* are the one who pressed the key.
   */
  nukeLaunched({ name, seconds, mine = false }) {
    this.nukeUntil = performance.now() / 1000 + (seconds ?? K.NUKE_COUNTDOWN);
    this.setNukeArmed(false);
    if (this.el.nukeBy) this.el.nukeBy.textContent = name ?? '—';
    if (this.el.nukeSub) {
      this.el.nukeSub.textContent = mine ? 'Stay alive — dying calls it off' : 'Kill them to stop it';
    }
    this.el.nukeWarning?.classList.remove('hidden');
    this.el.nukeWarning?.classList.toggle('mine', !!mine);
  }

  nukeAborted() {
    this.nukeUntil = 0;
    this.el.nukeWarning?.classList.add('hidden');
  }

  /** The flash. Held for a beat, then the end card comes up through it. */
  nukeDetonated() {
    this.nukeUntil = 0;
    this.el.nukeWarning?.classList.add('hidden');
    this.nukeFlashUntil = performance.now() / 1000 + 2.4;
    const f = this.el.nukeFlash;
    if (!f) return;
    f.classList.remove('hidden');
    // Restart the animation even if one is already running.
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  /** One frame of whichever nuke state is up. */
  updateNuke(nowSec) {
    if (this.nukeUntil > 0) {
      const left = Math.max(0, this.nukeUntil - nowSec);
      this._text(this.el.nukeCount, 'nk.count', Math.ceil(left));
      this._toggle(this.el.nukeWarning, 'nk.urgent', 'urgent', left <= 3);
      if (left <= 0) this.nukeUntil = 0;
    }
    if (this.nukeFlashUntil > 0 && nowSec >= this.nukeFlashUntil) {
      this.nukeFlashUntil = 0;
      this.el.nukeFlash?.classList.add('hidden');
    }
  }

  /* ── Spectating ────────────────────────────────────────────────────────── */

  /**
   * Turns the HUD into a window onto somebody else.
   *
   * Nothing moves and nothing is rebuilt: the same health bar, ammo counter,
   * class strip, minimap, killfeed and scoreboard are simply fed the watched
   * player's numbers instead of our own, with a line saying whose they are.
   * A spectator used to get no interface at all, which made the mode a camera
   * with no idea what it was looking at.
   */
  setWatching(name) {
    this.watching = name ?? null;
    this.el.hud?.classList.toggle('spectating', !!name);
    if (name) this.setNukeArmed(false);
  }

  /** The two switches the spectator bar owns, kept honest in both places. */
  setSpectatorView({ firstPerson = true, xray = false } = {}) {
    this._text(this.el.specViewLabel, 'spec.view', firstPerson ? 'FIRST PERSON' : 'THIRD PERSON');
    this._text(this.el.specXrayLabel, 'spec.xray', xray ? 'X-RAY ON' : 'X-RAY OFF');
    this._toggle($('btnSpecXray'), 'spec.xrayOn', 'on', !!xray);
    this._toggle($('btnSpecView'), 'spec.viewOn', 'on', !firstPerson);
  }

  /* ── Death & match ─────────────────────────────────────────────────────── */

  showDeath(by, weapon, respawnIn, killerHealth = null, { clan = null, clanVerified = false } = {}) {
    this.el.deathKiller.innerHTML = clanTag(clan, clanVerified) + escapeHtml(by);
    this.el.deathWeapon.textContent = WEAPON_LABEL[weapon] ?? weapon ?? '';
    this.el.respawnIn.textContent = Math.ceil(respawnIn);
    const hasHp = typeof killerHealth === 'number' && killerHealth > 0;
    this.el.deathKillerHp.parentElement.classList.toggle('hidden', !hasHp);
    if (hasHp) this.el.deathKillerHp.textContent = Math.round(killerHealth);
    this.el.deathScreen.classList.remove('hidden');
  }

  updateDeathTimer(secs, held = false) {
    this.el.respawnIn.textContent = Math.max(0, Math.ceil(secs));
    // Two hints, one visible: the automatic case, and the one where the player
    // pressed Escape and is deliberately staying down.
    this.el.deathHint?.classList.toggle('hidden', held);
    this.el.deathHintHeld?.classList.toggle('hidden', !held);
  }

  hideDeath() { this.el.deathScreen.classList.add('hidden'); }

  /* ── The kill cam ─────────────────────────────────────────────────────────
   *
   * Two methods and a hide. `showKillCam` paints the half that never changes —
   * who killed you and how — once, and `updateKillCam` paints the half that
   * ticks. Splitting them is the whole performance story here: the name, the
   * badges and the facts are four `innerHTML` writes on one frame instead of
   * four a frame for ten seconds.
   * ─────────────────────────────────────────────────────────────────────── */

  showKillCam(view) {
    const el = this.el;
    // The whole interface goes with the shot. It used to stay up — a crosshair,
    // a magazine and a minimap of the *present* over ten seconds of somebody
    // else's past, all of it about a body that is on the floor.
    document.body.classList.add('killcam');
    el.kcEyebrow.textContent = view.replay ? 'THROUGH THE EYES OF' : 'ELIMINATED BY';
    el.kcName.textContent = view.name ?? '—';
    el.kcTags.innerHTML = clanTag(view.clan, view.clanVerified)
      + verifiedTag(view.verified, 16)
      + creatorTag(view.creator)
      + (view.level ? `<span class="kc-level">${escapeHtml(tf('LEVEL {n}', { n: view.level | 0 }))}</span>` : '');

    // Only what is true. A melee has no distance worth printing, a headshot is
    // worth saying out loud, and a killer left standing on 8 HP is the single
    // most interesting number on this screen — so it is only drawn when the
    // fight was actually close.
    const facts = [['WITH', WEAPON_LABEL[view.weapon] ?? view.weapon ?? '—']];
    if (view.head) facts.push(['', 'HEADSHOT']);
    if (view.distance > 2) facts.push(['FROM', `${view.distance | 0} m`]);
    if (view.health > 0) facts.push(['THEY HAD', `${view.health | 0} HP`]);
    el.kcFacts.innerHTML = facts.map(([k, v]) =>
      `<span class="kc-fact${k ? '' : ' flag'}">${k ? `<small>${k}</small>` : ''}<b>${escapeHtml(v)}</b></span>`)
      .join('');

    const hasTrack = !!view.anthemTitle;
    el.kcAnthem.classList.toggle('hidden', !hasTrack);
    if (hasTrack) {
      el.kcTrack.textContent = view.anthemTitle;
      el.kcTrackBy.textContent = tf('{name} · MUSIC CREATOR', { name: view.name });
    }
    el.kcDirector.textContent = view.director ? t("DIRECTOR'S CUT") : '';
    el.killCam.classList.remove('hidden');
    this.killCamOpen = true;
  }

  updateKillCam(view, respawnIn) {
    const el = this.el;
    /*
     * The replay strip, and the moment it stops.
     *
     * A replay that has caught up with the death hands the cam to the orbit,
     * and the strip goes with it: leaving a full bar on screen over a camera
     * that is no longer replaying anything would be the interface saying one
     * thing while the picture says another.
     */
    el.kcReplay.classList.toggle('hidden', !view.replay);
    if (view.replay) {
      const span = view.replayLength || 1;
      el.kcReplayFill.style.width = `${Math.round((view.replayAt / span) * 100)}%`;
      el.kcReplayTime.textContent = `\u2212${view.replayLeft.toFixed(1)}s`;
      el.kcEyebrow.textContent = 'THROUGH THE EYES OF';
    } else if (el.kcEyebrow.textContent !== 'ELIMINATED BY') {
      el.kcEyebrow.textContent = 'ELIMINATED BY';
    }
    // The countdown is the respawn, not the cam: what a dead player wants to
    // know is when they are back in, and the two only agree if nobody skips.
    el.kcRemaining.textContent = Math.max(0, Math.ceil(Math.max(respawnIn, view.remaining)));
    el.kcSkipFill.style.width = `${Math.round(view.skipProgress * 100)}%`;
    el.kcSkip.disabled = !view.canSkip;
    el.kcSkip.classList.toggle('ready', view.canSkip);
    el.kcSkipLabel.textContent = view.canSkip
      ? t('SKIP')
      : tf('SKIP IN {n}', { n: Math.max(1, Math.ceil(view.skipIn)) });
    // The credit only appears once the track is really playing — a fetch that
    // lands late must not have promised music that never arrives.
    if (view.anthemTitle && el.kcAnthem.classList.contains('hidden')) {
      el.kcTrack.textContent = view.anthemTitle;
      el.kcTrackBy.textContent = tf('{name} · MUSIC CREATOR', { name: view.name });
      el.kcAnthem.classList.remove('hidden');
    }
  }

  hideKillCam() {
    this.el.killCam.classList.add('hidden');
    this.el.kcAnthem.classList.add('hidden');
    this.el.kcReplay.classList.add('hidden');
    document.body.classList.remove('killcam');
    this.killCamOpen = false;
  }

  /** Shows or hides the developer overlay column. devmode.js fills it. */
  setDevOverlay(on) {
    this.el.devOverlay.classList.toggle('hidden', !on);
    this.el.devOverlay.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  /** Full-screen end-of-match card: it stays up for the whole intermission. */
  showMatchEnd({ winner, nextIn, scoreboard, myId, mapName, modeName, teamMode, teamScore, duration, vote }) {
    this.matchEndOpen = true;
    this.el.meWinner.textContent = !winner ? 'INTERMISSION'
      : winner === 'draw' ? 'DRAW' : `${winner} WINS`;
    const bits = [];
    if (modeName) bits.push(modeName);
    if (mapName) bits.push(mapName);
    if (teamMode && teamScore) bits.push(`RED ${teamScore.red} — ${teamScore.blue} BLUE`);
    if (duration) bits.push(`${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`);
    this.el.meSub.textContent = bits.join('  ·  ');
    this.el.meRewards.textContent = '';
    this.el.meNext.textContent = Math.ceil(nextIn ?? K.INTERMISSION_TIME);
    this.renderMatchEndRows(scoreboard ?? [], myId, teamMode);
    this.renderMvp(scoreboard ?? []);
    this.myVote = null;
    this.setVote(vote ?? null);
    this.el.matchEnd.classList.remove('hidden');
    this.setScoreboardVisible(false);
  }

  /** A small card for whoever actually carried the match. */
  renderMvp(rows) {
    if (!rows.length) { this.el.meMvp.classList.add('hidden'); return; }
    const mvp = [...rows].sort((a, b) => b.score - a.score || b.kills - a.kills)[0];
    if (!mvp) { this.el.meMvp.classList.add('hidden'); return; }
    const awards = [];
    const best = (key) => [...rows].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))[0];
    const hs = best('headshots');
    const dmg = best('damage');
    const streak = best('bestStreak');
    if (hs?.headshots > 0) awards.push(['MOST HEADSHOTS', hs.name, hs.headshots]);
    if (dmg?.damage > 0) awards.push(['MOST DAMAGE', dmg.name, Math.round(dmg.damage)]);
    if (streak?.bestStreak > 1) awards.push(['BEST STREAK', streak.name, streak.bestStreak]);

    this.el.meMvp.classList.remove('hidden');
    this.el.meMvp.innerHTML = `
      <div class="mvp-main">
        <span class="mvp-label">MVP</span>
        <b class="mvp-name">${clanTag(mvp.clan, mvp.clanVerified)}${escapeHtml(mvp.name)}${
  verifiedTag(mvp.verified, 16)}</b>
        <span class="mvp-line">${mvp.score} pts · ${mvp.kills}/${mvp.deaths} · ${mvp.accuracy ?? 0}% acc</span>
      </div>
      <div class="mvp-awards">${awards.map(([t, n, v]) => `
        <div class="mvp-award"><span>${t}</span><b>${escapeHtml(n)}</b><i>${v}</i></div>`).join('')}
      </div>`;
  }

  renderMatchEndRows(rows, myId, teamMode) {
    const gg = this.mode === 'gg';
    const sorted = [...rows].sort((a, b) => (gg ? (b.rung ?? 0) - (a.rung ?? 0) : 0)
      || b.score - a.score || b.kills - a.kills);
    this.el.meRows.innerHTML = sorted.map((r, i) => {
      const teamClass = teamMode ? (r.team === K.TEAM.RED ? 'red' : 'blue') : '';
      return `<tr class="${r.id === myId ? 'me' : ''} ${teamClass} ${r.won ? 'won' : ''}">
        <td>${i + 1}</td>
        <td class="c-name">${playerName(r, 12, { link: true })}${
        r.bot ? '<span class="bot-tag">BOT</span>' : ''}</td>
        <td class="hi">${r.score}</td>
        <td class="gr">+${r.gr ?? 0}</td>
        <td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists ?? 0}</td><td>${r.headshots ?? 0}</td>
        <td>${Math.round(r.damage ?? 0)}</td><td>${r.accuracy ?? 0}%</td><td>${r.bestStreak ?? 0}</td></tr>`;
    }).join('');
  }

  setMatchEndReward(text, challenges = [], tomorrow = null) {
    this.el.meGuest?.classList.add('hidden');
    this.el.meRewards.innerHTML = `<span class="me-reward-line">${escapeHtml(text)}</span>`
      + (challenges ?? []).map((c) => `
        <span class="me-challenge${c.career ? ' career' : ''}">${c.career ? '★' : '✔'} ${
        escapeHtml(c.name)} <i>+${fmtNum(c.xp)} XP · +${fmtNum(c.gr)} GR</i></span>`).join('')
      // Drawn in its own register: everything to its left was earned, this is
      // an offer, and a card that let the two look alike would be selling.
      + (tomorrow ? `<span class="me-tomorrow">${escapeHtml(tomorrow)}</span>` : '');
  }

  /**
   * What the match would have been worth to an account.
   *
   * Shown to a guest, and only when the number is real — a match they scored
   * nothing in has nothing to argue with. The figure is the one the server just
   * computed with the same two functions it pays an account by, so this is not
   * a pitch, it is a receipt for something that was thrown away.
   *
   * @param {function} onRegister called when they press the button
   */
  setGuestReward({ forfeit, signup, score }, onRegister) {
    const host = this.el.meGuest;
    if (!host) return;
    if (!forfeit || (!forfeit.xp && !forfeit.gr)) { host.classList.add('hidden'); return; }
    this.el.meRewards.innerHTML = '';
    host.classList.remove('hidden');
    host.innerHTML = `
      <div class="mg-head">
        <b class="mg-figure">${fmtNum(forfeit.xp)} XP · ${fmtNum(forfeit.gr)} GR</b>
        <span class="mg-sub">is what those ${fmtNum(score ?? 0)} points were worth — and a guest keeps none of it.</span>
      </div>
      <ul class="mg-lines">${(signup?.lines ?? []).map((l) => `
        <li><i>${escapeHtml(l.icon)}</i><b>${escapeHtml(l.title)}</b><span>${escapeHtml(l.desc)}</span></li>`).join('')}
      </ul>
      <button type="button" class="btn-primary mg-cta">CREATE A FREE ACCOUNT</button>
      <span class="mg-foot">Takes a name and a password. Your next match starts counting.</span>`;
    host.querySelector('.mg-cta')?.addEventListener('click', () => {
      sfx.ui();
      onRegister?.();
    });
  }

  updateMatchEndTimer(s) { this.el.meNext.textContent = Math.max(0, Math.ceil(s)); }
  hideMatchEnd() { this.matchEndOpen = false; this.el.matchEnd.classList.add('hidden'); }

  /* ── Scoreboard ────────────────────────────────────────────────────────── */

  setScoreboardVisible(v) {
    // The end-of-match card already is a scoreboard; don't stack them.
    const show = v && !this.matchEndOpen;
    this.scoreboardOpen = show;
    this.el.scoreboard.classList.toggle('hidden', !show);
    // A press released outside the window never delivers its pointerup, and a
    // hold nothing clears is a board that stops updating for good.
    if (!show) this.sbHolding = false;
  }

  renderScoreboard(rows, myId, mapName, modeName, teamMode, { force = false } = {}) {
    // Somebody is pressing a button on this board. Redrawing now would delete
    // the element between mousedown and mouseup and swallow the click.
    if (this.sbHolding && !force) return;

    const gg = this.mode === 'gg';
    const sorted = [...rows].sort((a, b) => (gg ? (b.rung ?? 0) - (a.rung ?? 0) : 0)
      || b.score - a.score || b.kills - a.kills);

    // Everything the rows below actually draw, plus the two columns whose
    // presence changes the shape of a row. Same key, same table — so this runs
    // once per real change rather than once per frame.
    const key = [
      modeName, mapName, teamMode ? 't' : 'f', this.modTools ? this.myRole : '-',
      this.reportTool ? (this.canReport ? 'r' : `x${this.reportReason ?? ''}`) : '-',
      ...sorted.map((r) => [
        r.id, r.score, r.kills, r.deaths, r.assists ?? 0, r.headshots ?? 0,
        r.accuracy ?? 0, r.ping ?? 0, r.rung ?? 0, r.classId ?? '', r.team ?? 0,
        r.name, r.level ?? 0, r.clan ?? '', r.muted ? 1 : 0, r.bot ? 1 : 0,
      ].join(',')),
    ].join('|');
    if (key === this.lastBoardKey && !force) return;
    this.lastBoardKey = key;

    this.el.sbTitle.textContent = modeName?.toUpperCase() ?? 'SCOREBOARD';
    this.el.sbMap.textContent = mapName ?? '';

    this.el.sbRows.innerHTML = sorted.map((r, i) => {
      const teamClass = teamMode ? (r.team === K.TEAM.RED ? 'red' : 'blue') : '';
      const kd = (r.kills / Math.max(1, r.deaths)).toFixed(2);
      const ping = r.ping ?? 0;
      const bars = ping > 140 ? 1 : ping > 70 ? 2 : 3;
      return `<tr class="${r.id === myId ? 'me' : ''} ${teamClass}">
        <td>${i + 1}</td>
        <td class="c-name">${playerName(r, 12, { link: true })}${
        r.bot ? '<span class="bot-tag">BOT</span>' : ''}${mutedTag(r.muted)}</td>
        <td>${escapeHtml(gg ? `RUNG ${(r.rung ?? 0) + 1}` : (r.classId ?? ''))}</td>
        <td class="hi">${r.score}</td>
        <td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists ?? 0}</td><td>${r.headshots ?? 0}</td>
        <td>${kd}</td><td>${r.accuracy ?? 0}%</td>
        <td class="c-ping"><i class="ping-bars b${bars}"></i>${ping}</td>
        ${this.modTools ? `<td class="c-mod">${modCell(r, myId, this.myRole)}</td>` : ''}
        ${this.reportTool
    ? `<td class="c-report">${reportCell(r, myId, this.canReport ? null : this.reportReason)}</td>`
    : ''}</tr>`;
    }).join('');
  }

  /**
   * Wires the scoreboard's buttons — once, at construction.
   *
   * Delegated from the table body, which is the one node the redraw above never
   * replaces, so a button that has just been rebuilt is live without anybody
   * rebinding it. Binding per button after every render was the other half of
   * why these did nothing: the listeners were fine, the elements under them
   * were not.
   */
  bindScoreboard() {
    const board = this.el.scoreboard;
    const rows = this.el.sbRows;
    if (!board || !rows) return;

    // The redraw pauses for as long as a press is in flight — including one
    // that ends outside the board, which is a cancelled click, not a stuck one.
    board.addEventListener('pointerdown', () => { this.sbHolding = true; });
    for (const ev of ['pointerup', 'pointercancel', 'blur']) {
      window.addEventListener(ev, () => { this.sbHolding = false; });
    }

    rows.addEventListener('click', (e) => {
      const act = e.target.closest?.('.sb-act');
      if (act) {
        e.preventDefault();
        sfx.ui('ok');
        this.onModAction?.(act.dataset.act, Number(act.dataset.id), Number(act.dataset.min ?? 0));
        return;
      }
      const report = e.target.closest?.('.sb-report');
      if (!report) return;
      e.preventDefault();
      // A greyed button is not a dead one: it says why, out loud, for anyone
      // who clicked it instead of reading the tooltip.
      if (report.classList.contains('off')) {
        sfx.ui('error');
        this.toast(report.dataset.why || this.reportReason || 'you cannot report right now', 'error');
        return;
      }
      sfx.ui();
      this.openReportCard(Number(report.dataset.id), report.dataset.name ?? '');
    });
  }

  /**
   * The administrator switch in the scoreboard's footer.
   *
   * Wired once, at construction, and to the footer rather than a row — the
   * footer is never rebuilt, so the button survives every redraw the table
   * does underneath it.
   */
  bindAdminTools() {
    this.el.sbGod?.addEventListener('click', (e) => {
      e.preventDefault();
      if (!this.adminTools) return;
      sfx.ui('ok');
      // Asked for, not assumed: the server answers with what it actually did,
      // and `setGodMode` is what draws it.
      this.onGodMode?.(!this.godMode);
    });
  }

  /**
   * Turns the scoreboard's admin footer on. `handler` is called as (wanted).
   *
   * Only administrators see it; the server checks the rank again behind every
   * press, so this is presentation and never permission.
   */
  setAdminTools(role, handler = null) {
    this.adminTools = (role ?? 'player') === 'admin';
    this.onGodMode = handler;
    this.el.sbAdmin?.classList.toggle('hidden', !this.adminTools);
    if (!this.adminTools) this.setGodMode(false);
  }

  /**
   * The away-from-keyboard notice, or null to take it down.
   *
   * The server owns the rule; this only draws what it said. It is deliberately
   * large and central rather than a toast — it is the answer to "why has my
   * respawn stopped", and a toast that has already faded is not an answer.
   */
  setAfkNotice(text) {
    if (!this.el.afkNotice) return;
    this.el.afkNotice.classList.toggle('hidden', !text);
    if (text) this.el.afkNoticeText.textContent = text;
  }

  /** Draws whatever god-mode state the server last confirmed. */
  setGodMode(on) {
    this.godMode = !!on;
    if (this.el.sbGod) {
      this.el.sbGod.classList.toggle('on', this.godMode);
      const label = this.el.sbGod.querySelector('b');
      if (label) label.textContent = this.godMode ? 'ON' : 'OFF';
    }
    this.el.godBadge?.classList.toggle('hidden', !this.godMode);
  }

  /**
   * Turns the scoreboard's moderation column on for staff. `handler` is called
   * as (action, targetId, minutes); the server re-checks the rank behind it, so
   * nothing here is a permission — hiding a button the server would refuse is
   * only there so nobody clicks one that does nothing.
   */
  setModTools(role, handler = null) {
    this.myRole = role ?? 'player';
    this.modTools = K.canModerate(this.myRole);
    this.onModAction = handler;
    this.el.sbModHead?.classList.toggle('hidden', !this.modTools);
    this.el.scoreboard.classList.toggle('mod', this.modTools);
    this.refreshHints();
  }

  /* ── Reporting ─────────────────────────────────────────────────────────── */

  /**
   * Turns the scoreboard's report column on, and says what state it is in.
   *
   * Everybody sees the column — that is the difference between this and the
   * moderation column, which only staff have any business seeing at all. A
   * player who may not file gets the button greyed with the server's own reason
   * on it rather than an empty cell, because "reach level 5" is something you
   * can act on and a missing button is not.
   *
   * `handler` is called as (targetId, reason, detail); the server checks every
   * one of these again at the moment of filing, so nothing here is a permission.
   *
   * @param {{enabled?:boolean, canReport?:boolean, reason?:string|null}} state
   */
  setReportTool(state, handler = null) {
    const { enabled = false, canReport = false, reason = null } =
      typeof state === 'object' && state !== null ? state : { enabled: !!state, canReport: !!state };
    this.reportTool = !!enabled;
    this.canReport = !!canReport;
    this.reportReason = reason;
    if (handler) this.onReport = handler;
    this.el.sbReportHead?.classList.toggle('hidden', !this.reportTool);
    this.el.scoreboard.classList.toggle('reportable', this.reportTool);
    // The column's contents just changed under a key that only tracks rows.
    this.refreshHints();
  }

  /** The server's answer to "may you report at all", pushed mid-match. */
  setReportState({ enabled = undefined, canReport = false, reason = null } = {}) {
    this.setReportTool({ enabled: enabled ?? this.reportTool, canReport, reason });
  }

  /** The reason picker. Opened from a scoreboard row, closed by either button. */
  openReportCard(id, name) {
    const card = $('reportCard');
    if (!card) return;
    this.reportTarget = { id, name };
    $('reportWho').textContent = name;
    $('reportDetail').value = '';
    const picked = card.querySelector('.rp-reason.on');
    if (picked) picked.classList.remove('on');
    $('reportSend').disabled = true;
    card.classList.remove('hidden');
  }

  closeReportCard() {
    this.reportTarget = null;
    $('reportCard')?.classList.add('hidden');
  }

  // `=== false` rather than `!`: a missing card is closed, not open.
  get reportCardOpen() { return $('reportCard')?.classList.contains('hidden') === false; }

  /**
   * Builds the reason list once and wires the card up.
   *
   * A reason is mandatory — "reported" with nothing attached is a queue entry a
   * moderator cannot act on — so SEND stays disabled until one is picked.
   */
  bindReportCard() {
    const card = $('reportCard');
    if (!card) return;
    const list = $('reportReasons');
    list.innerHTML = K.REPORT_REASONS.map((r) =>
      `<button type="button" class="rp-reason" data-reason="${r.id}">
         <b>${escapeHtml(r.label)}</b><small>${escapeHtml(r.desc)}</small></button>`).join('');

    for (const btn of list.querySelectorAll('.rp-reason')) {
      btn.addEventListener('click', () => {
        sfx.ui();
        for (const other of list.querySelectorAll('.rp-reason')) other.classList.toggle('on', other === btn);
        $('reportSend').disabled = false;
      });
    }

    $('reportDetail').setAttribute('maxlength', String(K.REPORT_DETAIL_MAX));
    $('reportCancel').addEventListener('click', () => { sfx.ui(); this.closeReportCard(); });
    card.addEventListener('mousedown', (e) => { if (e.target === card) this.closeReportCard(); });

    $('reportSend').addEventListener('click', () => {
      const reason = list.querySelector('.rp-reason.on')?.dataset.reason;
      const target = this.reportTarget;
      if (!reason || !target) return;
      const detail = $('reportDetail').value.trim().slice(0, K.REPORT_DETAIL_MAX);
      this.onReport?.(target.id, reason, detail);
      sfx.ui('ok');
      this.closeReportCard();
    });
  }

  /** The server's answer to a report — the only feedback the reporter gets here. */
  reportResult({ ok: sent = false, message = null, target = null } = {}) {
    if (sent) {
      this.toast(`Report filed${target ? ` against ${target}` : ''} — follow it under ACCOUNT ▸ REPORTS`, 'good');
    } else if (message) {
      this.toast(message, 'error');
    }
  }

  /* ── Chat input ────────────────────────────────────────────────────────── */

  openChat(onSend) {
    if (!this.chatCanSend) { this.toast(this.chatReason ?? 'you cannot use the chat', 'error'); return false; }
    this.el.chatForm.classList.remove('hidden');
    this.el.chatPanel?.classList.add('typing');
    this.el.chatInput.value = '';
    this.el.chatInput.focus();
    // Opening the chat is also how you read it: every stored line comes back.
    this.scrollChat();
    this._chatSend = onSend;
    return true;
  }

  closeChat() {
    this.el.chatForm.classList.add('hidden');
    this.el.chatPanel?.classList.remove('typing');
    this.el.chatInput.blur();
  }

  get chatOpen() { return !this.el.chatForm.classList.contains('hidden'); }

  bindChat() {
    this.el.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.el.chatInput.value.trim();
      this.closeChat();
      if (text && this._chatSend) this._chatSend(text);
    });
    this.el.chatInput.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { e.preventDefault(); this.closeChat(); }
      e.stopPropagation();
    });
  }

  /* ── Minimap ───────────────────────────────────────────────────────────── */

  /**
   * Rotating minimap. Enemies only appear while someone can actually see them
   * (`entity.visible`), with a short memory so a target that ducks behind cover
   * fades rather than blinking out — anything else would be a wallhack.
   */
  drawMinimap(me, entities, teamMode, myTeam, nowSec, objectives = [], skipId = 0) {
    if (!settings.showMinimap || !this.map) return;
    /*
     * A 2D canvas redraw is not free — a clip, a bitmap blit, an arc and a
     * tick per player, and four compass letters — and it is the same picture
     * twice over on a screen refreshing faster than the eye reads a map. Sixty
     * a second is already more than the rotation needs; past that it is work
     * thrown at pixels that never change.
     */
    if (nowSec - this.mmDrawnAt < MINIMAP_INTERVAL) return;
    this.mmDrawnAt = nowSec;
    const g = this.mmCtx;
    const W = this.el.minimap.width, H = this.el.minimap.height;
    const cx = W / 2, cy = H / 2;
    const s = this.mmBaseScale * (settings.minimapZoom ?? 1);
    const radius = Math.min(cx, cy) - 3;

    g.clearRect(0, 0, W, H);
    g.save();
    g.beginPath();
    g.arc(cx, cy, radius, 0, Math.PI * 2);
    g.clip();

    g.fillStyle = 'rgba(8,11,17,.68)';
    g.fillRect(0, 0, W, H);

    // Rotate the map so "up" is always where the player looks.
    g.save();
    g.translate(cx, cy);
    g.rotate(me.yaw);
    g.translate(-me.x * s, -me.z * s);

    // Decor is dressing and clips are invisible: neither is a wall, so neither
    // is in the layer. See `minimapLayer` — it is baked, not walked.
    const layer = this.minimapLayer(s);
    if (layer.canvas) g.drawImage(layer.canvas, layer.minX * s, layer.minZ * s);

    for (const o of objectives) {
      const at = this.map.objectives?.find((p) => p.id === o.id);
      if (!at) continue;
      g.strokeStyle = o.owner === K.TEAM.RED ? '#ff4d4d' : o.owner === K.TEAM.BLUE ? '#4d9bff' : '#c8ced6';
      g.lineWidth = 2;
      g.globalAlpha = 0.9;
      g.beginPath();
      g.arc(at.x * s, at.z * s, 7, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
    }

    for (const e of entities) {
      if (!e.alive || e.id === skipId) continue;     // the arrow already is them
      const friendly = teamMode && e.profile.team === myTeam;
      let alpha = 1;
      if (!friendly) {
        const seenAgo = nowSec - (e.lastSeenAt ?? -99);
        if (!e.visible && seenAgo > K.VIS_MEMORY) continue;      // never seen / long gone
        alpha = e.visible ? 1 : Math.max(0, 1 - seenAgo / K.VIS_MEMORY);
      }
      g.globalAlpha = alpha;
      g.fillStyle = friendly ? '#4ddb7a' : '#ff4d4d';
      g.beginPath();
      g.arc(e.pos.x * s, e.pos.z * s, 4.2, 0, Math.PI * 2);
      g.fill();
      // A tick showing which way they face reads instantly at a glance.
      g.strokeStyle = g.fillStyle;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(e.pos.x * s, e.pos.z * s);
      g.lineTo((e.pos.x - Math.sin(e.yaw) * 2.4) * s, (e.pos.z - Math.cos(e.yaw) * 2.4) * s);
      g.stroke();
      g.globalAlpha = 1;
    }
    g.restore();

    // Local player arrow, always centred and pointing up.
    g.save();
    g.translate(cx, cy);
    g.fillStyle = '#f5a623';
    g.beginPath();
    g.moveTo(0, -8); g.lineTo(6, 7); g.lineTo(0, 3.5); g.lineTo(-6, 7);
    g.closePath();
    g.fill();
    g.restore();
    g.restore();

    // Compass ring
    g.strokeStyle = 'rgba(150,175,205,.42)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, radius, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(190,210,235,.7)';
    g.font = '600 11px Bahnschrift, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const [label, ang] of [['N', 0], ['E', Math.PI / 2], ['S', Math.PI], ['W', -Math.PI / 2]]) {
      const a = ang + me.yaw - Math.PI / 2;
      g.fillText(label, cx + Math.cos(a) * (radius - 10), cy + Math.sin(a) * (radius - 10));
    }
  }
}

const verifiedTag = (on, size = 12) =>
  (on ? `<img class="verified" src="/check.png" width="${size}" height="${size}" alt="verified" title="Verified">` : '');

/**
 * `[TAG]`, in front of the nickname the way clan tags are always written.
 *
 * Grey for a clan, gold for one the developers have verified — that colour is
 * the entirety of what verification buys, and it reads the same here, in the
 * chat, on the leaderboard and on a nametag out in the world.
 */
const clanTag = (clan, verified = false) => (clan
  ? `<span class="clan-tag${verified ? ' verified' : ''}"${
    verified ? ' title="Verified clan"' : ''}>[${escapeHtml(String(clan).slice(0, 4))}]</span>`
  : '');

/**
 * The creator badge, or nothing.
 *
 * One chip per discipline, drawn wherever a nickname is — the scoreboard, the
 * killfeed, the chat, the kill cam, a card. It is deliberately small and
 * deliberately not gold: the clan tag already owns gold, and a second thing
 * shouting for attention beside a name makes both of them harder to read.
 *
 * An unknown kind draws nothing rather than a placeholder, so a client one
 * build behind a server that added a fifth discipline degrades to no badge
 * instead of to a broken one.
 */
const creatorTag = (kind) => {
  const meta = K.getCreatorKind(kind);
  return meta
    ? `<span class="creator-tag ${escapeHtml(kind)}" title="${escapeHtml(meta.name)} creator">${
      escapeHtml(meta.name.slice(0, 1).toUpperCase())}</span>`
    : '';
};

/** ADMIN / MOD. Roles without a chip (plain players) render nothing. */
const roleTag = (role) => {
  const tag = K.ROLE_TAG[role];
  return tag ? `<span class="role-tag ${role}" title="${tag.title}">${tag.label}</span>` : '';
};

/**
 * A nickname and everything that travels with it: clan tag, verified check and
 * role chip. The name sits in its own element so the badges fall outside the
 * ellipsis — a long nickname truncates and its badges still show, which they
 * did not when they all shared one clipped box.
 *
 * `role: false` drops the role chip for the two 232px-wide HUD widgets — the
 * killfeed and the standings — where two of them on one row would leave the
 * names two characters each. Everywhere with room to spare shows the lot.
 */
const playerName = (row, size = 12, { role = true, link = false } = {}) => {
  const badges = clanTag(row?.clan, row?.clanVerified)
    + `<span class="n-text">${escapeHtml(row?.name ?? '')}</span>`
    + verifiedTag(row?.verified, size)
    + creatorTag(row?.creator)
    + (role ? roleTag(row?.role) : '');
  // Only an account has a profile to open. A bot has nobody behind it and a
  // guest has no row, so neither gets a link that could only ever 404.
  if (!link || !row?.account || row?.bot) return badges;
  return `<button type="button" class="pname" data-profile="${escapeHtml(row.name ?? '')}"`
    + ` title="View ${escapeHtml(row.name ?? '')}'s profile">${badges}</button>`;
};

/** The level chip that opens a chat line. Level 1 accounts cannot write anyway. */
const chatLevel = (level) =>
  (level ? `<span class="chat-lvl" title="Level ${level | 0}">${level | 0}</span>` : '');

/** Shown on the scoreboard next to anyone whose chat is currently shut. */
const mutedTag = (on) => (on ? '<span class="muted-tag" title="Muted">MUTED</span>' : '');

/**
 * The moderation cell on a staff scoreboard. Four durations rather than a
 * prompt, because a mute is a snap decision made mid-match; the server is what
 * actually decides whether this player is allowed to make it.
 */
const modCell = (row, myId, myRole) => {
  // Never draw a button the server would refuse: your own row, a bot, or
  // anyone of your own rank or above.
  if (row.bot || row.id === myId || !K.outranks(myRole, row.role)) return '';
  if (row.muted) return `<button class="sb-act lift" data-act="unmute" data-id="${row.id}">UNMUTE</button>`;
  return '<span class="sb-act-label">MUTE</span>' + K.MUTE_DURATIONS.map((d) =>
    `<button class="sb-act" data-act="mute" data-id="${row.id}" data-min="${d.minutes}"`
    + ` title="Mute ${escapeHtml(row.name ?? '')} ${d.title}">${d.label}</button>`).join('');
};

/**
 * The report cell. Your own row has nothing to report, and a bot has nobody
 * behind it to answer for anything.
 *
 * `denial` is the server's sentence for why this player may not file — the
 * level gate, a cooldown, or a moderator having switched the button off for
 * this account. The button is still drawn when one is present: greyed, refusing
 * the cursor, and carrying the reason both as a tooltip and as something the
 * click itself will say out loud.
 */
const reportCell = (row, myId, denial = null) => {
  if (row.bot || row.id === myId) return '';
  const name = escapeHtml(row.name ?? '');
  if (denial) {
    return `<button class="sb-report off" type="button" aria-disabled="true"`
      + ` data-why="${escapeHtml(denial)}" title="${escapeHtml(denial)}">⚑ REPORT</button>`;
  }
  return `<button class="sb-report" type="button" data-id="${row.id}" data-name="${name}"`
    + ` title="Report ${name}">⚑ REPORT</button>`;
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export default Hud;
