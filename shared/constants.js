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
export const PROTOCOL_VERSION = 9;
export const API_VERSION = 'v1';

/* ── Simulation ───────────────────────────────────────────────────────────── */

export const TICK_RATE = 60;                  // physics steps per second
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 30;              // state broadcasts per second
export const SNAPSHOT_DT = 1 / SNAPSHOT_RATE;
export const INTERP_DELAY = 0.10;             // remote-entity render lag (s)
export const MAX_LAG_COMP = 0.30;             // max rewind for hit validation (s)
export const MAX_INPUTS_PER_PACKET = 12;      // client input batching cap

/* ── Anti-cheat ───────────────────────────────────────────────────────────────
 *
 * Every number here answers one thing a client was previously allowed to say
 * about itself. The room believed all of them, and a userscript that only ever
 * changed what it *said* was enough to aim through walls, delete spread, rewind
 * a target a third of a second and run at three times everybody else's speed.
 *
 * The rule this file now enforces is the one the netcode was written under and
 * never checked: a packet may describe what a player did, never what the world
 * is. Angles are matched against the view the same client has been streaming,
 * the spread seed is the server's counter and not the client's pick, the rewind
 * comes off a round trip the server timed itself, and simulation steps are
 * spent out of a bucket that refills in real time.
 * ────────────────────────────────────────────────────────────────────────────*/

/**
 * How far a shot's claimed angles may sit from the view the client streamed.
 *
 * The client flushes its input batch immediately before the shoot packet on the
 * same ordered socket, so an honest shot arrives with its own view one or two
 * milliseconds old: the base tolerance only has to cover the mouse movement of
 * a single frame the tick loop had not sampled yet.
 */
export const AIM_TOLERANCE = 0.10;            // rad (~5.7°) at zero staleness
/** Extra tolerance per second of staleness, on top of the measured turn rate. */
export const AIM_TOLERANCE_RATE = 7.0;        // rad/s
/** How much of the client's own recent turn rate is forgiven while it flicks. */
export const AIM_TOLERANCE_TURN_MULT = 2.0;
/**
 * How stale the streamed view may be before the gate stops widening.
 *
 * Input and shoot travel the same ordered socket, and the room's clock only
 * moves on a tick, so an honest shot's view is either from this tick or the
 * last one. Three ticks is already generous; letting the gate keep opening past
 * that would hand a client a way to *buy* tolerance by going quiet for a moment
 * before firing, which is the exploit this whole check exists to close.
 */
export const AIM_VIEW_MAX_AGE = 0.05;         // s
/**
 * And the ceiling on the whole allowance, however fast the mouse is going.
 *
 * A hard flick at thirty radians a second covers 0.5 rad inside one tick, so
 * this never cuts into a real one. What it does cut into is every version of
 * shooting at something that is not in front of you.
 */
export const AIM_TOLERANCE_MAX = 0.60;        // rad (~34°)

/**
 * Simulation steps refill at exactly real time, with a small burst so a client
 * that lost a moment to a stall can catch up without being held back.
 *
 * A speed hack is nothing but spending more steps than the clock hands out, so
 * the ceiling on movement is the bucket rather than a speed check anywhere in
 * the physics.
 */
export const INPUT_BUDGET_BURST = 10;         // ticks of catch-up allowed
export const INPUT_BUDGET_START = 4;          // credit a fresh connection opens with
/**
 * How much faster than real time the bucket refills.
 *
 * Two machines never agree on how long a second is. A client whose clock runs a
 * tenth of a percent fast produces a tenth of a percent more ticks than the
 * server hands out, and over a long match that difference is the whole burst
 * reserve — so a bucket refilled at *exactly* the tick rate would eventually
 * flag every honest player with a slightly quick oscillator. Two percent is
 * two orders of magnitude more than real crystal drift, and a two percent
 * speed hack is not one.
 */
export const INPUT_BUDGET_SLACK = 0.02;

/** Server-measured round trip: a client's own claim is never read again. */
export const RTT_SAMPLES = 8;                 // median window
export const RTT_MAX = 1.0;                   // s — anything slower is a stall

/**
 * How long a body may go without a single meaningful input before the match
 * stops holding a seat for it.
 *
 * "Meaningful" is a key held or the view actually moving — a page left open
 * still streams sixty empty inputs a second, and an idle heartbeat is exactly
 * what an anti-AFK cheat sends. The warning lands first, and the fact that it
 * is the *player* who has to answer it is the whole point.
 */
export const AFK_WARN_SEC = 75;
export const AFK_KICK_SEC = 105;
/** Below this the view has not moved; it is mouse noise or a stuck axis. */
export const AFK_VIEW_EPSILON = 0.004;        // rad

/** What the anti-cheat calls each thing it catches. */
export const CHEAT_KINDS = [
  'aim',        // shot angles that do not match the streamed view
  'seq',        // a spread seed picked rather than taken
  'speed',      // more simulation steps asked for than the clock allows
  'rate',       // packets faster than the client that sends them can produce
  'lag',        // a claimed round trip the server never measured
  'ads',        // a sight picture claimed in a packet rather than held
  'spread',     // shots that land far closer to centre than the cone allows
];

/**
 * What a caught client costs itself.
 *
 * Weight is per incident; the running total decays so an unlucky frame on a bad
 * connection is never the same thing as a suite of them every second. Crossing
 * `CHEAT_KICK_SCORE` drops the connection and files a report the moderators
 * read next to the human ones, which is the only outcome that survives the
 * player simply reconnecting.
 */
export const CHEAT_WEIGHTS = {
  aim: 12, seq: 6, speed: 4, rate: 3, lag: 8, ads: 2, spread: 10,
};
export const CHEAT_DECAY_PER_SEC = 0.6;       // points shed per second of clean play
export const CHEAT_WARN_SCORE = 40;
export const CHEAT_KICK_SCORE = 120;
/** Below this many incidents nothing is ever acted on, whatever the score. */
export const CHEAT_MIN_INCIDENTS = 4;

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
/** Free-flight speed for an admin in god mode — brisk enough to cross a map. */
export const FLY_SPEED = 24;
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

/**
 * The floor god mode puts under every wait between two shots: the fire rate,
 * the bolt, the draw left over from a swap and the knife's swing.
 *
 * No wait at all means one round per rendered frame, which is a weapon nobody
 * asked for on a 240 Hz display, an input stream the packet-rate guard would
 * flag as a speedhack, and a tracer broadcast to the room two hundred times a
 * second. Twenty a second is quicker than anyone clicks and quicker than
 * anything in the game fires, so the trigger is the only limit left.
 *
 * A floor and never a ceiling: a weapon already faster than this keeps its own
 * rate rather than being slowed down to it.
 */
