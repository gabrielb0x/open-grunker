/**
 * Open Grunker — shared constants.
 *
 * This module is loaded byte-identically by the Node server and by the browser
 * client (nginx aliases /shared/ to this directory).  Everything that has to
 * agree between the two — physics tuning, timings, enums, wire opcodes — lives
 * here so prediction on the client and simulation on the server cannot drift.
 */

/**
 * Bumped whenever a page already open would misread the server.
 *
 * 6 added the badges clans travel on — a tag and whether it is verified — to
 * every profile, scoreboard row, chat line and death notice. An older page
 * would simply not draw them, which is exactly the silent half-working state
 * this number exists to turn into "reload the page".
 *
 * 7 added spectator mode and the report standing: an older page has no `sm` to
 * send and no `rt` to read, so it would draw a REPORT button whose refusal it
 * cannot explain and offer no way to watch anybody. It also carries the
 * carving change in shared/movement.js — and that one is not cosmetic at all,
 * because a page predicting with the old step() would correct on every hop.
 *
 * 8 makes jumping and sliding edge-triggered (shared/movement.js again, and
 * again not cosmetic: an old page holding the jump key predicts a hop the
 * server does not simulate, and gets yanked back to the ground on every one of
 * them). It also carries the nuke, which an older page would neither be able to
 * launch nor see coming — a seven-second countdown that draws nothing is worse
 * than no countdown at all.
 */
export const PROTOCOL_VERSION = 8;
export const API_VERSION = 'v1';

/* ── Simulation ───────────────────────────────────────────────────────────── */

export const TICK_RATE = 60;                  // physics steps per second
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 30;              // state broadcasts per second
export const SNAPSHOT_DT = 1 / SNAPSHOT_RATE;
export const INTERP_DELAY = 0.10;             // remote-entity render lag (s)
export const MAX_LAG_COMP = 0.30;             // max rewind for hit validation (s)
export const MAX_INPUTS_PER_PACKET = 12;      // client input batching cap

/* ── Player body ──────────────────────────────────────────────────────────── */

export const PLAYER_RADIUS = 0.42;            // AABB half-extent on X/Z
export const PLAYER_HEIGHT = 1.85;
export const PLAYER_CROUCH_HEIGHT = 1.05;
export const EYE_OFFSET = 0.16;               // below the top of the AABB
export const STEP_HEIGHT = 0.62;              // auto-climbable ledge height
export const COLLISION_SKIN = 1e-4;           // gap left when resolving a hit
export const HEAD_HEIGHT = 0.30;              // top slice counted as a headshot

export const MAX_HEALTH = 100;
export const REGEN_DELAY = 4.5;               // s without damage before regen
export const REGEN_RATE = 22;                 // hp per second
export const RESPAWN_TIME = 2.6;              // s
export const SPAWN_PROTECTION = 1.2;          // s of invulnerability after spawn

/* ── Movement (Quake/Source-flavoured, tuned for Krunker-like speed) ──────── */

export const GRAVITY = 27.5;
export const JUMP_VELOCITY = 9.4;
export const BASE_SPEED = 9.2;                // u/s ground target speed
export const SPRINT_NONE = 0;                 // no sprint key: speed comes from movement tech
export const CROUCH_SPEED_MULT = 0.45;
export const GROUND_ACCEL = 95;
export const AIR_ACCEL = 105;
export const AIR_WISH_CAP = 1.6;              // classic air-strafe accel cap
export const GROUND_FRICTION = 8.5;
export const AIR_FRICTION = 0.0;
export const MAX_AIR_SPEED = 30;
export const SLIDE_BOOST = 5.4;               // added u/s when a slide starts
export const SLIDE_FRICTION = 1.35;
export const SLIDE_MIN_SPEED = 4.5;           // below this the slide ends
export const SLIDE_MAX_TIME = 1.35;           // s
export const SLIDE_COOLDOWN = 0.35;           // s
export const JUMP_COOLDOWN = 0.0;             // s — 0 keeps hops perfectly chainable
export const COYOTE_TIME = 0.16;              // s of late-jump grace
export const JUMP_BUFFER = 0.22;              // s of early-jump grace
/**
 * The same grace, for the crouch key.
 *
 * Both are *one* press worth of grace, not a repeat: holding either key does
 * nothing after the frame it went down (see shared/movement.js). A bunny hop is
 * a rhythm you play, and a slide is a move you commit to — neither is a key you
 * lean on.
 */
export const SLIDE_BUFFER = 0.2;              // s of early-slide grace
export const HOP_GRACE = 0.18;                // s after landing where friction is skipped
export const HOP_SPEED_KEEP = 0.985;          // speed retained through a chained hop
export const FALL_DAMAGE_SPEED = 26;          // impact speed where damage starts
export const FALL_DAMAGE_SCALE = 4.2;         // hp per u/s over the threshold
/** Crouching mid-air tucks the legs: a little extra clearance over a ledge. */
export const CROUCH_JUMP_LIFT = 0.0;
/**
 * Carving: how fast momentum turns to follow where you are pointing.
 *
 * Radians per second, applied to the *direction* of the horizontal velocity
 * without touching its length — so a slide or a chained hop keeps every unit of
 * speed it earned and simply points it somewhere else. That is the whole rule:
 * speed is earned by hopping and sliding, and steering only decides where it
 * goes.
 *
 * A slide carves hard, because a slide is a committed, one-and-a-third-second
 * move you paid for with a crouch. The air carves about half as hard: enough
 * that a bunny hop follows your aim around a corner, not so much that the
 * air-strafe underneath it stops mattering.
 */
export const SLIDE_STEER = 5.2;
export const AIR_STEER = 2.6;
/**
 * Below this speed neither one steers.
 *
 * Carving is momentum being redirected, so there has to be momentum: a standing
 * jump or the last crawl of a dying slide would otherwise pivot on the spot,
 * which reads as the character sliding on ice rather than carrying speed.
 */
