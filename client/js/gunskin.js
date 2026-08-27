/**
 * Open Grunker — weapon finishes.
 *
 * A skin used to be one colour multiplied over every part of a gun, which is
 * why none of them read as anything: the wood, the steel and the polymer all
 * came out the same shade, and "Woodland" and "Crimson" were the same rifle
 * dipped in different paint. A finish here is three things instead.
 *
 *   **Zones.** Every model part declares which piece of the gun it is (see
 *   `ZONE` in shared/weapons.js) and a skin paints zones, not weapons. Gold
 *   Rush gilds the receiver and leaves the butt pad black rubber; Carbon Fibre
 *   weaves the furniture and leaves the barrel blued. Lenses, reticles and
 *   brass are in a zone no skin may touch, so a gold rifle still has glass in
 *   its optic.
 *
 *   **Pattern.** A canvas-painted, seamless tile per (skin, zone) — camouflage,
 *   carbon weave, engraved scroll, a circuit trace. Nothing is fetched: the
 *   whole set is a few dozen 128px canvases drawn once and uploaded once.
 *
 *   **Finish.** Gloss and an optional emissive rim, layered on top of the
 *   material's own shading so polished gold and matte olive drab are lit
 *   differently rather than tinted differently.
 *
 * Both the first-person viewmodel and the third-person body build from this, so
 * the finish somebody bought is the finish everybody else sees them carrying.
 */
import * as THREE from 'three';
import { MAT, paintFor } from '/shared/weapons.js';

const TILE = 128;

/** Shading per model material — this is what separates steel from polymer. */
export const FINISH = {
  [MAT.METAL]: { shininess: 78, specular: 0x8b939c, emissive: 0x05070a },
  [MAT.ALLOY]: { shininess: 46, specular: 0xa9b2bd, emissive: 0x070a0d },
  [MAT.POLY]: { shininess: 14, specular: 0x2a2e33, emissive: 0x050607 },
  [MAT.WOOD]: { shininess: 26, specular: 0x4a3a28, emissive: 0x0a0705 },
  [MAT.RUBBER]: { shininess: 3, specular: 0x101214, emissive: 0x030405 },
  [MAT.GLASS]: { shininess: 110, specular: 0xcfe8ff, emissive: 0x0a1a24 },
};

/* ── Painting ────────────────────────────────────────────────────────────── */

/** Deterministic RNG so a finish looks identical on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, '0')}`;

/** Draws `fn` nine times so anything crossing an edge wraps seamlessly. */
function wrapped(g, size, fn) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      g.save();
      g.translate(ox * size, oy * size);
      fn();
      g.restore();
    }
  }
}

/** An irregular closed blob — the shape every hand-sprayed camouflage is made of. */
function blob(g, x, y, r, rand, wobble = 0.45) {
  const n = 7 + Math.floor(rand() * 4);
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 - wobble / 2 + rand() * wobble);
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr * 0.78;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
}

/**
 * The pattern painters.
 *
 * Each fills an opaque `size × size` tile from `colors` (the skin's own
 * palette, darkest-to-lightest is not assumed — each recipe says what it wants
 * from which slot) and must tile seamlessly in both axes.
 */
