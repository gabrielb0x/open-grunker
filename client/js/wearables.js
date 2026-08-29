/**
 * Open Grunker — worn cosmetics.
 *
 * Headwear, faces, backpacks and charms, built from boxes and cylinders at the
 * moment they are equipped. Nothing here is loaded: a cosmetic in this game is
 * a recipe (`shape` plus two or three colours, see shared/cosmetics.js) rather
 * than a mesh, so a wardrobe of ninety items costs the download nothing and
 * the frame budget almost nothing.
 *
 * ── Why boxes ──────────────────────────────────────────────────────────────
 *
 * The operator everybody else sees is thirty boxes. A crown modelled at a
 * different fidelity to the head it sits on does not read as better, it reads
 * as *stuck on* — so every shape here is cut from the same blocky vocabulary
 * as the body, and a top hat is a cylinder and a brim because that is what a
 * top hat is at forty metres.
 *
 * ── What a builder returns ─────────────────────────────────────────────────
 *
 * `{ group, meshes }`. The group is parented wherever the caller wants it; the
 * meshes are handed back flat because the body's hit flash and death fade walk
 * a list of materials rather than the scene graph, and a hat that did not fade
 * with the corpse under it would hang in the air.
 *
 * Every builder is also used by the loadout preview, which is the point: what
 * the wardrobe screen draws and what the other nine players see are the same
 * code, so nothing can be bought on the strength of a preview that lies.
 */
import * as THREE from 'three';
import { getItem, SLOT, ANIM } from '/shared/cosmetics.js';

/* ── Geometry, cached ────────────────────────────────────────────────────── */

const boxes = new Map();
const cyls = new Map();
const spheres = new Map();

function box(w, h, d) {
  const key = `${w}|${h}|${d}`;
  let g = boxes.get(key);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); g.userData.shared = true; boxes.set(key, g); }
  return g;
}

function cyl(rt, rb, h, seg = 10) {
  const key = `${rt}|${rb}|${h}|${seg}`;
  let g = cyls.get(key);
  if (!g) { g = new THREE.CylinderGeometry(rt, rb, h, seg); g.userData.shared = true; cyls.set(key, g); }
  return g;
}

function sphere(r, seg = 10) {
  const key = `${r}|${seg}`;
  let g = spheres.get(key);
  if (!g) { g = new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1)); g.userData.shared = true; spheres.set(key, g); }
  return g;
}

/**
 * A material factory scoped to one body.
 *
 * Materials are per body for the same reason the body's own are: a hit flashes
 * them and a death fades them, and two players sharing one material would
 * flash and die together. Inside one body they are still shared by colour, so
 * a helmet and its crown are one draw call rather than two.
 */
function palette() {
  const cache = new Map();
  return (color, opts = {}) => {
    const key = `${color}|${opts.shininess ?? 8}|${opts.emissive ?? -1}|${opts.opacity ?? 1}`;
    let mat = cache.get(key);
    if (!mat) {
      mat = new THREE.MeshPhongMaterial({
        color, shininess: 8, specular: 0x14181d, ...opts,
        ...(opts.opacity != null && opts.opacity < 1 ? { transparent: true } : {}),
      });
      cache.set(key, mat);
    }
    return mat;
  };
}

/** Shading for a wearable, derived from its `gloss` and `glow`. */
function shade(def) {
  const gloss = def?.gloss ?? 0;
  return {
    shininess: 8 + gloss * 60,
    specular: new THREE.Color(0x14181d).multiplyScalar(1 + gloss),
    ...(def?.glow ? { emissive: def.glow } : {}),
  };
}

/* ── Headwear ────────────────────────────────────────────────────────────── */

/**
 * Every hat, keyed by the `shape` its catalogue entry names.
 *
 * They are positioned in the body's own space — the head sits at y 1.68 and
 * the issue helmet at 1.9 — so a hat is added to the character root rather
 * than to the head, and the pose code that nods the head leaves it alone. That
 * is deliberate: a top hat that pitched with a sprint animation looks like a
 * bug, and nobody has ever asked for it.
 */
