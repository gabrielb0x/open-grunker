/**
 * Open Grunker — deterministic shot spread (shared client/server).
 *
 * Both sides derive the exact same pellet directions from (shooterId, shotSeq),
 * so the tracer the shooter sees is the ray the server actually tests. No trust
 * is placed in the client for spread, and no correction pop is ever visible.
 */

/** mulberry32 — small, fast, deterministic across engines. */
export function rng32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed for one shot. */
export const shotSeed = (playerId, shotSeq) =>
  (Math.imul(playerId | 0, 0x9e3779b1) ^ Math.imul(shotSeq | 0, 0x85ebca6b)) >>> 0;

/**
 * Directions for every pellet of one shot.
 * @param {number} yaw    view yaw (radians)
 * @param {number} pitch  view pitch (radians)
 * @param {number} spread cone half-angle (radians)
 * @param {number} seed   from shotSeed()
 * @param {number} pellets
 * @returns {Array<{x:number,y:number,z:number}>} unit vectors
 */
export function shotDirections(yaw, pitch, spread, seed, pellets = 1) {
  if (pellets > 1) return pelletDirections(yaw, pitch, spread, seed, pellets);
  const rand = rng32(seed);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);

  // Forward, plus a right/up basis to offset within the cone.
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  const rx = cy, ry = 0, rz = -sy;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;

  const out = [];
  for (let i = 0; i < pellets; i++) {
    // Gaussian-ish cone: two uniform samples averaged pull the density toward
    // the middle, so most rounds land near point of aim and the cone edge is a
    // tail rather than a wall. Reads much closer to a real weapon than a disc.
    const ang = rand() * Math.PI * 2;
    const rad = ((rand() + rand()) * 0.5) ** 1.35 * spread * 1.9;
    const ox = Math.cos(ang) * rad, oy = Math.sin(ang) * rad;
    let dx = fx + rx * ox + ux * oy;
    let dy = fy + ry * ox + uy * oy;
    let dz = fz + rz * ox + uz * oy;
    const len = Math.hypot(dx, dy, dz) || 1;
    out.push({ x: dx / len, y: dy / len, z: dz / len });
  }
  return out;
}

/**
 * Pellet spread pattern for a shotgun: one round straight down the middle and
 * the rest on a jittered ring, which is far more predictable — and far more
 * satisfying — than nine independent random draws.
 */
export function pelletDirections(yaw, pitch, spread, seed, pellets) {
  const rand = rng32(seed);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  const rx = cy, ry = 0, rz = -sy;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;

  const out = [];
  const base = rand() * Math.PI * 2;
  for (let i = 0; i < pellets; i++) {
    let ox = 0, oy = 0;
    if (i > 0) {
      const ring = i <= 4 ? 0.55 : 1.0;
      const ang = base + (i / pellets) * Math.PI * 2 + (rand() - 0.5) * 0.6;
      const rad = spread * ring * (0.75 + rand() * 0.45);
      ox = Math.cos(ang) * rad;
      oy = Math.sin(ang) * rad;
    } else {
      ox = (rand() - 0.5) * spread * 0.16;
      oy = (rand() - 0.5) * spread * 0.16;
    }
    let dx = fx + rx * ox + ux * oy;
    let dy = fy + ry * ox + uy * oy;
    let dz = fz + rz * ox + uz * oy;
    const len = Math.hypot(dx, dy, dz) || 1;
    out.push({ x: dx / len, y: dy / len, z: dz / len });
  }
  return out;
}
