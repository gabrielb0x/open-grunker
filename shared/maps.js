/**
 * Open Grunker — map definitions (shared client/server).
 *
 * Maps are pure data: every solid is an axis-aligned box, which keeps collision
 * cheap and, more importantly, keeps the client's predicted movement and the
 * server's authoritative movement bit-for-bit identical.
 *
 * Box convention: `x`/`z` are the CENTRE of the footprint, `y` is the BOTTOM of
 * the box, `w`/`h`/`d` are full extents. Slopes are built as short stairs so the
 * shared step-up rule handles them.
 *
 * Every box also carries a `mat` — its surface material. The renderer picks the
 * texture from it, bullets pick their impact particles and sound from it, and
 * the minimap picks how solid it draws. It is the single piece of data that
 * turns a pile of coloured boxes into a place.
 *
 * ── Three kinds of box ─────────────────────────────────────────────────────
 *
 *   solid          collides, renders, blocks bullets. The map itself.
 *   `decor: true`  renders only. Lawn trim, road paint, a parked car's roof
 *                  light, a window pane. Dressing that must never take a corner
 *                  off a gunfight or eat a bullet — and, just as importantly,
 *                  nothing a player would ever expect to walk into. Anything
 *                  that reads as a *mass* is solid, whatever it costs: a tree
 *                  canopy you could run through was the single loudest thing
 *                  wrong with these maps.
 *   `clip: true`   collides only. The invisible boundary of the playable area.
 *
 * That last one is the rule the whole art direction hangs off. A map is not
 * fenced in by a fourteen-metre concrete wall any more; it ends at a line the
 * player cannot cross and cannot see, with the town carrying on past it in
 * decor. You are standing in a place, not inside a box.
 */
import { SURFACE } from './constants.js';

const S = SURFACE;

/* ── Build helpers ───────────────────────────────────────────────────────── */

const B = (x, y, z, w, h, d, c, o = {}) => ({ x, y, z, w, h, d, c, ...o });

/** Renders, never collides. */
const D = (x, y, z, w, h, d, c, o = {}) => ({ x, y, z, w, h, d, c, decor: true, ...o });

/** Collides, never renders. */
const CLIP = (x, y, z, w, h, d) => ({ x, y, z, w, h, d, c: 0x000000, clip: true, mat: S.VOID });

/**
 * The invisible edge of the world.
 *
 * Tall enough that nobody rockets over it and thick enough that no amount of
 * clipping pushes a body through, and — because it is never drawn — the player
 * only ever meets it as "I cannot go further that way", not as a wall.
 */
function bounds(size, h = 30, t = 3) {
  const s = size / 2;
  return [
    CLIP(0, -1, -s - t / 2, size + t * 2, h, t),
    CLIP(0, -1, s + t / 2, size + t * 2, h, t),
    CLIP(-s - t / 2, -1, 0, t, h, size + t * 2),
    CLIP(s + t / 2, -1, 0, t, h, size + t * 2),
  ];
}

/** Wall running along X at a fixed Z, with optional gaps (doorways). */
function wallX(z, x1, x2, y, h, t, c, gaps = [], doorH = 2.6, mat = S.CONCRETE) {
  const out = [];
  const cuts = gaps.slice().sort((a, b) => a[0] - b[0]);
  let cursor = x1;
  for (const [gs, ge] of cuts) {
    if (gs > cursor) out.push(B((cursor + gs) / 2, y, z, gs - cursor, h, t, c, { mat }));
    if (h > doorH) out.push(B((gs + ge) / 2, y + doorH, z, ge - gs, h - doorH, t, c, { mat }));
    cursor = ge;
  }
  if (cursor < x2) out.push(B((cursor + x2) / 2, y, z, x2 - cursor, h, t, c, { mat }));
  return out;
}

/** Wall running along Z at a fixed X, with optional gaps (doorways). */
function wallZ(x, z1, z2, y, h, t, c, gaps = [], doorH = 2.6, mat = S.CONCRETE) {
  const out = [];
  const cuts = gaps.slice().sort((a, b) => a[0] - b[0]);
  let cursor = z1;
  for (const [gs, ge] of cuts) {
    if (gs > cursor) out.push(B(x, y, (cursor + gs) / 2, t, h, gs - cursor, c, { mat }));
    if (h > doorH) out.push(B(x, y + doorH, (gs + ge) / 2, t, h - doorH, ge - gs, c, { mat }));
    cursor = ge;
  }
  if (cursor < z2) out.push(B(x, y, (cursor + z2) / 2, t, h, z2 - cursor, c, { mat }));
  return out;
}

/**
 * A hollow building with doorways and an optional walkable roof.
 * `doors` entries: { side: 'n'|'s'|'e'|'w', at: <offset from centre>, w: <width> }
 */
function building({
  x, z, w, d, y = 0, h = 4.2, c = 0xb08968, roofC, t = 0.4, roof = true,
  doors = [], mat = S.CONCRETE, roofMat = S.ROOF, lip = 0, overhang = 0,
}) {
  const out = [];
  const hx = w / 2, hz = d / 2;
  const gaps = { n: [], s: [], e: [], w: [] };
  for (const dr of doors) gaps[dr.side].push([dr.at - dr.w / 2, dr.at + dr.w / 2]);

  const map1 = (arr, base) => arr.map(([a, b]) => [base + a, base + b]);
  out.push(...wallX(z - hz, x - hx, x + hx, y, h, t, c, map1(gaps.n, x), 2.6, mat));
  out.push(...wallX(z + hz, x - hx, x + hx, y, h, t, c, map1(gaps.s, x), 2.6, mat));
  out.push(...wallZ(x - hx, z - hz, z + hz, y, h, t, c, map1(gaps.w, z), 2.6, mat));
  out.push(...wallZ(x + hx, z - hz, z + hz, y, h, t, c, map1(gaps.e, z), 2.6, mat));
  if (roof) {
    const rw = w + t + overhang * 2, rd = d + t + overhang * 2;
    out.push(B(x, y + h, z, rw, 0.35, rd, roofC ?? c, { roof: true, mat: roofMat }));
    // A low parapet turns a bare roof into cover worth taking.
    if (lip > 0) {
      const ry = y + h + 0.35;
      out.push(B(x, ry, z - rd / 2 + 0.15, rw, lip, 0.3, roofC ?? c, { mat: roofMat }));
      out.push(B(x, ry, z + rd / 2 - 0.15, rw, lip, 0.3, roofC ?? c, { mat: roofMat }));
      out.push(B(x - rw / 2 + 0.15, ry, z, 0.3, lip, rd, roofC ?? c, { mat: roofMat }));
      out.push(B(x + rw / 2 - 0.15, ry, z, 0.3, lip, rd, roofC ?? c, { mat: roofMat }));
    }
  }
  return out;
}

/**
 * A house on a suburban street.
 *
 * Same shell as `building()`, dressed: painted lap siding, a shingle roof that
 * overhangs its walls, glazed windows stuck to the outside of the cladding, a
 * dark doorway recess, and an optional chimney. Windows and the door surround
 * are decor — a façade should never be a thing bullets stop against or bodies
 * snag on, and none of it should cast a shadow onto the wall it is glued to.
 */
function house({
  x, z, w, d, y = 0, h = 4.4, wall = 0xe6e9ec, roofC = 0x4b525c,
  mat = S.SIDING, roofMat = S.SHINGLE, t = 0.42, doors = [], windows = 'auto',
  lip = 0, overhang = 0.75, chimney = null, trim = null, roof = true, porch = null,
}) {
  const out = building({ x, z, w, d, y, h, c: wall, roofC, t, roof, doors, mat, roofMat, lip, overhang });
  const hx = w / 2, hz = d / 2;
  const proud = t / 2 + 0.07;
  const frame = trim ?? 0xf4f6f8;

  // Trim board where the wall meets the roof: reads as a fascia, and stops the
  // overhang looking like a slab someone dropped on top.
  if (roof) {
    const rw = w + t + overhang * 2, rd = d + t + overhang * 2;
    out.push(D(x, y + h - 0.26, z - rd / 2 + 0.12, rw, 0.26, 0.24, frame, { mat: S.PAINT, noShadow: true }));
    out.push(D(x, y + h - 0.26, z + rd / 2 - 0.12, rw, 0.26, 0.24, frame, { mat: S.PAINT, noShadow: true }));
    out.push(D(x - rw / 2 + 0.12, y + h - 0.26, z, 0.24, 0.26, rd, frame, { mat: S.PAINT, noShadow: true }));
    out.push(D(x + rw / 2 - 0.12, y + h - 0.26, z, 0.24, 0.26, rd, frame, { mat: S.PAINT, noShadow: true }));
  }

  // Windows. 'auto' spaces two per long wall at eye height, which is the
  // arrangement that reads as a house from every angle without any thought.
  const list = windows === 'auto'
    ? [
      { side: 'n', at: -w * 0.24 }, { side: 'n', at: w * 0.24 },
      { side: 's', at: -w * 0.24 }, { side: 's', at: w * 0.24 },
      { side: 'e', at: -d * 0.22 }, { side: 'e', at: d * 0.22 },
      { side: 'w', at: -d * 0.22 }, { side: 'w', at: d * 0.22 },
    ]
    : (windows ?? []);

  for (const win of list) {
    const ww = win.w ?? 1.7, wh = win.h ?? 1.5, wy = y + (win.y ?? 1.45);
    if (wy + wh > y + h - 0.3) continue;                       // never punch the fascia
    const sill = frame;
    if (win.side === 'n' || win.side === 's') {
      const wz = win.side === 'n' ? z - hz - proud : z + hz + proud;
      out.push(D(x + win.at, wy, wz, ww, wh, 0.14, 0xffffff, { mat: S.WINDOW, noShadow: true }));
      out.push(D(x + win.at, wy - 0.16, wz, ww + 0.34, 0.16, 0.24, sill, { mat: S.PAINT, noShadow: true }));
    } else {
      const wx = win.side === 'w' ? x - hx - proud : x + hx + proud;
      out.push(D(wx, wy, z + win.at, 0.14, wh, ww, 0xffffff, { mat: S.WINDOW, noShadow: true }));
      out.push(D(wx, wy - 0.16, z + win.at, 0.24, 0.16, ww + 0.34, sill, { mat: S.PAINT, noShadow: true }));
    }
  }

  // Door surrounds: a painted frame around every gap the caller cut.
  for (const dr of doors) {
    const dw = dr.w + 0.5;
    if (dr.side === 'n' || dr.side === 's') {
      const dz = dr.side === 'n' ? z - hz - proud : z + hz + proud;
      out.push(D(x + dr.at, y, dz, dw, 2.9, 0.13, frame, { mat: S.PAINT, noShadow: true }));
      out.push(D(x + dr.at, y, dz - (dr.side === 'n' ? 0.06 : -0.06), dr.w, 2.6, 0.1, 0x3a2f28, { mat: S.PAINT, noShadow: true }));
    } else {
      const dx = dr.side === 'w' ? x - hx - proud : x + hx + proud;
      out.push(D(dx, y, z + dr.at, 0.13, 2.9, dw, frame, { mat: S.PAINT, noShadow: true }));
      out.push(D(dx - (dr.side === 'w' ? 0.06 : -0.06), y, z + dr.at, 0.1, 2.6, dr.w, 0x3a2f28, { mat: S.PAINT, noShadow: true }));
    }
  }

  if (chimney) {
    const [cx, cz, ch = 2.2] = chimney;
    out.push(B(x + cx, y + h, z + cz, 1.15, ch, 1.15, 0x8d5a48, { mat: S.BRICK }));
    out.push(D(x + cx, y + h + ch, z + cz, 1.45, 0.24, 1.45, 0x6d4436, { mat: S.BRICK }));
  }

  // A porch: two posts and a canopy over the front door. Walkable, so it is
  // also the first rung of the ladder onto the roof.
  if (porch) {
    const { side = 's', at = 0, w: pw = 4, depth = 2.2, c: pc = frame } = porch;
    const oz = side === 'n' ? -1 : 1;
    const pz = side === 'n' ? z - hz - depth / 2 : z + hz + depth / 2;
    out.push(B(x + at, y + 2.7, pz, pw, 0.28, depth + 0.3, pc, { roof: true, mat: S.PLANK }));
    out.push(B(x + at - pw / 2 + 0.2, y, pz + oz * (depth / 2 - 0.2), 0.26, 2.7, 0.26, pc, { mat: S.PAINT }));
    out.push(B(x + at + pw / 2 - 0.2, y, pz + oz * (depth / 2 - 0.2), 0.26, 2.7, 0.26, pc, { mat: S.PAINT }));
    out.push(D(x + at, y, pz, pw, 0.16, depth, 0xd8d2c4, { mat: S.PLANK, noShadow: true }));
  }
  return out;
}

/** Staircase; `dir` is the direction of ascent. */
function stairs({ x, z, y = 0, w = 3, steps = 8, rise = 0.55, run = 0.9, dir = '+x', c = 0x8d7355, mat = S.CONCRETE }) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const hgt = (i + 1) * rise;
    if (dir === '+x') out.push(B(x + i * run + run / 2, y, z, run, hgt, w, c, { mat }));
    else if (dir === '-x') out.push(B(x - i * run - run / 2, y, z, run, hgt, w, c, { mat }));
    else if (dir === '+z') out.push(B(x, y, z + i * run + run / 2, w, hgt, run, c, { mat }));
    else out.push(B(x, y, z - i * run - run / 2, w, hgt, run, c, { mat }));
  }
  return out;
}

/** Ramp made of shallow steps — reads as a slope, collides as stairs. */
const ramp = (o) => stairs({ rise: 0.3, run: 0.62, steps: 14, ...o });

/** Shipping container. */
const container = (x, y, z, rot = 0, c = 0xc0563a) =>
  (rot
    ? B(x, y, z, 2.6, 2.7, 6.4, c, { mat: S.RUST })
    : B(x, y, z, 6.4, 2.7, 2.6, c, { mat: S.RUST }));

/** Stack of crates. */
function crates(x, y, z, n = 3, s = 1.3, c = 0xc08a3c) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const jx = ((i * 37) % 5 - 2) * 0.16, jz = ((i * 53) % 5 - 2) * 0.16;
    out.push(B(x + jx, y + i * s, z + jz, s, s, s, c, { mat: S.CRATE }));
  }
  return out;
}

/** Waist-high barrier — the bread and butter of a readable gunfight. */
const cover = (x, y, z, w, d, c = 0xb9bec4, mat = S.CONCRETE, h = 1.25) =>
  B(x, y, z, w, h, d, c, { mat });

/** Oil drum. */
const barrel = (x, y, z, c = 0xd0563a) => B(x, y, z, 0.95, 1.35, 0.95, c, { mat: S.RUST });

/** Rotate a list of boxes 180° about the origin — instant mirrored symmetry. */
const rot180 = (boxes) => boxes.map((b) => ({ ...b, x: -b.x, z: -b.z }));

/** Shift a list of boxes. */
const at = (boxes, dx, dz) => boxes.map((b) => ({ ...b, x: b.x + dx, z: b.z + dz }));

/* ── Street furniture ────────────────────────────────────────────────────── */

/**
 * Road surface with kerbs and lane markings.
 *
 * The tarmac and the paint are decor lying flat on the ground, so they cost
 * nothing in the collision world; the kerbs are solid, because a player should
 * step up onto a pavement rather than walk through it.
 */
function road({ axis = 'z', at: a = 0, from, to, width = 14, kerb = true,
  c = 0x4f545c, line = 0xf0efe6, dash = true, centre = true }) {
  const out = [];
  const len = to - from, mid = (from + to) / 2;
  const along = axis === 'z';
  const put = (u, v, w, d, y, h, col, mat, o = {}) =>
    out.push(D(along ? u : v, y, along ? v : u, along ? w : d, h, along ? d : w, col, { mat, noShadow: true, ...o }));

  put(a, mid, width, len, 0, 0.07, c, S.ASPHALT);
  if (centre) {
    if (dash) {
      for (let v = from + 2; v < to - 2; v += 6.5) {
        put(a, v + 1.6, 0.34, 3.2, 0.07, 0.035, line, S.PAINT);
      }
    } else {
      put(a - 0.24, mid, 0.22, len, 0.07, 0.035, line, S.PAINT);
      put(a + 0.24, mid, 0.22, len, 0.07, 0.035, line, S.PAINT);
    }
  }
  // Edge lines, then the kerb stones that actually stop you.
  put(a - width / 2 + 0.6, mid, 0.22, len, 0.07, 0.035, line, S.PAINT);
  put(a + width / 2 - 0.6, mid, 0.22, len, 0.07, 0.035, line, S.PAINT);
  if (kerb) {
    const k = (u) => out.push(along
      ? B(u, 0, mid, 0.55, 0.26, len, 0xc8ccd2, { mat: S.TARMAC })
      : B(mid, 0, u, len, 0.26, 0.55, 0xc8ccd2, { mat: S.TARMAC }));
    k(a - width / 2 - 0.28);
    k(a + width / 2 + 0.28);
  }
  return out;
}

/** A paved area — plaza, forecourt, driveway. Solid, so you stand on it. */
const pavement = (x, z, w, d, c = 0xcfd4da, mat = S.TARMAC, h = 0.22) =>
  B(x, 0, z, w, h, d, c, { mat });

/** Zebra crossing. */
function crossing(x, z, axis = 'z', width = 14, c = 0xf0efe6) {
  const out = [];
  for (let i = -3; i <= 3; i++) {
    out.push(axis === 'z'
      ? D(x + i * 1.6, 0.07, z, 0.9, 0.035, 4.4, c, { mat: S.PAINT, noShadow: true })
      : D(x, 0.07, z + i * 1.6, 4.4, 0.035, 0.9, c, { mat: S.PAINT, noShadow: true }));
  }
  void width;
  return out;
}

/**
 * A run of garden fence. Solid, but only chest high: it shapes a fight without
 * ever being the thing that makes a map feel like a corridor.
 */
function fence({ axis = 'x', at: a = 0, from, to, y = 0, h = 1.85,
  c = 0xc4762d, post = 0x8a5220, gaps = [], t = 0.28 }) {
  const out = [];
  const cuts = gaps.slice().sort((p, q) => p[0] - q[0]);
  const seg = (s, e) => {
    if (e - s < 0.4) return;
    const mid = (s + e) / 2, len = e - s;
    if (axis === 'x') out.push(B(mid, y, a, len, h, t, c, { mat: S.FENCE }));
    else out.push(B(a, y, mid, t, h, len, c, { mat: S.FENCE }));
    // Posts every ~4 units, drawn slightly fatter so the run reads as built.
    for (let p = s; p <= e + 0.01; p += 4) {
      if (axis === 'x') out.push(B(p, y, a, 0.34, h + 0.24, t + 0.12, post, { mat: S.WOOD, noShadow: true }));
      else out.push(B(a, y, p, t + 0.12, h + 0.24, 0.34, post, { mat: S.WOOD, noShadow: true }));
    }
  };
  let cursor = from;
  for (const [gs, ge] of cuts) { seg(cursor, gs); cursor = ge; }
  seg(cursor, to);
  return out;
}

/** A clipped hedge. Solid, waist-to-chest high, and very green. */
function hedge({ axis = 'x', at: a = 0, from, to, y = 0, h = 1.7, w = 1.5, c = 0x3f8f36 }) {
  const mid = (from + to) / 2, len = to - from;
  const body = axis === 'x'
    ? B(mid, y, a, len, h, w, c, { mat: S.HEDGE })
    : B(a, y, mid, w, h, len, c, { mat: S.HEDGE });
  // A slightly wider, slightly darker cap: hedges are not cuboids, and this is
  // the cheapest lie that says so.
  const cap = axis === 'x'
    ? B(mid, y + h, a, len - 0.2, 0.22, w + 0.3, 0x357a2d, { mat: S.HEDGE, noShadow: true })
    : B(a, y + h, mid, w + 0.3, 0.22, len - 0.2, 0x357a2d, { mat: S.HEDGE, noShadow: true });
  return [body, cap];
}

/**
 * A tree. Trunk and canopy both solid.
 *
 * The canopy used to be decor you ran and shot straight through, which is the
 * single most-reported thing on any of these maps: a thing that plainly looks
 * like a mass of leaves that a body passes through reads as the map being
 * broken, however cheap it is. It stops bullets now too — a tree between you
 * and a sniper is cover, which is what a player already believed it was.
 */
