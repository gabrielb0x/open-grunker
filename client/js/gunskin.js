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

/** Welded part lists, keyed by weapon + finish + detail level. */
const recipes = new Map();

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
  /* ── V2 patterns ──────────────────────────────────────────────────────────
   *
   * Same contract as the ones above: draw a `size`×`size` tile that meets
   * itself at every edge, using nothing but the three or four colours handed
   * in. `wrapped` is the tool for anything that crosses a boundary; anything
   * built from full-width bands or a symmetric gradient wraps by construction.
   */

  /** Hand-brushed tiger stripe: torn horizontal bands, thick and thin. */
  tiger(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    const r = rng(0x71a3);
    for (let i = 0; i < 14; i++) {
      const y = (i / 14) * size + r() * 4;
      const h = size * (0.02 + r() * 0.05);
      g.fillStyle = hex(i % 3 === 0 ? colors[2] ?? colors[1] : colors[1]);
      g.beginPath();
      // Full width, so the band leaves one edge exactly where it enters the other.
      g.moveTo(0, y);
      for (let x = 0; x <= size; x += size / 8) {
        g.lineTo(x, y + Math.sin((x / size) * Math.PI * 2 + i) * h * 0.8);
      }
      for (let x = size; x >= 0; x -= size / 8) {
        g.lineTo(x, y + h + Math.sin((x / size) * Math.PI * 2 + i) * h * 0.8);
      }
      g.closePath();
      g.fill();
    }
    void rand;
  },

  /** Veined stone: a wash, then pale fractures through it. */
  marble(g, size, colors, rand) {
    const grad = g.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, hex(colors[0]));
    grad.addColorStop(0.5, hex(colors[1]));
    grad.addColorStop(1, hex(colors[0]));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x9a3c);
      g.strokeStyle = hex(colors[2] ?? colors[1]);
      g.lineCap = 'round';
      for (let v = 0; v < 7; v++) {
        g.globalAlpha = 0.25 + r() * 0.4;
        g.lineWidth = 0.6 + r() * 2.2;
        let x = r() * size;
        let y = r() * size;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 12; k++) {
          x += (r() - 0.5) * size * 0.3;
          y += (r() - 0.5) * size * 0.3;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      g.globalAlpha = 1;
    });
    void rand;
  },

  /** Nested V bands, symmetric so the tile repeats without a step. */
  chevron(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    const rows = 6;
    for (let i = 0; i < rows; i++) {
      g.fillStyle = hex(i % 2 ? colors[1] : (colors[2] ?? colors[1]));
      const y = (i / rows) * size;
      const h = size / rows;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(size / 2, y + h * 0.55);
      g.lineTo(size, y);
      g.lineTo(size, y + h * 0.42);
      g.lineTo(size / 2, y + h * 0.97);
      g.lineTo(0, y + h * 0.42);
      g.closePath();
      g.fill();
    }
    void rand;
  },

  /** Overlapping scales, offset row to row. */
  serpent(g, size, colors, rand) {
    g.fillStyle = hex(colors[1]);
    g.fillRect(0, 0, size, size);
    const cols = 8;
    const cell = size / cols;
    for (let y = 0; y <= cols; y++) {
      for (let x = 0; x <= cols; x++) {
        const ox = (y % 2 ? cell / 2 : 0);
        const cx = x * cell + ox;
        const cy = y * cell;
        const grad = g.createRadialGradient(cx, cy - cell * 0.2, 0, cx, cy, cell * 0.8);
        grad.addColorStop(0, hex(colors[2] ?? colors[0]));
        grad.addColorStop(1, hex(colors[0]));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(cx, cy, cell * 0.56, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = hex(colors[1]);
        g.lineWidth = 0.8;
        g.stroke();
      }
    }
    void rand;
  },

  /** Deep space: a dark wash, coloured clouds, and stars over the top. */
  nebula(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x4b21);
      for (let i = 0; i < 12; i++) {
        const x = r() * size;
        const y = r() * size;
        const rad = size * (0.12 + r() * 0.3);
        const grad = g.createRadialGradient(x, y, 0, x, y, rad);
        const c = hex(i % 2 ? colors[1] : (colors[2] ?? colors[1]));
        grad.addColorStop(0, c);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = 0.34;
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, rad, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      g.fillStyle = '#ffffff';
      for (let i = 0; i < 40; i++) {
        const rr = r() * 1.1 + 0.2;
        g.globalAlpha = 0.4 + r() * 0.6;
        g.beginPath();
        g.arc(r() * size, r() * size, rr, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    });
    void rand;
  },

  /** Stars only, on near-black. Reads as depth rather than as a pattern. */
  starfield(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x2f7d);
      for (let i = 0; i < 70; i++) {
        const x = r() * size;
        const y = r() * size;
        const rr = r() * 1.4 + 0.2;
        g.globalAlpha = 0.3 + r() * 0.7;
        g.fillStyle = r() > 0.82 ? hex(colors[1]) : hex(colors[2] ?? 0xffffff);
        g.beginPath();
        g.arc(x, y, rr, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    });
    void rand;
  },

  /** Rolling swells, drawn as full-width sine bands so they wrap by construction. */
  wave(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    for (let i = 0; i < 5; i++) {
      const base = (i / 5) * size;
      g.fillStyle = hex(i % 2 ? colors[1] : (colors[2] ?? colors[1]));
      g.beginPath();
      g.moveTo(0, base);
      for (let x = 0; x <= size; x += 2) {
        g.lineTo(x, base + Math.sin((x / size) * Math.PI * 4 + i) * size * 0.045);
      }
      g.lineTo(size, base + size * 0.12);
      for (let x = size; x >= 0; x -= 2) {
        g.lineTo(x, base + size * 0.12 + Math.sin((x / size) * Math.PI * 4 + i) * size * 0.045);
      }
      g.closePath();
      g.fill();
    }
    void rand;
  },

  /** Crazed glaze: a flat ground broken by a network of fine cracks. */
  crackle(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x5cc1);
      for (let i = 0; i < 16; i++) {
        let x = r() * size;
        let y = r() * size;
        let a = r() * Math.PI * 2;
        g.strokeStyle = hex(r() > 0.6 ? (colors[2] ?? colors[1]) : colors[1]);
        g.lineWidth = 0.5 + r() * 1.3;
        g.globalAlpha = 0.5 + r() * 0.5;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 6; k++) {
          a += (r() - 0.5) * 1.4;
          x += Math.cos(a) * size * 0.09;
          y += Math.sin(a) * size * 0.09;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      g.globalAlpha = 1;
    });
    void rand;
  },

  /** Contour lines. Concentric rings at wobbled radii, wrapped. */
  topo(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x3ab7);
      for (let c = 0; c < 4; c++) {
        const cx = r() * size;
        const cy = r() * size;
        g.strokeStyle = hex(c % 2 ? (colors[2] ?? colors[1]) : colors[1]);
        for (let ring = 1; ring <= 7; ring++) {
          g.lineWidth = 0.9;
          g.globalAlpha = 0.65;
          g.beginPath();
          const rad = ring * size * 0.045;
          for (let k = 0; k <= 24; k++) {
            const a = (k / 24) * Math.PI * 2;
            const wobble = 1 + Math.sin(a * 3 + ring) * 0.12;
            const px = cx + Math.cos(a) * rad * wobble;
            const py = cy + Math.sin(a) * rad * wobble;
            if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
          }
          g.closePath();
          g.stroke();
        }
      }
      g.globalAlpha = 1;
    });
    void rand;
  },

  /**
   * Iridescence — a thin film of oil.
   *
   * Two crossed gradients rather than a hue sweep, so it stays seamless: each
   * is symmetric about the tile's middle and therefore ends where it started.
   */
  oil(g, size, colors, rand) {
    const a = g.createLinearGradient(0, 0, size, 0);
    a.addColorStop(0, hex(colors[0]));
    a.addColorStop(0.33, hex(colors[1]));
    a.addColorStop(0.66, hex(colors[2] ?? colors[1]));
    a.addColorStop(1, hex(colors[0]));
    g.fillStyle = a;
    g.fillRect(0, 0, size, size);
    const b = g.createLinearGradient(0, 0, 0, size);
    b.addColorStop(0, 'rgba(255,255,255,0.30)');
    b.addColorStop(0.5, 'rgba(0,0,0,0.34)');
    b.addColorStop(1, 'rgba(255,255,255,0.30)');
    g.fillStyle = b;
    g.fillRect(0, 0, size, size);
    void rand;
  },

  /** Faceted crystal: bright shards over a dark ground. */
  crystal(g, size, colors, rand) {
    g.fillStyle = hex(colors[2] ?? colors[1]);
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x7d31);
      for (let i = 0; i < 22; i++) {
        const x = r() * size;
        const y = r() * size;
        const rad = size * (0.06 + r() * 0.14);
        g.beginPath();
        const n = 3 + Math.floor(r() * 3);
        for (let k = 0; k <= n; k++) {
          const a = (k / n) * Math.PI * 2 + r() * 0.4;
          const px = x + Math.cos(a) * rad;
          const py = y + Math.sin(a) * rad;
          if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath();
        g.globalAlpha = 0.35 + r() * 0.5;
        g.fillStyle = hex(r() > 0.5 ? colors[0] : colors[1]);
        g.fill();
      }
      g.globalAlpha = 1;
    });
    void rand;
  },

  /** Licking flames, rooted at the bottom edge of the tile. */
  flame(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    const r = rng(0x0f1a);
    // Tongues are drawn twice, half a tile apart horizontally, so the row
    // meets itself: nothing here crosses the top or bottom edge.
    for (const ox of [0, size / 2]) {
      for (let i = 0; i < 7; i++) {
        const x = ((i / 7) * size + ox) % size;
        const h = size * (0.3 + r() * 0.55);
        const w = size * (0.05 + r() * 0.07);
        const grad = g.createLinearGradient(0, size, 0, size - h);
        grad.addColorStop(0, hex(colors[2] ?? colors[1]));
        grad.addColorStop(0.55, hex(colors[1]));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(x - w, size);
        g.quadraticCurveTo(x - w * 0.4, size - h * 0.6, x, size - h);
        g.quadraticCurveTo(x + w * 0.4, size - h * 0.6, x + w, size);
        g.closePath();
        g.fill();
      }
    }
    void rand;
  },

  /** Electrical plasma: soft blobs with hard filaments across them. */
  plasma(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    wrapped(g, size, () => {
      const r = rng(0x2be0);
      for (let i = 0; i < 8; i++) {
        const x = r() * size;
        const y = r() * size;
        const rad = size * (0.1 + r() * 0.22);
        const grad = g.createRadialGradient(x, y, 0, x, y, rad);
        grad.addColorStop(0, hex(i % 2 ? colors[1] : (colors[2] ?? colors[1])));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = 0.6;
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, rad, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      g.lineWidth = 1;
      for (let i = 0; i < 9; i++) {
        g.strokeStyle = hex(colors[2] ?? colors[1]);
        g.globalAlpha = 0.5 + r() * 0.5;
        let x = r() * size;
        let y = r() * size;
        let a = r() * Math.PI * 2;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 7; k++) {
          a += (r() - 0.5) * 2;
          x += Math.cos(a) * size * 0.07;
          y += Math.sin(a) * size * 0.07;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      g.globalAlpha = 1;
    });
    void rand;
  },

  /** A spider's web — for the gloves that are named after one. */
  web(g, size, colors, rand) {
    g.fillStyle = hex(colors[0]);
    g.fillRect(0, 0, size, size);
    g.strokeStyle = hex(colors[1]);
    g.lineWidth = 0.9;
    g.globalAlpha = 0.8;
    // Anchored at each corner, so the four quarter-webs form whole ones across
    // the seam when the tile repeats.
    for (const [cx, cy] of [[0, 0], [size, 0], [0, size], [size, size]]) {
      for (let spoke = 0; spoke < 7; spoke++) {
        const a = (spoke / 6) * (Math.PI / 2);
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(a) * size * (cx ? -1 : 1) * 0.7,
          cy + Math.sin(a) * size * (cy ? -1 : 1) * 0.7);
        g.stroke();
      }
      for (let ring = 1; ring <= 5; ring++) {
        g.beginPath();
        g.arc(cx, cy, ring * size * 0.13, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    void rand;
  },
};

/* ── Animated finishes ───────────────────────────────────────────────────── */

/**
 * Motion, driven from one clock.
 *
 * An animated finish is the top of the rarity ladder, so it had better not be
 * the top of the frame budget too. Nothing here is a video, a sprite sheet or
 * a custom shader: a scrolling finish moves the *shared* texture's offset, and
 * a breathing one moves the *shared* material's emissive. Both are per finish
 * rather than per player, which is why forty players in Hellfire cost exactly
 * what one does — and why they are all in step, which is the look anyway.
 *
 * `tickCosmetics` is called once a frame from the render loop and from
 * nowhere else. If it is never called, an animated finish simply stands still
 * and everything else is unaffected.
 */
const animTextures = [];
const animMaterials = [];
/** How many materials may be driven at once. See `animateMaterial`. */
const ANIM_MATERIAL_CAP = 512;

/** Registers a shared texture to be moved by `kind`. */
function animateTexture(tex, kind, speed) {
  if (!kind || tex.userData.animated) return;
  tex.userData.animated = true;
  animTextures.push({ tex, kind, speed: speed || 0.3 });
}

/**
 * Registers a material to be lit by `kind`.
 *
 * The base colour and emissive are captured now, because every frame after
 * this one is a modulation of them rather than of the previous frame — a
 * pulse that multiplied its own output would fade to black inside a second.
 */
function animateMaterial(mat, kind, speed) {
  if (!kind || !mat || mat.userData?.animated) return;
  if (!mat.emissive && !mat.color) return;
  // Cached materials are shared and bounded by the catalogue; per-body clones
  // are not, and a long session could otherwise walk a list that only grows.
  // Past the ceiling a clone simply does not animate, which costs one player's
  // gun its motion rather than costing everybody frames.
  if (!mat.userData?.shared && animMaterials.length >= ANIM_MATERIAL_CAP) return;
  mat.userData = { ...(mat.userData ?? {}), animated: true };
  animMaterials.push({
    mat, kind, speed: speed || 1,
    baseEmissive: mat.emissive ? mat.emissive.clone() : null,
    baseColor: mat.color ? mat.color.clone() : null,
    hue: mat.color ? mat.color.getHSL({ h: 0, s: 0, l: 0 }) : null,
    seed: Math.random() * 100,
  });
}

const _hsl = { h: 0, s: 0, l: 0 };

/**
 * Advances every animated finish in the game.
 *
 * @param {number} t seconds since the client started — a monotonic clock, not
 *                   a delta, so a dropped frame does not lose ground.
 */
export function tickCosmetics(t) {
  for (const a of animTextures) {
    const o = a.tex.offset;
    switch (a.kind) {
      case 'scroll': o.y = -t * a.speed; break;
      case 'drift': o.x = t * a.speed * 0.35; o.y = t * a.speed * 0.2; break;
      case 'shimmer': o.x = Math.sin(t * a.speed) * 0.35; break;
      case 'rainbow': o.x = t * a.speed * 0.5; break;
      // Pulse and flicker are lighting, not movement: the tile stays put and
      // the material below does the work.
      default: break;
    }
    a.tex.needsUpdate = false;   // offset is a uniform; the pixels have not changed
  }

  for (const a of animMaterials) {
    switch (a.kind) {
      case 'pulse': {
        if (!a.baseEmissive) break;
        const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.1 * a.speed + a.seed));
        a.mat.emissive.copy(a.baseEmissive).multiplyScalar(k * 1.6);
        break;
      }
      case 'flicker': {
        if (!a.baseEmissive) break;
        // Three detuned sines rather than a random number: an electrical
        // flicker is irregular, not noisy, and Math.random() every frame per
        // material reads as static.
        const n = Math.sin(t * 13 + a.seed) * 0.5 + Math.sin(t * 29.3 + a.seed * 2) * 0.3
          + Math.sin(t * 7.1 + a.seed * 3) * 0.2;
        a.mat.emissive.copy(a.baseEmissive).multiplyScalar(Math.max(0.15, 0.8 + n * 0.9));
        break;
      }
      case 'rainbow': {
        if (!a.baseColor) break;
        a.baseColor.getHSL(_hsl);
        // Saturation is floored so a white-based finish still cycles visibly,
        // and lightness is left alone so the gun keeps its shading.
        a.mat.color.setHSL((_hsl.h + t * 0.11 * a.speed) % 1, Math.max(0.45, _hsl.s), _hsl.l);
        if (a.baseEmissive) {
          a.mat.emissive.setHSL((_hsl.h + t * 0.11 * a.speed + 0.5) % 1, 0.6, 0.08);
        }
        break;
      }
      case 'shimmer': {
        if (!a.baseEmissive) break;
        const k = 0.5 + 0.5 * Math.sin(t * 1.3 * a.speed + a.seed);
        a.mat.emissive.copy(a.baseEmissive).multiplyScalar(0.6 + k * 1.4);
        break;
      }
      default: break;
    }
  }
}

/** How many finishes are currently being animated — the perf figure, for tests. */
export const animatedCount = () => animTextures.length + animMaterials.length;

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
function patternTexture(skinId, pattern, anim = null) {
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
  // An animated finish moves this one texture for everybody wearing it.
  animateTexture(tex, anim, pattern.speed);
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
    const tex = paint.pattern ? patternTexture(skinId, paint.pattern, skin?.anim) : null;
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
  // Lighting-driven motion — pulse, flicker, rainbow, shimmer — lives on the
  // material rather than the tile. A finish may register both.
  if (part.m !== MAT.EMIT) animateMaterial(mat, skin?.anim);
  materials.set(key, mat);
  return mat;
}

/* ── Batching ────────────────────────────────────────────────────────────── */

/**
 * The parts list for one weapon, one finish and one detail level — welded.
 *
 * Cached, because the geometry that comes out of a weld depends only on those
 * three things: eight players carrying the same rifle carry byte-identical
 * buffers, and building them per body meant eight uploads on every join. The
 * *materials* still get cloned per body where the caller asks for it (a death
 * fade moves opacity), which costs nothing — a material is a handful of
 * numbers pointing at a texture everybody already shares.
 *
 * @returns {Array<{geo: THREE.BufferGeometry, mat: THREE.Material,
 *                  p: ?number[], r: ?number[], tag: ?string}>}
 */
function weaponRecipe(def, skin, fine, collapse) {
  const key = `${def?.id ?? '?'}|${skin?.id ?? 'default'}|${fine ? 1 : 0}|${collapse}`;
  const hit = recipes.get(key);
  if (hit) return hit;

  const loose = [];
  /** material -> the baked geometries that will become one mesh. */
  const batches = new Map();
  const m4 = new THREE.Matrix4();
  const euler = new THREE.Euler();

  for (const p of def?.model?.parts ?? []) {
    if (!fine && p.fine) continue;
    const mat = gunMaterial(p, skin);
    const geo = skinnedBoxGeometry(p.s[0], p.s[1], p.s[2]);
    // `static` keeps the tagged parts — a magazine, a bolt, a cylinder — as
    // meshes of their own, because the reload animation moves them. Everything
    // else on the gun is welded to everything else and can be one buffer.
    if (collapse === 'none' || (collapse === 'static' && p.tag)) {
      loose.push({ geo, mat, p: p.p, r: p.r ?? null, tag: p.tag ?? null });
      continue;
    }
    euler.set(p.r?.[0] ?? 0, p.r?.[1] ?? 0, p.r?.[2] ?? 0);
    m4.makeRotationFromEuler(euler);
    m4.setPosition(p.p[0], p.p[1], p.p[2]);
    // `clone` copies `userData` by reference, and the cached box geometries
    // carry `shared: true` — inheriting it would make the baked copy immortal.
    const baked = geo.clone();
    baked.userData = {};
    baked.applyMatrix4(m4);
    let list = batches.get(mat);
    if (!list) batches.set(mat, (list = []));
    list.push(baked);
  }

  const recipe = loose;
  for (const [mat, list] of batches) {
    const geo = list.length === 1 ? list[0] : weldGeometries(list);
    if (list.length > 1) for (const g of list) g.dispose();
    // Cached for the life of the page like every other geometry here, so the
    // teardown walkers know to leave it alone.
    geo.userData.shared = true;
    recipe.push({ geo, mat, p: null, r: null, tag: null });
  }
  recipes.set(key, recipe);
  return recipe;
}

/**
 * One weapon, built as meshes.
 *
 * `collapse` decides how much of it is welded into shared buffers: `none`
 * leaves every part its own mesh, `static` welds all but the parts a reload
 * animates, and `all` welds the lot.
 */
export function buildWeaponMesh(def, skin, { fine = true, clone = false, collapse = 'none' } = {}) {
  const group = new THREE.Group();
  const tagged = [];
  /**
   * One clone per cached material, not one per part.
   *
   * A clone is per-weapon so a death fade can move its opacity without
   * touching anybody else's gun — but two parts cut from the same steel are
   * still the same steel, and separate clones would keep them in separate
   * draw calls for the rest of the match.
   */
  const clones = clone ? new Map() : null;

  for (const part of weaponRecipe(def, skin, fine, collapse)) {
    let mat = part.mat;
    if (clones) {
      mat = clones.get(part.mat);
      if (!mat) {
        mat = part.mat.clone();
        // The clone belongs to whoever asked for it, so it must not inherit
        // the cache's "leave me alone" flag — its texture still carries one.
        mat.userData = {};
        // A clone is a fresh material, so it is not on the animation list the
        // original is on. Without this the finish everybody else is carrying
        // would be the one finish in the game that stands still.
        animateMaterial(mat, skin?.anim);
        clones.set(part.mat, mat);
      }
    }
    const m = new THREE.Mesh(part.geo, mat);
    if (part.p) m.position.set(part.p[0], part.p[1], part.p[2]);
    if (part.r) m.rotation.set(part.r[0], part.r[1], part.r[2]);
    group.add(m);
    if (part.tag) tagged.push([part.tag, m]);
  }
  group.userData.tagged = tagged;
  return group;
}

/**
 * Welds several indexed box geometries into one.
 *
 * Deliberately narrow: every geometry it is ever handed comes out of
 * `skinnedBoxGeometry`, so they all carry exactly position/normal/uv and an
 * index, and there is no attribute reconciliation to do. Shipping three's
 * `BufferGeometryUtils` for this would be a second copy of a library the
 * client does not otherwise need.
 */
function weldGeometries(list) {
  let verts = 0, indices = 0;
  for (const g of list) {
    verts += g.attributes.position.count;
    indices += g.index.count;
  }
  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const index = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

  let v = 0, i = 0;
  for (const g of list) {
    position.set(g.attributes.position.array, v * 3);
    normal.set(g.attributes.normal.array, v * 3);
    uv.set(g.attributes.uv.array, v * 2);
    const src = g.index.array;
    for (let k = 0; k < src.length; k++) index[i + k] = src[k] + v;
    v += g.attributes.position.count;
    i += src.length;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

/**
 * Collapses an assembly of little boxes into one mesh per material.
 *
 * A rifle is forty parts and a hand is a dozen, and every one of them used to
 * be its own draw call — for the viewmodel that is sixty draws a frame before
 * the world has been touched, and for eight bodies on screen it is another
 * hundred and twenty. None of those parts ever move relative to each other, so
 * their transforms can be baked into the vertices once, at build time, and the
 * whole gun handed to the GPU in four or five calls instead.
 *
 * @param {THREE.Object3D} root the assembly, modified in place
 * @param {?function} keep returns true for a mesh that must stay on its own
 *        because something animates it
 */
export function collapseStatic(root, keep = null) {
  root.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const local = new THREE.Matrix4();
  /** material -> the baked geometries that will become one mesh. */
  const batches = new Map();
  const merged = [];
  const empties = [];

  root.traverse((o) => {
    if (o === root) return;
    if (!o.isMesh) { if (o.isGroup) empties.push(o); return; }
    if (keep && keep(o)) return;
    const geo = o.geometry;
    const a = geo?.attributes;
    if (!geo?.index || !a?.position || !a?.normal || !a?.uv) return;
    local.multiplyMatrices(toLocal, o.matrixWorld);
    // `clone` copies `userData` by reference, and the cached box geometries
    // carry `shared: true` — inheriting it would make the baked copy immortal.
    const baked = geo.clone();
    baked.userData = {};
    baked.applyMatrix4(local);
    let list = batches.get(o.material);
    if (!list) batches.set(o.material, (list = []));
    list.push(baked);
    merged.push(o);
  });
  if (!merged.length) return root;

  for (const mesh of merged) mesh.parent?.remove(mesh);
  for (const [material, list] of batches) {
    const geo = list.length === 1 ? list[0] : weldGeometries(list);
    if (list.length > 1) for (const g of list) g.dispose();
    root.add(new THREE.Mesh(geo, material));
  }
  // Whatever sub-group the parts hung off is now an empty node in the middle
  // of every matrix walk; nothing is left for it to hold.
  for (const g of empties) if (!g.children.length) g.parent?.remove(g);
  return root;
}

export default {
  gunMaterial, skinnedBoxGeometry, buildWeaponMesh, collapseStatic, FINISH,
  tickCosmetics, animatedCount,
};