const HEADS = {
  none() { return []; },

  helmet(mk, def) {
    const [a, b] = def.colors ?? [0x23272d, 0x343a42];
    const scale = def.h ?? 1;
    const shell = new THREE.Mesh(box(0.44, 0.22 * scale, 0.44), mk(a, shade(def)));
    shell.position.y = 1.9;
    const crown = new THREE.Mesh(box(0.36, 0.08 * scale, 0.36), mk(a, shade(def)));
    crown.position.y = 2.0 + (scale - 1) * 0.1;
    const brim = new THREE.Mesh(box(0.46, 0.05, 0.14), mk(b, shade(def)));
    brim.position.set(0, 1.84, -0.22);
    const out = [shell, crown, brim];
    if (def.visor) {
      // A riot visor is the one hat piece that is glass, so it is the one that
      // gets transparency — everything else here is opaque and cheap.
      const visor = new THREE.Mesh(box(0.42, 0.2, 0.06), mk(b, { ...shade(def), opacity: 0.45, shininess: 90 }));
      visor.position.set(0, 1.7, -0.2);
      out.push(visor);
    }
    if (def.pads) {
      for (const sx of [-1, 1]) {
        const pad = new THREE.Mesh(box(0.07, 0.14, 0.2), mk(b, shade(def)));
        pad.position.set(sx * 0.22, 1.78, 0);
        out.push(pad);
      }
    }
    return out;
  },

  cap(mk, def) {
    const [a, b] = def.colors ?? [0x2f3a48, 0x1e2530];
    const crown = new THREE.Mesh(box(0.4, 0.14, 0.4), mk(a, shade(def)));
    crown.position.y = 1.9;
    const peak = new THREE.Mesh(box(0.36, 0.04, 0.22), mk(b, shade(def)));
    peak.position.set(0, 1.85, -0.28);
    return [crown, peak];
  },

  beanie(mk, def) {
    const [a, b] = def.colors ?? [0x2a2e34, 0x3a3f46];
    const cap = new THREE.Mesh(box(0.42, 0.2, 0.42), mk(a, shade(def)));
    cap.position.y = 1.9;
    const roll = new THREE.Mesh(box(0.44, 0.07, 0.44), mk(b, shade(def)));
    roll.position.y = 1.82;
    const out = [cap, roll];
    if (def.pads) {
      for (const sx of [-1, 1]) {
        const pad = new THREE.Mesh(box(0.06, 0.16, 0.2), mk(b, shade(def)));
        pad.position.set(sx * 0.22, 1.76, 0);
        out.push(pad);
      }
    }
    return out;
  },

  bucket(mk, def) {
    const [a, b] = def.colors ?? [0x4a5a38, 0x3a4630];
    const crown = new THREE.Mesh(box(0.4, 0.18, 0.4), mk(a, shade(def)));
    crown.position.y = 1.9;
    const brim = new THREE.Mesh(box(0.62, 0.04, 0.62), mk(b, shade(def)));
    brim.position.y = 1.82;
    return [crown, brim];
  },

  beret(mk, def) {
    const [a, b] = def.colors ?? [0x6b1720, 0x2a0d11];
    const disc = new THREE.Mesh(cyl(0.26, 0.23, 0.1, 12), mk(a, shade(def)));
    disc.position.set(0.04, 1.88, 0);
    disc.rotation.z = -0.14;
    const band = new THREE.Mesh(cyl(0.2, 0.2, 0.05, 12), mk(b, shade(def)));
    band.position.y = 1.83;
    return [disc, band];
  },

  cowboy(mk, def) {
    const [a, b] = def.colors ?? [0x6b4a2a, 0x4a3220];
    const crown = new THREE.Mesh(cyl(0.16, 0.19, 0.24, 10), mk(a, shade(def)));
    crown.position.y = 1.96;
    const brim = new THREE.Mesh(cyl(0.42, 0.42, 0.035, 14), mk(a, shade(def)));
    brim.position.y = 1.84;
    const band = new THREE.Mesh(cyl(0.2, 0.2, 0.05, 10), mk(b, shade(def)));
    band.position.y = 1.86;
    return [crown, brim, band];
  },

  hood(mk, def) {
    const [a, b] = def.colors ?? [0x22262c, 0x14171b];
    const back = new THREE.Mesh(box(0.46, 0.4, 0.2), mk(a, shade(def)));
    back.position.set(0, 1.78, 0.16);
    const top = new THREE.Mesh(box(0.46, 0.16, 0.44), mk(a, shade(def)));
    top.position.y = 1.94;
    const l = new THREE.Mesh(box(0.08, 0.34, 0.4), mk(b, shade(def)));
    l.position.set(-0.21, 1.72, 0);
    const r = l.clone();
    r.position.x = 0.21;
    return [back, top, l, r];
  },

  tophat(mk, def) {
    const [a, b] = def.colors ?? [0x0e1013, 0x8a1f2c];
    const crown = new THREE.Mesh(cyl(0.19, 0.19, 0.42, 12), mk(a, { ...shade(def), shininess: 70 }));
    crown.position.y = 2.06;
    const brim = new THREE.Mesh(cyl(0.36, 0.36, 0.035, 14), mk(a, shade(def)));
    brim.position.y = 1.85;
    const band = new THREE.Mesh(cyl(0.196, 0.196, 0.07, 12), mk(b, shade(def)));
    band.position.y = 1.9;
    return [crown, brim, band];
  },

  crown(mk, def) {
    const [a, b] = def.colors ?? [0xd4a520, 0x8a1f2c];
    const band = new THREE.Mesh(cyl(0.22, 0.22, 0.09, 12), mk(a, { ...shade(def), shininess: 110 }));
    band.position.y = 1.9;
    const out = [band];
    // Five points, evenly around — and one gem apiece, which is most of what
    // reads as a crown rather than as a bracelet on somebody's head.
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      const spike = new THREE.Mesh(cyl(0.005, 0.035, 0.14, 6), mk(a, { ...shade(def), shininess: 110 }));
      spike.position.set(Math.cos(ang) * 0.2, 2.0, Math.sin(ang) * 0.2);
      out.push(spike);
      const gem = new THREE.Mesh(sphere(0.028, 8), mk(b, { shininess: 120, emissive: b }));
      gem.position.set(Math.cos(ang) * 0.2, 1.93, Math.sin(ang) * 0.2);
      out.push(gem);
    }
    return out;
  },

  horns(mk, def) {
    const [a, b] = def.colors ?? [0x2a1a14, 0xd9cfbb];
    const scale = def.h ?? 1;
    const out = [];
    for (const sx of [-1, 1]) {
      // Three tapering segments, each rolled further out and up: a curve made
      // of straight pieces, which is the whole visual language of this game.
      let x = sx * 0.15;
      let y = 1.9;
      for (let seg = 0; seg < 3; seg++) {
        const len = (0.16 - seg * 0.03) * scale;
        const piece = new THREE.Mesh(cyl(0.028 - seg * 0.008, 0.045 - seg * 0.009, len, 7),
          mk(seg === 2 ? b : a, shade(def)));
        piece.position.set(x, y, -0.02 - seg * 0.02);
        // Each segment rakes a little further out than the last, but never far
        // enough to be horizontal: horns that stick straight out read as
        // antennae, and they widen the silhouette in a way a cosmetic must not.
        piece.rotation.z = sx * (0.3 + seg * 0.16);
        out.push(piece);
        x += sx * len * 0.42;
        y += len * 0.86;
      }
    }
    return out;
  },

  mohawk(mk, def) {
    const [a, b] = def.colors ?? [0x35f6e8, 0x1a1c20];
    const base = new THREE.Mesh(box(0.4, 0.1, 0.4), mk(b, shade(def)));
    base.position.y = 1.87;
    const out = [base];
    for (let i = 0; i < 6; i++) {
      const h = 0.1 + Math.sin((i / 5) * Math.PI) * 0.13;
      const fin = new THREE.Mesh(box(0.05, h, 0.06), mk(a, { ...shade(def), emissive: def.glow ?? 0 }));
      fin.position.set(0, 1.92 + h / 2, 0.15 - i * 0.06);
      out.push(fin);
    }
    return out;
  },

  /**
   * A ring that floats above the head and never touches it.
   *
   * Off the head on purpose: a halo resting on a helmet is a hat, and the
   * whole read of this item is that it is not attached to anything.
   */
  halo(mk, def) {
    const [a, b] = def.colors ?? [0xffe9a8, 0xffc04d];
    const out = [];
    const seg = 14;
    for (let i = 0; i < seg; i++) {
      const ang = (i / seg) * Math.PI * 2;
      const bead = new THREE.Mesh(box(0.05, 0.03, 0.05),
        mk(i % 2 ? a : b, { shininess: 120, emissive: def.glow ?? a }));
      bead.position.set(Math.cos(ang) * 0.26, 2.16, Math.sin(ang) * 0.26);
      bead.rotation.y = -ang;
      out.push(bead);
    }
    return out;
  },

  /** A crown of fire: tongues around the skull, lit rather than shaded. */
  flame(mk, def) {
    const [a, b] = def.colors ?? [0xff4d1a, 0xffd166];
    const out = [];
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2;
      const h = 0.14 + ((i * 7) % 5) * 0.035;
      const tongue = new THREE.Mesh(cyl(0.004, 0.035, h, 6),
        mk(i % 3 ? a : b, { shininess: 100, emissive: def.glow ?? a }));
      tongue.position.set(Math.cos(ang) * 0.19, 1.92 + h / 2, Math.sin(ang) * 0.19);
      tongue.rotation.z = Math.cos(ang) * 0.25;
      tongue.rotation.x = -Math.sin(ang) * 0.25;
      out.push(tongue);
    }
    return out;
  },
};