function tree(x, z, { y = 0, h = 4.4, c = 0x4aa544, trunk = 0x7b5433, r = 3.2, kind = 'round' } = {}) {
  const out = [B(x, y, z, 0.62, h, 0.62, trunk, { mat: S.BARK })];
  if (kind === 'pine') {
    out.push(B(x, y + h * 0.42, z, r, 2.6, r, c, { mat: S.FOLIAGE }));
    out.push(B(x, y + h * 0.42 + 2.2, z, r * 0.72, 2.3, r * 0.72, c, { mat: S.FOLIAGE }));
    out.push(B(x, y + h * 0.42 + 4.0, z, r * 0.44, 1.9, r * 0.44, c, { mat: S.FOLIAGE }));
  } else if (kind === 'palm') {
    out.push(B(x, y + h, z, r * 1.5, 0.5, 1.1, c, { mat: S.FOLIAGE }));
    out.push(B(x, y + h, z, 1.1, 0.5, r * 1.5, c, { mat: S.FOLIAGE }));
    out.push(B(x, y + h - 0.45, z, 1.5, 0.5, 1.5, c, { mat: S.FOLIAGE }));
  } else {
    out.push(B(x, y + h - 0.4, z, r, r * 0.75, r, c, { mat: S.FOLIAGE }));
    out.push(B(x, y + h - 0.4 + r * 0.75, z, r * 0.66, r * 0.5, r * 0.66, c, { mat: S.FOLIAGE }));
    out.push(B(x - r * 0.3, y + h - 0.9, z + r * 0.28, r * 0.55, r * 0.5, r * 0.55, c, { mat: S.FOLIAGE }));
  }
  return out;
}

/** Low ornamental bush — waist-high cover, like the hedge it is a piece of. */
const bush = (x, z, s = 1.5, c = 0x46974a, y = 0) => [
  B(x, y, z, s, s * 0.8, s, c, { mat: S.HEDGE }),
  B(x + s * 0.3, y, z - s * 0.25, s * 0.7, s * 0.6, s * 0.7, c, { mat: S.HEDGE }),
];

/**
 * Street lamp: pole, arm, and a lit head that never casts a shadow.
 * `y` is the ground it stands on — a pavement slab, usually, not zero.
 */
function lamp(x, z, { h = 6.4, dir = 1, c = 0xa9aeb6, y = 0 } = {}) {
  return [
    B(x, y, z, 0.3, 0.45, 0.3, 0x717780, { mat: S.METAL }),
    B(x, y, z, 0.22, h, 0.22, c, { mat: S.METAL }),
    D(x + dir * 0.9, y + h - 0.24, z, 2.0, 0.2, 0.2, c, { mat: S.METAL, noShadow: true }),
    D(x + dir * 1.75, y + h - 0.48, z, 1.15, 0.3, 0.55, 0xfaf3d8, { mat: S.NEON, noShadow: true }),
  ];
}

/**
 * A parked car. The body is solid — it is real cover, and half the fights on a
 * street map happen around one — while the glass, lights and wheels are decor.
 */
function car(x, z, { rot = 0, c = 0xe8e2cf, roofC = null, y = 0 } = {}) {
  const L = 4.5, W = 1.95;
  const along = rot === 0;
  const len = (l, w) => (along ? [l, w] : [w, l]);
  const [bw, bd] = len(L, W);
  const [cw, cd] = len(2.5, W - 0.16);
  const top = roofC ?? c;
  const out = [
    B(x, y + 0.42, z, bw, 0.78, bd, c, { mat: S.PAINT }),                       // body
    B(x, y + 1.2, z, cw, 0.82, cd, top, { mat: S.PAINT }),                      // cabin
    D(x, y + 2.02, z, cw - 0.2, 0.08, cd - 0.1, top, { mat: S.PAINT, noShadow: true }),
    D(x, y + 0.16, z, bw - 0.3, 0.3, bd + 0.1, 0x2a2d33, { mat: S.PAINT, noShadow: true }),
  ];
  // Glass on all four sides of the cabin, then wheels and lamps.
  const gz = along ? [[0, cd / 2 + 0.05, cw - 0.5, 0.1], [0, -cd / 2 - 0.05, cw - 0.5, 0.1]]
    : [[cw / 2 + 0.05, 0, 0.1, cd - 0.5], [-cw / 2 - 0.05, 0, 0.1, cd - 0.5]];
  for (const [ox, oz, gw, gd] of gz) {
    out.push(D(x + ox, y + 1.32, z + oz, gw, 0.58, gd, 0xbcdcee, { mat: S.GLASS, noShadow: true }));
  }
  const wheels = along
    ? [[-1.45, -W / 2], [1.45, -W / 2], [-1.45, W / 2], [1.45, W / 2]]
    : [[-W / 2, -1.45], [-W / 2, 1.45], [W / 2, -1.45], [W / 2, 1.45]];
  for (const [ox, oz] of wheels) {
    out.push(D(x + ox, y, z + oz, along ? 1.0 : 0.34, 0.72, along ? 0.34 : 1.0, 0x24262c, { mat: S.RUST, noShadow: true }));
  }
  const nose = along ? [bw / 2 + 0.02, 0, 0.1, 0.5] : [0, bd / 2 + 0.02, 0.5, 0.1];
  out.push(D(x + nose[0], y + 0.62, z + nose[1], nose[2], 0.26, nose[3], 0xfff0c0, { mat: S.NEON, noShadow: true }));
  out.push(D(x - nose[0], y + 0.62, z - nose[1], nose[2], 0.26, nose[3], 0xff5a44, { mat: S.NEON, noShadow: true }));
  return out;
}

/** A box truck — bigger cover than a car, and its roof is a real position. */
function truck(x, z, { rot = 0, c = 0xd8402f, box = 0xe9e6de, y = 0 } = {}) {
  const along = rot === 0;
  const dim = (l, w) => (along ? [l, w] : [w, l]);
  const [cabW, cabD] = dim(2.6, 2.4);
  const [boxW, boxD] = dim(5.4, 2.6);
  const cabAt = along ? [x + 3.6, z] : [x, z + 3.6];
  const boxAt = along ? [x - 1.2, z] : [x, z - 1.2];
  const out = [
    B(cabAt[0], y + 0.62, cabAt[1], cabW, 2.0, cabD, c, { mat: S.PAINT }),
    B(boxAt[0], y + 0.62, boxAt[1], boxW, 2.7, boxD, box, { mat: S.METAL }),
    D(boxAt[0], y + 3.32, boxAt[1], boxW + 0.2, 0.14, boxD + 0.2, 0xb9bec6, { mat: S.METAL, noShadow: true }),
    D(cabAt[0], y + 1.9, cabAt[1], cabW - 0.3, 0.55, cabD - 0.2, 0xbcdcee, { mat: S.GLASS, noShadow: true }),
    B(x, y, z, along ? 7.4 : 2.2, 0.62, along ? 2.2 : 7.4, 0x33363c, { mat: S.METAL }),
  ];
  const wheels = along
    ? [[3.0, -1.2], [3.0, 1.2], [-1.4, -1.3], [-1.4, 1.3], [-3.0, -1.3], [-3.0, 1.3]]
    : [[-1.2, 3.0], [1.2, 3.0], [-1.3, -1.4], [1.3, -1.4], [-1.3, -3.0], [1.3, -3.0]];
  for (const [ox, oz] of wheels) {
    out.push(D(x + ox, y, z + oz, along ? 1.1 : 0.4, 0.86, along ? 0.4 : 1.1, 0x22242a, { mat: S.RUST, noShadow: true }));
  }
  return out;
}

/** A billboard on two legs. The sign face is solid — it is a sight-line break. */
function billboard(x, z, { rot = 0, w = 8, h = 3.4, y = 3.2, c = 0xe8b23a, frame = 0x6d4a2c } = {}) {
  const along = rot === 0;
  const [sw, sd] = along ? [w, 0.4] : [0.4, w];
  return [
    B(x - (along ? w * 0.32 : 0), 0, z - (along ? 0 : w * 0.32), 0.4, y, 0.4, frame, { mat: S.WOOD }),
    B(x + (along ? w * 0.32 : 0), 0, z + (along ? 0 : w * 0.32), 0.4, y, 0.4, frame, { mat: S.WOOD }),
    B(x, y, z, sw, h, sd, c, { mat: S.NEON }),
    D(x, y - 0.26, z, sw + 0.5, 0.3, sd + 0.5, frame, { mat: S.WOOD, noShadow: true }),
    D(x, y + h, z, sw + 0.5, 0.3, sd + 0.5, frame, { mat: S.WOOD, noShadow: true }),
  ];
}

/** Utility pole with a crossarm and a slack line to the next one. */
function pole(x, z, { h = 8.5, span = null, c = 0x7f5a38 } = {}) {
  const out = [
    B(x, 0, z, 0.42, h, 0.42, c, { mat: S.BARK }),
    D(x, h - 1.2, z, 0.34, 0.26, 3.4, 0x6a4a30, { mat: S.WOOD, noShadow: true }),
    D(x, h - 2.2, z, 0.3, 0.22, 2.6, 0x6a4a30, { mat: S.WOOD, noShadow: true }),
  ];
  if (span) {
    const [tx, tz] = span;
    const mx = (x + tx) / 2, mz = (z + tz) / 2;
    const len = Math.hypot(tx - x, tz - z);
    const alongZ = Math.abs(tz - z) > Math.abs(tx - x);
    for (const off of [-1.2, 1.2]) {
      out.push(D(alongZ ? mx + off : mx, h - 1.35, alongZ ? mz : mz + off,
        alongZ ? 0.1 : len, 0.1, alongZ ? len : 0.1, 0x2c2c30, { mat: S.PAINT, noShadow: true }));
    }
  }
  return out;
}

/** Park bench. Solid: knee-high cover you vault, and a step onto a low wall. */
const bench = (x, z, rot = 0, c = 0xb87b3c, y = 0) => (rot === 0 ? [
  B(x, y, z, 2.4, 0.44, 0.7, c, { mat: S.PLANK, noShadow: true }),
  B(x, y + 0.44, z - 0.28, 2.4, 0.72, 0.16, c, { mat: S.PLANK, noShadow: true }),
] : [
  B(x, y, z, 0.7, 0.44, 2.4, c, { mat: S.PLANK, noShadow: true }),
  B(x - 0.28, y + 0.44, z, 0.16, 0.72, 2.4, c, { mat: S.PLANK, noShadow: true }),
]);

/** Wheelie bin / dumpster — chest-high cover, and a step onto a low roof. */
const dumpster = (x, z, c = 0x2f7a4a, rot = 0) => [
  B(x, 0, z, rot ? 1.7 : 2.8, 1.5, rot ? 2.8 : 1.7, c, { mat: S.METAL }),
  B(x, 1.5, z, rot ? 1.8 : 2.9, 0.16, rot ? 2.9 : 1.8, 0x27633c, { mat: S.METAL, noShadow: true }),
];

/** A market stall: striped awning over a plank counter. */
function stall(x, z, { rot = 0, c = 0xd94f42, post = 0x8a5a30, w = 4.2, d = 3.0 } = {}) {
  const [ww, dd] = rot ? [d, w] : [w, d];
  return [
    B(x, 0, z, ww * 0.9, 1.05, dd * 0.55, 0xc9a06a, { mat: S.PLANK }),
    D(x, 2.5, z, ww, 0.3, dd, c, { mat: S.CANVAS, noShadow: true }),
    D(x, 2.15, z + (rot ? 0 : dd / 2), rot ? 0.3 : ww, 0.45, rot ? dd : 0.3, c, { mat: S.CANVAS, noShadow: true }),
    B(x - ww / 2 + 0.16, 0, z - dd / 2 + 0.16, 0.2, 2.5, 0.2, post, { mat: S.WOOD }),
    B(x + ww / 2 - 0.16, 0, z - dd / 2 + 0.16, 0.2, 2.5, 0.2, post, { mat: S.WOOD }),
    B(x - ww / 2 + 0.16, 0, z + dd / 2 - 0.16, 0.2, 2.5, 0.2, post, { mat: S.WOOD }),
    B(x + ww / 2 - 0.16, 0, z + dd / 2 - 0.16, 0.2, 2.5, 0.2, post, { mat: S.WOOD }),
  ];
}

/** Flower planter: a low box you vault, with colour spilling out of it. */
const planter = (x, z, w = 2.4, d = 1.2, c = 0xb9713c, bloom = 0xe0577a, y = 0) => [
  B(x, y, z, w, 0.85, d, c, { mat: S.BRICK }),
  B(x, y + 0.85, z, w - 0.25, 0.4, d - 0.25, 0x4a9d4a, { mat: S.HEDGE, noShadow: true }),
  D(x - w * 0.22, y + 1.15, z, 0.5, 0.3, 0.5, bloom, { mat: S.HEDGE, noShadow: true }),
  D(x + w * 0.24, y + 1.15, z + d * 0.12, 0.44, 0.3, 0.44, bloom, { mat: S.HEDGE, noShadow: true }),
];

/** A patch of lawn laid over whatever the ground material is. */
const lawn = (x, z, w, d, c = 0x63b544) => D(x, 0.02, z, w, 0.05, d, c, { mat: S.GRASS, noShadow: true });

/** Water: a sunken pool you can stand in the middle of. */
const water = (x, z, w, d, c = 0x3fa9d8, y = 0.04) =>
  D(x, y, z, w, 0.08, d, c, { mat: S.WATER, noShadow: true });

/**
 * Far scenery: a silhouette of the town continuing past the invisible edge.
 *
 * Deliberately crude — it exists to be seen through fog at sixty metres, and
 * every box here is decor sitting outside the boundary, so it costs the
 * collision world nothing.
 */
function skyline(radius, { count = 26, seed = 7, palette = [0xcfd6de], h = [6, 16], mat = S.SIDING, roofC = 0x4c525c } = {}) {
  const out = [];
  let a = seed >>> 0;
  const rnd = () => { a = (Math.imul(a ^ (a >>> 15), 0x2545f491) + 0x9e3779b9) >>> 0; return a / 4294967296; };
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rnd() * 0.2;
    const dist = radius + rnd() * radius * 0.55;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    const w = 8 + rnd() * 14, d = 8 + rnd() * 14;
    const hh = h[0] + rnd() * (h[1] - h[0]);
    out.push(D(x, 0, z, w, hh, d, palette[Math.floor(rnd() * palette.length)], { mat, noShadow: true }));
    out.push(D(x, hh, z, w + 1.2, 0.5, d + 1.2, roofC, { mat: S.SHINGLE, noShadow: true }));
  }
  return out;
}

/** A ring of trees just past the boundary, so the edge reads as countryside. */
function treeline(radius, { count = 30, seed = 11, c = 0x3f8c3c, trunk = 0x6f4c2e, kind = 'round' } = {}) {
  const out = [];
  let a = seed >>> 0;
  const rnd = () => { a = (Math.imul(a ^ (a >>> 15), 0x2545f491) + 0x9e3779b9) >>> 0; return a / 4294967296; };
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rnd() * 0.35;
    const dist = radius + rnd() * radius * 0.4;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    for (const b of tree(x, z, { h: 4 + rnd() * 4, c, trunk, r: 3 + rnd() * 2.4, kind })) {
      out.push({ ...b, decor: true, noShadow: true });
    }
  }
  return out;
}

/* ── The station set ─────────────────────────────────────────────────────────
 *
 * Everything above dresses a town in daylight: fences, hedges, parked cars, a
 * sun to throw shadows off them. None of it survives being moved to a night
 * map, and not because of the colours — because of the *lighting model*. A
 * sunlit box at midnight is a dark box, and a level built out of dark boxes is
 * a level you cannot read: no silhouettes, no edges, nowhere for the eye to go.
 *
 * So the set below is built around light rather than around geometry. `G` is a
 * box that is drawn bright instead of being lit, which the renderer batches
 * into an unlit material whose colour runs past 1.0 — over-bright, so the post
 * chain's bright pass finds it and blooms it (client/js/world.js, `_buildBoxes`).
 * Every other helper here is a shape with those strips already in the right
 * places: a rim on the edge of a platform, a seam up the corner of a tower, a
 * bar along the top of a railing.
 *
 * The rule the whole set follows: **light marks what you can stand on**. Every
 * walkable edge glows and nothing else does, so a player reading the map at a
 * glance is reading a map of the routes. It is the night-time equivalent of the
 * bright roofs on the town maps, and it is doing the same job.
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * An emissive box: drawn, never lit, never solid, never a shadow caster.
 *
 * `i` is how far past white it pushes. Around 1.5 it reads as a lit surface;
 * past 2 it throws a visible halo and starts to bleed into whatever is in front
 * of it, which is right for a sign and wrong for a floor strip.
 */
const G = (x, y, z, w, h, d, c, i = 1.6) =>
  ({ x, y, z, w, h, d, c, decor: true, noShadow: true, mat: S.NEON, glow: i });

/** A light strip laid along X or Z. The workhorse of the whole set. */
function strip({ axis = 'x', at: a = 0, from, to, y = 0.03, c = 0x4fe3ff, t = 0.3, h = 0.07, i = 1.7 }) {
  const len = Math.abs(to - from), mid = (from + to) / 2;
  return axis === 'x' ? G(mid, y, a, len, h, t, c, i) : G(a, y, mid, t, h, len, c, i);
}

/**
 * Glowing trim around the edge of a platform, just inside its rim.
 *
 * Four strips rather than one hollow box because a box would light the middle
 * of the deck as well, and a deck that glows all over stops telling you where
 * its edge is — which is the only thing this is for. Every drop on this map is
 * long enough to matter, so the edge has to be legible from above.
 */
function rimLight(x, y, z, w, d, c = 0x4fe3ff, i = 1.7, t = 0.26) {
  const hx = w / 2 - t / 2, hz = d / 2 - t / 2;
  return [
    G(x, y, z - hz, w, 0.07, t, c, i), G(x, y, z + hz, w, 0.07, t, c, i),
    G(x - hx, y, z, t, 0.07, d - t * 2, c, i), G(x + hx, y, z, t, 0.07, d - t * 2, c, i),
  ];
}

/**
 * A walkable slab with a lit edge — the unit every level of this map is made of.
 *
 * The slab is solid and the trim is not, so the light never eats a bullet and
 * never takes a corner off a fight. `rail` puts a hip-high barrier round it,
 * which is cover you can shoot over and, more usefully, a line that stops a
 * player walking off a twenty-metre drop they could not see the edge of.
 */
function deck(x, y, z, w, d, {
  c = 0x39445c, mat = S.TILE, glowC = 0x4fe3ff, thick = 0.55, rail = 0, i = 1.7,
  glow: hasGlow = true, gaps = [],
} = {}) {
  const out = [B(x, y, z, w, thick, d, c, { roof: true, mat })];
  const top = y + thick;
  if (hasGlow) out.push(...rimLight(x, top + 0.01, z, w, d, glowC, i));
  if (rail > 0) {
    // A gap is a side left open: where a stair arrives, or where a bridge
    // leaves. Named by side rather than by coordinate because that is how the
    // level reads when you are standing on it.
    const has = (side) => !gaps.includes(side);
    const t = 0.22;
    if (has('n')) out.push(...railing(x, top, z - d / 2 + t, w, t, rail, c, glowC));
    if (has('s')) out.push(...railing(x, top, z + d / 2 - t, w, t, rail, c, glowC));
    if (has('w')) out.push(...railing(x - w / 2 + t, top, z, t, d, rail, c, glowC));
    if (has('e')) out.push(...railing(x + w / 2 - t, top, z, t, d, rail, c, glowC));
  }
  return out;
}

/** Hip-high barrier with a lit cap: cover to crouch behind, a line not to cross. */
function railing(x, y, z, w, d, h = 1.0, c = 0x2b3242, glowC = 0x4fe3ff) {
  return [
    B(x, y, z, w, h, d, c, { mat: S.METAL }),
    G(x, y + h, z, w + 0.06, 0.08, d + 0.06, glowC, 1.9),
  ];
}

/**
 * A structural column with a lit core running up it.
 *
 * Solid, so it is cover; the light is a decor sleeve around it, so shooting at
 * the glow hits the column. Used under every deck on the map — a floating slab
 * with nothing holding it up is the single fastest way to make a level read as
 * a whitebox rather than as a place.
 */
function pylon(x, z, { y = 0, h = 6.4, r = 0.8, c = 0x232b3c, glowC = 0x4fe3ff, i = 1.5 } = {}) {
  return [
    B(x, y, z, r * 2, h, r * 2, c, { mat: S.METAL }),
    G(x, y + 0.3, z - r - 0.03, 0.24, h - 0.9, 0.06, glowC, i),
    G(x, y + 0.3, z + r + 0.03, 0.24, h - 0.9, 0.06, glowC, i),
    G(x - r - 0.03, y + 0.3, z, 0.06, h - 0.9, 0.24, glowC, i),
    G(x + r + 0.03, y + 0.3, z, 0.06, h - 0.9, 0.24, glowC, i),
  ];
}

