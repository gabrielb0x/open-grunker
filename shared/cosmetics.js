/**
 * Open Grunker — the cosmetics catalogue.
 *
 * Everything a player can own, wear, carry, open, trade or sell is declared
 * here, once, and read identically by the browser, the game server and the
 * admin panel. Nothing downstream invents an item.
 *
 * ── Why this file replaced `SKINS` ─────────────────────────────────────────
 *
 * A skin used to be one string on an account — a finish, applied to whatever
 * primary the class happened to carry. That model could not answer the three
 * questions V2 asks of it: what is on your pistol, what is on your knife, and
 * what are you *wearing*. So a cosmetic is now an **item in a slot**:
 *
 *   primary · secondary · knife   the three guns, finished independently
 *   gloves                        what the hands the viewmodel draws are in
 *   head · face · body · back     the operator everyone else sees
 *   charm                         a trinket hung off the primary
 *
 * ── Items are generated, not typed out ─────────────────────────────────────
 *
 * A finish ("Gold Rush") is a look. A gun slot is a place to put it. Typing
 * out the cross product by hand would be nine hundred lines of copy-paste that
 * drift apart the first time a colour is tweaked, so a finish is declared once
 * and `expand()` mints one item per slot it is allowed on, pricing each by the
 * slot (a knife finish is worth more than the same paint on a sidearm because
 * far fewer people are looking at a sidearm).
 *
 * ── Rarity is a drop weight, not a label ───────────────────────────────────
 *
 * `RARITY[x].weight` is the only thing case rolls consult, and the tiers are
 * ordered so that the flat, cheap-looking finishes sit at the bottom and the
 * animated ones sit alone at the top: an animated item is *never* below
 * legendary, which is the whole promise of the tier. `ANIM` says what kind of
 * motion an animated finish has; the renderer maps each kind to a shader-side
 * behaviour and the server never looks at it at all.
 */

import { ZONE } from './weapons.js';

/* ── Slots ───────────────────────────────────────────────────────────────── */

export const SLOT = {
  PRIMARY: 'primary',
  SECONDARY: 'secondary',
  KNIFE: 'knife',
  GLOVES: 'gloves',
  HEAD: 'head',
  FACE: 'face',
  BODY: 'body',
  BACK: 'back',
  CHARM: 'charm',
};

/** Slots in the order the loadout screen lays them out. */
export const SLOT_IDS = Object.values(SLOT);

/**
 * What each slot is and how it behaves.
 *
 * `kind` splits the two halves of the wardrobe: a `weapon` slot takes a finish
 * and is previewed as a gun, a `wear` slot takes a piece of kit and is
 * previewed on the operator. `perClass` marks the one slot whose choice is
 * remembered per class — everybody wants a different paint on a sniper than on
 * an SMG, and nobody wants different gloves depending on which one they picked.
 */
export const SLOT_META = {
  [SLOT.PRIMARY]:   { id: SLOT.PRIMARY,   name: 'Primary',   kind: 'weapon', perClass: true,  icon: '▬', blurb: 'The gun your class is built around.' },
  [SLOT.SECONDARY]: { id: SLOT.SECONDARY, name: 'Sidearm',   kind: 'weapon', perClass: false, icon: '▸', blurb: 'What you draw when the primary runs dry.' },
  [SLOT.KNIFE]:     { id: SLOT.KNIFE,     name: 'Knife',     kind: 'weapon', perClass: false, icon: '\u2694', blurb: 'Never reloads, never misses at arm’s length.' },
  [SLOT.GLOVES]:    { id: SLOT.GLOVES,    name: 'Gloves',    kind: 'wear',   perClass: false, icon: '✋', blurb: 'The only cosmetic you look at all match.' },
  [SLOT.HEAD]:      { id: SLOT.HEAD,      name: 'Headwear',  kind: 'wear',   perClass: false, icon: '◠', blurb: 'Helmets, caps, and worse ideas.' },
  [SLOT.FACE]:      { id: SLOT.FACE,      name: 'Face',      kind: 'wear',   perClass: false, icon: '◑', blurb: 'Masks, optics, and what is under them.' },
  [SLOT.BODY]:      { id: SLOT.BODY,      name: 'Outfit',    kind: 'wear',   perClass: false, icon: '▣', blurb: 'The uniform under the plate carrier.' },
  [SLOT.BACK]:      { id: SLOT.BACK,      name: 'Backpack',  kind: 'wear',   perClass: false, icon: '◫', blurb: 'Whatever you are carrying it all in.' },
  [SLOT.CHARM]:     { id: SLOT.CHARM,     name: 'Charm',     kind: 'wear',   perClass: false, icon: '❀', blurb: 'Hangs off the primary and does nothing.' },
};

/** Slots that hold a weapon finish. */
export const WEAPON_SLOTS = SLOT_IDS.filter((s) => SLOT_META[s].kind === 'weapon');
/** Slots worn on the operator. */
export const WEAR_SLOTS = SLOT_IDS.filter((s) => SLOT_META[s].kind === 'wear');

/* ── Rarity ──────────────────────────────────────────────────────────────── */

/**
 * Six tiers. `weight` is the share of a case roll the tier takes when a case
 * offers it, and the collapse from 1000 to 4 across the ladder is what makes
 * the top of it worth wanting: a mythic is roughly one box in three hundred,
 * before the pool inside the tier is divided up.
 */
export const RARITY = {
  common:    { id: 'common',    name: 'Common',    color: 0x8fa0b4, weight: 1000, tier: 0 },
  uncommon:  { id: 'uncommon',  name: 'Uncommon',  color: 0x4ddb7a, weight: 420,  tier: 1 },
  rare:      { id: 'rare',      name: 'Rare',      color: 0x4d9bff, weight: 150,  tier: 2 },
  epic:      { id: 'epic',      name: 'Epic',      color: 0xb07cff, weight: 46,   tier: 3 },
  legendary: { id: 'legendary', name: 'Legendary', color: 0xf5a623, weight: 12,   tier: 4 },
  mythic:    { id: 'mythic',    name: 'Mythic',    color: 0xff4d6d, weight: 4,    tier: 5 },
};

export const RARITY_IDS = Object.keys(RARITY);
/** Rarity ids weakest first — the order every grid and drop strip sorts by. */
export const RARITY_ORDER = RARITY_IDS.slice().sort((a, b) => RARITY[a].tier - RARITY[b].tier);

/** The floor an animated item may not drop below. Motion is the top of the ladder. */
export const ANIMATED_MIN_TIER = RARITY.legendary.tier;

/**
 * How an animated finish moves.
 *
 * Each is a behaviour the renderer drives from one clock, never a video: the
 * texture offset scrolls, the emissive breathes, or the hue rotates. That is
 * why an animated skin costs nothing to stream and everything to obtain.
 */
export const ANIM = {
  SCROLL:  'scroll',   // the pattern flows along the weapon
  PULSE:   'pulse',    // the emissive rim breathes
  RAINBOW: 'rainbow',  // hue rotates through the whole wheel
  SHIMMER: 'shimmer',  // a highlight sweeps across the panel
  FLICKER: 'flicker',  // irregular, electrical
  DRIFT:   'drift',    // slow diagonal crawl, barely there
};

export const ANIM_IDS = Object.values(ANIM);

/* ── Prices ──────────────────────────────────────────────────────────────── */

/**
 * What a finish is worth before the slot is taken into account. These are the
 * numbers the shop, the market's suggested price and every case's payout are
 * all derived from, so the economy has exactly one set of dials.
 */
export const RARITY_PRICE = {
  common: 120, uncommon: 340, rare: 900, epic: 2400, legendary: 7000, mythic: 20000,
};

/** An animated item is worth this much more than the same tier standing still. */
export const ANIMATED_PRICE_MULT = 2.5;

/** Per-slot price weighting — see the header. */
export const SLOT_PRICE_MULT = {
  [SLOT.PRIMARY]: 1, [SLOT.SECONDARY]: 0.55, [SLOT.KNIFE]: 1.6,
  [SLOT.GLOVES]: 1.15, [SLOT.HEAD]: 0.8, [SLOT.FACE]: 0.7,
  [SLOT.BODY]: 0.9, [SLOT.BACK]: 0.6, [SLOT.CHARM]: 0.45,
};

/** The catalogue price of an item, rounded to something a price tag can show. */
export function priceOf(item) {
  if (!item) return 0;
  if (item.price != null) return item.price;
  const base = RARITY_PRICE[item.rarity] ?? RARITY_PRICE.common;
  const raw = base * (SLOT_PRICE_MULT[item.slot] ?? 1) * (item.anim ? ANIMATED_PRICE_MULT : 1);
  return Math.max(10, Math.round(raw / 10) * 10);
}

/* ── Weapon finishes ─────────────────────────────────────────────────────── */

const Z = ZONE;

/**
 * Every finish in the game.
 *
 * A finish paints zones, never whole weapons: `paint` says what colour each
 * zone goes, `pattern` lays a seamless tile over the zones it names, and
 * `gloss`/`glow` decide how it is lit. The `detail` zone — lenses, reticles,
 * brass, bores — is in neither, which is what keeps a gold rifle's optic made
 * of glass.
 *
 * `on` is the list of gun slots the finish may be minted for. Most go on all
 * three; a few are knife-only, because the shape is what carries them.
 *
 * `anim` promotes a finish into the animated tier — see ANIM. Nothing below
 * legendary carries one, and every legendary and mythic that does is priced
 * accordingly.
 */
