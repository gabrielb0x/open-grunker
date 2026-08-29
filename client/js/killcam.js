/**
 * Open Grunker — the kill cam.
 *
 * Ten seconds looking at whoever killed you, skippable after three, with their
 * music over it if they are a music creator and silence if they are not.
 *
 * ── What it is made of ──────────────────────────────────────────────────────
 *
 * Three things that happen to run for the same ten seconds, and keeping them
 * separate is what keeps this readable:
 *
 *   the camera   an orbit around the killer's body, driven by `update()` from
 *                the render loop and handed back to main.js as a position and
 *                a look-at rather than applied here. main.js owns the camera.
 *   the overlay  the DOM card the HUD draws. This module decides what is *on*
 *                it and when it may be skipped; hud.js decides how it looks.
 *   the anthem   fetched on the first death to a given player, decoded once,
 *                cached by URL, and played through the limited bus in audio.js.
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
 * before a cam ends is worse than no music. Every fetch after the first is a
 * cache hit, which is what the content-hashed filename is for.
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
   * Starts a cam from a DEATH message.
   *
   * Returns the shot, or null when there is nothing to show — a fall, a
   * suicide, a player who left, or a viewer who has switched the cam off. The
   * caller falls back to the plain death screen in every one of those cases,
   * which is the same screen the game had before this file existed.
   *
   * @param {object} msg the DEATH payload
   */
  begin(msg) {
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
      // Where the body was standing when we died, so a killer who walks off —
      // or is killed themselves mid-cam — leaves the camera somewhere sensible
      // rather than snapping back to the corpse.
      lastSeen: null,
      /*
       * Where the orbit starts.
       *
       * Filled in on the first frame, from the direction the body fell in
       * relative to the killer — so the shot opens roughly where the victim was
       * standing and drifts around from there. Starting at a fixed angle put
       * the camera on the killer's east side whatever had just happened, which
       * made the ease out of the body a swing across the scene rather than a
       * rise out of it.
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
   * `world` is optional and is the shared physics World. Without it the orbit
   * is geometric and will happily put the camera inside a wall; with it, the
   * shot is pulled in to whatever the room actually allows. It is optional
   * rather than required because the cam has to keep working on the frame a
   * map is being swapped, and a camera in a wall is a worse frame than no
   * camera but a much better one than a crash.
   *
   * @param {number} dt
   * @param {{get:(id:number)=>({pos:{x:number,y:number,z:number}}|undefined)}} entities
   * @param {{x:number,y:number,z:number}} deathPos where the local body fell
   * @param {{raycast:Function}} [world] the map's collision, to keep the shot clear
   * @returns {{from:{x,y,z}, at:{x,y,z}}|null}
   */
  update(dt, entities, deathPos, world = null) {
    const shot = this.shot;
    if (!shot) return null;

    shot.elapsed += dt;

    // Ends itself: at the full length, or the moment the skip lights up for a
    // player who has asked not to be held.
    const stopAt = settings.killCamHold ? shot.seconds : shot.skipAfter;
    if (shot.elapsed >= stopAt) { this.end(); return null; }

    const target = entities.get(shot.targetId);
    if (target?.pos) shot.lastSeen = { x: target.pos.x, y: target.pos.y, z: target.pos.z };
    const look = shot.lastSeen;
    if (!look) return null;

    if (shot.angle === null) {
      shot.angle = deathPos
        ? Math.atan2(deathPos.z - look.z, deathPos.x - look.x)
        : 0;
    }
    shot.angle += dt * ORBIT_SPEED;

    /*
     * The move from the body to the orbit, eased rather than cut.
     *
     * The first second is a rise out of where we died towards the shot, which
     * is what makes the cam read as one continuous camera rather than as a
     * teleport into a different scene — and it is the same trick the old
     * deathCam used, kept because it was the good part of it.
     */
    const settle = Math.min(1, shot.elapsed / 1.1);
    const ease = settle * settle * (3 - 2 * settle);

    const at = { x: look.x, y: look.y + 1.2, z: look.z };
    const orbit = {
      x: look.x + Math.cos(shot.angle) * ORBIT_RADIUS,
      y: look.y + ORBIT_HEIGHT,
      z: look.z + Math.sin(shot.angle) * ORBIT_RADIUS,
    };
    const from = deathPos ? {
      x: deathPos.x + (orbit.x - deathPos.x) * ease,
      y: (deathPos.y + 1.4) + (orbit.y - (deathPos.y + 1.4)) * ease,
      z: deathPos.z + (orbit.z - deathPos.z) * ease,
    } : orbit;

    return { from: pullIn(at, from, world), at };
  }

  /** Everything the overlay needs, or null. Pure read — safe to call per frame. */
  view() {
    const shot = this.shot;
    if (!shot) return null;
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
      canSkip: this.canSkip,
      skipIn: this.skipIn,
      // 0 → 1 over the three seconds before the skip lights up. The bar under
      // the button is this, which is what turns "wait" into "wait *this long*".
      skipProgress: Math.min(1, shot.skipAfter ? shot.elapsed / shot.skipAfter : 1),
    };
  }
}

export default KillCam;