/**
 * A bridge between two levels of the map, with rails down both long sides.
 *
 * Solid deck, lit kerbs, and a pylon every eight metres so it is carried rather
 * than floating. The rails are the point: a bridge is the most exposed place on
 * a map like this, and something to crouch behind is what makes crossing one a
 * decision instead of a coin toss.
 */
function bridge({ axis = 'z', at: a = 0, from, to, y = 6.4, w = 5,
  c = 0x39445c, glowC = 0x4fe3ff, rail = 0.95, legs = true, legTo = 0 } = {}) {
  const len = Math.abs(to - from), mid = (from + to) / 2;
  const out = [];
  const along = axis === 'z';
  out.push(...deck(along ? a : mid, y, along ? mid : a,
    along ? w : len, along ? len : w,
    { c, glowC, rail, gaps: along ? ['n', 's'] : ['w', 'e'] }));
  if (legs) {
    const step = 9;
    for (let s = -len / 2 + step; s < len / 2 - 1; s += step) {
      const px = along ? a : mid + s, pz = along ? mid + s : a;
      out.push(...pylon(px, pz, { y: legTo, h: y - legTo, r: 0.55, c, glowC, i: 1.3 }));
    }
  }
  return out;
}

/**
 * A holographic panel: a dark frame with a bright face floating inside it.
 *
 * Decor throughout — a sign you can hide behind is a sign somebody will hide
 * behind, and a two-metre-wide invisible wall in the middle of a lane is the
 * worst kind of level bug. The frame is drawn dark so the face reads as
 * *emitting* rather than as painted on.
 */
function holo(x, y, z, { w = 6, h = 3.2, axis = 'x', c = 0x4fe3ff, frame = 0x1b2130, i = 2.1 } = {}) {
  const t = 0.22;
  const fw = axis === 'x' ? w : t, fd = axis === 'x' ? t : w;
  return [
    D(x, y, z, fw, h, fd, frame, { mat: S.METAL, noShadow: true }),
    G(x, y + 0.28, z, axis === 'x' ? w - 0.7 : t + 0.06, h - 0.56,
      axis === 'x' ? t + 0.06 : w - 0.7, c, i),
  ];
}

/**
 * A run of railing along an axis, with named gaps left open.
 *
 * The gaps are the whole reason this exists rather than four calls to
 * `railing`: every edge on a vertical map wants a barrier *except* exactly
 * where a stair arrives or a bridge leaves, and a level whose rails are drawn
 * across its own doorways is a level nobody can move around.
 */
function railRun({ axis = 'x', at: a = 0, from, to, y = 0, h = 1.0, t = 0.22,
  c = 0x2b3242, glowC = 0x4fe3ff, gaps = [] } = {}) {
  const out = [];
  const lo = Math.min(from, to), hi = Math.max(from, to);
  const seg = (s, e) => {
    if (e - s < 0.4) return;
    const mid = (s + e) / 2, len = e - s;
    out.push(...(axis === 'x'
      ? railing(mid, y, a, len, t, h, c, glowC)
      : railing(a, y, mid, t, len, h, c, glowC)));
  };
  let cursor = lo;
  for (const [gs, ge] of gaps.slice().sort((p, q) => p[0] - q[0])) {
    seg(cursor, Math.min(gs, hi));
    cursor = Math.max(cursor, ge);
  }
  seg(cursor, hi);
  return out;
}

/**
 * A mast with a slow beacon on it. Pure silhouette: it exists to give the
 * skyline something to cut against a sky that is otherwise all gradient.
 */
function mast(x, z, { y = 0, h = 12, c = 0x2b3242, glowC = 0xff4fa3 } = {}) {
  return [
    D(x, y, z, 0.5, h, 0.5, c, { mat: S.METAL }),
    D(x, y + h * 0.45, z, 2.4, 0.16, 0.16, c, { mat: S.METAL, noShadow: true }),
    D(x, y + h * 0.72, z, 0.16, 0.16, 2.0, c, { mat: S.METAL, noShadow: true }),
    G(x, y + h, z, 0.7, 0.7, 0.7, glowC, 2.4),
  ];
}

/**
 * A cargo pod: waist-high cover with a lit band round it.
 *
 * The map needs a lot of these and they need to be *readable* at forty metres
 * in the dark, which a plain crate is not. The band is what turns it into a
 * shape the eye finds without looking for it.
 */
function pod(x, z, { y = 0, w = 2.6, d = 2.6, h = 1.3, c = 0x46536e, glowC = 0x4fe3ff } = {}) {
  return [
    B(x, y, z, w, h, d, c, { mat: S.METAL }),
    G(x, y + h * 0.62, z, w + 0.05, 0.1, d + 0.05, glowC, 1.5),
  ];
}

/**
 * A window band up the face of a building — dark glass with a lit sill.
 *
 * Decor, and flush with the wall it sits on rather than proud of it: it is
 * texture, not geometry, and a player should never be able to stand on a
 * window ledge that was drawn to break up a flat wall.
 */
function windows(x, y, z, { w = 10, axis = 'x', floors = 3, pitch = 3.2, c = 0x16324e, glowC = 0x4fe3ff } = {}) {
  const out = [];
  const t = 0.12;
  for (let f = 0; f < floors; f++) {
    const fy = y + 1.1 + f * pitch;
    const bw = axis === 'x' ? w : t, bd = axis === 'x' ? t : w;
    out.push(D(x, fy, z, bw, 1.5, bd, c, { mat: S.WINDOW, noShadow: true }));
    out.push(G(x, fy - 0.16, z, axis === 'x' ? w : t + 0.04, 0.09,
      axis === 'x' ? t + 0.04 : w, glowC, 1.35));
  }
  return out;
}

/* ── Maps ────────────────────────────────────────────────────────────────── */

/**
 * LITTLETOWN — a suburban crossroads, and the map the art direction was
 * written for.
 *
 * Two streets meet at a planted island in the middle. Four blocks of houses
 * sit behind chest-high fences and hedges, which means cover everywhere and
 * enclosure nowhere: you can see clean across the map in both directions and
 * still never be standing in the open. The corner shop and the garage carry
 * flat roofs with a plank run between them, so the high ground is a route
 * rather than a perch, and every way up is out in the street where it can be
 * watched.
 *
 * The edge of the world is four invisible boxes at ±58. Past them the town
 * keeps going in decor — more roofs, a treeline, hills — so the boundary is
 * something you bump into once and then stop thinking about.
 */
function littletown() {
  const BLUE = 0x2f6fd0, RED = 0xd4382f, YELLOW = 0xe0a93c, GREEN = 0x46a05a,
        CREAM = 0xeadfc6, ORANGE = 0xe07a33, TEAL = 0x2fa79b, PURPLE = 0x8b62c4,
        WHITE = 0xf2f4f6, ROOF_D = 0x4b525c, ROOF_B = 0x8a4d38, ROOF_R = 0xa8382c,
        WOOD = 0xb8752f, STONE = 0xc3c8ce, GRASSC = 0x63b544;

  // The street grid, written down once. Everything else is placed against it:
  // the pavement starts where the kerb ends, the fences stand a metre past the
  // pavement, and no building's near edge comes inside the fence line.
  const RW = 15, CW = 13;                          // carriageway widths
  const PAVE = 4.2;
  const PX = RW / 2 + 0.55 + PAVE / 2 + 0.03;      // 10.43 — pavement centre
  const PZ = CW / 2 + 0.55 + PAVE / 2 + 0.03;      //  9.43
  const PAVE_TOP = 0.22;
  const FX = 13.0, FZ = 12.0;                      // fence lines
  const boxes = [];
  const add = (...xs) => { for (const x of xs) boxes.push(...(Array.isArray(x) ? x : [x])); };

  /* ── Streets ─────────────────────────────────────────────────────────── */
  add(road({ axis: 'z', at: 0, from: -58, to: 58, width: RW }));
  add(road({ axis: 'x', at: 0, from: -58, to: 58, width: CW }));
  add(crossing(0, -10, 'z'), crossing(0, 10, 'z'));
  add(crossing(-10, 0, 'x'), crossing(10, 0, 'x'));

  for (const s of [-1, 1]) {
    add(pavement(s * PX, -33, PAVE, 46, STONE), pavement(s * PX, 33, PAVE, 46, STONE));
    add(pavement(-33, s * PZ, 46, PAVE, STONE), pavement(33, s * PZ, 46, PAVE, STONE));
    for (const t of [-1, 1]) add(pavement(s * PX, t * PZ, PAVE, PAVE, STONE));   // corner aprons
  }

  /* ── The island in the middle ────────────────────────────────────────── */
  add(B(0, 0, 0, 9, 0.42, 9, STONE, { mat: S.TARMAC }));
  add(D(0, 0.42, 0, 8, 0.06, 8, GRASSC, { mat: S.GRASS, noShadow: true }));
  add(B(0, 0.42, 0, 2.2, 1.5, 2.2, 0xcdd2d8, { mat: S.ROCK }));
  add(tree(0, 0, { y: 1.92, h: 4.2, c: 0x3f9440, r: 4.4 }));
  add(planter(-3.1, 2.9, 2.2, 1.1, 0xb9713c, 0xe0577a, 0.42));
  add(planter(3.1, -2.9, 2.2, 1.1, 0xb9713c, 0xf0c33c, 0.42));
  add(bush(3.2, 3.0, 1.4, 0x46974a, 0.42), bush(-3.2, -3.0, 1.4, 0x46974a, 0.42));
  for (const [bx, bz] of [[-4.2, -4.2], [4.2, -4.2], [-4.2, 4.2], [4.2, 4.2]]) {
    add(B(bx, 0.42, bz, 0.34, 1.0, 0.34, 0xd8d2c0, { mat: S.PAINT, noShadow: true }));
  }

  /* ── North-west: the corner shop, and the map's high ground ──────────── */
  add(house({
    x: -23, z: -23, w: 14, d: 13, h: 6.6, wall: BLUE, roofC: ROOF_D, lip: 0.95,
    doors: [{ side: 'e', at: 0, w: 3.6 }, { side: 's', at: -3, w: 3.2 }],
    windows: [
      { side: 's', at: -4.5 }, { side: 's', at: 1.5 }, { side: 's', at: 5 },
      { side: 's', at: -4.5, y: 4.1 }, { side: 's', at: 0, y: 4.1 }, { side: 's', at: 4.5, y: 4.1 },
      { side: 'e', at: -4 }, { side: 'e', at: 4 }, { side: 'e', at: 0, y: 4.1 },
      { side: 'n', at: -4 }, { side: 'n', at: 4 },
    ],
  }));
  // Shopfront: an awning out over the pavement, sign above it.
  add(D(-23, 3.1, -15.1, 12.5, 0.28, 2.8, 0xd94f42, { mat: S.CANVAS, noShadow: true }));
  add(D(-23, 2.7, -13.8, 12.5, 0.55, 0.3, 0xd94f42, { mat: S.CANVAS, noShadow: true }));
  add(D(-23, 4.9, -16.3, 8.5, 1.6, 0.3, 0xf0c33c, { mat: S.NEON, noShadow: true }));
  // Up onto the roof: an outdoor stair on the quiet side, and a bin-and-crate
  // scramble onto the awning for anyone who would rather not walk round.
  add(stairs({ x: -31.6, z: -32, w: 3, steps: 12, rise: 0.6, run: 0.86, dir: '+z', c: STONE, mat: S.TARMAC }));
  add(B(-32.2, 7.2, -21.2, 4.6, 0.4, 3, STONE, { roof: true, mat: S.TARMAC }));
  add(dumpster(-31.5, -14.6, 0x2f7a4a));
  add(crates(-29.3, 0, -14.6, 2, 1.35, WOOD));
  add(B(-29.9, 4.62, -16.6, 4, 0.34, 2.4, 0xb63f34, { roof: true, mat: S.PLANK }));

  add(house({ x: -43, z: -22, w: 12, d: 11, h: 4.5, wall: RED, roofC: ROOF_D,
    chimney: [3.4, -2.4, 2.4], porch: { side: 's', at: 0, w: 4.6, depth: 2.4 },
    doors: [{ side: 's', at: 0, w: 3 }] }));
  add(house({ x: -22, z: -43, w: 13, d: 12, h: 4.6, wall: YELLOW, roofC: ROOF_B,
    chimney: [-4, 3, 2.6], doors: [{ side: 'e', at: 2, w: 3 }, { side: 's', at: -3, w: 3 }] }));
  add(house({ x: -44, z: -44, w: 12, d: 12, h: 4.4, wall: GREEN, roofC: ROOF_R,
    doors: [{ side: 'n', at: 0, w: 3 }, { side: 'e', at: 0, w: 3 }] }));

  /* ── North-east: the far end of the plank run ────────────────────────── */
  add(house({
    x: 22, z: -23, w: 14, d: 13, h: 6.6, wall: CREAM, roofC: ROOF_R, lip: 0.95,
    doors: [{ side: 'w', at: 0, w: 3.6 }, { side: 's', at: 3, w: 3.2 }],
    windows: [
      { side: 's', at: -5 }, { side: 's', at: -1 }, { side: 's', at: 4.6, y: 4.1 },
      { side: 's', at: -5, y: 4.1 }, { side: 's', at: 0, y: 4.1 },
      { side: 'w', at: -4 }, { side: 'w', at: 4 }, { side: 'w', at: 0, y: 4.1 },
      { side: 'n', at: -4 }, { side: 'n', at: 4 }, { side: 'e', at: 0 },
    ],
  }));
  add(D(22, 3.1, -15.1, 12.5, 0.28, 2.8, 0x3fa9d8, { mat: S.CANVAS, noShadow: true }));
  add(D(22, 2.7, -13.8, 12.5, 0.55, 0.3, 0x3fa9d8, { mat: S.CANVAS, noShadow: true }));
  add(stairs({ x: 30.6, z: -32.4, w: 3, steps: 12, rise: 0.6, run: 0.86, dir: '+z', c: STONE, mat: S.TARMAC }));
  add(B(31.0, 7.2, -21.6, 4.6, 0.4, 3, STONE, { roof: true, mat: S.TARMAC }));
  // The plank run: shop roof to shop roof, straight over the main street. The
  // best sight line on the map, and the least cover anywhere on it.
  add(B(0, 6.95, -23, 32, 0.34, 1.7, WOOD, { roof: true, mat: S.PLANK }));
  add(D(0, 7.29, -23.8, 32, 0.8, 0.18, 0x8a5a30, { mat: S.WOOD, noShadow: true }));
  add(D(0, 7.29, -22.2, 32, 0.8, 0.18, 0x8a5a30, { mat: S.WOOD, noShadow: true }));

  add(house({ x: 44, z: -22, w: 15, d: 13, h: 5.6, wall: TEAL, roofC: ROOF_D, lip: 0.9,
    doors: [{ side: 'w', at: 0, w: 4.4 }, { side: 's', at: 4, w: 3.4 }],
    windows: [{ side: 'n', at: -5 }, { side: 'n', at: 0 }, { side: 'n', at: 5 },
      { side: 'e', at: -4 }, { side: 'e', at: 4 }, { side: 's', at: -4 }] }));
  add(ramp({ x: 53.6, z: -31.2, w: 3.2, dir: '-x', c: STONE, mat: S.TARMAC, steps: 11, rise: 0.56, run: 0.86 }));
  add(B(45, 5.95, -31.2, 13, 0.4, 3.2, STONE, { roof: true, mat: S.TARMAC }));
  add(house({ x: 23, z: -43, w: 12, d: 11, h: 4.4, wall: PURPLE, roofC: ROOF_D,
    doors: [{ side: 's', at: 0, w: 3 }] }));
  add(house({ x: 45, z: -44, w: 12, d: 11, h: 4.5, wall: WHITE, roofC: ROOF_B,
    chimney: [-3.6, -2.4, 2.2], doors: [{ side: 'w', at: 0, w: 3 }] }));

  /* ── South-west: terrace and back yard ───────────────────────────────── */
  add(house({ x: -22, z: 22, w: 13, d: 12, h: 4.8, wall: ORANGE, roofC: ROOF_D,
    chimney: [4.2, 2.6, 2.4], doors: [{ side: 'e', at: 0, w: 3.2 }, { side: 'n', at: -3, w: 3 }] }));
  add(house({ x: -43, z: 23, w: 12, d: 12, h: 4.5, wall: WHITE, roofC: ROOF_R,
    porch: { side: 'n', at: 0, w: 4.4, depth: 2.2 }, doors: [{ side: 'n', at: 0, w: 3 }] }));
  add(house({ x: -23, z: 43, w: 13, d: 11, h: 4.6, wall: BLUE, roofC: ROOF_B,
    doors: [{ side: 'n', at: 2, w: 3 }, { side: 'e', at: 0, w: 3 }] }));
  add(house({ x: -45, z: 44, w: 12, d: 12, h: 4.4, wall: YELLOW, roofC: ROOF_D,
    doors: [{ side: 'n', at: 0, w: 3 }] }));
  add(crates(-33.5, 0, 33, 3, 1.45, WOOD));
  add(crates(-30.9, 0, 33.4, 2, 1.45, WOOD));
  add(B(-33.5, 4.35, 33, 5.2, 0.34, 5.2, 0xb9803a, { roof: true, mat: S.PLANK }));

  /* ── South-east: the chapel and the little park ──────────────────────── */
  add(house({ x: 23, z: 23, w: 13, d: 15, h: 5.6, wall: CREAM, roofC: ROOF_R, lip: 0.85,
    doors: [{ side: 'n', at: 0, w: 3.4 }, { side: 'w', at: 3, w: 3 }],
    windows: [{ side: 'w', at: -4, h: 2.4, y: 1.3 }, { side: 'w', at: 4, h: 2.4, y: 1.3 },
      { side: 'e', at: -4, h: 2.4, y: 1.3 }, { side: 'e', at: 4, h: 2.4, y: 1.3 },
      { side: 's', at: 0, h: 2.4, y: 1.3 }] }));
  // Bell tower over the chapel's north-east corner. Pure landmark: the clock
  // is what you navigate by, and nobody gets to sit on top of it.
  add(building({ x: 28, z: 17.6, w: 5.6, d: 5.6, h: 9.2, c: CREAM, roofC: ROOF_R,
    mat: S.PLASTER, roofMat: S.SHINGLE, overhang: 0.5,
    doors: [{ side: 'w', at: 0, w: 2.4 }] }));
  add(D(28, 9.55, 17.6, 0.4, 2.6, 0.4, 0xe8d9a8, { mat: S.PAINT, noShadow: true }));
  add(D(28, 10.6, 17.6, 1.8, 0.35, 0.35, 0xe8d9a8, { mat: S.PAINT, noShadow: true }));
  add(D(28, 6.4, 14.68, 2.2, 2.2, 0.18, 0xf7f2e2, { mat: S.PAINT, noShadow: true }));
  add(stairs({ x: 32.6, z: 33, w: 3, steps: 11, rise: 0.58, run: 0.84, dir: '-z', c: STONE, mat: S.ROCK }));
  add(B(31.8, 5.95, 23.6, 3.6, 0.4, 3.6, STONE, { roof: true, mat: S.ROCK }));

  add(lawn(43, 40, 24, 28));
  add(tree(37, 32, { h: 5.2, r: 4.4 }), tree(50, 34, { h: 4.6, r: 3.8, c: 0x54ad4a }));
  add(tree(39, 50, { h: 5.6, r: 4.8 }), tree(52, 46, { h: 4.4, r: 3.6, c: 0x3d8e3a }));
  add(bench(37, 38, 0), bench(48, 40, 1));
  add(B(43, 0, 47, 11.4, 0.4, 9.4, STONE, { mat: S.ROCK }));
  add(D(43, 0.4, 47, 10, 0.08, 8, 0x3fa9d8, { mat: S.WATER, noShadow: true }));
  add(B(43, 0.4, 47, 1.5, 1.9, 1.5, 0xd6dae0, { mat: S.ROCK }));
  add(house({ x: 23, z: 44, w: 12, d: 11, h: 4.5, wall: GREEN, roofC: ROOF_D,
    doors: [{ side: 'n', at: 0, w: 3 }] }));

  /* ── Frontages: fence, lawn, hedge ───────────────────────────────────── */
  // One run per block along each street, gated where a door faces it.
  add(fence({ axis: 'z', at: -FX, from: -52, to: -FZ, gaps: [[-25, -21], [-46, -42]] }));
  add(fence({ axis: 'z', at: -FX, from: FZ, to: 52, gaps: [[20, 24], [41, 45]] }));
  add(fence({ axis: 'z', at: FX, from: -52, to: -FZ, gaps: [[-25, -21], [-45, -41]] }));
  add(fence({ axis: 'z', at: FX, from: FZ, to: 52, gaps: [[21, 25], [42, 46]] }));
  add(fence({ axis: 'x', at: -FZ, from: -52, to: -FX, gaps: [[-46, -41], [-26, -21]] }));
  add(fence({ axis: 'x', at: -FZ, from: FX, to: 52, gaps: [[19, 24], [41, 46]] }));
  add(fence({ axis: 'x', at: FZ, from: -52, to: -FX, gaps: [[-46, -41], [-25, -20]] }));
  add(fence({ axis: 'x', at: FZ, from: FX, to: 52, gaps: [[20, 25], [42, 47]] }));

  // Garden hedges between the lots: cover in the back gardens, and the thing
  // that stops a flank through a block being a free run in a straight line.
  add(hedge({ axis: 'x', at: -33, from: -52, to: -FX }));
  add(hedge({ axis: 'x', at: -33, from: FX, to: 52 }));
  add(hedge({ axis: 'x', at: 33, from: -52, to: -FX }));
  add(hedge({ axis: 'z', at: -34, from: -52, to: -FZ }));
  add(hedge({ axis: 'z', at: -34, from: FZ, to: 52 }));
  add(hedge({ axis: 'z', at: 34, from: -52, to: -FZ }));

  for (const [lx, lz, lw, ld] of [
    [-32, -13.6, 36, 3.2], [-32, 13.6, 36, 3.2], [32, -13.6, 36, 3.2], [32, 13.6, 36, 3.2],
    [-14.6, -33, 3.2, 36], [14.6, -33, 3.2, 36], [-14.6, 33, 3.2, 36], [14.6, 33, 3.2, 36],
  ]) add(lawn(lx, lz, lw, ld));

  /* ── Traffic, lighting and wires ─────────────────────────────────────── */
  add(car(-4.6, -30, { rot: 0, c: 0xe8e2cf, roofC: 0xd8d2be }));
  add(car(4.6, -42, { rot: 0, c: 0x3f7fd0 }));
  add(car(-4.6, 34, { rot: 0, c: 0xd44b3c }));
  add(car(4.6, 46, { rot: 0, c: 0x4aae6a }));
  add(car(-30, -4.2, { rot: 1, c: 0xf0c33c }));
  add(car(30, 4.2, { rot: 1, c: 0xe8e2cf, roofC: 0x2f6fd0 }));
  add(car(-46, 4.2, { rot: 1, c: 0x8b62c4 }));
  add(truck(4.2, -14, { rot: 1, c: 0xd8402f }));
  add(truck(-42, -2.6, { rot: 1, c: 0x2f6fd0, box: 0xe9e6de }));

  for (const z of [-46, -30, -17, 17, 30, 46]) {
    add(lamp(-PX + 0.8, z, { dir: 1, y: PAVE_TOP }));
    add(lamp(PX - 0.8, z, { dir: -1, y: PAVE_TOP }));
  }
  for (const x of [-46, -30, 30, 46]) {
    add(lamp(x, -PZ + 0.8, { dir: 1, y: PAVE_TOP }));
    add(lamp(x, PZ - 0.8, { dir: -1, y: PAVE_TOP }));
  }
  // Spans stop short of z = -23: that is where the plank run crosses, and a
  // power line drawn straight through it reads as a mistake, not as a town.
  add(pole(-14.4, -52, { span: [-14.4, -38] }), pole(-14.4, -38, { span: [-14.4, -27] }), pole(-14.4, -27));
  add(pole(-14.4, 16, { span: [-14.4, 36] }), pole(-14.4, 36, { span: [-14.4, 54] }));
  add(pole(14.4, -52, { span: [14.4, -38] }), pole(14.4, -38, { span: [14.4, -27] }), pole(14.4, -27));
  add(pole(14.4, 16, { span: [14.4, 36] }), pole(14.4, 36, { span: [14.4, 54] }));

  add(billboard(-34, -54, { rot: 0, w: 9, c: 0xe8b23a }));
  add(billboard(36, 54, { rot: 0, w: 9, c: 0x3fa9d8 }));

  /* ── Street-level cover ──────────────────────────────────────────────── */
  add(cover(-PX, PAVE_TOP, -50, 3.4, 1.2, 0xd8dade, S.CONCRETE, 1.25));
  add(cover(PX, PAVE_TOP, 50, 3.4, 1.2, 0xd8dade, S.CONCRETE, 1.25));
  add(crates(-16.4, 0, 4.4, 2, 1.4, WOOD), crates(16.4, 0, -4.4, 2, 1.4, WOOD));
  add(barrel(-16.4, 0, -9.4), barrel(-17.5, 0, -8.6), barrel(-16.9, 1.35, -9));
  add(barrel(17, 0, 9.4, 0x3fa9d8), barrel(18.1, 0, 8.6, 0x3fa9d8));
  add(dumpster(36, 9.6, 0x2f7a4a, 1), dumpster(-36, -9.6, 0xd8402f, 1));
  add(planter(-PX, -20, 2.6, 1.3, 0xb9713c, 0xe0577a, PAVE_TOP));
  add(planter(PX, 20, 2.6, 1.3, 0xb9713c, 0xe0577a, PAVE_TOP));
  add(stall(-38, -PZ, { c: 0xd94f42 }), stall(38, PZ, { c: 0x3fa9d8 }));

  /* ── The world past the edge ─────────────────────────────────────────── */
  add(bounds(112));
  add(skyline(80, { count: 30, seed: 41, palette: [BLUE, RED, YELLOW, CREAM, TEAL, WHITE], h: [7, 15], roofC: ROOF_D }));
  add(treeline(72, { count: 34, seed: 19, c: 0x3f8c3c }));
  add(D(0, -2, -150, 280, 16, 60, 0x6fa85e, { mat: S.GRASS, noShadow: true }));
  add(D(0, -2, 150, 280, 16, 60, 0x6fa85e, { mat: S.GRASS, noShadow: true }));
  add(D(-150, -2, 0, 60, 16, 280, 0x6fa85e, { mat: S.GRASS, noShadow: true }));
  add(D(150, -2, 0, 60, 16, 280, 0x6fa85e, { mat: S.GRASS, noShadow: true }));

  return {
    id: 'littletown', name: 'Littletown',
    description: 'A suburban crossroads under a cloudless sky. Fences for cover, rooftops for the brave.',
    size: 112, tags: ['classic', 'street', 'rooftops'],
    sky: { top: 0x2fb8ec, bottom: 0xa8e6fb, haze: 0xd6f3ff, clouds: 0.45 },
    fog: { color: 0xc4ecfb, near: 90, far: 260 },
    sun: { dir: [0.42, 0.82, 0.38], color: 0xfff6e0, intensity: 1.5 },
    ambient: { color: 0xbfe4fb, intensity: 0.8 },
    ground: { color: 0x6fbe4a, size: 340, mat: S.GRASS },
    boxes,
    spawns: {
      ffa: [
        [-4, 0.3, -50, 0], [4, 0.3, 50, Math.PI], [-50, 0.3, 4, -1.57], [50, 0.3, -4, 1.57],
        [-38, 0.3, -37, 0.7], [38, 0.3, 34, -2.4], [38, 0.3, -36, -0.7], [-38, 0.3, 36, 2.4],
        [-23, 7.4, -23, 1.2], [44, 6.4, -22, -1.9], [0, 0.6, -34, 0], [23, 6.4, 23, 3.1],
      ],
      red: [
        [-4.4, 0.3, -52, 0], [4.4, 0.3, -50, 0], [-6.6, 0.3, -44, 0.3], [6.6, 0.3, -44, -0.3],
        [-23, 7.4, -23, 1.0],
      ],
      blue: [
        [4.4, 0.3, 52, Math.PI], [-4.4, 0.3, 50, Math.PI], [6.6, 0.3, 44, 2.8], [-6.6, 0.3, 44, -2.8],
        [23, 6.4, 23, 3.0],
      ],
    },
    objectives: [
      { id: 'A', x: -23, y: 0.3, z: -23 },
      // Just off the island's plinth: a five-metre capture ring still covers
      // the whole roundabout, and nobody spawns or stands inside a tree.
      { id: 'B', x: 0, y: 0.55, z: 3.4 },
      { id: 'C', x: 23, y: 0.3, z: 23 },
    ],
  };
}

