/**
 * Open Grunker — moderation and end-of-match settlement.
 *
 * Two things that are only ever exercised at the very end of a match, and were
 * both quietly broken: the payout every player earns, and the ban that has to
 * reach someone who is already in a room.
 */
import { deflateSync, crc32 } from 'node:zlib';
import { Room } from '../server/game/room.js';
import { Player } from '../server/game/player.js';
import { SKINS } from '../shared/weapons.js';
import { identify, validateAvatar } from '../server/util/image.js';
import { pathFor as avatarPathFor, urlFor as avatarUrlFor } from '../server/util/avatar.js';
import * as K from '../shared/constants.js';
import config from '../server/config.js';
import { reportStanding } from '../server/util/reports.js';
import { suite, check, info } from './harness.mjs';

/* ── Throwaway images ────────────────────────────────────────────────────── */

/*
 * Three real files, built byte by byte rather than checked in. The sniffer's
 * whole job is reading headers, so the fixtures have to be headers — and a
 * 900×900 PNG of one flat colour is the case a byte limit alone would wave
 * through.
 */
const LIMITS = { maxBytes: K.AVATAR_MAX_BYTES, maxDimension: K.AVATAR_MAX_DIM };

function png(w, h) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                       // 8-bit, truecolour
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.alloc(1 + w * 3, 0));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpeg(w, h) {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);                       // segment length
  sof[4] = 8;                                     // sample precision
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3;                                     // components
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\u0001\u0001\0\0\u0001\0\u0001\0\0', 'latin1'),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function webp(w, h) {
  const body = Buffer.alloc(28);
  body.write('VP8 ', 0, 'latin1');
  body.writeUInt32LE(20, 4);
  body[11] = 0x9d; body[12] = 0x01; body[13] = 0x2a;   // start code, after the 3-byte frame tag
  body.writeUInt16LE(w, 14);
  body.writeUInt16LE(h, 16);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/* ── A database stand-in that records what the room asked it to write ────── */

function makeDb({ failChallengesFor = null } = {}) {
  const accounts = new Map();
  const log = { stats: [], progress: [], matchPlayers: [], mastery: [], milestones: [] };
  const account = (id) => {
    if (!accounts.has(id)) {
      accounts.set(id, {
        id, xp: 0, gr: 0, level: 1,
        // The lifetime stats row, and which career milestones have been paid.
        life: { kills: 0, wins: 0, headshots: 0, matches: 0, best_streak: 0, damage_dealt: 0, playtime_sec: 0 },
        milestones: new Set(),
      });
    }
    return accounts.get(id);
  };
  return {
    log,
    accounts,
    matches: {
      start: () => 1,
      finish: () => {},
      addPlayer: (_id, p) => log.matchPlayers.push(p),
    },
    stats: {
      bump: (userId, d) => {
        log.stats.push({ userId, ...d });
        // The lifetime row a milestone check reads, kept in step with the
        // deltas the room writes into it.
        const a = account(userId);
        for (const [k, col] of [['kills', 'kills'], ['wins', 'wins'], ['headshots', 'headshots'],
          ['matches', 'matches'], ['damage', 'damage_dealt'], ['playtime', 'playtime_sec']]) {
          a.life[col] = (a.life[col] ?? 0) + (d[k] ?? 0);
        }
        a.life.best_streak = Math.max(a.life.best_streak ?? 0, d.bestStreak ?? 0);
      },
      get: (userId) => account(userId).life,
    },
    // The career ledger. The set is the primary key: a milestone already in it
    // reports no change, and the room pays nothing for it a second time.
    milestones: {
      claimedFor: (userId) => [...account(userId).milestones],
      claim: (userId, id) => {
        const set = account(userId).milestones;
        if (set.has(id)) return false;
        set.add(id);
        log.milestones.push({ userId, id });
        return true;
      },
    },
    mastery: { bump: (userId, kills) => log.mastery.push({ userId, kills: [...kills.entries()] }) },
    challenges: {
      forUser: (userId) => {
        if (userId === failChallengesFor) throw new Error('challenge table exploded');
        return [];
      },
      bump: () => {},
      claim: () => true,
    },
    users: {
      addProgress(userId, xp, gr) {
        const a = account(userId);
        a.xp += xp;
        a.gr += gr;
        log.progress.push({ userId, xp, gr });
        return { xp: a.xp, gr: a.gr, level: a.level, leveledUp: false };
      },
      // The daily bonuses, modelled rather than stubbed out: the thing worth
      // testing about them is that the second match of a day pays nothing.
      checkInDay(userId, day) {
        const a = account(userId);
        if (a.lastPlayDay === day) return { streak: a.streak ?? 0, best: a.best ?? 0, fresh: false, xp: 0, gr: 0 };
        a.streak = a.lastPlayDay === day - 1 ? (a.streak ?? 0) + 1 : 1;
        a.lastPlayDay = day;
        a.best = Math.max(a.best ?? 0, a.streak);
        return { streak: a.streak, best: a.best, fresh: true, ...K.streakReward(a.streak) };
      },
      claimFirstWin(userId, day) {
        const a = account(userId);
        if (a.lastWinDay === day) return { xp: 0, gr: 0, fresh: false };
        a.lastWinDay = day;
        return { ...K.FIRST_WIN_BONUS, fresh: true };
      },
    },
  };
}

/** A room whose sockets are arrays, with a hub carrying the fake database. */
function makeRoom(opts, db) {
  const room = new Room({ ...opts, hub: { db } });
  const out = [];
  room.broadcast = (m) => out.push(m);
  room.broadcastNear = (m) => out.push(m);
  room.sendTo = (p, m) => out.push({ ...m, _to: p.id });
  room.messages = out;
  return room;
}

function addHuman(room, name, userId) {
  const p = new Player({ ws: null, name, userId, classId: 'triggerman' });
  room.add(p);
  return p;
}