export const FINISHES = {
  /* ── Common — issue paint, and it looks it ────────────────────────────── */
  factory: {
    name: 'Factory', rarity: 'common', on: WEAPON_SLOTS, price: 0,
    glove: 0x2b3038, swatch: [0x3b424c, 0x5c3a1f, 0x8d959f],
    blurb: 'However it left the armoury.',
  },
  urban: {
    name: 'Urban Grey', rarity: 'common', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x6f767e, [Z.WOOD]: 0x4b5158, [Z.METAL]: 0x2a2e34, [Z.ACCENT]: 0x3a3f46 },
    pattern: { kind: 'digital', on: [Z.BODY, Z.WOOD], colors: [0x878e96, 0x5b626b, 0x3b4048], scale: 0.05 },
    glove: 0x4a5058, swatch: [0x878e96, 0x5b626b, 0x3b4048],
    blurb: 'Pixel camouflage for somewhere with kerbs.',
  },
  primer: {
    name: 'Primer', rarity: 'common', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x8d5a3c, [Z.WOOD]: 0x6f4630, [Z.METAL]: 0x33373c, [Z.ACCENT]: 0x5d3b28 },
    pattern: { kind: 'scratch', on: [Z.BODY, Z.WOOD], colors: [0x9c6544, 0x63402c], scale: 0.09 },
    glove: 0x6f4630, swatch: [0x9c6544, 0x6f4630, 0x33373c],
    blurb: 'One coat. Somebody meant to come back to it.',
  },
  slate: {
    name: 'Slate', rarity: 'common', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x474d55, [Z.WOOD]: 0x383d44, [Z.METAL]: 0x232a30, [Z.ACCENT]: 0x555c66 },
    glove: 0x3c424a, swatch: [0x555c66, 0x474d55, 0x232a30],
    blurb: 'Grey. On purpose, apparently.',
  },
  oxide: {
    name: 'Oxide', rarity: 'common', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x6b4a3a, [Z.WOOD]: 0x4e372c, [Z.METAL]: 0x3a2a22, [Z.ACCENT]: 0x7d5a45 },
    pattern: { kind: 'blotch', on: [Z.BODY, Z.METAL], colors: [0x7a5340, 0x4a342a, 0x93664a], scale: 0.14 },
    glove: 0x5a4033, swatch: [0x93664a, 0x6b4a3a, 0x3a2a22],
    blurb: 'Stored badly, fires anyway.',
  },
  bone: {
    name: 'Bone', rarity: 'common', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xd9cfbb, [Z.WOOD]: 0xb7ab95, [Z.METAL]: 0x5f5a51, [Z.ACCENT]: 0xc7bda8 },
    glove: 0xc4bba7, swatch: [0xd9cfbb, 0xb7ab95, 0x5f5a51],
    blurb: 'Off-white, and it does not stay that way.',
  },

  /* ── Uncommon — somebody chose this ───────────────────────────────────── */
  midnight: {
    name: 'Midnight', rarity: 'uncommon', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x222c50, [Z.WOOD]: 0x1c2440, [Z.METAL]: 0x11151f, [Z.ACCENT]: 0x2c3760 },
    pattern: { kind: 'fade', on: [Z.BODY, Z.WOOD], colors: [0x33427a, 0x111726], scale: 0.5 },
    gloss: 0.5, glove: 0x1b2340, swatch: [0x33427a, 0x1e2745, 0x0d1018],
    blurb: 'Blued to the point of blue.',
  },
  arctic: {
    name: 'Arctic', rarity: 'uncommon', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xdfeaf3, [Z.WOOD]: 0xb9c8d6, [Z.METAL]: 0x8b98a6, [Z.ACCENT]: 0xcbd8e4 },
    pattern: { kind: 'splinter', on: [Z.BODY, Z.WOOD], colors: [0xf2f7fb, 0xc4d3e0, 0x94a4b4], scale: 0.13 },
    glove: 0xd3e2ee, swatch: [0xf2f7fb, 0xc4d3e0, 0x8b98a6],
    blurb: 'Splinter pattern, cut for snow.',
  },
  desert: {
    name: 'Desert Tan', rarity: 'uncommon', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xc2a06a, [Z.WOOD]: 0xa5854f, [Z.METAL]: 0x2f3138, [Z.ACCENT]: 0x8f7443 },
    pattern: { kind: 'scratch', on: [Z.BODY, Z.WOOD], colors: [0xd6b57e, 0x9a7d49], scale: 0.11 },
    glove: 0xb99a67, swatch: [0xd6b57e, 0xa5854f, 0x2f3138],
    blurb: 'Cerakote, sand-blasted, and it shows.',
  },
  forest: {
    name: 'Woodland', rarity: 'uncommon', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x4a5a38, [Z.WOOD]: 0x3a4630, [Z.METAL]: 0x22261d, [Z.ACCENT]: 0x37432b },
    pattern: { kind: 'blotch', on: [Z.BODY, Z.WOOD], colors: [0x6a7a46, 0x40502f, 0x2b3520, 0x6d5a34], scale: 0.16 },
    glove: 0x3d4a2c, swatch: [0x6a7a46, 0x40502f, 0x2b3520],
    blurb: 'Four tones, hand-sprayed, no two guns alike.',
  },
  tiger: {
    name: 'Tiger Stripe', rarity: 'uncommon', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x4d5b3a, [Z.WOOD]: 0x3b4630, [Z.METAL]: 0x1e2219, [Z.ACCENT]: 0x2f3a26 },
    pattern: { kind: 'tiger', on: [Z.BODY, Z.WOOD], colors: [0x67794b, 0x2c3522, 0x11150e], scale: 0.17 },
    glove: 0x3b4630, swatch: [0x67794b, 0x2c3522, 0x11150e],
    blurb: 'Brushed on by hand, somewhere humid.',
  },
  copper: {
    name: 'Copperhead', rarity: 'uncommon', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xa5613a, [Z.WOOD]: 0x3a2a22, [Z.METAL]: 0x7c4527, [Z.ACCENT]: 0xd08a52 },
    pattern: { kind: 'oil', on: [Z.BODY, Z.METAL], colors: [0xd08a52, 0x7c4527, 0x3f7a6a], scale: 0.2 },
    gloss: 0.9, glove: 0xa5613a, swatch: [0xd08a52, 0xa5613a, 0x3f7a6a],
    blurb: 'Patina where the hands go, bright where they do not.',
  },
  ivory: {
    name: 'Ivory & Blue', rarity: 'uncommon', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xeee6d2, [Z.WOOD]: 0x1f3a5c, [Z.METAL]: 0x2a3b4c, [Z.ACCENT]: 0x2f5f9c },
    pattern: { kind: 'chevron', on: [Z.BODY], colors: [0xf5efdd, 0x2f5f9c, 0x1f3a5c], scale: 0.24 },
    gloss: 0.7, glove: 0x2f5f9c, swatch: [0xf5efdd, 0x2f5f9c, 0x1f3a5c],
    blurb: 'Duelling pistol energy, on a service weapon.',
  },
  moss: {
    name: 'Moss Agate', rarity: 'uncommon', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x35473c, [Z.WOOD]: 0x27352d, [Z.METAL]: 0x18211c, [Z.ACCENT]: 0x4f6b58 },
    pattern: { kind: 'marble', on: [Z.BODY, Z.WOOD], colors: [0x4f6b58, 0x1c2621, 0x9fbfa8], scale: 0.22 },
    gloss: 0.8, glove: 0x35473c, swatch: [0x9fbfa8, 0x4f6b58, 0x1c2621],
    blurb: 'Cut from the wrong kind of stone.',
  },

  /* ── Rare — an actual design ──────────────────────────────────────────── */
  toxic: {
    name: 'Toxic', rarity: 'rare', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x1e2618, [Z.WOOD]: 0x232b1b, [Z.METAL]: 0x161a13, [Z.ACCENT]: 0x66dd33 },
    pattern: { kind: 'splatter', on: [Z.BODY, Z.WOOD], colors: [0x1a2016, 0x66dd33, 0xa8ff4d], scale: 0.2 },
    gloss: 0.8, glow: 0x1f3a0a, glove: 0x66dd33, swatch: [0xa8ff4d, 0x66dd33, 0x1a2016],
    blurb: 'Whatever was in the drum, it ate the finish.',
  },
  crimson: {
    name: 'Crimson', rarity: 'rare', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xa41f2c, [Z.WOOD]: 0x241b1f, [Z.METAL]: 0x1a1e23, [Z.ACCENT]: 0x7c1621 },
    pattern: { kind: 'stripe', on: [Z.BODY], colors: [0xc02434, 0x8c1926, 0x1a1418], scale: 0.22 },
    gloss: 1, glove: 0xb01f2e, swatch: [0xc02434, 0x8c1926, 0x14171b],
    blurb: 'Racing stripes on something that is not a car.',
  },
  cobalt: {
    name: 'Cobalt', rarity: 'rare', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x2b6ed6, [Z.WOOD]: 0x1b2b45, [Z.METAL]: 0x161c26, [Z.ACCENT]: 0xe8eef6 },
    pattern: { kind: 'stripe', on: [Z.BODY], colors: [0x3179e4, 0x2158ad, 0xe8eef6], scale: 0.22 },
    gloss: 1, glove: 0x2b6ed6, swatch: [0x3179e4, 0x2158ad, 0xe8eef6],
    blurb: 'Team colours, whichever team you are on.',
  },
  serpent: {
    name: 'Serpentine', rarity: 'rare', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x1d3a2c, [Z.WOOD]: 0x16281f, [Z.METAL]: 0x0f1a15, [Z.ACCENT]: 0xc8a63a },
    pattern: { kind: 'serpent', on: [Z.BODY, Z.WOOD], colors: [0x2a5b43, 0x0f1a15, 0xc8a63a], scale: 0.15 },
    gloss: 1.2, glove: 0x1d3a2c, swatch: [0xc8a63a, 0x2a5b43, 0x0f1a15],
    blurb: 'Scaled, lacquered, and cold to hold.',
  },
  ember: {
    name: 'Ember', rarity: 'rare', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x241713, [Z.WOOD]: 0x1a110e, [Z.METAL]: 0x120c0a, [Z.ACCENT]: 0xff6a2b },
    pattern: { kind: 'crackle', on: [Z.BODY, Z.WOOD], colors: [0x1a110e, 0xff6a2b, 0xffc04d], scale: 0.16 },
    gloss: 0.9, glow: 0x3a1204, glove: 0xff6a2b, swatch: [0xffc04d, 0xff6a2b, 0x1a110e],
    blurb: 'Cooled just enough to pick up.',
  },
  topo: {
    name: 'Cartographer', rarity: 'rare', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x243a3f, [Z.WOOD]: 0x1b2c30, [Z.METAL]: 0x141f22, [Z.ACCENT]: 0x63d9c4 },
    pattern: { kind: 'topo', on: [Z.BODY, Z.WOOD, Z.ACCENT], colors: [0x1b2c30, 0x63d9c4, 0x2f5a5f], scale: 0.19 },
    gloss: 0.7, glove: 0x24443f, swatch: [0x63d9c4, 0x2f5a5f, 0x1b2c30],
    blurb: 'Contour lines of nowhere in particular.',
  },
  hazard: {
    name: 'Hazard', rarity: 'rare', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xf0b823, [Z.WOOD]: 0x1a1a1c, [Z.METAL]: 0x121214, [Z.ACCENT]: 0xf0b823 },
    pattern: { kind: 'stripe', on: [Z.BODY, Z.ACCENT], colors: [0xf0b823, 0x141416, 0xffd964], scale: 0.16 },
    gloss: 1.1, glove: 0xf0b823, swatch: [0xffd964, 0xf0b823, 0x141416],
    blurb: 'Marked the way anything dangerous is.',
  },
  wave: {
    name: 'Great Wave', rarity: 'rare', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xe8e2d0, [Z.WOOD]: 0x1b3f6b, [Z.METAL]: 0x14283f, [Z.ACCENT]: 0x2f6fae },
    pattern: { kind: 'wave', on: [Z.BODY, Z.WOOD], colors: [0xe8e2d0, 0x1b3f6b, 0x2f6fae], scale: 0.26 },
    gloss: 1, glove: 0x1b3f6b, swatch: [0xe8e2d0, 0x2f6fae, 0x1b3f6b],
    blurb: 'Woodblock print, wrapped around a receiver.',
  },
  honeycomb: {
    name: 'Apiary', rarity: 'rare', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x171a1d, [Z.WOOD]: 0x1f2226, [Z.METAL]: 0x101214, [Z.ACCENT]: 0xe0a92a },
    pattern: { kind: 'hex', on: [Z.BODY, Z.ACCENT], colors: [0xe0a92a, 0x171a1d, 0x8a6512], scale: 0.06 },
    gloss: 1.3, glove: 0xe0a92a, swatch: [0xe0a92a, 0x8a6512, 0x171a1d],
    blurb: 'Cells all the way down.',
  },

  /* ── Epic — the ones people ask about ─────────────────────────────────── */
  carbon: {
    name: 'Carbon Fibre', rarity: 'epic', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x1e2229, [Z.WOOD]: 0x232830, [Z.METAL]: 0x14171b, [Z.ACCENT]: 0x323841 },
    pattern: { kind: 'hex', on: [Z.BODY, Z.WOOD, Z.ACCENT], colors: [0x22262c, 0x0e1013, 0x3a4149], scale: 0.045 },
    gloss: 1.7, glove: 0x14171c, swatch: [0x2c3138, 0x1a1d22, 0x0e1013],
    blurb: 'Woven, lacquered, and lighter than it looks.',
  },
  vapor: {
    name: 'Vaporwave', rarity: 'epic', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xff5fd2, [Z.WOOD]: 0x2a1b4e, [Z.METAL]: 0x1b1233, [Z.ACCENT]: 0x35f6e8 },
    pattern: { kind: 'grid', on: [Z.BODY, Z.WOOD], colors: [0xff5fd2, 0x6a2bd8, 0x35f6e8], scale: 0.4 },
    gloss: 1.5, glow: 0x3a0f4a, glove: 0xff5fd2, swatch: [0xff5fd2, 0x6a2bd8, 0x35f6e8],
    blurb: 'A sunset, a grid, and no apology.',
  },
  nebula: {
    name: 'Nebula', rarity: 'epic', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x171233, [Z.WOOD]: 0x120e28, [Z.METAL]: 0x0b0819, [Z.ACCENT]: 0x7b5cff },
    pattern: { kind: 'nebula', on: [Z.BODY, Z.WOOD, Z.ACCENT], colors: [0x2a1a6b, 0xff5fb0, 0x35d6f6], scale: 0.35 },
    gloss: 1.4, glow: 0x1a0f45, glove: 0x2a1a6b, swatch: [0xff5fb0, 0x7b5cff, 0x35d6f6],
    blurb: 'Somewhere out there, and now on your rifle.',
  },
  porcelain: {
    name: 'Porcelain', rarity: 'epic', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xf4f1e8, [Z.WOOD]: 0xe6e1d4, [Z.METAL]: 0x9aa3ad, [Z.ACCENT]: 0x2f5f9c },
    pattern: { kind: 'crackle', on: [Z.BODY, Z.WOOD], colors: [0xf4f1e8, 0x2f5f9c, 0xb9c6d6], scale: 0.12 },
    gloss: 2, glove: 0xe6e1d4, swatch: [0xf4f1e8, 0x2f5f9c, 0xb9c6d6],
    blurb: 'Glazed, fired, and one drop from ruined.',
  },
  obsidian: {
    name: 'Obsidian', rarity: 'epic', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x0c0d10, [Z.WOOD]: 0x111318, [Z.METAL]: 0x08090b, [Z.ACCENT]: 0x5a2fd6 },
    pattern: { kind: 'marble', on: [Z.BODY, Z.WOOD], colors: [0x14161c, 0x05060a, 0x5a2fd6], scale: 0.28 },
    gloss: 2.1, glow: 0x140a30, glove: 0x0c0d10, swatch: [0x5a2fd6, 0x14161c, 0x05060a],
    blurb: 'Volcanic glass, knapped to an edge nobody needed.',
  },
  bloodline: {
    name: 'Bloodline', rarity: 'epic', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x1a0d10, [Z.WOOD]: 0x140a0d, [Z.METAL]: 0x0e0709, [Z.ACCENT]: 0xd6203c },
    pattern: { kind: 'circuit', on: [Z.BODY, Z.WOOD, Z.METAL], colors: [0x140a0d, 0xd6203c, 0xff7a8c], scale: 0.15 },
    gloss: 1.6, glow: 0x3d060f, glove: 0xd6203c, swatch: [0xff7a8c, 0xd6203c, 0x140a0d],
    blurb: 'The veins light up when it is warm.',
  },
  quartz: {
    name: 'Quartz', rarity: 'epic', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xc8d6e6, [Z.WOOD]: 0x94a8c0, [Z.METAL]: 0x5f7086, [Z.ACCENT]: 0xe8f2ff },
    pattern: { kind: 'crystal', on: [Z.BODY, Z.WOOD, Z.ACCENT], colors: [0xe8f2ff, 0x7d94ad, 0x3f5064], scale: 0.2 },
    gloss: 2.2, glow: 0x0e1a28, glove: 0xc8d6e6, swatch: [0xe8f2ff, 0xc8d6e6, 0x3f5064],
    blurb: 'Faceted until there was nothing left to face.',
  },
  bullion: {
    name: 'Bullion', rarity: 'epic', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0x3a3226, [Z.WOOD]: 0x2a251c, [Z.METAL]: 0xb9922f, [Z.ACCENT]: 0xe4c25e },
    pattern: { kind: 'damascus', on: [Z.BODY, Z.METAL], colors: [0xe4c25e, 0x8a6a17, 0x2a251c], scale: 0.11 },
    gloss: 1.9, glove: 0xb9922f, swatch: [0xe4c25e, 0xb9922f, 0x2a251c],
    blurb: 'Not plated. Weighed.',
  },

  /* ── Legendary — including the first that move ────────────────────────── */
  gold: {
    name: 'Gold Rush', rarity: 'legendary', on: WEAPON_SLOTS,
    paint: { [Z.BODY]: 0xd4a520, [Z.WOOD]: 0x2e2419, [Z.METAL]: 0xb98a17, [Z.ACCENT]: 0xe0c05a },
    pattern: { kind: 'scroll', on: [Z.BODY, Z.METAL, Z.ACCENT], colors: [0xf2cf5e, 0xb98a17, 0x6d4f0a], scale: 0.09 },
    gloss: 2, glove: 0xd4a520, swatch: [0xf2cf5e, 0xd4a520, 0x6d4f0a],
    blurb: 'Engraved, plated, and utterly impractical.',
  },
  hellfire: {
    name: 'Hellfire', rarity: 'legendary', on: WEAPON_SLOTS, anim: ANIM.SCROLL,
    paint: { [Z.BODY]: 0x160a06, [Z.WOOD]: 0x1d0d07, [Z.METAL]: 0x0e0604, [Z.ACCENT]: 0xff8a2b },
    pattern: { kind: 'flame', on: [Z.BODY, Z.WOOD, Z.ACCENT], colors: [0x160a06, 0xff4d1a, 0xffd166], scale: 0.3, speed: 0.55 },
    gloss: 1.8, glow: 0x5a1a04, glove: 0xff4d1a, swatch: [0xffd166, 0xff4d1a, 0x160a06],
    blurb: 'The flames climb the receiver and never get anywhere.',
  },
  tidal: {
    name: 'Tidal', rarity: 'legendary', on: WEAPON_SLOTS, anim: ANIM.DRIFT,
    paint: { [Z.BODY]: 0x07222e, [Z.WOOD]: 0x061a24, [Z.METAL]: 0x041219, [Z.ACCENT]: 0x2ad6d0 },
    pattern: { kind: 'wave', on: [Z.BODY, Z.WOOD, Z.ACCENT], colors: [0x0a3242, 0x2ad6d0, 0x9df2ee], scale: 0.3, speed: 0.18 },
    gloss: 2, glow: 0x05303a, glove: 0x2ad6d0, swatch: [0x9df2ee, 0x2ad6d0, 0x07222e],
    blurb: 'It comes in, it goes out, it never stops.',
  },
  overclock: {
    name: 'Overclock', rarity: 'legendary', on: WEAPON_SLOTS, anim: ANIM.PULSE,
    paint: { [Z.BODY]: 0x0d1117, [Z.WOOD]: 0x121821, [Z.METAL]: 0x080b0f, [Z.ACCENT]: 0x35f6e8 },
    pattern: { kind: 'circuit', on: [Z.BODY, Z.WOOD, Z.METAL, Z.ACCENT], colors: [0x0d1117, 0x35f6e8, 0x9dfff8], scale: 0.13, speed: 0.9 },
    gloss: 1.9, glow: 0x063c3a, glove: 0x35f6e8, swatch: [0x9dfff8, 0x35f6e8, 0x0d1117],
    blurb: 'Running hotter than the spec sheet allows.',
  },
  aurora: {
    name: 'Aurora', rarity: 'legendary', on: WEAPON_SLOTS, anim: ANIM.SHIMMER,
    paint: { [Z.BODY]: 0x0a1024, [Z.WOOD]: 0x080d1c, [Z.METAL]: 0x050813, [Z.ACCENT]: 0x6cf5b0 },
    pattern: { kind: 'nebula', on: [Z.BODY, Z.WOOD, Z.ACCENT], colors: [0x0a1024, 0x6cf5b0, 0x8a6cff], scale: 0.4, speed: 0.3 },
    gloss: 2, glow: 0x0a2a3a, glove: 0x6cf5b0, swatch: [0x6cf5b0, 0x8a6cff, 0x0a1024],
    blurb: 'Northern lights, kept in a box, sold by the gram.',
  },
  reliquary: {
    name: 'Reliquary', rarity: 'legendary', on: [SLOT.KNIFE, SLOT.SECONDARY],
    paint: { [Z.BODY]: 0xd9c9a3, [Z.WOOD]: 0x4a3a24, [Z.METAL]: 0xc9a227, [Z.ACCENT]: 0x8a1f2c },
    pattern: { kind: 'scroll', on: [Z.BODY, Z.METAL], colors: [0xefe0b8, 0xc9a227, 0x5a4410], scale: 0.08 },
    gloss: 1.8, glove: 0xc9a227, swatch: [0xefe0b8, 0xc9a227, 0x8a1f2c],
    blurb: 'Older than the war it is being carried into.',
  },

  /* ── Mythic — animated, and priced like it ────────────────────────────── */
  prismatic: {
    name: 'Prismatic', rarity: 'mythic', on: WEAPON_SLOTS, anim: ANIM.RAINBOW,
    paint: { [Z.BODY]: 0xffffff, [Z.WOOD]: 0xdfe6ef, [Z.METAL]: 0x8f9aa8, [Z.ACCENT]: 0xffffff },
    pattern: { kind: 'oil', on: [Z.BODY, Z.WOOD, Z.METAL, Z.ACCENT], colors: [0xff4d6d, 0x35f6e8, 0xf5d94d], scale: 0.3, speed: 0.35 },
    gloss: 2.4, glow: 0x202028, glove: 0xdfe6ef, swatch: [0xff4d6d, 0x35f6e8, 0xf5d94d],
    blurb: 'Every colour, in turn, forever.',
  },
  singularity: {
    name: 'Singularity', rarity: 'mythic', on: WEAPON_SLOTS, anim: ANIM.PULSE,
    paint: { [Z.BODY]: 0x030308, [Z.WOOD]: 0x05050c, [Z.METAL]: 0x010104, [Z.ACCENT]: 0xb07cff },
    pattern: { kind: 'starfield', on: [Z.BODY, Z.WOOD, Z.ACCENT], colors: [0x030308, 0xb07cff, 0xffffff], scale: 0.45, speed: 0.22 },
    gloss: 2.5, glow: 0x1a0a3a, glove: 0x0a0a14, swatch: [0xb07cff, 0x2a1a5a, 0x030308],
    blurb: 'Light goes in. The paperwork on what happens next is incomplete.',
  },
  voidwalker: {
    name: 'Voidwalker', rarity: 'mythic', on: WEAPON_SLOTS, anim: ANIM.FLICKER,
    paint: { [Z.BODY]: 0x0a0410, [Z.WOOD]: 0x0d0616, [Z.METAL]: 0x05020a, [Z.ACCENT]: 0xff2bd6 },
    pattern: { kind: 'plasma', on: [Z.BODY, Z.WOOD, Z.METAL, Z.ACCENT], colors: [0x0a0410, 0xff2bd6, 0x2be0ff], scale: 0.34, speed: 1.4 },
    gloss: 2.3, glow: 0x3a0a3a, glove: 0xff2bd6, swatch: [0xff2bd6, 0x2be0ff, 0x0a0410],
    blurb: 'It is not entirely here and it is not entirely yours.',
  },
  dragonhide: {
    name: 'Dragonhide', rarity: 'mythic', on: [SLOT.PRIMARY, SLOT.KNIFE], anim: ANIM.SHIMMER,
    paint: { [Z.BODY]: 0x1a3a22, [Z.WOOD]: 0x122a19, [Z.METAL]: 0x0b1a10, [Z.ACCENT]: 0xf5c542 },
    pattern: { kind: 'serpent', on: [Z.BODY, Z.WOOD, Z.METAL], colors: [0x2a6b3d, 0x0b1a10, 0xf5c542], scale: 0.12, speed: 0.25 },
    gloss: 2.4, glow: 0x0f3a1a, glove: 0x2a6b3d, swatch: [0xf5c542, 0x2a6b3d, 0x0b1a10],
    blurb: 'Scales that catch the light in a direction light does not go.',
  },
  doppler: {
    name: 'Doppler', rarity: 'mythic', on: [SLOT.KNIFE], anim: ANIM.DRIFT,
    paint: { [Z.BODY]: 0x1b1040, [Z.WOOD]: 0x140c30, [Z.METAL]: 0x2a1a6b, [Z.ACCENT]: 0xff5fb0 },
    pattern: { kind: 'marble', on: [Z.BODY, Z.METAL, Z.ACCENT], colors: [0x2a1a6b, 0xff5fb0, 0x35d6f6], scale: 0.3, speed: 0.12 },
    gloss: 2.5, glow: 0x1a0a45, glove: 0x2a1a6b, swatch: [0xff5fb0, 0x35d6f6, 0x2a1a6b],
    blurb: 'The phase it cooled at decides what you got.',
  },
};