/**
 * BURGTOWN — the old market square.
 *
 * Cobbles, timbered houses, striped stalls and a clock tower in the middle
 * whose gallery is the best seat on the map and the worst place to be caught.
 * Three ways up it, all of them visible from the square, which is the deal:
 * the height is free, holding it is not.
 */
function burgtown() {
  const PLASTER = 0xf0e6cf, TIMBER = 0x7a4a28, ROOF_R = 0xb8442f, ROOF_B = 0x8f4a30,
        ROOF_D = 0x54595f, STONE = 0xc7c2b6, COBBLE = 0xb3ada1, WOOD = 0xb8752f,
        BLUE = 0x3d72c4, GREEN = 0x4a9a56, ROSE = 0xd9737f, MUSTARD = 0xdca93a;
  const boxes = [];
  const add = (...xs) => { for (const x of xs) boxes.push(...(Array.isArray(x) ? x : [x])); };

  /* ── The square itself ───────────────────────────────────────────────── */
  add(B(0, 0, 0, 54, 0.24, 54, COBBLE, { mat: S.TILE }));
  add(D(0, 0.24, 0, 20, 0.05, 20, 0xc4bfb2, { mat: S.TILE, noShadow: true }));

  /* ── Clock tower ─────────────────────────────────────────────────────── */
  add(building({ x: 0, z: 0, w: 11, d: 11, h: 5.6, c: STONE, mat: S.ROCK, roof: false,
    doors: [{ side: 'n', at: 0, w: 3 }, { side: 's', at: 0, w: 3 }, { side: 'e', at: 0, w: 3 }, { side: 'w', at: 0, w: 3 }] }));
  add(B(0, 5.6, 0, 13.4, 0.42, 13.4, WOOD, { roof: true, mat: S.PLANK }));
  for (const [gx, gz, gw, gd] of [[0, -6.7, 13.4, 0.36], [0, 6.7, 13.4, 0.36], [-6.7, 0, 0.36, 13.4], [6.7, 0, 0.36, 13.4]]) {
    add(B(gx, 6.02, gz, gw, 1.0, gd, STONE, { mat: S.ROCK }));
  }
  add(building({ x: 0, z: 0, w: 6.4, d: 6.4, h: 6.4, y: 6.02, c: PLASTER, roofC: ROOF_R,
    mat: S.PLASTER, roofMat: S.SHINGLE, overhang: 0.6,
    doors: [{ side: 'n', at: 0, w: 2.4 }, { side: 's', at: 0, w: 2.4 }] }));
  add(D(0, 10.4, -3.4, 2.4, 2.4, 0.2, 0xf7f2e2, { mat: S.PAINT, noShadow: true }));  // clock face
  add(D(0, 11.5, -3.5, 0.24, 1.0, 0.14, 0x2b2b2f, { mat: S.PAINT, noShadow: true }));
  add(D(0.7, 11.5, -3.5, 1.3, 0.2, 0.14, 0x2b2b2f, { mat: S.PAINT, noShadow: true }));
  add(D(0, 13.0, 0, 1.0, 1.6, 1.0, 0xd9b64a, { mat: S.NEON, noShadow: true }));
  // Three ways onto the gallery.
  add(stairs({ x: 8.4, z: -7.4, w: 3.0, steps: 10, rise: 0.6, run: 0.86, dir: '-x', c: STONE, mat: S.ROCK }));
  add(ramp({ x: -8.4, z: 7.4, w: 3.0, dir: '+x', c: STONE, mat: S.ROCK, steps: 12, rise: 0.5, run: 0.72 }));
  add(crates(-8.4, 0, -7.6, 3, 1.5, WOOD), crates(-6.2, 0, -8.2, 2, 1.5, WOOD));

  /* ── Market stalls, ringing the tower ────────────────────────────────── */
  add(stall(-14, -13, { c: 0xd94f42 }), stall(14, -13, { c: 0x3fa9d8 }));
  add(stall(-14, 13, { c: 0xf0c33c }), stall(14, 13, { c: 0x4aae6a }));
  add(stall(-20, 0, { rot: 1, c: 0xd9737f }), stall(20, 0, { rot: 1, c: 0x8b62c4 }));
  add(planter(-8, -18, 3, 1.3), planter(8, 18, 3, 1.3));
  add(planter(18, -8, 1.3, 3), planter(-18, 8, 1.3, 3));

  /* ── The four sides of the square ────────────────────────────────────── */
  // North terrace: two houses sharing a gable, with a balcony run between them.
  add(house({ x: -13, z: -34, w: 16, d: 13, h: 5.2, wall: PLASTER, roofC: ROOF_R,
    mat: S.PLASTER, chimney: [5, 3, 2.4], lip: 0.85,
    doors: [{ side: 's', at: 0, w: 3.4 }, { side: 'w', at: 0, w: 3 }] }));
  add(house({ x: 13, z: -34, w: 16, d: 13, h: 5.2, wall: MUSTARD, roofC: ROOF_B,
    mat: S.PLASTER, chimney: [-5, 3, 2.4], lip: 0.85,
    doors: [{ side: 's', at: 0, w: 3.4 }, { side: 'e', at: 0, w: 3 }] }));
  add(B(0, 4.0, -28.4, 12, 0.34, 2.6, WOOD, { roof: true, mat: S.PLANK }));
  add(D(0, 4.34, -27.2, 12, 0.85, 0.18, TIMBER, { mat: S.WOOD, noShadow: true }));
  add(stairs({ x: -3.0, z: -25.4, w: 2.8, steps: 7, rise: 0.58, run: 0.84, dir: '-z', c: WOOD, mat: S.WOOD }));
  // Half-timbering: dark straps over the plaster. Pure decor, huge payoff.
  for (const hx of [-13, 13]) {
    for (const off of [-5.4, -1.8, 1.8, 5.4]) {
      add(D(hx + off, 0, -27.4, 0.34, 5.2, 0.16, TIMBER, { mat: S.WOOD, noShadow: true }));
    }
    add(D(hx, 2.5, -27.4, 16, 0.34, 0.16, TIMBER, { mat: S.WOOD, noShadow: true }));
  }

  add(house({ x: -34, z: -12, w: 13, d: 15, h: 4.8, wall: BLUE, roofC: ROOF_D, mat: S.PLASTER,
    doors: [{ side: 'e', at: 0, w: 3.2 }, { side: 'n', at: 0, w: 3 }] }));
  add(house({ x: -34, z: 14, w: 13, d: 15, h: 5.4, wall: GREEN, roofC: ROOF_R, mat: S.PLASTER,
    lip: 0.85, chimney: [4, -4, 2.4], doors: [{ side: 'e', at: 0, w: 3.2 }] }));
  add(stairs({ x: -26.2, z: 20, w: 3.0, steps: 10, rise: 0.58, run: 0.84, dir: '-x', c: STONE, mat: S.ROCK }));
  add(B(-34, 5.4, 20.0, 12, 0.4, 3.0, STONE, { roof: true, mat: S.ROCK }));

  add(house({ x: 34, z: -14, w: 13, d: 15, h: 5.4, wall: ROSE, roofC: ROOF_B, mat: S.PLASTER,
    lip: 0.85, chimney: [-4, 4, 2.4], doors: [{ side: 'w', at: 0, w: 3.2 }] }));
  add(ramp({ x: 26.2, z: -20, w: 3.0, dir: '+x', c: STONE, mat: S.ROCK, steps: 12, rise: 0.5, run: 0.74 }));
  add(B(34, 5.4, -20.0, 12, 0.4, 3.0, STONE, { roof: true, mat: S.ROCK }));
  add(house({ x: 34, z: 12, w: 13, d: 15, h: 4.8, wall: PLASTER, roofC: ROOF_D, mat: S.PLASTER,
    doors: [{ side: 'w', at: 0, w: 3.2 }, { side: 's', at: 0, w: 3 }] }));

  add(house({ x: -14, z: 34, w: 15, d: 13, h: 4.9, wall: ROSE, roofC: ROOF_R, mat: S.PLASTER,
    chimney: [5, -3, 2.4], doors: [{ side: 'n', at: 0, w: 3.4 }] }));
  add(house({ x: 14, z: 34, w: 15, d: 13, h: 4.9, wall: BLUE, roofC: ROOF_B, mat: S.PLASTER,
    chimney: [-5, -3, 2.4], doors: [{ side: 'n', at: 0, w: 3.4 }] }));
  add(B(0, 3.9, 28.4, 11, 0.34, 2.6, WOOD, { roof: true, mat: S.PLANK }));
  add(stairs({ x: 3.0, z: 25.4, w: 2.8, steps: 7, rise: 0.56, run: 0.84, dir: '+z', c: WOOD, mat: S.WOOD }));

  /* ── Fountain, wells, cover ──────────────────────────────────────────── */
  add(B(0, 0.24, 24, 7, 0.9, 7, STONE, { mat: S.ROCK }));
  add(D(0, 1.14, 24, 5.8, 0.08, 5.8, 0x3fa9d8, { mat: S.WATER, noShadow: true }));
  add(B(0, 1.14, 24, 1.6, 2.1, 1.6, STONE, { mat: S.ROCK }));
  add(D(0, 3.24, 24, 2.4, 0.3, 2.4, 0xd9b64a, { mat: S.NEON, noShadow: true }));
  add(B(0, 0.24, -24, 5, 1.0, 5, STONE, { mat: S.ROCK }));
  add(D(0, 1.24, -24, 4.2, 0.08, 4.2, 0x3fa9d8, { mat: S.WATER, noShadow: true }));
  add(cover(-20, 0.24, -20, 5, 1.2, STONE, S.ROCK, 1.3));
  add(cover(20, 0.24, 20, 5, 1.2, STONE, S.ROCK, 1.3));
  add(cover(20, 0.24, -20, 1.2, 5, STONE, S.ROCK, 1.3));
  add(cover(-20, 0.24, 20, 1.2, 5, STONE, S.ROCK, 1.3));
  add(barrel(-24, 0.24, -6), barrel(-25.1, 0.24, -5.2), barrel(-24.5, 1.59, -5.6));
  add(barrel(24, 0.24, 6, 0x4aae6a), barrel(25.1, 0.24, 5.2, 0x4aae6a));
  add(bench(-10, 20, 0), bench(10, -20, 0), bench(20, 10, 1), bench(-20, -10, 1));
  add(car(-24, 27, { rot: 1, c: 0xe8e2cf }));
  add(car(24, -27, { rot: 1, c: 0xd44b3c }));

  /* ── Lanes out of the square, and the countryside past them ──────────── */
  for (const [lx, lz, lw, ld] of [[0, -40, 12, 26], [0, 40, 12, 26], [-40, 0, 26, 12], [40, 0, 26, 12]]) {
    add(D(lx, 0, lz, lw, 0.14, ld, 0xb3ada1, { mat: S.TILE, noShadow: true }));
  }
  add(hedge({ axis: 'x', at: -44, from: -20, to: -8 }));
  add(hedge({ axis: 'x', at: 44, from: 8, to: 20 }));
  add(tree(-44, 26, { h: 6, r: 5 }), tree(44, -26, { h: 6, r: 5 }));
  add(tree(-30, 44, { h: 5.4, r: 4.6 }), tree(30, -44, { h: 5.4, r: 4.6 }));
  add(lamp(-9, -22, { dir: -1 }), lamp(9, 22, { dir: 1 }));
  add(lamp(-22, 9, { dir: -1 }), lamp(22, -9, { dir: 1 }));

  add(bounds(96));
  add(skyline(86, { count: 26, seed: 77, palette: [PLASTER, MUSTARD, ROSE, BLUE, GREEN], h: [7, 14], roofC: ROOF_R }));
  add(treeline(66, { count: 34, seed: 23, c: 0x3f8c3c }));

  return {
    id: 'burgtown', name: 'Burgtown',
    description: 'A cobbled market square under a clock tower. Stalls for cover, rooftops for the patient.',
    size: 96, tags: ['classic', 'rooftops'],
    sky: { top: 0x39b6e8, bottom: 0xbdeafc, haze: 0xe2f6ff, clouds: 0.7 },
    fog: { color: 0xd2edfb, near: 80, far: 235 },
    sun: { dir: [0.55, 0.78, 0.32], color: 0xfff4dc, intensity: 1.46 },
    ambient: { color: 0xc0e2f8, intensity: 0.8 },
    ground: { color: 0x74b552, size: 300, mat: S.GRASS },
    boxes,
    spawns: {
      ffa: [
        [-32, 0.4, -32, 0.8], [32, 0.4, -30, -2.4], [32, 0.4, 32, 3.6], [-32, 0.4, 32, -0.7],
        [0, 0.4, -42, 0], [0, 0.4, 42, Math.PI], [-42, 0.4, 4, 1.57], [42, 0.4, -4, -1.57],
        [11, 0.4, -18, 2.2], [-11, 0.4, 18, -0.9], [0, 6.4, 0, 0], [-13, 6.0, -34, 3.1],
      ],
      red: [[-4, 0.4, -44, 0], [4, 0.4, -44, 0], [-14, 0.4, -42, 0.3], [14, 0.4, -42, -0.3], [-13, 6.0, -34, 0]],
      blue: [[4, 0.4, 44, Math.PI], [-4, 0.4, 44, Math.PI], [14, 0.4, 42, 2.8], [-14, 0.4, 42, -2.8], [14, 5.7, 34, Math.PI]],
    },
    objectives: [
      { id: 'A', x: -34, y: 0.4, z: -12 },
      { id: 'B', x: 0, y: 6.1, z: 0 },
      { id: 'C', x: 34, y: 0.4, z: 12 },
    ],
  };
}

