/**
 * Open Grunker — bot AI.
 *
 * Bots exist so a freshly deployed server is never an empty lobby. They drive
 * the exact same movement step and the exact same shoot path as human players —
 * no special cases, no server-side aimbot shortcuts — they just synthesise a
 * key bitmask and a view angle every tick.
 */
import * as K from '../../shared/constants.js';
import { KEY, eyeY } from '../../shared/movement.js';
import { shotInterval } from '../../shared/weapons.js';

const NAMES = [
  'Vex', 'Nyx', 'Rook', 'Slate', 'Onyx', 'Havoc', 'Ember', 'Quill', 'Zeph', 'Kilo',
  'Recoil', 'Static', 'Bandit', 'Crate', 'Pixel', 'Volt', 'Dusty', 'Mango', 'Nine',
  'Frost', 'Tango', 'Whisky', 'Juno', 'Cobalt', 'Sable', 'Wren', 'Bolt', 'Mesa',
];
const CLASSES = ['triggerman', 'runngun', 'hunter', 'spraynpray', 'vince', 'marksman', 'bulldog', 'detective'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);

/** Shortest signed angular difference, wrapped to [-PI, PI]. */
function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class BotBrain {
  static pickName(taken = new Set()) {
    const free = NAMES.filter((n) => !taken.has(n));
    const pool = free.length ? free : NAMES;
    const base = pool[Math.floor(Math.random() * pool.length)];
    return taken.has(base) ? `${base}${Math.floor(Math.random() * 90 + 10)}` : base;
  }

  static pickClass() {
    return CLASSES[Math.floor(Math.random() * CLASSES.length)];
  }

  constructor(player) {
    this.p = player;
    // Per-bot personality so a lobby doesn't feel like one AI copy-pasted.
    this.skill = rand(0.35, 0.85);
    this.aimSpeed = 5 + this.skill * 9;              // rad/s of turn rate
    this.aimError = (1 - this.skill) * 0.075 + 0.006;
    this.reaction = rand(0.12, 0.34) * (1.4 - this.skill);
    this.preferredRange = rand(12, 34);

    this.target = null;
    this.seenAt = 0;
    this.retargetIn = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeIn = 0;
    this.jumpIn = rand(0.5, 3);
    this.waypoint = null;
    this.stuckCheckIn = 0.6;
    this.lastPos = { x: 0, z: 0 };
    this.aimNoise = { yaw: 0, pitch: 0 };
    this.noiseIn = 0;
    this.fireHeldUntil = 0;
  }

  /** Called once per tick before the movement step. */
  think(room, dt) {
    const p = this.p;
    if (!p.alive) {
      p.botInput = { keys: 0, yaw: p.state.yaw, pitch: 0 };
      return;
    }

    this.retargetIn -= dt;
    this.strafeIn -= dt;
    this.jumpIn -= dt;
    this.noiseIn -= dt;
    this.stuckCheckIn -= dt;

    if (this.retargetIn <= 0) {
      this.retargetIn = 0.35;
      this.acquire(room);
    }
    if (this.noiseIn <= 0) {
      this.noiseIn = rand(0.25, 0.6);
      this.aimNoise.yaw = rand(-this.aimError, this.aimError);
      this.aimNoise.pitch = rand(-this.aimError, this.aimError) * 0.6;
    }
    if (this.strafeIn <= 0) {
      this.strafeIn = rand(0.5, 1.4);
      this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    }

    let keys = 0;
    let wantYaw = p.state.yaw;
    let wantPitch = p.state.pitch;

    const target = this.target && this.target.alive ? this.target : null;
    if (target) {
      const dx = target.state.x - p.state.x;
      const dz = target.state.z - p.state.z;
      const dy = (target.state.y + target.state.height * 0.62) - eyeY(p.state);
      const flat = Math.hypot(dx, dz) || 0.001;
      const dist = Math.hypot(flat, dy);

      wantYaw = Math.atan2(-dx, -dz) + this.aimNoise.yaw;
      wantPitch = Math.atan2(dy, flat) + this.aimNoise.pitch;

      // Close the gap, or back off if the bot is inside its preferred range.
      if (dist > this.preferredRange * 1.25) keys |= KEY.FWD;
      else if (dist < this.preferredRange * 0.55) keys |= KEY.BACK;
      keys |= this.strafeDir > 0 ? KEY.RIGHT : KEY.LEFT;

      const aimOff = Math.abs(angleDelta(wantYaw, p.state.yaw)) + Math.abs(wantPitch - p.state.pitch);
      const ready = room.now - this.seenAt > this.reaction;
      const w = p.weapon;

      if (ready && aimOff < 0.09 + (1 - this.skill) * 0.06 && dist < 120 && !w.reloading) {
        if (w.ammo > 0) {
          const interval = shotInterval(w.def);
          if (room.now - w.lastShot >= interval) {
            room.onShoot(p, { y: wantYaw, p: wantPitch, a: this.skill > 0.6 && dist > 18 });
          }
          if (w.def.auto) keys |= KEY.FIRE;
        } else if (w.reserve > 0) {
          room.onReload(p);
        }
      }
      if (dist < K.MELEE_RANGE * 0.85 && p.slot !== 2 && this.skill > 0.5) {
        room.onMelee(p);
      }
      // Slide-hop toward the fight now and then.
      if (this.jumpIn <= 0) {
        this.jumpIn = rand(0.7, 2.6);
        keys |= KEY.JUMP;
      }
    } else {
      // Patrol
      if (!this.waypoint || this.distTo(this.waypoint) < 3) this.pickWaypoint(room);
      const dx = this.waypoint.x - p.state.x;
      const dz = this.waypoint.z - p.state.z;
      wantYaw = Math.atan2(-dx, -dz);
      wantPitch = 0;
      keys |= KEY.FWD;
      if (this.jumpIn <= 0) {
        this.jumpIn = rand(1.5, 5);
        keys |= KEY.JUMP;
      }
    }

    // Unstick: if we've barely moved since the last check, jump and re-route.
    if (this.stuckCheckIn <= 0) {
      this.stuckCheckIn = 0.7;
      const moved = Math.hypot(p.state.x - this.lastPos.x, p.state.z - this.lastPos.z);
      if (moved < 0.8) {
        keys |= KEY.JUMP;
        this.strafeDir *= -1;
        this.pickWaypoint(room);
      }
      this.lastPos.x = p.state.x;
      this.lastPos.z = p.state.z;
    }

    // Turn toward the desired angle at a bounded rate.
    const maxTurn = this.aimSpeed * dt;
    const dyaw = clamp(angleDelta(wantYaw, p.state.yaw), -maxTurn, maxTurn);
    const dpitch = clamp(wantPitch - p.state.pitch, -maxTurn, maxTurn);

    p.botInput = {
      keys,
      yaw: p.state.yaw + dyaw,
      pitch: clamp(p.state.pitch + dpitch, -1.4, 1.4),
    };
  }

  distTo(pt) {
    return Math.hypot(pt.x - this.p.state.x, pt.z - this.p.state.z);
  }

  pickWaypoint(room) {
    // In an objective mode, head for a point the team does not already own —
    // otherwise a room of bots would never contest anything.
    const objectives = room.objectives ?? [];
    if (objectives.length && Math.random() < 0.7) {
      const wanted = objectives.filter((o) => o.owner !== this.p.team);
      const pool = wanted.length ? wanted : objectives;
      const o = pool[Math.floor(Math.random() * pool.length)];
      this.waypoint = { x: o.x + rand(-2.5, 2.5), z: o.z + rand(-2.5, 2.5) };
      return;
    }
    const pts = room.map.spawns.ffa;
    const [x, , z] = pts[Math.floor(Math.random() * pts.length)];
    this.waypoint = { x: x + rand(-4, 4), z: z + rand(-4, 4) };
  }

  /** Nearest visible enemy inside the bot's awareness range. */
  acquire(room) {
    const p = this.p;
    const ex = p.state.x, ey = eyeY(p.state), ez = p.state.z;
    let best = null, bestDist = 95;

    for (const other of room.players.values()) {
      if (other === p || !other.alive) continue;
      if (room.mode.teams && other.team === p.team) continue;
      const d = Math.hypot(other.state.x - ex, other.state.y - p.state.y, other.state.z - ez);
      if (d >= bestDist) continue;
      const tx = other.state.x, ty = other.state.y + other.state.height * 0.6, tz = other.state.z;
      if (!room.world.lineOfSight(ex, ey, ez, tx, ty, tz)) continue;
      best = other;
      bestDist = d;
    }

    if (best && best !== this.target) this.seenAt = room.now;
    if (!best) this.target = null;
    else this.target = best;
  }
}

export default BotBrain;