export const GOD_SHOT_INTERVAL = 0.05;

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
 * How much a level costs.
 *
 * Two terms. The first is the whole curve up to `LEVEL_RAMP_FROM` and keeps the
 * bottom of the ladder reachable: level 2 is one short match, and the gates
 * that live down there — chat at 2, the report button and a clan at 5 — are
 * still a first sitting away, because that is where people decide whether to
 * come back at all. The second takes over above it and grows much faster than
 * the first, so every level up the ladder costs meaningfully more than the one
 * under it.
 *
 * The whole thing was lifted in v1.6 because it was being cleared far too fast.
 * A match pays its own score back as XP — one to one, see `xpFromScore` — and a
 * decent four-minute round is a couple of thousand points, which put level 10
 * inside two matches and level 50 inside a hundred. A level nobody had to work
 * for is a number, not an achievement. The figures below put level 10 at about
 * an evening, level 30 at a few weeks and level 50 well beyond that, and they
 * do it by making levels dearer rather than by paying matches less — the number
 * on the end card is still exactly the number that was on the scoreboard.
 *
 * Existing accounts never lose a level to this: `regradeLevels` in the database
 * layer tops their XP up to whatever the level they already hold now costs.
 */
export const LEVEL_RAMP_FROM = 10;
export const LEVEL_BASE_COST = 260;
export const LEVEL_BASE_POWER = 1.75;
export const LEVEL_RAMP_COST = 46;
export const LEVEL_RAMP_POWER = 2.75;