/**
 * CROSSFIRE — a new-build site on a Saturday morning.
 *
 * Rotationally symmetric, so both spawns are the same fight from the other
 * side. Three layers: a service trench under the middle, the yard, and a
 * scaffold ring overhead. Every high position has two ways up and at least one
 * angle that punishes camping it.
 */
function crossfire() {
  const CONC = 0xc9cdd2, DARKC = 0x8d939a, STEEL = 0xa7adb4, SCAFF = 0xe0a92e,
        BRICKC = 0xc4674a, TARP = 0x3fa9d8, TIMBER = 0xc79a52, HAZ = 0xf0c33c,
        WHITE = 0xeef1f4, GREENC = 0x46a05a;
  const boxes = [];
  const add = (...xs) => { for (const x of xs) boxes.push(...(Array.isArray(x) ? x : [x])); };

  /** One half of the map; the other half is this, rotated 180°. */
  const half = [];
  const h = (...xs) => { for (const x of xs) half.push(...(Array.isArray(x) ? x : [x])); };

  // ── The shell: a house that has its walls but not its cladding ──
  h(building({ x: -20, z: -16, w: 17, d: 14, h: 6.4, c: BRICKC, roofC: DARKC, mat: S.BRICK, lip: 1.0,
    doors: [{ side: 'e', at: -2, w: 4.4 }, { side: 's', at: 3, w: 3.6 }, { side: 'n', at: 0, w: 3 }] }));
  h(B(-20, 3.1, -20, 16.6, 0.35, 5.6, TIMBER, { roof: true, mat: S.PLANK }));
  h(stairs({ x: -27, z: -14.6, w: 2.6, steps: 6, rise: 0.52, run: 0.78, dir: '-z', c: SCAFF, mat: S.METAL }));
  h(B(-20, 3.45, -17.4, 16.6, 0.85, 0.25, SCAFF, { mat: S.METAL }));
  h(stairs({ x: -10.6, z: -22, w: 3, steps: 11, rise: 0.6, run: 0.85, dir: '-x', c: SCAFF, mat: S.METAL }));
  // Scaffold cladding down the outside — the shape that says "building site".
  for (const zz of [-21.5, -18, -14.5, -11]) {
    h(D(-28.7, 0, zz, 0.22, 6.4, 0.22, SCAFF, { mat: S.METAL, noShadow: true }));
  }
  h(D(-28.7, 3.1, -16, 0.3, 0.18, 12, SCAFF, { mat: S.METAL, noShadow: true }));
  h(D(-28.7, 5.6, -16, 0.3, 0.18, 12, SCAFF, { mat: S.METAL, noShadow: true }));
  h(D(-27.4, 6.6, -16, 3.0, 0.14, 13, TARP, { mat: S.CANVAS, noShadow: true }));

  // ── Corner cabin: low roof, quick to take, easy to shoot off ──
  h(building({ x: -24, z: 20, w: 11, d: 10, h: 3.4, c: WHITE, roofC: DARKC, mat: S.SIDING, lip: 0.8,
    doors: [{ side: 'e', at: 0, w: 3.4 }, { side: 'n', at: 2, w: 2.8 }] }));
  h(D(-24, 1.4, 15.1, 8, 1.3, 0.16, 0xffffff, { mat: S.WINDOW, noShadow: true }));
  h(ramp({ x: -17.6, z: 20, w: 3, dir: '-x', c: CONC, mat: S.CONCRETE, steps: 8, rise: 0.48, run: 0.8 }));

  // ── Side lane: long, but broken by three pieces of hard cover ──
  h(container(-30, 0, 2, 1, 0xd8402f));
  h(container(-30, 2.7, 2, 1, TARP));
  h(cover(-30, 0, -6, 3.4, 4.6, CONC, S.CONCRETE, 1.3));
  h(crates(-31, 0, 10, 2, 1.5, TIMBER));
  h(tree(-33, 16, { h: 5, r: 4.2 }));

  // ── Catwalk arm reaching from the shell toward the middle ──
  h(B(-9, 5.2, -16, 6.4, 0.35, 3.4, SCAFF, { roof: true, mat: S.GRATE }));
  h(B(-9, 5.55, -17.5, 6.4, 0.8, 0.2, SCAFF, { mat: S.METAL }));
  h(B(-9, 5.55, -14.5, 6.4, 0.8, 0.2, SCAFF, { mat: S.METAL }));
  h(B(-6, 0, -16, 0.5, 5.2, 0.5, SCAFF, { mat: S.METAL }));

  // ── Yard furniture ──
  h(crates(-13, 0, 6, 3, 1.45, TIMBER));
  h(crates(-10.4, 0, 6.4, 2, 1.45, TIMBER));
  h(barrel(-16, 0, -4, 0xf0c33c), barrel(-17.1, 0, -3.2, 0xf0c33c), barrel(-16.6, 1.35, -3.7, 0xf0c33c));
  h(cover(-6, 0, 14, 6.5, 1.3, CONC, S.CONCRETE, 1.3));
  h(B(-22, 0, 6, 1.1, 2.6, 7, CONC, { mat: S.CONCRETE }));
  h(B(-2, 0, -26, 8, 1.35, 1.1, HAZ, { mat: S.PAINT }));
  h(D(-2, 1.35, -26, 8.3, 0.14, 1.3, 0x2b2b2f, { mat: S.PAINT, noShadow: true }));
  h(dumpster(-33, -24, 0xd8402f));
  // Two steps of sand, both solid: a pile you can be shot off the top of is
  // worth having, and one you walk through is a hole in the map.
  h(B(-14, 0, -30, 9, 0.9, 6, 0xd9c08a, { mat: S.SAND, noShadow: true }));   // sand pile
  h(B(-14, 0.9, -30, 6, 0.7, 4, 0xd9c08a, { mat: S.SAND, noShadow: true }));
  h(lamp(-11.4, 26, { dir: 1, h: 6.8 }));

  // ── Entrance to the trench that crosses under the middle ──
  h(B(-8.2, 0, 0, 0.6, 2.4, 7.2, DARKC, { mat: S.CONCRETE }));
  h(stairs({ x: -12.4, z: 0, w: 4.4, steps: 5, rise: 0.5, run: 0.9, dir: '+x', c: DARKC, mat: S.CONCRETE }));

  add(half, rot180(half));

  // ── The middle: a scaffold deck with the trench running underneath ──
  add(B(0, 3.4, 0, 15, 0.5, 15, TIMBER, { roof: true, mat: S.PLANK }));
  for (const [px, pz] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) add(B(px, 0, pz, 1.1, 3.4, 1.1, SCAFF, { mat: S.METAL }));
  add(B(0, 3.9, -7.3, 15, 0.95, 0.25, SCAFF, { mat: S.METAL }));
  add(B(0, 3.9, 7.3, 15, 0.95, 0.25, SCAFF, { mat: S.METAL }));
  add(B(-7.3, 3.9, 0, 0.25, 0.95, 15, SCAFF, { mat: S.METAL }));
  add(B(7.3, 3.9, 0, 0.25, 0.95, 15, SCAFF, { mat: S.METAL }));
  add(stairs({ x: 8, z: -5.4, w: 3.2, steps: 7, rise: 0.5, run: 0.82, dir: '-x', c: SCAFF, mat: S.GRATE }));
  add(stairs({ x: -8, z: 5.4, w: 3.2, steps: 7, rise: 0.5, run: 0.82, dir: '+x', c: SCAFF, mat: S.GRATE }));
  add(crates(1.6, 3.9, -1.6, 2, 1.4, TIMBER));
  add(B(0, 0, -4.2, 9, 2.4, 0.6, DARKC, { mat: S.CONCRETE }));
  add(B(0, 0, 4.2, 9, 2.4, 0.6, DARKC, { mat: S.CONCRETE }));

  // ── Long-lane cover along the north and south edges ──
  add(cover(-8, 0, -32, 9, 1.4, CONC, S.CONCRETE, 1.35));
  add(cover(8, 0, 32, 9, 1.4, CONC, S.CONCRETE, 1.35));
  add(crates(20, 0, -31, 2, 1.5, TIMBER), crates(-20, 0, 31, 2, 1.5, TIMBER));
  add(barrel(26, 0, -30, TARP), barrel(27.1, 0, -29.2, TARP));
  add(barrel(-26, 0, 30, 0xd8402f), barrel(-27.1, 0, 29.2, 0xd8402f));
  add(B(33, 0, 0, 1.2, 3.2, 12, CONC, { mat: S.CONCRETE }));
  add(B(-33, 0, 0, 1.2, 3.2, 12, CONC, { mat: S.CONCRETE }));
  add(truck(30, 22, { rot: 1, c: HAZ, box: WHITE }));
  add(truck(-30, -22, { rot: 1, c: HAZ, box: WHITE }));

  // Site hoarding: waist-high panels marking the perimeter without hiding it.
  for (const sx of [-1, 1]) {
    add(fence({ axis: 'x', at: sx * 37, from: -37, to: 37, h: 1.9, c: TARP, post: 0x1f6e91,
      gaps: [[-8, 8]] }));
    add(fence({ axis: 'z', at: sx * 37, from: -37, to: 37, h: 1.9, c: TARP, post: 0x1f6e91,
      gaps: [[-8, 8]] }));
  }

  add(bounds(80));
  add(skyline(62, { count: 22, seed: 55, palette: [WHITE, BRICKC, GREENC, CONC], h: [8, 17], roofC: DARKC }));
  add(treeline(56, { count: 24, seed: 31, c: 0x449440 }));

  return {
    id: 'crossfire', name: 'Crossfire',
    description: 'A half-built street on three levels: trench, yard and scaffold. Rotationally symmetric.',
    size: 80, tags: ['small', 'vertical', 'competitive'],
    sky: { top: 0x35bce9, bottom: 0xb2e8fb, haze: 0xdcf4ff, clouds: 0.55 },
    fog: { color: 0xcdeefc, near: 78, far: 220 },
    sun: { dir: [0.62, 0.72, 0.42], color: 0xfff3d8, intensity: 1.44 },
    ambient: { color: 0xbfe4f8, intensity: 0.84 },
    ground: { color: 0xb0a98f, size: 280, mat: S.DIRT },
    boxes,
    spawns: {
      ffa: [
        [-30, 0.2, -30, 0.75], [30, 0.2, 30, -2.4], [30, 0.2, -30, -0.75], [-30, 0.2, 30, 2.4],
        [0, 0.2, -33, 0], [0, 0.2, 33, Math.PI], [-33, 0.2, 8, -1.57], [33, 0.2, -8, 1.57],
        [0, 4.1, 0, 0.9], [-20, 6.8, -16, 1.2], [20, 6.8, 16, -1.9], [-24, 3.9, 20, -1.4],
      ],
      red: [
        [-31, 0.2, -31, 0.75], [-27, 0.2, -34, 0.6], [-34, 0.2, -28, 0.95],
        [-20, 6.8, -16, 1.2], [-24, 0.2, -33, 1.1],
      ],
      blue: [
        [31, 0.2, 31, -2.4], [27, 0.2, 34, -2.55], [34, 0.2, 28, -2.2],
        [20, 6.8, 16, -1.9], [24, 0.2, 33, -2.05],
      ],
    },
    objectives: [
      { id: 'A', x: -20, y: 0.2, z: -16 },
      { id: 'B', x: 0, y: 3.9, z: 0 },
      { id: 'C', x: 20, y: 0.2, z: 16 },
    ],
  };
}

/**
 * SANDSTORM — a desert town around a dry fountain.
 *
 * Mirrored, so team play is fair by construction. Whitewashed adobe, striped
 * bazaar canvas, palms, and two compounds whose flat roofs are the long-range
 * game — reachable from the outside, so a sniper on one is a sniper everyone
 * can see climbing.
 */
function sandstorm() {
  const SAND = 0xf0dcae, WHITEW = 0xf6efe0, CLAY = 0xd08a4e, TERRA = 0xc4593a,
        DARK = 0x8d6440, ROCK = 0xd2c3a2, TEAL = 0x2fa79b, BLUE = 0x3d72c4,
        PALM = 0x4f9a44, AWNING = 0xd94f42;
  const boxes = [];
  const add = (...xs) => { for (const x of xs) boxes.push(...(Array.isArray(x) ? x : [x])); };

  /* ── Mirrored compounds ──────────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    add(house({
      x: s * 32, z: 0, w: 18, d: 22, h: 5.2, wall: WHITEW, roofC: CLAY, mat: S.PLASTER,
      roofMat: S.PLASTER, lip: 0.95, overhang: 0.5,
      doors: s < 0
        ? [{ side: 'e', at: -5, w: 3.4 }, { side: 'e', at: 6, w: 3.4 }, { side: 'n', at: 0, w: 3 }]
        : [{ side: 'w', at: -5, w: 3.4 }, { side: 'w', at: 6, w: 3.4 }, { side: 's', at: 0, w: 3 }],
      windows: [
        { side: 'n', at: -5 }, { side: 'n', at: 5 }, { side: 's', at: -5 }, { side: 's', at: 5 },
        { side: s < 0 ? 'w' : 'e', at: -7 }, { side: s < 0 ? 'w' : 'e', at: 0 }, { side: s < 0 ? 'w' : 'e', at: 7 },
      ],
    }));
    add(stairs({ x: s * 32, z: s * -13, w: 3.4, steps: 9, rise: 0.6, run: 0.9, dir: s < 0 ? '-z' : '+z', c: CLAY, mat: S.BRICK }));
    add(B(s * 32, 2.6, s * -7, 17, 0.35, 6, CLAY, { roof: true, mat: S.PLANK }));
    add(stairs({ x: s * 38, z: s * -3, w: 2.6, steps: 5, rise: 0.55, run: 0.8, dir: s < 0 ? '-z' : '+z', c: CLAY, mat: S.BRICK }));
    add(D(s * 41.5, 5.55, 0, 1.4, 2.4, 1.4, TERRA, { mat: S.PLASTER, noShadow: true }));     // roof water tank
    add(tree(s * 22, s * 16, { h: 6.4, r: 5, c: PALM, trunk: 0xa88a5c, kind: 'palm' }));
  }

  /* ── Central plaza, dry fountain, and the obelisk on top of it ───────── */
  add(B(0, 0, 0, 26, 0.22, 26, ROCK, { mat: S.TILE }));
  add(B(0, 0.22, 0, 14, 1.1, 14, ROCK, { mat: S.ROCK }));
  add(B(0, 1.32, 0, 10, 1.1, 10, ROCK, { mat: S.ROCK }));
  add(D(0, 2.42, 0, 8.6, 0.08, 8.6, 0x3fa9d8, { mat: S.WATER, noShadow: true }));
  add(B(0, 2.42, 0, 2.4, 6.2, 2.4, TERRA, { mat: S.BRICK }));
  add(D(0, 8.62, 0, 1.4, 1.4, 1.4, 0xe0b23a, { mat: S.NEON, noShadow: true }));
  add(ramp({ x: -12.5, z: 0, w: 4, dir: '+x', c: ROCK, mat: S.ROCK, steps: 9, rise: 0.26, run: 0.75 }));
  add(ramp({ x: 12.5, z: 0, w: 4, dir: '-x', c: ROCK, mat: S.ROCK, steps: 9, rise: 0.26, run: 0.75 }));
  add(cover(-4.6, 2.42, -4.6, 2.6, 2.6, ROCK, S.ROCK, 1.1));
  add(cover(4.6, 2.42, 4.6, 2.6, 2.6, ROCK, S.ROCK, 1.1));

  /* ── The bazaar: arches down the middle lanes, canvas between them ───── */
  for (const z of [-22, -8, 8, 22]) {
    add(B(-3.6, 0, z, 1.4, 4.2, 1.4, CLAY, { mat: S.BRICK }));
    add(B(3.6, 0, z, 1.4, 4.2, 1.4, CLAY, { mat: S.BRICK }));
    add(B(0, 4.2, z, 8.6, 0.7, 1.4, CLAY, { roof: true, mat: S.BRICK }));
  }
  for (const z of [-15, 15]) {
    add(D(0, 4.0, z, 8.6, 0.24, 12, AWNING, { mat: S.CANVAS, noShadow: true }));
  }
  add(stall(-12, -18, { c: AWNING }), stall(12, 18, { c: TEAL }));
  add(stall(12, -18, { c: 0xe0b23a }), stall(-12, 18, { c: BLUE }));

  /* ── Corner towers ───────────────────────────────────────────────────── */
  for (const [x, z] of [[-40, -38], [40, -38], [-40, 38], [40, 38]]) {
    add(house({ x, z, w: 10, d: 10, h: 6.6, wall: WHITEW, roofC: TERRA, mat: S.PLASTER,
      roofMat: S.PLASTER, lip: 0.95, overhang: 0.4,
      doors: [{ side: x < 0 ? 'e' : 'w', at: 0, w: 3 }],
      windows: [{ side: 'n', at: 0, y: 3.6 }, { side: 's', at: 0, y: 3.6 },
        { side: x < 0 ? 'w' : 'e', at: 0, y: 3.6 }] }));
    add(stairs({ x: x + (x < 0 ? 7 : -7), z, w: 3, steps: 11, rise: 0.62, run: 0.85, dir: x < 0 ? '-x' : '+x', c: DARK, mat: S.ROCK }));
  }

  /* ── Dunes, walls and cover ──────────────────────────────────────────── */
  add(crates(-16, 0, -26, 3, 1.5, 0xd4a765), crates(16, 0, 26, 3, 1.5, 0xd4a765));
  add(crates(18, 0, -20, 2, 1.5, 0xd4a765), crates(-18, 0, 20, 2, 1.5, 0xd4a765));
  add(B(-14, 0, 34, 12, 2.4, 2, ROCK, { mat: S.ROCK }), B(14, 0, -34, 12, 2.4, 2, ROCK, { mat: S.ROCK }));
  add(B(0, 0, -44, 24, 3, 2, ROCK, { mat: S.ROCK }), B(0, 0, 44, 24, 3, 2, ROCK, { mat: S.ROCK }));
  add(B(-46, 0, -18, 2, 3, 14, ROCK, { mat: S.ROCK }), B(46, 0, 18, 2, 3, 14, ROCK, { mat: S.ROCK }));
  add(B(-24, 0, -12, 2, 2.6, 9, WHITEW, { mat: S.PLASTER }), B(24, 0, 12, 2, 2.6, 9, WHITEW, { mat: S.PLASTER }));
  add(cover(-12, 0, -14, 5, 1.4, WHITEW, S.PLASTER), cover(12, 0, 14, 5, 1.4, WHITEW, S.PLASTER));
  add(barrel(-20, 0, 6, 0xd0563a), barrel(-21.1, 0, 6.9, 0xd0563a));
  add(barrel(20, 0, -6, TEAL), barrel(21.1, 0, -6.9, TEAL));
  add(car(-27, -30, { rot: 0, c: 0xe8e2cf }));
  add(car(27, 30, { rot: 0, c: 0xd0a03a }));
  add(truck(-4, -33, { rot: 1, c: TEAL, box: WHITEW }));
  for (const [tx, tz] of [[-34, 18], [34, -18], [-18, -34], [18, 34], [-44, 4], [44, -4]]) {
    add(tree(tx, tz, { h: 5.6 + (tx % 3), r: 4.6, c: PALM, trunk: 0xa88a5c, kind: 'palm' }));
  }

  add(bounds(104));
  add(skyline(74, { count: 24, seed: 91, palette: [WHITEW, SAND, CLAY, TERRA], h: [6, 13], mat: S.PLASTER, roofC: CLAY }));
  add(treeline(66, { count: 18, seed: 37, c: PALM, trunk: 0xa88a5c, kind: 'palm' }));

  return {
    id: 'sandstorm', name: 'Sandstorm',
    description: 'A whitewashed desert town around a dry fountain. Long sight lines, mirrored compounds.',
    size: 104, tags: ['team', 'long range'],
    sky: { top: 0x4fc0e4, bottom: 0xfae6bd, haze: 0xffeecb, clouds: 0.2 },
    fog: { color: 0xf2e2bd, near: 85, far: 245 },
    sun: { dir: [-0.4, 0.8, 0.46], color: 0xfff0cc, intensity: 1.6 },
    ambient: { color: 0xf0dcb4, intensity: 0.82 },
    ground: { color: 0xe0c48c, size: 320, mat: S.SAND },
    boxes,
    spawns: {
      ffa: [
        [-42, 0.2, -6, -1.57], [42, 0.2, 6, 1.57], [0, 0.2, -40, 0], [0, 0.2, 40, Math.PI],
        [-47, 0.2, -46, 0.8], [47, 0.2, -46, -0.8], [-47, 0.2, 46, 2.3], [47, 0.2, 46, -2.3],
        [-20, 0.2, 24, -0.6], [20, 0.2, -24, 2.5], [4, 2.7, 0, 1.2], [-26, 5.6, 0, -1.57],
      ],
      red: [[-44, 0.2, 0, -1.57], [-40, 0.2, -10, -1.3], [-40, 0.2, 10, -1.8], [-36, 5.6, 0, -1.57], [-48, 0.2, -32, -1.2]],
      blue: [[44, 0.2, 0, 1.57], [40, 0.2, 10, 1.3], [40, 0.2, -10, 1.8], [36, 5.6, 0, 1.57], [48, 0.2, 32, 1.2]],
    },
    objectives: [
      { id: 'A', x: -32, y: 0.2, z: 0 },
      { id: 'B', x: 0, y: 2.52, z: 3.4 },
      { id: 'C', x: 32, y: 0.2, z: 0 },
    ],
  };
}

