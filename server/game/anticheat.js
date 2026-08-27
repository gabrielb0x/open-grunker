/**
 * Open Grunker — what the room refuses to believe.
 *
 * The netcode was written on one rule and never enforced it: a packet may
 * describe what a player *did*, never what the world *is*. Everything a client
 * used to be able to simply assert about itself — where it was looking when it
 * fired, which spread seed its bullet would use, how far behind the server its
 * screen was, how many simulation steps it was owed — is decided here or in the
 * room from state the server built itself.
 *
 * Two jobs, deliberately kept apart:
 *
 *   1. **Refuse.** Every check hands back the authoritative value, so a caught
 *      packet is played as though the client had told the truth rather than
 *      dropped. A rejected shot still fires — down the barrel the shooter was
 *      really pointing. This is what makes the cheat *useless* rather than
 *      merely detected, and it is the half that matters: a wallhack that aims
 *      where you are actually looking is a worse crosshair than no cheat at all.
 *
 *   2. **Remember.** Refusals are scored. One is a lost packet on a bad line;
 *      forty a second is a userscript. The score decays in real time, so
 *      nothing accumulates across an evening of jitter, and only a sustained
 *      run of them reaches the thresholds that warn, kick and file a report
 *      into the same queue the human reports land in.
 *
 * Nothing here ever *deletes* a shot on suspicion alone. A false positive that
 * silently eats a legitimate player's bullets is worse than the cheat: it is
 * indistinguishable from the server being broken.
 */
import * as K from '../../shared/constants.js';
import config from '../config.js';
import log from '../util/log.js';

