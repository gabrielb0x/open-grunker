/**
 * Open Grunker — procedural surface textures.
 *
 * Every material in the game is drawn into a canvas at load time and uploaded
 * once. Nothing is fetched, nothing is decoded, and the whole set costs a
 * couple of megabytes of VRAM — which is how a browser FPS gets real surface
 * detail without shipping a single image file.
 *
 * Each recipe paints a seamless tile: anything drawn near an edge is drawn
 * again wrapped around the other side, so a wall built out of a hundred boxes
 * reads as one continuous surface.
 *
 * ── Why these tiles are almost colourless ──────────────────────────────────
 * A box is drawn as `instanceColour × texture × faceShade`. If the texture
 * carried the hue too, every surface would be tinted twice and the whole game
 * would sag toward mud — which is exactly what the old, grimy tile set did.
 *
 * So a recipe paints *pattern*, not paint: brightness that hovers near white
 * with the joints, boards, blades and seams cut into it. The saturated colour
 * comes from the map's own palette, one hex per box. That is what makes a
 * cyan-sky toy town possible on the same renderer as a rusted shipyard: the
 * material says "lap siding", the map says "cobalt blue".
 */
import * as THREE from 'three';
import { SURFACE } from '/shared/constants.js';

const cache = new Map();
let RES = 256;
let anisotropy = 4;

/** Deterministic RNG so a texture looks the same on every machine. */
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

const canvas = (size) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
};

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

/** Fine per-pixel grain — the layer that stops a surface looking like plastic. */
function grain(g, size, amount, rand, tint = null) {
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n + (tint ? tint[0] * n * 0.02 : 0)));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

/** Soft low-frequency blotches, painted as translucent ellipses. */
function blotches(g, size, count, rand, colors, minR, maxR, alpha = 0.12) {
  wrapped(g, size, () => {
    const r2 = rng(0x51ed);
    for (let i = 0; i < count; i++) {
      const x = r2() * size, y = r2() * size;
      const rr = minR + r2() * (maxR - minR);
      g.globalAlpha = alpha * (0.5 + r2() * 0.8);
      g.fillStyle = colors[Math.floor(r2() * colors.length)];
      g.beginPath();
      g.ellipse(x, y, rr, rr * (0.6 + r2() * 0.8), r2() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  });
  g.globalAlpha = 1;
}

/** Hairline cracks — a few branching strokes. */
function cracks(g, size, count, rand, color = 'rgba(0,0,0,.35)', width = 1) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    let x = rand() * size, y = rand() * size;
    let a = rand() * Math.PI * 2;
    g.beginPath();
    g.moveTo(x, y);
    const segs = 4 + Math.floor(rand() * 8);
    for (let s = 0; s < segs; s++) {
      a += (rand() - 0.5) * 1.1;
      x += Math.cos(a) * (3 + rand() * 10);
      y += Math.sin(a) * (3 + rand() * 10);
      g.lineTo(x, y);
    }
    g.stroke();
  }
}

/* ── Recipes ─────────────────────────────────────────────────────────────── */

/* ── Painting helpers ────────────────────────────────────────────────────── */

/** Flat fill in neutral grey. `v` is 0–255 luminance. */
const flat = (g, s, v) => { g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, 0, s, s); };

/** Luminance-only fill, so the box's own colour survives the multiply. */
const lum = (v) => `rgb(${v | 0},${v | 0},${v | 0})`;

/**
 * Horizontal boards running across the tile: the shape behind siding, fences,
 * decking and awnings. Each board gets its own brightness and a shadow line
 * under it, which is the whole reason a flat-shaded wall reads as cladding.
 */
function boards(g, s, count, rand, { vary = 0.1, gap = 0.11, shadow = 0.22, base = 232 } = {}) {
  const bh = s / count;
  for (let i = 0; i < count; i++) {
    const v = base * (1 - vary / 2 + rand() * vary);
    g.fillStyle = lum(v);
    g.fillRect(-1, i * bh, s + 2, bh);
    // Top highlight, bottom shadow — the bevel that sells a lapped board.
    g.fillStyle = `rgba(255,255,255,${0.16})`;
    g.fillRect(-1, i * bh, s + 2, Math.max(1, bh * 0.12));
    g.fillStyle = `rgba(0,0,0,${shadow})`;
    g.fillRect(-1, i * bh + bh - Math.max(1, bh * gap), s + 2, Math.max(1, bh * gap));
  }
}