/**
 * SHIPYARD — a working harbour on a clear morning.
 *
 * A grid of painted containers with a gantry over the middle and water down
 * the east side. Verticality everywhere and almost no interior: nearly every
 * fight here is decided by who took the high line first.
 */
function shipyard() {
  const RED = 0xd8402f, BLUE = 0x2f6fd0, GREEN = 0x37a05a, YEL = 0xe0b23a,
        STEEL = 0xb9bec6, DECK = 0x8b929b, WHITE = 0xeef1f4, ORANGE = 0xe07a33,
        WOODC = 0xc08a3c, HAZ = 0xf0c33c;
  const boxes = [];
  const add = (...xs) => { for (const x of xs) boxes.push(...(Array.isArray(x) ? x : [x])); };

  /* ── Container yard ──────────────────────────────────────────────────── */
  const palette = [RED, BLUE, GREEN, YEL, ORANGE];
  let n = 0;
  for (let gx = -3; gx <= 3; gx++) {
    for (let gz = -2; gz <= 2; gz++) {
      if (Math.abs(gx) <= 1 && Math.abs(gz) <= 1) continue;      // keep the centre open
      const x = gx * 11, z = gz * 12;
      const rot = (gx + gz) % 2 === 0 ? 0 : 1;
      add(container(x, 0, z, rot, palette[n % 5]));
      if ((gx * 7 + gz * 3) % 3 === 0) add(container(x + (rot ? 0 : 0.4), 2.7, z, rot, palette[(n + 2) % 5]));
      n++;
    }
  }
  // Painted lane markings on the concrete apron, so the grid reads as a yard.
  for (const gx of [-2, 0, 2]) {
    add(D(gx * 11 + 5.5, 0, 0, 0.3, 0.05, 62, HAZ, { mat: S.PAINT, noShadow: true }));
  }

  /* ── Central gantry: high ground with four ways up ───────────────────── */
  add(B(0, 6.2, 0, 26, 0.5, 9, DECK, { roof: true, mat: S.GRATE }));
  add(B(-13, 0, 0, 1.4, 6.2, 9, STEEL, { mat: S.METAL }), B(13, 0, 0, 1.4, 6.2, 9, STEEL, { mat: S.METAL }));
  add(B(0, 6.7, -4.4, 26, 1.1, 0.3, HAZ, { mat: S.PAINT }), B(0, 6.7, 4.4, 26, 1.1, 0.3, HAZ, { mat: S.PAINT }));
  add(stairs({ x: -19, z: 0, w: 3.2, steps: 11, rise: 0.58, run: 0.86, dir: '+x', c: STEEL, mat: S.GRATE }));
  add(stairs({ x: 19, z: 0, w: 3.2, steps: 11, rise: 0.58, run: 0.86, dir: '-x', c: STEEL, mat: S.GRATE }));
  add(B(0, 2.7, -8, 4, 0.4, 8, STEEL, { roof: true, mat: S.GRATE }));
  add(stairs({ x: 0, z: -13, w: 3.4, steps: 6, rise: 0.48, run: 0.9, dir: '+z', c: STEEL, mat: S.GRATE }));
  add(B(0, 3.1, -4.6, 4, 3.1, 0.4, STEEL, { mat: S.METAL }));
  add(stairs({ x: 0, z: -4.2, y: 2.7, w: 3, steps: 7, rise: 0.5, run: 0.62, dir: '+z', c: STEEL, mat: S.GRATE }));
  add(B(0, 2.7, 8, 4, 0.4, 8, STEEL, { roof: true, mat: S.GRATE }));
  add(stairs({ x: 0, z: 13, w: 3.4, steps: 6, rise: 0.48, run: 0.9, dir: '-z', c: STEEL, mat: S.GRATE }));
  add(stairs({ x: 0, z: 4.2, y: 2.7, w: 3, steps: 7, rise: 0.5, run: 0.62, dir: '-z', c: STEEL, mat: S.GRATE }));

  /* ── Warehouse on the west edge ──────────────────────────────────────── */
  add(house({ x: -38, z: -14, w: 18, d: 20, h: 7, wall: WHITE, roofC: DECK, mat: S.METAL,
    roofMat: S.METAL, lip: 1.0, overhang: 0.4,
    doors: [{ side: 'e', at: -4, w: 4 }, { side: 'e', at: 6, w: 4 }, { side: 's', at: 0, w: 4 }],
    windows: [{ side: 'n', at: -5, y: 4.4 }, { side: 'n', at: 0, y: 4.4 }, { side: 'n', at: 5, y: 4.4 },
      { side: 'w', at: -5, y: 4.4 }, { side: 'w', at: 5, y: 4.4 }] }));
  add(B(-38, 0, -24.3, 17, 1.2, 0.3, RED, { mat: S.PAINT, noShadow: true }));
  add(stairs({ x: -29, z: -22, w: 3, steps: 13, rise: 0.58, run: 0.8, dir: '-x', c: DECK, mat: S.GRATE }));
  add(B(-38, 3.4, -20, 17, 0.4, 6, DECK, { roof: true, mat: S.GRATE }));
  add(stairs({ x: -44, z: -16, w: 2.6, steps: 7, rise: 0.5, run: 0.72, dir: '-z', c: DECK, mat: S.GRATE }));

  /* ── Crane pad on the east edge, and the water behind it ─────────────── */
  add(B(38, 0, 16, 16, 5.4, 14, 0xc9cdd2, { mat: S.CONCRETE }));
  add(B(38, 5.4, 16, 3, 8, 3, YEL, { mat: S.PAINT }));
  add(B(30, 12.6, 16, 20, 0.6, 2.4, YEL, { roof: true, mat: S.GRATE }));
  add(D(38, 13.2, 16, 3.6, 2.4, 3.6, ORANGE, { mat: S.PAINT, noShadow: true }));
  add(stairs({ x: 29.4, z: 16, w: 3.2, steps: 10, rise: 0.56, run: 0.86, dir: '-x', c: DECK, mat: S.GRATE }));
  add(cover(38, 5.4, 9.6, 15, 1, HAZ, S.PAINT, 1.1));
  // Quay wall, then open water past the boundary — a horizon, not a fence.
  add(B(50, 0, 0, 2.2, 1.4, 96, 0xc9cdd2, { mat: S.CONCRETE }));
  add(D(88, -0.4, 0, 76, 0.5, 300, 0x2f9ac8, { mat: S.WATER, noShadow: true }));
  for (const bz of [-30, 6, 34]) {
    add(D(60, 0.1, bz, 14, 1.8, 6, WHITE, { mat: S.METAL, noShadow: true }));       // moored barges
    add(D(60, 1.9, bz, 5, 2.6, 4, BLUE, { mat: S.METAL, noShadow: true }));
  }

  /* ── Yard clutter ────────────────────────────────────────────────────── */
  add(crates(-8, 0, 26, 3, 1.4, WOODC), crates(8, 0, -26, 3, 1.4, WOODC));
  add(crates(-24, 0, 32, 2, 1.4, WOODC), crates(24, 0, -32, 2, 1.4, WOODC));
  add(barrel(-6, 0, -18, RED), barrel(-7.1, 0, -18.9, RED));
  add(barrel(6, 0, 18, BLUE), barrel(7.1, 0, 18.9, BLUE));
  add(barrel(-6.6, 1.35, -18.5, RED), barrel(6.6, 1.35, 18.5, BLUE));
  add(B(0, 0, -42, 26, 2.6, 1.4, HAZ, { mat: S.PAINT }), B(0, 0, 42, 26, 2.6, 1.4, HAZ, { mat: S.PAINT }));
  add(B(-44, 0, 26, 1.4, 2.6, 20, STEEL, { mat: S.METAL }), B(44, 0, -26, 1.4, 2.6, 20, STEEL, { mat: S.METAL }));
  add(truck(-16, 40, { rot: 0, c: BLUE, box: WHITE }));
  add(truck(16, -40, { rot: 0, c: RED, box: WHITE }));
  add(car(-40, 34, { rot: 1, c: WHITE }));
  for (const [lx, lz] of [[-22, -34], [22, 34], [-34, 22], [34, -22], [-46, -2], [46, 2]]) {
    add(lamp(lx, lz, { h: 8.5, dir: lx < 0 ? 1 : -1 }));
  }

  add(bounds(100));
  add(skyline(72, { count: 20, seed: 63, palette: [WHITE, STEEL, BLUE, DECK], h: [9, 20], mat: S.METAL, roofC: DECK }));

  return {
    id: 'shipyard', name: 'Shipyard',
    description: 'A painted container maze under a steel gantry, with the sea on one side.',
    size: 100, tags: ['vertical', 'industrial'],
    sky: { top: 0x2fb0e8, bottom: 0xb6e6fb, haze: 0xdff5ff, clouds: 0.6 },
    fog: { color: 0xc9ecfb, near: 82, far: 240 },
    sun: { dir: [0.3, 0.78, -0.56], color: 0xfff6e4, intensity: 1.42 },
    ambient: { color: 0xbfe2f8, intensity: 0.88 },
    ground: { color: 0xa8aeb6, size: 300, mat: S.CONCRETE },
    boxes,
    spawns: {
      ffa: [
        [-38, 0.2, 34, 0.6], [38, 0.2, -34, -2.5], [-38, 0.2, -34, 1.0], [38, 0.2, 34, -0.9],
        [0, 0.2, -40, 0], [0, 0.2, 40, Math.PI], [-44, 0.2, 0, -1.57], [44, 0.2, 0, 1.57],
        [-16, 0.2, 18, -0.5], [16, 0.2, -18, 2.6], [0, 7.0, 0, 1.57], [34, 5.8, 12, 3.1],
      ],
      red: [[-42, 0.2, 36, 0.7], [-36, 0.2, 30, 0.7], [-46, 0.2, 10, 1.0], [-38, 0.2, 40, 0.6], [-38, 7.8, -14, -1.57]],
      blue: [[42, 0.2, -36, -2.4], [36, 0.2, -30, -2.4], [46, 0.2, -10, -2.1], [38, 0.2, -40, -2.5], [42, 5.8, 20, 3.1]],
    },
    objectives: [
      { id: 'A', x: -38, y: 0.2, z: -14 },
      { id: 'B', x: 0, y: 6.7, z: 0 },
      { id: 'C', x: 38, y: 5.6, z: 11.5 },
    ],
  };
}

/**
 * SUBZERO — an alpine village after fresh snow.
 *
 * Small and fast: two cabins facing each other across a frozen pond, pines for
 * cover, and short enough rotations that you are never more than a few seconds
 * from the next fight. The best warm-up map in the rotation.
 */
function subzero() {
  const SNOW = 0xf6fbff, ICE = 0xcfe9ff, LOG = 0xb5773d, DARKLOG = 0x8a5528,
        PINE = 0x2f6b46, ROCK = 0xc3ccd6, RED = 0xd44b3c, BLUE = 0x3d72c4,
        WOODC = 0xc08a3c, LANTERN = 0xffe1a0;
  const boxes = [];
  const add = (...xs) => { for (const x of xs) boxes.push(...(Array.isArray(x) ? x : [x])); };

  /* ── The two cabins ──────────────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    add(house({
      x: 0, z: s * 18, w: 15, d: 13, h: 4.6, wall: LOG, roofC: SNOW, mat: S.WOOD,
      roofMat: S.SNOW, lip: 0.85, overhang: 0.9, chimney: [s * 5, 0, 2.4],
      doors: s < 0 ? [{ side: 's', at: 0, w: 3.4 }, { side: 'e', at: 0, w: 3 }]
        : [{ side: 'n', at: 0, w: 3.4 }, { side: 'w', at: 0, w: 3 }],
      windows: [{ side: 'n', at: -4 }, { side: 'n', at: 4 }, { side: 's', at: -4 }, { side: 's', at: 4 },
        { side: 'e', at: 0 }, { side: 'w', at: 0 }],
      porch: { side: s < 0 ? 's' : 'n', at: 0, w: 5.2, depth: 2.4, c: DARKLOG },
    }));
    add(stairs({ x: s * 8.4, z: s * 18, w: 3, steps: 8, rise: 0.6, run: 0.88, dir: s < 0 ? '-x' : '+x', c: DARKLOG, mat: S.WOOD }));
    add(D(0, 4.95, s * 24.5, 16.8, 0.5, 0.6, ICE, { mat: S.ICE, noShadow: true }));   // icicle fringe
    add(B(s * 9.6, 0, s * 22, 2.4, 1.9, 2.4, WOODC, { mat: S.PLANK }));               // log pile
  }

  /* ── Frozen pond in the middle ───────────────────────────────────────── */
  add(B(0, 0, 0, 20, 0.5, 20, ICE, { mat: S.ICE }));
  add(D(0, 0.5, 0, 18.6, 0.06, 18.6, 0xa8dcf6, { mat: S.ICE, noShadow: true }));
  add(B(0, 0.5, 0, 8, 1.7, 8, ROCK, { mat: S.ROCK }));
  add(B(0, 2.2, 0, 5.4, 0.4, 5.4, SNOW, { roof: true, mat: S.SNOW }));
  add(ramp({ x: -9.6, z: 0, w: 3.4, dir: '+x', c: ROCK, mat: S.ROCK, steps: 7, rise: 0.32, run: 0.7 }));
  add(ramp({ x: 9.6, z: 0, w: 3.4, dir: '-x', c: ROCK, mat: S.ROCK, steps: 7, rise: 0.32, run: 0.7 }));
  // A bonfire on the ice: the one warm thing on the map, and a landmark.
  add(D(0, 2.6, 0, 2.2, 0.4, 2.2, DARKLOG, { mat: S.WOOD, noShadow: true }));
  add(D(0, 3.0, 0, 1.4, 1.3, 1.4, 0xff9a3c, { mat: S.NEON, noShadow: true }));

  /* ── Rocks, pines and cover ──────────────────────────────────────────── */
  for (const [x, z] of [[-22, -8], [22, 8], [-18, 14], [18, -14], [-26, 20], [26, -20]]) {
    add(B(x, 0, z, 2.4, 3.4, 2.4, ROCK, { mat: S.ROCK }));
    add(B(x + 3, 0, z + 2, 1.7, 2.2, 1.7, ROCK, { mat: S.ROCK }));
    add(D(x, 3.4, z, 2.7, 0.3, 2.7, SNOW, { mat: S.SNOW, noShadow: true }));
  }
  for (const [x, z] of [[-12, -28], [12, 28], [-28, -24], [28, 24], [-30, 4], [30, -4], [-8, 30], [8, -30]]) {
    add(tree(x, z, { h: 6.4, r: 4.6, c: PINE, trunk: DARKLOG, kind: 'pine' }));
  }
  add(crates(-16, 0, 0, 3, 1.4, WOODC), crates(16, 0, 0, 3, 1.4, WOODC));
  add(B(-24, 0, -30, 12, 2.2, 1.2, SNOW, { mat: S.SNOW }), B(24, 0, 30, 12, 2.2, 1.2, SNOW, { mat: S.SNOW }));
  add(cover(-10, 0, -8, 4.4, 1.2, SNOW, S.SNOW), cover(10, 0, 8, 4.4, 1.2, SNOW, S.SNOW));
  add(fence({ axis: 'x', at: -31, from: -16, to: 16, h: 1.5, c: DARKLOG, post: 0x6d4320, gaps: [[-4, 4]] }));
  add(fence({ axis: 'x', at: 31, from: -16, to: 16, h: 1.5, c: DARKLOG, post: 0x6d4320, gaps: [[-4, 4]] }));

  /* ── Ski lift pylon: the map's only real height, and fully exposed ───── */
  add(B(-31, 0, -20, 1.4, 9, 1.4, 0xb9bec6, { mat: S.METAL }));
  add(B(-31, 0, 20, 1.4, 9, 1.4, 0xb9bec6, { mat: S.METAL }));
  for (const py of [-20, 20]) add(D(-31, 9, py, 5.4, 0.4, 1.2, 0xb9bec6, { mat: S.METAL, noShadow: true }));
  for (const off of [-1.9, 1.9]) {
    add(D(-31 + off, 9.2, 0, 0.18, 0.18, 40, 0x33363c, { mat: S.PAINT, noShadow: true }));
  }
  // A chair hanging off the cable, because an empty lift line is just a wire.
  add(D(-29.1, 8.1, -4, 0.16, 1.1, 0.16, 0x33363c, { mat: S.PAINT, noShadow: true }));
  add(D(-29.1, 7.2, -4, 1.5, 0.9, 1.3, 0xd44b3c, { mat: S.PAINT, noShadow: true }));
  add(car(-24, 30, { rot: 0, c: RED }));
  add(car(24, -30, { rot: 0, c: BLUE }));
  add(lamp(-14, -20, { h: 5.4, dir: 1, c: DARKLOG }), lamp(14, 20, { h: 5.4, dir: -1, c: DARKLOG }));
  add(D(-14, 4.7, -20, 0.9, 0.9, 0.9, LANTERN, { mat: S.NEON, noShadow: true }));
  add(D(14, 4.7, 20, 0.9, 0.9, 0.9, LANTERN, { mat: S.NEON, noShadow: true }));

  add(bounds(76));
  add(treeline(56, { count: 44, seed: 13, c: PINE, trunk: DARKLOG, kind: 'pine' }));
  // Mountains: three rings of pale wedges, drawn far enough out to sit in fog.
  for (const [mx, mz, mw, mh] of [
    [-70, -90, 60, 34], [20, -110, 80, 44], [95, -40, 55, 30],
    [80, 70, 70, 38], [-30, 105, 65, 32], [-105, 30, 58, 36],
  ]) {
    add(D(mx, 0, mz, mw, mh, mw * 0.7, 0xd8e8f6, { mat: S.SNOW, noShadow: true }));
    add(D(mx, mh, mz, mw * 0.5, mh * 0.4, mw * 0.36, 0xf4fbff, { mat: S.SNOW, noShadow: true }));
  }

  return {
    id: 'subzero', name: 'Subzero',
    description: 'A snowbound village around a frozen pond. Short rotations, constant contact.',
    size: 76, tags: ['small', 'fast'],
    sky: { top: 0x63b8e8, bottom: 0xe6f6ff, haze: 0xf6fcff, clouds: 0.85 },
    fog: { color: 0xe0f2ff, near: 60, far: 190 },
    sun: { dir: [-0.35, 0.84, -0.42], color: 0xf2f8ff, intensity: 1.34 },
    ambient: { color: 0xd6ecff, intensity: 0.9 },
    ground: { color: 0xeef6ff, size: 260, mat: S.SNOW },
    boxes,
    spawns: {
      ffa: [
        [-26, 0.2, -26, 0.8], [26, 0.2, 26, -2.4], [26, 0.2, -26, -0.8], [-26, 0.2, 26, 2.4],
        [0, 0.2, -30, 0], [0, 0.2, 30, Math.PI], [-30, 0.2, 0, -1.57], [30, 0.2, 0, 1.57],
        [0, 2.9, 0, 0.5], [-14, 0.2, 8, -1.2], [14, 0.2, -8, 1.9], [0, 5.1, 18, Math.PI],
      ],
      red: [[-28, 0.2, -26, 0.8], [-24, 0.2, -26, 0.7], [-30, 0.2, -18, 1.0], [0, 5.1, -18, 0], [-30, 0.2, 6, -1.4]],
      blue: [[28, 0.2, 26, -2.4], [24, 0.2, 26, -2.5], [30, 0.2, 18, -2.1], [0, 5.1, 18, Math.PI], [30, 0.2, -6, 1.7]],
    },
    objectives: [
      { id: 'A', x: 0, y: 0.2, z: -18 },
      { id: 'B', x: 0, y: 2.7, z: 0 },
      { id: 'C', x: 0, y: 0.2, z: 18 },
    ],
  };
}

