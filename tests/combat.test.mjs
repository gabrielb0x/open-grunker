/**
 * Server-side hit registration: damage zones, falloff, multi-pellet weapons,
 * projectiles, and the lag-compensated rewind.
 */
import { Room } from '../server/game/room.js';
import { Player } from '../server/game/player.js';
import { World } from '../shared/physics.js';
import * as K from '../shared/constants.js';
import { getClass, CLASS_IDS, drawStamp, loadoutFor, shotInterval } from '../shared/weapons.js';
import { suite, check, info } from './harness.mjs';

export default function run() {
  const room = new Room({ id: 'test-combat', mapId: 'subzero', modeId: 'ffa' });
  // Rooms open dormant. These bodies are placed straight into the map rather
  // than seated through `add`, so nothing here has woken it.
  room.wake();
  room.broadcast = room.broadcastNear = () => {};
  const events = [];
  room.sendTo = (p, m) => { if (m.o === K.S2C.HIT) events.push(m); };

  const a = new Player({ name: 'Shooter', classId: 'triggerman' });
  const b = new Player({ name: 'Target', classId: 'triggerman' });
  room.players.set(a.id, a);
  room.players.set(b.id, b);

  /**
   * Puts both bodies in clear air a fixed distance apart, history filled.
   *
   * The altitude has to clear the map's invisible boundary, not just its
   * geometry: these checks fire up to 130 units across a 76-unit map, so at
   * rooftop height the shot would be stopped by the edge of the world rather
   * than by falloff, and the test would be measuring the wrong thing.
   */
  const place = (gap, y = 60) => {
    a.spawnAt(0, y, 0, 0, room.now);
    b.spawnAt(0, y, gap, 0, room.now);
    a.protectedUntil = -1;
    b.protectedUntil = -1;
    a.state.onGround = true;
    b.state.onGround = true;              // no airborne spread penalty
    for (let i = 0; i < 40; i++) {
      room.now += K.TICK_DT;
      a.recordHistory(room.now);
      b.recordHistory(room.now);
    }
  };

  const aimAt = (heightFrac) => {
    const eye = a.eye();
    const dx = b.state.x - eye.x;
    const dy = (b.state.y + b.state.height * heightFrac) - eye.y;
    const dz = b.state.z - eye.z;
    const flat = Math.hypot(dx, dz);
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, flat) };
  };

  /**
   * Fires one round at `heightFrac` of the target's body.
   *
   * `a.ads` is set on the player rather than claimed in the packet, because the
   * room no longer reads `a` off a shoot frame at all — the sight picture is
   * whatever the ADS bit of the last simulated input said, which is the only
   * version of it that matches the speed the body moved at. Claiming it was
   * free scoped accuracy while hip-firing, and is now a flag; see
   * anticheat.test.mjs.
   */
  const fire = (heightFrac) => {
    events.length = 0;
    const w = a.weapons[a.slot];
    w.lastShot = -99;
    w.pumpUntil = 0;
    w.ammo = w.def.magSize;
    const aim = aimAt(heightFrac);
    a.state.yaw = aim.yaw;
    a.state.pitch = aim.pitch;
    a.state.onGround = true;
    a.ads = true;
    room.onShoot(a, { y: aim.yaw, p: aim.pitch, a: 1, n: a.shotSeq + 1 });
    return events[0] ?? null;
  };

  suite('Combat — damage zones');
  place(15);
  const ar = getClass('triggerman').primary;

  const body = fire(0.5);
  check('body shots register at full damage',
    body && !body.head && Math.abs(body.damage - ar.damage) <= 1,
    body ? `${body.damage} dmg (base ${ar.damage})` : 'no hit');

  place(15);
  const head = fire(0.94);
  check('headshots are detected and multiplied',
    head?.head && Math.abs(head.damage - ar.damage * ar.headMult) <= 2,
    head ? `${head.damage} dmg (expected ~${Math.round(ar.damage * ar.headMult)})` : 'no hit');

  place(15);
  const leg = fire(0.1);
  check('leg shots are reduced', leg && leg.damage < ar.damage,
    leg ? `${leg.damage} dmg` : 'no hit');

  suite('Combat — range falloff');
  const damageAt = (d) => { place(d); const h = fire(0.5); return h?.damage ?? 0; };
  const near = damageAt(20), mid = damageAt(80), far = damageAt(130);
  info(`20 u: ${near} dmg · 80 u: ${mid} dmg · 130 u: ${far} dmg`);
  check('damage decreases with distance', near > mid && mid > far && far > 0,
    `${near} > ${mid} > ${far}`);

  suite('Combat — weapon behaviour');
  place(8);
  a.setClass('bulldog');
  const shotgun = fire(0.5);
  check('shotgun pellets aggregate into one hit', shotgun && shotgun.damage > 13 * 2,
    shotgun ? `${shotgun.damage} dmg from up to 9 pellets` : 'no hit');

  place(60);
  a.setClass('hunter');
  const sniper = fire(0.5);
  check('a scoped sniper body shot is lethal', sniper?.kill,
    sniper ? `${sniper.damage} dmg, kill=${sniper.kill}` : 'no hit');

  place(30);
  a.setClass('rocketeer');
  const before = room.projectiles.length;
  fire(0.5);
  check('the rocket launcher spawns a projectile instead of a hitscan',
    room.projectiles.length === before + 1, `${room.projectiles.length} in flight`);

  // Fly the rocket into the target and confirm splash damage plus knockback.
  b.health = K.MAX_HEALTH;
  const vyBefore = b.state.vy;
  for (let i = 0; i < 120 && room.projectiles.length; i++) room.stepProjectiles(K.TICK_DT);
  check('the rocket explodes, damages and launches the target',
    b.health < K.MAX_HEALTH && b.state.vy !== vyBefore,
    `target at ${Math.round(b.health)} hp, vy ${b.state.vy.toFixed(1)}`);

  check('an exploded rocket is gone from the world', (() => {
    // Not a formality: the client mirrors this list, and a projectile that
    // leaves the array without leaving the scene hangs its warhead at the
    // point of impact for the rest of the match.
    return room.projectiles.length === 0;
  })(), `${room.projectiles.length} left in flight`);

  check('a rocket that hits a wall still blows up whoever is standing at it', (() => {
    /*
     * The bug this covers: the burst point used to sit exactly on the surface
     * the rocket touched, so the line-of-sight test that decides who is in the
     * blast started *inside* that surface and reported everybody as covered. A
     * rocket into the wall a foot behind somebody did nothing at all.
     *
     * A wall of its own rather than a corner of the real map, so the geometry
     * under the check is the one sentence it is about: a solid at z = 0, both
     * players well clear of it, and the rocket arriving square on its face.
     */
    const realWorld = room.world;
    room.world = new World({
      size: 200,
      ground: { size: 200 },
      boxes: [{ x: 0, y: 0, z: 0, w: 40, h: 6, d: 1, c: 0x808080 }],
    });

    a.spawnAt(0, 0, 12, 0, room.now);          // looking down −z at the wall
    b.spawnAt(1.1, 0, 1.4, 0, room.now);       // hard up against it, off to one side
    a.protectedUntil = -1;
    b.protectedUntil = -1;
    a.state.onGround = b.state.onGround = true;
    b.health = K.MAX_HEALTH;
    room.projectiles.length = 0;

    const eye = a.eye();
    room.spawnProjectile(a, getClass('rocketeer').primary, eye, 0, -0.06, 3);
    for (let i = 0; i < 200 && room.projectiles.length; i++) room.stepProjectiles(K.TICK_DT);
    room.world = realWorld;
    info(`wall burst a metre away · target ${Math.round(b.health)} hp`);
    // It used to be exactly zero damage; anything like a real blast is the fix.
    return b.health < K.MAX_HEALTH * 0.15;
  })());

  check('…and it lifts the player who fired it — the rocket jump', (() => {
    /*
     * Same bug, other half. Every paved surface in these maps is a box rather
     * than the implicit floor plane, so firing at your own feet detonated on
     * the top face of one — and the trace back up to your own chest started
     * inside it. The blast that is supposed to launch you reached nobody at
     * all, including you.
     */
    const realWorld = room.world;
    room.world = new World({
      size: 200,
      ground: { size: 200 },
      boxes: [{ x: 0, y: -2, z: 0, w: 60, h: 2, d: 60, c: 0x808080 }],
    });

    a.spawnAt(0, 0, 0, 0, room.now);
    a.protectedUntil = -1;
    a.state.onGround = true;
    room.players.delete(b.id);
    room.projectiles.length = 0;

    const eye = a.eye();
    room.spawnProjectile(a, getClass('rocketeer').primary, eye, 0, -1.5, 2);
    for (let i = 0; i < 120 && room.projectiles.length; i++) room.stepProjectiles(K.TICK_DT);
    room.players.set(b.id, b);
    room.world = realWorld;
    info(`vy ${a.state.vy.toFixed(1)} u/s · ${Math.round(a.health)} hp left`);
    // Off the ground with real height in it, and survivable at full health.
    return a.state.vy > 6 && !a.state.onGround && a.health > K.MAX_HEALTH * 0.4;
  })());

  check('the blast reaches across a room and a direct hit is lethal', (() => {
    // The Rocketeer fires once every second or so; a splash that only counted
    // inside three metres made a near miss worth nothing at all.
    const rpg = getClass('rocketeer').primary;
    const sp = rpg.splash;
    // Damage at the very edge of the radius, and at the centre.
    const edge = sp.minDamage;
    info(`${sp.radius}u radius · ${sp.maxDamage} at the centre, ${edge} at the rim`
      + ` · self ${Math.round(sp.maxDamage * sp.selfMult)} · ${rpg.reloadTime}s reload`);
    return sp.radius >= 7 && sp.maxDamage >= K.MAX_HEALTH && edge >= 30
      // A rocket jump has to stay a move rather than a wager: survivable at
      // full health with room to spare.
      && sp.maxDamage * sp.selfMult < K.MAX_HEALTH * 0.5
      && rpg.reloadTime <= 1.2;
  })());

  suite('Combat — bringing a weapon up');

  {
    /*
     * A swap is recorded as a shot a moment ago, so what stands between a
     * weapon coming up and its first round is the weapon's own fire interval.
     * That is invisible on anything quick and was a second and a third on the
     * launcher. `drawTime` caps it; nothing without one may have moved.
     */
    const firstShotAt = (w, grace, tolerance) =>
      drawStamp(w, 0, grace) + shotInterval(w) * tolerance;

    const rpg = loadoutFor('rocketeer')[0];
    check('the launcher fires about a quarter of a second after it comes up',
      Math.abs(firstShotAt(rpg, 0.1, 1) - 0.25) < 0.001,
      `${firstShotAt(rpg, 0.1, 1).toFixed(3)}s, down from ${(shotInterval(rpg) - 0.1).toFixed(3)}s`);

    check('and the room takes it sooner than the client sends it, as it does for every shot',
      firstShotAt(rpg, 0.15, 0.9) < firstShotAt(rpg, 0.1, 1),
      `room ${firstShotAt(rpg, 0.15, 0.9).toFixed(3)}s · client ${firstShotAt(rpg, 0.1, 1).toFixed(3)}s`);

    check('no weapon that sets no draw time changed at all', (() => {
      const moved = [];
      for (const classId of CLASS_IDS) {
        for (const w of loadoutFor(classId)) {
          if (w.melee || w.drawTime !== undefined) continue;
          // What the line used to be, spelled out: `now - 0.1`.
          if (Math.abs(drawStamp(w, 0, 0.1) - -0.1) > 1e-9) moved.push(w.id);
        }
      }
      info(moved.length ? moved.join(' · ') : 'every one still opens on `now - 0.1`');
      return moved.length === 0;
    })());

    check('the room wires it to the actual swap', (() => {
      const p = new Player({ name: 'Drawer', classId: 'rocketeer' });
      room.players.set(p.id, p);
      p.spawnAt(0, 60, 0, 0, room.now);
      p.protectedUntil = -1;
      room.onSwitch(p, { s: 1 });
      room.onSwitch(p, { s: 0 });

      const t0 = room.now;
      let waited = null;
      for (let i = 0; i < 400 && waited === null; i++) {
        const fired = p.score.shotsFired;
        room.onShoot(p, { y: 0, p: 0, n: p.shotSeq + 1 });
        if (p.score.shotsFired > fired) waited = room.now - t0;
        else room.now += 0.005;
      }
      room.now = t0;
      room.players.delete(p.id);
      room.projectiles.length = 0;
      info(`${waited === null ? 'never' : waited.toFixed(3) + 's'} after the swap`);
      // The room's 10% tolerance puts it ahead of the client's quarter second.
      return waited !== null && waited > 0.1 && waited < 0.25;
    })());
  }

  suite('Combat — lag compensation');
  a.setClass('triggerman');
  place(15);
  const aim = aimAt(0.5);
  // Teleport the target away *after* its history was recorded. The rewind must
  // still see it where the shooter did.
  b.state.x = 40;
  b.state.z = 40;
  events.length = 0;
  a.weapons[0].lastShot = -99;
  a.state.yaw = aim.yaw;
  a.state.pitch = aim.pitch;
  room.onShoot(a, { y: aim.yaw, p: aim.pitch, a: 1, n: a.shotSeq + 1 });
  check('rewound hitboxes still register', events.length > 0,
    events[0] ? `${events[0].damage} dmg against a target that already moved 35 u away` : 'no hit');

  suite('Combat — unlimited ammo');
  a.setClass('hunter');                                  // 5-round magazine
  a.spawnAt(0, 60, 0, 0, room.now);
  a.protectedUntil = -1;
  const w = a.weapons[0];
  check('every weapon starts with an unlimited reserve', w.reserve === -1,
    `${w.def.name}: ${w.ammo} in the magazine, reserve ${w.reserve}`);

  // Empty the magazine and reload it twenty times over.
  let reloads = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    w.ammo = 0;
    w.reloading = false;
    room.onReload(a);
    if (!w.reloading) break;
    room.now = w.reloadEnd;
    room.tick(K.TICK_DT);
    if (w.ammo === w.def.magSize) reloads++;
  }
  check('reloading never runs the reserve down', reloads === 20 && w.reserve === -1,
    `${reloads}/20 full reloads, reserve still ${w.reserve}`);

  check('a dry magazine still reloads', (() => {
    w.ammo = 0; w.reloading = false;
    room.onReload(a);
    return w.reloading;
  })());
  a.setClass('triggerman');

  suite('Combat — walls block shots');
  a.setClass('triggerman');
  a.spawnAt(0, 0.2, -30, 0, room.now);
  b.spawnAt(0, 0.2, -12, 0, room.now);   // the north cabin sits between them
  a.protectedUntil = -1; b.protectedUntil = -1;
  a.state.onGround = true; b.state.onGround = true;
  for (let i = 0; i < 40; i++) { room.now += K.TICK_DT; a.recordHistory(room.now); b.recordHistory(room.now); }
  const blocked = fire(0.5);
  check('geometry between shooter and target stops the bullet', blocked === null,
    blocked ? `unexpectedly hit for ${blocked.damage}` : 'blocked by the cabin wall');
}