export const FINISH_IDS = Object.keys(FINISHES);

/* ── Worn cosmetics ──────────────────────────────────────────────────────── */

/**
 * Everything below is worn rather than carried, and everything below is a
 * *recipe* rather than a model: `shape` names a builder the renderer already
 * knows how to draw and `colors` feeds it. That is deliberate. A cosmetic that
 * shipped its own mesh would mean an asset pipeline, a download, a cache and a
 * loading screen; a cosmetic that names a shape and three colours is four
 * hundred bytes and draws on the frame it is equipped.
 *
 * The shapes are shared, so `beret` and `beanie` are the same builder with
 * different proportions, and a new item is usually a new row here rather than
 * new code.
 */

/** Hands. `cuff` is the band at the wrist, which is most of what reads in first person. */
export const GLOVES = {
  issue:      { name: 'Issue Tactical',  rarity: 'common',    color: 0x2b3038, cuff: 0x1e2228, price: 0, blurb: 'Signed for, never returned.' },
  worklight:  { name: 'Workman’s',       rarity: 'common',    color: 0x6b5a44, cuff: 0x3f3427, blurb: 'Split leather, one size, wrong size.' },
  mechanic:   { name: 'Mechanic',        rarity: 'common',    color: 0x2f3a48, cuff: 0xc2571f, blurb: 'Grease is part of the finish now.' },
  medic:      { name: 'Field Medic',     rarity: 'uncommon',  color: 0xe8e6de, cuff: 0xc0202c, blurb: 'Clean until they are not.' },
  moto:       { name: 'Moto',            rarity: 'uncommon',  color: 0x1a1c20, cuff: 0xd6203c, gloss: 1.2, blurb: 'Knuckle armour on a battlefield with no bikes.' },
  arcticglove:{ name: 'Snowline',        rarity: 'uncommon',  color: 0xdfe9f2, cuff: 0x8fa4b8, blurb: 'Insulated past the point of trigger discipline.' },
  bloodhound: { name: 'Bloodhound',      rarity: 'rare',      color: 0x7a2028, cuff: 0x2a1214, gloss: 0.9, blurb: 'Named for the colour, not the dog.' },
  huntsman:   { name: 'Huntsman',        rarity: 'rare',      color: 0x4a5a38, cuff: 0x6d5a34, pattern: 'blotch', blurb: 'Camouflage that stops at the wrist.' },
  crimsonweb: { name: 'Crimson Web',     rarity: 'rare',      color: 0x1a1214, cuff: 0xa41f2c, pattern: 'web', gloss: 1.1, blurb: 'Spun by something with a colour scheme.' },
  goldknuckle:{ name: 'Gilt',            rarity: 'epic',      color: 0x2a2419, cuff: 0xd4a520, gloss: 1.8, blurb: 'Gold at the knuckles, because of course.' },
  carbonglove:{ name: 'Carbon Weave',    rarity: 'epic',      color: 0x14171b, cuff: 0x323841, pattern: 'hex', gloss: 1.7, blurb: 'Woven, and it costs what woven costs.' },
  neonglove:  { name: 'Nightshift',      rarity: 'epic',      color: 0x120c2a, cuff: 0x35f6e8, glow: 0x0a3a38, blurb: 'The seams are lit. Nobody asked why.' },
  phantom:    { name: 'Phantom',         rarity: 'legendary', color: 0x0a0d14, cuff: 0x7b5cff, glow: 0x1a0f45, gloss: 2, anim: ANIM.PULSE, blurb: 'The stitching breathes.' },
  molten:     { name: 'Molten',          rarity: 'legendary', color: 0x1a0d08, cuff: 0xff5a1a, glow: 0x5a1a04, gloss: 1.9, anim: ANIM.FLICKER, pattern: 'crackle', blurb: 'Cracks that glow when you make a fist.' },
  chromatic:  { name: 'Chromatic',       rarity: 'mythic',    color: 0xdfe6ef, cuff: 0xffffff, gloss: 2.4, anim: ANIM.RAINBOW, pattern: 'oil', blurb: 'Whatever colour you are looking for, wait.' },
  eldritch:   { name: 'Eldritch',        rarity: 'mythic',    color: 0x0a0410, cuff: 0xff2bd6, glow: 0x3a0a3a, gloss: 2.3, anim: ANIM.FLICKER, pattern: 'plasma', blurb: 'Six fingers’ worth of glove on a five-fingered hand.' },
};