/**
 * NOVA — a transit station on the night side, under a nebula.
 *
 * The biggest map in the game and the first one built as a *stack*: four floors
 * of walkable level over one plaza, each reachable from the others without a
 * lift, a ladder or a trick jump. The pitch is that you should never be able to
 * say where the fight is — it is on the deck, on the ring, on the spans and on
 * the crown at the same time, and the interesting decision is which of those
 * you want to be on.
 *
 * ── The four floors ────────────────────────────────────────────────────────
 *
 *   DECK    y = 0      The plaza. Two avenues crossing at the reactor, long
 *                      enough to see the length of the map down, broken every
 *                      few metres by cargo and pylons so no part of that length
 *                      is a corridor with nothing in it.
 *   RING    y = 6.95   A square walkway around the reactor bay, eight metres
 *                      wide, with four stair runs up from the avenues. It meets
 *                      the tower balconies and the hangar roofs, so the whole
 *                      mid-level is one loop you can run without touching the
 *                      floor — and nothing is over it, so the towers look down
 *                      on every step of it.
 *   SPAN    y = 13.35  Four tower roofs and the square of bridges joining them.
 *                      Sight lines the length of the map, almost no cover, and
 *                      a very long way down.
 *   CROWN   y = 20.5   One platform on top of the reactor spire. It sees
 *                      everything and everything sees it, and the only way up
 *                      is the spiral: six flights wrapped round the spire, each
 *                      exposed to a different quarter of the map.
 *
 * The spiral is the piece the layout hangs off. A map with a best perch and one
 * ladder to it is a map about who got there first; a map where the climb takes
 * eight seconds in the open, in view of four towers, is a map where the perch
 * is a bet. Nobody holds the crown for long. That is what it is for.
 *
 * ── Reading it in the dark ─────────────────────────────────────────────────
 *
 * Every walkable edge is lit and nothing else is. That is not decoration: it is
 * the job the bright roofs do on the town maps, moved to a level where there is
 * no sun to do it. Cyan is structure you can stand on. Magenta is the reactor
 * and the crown — the two things worth crossing the map for. White is the spawn
 * halls, and it is the only white light here, so a player who has lost their
 * bearings finds the way back by looking for the colour that means back.
 *
 * ── Symmetry ───────────────────────────────────────────────────────────────
 *
 * Rotational rather than mirrored: everything not already symmetric about the
 * origin is authored once and passed through `rot180`. Both teams therefore
 * play the same map from the same angle rather than a reflection of it, so a
 * route learned from one spawn is the same route from the other and no weapon
 * favours a side. The spiral is the one exception, and deliberately: it winds
 * one way, out of the middle of the map, which is the one place equidistant
 * from both spawns.
 */
function nova() {
  /*
   * Structure runs cold and unsaturated; the light is the only colourful thing
   * on the map. That is the only reason a hundred neon strips do not turn into
   * soup the moment you look at them together — every hue in the scene is
   * either one of the three lights or a shade of blue-grey that reads as none.
   */
  const DECKC = 0x3a465e, DARK = 0x222a3a, FRAME = 0x1a2030, PANEL = 0xa9b8d0,
        TRIM = 0x55637e, PLATE = 0x2d3648, GLASSC = 0x1b3350;
  /* The three lights, and they mean three different things — see the header. */
  const CYA = 0x4fe3ff, MAG = 0xff4fa3, WHT = 0xdfe8ff;

  const boxes = [];
  const add = (...xs) => { for (const x of xs) boxes.push(...(Array.isArray(x) ? x : [x])); };

  /* Heights every floor is measured from, so a change to one moves the level
   * that stands on it rather than leaving a step nobody meant to author. */
  const RY = 6.4, RTOP = RY + 0.55;               // ring slab, and its walking surface
  const SPAN = 12.8, SPANTOP = SPAN + 0.55;       // tower roofs and the bridges between
  const CROWN = 19.95, CROWNTOP = CROWN + 0.55;   // the platform on the spire

  /* ── The deck ──────────────────────────────────────────────────────────────
   * The plaza floor is the map's own ground plane, so there is no slab here —
   * only what is painted on it and what stands on it. The avenues are light,
   * not geometry: two lines crossing at the reactor that tell a player which
   * way is out from anywhere they happen to be standing.
   * ────────────────────────────────────────────────────────────────────────*/
  for (const off of [-7.4, 7.4]) {
    add(strip({ axis: 'z', at: off, from: -60, to: 60, c: CYA, t: 0.34, i: 1.5 }));
    add(strip({ axis: 'x', at: off, from: -60, to: 60, c: CYA, t: 0.34, i: 1.5 }));
  }
  // Cross-hatching under the ring, where the avenues open out into the bay.
  for (const z of [-46, -34, 34, 46]) {
    add(strip({ axis: 'x', at: z, from: -7.4, to: 7.4, c: CYA, t: 0.2, i: 1.1 }));
    add(strip({ axis: 'z', at: z, from: -7.4, to: 7.4, c: CYA, t: 0.2, i: 1.1 }));
  }
  // Deck plating, laid as broad panels so the floor is not one flat colour.
  for (const [px, pz] of [[-38, -38], [38, -38], [-38, 38], [38, 38]]) {
    add(D(px, 0.01, pz, 30, 0.04, 30, PLATE, { mat: S.TILE, noShadow: true }));
  }

  /* ── The reactor ───────────────────────────────────────────────────────────
   * Two steps up to a plinth, and a spire out of the middle of it that carries
   * the crown twenty metres overhead. It is the only thing on the map visible
   * from every square metre of it, which is the whole job: a player who is lost
   * looks up, finds the magenta, and knows which way the middle is.
   * ────────────────────────────────────────────────────────────────────────*/
  add(B(0, 0, 0, 26, 0.6, 26, DECKC, { roof: true, mat: S.TILE }));
  add(B(0, 0.6, 0, 20, 0.6, 20, DECKC, { roof: true, mat: S.TILE }));
  add(rimLight(0, 0.62, 0, 26, 26, MAG, 1.5));
  add(rimLight(0, 1.22, 0, 20, 20, MAG, 1.8));
  /*
   * The spire is four columns and a light, not a pillar.
   *
   * A solid twenty-metre block would have been simpler and it was the first
   * thing here, but it made the exact centre of the map the one square metre
   * nobody can stand on — which is a problem when the centre is where the
   * objective goes. Four columns carry the crown just as well, leave the core
   * walkable, and turn the landmark into something you can be *inside* rather
   * than something you walk around. The beam between them is decor: a bullet
   * passes straight through it, which is the only honest way to draw light.
   */
  for (const cx of [-3.4, 3.4]) {
    for (const cz of [-3.4, 3.4]) {
      add(B(cx, 1.2, cz, 2.6, 19.3, 2.6, DARK, { mat: S.METAL }));
      add(G(cx, 2.2, cz - 1.36, 1.4, 17.4, 0.1, MAG, 1.7));
      add(G(cx, 2.2, cz + 1.36, 1.4, 17.4, 0.1, MAG, 1.7));
    }
  }
  add(G(0, 1.25, 0, 2.6, 19.2, 2.6, MAG, 2.3));
  // Coolant bands, at the heights the spiral passes — so the climb has rungs to
  // measure itself against instead of twenty metres of the same wall. Decor, so
  // the core stays a place you can walk into from any side.
  for (const y of [4.4, 7.6, 10.8, 14.1, 17.3]) {
    add(D(0, y, 0, 9.4, 0.3, 1.2, PLATE, { mat: S.METAL, noShadow: true }));
    add(D(0, y, 0, 1.2, 0.3, 9.4, PLATE, { mat: S.METAL, noShadow: true }));
    add(G(0, y + 0.3, 0, 9.6, 0.1, 1.3, MAG, 1.5));
    add(G(0, y + 0.3, 0, 1.3, 0.1, 9.6, MAG, 1.5));
  }

  /* ── The spiral ────────────────────────────────────────────────────────────
   * Six flights and five landings wound one and a half times round the spire,
   * from the plinth to the crown. Two of the flights pass over two others, so
   * the middle of the map is genuinely layered rather than a staircase drawn on
   * a wall — and every flight faces a different quarter of the map, which is
   * what makes the climb a decision instead of a formality.
   * ────────────────────────────────────────────────────────────────────────*/
  {
    const step = { rise: 0.268, run: 1.0, steps: 12, w: 3.4, c: TRIM, mat: S.GRATE };
    const rise = step.rise * step.steps;          // 3.216 per flight
    const land = (x, z, top) => [
      B(x, top - 0.55, z, 4, 0.55, 4, TRIM, { roof: true, mat: S.GRATE }),
      ...rimLight(x, top + 0.01, z, 4, 4, CYA, 1.6),
    ];
    let y = 1.2;
    // 1 — north face, out of the plinth.
    add(stairs({ ...step, x: -6, z: -8, y, dir: '+x' }));
    y += rise; add(land(8, -8, y));
    // 2 — east face.
    add(stairs({ ...step, x: 8, z: -6, y, dir: '+z' }));
    y += rise; add(land(8, 8, y));
    // 3 — south face.
    add(stairs({ ...step, x: 6, z: 8, y, dir: '-x' }));
    y += rise; add(land(-8, 8, y));
    // 4 — west face.
    add(stairs({ ...step, x: -8, z: 6, y, dir: '-z' }));
    y += rise; add(land(-8, -8, y));
    // 5 — north face again, this time fourteen metres over the first flight.
    add(stairs({ ...step, x: -6, z: -8, y, dir: '+x' }));
    y += rise; add(land(8, -8, y));
    // 6 — east face again, arriving level with the crown.
    add(stairs({ ...step, x: 8, z: -6, y, dir: '+z' }));
    // The four columns the whole thing hangs off. They run the full height, so
    // the spiral reads as being carried rather than as floating.
    for (const [px, pz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) {
      add(pylon(px, pz, { y: 1.2, h: CROWNTOP - 1.2, r: 0.55, c: DARK, glowC: MAG, i: 1.2 }));
    }
  }

  /* ── The crown ───────────────────────────────────────────────────────────*/
  add(deck(0, CROWN, 0, 15, 15, { c: DARK, glowC: MAG, i: 2.0 }));
  // Parapet, with the corner the spiral arrives at left open.
  add(railRun({ axis: 'x', at: -7.3, from: -7.5, to: 7.5, y: CROWNTOP, c: DARK, glowC: MAG }));
  add(railRun({ axis: 'x', at: 7.3, from: -7.5, to: 7.5, y: CROWNTOP, c: DARK, glowC: MAG, gaps: [[5, 7.5]] }));
  add(railRun({ axis: 'z', at: -7.3, from: -7.5, to: 7.5, y: CROWNTOP, c: DARK, glowC: MAG }));
  add(railRun({ axis: 'z', at: 7.3, from: -7.5, to: 7.5, y: CROWNTOP, c: DARK, glowC: MAG, gaps: [[5, 7.5]] }));
  // A beacon on the very top, which is the thing you can see from the spawn.
  add(D(0, CROWNTOP, 0, 1.2, 2.4, 1.2, DARK, { mat: S.METAL }));
  add(G(0, CROWNTOP + 2.4, 0, 2.0, 1.2, 2.0, MAG, 2.6));

  /* ── The ring ──────────────────────────────────────────────────────────────
   * Four slabs making a square donut round the reactor bay: outer edge at 26,
   * inner at 18. Rails everywhere except the eight places something arrives,
   * because an edge with no rail on a twenty-metre map is a death nobody chose.
   * ────────────────────────────────────────────────────────────────────────*/
  add(B(0, RY, -22, 52, 0.55, 8, DECKC, { roof: true, mat: S.TILE }));
  add(B(0, RY, 22, 52, 0.55, 8, DECKC, { roof: true, mat: S.TILE }));
  add(B(-22, RY, 0, 8, 0.55, 36, DECKC, { roof: true, mat: S.TILE }));
  add(B(22, RY, 0, 8, 0.55, 36, DECKC, { roof: true, mat: S.TILE }));
  for (const sign of [-1, 1]) {
    add(strip({ axis: 'x', at: sign * 25.85, from: -26, to: 26, y: RTOP, c: CYA }));
    add(strip({ axis: 'z', at: sign * 25.85, from: -18, to: 18, y: RTOP, c: CYA }));
    add(strip({ axis: 'x', at: sign * 18.15, from: -18, to: 18, y: RTOP, c: CYA }));
    add(strip({ axis: 'z', at: sign * 18.15, from: -18, to: 18, y: RTOP, c: CYA }));
    // Outer rails: open at the avenue, where the stairs land, and at both
    // corners, where the tower balconies meet the ring.
    add(railRun({ axis: 'x', at: sign * 25.8, from: -26, to: 26, y: RTOP,
      gaps: [[-4, 4], [-26, -22], [22, 26]] }));
    add(railRun({ axis: 'z', at: sign * 25.8, from: -18, to: 18, y: RTOP,
      gaps: [[-4, 4]] }));
    // Inner rails: open only where the bay stairs arrive.
    add(railRun({ axis: 'x', at: sign * 18.2, from: -18, to: 18, y: RTOP, gaps: [[-3.5, 3.5]] }));
    add(railRun({ axis: 'z', at: sign * 18.2, from: -18, to: 18, y: RTOP, gaps: [[-3.5, 3.5]] }));
  }
  // What holds it up.
  for (const [px, pz] of [[-22, -22], [22, -22], [-22, 22], [22, 22],
    [0, -22], [0, 22], [-22, 0], [22, 0], [-12, -22], [12, -22], [-12, 22], [12, 22]]) {
    add(pylon(px, pz, { h: RY, r: 0.7, c: DARK, glowC: CYA, i: 1.2 }));
  }

  /* ── Getting up ────────────────────────────────────────────────────────────
   * Four runs from the avenues, outward and up, and four out of the reactor bay
   * itself. Eight ways onto the ring, all of them in the open — the mid-level
   * should be easy to reach and impossible to reach unseen.
   * ────────────────────────────────────────────────────────────────────────*/
  const flight = { w: 7, steps: 12, rise: 0.58, run: 0.72, c: TRIM, mat: S.GRATE };
  add(stairs({ ...flight, x: 0, z: -34.6, dir: '+z' }));
  add(stairs({ ...flight, x: 0, z: 34.6, dir: '-z' }));
  add(stairs({ ...flight, x: -34.6, z: 0, dir: '+x' }));
  add(stairs({ ...flight, x: 34.6, z: 0, dir: '-x' }));
  for (const sign of [-1, 1]) {
    add(strip({ axis: 'z', at: sign * 3.6, from: -34.6, to: -26, y: 0.1, c: CYA, i: 1.2 }));
    add(strip({ axis: 'z', at: sign * 3.6, from: 26, to: 34.6, y: 0.1, c: CYA, i: 1.2 }));
    add(strip({ axis: 'x', at: sign * 3.6, from: -34.6, to: -26, y: 0.1, c: CYA, i: 1.2 }));
    add(strip({ axis: 'x', at: sign * 3.6, from: 26, to: 34.6, y: 0.1, c: CYA, i: 1.2 }));
  }
  const bay = { w: 6, steps: 12, rise: 0.53, run: 0.68, y: 0.6, c: TRIM, mat: S.GRATE };
  add(stairs({ ...bay, x: 0, z: -10, dir: '-z' }));
  add(stairs({ ...bay, x: 0, z: 10, dir: '+z' }));
  add(stairs({ ...bay, x: -10, z: 0, dir: '-x' }));
  add(stairs({ ...bay, x: 10, z: 0, dir: '+x' }));

  /* ── The towers ────────────────────────────────────────────────────────────
   * One in each diagonal. A hall on the deck whose roof is the tower's balcony
   * and part of the mid-level loop, a smaller block on top of that, and the
   * roof of *that* is the span. Two floors, two ways up, and the outer stair is
   * on the outside where the rest of the map can watch it.
   * ────────────────────────────────────────────────────────────────────────*/
  const tower = (x, z, inward) => {
    const out = [];
    const sx = Math.sign(x), sz = Math.sign(z);
    // Ground hall, with its doors facing the middle of the map.
    out.push(...building({
      x, z, w: 22, d: 22, h: 6.6, c: DECKC, roofC: PLATE, mat: S.CONCRETE,
      roofMat: S.TILE, overhang: 3, t: 0.5,
      doors: [
        { side: sx > 0 ? 'w' : 'e', at: 0, w: 6 },
        { side: sz > 0 ? 'n' : 's', at: 0, w: 6 },
        { side: sx > 0 ? 'e' : 'w', at: 6, w: 4 },
      ],
    }));
    // Balcony trim and the rail round its outer two sides.
    out.push(...rimLight(x, RTOP + 0.01, z, 28, 28, CYA, 1.6));
    out.push(...railRun({ axis: 'x', at: z - sz * 14, from: x - 14, to: x + 14, y: RTOP,
      gaps: [[x - sx * 14, x - sx * 6]] }));
    out.push(...railRun({ axis: 'z', at: x - sx * 14, from: z - 14, to: z + 14, y: RTOP,
      gaps: [[z - sz * 14, z - sz * 6]] }));
    // Upper block. Smaller, so the balcony is a walkway round it rather than a
    // ledge — a roof you can only stand on the edge of is a roof nobody uses.
    out.push(...building({
      x, z, w: 13, d: 13, y: RTOP, h: SPAN - RTOP, c: PLATE, roofC: DECKC,
      mat: S.METAL, roofMat: S.TILE, t: 0.45,
      doors: [{ side: sx > 0 ? 'w' : 'e', at: 0, w: 4 }],
    }));
    out.push(...windows(x - sx * 6.6, RTOP, z, { w: 11, axis: 'z', floors: 2, pitch: 2.6, glowC: CYA }));
    out.push(...windows(x, RTOP, z - sz * 6.6, { w: 11, axis: 'x', floors: 2, pitch: 2.6, glowC: CYA }));
    // The stair up to the span, on the outer face.
    out.push(...stairs({
      x: x + sx * 8.4, z: z + sz * 4.2, w: 4, steps: 12, rise: 0.535, run: 0.8,
      dir: sz > 0 ? '+z' : '-z', y: RTOP, c: TRIM, mat: S.GRATE,
    }));
    // Span parapet, open where the bridges leave and where the stair arrives.
    out.push(...rimLight(x, SPANTOP + 0.01, z, 13.5, 13.5, CYA, 1.8));
    out.push(...railRun({ axis: 'x', at: z - sz * 6.5, from: x - 6.5, to: x + 6.5, y: SPANTOP,
      gaps: [[x - 3, x + 3]] }));
    out.push(...railRun({ axis: 'x', at: z + sz * 6.5, from: x - 6.5, to: x + 6.5, y: SPANTOP,
      gaps: [[x + sx * 5.4, x + sx * 11]] }));
    out.push(...railRun({ axis: 'z', at: x - sx * 6.5, from: z - 6.5, to: z + 6.5, y: SPANTOP,
      gaps: [[z - 3, z + 3]] }));
    out.push(...railRun({ axis: 'z', at: x + sx * 6.5, from: z - 6.5, to: z + 6.5, y: SPANTOP }));
    // Silhouette. Nothing to stand on, and the point of it is the sky.
    out.push(...mast(x + sx * 4.6, z + sz * 4.6, { y: SPANTOP, h: 13, c: FRAME, glowC: MAG }));
    out.push(...holo(x - sx * 11.2, RTOP + 2.4, z, { w: 9, h: 4.2, axis: 'z', c: inward }));
    return out;
  };
  const nw = tower(-36, -36, CYA), ne = tower(36, -36, MAG);
  add(nw, ne, rot180(nw), rot180(ne));

  /* ── The spans ────────────────────────────────────────────────────────────
   * A square of bridges joining the four tower roofs, forty metres up in the
   * corners of the map. It is the only route that never touches the middle, so
   * it is the flanking lane — and it is also the most exposed place to be
   * standing on the whole map, which is the trade.
   * ────────────────────────────────────────────────────────────────────────*/
  for (const sign of [-1, 1]) {
    add(bridge({ axis: 'x', at: sign * 36, from: -30, to: 30, y: SPAN, w: 5,
      c: PLATE, glowC: CYA, legTo: 0 }));
    add(bridge({ axis: 'z', at: sign * 36, from: -30, to: 30, y: SPAN, w: 5,
      c: PLATE, glowC: CYA, legTo: 0 }));
  }

  /* ── The hangars ──────────────────────────────────────────────────────────
   * Two sheds on the east and west edges, open toward the middle. Their roofs
   * are at ring height and touch the tower balconies, which is what closes the
   * mid-level into a loop; underneath them is the only genuinely enclosed
   * fighting space on the map, which a level of this much open air needs.
   * ────────────────────────────────────────────────────────────────────────*/
  const hangar = (x) => {
    const out = [];
    const sx = Math.sign(x);
    out.push(...building({
      x, z: 0, w: 18, d: 50, h: 6.4, c: PLATE, roofC: DECKC, mat: S.METAL,
      roofMat: S.TILE, t: 0.5, overhang: 1,
      doors: [
        { side: sx > 0 ? 'w' : 'e', at: -14, w: 7 },
        { side: sx > 0 ? 'w' : 'e', at: 14, w: 7 },
        { side: 'n', at: 0, w: 8 }, { side: 's', at: 0, w: 8 },
      ],
    }));
    out.push(...rimLight(x, RTOP + 0.01, 0, 20, 52, CYA, 1.6));
    out.push(...railRun({ axis: 'z', at: x + sx * 10, from: -26, to: 26, y: RTOP }));
    out.push(...railRun({ axis: 'z', at: x - sx * 10, from: -26, to: 26, y: RTOP,
      gaps: [[-4, 4]] }));
    // Roof stair, off the deck at the middle of the inner face.
    out.push(...stairs({
      x: x - sx * 11.6, z: 0, w: 5, steps: 12, rise: 0.58, run: 0.72,
      dir: sx > 0 ? '+x' : '-x', c: TRIM, mat: S.GRATE,
    }));
    // Connectors to the tower balconies, north and south — this is the join
    // that turns the mid-level from four platforms into one circuit.
    for (const sz of [-1, 1]) {
      out.push(...deck(x + sx * 2, RY, sz * 27, 12, 8, { c: PLATE, glowC: CYA, rail: 0 }));
      out.push(...railRun({ axis: 'z', at: x + sx * 8, from: sz * 23, to: sz * 31, y: RTOP }));
    }
    // Inside: cargo, and a lit gantry over it so the interior is not a cave.
    for (const cz of [-18, -6, 6, 18]) {
      out.push(...pod(x - sx * 4, cz, { w: 3.2, d: 4.4, h: 1.5, c: DECKC, glowC: CYA }));
    }
    out.push(strip({ axis: 'z', at: x, from: -24, to: 24, y: 5.4, c: WHT, t: 0.5, i: 1.4 }));
    out.push(...holo(x - sx * 8.6, 3.4, 14, { w: 8, h: 3, axis: 'z', c: CYA }));
    return out;
  };
  add(hangar(-48), hangar(48));

  /* ── The spawn halls ──────────────────────────────────────────────────────
   * Open-fronted, roofed, and the only white light on the map. A player who
   * spawns is looking down the long avenue at the reactor with the crown over
   * it, which tells them where they are and which way is forward in one frame.
   * ────────────────────────────────────────────────────────────────────────*/
  const hall = () => {
    const out = [];
    out.push(...building({
      x: 0, z: -54, w: 30, d: 16, h: 6.4, c: DECKC, roofC: PLATE, mat: S.CONCRETE,
      roofMat: S.TILE, t: 0.5, overhang: 1,
      // One wide mouth facing the map, and a side door out of each flank. The
      // wide one is what makes the spawn read as a starting line rather than as
      // a room: everything a player needs to see is framed by it before they
      // have taken a step.
      doors: [{ side: 's', at: 0, w: 16 },
        { side: 'w', at: 0, w: 5 }, { side: 'e', at: 0, w: 5 }],
    }));
    out.push(...rimLight(0, RTOP + 0.01, -54, 32, 18, WHT, 1.5));
    out.push(strip({ axis: 'x', at: -54, from: -14, to: 14, y: 5.2, c: WHT, t: 0.6, i: 1.5 }));
    out.push(strip({ axis: 'x', at: -46.4, from: -15, to: 15, y: 0.06, c: WHT, t: 0.5, i: 1.4 }));
    out.push(...holo(0, 2.6, -46.2, { w: 12, h: 3.4, axis: 'x', c: WHT, i: 1.7 }));
    // Cover immediately outside the door, so a spawn is never a shooting
    // gallery for whoever happens to be looking down the avenue.
    out.push(...pod(-11, -42, { w: 4, d: 3, h: 1.4, c: DECKC, glowC: WHT }));
    out.push(...pod(11, -42, { w: 4, d: 3, h: 1.4, c: DECKC, glowC: WHT }));
    out.push(...pylon(-16, -47, { h: 7, r: 0.7, c: DARK, glowC: WHT, i: 1.3 }));
    out.push(...pylon(16, -47, { h: 7, r: 0.7, c: DARK, glowC: WHT, i: 1.3 }));
    return out;
  };
  const red = hall();
  add(red, rot180(red));

  /* ── Cover ─────────────────────────────────────────────────────────────────
   * Authored once for the north-west and north-east of the deck and rotated,
   * so the two halves are identical fights. Everything here is knee to chest
   * high: on a map with four floors, anything taller starts blocking a sight
   * line that another floor depends on.
   * ────────────────────────────────────────────────────────────────────────*/
  const clutter = () => {
    const out = [];
    for (const [px, pz] of [[-14, -32], [-20, -30], [-26, -40], [-32, -30],
      [-13, -46], [-24, -50], [-33, -44], [-40, -30], [-30, -20], [-40, -14],
      [-50, -32], [-16, -20], [-12, -12]]) {
      out.push(...pod(px, pz, { c: DECKC, glowC: CYA }));
    }
    for (const [px, pz, w, d] of [[-22, -22, 6, 1.4], [-30, -36, 1.4, 7],
      [-42, -22, 7, 1.4], [-18, -44, 1.4, 6]]) {
      out.push(B(px, 0, pz, w, 1.25, d, PLATE, { mat: S.CONCRETE }));
      out.push(G(px, 1.25, pz, w + 0.06, 0.09, d + 0.06, CYA, 1.4));
    }
    out.push(...pylon(-16, -16, { h: 5.4, r: 0.8, c: DARK, glowC: MAG, i: 1.4 }));
    out.push(...pylon(-46, -46, { h: 7.5, r: 0.9, c: DARK, glowC: CYA, i: 1.4 }));
    out.push(...holo(-30, 2.8, -12, { w: 8, h: 3.4, axis: 'x', c: MAG }));
    return out;
  };
  const nwClutter = clutter();
  const neClutter = nwClutter.map((b) => ({ ...b, x: -b.x }));
  add(nwClutter, neClutter, rot180(nwClutter), rot180(neClutter));

  /* ── Past the edge ────────────────────────────────────────────────────────
   * The invisible boundary, and then a city that keeps going without us. Every
   * one of these is decor: the point of the skyline is that the map does not
   * end at a wall, it ends at a line you bump into once and stop thinking
   * about — and at night a far-off tower with a light on it does that job far
   * better than a near one with detail on it.
   * ────────────────────────────────────────────────────────────────────────*/
  add(bounds(128, 46));
  add(skyline(96, { count: 34, seed: 137, palette: [FRAME, DARK, PLATE], h: [14, 46],
    mat: S.METAL, roofC: FRAME }));
  add(skyline(150, { count: 26, seed: 211, palette: [FRAME, 0x141a26], h: [22, 62],
    mat: S.METAL, roofC: FRAME }));
  // Beacons out in the city, at the top of the nearer towers.
  {
    let seed = 4919;
    const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2545f491) + 0x9e3779b9) >>> 0) / 4294967296);
    for (let i = 0; i < 22; i++) {
      const ang = (i / 22) * Math.PI * 2 + rnd() * 0.3;
      const dist = 96 + rnd() * 46;
      add(G(Math.cos(ang) * dist, 16 + rnd() * 34, Math.sin(ang) * dist, 2.2, 2.2, 2.2,
        rnd() > 0.5 ? MAG : CYA, 2.2));
    }
  }

  return {
    id: 'nova', name: 'Nova',
    description: 'A night station under a pink-and-blue nebula. Four floors of it, '
      + 'and a spiral up the reactor to the platform that sees all of them.',
    size: 128, tags: ['large', 'vertical', 'night', 'futuristic'],
    /*
     * The sky is a shader here rather than a painted dome — `sky.nebula` is
     * what switches the renderer over (client/js/world.js, `_buildNebulaSky`).
     * Two gas fields drift past each other, stars twinkle behind them and a
     * meteor crosses every few seconds, all of it derived from one clock so
     * every screen in the match is looking at the same sky.
     */
    sky: {
      top: 0x070a1a, bottom: 0x2a1042, haze: 0x3d1a55,
      nebula: { warm: 0xff4fa3, cool: 0x3f86ff, density: 1.05, speed: 1 },
    },
    fog: { color: 0x1d1533, near: 78, far: 260 },
    /*
     * There is no sun. What this is, is the nebula: a broad cool light from
     * high and behind, dim enough to read as night and directional enough that
     * every box still has a lit face and a dark one — without which a map made
     * of boxes is a map made of silhouettes.
     */
    sun: { dir: [-0.32, 0.86, 0.4], color: 0x9db4ff, intensity: 0.92 },
    /*
     * …and the ambient carries the rest, which is where a night map is won or
     * lost. Too little and the level is unreadable; too much and the neon stops
     * being the brightest thing in the frame and the whole art direction goes
     * with it. This sits just under the point where the strips stop reading as
     * light sources.
     */
    ambient: { color: 0x6f63b4, intensity: 1.05 },
    ground: { color: 0x171d2b, size: 420, mat: S.TILE },
    boxes,
    /*
     * Every one of these faces the reactor.
     *
     * `yaw` is Math.atan2(x, z) for a body at (x, z) looking at the origin —
     * the movement code's own convention, where a yaw of zero looks down -Z. A
     * spawn is a player's first frame of the match, and pointing it at the one
     * landmark on the map is the difference between knowing where you are
     * immediately and turning on the spot to find out.
     */
    spawns: {
      ffa: [
        [0, 0.3, -50, Math.PI], [0, 0.3, 50, 0], [-50, 0.3, 0, -1.571], [50, 0.3, 0, 1.571],
        [-36, RTOP + 0.2, -36, -2.356], [36, RTOP + 0.2, 36, 0.785],
        [36, RTOP + 0.2, -36, 2.356], [-36, RTOP + 0.2, 36, -0.785],
        [-44, 0.3, -12, -1.834], [44, 0.3, 12, 1.307],
        [0, RTOP + 0.2, -22, Math.PI], [0, RTOP + 0.2, 22, 0],
      ],
      red: [
        [-6, 0.3, -52, 3.03], [6, 0.3, -52, -3.03], [-11, 0.3, -47, 2.91], [11, 0.3, -47, -2.91],
        [-36, RTOP + 0.2, -36, -2.356],
      ],
      blue: [
        [6, 0.3, 52, 0.115], [-6, 0.3, 52, -0.115], [11, 0.3, 47, 0.23], [-11, 0.3, 47, -0.23],
        [36, RTOP + 0.2, 36, 0.785],
      ],
    },
    /*
     * A and C sit out on the deck by the hangars, where the fight is a normal
     * one; B is the reactor plinth, which anybody can reach from any of the
     * four avenues and nobody can hold, because four floors are looking down
     * into it. That is deliberately the least defensible point on the map.
     */
    objectives: [
      { id: 'A', x: -38, y: 0.2, z: -18 },
      { id: 'B', x: 0, y: 1.4, z: 0 },
      { id: 'C', x: 38, y: 0.2, z: 18 },
    ],
  };
}