export const STEER_MIN_SPEED = BASE_SPEED * 0.55;
/** A jump that leaves a slide keeps this fraction of the slide's speed. */
export const SLIDE_JUMP_KEEP = 1.0;

/* ── Combat ───────────────────────────────────────────────────────────────── */

export const HEADSHOT_MULT = 2.35;
export const LEG_MULT = 0.85;
export const MELEE_RANGE = 3.1;
export const MELEE_DAMAGE = 60;
export const MELEE_COOLDOWN = 0.52;
export const MAX_SHOT_RANGE = 400;
/** Ammo reserves are unlimited everywhere — reloads never cost anything. */
export const INFINITE_AMMO = true;
export const KILLSTREAK_LABELS = [
  [3, 'TRIPLE'], [5, 'RAMPAGE'], [7, 'UNSTOPPABLE'],
  [10, 'GODLIKE'], [15, 'LEGENDARY'], [20, 'MYTHIC'],
];

/* ── The nuke ─────────────────────────────────────────────────────────────── */

/**
 * The last killstreak, and the only one that does anything.
 *
 * Twelve kills without dying in an eight-player room is a run nobody has by
 * accident — roughly a third of an FFA's whole score limit taken off a lobby
 * that is actively trying to stop you. Earning it arms the launch; it is never
 * automatic, because the moment it is worth something is the moment the player
 * chooses to spend it, and because a streak that ends the match the instant it
 * lands would take the decision away from the person who earned it.
 *
 * It is spent, not kept: launching clears the streak, so a nuke is one per run
 * rather than one every twelfth kill.
 */
export const NUKE_STREAK = 12;
/** Seconds between the launch and the flash. Long enough to be a warning. */
export const NUKE_COUNTDOWN = 7.0;
/** The match is over once it lands; this is how long the flash holds first. */
export const NUKE_BLAST_HOLD = 1.6;

/* ── Scoring ──────────────────────────────────────────────────────────────── */

/**
 * Points awarded for the things worth doing. Every 100 points earned over a
 * match converts to 1 GR when it ends (see `GR_PER_SCORE`).
 */
export const SCORE = {
  KILL: 50,
  HEADSHOT: 50,          // on top of the kill
  MIDAIR: 25,            // victim was airborne
  AIRSHOT: 25,           // you were airborne
  DRIFT: 50,             // killed while sliding
  NOSCOPE: 100,          // sniper kill without scoping
  QUICKSCOPE: 60,        // sniper kill within 0.35 s of scoping in
  LONGSHOT: 50,          // over LONGSHOT_RANGE units
  POINTBLANK: 20,        // under 4 units
  BACKSTAB: 75,
  MELEE: 40,
  ASSIST: 25,
  FIRST_BLOOD: 50,
  REVENGE: 25,
  SHUTDOWN: 40,          // ended a streak of 5+
  MULTIKILL: 40,         // second kill within MULTIKILL_WINDOW
  STREAK_STEP: 25,       // per killstreak milestone reached
  NUKE: 500,             // called one in, and it landed
  SUICIDE: -25,
  TEAMKILL: -50,
};

export const LONGSHOT_RANGE = 60;
export const MULTIKILL_WINDOW = 4.5;          // s
export const NOSCOPE_GRACE = 0.35;            // s of scope time that still counts as quickscope
export const SCORE_LABELS = {
  KILL: 'KILL', HEADSHOT: 'HEADSHOT', MIDAIR: 'MIDAIR', AIRSHOT: 'AIRSHOT',
  DRIFT: 'DRIFT KILL', NOSCOPE: 'NO SCOPE', QUICKSCOPE: 'QUICKSCOPE',
  LONGSHOT: 'LONGSHOT', POINTBLANK: 'POINT BLANK', BACKSTAB: 'BACKSTAB',
  MELEE: 'MELEE', ASSIST: 'ASSIST', FIRST_BLOOD: 'FIRST BLOOD', REVENGE: 'REVENGE',
  SHUTDOWN: 'SHUTDOWN', MULTIKILL: 'MULTI KILL', STREAK_STEP: 'KILLSTREAK',
  SUICIDE: 'SUICIDE', TEAMKILL: 'TEAM KILL', NUKE: 'NUKE',
};

/* ── Progression ──────────────────────────────────────────────────────────── */

/**
 * XP a finished match pays: exactly the match score, one for one.
 *
 * It used to be a formula of its own — so many points per kill, a bonus per
 * headshot, a flat lump for the win — which meant the number on the end card
 * had no relationship to the number the player had been watching climb all
 * match. Scoring already prices every one of those things (see SCORE), and it
 * prices them together: a longshot headshot is worth more than two body shots
 * because the scoreboard says so. Paying the score back as XP is the same
 * judgement applied twice instead of two judgements that disagree.
 *
 * Daily challenges still pay their own XP on top; they are a separate reward
 * for a separate thing, and the end card lists them separately too.
 */
export const xpFromScore = (score) => Math.max(0, Math.round(score || 0));
/** GR — the in-game currency. Match score converts at this rate. */
export const GR_PER_SCORE = 100;              // 100 match points → 1 GR
export const GR_PER_WIN = 25;                 // flat bonus for taking the match
export const CURRENCY = 'GR';
/** What a nickname change costs an account. Guests cannot rename at all. */
export const RENAME_COST = 100;
/** The ceiling. Nothing above this is reachable, so nothing above it is priced. */
export const MAX_LEVEL = 999;

/**
 * Where the ladder stops being generous.
 *
 * Below `LEVEL_RAMP_FROM` the curve is *exactly* what it always was, because
 * the thing a new account needs is to watch the number move: the first ten
 * levels still cost what they cost, and the gates that live down there — chat
 * at 2, the report button and a clan at 5 — arrive on the same evening they
 * always did. Past it a second term takes over and grows far faster than the
 * first, so every level up the ladder costs meaningfully more than the one
 * under it: level 30 lands at roughly twice the old figure, level 50 at three
 * and a half times it, level 100 at eight.
 *
 * That is the whole point of the shape. A single exponent that made the top of
 * the ladder respectable would have made the bottom of it a wall, and the
 * bottom of the ladder is where people decide whether to come back.
 */