/** Headwear. `shape` picks the builder; `h`/`r` nudge its proportions. */
export const HEADWEAR = {
  bare:       { name: 'Bare Head',       rarity: 'common',    shape: 'none',    price: 0, blurb: 'Brave.' },
  helmet:     { name: 'Issue Helmet',    rarity: 'common',    shape: 'helmet',  colors: [0x23272d, 0x343a42], price: 0, blurb: 'The one everybody starts in.' },
  cap:        { name: 'Ball Cap',        rarity: 'common',    shape: 'cap',     colors: [0x2f3a48, 0x1e2530], blurb: 'Backwards is not an option.' },
  beanie:     { name: 'Watch Cap',       rarity: 'common',    shape: 'beanie',  colors: [0x2a2e34, 0x3a3f46], blurb: 'Wool, itchy, warm.' },
  boonie:     { name: 'Boonie',          rarity: 'common',    shape: 'bucket',  colors: [0x4a5a38, 0x3a4630], blurb: 'Brim all the way round, for a sun this map does not have.' },
  beret:      { name: 'Beret',           rarity: 'uncommon',  shape: 'beret',   colors: [0x6b1720, 0x2a0d11], blurb: 'Earned somewhere, bought here.' },
  visorhelm:  { name: 'Riot Helm',       rarity: 'uncommon',  shape: 'helmet',  colors: [0x1a1d22, 0x4d9bff], visor: true, blurb: 'Polycarbonate between you and the argument.' },
  hardhat:    { name: 'Hard Hat',        rarity: 'uncommon',  shape: 'helmet',  colors: [0xf0b823, 0xd69a12], h: 1.1, blurb: 'Site safety, no site.' },
  tanker:     { name: 'Tanker’s',        rarity: 'uncommon',  shape: 'beanie',  colors: [0x3f3428, 0x2a2219], pads: true, blurb: 'Padded for a vehicle you do not have.' },
  cowboy:     { name: 'Drover',          rarity: 'rare',      shape: 'cowboy',  colors: [0x6b4a2a, 0x4a3220], blurb: 'Wrong century, right silhouette.' },
  mohawk:     { name: 'Mohawk',          rarity: 'rare',      shape: 'mohawk',  colors: [0x35f6e8, 0x1a1c20], blurb: 'Grown, dyed, and unhelmeted.' },
  hood:       { name: 'Hood',            rarity: 'rare',      shape: 'hood',    colors: [0x22262c, 0x14171b], blurb: 'Up, always.' },
  gasmask_h:  { name: 'Filter Hood',     rarity: 'rare',      shape: 'hood',    colors: [0x2f3a2a, 0x1a2018], blurb: 'Sealed at the neck, which is the part that matters.' },
  tophat:     { name: 'Top Hat',         rarity: 'epic',      shape: 'tophat',  colors: [0x0e1013, 0x8a1f2c], blurb: 'Nobody has ever explained this one.' },
  crown:      { name: 'Crown',           rarity: 'epic',      shape: 'crown',   colors: [0xd4a520, 0x8a1f2c], gloss: 1.9, blurb: 'Uneasy, heavy, all of that.' },
  horns:      { name: 'Horns',           rarity: 'epic',      shape: 'horns',   colors: [0x2a1a14, 0xd9cfbb], blurb: 'Bone, allegedly.' },
  neonhelm:   { name: 'Circuit Helm',    rarity: 'epic',      shape: 'helmet',  colors: [0x0d1117, 0x35f6e8], glow: 0x063c3a, blurb: 'The lines on it do something. Not for you.' },
  halo:       { name: 'Halo',            rarity: 'legendary', shape: 'halo',    colors: [0xffe9a8, 0xffc04d], glow: 0x5a4410, anim: ANIM.PULSE, blurb: 'Floats. Judges.' },
  wreath:     { name: 'Laurel',          rarity: 'legendary', shape: 'crown',   colors: [0x2a6b3d, 0xd4a520], gloss: 1.6, anim: ANIM.SHIMMER, blurb: 'For winning something, at some point, presumably.' },
  flamecrown: { name: 'Pyre',            rarity: 'legendary', shape: 'flame',   colors: [0xff4d1a, 0xffd166], glow: 0x5a1a04, anim: ANIM.FLICKER, blurb: 'It is on fire and it is fine.' },
  voidcrown:  { name: 'Event Horizon',   rarity: 'mythic',    shape: 'halo',    colors: [0xb07cff, 0x030308], glow: 0x1a0a3a, anim: ANIM.RAINBOW, blurb: 'The ring is the only part still emitting.' },
  antlers:    { name: 'Wildwood',        rarity: 'mythic',    shape: 'horns',   colors: [0x6cf5b0, 0x2a1a14], glow: 0x0a3a2a, anim: ANIM.SHIMMER, h: 1.4, blurb: 'Still growing, slowly, in the dark.' },
};