/**
 * RANGE — the practice map. No enemies unless you ask for them: a firing line,
 * a movement course and a wall of targets to learn a spray pattern against.
 */
function range() {
  const DECK = 0xc9cdd2, WALL = 0xdfe3e8, ACCENT = 0xf0a92e, DARK = 0x8d939a,
        GREENC = 0x63b544, WOODC = 0xc08a3c;
  const boxes = [];
  const add = (...xs) => { for (const x of xs) boxes.push(...(Array.isArray(x) ? x : [x])); };

  // Firing line: a raised deck with a counter to shoot across.
  add(B(0, 0, 20, 36, 0.4, 4.2, DECK, { roof: true, mat: S.TARMAC }));
  add(B(0, 0.4, 18.2, 36, 1.05, 0.7, DARK, { mat: S.CONCRETE }));
  add(D(0, 1.45, 18.2, 36, 0.14, 1.0, WOODC, { mat: S.PLANK, noShadow: true }));
  add(D(0, 3.4, 20.6, 36, 0.3, 5.4, 0x3fa9d8, { mat: S.CANVAS, noShadow: true }));
  // No post on the centre line: that is where the middle lane spawns.
  for (const px of [-16, -8, 8, 16]) add(B(px, 0.4, 22.4, 0.26, 3.0, 0.26, DECK, { mat: S.METAL }));

  // Lane dividers and distance markers down the range.
  for (const lx of [-15, -5, 5, 15]) {
    add(D(lx, 0, 0, 0.3, 0.06, 44, 0xf0efe6, { mat: S.PAINT, noShadow: true }));
  }
  for (const [i, z] of [8, -2, -12, -22].entries()) {
    add(B(-19, 0, z, 0.4, 1.6, 0.4, ACCENT, { mat: S.PAINT }));
    add(B(19, 0, z, 0.4, 1.6, 0.4, ACCENT, { mat: S.PAINT }));
    add(D(-19, 1.6, z, 1.6, 0.7, 0.2, 0xf7f7f2, { mat: S.NEON, noShadow: true }));
    add(D(19, 1.6, z, 1.6, 0.7, 0.2, 0xf7f7f2, { mat: S.NEON, noShadow: true }));
    void i;
  }

  // Target berm at the far end, with alcoves so shots have somewhere to land.
  add(B(0, 0, -28, 36, 6, 1.2, WALL, { mat: S.CONCRETE }));
  add(B(0, 0, -26.4, 36, 1.4, 2.2, 0xd9c08a, { mat: S.SAND, noShadow: true }));
  for (const x of [-10, -5, 0, 5, 10]) {
    add(B(x, 0.6, -27.4, 1.8, 1.8, 0.5, ACCENT, { mat: S.PAINT }));
    add(D(x, 1.0, -27.7, 1.0, 1.0, 0.1, 0xf7f7f2, { mat: S.PAINT, noShadow: true }));
  }

  // Movement course: a stair, two gaps to jump and a slide-under.
  add(stairs({ x: 24, z: 6, w: 4, steps: 8, rise: 0.55, run: 0.9, dir: '-z', c: DECK, mat: S.CONCRETE }));
  add(B(24, 4.4, -3, 4, 0.4, 6, DECK, { roof: true, mat: S.GRATE }));
  add(B(24, 4.4, -13, 4, 0.4, 6, DECK, { roof: true, mat: S.GRATE }));
  add(B(24, 4.4, -22, 4, 0.4, 6, DECK, { roof: true, mat: S.GRATE }));
  add(B(-24, 0, -2, 6, 2.2, 0.6, DARK, { mat: S.CONCRETE }));
  add(B(-24, 2.8, -2, 6, 3, 0.6, DARK, { mat: S.CONCRETE }));
  add(B(-24, 0, -10, 6, 2.2, 0.6, DARK, { mat: S.CONCRETE }));
  add(B(-24, 2.8, -10, 6, 3, 0.6, DARK, { mat: S.CONCRETE }));
  add(crates(-27, 0, 8, 3, 1.4, WOODC));
  add(crates(27, 0, 14, 2, 1.4, WOODC));

  // Dressing: it is a range, not a bunker.
  add(lawn(0, 0, 70, 60, GREENC));
  add(fence({ axis: 'x', at: 26, from: -30, to: 30, h: 1.5, c: 0xc4762d, gaps: [[-4, 6]] }));
  add(fence({ axis: 'z', at: -30, from: -26, to: 26, h: 1.5, c: 0xc4762d }));
  add(fence({ axis: 'z', at: 30, from: -26, to: 26, h: 1.5, c: 0xc4762d }));
  for (const [tx, tz] of [[-28, 22], [28, 24], [-30, -20], [30, -24]]) add(tree(tx, tz, { h: 5.4, r: 4.4 }));
  add(billboard(0, 25.4, { rot: 0, w: 9, h: 2.6, y: 3.6, c: 0x3fa9d8 }));

  add(bounds(64));
  add(treeline(48, { count: 26, seed: 5, c: 0x3f8c3c }));

  return {
    id: 'range', name: 'Practice Range',
    description: 'Targets, a movement course and a live accuracy readout. No clock.',
    size: 64, tags: ['practice'], practice: true,
    sky: { top: 0x35bce9, bottom: 0xb2e8fb, haze: 0xdcf4ff, clouds: 0.4 },
    fog: { color: 0xcdeefc, near: 70, far: 200 },
    sun: { dir: [0.4, 0.86, 0.3], color: 0xfff8ea, intensity: 1.4 },
    ambient: { color: 0xc4e6fa, intensity: 0.95 },
    ground: { color: 0x74b552, size: 220, mat: S.GRASS },
    boxes,
    spawns: {
      ffa: [[0, 0.55, 21, 0], [-6, 0.55, 21, 0], [6, 0.55, 21, 0], [-12, 0.55, 21, 0], [12, 0.55, 21, 0]],
      red: [[-6, 0.55, 21, 0]],
      blue: [[6, 0.55, 21, 0]],
    },
    /** Static targets the server scores hits on. */
    targets: [
      { x: -10, y: 1.5, z: -27 }, { x: -5, y: 1.5, z: -27 }, { x: 0, y: 1.5, z: -27 },
      { x: 5, y: 1.5, z: -27 }, { x: 10, y: 1.5, z: -27 },
    ],
  };
}

/* ── Registry ────────────────────────────────────────────────────────────── */

const _cache = new Map();
const BUILDERS = { littletown, burgtown, sandstorm, shipyard, subzero, crossfire, nova, range };

/** Maps that appear in normal rotation (the range is opt-in only). */
export const MAP_IDS = ['littletown', 'burgtown', 'crossfire', 'sandstorm', 'shipyard', 'subzero', 'nova'];
export const ALL_MAP_IDS = Object.keys(BUILDERS);

/** Build (and memoise) a map by id. */
export function getMap(id) {
  if (!BUILDERS[id]) id = 'littletown';
  if (!_cache.has(id)) {
    const m = BUILDERS[id]();
    m.solids = m.boxes.filter((b) => !b.decor);
    _cache.set(id, m);
  }
  return _cache.get(id);
}

/** Lightweight listing for menus / the API. */
export const mapList = () => ALL_MAP_IDS.map((id) => {
  const m = getMap(id);
  return {
    id: m.id, name: m.name, description: m.description, size: m.size,
    tags: m.tags ?? [], practice: !!m.practice, rotation: MAP_IDS.includes(id),
  };
});
