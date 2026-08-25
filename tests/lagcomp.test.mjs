/**
 * Lag-compensation precision.
 *
 * Models a real client end to end: a 30 Hz snapshot stream delayed by one-way
 * latency, interpolated INTERP_DELAY behind the server clock. Then compares
 * where the client would DRAW a strafing target against where the server
 * REWINDS it to when the shot lands.
 */
import { Room } from '../server/game/room.js';
import { Player } from '../server/game/player.js';
import * as K from '../shared/constants.js';
import { KEY } from '../shared/movement.js';
import { suite, check, info } from './harness.mjs';

export default function run() {
  for (const pingMs of [20, 60, 150]) {
    const room = new Room({ id: `test-lag-${pingMs}`, mapId: 'subzero', modeId: 'ffa' });
    room.broadcast = room.broadcastNear = () => {};
    const hits = [];
    room.sendTo = (p, m) => { if (m.o === K.S2C.HIT) hits.push(m); };

    const a = new Player({ name: 'Shooter' });
    const b = new Player({ name: 'Target' });
    room.players.set(a.id, a);
    room.players.set(b.id, b);
    a.spawnAt(-12, 0.2, -6, 0, 0);
    b.spawnAt(-12, 0.2, 6, 0, 0);
    a.protectedUntil = -1;
    b.protectedUntil = -1;
    a.rtt = pingMs / 1000;
    b.rtt = pingMs / 1000;

    const owd = a.rtt / 2;
    const stream = [];
    const inFlight = [];              // shots travelling from client to server
    let aSeq = 0, bSeq = 0, snapAcc = 0, shots = 0, landed = 0;
    const deltas = [];

    for (let tick = 0; tick < 60 * 14; tick++) {
      const strafing = Math.floor(room.now * 1.6) % 2 ? KEY.RIGHT : KEY.LEFT;
      a.inputQueue.push({ seq: ++aSeq, keys: 0, yaw: a.state.yaw, pitch: a.state.pitch });
      b.inputQueue.push({ seq: ++bSeq, keys: strafing, yaw: 0, pitch: 0 });
      room.tick(K.TICK_DT);

      snapAcc += K.TICK_DT;
      if (snapAcc >= K.SNAPSHOT_DT) {
        snapAcc -= K.SNAPSHOT_DT;
        stream.push({
          t: room.now * 1000, arriveAt: room.now + owd,
          x: b.state.x, y: b.state.y, z: b.state.z, h: b.state.height,
        });
        if (stream.length > 90) stream.shift();
      }

      if (tick > 120 && tick % 10 === 0) {
        const known = stream.filter((s) => s.arriveAt <= room.now);
        if (known.length < 2) continue;

        // The client's estimate of the server clock, then its render time.
        const newest = known[known.length - 1];
        const estServer = (newest.t / 1000 + (room.now - (newest.arriveAt - owd))) * 1000;
        const renderTime = estServer - K.INTERP_DELAY * 1000;

        let older = known[0], newer = newest;
        for (let i = known.length - 1; i >= 0; i--) {
          if (known[i].t <= renderTime) {
            older = known[i];
            newer = known[Math.min(i + 1, known.length - 1)];
            break;
          }
        }
        const span = newer.t - older.t;
        const k = span > 0 ? Math.max(0, Math.min(1, (renderTime - older.t) / span)) : 0;
        const lerp = (u, v) => u + (v - u) * k;
        const drawn = { x: lerp(older.x, newer.x), y: lerp(older.y, newer.y), z: lerp(older.z, newer.z), h: older.h };

        // Aim at what is drawn; the shot reaches the server one hop later.
        const eye = a.eye();
        const dx = drawn.x - eye.x, dy = (drawn.y + drawn.h * 0.5) - eye.y, dz = drawn.z - eye.z;
        const flat = Math.hypot(dx, dz);
        const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, flat);

        // The shot takes one hop to reach the server, exactly like a real one.
        inFlight.push({ at: room.now + owd, yaw, pitch, drawn });
      }

      // Deliver any shot whose packet has now arrived.
      while (inFlight.length && inFlight[0].at <= room.now) {
        const shot = inFlight.shift();
        const rewound = b.rewind(room.now - (a.rtt / 2 + K.INTERP_DELAY));
        deltas.push(Math.hypot(rewound.x - shot.drawn.x, rewound.z - shot.drawn.z));

        a.weapons[0].lastShot = -99;
        a.weapons[0].ammo = 30;
        a.state.yaw = shot.yaw;
        a.state.pitch = shot.pitch;
        a.state.onGround = true;
        hits.length = 0;
        room.onShoot(a, { y: shot.yaw, p: shot.pitch, a: 1, n: a.shotSeq + 1 });
        shots++;
        if (hits.length) landed++;
        // Heal rather than respawn: a respawn teleports the body and clears its
        // history, which is covered by spawn protection in a real match but
        // would otherwise pollute this measurement.
        if (!b.alive || b.health < 40) {
          b.alive = true;
          b.health = K.MAX_HEALTH;
          b.respawnAt = 0;
          b.protectedUntil = -1;
        }
      }
    }

    suite(`Lag compensation — ${pingMs} ms ping`);
    const avg = deltas.reduce((x, y) => x + y, 0) / Math.max(1, deltas.length);
    const max = Math.max(...deltas);
    info(`drawn-vs-rewound delta: avg ${(avg * 100).toFixed(1)} cm, max ${(max * 100).toFixed(1)} cm `
      + `(hitbox half-width 46 cm)`);
    check('what the client draws is what the server rewinds to', avg < 0.15,
      `${(avg * 100).toFixed(1)} cm average error`);
    check('shots land on a target strafing at full speed', landed / shots >= 0.95,
      `${landed}/${shots} hits (${Math.round((landed / shots) * 100)}%)`);
  }
}