export default async function run() {
  /* ── Match settlement ──────────────────────────────────────────────────── */

  suite('Match settlement');

  const db = makeDb();
  const room = makeRoom({ id: 'test-payout', mapId: 'burgtown', modeId: 'ffa' }, db);
  const winner = addHuman(room, 'Winner', 11);
  const runnerUp = addHuman(room, 'RunnerUp', 12);
  const bot = room.addBot();

  winner.score.kills = 9;
  winner.score.headshots = 4;
  winner.score.assists = 2;
  winner.score.score = 940;
  winner.score.shotsFired = 60;
  winner.score.shotsHit = 31;
  winner.score.damage = 1420;
  winner.weaponKills.set('ar', 9);
  runnerUp.score.kills = 3;
  runnerUp.score.score = 260;
  room.now = room.matchStart + 128;

  room.endMatch('time');

  check('every human in the match gets their stats written', (() => {
    const ids = db.log.stats.map((s) => s.userId).sort();
    info(`stats rows: ${JSON.stringify(db.log.stats.map((s) => [s.userId, s.kills, s.score]))}`);
    return ids.length === 2 && ids[0] === 11 && ids[1] === 12;
  })());

  check('bots are recorded in the match but never in an account\'s stats',
    db.log.matchPlayers.length === 3 && !db.log.stats.some((s) => s.userId === null),
    `${db.log.matchPlayers.length} match rows, ${db.log.stats.length} stat rows`);

  check('the winner is credited a win and the loser a loss', (() => {
    const w = db.log.stats.find((s) => s.userId === 11);
    const l = db.log.stats.find((s) => s.userId === 12);
    return w.wins === 1 && w.losses === 0 && l.wins === 0 && l.losses === 1;
  })());

  check('the scoreboard and the database agree on who won', (() => {
    // These used to be computed two different ways: `winner === p.name` for the
    // broadcast and `rows[0].id === p.id` for the stats row.
    const board = room.messages.find((m) => m.o === K.S2C.MATCH && m.phase === 'end');
    const boardWon = board.scoreboard.filter((r) => r.won).map((r) => r.name);
    const dbWon = db.log.matchPlayers.filter((r) => r.won).map((r) => r.name);
    info(`board=${boardWon.join(',')} db=${dbWon.join(',')}`);
    return boardWon.length === 1 && boardWon[0] === 'Winner' && dbWon.join(',') === boardWon.join(',');
  })());

  // Day one of a streak for both of them, and only the winner takes the
  // first-win bonus — which is what the payout has to come out to.
  const dayOne = K.streakReward(1);

  check('GR is paid out from the match score', (() => {
    const paid = db.log.progress.find((p) => p.userId === 11);
    const expected = K.grFromScore(940, true) + dayOne.gr + K.FIRST_WIN_BONUS.gr;
    info(`${paid?.gr} GR for 940 points and a win (expected ${expected})`);
    return paid && paid.gr === expected && paid.xp > 0;
  })());

  check('XP is the match score, one for one', (() => {
    // It used to be its own formula — so much per kill, a bonus per headshot, a
    // lump for the win — which meant the number on the end card had nothing to
    // do with the one the player had watched climb all match. The daily bonuses
    // ride on top of that, never inside it.
    const w = db.log.progress.find((p) => p.userId === 11);
    const l = db.log.progress.find((p) => p.userId === 12);
    info(`${w?.xp} XP for 940 points · ${l?.xp} XP for 260 (+ daily bonuses)`);
    return w?.xp === 940 + dayOne.xp + K.FIRST_WIN_BONUS.xp && l?.xp === 260 + dayOne.xp;
  })());

  check('the daily bonuses are paid once and then not again', (() => {
    // A second finished match on the same day must pay the match and nothing
    // else, or the streak would be a queue-dodging exploit rather than a reason
    // to come back tomorrow.
    const day = K.dayIndex();
    const again = db.users.checkInDay(11, day);
    const win = db.users.claimFirstWin(11, day);
    info(`repeat check-in: +${again.gr} GR · repeat win bonus: +${win.gr} GR`);
    return !again.fresh && again.gr === 0 && !win.fresh && win.gr === 0 && again.streak === 1;
  })());

  check('the reward card reports the match payout, not the account balance', (() => {
    // `...prog` used to be spread over `xp`/`gr`, so a veteran was shown their
    // lifetime XP as the reward for a single match.
    const reward = room.messages.find((m) => m.o === K.S2C.MATCH && m.phase === 'reward' && m._to === winner.id);
    if (!reward) return false;
    info(`match +${reward.xp} XP / +${reward.gr} GR · account ${reward.totalXp} XP / ${reward.totalGr} GR`);
    return reward.gr === K.grFromScore(940, true) + dayOne.gr + K.FIRST_WIN_BONUS.gr
      && reward.streak?.days === 1 && reward.firstWin?.gr === K.FIRST_WIN_BONUS.gr
      && reward.totalGr === db.accounts.get(11).gr
      && reward.totalXp === db.accounts.get(11).xp
      && typeof reward.level === 'number';
  })());

  check('weapon mastery is flushed with the kills that earned it', (() => {
    const mine = db.log.mastery.find((m) => m.userId === 11);
    info(db.log.mastery.map((m) => `${m.userId}:${JSON.stringify(m.kills)}`).join(' '));
    return !!mine && mine.kills.length === 1 && mine.kills[0][0] === 'ar' && mine.kills[0][1] === 9;
  })());

  /* One player failing to settle must not cost everybody else their match. */
  const db2 = makeDb({ failChallengesFor: 21 });
  const room2 = makeRoom({ id: 'test-payout-2', mapId: 'burgtown', modeId: 'ffa' }, db2);
  const cursed = addHuman(room2, 'Cursed', 21);
  const bystander = addHuman(room2, 'Bystander', 22);
  cursed.score.score = 500;
  cursed.score.kills = 5;
  bystander.score.score = 300;
  bystander.score.kills = 3;
  room2.now = room2.matchStart + 60;
  room2.endMatch('time');

  check('one player failing to settle does not cost the rest their payout', (() => {
    const paid = db2.log.progress.map((p) => p.userId);
    info(`settled: ${paid.join(', ') || 'nobody'}`);
    return paid.includes(22);
  })());

  /* ── Levelling up mid-session ──────────────────────────────────────────── */

  {
    // A level is a set of gates, not a number on a card. Crossing one used to
    // reach the client only on the next page load, so a player was congratulated
    // on reaching level 2 and then found the chat still locked.
    const lvlDb = makeDb();
    lvlDb.users.addProgress = (userId, xp, gr) => ({ xp, gr, level: 2, leveledUp: true });
    const lvlRoom = makeRoom({ id: 'test-levelup', mapId: 'burgtown', modeId: 'ffa' }, lvlDb);
    const climber = addHuman(lvlRoom, 'Climber', 51);
    climber.level = 1;
    climber.score.score = 400;
    lvlRoom.now = lvlRoom.matchStart + 60;
    lvlRoom.messages.length = 0;
    lvlRoom.endMatch('time');

    check('levelling up unlocks the chat without a page reload', (() => {
      const chat = lvlRoom.messages.find((m) => m.o === K.S2C.CHATSTATE && m._to === climber.id);
      const report = lvlRoom.messages.find((m) => m.o === K.S2C.REPORTSTATE && m._to === climber.id);
      info(`level ${climber.level} · chat ${chat ? (chat.canSend ? 'open' : chat.reason) : 'not pushed'}`);
      return climber.level === 2 && !!chat && chat.canSend === true && !!report;
    })());
  }

  /* ── The progression ladder ────────────────────────────────────────────── */

  check('the ladder names every gate, in the order they are reached', (() => {
    // Each of these thresholds already existed; none of them was written down
    // anywhere a player could read before the level stopped them.
    const steps = K.progressionLadder({ reportLevel: 5 });
    const levels = steps.map((s) => s.level);
    const sorted = levels.every((n, i) => i === 0 || n >= levels[i - 1]);
    const at = (n) => steps.filter((st) => st.level === n).map((st) => st.title);
    info(steps.map((st) => `${st.level}:${st.title}`).join(' · '));
    return sorted
      && at(K.CHAT_MIN_LEVEL).includes('MATCH CHAT')
      && at(5).includes('REPORT A PLAYER')
      && at(K.CLAN_JOIN_LEVEL).includes('JOIN A CLAN')
      && at(K.CLAN_CREATE_LEVEL).includes('FOUND A CLAN')
      && steps.every((st) => st.desc.length > 20);
  })());

  check('an operator who moves a gate moves the ladder with it', (() => {
    // The panel promises what this server does, not what the defaults say.
    const raised = K.progressionLadder({ reportLevel: 12, clansEnabled: false });
    const report = raised.find((st) => st.title === 'REPORT A PLAYER');
    info(`report at ${report?.level}, ${raised.filter((st) => /CLAN/.test(st.title)).length} clan step(s)`);
    return report?.level === 12 && !raised.some((st) => /CLAN/.test(st.title));
  })());

  check('the Veteran skin is on the ladder at the level it really unlocks', (() => {
    // The rule lives on the skin in weapons.js; the ladder repeats the number,
    // so the two have to be checked against each other somewhere.
    const step = K.progressionLadder().find((st) => st.title === 'VETERAN SKIN');
    info(`ladder ${step?.level} · skin ${SKINS.veteran.unlock.value}`);
    return step?.level === SKINS.veteran.unlock.value;
  })());

  /* ── Spectator mode ────────────────────────────────────────────────────── */

  suite('Spectator mode');

  {
    const specDb = makeDb();
    const sRoom = makeRoom({ id: 'test-spectate', mapId: 'burgtown', modeId: 'ffa' }, specDb);
    const watcher = addHuman(sRoom, 'Watcher', 41);
    const other = addHuman(sRoom, 'Other', 42);
    const frames = (id) => sRoom.messages.filter((m) => m.o === K.S2C.MATCH && m.phase === 'specMode' && m._to === id);

    check('a switch flipped mid-firefight is armed, not obeyed', (() => {
      // A body cannot vanish out of the world in front of the people shooting
      // at it, so the wish is recorded and the next death honours it.
      sRoom.messages.length = 0;
      sRoom.onSpectateMode(watcher, { v: 1 });
      const told = frames(watcher.id)[0];
      info(told ? `on=${told.on} queued=${told.queued}` : 'nothing said');
      return watcher.wantsSpectate === true && watcher.spectator === false && watcher.alive === true
        && told?.on === true && told?.queued === true;
    })());

    check('the next death hands over the camera', (() => {
      sRoom.messages.length = 0;
      sRoom.onKill(other, watcher, 'ar', false);
      const told = frames(watcher.id).at(-1);
      const left = sRoom.messages.some((m) => m.o === K.S2C.LEAVE && m.id === watcher.id);
      info(`spectator=${watcher.spectator} target=${told?.name ?? 'nobody'} announced-as-left=${left}`);
      return watcher.spectator === true && watcher.alive === false
        && told?.on === true && told?.queued === false && told?.targetId === other.id
        && left && !sRoom.roster.includes(watcher);
    })());

    check('watching costs nobody their scorecard', (() => {
      // Parked exactly the way a disconnect parks it: sitting back down inside
      // the same match picks it up where it was left.
      const parked = sRoom.savedScores.get(watcher.identity);
      return !!parked;
    })());

    check('a watcher may neither chat nor report', (() => {
      // Both are seat-only, and both say so: a spectator reaching for either
      // gets a sentence rather than a key that does nothing.
      const chat = sRoom.chatDenial(watcher);
      const report = sRoom.reportDenial(watcher);
      info(`${chat} / ${report}`);
      return /take a seat/.test(chat) && typeof report === 'string' && report.length > 0;
    })());

    check('turning it off puts them back in the match they left', (() => {
      sRoom.messages.length = 0;
      sRoom.onSpectateMode(watcher, { v: 0 });
      const joined = sRoom.messages.find((m) => m.o === K.S2C.MATCH && m.phase === 'joined' && m._to === watcher.id);
      info(joined ? 'seated again' : 'still watching');
      return watcher.spectator === false && watcher.wantsSpectate === false
        && !!joined && sRoom.roster.includes(watcher);
    })());

    check('with nothing spawned it lands immediately instead of waiting', (() => {
      // "At your next death" is meaningless to somebody who is already dead, so
      // the same switch takes effect on the spot.
      watcher.alive = false;
      sRoom.messages.length = 0;
      sRoom.onSpectateMode(watcher, { v: 1 });
      const told = frames(watcher.id)[0];
      info(told ? `queued=${told.queued}` : 'nothing said');
      return watcher.spectator === true && told?.queued === false;
    })());

    check('a socket watching the menu is sent back to the menu, not into a seat', (() => {
      // The menu's backdrop is a spectator too, and it has never pressed PLAY.
      const lurker = new Player({ ws: null, name: 'Lurker', userId: 43, classId: 'triggerman', spectator: true });
      sRoom.add(lurker);
      sRoom.messages.length = 0;
      sRoom.onSpectateMode(lurker, { v: 1 });
      const on = frames(lurker.id).at(-1);
      sRoom.onSpectateMode(lurker, { v: 0 });
      const off = frames(lurker.id).at(-1);
      info(`on: queued=${on?.queued} · off: menu=${off?.menu}`);
      return on?.on === true && on?.queued === false
        && off?.on === false && off?.menu === true
        && lurker.spectator === true && !sRoom.roster.includes(lurker);
    })());
  }

  /* ── Bans ──────────────────────────────────────────────────────────────── */

  suite('Bans');

  const banRoom = new Room({ id: 'test-ban', mapId: 'burgtown', modeId: 'ffa' });
  const sent = [];
  banRoom.broadcast = (m) => sent.push(m);
  banRoom.sendTo = (p, m) => sent.push({ ...m, _to: p.id });
  const cheat = new Player({ ws: null, name: 'Cheater', userId: 31, classId: 'triggerman', ip: '::ffff:203.0.113.9' });
  banRoom.add(cheat);

  check('a player carries the address they connected from, without the v6 mapping',
    cheat.ip === '203.0.113.9', cheat.ip);

  sent.length = 0;
  const payload = { o: K.S2C.ERROR, code: 'banned', reason: 'aimbot', until: -1, ref: '0xDEADBEEF' };
  banRoom.applyBan(cheat, { chat: 'Cheater has been banned permanently — aimbot', payload });

  check('the room is told in red that someone was banned', (() => {
    const line = sent.find((m) => m.o === K.S2C.CHAT && m.kind === 'ban');
    info(line?.text ?? 'no chat line');
    return !!line && line.system === true && line.text.includes('aimbot');
  })());

  check('the banned player gets the ban screen for themselves', (() => {
    const screen = sent.find((m) => m.code === 'banned' && m._to === cheat.id);
    return !!screen && screen.reason === 'aimbot';
  })());

  /* ── Match chat ────────────────────────────────────────────────────────── */

  suite('Match chat');

  const chatRoom = makeRoom({ id: 'test-chat', mapId: 'burgtown', modeId: 'ffa' }, makeDb());
  const say = (p, text) => chatRoom.onChat(p, { m: text });
  const spoken = () => chatRoom.messages.filter((m) => m.o === K.S2C.CHAT && !m.system && !m.purge);

  const rookie = addHuman(chatRoom, 'Rookie', 41);        // level 1: the default
  const talker = addHuman(chatRoom, 'Talker', 42);
  talker.level = 5;
  const drifter = addHuman(chatRoom, 'Drifter', null);    // guest
  drifter.level = 9;                                      // a level means nothing without an account

  chatRoom.messages.length = 0;
  say(drifter, 'hello');
  say(rookie, 'hello');
  say(talker, 'hello');

  check('only a signed-in account at the level gate gets to write', (() => {
    const names = spoken().map((m) => m.name);
    info(names.join(', ') || 'nobody');
    return names.length === 1 && names[0] === 'Talker';
  })());

  check('a refusal goes to the sender alone, and says why', (() => {
    const told = chatRoom.messages.filter((m) => m.o === K.S2C.CHATSTATE && m._to === rookie.id);
    info(told[0]?.reason ?? 'nothing said');
    return told.length === 1 && told[0].canSend === false && /level 2/.test(told[0].reason);
  })());

  check('a line carries the badges its sender wears', (() => {
    Object.assign(talker, { verified: true, clan: 'OG', role: 'mod', lastChatAt: 0 });
    chatRoom.messages.length = 0;
    say(talker, 'hi again');
    const line = spoken()[0];
    info(JSON.stringify({ ...line, o: undefined, at: undefined }));
    return line.verified === true && line.clan === 'OG' && line.role === 'mod' && line.level === 5;
  })());

  check('the history keeps fifty lines, dropping the oldest rather than the newest', (() => {
    chatRoom.chat.length = 0;
    const total = K.CHAT_HISTORY + 20;
    for (let i = 0; i < total; i++) { talker.lastChatAt = 0; say(talker, `m${i}`); }
    const h = chatRoom.chat;
    info(`${h.length} kept: ${h[0].text} … ${h[h.length - 1].text}`);
    return h.length === K.CHAT_HISTORY
      && h[0].text === `m${total - K.CHAT_HISTORY}` && h[h.length - 1].text === `m${total - 1}`;
  })());

  check('a new arrival is handed the match history rather than an empty log', (() => {
    const payload = chatRoom.chatPayload(talker);
    return payload.history.length === K.CHAT_HISTORY && payload.canSend === true
      && payload.max === K.CHAT_HISTORY && payload.minLevel === K.CHAT_MIN_LEVEL;
  })());

  check('joins and captures are said out loud but never replayed', (() => {
    const before = chatRoom.chat.length;
    chatRoom.pushSystemChat('Someone joined');
    const heard = chatRoom.messages.some((m) => m.text === 'Someone joined');
    return heard && chatRoom.chat.length === before;
  })());

  check('the end of a match purges its chat', (() => {
    chatRoom.messages.length = 0;
    chatRoom.now = chatRoom.matchStart + 60;
    chatRoom.endMatch('time');
    const cleared = chatRoom.messages.some((m) => m.o === K.S2C.CHAT && m.purge);
    return chatRoom.chat.length === 0 && cleared;
  })());

  /* ── Chat bans ─────────────────────────────────────────────────────────── */

  suite('Chat bans');

  const muteRoom = makeRoom({ id: 'test-mute', mapId: 'burgtown', modeId: 'ffa' }, makeDb());
  const officer = addHuman(muteRoom, 'Officer', 51);
  const loud = addHuman(muteRoom, 'Loud', 52);
  const colleague = addHuman(muteRoom, 'Colleague', 53);
  for (const p of [officer, loud, colleague]) p.level = 9;
  officer.role = 'mod';
  colleague.role = 'mod';

  // Back-to-back in the same millisecond is not what a moderator clicking
  // buttons looks like, so each action here starts from a clear cooldown.
  const moderate = (actor, msg) => { actor.lastModAt = 0; muteRoom.onModAction(actor, msg); };

  muteRoom.messages.length = 0;
  moderate(officer, { a: 'mute', t: loud.id, d: 5 });

  check('a moderator can shut someone up from the scoreboard', loud.muted === true,
    `muted until ${loud.mutedUntil}`);

  check('the room is told, and the notice stays in the match history', (() => {
    const line = muteRoom.chat.find((m) => m.kind === 'mute');
    info(line?.text ?? 'no line kept');
    return !!line && line.text.includes('Loud') && line.text.includes('Officer');
  })());

  check('a muted player is refused, and only they are told', (() => {
    muteRoom.messages.length = 0;
    muteRoom.onChat(loud, { m: 'let me speak' });
    const spoke = muteRoom.messages.some((m) => m.o === K.S2C.CHAT && m.name === 'Loud');
    const told = muteRoom.messages.find((m) => m.o === K.S2C.CHATSTATE && m._to === loud.id);
    return !spoke && told?.canSend === false && /muted/.test(told.reason);
  })());

  check('a mute takes nobody out of the match they are playing',
    muteRoom.players.has(loud.id) && loud.ws === null && !loud.spectator);

  check('a plain player cannot mute anyone', (() => {
    moderate(loud, { a: 'mute', t: officer.id, d: 5 });
    return !officer.muted;
  })());

  check('one moderator cannot silence another of the same rank', (() => {
    moderate(officer, { a: 'mute', t: colleague.id, d: 5 });
    return !colleague.muted;
  })());

  check('a burst of clicks lands once, not once per click', (() => {
    // The cooldown is on what actually happens, so the second mute inside half
    // a second is dropped rather than re-announced to the room.
    const before = muteRoom.chat.filter((m) => m.kind === 'mute').length;
    officer.lastModAt = 0;
    muteRoom.onModAction(officer, { a: 'mute', t: loud.id, d: 60 });
    muteRoom.onModAction(officer, { a: 'mute', t: loud.id, d: 60 });
    const after = muteRoom.chat.filter((m) => m.kind === 'mute').length;
    info(`${after - before} notice(s) for two clicks`);
    return after - before === 1;
  })());

  check('unmuting hands the chat straight back', (() => {
    moderate(officer, { a: 'unmute', t: loud.id });
    muteRoom.messages.length = 0;
    muteRoom.onChat(loud, { m: 'thanks' });
    return !loud.muted && muteRoom.messages.some((m) => m.o === K.S2C.CHAT && m.name === 'Loud');
  })());

  /* ── IP ban storage ────────────────────────────────────────────────────── */

  // tests/run.mjs points DB_PATH at a throwaway file before any suite loads, so
  // this is the real SQL against a real database — just never the live one.
  const real = await import('../server/db/index.js');

  try {
    check('an address ban normalises the IPv4-mapped form', (() => {
      real.ipBans.add({ ip: '::ffff:198.51.100.7', reason: 'ban evasion', userId: 5, username: 'Ghost' });
      const hit = real.ipBans.active('198.51.100.7');
      const same = real.ipBans.active('::ffff:198.51.100.7');
      return !!hit && !!same && hit.ip === '198.51.100.7' && hit.until === -1;
    })());

    check('a timed address ban expires on its own', (() => {
      real.ipBans.add({ ip: '198.51.100.8', reason: 'spam', days: 1 });
      const row = real.ipBans.get('198.51.100.8');
      // Rewind it to yesterday and it should read as clean, and be gone.
      real.db.prepare('UPDATE ip_bans SET until = ? WHERE ip = ?')
        .run(Math.floor(Date.now() / 1000) - 60, '198.51.100.8');
      const after = real.ipBans.active('198.51.100.8');
      return row.until > 0 && after === null && real.ipBans.get('198.51.100.8') === null;
    })());

    check('lifting an address ban leaves nothing behind', (() => {
      real.ipBans.remove('198.51.100.7');
      return real.ipBans.active('198.51.100.7') === null;
    })());

    check('an unbanned address is not banned', real.ipBans.active('203.0.113.1') === null);

    /* ── The room → SQLite contract ──────────────────────────────────────── */

    suite('Match settlement (real database)');

    // The stand-in above proves the control flow; this proves the values the
    // room hands over are ones SQLite will actually take. A float where an
    // INTEGER column is expected throws, and that used to lose the whole match.
    const user = real.users.create({
      username: 'Settler', email: null, passwordHash: 'x', ip: '203.0.113.4',
    });
    const live = new Room({ id: 'test-real', mapId: 'burgtown', modeId: 'ffa', hub: { db: real } });
    live.broadcast = () => {};
    live.sendTo = () => {};
    const settler = new Player({ ws: null, name: 'Settler', userId: user.id, classId: 'triggerman' });
    live.add(settler);

    Object.assign(settler.score, {
      kills: 7, deaths: 3, assists: 1, headshots: 2,
      // Damage and score accumulate as floats in play; the columns are integers.
      damage: 812.4, score: 613.6, shotsFired: 44, shotsHit: 19, bestStreak: 4,
    });
    settler.weaponKills.set('ar', 7);
    live.now = live.matchStart + 91.37;

    let threw = null;
    try { live.endMatch('time'); } catch (e) { threw = e; }

    check('a finished match writes without a type error', threw === null, threw?.message ?? 'clean');

    check('the account\'s lifetime stats moved', (() => {
      const st = real.stats.get(user.id);
      info(`kills ${st?.kills} · score ${st?.score} · damage ${st?.damage_dealt} · matches ${st?.matches}`);
      return st && st.kills === 7 && st.deaths === 3 && st.matches === 1
        && st.score === 614 && st.damage_dealt === 812 && st.wins === 1;
    })());

    check('XP and GR landed on the account', (() => {
      // The match payout, the two bonuses a first match of the day always
      // carries — day one of the play streak and the first win — and the grant
      // the account was opened with, which is still sitting in the same wallet.
      const u = real.users.byId(user.id);
      // …and every rung the payout crossed on the way up, which is paid for the
      // moment it is crossed rather than at the next match.
      let ladder = 0;
      for (let l = 2; l <= u.level; l++) ladder += K.levelUpReward(l).gr;
      const expected = K.SIGNUP_REWARD.gr + K.grFromScore(613.6, true)
        + K.streakReward(1).gr + K.FIRST_WIN_BONUS.gr + ladder;
      info(`${u.xp} XP · ${u.gr} GR · level ${u.level} (expected ${expected} GR, ${ladder} of it from levels)`);
      return u.xp > 0 && u.gr === expected;
    })());

    check('crossing four levels paid for four levels, not one', (() => {
      const u = real.users.byId(user.id);
      info(`level ${u.level} on ${u.xp} XP`);
      return u.level === K.levelFromXp(u.xp) && u.level > 1;
    })());

    check('the first match of the day opens a play streak', (() => {
      const u = real.users.byId(user.id);
      info(`day ${u.last_play_day} · streak ${u.play_streak} · best ${u.best_streak_days}`);
      return u.play_streak === 1 && u.best_streak_days === 1 && u.last_play_day === K.dayIndex()
        && u.last_win_day === K.dayIndex();
    })());

    check('the match and its player row were recorded', (() => {
      const rows = real.matches.recentFor(user.id, 5);
      info(`${rows.length} match row(s)`);
      return rows.length === 1 && rows[0].kills === 7 && rows[0].won === 1;
    })());

    check('weapon mastery reached the mastery table',
      real.mastery.forUser(user.id).ar?.kills === 7);

    /* ── Chat ban storage ────────────────────────────────────────────────── */

    suite('Chat bans (real database)');

    check('a mute is stored against the account and read back', (() => {
      real.chatBans.set({
        userId: user.id, until: -1, reason: 'spam', actor: 'admin@local', username: 'Settler',
      });
      const row = real.chatBans.active(user.id);
      return !!row && row.until === -1 && row.reason === 'spam' && row.actor === 'admin@local';
    })());

    check('a second mute replaces the first rather than colliding', (() => {
      const row = real.chatBans.add({ userId: user.id, minutes: 30, reason: 'again' });
      return row.until > 0 && real.chatBans.list(10).filter((b) => b.user_id === user.id).length === 1;
    })());

    check('a timed mute expires on its own', (() => {
      real.db.prepare('UPDATE chat_bans SET until = ? WHERE user_id = ?')
        .run(Math.floor(Date.now() / 1000) - 60, user.id);
      const after = real.chatBans.active(user.id);
      return after === null && real.chatBans.get(user.id) === null;
    })());

    check('lifting a mute leaves nothing behind', (() => {
      real.chatBans.set({ userId: user.id, until: -1 });
      real.chatBans.remove(user.id);
      return real.chatBans.active(user.id) === null;
    })());

    /* ── Reports ─────────────────────────────────────────────────────────── */

    suite('Player reports (real database)');

    // Reporting goes through the room rather than the API because the room is
    // the only thing that knows who was actually in the match; that is exactly
    // what these checks are about.
    const witness = real.users.create({ username: 'Witness', email: null, passwordHash: 'x', ip: '198.51.100.20' });
    const accused = real.users.create({ username: 'Accused', email: null, passwordHash: 'x', ip: '198.51.100.21' });

    const repRoom = new Room({ id: 'test-report', mapId: 'crossfire', modeId: 'tdm', hub: { db: real } });
    const repSent = [];
    repRoom.broadcast = (m) => repSent.push(m);
    repRoom.sendTo = (p, m) => repSent.push({ ...m, _to: p.id });

    const reporter = new Player({ ws: null, name: 'Witness', userId: witness.id, classId: 'triggerman' });
    const suspect = new Player({ ws: null, name: 'Accused', userId: accused.id, classId: 'triggerman', ip: '198.51.100.21' });
    const guest = new Player({ ws: null, name: 'Nobody', userId: null, classId: 'triggerman' });
    for (const p of [reporter, suspect, guest]) { p.level = 5; repRoom.add(p); }
    const bot = repRoom.addBot();

    /** One report, with the double-click guard cleared first. */
    const file = (from, msg) => { from.lastReportAt = 0; repRoom.onReport(from, msg); };
    const answers = () => repSent.filter((m) => m.o === K.S2C.REPORT);

    /** A fresh, reportable body in the room. */
    const spawnTarget = (name) => {
      const p = new Player({ ws: null, name, userId: null, classId: 'triggerman' });
      p.level = 3;
      repRoom.add(p);
      return p;
    };

    /**
     * There are six separate ceilings on reporting, and testing one through
     * another only ever proves which of them fires first. Every check below
     * opens the others right up and closes the single rule it is about, then
     * `relax()` puts things back for the next one.
     */
    const quota = config.reports;
    const quotaDefaults = { ...quota };
    const relax = (over = {}) => Object.assign(quota, quotaDefaults, {
      cooldownSec: 0, maxOpen: 9999, maxPerHour: 9999, maxPerDay: 9999, dismissedMax: 0,
    }, over);
    /** Settles everything this account has filed, freeing the open ceiling. */
    const settleAll = (status = 'actioned') => {
      for (const rep of real.reports.forReporter(witness.id, 500)) {
        if (rep.status === 'open') real.reports.resolve(rep.id, { status, action: 'warned' });
      }
    };
    relax();

    check('a guest cannot report anybody', (() => {
      repSent.length = 0;
      file(guest, { t: suspect.id, r: 'cheat' });
      const told = answers()[0];
      info(told?.message ?? 'nothing said');
      return real.reports.count() === 0 && told?.ok === false && /sign in/.test(told.message);
    })());

    check('an account below the level gate cannot report', (() => {
      repSent.length = 0;
      reporter.level = 1;
      file(reporter, { t: suspect.id, r: 'cheat' });
      reporter.level = 5;
      const told = answers()[0];
      info(told?.message ?? 'nothing said');
      return real.reports.count() === 0 && told?.ok === false && /level/.test(told.message);
    })());

    check('a report with no usable reason is refused', (() => {
      repSent.length = 0;
      file(reporter, { t: suspect.id, r: 'because-i-lost' });
      return real.reports.count() === 0 && answers()[0]?.message === 'pick a reason for the report';
    })());

    check('bots and your own row are not reportable', (() => {
      repSent.length = 0;
      file(reporter, { t: bot.id, r: 'cheat' });
      file(reporter, { t: reporter.id, r: 'cheat' });
      return real.reports.count() === 0;
    })());

    // Something to attach: two lines of chat, one of them the server's own.
    repRoom.pushChat({ id: suspect.id, name: 'Accused', text: 'ez', team: 0 });
    repRoom.pushSystemChat('Witness joined', null, true);

    check('a report is filed with the match it happened in', (() => {
      repSent.length = 0;
      file(reporter, { t: suspect.id, r: 'cheat', d: '  walling through mid  ' });
      const rep = real.reports.forReporter(witness.id)[0];
      info(rep ? `#${rep.id} ${rep.targetName} · ${rep.reason} · ${rep.room} · ${rep.map}/${rep.mode}` : 'nothing filed');
      return !!rep && rep.targetName === 'Accused' && rep.targetId === accused.id
        && rep.reason === 'cheat' && rep.detail === 'walling through mid'
        && rep.map === 'crossfire' && rep.mode === 'tdm' && rep.room === repRoom.code
        && rep.status === 'open' && answers()[0]?.ok === true;
    })());

    check('the address of the reported player travels with it — the only handle on a guest',
      real.reports.forReporter(witness.id)[0].targetIp === '198.51.100.21');

    check('what was being said is attached, minus the server\'s own lines', (() => {
      const snap = real.reports.forReporter(witness.id)[0].chatLog;
      info(JSON.stringify(snap));
      return snap.length === 1 && snap[0].name === 'Accused' && snap[0].text === 'ez';
    })());

    check('only the reporter is told; the room never learns of it', (() => {
      const heard = repSent.filter((m) => m.o === K.S2C.CHAT && !m._to);
      const priv = repSent.find((m) => m.o === K.S2C.CHAT && m._to === reporter.id);
      info(`${heard.length} public line(s), ${priv ? 'a private one' : 'nothing private'}`);
      return heard.length === 0 && !!priv && /Report filed/.test(priv.text);
    })());

    check('the same player cannot be reported twice by the same person', (() => {
      repSent.length = 0;
      file(reporter, { t: suspect.id, r: 'chat' });
      const told = answers()[0];
      info(told?.message ?? 'nothing said');
      return real.reports.forReporter(witness.id).length === 1
        && told?.ok === false && /already reported/.test(told.message);
    })());

    check('a burst of clicks files one report, not one per click', (() => {
      const before = real.reports.count();
      const target = spawnTarget('Fresh');
      reporter.lastReportAt = 0;
      repRoom.onReport(reporter, { t: target.id, r: 'grief' });
      repRoom.onReport(reporter, { t: target.id, r: 'grief' });
      info(`${real.reports.count() - before} filed for two clicks`);
      return real.reports.count() - before === 1;
    })());

    check('a guest can be reported even though they have no account', (() => {
      const rep = real.reports.forReporter(witness.id).find((r) => r.targetName === 'Fresh');
      return !!rep && rep.targetId === null;
    })());

    /* ── The ceilings, one rule at a time ────────────────────────────────── */

    check('a flat cooldown separates any two reports', (() => {
      relax({ cooldownSec: 120 });
      file(reporter, { t: spawnTarget('Gap1').id, r: 'grief' });
      const before = real.reports.count();
      repSent.length = 0;
      file(reporter, { t: spawnTarget('Gap2').id, r: 'grief' });
      const told = answers()[0];
      info(told?.message ?? 'accepted');
      relax();
      return real.reports.count() === before
        && told?.ok === false && /one report at a time/.test(told.message);
    })());

    check('one account cannot flood the queue in an hour', (() => {
      relax({ maxPerHour: 4 });
      settleAll();
      const start = real.reports.countSince(witness.id, Math.floor(Date.now() / 1000) - 3600);
      let refused = null;
      for (let i = 0; i < 4 - start + 1; i++) {
        repSent.length = 0;
        file(reporter, { t: spawnTarget(`Hour${i}`).id, r: 'grief' });
        refused = answers()[0];
      }
      const filed = real.reports.countSince(witness.id, Math.floor(Date.now() / 1000) - 3600);
      info(`${filed} filed this hour, last answer: ${refused?.message ?? 'accepted'}`);
      relax();
      return filed === 4 && refused?.ok === false && /this hour/.test(refused.message);
    })());

    check('…and the daily ceiling outlives the hourly one', (() => {
      // Backdate everything filed so far out of the hour but not out of the day:
      // the hourly cap now has nothing to say, and only the daily one is left.
      const now = Math.floor(Date.now() / 1000);
      real.db.prepare('UPDATE reports SET created_at = ? WHERE reporter_id = ?')
        .run(now - 7200, witness.id);
      const filedToday = real.reports.countSince(witness.id, now - 86400);
      relax({ maxPerDay: filedToday });
      repSent.length = 0;
      file(reporter, { t: spawnTarget('Daily').id, r: 'grief' });
      const told = answers()[0];
      info(`${filedToday} today, answer: ${told?.message ?? 'accepted'}`);
      relax();
      return told?.ok === false && /today/.test(told.message);
    })());

    check('reports nobody has read yet are not an allowance to spend', (() => {
      relax({ maxOpen: 2 });
      settleAll();
      file(reporter, { t: spawnTarget('Open1').id, r: 'grief' });
      file(reporter, { t: spawnTarget('Open2').id, r: 'grief' });
      const before = real.reports.count();
      repSent.length = 0;
      file(reporter, { t: spawnTarget('Open3').id, r: 'grief' });
      const blocked = answers()[0];

      // A moderator working the queue hands the allowance straight back.
      settleAll();
      repSent.length = 0;
      file(reporter, { t: spawnTarget('Open4').id, r: 'grief' });
      const after = answers()[0];
      info(`blocked: ${blocked?.message ?? 'accepted'} · then ${after?.ok ? 'accepted' : after?.message}`);
      relax();
      return real.reports.count() === before + 1
        && blocked?.ok === false && /still being looked at/.test(blocked.message)
        && after?.ok === true;
    })());

    check('a reporter whose reports keep being thrown out is shut out for a day', (() => {
      // Two of this account's reports, both dismissed by a moderator.
      settleAll();
      file(reporter, { t: spawnTarget('Wolf0').id, r: 'grief' });
      file(reporter, { t: spawnTarget('Wolf1').id, r: 'grief' });
      settleAll('rejected');
      relax({ dismissedMax: 2, dismissedWindowDays: 7, dismissedLockoutHours: 24 });
      const before = real.reports.count();
      repSent.length = 0;
      file(reporter, { t: spawnTarget('Wolf').id, r: 'grief' });
      const told = answers()[0];
      info(told?.message ?? 'accepted');

      // The lockout is measured from the last dismissal, so an old one lapses
      // on its own without any state to clean up.
      real.db.prepare("UPDATE reports SET resolved_at = ? WHERE reporter_id = ? AND status = 'rejected'")
        .run(Math.floor(Date.now() / 1000) - 2 * 86400, witness.id);
      repSent.length = 0;
      file(reporter, { t: spawnTarget('Wolf2').id, r: 'grief' });
      const later = answers()[0];
      relax();
      return real.reports.count() === before + 1
        && told?.ok === false && /dismissed/.test(told.message)
        && later?.ok === true;
    })());

    check('a moderator can switch one account\'s reporting off entirely', (() => {
      // The one ceiling that is not self-clearing, and the only one a human
      // issues by hand. Everything else on this list is about how many; this is
      // about who.
      relax();
      settleAll();
      real.reportBans.set({
        userId: witness.id, until: -1, reason: 'using the queue as a weapon', actor: 'admin@local',
      });
      const standing = reportStanding(real, { id: witness.id, level: 30 });
      repSent.length = 0;
      const before = real.reports.count();
      file(reporter, { t: spawnTarget('Untouchable').id, r: 'cheat' });
      const told = answers()[0];
      info(`${standing.reason}`);
      return standing.blocked === true && standing.allowed === false
        && /switched off for your account/.test(standing.reason)
        && /using the queue as a weapon/.test(standing.reason)
        && real.reports.count() === before
        && told?.ok === false && /switched off for your account/.test(told.message);
    })());

    check('a spectator is told to take a seat before reporting', (() => {
      const lurker = new Player({ ws: null, name: 'Lurker', userId: null, classId: 'triggerman', spectator: true });
      repRoom.add(lurker);
      const why = repRoom.reportDenial(lurker);
      info(why);
      return /take a seat/.test(why);
    })());

    check('the room hands that refusal straight to the scoreboard', (() => {
      // The greyed button and the server's answer have to be the same sentence:
      // they come from the same function, so a player is never told two things.
      const payload = repRoom.reportPayload(reporter);
      info(`${payload.canReport ? 'allowed' : 'refused'} — ${payload.reason}`);
      return payload.enabled === true && payload.canReport === false
        && payload.reason === reportStanding(real, { id: witness.id, level: reporter.level }).reason;
    })());

    check('lifting the block gives the button straight back', (() => {
      repSent.length = 0;
      repRoom.applyReportBan(reporter, { until: 0, by: 'admin@local' });
      const pushed = repSent.find((m) => m.o === K.S2C.REPORTSTATE && m._to === reporter.id);
      const before = real.reports.count();
      file(reporter, { t: spawnTarget('Reportable').id, r: 'cheat' });
      info(pushed ? `pushed canReport=${pushed.canReport}` : 'nothing pushed');
      return real.reportBans.active(witness.id) === null
        && !!pushed && pushed.canReport === true
        && real.reports.count() === before + 1;
    })());

    check('a block that has expired is not a block', (() => {
      real.reportBans.set({ userId: witness.id, until: Math.floor(Date.now() / 1000) - 5 });
      const standing = reportStanding(real, { id: witness.id, level: 30 });
      // …and the lapsed row is cleaned up in passing rather than left to rot.
      return standing.blocked === false && real.reportBans.get(witness.id) === null;
    })());

    // Everything after this point is about stored reports rather than the
    // ceilings on filing them, so put the server's real limits back.
    Object.assign(quota, quotaDefaults);

    check('a moderator\'s verdict is what the reporter reads back', (() => {
      const filed = real.reports.forReporter(witness.id, 500);
      const rep = filed.find((r) => r.status === 'open') ?? filed.at(-1);
      const openBefore = real.reports.countOpen();
      real.reports.resolve(rep.id, {
        status: 'actioned', action: 'banned',
        outcome: 'Banned for a week. Thanks for the report.', resolver: 'admin@local',
      });
      const after = real.reports.get(rep.id);
      info(`${after.status} · ${after.action} · ${after.outcome}`);
      return after.status === 'actioned' && after.action === 'banned' && after.resolvedAt > 0
        && after.outcome === 'Banned for a week. Thanks for the report.'
        && real.reports.countOpen() === openBefore - (rep.status === 'open' ? 1 : 0);
    })());

    check('the queue puts open reports first, however old they are', (() => {
      const { rows } = real.reports.list({});
      const firstSettled = rows.findIndex((r) => r.status !== 'open');
      const lastOpen = rows.map((r) => r.status).lastIndexOf('open');
      info(rows.map((r) => r.status).join(', '));
      return firstSettled === -1 || lastOpen < firstSettled;
    })());

    check('a search finds a report by either side of it or by its words', (() => {
      const byTarget = real.reports.list({ q: 'accused' }).rows.length;
      const byReporter = real.reports.list({ q: 'witness' }).rows.length;
      const byWords = real.reports.list({ q: 'walling' }).rows.length;
      info(`target ${byTarget} · reporter ${byReporter} · words ${byWords}`);
      return byTarget >= 1 && byReporter >= 1 && byWords === 1;
    })());

    check('settled reports age out and open ones never do', (() => {
      const openBefore = real.reports.countOpen();
      const settledBefore = real.reports.count() - openBefore;
      real.db.prepare("UPDATE reports SET resolved_at = ? WHERE status <> 'open'")
        .run(Math.floor(Date.now() / 1000) - 400 * 86400);
      const pruned = real.reports.prune(90 * 86400);
      info(`${pruned} of ${settledBefore} settled pruned, ${real.reports.countOpen()} open left`);
      return pruned === settledBefore && settledBefore > 0
        && real.reports.countOpen() === openBefore;
    })());

    /* ── Profile pictures ────────────────────────────────────────────────── */

    suite('Profile pictures');

    check('a PNG is measured from its header', (() => {
      const hit = identify(png(120, 90));
      info(JSON.stringify(hit));
      return hit?.type === 'image/png' && hit.width === 120 && hit.height === 90;
    })());

    check('a JPEG is measured by walking to its frame header', (() => {
      const hit = identify(jpeg(64, 48));
      info(JSON.stringify(hit));
      return hit?.type === 'image/jpeg' && hit.width === 64 && hit.height === 48;
    })());

    check('a lossy WebP is measured from its VP8 chunk', (() => {
      const hit = identify(webp(200, 150));
      info(JSON.stringify(hit));
      return hit?.type === 'image/webp' && hit.width === 200 && hit.height === 150;
    })());

    check('a file that only claims to be an image is refused', (() => {
      const verdict = validateAvatar(Buffer.from('<script>alert(1)</script>'.padEnd(400, ' ')), LIMITS);
      info(verdict.message);
      return verdict.ok === false && verdict.code === 'unsupported_image';
    })());

    check('an oversized picture is refused on its pixels, not its bytes', (() => {
      // 900x900 of one flat colour compresses to almost nothing, so only the
      // dimension check can catch it.
      const big = png(900, 900);
      const verdict = validateAvatar(big, LIMITS);
      info(`${Math.round(big.length / 1024)} KB · ${verdict.message}`);
      return big.length < LIMITS.maxBytes && verdict.ok === false && verdict.code === 'image_too_big';
    })());

    check('a picture past the byte ceiling is refused', (() => {
      const verdict = validateAvatar(png(64, 64), { ...LIMITS, maxBytes: 10 });
      return verdict.ok === false && verdict.code === 'image_too_large';
    })());

    check('a favicon-sized picture is too small to be a face', (() => {
      const verdict = validateAvatar(png(8, 8), LIMITS);
      info(verdict.message);
      return verdict.ok === false && verdict.code === 'image_too_small';
    })());

    check('a truncated image is refused rather than guessed at',
      validateAvatar(png(64, 64).subarray(0, 20), LIMITS).ok === false);

    check('a stored picture is named by its own content', (() => {
      const name = `${user.id}-0123456789ab.webp`;
      const path = avatarPathFor(name);
      info(`${avatarUrlFor(name)} · ${path ? 'resolved' : 'refused'}`);
      return avatarUrlFor(name) === `/avatars/${name}` && !!path;
    })());

    check('a name that is not one of ours never reaches the filesystem', (() => {
      const tries = ['../../server/config.js', '4-abc.png', 'evil.svg', `${user.id}-0123456789ab.exe`,
        `..%2f${user.id}-0123456789ab.png`];
      const refused = tries.filter((t) => avatarPathFor(t) === null);
      info(`${refused.length}/${tries.length} refused`);
      return refused.length === tries.length;
    })());

    check('the account row points at the file, never holds it', (() => {
      const name = `${user.id}-abcdef012345.webp`;
      const fresh = real.users.setAvatar(user.id, name);
      const cleared = real.users.setAvatar(user.id, null);
      return fresh.avatar === name && fresh.avatar_at > 0 && cleared.avatar === null;
    })());
  } finally {
    real.close();
  }
}