/* ── Faces ───────────────────────────────────────────────────────────────── */

const FACES = {
  none() { return []; },

  balaclava(mk, def) {
    const [a] = def.colors ?? [0x1a1d22];
    const m = new THREE.Mesh(box(0.4, 0.24, 0.38), mk(a, shade(def)));
    m.position.set(0, 1.63, 0.01);
    return [m];
  },

  shades(mk, def) {
    const [a, b] = def.colors ?? [0x0e1013, 0x2a2e34];
    const lens = new THREE.Mesh(box(0.36, 0.07, 0.05), mk(a, { ...shade(def), shininess: 100 }));
    lens.position.set(0, 1.71, -0.18);
    const bridge = new THREE.Mesh(box(0.38, 0.02, 0.06), mk(b, shade(def)));
    bridge.position.set(0, 1.75, -0.17);
    return [lens, bridge];
  },

  bandana(mk, def) {
    const [a, b] = def.colors ?? [0x8a1f2c, 0xe8e6de];
    const wrap = new THREE.Mesh(box(0.4, 0.16, 0.38), mk(a, shade(def)));
    wrap.position.set(0, 1.6, 0.01);
    const knot = new THREE.Mesh(box(0.1, 0.09, 0.1), mk(b, shade(def)));
    knot.position.set(0.16, 1.58, 0.16);
    return [wrap, knot];
  },

  goggles(mk, def) {
    const [a, b] = def.colors ?? [0x2a2e34, 0x66c8ff];
    const strap = new THREE.Mesh(box(0.42, 0.09, 0.4), mk(a, shade(def)));
    strap.position.set(0, 1.73, 0);
    const out = [strap];
    for (const sx of [-1, 1]) {
      const lens = new THREE.Mesh(cyl(0.06, 0.06, 0.05, 10), mk(b, { shininess: 110, emissive: 0x0a1a24, opacity: 0.8 }));
      lens.position.set(sx * 0.1, 1.73, -0.19);
      lens.rotation.x = Math.PI / 2;
      out.push(lens);
    }
    return out;
  },

  nvg(mk, def) {
    const [a, b] = def.colors ?? [0x2a2e34, 0x66ff99];
    const mount = new THREE.Mesh(box(0.16, 0.07, 0.1), mk(a, shade(def)));
    mount.position.set(0, 1.84, -0.16);
    const out = [mount];
    for (const sx of [-1, 1]) {
      const tube = new THREE.Mesh(cyl(0.037, 0.037, 0.16, 9), mk(a, shade(def)));
      tube.position.set(sx * 0.055, 1.76, -0.24);
      tube.rotation.x = Math.PI / 2;
      out.push(tube);
      const glass = new THREE.Mesh(cyl(0.031, 0.031, 0.02, 9), mk(b, { shininess: 120, emissive: def.glow ?? b }));
      glass.position.set(sx * 0.055, 1.76, -0.32);
      glass.rotation.x = Math.PI / 2;
      out.push(glass);
    }
    return out;
  },

  respirator(mk, def) {
    const [a, b] = def.colors ?? [0x2f3a2a, 0x1a2018];
    const cup = new THREE.Mesh(box(0.3, 0.16, 0.14), mk(a, shade(def)));
    cup.position.set(0, 1.6, -0.15);
    const out = [cup];
    for (const sx of [-1, 1]) {
      const can = new THREE.Mesh(cyl(0.055, 0.055, 0.09, 9), mk(b, shade(def)));
      can.position.set(sx * 0.13, 1.6, -0.23);
      can.rotation.x = Math.PI / 2;
      out.push(can);
    }
    return out;
  },

  /** Two stripes across the eyes. No geometry that is not paint. */
  paint(mk, def) {
    const [a, b] = def.colors ?? [0x1a1d22, 0xd6203c];
    const out = [];
    for (const [sx, colour] of [[-1, b], [1, a]]) {
      const stripe = new THREE.Mesh(box(0.14, 0.05, 0.02), mk(colour, shade(def)));
      stripe.position.set(sx * 0.09, 1.71, -0.185);
      stripe.rotation.z = sx * 0.14;
      out.push(stripe);
    }
    return out;
  },

  /** A flat plate over the whole face — hockey mask, oni, anything rigid. */
  plate(mk, def) {
    const [a, b] = def.colors ?? [0xe6e1d4, 0x8a8172];
    const face = new THREE.Mesh(box(0.34, 0.3, 0.06), mk(a, { ...shade(def), shininess: 40 }));
    face.position.set(0, 1.66, -0.18);
    const out = [face];
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(box(0.07, 0.05, 0.03), mk(b, shade(def)));
      eye.position.set(sx * 0.08, 1.72, -0.21);
      out.push(eye);
    }
    const mouth = new THREE.Mesh(box(0.13, 0.03, 0.03), mk(b, shade(def)));
    mouth.position.set(0, 1.58, -0.21);
    out.push(mouth);
    return out;
  },

  skull(mk, def) {
    const [a, b] = def.colors ?? [0xd9cfbb, 0x14161c];
    const face = new THREE.Mesh(box(0.34, 0.3, 0.07), mk(a, { ...shade(def), shininess: 30 }));
    face.position.set(0, 1.66, -0.18);
    const out = [face];
    for (const sx of [-1, 1]) {
      const socket = new THREE.Mesh(box(0.09, 0.09, 0.04), mk(b, { emissive: def.glow ?? 0 }));
      socket.position.set(sx * 0.08, 1.73, -0.21);
      out.push(socket);
    }
    // Teeth: five blocks with the gaps between them doing the work.
    for (let i = 0; i < 5; i++) {
      const tooth = new THREE.Mesh(box(0.028, 0.05, 0.03), mk(b));
      tooth.position.set(-0.08 + i * 0.04, 1.56, -0.21);
      out.push(tooth);
    }
    return out;
  },

  /** One unbroken pane where a face should be. */
  visor(mk, def) {
    const [a, b] = def.colors ?? [0x0d1117, 0x35f6e8];
    const shell = new THREE.Mesh(box(0.4, 0.26, 0.08), mk(a, { ...shade(def), shininess: 80 }));
    shell.position.set(0, 1.67, -0.17);
    const pane = new THREE.Mesh(box(0.32, 0.11, 0.03), mk(b, { shininess: 130, emissive: def.glow ?? b }));
    pane.position.set(0, 1.71, -0.22);
    return [shell, pane];
  },
};

