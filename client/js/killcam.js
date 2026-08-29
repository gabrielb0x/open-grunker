/**
 * Open Grunker — the kill cam.
 *
 * Ten seconds of the fight you just lost, played back through the eyes of
 * whoever won it, skippable after three, with their music over it if they are
 * a music creator and silence if they are not.
 *
 * ── What it is made of ──────────────────────────────────────────────────────
 *
 * Four things that happen to run for the same ten seconds, and keeping them
 * separate is what keeps this readable:
 *
 *   the replay   the scene rewound to `deathAt - KILLCAM_SECONDS` and played
 *                forward at real time. Nothing is recorded for it: the entity
 *                buffer every client already interpolates out of is simply
 *                asked about an older moment, so what you watch is the same
 *                interpolation of the same server snapshots that drew the
 *                fight the first time.
 *   the camera   the killer's own eye and view angles, sampled straight out of
 *                that buffer — so a flick they made is the flick you see —
 *                handed back to main.js as a position and a rotation rather
 *                than applied here. main.js owns the camera.
 *   the overlay  the DOM card the HUD draws. This module decides what is *on*
 *                it and when it may be skipped; hud.js decides how it looks.
 *   the anthem   fetched on the first death to a given player, decoded once,
 *                cached by URL, and played through the limited bus in audio.js.
 *
 * ── Why the replay is a *read* and not a recording ──────────────────────────
 *
 * The obvious build is a second buffer written on every snapshot and a second
 * interpolator to play it back. Both already exist: entities.js has held a
 * ring of snapshots and the code to read a moment out of it since the first
 * day of network play, and the only thing standing between that and a replay
 * was the length of the ring. So the ring got longer (entities.js, BUFFER_MS)
 * and this file asks it for a timestamp ten seconds old. A replay that shares
 * one interpolator with live play cannot drift from live play, and there is no
 * second copy of "where was everybody" to keep in step with the first.
 *
 * The one thing a snapshot does not carry is the *recipient's* own entry — the
 * server cuts it, because that client is predicting it — so the game layer
 * hands its own state to `pushSnapshot` alongside. Without it the replay would
 * show the killer's ten seconds with the person they were shooting at missing.
 *
 * ── When it falls back to the orbit ─────────────────────────────────────────
 *
 * A replay needs history, and there are three ordinary ways not to have it:
 * dying within a few seconds of joining, dying to somebody who has since left
 * the room, and a director's cut that runs longer than the buffer is deep. In
 * every one of them the cam falls back to the orbit shot this file used to do
 * outright — a slow quarter-turn around the killer — which is also what runs
 * after a replay reaches the moment of death and still has cam left.
 *
 * ── Why nothing here is a server rule ───────────────────────────────────────
 *
 * The room's respawn timer is untouched at RESPAWN_TIME. This holds the respawn
 * the same way the pause menu and the open scoreboard already do — by not
 * asking for one — so a client that skipped the whole thing would respawn at
 * 2.6 s and be exactly as well off as one that pressed the button. The cam is
 * a camera. It is not allowed to be anything else.
 *
 * ── The anthem's timing ─────────────────────────────────────────────────────
 *
 * The track is not prefetched when somebody joins. Eight players with anthems
 * would be five megabytes downloaded for a match in which most of them never
 * kill you, and a phone on a train pays for all of it. So it is fetched on the
 * death that needs it, and the cam starts without waiting: if the file lands
 * inside `ANTHEM_LATE_CUTOFF` it fades in wherever the cam has got to, and if
 * it lands after that it is dropped, because music that starts two seconds
 * before a cam ends is worse than no music.
 */
import * as K from '/shared/constants.js';
import { loadAnthem, playAnthem, stopAnthem } from './audio.js';
import { settings } from './settings.js';

/** Past this far into the cam, a track that has only just arrived is dropped. */
const ANTHEM_LATE_CUTOFF = 4;

/** How far off a wall the camera stops, so it never sits inside the surface. */
const WALL_MARGIN = 0.35;
/** Closer than this to the subject is a face full of model, not a shot. */
const MIN_SHOT = 1.6;
/** How far up the overhead fallback will look for a ceiling before giving up. */
const OVERHEAD_MAX = 4.2;