/** Faces — masks, optics and what is under them. */
export const FACEWEAR = {
  clear:      { name: 'Clear',           rarity: 'common',    shape: 'none',      price: 0, blurb: 'Your actual face. Such as it is.' },
  balaclava:  { name: 'Balaclava',       rarity: 'common',    shape: 'balaclava', colors: [0x1a1d22], price: 0, blurb: 'The default, and there is a reason.' },
  shades:     { name: 'Shades',          rarity: 'common',    shape: 'shades',    colors: [0x0e1013, 0x2a2e34], blurb: 'Indoors. At night.' },
  bandana:    { name: 'Bandana',         rarity: 'common',    shape: 'bandana',   colors: [0x8a1f2c, 0xe8e6de], blurb: 'Filters nothing, hides everything.' },
  goggles:    { name: 'Goggles',         rarity: 'uncommon',  shape: 'goggles',   colors: [0x2a2e34, 0x66c8ff], blurb: 'Fogged within a minute of putting them on.' },
  respirator: { name: 'Respirator',      rarity: 'uncommon',  shape: 'respirator',colors: [0x2f3a2a, 0x1a2018], blurb: 'Two cartridges, one voice, muffled.' },
  scarf:      { name: 'Shemagh',         rarity: 'uncommon',  shape: 'bandana',   colors: [0xc2a06a, 0x3a3228], blurb: 'Wrapped, tucked, and still coming loose.' },
  warpaint:   { name: 'War Paint',       rarity: 'rare',      shape: 'paint',     colors: [0x1a1d22, 0xd6203c], blurb: 'Two stripes and a bad decision.' },
  nvg:        { name: 'Night Vision',    rarity: 'rare',      shape: 'nvg',       colors: [0x2a2e34, 0x66ff99], glow: 0x0a3a1a, blurb: 'Flipped down, and now it is green.' },
  hockey:     { name: 'Hockey Mask',     rarity: 'rare',      shape: 'plate',     colors: [0xe6e1d4, 0x8a8172], blurb: 'A sport was involved. Once.' },
  skull:      { name: 'Skull',           rarity: 'epic',      shape: 'skull',     colors: [0xd9cfbb, 0x14161c], blurb: 'Printed, not excavated.' },
  oni:        { name: 'Oni',             rarity: 'epic',      shape: 'plate',     colors: [0xa41f2c, 0xd4a520], gloss: 1.6, blurb: 'Lacquered, horned, unfriendly.' },
  visorface:  { name: 'Optic Visor',     rarity: 'epic',      shape: 'visor',     colors: [0x0d1117, 0x35f6e8], glow: 0x063c3a, blurb: 'One pane, no eyes.' },
  spectre:    { name: 'Spectre',         rarity: 'legendary', shape: 'skull',     colors: [0x8a6cff, 0x0a0d14], glow: 0x1a0f45, anim: ANIM.PULSE, blurb: 'Whatever is behind it is not keeping still.' },
  wraith:     { name: 'Wraith',          rarity: 'mythic',    shape: 'visor',     colors: [0xff2bd6, 0x0a0410], glow: 0x3a0a3a, anim: ANIM.FLICKER, blurb: 'It flickers when you are shot at. That is not a bug.' },
};