/** Total XP required to reach `level`. Soft to LEVEL_RAMP_FROM, steep after it. */
export const xpForLevel = (level) => {
  const l = Math.max(1, Math.min(MAX_LEVEL + 1, Math.floor(level)));
  const over = l - LEVEL_RAMP_FROM;
  return Math.floor(LEVEL_BASE_COST * (l - 1) ** LEVEL_BASE_POWER
    + (over > 0 ? LEVEL_RAMP_COST * over ** LEVEL_RAMP_POWER : 0));
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
 *
 * Both figures went up with the v1.6 ladder. Levels arrive maybe a third as
 * often as they used to, so each one has to be worth roughly three times as
 * much or the whole ladder quietly becomes a worse way to earn than playing.
 */
export const levelUpReward = (level) => {
  const l = Math.max(2, Math.floor(level));
  return { gr: Math.min(1800, 90 + (l - 1) * 34) };
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

/* ── Weekly challenges ────────────────────────────────────────────────────── */

/**
 * Three a week, on top of the three a day.
 *
 * Dailies are a reason to play tonight; they are worth an evening and they are
 * gone tomorrow whether or not anybody finished them. That makes them useless
 * to the player who gets two evenings a week — the goal resets before they can
 * reach it, so there is never anything to come back *to*.
 *
 * A week is the unit that fixes it. The goals below are deliberately out of
 * reach of a single sitting: they are what a Tuesday session and a Saturday
 * session add up to, and progress on them survives in between.
 */
export const WEEKLY_POOL = [
  { id: 'w.kills200',   stat: 'kills',      goal: 200,   xp: 4000,  gr: 320, name: 'Standing Army',    desc: 'Get 200 kills this week' },
  { id: 'w.kills500',   stat: 'kills',      goal: 500,   xp: 9000,  gr: 700, name: 'War of Attrition', desc: 'Get 500 kills this week' },
  { id: 'w.heads100',   stat: 'headshots',  goal: 100,   xp: 5000,  gr: 400, name: 'Cold Eye',         desc: 'Land 100 headshots this week' },
  { id: 'w.wins15',     stat: 'wins',       goal: 15,    xp: 5500,  gr: 450, name: 'Season Form',      desc: 'Win 15 matches this week' },
  { id: 'w.score30k',   stat: 'score',      goal: 30000, xp: 5000,  gr: 400, name: 'Six Figures Soon', desc: 'Earn 30,000 match points this week' },
  { id: 'w.matches40',  stat: 'matches',    goal: 40,    xp: 3500,  gr: 280, name: 'Clocked In',       desc: 'Finish 40 matches this week' },
  { id: 'w.damage50k',  stat: 'damage',     goal: 50000, xp: 4500,  gr: 360, name: 'Sustained Fire',   desc: 'Deal 50,000 damage this week' },
  { id: 'w.assists60',  stat: 'assists',    goal: 60,    xp: 3500,  gr: 280, name: 'Second Pair',      desc: 'Get 60 assists this week' },
  { id: 'w.midairs25',  stat: 'midairs',    goal: 25,    xp: 4500,  gr: 380, name: 'Clay Pigeon',      desc: 'Kill 25 airborne enemies this week' },
  { id: 'w.melees30',   stat: 'melees',     goal: 30,    xp: 4000,  gr: 340, name: 'Knife Work',       desc: 'Get 30 melee kills this week' },
  { id: 'w.longshot25', stat: 'longshots',  goal: 25,    xp: 4500,  gr: 380, name: 'Across The Map',   desc: 'Land 25 longshot kills this week' },
  { id: 'w.drifts30',   stat: 'drifts',     goal: 30,    xp: 4000,  gr: 340, name: 'Kept Moving',      desc: 'Kill 30 enemies while sliding this week' },
];

export const WEEKLIES_PER_WEEK = 3;

/**
 * UTC week number, rolling over on Monday.
 *
 * Day 0 of the epoch was a Thursday, and Monday is three days short of the next
 * one — so +3 is what puts the boundary at Monday morning rather than in the
 * middle of a weekend, which is when the week starts for everybody who is not a
 * computer and, more to the point, when a weekend's worth of progress would be
 * most annoying to lose.
 */
export const weekIndex = (ms = Date.now()) => Math.floor((dayIndex(ms) + 3) / 7);

/** Deterministic weekly pick, so everybody is chasing the same three. */
export function weeklyChallenges(week) {
  const out = [];
  let h = (week * 0x9e3779b1) >>> 0;
  const used = new Set();
  while (out.length < WEEKLIES_PER_WEEK && used.size < WEEKLY_POOL.length) {
    h = (Math.imul(h ^ (h >>> 15), 0x2545f491) + 0x85ebca6b) >>> 0;
    const i = h % WEEKLY_POOL.length;
    if (used.has(i)) continue;
    used.add(i);
    out.push(WEEKLY_POOL[i]);
  }
  return out;
}

/**
 * Where a weekly's progress is filed.
 *
 * Both kinds of challenge share one table, keyed by a period number. Dailies
 * use the day index — currently around twenty thousand — and weeklies are
 * pushed above a million so the two can never collide and, more importantly, so
 * the daily cleanup (which deletes everything below the last few days) cannot
 * sweep away a week that is still running.
 */
export const WEEKLY_PERIOD_BASE = 1_000_000;
export const weeklyPeriod = (week) => WEEKLY_PERIOD_BASE + week;

/* ── Career milestones ────────────────────────────────────────────────────── */

/**
 * The long game.
 *
 * Everything else this game pays out is measured in evenings: a daily resets
 * overnight, a weekly resets on Monday, a level arrives and is spent. None of
 * it gives an account a reason to still be here in three months, because none
 * of it accumulates into anything a player can point at.
 *
 * These do. Each one is a threshold on a lifetime counter that only ever goes
 * up, each pays once, and the set is deliberately front-loaded — the first rung
 * of every track is inside a first evening, so a new account collects two or
 * three of them immediately and learns that the list is worth reading. The top
 * rungs are years of play and are meant to be.
 *
 * `stat` names a column on the account's lifetime stats row.
 */
export const MILESTONES = [
  // Kills — the spine of the list.
  { id: 'k.100',    stat: 'kills',      goal: 100,     name: 'Blooded',        desc: '100 kills',                 gr: 100,  xp: 600 },
  { id: 'k.500',    stat: 'kills',      goal: 500,     name: 'Regular',        desc: '500 kills',                 gr: 250,  xp: 1800 },
  { id: 'k.2500',   stat: 'kills',      goal: 2500,    name: 'Hardened',       desc: '2,500 kills',               gr: 700,  xp: 6000 },
  { id: 'k.10000',  stat: 'kills',      goal: 10000,   name: 'Career Soldier', desc: '10,000 kills',              gr: 2000, xp: 20000 },
  { id: 'k.25000',  stat: 'kills',      goal: 25000,   name: 'Institution',    desc: '25,000 kills',              gr: 5000, xp: 55000 },
  // Wins.
  { id: 'w.10',     stat: 'wins',       goal: 10,      name: 'Winner',         desc: 'Win 10 matches',            gr: 120,  xp: 700 },
  { id: 'w.100',    stat: 'wins',       goal: 100,     name: 'Habitual',       desc: 'Win 100 matches',           gr: 600,  xp: 5000 },
  { id: 'w.500',    stat: 'wins',       goal: 500,     name: 'Dynasty',        desc: 'Win 500 matches',           gr: 2400, xp: 24000 },
  // Precision.
  { id: 'h.100',    stat: 'headshots',  goal: 100,     name: 'Steady Hand',    desc: '100 headshots',             gr: 150,  xp: 900 },
  { id: 'h.1000',   stat: 'headshots',  goal: 1000,    name: 'Marksman',       desc: '1,000 headshots',           gr: 800,  xp: 7000 },
  { id: 'h.5000',   stat: 'headshots',  goal: 5000,    name: 'Surgeon',        desc: '5,000 headshots',           gr: 3000, xp: 30000 },
  // Turning up.
  { id: 'm.25',     stat: 'matches',    goal: 25,      name: 'Signed On',      desc: 'Finish 25 matches',         gr: 80,   xp: 500 },
  { id: 'm.250',    stat: 'matches',    goal: 250,     name: 'Fixture',        desc: 'Finish 250 matches',        gr: 500,  xp: 4200 },
  { id: 'm.1000',   stat: 'matches',    goal: 1000,    name: 'Landmark',       desc: 'Finish 1,000 matches',      gr: 2200, xp: 22000 },
  // One very good round.
  { id: 's.10',     stat: 'bestStreak', goal: 10,      name: 'On A Tear',      desc: 'Reach a 10 killstreak',     gr: 200,  xp: 1200 },
  { id: 's.15',     stat: 'bestStreak', goal: 15,      name: 'Unanswered',     desc: 'Reach a 15 killstreak',     gr: 500,  xp: 3500 },
  { id: 's.25',     stat: 'bestStreak', goal: 25,      name: 'Untouchable',    desc: 'Reach a 25 killstreak',     gr: 1500, xp: 12000 },
  // Damage, and hours.
  { id: 'd.100k',   stat: 'damage',     goal: 100000,  name: 'Heavy Weather',  desc: 'Deal 100,000 damage',       gr: 300,  xp: 2200 },
  { id: 'd.1m',     stat: 'damage',     goal: 1000000, name: 'Artillery',      desc: 'Deal 1,000,000 damage',     gr: 1800, xp: 18000 },
  { id: 't.10h',    stat: 'playtime',   goal: 36000,   name: 'Ten Hours In',   desc: 'Play for 10 hours',         gr: 250,  xp: 1600 },
  { id: 't.100h',   stat: 'playtime',   goal: 360000,  name: 'A Hundred Hours', desc: 'Play for 100 hours',       gr: 1600, xp: 16000 },
];

/** How a milestone's target reads: hours for playtime, a plain figure otherwise. */
export const milestoneProgressText = (m, value) => (m.stat === 'playtime'
  ? `${Math.floor((value ?? 0) / 3600)} / ${Math.floor(m.goal / 3600)} h`
  : `${Math.min(value ?? 0, m.goal).toLocaleString('en-GB')} / ${m.goal.toLocaleString('en-GB')}`);

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

/**
 * The two piles a moderator actually works in.
 *
 * `open` is the to-do list; `handled` is everything that has been settled,
 * whichever way it went. They are a filter rather than a state — a row is still
 * stored as one of REPORT_STATUSES — but they are the split the panel is built
 * around, because "has anybody dealt with this" is the only question being
 * asked when the queue is opened.
 */
export const REPORT_QUEUES = {
  open: { label: 'OPEN', note: 'Nobody has settled these yet.' },
  handled: { label: 'HANDLED', note: 'Settled, and kept — this is the history behind a name.' },
};
export const REPORT_QUEUE_IDS = Object.keys(REPORT_QUEUES);

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

/* ── Friends ──────────────────────────────────────────────────────────────────
 *
 * A friend list is a small thing that becomes a nuisance vector the moment it
 * is unbounded, so each ceiling here answers one way of turning it into one:
 * a list nobody can fill, a request queue nobody can flood, and a name that
 * cannot be asked twice in a row.
 * ────────────────────────────────────────────────────────────────────────────*/

/** Friends one account may hold. */
export const FRIENDS_MAX = 100;
/** Requests one account may have outstanding, so the button is not a megaphone. */
export const FRIEND_REQUESTS_MAX = 40;
/** And how many may be waiting for one account to answer. */
export const FRIEND_REQUESTS_INBOX_MAX = 60;
/** Seconds between two requests from the same account. */
export const FRIEND_REQUEST_COOLDOWN_SEC = 5;
/**
 * Level needed to send one.
 *
 * The same reasoning as the report button: a fresh throwaway account costs
 * nothing to make, and an invitation from one is spam with a nickname on it.
 */
export const FRIEND_MIN_LEVEL = 2;

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

/* ── Profile cards ────────────────────────────────────────────────────────────
 *
 * The card is what a nickname means: click one anywhere in the game — a
 * scoreboard row, the killfeed, a leaderboard entry — and this is what opens.
 * Everything below is the part of it the account owns rather than the part the
 * match writes, so it is stored as one small JSON blob on the user row and
 * travels with every public profile.
 *
 * The catalogues are shared rather than living in the client because the server
 * is what refuses an unknown one: a card is drawn inside other people's
 * screens, so "any string the browser felt like sending" is a styling hole with
 * an audience.
 * ────────────────────────────────────────────────────────────────────────────*/

/** Backdrop patterns a card may wear, drawn in CSS from the accent colour. */
export const CARD_PATTERNS = [
  { id: 'none', name: 'Clean' },
  { id: 'grid', name: 'Grid' },
  { id: 'scan', name: 'Scanlines' },
  { id: 'hex', name: 'Hexes' },
  { id: 'rays', name: 'Rays' },
  { id: 'topo', name: 'Topography' },
  { id: 'circuit', name: 'Circuit' },
  { id: 'noise', name: 'Static' },
  { id: 'diag', name: 'Hazard' },
  { id: 'dots', name: 'Halftone' },
  { id: 'camo', name: 'Camo' },
  { id: 'bokeh', name: 'Bokeh' },
];
export const CARD_PATTERN_IDS = CARD_PATTERNS.map((p) => p.id);

/** How hard the accent is pushed into the card's own background. */
export const CARD_INTENSITIES = ['subtle', 'medium', 'loud'];

/** Where the accent comes from: the profile picture, or a colour they picked. */
export const CARD_ACCENT_MODES = ['auto', 'custom'];

/**
 * Frames the avatar can wear. Purely decorative, and deliberately not something
 * that has to be unlocked — a card nobody can style is a card nobody opens.
 */
export const CARD_FRAMES = [
  { id: 'ring', name: 'Ring' },
  { id: 'none', name: 'None' },
  { id: 'glow', name: 'Halo' },
  { id: 'hex', name: 'Hex cut' },
  { id: 'square', name: 'Squared' },
  { id: 'dashed', name: 'Dashed' },
];
export const CARD_FRAME_IDS = CARD_FRAMES.map((f) => f.id);

/** Card layouts — how much of the card the hero band takes. */
export const CARD_LAYOUTS = [
  { id: 'classic', name: 'Classic', note: 'Hero band, career grid, recent matches' },
  { id: 'showcase', name: 'Showcase', note: 'A taller hero with the picture large' },
  { id: 'compact', name: 'Compact', note: 'One column, less chrome' },
];
export const CARD_LAYOUT_IDS = CARD_LAYOUTS.map((l) => l.id);

/**
 * Statistics a player may pin to the hero band.
 *
 * Everything here is already on the card; pinning only decides which three are
 * the big ones. Keyed by the names `stats` already uses on the wire.
 */
export const CARD_STATS = [
  { id: 'kd', name: 'K/D' },
  { id: 'kills', name: 'Kills' },
  { id: 'wins', name: 'Wins' },
  { id: 'score', name: 'Score' },
  { id: 'headshots', name: 'Headshots' },
  { id: 'accuracy', name: 'Accuracy' },
  { id: 'damage', name: 'Damage' },
  { id: 'matches', name: 'Matches' },
  { id: 'bestStreak', name: 'Best streak' },
  { id: 'assists', name: 'Assists' },
  { id: 'deaths', name: 'Deaths' },
  { id: 'playtime', name: 'Playtime' },
  { id: 'level', name: 'Level' },
  { id: 'streak', name: 'Day streak' },
];
export const CARD_STAT_IDS = CARD_STATS.map((s) => s.id);

/** How many of them fit in the band. */
export const CARD_FEATURED_MAX = 3;

/** Room a player has to say something about themselves. */
export const CARD_TITLE_MAX = 32;
export const CARD_BIO_MAX = 160;

/** A card as it is stored when nobody has touched it. */
export const CARD_DEFAULTS = {
  accentMode: 'auto',
  accent: '#f5a623',
  pattern: 'grid',
  intensity: 'medium',
  frame: 'ring',
  layout: 'classic',
  glow: true,
  title: '',
  bio: '',
  featured: ['kd', 'kills', 'wins'],
};

const CARD_HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * One free-text line, as it is allowed to be stored.
 *
 * Control characters, newlines and the invisible direction marks are collapsed
 * to spaces rather than rejected: a title is one line by construction, and this
 * string is drawn on other people's screens, so its shape is not something to
 * take on trust. Length is the last step, so a padded string cannot smuggle
 * characters past the cap.
 */
export const cleanCardText = (raw, max) => String(raw ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

/**
 * Sanitises a card blob into something safe to store and to draw.
 *
 * Never throws and never rejects: anything unrecognised falls back to the
 * default, so a card written by a newer client — or by somebody poking the
 * route by hand — degrades to a plain one rather than breaking every scoreboard
 * that draws its owner's name.
 */
export function normaliseCard(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
  const featured = Array.isArray(src.featured)
    ? [...new Set(src.featured.filter((id) => CARD_STAT_IDS.includes(id)))].slice(0, CARD_FEATURED_MAX)
    : [];
  return {
    accentMode: pick(src.accentMode, CARD_ACCENT_MODES, CARD_DEFAULTS.accentMode),
    accent: CARD_HEX_RE.test(src.accent ?? '') ? String(src.accent).toLowerCase() : CARD_DEFAULTS.accent,
    pattern: pick(src.pattern, CARD_PATTERN_IDS, CARD_DEFAULTS.pattern),
    intensity: pick(src.intensity, CARD_INTENSITIES, CARD_DEFAULTS.intensity),
    frame: pick(src.frame, CARD_FRAME_IDS, CARD_DEFAULTS.frame),
    layout: pick(src.layout, CARD_LAYOUT_IDS, CARD_DEFAULTS.layout),
    glow: src.glow !== false,
    title: cleanCardText(src.title, CARD_TITLE_MAX),
    bio: cleanCardText(src.bio, CARD_BIO_MAX),
    featured: featured.length ? featured : [...CARD_DEFAULTS.featured],
  };
}

/* ── Social privacy ───────────────────────────────────────────────────────────
 *
 * Every one of these answers "who is this for", and the answer is enforced on
 * the server: the card route leaves out what a viewer may not see rather than
 * sending it with a flag the client is trusted to honour.
 *
 * `friends` means "people already on my list", which is why none of these can
 * lock an account out of being added in the first place — that is `whoCanAdd`,
 * and it has its own three answers.
 * ────────────────────────────────────────────────────────────────────────────*/

/** The audience scale used by every visibility switch below. */
export const PRIVACY_AUDIENCES = ['everyone', 'friends', 'nobody'];

/** Who may send a friend request. */
export const PRIVACY_ADD_MODES = ['everyone', 'mutuals', 'nobody'];

export const PRIVACY_DEFAULTS = {
  /** everyone · mutuals (someone a friend is already friends with) · nobody */
  whoCanAdd: 'everyone',
  /** Whether "online" and "in a match" show on the card at all. */
  showPresence: 'friends',
  /** Whether the card offers a button that drops the viewer into your match. */
  allowJoin: 'friends',
  showStats: 'everyone',
  showMatches: 'everyone',
  showStreak: 'everyone',
  showClan: 'everyone',
  showJoined: 'everyone',
  /** Off takes the account off the public leaderboard. Stats still count. */
  listed: true,
};

/** Each switch, with the sentence the settings panel puts under it. */
export const PRIVACY_FIELDS = [
  {
    id: 'whoCanAdd',
    name: 'Who can add me',
    note: 'Who is allowed to send you a friend request.',
    options: PRIVACY_ADD_MODES,
    labels: { everyone: 'Anyone', mutuals: 'Friends of friends', nobody: 'No one' },
  },
  {
    id: 'showPresence',
    name: 'Show when I am online',
    note: 'Whether your card says you are in the menu or in a match.',
    options: PRIVACY_AUDIENCES,
  },
  {
    id: 'allowJoin',
    name: 'Let people join my match',
    note: 'Puts a JOIN button on your card while you are playing.',
    options: PRIVACY_AUDIENCES,
  },
  {
    id: 'showStats',
    name: 'Show my career stats',
    note: 'Kills, K/D, accuracy, damage, playtime.',
    options: PRIVACY_AUDIENCES,
  },
  {
    id: 'showMatches',
    name: 'Show my recent matches',
    note: 'The last few games on your card.',
    options: PRIVACY_AUDIENCES,
  },
  {
    id: 'showStreak',
    name: 'Show my day streak',
    note: 'How many days in a row you have played.',
    options: PRIVACY_AUDIENCES,
  },
  {
    id: 'showClan',
    name: 'Show my clan',
    note: 'The tag beside your name stays either way — this is the card.',
    options: PRIVACY_AUDIENCES,
  },
  {
    id: 'showJoined',
    name: 'Show when I joined',
    note: 'The date this account was created.',
    options: PRIVACY_AUDIENCES,
  },
];

/** What each audience value reads as in the panel. */
export const PRIVACY_AUDIENCE_LABELS = {
  everyone: 'Everyone', friends: 'Friends only', nobody: 'No one',
};

/** Sanitises a privacy blob. Same contract as normaliseCard: never throws. */
export function normalisePrivacy(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = { ...PRIVACY_DEFAULTS };
  for (const field of PRIVACY_FIELDS) {
    if (field.options.includes(src[field.id])) out[field.id] = src[field.id];
  }
  out.listed = src.listed !== false;
  return out;
}

/**
 * Whether a viewer may see something its owner set to `audience`.
 *
 * `relation` is what the server worked out about the two accounts — 'self',
 * 'friend' or 'none' — so this is the single rule and every route asks it
 * rather than re-deriving one. Your own card always shows you everything.
 */
export function canSee(audience, relation) {
  if (relation === 'self') return true;
  if (audience === 'nobody') return false;
  if (audience === 'friends') return relation === 'friend';
  return true;
}


/* ── The kill cam ─────────────────────────────────────────────────────────────
 *
 * Ten seconds looking at whoever just killed you, skippable after three.
 *
 * The three is not a compromise between the ten and impatience — it is the
 * whole shape of the thing. A death screen you cannot leave is a punishment,
 * and one you can leave instantly is one nobody ever sees. Three seconds is
 * long enough that the cam has said what it came to say — who, with what, from
 * how far, and on how much health — and short enough that a player in a hurry
 * is never really held.
 *
 * None of this is a server rule. The room's respawn timer is unchanged at
 * RESPAWN_TIME; the cam simply does not ask for a spawn while it is running, in
 * exactly the way the pause menu and the open scoreboard already do not. A
 * client that skipped the cam entirely would still respawn at RESPAWN_TIME and
 * be no better off than one that pressed the button — which is the correct
 * amount of power for a client to have over its own camera.
 * ────────────────────────────────────────────────────────────────────────────*/

export const KILLCAM_SECONDS = 10;
export const KILLCAM_SKIP_AFTER = 3;
/** How far past the ten a video creator may hold the shot. */
export const KILLCAM_DIRECTOR_SECONDS = 30;

/* ── Player anthems ───────────────────────────────────────────────────────────
 *
 * Ten seconds a music creator uploads, played to whoever they just killed.
 *
 * The design question here is one sentence long: *somebody will upload a
 * scream*. Everything below is the answer, and the answer is that loudness is
 * not something the uploader gets to decide. The server measures what it was
 * sent and rewrites the samples to a fixed loudness before a byte is stored —
 * see server/util/audio.js — and the client then plays every anthem through one
 * limited bus at the listener's own volume, so a file that somehow got past the
 * first rule still cannot get past the second.
 *
 * The format is deliberately the dullest one there is. A server with no audio
 * library cannot decode an MP3, and a server that cannot decode what it stores
 * cannot measure it. So the browser — which has a full decoder built in —
 * decodes, and what it uploads is plain PCM the server can read with a `for`
 * loop. That is the same trade util/image.js makes for pictures, for the same
 * reason: the magic bytes are the fact, and nothing else is.
 * ────────────────────────────────────────────────────────────────────────────*/

/** Length of an anthem. The kill cam is ten seconds, so an anthem is too. */
export const ANTHEM_MAX_SECONDS = KILLCAM_SECONDS;
/** Under this there is nothing to play: a click is not a track. */
export const ANTHEM_MIN_SECONDS = 1;
/** Mono, because it is a sting on a death screen and not an album. */
export const ANTHEM_CHANNELS = 1;
/** 16 kHz of bandwidth: a stinger's worth, at a third of a CD's size. */
export const ANTHEM_SAMPLE_RATE = 32000;
/** Signed 16-bit PCM — the one encoding every browser both writes and reads. */
export const ANTHEM_BITS = 16;

/**
 * Hard ceiling on the stored file.
 *
 * Ten seconds of mono 32 kHz 16-bit PCM is 640 KB, plus a 44-byte header. The
 * slack is for a file that rounds up, never for a longer one: duration comes
 * from the header, and is never inferred from the size.
 */
export const ANTHEM_MAX_BYTES = 704 * 1024;

/** Biggest file the picker will even open, before it decodes and re-encodes. */
export const ANTHEM_SOURCE_MAX_BYTES = 24 * 1024 * 1024;

/** Room for the track's name, credited under the killer's on the cam. */
export const ANTHEM_TITLE_MAX = 48;

/**
 * The loudness every stored anthem is rewritten to.
 *
 * Two numbers doing different jobs. The RMS target is what a track is
 * *levelled* to, so a whisper and a wall of distortion arrive at the same
 * perceived volume. The peak ceiling is what stops that levelling from clipping
 * anything on the way up. The gain applied is whichever of the two asks for
 * less, which is why a brickwalled troll upload comes out quieter than it went
 * in and a quiet piano comes out louder.
 */
export const ANTHEM_TARGET_RMS_DB = -19;
export const ANTHEM_PEAK_CEILING_DB = -1.5;

/**
 * The window the RMS is measured over, and why it is a window at all.
 *
 * Averaged across a whole file, "nine seconds of silence and one air horn"
 * measures as a quiet track and gets turned *up*. Measured as the loudest
 * 400 ms in it, it measures as an air horn. Loudness is a short-term quantity,
 * and the trick only ever worked against the long-term one.
 */
export const ANTHEM_WINDOW_MS = 400;
export const ANTHEM_HOP_MS = 100;

/** Anything quieter than this across its whole length is silence, not a track. */
export const ANTHEM_SILENCE_DB = -60;

/** Milliseconds of ramp welded onto both ends, so no anthem starts on a click. */
export const ANTHEM_FADE_MS = 25;

/* ── Developer mode ───────────────────────────────────────────────────────────
 *
 * Instruments, not powers. Everything here reads something the client already
 * has and draws it; nothing asks the server for anything, and nothing shows a
 * player one fact about anybody else that their own screen was not already
 * about to tell them.
 *
 * That line is the whole design constraint, and it is why there is no enemy
 * hitbox overlay in this list. "Draw a box around every player" is a debugging
 * tool right up until the boxes are visible through a wall, at which point it
 * is a wallhack that shipped with the game — so the reconciliation trace is of
 * the local player's own body, and the collision overlay is of the map, which
 * is static data every client already downloaded.
 *
 * The level gate is the second half of the same thought: a panel this dense is
 * a way to have a much worse first ten minutes, so it is not on the table until
 * somebody has had a good ten hours instead.
 * ────────────────────────────────────────────────────────────────────────────*/

export const DEV_MODE_LEVEL = 10;

/**
 * The panels, in the order they stack down the side of the screen.
 *
 * `pro` marks the three a code creator gets and the level gate does not open —
 * not because they are dangerous, but because they are unreadable without
 * already knowing what they are readings of.
 */
export const DEV_PANELS = [
  {
    id: 'perf',
    name: 'Performance',
    note: "Frame time, the renderer's own counters, and what the heap is doing.",
  },
  {
    id: 'net',
    name: 'Network',
    note: 'Round trip, jitter, packet and byte rates, and how deep the snapshot buffer is.',
  },
  {
    id: 'state',
    name: 'Player state',
    note: 'Position, velocity, the ground under you, and what the movement code thinks you are doing.',
  },
  {
    id: 'render',
    name: 'Render toggles',
    note: "Wireframe, post-processing, the map's collision volumes, and a frozen frustum.",
  },
  {
    id: 'wire',
    name: 'Wire inspector',
    pro: true,
    note: 'Every opcode the socket carries, counted and rated, newest first.',
  },
  {
    id: 'recon',
    name: 'Reconciliation',
    pro: true,
    note: "Your own prediction against the server's correction, tick by tick.",
  },
  {
    id: 'frames',
    name: 'Frame histogram',
    pro: true,
    note: 'Where the long frames are, as a distribution rather than an average.',
  },
];

export const DEV_PANEL_IDS = DEV_PANELS.map((p) => p.id);
/** The three that need a code creator behind them. */
export const DEV_PRO_PANEL_IDS = DEV_PANELS.filter((p) => p.pro).map((p) => p.id);

/* ── Creators ─────────────────────────────────────────────────────────────────
 *
 * A creator is a player the people running a server have looked at and said yes
 * to. It is not a rank, it buys nothing that decides a fight, and it cannot be
 * earned by playing — which is exactly what makes it worth having. Everything
 * else in this file is a number that goes up on its own; this is the one status
 * with a human reading something somebody made behind it.
 *
 * Four disciplines, and each gets a perk built out of what that discipline
 * actually produces rather than a badge in a different colour. A musician's
 * work is heard, so theirs is heard. An artist's is seen, so theirs is a skin.
 * Someone who films the game gets the camera; someone who writes code gets the
 * instruments. The badge and the links are what all four share, and they are
 * the part really being asked for: a way to say "this is mine" on a card other
 * people already open.
 *
 * The catalogue is shared rather than living in the client for the same reason
 * every other catalogue here is — the server is what refuses an unknown kind, a
 * perk that kind was never granted, or a link to somewhere nobody vetted, and
 * it cannot do any of that from a list only the browser has.
 * ────────────────────────────────────────────────────────────────────────────*/

/** The level an account has to reach before it may even apply. */
export const CREATOR_MIN_LEVEL = 5;

/**
 * The four disciplines, and what each is handed on approval.
 *
 * `perks` is prose for the panel. `grants` is the machine-readable half every
 * gate in the game actually asks — `creatorCan(creator, 'anthem')` is the one
 * question, asked in one place, and a kind that does not list a grant cannot
 * reach the route behind it however the request is shaped.
 */
export const CREATOR_KINDS = [
  {
    id: 'music',
    name: 'Music',
    icon: 'note',
    blurb: 'Composers, sound designers, anyone who writes the thing you hear.',
    grants: ['anthem'],
    perks: [
      `A player anthem: up to ${ANTHEM_MAX_SECONDS} seconds of your own music, played over the `
      + 'kill cam of everyone you kill. Levelled by the server on the way in, so nobody can be '
      + 'shouted at.',
      'Your track title, credited under your name on the cam that plays it.',
    ],
  },
  {
    id: 'art',
    name: 'Art',
    icon: 'palette',
    blurb: 'Illustrators, modellers, texture artists — anyone who makes it look like something.',
    grants: ['skinRequest', 'frame'],
    perks: [
      'Commission your own finish: brief it, pick the palette, link the reference, and it goes '
      + 'into a queue a human reads and answers.',
      'The engraved card frame, which is not for sale and never will be.',
    ],
  },
  {
    id: 'video',
    name: 'Video',
    icon: 'film',
    blurb: 'Editors, streamers, anyone whose output is footage of this game.',
    grants: ['director'],
    perks: [
      "The director's cut kill cam: letterboxed, interface-free, orbiting, and yours to hold "
      + `for ${KILLCAM_DIRECTOR_SECONDS} seconds instead of ${KILLCAM_SECONDS}.`,
      'A clean-screen key that strips the HUD for a shot, mid-match, without touching settings.',
    ],
  },
  {
    id: 'code',
    name: 'Code',
    icon: 'terminal',
    blurb: 'Anyone who has sent a patch, written a tool, or run a server of their own.',
    grants: ['devPro'],
    perks: [
      `Developer mode with no level gate — it is level ${DEV_MODE_LEVEL} for everyone else.`,
      'The instruments that gate does not open: the wire inspector, the reconciliation trace '
      + 'and the frame-time histogram.',
    ],
  },
];

export const CREATOR_KIND_IDS = CREATOR_KINDS.map((k) => k.id);

/** One kind by id, or null. */
export const getCreatorKind = (id) => CREATOR_KINDS.find((k) => k.id === id) ?? null;

/** Where an application can be in its life. */
export const CREATOR_STATUSES = ['pending', 'approved', 'rejected', 'revoked'];

/**
 * May this creator do this thing?
 *
 * The single gate. Every route, every panel and every draw call asks this
 * rather than testing `kind === 'music'` in fourteen places, which is what makes
 * adding a fifth discipline a line in the catalogue above rather than a search
 * for everywhere the fourth was spelled out.
 *
 * The status is checked here and not by the caller, so the one thing nobody may
 * ever forget — that a *pending* application grants absolutely nothing — cannot
 * be forgotten anywhere.
 *
 * @param {{kind?:string, status?:string}|null|undefined} creator
 * @param {string} grant
 */
export function creatorCan(creator, grant) {
  if (!creator || creator.status !== 'approved') return false;
  return !!getCreatorKind(creator.kind)?.grants.includes(grant);
}

/** Room for the applicant to say what they make and where it lives. */
export const CREATOR_PITCH_MIN = 40;
export const CREATOR_PITCH_MAX = 700;
/** The one line a decision comes back with, which the applicant reads. */
export const CREATOR_VERDICT_MAX = 240;

/**
 * How long a rejected application waits before it may be sent again.
 *
 * Long enough that "apply again immediately" is not the reflex, short enough
 * that somebody who was told *what* to fix can go and fix it. A withdrawn
 * application waits no time at all — nobody read it.
 */
export const CREATOR_REAPPLY_DAYS = 14;

/**
 * May this account apply right now, and if not, why not?
 *
 * Shared so the panel can grey the button out for exactly the reason the route
 * would have refused the request. The route still decides.
 *
 * @param {{level?:number, emailVerified?:boolean}|null} account
 * @param {{status?:string, decidedAt?:number}|null} creator existing application
 * @param {{minLevel?:number, needEmail?:boolean, now?:number}} rules
 * @returns {{can:boolean, why:string|null, retryAt:number}}
 */
export function creatorApplyState(account, creator, rules = {}) {
  const { minLevel = CREATOR_MIN_LEVEL, needEmail = false, now = Math.floor(Date.now() / 1000) } = rules;
  const no = (why, retryAt = 0) => ({ can: false, why, retryAt });

  if (!account) return no('sign in to apply');
  if (needEmail && !account.emailVerified) return no('confirm your email address first');
  const level = Math.max(0, Math.floor(account.level ?? 0));
  if (level < minLevel) return no(`reach level ${minLevel} first — you are ${level}`);

  const status = creator?.status ?? null;
  if (status === 'pending') return no('your application is already in the queue');
  if (status === 'approved') return no('you are already a creator');
  if (status === 'rejected' || status === 'revoked') {
    const retryAt = (creator.decidedAt ?? 0) + CREATOR_REAPPLY_DAYS * 86400;
    if (now < retryAt) {
      const days = Math.max(1, Math.ceil((retryAt - now) / 86400));
      return no(`you can apply again in ${days} day${days === 1 ? '' : 's'}`, retryAt);
    }
  }
  return { can: true, why: null, retryAt: 0 };
}

/**
 * May this account open developer mode, and how much of it?
 *
 * One function, so the tab, the keybind and the overlay cannot disagree. The
 * creator status buys exactly one thing here: `pro`. A level-10 account and a
 * code creator see the same four panels; the creator sees three more.
 *
 * `enabled` is checked first and beats everything, the creator status
 * included. An operator who has closed developer mode has closed it — a perk
 * that reaches past a server-wide switch is not a perk, it is a bug.
 *
 * @param {{level?:number, creator?:{kind?:string, status?:string}}|null} account
 * @param {{devLevel?:number, enabled?:boolean}} rules
 */
export function devModeAccess(account, { devLevel = DEV_MODE_LEVEL, enabled = true } = {}) {
  const level = Math.max(0, Math.floor(account?.level ?? 0));
  const pro = enabled && creatorCan(account?.creator, 'devPro');
  return {
    allowed: enabled && (pro || level >= devLevel),
    pro,
    need: devLevel,
    level,
    panels: enabled ? DEV_PANELS.filter((p) => !p.pro || pro).map((p) => p.id) : [],
  };
}

/* ── Creator links ────────────────────────────────────────────────────────────
 *
 * The part of this feature with a real attack surface, so the part with the
 * most rules.
 *
 * A card is drawn inside other people's screens. A free URL field on one is a
 * phishing form with a distribution channel attached, and "only approved
 * creators get one" is not an answer — approval happens once, and the field
 * stays editable forever afterwards.
 *
 * So there is no free URL field. A link is a *platform id and a handle*, and
 * the URL is built here, from the catalogue below, out of a handle that had to
 * match that platform's own character rules to be stored at all. Nothing a
 * player types ever becomes a scheme, a host, a port, a query or a fragment.
 *
 * `site` is the one exception, because a creator with their own domain and no
 * platform account is a real person and refusing them would be silly. That one
 * is https-only and host-only — no path, no port, no userinfo, no unicode — and
 * the client puts an interstitial in front of it naming where it goes.
 * ────────────────────────────────────────────────────────────────────────────*/

/**
 * @typedef {{id:string, name:string, base:string|null, handle:RegExp,
 *            prefix?:string, placeholder:string, suffix?:string}} CreatorPlatform
 */

/** @type {CreatorPlatform[]} */
export const CREATOR_PLATFORMS = [
  { id: 'youtube', name: 'YouTube', base: 'https://www.youtube.com/@', handle: /^[A-Za-z0-9._-]{3,30}$/, prefix: '@', placeholder: 'handle' },
  { id: 'twitch', name: 'Twitch', base: 'https://www.twitch.tv/', handle: /^[a-z0-9_]{4,25}$/, placeholder: 'channel' },
  { id: 'kick', name: 'Kick', base: 'https://kick.com/', handle: /^[a-z0-9_-]{3,25}$/, placeholder: 'channel' },
  { id: 'x', name: 'X', base: 'https://x.com/', handle: /^[A-Za-z0-9_]{1,15}$/, prefix: '@', placeholder: 'handle' },
  { id: 'bluesky', name: 'Bluesky', base: 'https://bsky.app/profile/', handle: /^[a-z0-9][a-z0-9.-]{2,58}[a-z0-9]$/, placeholder: 'you.bsky.social' },
  { id: 'instagram', name: 'Instagram', base: 'https://www.instagram.com/', handle: /^[a-z0-9._]{1,30}$/, prefix: '@', placeholder: 'handle' },
  { id: 'tiktok', name: 'TikTok', base: 'https://www.tiktok.com/@', handle: /^[a-z0-9._]{2,24}$/, prefix: '@', placeholder: 'handle' },
  { id: 'soundcloud', name: 'SoundCloud', base: 'https://soundcloud.com/', handle: /^[a-z0-9_-]{3,40}$/, placeholder: 'artist' },
  { id: 'bandcamp', name: 'Bandcamp', base: 'https://', suffix: '.bandcamp.com', handle: /^[a-z0-9-]{3,40}$/, placeholder: 'artist' },
  { id: 'spotify', name: 'Spotify', base: 'https://open.spotify.com/artist/', handle: /^[A-Za-z0-9]{22}$/, placeholder: 'artist id' },
  { id: 'github', name: 'GitHub', base: 'https://github.com/', handle: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, placeholder: 'user' },
  { id: 'artstation', name: 'ArtStation', base: 'https://www.artstation.com/', handle: /^[a-z0-9_-]{3,40}$/, placeholder: 'artist' },
  { id: 'itch', name: 'itch.io', base: 'https://', suffix: '.itch.io', handle: /^[a-z0-9-]{3,40}$/, placeholder: 'user' },
  { id: 'kofi', name: 'Ko-fi', base: 'https://ko-fi.com/', handle: /^[A-Za-z0-9_]{3,30}$/, placeholder: 'page' },
  /*
   * The free one, and the only pattern here worth reading twice.
   *
   * A hostname and nothing else: no scheme to choose, no port, no userinfo, no
   * path, no query. `(?!xn--)` on every label refuses punycode outright, which
   * is what stops a homograph domain from reading as somebody else's in the
   * interstitial that names it — and the trailing `[a-z]{2,24}` requires a real
   * alphabetic TLD, which incidentally refuses a bare IP address.
   */
  {
    id: 'site',
    name: 'Website',
    base: 'https://',
    handle: /^(?!xn--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.(?!xn--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/,
    placeholder: 'example.com',
  },
];

export const CREATOR_PLATFORM_IDS = CREATOR_PLATFORMS.map((p) => p.id);

/** How many a card carries. Enough for a real footprint, few enough to read. */
export const CREATOR_LINKS_MAX = 5;

/** One platform by id, or null. */
export const getCreatorPlatform = (id) => CREATOR_PLATFORMS.find((p) => p.id === id) ?? null;

/**
 * The URL one stored link points at — built here, never sent by a client.
 *
 * @param {{platform?:string, handle?:string}} link
 * @returns {string|null} null when the pair is not one this file recognises,
 *   which is also what every renderer treats as "draw nothing".
 */
export function creatorLinkUrl(link) {
  const spec = getCreatorPlatform(link?.platform);
  if (!spec) return null;
  const handle = String(link.handle ?? '');
  if (!spec.handle.test(handle)) return null;
  return `${spec.base}${handle}${spec.suffix ?? ''}`;
}

/** What a link reads as beside its icon: the handle, never the URL. */
export function creatorLinkLabel(link) {
  const spec = getCreatorPlatform(link?.platform);
  if (!spec) return '';
  return `${spec.prefix ?? ''}${link.handle}${spec.suffix ?? ''}`;
}

/**
 * Folds a typed handle into the shape its platform stores.
 *
 * A leading @, a trailing slash and a pasted `https://twitch.tv/` prefix are
 * typos rather than attacks, and refusing them teaches nobody anything — so
 * they are trimmed. Case is folded only for the platforms whose own handles are
 * lower-case, which is why the rule reads off the pattern rather than being a
 * flag somebody has to remember to set.
 */
export function normaliseCreatorHandle(platform, raw) {
  const spec = getCreatorPlatform(platform);
  if (!spec) return '';
  let handle = String(raw ?? '').trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^(?:www\.)?[a-z0-9.-]+\//i, (m) => (spec.id === 'site' ? m : ''))
    .replace(/^@+/, '')
    .replace(/\/+$/, '');
  if (spec.suffix) handle = handle.replace(new RegExp(`${spec.suffix.replace(/\./g, '\\.')}$`, 'i'), '');
  if (spec.id === 'site') handle = handle.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  if (!/[A-Z]/.test(spec.handle.source)) handle = handle.toLowerCase();
  return handle;
}

/**
 * Sanitises a set of links into something safe to store and to draw.
 *
 * Same contract as `normaliseCard`: never throws, and never rejects a whole set
 * over one bad member. Anything unrecognised is dropped rather than corrected,
 * because a link that has been "fixed" points somewhere its owner did not ask
 * for — and each platform is kept at most once, so a card cannot be six copies
 * of the same handle.
 */
export function normaliseCreatorLinks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const platform = String(entry.platform ?? '');
    if (seen.has(platform) || !getCreatorPlatform(platform)) continue;
    const handle = normaliseCreatorHandle(platform, entry.handle);
    // Built rather than trusted: a pair that cannot make a URL is not a link,
    // whatever it claims to be.
    if (!creatorLinkUrl({ platform, handle })) continue;
    seen.add(platform);
    out.push({ platform, handle });
    if (out.length >= CREATOR_LINKS_MAX) break;
  }
  return out;
}

/** Why a set of links is unacceptable, or null. Drawn under the editor. */
export function creatorLinksError(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > CREATOR_LINKS_MAX) return `${CREATOR_LINKS_MAX} links at most`;
  const seen = new Set();
  for (const entry of list) {
    const spec = getCreatorPlatform(entry?.platform);
    if (!spec) return 'pick a platform for every link';
    if (seen.has(spec.id)) return `one ${spec.name} link is enough`;
    seen.add(spec.id);
    const handle = normaliseCreatorHandle(spec.id, entry?.handle);
    if (!handle) return `${spec.name} needs a ${spec.placeholder}`;
    if (!spec.handle.test(handle)) return `that is not a ${spec.name} ${spec.placeholder}`;
  }
  return null;
}

/* ── Skin commissions ─────────────────────────────────────────────────────────
 *
 * What an art creator's grant actually is: a brief, a palette and a reference,
 * queued for a human. Nothing here mints a cosmetic — the request is a
 * conversation, and shared/cosmetics.js stays the only thing that decides what
 * exists in the game.
 * ────────────────────────────────────────────────────────────────────────────*/

export const SKIN_REQUEST_NAME_MAX = 28;
export const SKIN_REQUEST_BRIEF_MIN = 40;
export const SKIN_REQUEST_BRIEF_MAX = 900;
export const SKIN_REQUEST_PALETTE_MAX = 6;
/** Open requests one creator may hold. A queue, not a wishlist. */
export const SKIN_REQUEST_OPEN_MAX = 2;
export const SKIN_REQUEST_STATUSES = ['open', 'accepted', 'shipped', 'declined'];

/** Sanitises a proposed palette into hex the panel can draw. */
export function normalisePalette(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const entry of list) {
    const hex = String(entry ?? '').trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex) || out.includes(hex)) continue;
    out.push(hex);
    if (out.length >= SKIN_REQUEST_PALETTE_MAX) break;
  }
  return out;
}

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
  /**
   * The other half of the round trip the server times for itself.
   *
   * Sent the instant a PONG lands, carrying the token that PONG issued, so what
   * the server measures is one real trip out and back — not the interval
   * between two of the client's own heartbeats, which is what echoing the token
   * on the *next* PING would have measured.
   */
  ACK: 'ak',
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
  GOD: 'gd',          // an admin switching god mode on or off
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
  GOD: 'gd',          // god mode is on, off, or was refused
  AFK: 'af',          // you stopped playing: a warning, then the way out
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
 *          reportsEnabled?:boolean, devLevel?:number, devEnabled?:boolean,
 *          creatorLevel?:number, creatorsEnabled?:boolean}} rules
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
    devLevel = DEV_MODE_LEVEL,
    devEnabled = true,
    creatorLevel = CREATOR_MIN_LEVEL,
    creatorsEnabled = true,
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
      title: 'SKINS, CASES AND THE MARKET',
      desc: `Nine slots to dress — three weapons, gloves, headwear, face, outfit, pack `
        + `and a charm. Bought outright with ${CURRENCY}, pulled out of a case, or `
        + 'bought off another player. None of it changes a weapon.',
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
    ...(creatorsEnabled ? [{
      level: creatorLevel,
      title: 'APPLY AS A CREATOR',
      desc: 'Make music, art, video or code for this game and ask for the status that goes with '
        + 'it. A human reads the application. Approved creators wear the badge, put their links '
        + 'on their card, and get the perk their discipline earns — an anthem over the kill cam, '
        + 'a commissioned finish, the director\'s camera, or the instruments.',
    }] : []),
    ...(devEnabled ? [{
      level: devLevel,
      title: 'DEVELOPER MODE',
      desc: 'Frame time, the network, your own movement state and a set of render toggles, on '
        + 'screen while you play. Instruments only: nothing in it tells you anything about '
        + 'anybody else that your screen was not already going to.',
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