/** How far the camera sits from the killer, and how high it looks from. */
const ORBIT_RADIUS = 4.6;
const ORBIT_HEIGHT = 2.4;
/** Radians per second. A quarter turn over the ten seconds — a drift, not a spin. */
const ORBIT_SPEED = 0.16;

/**
 * Less replay than this is not worth cutting to.
 *
 * Under about a second and a half the cut in, the shot and the cut out land on
 * top of each other and it reads as a glitch rather than as a replay — so a
 * player who died four seconds after spawning gets the orbit, which needs no
 * history at all.
 */
const MIN_REPLAY_MS = 1500;

/**
 * Finds somewhere to stand that can actually see the subject.
 *
 * The one failure every orbiting death camera has is a killer with their back
 * to a wall: a quarter of the orbit spent looking at the inside of it. The fix
 * is the one a third-person camera uses — cast from the *subject* outwards and
 * stop short of what the ray hits, rather than from the camera, which is
 * already in the wall by the time anybody thinks to ask.
 *
 * Three answers, in order:
 *
 *  1. **Nothing in the way** — the ordinary case, and the wanted shot is used
 *     unchanged. Measured over every orbit position on every map in the game,
 *     that is about 98.6% of them.
 *  2. **Something in the way, with room behind them** — pull in to just short
 *     of it. This is the whole of what a pull-in camera normally does.
 *  3. **Something in the way and no room at all** — a corner, a doorway, a
 *     stairwell. Going as close as the wall allows would put the camera inside
 *     the body it is meant to be filming, so it goes *overhead* instead and
 *     looks down, which is what there is always room for. Pulling in with no
 *     floor under it left the camera inside geometry three times as often as
 *     this does, and inside a player model besides.
 *
 * The last line is the case where even overhead is blocked — under a low
 * ceiling in a corner — and there is genuinely nowhere to put a camera. It
 * takes what room there is, because a bad shot beats a shot inside a wall.
 */
function pullIn(at, want, world) {
  if (!world?.raycast) return want;
  let dx = want.x - at.x, dy = want.y - at.y, dz = want.z - at.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return want;
  dx /= dist; dy /= dist; dz /= dist;

  // `raycast` answers with the distance it was given when it hit nothing, so a
  // hit is only a hit if it came back short of where we asked to go.
  const hit = world.raycast(at.x, at.y, at.z, dx, dy, dz, dist);
  if (!hit || hit.dist >= dist - 1e-4) return want;

  const back = hit.dist - WALL_MARGIN;
  if (back >= MIN_SHOT) return { x: at.x + dx * back, y: at.y + dy * back, z: at.z + dz * back };

  const up = world.raycast(at.x, at.y, at.z, 0, 1, 0, OVERHEAD_MAX);
  const room = (up && up.dist < OVERHEAD_MAX) ? up.dist - WALL_MARGIN : OVERHEAD_MAX;
  if (room >= MIN_SHOT) return { x: at.x, y: at.y + room, z: at.z };

  const last = Math.max(0, back);
  return { x: at.x + dx * last, y: at.y + dy * last, z: at.z + dz * last };
}

export class KillCam {
  constructor() {
    /** The live cam, or null. Everything else here reads this. */
    this.shot = null;
    /** Bumped per death, so a late fetch can tell whose death it belongs to. */
    this.token = 0;
  }

  get active() { return !!this.shot; }

  /**
   * Whether the cam is holding the respawn right now.
   *
   * Separate from `active` because the two stop being the same thing the
   * moment somebody presses skip: the overlay is gone, the respawn is free, and
   * the camera may still be easing back for a frame or two.
   */
  get holding() { return !!this.shot && !this.shot.skipped; }

  /** May the player skip yet, and how long until they can? */
  get skipIn() {
    if (!this.shot) return 0;
    return Math.max(0, this.shot.skipAfter - this.shot.elapsed);
  }

