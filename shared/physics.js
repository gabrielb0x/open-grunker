/**
 * Open Grunker — collision world (shared client/server).
 *
 * Everything solid in a map is an AABB, so the world is a flat array of
 * min/max triples plus a uniform grid for broad-phase queries. The same code
 * runs in Node and in the browser, which is what lets client prediction and
 * server authority agree.
 */

const CELL = 8;

export class World {
  /** @param {object} map a map object from shared/maps.js */
  constructor(map) {
    this.map = map;
    const solids = map.solids ?? map.boxes.filter((b) => !b.decor);

    const n = solids.length;
    this.count = n;
    this.min = new Float64Array(n * 3);
    this.max = new Float64Array(n * 3);
    this.meta = solids;

    for (let i = 0; i < n; i++) {
      const b = solids[i];
      const hw = b.w / 2, hd = b.d / 2;
      this.min[i * 3] = b.x - hw; this.min[i * 3 + 1] = b.y; this.min[i * 3 + 2] = b.z - hd;
      this.max[i * 3] = b.x + hw; this.max[i * 3 + 1] = b.y + b.h; this.max[i * 3 + 2] = b.z + hd;
    }

    // Ground plane: an implicit floor at y = 0 spanning the whole arena.
    this.floorY = 0;

    // Uniform grid over X/Z (Y is rarely the discriminating axis in an arena).
    const half = (map.ground?.size ?? map.size ?? 128) / 2 + 16;
    this.origin = -half;
    this.dim = Math.max(1, Math.ceil((half * 2) / CELL));
    this.grid = Array.from({ length: this.dim * this.dim }, () => []);
    for (let i = 0; i < n; i++) {
      const cx0 = this._cell(this.min[i * 3]), cx1 = this._cell(this.max[i * 3]);
      const cz0 = this._cell(this.min[i * 3 + 2]), cz1 = this._cell(this.max[i * 3 + 2]);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) this.grid[cz * this.dim + cx].push(i);
      }
    }
    this._scratch = [];
    this._mark = new Int32Array(n).fill(-1);
    this._stamp = 0;
  }

  _cell(v) {
    const c = Math.floor((v - this.origin) / CELL);
    return c < 0 ? 0 : c >= this.dim ? this.dim - 1 : c;
  }

  /** Indices of boxes whose AABB overlaps the query box. Reuses one array. */
  query(minX, minY, minZ, maxX, maxY, maxZ) {
    const out = this._scratch;
    out.length = 0;
    const stamp = ++this._stamp;
    const cx0 = this._cell(minX), cx1 = this._cell(maxX);
    const cz0 = this._cell(minZ), cz1 = this._cell(maxZ);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.grid[cz * this.dim + cx];
        for (let k = 0; k < cell.length; k++) {
          const i = cell[k];
          if (this._mark[i] === stamp) continue;
          this._mark[i] = stamp;
          const j = i * 3;
          if (this.max[j] <= minX || this.min[j] >= maxX) continue;
          if (this.max[j + 1] <= minY || this.min[j + 1] >= maxY) continue;
          if (this.max[j + 2] <= minZ || this.min[j + 2] >= maxZ) continue;
          out.push(i);
        }
      }
    }
    return out;
  }

  /** True if the axis-aligned box overlaps any solid. */
  overlapsAny(minX, minY, minZ, maxX, maxY, maxZ) {
    return this.query(minX, minY, minZ, maxX, maxY, maxZ).length > 0;
  }

  /**
   * Ray vs. world.
   *
   * Walks the broad-phase grid with a 2-D DDA and only slab-tests the boxes in
   * the cells the ray actually crosses, stopping as soon as nothing further out
   * could beat the closest hit so far. On a detailed map that is the difference
   * between touching every solid on every visibility check and touching a
   * handful — and visibility checks run for every enemy, several times a second.
   *
   * @returns {{dist:number, nx:number, ny:number, nz:number, index:number, mat:string|null}|null}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = maxDist, bnx = 0, bny = 0, bnz = 0, bi = -1;

    // Implicit floor
    if (dy < -1e-6 && oy > this.floorY) {
      const t = (this.floorY - oy) / dy;
      if (t >= 0 && t < best) { best = t; bnx = 0; bny = 1; bnz = 0; bi = -2; }
    }

    const invx = 1 / dx, invy = 1 / dy, invz = 1 / dz;
    const stamp = ++this._stamp;

    /** Slab-test one box, keeping it if it is the closest hit so far. */
    const test = (i) => {
      if (this._mark[i] === stamp) return;
      this._mark[i] = stamp;
      const j = i * 3;
      let t0 = 0, t1 = best, axis = -1, sign = 1;

      let ta = (this.min[j] - ox) * invx, tb = (this.max[j] - ox) * invx;
      let sg = -1;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; sg = 1; }
      if (ta > t0) { t0 = ta; axis = 0; sign = sg; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return;

      ta = (this.min[j + 1] - oy) * invy; tb = (this.max[j + 1] - oy) * invy; sg = -1;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; sg = 1; }
      if (ta > t0) { t0 = ta; axis = 1; sign = sg; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return;

      ta = (this.min[j + 2] - oz) * invz; tb = (this.max[j + 2] - oz) * invz; sg = -1;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; sg = 1; }
      if (ta > t0) { t0 = ta; axis = 2; sign = sg; }
      if (tb < t1) t1 = tb;
      if (t0 > t1 || t0 < 0) return;

      if (t0 < best) {
        best = t0; bi = i;
        bnx = axis === 0 ? sign : 0;
        bny = axis === 1 ? sign : 0;
        bnz = axis === 2 ? sign : 0;
      }
    };

    const span = this.dim * CELL;
    const inside = ox >= this.origin && ox <= this.origin + span
                && oz >= this.origin && oz <= this.origin + span;

    if (!inside) {
      // Outside the grid the DDA has no valid starting cell; the linear scan is
      // both correct and rare (only long shots fired from beyond the arena).
      for (let i = 0; i < this.count; i++) test(i);
    } else {
      let cx = this._cell(ox), cz = this._cell(oz);
      const stepX = dx > 1e-9 ? 1 : dx < -1e-9 ? -1 : 0;
      const stepZ = dz > 1e-9 ? 1 : dz < -1e-9 ? -1 : 0;
      const bx = this.origin + (cx + (stepX > 0 ? 1 : 0)) * CELL;
      const bz = this.origin + (cz + (stepZ > 0 ? 1 : 0)) * CELL;
      let tMaxX = stepX === 0 ? Infinity : (bx - ox) * invx;
      let tMaxZ = stepZ === 0 ? Infinity : (bz - oz) * invz;
      const tDeltaX = stepX === 0 ? Infinity : Math.abs(CELL * invx);
      const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(CELL * invz);

      for (let guard = 0; guard < 4096; guard++) {
        const cell = this.grid[cz * this.dim + cx];
        for (let k = 0; k < cell.length; k++) test(cell[k]);

        const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
        if (!(tNext < best) || tNext > maxDist) break;
        if (tMaxX < tMaxZ) { cx += stepX; tMaxX += tDeltaX; }
        else { cz += stepZ; tMaxZ += tDeltaZ; }
        if (cx < 0 || cx >= this.dim || cz < 0 || cz >= this.dim) break;
      }
    }

    if (bi === -1) return null;
    return {
      dist: best, nx: bnx, ny: bny, nz: bnz, index: bi,
      mat: bi >= 0 ? (this.meta[bi]?.mat ?? null) : (this.map?.ground?.mat ?? null),
    };
  }

  /** Convenience: is there a clear line between two points? */
  lineOfSight(ax, ay, az, bx, by, bz) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    dx /= len; dy /= len; dz /= len;
    const hit = this.raycast(ax, ay, az, dx, dy, dz, len - 0.05);
    return hit === null;
  }
}

/** Ray vs. a single AABB. Returns entry distance or -1. */
export function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, maxDist) {
  let t0 = 0, t1 = maxDist;
  const inv = [1 / dx, 1 / dy, 1 / dz];
  const o = [ox, oy, oz], mn = [minX, minY, minZ], mx = [maxX, maxY, maxZ];
  for (let a = 0; a < 3; a++) {
    let ta = (mn[a] - o[a]) * inv[a], tb = (mx[a] - o[a]) * inv[a];
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0 < 0 ? -1 : t0;
}