/** Outfits — the fabric and plate carrier under everything else. */
export const OUTFITS = {
  issue:      { name: 'Standard Issue',  rarity: 'common',    fabric: null, vest: 0x23272d, pants: null, price: 0, blurb: 'Team-coloured, like everyone else’s.' },
  fatigues:   { name: 'Fatigues',        rarity: 'common',    fabric: 0x4a5340, vest: 0x2a3025, pants: 0x3d4536, blurb: 'Pressed once, in another life.' },
  workwear:   { name: 'Workwear',        rarity: 'common',    fabric: 0x2f4258, vest: 0x1e2b3a, pants: 0x2a3a4c, blurb: 'Denim, canvas, and no armour rating.' },
  urbanfit:   { name: 'Urban Kit',       rarity: 'common',    fabric: 0x54595f, vest: 0x33373c, pants: 0x3e4348, pattern: 'digital', blurb: 'Pixels, everywhere, forever.' },
  desertfit:  { name: 'Desert Kit',      rarity: 'uncommon',  fabric: 0xb59a6a, vest: 0x8a7448, pants: 0xa08a5e, pattern: 'scratch', blurb: 'Sand in the seams as standard.' },
  arcticfit:  { name: 'Arctic Kit',      rarity: 'uncommon',  fabric: 0xdfe9f2, vest: 0xa8b8c8, pants: 0xc8d6e2, pattern: 'splinter', blurb: 'Invisible on one map, a target on eight.' },
  ghillie:    { name: 'Ghillie',         rarity: 'uncommon',  fabric: 0x3d4a2c, vest: 0x2a3520, pants: 0x35402a, pattern: 'blotch', shag: true, blurb: 'Strips of hessian and a lot of patience.' },
  hazmat:     { name: 'Hazmat',          rarity: 'rare',      fabric: 0xf0b823, vest: 0x2a2a1a, pants: 0xe0aa18, gloss: 1.2, blurb: 'Sealed against something nobody named.' },
  diver:      { name: 'Diver',           rarity: 'rare',      fabric: 0x14283f, vest: 0x0d1a2a, pants: 0x1b3f6b, gloss: 1.4, blurb: 'Neoprene, on land, sweating.' },
  redteam:    { name: 'Red Cell',        rarity: 'rare',      fabric: 0x6b1720, vest: 0x2a0d11, pants: 0x4a1018, blurb: 'The team you were told to expect.' },
  carbonfit:  { name: 'Carbon Suit',     rarity: 'epic',      fabric: 0x1e2229, vest: 0x14171b, pants: 0x232830, pattern: 'hex', gloss: 1.7, blurb: 'The whole suit is the weave.' },
  royal:      { name: 'Regalia',         rarity: 'epic',      fabric: 0x3a1a5a, vest: 0xd4a520, pants: 0x2a1240, gloss: 1.8, blurb: 'Velvet, gilt, and no ballistic protection.' },
  neonfit:    { name: 'Gridrunner',      rarity: 'epic',      fabric: 0x120c2a, vest: 0x0a0818, pants: 0x1a1240, glow: 0x0a3a38, pattern: 'grid', blurb: 'The piping is the point.' },
  spectral:   { name: 'Spectral',        rarity: 'legendary', fabric: 0x0a0d14, vest: 0x14103a, pants: 0x0a0d14, glow: 0x1a0f45, anim: ANIM.PULSE, blurb: 'Fabric that has not decided how solid it is.' },
  inferno:    { name: 'Inferno',         rarity: 'legendary', fabric: 0x1a0d08, vest: 0x2a1208, pants: 0x160a06, glow: 0x5a1a04, pattern: 'flame', anim: ANIM.SCROLL, blurb: 'The kit is burning and the wearer is unbothered.' },
  cosmic:     { name: 'Cosmic',          rarity: 'mythic',    fabric: 0x0a1024, vest: 0x030308, pants: 0x0a1024, glow: 0x1a0a3a, pattern: 'starfield', anim: ANIM.DRIFT, blurb: 'There is a sky in it, and it is moving.' },
};

/** Backpacks and other things strapped to a back. */
export const BACKPACKS = {
  none:       { name: 'Nothing',         rarity: 'common',    shape: 'none',   price: 0, blurb: 'Travelling light.' },
  daypack:    { name: 'Day Pack',        rarity: 'common',    shape: 'pack',   colors: [0x23272d, 0x343a42], price: 0, blurb: 'Standard, square, adequate.' },
  bedroll:    { name: 'Bedroll',         rarity: 'common',    shape: 'roll',   colors: [0x6b5a44, 0x3f3427], blurb: 'Rolled tight. Never unrolled.' },
  rucksack:   { name: 'Rucksack',        rarity: 'uncommon',  shape: 'pack',   colors: [0x4a5a38, 0x2f3a26], h: 1.25, blurb: 'Bigger than it needs to be.' },
  radio:      { name: 'Field Radio',     rarity: 'uncommon',  shape: 'radio',  colors: [0x2f3a2a, 0x1a2018], blurb: 'Antenna up, nobody on the other end.' },
  quiver:     { name: 'Quiver',          rarity: 'uncommon',  shape: 'quiver', colors: [0x6b4a2a, 0xd9cfbb], blurb: 'For a bow this game does not contain.' },
  ammocan:    { name: 'Ammo Cans',       rarity: 'rare',      shape: 'cans',   colors: [0x3a4630, 0x1e2219], blurb: 'Two, strapped, rattling.' },
  turtle:     { name: 'Carapace',        rarity: 'rare',      shape: 'shell',  colors: [0x2a3a2a, 0x14211a], gloss: 1.3, blurb: 'Plated, ridged, and slower than it looks.' },
  jetpack:    { name: 'Jump Pack',       rarity: 'epic',      shape: 'jet',    colors: [0x33373c, 0xff6a2b], glow: 0x3a1204, blurb: 'Non-functional. Legally, decorative.' },
  reactor:    { name: 'Cell Pack',       rarity: 'epic',      shape: 'radio',  colors: [0x0d1117, 0x35f6e8], glow: 0x063c3a, blurb: 'Humming, warm, sealed.' },
  wings:      { name: 'Wings',           rarity: 'legendary', shape: 'wings',  colors: [0xe8f2ff, 0x8fa4b8], anim: ANIM.SHIMMER, blurb: 'Do not help. Never have.' },
  voidwings:  { name: 'Riftwings',       rarity: 'mythic',    shape: 'wings',  colors: [0xff2bd6, 0x0a0410], glow: 0x3a0a3a, anim: ANIM.FLICKER, blurb: 'Two holes in the world, roughly wing-shaped.' },
};

/** Charms — a trinket hung off the primary, visible in first person. */
export const CHARMS = {
  nothing:    { name: 'No Charm',        rarity: 'common',    shape: 'none',  price: 0, blurb: 'Unencumbered.' },
  dogtag:     { name: 'Dog Tag',         rarity: 'common',    shape: 'tag',   colors: [0x9aa3ad], price: 0, blurb: 'Somebody’s. Not necessarily yours.' },
  dice:       { name: 'Loaded Die',      rarity: 'common',    shape: 'cube',  colors: [0xe8e6de, 0x1a1d22], blurb: 'Six, every time.' },
  bell:       { name: 'Brass Bell',      rarity: 'uncommon',  shape: 'bell',  colors: [0xc9a227], blurb: 'Announces you. Repeatedly.' },
  bone:       { name: 'Knucklebone',     rarity: 'uncommon',  shape: 'bone',  colors: [0xd9cfbb], blurb: 'From something. Best not.' },
  lucky:      { name: 'Lucky Coin',      rarity: 'uncommon',  shape: 'coin',  colors: [0xd4a520], gloss: 1.6, blurb: 'Worn smooth on one side only.' },
  cat:        { name: 'Cat',             rarity: 'rare',      shape: 'cat',   colors: [0x1a1d22, 0x66dd33], blurb: 'Swings when you sprint. Judges when you do not.' },
  grenadepin: { name: 'The Pin',         rarity: 'rare',      shape: 'ring',  colors: [0x8d959f], blurb: 'Kept, framed, on a string.' },
  skullcharm: { name: 'Tiny Skull',      rarity: 'rare',      shape: 'skull', colors: [0xd9cfbb, 0x14161c], blurb: 'Miniature, grinning, unhelpful.' },
  star:       { name: 'Fallen Star',     rarity: 'epic',      shape: 'star',  colors: [0xffe9a8], glow: 0x5a4410, blurb: 'Still slightly warm.' },
  heart:      { name: 'Cold Heart',      rarity: 'legendary', shape: 'heart', colors: [0xd6203c, 0x3d060f], glow: 0x3d060f, anim: ANIM.PULSE, blurb: 'Beats at a rate nothing alive would.' },
  singular:   { name: 'Pocket Void',     rarity: 'legendary', shape: 'orb',   colors: [0xb07cff, 0x030308], glow: 0x1a0a3a, anim: ANIM.PULSE, blurb: 'Do not put anything else in that pocket.' },
};

