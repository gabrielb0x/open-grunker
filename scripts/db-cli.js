#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Open Grunker — database maintenance CLI.
 *
 * Usage:  node scripts/db-cli.js <command> [args]
 *         npm run db:init | db:reset | db:stats | user:admin -- <name>
 */
import { rmSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import config from '../server/config.js';

const [, , cmd, ...args] = process.argv;

const usage = `
Open Grunker — database CLI

  node scripts/db-cli.js <command> [args]

Commands
  init                        create the database and schema (idempotent)
  stats                       show row counts and the top players
  users [limit]               list accounts
  admin <username>            grant the admin role
  mod <username>              grant the moderator role
  demote <username>           return an account to the player role
  ban <username> [days] [why] ban an account (omit days for permanent)
  unban <username>            lift a ban
  mute <username> [min] [why] ban an account from the chat (omit min for permanent)
  unmute <username>           lift a chat ban
  passwd <username> <new>     set a new password
  delete <username>           delete an account and everything attached to it
  prune                       drop expired sessions
  reset                       DESTROY the database and recreate it empty
`;

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(usage);
  process.exit(0);
}

async function confirm(question) {
  if (process.env.FORCE === '1' || args.includes('--yes')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// `reset` must delete the file before the schema is opened.
if (cmd === 'reset') {
  if (!(await confirm(`Delete ${config.dbPath} and every account in it?`))) {
    console.log('cancelled');
    process.exit(0);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = config.dbPath + suffix;
    if (existsSync(f)) { rmSync(f); console.log(`removed ${f}`); }
  }
}

const db = await import('../server/db/index.js');
const { users, stats, sessions, chatBans, summary, db: raw } = db;

const need = (i, what) => {
  if (!args[i]) { console.error(`error: missing <${what}>`); process.exit(1); }
  return args[i];
};

const findUser = (name) => {
  const u = users.byName(name);
  if (!u) { console.error(`error: no account named "${name}"`); process.exit(1); }
  return u;
};

switch (cmd) {
  case 'init':
  case 'reset': {
    const s = summary();
    console.log(`database ready at ${s.path}`);
    console.log(`  users ${s.users}  matches ${s.matches}  sessions ${s.sessions}`);
    break;
  }

  case 'stats': {
    const s = summary();
    console.log(`database   ${s.path}`);
    console.log(`accounts   ${s.users}`);
    console.log(`matches    ${s.matches}`);
    console.log(`sessions   ${s.sessions}`);
    console.log(`ip bans    ${s.ipBans}`);
    console.log(`chat bans  ${s.chatBans}`);
    const top = stats.leaderboard({ limit: 10 });
    if (top.length) {
      console.log('\ntop players by kills');
      console.log('  #  name              lvl   kills  deaths   K/D   wins');
      for (const r of top) {
        const kd = (r.kills / Math.max(1, r.deaths)).toFixed(2);
        console.log(`  ${String(r.rank).padStart(2)} ${r.username.padEnd(16)} ${String(r.level).padStart(4)}`
          + ` ${String(r.kills).padStart(7)} ${String(r.deaths).padStart(7)} ${kd.padStart(6)} ${String(r.wins).padStart(6)}`);
      }
    }
    break;
  }

  case 'users': {
    const limit = Number(args[0]) || 50;
    const rows = raw.prepare(
      'SELECT id, username, level, gr, verified, role, banned_until, created_at, last_login FROM users ORDER BY id LIMIT ?',
    ).all(limit);
    if (!rows.length) { console.log('no accounts yet'); break; }
    console.log('  id  username          lvl     gr  role    status   created');
    for (const u of rows) {
      const banned = u.banned_until === -1 ? 'perm'
        : u.banned_until > Date.now() / 1000 ? 'banned' : 'ok';
      const created = new Date(u.created_at * 1000).toISOString().slice(0, 10);
      console.log(`  ${String(u.id).padStart(3)} ${u.username.padEnd(16)} ${String(u.level).padStart(4)}`
        + ` ${String(u.gr).padStart(6)}  ${u.role.padEnd(7)} ${banned.padEnd(8)} ${created}`);
    }
    break;
  }

  case 'admin': {
    const u = findUser(need(0, 'username'));
    users.setRole(u.id, 'admin');
    console.log(`${u.username} is now an admin`);
    break;
  }

  case 'mod': {
    const u = findUser(need(0, 'username'));
    users.setRole(u.id, 'mod');
    console.log(`${u.username} is now a moderator — they can mute from the scoreboard`);
    break;
  }

  case 'demote': {
    const u = findUser(need(0, 'username'));
    users.setRole(u.id, 'player');
    console.log(`${u.username} is now a player`);
    break;
  }

  case 'ban': {
    const u = findUser(need(0, 'username'));
    const days = Number(args[1]);
    const reason = args.slice(Number.isFinite(days) && days > 0 ? 2 : 1).join(' ') || 'no reason given';
    const until = Number.isFinite(days) && days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : -1;
    users.ban(u.id, until, reason);
    sessions.destroyAllFor(u.id);
    console.log(`${u.username} banned ${until === -1 ? 'permanently' : `for ${days} day(s)`} — ${reason}`);
    break;
  }

  case 'unban': {
    const u = findUser(need(0, 'username'));
    users.ban(u.id, 0, null);
    console.log(`${u.username} unbanned`);
    break;
  }

  case 'mute': {
    const u = findUser(need(0, 'username'));
    const minutes = Number(args[1]);
    const timed = Number.isFinite(minutes) && minutes > 0;
    const reason = args.slice(timed ? 2 : 1).join(' ') || null;
    const row = chatBans.add({
      userId: u.id, minutes: timed ? minutes : 0, reason, actor: 'cli', username: u.username,
    });
    console.log(`${u.username} is banned from the chat ${timed ? `for ${minutes} minute(s)` : 'permanently'}`
      + `${reason ? ` — ${reason}` : ''}`);
    // The CLI is a separate process from the game server, which reads the row
    // at the handshake; the admin panel is the path that lands mid-match.
    console.log(`(takes effect on their next connection — use the admin panel to mute someone mid-match)`);
    if (!row) console.log('warning: nothing was written');
    break;
  }

  case 'unmute': {
    const u = findUser(need(0, 'username'));
    const lifted = chatBans.remove(u.id);
    console.log(lifted ? `${u.username} can chat again` : `${u.username} was not muted`);
    break;
  }

  case 'passwd': {
    const u = findUser(need(0, 'username'));
    const next = need(1, 'new password');
    const { hashPassword } = await import('../server/util/auth.js');
    users.setPassword(u.id, await hashPassword(next));
    sessions.destroyAllFor(u.id);
    console.log(`password changed for ${u.username}; existing sessions revoked`);
    break;
  }

  case 'delete': {
    const u = findUser(need(0, 'username'));
    if (!(await confirm(`Delete ${u.username} (#${u.id}) and all their stats?`))) {
      console.log('cancelled');
      break;
    }
    raw.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    console.log(`${u.username} deleted`);
    break;
  }

  case 'prune': {
    const n = sessions.prune();
    console.log(`pruned ${n} expired session(s)`);
    break;
  }

  default:
    console.error(`unknown command "${cmd}"`);
    console.log(usage);
    process.exit(1);
}

db.close();