const RECIPES = {
  [SURFACE.CONCRETE]: (g, s, rand) => {
    flat(g, s, 214);
    blotches(g, s, 20, rand, ['#c8c8c8', '#e2e2e2', '#bcbcbc'], s * 0.07, s * 0.24, 0.2);
    // Panel seams every half tile: instant sense of scale.
    g.strokeStyle = 'rgba(0,0,0,.2)'; g.lineWidth = Math.max(1, s / 128);
    g.beginPath(); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.moveTo(s / 2, 0); g.lineTo(s / 2, s); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.28)';
    g.beginPath(); g.moveTo(0, s / 2 + 1.5); g.lineTo(s, s / 2 + 1.5); g.stroke();
    cracks(g, s, 4, rand, 'rgba(0,0,0,.14)', Math.max(1, s / 256));
    grain(g, s, 14, rand);
  },

  [SURFACE.BRICK]: (g, s, rand) => {
    const rows = 8, bh = s / rows, bw = s / 4;
    flat(g, s, 245);                                          // mortar
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * (bw / 2);
      for (let c = -1; c < 5; c++) {
        const x = c * bw + off + 1.5, y = r * bh + 1.5;
        g.fillStyle = lum(196 + rand() * 42);
        g.fillRect(x, y, bw - 3, bh - 3);
        g.fillStyle = 'rgba(255,255,255,.2)';
        g.fillRect(x, y, bw - 3, Math.max(1, bh * 0.16));
        g.fillStyle = 'rgba(0,0,0,.16)';
        g.fillRect(x, y + bh - 3 - Math.max(1, bh * 0.18), bw - 3, Math.max(1, bh * 0.18));
      }
    }
    grain(g, s, 12, rand);
  },

  [SURFACE.PLASTER]: (g, s, rand) => {
    flat(g, s, 238);
    blotches(g, s, 24, rand, ['#e6e6e6', '#f6f6f6', '#d8d8d8'], s * 0.08, s * 0.28, 0.2);
    cracks(g, s, 5, rand, 'rgba(0,0,0,.12)', Math.max(1, s / 256));
    grain(g, s, 10, rand);
  },

  [SURFACE.WOOD]: (g, s, rand) => {
    flat(g, s, 212);
    for (let i = 0; i < 80; i++) {
      const x = rand() * s, w = 1 + rand() * 3.5;
      g.fillStyle = `rgba(${rand() > 0.5 ? '90,66,40' : '255,246,225'},${0.05 + rand() * 0.13})`;
      g.fillRect(x, 0, w, s);
    }
    for (let i = 0; i < 3; i++) {                             // knots
      const x = rand() * s, y = rand() * s, r = 3 + rand() * 7;
      const grd = g.createRadialGradient(x, y, 1, x, y, r * 2.4);
      grd.addColorStop(0, 'rgba(70,48,26,.45)');
      grd.addColorStop(1, 'rgba(70,48,26,0)');
      g.fillStyle = grd;
      g.beginPath(); g.ellipse(x, y, r * 1.2, r * 2.4, 0, 0, Math.PI * 2); g.fill();
    }
    grain(g, s, 12, rand);
  },

  [SURFACE.PLANK]: (g, s, rand) => {
    boards(g, s, 6, rand, { vary: 0.16, gap: 0.09, shadow: 0.3, base: 224 });
    for (let i = 0; i < 120; i++) {                           // long grain streaks
      g.fillStyle = `rgba(${rand() > 0.5 ? '80,58,34' : '255,248,232'},${0.05 + rand() * 0.11})`;
      g.fillRect(rand() * s, rand() * s, 6 + rand() * 44, 1);
    }
    // Nail heads, two per plank, on a shared line so the boards read as fixed.
    const ph = s / 6;
    for (let i = 0; i < 6; i++) {
      const jx = rand() * s;
      g.fillStyle = 'rgba(0,0,0,.24)'; g.fillRect(jx, i * ph, 1.5, ph - 1);
      g.fillStyle = 'rgba(52,44,36,.5)';
      g.beginPath(); g.arc(jx + 5, i * ph + ph * 0.3, 1.4, 0, 7); g.fill();
      g.beginPath(); g.arc(jx + 5, i * ph + ph * 0.72, 1.4, 0, 7); g.fill();
    }
    grain(g, s, 12, rand);
  },

  [SURFACE.METAL]: (g, s, rand) => {
    flat(g, s, 206);
    for (let i = 0; i < 240; i++) {                           // brushed streaks
      g.fillStyle = `rgba(${rand() > 0.5 ? '255,255,255' : '40,46,54'},${0.02 + rand() * 0.07})`;
      g.fillRect(0, rand() * s, s, 1);
    }
    g.strokeStyle = 'rgba(36,42,50,.42)'; g.lineWidth = Math.max(1, s / 128);
    g.strokeRect(0.5, 0.5, s - 1, s - 1);
    g.beginPath(); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.45)';                    // rivets
    for (let i = 0; i < 8; i++) {
      const rx = (i + 0.5) * (s / 8);
      for (const ry of [4, s / 2 - 4, s / 2 + 4, s - 4]) {
        g.beginPath(); g.arc(rx, ry, Math.max(1, s / 128), 0, 7); g.fill();
      }
    }
    grain(g, s, 10, rand);
  },

  [SURFACE.RUST]: (g, s, rand) => {
    RECIPES[SURFACE.METAL](g, s, rng(9137));
    blotches(g, s, 34, rand, ['#a06a44', '#c08a52', '#7d5230'], s * 0.04, s * 0.2, 0.3);
    // Corrugation: shipping containers live and die by it.
    for (let x = 0; x < s; x += s / 16) {
      g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(x, 0, Math.max(1, s / 64), s);
      g.fillStyle = 'rgba(255,255,255,.24)'; g.fillRect(x + s / 32, 0, Math.max(1, s / 64), s);
    }
    grain(g, s, 16, rand);
  },

  [SURFACE.GRATE]: (g, s, rand) => {
    flat(g, s, 96);
    const cell = s / 8;
    g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = Math.max(1.5, s / 42);
    for (let i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, s); g.stroke();
      g.beginPath(); g.moveTo(0, i * cell); g.lineTo(s, i * cell); g.stroke();
    }
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = Math.max(1, s / 96);
    for (let i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(i * cell + 2, 0); g.lineTo(i * cell + 2, s); g.stroke();
    }
    grain(g, s, 12, rand);
  },

  [SURFACE.SAND]: (g, s, rand) => {
    flat(g, s, 232);
    blotches(g, s, 20, rand, ['#e4e4e4', '#f4f4f4', '#d2d2d2'], s * 0.09, s * 0.32, 0.18);
    g.strokeStyle = 'rgba(0,0,0,.1)'; g.lineWidth = Math.max(1, s / 200);
    for (let i = 0; i < 22; i++) {                            // wind ripples
      const y = rand() * s;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= s; x += s / 16) g.lineTo(x, y + Math.sin(x * 0.06 + i) * (s / 60));
      g.stroke();
    }
    grain(g, s, 18, rand);
  },

  [SURFACE.ROCK]: (g, s, rand) => {
    flat(g, s, 220);
    blotches(g, s, 36, rand, ['#cfcfcf', '#eaeaea', '#b4b4b4'], s * 0.05, s * 0.24, 0.26);
    cracks(g, s, 10, rand, 'rgba(0,0,0,.24)', Math.max(1, s / 200));
    grain(g, s, 20, rand);
  },

  [SURFACE.DIRT]: (g, s, rand) => {
    flat(g, s, 214);
    blotches(g, s, 34, rand, ['#c6c6c6', '#e6e6e6', '#a8a8a8'], s * 0.05, s * 0.26, 0.24);
    for (let i = 0; i < 180; i++) {                           // grit
      g.fillStyle = `rgba(${rand() > 0.5 ? '255,250,238' : '80,66,48'},${0.16 + rand() * 0.4})`;
      g.beginPath(); g.arc(rand() * s, rand() * s, 0.8 + rand() * 2.2, 0, 7); g.fill();
    }
    grain(g, s, 18, rand);
  },

  [SURFACE.SNOW]: (g, s, rand) => {
    flat(g, s, 250);
    blotches(g, s, 18, rand, ['#e8f0f8', '#ffffff'], s * 0.09, s * 0.32, 0.3);
    for (let i = 0; i < 340; i++) {                           // sparkle
      g.fillStyle = `rgba(255,255,255,${0.3 + rand() * 0.6})`;
      g.fillRect(rand() * s, rand() * s, 1, 1);
    }
    grain(g, s, 8, rand);
  },

  [SURFACE.ICE]: (g, s, rand) => {
    flat(g, s, 236);
    blotches(g, s, 14, rand, ['#dceaf6', '#ffffff'], s * 0.11, s * 0.36, 0.34);
    cracks(g, s, 12, rand, 'rgba(255,255,255,.7)', Math.max(1, s / 200));
    cracks(g, s, 5, rand, 'rgba(70,110,140,.22)', Math.max(1, s / 160));
    grain(g, s, 6, rand);
  },

  [SURFACE.TILE]: (g, s, rand) => {
    const n = 4, ts = s / n;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        g.fillStyle = lum(226 + rand() * 26);
        g.fillRect(x * ts + 1, y * ts + 1, ts - 2, ts - 2);
      }
    }
    g.fillStyle = 'rgba(0,0,0,.4)';
    for (let i = 0; i <= n; i++) {
      g.fillRect(i * ts - 1, 0, 2, s);
      g.fillRect(0, i * ts - 1, s, 2);
    }
    grain(g, s, 8, rand);
  },

  [SURFACE.ROOF]: (g, s, rand) => {
    flat(g, s, 190);
    const rows = 8, rh = s / rows;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * (s / 12);
      for (let c = -1; c < 7; c++) {
        const x = c * (s / 6) + off, y = r * rh;
        g.fillStyle = lum(206 + rand() * 44);
        g.beginPath();
        g.moveTo(x, y + rh); g.lineTo(x, y + rh * 0.35);
        g.quadraticCurveTo(x + s / 12, y - rh * 0.1, x + s / 6, y + rh * 0.35);
        g.lineTo(x + s / 6, y + rh); g.closePath(); g.fill();
        g.strokeStyle = 'rgba(0,0,0,.2)'; g.lineWidth = 1; g.stroke();
      }
    }
    grain(g, s, 12, rand);
  },

  [SURFACE.CRATE]: (g, s, rand) => {
    flat(g, s, 224);
    for (let i = 0; i < 50; i++) {
      g.fillStyle = `rgba(${rand() > 0.5 ? '86,60,28' : '255,246,224'},${0.05 + rand() * 0.12})`;
      g.fillRect(0, rand() * s, s, 1 + rand() * 2);
    }
    // Frame planks around the edges and a diagonal brace.
    const t = s * 0.1;
    g.fillStyle = 'rgba(0,0,0,.16)';
    g.fillRect(0, 0, s, t); g.fillRect(0, s - t, s, t);
    g.fillRect(0, 0, t, s); g.fillRect(s - t, 0, t, s);
    g.strokeStyle = 'rgba(0,0,0,.16)'; g.lineWidth = t * 0.75;
    g.beginPath(); g.moveTo(t, t); g.lineTo(s - t, s - t); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,.34)'; g.lineWidth = 2;
    g.strokeRect(1, 1, s - 2, s - 2);
    grain(g, s, 12, rand);
  },

  [SURFACE.FOLIAGE]: (g, s, rand) => {
    flat(g, s, 150);
    for (let i = 0; i < 900; i++) {                           // needles / leaves
      g.fillStyle = `rgba(${rand() > 0.42 ? '255,255,255' : '18,40,20'},${0.16 + rand() * 0.4})`;
      const x = rand() * s, y = rand() * s, w = 2 + rand() * 5;
      g.save(); g.translate(x, y); g.rotate(rand() * Math.PI);
      g.fillRect(-w / 2, -1, w, 2.4);
      g.restore();
    }
    grain(g, s, 16, rand);
  },

  [SURFACE.GLASS]: (g, s, rand) => {
    flat(g, s, 224);
    const grd = g.createLinearGradient(0, 0, s, s);
    grd.addColorStop(0, 'rgba(255,255,255,.55)');
    grd.addColorStop(0.5, 'rgba(255,255,255,.05)');
    grd.addColorStop(1, 'rgba(255,255,255,.4)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(0,0,0,.34)'; g.lineWidth = Math.max(2, s / 64);
    g.strokeRect(1, 1, s - 2, s - 2);
    grain(g, s, 4, rand);
  },

  /* ── The town set ──────────────────────────────────────────────────────── */

  /**
   * Road. Coarse aggregate with a faint camber sheen and the odd tar seam —
   * everything a street needs except the markings, which are their own boxes so
   * they can be laid out lane by lane.
   */
  [SURFACE.ASPHALT]: (g, s, rand) => {
    flat(g, s, 222);
    blotches(g, s, 26, rand, ['#d0d0d0', '#eeeeee', '#bebebe'], s * 0.06, s * 0.26, 0.22);
    for (let i = 0; i < 900; i++) {                           // aggregate
      g.fillStyle = `rgba(${rand() > 0.5 ? '255,255,255' : '40,40,44'},${0.06 + rand() * 0.22})`;
      g.beginPath(); g.arc(rand() * s, rand() * s, 0.6 + rand() * 1.8, 0, 7); g.fill();
    }
    // Tar-band repair seams, deliberately not axis-aligned.
    g.strokeStyle = 'rgba(0,0,0,.16)'; g.lineWidth = Math.max(2, s / 90); g.lineCap = 'round';
    for (let i = 0; i < 2; i++) {
      let x = rand() * s, y = rand() * s, a = rand() * Math.PI * 2;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        a += (rand() - 0.5) * 0.7;
        x += Math.cos(a) * s * 0.3; y += Math.sin(a) * s * 0.3;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    grain(g, s, 16, rand);
  },

  /** Flat paint: road markings, car bodies, painted steelwork. Barely a texture. */
  [SURFACE.PAINT]: (g, s, rand) => {
    flat(g, s, 246);
    const grd = g.createLinearGradient(0, 0, 0, s);
    grd.addColorStop(0, 'rgba(255,255,255,.28)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0)');
    grd.addColorStop(1, 'rgba(0,0,0,.1)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    grain(g, s, 5, rand);
  },

  /**
   * Lawn. Thousands of short blades at mixed brightness — from a standing
   * player's eye height that reads as grass, and from a rooftop it reads as a
   * lawn rather than a green rectangle.
   */
  [SURFACE.GRASS]: (g, s, rand) => {
    flat(g, s, 208);
    blotches(g, s, 18, rand, ['#cfcfcf', '#f0f0f0'], s * 0.1, s * 0.34, 0.2);
    for (let i = 0; i < 1400; i++) {
      const bright = rand();
      g.strokeStyle = bright > 0.5
        ? `rgba(255,255,255,${0.1 + rand() * 0.3})`
        : `rgba(26,52,22,${0.1 + rand() * 0.3})`;
      g.lineWidth = 1 + rand();
      const x = rand() * s, y = rand() * s, len = 2 + rand() * 5, a = (rand() - 0.5) * 1.2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(a) * len, y - Math.cos(a) * len); g.stroke();
    }
    grain(g, s, 10, rand);
  },

  /** Clipped hedge: tight leaf clumps with a soft top-lit falloff. */
  [SURFACE.HEDGE]: (g, s, rand) => {
    flat(g, s, 186);
    wrapped(g, s, () => {
      const r2 = rng(0x4e2f);
      for (let i = 0; i < 260; i++) {
        const x = r2() * s, y = r2() * s, r = 2 + r2() * 6;
        g.globalAlpha = 0.2 + r2() * 0.45;
        g.fillStyle = r2() > 0.45 ? '#ffffff' : '#1c3a18';
        g.beginPath(); g.ellipse(x, y, r, r * (0.6 + r2() * 0.6), r2() * 3, 0, 7); g.fill();
      }
    });
    g.globalAlpha = 1;
    grain(g, s, 14, rand);
  },

  /**
   * Garden fence: three wide horizontal boards with real gaps between them and
   * a post every tile. The gaps are drawn dark rather than cut out — the boxes
   * behind a fence are solid, so a see-through alpha here would only show sky.
   */
  [SURFACE.FENCE]: (g, s, rand) => {
    flat(g, s, 96);
    const rows = 3, rh = s / rows;
    for (let r = 0; r < rows; r++) {
      const y = r * rh + rh * 0.08, h = rh * 0.8;
      g.fillStyle = lum(214 + rand() * 34);
      g.fillRect(-1, y, s + 2, h);
      g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(-1, y, s + 2, Math.max(1, h * 0.14));
      g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(-1, y + h - Math.max(1, h * 0.16), s + 2, Math.max(1, h * 0.16));
      for (let k = 0; k < 40; k++) {                          // grain along the board
        g.fillStyle = `rgba(${rand() > 0.5 ? '92,60,28' : '255,246,226'},${0.05 + rand() * 0.12})`;
        g.fillRect(rand() * s, y + rand() * h, 8 + rand() * 40, 1);
      }
    }
    // Post: a darker vertical strap holding the boards, wrapped over the seam.
    g.fillStyle = 'rgba(0,0,0,.22)';
    g.fillRect(s * 0.06, 0, s * 0.1, s);
    g.fillStyle = 'rgba(255,255,255,.12)';
    g.fillRect(s * 0.06, 0, s * 0.03, s);
    grain(g, s, 12, rand);
  },

  /** Painted lap siding — the wall of every house in town. */
  [SURFACE.SIDING]: (g, s, rand) => {
    boards(g, s, 7, rand, { vary: 0.07, gap: 0.09, shadow: 0.2, base: 240 });
    grain(g, s, 7, rand);
  },

  /**
   * A glazed window: dark frame, four panes, and a sky reflection sliding
   * across them. Drawn as its own material rather than a decal so a whole
   * façade can be built by dropping one thin box over the siding.
   */
  [SURFACE.WINDOW]: (g, s) => {
    flat(g, s, 70);                                            // frame
    const m = s * 0.08, bar = s * 0.045;
    const pane = (x, y, w, h) => {
      const grd = g.createLinearGradient(x, y, x + w, y + h);
      grd.addColorStop(0, 'rgba(255,255,255,.98)');
      grd.addColorStop(0.42, 'rgba(196,226,246,.92)');
      grd.addColorStop(0.62, 'rgba(120,168,204,.92)');
      grd.addColorStop(1, 'rgba(206,232,250,.96)');
      g.fillStyle = grd; g.fillRect(x, y, w, h);
      // A hard diagonal glint: the thing that says "glass" at forty metres.
      g.save();
      g.beginPath(); g.rect(x, y, w, h); g.clip();
      g.fillStyle = 'rgba(255,255,255,.5)';
      g.beginPath();
      g.moveTo(x - w * 0.1, y + h * 0.9); g.lineTo(x + w * 0.55, y - h * 0.1);
      g.lineTo(x + w * 0.8, y - h * 0.1); g.lineTo(x + w * 0.15, y + h * 0.9);
      g.closePath(); g.fill();
      g.restore();
    };
    const pw = (s - m * 2 - bar) / 2, ph = pw;
    pane(m, m, pw, ph);
    pane(m + pw + bar, m, pw, ph);
    pane(m, m + ph + bar, pw, ph);
    pane(m + pw + bar, m + ph + bar, pw, ph);
    // Frame shading, so it does not read as a flat black square.
    g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = Math.max(1, s / 128);
    g.strokeRect(m * 0.4, m * 0.4, s - m * 0.8, s - m * 0.8);
    g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = Math.max(1, s / 160);
    g.strokeRect(0.5, 0.5, s - 1, s - 1);
  },

  /** Bright shingle roof: staggered rectangular tabs, not the old scalloped tile. */
  [SURFACE.SHINGLE]: (g, s, rand) => {
    flat(g, s, 170);
    const rows = 6, rh = s / rows, tw = s / 5;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * (tw / 2), y = r * rh;
      for (let c = -1; c < 6; c++) {
        const x = c * tw + off;
        g.fillStyle = lum(206 + rand() * 46);
        g.fillRect(x + 1, y + 1, tw - 2, rh - 2);
        g.fillStyle = 'rgba(255,255,255,.18)';
        g.fillRect(x + 1, y + 1, tw - 2, Math.max(1, rh * 0.16));
      }
      // The shadow line under a course of tabs, drawn after them so it reads
      // as one continuous edge rather than one nick per shingle.
      g.fillStyle = 'rgba(0,0,0,.3)';
      g.fillRect(0, y + rh - Math.max(1.5, rh * 0.12), s, Math.max(1.5, rh * 0.12));
    }
    grain(g, s, 12, rand);
  },

  /** Tree trunk: vertical fibre with deep shadow channels. */
  [SURFACE.BARK]: (g, s, rand) => {
    flat(g, s, 204);
    for (let i = 0; i < 120; i++) {
      const x = rand() * s, w = 1 + rand() * 5;
      g.fillStyle = `rgba(${rand() > 0.5 ? '48,30,14' : '255,240,214'},${0.08 + rand() * 0.2})`;
      g.fillRect(x, -1, w, s + 2);
    }
    g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = Math.max(1.5, s / 110);
    for (let i = 0; i < 7; i++) {
      let x = rand() * s;
      g.beginPath(); g.moveTo(x, 0);
      for (let y = 0; y <= s; y += s / 8) { x += (rand() - 0.5) * 5; g.lineTo(x, y); }
      g.stroke();
    }
    grain(g, s, 14, rand);
  },

  /** Still water: layered ripple rings and a broad specular sheet. */
  [SURFACE.WATER]: (g, s, rand) => {
    flat(g, s, 224);
    wrapped(g, s, () => {
      const r2 = rng(0x1f5c);
      g.strokeStyle = 'rgba(255,255,255,.3)';
      for (let i = 0; i < 26; i++) {
        g.lineWidth = 1 + r2() * 2;
        g.beginPath();
        g.ellipse(r2() * s, r2() * s, 4 + r2() * 26, 2 + r2() * 10, r2() * 3, 0, 7);
        g.stroke();
      }
    });
    const grd = g.createLinearGradient(0, 0, s, s);
    grd.addColorStop(0, 'rgba(255,255,255,.3)');
    grd.addColorStop(0.5, 'rgba(0,0,0,.08)');
    grd.addColorStop(1, 'rgba(255,255,255,.24)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    grain(g, s, 5, rand);
  },

  /** Striped awning canvas — market stalls, shopfronts, porch covers. */
  [SURFACE.CANVAS]: (g, s, rand) => {
    const n = 6, bw = s / n;
    for (let i = 0; i < n; i++) {
      g.fillStyle = lum(i % 2 ? 252 : 176);
      g.fillRect(i * bw, -1, bw, s + 2);
    }
    g.fillStyle = 'rgba(0,0,0,.12)';
    for (let i = 0; i < n; i++) g.fillRect(i * bw, -1, Math.max(1, bw * 0.06), s + 2);
    for (let i = 0; i < 200; i++) {                            // weave
      g.fillStyle = `rgba(${rand() > 0.5 ? '255,255,255' : '60,54,44'},${0.04 + rand() * 0.08})`;
      g.fillRect(0, rand() * s, s, 1);
    }
    grain(g, s, 8, rand);
  },

  /** Pavement slabs and kerbs: big, clean, obvious grid. */
  [SURFACE.TARMAC]: (g, s, rand) => {
    const n = 2, ts = s / n;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        g.fillStyle = lum(228 + rand() * 22);
        g.fillRect(x * ts, y * ts, ts, ts);
        g.fillStyle = 'rgba(255,255,255,.14)';
        g.fillRect(x * ts + 2, y * ts + 2, ts - 4, Math.max(1, ts * 0.05));
      }
    }
    g.fillStyle = 'rgba(0,0,0,.26)';
    for (let i = 0; i <= n; i++) {
      g.fillRect(i * ts - 1.5, 0, 3, s);
      g.fillRect(0, i * ts - 1.5, s, 3);
    }
    blotches(g, s, 10, rand, ['#dcdcdc', '#f2f2f2'], s * 0.06, s * 0.2, 0.14);
    grain(g, s, 10, rand);
  },

  /** Signage panel: a bright face, a hard border, and a faint scanline. */
  [SURFACE.NEON]: (g, s, rand) => {
    flat(g, s, 252);
    const grd = g.createRadialGradient(s / 2, s / 2, s * 0.05, s / 2, s / 2, s * 0.72);
    grd.addColorStop(0, 'rgba(255,255,255,.9)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(0,0,0,.42)'; g.lineWidth = Math.max(3, s / 34);
    g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, s - g.lineWidth, s - g.lineWidth);
    g.fillStyle = 'rgba(0,0,0,.06)';
    for (let y = 0; y < s; y += 4) g.fillRect(0, y, s, 1);
    grain(g, s, 4, rand);
  },
};

