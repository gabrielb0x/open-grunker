/**
 * Open Grunker — what one account is allowed to report, and when.
 *
 * A report costs the person filing it nothing and costs a moderator a minute of
 * reading. The only thing that keeps the queue worth reading is that no single
 * account can fill it, so every ceiling lives here rather than at the button:
 * the room asks this before it writes a row, and the account panel asks the same
 * function so the player is shown the truth instead of a guess.
 *
 * Each limit answers a different way of abusing the button:
 *
 *   blocked       a moderator decided this account may not file at all
 *   level         a fresh throwaway account is not a witness
 *   cooldown      one incident at a time, not a burst
 *   per hour      a bad evening cannot bury a week of real reports
 *   per day       and the hourly cap cannot simply be waited out all night
 *   open at once  reports nobody has read yet are not an allowance to spend
 *   same target   one incident, one queue entry
 *   dismissals    crying wolf costs the next day of reporting
 *
 * Only the first is a punishment, and it is the only one a human issues by
 * hand; every other one clears on its own, and the one that bites hardest — the
 * open ceiling — is given straight back the moment a moderator works the queue.
 */
import config from '../config.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/** "in 4m", "in 90s" — how a wait reads in a refusal. */
export function waitText(seconds) {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.ceil(s / 60)}m`;
  return `${Math.ceil(s / 3600)}h`;
}

/**
 * Everything the ceilings say about one account, whether or not it is asking to
 * file right now.
 *
 * @param {object} db the database module
 * @param {{id:number, level:number}} account
 * @returns {{
 *   allowed: boolean, reason: string|null, retryAfter: number, blocked: boolean,
 *   hour: number, day: number, open: number, dismissed: number,
 *   limits: object,
 * }}
 */
export function reportStanding(db, account) {
  const r = config.reports;
  const limits = {
    minLevel: r.minLevel,
    maxPerHour: r.maxPerHour,
    maxPerDay: r.maxPerDay,
    maxOpen: r.maxOpen,
    cooldownSec: r.cooldownSec,
    repeatCooldownSec: r.repeatCooldownSec,
  };
  const blank = {
    allowed: false, reason: null, retryAfter: 0, blocked: false,
    hour: 0, day: 0, open: 0, dismissed: 0, limits,
  };

  if (!r.enabled || !db?.reports) {
    return { ...blank, reason: 'reporting is switched off on this server' };
  }
  if (!account?.id) return { ...blank, reason: 'sign in to report a player' };

  // A moderator's own decision comes before every self-clearing ceiling: it is
  // the only one of these that is a judgement about the person rather than
  // about how many reports they have filed lately.
  const block = db.reportBans?.active?.(account.id) ?? null;
  if (block) {
    const why = block.reason ? ` \u2014 ${block.reason}` : '';
    const when = block.until > 0
      ? `until ${new Date(block.until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : 'indefinitely';
    return {
      ...blank,
      blocked: true,
      retryAfter: block.until > 0 ? Math.max(1, block.until - nowSec()) : 0,
      reason: `reporting is switched off for your account ${when}${why}`,
    };
  }

  if ((account.level ?? 1) < r.minLevel) {
    return { ...blank, reason: `reach level ${r.minLevel} to report a player` };
  }

  const t = nowSec();
  const hour = db.reports.countSince(account.id, t - 3600);
  const day = db.reports.countSince(account.id, t - 86400);
  const open = db.reports.countOpenFor(account.id);
  const last = db.reports.lastBy(account.id);
  const dismissed = r.dismissedMax > 0
    ? db.reports.dismissedSince(account.id, t - r.dismissedWindowDays * 86400)
    : { count: 0, lastAt: 0 };

  const state = { ...blank, hour, day, open, dismissed: dismissed.count };

  // Crying wolf first: it is the only ceiling that is about the reports
  // themselves rather than about how many there are.
  if (r.dismissedMax > 0 && dismissed.count >= r.dismissedMax) {
    const until = dismissed.lastAt + r.dismissedLockoutHours * 3600;
    if (until > t) {
      return {
        ...state,
        retryAfter: until - t,
        reason: `${dismissed.count} of your reports were dismissed — you can report again in `
          + `${waitText(until - t)}`,
      };
    }
  }

  if (open >= r.maxOpen) {
    return {
      ...state,
      reason: `you have ${open} reports still being looked at — wait for a moderator `
        + 'to settle them before filing another',
    };
  }
  if (hour >= r.maxPerHour) {
    return { ...state, retryAfter: 60, reason: `you have filed ${hour} reports this hour — that is the limit` };
  }
  if (day >= r.maxPerDay) {
    return { ...state, retryAfter: 600, reason: `you have filed ${day} reports today — that is the limit` };
  }
  if (last && r.cooldownSec > 0) {
    const wait = last.createdAt + r.cooldownSec - t;
    if (wait > 0) {
      return { ...state, retryAfter: wait, reason: `one report at a time — try again in ${waitText(wait)}` };
    }
  }

  return { ...state, allowed: true };
}

/**
 * The same-target gap, checked separately because it needs the target's name
 * and the rest of the standing does not.
 *
 * @returns {string|null} why not, or null when this target may be reported
 */
export function repeatDenial(db, accountId, targetName) {
  const gap = config.reports.repeatCooldownSec;
  if (!gap || !accountId) return null;
  const previous = db.reports.lastOn(accountId, targetName);
  if (!previous) return null;
  const wait = previous.createdAt + gap - nowSec();
  if (wait <= 0) return null;
  return previous.status === 'open'
    ? `you already reported ${targetName} — a moderator is looking at it`
    : `you reported ${targetName} recently — try again in ${waitText(wait)}`;
}

export default { reportStanding, repeatDenial, waitText };
