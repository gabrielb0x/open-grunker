/**
 * Open Grunker — god mode.
 *
 * The one power in the game that takes a player out of the rules entirely, so
 * the tests are mostly about who may have it and what still cannot touch them.
 */
import { Room } from '../server/game/room.js';
import { Player } from '../server/game/player.js';
import * as K from '../shared/constants.js';
import { KEY } from '../shared/movement.js';
import { suite, check, info } from './harness.mjs';

function makeRoom() {
  const room = new Room({ id: 'test-god', mapId: 'crossfire', modeId: 'ffa' });
  const out = [];
  room.broadcast = (m) => out.push(m);
  room.broadcastNear = (m) => out.push(m);
  room.sendTo = (p, m) => out.push({ ...m, _to: p.id });
  room.messages = out;
  return room;
}

function seat(room, name, role) {
  const p = new Player({ ws: null, name, userId: `u-${name}`, classId: 'triggerman', role });
  room.add(p);
  room.respawn(p);
  return p;
}

const last = (room, op) => [...room.messages].reverse().find((m) => m.o === op);

export default function run() {
  suite('God mode — who may have it');

  {
    const room = makeRoom();
    const admin = seat(room, 'Admin', 'admin');
    const mod = seat(room, 'Mod', 'mod');
    const player = seat(room, 'Player', 'player');

    check('an administrator can switch it on', (() => {
      room.onGodMode(admin, { v: 1 });
      const msg = last(room, K.S2C.GOD);
      return admin.god === true && msg?.on === true && msg?.allowed === true;
    })());

    check('a moderator cannot — the chat ban is where their powers stop', (() => {
      room.onGodMode(mod, { v: 1 });
      const msg = last(room, K.S2C.GOD);
      info(`mod.god=${mod.god} allowed=${msg?.allowed}`);
      return mod.god === false && msg?.allowed === false;
    })());

    check('an ordinary player cannot', (() => {
      room.onGodMode(player, { v: 1 });
      return player.god === false && last(room, K.S2C.GOD)?.allowed === false;
    })());

    check('an admin demoted mid-session loses it at the next press', (() => {
      admin.role = 'player';
      room.onGodMode(admin, { v: 1 });
      return admin.god === false;
    })());

    check('it is never persisted — a fresh connection starts mortal', (() => {
      const rejoin = new Player({ ws: null, name: 'Admin', userId: 'u-Admin', role: 'admin' });
      return rejoin.god === false;
    })());
  }

  suite('God mode — what cannot touch you');

  {
    const room = makeRoom();
    const admin = seat(room, 'Admin', 'admin');
    const shooter = seat(room, 'Shooter', 'player');
    admin.protectedUntil = -1;                       // past the spawn shield
    shooter.protectedUntil = -1;
    room.onGodMode(admin, { v: 1 });

    check('bullets do nothing', (() => {
      const before = admin.health;
      room.applyHit(shooter, admin, 90, true, { id: 'ar' }, null);
      info(`${before} → ${admin.health}`);
      return admin.health === before && admin.alive;
    })());

    check('a full-health hit does not kill either', (() => {
      const res = admin.applyDamage(K.MAX_HEALTH * 3, room.now, shooter.id);
      return res.damage === 0 && res.dead === false && admin.alive;
    })());

    check('a landing that would break both legs is survived', (() => {
      admin.state.landed = true;
      admin.state.fallSpeed = 90;
      room.postStep(admin);
      admin.state.landed = false;
      return admin.alive && admin.health === K.MAX_HEALTH;
    })());

    check('falling out of the world does not kill', (() => {
      admin.state.y = -200;
      room.postStep(admin);
      const alive = admin.alive;
      admin.state.y = 4;
      return alive;
    })());

    check('a nuke leaves them standing and does not credit a kill for them', (() => {
      room.nuke = { by: shooter.id, name: shooter.name, team: shooter.team, at: room.now };
      const killsBefore = shooter.score.kills;
      room.detonateNuke();
      info(`admin alive: ${admin.alive} · shooter kills ${killsBefore} → ${shooter.score.kills}`);
      return admin.alive && shooter.score.kills === killsBefore;
    })());

    check('and everybody else still dies to it', (() => {
      const victim = seat(room, 'Victim', 'player');
      victim.protectedUntil = -1;
      room.nuke = { by: shooter.id, name: shooter.name, team: shooter.team, at: room.now };
      room.detonateNuke();
      return !victim.alive;
    })());

    check('switching it off gives the body back to gravity', (() => {
      admin.role = 'admin';
      admin.lastGodAt = 0;
      admin.state.vy = 30;
      room.onGodMode(admin, { v: 0 });
      const hurt = admin.applyDamage(40, room.now, shooter.id);
      info(`vy ${admin.state.vy.toFixed(1)} · took ${hurt.damage}`);
      // The upward velocity from flying is dropped, so the first thing gravity
      // does is a fall rather than a launch.
      return admin.god === false && admin.state.vy <= 0 && hurt.damage === 40;
    })());
  }

  suite('God mode — flight is authoritative');

  {
    const room = makeRoom();
    const admin = seat(room, 'Pilot', 'admin');
    room.onGodMode(admin, { v: 1 });
    const y0 = admin.state.y;

    check('the room simulates the flight, not just the client', (() => {
      for (let t = 0; t < 90; t++) {
        admin.inputQueue.push({ seq: t + 1, keys: KEY.JUMP, yaw: 0, pitch: 0 });
        room.tick(K.TICK_DT);
      }
      info(`y ${y0.toFixed(1)} → ${admin.state.y.toFixed(1)}`);
      return admin.state.y > y0 + 4;
    })());
  }

  suite('God mode — nothing is waited on');

  {
    const room = makeRoom();
    const admin = seat(room, 'Spammer', 'admin');
    const mortal = seat(room, 'Patient', 'player');
    for (const p of [admin, mortal]) { p.setClass('rocketeer'); room.respawn(p); }
    room.onGodMode(admin, { v: 1 });

    /** As fast as a person clicks — fifteen presses spread over one second. */
    const spam = (p, presses = 15) => {
      const t0 = room.now;
      let out = 0;
      for (let i = 0; i < presses; i++) {
        const before = p.score.shotsFired;
        room.onShoot(p, { y: 0, p: 0, n: p.shotSeq + 1 });
        if (p.score.shotsFired > before) out++;
        room.now += 1 / presses;
      }
      room.now = t0;
      room.projectiles.length = 0;
      return out;
    };

    const godRockets = spam(admin);
    check('spamming the trigger puts fifteen rockets in the air in one second',
      godRockets === 15, `${godRockets} of 15 went out`);

    const mortalRockets = spam(mortal);
    check('a launcher outside god mode still fires once a second and a bit',
      mortalRockets === 1, `${mortalRockets} of 15 went out`);

    check('the bolt is not waited on either', (() => {
      admin.setClass('hunter');            // AWM: 0.9s of bolt after every round
      room.respawn(admin);
      room.onShoot(admin, { y: 0, p: 0, n: admin.shotSeq + 1 });
      const bolt = admin.weapon.pumpUntil - room.now;
      const before = admin.score.shotsFired;
      room.now += K.GOD_SHOT_INTERVAL;
      room.onShoot(admin, { y: 0, p: 0, n: admin.shotSeq + 1 });
      info(`${bolt.toFixed(2)}s of bolt, second round ${admin.score.shotsFired > before ? 'went out' : 'refused'}`);
      return bolt > 0.5 && admin.score.shotsFired === before + 1;
    })());

    check('and neither is the knife', (() => {
      admin.slot = 2;
      const knife = admin.weapons[2];
      knife.lastShot = -999;
      room.onMelee(admin);
      const first = knife.lastShot;
      room.now += K.GOD_SHOT_INTERVAL;
      room.onMelee(admin);
      info(`${K.MELEE_COOLDOWN}s cooldown, swung again after ${(room.now - first).toFixed(2)}s`);
      return knife.lastShot > first;
    })());

    // A floor, never a ceiling: the fastest weapon in the game already beats it
    // and must not be slowed down to it.
    check('a weapon quicker than the floor keeps its own rate', (() => {
      admin.setClass('detective');         // akimbo, 1250 rpm
      room.respawn(admin);
      const interval = 60 / admin.weapon.def.fireRate;
      info(`akimbo ${interval.toFixed(3)}s vs the ${K.GOD_SHOT_INTERVAL}s floor`);
      return interval < K.GOD_SHOT_INTERVAL;
    })());
  }

  suite('God mode — the magazine never empties');

  {
    const room = makeRoom();
    const admin = seat(room, 'Armourer', 'admin');
    const mortal = seat(room, 'Mortal', 'player');

    /** One trigger pull, with the rate limiter stepped past rather than around. */
    const fire = (p) => {
      p.weapon.lastShot = -99;
      p.weapon.pumpUntil = 0;
      room.onShoot(p, { y: p.state.yaw, p: p.state.pitch, n: p.shotSeq + 1 });
    };

    // Half a magazine down, and then the switch: the tool is no use starting
    // where the last firefight left it.
    admin.weapon.ammo = 3;
    admin.weapons[1].ammo = 1;
    room.onGodMode(admin, { v: 1 });

    check('turning it on fills every magazine, not just the one in hand',
      admin.weapons.filter((w) => !w.def.melee)
        .every((w) => w.ammo === w.def.magSize),
      admin.weapons.map((w) => `${w.def.id}:${w.ammo}`).join(' · '));

    check('and the client is told, so the counter is right before the first shot',
      last(room, K.S2C.AMMO)?.ammo === admin.weapon.def.magSize);

    check('a whole magazine goes out without spending a round', (() => {
      const mag = admin.weapon.def.magSize;
      for (let i = 0; i < mag + 5; i++) fire(admin);
      info(`${mag + 5} shots fired, ${admin.weapon.ammo}/${mag} left`);
      return admin.weapon.ammo === mag && admin.score.shotsFired === mag + 5;
    })());

    check('nothing ever goes dry, so there is no reload to sit through',
      !admin.weapon.reloading && !last(room, K.S2C.AMMO)?.dry);

    check('everybody else still pays for theirs', (() => {
      const before = mortal.weapon.ammo;
      fire(mortal);
      info(`${before} → ${mortal.weapon.ammo}`);
      return mortal.weapon.ammo === before - 1;
    })());

    check('switching it off starts the magazine counting again', (() => {
      admin.lastGodAt = 0;
      room.onGodMode(admin, { v: 0 });
      const before = admin.weapon.ammo;
      fire(admin);
      info(`${before} → ${admin.weapon.ammo}`);
      return admin.god === false && admin.weapon.ammo === before - 1;
    })());
  }
}