  get canSkip() { return !!this.shot && this.shot.elapsed >= this.shot.skipAfter; }

  /**
   * The moment on the server clock the whole scene should be drawn at, or null
   * to draw the present.
   *
   * This is the entire interface between the replay and the renderer: main.js
   * hands it to `entities.update` in place of the live render time, and every
   * body in the room rewinds with the camera because they are read out of the
   * same buffer by the same interpolator.
   */
  get replayTime() {
    const shot = this.shot;
    if (!shot?.replay) return null;
    const t = shot.replayFrom + shot.elapsed * 1000;
    return t < shot.replayTo ? t : null;
  }

  /** True while the replay half of the cam is running. */
  get replaying() { return this.replayTime !== null; }

  /**
   * Starts a cam from a DEATH message.
   *
   * Returns the shot, or null when there is nothing to show — a fall, a
   * suicide, a player who left, or a viewer who has switched the cam off. The
   * caller falls back to the plain death screen in every one of those cases,
   * which is the same screen the game had before this file existed.
   *
   * @param {object} msg the DEATH payload
   * @param {{earliestTime:number, latestTime:number}} [history] the snapshot
   *        ring the replay is read out of. Without one — or without enough in
   *        it — the cam is the orbit alone, which is what it always was.
   */
  begin(msg, history = null) {
    this.end();
    const seconds = msg.cam?.seconds ?? 0;
    // `byId` is 0 for the world — a fall, a rocket of your own, the void. There
    // is nobody to look at, so there is no cam.
    if (!seconds || !msg.byId || !settings.killCam) return null;

    const token = ++this.token;
    /*
     * The director's cut, and it comes off the message rather than out of a
     * flag this client keeps for itself: `cam.director` is non-zero only when
     * the *server* decided this account is a video creator, so there is one
     * answer and no second copy of it here to drift.
     *
     * It is only ever *offered*. The shot holds for longer if the player keeps
     * it, and the skip still lights up at the same three seconds as everybody
     * else's — a creator perk that made a death screen harder to leave would be
     * a punishment for being a creator.
     */
    const total = msg.cam?.director > 0 ? msg.cam.director : seconds;

    /*
     * The window to replay.
     *
     * It ends at the newest snapshot rather than at the current server clock:
     * the clock runs on past the last packet, and asking the buffer about a
     * moment it has not been told about yet would freeze the first frames of
     * the replay on whatever it last knew. It starts `seconds` earlier, or at
     * the oldest frame still held, whichever is later.
     */
    let replayFrom = 0, replayTo = 0, replay = false;
    if (history && settings.killCamReplay !== false) {
      replayTo = history.latestTime;
      replayFrom = Math.max(history.earliestTime, replayTo - seconds * 1000);
      replay = replayTo - replayFrom >= MIN_REPLAY_MS;
    }

    this.shot = {
      token,
      targetId: msg.byId,
      name: msg.by,
      clan: msg.byClan ?? null,
      clanVerified: !!msg.byClanVerified,
      verified: !!msg.byVerified,
      level: msg.byLevel ?? 0,
      creator: msg.byCreator ?? null,
      weapon: msg.weapon,
      head: !!msg.head,
      distance: msg.distance ?? 0,
      health: msg.killerHealth ?? 0,
      anthemTitle: msg.anthemTitle ?? null,
      // Set once the file is decoded and actually started, so the overlay can
      // credit a track that is playing rather than one that might be.
      anthemPlaying: false,
      director: msg.cam?.director > 0,
      seconds: total,
      skipAfter: Math.min(msg.cam?.skipAfter ?? K.KILLCAM_SKIP_AFTER, total),
      elapsed: 0,
      skipped: false,
      replay,
      replayFrom,
      replayTo,
      /** Where the camera was on the last frame of the replay, to ease out of. */
      handoff: null,
      // Where the body was standing when we died, so a killer who walks off —
      // or is killed themselves mid-cam — leaves the camera somewhere sensible
      // rather than snapping back to the corpse.
      lastSeen: null,
      /*
       * Where the orbit starts.
       *
       * Filled in on the first frame it runs, from the direction the body fell
       * in relative to the killer — so the shot opens roughly where the victim
       * was standing and drifts around from there. Starting at a fixed angle
       * put the camera on the killer's east side whatever had just happened,
       * which made the ease out of the body a swing across the scene rather
       * than a rise out of it.
       */
      angle: null,
    };

    if (msg.anthem && settings.anthemVolume > 0) this._cueAnthem(msg.anthem, token);
    return this.shot;
  }