const logger = log.child('anticheat');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Shortest signed distance between two angles, in radians. */
export function angleDelta(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Angular distance between two view directions (yaw/pitch pairs), in radians. */
export function viewDistance(yawA, pitchA, yawB, pitchB) {
  // Yaw error shrinks with pitch: looking near-vertical, a large yaw change
  // barely moves the crosshair. Scaling by cos(pitch) is what keeps a legit
  // player who is looking at the sky from tripping the aim check.
  const cp = Math.cos(clamp((pitchA + pitchB) * 0.5, -1.5, 1.5));
  const dy = angleDelta(yawA, yawB) * cp;
  const dp = pitchA - pitchB;
  return Math.hypot(dy, dp);
}

/**
 * Per-connection anti-cheat state.
 *
 * One of these hangs off every Player, bots included — a bot never trips
 * anything, and giving it the same object keeps the room free of null checks in
 * the hot path.
 */
export class CheatState {
  constructor() {
    /** Running suspicion, in points. Decays at CHEAT_DECAY_PER_SEC. */
    this.score = 0;
    /** Incidents by kind, for the report body a moderator ends up reading. */
    this.counts = Object.create(null);
    /** Total incidents, so a single unlucky packet can never reach a threshold. */
    this.incidents = 0;
    /** Server clock at the last decay pass; -1 until there has been one. */
    this.lastDecay = -1;
    /** Has this connection already been warned? Warned once, then acted on. */
    this.warned = false;
    /** Set once the connection has been dropped, so it is only dropped once. */
    this.kicked = false;
    /** The worst single line of evidence per kind — what the report quotes. */
    this.evidence = Object.create(null);

    /* ── Spread centrality ──────────────────────────────────────────────────
     * The residual after the shot counter is taken away from the client: a
     * grinder can still *burn* rounds to skip a seed it does not like. It
     * cannot hide from the average. The draw in shared/shot.js puts a round, on
     * average, 0.78 of the cone half-angle out from point of aim; searching a
     * hundred and sixty seeds for the best one puts it at 0.04. Forty rounds of
     * that is eight standard errors from honest, which is why the threshold can
     * sit a long way below the honest mean and still never reach a real player.
     * Only shots with a cone worth sampling are counted, so a scoped rifle
     * standing still contributes nothing either way.
     * ──────────────────────────────────────────────────────────────────────*/
    this.spreadShots = 0;
    this.spreadSum = 0;
  }

  /** How many of each kind, as a plain object — safe to serialise. */
  summary() {
    const out = {};
    for (const kind of K.CHEAT_KINDS) if (this.counts[kind]) out[kind] = this.counts[kind];
    return out;
  }
}

/**
 * Records one refusal and decides what it costs.
 *
 * @param {object} player     the Player it happened to
 * @param {string} kind       one of K.CHEAT_KINDS
 * @param {string} [detail]   one line of evidence, kept for the report
 * @param {number} [weight]   override for the default weight of this kind
 * @returns {'none'|'warn'|'kick'} what the caller should now do about it
 */
export function flag(player, kind, detail = null, weight = null) {
  const st = player?.cheat;
  if (!st || player.isBot) return 'none';

  const w = weight ?? K.CHEAT_WEIGHTS[kind] ?? 4;
  st.score += w;
  st.counts[kind] = (st.counts[kind] ?? 0) + 1;
  st.incidents++;
  if (detail && !st.evidence[kind]) st.evidence[kind] = String(detail).slice(0, 160);

  if (!config.anticheat.enabled) return 'none';
  if (st.incidents < K.CHEAT_MIN_INCIDENTS) return 'none';
  if (st.score >= config.anticheat.kickScore) return config.anticheat.kick ? 'kick' : 'warn';
  if (st.score >= config.anticheat.warnScore && !st.warned) return 'warn';
  return 'none';
}

/**
 * Sheds suspicion for clean play. Called once per room tick per player, which
 * is why it takes the server clock rather than reading one.
 */
export function decay(player, now) {
  const st = player?.cheat;
  if (!st || st.score <= 0) return;
  // `lastDecay` starts at -1 rather than 0 because a room's clock starts at 0:
  // a falsy check here would throw away the first pass of every match.
  const dt = st.lastDecay < 0 ? 0 : Math.max(0, now - st.lastDecay);
  st.lastDecay = now;
  st.score = Math.max(0, st.score - dt * K.CHEAT_DECAY_PER_SEC);
}

/**
 * Folds one fired round into the spread-centrality average, and reports when
 * the average has become impossible.
 *
 * `offset` is how far the round left point of aim, in radians; `spread` is the
 * cone half-angle it was drawn from. The ratio is what matters — the same
 * absolute offset is dead centre for a hip-fired shotgun and a mile off for a
 * scoped rifle.
 *
 * @returns {boolean} true the moment the sample becomes evidence
 */
export function trackSpread(player, offset, spread) {
  const st = player?.cheat;
  if (!st || player.isBot) return false;
  if (!(spread > 0.004)) return false;              // no cone, nothing to measure
  st.spreadShots++;
  st.spreadSum += clamp(offset / spread, 0, 4);
  if (st.spreadShots < 40) return false;

  const mean = st.spreadSum / st.spreadShots;
  // Reset the window either way: this is a rolling verdict, not a life sentence
  // built out of one bad stretch forty rounds ago.
  st.spreadShots = 0;
  st.spreadSum = 0;
  // Honest is 0.78 with a standard error near 0.07 over this window; a seed
  // grinder is 0.04. Nothing between them is an unlucky forty rounds.
  return mean < 0.18;
}

/**
 * Acts on a verdict: warns the player, or drops the connection and files the
 * report a moderator will read.
 *
 * The report is what makes this stick. A kick costs a cheater one reconnect;
 * a row in the queue with the counts, the evidence and the match it happened in
 * costs them the account, and it is reviewed by a human before it does.
 *
 * @param {object} room     the Room, for chat, the match code and the db
 * @param {object} player
 * @param {'warn'|'kick'} verdict
 * @param {string} kind     what tipped it over
 */
export function enforce(room, player, verdict, kind) {
  const st = player.cheat;
  if (!st || st.kicked) return;

  if (verdict === 'warn') {
    st.warned = true;
    logger.warn(`${player.name} (${player.id}) flagged: ${kind} · score ${Math.round(st.score)} `
      + `· ${JSON.stringify(st.summary())}`);
    room.sendTo(player, {
      o: K.S2C.CHAT,
      system: true,
      kind: 'alert',
      text: 'The server is refusing packets from this client. Close anything modifying the '
        + 'game and reload the page — the connection is dropped if it keeps happening.',
    });
    return;
  }

  st.kicked = true;
  logger.warn(`${player.name} (${player.id}) kicked for cheating: ${kind} `
    + `· score ${Math.round(st.score)} · ${JSON.stringify(st.summary())}`);

  fileReport(room, player, kind);

  room.sendTo(player, {
    o: K.S2C.ERROR,
    code: 'anticheat',
    message: 'Disconnected: this client is sending packets the server will not accept. '
      + 'A report has been filed.',
  });
  // Let the frame reach the socket before it closes under it.
  setTimeout(() => {
    try { player.ws?.close(4010, 'anticheat'); } catch { /* already gone */ }
  }, 60);
}

/**
 * Files the kick as a report, from the server rather than from a player.
 *
 * It goes in the same table the scoreboard's report button writes to, so it
 * lands in the same queue, carries the same evidence fields and is settled with
 * the same buttons. `reporterId` is null — nobody's own reporting ceilings are
 * spent on it, and the reporter column reads "anti-cheat" wherever a name is
 * drawn.
 */
function fileReport(room, player, kind) {
  const db = room.hub?.db;
  if (!db?.reports) return;
  const st = player.cheat;
  try {
    const lines = K.CHEAT_KINDS
      .filter((k) => st.counts[k])
      .map((k) => `${k}×${st.counts[k]}${st.evidence[k] ? ` (${st.evidence[k]})` : ''}`);
    db.reports.add({
      reporterId: null,
      reporterName: 'anti-cheat',
      targetId: player.userId,
      targetName: player.name,
      targetIp: player.ip,
      reason: 'cheat',
      detail: `Automatic: score ${Math.round(st.score)} over ${st.incidents} refused packets. `
        + `Tripped on ${kind}. ${lines.join(', ')}`,
      room: room.code,
      mode: room.modeId,
      map: room.map?.id ?? null,
      chatLog: [],
    });
    room.logEvent?.(db, {
      kind: 'anticheat.kick',
      userId: player.userId,
      name: player.name,
      detail: { trigger: kind, score: Math.round(st.score), counts: st.summary() },
    });
  } catch (err) {
    logger.warn('anti-cheat report write failed:', err.message);
  }
}

export default { CheatState, flag, decay, enforce, trackSpread, angleDelta, viewDistance };