/* ── Backs ───────────────────────────────────────────────────────────────── */

const BACKS = {
  none() { return []; },

  pack(mk, def) {
    const [a, b] = def.colors ?? [0x23272d, 0x343a42];
    const h = 0.5 * (def.h ?? 1);
    const body = new THREE.Mesh(box(0.4, h, 0.2), mk(a, shade(def)));
    body.position.set(0, 1.2, 0.26);
    const lid = new THREE.Mesh(box(0.42, 0.08, 0.22), mk(b, shade(def)));
    lid.position.set(0, 1.2 + h / 2 - 0.02, 0.27);
    return [body, lid];
  },

  roll(mk, def) {
    const [a, b] = def.colors ?? [0x6b5a44, 0x3f3427];
    const bed = new THREE.Mesh(cyl(0.1, 0.1, 0.46, 10), mk(a, shade(def)));
    bed.position.set(0, 1.34, 0.26);
    bed.rotation.z = Math.PI / 2;
    const strap = new THREE.Mesh(box(0.48, 0.04, 0.04), mk(b, shade(def)));
    strap.position.set(0, 1.34, 0.36);
    return [bed, strap];
  },

  radio(mk, def) {
    const [a, b] = def.colors ?? [0x2f3a2a, 0x1a2018];
    const body = new THREE.Mesh(box(0.34, 0.4, 0.18), mk(a, shade(def)));
    body.position.set(0, 1.2, 0.25);
    const dial = new THREE.Mesh(box(0.1, 0.1, 0.04), mk(b, { ...shade(def), emissive: def.glow ?? 0 }));
    dial.position.set(-0.08, 1.3, 0.35);
    // The whip is what makes it read as a radio from behind.
    const whip = new THREE.Mesh(cyl(0.008, 0.012, 0.7, 6), mk(b, shade(def)));
    whip.position.set(0.14, 1.68, 0.3);
    whip.rotation.z = -0.14;
    return [body, dial, whip];
  },

  quiver(mk, def) {
    const [a, b] = def.colors ?? [0x6b4a2a, 0xd9cfbb];
    const tube = new THREE.Mesh(cyl(0.09, 0.07, 0.5, 10), mk(a, shade(def)));
    tube.position.set(0.1, 1.25, 0.26);
    tube.rotation.z = -0.3;
    const out = [tube];
    for (let i = 0; i < 4; i++) {
      const shaft = new THREE.Mesh(cyl(0.008, 0.008, 0.28, 5), mk(b, shade(def)));
      shaft.position.set(0.14 + (i % 2) * 0.03, 1.58, 0.22 + Math.floor(i / 2) * 0.05);
      shaft.rotation.z = -0.3;
      out.push(shaft);
    }
    return out;
  },

  cans(mk, def) {
    const [a, b] = def.colors ?? [0x3a4630, 0x1e2219];
    const out = [];
    for (const sx of [-1, 1]) {
      const can = new THREE.Mesh(box(0.19, 0.22, 0.14), mk(a, shade(def)));
      can.position.set(sx * 0.12, 1.16, 0.26);
      const lid = new THREE.Mesh(box(0.2, 0.03, 0.15), mk(b, shade(def)));
      lid.position.set(sx * 0.12, 1.28, 0.26);
      out.push(can, lid);
    }
    return out;
  },

  shell(mk, def) {
    const [a, b] = def.colors ?? [0x2a3a2a, 0x14211a];
    const out = [];
    // Five plates, each a little smaller and further out — a carapace read as
    // ridges rather than modelled as one.
    for (let i = 0; i < 5; i++) {
      const w = 0.5 - i * 0.06;
      const plate = new THREE.Mesh(box(w, 0.1, 0.1 + i * 0.02), mk(i % 2 ? a : b, { ...shade(def), shininess: 40 }));
      plate.position.set(0, 1.4 - i * 0.1, 0.24 + i * 0.012);
      out.push(plate);
    }
    return out;
  },

  jet(mk, def) {
    const [a, b] = def.colors ?? [0x33373c, 0xff6a2b];
    const out = [];
    for (const sx of [-1, 1]) {
      const tank = new THREE.Mesh(cyl(0.09, 0.09, 0.42, 10), mk(a, shade(def)));
      tank.position.set(sx * 0.14, 1.24, 0.28);
      const nozzle = new THREE.Mesh(cyl(0.06, 0.09, 0.09, 8), mk(b, { ...shade(def), emissive: def.glow ?? 0 }));
      nozzle.position.set(sx * 0.14, 1.0, 0.28);
      out.push(tank, nozzle);
    }
    return out;
  },

  /**
   * Wings, as stepped feathers.
   *
   * Swept back rather than out: a wingspan wide enough to look like wings is
   * wide enough to hide behind, and a cosmetic that changes what a player can
   * see of another player is not a cosmetic.
   */
  wings(mk, def) {
    const [a, b] = def.colors ?? [0xe8f2ff, 0x8fa4b8];
    const out = [];
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const len = 0.3 - i * 0.045;
        const feather = new THREE.Mesh(box(len, 0.055, 0.03),
          mk(i % 2 ? a : b, { ...shade(def), emissive: def.glow ?? 0 }));
        feather.position.set(sx * (0.12 + len / 2), 1.48 - i * 0.1, 0.24 + i * 0.02);
        feather.rotation.z = sx * (-0.25 - i * 0.06);
        out.push(feather);
      }
    }
    return out;
  },
};