  /**
   * Fetches, decodes and starts a track — if the death it belongs to is still
   * the one on screen by the time it is ready.
   *
   * Both guards matter. `token` catches a respawn-and-die inside the fetch;
   * `elapsed` catches a slow connection, where the honest answer is to play
   * nothing rather than a sting over the last second of a cam.
   */
  async _cueAnthem(url, token) {
    const buffer = await loadAnthem(url);
    if (!buffer || !this.shot || this.shot.token !== token) return;
    if (this.shot.elapsed > ANTHEM_LATE_CUTOFF) return;
    playAnthem(buffer, { volume: settings.anthemVolume });
    this.shot.anthemPlaying = true;
  }

  /** The player pressed skip. Ignored before the cam says they may. */
  skip() {
    if (!this.canSkip || !this.shot) return false;
    this.shot.skipped = true;
    this.end();
    return true;
  }

  /** Tears the cam down and takes the music with it. */
  end() {
    if (!this.shot) return;
    this.shot = null;
    stopAnthem();
  }

  /**
   * Advances the cam and works out where the camera wants to be.
   *
   * Returns null when there is nothing to place — no cam, or a killer the
   * client cannot see — and main.js then leaves the camera wherever its own
   * rules put it. That is the correct failure: a cam that cannot find its
   * subject should get out of the way, not point at the origin.
   *
   * Two shapes come back. The replay half returns `rot`, the killer's own view
   * angles, which main.js sets on the camera directly — a `lookAt` cannot
   * reproduce a view that is pointing straight up, and being unable to look
   * straight up is not a property a first-person camera may have. The orbit
   * half returns `at`, a point to aim at, and no rotation.
   *
   * `world` is optional and is the shared physics World. Without it the orbit
   * is geometric and will happily put the camera inside a wall; with it, the
   * shot is pulled in to whatever the room actually allows. It is optional
   * rather than required because the cam has to keep working on the frame a
   * map is being swapped, and a camera in a wall is a worse frame than no
   * camera but a much better one than a crash.
   *
   * @param {number} dt
   * @param {{get:Function, sampleAt:Function}} entities
   * @param {{x:number,y:number,z:number}} deathPos where the local body fell
   * @param {{raycast:Function}} [world] the map's collision, to keep the shot clear
   * @returns {{from:{x,y,z}, at?:{x,y,z}, rot?:{yaw,pitch}, replay:boolean}|null}
   */
  update(dt, entities, deathPos, world = null) {
    const shot = this.shot;
    if (!shot) return null;

    shot.elapsed += dt;

    // Ends itself: at the full length, or the moment the skip lights up for a
    // player who has asked not to be held.
    const stopAt = settings.killCamHold ? shot.seconds : shot.skipAfter;
    if (shot.elapsed >= stopAt) { this.end(); return null; }

    const pov = this._pov(entities);
    if (pov) return pov;

    return this._orbit(dt, entities, deathPos, world);
  }

  /**
   * The replay half: the camera is the killer's eye, exactly.
   *
   * Everything it needs is one sample out of the snapshot ring, taken here
   * rather than read off the entity — main.js places the camera *before* it
   * interpolates the bodies, so reading the entity would draw a view one frame
   * behind the world it is looking at.
   */
  _pov(entities) {
    const t = this.replayTime;
    if (t === null || !entities?.sampleAt) return null;
    const s = entities.sampleAt(this.shot.targetId, t);
    // The killer left the room mid-replay, taking their half of the buffer
    // with them. The orbit cannot find them either, and both say so by
    // answering null; the death screen takes over.
    if (!s) return null;
    const from = { x: s.x, y: s.y + s.height - K.EYE_OFFSET, z: s.z };
    this.shot.handoff = from;
    return { from, rot: { yaw: s.yaw, pitch: s.pitch }, replay: true };
  }