/**
 * Finishes that are earned rather than sold or dropped.
 *
 * `unlock` is checked against the account, never the wallet, and these are
 * deliberately kept out of every case: a case is the only thing in the game
 * that can hand you something you did not work for, and these four are the
 * only things in the game that cannot be handed to you at all. They are also
 * untradable for the same reason — an earned mark that can be bought from
 * somebody else is not a mark of anything.
 */
export const EARNED_FINISHES = {
  enlisted: {
    name: 'Enlisted', rarity: 'uncommon', on: WEAPON_SLOTS, price: -1,
    unlock: { type: 'account' }, hint: 'Create a free account',
    paint: { [Z.BODY]: 0x2f7d64, [Z.WOOD]: 0x24503f, [Z.METAL]: 0x1b2a24, [Z.ACCENT]: 0x3f9c7e },
    pattern: { kind: 'stencil', on: [Z.BODY], colors: [0x2f7d64, 0x1f5847, 0xd8e6df], scale: 0.13 },
    glove: 0x2f7d64, swatch: [0x3f9c7e, 0x2f7d64, 0x1b2a24],
    blurb: 'Issued, stencilled, and signed for.',
  },
  veteran: {
    name: 'Veteran', rarity: 'rare', on: WEAPON_SLOTS, price: -1,
    unlock: { type: 'level', value: 15 }, hint: 'Reach level 15',
    paint: { [Z.BODY]: 0x3f4a55, [Z.WOOD]: 0x2a3038, [Z.METAL]: 0x1c2027, [Z.ACCENT]: 0x59667a },
    pattern: { kind: 'scratch', on: [Z.BODY, Z.WOOD, Z.METAL], colors: [0x505c69, 0x2b323a], scale: 0.08 },
    gloss: 0.6, glove: 0x3f4a55, swatch: [0x59667a, 0x3f4a55, 0x1c2027],
    blurb: 'Every scratch on it was earned somewhere.',
  },
  master: {
    name: 'Masterwork', rarity: 'epic', on: WEAPON_SLOTS, price: -1,
    unlock: { type: 'mastery', value: 4 }, hint: 'Reach mastery IV with this weapon',
    paint: { [Z.BODY]: 0x7a5cff, [Z.WOOD]: 0x241c3d, [Z.METAL]: 0x4a37a8, [Z.ACCENT]: 0xa791ff },
    pattern: { kind: 'damascus', on: [Z.BODY, Z.METAL], colors: [0x9d86ff, 0x4a37a8, 0x1d1633], scale: 0.1 },
    gloss: 1.4, glow: 0x241452, glove: 0x7a5cff, swatch: [0x9d86ff, 0x7a5cff, 0x1d1633],
    blurb: 'Folded steel, case-hardened violet.',
  },
  legend: {
    name: 'Legend', rarity: 'legendary', on: WEAPON_SLOTS, price: -1,
    unlock: { type: 'mastery', value: 6 }, hint: 'Reach mastery VI with this weapon',
    paint: { [Z.BODY]: 0x211a16, [Z.WOOD]: 0x2a201b, [Z.METAL]: 0x171110, [Z.ACCENT]: 0xff7043 },
    pattern: { kind: 'circuit', on: [Z.BODY, Z.WOOD, Z.METAL], colors: [0x1a1512, 0xff7043, 0xffd08a], scale: 0.14 },
    gloss: 1.9, glow: 0x3a1204, glove: 0xff7043, swatch: [0xffd08a, 0xff7043, 0x1a1512],
    blurb: 'Still cooling.',
  },
};

/* ── Building the catalogue ──────────────────────────────────────────────── */

/**
 * The item id for one cosmetic. Slot-prefixed on purpose: `gold` alone is
 * ambiguous the moment the same finish exists on three guns, and every id that
 * reaches the database, the market or a trade has to name exactly one thing.
 */
export const itemId = (slot, key) => `${slot}:${key}`;

/** Split an item id back into its two halves; null if it is not one. */
export function parseItemId(id) {
  if (typeof id !== 'string') return null;
  const at = id.indexOf(':');
  if (at < 1) return null;
  const slot = id.slice(0, at);
  const key = id.slice(at + 1);
  return SLOT_META[slot] && key ? { slot, key } : null;
}

const ITEMS = {};

/** Adds one finished item to the catalogue. */
function mint(slot, key, def, extra) {
  const id = itemId(slot, key);
  const item = {
    id, slot, key,
    name: def.name,
    rarity: def.rarity ?? 'common',
    anim: def.anim ?? null,
    blurb: def.blurb ?? '',
    swatch: def.swatch ?? null,
    // A default item is the one everybody already has, so it is never priced,
    // never dropped and never worth trading.
    ...extra,
  };
  item.price = def.price != null ? def.price : priceOf(item);
  item.default = item.price === 0;
  item.earned = item.price < 0;
  item.unlock = def.unlock ?? null;
  item.hint = def.hint ?? null;
  // Earned marks and the defaults everybody owns stay out of the economy.
  item.tradable = !item.earned && !item.default;
  item.dropable = item.tradable;
  if (!item.swatch) item.swatch = swatchFor(item);
  ITEMS[id] = item;
  return item;
}

/** Three colours that stand for an item in a grid, when it did not name its own. */
function swatchFor(item) {
  const w = item.wear;
  if (item.finish) {
    const p = item.finish.paint ?? {};
    return [p[Z.BODY] ?? 0x3b424c, p[Z.WOOD] ?? p[Z.METAL] ?? 0x2a2e34, p[Z.ACCENT] ?? 0x8d959f];
  }
  if (w?.colors?.length) return [w.colors[0], w.colors[1] ?? w.colors[0], w.colors[2] ?? w.colors[0]];
  if (w?.color != null) return [w.color, w.cuff ?? w.color, w.glow ?? w.color];
  if (w?.fabric != null || w?.vest != null) return [w.fabric ?? 0x2f333a, w.vest ?? 0x23272d, w.pants ?? 0x363b40];
  return [0x3b424c, 0x2a2e34, 0x8d959f];
}

// Weapon finishes: one item per (finish, allowed slot).
for (const table of [FINISHES, EARNED_FINISHES]) {
  for (const [key, def] of Object.entries(table)) {
    for (const slot of def.on ?? WEAPON_SLOTS) {
      const finish = {
        id: key, paint: def.paint ?? null, pattern: def.pattern ?? null,
        gloss: def.gloss ?? 0, glow: def.glow ?? 0, glove: def.glove ?? 0x2b3038,
        anim: def.anim ?? null,
      };
      // A sidearm shows a third of the panel a rifle does, so the same paint
      // reads as a cheaper item there — and a knife shows almost none of it,
      // which is exactly why knife finishes are what people chase.
      mint(slot, key, def, { finish, family: key });
    }
  }
}

const WEAR_TABLES = [
  [SLOT.GLOVES, GLOVES], [SLOT.HEAD, HEADWEAR], [SLOT.FACE, FACEWEAR],
  [SLOT.BODY, OUTFITS], [SLOT.BACK, BACKPACKS], [SLOT.CHARM, CHARMS],
];
for (const [slot, table] of WEAR_TABLES) {
  for (const [key, def] of Object.entries(table)) {
    mint(slot, key, def, { wear: def, family: key });
  }
}

export { ITEMS };
export const ITEM_IDS = Object.keys(ITEMS);

/** One item by id, or null. Never throws, never invents. */
export const getItem = (id) => ITEMS[id] ?? null;

/** Every item that lives in one slot, cheapest tier first. */
export function itemsInSlot(slot) {
  return ITEM_IDS.map((id) => ITEMS[id]).filter((i) => i.slot === slot)
    .sort((a, b) => (RARITY[a.rarity].tier - RARITY[b.rarity].tier) || (a.price - b.price)
      || a.name.localeCompare(b.name));
}

/** What a fresh account has on, before it owns anything. */
export const DEFAULT_EQUIP = {
  [SLOT.PRIMARY]: itemId(SLOT.PRIMARY, 'factory'),
  [SLOT.SECONDARY]: itemId(SLOT.SECONDARY, 'factory'),
  [SLOT.KNIFE]: itemId(SLOT.KNIFE, 'factory'),
  [SLOT.GLOVES]: itemId(SLOT.GLOVES, 'issue'),
  [SLOT.HEAD]: itemId(SLOT.HEAD, 'helmet'),
  [SLOT.FACE]: itemId(SLOT.FACE, 'balaclava'),
  [SLOT.BODY]: itemId(SLOT.BODY, 'issue'),
  [SLOT.BACK]: itemId(SLOT.BACK, 'daypack'),
  [SLOT.CHARM]: itemId(SLOT.CHARM, 'nothing'),
};

