/**
 * Open Grunker — the reasons to come back.
 *
 * Four things, each answering a different span of time: the level ladder (how
 * long the whole game lasts), the daily (tonight), the weekly (this week) and
 * the career milestones (this year). What is on trial is that each one is
 * actually reachable on its own timescale and not on any of the others — a
 * weekly a single evening can clear is a daily with extra steps, and a level
 * that arrives every other match is not a level.
 */
import { suite, check, info } from './harness.mjs';
import * as K from '../shared/constants.js';

/**
 * XP a decent four-minute round pays.
 *
 * A match pays its score back one for one (see `xpFromScore`), and a couple of
 * thousand points is a good round for a competent player. Every "how many
 * matches" figure below is against this.
 */
const MATCH_XP = 1800;

export default function run() {
  suite('Progression — the level ladder');

  const matches = (level) => K.xpForLevel(level) / MATCH_XP;

  check('level 2 is one short match — the first one has to arrive immediately',
    matches(2) <= 1, `${matches(2).toFixed(2)} matches`);
  check('the level-5 gates (clan, reports) are a first sitting away',
    matches(5) >= 1 && matches(5) <= 4, `${matches(5).toFixed(1)} matches`);
  check('level 10 is an evening rather than two matches',
    matches(10) >= 5 && matches(10) <= 12, `${matches(10).toFixed(1)} matches`);
  check('level 30 is weeks of play',
    matches(30) >= 100, `${Math.round(matches(30))} matches`);
  check('level 50 is a serious commitment',
    matches(50) >= 500, `${Math.round(matches(50))} matches`);

  check('every level costs strictly more than the one below it', (() => {
    for (let l = 3; l <= K.MAX_LEVEL; l++) {
      if (K.xpForLevel(l) - K.xpForLevel(l - 1) <= K.xpForLevel(l - 1) - K.xpForLevel(l - 2)) return false;
    }
    return true;
  })());

  check('the curve and the lookup that inverts it agree at every rung', (() => {
    for (let l = 2; l <= K.MAX_LEVEL; l++) {
      if (K.levelFromXp(K.xpForLevel(l)) !== l) return false;
      if (K.levelFromXp(K.xpForLevel(l) - 1) !== l - 1) return false;
    }
    return true;
  })());
  check('no XP at all is level 1, and nothing is ever above the ceiling',
    K.levelFromXp(0) === 1 && K.levelFromXp(-5) === 1
    && K.levelFromXp(Number.MAX_SAFE_INTEGER) === K.MAX_LEVEL);

  // The ladder got steeper, so a level has to be worth more. If a match pays
  // better than a level does, the ladder is decoration.
  check('a level pays more than the match that finished it',
    K.levelUpReward(2).gr > K.grFromScore(MATCH_XP, true),
    `level 2 pays ${K.levelUpReward(2).gr} GR, a winning match ${K.grFromScore(MATCH_XP, true)}`);
  check('and the payout climbs with the level, up to a cap',
    K.levelUpReward(30).gr > K.levelUpReward(10).gr
    && K.levelUpReward(999).gr === K.levelUpReward(500).gr,
    `L10 ${K.levelUpReward(10).gr} · L30 ${K.levelUpReward(30).gr} · cap ${K.levelUpReward(999).gr}`);

  info(`level 10 ≈ ${matches(10).toFixed(1)} matches · level 30 ≈ ${Math.round(matches(30))}`
    + ` · level 50 ≈ ${Math.round(matches(50))}`);

  /* ── Weeklies ──────────────────────────────────────────────────────────── */

  suite('Progression — weekly challenges');

  const week = K.weekIndex();
  const list = K.weeklyChallenges(week);
  check('three a week', list.length === K.WEEKLIES_PER_WEEK && new Set(list.map((c) => c.id)).size === 3,
    list.map((c) => c.name).join(' · '));
  check('the same three for everybody, every time it is asked',
    JSON.stringify(K.weeklyChallenges(week)) === JSON.stringify(list));
  check('and a different three next week',
    JSON.stringify(K.weeklyChallenges(week + 1)) !== JSON.stringify(list));

  check('every week of the next four years draws a full, distinct set', (() => {
    for (let w = week; w < week + 208; w++) {
      const set = K.weeklyChallenges(w);
      if (set.length !== K.WEEKLIES_PER_WEEK) return false;
      if (new Set(set.map((c) => c.id)).size !== K.WEEKLIES_PER_WEEK) return false;
    }
    return true;
  })());

  check('every weekly names a counter a match actually reports', (() => {
    const known = new Set(['kills', 'headshots', 'assists', 'midairs', 'noscopes', 'drifts',
      'melees', 'longshots', 'score', 'damage', 'matches', 'wins', 'bestStreak']);
    return K.WEEKLY_POOL.every((c) => known.has(c.stat));
  })());

  // The whole point of a week is that it outlasts a night.
  const dailies = K.dailyChallenges(K.dayIndex());
  check('a weekly is worth several evenings, not one',
    K.WEEKLY_POOL.every((w) => {
      const sameStat = K.CHALLENGE_POOL.filter((d) => d.stat === w.stat);
      return !sameStat.length || w.goal >= Math.max(...sameStat.map((d) => d.goal)) * 3;
    }),
    `dailies today: ${dailies.map((c) => c.name).join(', ')}`);
  check('…and pays accordingly',
    K.WEEKLY_POOL.every((w) => w.xp >= 3000 && w.gr >= 250),
    `${Math.min(...K.WEEKLY_POOL.map((c) => c.gr))}–${Math.max(...K.WEEKLY_POOL.map((c) => c.gr))} GR`);

  check('weeks turn over on a Monday', (() => {
    // Two consecutive weeks' worth of noon UTC, checking the number changes on
    // exactly the Mondays and on no other day.
    const start = Date.UTC(2026, 7, 17, 12);        // a Monday
    let prev = K.weekIndex(start);
    for (let d = 1; d <= 14; d++) {
      const at = start + d * 86400000;
      const now = K.weekIndex(at);
      const isMonday = new Date(at).getUTCDay() === 1;
      if ((now !== prev) !== isMonday) return false;
      prev = now;
    }
    return true;
  })());

  check('a week is filed where the daily cleanup cannot reach it',
    K.weeklyPeriod(week) > K.dayIndex() + 4000 && K.weeklyPeriod(week) >= K.WEEKLY_PERIOD_BASE,
    `day ${K.dayIndex()} vs week period ${K.weeklyPeriod(week)}`);

  /* ── Career milestones ─────────────────────────────────────────────────── */

  suite('Progression — career milestones');

  check('every id is unique', new Set(K.MILESTONES.map((m) => m.id)).size === K.MILESTONES.length,
    `${K.MILESTONES.length} milestones`);
  check('every one reads a lifetime counter the stats row actually carries', (() => {
    const known = new Set(['kills', 'wins', 'headshots', 'matches', 'bestStreak', 'damage', 'playtime']);
    return K.MILESTONES.every((m) => known.has(m.stat));
  })());

  check('each track climbs, and pays more the higher it goes', (() => {
    const byStat = new Map();
    for (const m of K.MILESTONES) {
      if (!byStat.has(m.stat)) byStat.set(m.stat, []);
      byStat.get(m.stat).push(m);
    }
    for (const track of byStat.values()) {
      for (let i = 1; i < track.length; i++) {
        if (track[i].goal <= track[i - 1].goal) return false;
        if (track[i].gr <= track[i - 1].gr || track[i].xp <= track[i - 1].xp) return false;
      }
    }
    return true;
  })());

  // The first rung of the list has to be inside a first evening, or a new
  // account never learns the list is worth reading.
  const first = K.MILESTONES.filter((m) => m.stat === 'matches' || m.stat === 'kills')
    .sort((a, b) => a.goal - b.goal)[0];
  check('the first rung is reachable on a first evening',
    first.goal <= 100, `${first.name} — ${first.desc}`);

  check('the top of the list is years away, not weeks',
    Math.max(...K.MILESTONES.map((m) => m.goal)) >= 25000);

  check('no milestone outpays a level of comparable effort',
    K.MILESTONES.every((m) => m.gr <= 5000 && m.xp <= 60000));

  check('progress reads in the unit the milestone is counted in', (() => {
    const time = K.MILESTONES.find((m) => m.stat === 'playtime');
    const kills = K.MILESTONES.find((m) => m.stat === 'kills');
    return K.milestoneProgressText(time, 7200).includes('h')
      && K.milestoneProgressText(kills, 50).startsWith('50 /');
  })(), K.milestoneProgressText(K.MILESTONES.find((m) => m.stat === 'playtime'), 7200));

  const totalGr = K.MILESTONES.reduce((n, m) => n + m.gr, 0);
  info(`the whole career list is worth ${totalGr.toLocaleString('en-GB')} GR`
    + ` and ${K.MILESTONES.reduce((n, m) => n + m.xp, 0).toLocaleString('en-GB')} XP`);
}
