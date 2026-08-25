/**
 * Open Grunker — remote players.
 *
 * Characters are box assemblies (no rigs, no imported models) driven by
 * snapshot interpolation: everything renders INTERP_DELAY behind the newest
 * server state so movement stays smooth through packet jitter.
 *
 * Each entity also carries a throttled line-of-sight test. Nametags and
 * minimap blips are gated on it, so neither can ever tell you about an enemy
 * you cannot actually see.
 */
import * as THREE from 'three';
import * as K from '/shared/constants.js';
import { getClass, loadoutFor } from '/shared/weapons.js';
import { settings } from './settings.js';

const BUFFER_MS = 1200;
/** How long a body takes to go down, settle, and fade out. */
const DEATH_TIME = 2.2;
const SKIN_TONES = [0xc99a72, 0x9d6a45, 0x71472c, 0xe0b593, 0x54341f];

/**
 * Every box geometry a character is made of, shared across every character.
 *
 * All nine classes wear the same body; only the colours and the gun differ. So
 * the twenty-odd distinct box sizes are built once for the life of the page
 * instead of thirty-one per player — which used to mean thirty-one buffer
 * allocations and thirty-one GPU uploads on every join *and* on every class
 * change, landing as a hitch in the middle of a firefight.
 *
 * Nothing here is ever disposed: it belongs to the module, not to a body, and
 * `removePlayer` knows to leave it alone.
 */
const BOX_CACHE = new Map();
function boxGeometry(w, h, d) {
  const key = `${w},${h},${d}`;
  let geo = BOX_CACHE.get(key);
  if (!geo) {
    geo = new THREE.BoxGeometry(w, h, d);
    geo.userData.shared = true;
    BOX_CACHE.set(key, geo);
  }
  return geo;
}

let BLOB_GEO = null;
function blobGeometry() {
  if (!BLOB_GEO) {
    BLOB_GEO = new THREE.CircleGeometry(0.44, 14);
    BLOB_GEO.userData.shared = true;
  }
  return BLOB_GEO;
}

/**
 * Parts whose shadow is already inside somebody else's.
 *
 * Each of these is contained by — or lies flush against — a larger part that
 * still casts: the mask is inside the head, the helmet crown is on the helmet,
 * the pouches are on the face of the plate carrier. A directional light casts
 * the shadow of a contained solid strictly inside the shadow of its container,
 * so taking them out of the shadow pass removes fifteen draws per player per
 * frame and removes nothing anybody can see.
 */
const NO_SHADOW_PARTS = new Set([
  'collar', 'pouchL', 'pouchR', 'pouchC', 'roll', 'mask', 'visor',
  'helmetTop', 'brim', 'nvg', 'kneeL', 'kneeR', 'band', 'band2', 'flash',
]);

/** The verified check, loaded once and drawn straight into every nametag. */
const checkImage = new Image();
let checkReady = false;
checkImage.onload = () => { checkReady = true; };
checkImage.src = '/check.png';

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Builds one low-poly operator. Silhouette first: helmet, plate carrier and
 * boots are what a player reads at forty metres, long before any detail.
 */
