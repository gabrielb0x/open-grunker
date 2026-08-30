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
import { step, createState, eyeY, carry, restore, KEY } from '/shared/movement.js';
import { shotDirections, shotSeed } from '/shared/shot.js';
import {
  loadoutFor, getClass, drawStamp, shotInterval, spreadFor, recoilKick, recoilRecovery, weaponById,
} from '/shared/weapons.js';

import * as COS from '/shared/cosmetics.js';
/**
 * Which cosmetic slot finishes which weapon slot.
 *
 * The game's three weapon slots are indices — 0 primary, 1 sidearm, 2 knife —
 * and the wardrobe's are names. This is the one place the two are lined up.
 */
const SLOT_FOR = [COS.SLOT.PRIMARY, COS.SLOT.SECONDARY, COS.SLOT.KNIFE];
import { settings, set as setSetting, onChange as onSettingsChange, HEAVY_KEYS } from './settings.js';
import * as i18n from './i18n.js';
import { binds } from './keybinds.js';
import { api } from './api.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { GameWorld } from './world.js';
import { EntityManager } from './entities.js';
import { ViewModel } from './viewmodel.js';
import { tickCosmetics } from './gunskin.js';
import { Effects } from './effects.js';
import { Objectives } from './objectives.js';
import { Hud } from './hud.js';
import { Menu } from './menu.js';
import { initAudio, resumeAudio, setMasterVolume, sfx } from './audio.js';
import { KillCam } from './killcam.js';
import { DevMode } from './devmode.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** How long after the last shot the view starts walking recoil back down. */
const RECOVER_DELAY = 0.12;

/* ── The eye, and why it is not welded to the body ──────────────────────────
 *
 * The collision box changes height instantly, because it has to: the server
 * runs the same `step` this client does, and a body that shrank over a tenth of
 * a second would be a different body on each side of the wire for that tenth.
 *
 * The camera is under no such obligation, and nailing it to the top of that box
 * is what made sliding read as broken. Crouching drops the box by eighty
 * centimetres in one frame; standing up raises it in one frame; a slide does
 * both, half a second apart, and every stair in the game teleports the whole
 * thing up by the step height. Those are four hard cuts in a first-person view
 * that is otherwise continuous, and a cut in a first-person view does not read
 * as movement — it reads as a fault. Players called it glitchy, and they were
 * describing exactly this.
 *
 * So the eye follows the body rather than being welded to it. Two filters, and
 * they are separate because they are answering different questions:
 *
 *   DUCK_TAU     going down: a crouch or a slide. Deliberately the faster of
 *                the two. Dropping is meant to feel like dropping — this is a
 *                smoothing pass, not slow motion — and it is also the direction
 *                with a cost: while the eye is still catching up it sits above
 *                the crouched head, so a long one would put the camera through
 *                the ceiling of a low gap the body has already fitted under.
 *   RISE_TAU     coming back up. Softer, because standing is the half that
 *                reads as a snap and the eye rising *into* a space the body
 *                already occupies can clip nothing.
 *   STEP_UP_TAU  a stair. Shorter again, because a step is at most a third of
 *                the crouch delta and a slow one feels like the floor is soft.
 *
 * All three are time constants in seconds, so the result is the same at 60 fps
 * and at 240. None of them touches the simulation: the body is exactly where
 * the server says it is, the hitbox is exactly the height the server says it
 * is, and what moves is where the picture is taken from. That is the only kind
 * of smoothing a networked shooter is allowed to do to a player's own eye.
 * ────────────────────────────────────────────────────────────────────────── */
const DUCK_TAU = 0.04;
const RISE_TAU = 0.07;
const STEP_UP_TAU = 0.04;
/** A jump this big is a teleport, not a crouch: adopt it rather than sliding. */
const VIEW_HEIGHT_SNAP = 1.2;
/** A round passing closer than this makes an audible snap. */
const WHIZZ_RADIUS = 3.2;
/** Frame rate the live match is drawn at behind the menu, and behind a panel. */
const MENU_BACKDROP_HZ = 60;
const MENU_COVERED_HZ = 30;
/** Seconds between exhaust puffs on a rocket in flight. */
const TRAIL_INTERVAL = 1 / 60;

/**
 * The one rocket, shared by every rocket in the air.
 *
 * Every warhead used to build — and on impact destroy — its own three
 * geometries and three materials, so a magazine of them was a hundred buffer
 * allocations and deletions inside a second, on the exact frames already
 * paying for the blast. A rocket differs from another rocket only by where it
 * is, and a Mesh is just a transform pointing at a buffer, so they can all
 * point at the same one.
 */