  /**
   * The orbit half: a slow quarter-turn around the killer.
   *
   * Runs when there was never enough history to replay, and again once a
   * replay has caught up with the moment of death and the cam still has time
   * on it — which is the whole of a director's cut past the first ten seconds.
   */
  _orbit(dt, entities, deathPos, world) {
    const shot = this.shot;
    const target = entities.get(shot.targetId);
    if (target?.pos) shot.lastSeen = { x: target.pos.x, y: target.pos.y, z: target.pos.z };
    const look = shot.lastSeen;
    if (!look) return null;

    if (shot.angle === null) {
      // Where the shot opens. After a replay that is wherever the replay's last
      // frame left the camera, so the two are one continuous move rather than
      // a cut; without one it is where the body fell, which is where the
      // player was looking from a moment ago.
      const seed = shot.handoff ?? deathPos;
      shot.angle = seed ? Math.atan2(seed.z - look.z, seed.x - look.x) : 0;
      shot.settleFrom = seed ? { x: seed.x, y: seed.y, z: seed.z } : null;
      shot.settleT = 0;
    }
    shot.angle += dt * ORBIT_SPEED;
    shot.settleT += dt;

    /*
     * The move from wherever the camera was to the orbit, eased rather than cut.
     *
     * That is what makes the cam read as one continuous camera rather than as
     * a teleport into a different scene — and it is the same trick the old
     * deathCam used, kept because it was the good part of it.
     */
    const settle = Math.min(1, shot.settleT / 1.1);
    const ease = settle * settle * (3 - 2 * settle);

    const at = { x: look.x, y: look.y + 1.2, z: look.z };
    const orbit = {
      x: look.x + Math.cos(shot.angle) * ORBIT_RADIUS,
      y: look.y + ORBIT_HEIGHT,
      z: look.z + Math.sin(shot.angle) * ORBIT_RADIUS,
    };
    const start = shot.settleFrom;
    const from = start ? {
      x: start.x + (orbit.x - start.x) * ease,
      y: (start.y + 1.4) + (orbit.y - (start.y + 1.4)) * ease,
      z: start.z + (orbit.z - start.z) * ease,
    } : orbit;

    return { from: pullIn(at, from, world), at, replay: false };
  }

  /** Everything the overlay needs, or null. Pure read — safe to call per frame. */
  view() {
    const shot = this.shot;
    if (!shot) return null;
    const replayLength = (shot.replayTo - shot.replayFrom) / 1000;
    const replaying = this.replayTime !== null;
    return {
      name: shot.name,
      clan: shot.clan,
      clanVerified: shot.clanVerified,
      verified: shot.verified,
      level: shot.level,
      creator: shot.creator,
      weapon: shot.weapon,
      head: shot.head,
      distance: shot.distance,
      health: shot.health,
      anthemTitle: shot.anthemPlaying ? shot.anthemTitle : null,
      director: shot.director,
      elapsed: shot.elapsed,
      seconds: shot.seconds,
      remaining: Math.max(0, shot.seconds - shot.elapsed),
      // The replay's own clock, for the strip under the card: how far through
      // the last ten seconds of the fight this frame is, and how many of them
      // there turned out to be.
      replay: replaying,
      replayLength,
      replayAt: replaying ? Math.min(replayLength, shot.elapsed) : replayLength,
      // Counts down to the death rather than up from the start: what the strip
      // is really saying is "this is what happened N seconds before you died".
      replayLeft: replaying ? Math.max(0, replayLength - shot.elapsed) : 0,
      canSkip: this.canSkip,
      skipIn: this.skipIn,
      // 0 → 1 over the three seconds before the skip lights up. The bar under
      // the button is this, which is what turns "wait" into "wait *this long*".
      skipProgress: Math.min(1, shot.skipAfter ? shot.elapsed / shot.skipAfter : 1),
    };
  }
}

export default KillCam;