const PATTERNS = {
  /** Pixel camouflage: a coarse grid of blocks drawn from three tones. */
  digital(g, size, colors, rand) {
    const cell = size / 16;
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const r = rand();
        if (r < 0.42) continue;
        g.fillStyle = hex(colors[r < 0.74 ? 1 : 2]);
        g.fillRect(x * cell, y * cell, cell + 0.5, cell + 0.5);
      }
    }
  },

  /** Angular shards — the splinter patterns cut for snow and rock. */
  splinter(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x5eed);
      for (let i = 0; i < 14; i++) {
        g.fillStyle = hex(colors[1 + (i % 2)]);
        const x = r() * size, y = r() * size;
        const w = size * (0.1 + r() * 0.22), h = size * (0.06 + r() * 0.16);
        g.save();
        g.translate(x, y);
        g.rotate((r() - 0.5) * 1.6);
        g.beginPath();
        g.moveTo(-w / 2, 0);
        g.lineTo(0, -h / 2);
        g.lineTo(w / 2, h * 0.1);
        g.lineTo(w * 0.1, h / 2);
        g.closePath();
        g.fill();
        g.restore();
      }
    });
    void rand;
  },

  /** Organic four-tone woodland: overlapping sprayed blobs. */
  blotch(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    for (let layer = 1; layer < colors.length; layer++) {
      wrapped(g, size, () => {
        const r = rng(0x9a11 + layer * 977);
        g.fillStyle = hex(colors[layer]);
        for (let i = 0; i < 7; i++) {
          blob(g, r() * size, r() * size, size * (0.09 + r() * 0.11), r);
        }
      });
    }
    void rand;
  },

  /** Honest wear: a flat coat, then streaks and rubbed-through edges. */
  scratch(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x3c1d);
      g.strokeStyle = hex(colors[1] ?? colors[0]);
      for (let i = 0; i < 40; i++) {
        g.globalAlpha = 0.1 + r() * 0.4;
        g.lineWidth = 0.6 + r() * 1.8;
        const x = r() * size, y = r() * size, len = size * (0.05 + r() * 0.3);
        const a = (r() - 0.5) * 0.5;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        g.stroke();
      }
      g.globalAlpha = 1;
    });
    void rand;
  },

  /** Thrown paint: droplets with a little gravity in them. */
  splatter(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x7f21);
      for (let i = 0; i < 26; i++) {
        g.fillStyle = hex(colors[1 + (r() < 0.3 ? 1 : 0)]);
        const x = r() * size, y = r() * size, rr = size * (0.012 + r() * 0.05);
        g.beginPath();
        g.ellipse(x, y, rr, rr * (0.7 + r() * 0.5), 0, 0, Math.PI * 2);
        g.fill();
        if (r() < 0.45) {
          const drip = size * (0.03 + r() * 0.12);
          g.fillRect(x - rr * 0.28, y, rr * 0.56, drip);
        }
      }
    });
    void rand;
  },

  /**
   * Racing bands at 45°.
   *
   * Drawn as long rectangles rotated onto the `x + y` diagonal and repeated
   * every half-tile: `size` is a whole number of periods, so the pattern meets
   * itself exactly at every edge. A band drawn at any other angle does not, and
   * a gun wearing it grows a seam wherever the tile repeats.
   */
  stripe(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    const period = size / 2;
    const band = (offset, width, colour) => {
      g.fillStyle = hex(colour);
      for (let k = -size; k <= size * 2; k += period) {
        g.save();
        g.translate((k + offset) / 2, (k + offset) / 2);
        g.rotate(-Math.PI / 4);
        g.fillRect(-size * 2, -width / 2, size * 4, width);
        g.restore();
      }
    };
    band(0, period * 0.34, colors[1]);
    band(period * 0.3, period * 0.08, colors[2] ?? colors[1]);
    void rand;
  },

  /** Woven carbon: two offset rows of glossy tows. */
  hex(g, size, colors, rand) {
    g.fillStyle = hex(colors[1]);
    g.fillRect(0, 0, size, size);
    const cell = size / 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const over = (x + y) % 2 === 0;
        g.fillStyle = hex(over ? colors[0] : colors[1]);
        g.fillRect(x * cell + 0.6, y * cell + 0.6, cell - 1.2, cell - 1.2);
        const grad = g.createLinearGradient(
          x * cell, y * cell, over ? (x + 1) * cell : x * cell, over ? y * cell : (y + 1) * cell,
        );
        grad.addColorStop(0, 'rgba(255,255,255,0.16)');
        grad.addColorStop(1, 'rgba(0,0,0,0.28)');
        g.fillStyle = grad;
        g.fillRect(x * cell + 0.6, y * cell + 0.6, cell - 1.2, cell - 1.2);
      }
    }
    g.strokeStyle = hex(colors[2] ?? colors[0]);
    g.globalAlpha = 0.22;
    g.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, size); g.stroke();
      g.beginPath(); g.moveTo(0, i * cell); g.lineTo(size, i * cell); g.stroke();
    }
    g.globalAlpha = 1;
    void rand;
  },

  /**
   * A vertical gradient — the whole point is that it is not flat.
   *
   * Symmetric on purpose: light at both edges and dark through the middle, so
   * the tile ends on the colour it started with and repeats without a seam.
   */
  fade(g, size, colors, rand) {
    const grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, hex(colors[0]));
    grad.addColorStop(0.5, hex(colors[1]));
    grad.addColorStop(1, hex(colors[0]));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    void rand;
  },

  /** Sunset gradient under a grid, symmetric so the tile meets itself. */
  grid(g, size, colors, rand) {
    const grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, hex(colors[1]));
    grad.addColorStop(0.5, hex(colors[0]));
    grad.addColorStop(1, hex(colors[1]));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    g.strokeStyle = hex(colors[2]);
    g.lineWidth = 1.4;
    g.globalAlpha = 0.75;
    const step = size / 8;
    for (let i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, size); g.stroke();
      g.beginPath(); g.moveTo(0, i * step); g.lineTo(size, i * step); g.stroke();
    }
    g.globalAlpha = 1;
    void rand;
  },

  /** Engraved scrollwork over polished plate. */
  scroll(g, size, colors, rand) {
    const grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, hex(colors[0]));
    grad.addColorStop(0.5, hex(colors[1]));
    grad.addColorStop(1, hex(colors[0]));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x60d1);
      g.strokeStyle = hex(colors[2]);
      g.lineWidth = 1.6;
      for (let i = 0; i < 9; i++) {
        const x = r() * size, y = r() * size, rr = size * (0.05 + r() * 0.1);
        const from = r() * Math.PI * 2;
        g.beginPath();
        g.arc(x, y, rr, from, from + 3.6);
        g.stroke();
        g.beginPath();
        g.arc(x + rr * 0.9, y + rr * 0.5, rr * 0.45, from + 1.2, from + 4.6);
        g.stroke();
      }
    });
    void rand;
  },

  /** Folded steel: wavy bands of light and dark layers. */
  damascus(g, size, colors, rand) {
    g.fillStyle = hex(colors[1]);
    g.fillRect(0, 0, size, size);
    const r = rng(0x1d44);
    for (let band = 0; band < 22; band++) {
      g.strokeStyle = hex(band % 2 ? colors[0] : colors[2]);
      g.globalAlpha = 0.35 + r() * 0.4;
      g.lineWidth = 1.5 + r() * 3;
      g.beginPath();
      const y0 = (band / 22) * size;
      for (let x = 0; x <= size; x += 6) {
        const y = y0 + Math.sin((x / size) * Math.PI * 2 + band) * size * 0.05
          + Math.sin((x / size) * Math.PI * 6 + band * 2) * size * 0.02;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    void rand;
  },

  /** Traces and nodes, lit from inside. */
  circuit(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    const r = rng(0x2b90);
    const step = size / 8;
    g.lineWidth = 2;
    g.lineCap = 'square';
    for (let i = 0; i < 16; i++) {
      g.strokeStyle = hex(r() < 0.3 ? colors[2] : colors[1]);
      let x = Math.floor(r() * 8) * step;
      let y = Math.floor(r() * 8) * step;
      g.beginPath();
      g.moveTo(x, y);
      for (let s = 0; s < 3; s++) {
        if (r() < 0.5) x += (r() < 0.5 ? -1 : 1) * step; else y += (r() < 0.5 ? -1 : 1) * step;
        g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = hex(colors[2]);
      g.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
    void rand;
  },

  /** Issued kit: a flat coat with a stencilled number stamped into it. */
  stencil(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    g.fillStyle = hex(colors[1]);
    for (let i = 0; i < 5; i++) g.fillRect(0, (i / 5) * size, size, size * 0.03);
    g.globalAlpha = 0.85;
    g.fillStyle = hex(colors[2]);
    g.font = `bold ${Math.round(size * 0.3)}px monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('7-4', size / 2, size / 2);
    g.globalAlpha = 1;
    void rand;
  },
};

/* ── Caches ──────────────────────────────────────────────────────────────── */

const textures = new Map();
const materials = new Map();
const geometries = new Map();

/**
 * The tile for one skin's pattern, as it applies to one zone.
 *
 * Keyed by skin and pattern kind rather than by zone, because a skin paints
 * every zone it touches from the same recipe — Woodland's stock and its
 * receiver are the same camouflage, and drawing it twice would only cost VRAM.
 */
function patternTexture(skinId, pattern) {
  const key = `${skinId}|${pattern.kind}`;
  let tex = textures.get(key);
  if (tex) return tex;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const g = canvas.getContext('2d');
  const paint = PATTERNS[pattern.kind] ?? PATTERNS.scratch;
  paint(g, TILE, pattern.colors ?? [0x808080, 0x606060, 0x404040], rng(hash(key)));

  tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // The geometry's UVs are in world units, so one repeat unit *is* one metre:
  // `scale` is how big a tile of this pattern should be on the gun.
  const s = 1 / Math.max(0.01, pattern.scale ?? 0.12);
  tex.repeat.set(s, s);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.shared = true;
  textures.set(key, tex);
  return tex;
}

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * A box whose UVs are measured in world units rather than 0..1 per face.
 *
 * That is the whole trick behind patterns that hold their scale: a camouflage
 * blob is the same size on a butt pad as on a receiver, and the texture itself
 * carries the repeat, so every part of a gun can share one material.
 */
export function skinnedBoxGeometry(w, h, d) {
  const key = `${w}|${h}|${d}`;
  let geo = geometries.get(key);
  if (geo) return geo;
  geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  // BoxGeometry lays its faces out +X, -X, +Y, -Y, +Z, -Z, four vertices each.
  const spans = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = spans[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  uv.needsUpdate = true;
  geo.userData.shared = true;
  geometries.set(key, geo);
  return geo;
}

/**
 * The material for one part of one weapon under one finish.
 *
 * Shared and cached: a rifle's thirty-odd parts collapse to a handful of
 * materials, and every player wearing the same finish shares them. Anything
 * that needs to *mutate* one (the death fade on a third-person body) clones it
 * first — the clone still shares the texture, which is the expensive half.
 */
export function gunMaterial(part, skin) {
  const skinId = skin?.id ?? 'default';
  const key = `${skinId}|${part.z ?? 'body'}|${part.c}|${part.m}`;
  let mat = materials.get(key);
  if (mat) return mat;

  if (part.m === MAT.EMIT) {
    mat = new THREE.MeshBasicMaterial({ color: part.c });
  } else {
    const paint = paintFor(part, skin);
    const finish = FINISH[part.m] ?? FINISH[MAT.POLY];
    const tex = paint.pattern ? patternTexture(skinId, paint.pattern) : null;
    const emissive = new THREE.Color(finish.emissive);
    if (paint.glow) emissive.lerp(new THREE.Color(paint.glow), 0.75);
    mat = new THREE.MeshPhongMaterial({
      // A patterned zone gets its colour from the tile, so the base must be
      // white or the paint would be applied twice.
      color: tex ? 0xffffff : paint.color,
      map: tex,
      shininess: finish.shininess * (1 + paint.gloss * 0.8),
      specular: new THREE.Color(finish.specular).multiplyScalar(1 + paint.gloss * 0.5),
      emissive,
    });
  }
  mat.userData.shared = true;
  materials.set(key, mat);
  return mat;
}

/** Builds one weapon's meshes. `fine: false` drops the detail work (third person). */
export function buildWeaponMesh(def, skin, { fine = true, clone = false } = {}) {
  const group = new THREE.Group();
  const tagged = [];
  for (const p of def?.model?.parts ?? []) {
    if (!fine && p.fine) continue;
    const base = gunMaterial(p, skin);
    // A clone belongs to whoever asked for it, so it must not inherit the
    // cache's "leave me alone" flag — the texture behind it still carries one.
    const mat = clone ? base.clone() : base;
    if (clone) mat.userData = {};
    const m = new THREE.Mesh(skinnedBoxGeometry(p.s[0], p.s[1], p.s[2]), mat);
    m.position.set(p.p[0], p.p[1], p.p[2]);
    if (p.r) m.rotation.set(p.r[0], p.r[1], p.r[2]);
    group.add(m);
    if (p.tag) tagged.push([p.tag, m]);
  }
  group.userData.tagged = tagged;
  return group;
}

/** Every finish the shop can offer, painted once so a card can show the real thing. */
export function skinSwatchCss(skin) {
  const c = skin?.swatch ?? [0x3b424c, 0x5c3a1f, 0x8d959f];
  return `linear-gradient(135deg, ${hex(c[0])} 0%, ${hex(c[1])} 52%, ${hex(c[2] ?? c[0])} 100%)`;
}

export default { gunMaterial, skinnedBoxGeometry, buildWeaponMesh, FINISH, skinSwatchCss };