export const LEVEL_RAMP_FROM = 10;
export const LEVEL_RAMP_COST = 9;
export const LEVEL_RAMP_POWER = 2.6;

/** Total XP required to reach `level`. Soft to LEVEL_RAMP_FROM, steep after it. */
export const xpForLevel = (level) => {
  const l = Math.max(1, Math.min(MAX_LEVEL + 1, Math.floor(level)));
  const over = l - LEVEL_RAMP_FROM;
  return Math.floor(120 * (l - 1) ** 1.55 + (over > 0 ? LEVEL_RAMP_COST * over ** LEVEL_RAMP_POWER : 0));
};

/**
 * The whole ladder, precomputed once.
 *
 * `levelFromXp` is called on every match payout and on every admin write, and
 * it used to walk the curve one level at a time, evaluating two fractional
 * powers per step. The table costs a kilobyte and turns that into a binary
 * search.
 */
const LEVEL_XP = (() => {
  const table = new Float64Array(MAX_LEVEL + 2);
  for (let l = 1; l <= MAX_LEVEL + 1; l++) table[l] = xpForLevel(l);
  return table;
})();

export const levelFromXp = (xp) => {
  const x = Number(xp) || 0;
  if (x < LEVEL_XP[2]) return 1;
  let lo = 1, hi = MAX_LEVEL;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEVEL_XP[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
};

/**
 * GR paid for reaching a level, and what the client announces.
 *
 * The steeper curve above needs something on the other side of it: a level that
 * takes three evenings to earn and pays nothing is a level nobody chases. The
 * payout climbs with the level, so the expensive end of the ladder is also the
 * profitable one, and it is capped so it can never outrun what a match pays.
 */
export const levelUpReward = (level) => {
  const l = Math.max(2, Math.floor(level));
  return { gr: Math.min(600, 40 + (l - 1) * 12) };
};
/**
 * GR earned from a finished match.
 *
 * A blank scoreboard pays nothing at all: no points, no GR, and not even the
 * win bonus. Sitting in a spawn while the team carries the match is not work.
 */
export const grFromScore = (score, won = false) => {
  if (!(score > 0)) return 0;
  return Math.floor(score / GR_PER_SCORE) + (won ? GR_PER_WIN : 0);
};

/* ── Teams & modes ────────────────────────────────────────────────────────── */

export const TEAM = { NONE: 0, RED: 1, BLUE: 2 };
export const TEAM_COLORS = { [TEAM.NONE]: 0xf0a010, [TEAM.RED]: 0xff4040, [TEAM.BLUE]: 0x4090ff };
export const TEAM_NAMES = { [TEAM.NONE]: 'FFA', [TEAM.RED]: 'RED', [TEAM.BLUE]: 'BLUE' };

/** Matches are four minutes. Score limits are high enough that time usually decides. */
export const MATCH_TIME = 240;
export const INTERMISSION_TIME = 18;

export const MODES = {
  ffa: {
    id: 'ffa', name: 'Free For All', short: 'FFA', teams: false,
    scoreLimit: 30, timeLimit: MATCH_TIME,
    blurb: 'Everyone for themselves. First to 30 kills, or the highest score when the clock runs out.',
  },
  tdm: {
    id: 'tdm', name: 'Team Deathmatch', short: 'TDM', teams: true,
    scoreLimit: 50, timeLimit: MATCH_TIME,
    blurb: 'Red versus Blue. First team to 50 eliminations takes the match.',
  },
  gg: {
    id: 'gg', name: 'Gun Game', short: 'GG', teams: false,
    scoreLimit: 0, timeLimit: MATCH_TIME, gunGame: true,
    blurb: 'Every kill promotes you to the next weapon. Finish the ladder with a knife kill to win.',
  },
  dom: {
    id: 'dom', name: 'Domination', short: 'DOM', teams: true,
    scoreLimit: 300, timeLimit: MATCH_TIME + 60, objectives: true,
    blurb: 'Hold A, B and C. Every captured point ticks score for your team.',
  },
  range: {
    id: 'range', name: 'Practice Range', short: 'RANGE', teams: false,
    scoreLimit: 0, timeLimit: 0, practice: true,
    blurb: 'No clock, no pressure. Targets, bots on demand and a live accuracy readout.',
  },
};

/** The ladder Gun Game climbs — one rung per kill, knife last. */
export const GUN_GAME_LADDER = [
  'runngun', 'triggerman', 'spraynpray', 'detective', 'bulldog',
  'vince', 'marksman', 'hunter', 'rocketeer',
];
/** Kills needed on each rung before promotion. */
export const GUN_GAME_KILLS_PER_RUNG = 2;

/* ── Domination ───────────────────────────────────────────────────────────── */

export const DOM_CAPTURE_RADIUS = 5.2;        // world units around a flag
export const DOM_CAPTURE_TIME = 5.0;          // s of solo presence to flip a point
export const DOM_TICK_INTERVAL = 4.0;         // s between score ticks
export const DOM_TICK_POINTS = 5;             // team score per held point per tick
export const DOM_CAPTURE_SCORE = 60;          // personal points for a capture
export const DOM_DEFEND_SCORE = 30;           // personal points for a defend kill
export const DOM_NAMES = ['A', 'B', 'C'];

/* ── Map voting ───────────────────────────────────────────────────────────── */

/** Number of candidates offered at the end of a match. */
export const VOTE_OPTIONS = 3;

/* ── Visibility (nametags / minimap) ──────────────────────────────────────── */

export const TAG_MAX_DISTANCE = 110;          // nametags fade out past this
export const VIS_CHECK_INTERVAL = 0.08;       // s between line-of-sight refreshes
export const VIS_MEMORY = 1.1;                // s an enemy stays on the minimap after being seen
/** Base world height of a nametag plate at 1.0× scale — the user can resize it. */
export const TAG_BASE_WIDTH = 3.1;
export const TAG_BASE_HEIGHT = 0.94;
/** Distance at which a plate stops growing on screen (keeps far tags readable). */
export const TAG_REF_DISTANCE = 16;
export const TAG_MAX_GROWTH = 4.2;

/* ── Surfaces ─────────────────────────────────────────────────────────────── */

/**
 * Material of a solid. Drives the texture it is drawn with, the impact
 * particles a bullet kicks off it, and the sound that impact makes.
 */
export const SURFACE = {
  CONCRETE: 'concrete',
  BRICK: 'brick',
  PLASTER: 'plaster',
  WOOD: 'wood',
  PLANK: 'plank',
  METAL: 'metal',
  RUST: 'rust',
  GRATE: 'grate',
  SAND: 'sand',
  ROCK: 'rock',
  DIRT: 'dirt',
  SNOW: 'snow',
  ICE: 'ice',
  TILE: 'tile',
  ROOF: 'roof',
  CRATE: 'crate',
  FOLIAGE: 'foliage',
  GLASS: 'glass',

  /*
   * The town set. Everything above predates the art pass and reads gritty and
   * desaturated; these are painted flat and bright so a map built out of them
   * looks like a toy town rather than a bombed-out warehouse.
   */
  ASPHALT: 'asphalt',      // road surface
  PAINT: 'paint',          // road markings, painted metal, car bodies
  GRASS: 'grass',          // lawns and verges
  HEDGE: 'hedge',          // clipped garden hedges
  FENCE: 'fence',          // horizontal garden fence boards
  SIDING: 'siding',        // painted house cladding
  WINDOW: 'window',        // glazed window with a frame
  SHINGLE: 'shingle',      // bright asphalt-shingle roof
  BARK: 'bark',            // tree trunks
  WATER: 'water',          // ponds, fountains, canals
  CANVAS: 'canvas',        // awnings, tarpaulins, market stalls
  TARMAC: 'tarmac',        // pavement / kerb slabs
  NEON: 'neon',            // signage, emissive-looking panels

  /**
   * The invisible edge of the world. Never drawn, and — because a bullet that
   * stopped in mid-air over a sunlit street would puff dust out of nothing —
   * never given an impact either.
   */
  VOID: 'void',
};

/** Impact tint + spark behaviour per surface. */
export const SURFACE_FX = {
  concrete: { dust: 0xb9b4ad, sparks: 0.15, sound: 'stone' },
  brick:    { dust: 0xb07a5c, sparks: 0.15, sound: 'stone' },
  plaster:  { dust: 0xded3bb, sparks: 0.08, sound: 'stone' },
  wood:     { dust: 0x9d6f42, sparks: 0.05, sound: 'wood' },
  plank:    { dust: 0xa87c4c, sparks: 0.05, sound: 'wood' },
  metal:    { dust: 0xa8b0ba, sparks: 0.95, sound: 'metal' },
  rust:     { dust: 0x8a5a3d, sparks: 0.75, sound: 'metal' },
  grate:    { dust: 0x9aa3ad, sparks: 0.9, sound: 'metal' },
  sand:     { dust: 0xd9c193, sparks: 0.0, sound: 'sand' },
  rock:     { dust: 0xa79c8c, sparks: 0.2, sound: 'stone' },
  dirt:     { dust: 0x8b7355, sparks: 0.0, sound: 'dirt' },
  snow:     { dust: 0xf2f8ff, sparks: 0.0, sound: 'snow' },
  ice:      { dust: 0xd8ecff, sparks: 0.1, sound: 'glass' },
  tile:     { dust: 0xc9cdd2, sparks: 0.2, sound: 'stone' },
  roof:     { dust: 0x9a5348, sparks: 0.1, sound: 'stone' },
  crate:    { dust: 0xa9762f, sparks: 0.05, sound: 'wood' },
  foliage:  { dust: 0x4b7a4a, sparks: 0.0, sound: 'foliage' },
  glass:    { dust: 0xcfe8ff, sparks: 0.35, sound: 'glass' },

  asphalt:  { dust: 0x6a6f76, sparks: 0.05, sound: 'stone' },
  paint:    { dust: 0xe8e8e4, sparks: 0.25, sound: 'metal' },
  grass:    { dust: 0x6fae4f, sparks: 0.0, sound: 'dirt' },
  hedge:    { dust: 0x4e8f3d, sparks: 0.0, sound: 'foliage' },
  fence:    { dust: 0xc07a3a, sparks: 0.05, sound: 'wood' },
  siding:   { dust: 0xd9dce0, sparks: 0.05, sound: 'wood' },
  window:   { dust: 0xd6ecff, sparks: 0.3, sound: 'glass' },
  shingle:  { dust: 0x8d5a4a, sparks: 0.05, sound: 'stone' },
  bark:     { dust: 0x7a5432, sparks: 0.0, sound: 'wood' },
  water:    { dust: 0x8fd4ee, sparks: 0.0, sound: 'dirt' },
  canvas:   { dust: 0xe4d6bc, sparks: 0.0, sound: 'wood' },
  tarmac:   { dust: 0xbfc3c8, sparks: 0.1, sound: 'stone' },
  neon:     { dust: 0xffe9a8, sparks: 0.5, sound: 'glass' },
  // `silent` is read by the impact effect and by the impact sound: a hit on
  // this surface produces no particles, no decal and no noise.
  void:     { dust: 0x000000, sparks: 0, sound: null, silent: true },
};

/* ── Weapon mastery ───────────────────────────────────────────────────────── */

/** Kills needed to reach each mastery tier with one weapon. */
export const MASTERY_TIERS = [
  { tier: 1, kills: 0,    name: 'Recruit',  color: 0x8fa0b4 },
  { tier: 2, kills: 25,   name: 'Marksman', color: 0x4ddb7a },
  { tier: 3, kills: 75,   name: 'Veteran',  color: 0x4d9bff },
  { tier: 4, kills: 175,  name: 'Elite',    color: 0xb07cff },
  { tier: 5, kills: 350,  name: 'Master',   color: 0xf5a623 },
  { tier: 6, kills: 700,  name: 'Legend',   color: 0xff5f5f },
];

export function masteryFor(kills = 0) {
  let cur = MASTERY_TIERS[0];
  for (const t of MASTERY_TIERS) if (kills >= t.kills) cur = t;
  const next = MASTERY_TIERS.find((t) => t.kills > kills) ?? null;
  const span = next ? next.kills - cur.kills : 1;
  return {
    ...cur,
    next,
    progress: next ? Math.min(1, (kills - cur.kills) / span) : 1,
    toNext: next ? next.kills - kills : 0,
  };
}

/* ── Daily challenges ─────────────────────────────────────────────────────── */

/**
 * The pool three daily challenges are drawn from. `stat` names a counter the
 * server bumps during a match; `goal` is how many of it the day asks for.
 */
export const CHALLENGE_POOL = [
  { id: 'kills20',    stat: 'kills',      goal: 20,   xp: 300, gr: 25, name: 'Body Count',      desc: 'Get 20 kills' },
  { id: 'kills50',    stat: 'kills',      goal: 50,   xp: 700, gr: 60, name: 'Rampage',         desc: 'Get 50 kills' },
  { id: 'heads10',    stat: 'headshots',  goal: 10,   xp: 400, gr: 35, name: 'Precision',       desc: 'Land 10 headshots' },
  { id: 'heads25',    stat: 'headshots',  goal: 25,   xp: 800, gr: 70, name: 'Surgical',        desc: 'Land 25 headshots' },
  { id: 'midair5',    stat: 'midairs',    goal: 5,    xp: 350, gr: 30, name: 'Skeet',           desc: 'Kill 5 airborne enemies' },
  { id: 'noscope3',   stat: 'noscopes',   goal: 3,    xp: 450, gr: 45, name: 'Trust the Sights', desc: 'Land 3 no-scope kills' },
  { id: 'drift5',     stat: 'drifts',     goal: 5,    xp: 350, gr: 30, name: 'Drifter',         desc: 'Kill 5 enemies while sliding' },
  { id: 'melee5',     stat: 'melees',     goal: 5,    xp: 300, gr: 25, name: 'Up Close',        desc: 'Get 5 melee kills' },
  { id: 'score3k',    stat: 'score',      goal: 3000, xp: 450, gr: 40, name: 'Point Machine',   desc: 'Earn 3000 match points' },
  { id: 'wins2',      stat: 'wins',       goal: 2,    xp: 500, gr: 50, name: 'Winner',          desc: 'Win 2 matches' },
  { id: 'damage5k',   stat: 'damage',     goal: 5000, xp: 400, gr: 35, name: 'Heavy Hitter',    desc: 'Deal 5000 damage' },
  { id: 'matches5',   stat: 'matches',    goal: 5,    xp: 300, gr: 25, name: 'Regular',         desc: 'Finish 5 matches' },
  { id: 'streak5',    stat: 'bestStreak', goal: 5,    xp: 400, gr: 35, name: 'On a Roll',       desc: 'Reach a 5 killstreak' },
  { id: 'assists10',  stat: 'assists',    goal: 10,   xp: 300, gr: 25, name: 'Team Player',     desc: 'Get 10 assists' },
  { id: 'longshot3',  stat: 'longshots',  goal: 3,    xp: 400, gr: 40, name: 'Long Distance',   desc: 'Land 3 longshot kills' },
];

export const CHALLENGES_PER_DAY = 3;

/** Deterministic daily pick, so every player gets the same three challenges. */
export function dailyChallenges(dayIndex) {
  const out = [];
  const pool = CHALLENGE_POOL;
  let h = (dayIndex * 2654435761) >>> 0;
  const used = new Set();
  while (out.length < CHALLENGES_PER_DAY && used.size < pool.length) {
    h = (Math.imul(h ^ (h >>> 15), 0x2545f491) + 0x9e3779b9) >>> 0;
    const i = h % pool.length;
    if (used.has(i)) continue;
    used.add(i);
    out.push(pool[i]);
  }
  return out;
}

/** UTC day number — the unit dailies roll over on. */
export const dayIndex = (ms = Date.now()) => Math.floor(ms / 86400000);

/* ── Coming back tomorrow ─────────────────────────────────────────────────── */

/**
 * Daily play streak.
 *
 * One check-in per UTC day, on the first match you *finish* — not on opening
 * the page. That distinction is the whole design: the reward is for playing,
 * so it cannot be farmed by loading the menu, and a player who came back and
 * played a single match has already earned the day.
 *
 * The payout climbs for a week and then flattens. A curve that kept climbing
 * would turn a missed day into a punishment worth quitting over; a flat one
 * gives nobody a reason to come back on day three.
 */
export const STREAK_CAP_DAYS = 7;
export const streakReward = (streak) => {
  const step = Math.min(Math.max(1, streak), STREAK_CAP_DAYS) - 1;
  const gr = 60 + step * 30;                    // 60 → 240 over a week
  return { gr, xp: gr * 3 };
};

/** First win of the day. Flat, generous, and impossible to grind twice. */
export const FIRST_WIN_BONUS = { xp: 400, gr: 140 };

/**
 * What signing up actually hands you.
 *
 * The menu has advertised "GET SIGNUP REWARDS" since the first release and the
 * button only ever opened the form, which is the worst version of a promise.
 * This is the list it now pays, granted once at registration and itemised on
 * the card the new account lands on.
 *
 * Every line of it is something a guest is *already* being refused rather than
 * something invented to bribe them: a guest's score evaporates when they close
 * the tab, a guest cannot be called anything, a guest owns no skins. The grant
 * is the same argument stated in numbers.
 */
export const SIGNUP_REWARD = {
  gr: 500,
  xp: 0,
  skins: ['enlisted'],
  lines: [
    { icon: '\u25c6', title: `500 ${CURRENCY}`, desc: 'enough for your first weapon finish, on the house' },
    { icon: '\u2726', title: 'Your name, kept', desc: 'a guest is assigned one and loses it every session' },
    { icon: '\u25b3', title: 'XP and levels', desc: 'every point you score becomes XP the moment a match ends' },
    { icon: '\u25c9', title: 'Daily streak & first win', desc: 'two bonuses a guest can never claim' },
  ],
};

/**
 * What a guest is told they walked away from.
 *
 * A finished match already knows exactly what it would have paid — the score is
 * the XP and the GR is a division — so the end-of-match card can put a real
 * number in front of a guest instead of a slogan. Nothing is stored: there is
 * no account to store it against, and pretending otherwise would be a lie the
 * next session exposes.
 */
export const guestForfeit = (score, won = false) => ({
  xp: xpFromScore(score),
  gr: grFromScore(score, won),
});

/** How a streak reads in the interface. */
export const streakLabel = (streak) => {
  if (streak <= 0) return 'No streak yet';
  if (streak === 1) return 'Day 1';
  return `${streak} day streak`;
};

/* ── Roles ────────────────────────────────────────────────────────────────── */

/** Account roles, weakest first. Stored verbatim in `users.role`. */
export const ROLES = ['player', 'mod', 'admin'];
const ROLE_RANK = { player: 0, mod: 1, admin: 2 };

export const rankOf = (role) => ROLE_RANK[role] ?? 0;
/** Mods and admins can moderate; everyone else cannot. */
export const canModerate = (role) => rankOf(role) >= ROLE_RANK.mod;
/**
 * Strictly greater rank. Equal ranks deliberately fail, so two mods can never
 * silence each other and an admin can never be silenced by their own staff.
 */
export const outranks = (a, b) => rankOf(a) > rankOf(b);

/** The chip drawn next to a nickname. Roles without one render nothing. */
export const ROLE_TAG = {
  admin: { label: 'ADMIN', title: 'Administrator' },
  mod: { label: 'MOD', title: 'Moderator' },
};

/* ── Chat ─────────────────────────────────────────────────────────────────── */

/** Messages one match's chat keeps. Older lines fall off the end. */
export const CHAT_HISTORY = 50;
/** Below this level an account can read the chat but not write into it. */
export const CHAT_MIN_LEVEL = 2;
/** Minimum gap between two messages from the same player. */
export const CHAT_COOLDOWN_MS = 900;
/** Mute lengths the scoreboard offers. `minutes: 0` means permanent. */
export const MUTE_DURATIONS = [
  { minutes: 5, label: '5M', title: '5 minutes' },
  { minutes: 60, label: '1H', title: '1 hour' },
  { minutes: 1440, label: '1D', title: '1 day' },
  { minutes: 0, label: '\u221e', title: 'permanently' },
];

/** How a mute expiry reads in a chat notice. */
export const muteUntilText = (until) => (until > 0
  ? `until ${new Date(until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  : 'permanently');

/**
 * How long a line stays on the HUD before it drops out of view.
 *
 * Every line goes the same way, moderation notices included: a ban or a mute
 * is loud while it happens and then gets out of the way, exactly like chatter.
 * Nothing is deleted — the match's log still holds it, and opening the chat
 * brings it all back.
 */
export const CHAT_VISIBLE_MS = 13_000;
export const CHAT_FADE_MS = 1000;

/* ── Reports ────────────────────────────────────────────────────────────────────── */

/** Why one player reports another. The `id` is what the database stores. */
export const REPORT_REASONS = [
  { id: 'cheat', label: 'CHEATING', desc: 'Aimbot, wallhack, impossible movement' },
  { id: 'chat', label: 'CHAT ABUSE', desc: 'Insults, harassment, spam' },
  { id: 'name', label: 'OFFENSIVE NAME', desc: 'Nickname, clan tag or profile picture' },
  { id: 'grief', label: 'GRIEFING', desc: 'Team killing, throwing, blocking spawns' },
  { id: 'other', label: 'SOMETHING ELSE', desc: 'Say what happened in your own words' },
];

export const REPORT_REASON_IDS = REPORT_REASONS.map((r) => r.id);
export const reportReason = (id) => REPORT_REASONS.find((r) => r.id === id) ?? null;
/** The label a reason reads under, falling back to whatever was stored. */
export const reportReasonLabel = (id) => reportReason(id)?.label ?? String(id ?? '—').toUpperCase();

/** Free text the reporter may add. Long enough to describe a round, no more. */
export const REPORT_DETAIL_MAX = 300;

/**
 * Where a report ends up.
 *
 * `open` is the only state a player's report starts in; a moderator moves it to
 * one of the other two, and the reporter reads that verdict back from their own
 * account panel. That feedback loop is the whole point of keeping the row: a
 * report nobody ever hears about again is a report nobody files twice.
 */
export const REPORT_STATUS = {
  open: { label: 'UNDER REVIEW', note: 'A moderator has not looked at this yet.' },
  actioned: { label: 'ACTION TAKEN', note: 'This report led to a sanction.' },
  rejected: { label: 'NO ACTION', note: 'A moderator found nothing to act on.' },
};
export const REPORT_STATUSES = Object.keys(REPORT_STATUS);

/** What a moderator did about it. Shown to the reporter, so keep it plain. */
export const REPORT_ACTIONS = {
  none: 'Nothing — no rule was broken',
  warned: 'The player was warned',
  muted: 'The player was muted',
  banned: 'The player was banned',
};
export const REPORT_ACTION_IDS = Object.keys(REPORT_ACTIONS);

/**
 * The ceilings on one account's reporting.
 *
 * A report costs the person filing it nothing and costs a moderator a minute of
 * reading, so the only thing keeping the queue worth reading is that no single
 * account can fill it. Each limit answers a different way of abusing the button,
 * and every one of them is enforced by the server at the moment of filing — the
 * client only ever hides a button the server would refuse anyway.
 */
/** Reports one account may file per hour. Beyond this the button is refused. */
export const REPORT_MAX_PER_HOUR = 6;
/** …and per rolling day, so an hourly cap cannot simply be waited out six times. */
export const REPORT_MAX_PER_DAY = 15;
/**
 * Reports of yours a moderator may still have open at once.
 *
 * This is the limit that actually stops a flood: someone whose reports are never
 * acted on stops being able to file new ones until a human has looked at the
 * ones already waiting, and somebody who reports real cheaters gets their
 * allowance straight back as the queue is worked.
 */
export const REPORT_MAX_OPEN = 5;
/** Minimum gap between any two reports from the same account. */
export const REPORT_COOLDOWN_SEC = 60;
/** How long before the same reporter may file on the same player again. */
export const REPORT_REPEAT_COOLDOWN_SEC = 600;
/**
 * Below this level an account cannot report.
 *
 * A fresh throwaway is not a witness, and the bar is deliberately higher than
 * the chat's: writing a bad line costs one person one line, while filing a bad
 * report costs a moderator the time of every real report it buried. Five levels
 * is a few matches actually played rather than an account made this minute.
 */
export const REPORT_MIN_LEVEL = 5;
/**
 * Crying wolf costs something.
 *
 * A reporter whose reports keep coming back as "no action" is not reading the
 * game, they are using the button as a complaint box. After `max` dismissals
 * inside `windowDays` the button is shut for `lockoutHours`, counted from the
 * last dismissal — so it clears itself and no extra state has to be stored.
 */
export const REPORT_DISMISSED_LOCKOUT = { max: 5, windowDays: 7, lockoutHours: 24 };

/* ── Clans ────────────────────────────────────────────────────────────────── */

/**
 * A clan is a tag, an owner and a member list — nothing more.
 *
 * The tag is the whole visible product: it is drawn in front of the nickname
 * everywhere a nickname appears, which is exactly why it is four characters of
 * plain ASCII and nothing else. A tag that can hold a zero-width joiner, a
 * right-to-left mark or a combining accent is a tag that can impersonate a
 * moderator, break a killfeed row or paint over the plate next to it, and the
 * scoreboard has no way to tell that apart from a clan name.
 */
export const CLAN_TAG_MIN = 2;
export const CLAN_TAG_MAX = 4;
/** Letters and digits, uppercase, two to four of them. Deliberately narrow. */
export const CLAN_TAG_RE = /^[A-Z0-9]{2,4}$/;
/** Level needed to accept an invite. */
export const CLAN_JOIN_LEVEL = 5;
/** Level needed to found one — and what founding it costs. */
export const CLAN_CREATE_LEVEL = 15;
export const CLAN_CREATE_COST = 1000;
/** Members one clan may hold, owner included. */
export const CLAN_MAX_MEMBERS = 24;
/** Invites one clan may have outstanding, and how long each one lives. */
export const CLAN_MAX_INVITES = 25;
export const CLAN_INVITE_TTL_HOURS = 72;

/**
 * Tags nobody may found a clan under.
 *
 * Every one of these would read, next to a nickname, as something the server
 * said rather than something a player chose.
 */
export const CLAN_RESERVED_TAGS = [
  'ADMN', 'ADM', 'MOD', 'MODS', 'DEV', 'DEVS', 'STAF', 'GM', 'OG', 'BOT',
  'BOTS', 'NULL', 'NONE', 'SYS', 'ROOT', 'TEAM', 'VIP',
  // …plus the one word that is a route rather than a name: /clans/mine is this
  // account's own clan, so a clan called MINE could never be linked to.
  'MINE',
];

/** How a typed tag is stored: trimmed and uppercased, never otherwise altered. */
export const normaliseClanTag = (raw) => String(raw ?? '').trim().toUpperCase();

/**
 * Why a tag is unacceptable, or null when it is fine.
 *
 * Shared so the browser can grey the button out for the same reason the server
 * would refuse the request — the server is still the one that decides.
 */
export function clanTagError(raw) {
  const tag = normaliseClanTag(raw);
  if (!tag) return 'pick a clan tag';
  if (tag.length < CLAN_TAG_MIN || tag.length > CLAN_TAG_MAX) {
    return `a clan tag is ${CLAN_TAG_MIN}–${CLAN_TAG_MAX} characters`;
  }
  if (!CLAN_TAG_RE.test(tag)) return 'letters and digits only — no spaces, accents or symbols';
  if (CLAN_RESERVED_TAGS.includes(tag)) return `[${tag}] is reserved`;
  return null;
}

/** Roles inside a clan. One owner, everybody else a member. */
export const CLAN_ROLES = ['owner', 'member'];

/**
 * What colour a clan tag reads in.
 *
 * Grey by default and gold once the developers have verified the clan, which is
 * the only difference between the two and the only thing verification buys.
 */
export const CLAN_TAG_COLOR = '#8fa1b7';
export const CLAN_TAG_COLOR_VERIFIED = '#f5c542';

/** Ceilings on a clan picture. Same machinery, same limits, as an avatar's. */
export const CLAN_AVATAR_SIZE = 256;

/* ── Profile pictures ─────────────────────────────────────────────────────── */

/**
 * An avatar is stored exactly as it arrives — there is no image library on the
 * server to re-encode it with — so the limits are what keeps the disk small.
 * The client squares, downscales to AVATAR_SIZE and re-encodes before it ever
 * uploads, which puts a normal picture around 20 KB; the server then refuses
 * anything past these bounds, because a client is not a promise.
 */
export const AVATAR_SIZE = 256;
/** Hard ceiling on the stored file. A 256×256 WebP is nowhere near this. */
export const AVATAR_MAX_BYTES = 192 * 1024;
/** Ceiling on the stored pixels, whatever the file size says. */
export const AVATAR_MAX_DIM = 512;
/** What the picker accepts, and what the server will store. */
export const AVATAR_TYPES = ['image/webp', 'image/png', 'image/jpeg'];
/** Biggest file the picker will even try to read, before downscaling. */
export const AVATAR_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

/* ── Wire protocol opcodes ────────────────────────────────────────────────── */

/** Client → server */
export const C2S = {
  HELLO: 'hello',
  INPUT: 'in',
  SHOOT: 'sh',
  MELEE: 'ml',
  RELOAD: 'rl',
  SWITCH: 'sw',
  CHAT: 'ch',
  PING: 'pi',
  RESPAWN: 'rs',
  CLASS: 'cl',
  TEAM: 'tm',
  PLAY: 'pl',         // a spectator asking to enter the match
  VOTE: 'vo',         // map vote during the intermission
  SPECTATE: 'sp',     // switch the spectator camera target
  SPECMODE: 'sm',     // turn spectator mode on or off for this player
  MOD: 'md',          // a moderator acting on someone from the scoreboard
  REPORT: 'rp',       // a player reporting someone from the scoreboard
  NUKE: 'nk',         // spending an earned killstreak on the nuke
};

/** Server → client */
export const S2C = {
  WELCOME: 'we',
  SNAPSHOT: 'sn',
  JOIN: 'jn',
  LEAVE: 'lv',
  HIT: 'ht',          // you hit someone (hitmarker + damage number)
  DAMAGE: 'dm',       // you took damage
  KILL: 'kf',         // killfeed entry
  DEATH: 'de',        // you died
  SPAWN: 'sp',        // you spawned
  SHOT: 'fx',         // someone else fired (tracer + sound)
  IMPACT: 'im',       // surface impact fx
  CHAT: 'ch',
  PONG: 'po',
  SCORE: 'sc',
  POINTS: 'pt',       // score events awarded to you (+50 HEADSHOT …)
  MATCH: 'mt',        // match state / round end
  AMMO: 'am',
  ERROR: 'er',
  EXPLOSION: 'ex',
  OBJECTIVE: 'ob',    // domination point state
  VOTE: 'vo',         // map vote options / tally
  PROGRESS: 'pg',     // mastery + challenge progress popups
  GUNGAME: 'gg',      // gun-game rung change
  CHATSTATE: 'cs',    // may you write into the chat, and why not
  REPORT: 'rp',       // the outcome of a report this player just filed
  REPORTSTATE: 'rt',  // may you report anyone at all, and why not
  NUKE: 'nk',         // nuke armed / launched / landed
};

/* ── Misc ─────────────────────────────────────────────────────────────────── */

export const NAME_MIN = 3;
export const NAME_MAX = 16;
export const NAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;
export const PASSWORD_MIN = 6;
export const CHAT_MAX = 140;
export const MAX_PLAYERS_PER_ROOM = 8;

/** Shareable match codes look like `FRA:7K2Q`. */
export const ROOM_CODE_RE = /^[A-Z]{2,4}:[A-Z0-9]{4}$/;

/* ── The progression ladder ──────────────────────────────────────────────── */

/**
 * The level the Veteran skin unlocks at.
 *
 * The rule itself lives on that skin in weapons.js, which imports this file —
 * so the number is repeated here rather than imported back, and the client test
 * suite checks the two still agree.
 */
export const SKINS_VETERAN_LEVEL = 15;

/**
 * What a level is actually worth.
 *
 * Every gate in the game already knows its own threshold, and until now that
 * was the only place any of them were written down: a player who could not
 * type in the chat was told to reach level 2 at the moment they tried, and had
 * no way at all to find out that level 5 buys the report button. This is the
 * same set of numbers assembled into the one thing nobody could read anywhere —
 * the ladder itself — and the account panel draws exactly this list.
 *
 * The thresholds are passed in rather than read from the constants because an
 * operator may move them in .env; the server hands the panel its own values so
 * the ladder promises what this server will really do.
 *
 * @param {{chatLevel?:number, reportLevel?:number, clanJoinLevel?:number,
 *          clanCreateLevel?:number, clanCreateCost?:number, clansEnabled?:boolean,
 *          reportsEnabled?:boolean}} rules
 * @returns {Array<{level:number, title:string, desc:string}>} ascending by level
 */
export function progressionLadder(rules = {}) {
  const {
    chatLevel = CHAT_MIN_LEVEL,
    reportLevel = REPORT_MIN_LEVEL,
    clanJoinLevel = CLAN_JOIN_LEVEL,
    clanCreateLevel = CLAN_CREATE_LEVEL,
    clanCreateCost = CLAN_CREATE_COST,
    clansEnabled = true,
    reportsEnabled = true,
  } = rules;

  const steps = [
    {
      level: 1,
      title: 'EVERY CLASS, EVERY MAP',
      desc: 'Nothing that decides a fight is locked behind a level. All nine classes, '
        + 'every map and every mode are yours from your first match.',
    },
    {
      level: 1,
      title: 'WEAPON SKINS',
      desc: `Bought with ${CURRENCY}, which match score pays out at ${GR_PER_SCORE} points each. `
        + 'Skins are paint: none of them changes a weapon.',
    },
    {
      level: chatLevel,
      title: 'MATCH CHAT',
      desc: 'Write into the chat during a match. Everyone can read it from level 1 — '
        + 'this is the level that lets you answer.',
    },
    ...(reportsEnabled ? [{
      level: reportLevel,
      title: 'REPORT A PLAYER',
      desc: 'The REPORT button on the scoreboard, and the queue a moderator reads. '
        + 'You get the verdict back under ACCOUNT ▸ REPORTS.',
    }] : []),
    ...(clansEnabled ? [{
      level: clanJoinLevel,
      title: 'JOIN A CLAN',
      desc: 'Accept an invitation and wear the tag in front of your name on every '
        + 'scoreboard, killfeed and nametag in the game.',
    }] : []),
    {
      level: SKINS_VETERAN_LEVEL,
      title: 'VETERAN SKIN',
      desc: 'Earned, never sold: the Veteran finish unlocks on every weapon at once.',
    },
    ...(clansEnabled ? [{
      level: clanCreateLevel,
      title: 'FOUND A CLAN',
      desc: `Create your own tag and invite people into it. Founding one costs `
        + `${clanCreateCost} ${CURRENCY} on top of the level.`,
    }] : []),
  ];

  return steps.sort((a, b) => a.level - b.level);
}