/** Items every account owns without ever having been given them. */
export const FREE_ITEMS = ITEM_IDS.filter((id) => ITEMS[id].default);

/* ── Cases ───────────────────────────────────────────────────────────────── */

/**
 * A case is a priced roll over a slice of the catalogue.
 *
 * `pool` is a filter rather than a list, so adding an item to the catalogue
 * puts it in every case that already described it and nothing has to be kept
 * in step by hand. `odds` overrides the rarity weights for that case only —
 * which is how the Prismatic case can be the one place a mythic is a realistic
 * outcome without making mythics common anywhere else.
 *
 * Nothing earned, default or untradable is ever in a pool: `dropable` is the
 * single gate, and it is checked when the pool is resolved rather than when
 * the roll is made.
 */
export const CASES = {
  field: {
    id: 'field', name: 'Field Crate', price: 300,
    accent: 0x8fa0b4,
    blurb: 'Whatever was left in the back of the truck.',
    pool: { rarities: ['common', 'uncommon', 'rare'] },
  },
  armoury: {
    id: 'armoury', name: 'Armoury Case', price: 1200,
    accent: 0x4d9bff,
    blurb: 'Finishes for all three weapons, every tier on the sheet.',
    pool: { slots: WEAPON_SLOTS },
  },
  wardrobe: {
    id: 'wardrobe', name: 'Wardrobe Case', price: 1000,
    accent: 0x4ddb7a,
    blurb: 'Everything you wear, and nothing you shoot.',
    pool: { slots: WEAR_SLOTS },
  },
  hands: {
    id: 'hands', name: 'Glovebox', price: 1800,
    accent: 0xb07cff,
    blurb: 'Gloves only. The one cosmetic you look at all match.',
    pool: { slots: [SLOT.GLOVES] },
  },
  blade: {
    id: 'blade', name: 'Blade Case', price: 2600,
    accent: 0xf5a623,
    blurb: 'Knife finishes, and nothing under rare.',
    pool: { slots: [SLOT.KNIFE], rarities: ['rare', 'epic', 'legendary', 'mythic'] },
  },
  prismatic: {
    id: 'prismatic', name: 'Prismatic Case', price: 6000,
    accent: 0xff4d6d,
    blurb: 'The only case where the animated finishes are a realistic outcome.',
    pool: { rarities: ['epic', 'legendary', 'mythic'] },
    // Flattened deliberately: a mythic is about one in twenty-five here rather
    // than one in three hundred, which is what the price is buying.
    odds: { epic: 200, legendary: 42, mythic: 9 },
  },
  regalia: {
    id: 'regalia', name: 'Regalia Case', price: 3200,
    accent: 0xd4a520,
    blurb: 'Crowns, capes, and things that float above your head.',
    pool: { slots: [SLOT.HEAD, SLOT.BODY, SLOT.BACK, SLOT.CHARM], rarities: ['rare', 'epic', 'legendary', 'mythic'] },
  },
};

export const CASE_IDS = Object.keys(CASES);

/** Every item one case can produce, cheapest tier first. */
export function casePool(caseId) {
  const c = CASES[caseId];
  if (!c) return [];
  const { slots, rarities } = c.pool ?? {};
  return ITEM_IDS.map((id) => ITEMS[id]).filter((i) => i.dropable
    && (!slots || slots.includes(i.slot))
    && (!rarities || rarities.includes(i.rarity)))
    .sort((a, b) => (RARITY[a.rarity].tier - RARITY[b.rarity].tier) || a.name.localeCompare(b.name));
}

/**
 * The real odds of a case, tier by tier.
 *
 * Published rather than inferred: the odds panel in the shop reads exactly the
 * numbers `rollCase` uses, so what a player is shown and what actually happens
 * cannot drift apart.
 *
 * @returns {Array<{rarity:string, weight:number, count:number, chance:number}>}
 */
export function caseOdds(caseId) {
  const c = CASES[caseId];
  if (!c) return [];
  const pool = casePool(caseId);
  const byRarity = new Map();
  for (const item of pool) byRarity.set(item.rarity, (byRarity.get(item.rarity) ?? 0) + 1);
  const rows = [...byRarity.entries()].map(([rarity, count]) => ({
    rarity, count, weight: (c.odds?.[rarity] ?? RARITY[rarity].weight),
  }));
  const total = rows.reduce((s, r) => s + r.weight, 0) || 1;
  return rows
    .map((r) => ({ ...r, chance: r.weight / total }))
    .sort((a, b) => RARITY[a.rarity].tier - RARITY[b.rarity].tier);
}

/**
 * Rolls one item out of a case.
 *
 * Two draws, not one: the tier is chosen against the published weights and
 * then the item is chosen uniformly inside it. Rolling flat over the pool
 * instead would make a tier's odds depend on how many items happen to be in
 * it, so adding one more legendary would quietly make legendaries commoner —
 * which is precisely the drift the odds panel exists to rule out.
 *
 * `random` is injected so the server can hand it a CSPRNG and the tests can
 * hand it a fixed sequence. It is never called on the client.
 *
 * @param {string} caseId
 * @param {() => number} random  a uniform [0,1)
 * @returns {object|null} the item won
 */
export function rollCase(caseId, random = Math.random) {
  const pool = casePool(caseId);
  if (!pool.length) return null;
  const odds = caseOdds(caseId);
  let roll = random();
  let picked = odds[odds.length - 1];
  for (const row of odds) {
    if (roll < row.chance) { picked = row; break; }
    roll -= row.chance;
  }
  const tier = pool.filter((i) => i.rarity === picked.rarity);
  return tier[Math.min(tier.length - 1, Math.floor(random() * tier.length))] ?? null;
}

/* ── The economy ─────────────────────────────────────────────────────────── */

/** What the game itself pays for an item handed back to it. */
export const SCRAP_RATE = 0.2;
/** The cut the market takes on a sale, which is the only GR sink trading has. */
export const MARKET_FEE = 0.1;
/** Nothing may be listed below this, so a listing is always worth a click. */
export const MARKET_MIN_PRICE = 10;
/** Nor above it — a listing is a price, not a message board. */
export const MARKET_MAX_PRICE = 5_000_000;
/** How many listings one account may have standing at once. */
export const MARKET_MAX_LISTINGS = 20;
/** How many items may be on one side of a trade. */
export const TRADE_MAX_ITEMS = 12;
/** How many trades one account may have open at once. */
export const TRADE_MAX_OPEN = 10;
/** An offer nobody answers expires rather than sitting there forever. */
export const TRADE_TTL_SEC = 7 * 24 * 3600;

/** What the game pays to take a duplicate back. */
export const scrapValue = (item) => Math.max(1, Math.round(priceOf(item) * SCRAP_RATE));

/* ── Equipping ───────────────────────────────────────────────────────────── */

/**
 * Whether an account may put `itemId` in its slot.
 *
 * One function, called by the client to grey a card out and by the server to
 * reject a save, so a card that looks equippable always is. `ctx` carries only
 * what an unlock can ask about: whether there is an account at all, its level,
 * and its mastery tier with the weapon the slot would apply to.
 *
 * @param {string} id                 the item id being equipped
 * @param {string[]} owned            item ids the account holds
 * @param {{authed?:boolean, level?:number, masteryTier?:number}} ctx
 */
export function canEquip(id, owned, ctx = {}) {
  const item = getItem(id);
  if (!item) return false;
  if (item.default) return true;
  if (item.earned) {
    const u = item.unlock;
    if (!u) return false;
    if (u.type === 'account') return !!ctx.authed;
    if (u.type === 'level') return (ctx.level ?? 0) >= u.value;
    if (u.type === 'mastery') return (ctx.masteryTier ?? 0) >= u.value;
    return false;
  }
  return Array.isArray(owned) && owned.includes(id);
}

/**
 * Cleans an equip map down to what the account may actually wear.
 *
 * Anything unknown, unowned or in the wrong slot falls back to the default for
 * that slot rather than being dropped, so a loadout is always complete and the
 * renderer never has to ask what to draw when nothing is equipped.
 */
export function sanitiseEquip(equip, owned, ctx = {}) {
  const out = { ...DEFAULT_EQUIP };
  if (equip && typeof equip === 'object') {
    for (const [slot, id] of Object.entries(equip)) {
      if (!SLOT_META[slot]) continue;
      const item = getItem(id);
      if (!item || item.slot !== slot) continue;
      if (!canEquip(id, owned, ctx)) continue;
      out[slot] = id;
    }
  }
  return out;
}

/**
 * The primary finish a class is wearing, out of the per-class map.
 *
 * The primary is the one slot remembered per class — see SLOT_META — so it is
 * the one slot with a lookup of its own.
 */
export function primaryFor(perClass, classId) {
  const id = perClass?.[classId];
  const item = getItem(id);
  return item && item.slot === SLOT.PRIMARY ? id : DEFAULT_EQUIP[SLOT.PRIMARY];
}

export default {
  SLOT, SLOT_IDS, SLOT_META, WEAPON_SLOTS, WEAR_SLOTS,
  RARITY, RARITY_IDS, RARITY_ORDER, ANIM,
  FINISHES, EARNED_FINISHES, ITEMS, ITEM_IDS, getItem, itemsInSlot, itemId, parseItemId,
  DEFAULT_EQUIP, FREE_ITEMS, CASES, CASE_IDS, casePool, caseOdds, rollCase,
  priceOf, scrapValue, canEquip, sanitiseEquip, primaryFor,
};