/** Shading response per surface — feeds the material's specular. */
export const SURFACE_SHADING = {
  [SURFACE.CONCRETE]: { shininess: 6, specular: 0x121416 },
  [SURFACE.BRICK]: { shininess: 4, specular: 0x0e1012 },
  [SURFACE.PLASTER]: { shininess: 3, specular: 0x0c0e10 },
  [SURFACE.WOOD]: { shininess: 14, specular: 0x1a1512 },
  [SURFACE.PLANK]: { shininess: 10, specular: 0x161210 },
  [SURFACE.METAL]: { shininess: 58, specular: 0x51585f },
  [SURFACE.RUST]: { shininess: 20, specular: 0x2a2622 },
  [SURFACE.GRATE]: { shininess: 44, specular: 0x3d434a },
  [SURFACE.SAND]: { shininess: 3, specular: 0x0d0c0a },
  [SURFACE.ROCK]: { shininess: 7, specular: 0x131313 },
  [SURFACE.DIRT]: { shininess: 2, specular: 0x0a0908 },
  [SURFACE.SNOW]: { shininess: 26, specular: 0x2e3742 },
  [SURFACE.ICE]: { shininess: 74, specular: 0x5a7484 },
  [SURFACE.TILE]: { shininess: 48, specular: 0x3a3f44 },
  [SURFACE.ROOF]: { shininess: 8, specular: 0x151112 },
  [SURFACE.CRATE]: { shininess: 8, specular: 0x151210 },
  [SURFACE.FOLIAGE]: { shininess: 4, specular: 0x0e120e },
  [SURFACE.GLASS]: { shininess: 96, specular: 0x8fb6cc },

  [SURFACE.ASPHALT]: { shininess: 5, specular: 0x0f1012 },
  [SURFACE.PAINT]: { shininess: 42, specular: 0x2e3238 },
  [SURFACE.GRASS]: { shininess: 2, specular: 0x0a0d0a },
  [SURFACE.HEDGE]: { shininess: 3, specular: 0x0c100c },
  [SURFACE.FENCE]: { shininess: 9, specular: 0x161210 },
  [SURFACE.SIDING]: { shininess: 16, specular: 0x1c1e20 },
  [SURFACE.WINDOW]: { shininess: 110, specular: 0x9ec4dc },
  [SURFACE.SHINGLE]: { shininess: 6, specular: 0x131112 },
  [SURFACE.BARK]: { shininess: 3, specular: 0x120e0a },
  [SURFACE.WATER]: { shininess: 120, specular: 0x86b6cc },
  [SURFACE.CANVAS]: { shininess: 6, specular: 0x141312 },
  [SURFACE.TARMAC]: { shininess: 8, specular: 0x16181a },
  [SURFACE.NEON]: { shininess: 60, specular: 0x6a6250 },
  // The boundary is never drawn, but every material carries a full entry so
  // the tables stay total: a gap here would only ever surface as a silent
  // fallback the day something did get rendered with it.
  [SURFACE.VOID]: { shininess: 0, specular: 0x000000 },
};

