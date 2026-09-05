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
 * Three jobs, deliberately kept apart:
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
 *   3. **Explain.** `reportBody` turns that memory into a page somebody who has
 *      never opened this file can act on: what was refused, in words; what a
 *      cheat doing it would have been buying; whether a bad connection can
 *      produce it on its own; when it started and when it stopped; and what the
 *      line looked like while it happened. A report nobody can read is a report
 *      that gets closed with "no action", which is the same as not filing it.
 *
 * Nothing here ever *deletes* a shot on suspicion alone. A false positive that
 * silently eats a legitimate player's bullets is worse than the cheat: it is
 * indistinguishable from the server being broken.
 *
 * ── Lag is not cheating ─────────────────────────────────────────────────────
 *
 * Four of the seven kinds are decided by what a packet *contains* and cannot be
 * produced by a bad line at all. Three — `lag`, `rate` and `speed` — are
 * decided by when packets *arrive*, and arrival times on a lossy connection are
 * not a measurement of the client: TCP holds a stalled stream and then delivers
 * the entire backlog in one frame, which looks exactly like a burst-fire speed
 * hack for as long as you only look at one second of it.
 *
 * So all three are counted as sustained rates rather than as bursts, with the
 * burst itself explicitly forgiven, and all three are weighted below the decay
 * rate: one a second is a connection the server sheds faster than it
 * accumulates. Reaching a threshold on those three alone takes a client
 * genuinely producing more than one second per second, for several seconds
 * running. Everything about that is in the CHEAT_RATE_*, CHEAT_SPEED_* and
 * CHEAT_LAG_* constants, and the report says which side of the line each
 * refusal fell on.
 */
import * as K from '../../shared/constants.js';
import config from '../config.js';
import log from '../util/log.js';

const logger = log.child('anticheat', 'moderation');

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
    /**
     * The last line of evidence per kind, and when each kind was first and last
     * seen (room clock, seconds).
     *
     * The first line alone was never enough to settle a report. What a
     * moderator is really asking is *how it changed*: a client that was 8° off
     * once and 174° off forty seconds later is a cheat somebody switched on
     * mid-match, and a client that was 8° off every single time for a minute is
     * a connection. Keeping the first and the last of each kind says which.
     */
    this.lastEvidence = Object.create(null);
    this.firstAt = Object.create(null);
    this.lastAt = Object.create(null);
    /** Room clock at the first refusal of any kind — the span the report quotes. */
    this.openedAt = -1;
    /** Highest the score ever reached, which is not the score at the kick. */
    this.peak = 0;

    /* ── What the connection itself looked like ─────────────────────────────
     * Written by the room every time it measures the line, and read only by
     * the report: a moderator deciding whether 40 refused packets are a cheat
     * or a train tunnel needs the ping and the jitter that were live when they
     * happened, and neither is recoverable afterwards.
     * ──────────────────────────────────────────────────────────────────────*/
    this.worstRtt = 0;
    this.worstJitter = 0;

    /* ── Burst tolerance ────────────────────────────────────────────────────
     * The three checks that read arrival times rather than contents. Each one
     * holds the state that separates "a stalled socket delivered its backlog"
     * from "this client is producing more than a second per second" — see the
     * CHEAT_RATE_* and CHEAT_SPEED_* constants.
     * ──────────────────────────────────────────────────────────────────────*/
    /** Leaky bucket of input packets over the steady-state rate. */
    this.rateBucket = 0;
    /** Room clock the rate bucket last leaked at; -1 until the first packet. */
    this.rateAt = -1;
    /** Room clock the input queue first went over the cap in this run, or -1. */
    this.speedSince = -1;
    /** Room clock the last sustained-overflow flag was raised at. */
    this.speedFlagAt = -1;
    /** Consecutive ping samples where the claim and the measurement disagreed. */
    this.lagStreak = 0;
    /** Which way the disagreement ran: +1 claiming more, -1 claiming less. */
    this.lagDir = 0;
    /** Room clock of the last lag flag, so a bad line is counted once, not twice a second. */
    this.lagFlagAt = -1;

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
 * @param {number} [now]      room clock, so the report can say *when*
 * @returns {'none'|'warn'|'kick'} what the caller should now do about it
 */
export function flag(player, kind, detail = null, weight = null, now = -1) {
  const st = player?.cheat;
  if (!st || player.isBot) return 'none';

  const w = weight ?? K.CHEAT_WEIGHTS[kind] ?? 4;
  st.score += w;
  if (st.score > st.peak) st.peak = st.score;
  st.counts[kind] = (st.counts[kind] ?? 0) + 1;
  st.incidents++;
  if (detail) {
    const line = String(detail).slice(0, 160);
    if (!st.evidence[kind]) st.evidence[kind] = line;
    st.lastEvidence[kind] = line;
  }
  if (now >= 0) {
    if (st.openedAt < 0) st.openedAt = now;
    if (st.firstAt[kind] === undefined) st.firstAt[kind] = now;
    st.lastAt[kind] = now;
  }

  if (!config.anticheat.enabled) return 'none';
  if (st.incidents < K.CHEAT_MIN_INCIDENTS) return 'none';
  if (st.score >= config.anticheat.kickScore) return config.anticheat.kick ? 'kick' : 'warn';
  if (st.score >= config.anticheat.warnScore && !st.warned) return 'warn';
  return 'none';
}

