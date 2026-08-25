/**
 * Open Grunker — client entry point.
 *
 * Runs the fixed-step prediction loop, reconciles against server snapshots,
 * and drives rendering, audio and the HUD. The physics here is the *same*
 * module the server runs, so a replayed input produces an identical result on
 * both sides and corrections are usually exactly zero.
 */
import * as THREE from 'three';
import * as K from '/shared/constants.js';
import { World } from '/shared/physics.js';
import { getMap, ALL_MAP_IDS } from '/shared/maps.js';
import { step, createState, eyeY, KEY } from '/shared/movement.js';
import { shotDirections, shotSeed } from '/shared/shot.js';
import {
  loadoutFor, getClass, shotInterval, spreadFor, recoilKick, recoilRecovery, weaponById,
} from '/shared/weapons.js';

import { settings, set as setSetting, onChange as onSettingsChange, HEAVY_KEYS } from './settings.js';
import { binds } from './keybinds.js';
import { api } from './api.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { GameWorld } from './world.js';
import { EntityManager } from './entities.js';
import { ViewModel } from './viewmodel.js';
import { Effects } from './effects.js';
import { Objectives } from './objectives.js';
import { Hud } from './hud.js';
import { Menu } from './menu.js';
import { initAudio, resumeAudio, setMasterVolume, sfx } from './audio.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** How long after the last shot the view starts walking recoil back down. */
const RECOVER_DELAY = 0.12;
/** A round passing closer than this makes an audible snap. */
const WHIZZ_RADIUS = 3.2;

/** The match code someone shared with us, e.g. ?game=FRA:7K2Q. */
function matchFromUrl() {
  const raw = new URLSearchParams(location.search).get('game');
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return K.ROOM_CODE_RE.test(code) ? code : null;
}

/**
 * The whole client, as one object.
 *
 * Exported so the test suite can borrow individual methods and drive them
 * against the real DOM shim; the boot below is what actually builds one, and it
 * only runs on DOMContentLoaded, so importing this module builds nothing.
 */
export class Game {
  constructor() {
    this.canvas = $('view');
    this.gfx = new GameWorld(this.canvas);
    this.entities = new EntityManager(this.gfx.scene);
    this.effects = new Effects(this.gfx.scene);
    this.objectives = new Objectives(this.gfx.scene);
    this.viewmodel = new ViewModel(this.gfx.renderer);
    this.hud = new Hud();
    this.net = new Net();
    this.input = new Input(this.canvas);

    this.state = 'menu';        // menu | connecting | spectating | playing
    this.local = createState(0, 0, 0, 0);
    this.pending = [];
    this.seq = 0;
    /** Key mask of the last sampled tick — see simulateTick. */
    this.prevKeys = 0;
    this.shotSeq = 0;
    this.accumulator = 0;
    this.lastFrame = performance.now();
    this.inputFlushAcc = 0;
    this.frameBudget = 0;

    this.weapons = loadoutFor('triggerman');
    this.slot = 0;
    this.prevSlot = 1;
    this.ammo = [30, 15, 0];
    this.reserve = [-1, -1, -1];               // -1 = unlimited
    this.reloading = false;
    this.reloadEnd = 0;
    this.lastShotAt = -99;
    this.lastMeleeAt = -99;
    this.pumpUntil = 0;
    this.burst = 0;
    this.alive = false;
    this.health = K.MAX_HEALTH;
    this.respawnAt = 0;
    /**
     * Set when the player presses Escape while dead.
     *
     * Death respawns you on its own now; that is the point. Escape during the
     * couple of seconds before the timer runs out is the one way to say "not
     * yet" — to change class, to read the board, to walk away from the desk —
     * and it holds the body down until the menu is closed again.
     */
    this.respawnHeld = false;
    this.respawnSentAt = 0;
    this.skin = 'default';
    this.classId = 'triggerman';
    this.deathCam = null;
    this.projectiles = [];
    this.scoreboardRows = [];
    this.teamMode = false;
    this.myTeam = K.TEAM.NONE;
    this.matchTime = -1;
    this.teamScore = { red: 0, blue: 0 };
    this.matchEndAt = 0;
    this.matchPhase = 'live';
    this.shake = 0;
    this.shakeSeed = Math.random() * 1000;
    this.punch = { pitch: 0, yaw: 0, vp: 0, vy: 0 };
    this.pauseOpenedAt = 0;
    /** Set while a ban screen is up: blocks play, reconnects and pointer lock. */
    this.banned = null;
    /** A non-ban refusal (VPN, unconfirmed address, playing elsewhere). */
    this.gated = null;
    this.roomCode = null;
    this.roomId = null;
    this.specAngle = Math.random() * Math.PI * 2;
    this.specTarget = new THREE.Vector3();
    this.specFollowId = 0;
    /**
     * Spectator mode, as the player asked for it.
     *
     * `specMode` is the switch; `specWatching` is whether the server has
     * actually taken the seat away yet. They differ for exactly as long as it
     * takes to die: flipping the switch mid-firefight arms it, and the room
     * honours it on the next death rather than making a body vanish.
     */
    this.specMode = false;
    this.specWatching = false;
    this.specName = null;
    /** `[ammo, reserve, reloading]` for the body a spectator camera is on. */
    this.specAmmo = null;
    /** When that body's reload finishes, so the bar can fill for a watcher. */
    this.specReloadEnd = 0;
    this.specEye = new THREE.Vector3();
    this.reconnectTimer = null;
    this.myVerified = false;
    this.myRole = 'player';
    /** The scoreboard is pinned open with the mouse free — see toggleScoreboard. */
    this.scoreboardPinned = false;
    this.renderTime = 0;
    this.smooth = new THREE.Vector3();
    this.viewRoll = 0;
    this.fovCurrent = settings.fov;
    this.footstepAcc = 0;
    this.groundSurface = 'concrete';
    this.surfaceCheckAt = 0;
    this.lastTickSecond = -1;
    this.gunGame = null;
    /** Killstreak nuke: ours to launch, and the countdown anybody can see. */
    this.nukeArmed = false;
    this.nukeAt = 0;
    this.nukeTick = -1;
    this.practice = false;
    this.practiceHits = 0;
    this.practiceShots = 0;
    this.targets = [];
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();
    /** Scratch for the aim-assist cone test, which runs before the camera does. */
    this.aimFwd = new THREE.Vector3();
    this.aimTo = new THREE.Vector3();

    this.effects.setBudget(settings.particleAmount ?? 1);
    this.effects.onShellLand = () => sfx.shell();
    this.viewmodel.onEject = (localPos, localVel, scale) => this.ejectShell(localPos, localVel, scale);

    this.menu = new Menu({
      input: this.input,
      onPlay: (opts) => this.play(opts),
      onSettingsChange: (key) => this.applySettings(key),
      onClassChange: (id) => this.requestClass(id),
      // Picking a class in the menu arms it for the seat we are about to take.
      onClassPreview: (id) => { this.classId = id; if (this.net.connected) this.net.setClass(id); },
      onBindsChange: () => this.hud.refreshHints(),
    });

    this._bindNet();
    this._bindInput();
    this._bindUi();
    this.hud.bindChat();
      this.hud.onVote = (mapId) => this.net.vote(mapId);
    onSettingsChange((key) => this.applySettings(key));

    // The menu is an overlay on a live match: connect as a watcher immediately
    // so the background *is* the game, and PLAY is one click away.
    this.spectate(matchFromUrl());

    // Bound once. `requestAnimationFrame((t) => this.loop(t))` allocated a
    // closure on every frame of the session for no reason at all.
    this._frame = (t) => this.loop(t);
    requestAnimationFrame(this._frame);
  }

  /* ── Setup & lifecycle ─────────────────────────────────────────────────── */

  applySettings(key = null) {
    if (key && HEAVY_KEYS.has(key)) this.gfx.rebuild();
    this.gfx.applySettings();
    this.viewmodel.applySettings();
    this.hud.applySettings();
    this.effects.setBudget(settings.particleAmount ?? 1);
    setMasterVolume(settings.masterVolume);
    // Raw input is a property of the pointer lock itself, so a lock we are
    // already holding has to be re-asked for — see Input.refreshLockOptions.
    if (!key || key === 'mouseAcceleration') this.input.refreshLockOptions();
    if (!key || key === 'specXray') this.entities.setXray(settings.specXray && this.specWatching);
  }

  /** Opens (or reopens) a watching connection: the menu's live backdrop. */
  spectate(room = null) {
    if (this.banned || this.gated) return;
    clearTimeout(this.reconnectTimer);
    this.state = 'connecting';
    this.net.connect({
      name: this.menu?.currentName(),
      token: api.token,
      classId: this.menu?.selectedClass ?? this.classId,
      room: room || undefined,
      spectate: true,
    });
  }

  /**
   * Takes a seat. Already watching the right match? That is one message, no
   * reconnect and no loading screen. Otherwise connect straight into the room
   * the player picked.
   */
  play(opts = {}) {
    if (this.banned) { $('banScreen').classList.remove('hidden'); return; }
    if (this.gated) { $('gateScreen').classList.remove('hidden'); return; }
    initAudio();
    resumeAudio();
    this.classId = opts.classId ?? this.classId ?? 'triggerman';
    this.skin = api.account?.loadout?.skins?.[this.classId] ?? 'default';

    const wanted = opts.room || null;
    const here = !wanted || wanted === this.roomCode || wanted === this.roomId;
    const nameMatches = !opts.name || opts.name === this.myName;

    if (this.state === 'spectating' && this.net.connected && here && nameMatches) {
      this.net.setClass(this.classId);
      this.net.play();
      return;
    }

    this.state = 'connecting';
    $('loading').classList.remove('hidden');
    $('loadingText').textContent = 'CONNECTING…';
    this.net.connect({
      name: opts.name, token: api.token, classId: this.classId,
      room: wanted || undefined,
    });
  }

  /** Leaves the match and drops back to watching it from the menu. */
  leaveMatch() {
    const code = this.roomCode;
    this.net.disconnect();
    this.state = 'menu';
    this.alive = false;
    this.input.enabled = false;
    this.input.unlock();
    this.entities.reset();
    this.effects.clear();
    this.objectives.clear();
    this.clearProjectiles();
    this.hud.hide();
    this.hud.hideDeath();
    this.hud.hideMatchEnd();
    this.nukeArmed = false;
    this.nukeAt = 0;
    this.hud.setNukeArmed(false);
    this.hud.nukeAborted();
    this.scoreboardPinned = false;
    this.hud.setScoreboardVisible(false);
    $('pause').classList.add('hidden');
    // Leaving is leaving: the switch does not follow the player into the next
    // match they join, and the menu's own backdrop camera takes over here.
    this.specMode = false;
    this.specWatching = false;
    this.specFollowId = 0;
    this.specName = null;
    this.entities.hidden = 0;
    this.entities.setXray(false);
    this.hud.setWatching(null);
    this.setSpectateSwitch(false);
    this.updateSpectatorBar();
    this.closeInGameMenu();
    this.menu.show();
    this.spectate(code);
  }

  /* ── Bans ──────────────────────────────────────────────────────────────── */

  /**
   * Raises the ban screen. The server has already refused the connection; this
   * explains why, and keeps the client out of the match until the ban lifts.
   */
  showBan(info) {
    this.banned = info;
    const until = info.until > 0
      ? new Date(info.until * 1000).toLocaleString()
      : 'never — this ban is permanent';
    $('loading').classList.add('hidden');
    $('banTitle').textContent = info.scope === 'ip' ? 'NETWORK BANNED' : 'CONNECTION BANNED';
    $('banIds').textContent =
      `REF: ${info.ref ?? '—'}  |  SCOPE: ${(info.scope ?? 'account').toUpperCase()}  |  EXPIRES: ${until}`;
    $('banReason').textContent = info.reason || 'no reason given';
    $('banAppeal').innerHTML = info.appeal
      ? `Think this is a mistake? Quote the reference above to <a href="mailto:${escapeAttr(info.appeal)}">${escapeAttr(info.appeal)}</a>.`
      : 'Contact the server operator to appeal.';
    $('banScreen').classList.remove('hidden');
  }

  /** Tears the client down to the ban screen: no match, no reconnect loop. */
  stopForBan() {
    clearTimeout(this.reconnectTimer);
    this.net.disconnect();
    this.state = 'menu';
    this.alive = false;
    this.input.enabled = false;
    this.input.unlock();
    this.hud.hide();
    this.hud.setScoreboardVisible(false);
    $('pause').classList.add('hidden');
    this.closeInGameMenu();
    this.menu.hide();
  }

  /** Clears the screen and tries the connection again. */
  clearBan(retry) {
    this.banned = null;
    $('banScreen').classList.add('hidden');
    this.menu.show();
    if (retry) this.spectate(this.roomCode);
  }

  /* ── Gates ─────────────────────────────────────────────────────────────── */