/** World units one texture tile covers. Bigger = coarser. */
export const SURFACE_TILE = {
  [SURFACE.CONCRETE]: 4, [SURFACE.BRICK]: 3, [SURFACE.PLASTER]: 4.5,
  [SURFACE.WOOD]: 2.4, [SURFACE.PLANK]: 3, [SURFACE.METAL]: 3.2,
  [SURFACE.RUST]: 3.2, [SURFACE.GRATE]: 2, [SURFACE.SAND]: 6,
  [SURFACE.ROCK]: 4, [SURFACE.DIRT]: 5, [SURFACE.SNOW]: 5,
  [SURFACE.ICE]: 6, [SURFACE.TILE]: 2.4, [SURFACE.ROOF]: 2.6,
  [SURFACE.CRATE]: 1.3, [SURFACE.FOLIAGE]: 2, [SURFACE.GLASS]: 2,

  [SURFACE.ASPHALT]: 7, [SURFACE.PAINT]: 5, [SURFACE.GRASS]: 3.4,
  [SURFACE.HEDGE]: 1.8, [SURFACE.FENCE]: 2.2, [SURFACE.SIDING]: 2.6,
  // One window tile is one window: the box it is painted on is sized to match.
  [SURFACE.WINDOW]: 1.6, [SURFACE.SHINGLE]: 2.4, [SURFACE.BARK]: 1.6,
  [SURFACE.WATER]: 8, [SURFACE.CANVAS]: 2.2, [SURFACE.TARMAC]: 3,
  [SURFACE.NEON]: 4, [SURFACE.VOID]: 4,
};