/**
 * Remembers the worst the line ever looked, for the report.
 *
 * Called wherever the room measures a round trip. It is deliberately the
 * *worst* rather than the current value: the ping at the moment a connection is
 * dropped says nothing, because whatever caused the refusals is thirty seconds
 * in the past by then, and "their ping was 40 ms" printed under forty refused
 * packets that all happened during a 900 ms spike is worse than printing
 * nothing at all.
 */
export function noteLine(player, rtt, jitter) {
  const st = player?.cheat;
  if (!st) return;
  if (rtt > st.worstRtt) st.worstRtt = rtt;
  if (jitter > st.worstJitter) st.worstJitter = jitter;
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

  const info = K.CHEAT_KIND_INFO[kind] ?? null;
  const title = info ? info.title.toLowerCase() : kind;

  if (verdict === 'warn') {
    st.warned = true;
    logger.for(player, room).warn(`flagged — ${title}`, {
      kind,
      score: Math.round(st.score),
      warnAt: Math.round(config.anticheat.warnScore),
      incidents: st.incidents,
      rttMs: Math.round((player.rtt ?? 0) * 1000),
      map: room.mapId, mode: room.modeId,
      detail: st.summary(),
    });
    room.sendTo(player, {
      o: K.S2C.CHAT,
      system: true,
      kind: 'alert',
      // Named, not just announced. "The server is refusing packets" tells an
      // honest player with a broken extension nothing they can act on; telling
      // them *which* thing is being refused is what turns a warning into
      // something they can go and fix before the kick.
      text: `The server is refusing packets from this client — ${title}. Close anything `
        + 'modifying the game and reload the page. If your connection is unstable, that '
        + 'is the more likely cause and it clears itself. The connection is dropped if it '
        + 'keeps happening.',
    });
    return;
  }

  st.kicked = true;
  logger.for(player, room).warn(`kicked — ${title}`, {
    kind,
    peakScore: Math.round(st.peak),
    kickAt: Math.round(config.anticheat.kickScore),
    refusedPackets: st.incidents,
    worstRttMs: Math.round(st.worstRtt * 1000),
    worstJitterMs: Math.round(st.worstJitter * 1000),
    map: room.mapId, mode: room.modeId,
    detail: st.summary(),
  });

  fileReport(room, player, kind);

  room.sendTo(player, {
    o: K.S2C.ERROR,
    code: 'anticheat',
    message: `Disconnected: the server refused ${st.incidents} packets from this client `
      + `(${title}). If you are running anything that modifies the game, close it and `
      + 'reload. A report has been filed and is reviewed by a person.',
  });
  // Let the frame reach the socket before it closes under it.
  setTimeout(() => {
    try { player.ws?.close(4010, 'anticheat'); } catch { /* already gone */ }
  }, 60);
}

/* ── The report a person reads ───────────────────────────────────────────────
 *
 * What used to land in the queue was one line:
 *
 *   Automatic: score 124 over 31 refused packets. Tripped on aim.
 *   aim×14 (shot 173.4° off the streamed view (allowed 21.6°)), seq×3 (…)
 *
 * Everything a moderator needs is technically in there and none of it is
 * legible: the kind names are internal identifiers, the numbers have no scale
 * next to them, there is nothing saying which of these a bad connection can
 * produce on its own, and no indication of whether it happened in one burst or
 * across five minutes. The queue is worked by people, sometimes by people who
 * have never opened this file, and a report nobody can act on is a report that
 * gets closed with "no action" whatever it says.
 *
 * So the body below is written as a page, in sections, in English. Every number
 * is given with the threshold it is being compared against, every kind is named
 * in words before it is named in code, and the connection quality that was live
 * while it happened is printed next to the verdict rather than left out — the
 * one question that decides most of these reports is "was this player lagging",
 * and the answer is on the third line.
 * ──────────────────────────────────────────────────────────────────────────*/