function buildCharacter(teamColor, classDef, skinIdx = 0) {
  const g = new THREE.Group();

  /**
   * Materials are cached *per character*, not globally.
   *
   * A body's materials are mutated while it is on screen — a hit flashes their
   * emissive, a death fades their opacity — so two players cannot share one.
   * Within a single body they can: the torso and the bedroll are the same
   * fabric, and both fade together anyway. Thirty-one materials become about
   * thirteen, which is thirteen shader-uniform sets per body per frame.
   */
  const mats = new Map();
  const mk = (w, h, d, color, opts = {}) => {
    const key = `${color}|${opts.shininess ?? 8}|${opts.specular ?? 0x14181d}|${opts.emissive ?? -1}`;
    let mat = mats.get(key);
    if (!mat) {
      mat = new THREE.MeshPhongMaterial({ color, shininess: 8, specular: 0x14181d, ...opts });
      mats.set(key, mat);
    }
    return new THREE.Mesh(boxGeometry(w, h, d), mat);
  };

  const team = new THREE.Color(teamColor);
  const fabric = team.clone().multiplyScalar(0.42).lerp(new THREE.Color(0x2f333a), 0.55);
  const gear = new THREE.Color(0x23272d);
  const gearLight = new THREE.Color(0x343a42);
  const pants = new THREE.Color(0x363b40).lerp(team, 0.12);
  const rubber = new THREE.Color(0x141619);
  const accent = new THREE.Color(classDef?.color ?? 0xf0a010);
  const strap = team.clone().lerp(new THREE.Color(0xffffff), 0.15);

  // ── Torso: shirt, plate carrier, pouches, backpack ────────────────────
  const torso = mk(0.6, 0.7, 0.34, fabric.getHex());
  torso.position.y = 1.15;
  const vest = mk(0.66, 0.42, 0.42, gear.getHex(), { shininess: 22, specular: 0x2a3038 });
  vest.position.set(0, 1.24, 0);
  const collar = mk(0.4, 0.11, 0.3, gearLight.getHex());
  collar.position.set(0, 1.5, 0);
  const pouchL = mk(0.15, 0.15, 0.1, gearLight.getHex());
  pouchL.position.set(-0.17, 1.09, -0.23);
  const pouchR = pouchL.clone();
  pouchR.position.x = 0.17;
  const pouchC = mk(0.15, 0.13, 0.09, gearLight.getHex());
  pouchC.position.set(0, 1.09, -0.23);
  // Team armband and class flash — the two colours that identify a player.
  const band = mk(0.2, 0.11, 0.21, strap.getHex(), { emissive: strap.clone().multiplyScalar(0.22).getHex() });
  band.position.set(-0.4, 1.33, 0);
  const band2 = band.clone();
  band2.position.x = 0.4;
  const flash = mk(0.14, 0.1, 0.02, accent.getHex(), { emissive: accent.clone().multiplyScalar(0.3).getHex() });
  flash.position.set(0.21, 1.36, -0.215);
  const pack = mk(0.4, 0.44, 0.2, gear.getHex());
  pack.position.set(0, 1.18, 0.26);
  const roll = mk(0.34, 0.12, 0.14, fabric.getHex());
  roll.position.set(0, 1.42, 0.28);

  // ── Head: balaclava, face, goggles, helmet ────────────────────────────
  const head = mk(0.38, 0.34, 0.36, SKIN_TONES[skinIdx % SKIN_TONES.length]);
  head.position.y = 1.68;
  const mask = mk(0.39, 0.18, 0.37, 0x1b1f25);
  mask.position.set(0, 1.62, 0);
  const visor = mk(0.34, 0.1, 0.04, 0x121a24, { shininess: 90, specular: 0x7fbfe0 });
  visor.position.set(0, 1.73, -0.19);
  const helmet = mk(0.44, 0.22, 0.44, gear.getHex(), { shininess: 26, specular: 0x2e343c });
  helmet.position.y = 1.9;
  const helmetTop = mk(0.36, 0.08, 0.36, gear.getHex(), { shininess: 26, specular: 0x2e343c });
  helmetTop.position.y = 2.0;
  const brim = mk(0.42, 0.05, 0.14, gearLight.getHex());
  brim.position.set(0, 1.82, -0.26);
  const nvg = mk(0.12, 0.08, 0.12, 0x1a1e24);
  nvg.position.set(0, 1.93, -0.24);

  // ── Limbs ─────────────────────────────────────────────────────────────
  const shoulderL = mk(0.19, 0.19, 0.28, gearLight.getHex());
  shoulderL.position.set(-0.38, 1.42, 0);
  const shoulderR = shoulderL.clone();
  shoulderR.position.x = 0.38;

  const armL = mk(0.16, 0.56, 0.18, fabric.clone().multiplyScalar(0.9).getHex());
  armL.position.set(-0.38, 1.14, 0);
  const armR = armL.clone();
  armR.position.x = 0.38;
  const gloveL = mk(0.15, 0.14, 0.17, gear.getHex());
  gloveL.position.set(-0.38, 0.87, 0);
  const gloveR = gloveL.clone();
  gloveR.position.x = 0.38;

  const legL = mk(0.21, 0.74, 0.23, pants.getHex());
  legL.position.set(-0.145, 0.42, 0);
  const legR = legL.clone();
  legR.position.x = 0.145;
  const kneeL = mk(0.22, 0.1, 0.24, gear.getHex());
  kneeL.position.set(-0.145, 0.42, -0.01);
  const kneeR = kneeL.clone();
  kneeR.position.x = 0.145;

  const bootL = mk(0.23, 0.16, 0.31, rubber.getHex(), { shininess: 20, specular: 0x2a2e33 });
  bootL.position.set(-0.145, 0.08, -0.03);
  const bootR = bootL.clone();
  bootR.position.x = 0.145;

  /*
   * Third-person weapons — all three of them, built from the same recipes the
   * viewmodel uses.
   *
   * Only the primary used to exist here, so switching to the sidearm or the
   * knife changed nothing anybody else could see: everyone watched you kill
   * them with a rifle you were not holding. Every slot gets a model, and the
   * snapshot's slot field picks which one is visible — the wire already carried
   * it, nothing was ever drawing it.
   */
  const guns = (loadoutFor(classDef?.id) ?? []).map((def) => {
    const g2 = new THREE.Group();
    for (const p of def?.model?.parts ?? []) {
      const m = mk(p.s[0], p.s[1], p.s[2], p.c, { shininess: p.m === 'metal' || p.m === 'alloy' ? 60 : 10 });
      m.position.set(p.p[0], p.p[1], p.p[2]);
      if (p.r) m.rotation.set(p.r[0], p.r[1], p.r[2]);
      g2.add(m);
    }
    g2.scale.setScalar(0.86);
    g2.position.set(0.3, 1.25, -0.4);
    g2.visible = false;
    return g2;
  });
  if (!guns.length) guns.push(new THREE.Group());
  const gun = guns[0];
  gun.visible = true;

  // Cheap contact shadow so bodies sit on the ground even with shadows off.
  const blob = new THREE.Mesh(
    blobGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  blob.renderOrder = 1;

  const named = {
    torso, vest, collar, pouchL, pouchR, pouchC, pack, roll, head, mask, visor,
    helmet, helmetTop, brim, nvg, shoulderL, shoulderR, armL, armR, gloveL, gloveR,
    legL, legR, kneeL, kneeR, bootL, bootR, band, band2, flash,
  };
  const solid = Object.values(named);
  for (const [id, part] of Object.entries(named)) {
    part.castShadow = !NO_SHADOW_PARTS.has(id);
    g.add(part);
  }
  g.add(...guns, blob);

  g.userData = {
    ...named, gun, guns, blob,
    solid,
    /** Parts a damage flash may tint — the ones with no emissive of their own. */
    flashParts: solid.filter((p) => p !== band && p !== band2 && p !== flash),
    /** Every part's rest height, so crouch/slide can offset them as a group. */
    homeY: solid.map((p) => p.position.y).concat([gun.position.y]),
    /** Every mesh a death fade or an x-ray pass has to reach. */
    fadeParts: solid.concat(guns.flatMap((w) => w.children)),
  };
  return g;
}

/** Name + level + health plate that floats above a player. */
function buildNametag() {
  const cnv = document.createElement('canvas');
  cnv.width = 420; cnv.height = 132;
  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(K.TAG_BASE_WIDTH, K.TAG_BASE_HEIGHT, 1);
  sprite.position.y = 2.34;
  sprite.renderOrder = 6;
  return { sprite, cnv, tex, last: '' };
}

function drawNametag(tag, { name, level, health, teamColor, clan, clanVerified, verified, friendly }) {
  const key = `${name}|${clan}|${clanVerified ? 1 : 0}|${level}|${Math.round(health / 4)}`
    + `|${teamColor}|${verified ? 1 : 0}|${checkReady ? 1 : 0}`;
  if (tag.last === key) return;
  tag.last = key;

  const g = tag.cnv.getContext('2d');
  const W = 420, H = 132;
  g.clearRect(0, 0, W, H);

  // The clan tag is drawn as its own run rather than folded into the label:
  // it has its own colour — grey, or gold for a verified clan — and the name
  // keeps the team's.
  const prefix = clan ? `[${clan}] ` : '';
  const badge = verified ? 34 : 0;

  g.font = '700 42px Bahnschrift, "Segoe UI Semibold", system-ui, sans-serif';
  const prefixW = prefix ? g.measureText(prefix).width : 0;
  const nameW = g.measureText(name).width;
  const totalW = prefixW + nameW + badge;
  const startX = (W - totalW) / 2;

  // A dark plate behind the text keeps a nametag legible on a bright sky.
  const plateW = Math.min(W - 8, totalW + 34);
  g.fillStyle = 'rgba(6,9,14,.5)';
  roundRect(g, (W - plateW) / 2, 6, plateW, 50, 8);
  g.fill();

  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,0,.92)';
  if (prefix) {
    g.strokeText(prefix, startX, 32);
    g.fillStyle = clanVerified ? K.CLAN_TAG_COLOR_VERIFIED : K.CLAN_TAG_COLOR;
    g.fillText(prefix, startX, 32);
  }
  g.strokeText(name, startX + prefixW, 32);
  g.fillStyle = `#${new THREE.Color(teamColor).getHexString()}`;
  g.fillText(name, startX + prefixW, 32);

  if (verified && checkReady) {
    try { g.drawImage(checkImage, startX + prefixW + nameW + 6, 12, 26, 26); } catch { /* not decodable yet */ }
  }

  g.textAlign = 'center';
  g.font = '700 24px Bahnschrift, system-ui, sans-serif';
  g.lineWidth = 6;
  g.strokeText(`LVL ${level}`, W / 2, 72);
  g.fillStyle = '#f5a623';
  g.fillText(`LVL ${level}`, W / 2, 72);

  const pct = Math.max(0, Math.min(1, health / K.MAX_HEALTH));
  const barW = 236, barX = (W - barW) / 2;
  g.fillStyle = 'rgba(0,0,0,.78)';
  roundRect(g, barX, 94, barW, 15, 4);
  g.fill();
  g.fillStyle = friendly ? '#4ddb7a' : pct > 0.55 ? '#4ddb7a' : pct > 0.25 ? '#f5a623' : '#ff4d4d';
  roundRect(g, barX + 2, 96, (barW - 4) * pct, 11, 3);
  g.fill();

  tag.tex.needsUpdate = true;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export class EntityManager {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map();          // id -> entity
    this.buffer = [];                  // [{ t, entries: Map<id, arr> }]
    this.localId = 0;
    this.teamMode = false;
    this.myTeam = K.TEAM.NONE;
    /**
     * One body the renderer must not draw, by id.
     *
     * Set while the spectator camera sits inside somebody's head: from in
     * there their own model is a shoulder and a jaw filling half the screen,
     * which is exactly what a first-person view exists to avoid.
     */
    this.hidden = 0;
    /** Draw every body over the world rather than behind it — spectators only. */
    this.xray = false;
    this._fwd = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this.visAcc = 0;
  }

  reset() {
    for (const id of [...this.players.keys()]) this.removePlayer(id);
    this.buffer.length = 0;
  }

  /* ── Membership ────────────────────────────────────────────────────────── */

  addPlayer(profile) {
    if (this.players.has(profile.id) || profile.id === this.localId) return;
    const teamColor = this.teamMode
      ? (K.TEAM_COLORS[profile.team] ?? 0xf0a010)
      : 0xdd4b3e;
    const group = buildCharacter(teamColor, getClass(profile.classId), profile.id);
    const tag = buildNametag();
    group.add(tag.sprite);
    group.visible = false;
    this.scene.add(group);

    this.players.set(profile.id, {
      id: profile.id, profile, group, tag, teamColor,
      pos: new THREE.Vector3(), yaw: 0, pitch: 0,
      health: K.MAX_HEALTH, alive: false, walkPhase: 0, speed: 0, height: K.PLAYER_HEIGHT,
      lastSlot: -1, visible: false, lastSeenAt: -99, visCheckAt: 0,
      hitFlash: 0, deathT: 0, deathDur: 0, deathSeed: 0, faded: false,
      swingT: 0, wasAlive: false, lean: 0,
    });
    if (this.xray) this._applyXray(this.players.get(profile.id), true);
  }

  removePlayer(id) {
    const e = this.players.get(id);
    if (!e) return;
    this.scene.remove(e.group);
    // Geometry marked `shared` belongs to the module and outlives every body;
    // disposing it here would blank every other player on screen.
    e.group.traverse((o) => {
      if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose?.();
      if (o.material) { o.material.map?.dispose?.(); o.material.dispose?.(); }
    });
    this.players.delete(id);
  }

  /** Rebuilds a character when its class changes. */
  setClass(id, classId) {
    const e = this.players.get(id);
    if (!e || e.profile.classId === classId) return;
    e.profile.classId = classId;
    const wasVisible = e.group.visible;
    this.scene.remove(e.group);
    e.group.traverse((o) => {
      if (o === e.tag.sprite) return;
      if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose?.();
      if (o.material && o.material !== e.tag.sprite.material) o.material.dispose?.();
    });
    const group = buildCharacter(e.teamColor, getClass(classId), id);
    group.add(e.tag.sprite);
    group.visible = wasVisible;
    group.position.copy(e.group.position);
    this.scene.add(group);
    e.group = group;
    // A fresh body starts on the primary; make the next frame notice which slot
    // this player is actually holding, and re-arm the x-ray if one is on.
    e.lastSlot = -1;
    if (this.xray) this._applyXray(e, true);
  }

  /**
   * See everybody through the walls.
   *
   * Only ever switched on for a spectator, who has no fight to gain from it:
   * a camera watching a match wants to follow the fight through the building it
   * is happening inside. Drawing over depth rather than disabling it keeps the
   * bodies solid and readable instead of turning them into ghosts.
   */
  setXray(on) {
    const want = !!on;
    if (want === this.xray) return;
    this.xray = want;
    for (const e of this.players.values()) this._applyXray(e, want);
  }

  _applyXray(e, on) {
    const u = e.group.userData;
    for (const p of u.fadeParts ?? u.solid) {
      p.material.depthTest = !on;
      p.material.needsUpdate = true;
      p.renderOrder = on ? 4 : 0;
    }
  }

  /** A third-person knife swing, so a melee reads as one from the outside too. */
  meleeSwing(id) {
    const e = this.players.get(id);
    if (e) e.swingT = 0.42;
  }

  get(id) { return this.players.get(id); }

  /** Flashes a body white when one of our rounds lands on it. */
  flashHit(id) {
    const e = this.players.get(id);
    if (e) e.hitFlash = 0.13;
  }

  /* ── Snapshots ─────────────────────────────────────────────────────────── */

  pushSnapshot(t, entries) {
    const map = new Map();
    for (const e of entries) map.set(e[0], e);
    this.buffer.push({ t, entries: map });
    if (this.buffer.length > 2 && this.buffer[this.buffer.length - 1].t < this.buffer[this.buffer.length - 2].t) {
      this.buffer.sort((a, b) => a.t - b.t);        // out-of-order packet
    }
    const cutoff = t - BUFFER_MS;
    while (this.buffer.length > 2 && this.buffer[0].t < cutoff) this.buffer.shift();
  }

  get latestTime() { return this.buffer.length ? this.buffer[this.buffer.length - 1].t : 0; }

  /**
   * Interpolates every remote player to `renderTime` (ms, server clock).
   * @param {object} view { camera, world, nowSec } — the world is used for the
   *        line-of-sight test that gates nametags and minimap blips.
   */
  update(renderTime, dt, view = {}) {
    if (this.buffer.length === 0) return;
    const { camera, world, nowSec = 0 } = view;

    let older = this.buffer[0], newer = this.buffer[this.buffer.length - 1];
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].t <= renderTime) {
        older = this.buffer[i];
        newer = this.buffer[Math.min(i + 1, this.buffer.length - 1)];
        break;
      }
    }
    const span = newer.t - older.t;
    const alpha = span > 0 ? Math.max(0, Math.min(1, (renderTime - older.t) / span)) : 0;

    if (camera) camera.getWorldDirection(this._fwd);

    for (const e of this.players.values()) {
      const a = older.entries.get(e.id);
      const b = newer.entries.get(e.id) ?? a;
      if (!a) { e.group.visible = false; e.visible = false; continue; }

      const alive = (a[6] & 1) !== 0;
      if (e.wasAlive && !alive) {
        e.deathDur = DEATH_TIME;
        e.deathT = DEATH_TIME;
        // One number decides which way this particular body goes down, so the
        // collapse is different every time and identical on every screen.
        e.deathSeed = (Math.imul(e.id | 0, 0x9e3779b1) ^ Math.imul(Math.round(a[4] * 100), 0x85ebca6b)) >>> 0;
      }
      e.wasAlive = alive;
      e.alive = alive;

      if (!alive) {
        e.visible = false;
        e.tag.sprite.visible = false;
        if (e.deathT > 0) {
          e.deathT = Math.max(0, e.deathT - dt);
          this._deathPose(e, dt);
          e.group.visible = true;
        } else {
          e.group.visible = false;
        }
        continue;
      }
      e.group.visible = e.id !== this.hidden;
      /*
       * Alive again: every part of the death has to be undone.
       *
       * This used to be gated on `deathT > 0`, which is true only if the body
       * respawned *during* its own fall — and a corpse that had already faded
       * out sat at zero opacity for the rest of the match. The gun was never
       * faded at all, so the player came back as a rifle walking around on its
       * own. It is the transition that undoes it now, not the timer.
       */
      if (e.faded) this._resetPose(e);

      e.pos.set(lerp(a[1], b[1], alpha), lerp(a[2], b[2], alpha), lerp(a[3], b[3], alpha));
      e.yaw = lerpAngle(a[4], b[4], alpha);
      e.pitch = lerp(a[5], b[5], alpha);
      e.health = b[7];
      e.speed = lerp(a[9] ?? 0, b[9] ?? 0, alpha);

      const crouching = (b[6] & 4) !== 0;
      const sliding = (b[6] & 8) !== 0;
      const grounded = (b[6] & 2) !== 0;
      // Kept so local shot prediction uses the same hitbox the server rewinds.
      e.height = (crouching || sliding) ? K.PLAYER_CROUCH_HEIGHT : K.PLAYER_HEIGHT;

      this._pose(e, dt, { crouching, sliding, grounded });

      e.group.position.copy(e.pos);
      e.group.rotation.set(0, e.yaw, 0);

      if (e.hitFlash > 0) {
        e.hitFlash = Math.max(0, e.hitFlash - dt);
        const k = e.hitFlash / 0.13;
        for (const p of e.group.userData.flashParts) {
          if (p.material.emissive) p.material.emissive.setScalar(k * 0.55);
        }
      }

      this._updateVisibility(e, camera, world, nowSec);
      this._updateTag(e, camera);

      // Show whatever they are actually holding. The slot is in every snapshot;
      // until now only the knife did anything with it.
      if (b[8] !== e.lastSlot) {
        e.lastSlot = b[8];
        const guns = e.group.userData.guns;
        for (let i = 0; i < guns.length; i++) guns[i].visible = i === b[8];
      }
    }
  }

  /**
   * The death.
   *
   * A kill is the loudest thing that happens in a match and it used to be a box
   * tipping forward, so this is built as an actual collapse: the legs go first
   * and the body follows them down, the arms let go, the head lolls, the whole
   * thing rolls off the axis it was shot along rather than falling politely
   * forward, and the weapon leaves the hands and drops on its own. It settles
   * flat on the ground for a beat — long enough to read as a body — and only
   * then sinks and fades out.
   *
   * Everything is derived from `deathSeed`, so two clients watching the same
   * kill watch the same fall, and nobody's corpse lands the same way twice.
   */
  _deathPose(e, dt) {
    const u = e.group.userData;
    const dur = e.deathDur || DEATH_TIME;
    const t = 1 - e.deathT / dur;

    // Which way this one goes over. Mostly forward, tipped a quarter turn one
    // way or the other so a pile of bodies never lines up.
    const r1 = ((e.deathSeed & 0xffff) / 65535) * 2 - 1;
    const r2 = (((e.deathSeed >>> 16) & 0xffff) / 65535) * 2 - 1;
    const twist = r1 * 0.9;
    const tilt = r2 * 0.45;

    // The fall: a slow buckle, then gravity takes it, then it stops dead.
    const fall = t < 0.62 ? 1 - (1 - t / 0.62) ** 2.4 : 1;
    const bounce = t > 0.55 && t < 0.78 ? Math.sin((t - 0.55) / 0.23 * Math.PI) * 0.055 : 0;

    e.group.rotation.set(fall * (1.52 + tilt * 0.2), e.yaw + fall * twist, fall * tilt);
    e.group.position.set(
      e.pos.x + Math.sin(e.yaw + Math.PI) * fall * 0.35,
      e.pos.y + bounce - fall * 0.06,
      e.pos.z + Math.cos(e.yaw + Math.PI) * fall * 0.35,
    );

    // The body inside the fall: knees fold, arms swing loose, head drops.
    const limp = Math.min(1, t * 2.2);
    u.legL.rotation.x = -0.9 * limp + twist * 0.25;
    u.legR.rotation.x = -0.45 * limp - twist * 0.25;
    u.kneeL.rotation.x = u.legL.rotation.x;
    u.kneeR.rotation.x = u.legR.rotation.x;
    u.bootL.rotation.x = u.legL.rotation.x;
    u.bootR.rotation.x = u.legR.rotation.x;
    u.armL.rotation.x = 1.25 * limp;
    u.armR.rotation.x = 0.95 * limp + Math.sin(t * 7) * 0.12 * (1 - t);
    u.gloveL.rotation.x = u.armL.rotation.x;
    u.gloveR.rotation.x = u.armR.rotation.x;
    u.head.rotation.x = 0.75 * limp;
    u.mask.rotation.x = u.head.rotation.x;
    u.visor.rotation.x = u.head.rotation.x;
    u.helmet.rotation.x = 0.55 * limp;
    u.helmetTop.rotation.x = u.helmet.rotation.x;
    u.brim.rotation.x = u.helmet.rotation.x;
    u.nvg.rotation.x = u.helmet.rotation.x;
    u.torso.rotation.x = 0.3 * limp;
    u.vest.rotation.x = u.torso.rotation.x;
    u.pack.rotation.x = u.torso.rotation.x;

    // The weapon is dropped rather than carried down: it leaves the hand, spins
    // a little, and ends up on the floor beside the body.
    const drop = Math.min(1, t * 1.9);
    const gun = u.guns[e.lastSlot] ?? u.gun;
    for (const g of u.guns) {
      if (g !== gun) continue;
      g.position.set(0.3 + drop * 0.34, 1.25 - drop * 1.18, -0.4 - drop * 0.5);
      g.rotation.set(drop * 1.9, drop * (1.1 + twist), drop * 2.6 * (twist >= 0 ? 1 : -1));
    }

    // Flat on the ground, then gone. The gap between the two is what makes it a
    // body rather than a puff of smoke.
    const fade = t > 0.78 ? Math.max(0, 1 - (t - 0.78) / 0.22) : 1;
    for (const p of u.fadeParts) {
      p.material.transparent = fade < 1;
      p.material.opacity = fade;
    }
    u.blob.material.opacity = 0.3 * fade * (1 - fall * 0.4);
    e.faded = true;
    void dt;
  }

  /** Undoes every last thing `_deathPose` touched. */
  _resetPose(e) {
    const u = e.group.userData;
    for (const p of u.fadeParts) {
      p.material.transparent = false;
      p.material.opacity = 1;
    }
    for (const g of u.guns) {
      g.position.set(0.3, 1.25, -0.4);
      g.rotation.set(0, 0, 0);
    }
    for (const key of ['torso', 'vest', 'pack', 'head', 'mask', 'visor', 'helmet',
      'helmetTop', 'brim', 'nvg', 'armL', 'armR', 'gloveL', 'gloveR']) {
      u[key].rotation.set(0, 0, 0);
    }
    u.blob.material.opacity = 0.3;
    e.group.rotation.set(0, e.yaw, 0);
    e.faded = false;
    e.deathT = 0;
    e.lean = 0;
  }

  /**
   * Can the local player actually see this one? Friendly players are always
   * "visible"; enemies need to be in front of the camera *and* have a clear
   * line to head, chest or feet. Recomputed on a slow timer, which is plenty
   * for a HUD and costs three raycasts per enemy per 80 ms.
   */
  _updateVisibility(e, camera, world, nowSec) {
    // A spectator seeing through walls is seeing through them for the plates
    // and the minimap too — a camera that can watch the fight but not name the
    // people in it is half a camera.
    const friendly = (this.teamMode && e.profile.team === this.myTeam) || this.xray;
    if (friendly) { e.visible = true; e.lastSeenAt = nowSec; return; }
    if (!camera || !world) { e.visible = true; return; }
    if (nowSec - e.visCheckAt < K.VIS_CHECK_INTERVAL) return;
    e.visCheckAt = nowSec;

    const cam = camera.position;
    this._to.copy(e.pos).sub(cam);
    const dist = this._to.length();
    if (dist > K.TAG_MAX_DISTANCE) { e.visible = false; return; }

    // In front of the camera, with a little slack outside the exact frustum.
    this._to.normalize();
    if (this._to.dot(this._fwd) < 0.28) { e.visible = false; return; }

    const h = e.height;
    e.visible = world.lineOfSight(cam.x, cam.y, cam.z, e.pos.x, e.pos.y + h - 0.25, e.pos.z)
      || world.lineOfSight(cam.x, cam.y, cam.z, e.pos.x, e.pos.y + h * 0.55, e.pos.z)
      || world.lineOfSight(cam.x, cam.y, cam.z, e.pos.x, e.pos.y + 0.25, e.pos.z);
    if (e.visible) e.lastSeenAt = nowSec;
  }

  /**
   * Nametags follow visibility exactly — an unseen enemy has no plate. Their
   * size is the player's choice: the plate is drawn at a fixed world size and
   * then scaled by distance and by `nametagScale`, so someone who wants them
   * big and readable gets exactly that without them swallowing the screen up
   * close.
   */
  _updateTag(e, camera) {
    // A hidden body is the one the camera is standing inside; its own plate
    // would be a wall of text across the middle of the view.
    const show = settings.nametags && e.visible && !!camera && e.id !== this.hidden;
    e.tag.sprite.visible = show;
    if (!show) return;
    const d = e.pos.distanceTo(camera.position);
    const friendly = this.teamMode && e.profile.team === this.myTeam;
    drawNametag(e.tag, {
      name: e.profile.name,
      level: e.profile.level ?? 1,
      health: e.health,
      teamColor: e.teamColor,
      clan: e.profile.clan,
      clanVerified: !!e.profile.clanVerified,
      verified: !!e.profile.verified,
      friendly,
    });

    const user = settings.nametagScale ?? 1;
    // Plates grow with distance so a far target stays readable, up to a cap.
    const growth = Math.max(1, Math.min(K.TAG_MAX_GROWTH, d / K.TAG_REF_DISTANCE));
    const s = 0.5 * user * growth;
    e.tag.sprite.scale.set(K.TAG_BASE_WIDTH * s, K.TAG_BASE_HEIGHT * s, 1);
    e.tag.sprite.position.y = e.height + 0.5 + K.TAG_BASE_HEIGHT * s * 0.4;
    e.tag.sprite.material.opacity = d > K.TAG_MAX_DISTANCE * 0.8
      ? Math.max(0, 1 - (d - K.TAG_MAX_DISTANCE * 0.8) / (K.TAG_MAX_DISTANCE * 0.2))
      : 1;
  }

  /** Leg swing, crouch squash, and aiming the torso/arms at the view pitch. */
  _pose(e, dt, { crouching, sliding, grounded }) {
    const u = e.group.userData;
    const moving = e.speed > 0.6;

    e.walkPhase += dt * (moving ? Math.min(17, 3 + e.speed * 1.5) : 0);
    if (!moving) e.walkPhase *= 0.86;

    const swing = Math.sin(e.walkPhase) * Math.min(0.8, e.speed / 10.5);
    const bounce = moving && grounded ? Math.abs(Math.cos(e.walkPhase)) * Math.min(0.05, e.speed / 240) : 0;

    u.legL.rotation.x = grounded ? swing : -0.4;
    u.legR.rotation.x = grounded ? -swing : 0.24;
    u.kneeL.rotation.x = u.legL.rotation.x;
    u.kneeR.rotation.x = u.legR.rotation.x;
    u.bootL.rotation.x = u.legL.rotation.x;
    u.bootR.rotation.x = u.legR.rotation.x;
    u.armL.rotation.x = -swing * 0.5 - 0.3;
    u.gloveL.rotation.x = u.armL.rotation.x;

    const crouchAmt = sliding ? 1 : crouching ? 0.78 : 0;
    const drop = -crouchAmt * 0.55 + bounce;
    const solid = u.solid;
    for (let i = 0; i < solid.length; i++) {
      solid[i].position.y = u.homeY[i] + drop;
    }
    const gunHomeY = u.homeY[u.homeY.length - 1] + drop;
    for (const g of u.guns) g.position.y = gunHomeY;

    const squash = 1 - crouchAmt * 0.55;
    u.legL.scale.y = u.legR.scale.y = squash;
    u.legL.position.y = 0.42 * squash + bounce;
    u.legR.position.y = 0.42 * squash + bounce;
    u.kneeL.position.y = 0.42 * squash + bounce;
    u.kneeR.position.y = 0.42 * squash + bounce;
    u.bootL.position.y = 0.08 * squash + bounce;
    u.bootR.position.y = 0.08 * squash + bounce;

    // Aim the head, gun arm and weapon along the view pitch.
    const p = Math.max(-1.2, Math.min(1.2, e.pitch));
    u.head.rotation.x = -p * 0.7;
    u.mask.rotation.x = u.head.rotation.x;
    u.visor.rotation.x = u.head.rotation.x;
    u.helmet.rotation.x = -p * 0.5;
    u.helmetTop.rotation.x = u.helmet.rotation.x;
    u.brim.rotation.x = u.helmet.rotation.x;
    u.nvg.rotation.x = u.helmet.rotation.x;

    /*
     * The knife swing, from the outside.
     *
     * Same three beats the viewmodel plays (see ViewModel._slashPose) so the
     * player swinging and the player being swung at are watching one animation:
     * the arm cocks back over the wind-up and throws across and down through the
     * cut, with the blade following the arm.
     */
    let slash = 0;
    if (e.swingT > 0) {
      e.swingT = Math.max(0, e.swingT - dt);
      const st = 1 - e.swingT / 0.42;
      const wind = st < 0.22 ? st / 0.22 : 1;
      const cut = st < 0.22 ? 0 : Math.min(1, (st - 0.22) / 0.34);
      const cutEase = 1 - (1 - cut) ** 3;
      const settle = st < 0.56 ? 0 : (st - 0.56) / 0.44;
      slash = cutEase * (1 - settle) - wind * (1 - cutEase) * 0.55;
    }

    u.armR.rotation.x = -p - 1.35 - slash * 1.5;
    u.armR.rotation.z = slash * 0.9;
    u.gloveR.rotation.x = u.armR.rotation.x;
    for (const g of u.guns) {
      g.rotation.x = -p - slash * 1.6;
      g.rotation.y = 0;
      g.rotation.z = slash * 1.1;
      g.position.z = -0.4 - Math.sin(p) * 0.2 - slash * 0.35;
      g.position.y += Math.sin(p) * 0.34 - slash * 0.18;
    }

    // Lean into a turn; slide flattens the body out.
    const targetLean = sliding ? 0.5 : moving ? 0.13 : 0;
    e.lean += (targetLean - e.lean) * Math.min(1, dt * 9);
    u.torso.rotation.x = e.lean;
    u.vest.rotation.x = e.lean;
    u.pack.rotation.x = e.lean;
    u.blob.position.y = 0.02;
  }
}

export default EntityManager;