  /**
   * The refusals that are not bans. Each one has something the player can do,
   * so the button says what that is rather than a flat "retry".
   */
  showGate(info) {
    const kinds = {
      vpn_blocked: {
        head: 'CONNECTION REFUSED', title: 'VPN OR PROXY DETECTED', action: 'I TURNED IT OFF',
        note: 'Open Grunker refuses VPNs, proxies, Tor exits and datacenter connections. '
          + 'Turn yours off and retry.',
      },
      email_unverified: {
        head: 'ALMOST THERE', title: 'CONFIRM YOUR EMAIL', action: 'SEND A NEW LINK',
        note: 'Open the link we emailed you, then press retry. No link? Ask for another one.',
      },
      session_replaced: {
        head: 'CONNECTION DROPPED', title: 'PLAYING SOMEWHERE ELSE', action: 'PLAY HERE INSTEAD',
        note: 'One account, one game. This window lost its seat when the account joined from '
          + 'another window or device.',
      },
      already_playing: {
        head: 'CONNECTION REFUSED', title: 'ALREADY IN A MATCH', action: 'RETRY',
        note: 'One account, one game. Leave the other match first, then retry.',
      },
    };
    const kind = kinds[info.code] ?? {
      head: 'CANNOT JOIN', title: 'BLOCKED', action: 'RETRY', note: '',
    };

    this.gated = info;
    $('loading').classList.add('hidden');
    $('gateHead').textContent = kind.head;
    $('gateTitle').textContent = kind.title;
    $('gateReason').textContent = info.message || 'the server refused this connection';
    $('gateNote').innerHTML = info.appeal
      ? `${escapeAttr(kind.note)} <br>Still stuck? <a href="mailto:${escapeAttr(info.appeal)}">${escapeAttr(info.appeal)}</a>.`
      : escapeAttr(kind.note);
    $('gateAction').textContent = kind.action;
    $('gateScreen').classList.remove('hidden');
  }

  /** Same teardown a ban gets: no match, no reconnect loop. */
  stopForGate() {
    clearTimeout(this.reconnectTimer);
    this.net.disconnect();
    this.state = 'menu';
    this.alive = false;
    this.input.enabled = false;
    this.input.unlock();
    this.hud.hide();
    this.hud.setScoreboardVisible(false);
    $('pause').classList.add('hidden');
    this.closeInGameMenu();
  }

  /**
   * The gate's action button. An unconfirmed address gets a fresh link before
   * retrying, because retrying without one would just bounce again.
   */
  async clearGate(retry) {
    const was = this.gated;
    this.gated = null;
    $('gateScreen').classList.add('hidden');
    this.menu.show();
    if (!retry) return;

    if (was?.code === 'email_unverified') {
      try {
        const r = await api.resendVerification();
        this.hud.toast(r.sent ? `New link sent to ${r.email}` : 'This server is not sending mail yet', 'good');
      } catch (err) {
        this.hud.toast(err.message ?? 'could not send the link', 'error');
        this.menu.openTab('profile');
        return;
      }
    }
    this.spectate(this.roomCode);
  }

  /**
   * Opens the full menu as an overlay without dropping the connection, so
   * changing a setting mid-match never costs the score you are sitting on.
   */
  openInGameMenu(tab = 'settings') {
    $('pause').classList.add('hidden');
    $('menu').classList.add('in-game');
    $('btnBackToMatch').classList.remove('hidden');
    this.menu.show();
    this.menu.openTab(tab);
    this.input.unlock();
  }

  closeInGameMenu() {
    $('menu').classList.remove('in-game');
    $('btnBackToMatch').classList.add('hidden');
  }

  get inGameMenuOpen() { return this.state === 'playing' && this.menu.visible; }

  /** Are we drawing somebody else's HUD right now? */
  get watchingHud() { return this.specWatching && this.state === 'spectating'; }

  /* ── Networking ────────────────────────────────────────────────────────── */

