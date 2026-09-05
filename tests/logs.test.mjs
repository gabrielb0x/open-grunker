/**
 * Open Grunker — the log.
 *
 * Three things are worth testing here and they are all things that used to be
 * impossible to ask of a log made of sentences: that a line carries its
 * structure, that the structure can be filtered on, and that the copy on disk
 * is bounded, safe to name from a query string, and never able to take the
 * server down with it.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, check, info, sleep } from './harness.mjs';

const log = (await import('../server/util/log.js')).default;
const { Room } = await import('../server/game/room.js');
const { Player } = await import('../server/game/player.js');
const K = await import('../shared/constants.js');
const { recent, stats, CAT, CAT_NAMES, LEVEL_NAMES } = await import('../server/util/log.js');
const { LogSink } = await import('../server/util/logsink.js');
const db = await import('../server/db/index.js');

/** A player as the room hands one over. */
const fakePlayer = (name, userId) => ({ name, userId, ip: '203.0.113.9' });
const fakeRoom = { code: 'TST:0001', mapId: 'chateau', modeId: 'ffa' };

export default async function run() {
  suite('Logs — a line is a record');

  log.clear();
  const room = log.child('room', 'match');

  check('a plain line still works exactly as it did', (() => {
    room.info('room up');
    const [e] = recent({ limit: 1 });
    return e.msg === 'room up' && e.level === 'info' && e.ns === 'room' && e.cat === 'match';
  })());

  check('a trailing object becomes fields rather than text', (() => {
    room.warn('rotated', { map: 'nova', players: 6 });
    const [e] = recent({ limit: 1 });
    return e.msg === 'rotated' && e.map === 'nova' && e.fields?.players === 6;
  })());

  check('an Error is still a message, not a field bag', (() => {
    room.error('boom:', new Error('the disk went away'));
    const [e] = recent({ limit: 1 });
    return e.msg.includes('the disk went away') && !e.fields;
  })());

  check('a line can be attached to a player without the call site repeating them', (() => {
    const plog = room.for(fakePlayer('gab', 'user-1'), fakeRoom);
    plog.info('joined');
    plog.info('left', { kills: 3 });
    const lines = recent({ limit: 2 });
    return lines.every((e) => e.player === 'gab' && e.userId === 'user-1' && e.room === 'TST:0001')
      && lines[0].fields.kills === 3;
  })());

  check('a single line can say it belongs to another category', (() => {
    room.as('moderation').info('muted somebody');
    const [e] = recent({ limit: 1 });
    return e.cat === CAT.moderation && e.ns === 'room';
  })());

  check('a field bag cannot put a megabyte in the ring', (() => {
    room.info('big', { blob: 'x'.repeat(5000), ...Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`k${i}`, i])) });
    const [e] = recent({ limit: 1 });
    const size = JSON.stringify(e).length;
    info(`${Object.keys(e.fields).length} fields kept, record is ${size} bytes`);
    return Object.keys(e.fields).length <= 24 && size < 2000;
  })());

  suite('Logs — asking it questions');

  log.clear();
  const combat = log.child('combat', 'combat');
  combat.for(fakePlayer('gab', 'user-1'), fakeRoom).info('killed hunter', { weapon: 'ak', head: true });
  combat.for(fakePlayer('hunter', 'user-2'), fakeRoom).info('killed gab', { weapon: 'shotgun' });
  log.child('api', 'account').warn('sign-in refused', { ip: '198.51.100.4' });
  log.child('net', 'net').debug('socket open', { ip: '198.51.100.4' });

  check('by level', recent({ level: 'warn' }).length === 1
    && recent({ level: 'info,debug' }).length === 3);
  check('by category', recent({ cat: 'combat' }).length === 2
    && recent({ cat: 'combat,account' }).length === 3);
  check('by source', recent({ ns: 'api' }).length === 1);
  check('by player, loosely, because nobody types an exact case',
    recent({ player: 'GAB' }).length === 1);
  check('by account, exactly, because an id is not a nickname',
    recent({ userId: 'user-2' }).length === 1);
  check('by room', recent({ room: 'tst:0001' }).length === 2);

  check('by free text, across the message and the fields', (() => {
    const byMessage = recent({ q: 'refused' }).length;
    const byField = recent({ q: 'shotgun' }).length;
    const byFieldName = recent({ q: 'weapon' }).length;
    info(`${byMessage} on the message, ${byField} on a value, ${byFieldName} on a key`);
    return byMessage === 1 && byField === 1 && byFieldName === 2;
  })());

  check('and filters compose', recent({ cat: 'combat', q: 'ak' }).length === 1);

  check('`since` hands back only what the panel has not drawn', (() => {
    const before = recent({ limit: 1 })[0].id;
    combat.info('one more');
    const fresh = recent({ sinceId: before });
    return fresh.length === 1 && fresh[0].msg === 'one more';
  })());

  check('the statistics agree with what is in the buffer', (() => {
    const s = stats();
    const summed = Object.values(s.byLevel).reduce((a, b) => a + b, 0);
    info(`${s.buffered} buffered of ${s.capacity}, ${s.namespaces.length} source(s)`);
    return summed === s.buffered && s.byCat.combat === 3 && s.lastId > 0;
  })());

  check('every category and level the panel offers is one the log can write',
    CAT_NAMES.every((c) => CAT[c] === c) && LEVEL_NAMES.length === 4);

  suite('Logs — a match writes its own history');

  /*
   * The line the whole thing exists for.
   *
   * A death is the single most useful record a game server can write: who,
   * whom, with what, from how far, whether it was a headshot, and what the
   * streak stood at. Everything else about a match can be reconstructed from
   * those, and none of it can be reconstructed from a scoreboard.
   */
  log.clear();
  const arena = new Room({ id: 'test-logs', mapId: 'subzero', modeId: 'ffa' });
  arena.wake();
  arena.broadcast = arena.broadcastNear = arena.sendTo = () => {};
  const killer = new Player({ name: 'Shooter', classId: 'triggerman', userId: 'user-k' });
  const victim = new Player({ name: 'Target', classId: 'triggerman' });
  arena.players.set(killer.id, killer);
  arena.players.set(victim.id, victim);
  killer.spawnAt(0, 20, 0, 0, arena.now);
  victim.spawnAt(0, 20, 14, 0, arena.now);

  check('a kill is one line, and it names everything about the kill', (() => {
    log.clear();
    arena.onKill(killer, victim, 'ak', true, { id: 'ak' }, { distance: 14.2 });
    const [e] = recent({ cat: 'combat', limit: 1 });
    if (!e) { info('nothing was written'); return false; }
    info(`${e.msg} · ${JSON.stringify(e.fields)}`);
    return e.player === 'Shooter' && e.userId === 'user-k' && e.room === arena.code
      && e.msg.includes('Target') && e.fields.weapon === 'ak' && e.fields.head === true
      && e.fields.distance === 14.2 && e.map === 'subzero';
  })());

  check('and it is findable from either end of it', (() => {
    // The killer's account, and the victim by name in the fields.
    return recent({ userId: 'user-k', cat: 'combat' }).length === 1
      && recent({ q: 'target' }).length >= 1;
  })());

  check('a chat line is kept, in its own category', (() => {
    log.clear();
    killer.lastChatAt = 0;
    // Writing into the chat needs a signed-in account at the minimum level —
    // see `chatDenial`. This body has one; it just has to have the level too.
    killer.level = Math.max(killer.level ?? 1, K.CHAT_MIN_LEVEL);
    arena.onChat(killer, { m: 'gg wp' });
    const [e] = recent({ cat: 'chat', limit: 1 });
    return e?.msg === 'gg wp' && e.player === 'Shooter' && e.room === arena.code;
  })());

  check('a spawn and a shot are trace, not noise', (() => {
    log.clear();
    log.verbose.trace = false;
    arena.respawn(victim);
    const quiet = recent({ cat: 'combat' }).length;
    log.verbose.trace = true;
    arena.respawn(victim);
    const loud = recent({ cat: 'combat' }).length;
    log.verbose.trace = false;
    info(`${quiet} line(s) with the trace off, ${loud} with it on`);
    return quiet === 0 && loud === 1;
  })());

  suite('Logs — the verbose trace');

  log.clear();
  check('trace writes nothing while it is off', (() => {
    log.verbose.trace = false;
    combat.trace('fired', { weapon: 'ak' });
    return recent({ limit: 5 }).length === 0;
  })());

  check('…and everything while it is on', (() => {
    log.verbose.trace = true;
    combat.trace('fired', { weapon: 'ak' });
    const [e] = recent({ limit: 1 });
    log.verbose.trace = false;
    return e?.level === 'debug' && e.fields.weapon === 'ak';
  })());

  suite('Logs — the copy on disk');

  const dir = mkdtempSync(join(tmpdir(), 'og-logs-'));
  const sink = new LogSink({ dir, maxFileMb: 1, keepDays: 14, maxTotalMb: 8 });

  check('nothing is written until it is switched on', (() => {
    sink.write({ id: 1, msg: 'before' });
    return sink.list().length === 0 && sink.queue.length === 0;
  })());

  let wrote = false;
  check('switching it on writes one JSON record per line', await (async () => {
    sink.enable();
    sink.write({ id: 2, at: Date.now(), level: 'info', msg: 'after', player: 'gab' });
    sink.write({ id: 3, at: Date.now(), level: 'warn', msg: 'second' });
    await sleep(400);
    const files = sink.list();
    if (!files.length) return false;
    const lines = readFileSync(join(dir, files[0].name), 'utf8').trim().split('\n');
    wrote = lines.length === 2;
    const first = JSON.parse(lines[0]);
    info(`${files[0].name} — ${lines.length} line(s), ${files[0].bytes} bytes`);
    return wrote && first.msg === 'after' && first.player === 'gab' && !JSON.parse(lines[0]).before;
  })(), 'rolled by day, appended to');

  check('a full file rolls to the next part rather than growing forever', await (async () => {
    // A megabyte of records, which is the cap this sink was built with.
    for (let i = 0; i < 3000; i++) {
      sink.write({ id: i, at: Date.now(), level: 'info', msg: 'x'.repeat(400) });
      if (i % 500 === 0) { sink._flush(); }
    }
    sink._flush();
    await sleep(200);
    const files = sink.list();
    info(files.map((f) => `${f.name} ${Math.round(f.bytes / 1024)}KB`).join(' · '));
    return files.length >= 2 && files.every((f) => f.bytes <= 1.2 * 1048576);
  })(), 'the size cap is a real cap');

  check('the whole directory is held under its total', (() => {
    const before = sink.list().reduce((n, f) => n + f.bytes, 0);
    sink.maxTotalMb = 1;
    sink.sweep();
    const after = sink.list().reduce((n, f) => n + f.bytes, 0);
    info(`${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB`);
    return after < before;
  })());

  check('a name from a query string cannot walk out of the directory', (() => {
    writeFileSync(join(dir, '..', 'og-not-mine.txt'), 'secret');
    const refused = ['../.env', '/etc/passwd', 'og-2026-01-01.log/../../.env', 'notes.txt', '', null]
      .every((name) => sink.resolve(name) === null);
    rmSync(join(dir, '..', 'og-not-mine.txt'), { force: true });
    const real = sink.list()[0]?.name;
    return refused && (!real || sink.resolve(real) !== null);
  })(), 'only files this sink could have written resolve at all');

  check('purge leaves the file being written and takes the rest', (() => {
    const before = sink.list().length;
    const out = sink.purge();
    const after = sink.list();
    info(`${before} → ${after.length} after deleting ${out.removed}`);
    return after.length <= 1 && (after.length === 0 || after[0].current);
  })());

  check('a broken disk switches the sink off instead of taking the server with it', (() => {
    sink._fail(new Error('ENOSPC'));
    let threw = false;
    try { sink.write({ id: 9, msg: 'after the failure' }); } catch { threw = true; }
    const state = sink.state();
    return !threw && state.enabled === false && state.lastError === 'ENOSPC';
  })());

  sink.disable();
  rmSync(dir, { recursive: true, force: true });

  suite('Logs — the switches are remembered');

  check('the disk copy and the trace survive a restart', (() => {
    const store = db.settings;
    log.updateStored(store, { toDisk: false, trace: true, keepDays: 3 });
    const saved = store.get('logs', null);
    // What is stored is what was *asked for*: a disk that refused the write
    // must not quietly turn the operator's choice off for next time as well.
    const ok = saved.trace === true && saved.toDisk === false && saved.keepDays === 3;
    log.verbose.trace = false;
    const applied = log.applyStored(store);
    const back = log.verbose.trace === true;
    log.updateStored(store, { trace: false });
    info(`stored ${JSON.stringify(saved)}`);
    return ok && back && applied.trace === true;
  })());

  check('and the panel can read both back in one shape', (() => {
    const state = log.settingsState();
    return typeof state.trace === 'boolean' && typeof state.disk.enabled === 'boolean'
      && typeof state.disk.dir === 'string' && Array.isArray(log.sink.list());
  })());

  check('a settings value that was hand-edited to nonsense does not throw', (() => {
    db.db.prepare('INSERT INTO settings (key, value, at) VALUES (?,?,?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('junk', '{not json', 0);
    return db.settings.get('junk', 'fallback') === 'fallback'
      && typeof db.settings.all() === 'object';
  })());

  log.clear();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