/** `1m 04s`, `12s`, `0.4s` — a span, at the precision the reader cares about. */
function span(sec) {
  if (!(sec > 0.05)) return 'under a tenth of a second';
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${String(Math.round(sec - m * 60)).padStart(2, '0')}s`;
}

/**
 * The body of the automatic report, as plain text.
 *
 * Exported so the tests can read it, and so a future admin page can render it
 * without going through the database.
 *
 * @param {object} room
 * @param {object} player
 * @param {string} trigger  the kind that crossed the threshold
 * @returns {string}
 */
export function reportBody(room, player, trigger) {
  const st = player.cheat;
  const now = room?.now ?? 0;
  const kinds = K.CHEAT_KINDS.filter((k) => st.counts[k]);
  const over = st.openedAt >= 0 ? now - st.openedAt : 0;
  const info = K.CHEAT_KIND_INFO[trigger] ?? null;
  const out = [];

  out.push('AUTOMATIC — filed by the server, not by a player.');
  out.push('');
  out.push(`${player.name} was disconnected after the server refused ${st.incidents} `
    + `packet${st.incidents === 1 ? '' : 's'} from this client over ${span(over)} of play.`);
  out.push(`Suspicion reached ${Math.round(st.peak)} points against a threshold of `
    + `${Math.round(config.anticheat.kickScore)}; suspicion sheds `
    + `${K.CHEAT_DECAY_PER_SEC} points for every second of clean play, so this is a rate, `
    + 'not a total.');
  out.push('');

  out.push(`WHAT TIPPED IT: ${info ? info.title.toLowerCase() : trigger} (${trigger})`);
  if (info) {
    out.push(`  ${info.what}`);
    out.push(`  A cheat doing this is buying: ${info.cheat}`);
    out.push(`  Can a bad connection cause it? ${info.lag}.`);
  }
  out.push('');

  out.push(`EVERY REFUSAL, BY KIND (${kinds.length} of ${K.CHEAT_KINDS.length} kinds seen)`);
  for (const k of kinds) {
    const ki = K.CHEAT_KIND_INFO[k];
    const n = st.counts[k];
    const first = st.firstAt[k], last = st.lastAt[k];
    out.push('');
    out.push(`· ${ki?.title ?? k} — ${n}×  [${k}, ${K.CHEAT_WEIGHTS[k] ?? 4} pts each]`);
    if (ki) out.push(`    ${ki.what}`);
    if (first !== undefined) {
      out.push(first === last || n === 1
        ? `    Seen once, ${span(now - first)} before the disconnect.`
        : `    First ${span(now - first)} before the disconnect, last ${span(now - last)} before it.`);
    }
    if (st.evidence[k]) out.push(`    First: ${st.evidence[k]}`);
    if (st.lastEvidence[k] && st.lastEvidence[k] !== st.evidence[k]) {
      out.push(`    Last:  ${st.lastEvidence[k]}`);
    }
    if (ki) out.push(`    Lag can cause this: ${ki.lag}.`);
  }
  out.push('');

  out.push('THE CONNECTION AT THE TIME');
  out.push(`  Worst measured ping ${Math.round(st.worstRtt * 1000)}ms, worst jitter `
    + `${Math.round(st.worstJitter * 1000)}ms. Last measured ping `
    + `${Math.round((player.rtt ?? 0) * 1000)}ms.`);
  out.push('  Every check that reads arrival times rather than packet contents already '
    + 'forgives a burst after a stall, and the aim gate widens with both of the numbers '
    + 'above — so these figures are context, not an excuse. But if the only kinds listed '
    + 'above are lag, rate or speed and the ping is poor, treat it as a connection until '
    + 'something else appears.');
  out.push('');

  out.push('HOW TO READ THIS');
  out.push('  Nothing here was deleted or blocked on suspicion. Every refused packet was '
    + 'played as though the client had told the truth — a refused shot still fired, down '
    + 'the barrel the player was really pointing. So the cheat, if there was one, bought '
    + 'nothing; this report exists to decide what happens to the account.');
  out.push(`  Match ${room?.code ?? '—'} · ${room?.mode?.name ?? room?.modeId ?? '—'} on `
    + `${room?.map?.name ?? room?.map?.id ?? '—'}.`);

  return out.join('\n');
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
    db.reports.add({
      reporterId: null,
      reporterName: 'anti-cheat',
      targetId: player.userId,
      targetName: player.name,
      targetIp: player.ip,
      reason: 'cheat',
      detail: reportBody(room, player, kind),
      room: room.code,
      mode: room.modeId,
      map: room.map?.id ?? null,
      chatLog: [],
    });
    room.logEvent?.(db, {
      kind: 'anticheat.kick',
      userId: player.userId,
      name: player.name,
      detail: {
        trigger: kind,
        score: Math.round(st.peak),
        counts: st.summary(),
        rtt: Math.round(st.worstRtt * 1000),
        jitter: Math.round(st.worstJitter * 1000),
      },
    });
  } catch (err) {
    logger.warn('anti-cheat report write failed:', err.message, { player: player?.name ?? null });
  }
}

export default {
  CheatState, flag, decay, enforce, trackSpread, angleDelta, viewDistance, noteLine, reportBody,
};