/* ── Charms ──────────────────────────────────────────────────────────────── */

/**
 * A charm hangs off the weapon, not off the player.
 *
 * Which is why these are built around the origin and positioned by whoever
 * attaches them: the viewmodel hangs one off the magazine well where the owner
 * can see it, and the third-person body hangs the same one off the slung
 * rifle, and neither has to know what the other did.
 */
const CHARMS = {
  none() { return []; },

  tag(mk, def) {
    const [a] = def.colors ?? [0x9aa3ad];
    const plate = new THREE.Mesh(box(0.024, 0.04, 0.004), mk(a, { shininess: 90 }));
    return [plate];
  },
  cube(mk, def) {
    const [a, b] = def.colors ?? [0xe8e6de, 0x1a1d22];
    const die = new THREE.Mesh(box(0.03, 0.03, 0.03), mk(a, { shininess: 40 }));
    const pip = new THREE.Mesh(box(0.008, 0.008, 0.033), mk(b));
    return [die, pip];
  },
  bell(mk, def) {
    const [a] = def.colors ?? [0xc9a227];
    const body = new THREE.Mesh(cyl(0.012, 0.022, 0.03, 8), mk(a, { shininess: 110 }));
    const clapper = new THREE.Mesh(sphere(0.007, 6), mk(a, { shininess: 110 }));
    clapper.position.y = -0.02;
    return [body, clapper];
  },
  bone(mk, def) {
    const [a] = def.colors ?? [0xd9cfbb];
    const shaft = new THREE.Mesh(box(0.012, 0.045, 0.012), mk(a));
    const out = [shaft];
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const knuckle = new THREE.Mesh(sphere(0.009, 6), mk(a));
        knuckle.position.set(sx * 0.008, sy * 0.023, 0);
        out.push(knuckle);
      }
    }
    return out;
  },
  coin(mk, def) {
    const [a] = def.colors ?? [0xd4a520];
    const c = new THREE.Mesh(cyl(0.019, 0.019, 0.005, 12), mk(a, { shininess: 130 }));
    c.rotation.x = Math.PI / 2;
    return [c];
  },
  ring(mk, def) {
    const [a] = def.colors ?? [0x8d959f];
    const out = [];
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const bead = new THREE.Mesh(box(0.006, 0.006, 0.006), mk(a, { shininess: 90 }));
      bead.position.set(Math.cos(ang) * 0.016, Math.sin(ang) * 0.016, 0);
      out.push(bead);
    }
    return out;
  },
  cat(mk, def) {
    const [a, b] = def.colors ?? [0x1a1d22, 0x66dd33];
    const body = new THREE.Mesh(box(0.024, 0.03, 0.018), mk(a));
    const out = [body];
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(box(0.008, 0.01, 0.006), mk(a));
      ear.position.set(sx * 0.008, 0.02, 0);
      const eye = new THREE.Mesh(box(0.005, 0.005, 0.004), mk(b, { emissive: b }));
      eye.position.set(sx * 0.006, 0.008, -0.01);
      out.push(ear, eye);
    }
    return out;
  },
  skull(mk, def) {
    const [a, b] = def.colors ?? [0xd9cfbb, 0x14161c];
    const cranium = new THREE.Mesh(box(0.026, 0.026, 0.024), mk(a));
    const jaw = new THREE.Mesh(box(0.02, 0.01, 0.02), mk(a));
    jaw.position.y = -0.017;
    const out = [cranium, jaw];
    for (const sx of [-1, 1]) {
      const socket = new THREE.Mesh(box(0.007, 0.007, 0.004), mk(b));
      socket.position.set(sx * 0.007, 0.004, -0.012);
      out.push(socket);
    }
    return out;
  },
  star(mk, def) {
    const [a] = def.colors ?? [0xffe9a8];
    const out = [];
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 - Math.PI / 2;
      const point = new THREE.Mesh(box(0.008, 0.026, 0.008), mk(a, { shininess: 120, emissive: def.glow ?? a }));
      point.position.set(Math.cos(ang) * 0.012, Math.sin(ang) * 0.012, 0);
      point.rotation.z = -ang - Math.PI / 2;
      out.push(point);
    }
    return out;
  },
  heart(mk, def) {
    const [a, b] = def.colors ?? [0xd6203c, 0x3d060f];
    const lower = new THREE.Mesh(box(0.02, 0.02, 0.014), mk(a, { shininess: 60, emissive: def.glow ?? b }));
    lower.rotation.z = Math.PI / 4;
    const out = [lower];
    for (const sx of [-1, 1]) {
      const lobe = new THREE.Mesh(sphere(0.011, 8), mk(a, { shininess: 60, emissive: def.glow ?? b }));
      lobe.position.set(sx * 0.009, 0.01, 0);
      out.push(lobe);
    }
    return out;
  },
  orb(mk, def) {
    const [a, b] = def.colors ?? [0xb07cff, 0x030308];
    const core = new THREE.Mesh(sphere(0.014, 10), mk(b, { shininess: 130, emissive: def.glow ?? 0 }));
    const halo = new THREE.Mesh(cyl(0.023, 0.023, 0.003, 12), mk(a, { shininess: 130, emissive: a }));
    halo.rotation.x = 1.1;
    return [core, halo];
  },
};