/** Configure resolution before the first request; safe to call again later. */
export function configureTextures({ resolution = 256, aniso = 4 } = {}) {
  if (resolution !== RES) {
    // Only the surface tiles are resolution-dependent. Sprites are fixed-size
    // and are held by live particle systems, so they must survive this.
    for (const [key, tex] of cache) {
      if (key.startsWith('sprite:')) continue;
      tex.dispose();
      cache.delete(key);
    }
    RES = resolution;
  }
  anisotropy = aniso;
  for (const [key, tex] of cache) {
    if (!key.startsWith('sprite:')) tex.anisotropy = aniso;
  }
}

/** Builds (and caches) the tiling texture for one surface material. */
export function surfaceTexture(mat) {
  const key = RECIPES[mat] ? mat : SURFACE.CONCRETE;
  const cached = cache.get(key);
  if (cached) return cached;

  const cnv = canvas(RES);
  const g = cnv.getContext('2d');
  let seed = 0;
  for (const ch of key) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
  RECIPES[key](g, RES, rng(seed || 1));

  const tex = new THREE.CanvasTexture(cnv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** A small square sprite used for particles, decals and flashes. */
export function spriteTexture(kind) {
  const key = `sprite:${kind}`;
  if (cache.has(key)) return cache.get(key);
  const size = 64;
  const cnv = canvas(size);
  const g = cnv.getContext('2d');
  const rand = rng(kind.length * 7919 + 13);

  if (kind === 'smoke') {
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grd.addColorStop(0, 'rgba(255,255,255,.85)');
    grd.addColorStop(0.45, 'rgba(255,255,255,.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 26; i++) {
      g.globalAlpha = 0.16 + rand() * 0.2;
      g.beginPath(); g.arc(rand() * size, rand() * size, 3 + rand() * 9, 0, 7); g.fill();
    }
  } else if (kind === 'flash') {
    // Four-point star with a hot core — a muzzle flare, not a blob.
    const grd = g.createRadialGradient(32, 32, 1, 32, 32, 22);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,232,160,.9)');
    grd.addColorStop(1, 'rgba(255,150,40,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(32, 32, 26, 0, 7); g.fill();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(255,244,205,.85)';
    for (let i = 0; i < 4; i++) {
      g.save(); g.translate(32, 32); g.rotate((i * Math.PI) / 2 + Math.PI / 4);
      g.beginPath(); g.moveTo(-2.5, 0); g.lineTo(0, -31); g.lineTo(2.5, 0); g.lineTo(0, -6); g.closePath(); g.fill();
      g.restore();
    }
  } else if (kind === 'hole') {
    // Bullet hole decal: dark pit, bright rim, radial cracks.
    g.clearRect(0, 0, size, size);
    const grd = g.createRadialGradient(32, 32, 1, 32, 32, 20);
    grd.addColorStop(0, 'rgba(8,8,10,.96)');
    grd.addColorStop(0.42, 'rgba(24,22,22,.78)');
    grd.addColorStop(0.62, 'rgba(150,146,140,.42)');
    grd.addColorStop(1, 'rgba(150,146,140,0)');
    g.fillStyle = grd; g.fillRect(0, 0, size, size);
    g.strokeStyle = 'rgba(210,206,198,.4)';
    g.lineWidth = 1.2;
    for (let i = 0; i < 9; i++) {
      const a = rand() * Math.PI * 2;
      g.beginPath();
      g.moveTo(32 + Math.cos(a) * 7, 32 + Math.sin(a) * 7);
      g.lineTo(32 + Math.cos(a) * (12 + rand() * 12), 32 + Math.sin(a) * (12 + rand() * 12));
      g.stroke();
    }
    g.fillStyle = 'rgba(0,0,0,.95)';
    g.beginPath(); g.arc(32, 32, 5.2, 0, 7); g.fill();
  } else if (kind === 'blood') {
    g.clearRect(0, 0, size, size);
    g.fillStyle = 'rgba(120,12,18,.72)';
    for (let i = 0; i < 12; i++) {
      const a = rand() * Math.PI * 2, d = rand() * 20;
      g.globalAlpha = 0.3 + rand() * 0.5;
      g.beginPath();
      g.ellipse(32 + Math.cos(a) * d, 32 + Math.sin(a) * d, 3 + rand() * 9, 3 + rand() * 8, a, 0, 7);
      g.fill();
    }
  } else {                                    // 'spark' — a soft round dot
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,.6)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, size, size);
  }

  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

export function disposeTextures() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