  _bindNet() {
    const net = this.net;

    net.on('welcome', (msg) => {
      $('loadingText').textContent = 'BUILDING MAP…';
      this.myId = msg.id;
      this.roomId = msg.room;
      this.roomCode = msg.code ?? null;
      this.entities.localId = msg.id;
      this.teamMode = K.MODES[msg.mode]?.teams ?? false;
      this.entities.teamMode = this.teamMode;
      this.myTeam = msg.you.team;
      this.myName = msg.you.name;
      // Guests are named by the server; show the one actually in play.
      if (msg.assignedName) this.menu?.setAssignedName(msg.assignedName);
      this.myLevel = msg.you.level ?? 1;
      this.myVerified = !!(msg.account?.verified ?? msg.you.verified);
      this.myRole = msg.account?.role ?? 'player';
      this.matchTime = msg.match?.endsIn ?? -1;
      this.matchPhase = msg.match?.phase ?? 'live';
      this.modeId = msg.mode;
      this.modeName = msg.match?.modeName ?? K.MODES[msg.mode]?.name ?? 'Free For All';
      this.practice = !!msg.match?.practice;
      this.teamScore = msg.match?.teamScore ?? { red: 0, blue: 0 };
      this.scoreboardRows = msg.scoreboard ?? [];
      this.entities.myTeam = this.myTeam;
      this.gunGame = msg.gunGame ?? null;

      this.loadMap(msg.map);
      this.entities.reset();
      this.entities.localId = msg.id;
      for (const p of msg.players) this.entities.addPlayer(p);

      this.objectives.apply(msg.objectives ?? []);
      this.hud.setMode(this.modeId, this.modeName, this.practice);
      this.hud.setGunGame(this.gunGame);
      this.hud.setObjectives(msg.objectives ?? []);
      this.hud.setVote(msg.vote ?? null);
      // The chat is the match's, so a reconnect or a new room replaces it
      // wholesale rather than appending to whatever was on screen.
      this.hud.setChat(msg.chat ?? {});
      this.hud.setModTools(this.myRole, (a, id, min) => this.net.mod(a, id, min));
      // The server decides, and says why: the column is drawn whenever this
      // build has reporting at all, and the button inside it is greyed with
      // whatever sentence the server would have refused with.
      this.hud.setReportTool(
        {
          enabled: msg.report?.enabled ?? (this.menu?.meta?.reports?.enabled ?? true),
          canReport: !!msg.report?.canReport,
          reason: msg.report?.reason ?? null,
        },
        (id, reason, detail) => this.net.report(id, reason, detail),
      );

      this.setClass(msg.you.classId ?? this.classId);
      this.ammo[0] = msg.you.ammo ?? this.weapons[0].magSize;
      this.reserve[0] = msg.you.reserve ?? -1;
      this.health = msg.you.health ?? K.MAX_HEALTH;

      this.renderTime = 0;
      $('loading').classList.add('hidden');
      this.syncUrl();
      this.menu.watchingCode = this.roomCode;
      this.menu.setNowPlaying({ mapName: this.mapName, modeName: this.modeName, code: this.roomCode });
      // The first roster this client has seen, and the first chance to know
      // whether there is anybody in the match worth watching.
      this.updateSpectateAvailability();
      if (this.menu.visible) this.menu.refreshServers();      // mark the live row

      if (msg.you.spectator) {
        // Watching from the menu: no HUD, no input, just the world behind the UI.
        this.state = 'spectating';
        this.alive = false;
        this.specCentre(msg);
        this.hud.hide();
        this.input.enabled = false;
        this.menu.show();
        return;
      }

      this.enterMatch();
      // Dropping into a match that is already over goes straight to its board.
      if (this.matchPhase === 'intermission') {
        this.matchEndAt = performance.now() / 1000 + (msg.match?.nextIn ?? K.INTERMISSION_TIME);
        this.hud.showMatchEnd({
          winner: null, nextIn: msg.match?.nextIn ?? K.INTERMISSION_TIME,
          scoreboard: this.scoreboardRows, myId: this.myId,
          mapName: this.mapName, modeName: this.modeName, teamMode: this.teamMode,
          vote: msg.vote ?? null,
        });
      }
      sfx.spawn();
    });

    net.on('snapshot', (msg) => this.onSnapshot(msg));

    net.on('spawn', (msg) => {
      this.local = createState(msg.x, msg.y, msg.z, msg.yaw);
      this.pending.length = 0;
      // The server's body is brand new and remembers no keys; ours must not
      // either, or the first tick reads a held jump as a fresh press.
      this.prevKeys = 0;
      this.alive = true;
      this.health = msg.health;
      this.deathCam = null;
      this.smooth.set(0, 0, 0);
      if (msg.classId && msg.classId !== this.classId) this.setClass(msg.classId);
      for (let i = 0; i < this.weapons.length; i++) {
        this.ammo[i] = this.weapons[i].magSize ?? 0;
        this.reserve[i] = -1;
      }
      this.ammo[0] = msg.ammo ?? this.weapons[0].magSize ?? 0;
      this.reserve[0] = msg.reserve ?? -1;
      this.slot = 0;
      this.reloading = false;
      this.burst = 0;
      this.viewmodel.setWeapon(this.weapons[0], this.skin);
      this.input.reset(msg.yaw, 0);
      this.hud.hideDeath();
      sfx.spawn();
    });

    net.on('join', (p) => {
      // A class change re-announces the player: refresh rather than duplicate.
      if (this.entities.get(p.id)) this.entities.setClass(p.id, p.classId);
      else this.entities.addPlayer(p);
      const row = this.scoreboardRows.find((r) => r.id === p.id);
      if (row) Object.assign(row, { classId: p.classId, name: p.name, level: p.level, verified: p.verified });
      else this.scoreboardRows.push({ ...p, assists: 0, ping: 0 });
      this.refreshRoster();
    });
    net.on('leave', (id) => {
      this.entities.removePlayer(id);
      this.scoreboardRows = this.scoreboardRows.filter((r) => r.id !== id);
      this.refreshRoster();
    });

    net.on('hit', (msg) => {
      this.hud.hitmarker(msg.kill, msg.head);
      sfx.hitmarker(msg.head, msg.kill);
      if (msg.kill) sfx.kill();
      this.hud.damageNumber({ x: msg.x, y: msg.y, z: msg.z }, msg.damage, this.gfx.camera,
        msg.kill ? 'kill' : msg.head ? 'head' : '');
      this.effects.blood(msg.x, msg.y, msg.z, msg.head || msg.kill);
      this.entities.flashHit(msg.target);
      this.input.gamepad.rumble(msg.kill ? 0.75 : msg.head ? 0.45 : 0.3, msg.kill ? 150 : 70);
    });

    net.on('damage', (msg) => {
      const drop = Math.max(0, this.health - msg.health);
      this.health = msg.health;
      this.addShake(Math.min(0.9, msg.damage / 45));
      this.gfx.post.addDamage(Math.min(0.8, 0.18 + msg.damage / 90));
      sfx.hurt(msg.damage);
      if (!msg.fall) sfx.fleshHit();
      this.hud.tookDamage(
        msg.from ? { x: msg.x, y: msg.y, z: msg.z } : null,
        this.local, this.input.yaw, msg.damage);
      if (drop > 0 && this.health <= 30) this.hud.lowHealthPulse();
      this.input.gamepad.rumble(Math.min(0.9, 0.25 + msg.damage / 80), 110);
    });

    net.on('kill', (msg) => {
      this.hud.killfeedEntry(msg, this.myId);
      const row = this.scoreboardRows.find((r) => r.id === msg.killer?.id);
      if (row) row.kills++;
      const vrow = this.scoreboardRows.find((r) => r.id === msg.victim.id);
      if (vrow) vrow.deaths++;
      if (msg.streak && msg.killer?.id === this.myId && settings.announcer) sfx.sting(1.15);
    });

    net.on('death', (msg) => {
      this.alive = false;
      this.respawnHeld = false;
      // The streak died with the life; the server says so too, a frame later.
      this.nukeArmed = false;
      this.hud.setNukeArmed(false);
      this.respawnAt = performance.now() / 1000 + msg.respawnIn;
      this.hud.showDeath(msg.by, msg.weapon, msg.respawnIn, msg.killerHealth,
        { clan: msg.byClan, clanVerified: msg.byClanVerified });
      sfx.die();
      this.input.gamepad.rumble(1, 320);
      const killer = this.entities.get(msg.byId);
      this.deathCam = killer ? { targetId: msg.byId } : null;
      this.input.clearRecoil();
    });

    net.on('ammo', (msg) => {
      const wasEmpty = this.ammo[msg.slot] === 0;
      this.ammo[msg.slot] = msg.ammo;
      this.reserve[msg.slot] = msg.reserve ?? -1;
      if (msg.reloading) {
        this.reloading = true;
        this.reloadEnd = performance.now() / 1000 + msg.reloading;
        this.burst = 0;
        this.viewmodel.reload(msg.reloading, wasEmpty);
        this.scheduleReloadSounds(msg.reloading, wasEmpty);
      } else if (msg.dry) {
        sfx.dryFire();
      } else {
        this.reloading = false;
      }
    });

    net.on('nuke', (msg) => this.onNuke(msg));

    net.on('shot', (msg) => this.onRemoteShot(msg));
    net.on('impact', (msg) => {
      this.effects.impact(msg.x, msg.y, msg.z, msg.nx, msg.ny, msg.nz, msg.s ?? 'concrete');
      sfx.impact(msg, this.listener(), msg.s ?? 'concrete');
    });
    net.on('explosion', (msg) => {
      this.effects.explosion(msg.x, msg.y, msg.z, msg.r);
      sfx.explosion(msg, this.listener());
      // The rocket is gone the instant it goes off. Dropping it from the array
      // was never enough on its own: the mesh belongs to the scene, so a
      // filtered-out projectile left its warhead hanging in the air at the
      // point of impact for the rest of the match.
      this.despawnProjectile(msg.id);
      // Felt as far as it reaches: the falloff is keyed to the blast's own
      // radius rather than a fixed 26 units, so a bigger warhead shakes a
      // bigger room instead of the same one harder.
      const d = Math.hypot(msg.x - this.local.x, msg.y - this.local.y, msg.z - this.local.z);
      const near = Math.max(0, 1 - d / Math.max(18, (msg.r ?? 6) * 4.4));
      this.addShake(near * 1.9);
      this.gfx.post.addFlash(near * 0.62, 0xffb861);
    });

    net.on('chat', (msg) => {
      // The match that owned this chat is over; the log goes with it.
      if (msg.purge) return this.hud.purgeChat();
      this.hud.chatMessage(msg);
    });
    net.on('chatstate', (msg) => this.hud.setChatState(msg));
    net.on('report', (msg) => this.hud.reportResult(msg));
    net.on('reportstate', (msg) => this.hud.setReportState(msg));

    net.on('score', (msg) => {
      this.scoreboardRows = msg.rows ?? this.scoreboardRows;
      if (msg.teamScore) this.teamScore = msg.teamScore;
      // Badges travel on every scoreboard row, so this is also how a clan tag
      // that changed mid-match reaches the plate over that player's head.
      this.syncBadges(this.scoreboardRows);
      this.refreshRoster();
      if (this.hud.scoreboardOpen) {
        this.hud.renderScoreboard(this.scoreboardRows, this.myId, this.mapName, this.modeName, this.teamMode);
      }
    });

    net.on('points', (msg) => {
      this.hud.pointsPopup(msg);
      sfx.points(msg.total >= 100);
      const mine = this.scoreboardRows.find((r) => r.id === this.myId);
      if (mine) mine.score = msg.score;
      this.refreshRoster();
    });

    net.on('objective', (msg) => {
      this.objectives.apply(msg.points ?? []);
      this.hud.setObjectives(msg.points ?? []);
    });

    net.on('vote', (msg) => this.hud.setVote(msg));

    net.on('gungame', (msg) => {
      this.gunGame = msg;
      this.hud.setGunGame(msg);
      if (msg.kills === 0 && settings.announcer) sfx.unlock();
    });

    net.on('match', (msg) => {
      if (msg.phase === 'end') {
        this.matchPhase = 'intermission';
        this.matchTime = -1;
        this.scoreboardRows = msg.scoreboard ?? this.scoreboardRows;
        this.matchEndAt = performance.now() / 1000 + (msg.nextIn ?? K.INTERMISSION_TIME);
        this.hud.showMatchEnd({
          winner: msg.winner, nextIn: msg.nextIn, scoreboard: this.scoreboardRows,
          myId: this.myId, mapName: msg.mapName ?? this.mapName,
          modeName: msg.modeName ?? this.modeName, teamMode: this.teamMode,
          teamScore: msg.teamScore, duration: msg.duration, vote: msg.vote,
        });
        this.refreshRoster();
        this.scoreboardPinned = false;
        // A streak that ended with the match is not a streak you still hold.
        this.nukeArmed = false;
        this.nukeAt = 0;
        this.hud.setNukeArmed(false);
        this.hud.nukeAborted();
        sfx.matchEnd();
        this.input.unlock();
      } else if (msg.phase === 'start') {
        this.matchPhase = 'live';
        this.hud.hideMatchEnd();
        this.loadMap(msg.map);
        this.matchTime = msg.endsIn;
        this.matchEndAt = 0;
        this.teamScore = { red: 0, blue: 0 };
        for (const r of this.scoreboardRows) {
          Object.assign(r, { score: 0, kills: 0, deaths: 0, assists: 0, headshots: 0, streak: 0, rung: 0 });
        }
        this.refreshRoster();
        this.hud.setVote(null);
        this.effects.clear();
        this.clearProjectiles();
        // Only re-grab the mouse if nothing is on top of the game asking for it.
        if (this.state === 'playing' && $('pause').classList.contains('hidden')) this.grabMouse();
      } else if (msg.phase === 'reward') {
        const bits = [`+${msg.xp} XP`, `+${msg.gr} GR`, `${msg.score} POINTS`];
        // The daily bonuses ride in the same totals, so they are called out as
        // their own lines rather than silently inflating the match figure.
        const extras = [];
        if (msg.streak?.fresh) {
          extras.push({ name: `${K.streakLabel(msg.streak.days)} · daily streak`,
            xp: msg.streak.xp, gr: msg.streak.gr });
        }
        if (msg.firstWin) {
          extras.push({ name: 'First win of the day', xp: msg.firstWin.xp, gr: msg.firstWin.gr });
        }
        // A level crossed is paid the moment it is crossed, so it is named
        // rather than folded into the match figure the player watched climb.
        if (msg.levelGr > 0) {
          extras.push({
            name: msg.levelsGained > 1
              ? `Levels ${msg.level - msg.levelsGained + 1}–${msg.level} reached`
              : `Level ${msg.level} reached`,
            xp: 0, gr: msg.levelGr,
          });
        }
        this.hud.setMatchEndReward(`${bits.join('  ·  ')}  ·  LEVEL ${msg.level}`,
          [...extras, ...(msg.challenges ?? [])],
          // Not a reward — a standing offer, drawn apart from the ones that
          // were actually just paid so it can never read as one.
          msg.tomorrow
            ? `Come back tomorrow for day ${msg.tomorrow.day} of your streak — `
              + `+${msg.tomorrow.gr} GR, +${msg.tomorrow.xp} XP`
            : null);
        // `totalGr` is the account balance the server just wrote; adding the
        // match payout on top of it would double-count every match.
        if (api.account && typeof msg.totalGr === 'number') api.account.gr = msg.totalGr;
        if (api.account && typeof msg.level === 'number') {
          api.account.level = msg.level;
          if (typeof msg.totalXp === 'number') api.account.xp = msg.totalXp;
          api.account.levelXp = K.xpForLevel(msg.level);
          api.account.nextLevelXp = K.xpForLevel(msg.level + 1);
          // The account panel's ladder reads straight off this; without it a
          // player who levelled up mid-session still saw the old rung.
          this.menu?.renderProgression?.(api.account);
        }
        // The plate over this player's own head carries the level too.
        if (typeof msg.level === 'number') this.myLevel = msg.level;
        if (msg.leveledUp) {
          sfx.levelUp();
          this.hud.toast(msg.levelGr > 0
            ? `Level up — you are now level ${msg.level}, +${msg.levelGr} GR`
            : `Level up — you are now level ${msg.level}`, 'good');
          this.input.gamepad.rumble(0.5, 260);
        }
        if (msg.streak?.fresh) {
          sfx.unlock();
          this.hud.toast(msg.streak.days > 1
            ? `${msg.streak.days} day streak — +${msg.streak.gr} GR, +${msg.streak.xp} XP`
            : `Daily streak started — +${msg.streak.gr} GR, +${msg.streak.xp} XP`, 'good');
        }
        if (msg.firstWin) {
          this.hud.toast(`First win of the day — +${msg.firstWin.gr} GR, +${msg.firstWin.xp} XP`, 'good');
        }
        // The account panel's streak card reads off this; without it a player
        // who just claimed today would still be shown yesterday's number.
        if (api.account && msg.streak) {
          api.account.streak = {
            ...(api.account.streak ?? {}),
            days: msg.streak.days, best: msg.streak.best, todayDone: true,
            firstWinDone: (api.account.streak?.firstWinDone ?? false) || !!msg.firstWin,
            next: K.streakReward(msg.streak.days + 1),
            firstWin: K.FIRST_WIN_BONUS,
          };
          this.menu?.renderStreak?.(api.account.streak);
        }
        for (const c of msg.challenges ?? []) {
          this.hud.toast(`Challenge complete — ${c.name} (+${c.xp} XP, +${c.gr} GR)`, 'good');
          sfx.unlock();
        }
      } else if (msg.phase === 'guestReward') {
        // A guest is handed the receipt for what the match was worth, not a
        // slogan. The numbers are the server's own, computed the same way an
        // account is paid.
        this.hud.setGuestReward(msg, () => {
          this.input.unlock();
          this.menu.openAuth('register');
        });
      } else if (msg.phase === 'joined') {
        this.scoreboardRows = msg.scoreboard ?? this.scoreboardRows;
        // A spectator has no team; the seat it was just given does. Without
        // this the client kept TEAM.NONE and drew its own side as the enemy —
        // wrong nametag colours, wrong minimap blips, tracers through friends.
        if (msg.you) {
          this.myId = msg.you.id ?? this.myId;
          this.myTeam = msg.you.team ?? this.myTeam;
          this.entities.localId = this.myId;
          this.entities.myTeam = this.myTeam;
          this.entities.teamMode = this.teamMode;
        }
        if (msg.classId) this.setClass(msg.classId);
        // Whatever brought the seat back — PLAY, or the switch going off —
        // this is the end of watching.
        this.specWatching = false;
        this.specFollowId = 0;
        this.specName = null;
        this.setSpectateSwitch(false);
        this.updateSpectatorBar();
        this.enterMatch();
        sfx.spawn();
      } else if (msg.phase === 'classSet') {
        this.setClass(msg.classId);
        if (typeof msg.ammo === 'number') this.ammo[0] = msg.ammo;
        this.reserve[0] = msg.reserve ?? -1;
        if (msg.immediate) this.hud.toast(`Switched to ${getClass(msg.classId).name}`, 'good');
      } else if (msg.phase === 'classQueued') {
        this.hud.toast('In combat — the new class lands on your next respawn', '');
      } else if (msg.phase === 'classLocked') {
        this.hud.toast('Gun Game picks your weapon — earn the next one', '');
      } else if (msg.phase === 'spectate') {
        this.specFollowId = msg.targetId;
        this.specName = msg.name ?? null;
        this.specAmmo = null;
        this.specReloadEnd = 0;
        this.updateSpectatorBar();
        this.refreshRoster();
      } else if (msg.phase === 'specMode') {
        this.onSpectateMode(msg);
      }
    });

    const GATED = new Set(['vpn_blocked', 'email_unverified', 'session_replaced', 'already_playing']);

    net.on('serverError', (msg) => {
      if (msg.code === 'banned') return this.showBan(msg);
      if (GATED.has(msg.code)) { this.showGate(msg); return; }
      this.hud.toast(msg.message ?? msg.code, 'error');
      $('loading').classList.add('hidden');
      if (msg.code === 'room_full') this.menu.openTab('servers');
    });

    // 4014 vpn · 4016 unconfirmed address · 4017/4018 one account, one game.
    const GATE_CODES = new Set([4014, 4016, 4017, 4018]);

    net.on('close', (code, reason) => {
      $('loading').classList.add('hidden');
      // 4013 is the ban close code. The screen has already been raised by the
      // ERROR frame that preceded it; retrying here would only bounce again.
      if (code === 4013 || this.banned) {
        if (!this.banned) this.showBan({ reason: reason || 'this connection is banned' });
        this.stopForBan();
        return;
      }
      // Same shape for the gates: the ERROR frame explained it, and the
      // reconnect timer must not fight the server about it.
      if (GATE_CODES.has(code) || this.gated) {
        if (!this.gated) this.showGate({ code: 'blocked', message: reason || 'this connection was refused' });
        this.stopForGate();
        return;
      }
      const wasPlaying = this.state === 'playing';
      if (wasPlaying) {
        const why = reason || (code === 4029 ? 'too many connections' : 'connection lost');
        this.hud.toast(`Disconnected: ${why}`, 'error');
        this.leaveMatch();
        return;
      }
      if (this.state === 'menu') return;
      // Watching connection dropped: the menu keeps working, try again shortly.
      this.state = 'menu';
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.spectate(this.roomCode), 4000);
    });
  }

  /**
   * Builds the level the server named.
   *
   * A `builtin` map arrives as an id and no geometry: the box list is rebuilt
   * from the shared module rather than downloaded, which is both exact — it is
   * literally the same code the server collides against — and free. Whatever
   * the server did send still wins on top, because the live objective set
   * depends on the game mode, not on the map.
   */
  loadMap(payload) {
    const map = payload.builtin && ALL_MAP_IDS.includes(payload.id)
      ? { ...getMap(payload.id), ...payload, boxes: getMap(payload.id).boxes }
      : payload;
    this.map = map;
    this.mapName = map.name;
    this.world = new World(map);
    this.gfx.setMap(map);
    this.hud.setMap(map);
    this.objectives.setPoints(map.objectives ?? []);
    this.targets = (map.targets ?? []).map((t) => ({ ...t, hitAt: -99 }));
    this.buildTargets();
  }

  /** Practice-range targets: local props, scored client-side for feedback only. */
  buildTargets() {
    if (this.targetGroup) {
      this.gfx.scene.remove(this.targetGroup);
      this.targetGroup.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      this.targetGroup = null;
    }
    if (!this.targets.length) return;
    const group = new THREE.Group();
    for (const t of this.targets) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 1.6, 0.16),
        new THREE.MeshPhongMaterial({ color: 0xd94a3a, shininess: 20, specular: 0x333333 }),
      );
      mesh.position.set(t.x, t.y, t.z);
      mesh.castShadow = true;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.14, 0.24, 20),
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
      );
      ring.position.set(t.x, t.y + 0.35, t.z - 0.09);
      group.add(mesh, ring);
      t.mesh = mesh;
    }
    this.gfx.scene.add(group);
    this.targetGroup = group;
  }

  /** Menu out, HUD in, mouse captured. */
  enterMatch() {
    this.state = 'playing';
    // Whatever the spectator camera was hiding is somebody's opponent again —
    // and whatever it was letting us see through certainly is.
    this.entities.hidden = 0;
    this.entities.setXray(false);
    this.hud.setWatching(null);
    this.specWatching = false;
    this.updateSpectatorBar();
    $('loading').classList.add('hidden');
    this.closeInGameMenu();
    this.menu.hide();
    this.menu.closeClassModal();
    this.hud.show();
    this.hud.hideMatchEnd();
    this.refreshRoster();
    this.input.enabled = true;
    this.input.lock();
  }

  /* ── The nuke ──────────────────────────────────────────────────────────── */

  /**
   * Every phase of a nuke, from either side of it.
   *
   * `armed` is private — it is the answer to "is this streak mine to spend" and
   * only ever arrives for the player holding it. The other three are the whole
   * room's: a launch everybody has to be told about, an abort when the caller
   * is killed, and the flash.
   */
  onNuke(msg) {
    if (msg.phase === 'armed') {
      // Kept whatever the client is doing at the time: the room only sends this
      // when the answer *changes*, so a frame dropped because a menu happened to
      // be open would never come again.
      const armed = !!msg.armed;
      if (armed && !this.nukeArmed && settings.announcer) sfx.sting(1.35);
      this.nukeArmed = armed;
      this.hud.setNukeArmed(armed && this.state === 'playing');
      return;
    }

    if (msg.phase === 'launched') {
      const mine = msg.by === this.myId;
      this.nukeAt = performance.now() / 1000 + (msg.seconds ?? K.NUKE_COUNTDOWN);
      this.nukeTick = -1;
      this.nukeArmed = false;
      this.hud.nukeLaunched({ name: msg.name, seconds: msg.seconds, mine });
      this.hud.toast(mine ? 'Nuke away — stay alive' : `${msg.name} launched a NUKE`, mine ? 'good' : 'error');
      return;
    }

    if (msg.phase === 'aborted') {
      this.nukeAt = 0;
      this.hud.nukeAborted();
      this.hud.toast(`${msg.name}'s nuke was stopped`, 'good');
      return;
    }

    if (msg.phase !== 'detonated') return;
    this.nukeAt = 0;
    this.hud.nukeDetonated();
    sfx.nuke();
    this.addShake(3.2);
    this.gfx.post.addFlash(1, 0xffffff);
    // A blast over wherever the view actually is — a spectator's camera is not
    // standing where `local` says a body is, and lighting the world under an
    // empty coordinate would flash nothing anybody can see.
    const cam = this.gfx.camera.position;
    this.effects.explosion(cam.x, cam.y + 12, cam.z, 30);
  }

  /** One frame of the countdown: the siren, and the HUD that carries it. */
  updateNukeCountdown(nowSec) {
    this.hud.updateNuke(nowSec);
    if (this.nukeAt <= 0) return;
    const left = this.nukeAt - nowSec;
    if (left <= 0) { this.nukeAt = 0; return; }
    const secs = Math.ceil(left);
    if (secs !== this.nukeTick) {
      this.nukeTick = secs;
      if (settings.announcer) sfx.siren(secs <= 3);
    }
  }

  /* ── Spectator mode ────────────────────────────────────────────────────── */

  /**
   * The switch, from either place it is drawn.
   *
   * The client never decides when watching starts: it asks, and the room
   * answers with a `specMode` frame saying whether it landed now or is waiting
   * on a death. Anything else would show a camera to a player whose body is
   * still standing in the world for everybody else.
   */
  requestSpectateMode(on) {
    if (on && this.watchableCount < 1) {
      // Belt and braces: the switch is already greyed, but a keyboard or a
      // stale click must not turn on a camera with nothing to point at.
      this.setSpectateSwitch(false);
      this.updateSpectateAvailability();
      this.hud.toast('Nobody else is in this match to watch', 'error');
      return;
    }
    this.specMode = !!on;
    this.setSpectateSwitch(this.specMode);
    if (!this.net.connected) return;
    this.net.spectateMode(this.specMode);
    // Nothing to hand back to when the answer is "at your next death", so the
    // player keeps playing with the mouse they already had.
    if (this.specMode && this.state === 'playing') this.grabMouse();
  }

  /** The room's answer to that request. */
  onSpectateMode(msg) {
    this.specMode = !!msg.on;
    this.setSpectateSwitch(this.specMode);

    if (msg.on && msg.queued) {
      this.hud.toast('Spectator mode on — it takes over at your next death', '');
      return;
    }
    if (!msg.on) {
      this.specWatching = false;
      this.specFollowId = 0;
      this.specName = null;
      this.entities.hidden = 0;
      this.entities.setXray(false);
      this.hud.setWatching(null);
      // `menu` means this player never had a seat to go back to: they turned
      // the switch on from the menu, so turning it off returns them there
      // rather than into a match they have still not asked to play.
      if (msg.menu) {
        this.state = 'spectating';
        this.specCentre({ map: this.map });
        this.hud.hide();
        this.menu.show();
      }
      this.updateSpectatorBar();
      return;
    }

    // It landed: this client no longer has a body in the world.
    this.specWatching = true;
    this.specFollowId = msg.targetId ?? 0;
    this.specName = msg.name ?? null;
    this.alive = false;
    this.deathCam = null;
    this.scoreboardPinned = false;
    this.state = 'spectating';
    this.pending.length = 0;
    this.clearProjectiles();
    this.input.enabled = false;
    this.input.unlock();
    /*
     * The HUD stays up.
     *
     * Watching used to mean a bare camera: no crosshair, no health, no map, no
     * killfeed, no board — a view of a match with nothing in it to tell you
     * what was happening. Everything below is fed from the body the camera is
     * on instead of from a body of our own (see `updateSpectatorHud`), so a
     * watcher reads the match exactly the way the player they are watching does.
     */
    this.hud.show();
    this.hud.setWatching(msg.name ?? null);
    this.hud.hideDeath();
    this.hud.setScoreboardVisible(false);
    this.entities.setXray(!!settings.specXray);
    this.hud.setSpectatorView({ firstPerson: !settings.specThirdPerson, xray: !!settings.specXray });
    // The menu is the other thing that owns this screen, and the point of the
    // mode is the view: watching somebody through a panel is not watching them.
    this.menu.hide();
    this.closeInGameMenu();
    $('pause').classList.add('hidden');
    if (msg.scoreboard) {
      this.scoreboardRows = msg.scoreboard;
      this.syncBadges(this.scoreboardRows);
    }
    // The camera has to have somewhere to fall back to when nobody is alive.
    this.specCentre({ map: this.map });
    this.updateSpectatorBar();
    this.refreshRoster();
    sfx.ui('ok');
  }

  /**
   * Moving the spectator camera.
   *
   * Its own listeners rather than the game's input map: a watcher has no body,
   * so the whole movement layer is switched off and the rebindable weapon keys
   * it would otherwise borrow mean nothing here. Left and right are the
   * gesture, on the keys, the arrows, the wheel and the mouse buttons, and the
   * bar says so — this is the only thing a spectator can do.
   */
  _bindSpectatorControls() {
    /** Watching, with nothing on top of the view. */
    const watching = () => this.specWatching && this.state === 'spectating'
      && !this.menu.visible && !this.menu.playerCardOpen;
    /** …and free to move the camera, which the pause card is not. */
    const active = () => watching() && $('pause').classList.contains('hidden');
    const cycle = (dir) => { sfx.ui(); this.net.spectate(dir); };

    const NEXT = new Set(['KeyD', 'ArrowRight', 'Space']);
    const PREV = new Set(['KeyA', 'ArrowLeft']);
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // The pause card is the only way out that is not the bar's own button:
      // settings, the class picker and LEAVE MATCH all live on it. It has to
      // answer whether it is already open or not, so it comes before `active`.
      if (e.code === 'Escape' && watching()) {
        e.preventDefault();
        this.togglePause($('pause').classList.contains('hidden'));
        return;
      }
      // The board is readable while watching for the same reason it is readable
      // while playing: it is how anybody knows what the match is doing.
      if (e.code === 'Tab' && watching()) {
        e.preventDefault();
        this.showScoreboard(!this.hud.scoreboardOpen);
        return;
      }
      if (!active()) return;
      if (NEXT.has(e.code)) { e.preventDefault(); cycle(1); }
      else if (PREV.has(e.code)) { e.preventDefault(); cycle(-1); }
      else if (e.code === 'KeyV') { e.preventDefault(); this.toggleSpectatorView(); }
      else if (e.code === 'KeyX') { e.preventDefault(); this.toggleSpectatorXray(); }
    });
    $('btnSpecView')?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSpectatorView(); });
    $('btnSpecXray')?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSpectatorXray(); });
    this.canvas.addEventListener('mousedown', (e) => {
      if (!active()) return;
      e.preventDefault();
      cycle(e.button === 2 ? -1 : 1);
    });
    this.canvas.addEventListener('contextmenu', (e) => { if (active()) e.preventDefault(); });
    window.addEventListener('wheel', (e) => {
      if (!active()) return;
      cycle(e.deltaY > 0 ? 1 : -1);
    }, { passive: true });
  }

  /**
   * The roster changed: redraw the standings, and re-check what it allows.
   *
   * The two always move together — the mini standings are the roster, and so is
   * the question of whether there is anybody in this match to watch.
   */
  refreshRoster() {
    // While watching, "your" row on the mini standings is the row of whoever
    // the camera is on — a spectator has no row of their own to highlight.
    const me = this.specWatching && this.specFollowId ? this.specFollowId : this.myId;
    this.hud.renderLiveScore(this.scoreboardRows, me, this.teamMode);
    this.updateSpectateAvailability();
  }

  /**
   * How many people this player could actually watch.
   *
   * Everybody on the board except themselves. Bots count: they are bodies in
   * the world with a point of view, and watching one is a perfectly good way to
   * see a map you have not played.
   */
  get watchableCount() {
    return (this.scoreboardRows ?? []).filter((r) => r.id !== this.myId).length;
  }

  /**
   * Greys the spectator switch out when there is nobody behind it.
   *
   * An empty match has no point of view to borrow, and a switch that turns on
   * and shows you an empty arena is worse than one that says why it cannot.
   * The exception is a watcher who is already watching: that switch is their
   * way back into the match, and it stays live however empty the room gets.
   */
  updateSpectateAvailability() {
    const box = $('specToggle');
    const label = box?.parentElement;
    const btn = $('btnPauseSpectate');
    const empty = this.watchableCount < 1 && !this.specMode;
    const why = 'nobody else is in this match to watch';

    if (box) box.disabled = empty;
    if (label) {
      label.classList.toggle('off', empty);
      if (empty) label.setAttribute('title', why);
      else label.removeAttribute('title');
    }
    if (btn) {
      btn.disabled = empty;
      if (empty) btn.setAttribute('title', why);
      else btn.removeAttribute('title');
    }
    if (empty) {
      const hint = $('specToggleHint');
      if (hint) hint.textContent = 'Nobody else is in this match yet';
    } else {
      this.setSpectateSwitch(this.specMode);
    }
  }

  /** Keeps both copies of the switch — menu and pause card — telling the truth. */
  setSpectateSwitch(on) {
    const box = $('specToggle');
    if (box) box.checked = !!on;
    const hint = $('specToggleHint');
    if (hint) {
      hint.textContent = !on
        ? "Watch the match from another player's eyes"
        : this.specWatching
          ? 'Watching — turn this off to take a seat again'
          : this.state === 'playing'
            ? 'On — the camera takes over at your next death'
            : 'On — you will watch instead of spawning';
    }
    const btn = $('btnPauseSpectate');
    if (btn) btn.textContent = on ? 'STOP SPECTATING' : 'SPECTATE INSTEAD';
  }

  /** The bar along the bottom: who the camera is on, and the way back in. */
  updateSpectatorBar() {
    const bar = $('specBar');
    if (!bar) return;
    bar.classList.toggle('hidden', !(this.specWatching && this.state === 'spectating'));
    if (!this.specWatching) return;
    const name = this.specName
      ?? (this.specFollowId ? this.entities.get(this.specFollowId)?.profile?.name ?? '—' : 'the arena');
    $('specName').textContent = name;
    this.hud.setWatching(name);
    this.hud.setSpectatorView({ firstPerson: !settings.specThirdPerson, xray: !!settings.specXray });
  }

  /** The two things a watcher can change about the view they are given. */
  toggleSpectatorView() {
    setSetting('specThirdPerson', !settings.specThirdPerson);
    this.hud.setSpectatorView({ firstPerson: !settings.specThirdPerson, xray: !!settings.specXray });
    sfx.ui();
  }

  toggleSpectatorXray() {
    setSetting('specXray', !settings.specXray);
    this.entities.setXray(!!settings.specXray && this.specWatching);
    this.hud.setSpectatorView({ firstPerson: !settings.specThirdPerson, xray: !!settings.specXray });
    sfx.ui();
  }

  /** Puts the watching camera over the middle of the map. */
  specCentre(msg) {
    const size = msg?.map?.size ?? this.map?.size ?? 96;
    this.specRadius = size * 0.30;
    this.specHeight = size * 0.16;
    this.specTarget.set(0, size * 0.045, 0);
  }

  /**
   * Slow orbit around the centre of the arena. It is a camera, not a player:
   * nobody can see it and it takes no part in the match.
   *
   * A player who asked for spectator mode gets the other version of this: the
   * target's own eyes, on the target's own aim. That is the point of the mode —
   * "sa pov et tout" — so it is a hard cut to their view rather than a chase
   * camera, with only enough smoothing to survive a 30 Hz snapshot rate. The
   * menu's backdrop keeps the old third-person orbit, which is what it is for.
   */
  updateSpectatorCamera(dt) {
    const cam = this.gfx.camera;
    if (!this.map) return;

    // Following a specific player when one has been picked, orbiting otherwise.
    const target = this.specFollowId ? this.entities.get(this.specFollowId) : null;
    const firstPerson = !settings.specThirdPerson;
    if (target && target.alive && this.specWatching && firstPerson) {
      // Their eye, not their head: the same offset the player behind that body
      // is rendering from, so the two views agree to the centimetre.
      this.specEye.set(
        target.pos.x,
        target.pos.y + (target.height ?? K.PLAYER_HEIGHT) - K.EYE_OFFSET,
        target.pos.z,
      );
      // Snap on a switch, glide otherwise: lerping across half a map on every
      // change of target is a swoop nobody asked for, and a hard cut between
      // two players a metre apart is a jolt.
      if (cam.position.distanceToSquared(this.specEye) > 64) cam.position.copy(this.specEye);
      else cam.position.lerp(this.specEye, Math.min(1, dt * 22));
      cam.rotation.set(target.pitch, target.yaw, 0, 'YXZ');
      this.entities.hidden = target.id;      // we are inside that body
      if (Math.abs(cam.fov - settings.fov) > 0.01) {
        cam.fov = settings.fov;
        cam.updateProjectionMatrix();
      }
      this.gfx.followSun(cam.position.x, cam.position.z);
      return;
    }
    this.entities.hidden = 0;

    if (target && target.alive) {
      /*
       * Over the shoulder, and never through a wall.
       *
       * The boom is traced from the head backwards and pulled in to whatever it
       * hits, so a player fighting inside a building is watched from inside it
       * rather than from the far side of the bricks. The menu's backdrop uses
       * the same branch with no target, which is why the orbit below is still
       * here untouched.
       */
      const back = this.specWatching ? 4.2 : 4.5;
      const eyeH = (target.height ?? K.PLAYER_HEIGHT) - K.EYE_OFFSET;
      const hx = Math.sin(target.yaw) * Math.cos(target.pitch);
      const hz = Math.cos(target.yaw) * Math.cos(target.pitch);
      let dist = back;
      if (this.specWatching && this.world) {
        const up = Math.sin(-target.pitch);
        const hit = this.world.raycast(
          target.pos.x, target.pos.y + eyeH, target.pos.z, hx, up, hz, back + 0.4);
        if (hit) dist = Math.max(0.6, hit.dist - 0.4);
      }
      this.tmp.set(
        target.pos.x + hx * dist,
        target.pos.y + eyeH + Math.sin(-target.pitch) * dist + 0.35,
        target.pos.z + hz * dist,
      );
      const snap = this.specWatching
        ? (cam.position.distanceToSquared(this.tmp) > 64 ? 1 : Math.min(1, dt * 14))
        : Math.min(1, dt * 4);
      cam.position.lerp(this.tmp, snap);
      cam.rotation.set(0, 0, 0);
      cam.lookAt(target.pos.x, target.pos.y + eyeH * 0.92, target.pos.z);
    } else {
      this.specAngle += dt * 0.055;
      const r = this.specRadius ?? 30;
      const bob = Math.sin(this.specAngle * 1.7) * (this.specHeight ?? 14) * 0.12;
      cam.position.set(
        Math.cos(this.specAngle) * r,
        (this.specHeight ?? 14) + bob,
        Math.sin(this.specAngle) * r,
      );
      cam.rotation.set(0, 0, 0);
      cam.lookAt(this.specTarget);
    }

    if (Math.abs(cam.fov - settings.fov) > 0.01) {
      cam.fov = settings.fov;
      cam.updateProjectionMatrix();
    }
    this.gfx.followSun(cam.position.x, cam.position.z);
  }

  /** Keeps ?game=FRA:XXXX in the address bar pointing at the current match. */
  syncUrl() {
    if (!this.roomCode) return;
    const url = `${location.pathname}?game=${encodeURIComponent(this.roomCode)}`;
    if (location.search !== `?game=${encodeURIComponent(this.roomCode)}`) {
      history.replaceState({ game: this.roomCode }, '', url);
    }
  }

  /** Adds a decaying camera shake (0-2 is the useful range). */
  addShake(amount) {
    this.shake = Math.min(2.2, this.shake + amount);
  }

  /**
   * View punch: a sharp, spring-damped camera kick that is *not* part of the
   * aim. Recoil moves where the bullets go; punch only moves what you see,
   * and it settles back to zero on its own.
   */
  addPunch(pitch, yaw) {
    this.punch.vp += pitch;
    this.punch.vy += yaw;
  }

  /** Listener frame for positional audio. */
  listener() {
    const cam = this.gfx.camera;
    const right = this.tmp.set(1, 0, 0).applyQuaternion(cam.quaternion);
    return { pos: cam.position, right: { x: right.x, z: right.z } };
  }

  /* ── Snapshots & reconciliation ────────────────────────────────────────── */

  onSnapshot(msg) {
    this.entities.pushSnapshot(msg.t, msg.p ?? []);
    if (typeof msg.h === 'number') this.health = msg.h;
    if (typeof msg.m === 'number') this.matchTime = msg.m;
    // Only a spectator is sent this, and only for the body it is watching.
    if (msg.sa) {
      // The wire says *that* they are reloading, not how far through it they
      // are; the weapon's own reload time turns the one into the other so the
      // bar under the magazine means something instead of sitting at zero.
      const wasReloading = !!this.specAmmo?.[2];
      this.specAmmo = msg.sa;
      if (msg.sa[2] && !wasReloading) {
        const e = this.entities.get(this.specFollowId);
        const w = loadoutFor(e?.profile?.classId ?? this.classId)[Math.max(0, e?.lastSlot | 0)];
        this.specReloadEnd = performance.now() / 1000 + (w?.reloadTime ?? 1);
      }
    }

    const y = msg.y;
    if (!y || !this.alive) return;

    // Drop inputs the server has already consumed.
    while (this.pending.length && this.pending[0].seq <= msg.q) this.pending.shift();

    const before = { x: this.local.x, y: this.local.y, z: this.local.z };

    // Rewind to the authoritative state, then replay everything still in flight.
    this.local.x = y[0]; this.local.y = y[1]; this.local.z = y[2];
    this.local.vx = y[3]; this.local.vy = y[4]; this.local.vz = y[5];
    this.local.onGround = !!y[6];
    this.local.height = y[7];

    for (const inp of this.pending) {
      step(this.local, inp, this.world, K.TICK_DT, { speedMult: this.speedMultFor(inp.keys) });
    }

    // Any residual error is absorbed visually instead of snapping the camera.
    const dx = before.x - this.local.x, dy = before.y - this.local.y, dz = before.z - this.local.z;
    const err = Math.hypot(dx, dy, dz);
    if (err > 0.0005 && err < 4) {
      this.smooth.set(dx, dy, dz);
    } else if (err >= 4) {
      this.smooth.set(0, 0, 0);                 // big correction: teleport, don't slide
    }
  }

  speedMultFor(keys) {
    const def = this.weapons[this.slot];
    const ads = (keys & KEY.ADS) !== 0;
    return (def.moveMult ?? 1) * (ads ? (def.adsMoveMult ?? 0.6) : 1);
  }

  /* ── Input wiring ──────────────────────────────────────────────────────── */

  _bindInput() {
    const inp = this.input;

    // A controller steers the interface as well as the game — see Menu.padNav.
    inp.on('padnav', (dir) => this.menu.padNav(dir));
    inp.on('padconnect', (on) => {
      document.body.classList.toggle('pad', on);
      this.hud.setPadHints(on);
      this.hud.toast(on ? 'Controller connected' : 'Controller disconnected', on ? 'good' : '');
    });

    inp.on('fire', () => this.tryFire());
    inp.on('reload', () => this.tryReload());
    inp.on('melee', () => this.tryMelee());
    inp.on('nuke', () => {
      if (this.state !== 'playing' || !this.alive || !this.nukeArmed) return;
      // Asked for, not done. The room decides whether the streak was really
      // there and answers with the launch everybody sees; clearing the prompt
      // here instead would leave the two disagreeing whenever it refuses.
      this.net.nuke();
    });
    inp.on('slot', (s) => this.switchSlot(s));
    inp.on('lastWeapon', () => this.switchSlot(this.prevSlot));
    inp.on('switch', (dir) => {
      if (this.state === 'spectating') return void this.net.spectate(dir);
      this.switchSlot((this.slot + dir + 3) % 3);
    });

    inp.on('scoreboard', (v) => {
      // A board you can click is a board that has to be pinned rather than
      // held, so the key toggles it and hands the mouse back. The key-up half
      // is ignored: nothing on this board is hold-to-view any more.
      if (v) this.toggleScoreboard();
    });

    inp.on('chat', () => {
      if (this.state !== 'playing' || this.hud.chatOpen) return;
      this.input.unlock();
      // openChat refuses — and says why — when the server has not cleared this
      // player to write; take the mouse straight back when it does.
      if (!this.hud.openChat((text) => {
        this.net.chat(text);
        this.grabMouse();
      })) this.grabMouse();
    });

    inp.on('classMenu', () => {
      if (this.state !== 'playing') return;
      this.input.unlock();
      this.menu.openClassModal();
    });

    inp.on('escape', () => {
      if (this.state !== 'playing') return;
      if (this.menu.classModalOpen) { this.menu.closeClassModal(); this.input.lock(); return; }
      if (this.menu.authModalOpen) {
        $('authModal').classList.add('hidden');
        if (!this.menu.visible) this.input.lock();
        return;
      }
      if (this.menu.playerCardOpen) { this.menu.closePlayerCard(); return; }
      if (this.hud.reportCardOpen) { this.hud.closeReportCard(); return; }
      if (this.inGameMenuOpen) { this.resumeMatch(); return; }
      if (this.hud.chatOpen) { this.hud.closeChat(); this.grabMouse(); return; }
      if (this.scoreboardPinned) { this.toggleScoreboard(); return; }
      // Some browsers deliver the Escape keydown *and* exit pointer lock; the
      // unlock has already opened the pause menu, so ignore the echo.
      if (performance.now() - this.pauseOpenedAt < 250) return;
      this.togglePause($('pause').classList.contains('hidden'));
    });

    inp.on('toggleMinimap', () => {
      settings.showMinimap = !settings.showMinimap;
      this.hud.applySettings();
    });
    inp.on('toggleFps', () => {
      settings.showFps = !settings.showFps;
      this.hud.applySettings();
    });

    inp.on('unlock', () => {
      if (this.state === 'playing' && !this.hud.chatOpen && !this.menu.classModalOpen
          && !this.inGameMenuOpen && !this.hud.matchEndOpen && !this.scoreboardPinned
          && !this.hud.reportCardOpen && !this.menu.playerCardOpen
          && $('pause').classList.contains('hidden')) {
        this.togglePause(true);
      }
    });

    // The jump binding still works while dead — it is how somebody who put the
    // respawn on hold with Escape gets back in without waiting for the menu.
    inp.on('keydown', (code) => {
      if (this.state !== 'playing' || this.alive || this.matchPhase !== 'live') return;
      if (!(binds.jump ?? []).includes(code)) return;
      this.respawnHeld = false;
      this.requestRespawn();
    });
  }

  /**
   * Back into the match, as soon as the server will have us.
   *
   * Called every frame while dead (see `updateHud`), so it is deliberately
   * cheap and deliberately idempotent: the request is only worth sending once
   * per death, and re-sending it every frame for the half-second a slow
   * connection takes to answer would be a flood for no reason.
   */
  requestRespawn() {
    const now = performance.now() / 1000;
    if (this.alive || now < this.respawnAt) return;
    if (now - this.respawnSentAt < 0.6) return;
    this.respawnSentAt = now;
    this.net.respawn();
  }

  _bindUi() {
    $('btnResume').addEventListener('click', () => this.togglePause(false));
    $('btnQuit').addEventListener('click', () => this.leaveMatch());

    // Clicking anywhere that is not the card puts the player straight back in.
    // The card itself stops the event so its own buttons still work.
    $('pause').addEventListener('mousedown', (e) => {
      if (e.target !== $('pause')) return;
      e.preventDefault();
      this.togglePause(false);
    });
    document.querySelector('#pause .pause-card')
      ?.addEventListener('mousedown', (e) => e.stopPropagation());

    // The canvas is the other half of that gesture: a click on the world while
    // paused is a request to play, not a stray click.
    this.canvas.addEventListener('mousedown', () => {
      if (this.state !== 'playing' || this.input.locked) return;
      this.togglePause(false);
    });

    // Settings mid-match no longer disconnects — the score survives.
    // Both copies of the spectator switch drive the same request; the room is
    // what decides when it lands.
    $('specToggle')?.addEventListener('change', (e) => {
      sfx.ui();
      this.requestSpectateMode(e.target.checked);
    });
    $('btnPauseSpectate')?.addEventListener('click', () => {
      sfx.ui();
      const want = !this.specMode;
      this.requestSpectateMode(want);
      // Turning it on from the pause card means going back to the match you are
      // still in; turning it off is answered by the seat the server hands back.
      if (want && this.state === 'playing') this.togglePause(false);
    });
    $('btnSpecJoin')?.addEventListener('click', () => {
      sfx.ui('ok');
      this.requestSpectateMode(false);
    });
    this._bindSpectatorControls();

    $('btnPauseSettings').addEventListener('click', () => this.openInGameMenu('settings'));
    $('btnPauseClass').addEventListener('click', () => {
      $('pause').classList.add('hidden');
      this.menu.openClassModal();
    });
    $('btnBackToMatch').addEventListener('click', () => this.resumeMatch());
    $('banRetry').addEventListener('click', () => this.clearBan(true));
    $('banDismiss').addEventListener('click', () => this.clearBan(false));
    $('gateAction').addEventListener('click', () => this.clearGate(true));
    $('gateDismiss').addEventListener('click', () => this.clearGate(false));
    window.addEventListener('resize', () => this.viewmodel.resize());
    window.addEventListener('beforeunload', () => this.net.disconnect());
  }

  /** Closes every overlay and puts the player back in control. */
  resumeMatch() {
    // A watcher gets this too: BACK TO MATCH after opening the settings from
    // the pause card has to give them their view back, and `grabMouse` below
    // already knows not to hand a spectator a pointer lock.
    const watching = this.state === 'spectating' && this.specWatching;
    if (this.state !== 'playing' && !watching) return;
    this.closeInGameMenu();
    this.menu.hide();
    this.menu.closeClassModal();
    $('pause').classList.add('hidden');
    this.updateSpectatorBar();
    this.grabMouse();
  }

  /**
   * Takes the mouse back, unless something on screen still needs it — the
   * end-of-match card in particular, whose map vote is a set of real buttons.
   */
  grabMouse() {
    // A watcher has no body to aim; locking the pointer for one would trap the
    // cursor behind a camera nobody is driving.
    if (this.state !== 'playing') return;
    if (this.banned || this.hud.matchEndOpen || this.hud.chatOpen || this.scoreboardPinned) return;
    if (this.menu.visible || this.menu.classModalOpen || this.menu.authModalOpen) return;
    if (this.menu.playerCardOpen || this.hud.reportCardOpen) return;
    this.input.lock();
  }

  togglePause(on, silent = false) {
    if (!on && this.banned) return;                  // nothing to go back to
    $('pause').classList.toggle('hidden', !on);
    if (on) { this.pauseOpenedAt = performance.now(); this.input.unlock(); }
    else if (!silent) this.grabMouse();
    /*
     * The pause card is the hold on an automatic respawn.
     *
     * Death puts you back in the match on its own; Escape in the seconds before
     * it lands is how somebody says "not yet" — to change class, to read the
     * board, to walk away from the desk. Opening the card is that request and
     * closing it is the answer, which is why this lives here rather than in the
     * Escape handler: every other thing Escape closes is already a reason to
     * stay down while it is open, and none of them should keep you down after.
     */
    if (on) { if (!this.alive) this.respawnHeld = true; }
    else this.respawnHeld = false;
  }


  /**
   * Copies the badges off a set of scoreboard rows onto the entities that wear
   * them. The nametag redraws itself when any of them changes, so a player who
   * joins or leaves a clan stops wearing the old tag without reconnecting.
   */
  syncBadges(rows) {
    for (const r of rows ?? []) {
      const e = this.entities.get(r.id);
      if (!e?.profile) continue;
      e.profile.clan = r.clan ?? null;
      e.profile.clanVerified = !!r.clanVerified;
      e.profile.verified = !!r.verified;
      e.profile.level = r.level ?? e.profile.level;
    }
  }

  showScoreboard(v) {
    this.hud.setScoreboardVisible(v);
    if (v) this.hud.renderScoreboard(this.scoreboardRows, this.myId, this.mapName, this.modeName, this.teamMode);
  }

  /**
   * The scoreboard: open, mouse free, everything on it clickable — press the
   * key (or Escape) again to close it and go back to playing.
   *
   * It used to be held-to-view for everyone except staff and reporters. Every
   * nickname on it now opens that player's profile, so there is no version of
   * the board left that is purely something to read, and pinning it is what
   * makes the mute and report buttons reachable at all.
   */
  toggleScoreboard() {
    // The card asks about a row on this board; closing one closes the other.
    this.hud.closeReportCard();
    this.showScoreboard(!this.hud.scoreboardOpen);
    // The end-of-match card refuses to stack a second board on itself, so the
    // pin follows what actually happened rather than what was asked for —
    // otherwise a key pressed over that card would hold the mouse hostage.
    this.scoreboardPinned = this.hud.scoreboardOpen;
    if (this.scoreboardPinned) this.input.unlock();
    else this.grabMouse();
  }

  requestClass(classId) {
    // `null` means the picker was dismissed without choosing.
    if (classId) this.net.setClass(classId);
    if (this.state === 'playing') this.resumeMatch();
  }

  setClass(classId) {
    this.classId = classId;
    this.menu?.setLoadoutCard(classId);
    this.weapons = loadoutFor(classId);
    this.skin = api.account?.loadout?.skins?.[classId] ?? 'default';
    for (let i = 0; i < this.weapons.length; i++) {
      this.ammo[i] = this.weapons[i].magSize ?? 0;
      this.reserve[i] = -1;
    }
    this.slot = 0;
    this.reloading = false;
    this.burst = 0;
    this.viewmodel.setWeapon(this.weapons[0], this.skin);
  }

  switchSlot(slot) {
    if (slot === this.slot || slot < 0 || slot > 2 || !this.alive) return;
    this.prevSlot = this.slot;
    this.slot = slot;
    this.reloading = false;
    this.burst = 0;
    this.lastShotAt = performance.now() / 1000 - 0.1;
    this.viewmodel.setWeapon(this.weapons[slot], this.skin);
    this.net.switchSlot(slot);
    sfx.switchWeapon();
  }

  /* ── Firing ────────────────────────────────────────────────────────────── */

  get weapon() { return this.weapons[this.slot]; }

  /**
   * Bloom decays with time spent *not* firing — the exact rule the server
   * uses, so the cone the client draws and the cone the server tests never
   * diverge. Holding the trigger keeps the cone open; letting go closes it in
   * about a second.
   */
  currentBurst(now) {
    const w = this.weapon;
    const idle = now - this.lastShotAt - shotInterval(w);
    if (idle <= 0) return this.burst;
    return Math.max(0, this.burst - idle * (w.bloomRecover ?? 12));
  }

  tryFire() {
    if (this.state !== 'playing' || !this.alive || this.hud.chatOpen) return;
    if (this.matchPhase !== 'live' && !this.practice) return;
    const w = this.weapon;
    if (w.melee) return this.tryMelee();

    const now = performance.now() / 1000;
    if (this.reloading || now < this.pumpUntil) return;
    if (now - this.lastShotAt < shotInterval(w)) return;

    if (this.ammo[this.slot] <= 0) {
      sfx.dryFire();
      if (settings.autoReload) this.tryReload();
      return;
    }

    const burst = this.currentBurst(now);
    this.lastShotAt = now;
    this.ammo[this.slot]--;
    this.burst = burst + 1;
    if (w.boltTime) {
      this.pumpUntil = now + w.boltTime;
      setTimeout(() => sfx.cycle(), Math.max(60, w.boltTime * 380));
    }

    const seq = ++this.shotSeq;
    const ads = this.input.ads;
    this.net.shoot(this.input.yaw, this.input.pitch, ads, seq, Math.round(burst));

    // Local prediction of the exact rays the server will test.
    const spread = spreadFor(w, {
      moving: Math.hypot(this.local.vx, this.local.vz) > 1.5,
      airborne: !this.local.onGround,
      ads,
      crouching: this.local.crouching,
      burst,
    });
    const dirs = shotDirections(this.input.yaw, this.input.pitch, spread, shotSeed(this.myId, seq), w.pellets ?? 1);
    const muzzle = this.muzzleWorld(ads);

    if (!w.projectile) {
      // Only every third round leaves a visible trail, the way real tracers work.
      for (let i = 0; i < dirs.length; i++) {
        this.traceAndDraw(muzzle, dirs[i], w, (w.pellets ?? 1) > 1 || this.shotSeq % 3 === 0);
      }
    }
    this.practiceShots++;

    // A flash in the world too, so the light lands on the map around us.
    const fd = dirs[0] ?? { x: 0, y: 0, z: -1 };
    this.effects.muzzleFlash(
      muzzle.x + fd.x * 0.25, muzzle.y + fd.y * 0.25, muzzle.z + fd.z * 0.25,
      w.pellets > 1 || w.projectile ? 1.5 : 1, fd);
    this.gfx.post.addFlash(0.05 + (w.recoil?.up ?? 0.02) * 1.2, 0xffe0a8);

    this.viewmodel.fire();
    sfx.shot(w.sound, null, null);

    const kick = recoilKick(w, Math.round(burst) + 1);
    const adsScale = ads ? 0.62 : 1;
    if (settings.recoilRecovery) {
      this.input.addRecoil(kick.pitch * adsScale, kick.yaw * adsScale);
    } else {
      this.input.pitch = Math.min(Math.PI / 2 - 0.001, this.input.pitch + kick.pitch * adsScale);
      this.input.yaw += kick.yaw * adsScale;
    }
    this.addPunch(kick.pitch * 22 * adsScale, kick.yaw * 16 * adsScale);
    this.addShake(Math.min(0.35, (w.recoil?.up ?? 0.02) * 3.4));

    if (this.ammo[this.slot] === 0 && settings.autoReload) setTimeout(() => this.tryReload(), 120);
  }

  /** Raycasts one pellet against the map and remote players, drawing the result. */
  traceAndDraw(from, dir, w, drawTracer = true) {
    let hitPlayer = false, normal = null, surface = 'concrete';
    const wall = this.world.raycast(from.x, from.y, from.z, dir.x, dir.y, dir.z, K.MAX_SHOT_RANGE);
    let best = wall ? wall.dist : K.MAX_SHOT_RANGE;
    if (wall) {
      normal = { nx: wall.nx, ny: wall.ny, nz: wall.nz };
      surface = wall.mat ?? this.map?.ground?.mat ?? 'concrete';
    }

    for (const e of this.entities.players.values()) {
      if (!e.alive) continue;
      if (this.teamMode && e.profile.team === this.myTeam) continue;
      const t = rayAabb(from, dir,
        e.pos.x - 0.46, e.pos.y, e.pos.z - 0.46,
        e.pos.x + 0.46, e.pos.y + e.height, e.pos.z + 0.46, best);
      if (t >= 0 && t < best) { best = t; hitPlayer = true; normal = null; }
    }

    // Practice targets are local props: hitting one is feedback, not score.
    for (const t of this.targets) {
      const d = rayAabb(from, dir,
        t.x - 0.55, t.y - 0.8, t.z - 0.1, t.x + 0.55, t.y + 0.8, t.z + 0.1, best);
      if (d >= 0 && d < best) {
        best = d;
        hitPlayer = true;
        normal = null;
        t.hitAt = performance.now() / 1000;
        this.practiceHits++;
        this.hud.hitmarker(false, false);
        sfx.hitmarker(false, false);
      }
    }

    const end = { x: from.x + dir.x * best, y: from.y + dir.y * best, z: from.z + dir.z * best };
    if (drawTracer) {
      this.effects.tracer(from, end, {
        width: w.id === 'sniper' ? 0.05 : 0.03,
        life: w.id === 'sniper' ? 0.11 : 0.07,
        bright: w.id === 'sniper' ? 1.3 : 1,
      });
    }
    if (!hitPlayer && normal) {
      this.effects.impact(end.x, end.y, end.z, normal.nx, normal.ny, normal.nz, surface);
      sfx.impact(end, this.listener(), surface);
    }
  }

  /** Approximate world-space muzzle position for the local viewmodel. */
  muzzleWorld(ads) {
    const cam = this.gfx.camera;
    const off = ads ? { x: 0, y: -0.03, z: -0.7 } : { x: 0.2, y: -0.14, z: -0.7 };
    return this.tmp.set(off.x, off.y, off.z).applyMatrix4(cam.matrixWorld).clone();
  }

  /** Turns a viewmodel-space ejection into a world-space casing. */
  ejectShell(localPos, localVel, scale) {
    const cam = this.gfx.camera;
    const p = this.tmp.copy(localPos).applyMatrix4(cam.matrixWorld);
    const v = this.tmp2.copy(localVel).applyQuaternion(cam.quaternion);
    this.effects.ejectShell(
      p.x, p.y, p.z,
      v.x + this.local.vx * 0.55, v.y + Math.max(0, this.local.vy) * 0.4, v.z + this.local.vz * 0.55,
      scale,
    );
  }

  /** Reload audio, staged to line up with the animation. */
  scheduleReloadSounds(duration, fromEmpty) {
    const kind = this.weapon.kind;
    sfx.reload('out');
    if (kind === 'shotgun') {
      for (let i = 1; i <= 5; i++) setTimeout(() => sfx.reload('in'), duration * 1000 * (i / 6));
      setTimeout(() => sfx.cycle(), duration * 1000 * 0.93);
      return;
    }
    setTimeout(() => sfx.reload('in'), duration * 520);
    if (fromEmpty || kind === 'revolver' || kind === 'rpg') {
      setTimeout(() => sfx.reload('charge'), duration * 820);
    }
  }

  tryMelee() {
    if (!this.alive || this.state !== 'playing') return;
    const now = performance.now() / 1000;
    if (now - this.lastMeleeAt < K.MELEE_COOLDOWN) return;
    this.lastMeleeAt = now;
    this.net.melee();
    // The swing fills most of the cooldown, so the blade is home again just
    // before the next one can start rather than snapping back and waiting.
    this.viewmodel.meleeSwing(K.MELEE_COOLDOWN * 0.82);
    this.addPunch(2.4, (Math.random() * 2 - 1) * 3.5);
    sfx.shot({ ...this.weapons[2].sound, gain: 0.35 }, null, null);
  }

  tryReload() {
    if (!this.alive || this.reloading) return;
    const w = this.weapon;
    // Reserves are unlimited (-1); only a full magazine blocks a reload.
    if (w.melee || this.ammo[this.slot] >= w.magSize || this.reserve[this.slot] === 0) return;
    this.net.reload();
  }

  /* ── Remote fire effects ───────────────────────────────────────────────── */

  onRemoteShot(msg) {
    const e = this.entities.get(msg.id);
    const from = { x: msg.x, y: msg.y, z: msg.z };

    if (msg.projectile) {
      // The drop comes off the weapon rather than out of a literal here: the
      // server steps the real rocket with `projectile.gravity`, and a client
      // guessing a different number draws it somewhere it is not.
      const rpg = weaponById(msg.w) ?? getClass('rocketeer').primary;
      this.projectiles.push({
        id: msg.projectile, x: msg.x, y: msg.y, z: msg.z,
        vx: msg.vx, vy: msg.vy, vz: msg.vz, life: 6,
        gravity: rpg.projectile?.gravity ?? 2.5,
        mesh: this.spawnRocketMesh(msg.x, msg.y, msg.z),
      });
      sfx.shot(getClass('rocketeer').primary.sound, from, this.listener());
      return;
    }

    if (msg.melee) {
      sfx.shot({ ...weaponById('knife').sound, gain: 0.3 }, from, this.listener());
      this.entities.meleeSwing(msg.id);
      return;
    }

    const def = weaponById(msg.w);
    if (def) sfx.shot(def.sound, from, this.listener());
    // A tiny visible kick, on whichever weapon they are actually holding.
    if (e) {
      const held = e.group.userData.guns[e.lastSlot] ?? e.group.userData.gun;
      held.position.z -= 0.06;
    }
    // Flash at the shooter's barrel, a little ahead of their eye.
    const fd = { x: -Math.sin(msg.yaw ?? 0), y: Math.sin(msg.pitch ?? 0), z: -Math.cos(msg.yaw ?? 0) };
    this.effects.muzzleFlash(from.x + fd.x * 0.9, from.y + fd.y * 0.9 - 0.15, from.z + fd.z * 0.9,
      def?.id === 'shotgun' || def?.id === 'rpg' ? 1.6 : 1.1, fd);
    if (def?.shell) {
      this.effects.ejectShell(
        from.x + fd.x * 0.2, from.y - 0.12, from.z + fd.z * 0.2,
        fd.z * 2.4 + (Math.random() - 0.5), 1.8 + Math.random(), -fd.x * 2.4 + (Math.random() - 0.5),
        def.shell.size ?? 1);
    }

    // Recreate the shooter's rays so the tracer matches what the server tested.
    const dirs = shotDirections(msg.yaw ?? 0, msg.pitch ?? 0, msg.spread ?? 0,
      shotSeed(msg.id, msg.seq ?? 0), def?.pellets ?? 1);
    const eye = { x: this.local.x, y: eyeY(this.local), z: this.local.z };
    let closest = Infinity;

    for (const d of dirs) {
      const wall = this.world.raycast(from.x, from.y, from.z, d.x, d.y, d.z, K.MAX_SHOT_RANGE);
      let best = wall ? wall.dist : 90;
      const surface = wall?.mat ?? 'concrete';
      let hitBody = false;
      for (const other of this.entities.players.values()) {
        if (!other.alive || other.id === msg.id) continue;
        const t = rayAabb(from, d,
          other.pos.x - 0.46, other.pos.y, other.pos.z - 0.46,
          other.pos.x + 0.46, other.pos.y + other.height, other.pos.z + 0.46, best);
        if (t >= 0 && t < best) { best = t; hitBody = true; }
      }
      // Also stop at the local player, so incoming fire visibly reaches us.
      const tMe = rayAabb(from, d,
        this.local.x - 0.46, this.local.y, this.local.z - 0.46,
        this.local.x + 0.46, this.local.y + this.local.height, this.local.z + 0.46, best);
      if (tMe >= 0 && tMe < best) { best = tMe; hitBody = true; }

      // How near did it pass? A close round snaps as it goes by.
      const miss = pointRayDistance(eye, from, d, best);
      if (miss < closest) closest = miss;

      this.effects.tracer(from, {
        x: from.x + d.x * best, y: from.y + d.y * best, z: from.z + d.z * best,
      }, { width: 0.028, life: 0.07 });
      if (!hitBody && wall && best === wall.dist) {
        this.effects.impact(
          from.x + d.x * best, from.y + d.y * best, from.z + d.z * best,
          wall.nx, wall.ny, wall.nz, surface);
      }
    }

    if (this.alive && closest < WHIZZ_RADIUS) {
      const right = this.tmp.set(1, 0, 0).applyQuaternion(this.gfx.camera.quaternion);
      const dx = from.x - eye.x, dz = from.z - eye.z;
      const len = Math.hypot(dx, dz) || 1;
      sfx.whizz(clamp((dx * right.x + dz * right.z) / len, -1, 1) * -1, 1 - closest / WHIZZ_RADIUS);
    }
  }

  spawnRocketMesh(x, y, z) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.11, 0.6, 8),
      new THREE.MeshPhongMaterial({ color: 0x6b3f22, shininess: 20 }),
    );
    body.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.11, 0.24, 8),
      new THREE.MeshPhongMaterial({ color: 0x53301a, shininess: 20 }),
    );
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = -0.4;
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.1, 0.5, 7),
      new THREE.MeshBasicMaterial({ color: 0xffb457, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }),
    );
    flame.rotation.x = Math.PI / 2;
    flame.position.z = 0.55;
    group.add(body, tip, flame);
    group.position.set(x, y, z);
    this.gfx.scene.add(group);
    return group;
  }

  /**
   * Takes one rocket out of the world, mesh and all.
   *
   * Every way a projectile can end goes through here — it went off, it timed
   * out, the match rotated, the player left. There used to be three of them and
   * only one remembered the scene graph.
   */
  despawnProjectile(id) {
    const i = this.projectiles.findIndex((p) => p.id === id);
    if (i < 0) return;
    this.disposeProjectile(this.projectiles[i]);
    this.projectiles.splice(i, 1);
  }

  disposeProjectile(p) {
    if (!p?.mesh) return;
    this.gfx.scene.remove(p.mesh);
    p.mesh.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }

  /** Every rocket in the air at once — a map change, a disconnect, a new round. */
  clearProjectiles() {
    for (const p of this.projectiles) this.disposeProjectile(p);
    this.projectiles.length = 0;
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.vy -= (p.gravity ?? 2.5) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.life -= dt;
      p.mesh.position.set(p.x, p.y, p.z);
      p.mesh.lookAt(p.x + p.vx, p.y + p.vy, p.z + p.vz);
      this.effects.rocketTrail(p.x, p.y, p.z);
      if (p.life <= 0) {
        this.disposeProjectile(p);
        this.projectiles.splice(i, 1);
      }
    }
  }

  /* ── Main loop ─────────────────────────────────────────────────────────── */

  loop(now) {
    requestAnimationFrame(this._frame);
    let dt = Math.min(0.1, (now - this.lastFrame) / 1000);

    // Optional frame cap: skip the frame rather than busy-wait for it.
    const cap = settings.fpsLimit | 0;
    if (cap > 0) {
      this.frameBudget += dt;
      if (this.frameBudget < 1 / cap - 0.0008) { this.lastFrame = now; return; }
      dt = this.frameBudget;
      this.frameBudget = 0;
    }
    this.lastFrame = now;

    // The controller is polled on every frame, in the match *and* in the menu:
    // one path drives the game, the other steers the interface, and a pad that
    // only worked once you were already playing would be a pad you could never
    // press PLAY with.
    const playing = this.state === 'playing';
    this.input.aimAssist = playing ? this.aimAssistAmount() : 0;
    this.input.pollPad(dt, playing);
    // A pad plugged in before the page loaded fires no connect event, so the
    // hints follow the first *use* rather than the arrival.
    if (this.input.padActive !== this._padHinted) {
      this._padHinted = this.input.padActive;
      document.body.classList.toggle('pad', this._padHinted);
      this.hud.setPadHints(this._padHinted);
    }

    if (this.state !== 'playing') {
      // The menu sits on top of a live match: keep drawing it.
      if (this.map) {
        // Bodies first, camera second: in spectator mode the camera *is* one of
        // those bodies, and reading its position before this frame interpolated
        // it leaves the view a frame behind everything in it.
        if (this.net.connected) this.updateRemote(dt);
        this.updateSpectatorCamera(dt);
        this.effects.update(dt, this.gfx.camera);
        this.objectives.update(dt, this.gfx.camera);
      }
      // A watcher gets the whole interface, drawn from the body they are on.
      if (this.specWatching) this.updateSpectatorHud(dt);
      else this.updateNukeCountdown(performance.now() / 1000);
      this.menu.tickStats(dt, this.net.rtt * 1000);
      this.gfx.render(dt);
      return;
    }

    this.input.applyLook();
    this.viewmodel.addLookLag(this.input.lookDelta.yaw, this.input.lookDelta.pitch);

    // Recoil walks back down once the trigger has been quiet for a moment.
    const nowSec = performance.now() / 1000;
    if (settings.recoilRecovery && !this.input.mouse.left
        && nowSec - this.lastShotAt > RECOVER_DELAY) {
      this.input.recoverRecoil(dt, recoilRecovery(this.weapon) * 0.16);
    }

    // Fixed-step prediction
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= K.TICK_DT && steps < 5) {
      this.simulateTick();
      this.accumulator -= K.TICK_DT;
      steps++;
    }
    if (steps === 5) this.accumulator = 0;

    // Send batched input at roughly the snapshot rate
    this.inputFlushAcc += dt;
    if (this.inputFlushAcc >= K.SNAPSHOT_DT) {
      this.inputFlushAcc = 0;
      this.net.flushInputs();
    }

    // Held-trigger automatic fire
    if (this.input.mouse.left && this.weapon.auto) this.tryFire();

    this.updateCamera(dt);
    this.updateRemote(dt);
    this.updateProjectiles(dt);
    this.updateTargets(dt);
    this.effects.update(dt, this.gfx.camera);
    this.objectives.update(dt, this.gfx.camera);
    this.viewmodel.update(dt, {
      speed: Math.hypot(this.local.vx, this.local.vz),
      grounded: this.local.onGround,
      ads: this.input.ads,
      sliding: this.local.sliding,
      scoped: this.weapon.scope && this.input.ads,
    });

    this.updateHud(dt);
    this.updateNukeCountdown(nowSec);

    this.gfx.followSun(this.local.x, this.local.z);
    this.gfx.render(dt, () => this.viewmodel.render());
  }

  simulateTick() {
    const keys = this.alive ? this.input.sample() : 0;
    const seq = ++this.seq;
    /*
     * `prev` is what jump and slide are edge-triggered off (shared/movement.js),
     * and it is recorded *on the input* rather than left in the movement state
     * on purpose. Every snapshot rewinds to the server's state and replays
     * whatever is still in flight — and a replay that read the state's own copy
     * would be comparing the first replayed input against the last one, which
     * swallows exactly the fresh press that is still in flight. Carrying it per
     * input makes the replay reproduce the presses instead of eating them.
     */
    const inp = { seq, keys, prev: this.prevKeys ?? 0, yaw: this.input.yaw, pitch: this.input.pitch };
    this.prevKeys = keys;

    this.pending.push(inp);
    if (this.pending.length > 200) this.pending.shift();
    this.net.queueInput(seq, keys, inp.yaw, inp.pitch);

    if (!this.alive) return;

    const wasGrounded = this.local.onGround;
    const wasSliding = this.local.sliding;
    step(this.local, inp, this.world, K.TICK_DT, { speedMult: this.speedMultFor(keys) });

    // Local-only feedback the server doesn't need to tell us about.
    if (this.local.landed) {
      const hard = this.local.fallSpeed > 15;
      sfx.land(hard, this.groundSurface);
      this.viewmodel.land(hard);
      if (hard) {
        this.effects.dust(this.local.x, this.local.y, this.local.z, 9, dustColor(this.groundSurface));
        this.addShake(0.25);
      }
    }
    if (!wasGrounded && this.local.onGround) this.footstepAcc = 0;
    if (wasGrounded && !this.local.onGround && this.local.vy > 1) sfx.jump();
    if (!wasSliding && this.local.sliding) {
      sfx.slide();
      this.effects.dust(this.local.x, this.local.y, this.local.z, 8, dustColor(this.groundSurface));
    }
    if (this.local.sliding && Math.random() < 0.28) {
      this.effects.dust(this.local.x, this.local.y, this.local.z, 1, dustColor(this.groundSurface));
    }

    const speed = Math.hypot(this.local.vx, this.local.vz);
    if (this.local.onGround && speed > 2 && !this.local.sliding) {
      this.footstepAcc += speed * K.TICK_DT;
      if (this.footstepAcc > 3.1) {
        this.footstepAcc = 0;
        sfx.footstep(speed > 10, this.groundSurface);
      }
    }
  }

  /** What are we standing on? Refreshed a few times a second, not per frame. */
  updateGroundSurface(nowSec) {
    if (!this.world || nowSec - this.surfaceCheckAt < 0.25) return;
    this.surfaceCheckAt = nowSec;
    const hit = this.world.raycast(this.local.x, this.local.y + 0.3, this.local.z, 0, -1, 0, 1.2);
    this.groundSurface = hit?.mat ?? this.map?.ground?.mat ?? 'concrete';
  }

  updateTargets(dt) {
    if (!this.targets.length) return;
    const now = performance.now() / 1000;
    for (const t of this.targets) {
      if (!t.mesh) continue;
      const since = now - t.hitAt;
      // A struck target tips back and swings home — instant, honest feedback.
      t.mesh.rotation.x = since < 0.6 ? Math.sin(since * 12) * Math.max(0, 0.6 - since) * 1.4 : 0;
      t.mesh.material.emissive?.setScalar(since < 0.2 ? (0.2 - since) * 2 : 0);
    }
  }

  updateCamera(dt) {
    const cam = this.gfx.camera;

    // Absorb prediction error over ~120 ms instead of snapping.
    this.smooth.multiplyScalar(Math.max(0, 1 - dt * 9));
    if (this.smooth.lengthSq() < 1e-8) this.smooth.set(0, 0, 0);

    if (!this.alive && this.deathCam) {
      const target = this.entities.get(this.deathCam.targetId);
      if (target) {
        const from = this.tmp.set(this.local.x, this.local.y + 1.4, this.local.z);
        const over = this.tmp2.set(target.pos.x, target.pos.y + 3.2, target.pos.z);
        cam.position.lerp(over.lerp(from, 0.55), Math.min(1, dt * 3));
        cam.lookAt(target.pos.x, target.pos.y + 1.2, target.pos.z);
        return;
      }
    }

    cam.position.set(
      this.local.x + this.smooth.x,
      eyeY(this.local) + this.smooth.y,
      this.local.z + this.smooth.z,
    );

    // Screen shake: decays fast, never fights the aim.
    if (this.shake > 0.0005) {
      this.shake = Math.max(0, this.shake - dt * 3.4);
      if (settings.screenShake) {
        const t = performance.now() / 90 + this.shakeSeed;
        const a = this.shake * 0.075;
        cam.position.x += Math.sin(t * 1.7) * a;
        cam.position.y += Math.sin(t * 2.3) * a;
        cam.position.z += Math.cos(t * 1.3) * a;
      }
    } else {
      this.shake = 0;
    }

    // View punch: a stiff spring that settles back to zero on its own.
    const stiff = 190, damp = 21;
    this.punch.vp += (-this.punch.pitch * stiff - this.punch.vp * damp) * dt;
    this.punch.vy += (-this.punch.yaw * stiff - this.punch.vy * damp) * dt;
    this.punch.pitch += this.punch.vp * dt;
    this.punch.yaw += this.punch.vy * dt;

    // A little strafe roll — subtle, but it sells the speed.
    const strafe = this.input.strafeAxis;
    const targetRoll = -strafe * 0.021 - (this.local.sliding ? 0.055 : 0);
    this.viewRoll += (targetRoll - this.viewRoll) * Math.min(1, dt * 8);

    cam.rotation.set(
      this.input.pitch + this.punch.pitch * 0.02,
      this.input.yaw + this.punch.yaw * 0.02,
      this.viewRoll,
      'YXZ',
    );

    // FOV: base, narrowed by ADS, widened slightly by speed.
    const w = this.weapon;
    const ads = this.input.ads;
    const speed = Math.hypot(this.local.vx, this.local.vz);
    const speedBoost = clamp((speed - K.BASE_SPEED) * 0.6, 0, 10);
    const target = ads ? (w.adsFov ?? 55) : settings.fov + speedBoost;
    const rate = ads ? 1 / Math.max(0.05, w.adsTime ?? 0.2) : 6;
    this.fovCurrent += (target - this.fovCurrent) * Math.min(1, dt * rate * 3.2);
    if (Math.abs(cam.fov - this.fovCurrent) > 0.01) {
      cam.fov = this.fovCurrent;
      cam.updateProjectionMatrix();
    }

    this.input.sensScale = ads ? settings.adsSensitivity : 1;
  }

  /**
   * How much to slow the look stick this frame, 0-1.
   *
   * The crosshair being *on* a target is the whole test — nothing is pulled
   * anywhere, and an empty screen slows nothing. The cone is the angle the
   * body actually subtends at its distance, so the assist is generous across a
   * room and nearly nothing at forty metres, which is where a mouse's advantage
   * is real and a magnet would be indistinguishable from an aimbot.
   *
   * Only enemies the client can genuinely see count: `visible` is the same
   * line-of-sight test that gates nametags, so this can no more reveal a player
   * through a wall than a nameplate can.
   */
  aimAssistAmount() {
    const amount = settings.gamepadAimAssist ?? 0;
    if (amount <= 0 || !this.alive || !this.input.padActive) return 0;
    const cam = this.gfx.camera;
    cam.getWorldDirection(this.aimFwd);
    let best = 0;
    for (const e of this.entities.players.values()) {
      if (!e.alive || !e.visible) continue;
      if (this.teamMode && e.profile.team === this.myTeam) continue;
      const to = this.aimTo.set(e.pos.x, e.pos.y + e.height * 0.6, e.pos.z).sub(cam.position);
      const dist = to.length();
      if (dist < 0.6 || dist > 120) continue;
      to.multiplyScalar(1 / dist);
      const dot = to.dot(this.aimFwd);
      if (dot <= 0) continue;
      const cone = Math.atan2(0.85, dist) + 0.015;
      const ang = Math.acos(Math.min(1, dot));
      if (ang >= cone) continue;
      const t = 1 - ang / cone;
      if (t > best) best = t;
    }
    return best * amount;
  }

  updateRemote(dt) {
    // Render remote entities INTERP_DELAY behind the server clock.
    const target = this.net.serverTime - K.INTERP_DELAY * 1000;
    if (this.renderTime === 0) this.renderTime = target;
    this.renderTime += dt * 1000;
    this.renderTime += (target - this.renderTime) * Math.min(1, dt * 3.5);
    this.entities.update(this.renderTime, dt, {
      camera: this.gfx.camera,
      world: this.world,
      nowSec: performance.now() / 1000,
    });
  }

  updateHud(dt) {
    const w = this.weapon;
    const nowSec = performance.now() / 1000;

    this.updateGroundSurface(nowSec);
    if (this.reloading && nowSec >= this.reloadEnd) this.reloading = false;
    if (!this.alive) {
      // Anything on screen that wants the mouse is a reason to stay down: the
      // class picker, the scoreboard, the end card. Pressing Escape is the
      // deliberate version of the same thing.
      const busy = this.respawnHeld || this.inGameMenuOpen || this.hud.chatOpen
        || this.menu.classModalOpen || this.menu.visible || this.hud.matchEndOpen
        || this.scoreboardPinned || !$('pause').classList.contains('hidden');
      this.hud.updateDeathTimer(this.respawnAt - nowSec, busy);
      if (!busy && this.matchPhase === 'live') this.requestRespawn();
    }
    if (this.matchEndAt > nowSec) this.hud.updateMatchEndTimer(this.matchEndAt - nowSec);

    // The last ten seconds tick audibly.
    if (this.matchTime >= 0 && this.matchTime <= 10) {
      const s = Math.ceil(this.matchTime);
      if (s !== this.lastTickSecond) { this.lastTickSecond = s; sfx.tick(s <= 5); }
    } else {
      this.lastTickSecond = -1;
    }

    const spread = spreadFor(w, {
      moving: Math.hypot(this.local.vx, this.local.vz) > 1.5,
      airborne: !this.local.onGround,
      ads: this.input.ads,
      crouching: this.local.crouching,
      burst: this.currentBurst(nowSec),
    });

    this.hud.update({
      health: this.health,
      ammo: this.ammo[this.slot],
      reserve: this.reserve[this.slot],
      weapon: w,
      slot: this.slot,
      reloading: this.reloading,
      reloadFrac: this.reloading ? clamp(1 - (this.reloadEnd - nowSec) / Math.max(0.05, w.reloadTime ?? 1), 0, 1) : 0,
      spread,
      ads: this.input.ads,
      scoped: w.scope && this.input.ads && this.viewmodel.adsAmount > 0.85,
      matchTime: this.matchTime,
      teamScore: this.teamScore,
      teamMode: this.teamMode,
      ping: this.net.rtt * 1000,
      name: this.myName,
      level: this.myLevel,
      verified: this.myVerified,
      speed: Math.hypot(this.local.vx, this.local.vz),
      grounded: this.local.onGround,
      alive: this.alive,
      accuracy: this.practiceShots ? Math.round((this.practiceHits / this.practiceShots) * 100) : 0,
      practice: this.practice,
    }, dt);

    if (this.hud.scoreboardOpen) {
      this.hud.renderScoreboard(this.scoreboardRows, this.myId, this.mapName, this.modeName, this.teamMode);
    }
    this.hud.drawMinimap(
      { x: this.local.x, z: this.local.z, yaw: this.input.yaw },
      this.entities.players.values(), this.teamMode, this.myTeam, nowSec,
      this.objectives.state);
  }

  /**
   * The same HUD, filled in from somebody else.
   *
   * Every readout on screen is fed the watched player's numbers: their health,
   * their magazine, their weapon and class, their name and level, their place
   * on the minimap, their crosshair. The pieces that belong to the match rather
   * than to a person — the clock, the killfeed, the standings, the chat — are
   * already the same for everybody and simply keep drawing.
   *
   * With nobody to watch (everybody dead, an empty room) it still runs: the
   * clock and the board are the two things worth having in front of a camera
   * orbiting an empty arena.
   */
  updateSpectatorHud(dt) {
    const nowSec = performance.now() / 1000;
    // The menu is a full-screen overlay, and somebody else's health bar is not
    // something to read it through. The playing HUD lives under the menu's own
    // veil; this one simply steps aside.
    if (this.menu.visible) { this.hud.hide(); return; }
    this.hud.show();
    const e = this.specFollowId ? this.entities.get(this.specFollowId) : null;
    const cls = getClass(e?.profile?.classId ?? this.classId);
    const guns = loadoutFor(cls.id);
    const slot = e ? Math.max(0, Math.min(2, e.lastSlot | 0)) : 0;
    const w = guns[slot];
    const firstPerson = !settings.specThirdPerson;

    this.updateNukeCountdown(nowSec);
    this.hud.update({
      health: e ? e.health : 0,
      ammo: this.specAmmo?.[0] ?? (w.magSize ?? 0),
      reserve: this.specAmmo?.[1] ?? -1,
      weapon: w,
      slot,
      reloading: !!this.specAmmo?.[2],
      reloadFrac: this.specReloadEnd
        ? clamp(1 - (this.specReloadEnd - nowSec) / Math.max(0.05, w.reloadTime ?? 1), 0, 1)
        : 0,
      spread: 0,
      ads: false,
      // Their crosshair is only theirs while we are behind their eyes; from a
      // chase camera it would sit in the middle of the screen pointing at
      // nothing anybody is aiming at.
      scoped: false,
      hideCrosshair: !firstPerson || !e,
      matchTime: this.matchTime,
      teamScore: this.teamScore,
      teamMode: this.teamMode,
      ping: this.net.rtt * 1000,
      name: e?.profile?.name ?? '—',
      level: e?.profile?.level ?? 1,
      verified: !!e?.profile?.verified,
      speed: e?.speed ?? 0,
      grounded: true,
      alive: !!e?.alive,
      accuracy: 0,
      practice: this.practice,
    }, dt);

    if (this.hud.scoreboardOpen) {
      this.hud.renderScoreboard(this.scoreboardRows, e?.id ?? this.myId,
        this.mapName, this.modeName, this.teamMode);
    }
    this.hud.drawMinimap(
      e ? { x: e.pos.x, z: e.pos.z, yaw: e.yaw } : { x: 0, z: 0, yaw: 0 },
      this.entities.players.values(), this.teamMode,
      // Blips are coloured relative to whoever we are watching, not relative to
      // the team we happen to be parked on while not playing.
      e?.profile?.team ?? this.myTeam, nowSec, this.objectives.state, e?.id ?? 0);
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const escapeAttr = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function rayAabb(o, d, minX, minY, minZ, maxX, maxY, maxZ, maxDist) {
  let t0 = 0, t1 = maxDist;
  const ox = [o.x, o.y, o.z], dx = [d.x, d.y, d.z];
  const mn = [minX, minY, minZ], mx = [maxX, maxY, maxZ];
  for (let a = 0; a < 3; a++) {
    const inv = 1 / dx[a];
    let ta = (mn[a] - ox[a]) * inv, tb = (mx[a] - ox[a]) * inv;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0 < 0 ? -1 : t0;
}

/** Closest approach of a point to a ray segment, for the bullet-snap test. */
function pointRayDistance(p, from, dir, length) {
  const px = p.x - from.x, py = p.y - from.y, pz = p.z - from.z;
  let t = px * dir.x + py * dir.y + pz * dir.z;
  if (t < 0) t = 0; else if (t > length) t = length;
  const cx = from.x + dir.x * t - p.x;
  const cy = from.y + dir.y * t - p.y;
  const cz = from.z + dir.z * t - p.z;
  return Math.hypot(cx, cy, cz);
}

const DUST = {
  snow: 0xeef4fb, ice: 0xcfe6f7, sand: 0xd9c193, dirt: 0x8b7355,
  concrete: 0xb9b4ad, metal: 0xa8b0ba, grate: 0x9aa3ad, wood: 0x9d6f42,
  plank: 0xa87c4c, rock: 0xa79c8c, foliage: 0x4b7a4a,
};
const dustColor = (surface) => DUST[surface] ?? 0xbfb4a0;

/* ── Boot ────────────────────────────────────────────────────────────────── */

window.addEventListener('DOMContentLoaded', () => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
      || document.createElement('canvas').getContext('webgl');
    if (!gl) throw new Error('WebGL unavailable');
  } catch {
    document.body.innerHTML =
      '<p style="color:#fff;padding:2rem;font:16px system-ui">Open Grunker needs WebGL. '
      + 'Enable hardware acceleration or try a different browser.</p>';
    return;
  }
  window.game = new Game();
  document.addEventListener('pointerdown', () => { initAudio(); resumeAudio(); }, { once: true });
});