const BUILDERS = {
  [SLOT.HEAD]: HEADS,
  [SLOT.FACE]: FACES,
  [SLOT.BACK]: BACKS,
  [SLOT.CHARM]: CHARMS,
};

/* ── The public shape ────────────────────────────────────────────────────── */

/**
 * Builds one worn item.
 *
 * @param {string} id    an item id — `head:crown`, `charm:orb`, …
 * @param {(color:number, opts?:object) => THREE.Material} [mk]
 *        the body's own material factory, so a hat fades with the corpse it is
 *        on. Left out, one is made — which is what the loadout preview wants.
 * @returns {{ group: THREE.Group, meshes: THREE.Mesh[], anim: string|null }}
 */
export function buildWearable(id, mk = palette()) {
  const group = new THREE.Group();
  const item = getItem(id);
  const table = item ? BUILDERS[item.slot] : null;
  if (!item || !table) return { group, meshes: [], anim: null };
  const build = table[item.wear?.shape ?? 'none'] ?? table.none;
  const meshes = build(mk, item.wear ?? {}) ?? [];
  for (const m of meshes) {
    m.castShadow = true;
    group.add(m);
  }
  return { group, meshes, anim: item.anim ?? null };
}

/**
 * The colours one outfit puts on a body.
 *
 * Returned rather than applied, because the body already decides its own
 * fabric from the team colour and an outfit is an override of some of that,
 * not all of it: `Standard Issue` returns nothing at all and lets the team
 * colour through, which is why it is still the one most players wear.
 */
export function outfitColors(id, teamColor) {
  const item = getItem(id);
  const w = item?.wear;
  if (!w) return null;
  const team = new THREE.Color(teamColor);
  return {
    fabric: w.fabric ?? null,
    vest: w.vest ?? null,
    pants: w.pants ?? null,
    glow: w.glow ?? 0,
    gloss: w.gloss ?? 0,
    pattern: w.pattern ?? null,
    anim: item.anim ?? null,
    // Even a full outfit keeps a thread of the team colour on the armband and
    // the shoulder strap. Losing that would make friend and foe the same
    // silhouette, which is a cosmetic changing how the game plays.
    team: team.getHex(),
  };
}

/** The colours one glove item puts on a pair of hands. */
export function gloveColors(id) {
  const item = getItem(id);
  const w = item?.wear;
  if (!w) return null;
  return {
    color: w.color ?? 0x2b3038,
    cuff: w.cuff ?? w.color ?? 0x1e2228,
    glow: w.glow ?? 0,
    gloss: w.gloss ?? 0,
    pattern: w.pattern ?? null,
    anim: item.anim ?? null,
  };
}

/** Which animation kinds exist, re-exported so callers need one import. */
export { ANIM };

export default { buildWearable, outfitColors, gloveColors };