const ROCKET_PARTS = {
  bodyGeo: new THREE.CylinderGeometry(0.09, 0.11, 0.6, 8),
  tipGeo: new THREE.ConeGeometry(0.11, 0.24, 8),
  flameGeo: new THREE.ConeGeometry(0.1, 0.5, 7),
  bodyMat: new THREE.MeshPhongMaterial({ color: 0x6b3f22, shininess: 20 }),
  tipMat: new THREE.MeshPhongMaterial({ color: 0x53301a, shininess: 20 }),
  flameMat: new THREE.MeshBasicMaterial({
    color: 0xffb457, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
  }),
};

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
    /** Time owed to the menu's backdrop since it last drew a frame. */
    this.backdropAcc = 0;

    this.weapons = loadoutFor('triggerman');
    this.slot = 0;
    this.prevSlot = 1;
    this.ammo = [30, 15, 0];
    this.reserve = [-1, -1, -1];               // -1 = unlimited
    this.reloading = false;
    this.reloadEnd = 0;
    /** How long the server said this reload takes. The bar divides by it. */
    this.reloadTime = 0;
    this.lastShotAt = -99;
    this.lastMeleeAt = -99;
    this.pumpUntil = 0;
    this.burst = 0;
    this.alive = false;
    this.health = K.MAX_HEALTH;
    /**
     * This body's own ceiling, which is not everybody's in the Perks mode.
     *
     * Seeded from the constant and replaced by whatever the server says on the
     * handshake and on every spawn. Every bar that draws health draws it
     * against this rather than against `K.MAX_HEALTH`, so a Runner on fifty of
     * fifty is full rather than looking half dead.
     */
    this.maxHealth = K.MAX_HEALTH;
    /** The perk this client has been told it has, or null outside the mode. */
    this.perkId = null;
    /** Its multiplier table — the neutral one until a server says otherwise. */
    this.perkMods = K.NEUTRAL_PERK;
    /** The catalogue the room sent, for the picker. */
    this.perkList = null;
    /** Has this player chosen yet this match? Drives whether the picker opens. */
    this.perkChosen = true;
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
    /**
     * The AFK warning, while it stands.
     *
     * The server owns the rule and sends the frames; this is only what is on
     * screen, and it doubles as a hold on the automatic respawn so an idle body
     * is never put back into the match by the client either.
     */
    this.afkNotice = null;
    this.skin = 'default';
    /**
     * The worn loadout: `{ <slot>: <itemId> }` for all nine slots.
     *
     * Kept on the game rather than read out of `api` at every use, because it
     * is read on every weapon switch and every respawn, and because a guest
     * has no account to read it from — a guest wears the defaults, which is
     * exactly what this starts as.
     */
    this.cos = { ...COS.DEFAULT_EQUIP };
    this.classId = 'triggerman';
    /*
     * The kill cam, and the plain death camera it did not replace.
     *
     * `deathCam` is still here and still the fallback: a fall, a suicide, a
     * killer who disconnected, and a player who has switched the cam off all
     * end up on it — which is exactly the screen the game had before
     * killcam.js existed. The two are never both running; `onDeath` picks one.
     */
    this.deathCam = null;
    this.killCam = new KillCam();
    /** The last DEATH, for the screen that takes over when the cam ends early. */
    this.lastKiller = null;
    /** This account's creator discipline, or null. Set from the handshake. */
    this.myCreator = null;
    /** Where the local body fell, so the cam can rise out of it. */
    this.deathAt = null;
    /** Read-only instruments — see devmode.js. Off, and gated, until told. */
    this.dev = new DevMode();
    this.devWireframe = false;
    this.devNoPost = false;
    this.devCollision = false;
    this.devFreezeFrustum = false;
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
    /** God mode, exactly as the server last confirmed it — never assumed here. */
    this.godMode = false;
    /** The scoreboard is pinned open with the mouse free — see toggleScoreboard. */
    this.scoreboardPinned = false;
    this.renderTime = 0;
    /** True while the scene is being drawn at a moment in the past. */
    this.replaying = false;
    /*
     * Every shot fired in the last dozen seconds, so the kill cam can fire them
     * again.
     *
     * The replay itself needs no recording — it is the snapshot ring read at an
     * older moment (see killcam.js) — but a shot is not in that ring. It is an
     * event: one packet, one flash, one tracer, gone by the next frame. So the
     * one thing the cam cannot reconstruct is the only thing the fight was
     * actually made of, and without this the replay is two people running
     * around a map in silence and then one of them falling over.
     *
     * Each entry is stamped with the moment on the *render* timeline rather
     * than with arrival time, because that is the clock the bodies are drawn
     * on: a tracer stamped with `serverTime` would be played back a fifth of a
     * second before the body that fired it got there.
     */
    this.shotLog = [];
    /** How far through the log the replay has got, on the same clock. */
    this.replayShotAt = 0;
    /** Which weapon the replay has put in the killer's hands, and from which slot. */
    this.replayWeapon = null;
    this.replaySlot = -1;
    /** The killer's view angles on the previous replay frame, for the gun's sway. */
    this.replayAim = null;
    /** Whether the controller legend is up, so the class is toggled on change. */
    this._padLegend = false;
    this.smooth = new THREE.Vector3();
    /**
     * The height the camera is currently taken from, chasing `local.height`.
     *
     * Not `local.height` itself: see DUCK_TAU above for why the eye is allowed
     * to lag the collision box and the box is not allowed to lag anything.
     */
    this.viewHeight = K.PLAYER_HEIGHT;
    /** How far below the body the eye still is after a step up, in metres. */
    this.stepOffset = 0;
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
      // A request, exactly like the class one: the room answers with `perkSet`
      // or `perkQueued`, and `setPerk` below only ever runs off that answer.
      onPerkChange: (id) => { if (this.net.connected) this.net.setPerk(id); },
      /*
       * Something was equipped in the wardrobe.
       *
       * Re-reads the loadout and rebuilds the viewmodel in place, so a knife
       * bought between rounds is in your hand on the next draw. The server
       * already has it — this is only the local view catching up.
       */
      onCosmeticsChange: () => {
        this.refreshCosmetics();
        if (this.weapons?.length) {
          this.viewmodel.setWeapon(this.weapons[this.slot] ?? this.weapons[0],
            SLOT_FOR[this.slot] ?? COS.SLOT.PRIMARY, this.cos);
        }
      },
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
    this.refreshCosmetics();

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
    this.afkNotice = null;
    this.hud.setAfkNotice(null);
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
    this.hud.hideKillCam();
    this.killCam.end();
    this.endReplay();
    // A clean screen belongs to the shot it was turned on for, not to the
    // browser: leaving with the interface off would mean coming back to a menu
    // over a game with no HUD and no obvious way to get it back.
    document.body.classList.remove('clean');
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

  /**
   * True while something on screen, rather than the match, is what a button
   * press is aimed at. See the poll in `loop`.
   */
  get interfaceOwnsPad() {
    return this.hud.chatOpen || this.hud.matchEndOpen || this.hud.reportCardOpen
      || this.menu.classModalOpen || this.menu.perkModalOpen || this.menu.playerCardOpen
      || this.menu.visible || this.scoreboardPinned || this.inGameMenuOpen
      || !$('pause').classList.contains('hidden');
  }

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
      /*
       * Creator status and developer access, both straight off the handshake.
       *
       * Neither is worked out here. The status is a decision a human made and
       * the access is a level plus that status, so both live on the server —
       * and a client that derived either for itself would be a client that
       * could be told to derive it differently. `setAccess` is the only way
       * devmode.js ever learns what it may open.
       */
      this.myCreator = msg.account?.creator?.status === 'approved'
        ? msg.account.creator.kind : null;
      this.dev.setAccess(msg.account?.dev ?? null);
      this.dev.el = this.hud.el.devOverlay;
      // The rail entry and the page behind it. The menu draws both; only the
      // game knows what the server answered, so it is handed over rather than
      // worked out twice.
      this.menu.onDevToggle = () => this.setDevMode(!this.dev.open);
      this.menu.setDevAccess(this.dev.access, this.dev.open);
      // The wire inspector's feed. Attached only for an account that may open
      // it at all, so a session that cannot see the panel does not pay for it.
      this.net.onPacket = this.dev.access.allowed
        ? (dir, op, bytes) => this.dev.samplePacket(dir, op, bytes)
        : null;
      this.setDevMode(settings.devMode);
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
      // A body for ourselves, drawn by nothing but the kill cam's replay — see
      // EntityManager.addSelf. Without it the replay is the killer's ten
      // seconds with the person they were shooting at cut out of them.
      this.entities.addSelf({ ...msg.you, id: msg.id });
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
      // A fresh connection is never in god mode; the switch starts off and the
      // server is the only thing that ever turns it on.
      this.godMode = false;
      this.hud.setGodMode(false);
      this.hud.setAdminTools(this.myRole, (want) => this.net.god(want));
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
      this.ammo[0] = msg.you.ammo ?? this.magOf(this.weapons[0]);
      this.reserve[0] = msg.you.reserve ?? -1;
      this.health = msg.you.health ?? K.MAX_HEALTH;
      this.maxHealth = msg.you.maxHealth ?? K.MAX_HEALTH;
      /*
       * The Perks mode, and everything this client needs to play it.
       *
       * `msg.perks` is null in every other mode, which is what turns the whole
       * feature off here: no picker, no chip on the HUD, and `perkMods` stays
       * the neutral table so the prediction below is byte-for-byte what it was.
       */
      this.setPerk(msg.perks ? msg.perks.perk : null, msg.perks?.list ?? null);
      this.perkChosen = !msg.perks || !!msg.perks.chosen;

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
      // A Perks match nobody has chosen for yet: the picker is the first thing
      // this player sees, before the mouse is taken for the game.
      if (this.perkList && !this.perkChosen) this.openPerkPicker();
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
      if (typeof msg.maxHealth === 'number') this.maxHealth = msg.maxHealth;
      // A queued perk lands on the respawn, so the spawn packet is where this
      // client finds out it is now somebody else.
      if (msg.perk) this.setPerk(msg.perk);
      this.deathCam = null;
      // A spawn always closes the cam, whether it was skipped or ran out: a
      // player who is back in the match must not still be watching a replay.
      this.killCam.end();
      this.hud.hideKillCam();
      this.endReplay();
      this.deathAt = null;
      this.smooth.set(0, 0, 0);
      // A spawn is a cut, and the eye filters have to be told so: easing a
      // camera across a respawn would slide it out of the last body and into
      // the new one over a sixth of a second.
      this.viewHeight = this.local.height;
      this.stepOffset = 0;
      if (msg.classId && msg.classId !== this.classId) this.setClass(msg.classId);
      for (let i = 0; i < this.weapons.length; i++) {
        this.ammo[i] = this.magOf(this.weapons[i]);
        this.reserve[i] = -1;
      }
      this.ammo[0] = msg.ammo ?? this.magOf(this.weapons[0]);
      this.reserve[0] = msg.reserve ?? -1;
      this.slot = 0;
      this.reloading = false;
      this.burst = 0;
      this.viewmodel.setWeapon(this.weapons[0], COS.SLOT.PRIMARY, this.cos);
      this.input.reset(msg.yaw, 0);
      this.hud.hideDeath();
      sfx.spawn();
    });

    net.on('join', (p) => {
      // A class change re-announces the player: refresh rather than duplicate.
      if (this.entities.get(p.id)) this.entities.setClass(p.id, p.classId, p.skin, p.cos);
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
      // A `hit` only ever reaches the player who caused it, so the round came
      // from this camera: the spray leaves the far side of them rather than
      // puffing out in every direction from the point of contact.
      const from = this.gfx.camera.position;
      const away = { x: msg.x - from.x, y: msg.y - from.y, z: msg.z - from.z };
      const reach = Math.hypot(away.x, away.y, away.z) || 1;
      this.effects.blood(msg.x, msg.y, msg.z, msg.head || msg.kill,
        { x: away.x / reach, y: away.y / reach, z: away.z / reach });
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
      sfx.die();
      this.input.gamepad.rumble(1, 320);
      this.input.clearRecoil();
      // Remembered before anything moves: the cam rises out of where the body
      // fell, and by the next frame `local` has begun easing somewhere else.
      this.deathAt = { x: this.local.x, y: this.local.y, z: this.local.z };
      // Kept so the plain death screen can take over if the cam ends before the
      // respawn does — which is the normal case for anyone who turned the hold
      // off, and the only case for a cam that lost the body it was orbiting.
      this.lastKiller = {
        name: msg.by, weapon: msg.weapon, health: msg.killerHealth,
        clan: msg.byClan, clanVerified: msg.byClanVerified,
      };

      /*
       * One of two screens, never both.
       *
       * The cam is the interesting case and the plain death screen is the
       * fallback, and the fallback is what runs whenever there is nothing worth
       * looking at: the world killed us, the killer has already left the room,
       * or this player has turned the cam off. `begin` answers null for every
       * one of those, which is why the test is its return value rather than a
       * list of conditions repeated here.
       */
      const shot = this.entities.get(msg.byId) ? this.killCam.begin(msg, this.entities) : null;
      if (shot) {
        this.deathCam = null;
        this.hud.hideDeath();
        this.hud.showKillCam(this.killCam.view());
      } else {
        this.killCam.end();
        this.hud.hideKillCam();
        this.hud.showDeath(msg.by, msg.weapon, msg.respawnIn, msg.killerHealth,
          { clan: msg.byClan, clanVerified: msg.byClanVerified });
        this.deathCam = this.entities.get(msg.byId) ? { targetId: msg.byId } : null;
      }
    });

    net.on('ammo', (msg) => {
      const wasEmpty = this.ammo[msg.slot] === 0;
      this.ammo[msg.slot] = msg.ammo;
      this.reserve[msg.slot] = msg.reserve ?? -1;
      if (msg.reloading) {
        this.reloading = true;
        this.reloadEnd = performance.now() / 1000 + msg.reloading;
        // Kept so the bar has something to divide by — see `reloadFrac`.
        this.reloadTime = msg.reloading;
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

    /*
     * The match noticing that nobody is at the keyboard.
     *
     * `warn` puts a notice up and, while it stands, stops the automatic respawn
     * — the point of the whole rule is that an empty body stops being fed back
     * into the match. `held` is the same answer to a respawn the server just
     * refused. `clear` arrives the moment a key or the mouse moves again, so
     * nothing here has to duplicate the server's rule; it only draws it.
     *
     * `out` is the end of it: the seat goes back and the player goes to the
     * menu, which is where somebody who is not playing belongs. The socket is
     * closed behind this frame either way, so a client that ignored it would
     * land in the same place a second later — this only makes it land gently,
     * with an explanation rather than a "connection lost".
     */
    net.on('afk', (msg) => {
      if (msg.phase === 'out') {
        this.afkNotice = null;
        this.hud.setAfkNotice(null);
        this.leaveMatch();
        this.menu.notify(msg.message ?? 'You were away, so the match gave your seat back.', '');
        return;
      }
      if (msg.phase === 'clear') {
        this.afkNotice = null;
        this.hud.setAfkNotice(null);
        return;
      }
      this.afkNotice = msg.message
        ?? `Still there? You are out of the match in ${msg.in ?? 30}s without an input.`;
      this.hud.setAfkNotice(this.afkNotice);
    });

    net.on('god', (msg) => {
      this.godMode = !!msg.on;
      this.hud.setGodMode(this.godMode);
      // The room tops every magazine up on the way in and stops spending them.
      // Doing the same here keeps the prediction and the HUD from disagreeing
      // with it for the slots no AMMO packet covers.
      if (this.godMode) {
        for (let i = 0; i < this.weapons.length; i++) this.ammo[i] = this.magOf(this.weapons[i]);
        this.reloading = false;
      }
      if (msg.allowed === false) this.hud.toast('God mode is an administrator tool', 'error');
    });

    net.on('shot', (msg) => this.onRemoteShot(msg));
    net.on('impact', (msg) => {
      // Not during a replay: a spark from the present landing in a picture of
      // ten seconds ago is the one thing that would give the illusion away.
      if (this.replaying) return;
      this.effects.impact(msg.x, msg.y, msg.z, msg.nx, msg.ny, msg.nz, msg.s ?? 'concrete');
      sfx.impact(msg, this.listener(), msg.s ?? 'concrete');
    });
    net.on('explosion', (msg) => {
      // The rocket is gone the instant it goes off, replay or not. Dropping it
      // from the array was never enough on its own: the mesh belongs to the
      // scene, so a filtered-out projectile left its warhead hanging in the air
      // at the point of impact for the rest of the match.
      this.despawnProjectile(msg.id);
      if (this.replaying) return;
      this.effects.explosion(msg.x, msg.y, msg.z, msg.r);
      sfx.explosion(msg, this.listener());
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
        // A career milestone is not a daily. It is named as what it is, so a
        // line somebody has been walking toward for a month does not arrive
        // looking like the third of tonight's three chores.
        for (const m of msg.milestones ?? []) {
          extras.push({ name: `${m.name} · ${m.desc}`, xp: m.xp, gr: m.gr, career: true });
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
        if (msg.immediate) this.hud.toast(i18n.tf('Switched to {name}', { name: getClass(msg.classId).name }), 'good');
      } else if (msg.phase === 'classQueued') {
        this.hud.toast('In combat — the new class lands on your next respawn', '');
      } else if (msg.phase === 'classLocked') {
        this.hud.toast('Gun Game picks your weapon — earn the next one', '');
      } else if (msg.phase === 'perkPick') {
        /*
         * A fresh match in the Perks mode. The choice is per match, so the
         * picker comes back up rather than the last one being reselected
         * silently — see `startMatch` in the room.
         *
         * It is only *opened* here when this client is already in a match. On
         * the way in, `wake()` starts a match before the handshake is written,
         * so this frame arrives before WELCOME does — a picker opened at that
         * moment would be over a screen that has no map on it yet, and the
         * `enterMatch` that follows would take the mouse straight back off it.
         * WELCOME opens it instead, off the `chosen` flag this leaves behind.
         */
        this.setPerk(msg.perk, msg.list ?? null);
        this.perkChosen = false;
        if (this.state === 'playing') this.openPerkPicker();
      } else if (msg.phase === 'perkSet') {
        this.setPerk(msg.perk);
        this.perkChosen = true;
        if (typeof msg.health === 'number') this.maxHealth = msg.health;
        if (msg.immediate) this.hud.toast(i18n.tf('Playing as {name}', { name: K.getPerk(msg.perk).name }), 'good');
      } else if (msg.phase === 'perkQueued') {
        this.perkChosen = true;
        this.hud.toast('In combat — the perk you picked lands on your next respawn', '');
      } else if (msg.phase === 'perkLocked') {
        /*
         * Two different refusals, and they are not the same sentence.
         *
         * `mode` is a client asking for something the room does not run, which
         * is a bug in this file if it ever happens. `chosen` is the ordinary
         * one: the pick is per match and this match's has been made, so the
         * answer is the perk they already have — adopted here rather than
         * assumed, so a picker that has drifted lands back on the truth.
         */
        if (msg.reason === 'chosen') {
          this.perkChosen = true;
          if (msg.perk) this.setPerk(msg.perk);
          this.menu.buildPerks(this.perkList, this.perkId, true);
          this.hud.toast('Your perk is locked in — the next match asks again', '');
        } else {
          this.hud.toast('Perks are only a thing in the Perks mode', '');
        }
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
    // A shot belongs to the level it was fired on. Kept across a map change it
    // would be replayed against geometry that no longer exists, which is a
    // tracer through the middle of the new map from nowhere.
    this.shotLog.length = 0;
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
    this.killCam.end();
    this.hud.hideKillCam();
    this.endReplay();
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

  /**
   * The bar along the bottom: who the camera is on, and the way back in.
   *
   * Runs on every frame while watching as well as on every message that could
   * change it, and writes nothing the screen already says. The room retargets
   * the camera silently when the watched player dies, so a name that only
   * followed message arrivals spent the gap naming a corpse.
   */
  updateSpectatorBar() {
    const bar = $('specBar');
    if (!bar) return;
    bar.classList.toggle('hidden', !(this.specWatching && this.state === 'spectating'));
    if (!this.specWatching) { this._specBarName = null; return; }
    const name = this.specName
      ?? (this.specFollowId ? this.entities.get(this.specFollowId)?.profile?.name ?? '—' : 'the arena');
    if (name !== this._specBarName) {
      this._specBarName = name;
      $('specName').textContent = name;
      this.hud.setWatching(name);
    }
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

  /**
   * This client's own snapshot entry, or null while it has no body.
   *
   * Byte for byte the layout `Player.netEntry` writes on the server — id,
   * position, view angles, a flag word, health, weapon slot and ground speed —
   * because entities.js reads every entry through one code path and a second
   * shape would mean a second one.
   */
  selfEntry(msg) {
    const y = msg.y;
    if (!y || !this.alive || !this.myId) return null;
    let flags = 1;
    if (y[6]) flags |= 2;
    if (this.local.crouching) flags |= 4;
    if (this.local.sliding) flags |= 8;
    if (this.input.ads) flags |= 16;
    if (this.input.mouse.left) flags |= 32;
    return [
      this.myId, y[0], y[1], y[2], this.input.yaw, this.input.pitch,
      flags, Math.round(this.health), this.slot,
      Math.hypot(this.local.vx, this.local.vz),
    ];
  }

  onSnapshot(msg) {
    /*
     * Our own entry, in the shape the server sends everybody else's.
     *
     * The position is the server's — `msg.y`, the state it simulated at `msg.t`
     * — and not the predicted one a few ticks ahead of it, because what the
     * replay has to line up with is what the *killer* was shooting at, which is
     * the position on the server's clock. The view angles are this client's
     * own: nothing else knows them, and they are what makes a replay of a
     * duel show two people looking at each other.
     */
    this.entities.pushSnapshot(msg.t, msg.p ?? [], this.selfEntry(msg));
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
    /*
     * …and the half of the state the packet does not carry.
     *
     * `pending[0].pre` is the timer state as it was just before the first
     * still-unacknowledged input was simulated — which is to say, the state
     * immediately after the input the server has just told us it consumed. An
     * empty queue means the server is level with us and there is nothing to
     * undo. Without this the slide, hop and coyote timers were advanced once
     * per replay per snapshot on top of the once per frame they were meant to
     * be, and a slide lasted a fraction of the time the room was giving it.
     */
    restore(this.local, this.pending[0]?.pre);

    for (const inp of this.pending) {
      step(this.local, inp, this.world, K.TICK_DT, this.moveOptsFor(inp.keys));
    }

    // Any residual error is absorbed visually instead of snapping the camera.
    const dx = before.x - this.local.x, dy = before.y - this.local.y, dz = before.z - this.local.z;
    const err = Math.hypot(dx, dy, dz);
    // The error and the queue depth, for the reconciliation trace. Neither is
    // computed for it — both are already here, which is the only reason a
    // sampler on this path is acceptable at all.
    this.dev.sampleRecon(err, this.pending.length);
    if (err > 0.0005 && err < 4) {
      this.smooth.set(dx, dy, dz);
    } else if (err >= 4) {
      this.smooth.set(0, 0, 0);                 // big correction: teleport, don't slide
    }
  }

  speedMultFor(keys) {
    const def = this.weapons[this.slot];
    const ads = (keys & KEY.ADS) !== 0;
    return (def.moveMult ?? 1) * this.perkMods.speed * (ads ? (def.adsMoveMult ?? 0.6) : 1);
  }

  /**
   * The `step` options this body moves under — the client's half of the perk.
   *
   * It has to produce the identical object the server builds in
   * `Player.moveOpts`, because prediction and authority run the *same* function
   * on it. That is why the perk is only ever set from a server packet
   * (`setPerk`, below) and never chosen locally: a client that decided for
   * itself that it was a Runner would predict a body the room refuses to
   * simulate, and spend the whole match being corrected.
   */
  moveOptsFor(keys) {
    const p = this.perkMods;
    return {
      speedMult: this.speedMultFor(keys),
      jumpMult: p.jump,
      hopKeep: p.hopKeep,
      airMax: p.airMax,
      fly: this.godMode,
    };
  }

  /**
   * Adopts a perk the server has told this client it has, or clears it.
   *
   * `null` is the ordinary case — every mode but one — and it puts the neutral
   * table back, which is what keeps every other mode's movement identical to
   * what it was before perks existed. `list` arrives with the handshake and
   * with a fresh match; it is the *server's* catalogue rather than this
   * client's copy of the constants, so a room running different numbers
   * describes its own.
   */
  setPerk(perkId, list = null) {
    if (list) this.perkList = list;
    this.perkId = perkId ?? null;
    this.perkMods = perkId ? K.getPerk(perkId) : K.NEUTRAL_PERK;
    this.hud.setPerk(perkId ? K.getPerk(perkId) : null);
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
      })) { this.grabMouse(); return; }
      // A controller has no letters of its own. It does now — DONE sends the
      // line, which is what Enter does on the keyboard this is standing in for.
      if (this.input.padActive) {
        this.menu.padKeyboard.open(this.hud.el.chatInput, {
          done: () => this.hud.el.chatForm.requestSubmit?.(),
        });
      }
    });

    inp.on('classMenu', () => {
      if (this.state !== 'playing') return;
      this.input.unlock();
      // One key, two pickers. In the Perks mode the weapon is not the choice
      // that matters — what kind of player you are is — so the key that has
      // always meant "change what I am" opens the one that does.
      if (this.perkList) this.openPerkPicker();
      else this.menu.openClassModal();
    });

    inp.on('escape', () => {
      if (this.state !== 'playing') return;
      if (this.menu.classModalOpen) { this.menu.closeClassModal(); this.input.lock(); return; }
      if (this.menu.perkModalOpen) { this.menu.closePerkModal(); this.input.lock(); return; }
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
    // Unbound by default and refused for an account that has not unlocked it,
    // so a stray press on a fresh keyboard layout does nothing at all.
    inp.on('devMode', () => {
      if (!this.dev.access.allowed) return;
      sfx.ui(this.setDevMode(!this.dev.open) ? 'ok' : 'click');
    });
    /*
     * The video creator's clean screen.
     *
     * Takes the whole interface off for a shot without touching a single
     * setting, so it comes back the moment the key is pressed again rather than
     * being something to remember to undo. It is a capture tool and nothing
     * else — losing your health, your ammo and your minimap is a
     * *disadvantage*, which is exactly why it can be a perk rather than an
     * advantage somebody would want for the wrong reason.
     */
    inp.on('cleanScreen', () => {
      if (this.myCreator !== 'video') return;
      const on = document.body.classList.toggle('clean');
      sfx.ui(on ? 'ok' : 'click');
    });


    inp.on('unlock', () => {
      if (this.state === 'playing' && !this.hud.chatOpen && !this.menu.classModalOpen
          && !this.menu.perkModalOpen
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
      // While the cam is up the same key is the skip, and pressing it early is
      // not a respawn request that gets to jump the three seconds — it is a
      // press the cam declines. Falling through to `requestRespawn` here would
      // have made the skip delay decorative.
      if (this.killCam.active) {
        if (this.killCam.skip()) { sfx.ui('ok'); this.hud.hideKillCam(); }
        return;
      }
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
  /**
   * Puts the perk picker up, with the room's own catalogue in it.
   *
   * Called at the start of every Perks match and from the class key. It takes
   * the mouse, because a grid of cards is not something a locked pointer can
   * click — and the same escape/backdrop handling every other modal has puts
   * it back.
   */
  openPerkPicker() {
    if (!this.perkList) return;
    this.input.unlock();
    // Read-only once the choice has been made. The picker still opens — a
    // player who wants to reread what they signed up for should be able to —
    // it simply has nothing left to click.
    this.menu.openPerkModal(this.perkList, this.perkId, this.perkChosen);
  }

  requestRespawn() {
    const now = performance.now() / 1000;
    if (this.alive || now < this.respawnAt) return;
    if (now - this.respawnSentAt < 0.6) return;
    this.respawnSentAt = now;
    this.net.respawn();
  }

  _bindUi() {
    // The kill cam's own two controls. The button is a second way to do what
    // the jump key already does, for anyone playing with a mouse in one hand
    // and a drink in the other; the overlay column delegates its render
    // toggles off `data-dev`, so devmode.js can rewrite its own markup every
    // eighth of a second without ever leaking a listener.
    $('kcSkip').addEventListener('click', () => {
      if (this.killCam.skip()) { sfx.ui('ok'); this.hud.hideKillCam(); }
      else sfx.ui('error');
    });
    $('devOverlay').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-dev]');
      if (!btn) return;
      sfx.ui();
      this.toggleDevRender(btn.dataset.dev);
      this.dev.drawAt = 0;                       // repaint the row on this frame
      this.dev.update(this);
    });

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
    if (this.menu.visible || this.menu.classModalOpen || this.menu.perkModalOpen
        || this.menu.authModalOpen) return;
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
    this.refreshCosmetics();
    // The replay body wears what we wear. Everybody else's is rebuilt off the
    // join that re-announces a class change; ours never travels, so it is
    // rebuilt here.
    if (this.myId) this.entities.setClass(this.myId, classId, undefined, this.cos);
    for (let i = 0; i < this.weapons.length; i++) {
      this.ammo[i] = this.magOf(this.weapons[i]);
      this.reserve[i] = -1;
    }
    this.slot = 0;
    this.reloading = false;
    this.burst = 0;
    this.viewmodel.setWeapon(this.weapons[0], COS.SLOT.PRIMARY, this.cos);
  }

  /**
   * Re-reads the wardrobe off the account.
   *
   * Called on every class change and every spawn rather than cached once,
   * because the loadout screen is reachable mid-match: somebody who equips a
   * new knife between rounds sees it on the next draw, without a reconnect.
   */
  refreshCosmetics() {
    const w = api.account?.wardrobe ?? null;
    const primary = w?.primaries?.[this.classId] ?? w?.equip?.[COS.SLOT.PRIMARY];
    this.cos = {
      ...COS.DEFAULT_EQUIP,
      ...(w?.equip ?? {}),
      ...(primary ? { [COS.SLOT.PRIMARY]: primary } : {}),
    };
    // What a pre-V2 payload called the skin, for a server that is still on one.
    this.skin = COS.parseItemId(this.cos[COS.SLOT.PRIMARY])?.key ?? 'default';
  }

  switchSlot(slot) {
    if (slot === this.slot || slot < 0 || slot > 2 || !this.alive) return;
    this.prevSlot = this.slot;
    this.slot = slot;
    this.reloading = false;
    this.burst = 0;
    this.lastShotAt = drawStamp(this.weapons[slot], performance.now() / 1000, 0.1);
    this.viewmodel.setWeapon(this.weapons[slot], SLOT_FOR[slot] ?? COS.SLOT.PRIMARY, this.cos);
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
    // The room puts the same floor under every wait in god mode — fire rate,
    // bolt and the leftover draw alike. Predicting anything slower would just
    // be the client refusing shots the server would have taken.
    const gate = this.godMode ? Math.min(shotInterval(w), K.GOD_SHOT_INTERVAL) : shotInterval(w);
    if (this.reloading || (now < this.pumpUntil && !this.godMode)) return;
    if (now - this.lastShotAt < gate) return;

    if (this.ammo[this.slot] <= 0) {
      sfx.dryFire();
      if (settings.autoReload) this.tryReload();
      return;
    }

    const burst = this.currentBurst(now);
    this.lastShotAt = now;
    // The server does not spend the magazine in god mode either; predicting a
    // round out of it would only be corrected by the next AMMO packet.
    if (!this.godMode) this.ammo[this.slot]--;
    this.burst = burst + 1;
    if (w.boltTime) {
      this.pumpUntil = now + w.boltTime;
      setTimeout(() => sfx.cycle(), Math.max(60, w.boltTime * 380));
    }

    const seq = ++this.shotSeq;
    const ads = this.input.ads;
    this.net.shoot(this.input.yaw, this.input.pitch, ads, seq, Math.round(burst));

    // Local prediction of the exact rays the server will test — including the
    // perk's own cone multiplier, which is in the server's call too. The two
    // sides derive pellet directions from the same seed and the same cone, and
    // a cone they disagreed about would draw a tracer where nothing was fired.
    const spread = spreadFor(w, {
      moving: Math.hypot(this.local.vx, this.local.vz) > 1.5,
      airborne: !this.local.onGround,
      ads,
      crouching: this.local.crouching,
      burst,
      mult: this.perkMods.spread,
    });
    const dirs = shotDirections(this.input.yaw, this.input.pitch, spread, shotSeed(this.myId, seq), w.pellets ?? 1);
    const muzzle = this.muzzleWorld(ads);

    if (!w.projectile) {
      /*
       * Ours goes in the kill cam's log too, and it is the half that makes a
       * replay read as a fight rather than as an execution: what the killer saw
       * was somebody shooting back. The muzzle is the viewmodel's rather than
       * the eye, which is the same point the live tracer leaves from — the cam
       * should show the shot that was drawn, not a recomputed one.
       */
      this.logShot({
        id: this.myId, x: muzzle.x, y: muzzle.y, z: muzzle.z,
        yaw: this.input.yaw, pitch: this.input.pitch, spread, seq, w: w.id,
      });
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
    const cooldown = this.godMode ? Math.min(K.MELEE_COOLDOWN, K.GOD_SHOT_INTERVAL) : K.MELEE_COOLDOWN;
    if (now - this.lastMeleeAt < cooldown) return;
    this.lastMeleeAt = now;
    this.net.melee();
    // The swing fills most of the cooldown, so the blade is home again just
    // before the next one can start rather than snapping back and waiting.
    this.viewmodel.meleeSwing(K.MELEE_COOLDOWN * 0.82);
    this.addPunch(2.4, (Math.random() * 2 - 1) * 3.5);
    sfx.shot({ ...this.weapons[2].sound, gain: 0.35 }, null, null);
    this.logShot({ id: this.myId, melee: true, x: this.local.x, y: eyeY(this.local), z: this.local.z });
  }

  /**
   * How many rounds this body's magazine holds — the perk's, not the weapon's.
   *
   * The same question `Player.magOf` answers on the server, asked the same way,
   * so the client never thinks a Scavenger's gun is full at thirty when the
   * room is holding fifty-two in it.
   */
  magOf(w) { return Math.max(1, Math.round((w?.magSize ?? 0) * this.perkMods.mag)); }

  tryReload() {
    if (!this.alive || this.reloading) return;
    const w = this.weapon;
    // Reserves are unlimited (-1); only a full magazine blocks a reload.
    if (w.melee || this.ammo[this.slot] >= this.magOf(w) || this.reserve[this.slot] === 0) return;
    this.net.reload();
  }

  /* ── The kill cam's shot log ───────────────────────────────────────────── */

  /**
   * Remembers one shot, so the cam can fire it again ten seconds later.
   *
   * Stamped with the moment on the render timeline rather than with the time it
   * arrived: bodies are drawn `INTERP_DELAY` behind the server clock, and the
   * whole point of the replay is that the tracer and the person who fired it
   * are in the same frame.
   *
   * The ring is trimmed to the same window `entities.js` keeps snapshots for,
   * because a shot older than the oldest frame of the replay can never be
   * played back — the camera would have nowhere to stand for it.
   */
  logShot(entry) {
    entry.t = this.net.serverTime - K.INTERP_DELAY * 1000;
    this.shotLog.push(entry);
    const cutoff = entry.t - (K.KILLCAM_SECONDS + 2) * 1000;
    let drop = 0;
    while (drop < this.shotLog.length && this.shotLog[drop].t < cutoff) drop++;
    if (drop) this.shotLog.splice(0, drop);
  }

  /**
   * Fires every logged shot the replay has just passed over.
   *
   * Called once per replay frame with the window between the last frame's
   * moment and this one's, so a hitch draws every round inside it rather than
   * silently swallowing the ones it stepped across.
   *
   * The rays are cast against the world and against the bodies *as they are
   * drawn right now*, which during a replay is where they were at that moment —
   * so a tracer stops on the wall it stopped on, and on the person it hit.
   */
  replayShots(from, to) {
    for (const e of this.shotLog) {
      if (e.t <= from || e.t > to) continue;
      const at = { x: e.x, y: e.y, z: e.z };
      if (e.melee) {
        sfx.shot({ ...weaponById('knife').sound, gain: 0.3 }, at, this.listener());
        if (e.id === this.killCam.shot?.targetId) this.viewmodel.meleeSwing(K.MELEE_COOLDOWN * 0.82);
        else this.entities.meleeSwing(e.id);
        continue;
      }
      const def = weaponById(e.w);
      const fd = { x: -Math.sin(e.yaw), y: Math.sin(e.pitch), z: -Math.cos(e.yaw) };

      // The killer's own rounds come out of the gun the cam is holding, so the
      // viewmodel kicks with them; everybody else's only exist in the world.
      if (e.id === this.killCam.shot?.targetId) this.viewmodel.fire();
      else {
        this.effects.muzzleFlash(at.x + fd.x * 0.9, at.y + fd.y * 0.9 - 0.15, at.z + fd.z * 0.9,
          def?.id === 'shotgun' ? 1.6 : 1.1, fd);
      }
      if (def) sfx.shot(def.sound, at, this.listener());

      const dirs = shotDirections(e.yaw, e.pitch, e.spread, shotSeed(e.id, e.seq), def?.pellets ?? 1);
      for (const d of dirs) {
        const wall = this.world.raycast(at.x, at.y, at.z, d.x, d.y, d.z, K.MAX_SHOT_RANGE);
        let best = wall ? wall.dist : 90;
        let hitBody = false;
        for (const other of this.entities.players.values()) {
          if (!other.alive || other.id === e.id) continue;
          const t = rayAabb(at, d,
            other.pos.x - 0.46, other.pos.y, other.pos.z - 0.46,
            other.pos.x + 0.46, other.pos.y + other.height, other.pos.z + 0.46, best);
          if (t >= 0 && t < best) { best = t; hitBody = true; }
        }
        this.effects.tracer(at, {
          x: at.x + d.x * best, y: at.y + d.y * best, z: at.z + d.z * best,
        }, { width: 0.028, life: 0.07 });
        if (!hitBody && wall && best === wall.dist) {
          this.effects.impact(at.x + d.x * best, at.y + d.y * best, at.z + d.z * best,
            wall.nx, wall.ny, wall.nz, wall.mat ?? 'concrete');
        }
      }
    }
  }

  /* ── Remote fire effects ───────────────────────────────────────────────── */

  onRemoteShot(msg) {
    const e = this.entities.get(msg.id);
    const from = { x: msg.x, y: msg.y, z: msg.z };

    // Written down before anything is drawn, so a shot fired *during* somebody
    // else's replay is still in the log when their own cam wants it. The melee
    // branch below logs its own, because a knife carries none of these fields.
    if (!msg.projectile && !msg.melee) {
      this.logShot({
        id: msg.id, x: msg.x, y: msg.y, z: msg.z,
        yaw: msg.yaw ?? 0, pitch: msg.pitch ?? 0, spread: msg.spread ?? 0,
        seq: msg.seq ?? 0, w: msg.w,
      });
    }

    /*
     * A rocket is an object in the world and has to be tracked whatever is on
     * screen: it will still be in the air when the replay ends, and the
     * explosion that removes it is matched by id. Everything below the
     * projectile branch is a flash, a shell and a tracer — sensory, transient,
     * and belonging to a moment ten seconds newer than the picture.
     */
    if (this.replaying && !msg.projectile) return;

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
      this.logShot({ id: msg.id, melee: true, x: msg.x, y: msg.y, z: msg.z });
      if (this.replaying) return;
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
    const body = new THREE.Mesh(ROCKET_PARTS.bodyGeo, ROCKET_PARTS.bodyMat);
    body.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(ROCKET_PARTS.tipGeo, ROCKET_PARTS.tipMat);
    tip.rotation.x = -Math.PI / 2;
    tip.position.z = -0.4;
    const flame = new THREE.Mesh(ROCKET_PARTS.flameGeo, ROCKET_PARTS.flameMat);
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
    // Nothing to free: every rocket draws the same three buffers. See
    // `ROCKET_PARTS`.
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
      // Still flown, never drawn, while the scene is ten seconds behind: this
      // rocket is in the air *now*, and it has to be where the explosion that
      // removes it says it is the moment the replay hands the screen back. Its
      // exhaust is the part that must not appear, so only that is skipped —
      // the flight, the fuse and the disposal all keep running.
      p.mesh.visible = !this.replaying;
      if (!this.replaying) {
        // On the clock rather than on the frame. Emitting once per frame made a
        // single rocket cost four times as many particles at 240 fps as at 60,
        // and both pools hold eleven hundred between everything on screen — so a
        // fast machine spent its whole particle budget on exhaust and recycled
        // the trail out from under itself.
        p.trail = (p.trail ?? TRAIL_INTERVAL) + dt;
        if (p.trail >= TRAIL_INTERVAL) {
          p.trail = 0;
          this.effects.rocketTrail(p.x, p.y, p.z);
        }
      }
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

    // Animated finishes, once a frame for the whole game. It walks two short
    // lists of shared textures and materials — see gunskin.js — so the cost is
    // per *finish on screen*, not per player wearing one.
    tickCosmetics(now / 1000);

    // The controller is polled on every frame, in the match *and* in the menu:
    // one path drives the game, the other steers the interface, and a pad that
    // only worked once you were already playing would be a pad you could never
    // press PLAY with.
    const playing = this.state === 'playing';
    this.input.aimAssist = playing ? this.aimAssistAmount() : 0;
    /*
     * Whose pad it is.
     *
     * `playing` alone was not the question. A player standing in a match with
     * the class picker, the pause card, the end-of-match vote or the scoreboard
     * open is looking at an interface, and every face button was still firing
     * the *game's* action at it — so a pad could open all four and press
     * nothing on any of them. The kill cam is deliberately not on this list:
     * skipping it is the jump binding, and that has to stay the game's.
     */
    this.input.pollPad(dt, playing && !this.interfaceOwnsPad);
    // A pad plugged in before the page loaded fires no connect event, so the
    // hints follow the first *use* rather than the arrival.
    if (this.input.padActive !== this._padHinted) {
      this._padHinted = this.input.padActive;
      document.body.classList.toggle('pad', this._padHinted);
      this.hud.setPadHints(this._padHinted);
    }
    // …and the legend, which is about the *interface's* buttons rather than
    // the game's, so it follows what a press is currently aimed at.
    const legend = this._padHinted && (!playing || this.interfaceOwnsPad);
    if (legend !== this._padLegend) {
      this._padLegend = legend;
      document.body.classList.toggle('pad-ui', legend);
    }

    if (this.state !== 'playing') {
      /*
       * The menu's backdrop does not need the display's full frame rate.
       *
       * An open settings panel or modal is an 84%-opaque sheet over the whole
       * screen, so what is behind it is drawn at `MENU_COVERED_HZ` — one 3D
       * frame in five on a 144 Hz display, shadow pass and post chain
       * included, and still smooth enough to judge a video setting by. With
       * only the menu itself up, the match *is* the background and stays
       * smooth, capped at the rate a screen refreshing faster than that cannot
       * show anyway.
       *
       * The skipped time is carried, not dropped: the frame that does run
       * interpolates and ages particles over the whole interval, so nothing
       * runs in slow motion.
       */
      this.menu.tickStats(dt, this.net.rtt * 1000);
      const backdropHz = this.menu.visible
        ? (this.menu.coveredByPanel ? MENU_COVERED_HZ : MENU_BACKDROP_HZ)
        : 0;
      if (backdropHz > 0) {
        this.backdropAcc += dt;
        if (this.backdropAcc < 1 / backdropHz - 0.0008) return;
        dt = this.backdropAcc;
        this.backdropAcc = 0;
      }

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
      this.gfx.render(dt);
      return;
    }

    this.input.applyLook();
    // Not while the cam is holding the gun: the sway on a replayed weapon is
    // the killer's mouse, out of the snapshot ring, and ours dragging it around
    // underneath theirs would be two hands on one rifle.
    if (!this.replaying) {
      this.viewmodel.addLookLag(this.input.lookDelta.yaw, this.input.lookDelta.pitch);
    }

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
    // A dead player has no weapon on screen. It used to stay drawn through the
    // whole death — a rifle floating in the middle of somebody else's kill cam,
    // pointed wherever the corpse had last been facing.
    //
    // The one exception is a replay, where the gun on screen is the *killer's*
    // and `replayGun` has already posed it out of their half of the snapshot
    // ring. Posing it again from our own dead body here would put their weapon
    // in our hands and bob it to a speed nobody is moving at.
    if (!this.replaying) {
      this.viewmodel.visible = this.alive;
      this.viewmodel.update(dt, {
        speed: Math.hypot(this.local.vx, this.local.vz),
        grounded: this.local.onGround,
        ads: this.input.ads,
        sliding: this.local.sliding,
        scoped: this.weapon.scope && this.input.ads,
      });
    }

    this.updateHud(dt);
    this.updateNukeCountdown(nowSec);

    // The shadow frustum follows whatever the camera is looking at. Normally
    // that is us; during a kill cam it is somebody else, ten seconds ago, and a
    // frustum still centred on our corpse leaves the replay unshadowed.
    const sunAt = this.alive ? this.local : this.gfx.camera.position;
    this.gfx.followSun(sunAt.x, sunAt.z);
    this.gfx.render(dt, () => this.viewmodel.render());

    // Last, so the frame it measures is the whole frame. Both calls return on
    // their first line when the mode is shut, which is what makes it safe to
    // leave them unconditionally in the hot loop.
    this.dev.sampleFrame(dt * 1000);
    this.dev.update(this);
  }

  /* ── Developer mode ─────────────────────────────────────────────────────
   *
   * The switch and the four render toggles. Everything that *reads* anything
   * lives in devmode.js; what is here is the part that has to touch the game,
   * and it is deliberately small — four local render flags and nothing else.
   * ───────────────────────────────────────────────────────────────────────── */

  /**
   * Opens or closes the overlays. Refused, quietly, for an account that may
   * not have them: the server said so at the handshake and this is not a
   * decision the client gets to revisit.
   */
  setDevMode(on) {
    const open = this.dev.toggle(!!on);
    setSetting('devMode', open);
    this.hud.setDevOverlay(open);
    this.menu.devOpen = open;
    this.menu.renderDeveloper?.();
    if (!open) this.applyDevRender({ wireframe: false, nopost: false, collision: false, freeze: false });
    return open;
  }

  /** One render toggle, from the overlay's own button row. */
  toggleDevRender(id) {
    const map = {
      wireframe: 'devWireframe', nopost: 'devNoPost',
      collision: 'devCollision', freeze: 'devFreezeFrustum',
    };
    const field = map[id];
    if (!field) return;
    this.applyDevRender({ [id]: !this[field] });
  }

  /**
   * Applies whichever render flags were named.
   *
   * Every one of these is a *local* drawing choice with no effect on the
   * simulation and nothing to tell the server about. The collision overlay
   * draws the map's own volumes, which is static data this client downloaded
   * before the match began — it shows nobody's position and never has.
   */
  applyDevRender(want) {
    if ('wireframe' in want) {
      this.devWireframe = !!want.wireframe;
      this.gfx.setWireframe?.(this.devWireframe);
    }
    if ('nopost' in want) {
      this.devNoPost = !!want.nopost;
      this.gfx.setPostEnabled?.(!this.devNoPost);
    }
    if ('collision' in want) {
      this.devCollision = !!want.collision;
      this.gfx.setCollisionDebug?.(this.devCollision, this.world);
    }
    if ('freeze' in want) {
      this.devFreezeFrustum = !!want.freeze;
      this.gfx.setFrustumFrozen?.(this.devFreezeFrustum);
    }
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

    /*
     * The movement timers as they stand *before* this input is simulated.
     *
     * The reconciliation below replays every unacknowledged input from the
     * server's state, and the server's state has no timers in it — see CARRIED
     * in shared/movement.js for what that used to do to a slide. Recorded per
     * input rather than kept in one place because the input that matters is
     * whichever one is at the head of the queue when the packet lands, and that
     * is not knowable here.
     */
    inp.pre = carry(this.local);

    this.pending.push(inp);
    if (this.pending.length > 200) this.pending.shift();
    this.net.queueInput(seq, keys, inp.yaw, inp.pitch);

    if (!this.alive) return;

    const wasGrounded = this.local.onGround;
    const wasSliding = this.local.sliding;
    step(this.local, inp, this.world, K.TICK_DT, this.moveOptsFor(keys));

    // A stair is a teleport upward as far as the eye is concerned — the body
    // climbs it in one step, because that is what `moveAndCollide` does with a
    // ledge inside the step height. The camera stays where it was and rises,
    // which is the whole of what `steppedUp` was recorded for.
    if (this.local.steppedUp > 0) {
      this.stepOffset = Math.min(K.STEP_HEIGHT * 1.2, this.stepOffset + this.local.steppedUp);
    }

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

    /*
     * The kill cam owns the camera outright while it is running.
     *
     * It hands back a position and a look-at rather than moving anything
     * itself — killcam.js has no business touching a three.js camera — and a
     * frame where it cannot find its subject returns null and falls through to
     * the ordinary rules below, which is the right failure: a cam that has lost
     * the body it was orbiting should get out of the way, not point at nothing.
     */
    if (!this.alive && this.killCam.active) {
      const shot = this.killCam.update(dt, this.entities, this.deathAt, this.world);
      if (shot) {
        cam.position.set(shot.from.x, shot.from.y, shot.from.z);
        // Angles, not a look-at. `lookAt` cannot express a view pointing
        // straight up — and "cannot look straight up" is not a property a
        // first-person camera is allowed to have — and being a hard set, it cut
        // the orientation on the frame the replay handed over to the orbit
        // while the position eased across. The cam aims itself now; the
        // fallback is kept for the frame a map swap leaves it with neither.
        if (shot.rot) cam.rotation.set(shot.rot.pitch, shot.rot.yaw, 0, 'YXZ');
        else if (shot.at) cam.lookAt(shot.at.x, shot.at.y, shot.at.z);
        return;
      }
    }

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

    /*
     * The eye catches up with the body rather than being nailed to it.
     *
     * A crouch, a slide and every stair in the game move `local.height` or
     * `local.y` by more in one frame than a walking player moves in ten, and
     * a camera that copies them is a camera that cuts. Both filters are
     * purely visual — nothing below this line is ever sent, predicted or
     * tested against — and both are dropped for a jump too big to be either,
     * which is a spawn or a teleport and wants to be a cut.
     */
    const wantHeight = this.local.height;
    if (Math.abs(wantHeight - this.viewHeight) > VIEW_HEIGHT_SNAP) {
      this.viewHeight = wantHeight;
      this.stepOffset = 0;
    } else {
      const tau = wantHeight < this.viewHeight ? DUCK_TAU : RISE_TAU;
      this.viewHeight += (wantHeight - this.viewHeight) * (1 - Math.exp(-dt / tau));
    }
    this.stepOffset *= Math.exp(-dt / STEP_UP_TAU);
    if (this.stepOffset < 0.002) this.stepOffset = 0;

    cam.position.set(
      this.local.x + this.smooth.x,
      this.local.y + this.viewHeight - K.EYE_OFFSET - this.stepOffset + this.smooth.y,
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
    const view = {
      camera: this.gfx.camera,
      world: this.world,
      nowSec: performance.now() / 1000,
    };

    /*
     * The kill cam's replay, which is this same call pointed at a moment ten
     * seconds ago. Every body in the room rewinds with the camera because they
     * are all read out of one buffer by one interpolator — there is no second
     * playback path to keep in step with this one.
     */
    const replay = this.killCam.replayTime;
    if (replay !== null) {
      if (!this.replaying) this.beginReplay(replay);
      this.entities.update(replay, dt, view);
      // Bodies first, then the gun that is about to fire, then the rounds that
      // passed between them: the rays below are cast against the positions this
      // call has just written, and a shot has to kick a weapon that is already
      // the killer's rather than the one we died holding.
      this.replayGun(dt, replay);
      this.replayShots(this.replayShotAt, replay);
      this.replayShotAt = replay;
      return;
    }
    if (this.replaying) this.endReplay();

    // Render remote entities INTERP_DELAY behind the server clock.
    const target = this.net.serverTime - K.INTERP_DELAY * 1000;
    if (this.renderTime === 0) this.renderTime = target;
    this.renderTime += dt * 1000;
    this.renderTime += (target - this.renderTime) * Math.min(1, dt * 3.5);
    this.entities.update(this.renderTime, dt, view);
  }

  /**
   * Puts the scene into the past, and takes it out again.
   *
   * Three things have to move together, which is why they are a pair of
   * methods rather than three flags read in three places: the entity manager
   * has to know it is being asked about a moment that is not now, the killer's
   * own body has to come off the screen because the camera is standing inside
   * it, and ours has to go on.
   */
  beginReplay(at) {
    this.replaying = true;
    for (const p of this.projectiles) p.mesh.visible = false;
    this.entities.replaying = true;
    this.entities.hidden = this.killCam.shot?.targetId ?? 0;
    // Nothing older than the first frame of the replay: the log runs a couple
    // of seconds deeper than the cam does, and firing all of it on the opening
    // frame would be a wall of tracers nobody fired.
    this.replayShotAt = at;
    this.replaySlot = -1;
    this.replayWeapon = null;
    this.replayAim = null;
  }

  /**
   * Puts the killer's weapon in the cam's hands.
   *
   * The replay is their eye, and an eye with nothing under it is a camera
   * floating through a level: you watch the kill without ever seeing what did
   * it, and a shotgun and a sniper look identical from inside the skull of the
   * person holding them. So the viewmodel — the same one that draws our own gun
   * every other frame of the game — is handed the killer's weapon for the
   * length of the replay and taken back afterwards.
   *
   * Everything it needs is already on the wire. The class rides on the profile,
   * the slot rides in the snapshot (which is what makes a mid-replay switch
   * follow, rather than showing the rifle they started the fight with all the
   * way through a pistol kill), and the finish rides on the wardrobe the join
   * announced — so the gun in the cam is the gun they were actually holding,
   * skin and all.
   *
   * The pose is driven the way ours is: their ground speed bobs it, their
   * mouse drags it. `addLookLag` wants a per-frame delta rather than an angle,
   * so the previous frame's aim is kept and differenced here.
   */
  replayGun(dt, at) {
    const shot = this.killCam.shot;
    const s = shot ? this.entities.sampleAt(shot.targetId, at, true) : null;
    const e = shot ? this.entities.get(shot.targetId) : null;
    // The killer left mid-replay, and the cam has fallen back to its orbit —
    // which is a shot from outside a body, so there is no first-person weapon
    // to be holding. Left drawn, it is a rifle hanging in the middle of the
    // frame belonging to nobody.
    if (!s || !e) { this.viewmodel.visible = false; return; }

    const slot = Math.max(0, Math.min(2, e.lastSlot | 0));
    if (slot !== this.replaySlot) {
      this.replaySlot = slot;
      this.replayWeapon = loadoutFor(e.profile?.classId ?? this.classId)[slot] ?? null;
      if (this.replayWeapon) {
        // Their wardrobe, and the default rather than *ours* when they have
        // none: `setWeapon` falls back to the last loadout it was given, which
        // would put our own finishes on somebody else's gun.
        this.viewmodel.setWeapon(this.replayWeapon, SLOT_FOR[slot] ?? COS.SLOT.PRIMARY,
          e.profile?.cos ?? { ...COS.DEFAULT_EQUIP });
      }
    }
    // No loadout to draw — a class this build does not know. Nothing is better
    // than the wrong gun.
    if (!this.replayWeapon) { this.viewmodel.visible = false; return; }

    if (this.replayAim) {
      let dy = s.yaw - this.replayAim.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.viewmodel.addLookLag(dy, s.pitch - this.replayAim.pitch);
      this.replayAim.yaw = s.yaw;
      this.replayAim.pitch = s.pitch;
    } else {
      this.replayAim = { yaw: s.yaw, pitch: s.pitch };
    }

    this.viewmodel.visible = true;
    this.viewmodel.update(dt, {
      speed: e.speed ?? 0,
      // Their sights and their feet, off the same flag word the third-person
      // body is posed from.
      grounded: e.grounded !== false,
      ads: !!e.ads,
      sliding: !!e.sliding,
      scoped: !!this.replayWeapon.scope && !!e.ads,
    });
  }

  endReplay() {
    this.replaying = false;
    this.entities.replaying = false;
    this.entities.hidden = 0;
    // The gun goes back to being ours. `visible` is settled by the frame loop —
    // we are still dead here, so it stays off until the respawn.
    if (this.replayWeapon) {
      this.viewmodel.setWeapon(this.weapons[this.slot], SLOT_FOR[this.slot] ?? COS.SLOT.PRIMARY, this.cos);
      this.replayWeapon = null;
      this.replaySlot = -1;
      this.replayAim = null;
    }
    // Ten seconds forward in one frame is not a death, and the interpolator
    // reads a death out of a body that was alive on the previous frame and is
    // not on this one. Without this, everybody who died inside the replayed
    // window falls over a second time as it ends.
    this.entities.syncAlive(this.net.serverTime - K.INTERP_DELAY * 1000);
    // …and the render clock has been ignored for ten seconds; let it re-seed
    // from the server's rather than easing back across the whole gap.
    this.renderTime = 0;
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
      // The kill cam holds the respawn the same way everything else on this
      // line does — by being one more reason not to ask for one. That is the
      // whole of its authority over the match: it never moves the server's
      // timer, it only declines to spend it.
      const busy = this.respawnHeld || this.inGameMenuOpen || this.hud.chatOpen
        || this.menu.classModalOpen || this.menu.perkModalOpen || this.menu.visible
        || this.hud.matchEndOpen
        || this.scoreboardPinned || !!this.afkNotice || this.killCam.holding
        || !$('pause').classList.contains('hidden');

      if (this.killCam.active) {
        const view = this.killCam.view();
        if (view) this.hud.updateKillCam(view, this.respawnAt - nowSec);
      } else if (this.hud.killCamOpen) {
        // The cam ended itself — ran out, or lost its subject. The plain death
        // screen takes over for whatever is left of the respawn, so a player
        // is never left looking at nothing.
        this.hud.hideKillCam();
        this.hud.showDeath(this.lastKiller?.name ?? 'the world', this.lastKiller?.weapon,
          Math.max(0, this.respawnAt - nowSec), this.lastKiller?.health,
          { clan: this.lastKiller?.clan, clanVerified: this.lastKiller?.clanVerified });
      } else {
        this.hud.updateDeathTimer(this.respawnAt - nowSec, busy);
      }
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
      mult: this.perkMods.spread,
    });

    this.hud.update({
      health: this.health,
      maxHealth: this.maxHealth,
      ammo: this.ammo[this.slot],
      reserve: this.reserve[this.slot],
      weapon: w,
      slot: this.slot,
      reloading: this.reloading,
      // Against the length the *server* gave this reload, not the weapon's own:
      // a perk stretches or shortens it, and a bar measured off the weapon
      // would fill early for a Trooper and stall for a Juggernaut.
      reloadFrac: this.reloading
        ? clamp(1 - (this.reloadEnd - nowSec) / Math.max(0.05, this.reloadTime || w.reloadTime || 1), 0, 1)
        : 0,
      godMode: this.godMode,
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
      // No body under the camera — between matches, or with everybody down at
      // once. The HUD reads that as "nothing to show" rather than as a player
      // sitting on zero health.
      hasBody: !!e,
      health: e ? e.health : 0,
      ammo: this.specAmmo?.[0] ?? (w.magSize ?? 0),
      reserve: this.specAmmo?.[1] ?? -1,
      weapon: w,
      slot,
      reloading: !!e && !!this.specAmmo?.[2],
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

    // The perk card belongs to the body the camera is on rather than to us: a
    // watcher in a Perks match is reading the trade the person they are
    // watching took, and we took none. Absent in every other mode, because the
    // profile only carries a perk where one was chosen.
    this.hud.setPerk(e?.profile?.perk ? K.getPerk(e.profile.perk) : null);

    // The bar names whoever the camera settled on. The room retargets silently
    // when somebody dies, so the name under it has to follow every frame rather
    // than only the frames a message happened to arrive on.
    this.updateSpectatorBar();

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
  /*
   * The interface's language.
   *
   * Started after the game rather than before it because it has nothing to do
   * with WebGL and everything to draw: `init` translates whatever is already on
   * screen and then watches for the rest, so the order it runs in decides only
   * how many nodes the first pass has to walk. `/meta` arrives later and hands
   * over the server's own default, for an operator running this for one
   * country. An English player pays for none of it — see i18n.js.
   */
  i18n.init();
  document.addEventListener('pointerdown', () => { initAudio(); resumeAudio(); }, { once: true });
});
