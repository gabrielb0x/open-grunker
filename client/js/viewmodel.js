/**
 * Open Grunker — first-person weapon.
 *
 * The viewmodel lives in its own scene with its own fixed-FOV camera, drawn
 * after the world with the depth buffer cleared. That keeps the gun from
 * ballooning when the main camera's FOV drops for aim-down-sights, and stops it
 * clipping through walls.
 *
 * Aim-down-sights is derived, never hand-tuned: every weapon declares the point
 * on itself that must line up with the crosshair (`model.sight`), and the ADS
 * pose is simply the transform that puts that point dead centre. Add a gun,
 * mark its rear notch, and it aims correctly the first time.
 *
 * ── The hands ──────────────────────────────────────────────────────────────
 * The arms are not decoration parked near the weapon. Every model declares
 * where its two hands go — `model.grip` for the trigger hand, `model.fore` for
 * the support hand, with `gripTilt` raking the first one along the grip and
 * `foreKind` saying what the second one is holding on to. An articulated hand
 * is built at each anchor: palm, four fingers, a thumb, an index finger laid on
 * the trigger, a bare wrist and a sleeved forearm running out of frame toward
 * the shoulder. Change a gun's grip and the fingers follow it, because they are
 * placed from the same numbers the grip is.
 *
 * The gloves take their colour from the equipped finish, so a skin is something
 * the player wears as well as something they carry.
 *
 * Reloads are staged rather than a single swing — magazine out, magazine in,
 * action cycled — with a per-weapon flavour, because the reload is the
 * animation a player watches more than any other.
 */
import * as THREE from 'three';
import { SKINS, gloveColor } from '/shared/weapons.js';
import { buildWeaponMesh, collapseStatic, skinnedBoxGeometry } from './gunskin.js';
import { settings } from './settings.js';

/** Where the gun rests when hip-firing, before per-weapon and per-player offsets. */
const HIP = { x: 0.2, y: -0.19, z: -0.46 };
/** How far in front of the eye the aligned sight sits when aiming. */
const ADS_Z = -0.42;
const AKIMBO_OFFSET = 0.5;

/**
 * Where each class of weapon rests, on top of `HIP`.
 *
 * A rifle is long and is held into the shoulder; a pistol is short and is held
 * out at arm's length, higher and closer to the sight line. Framing them
 * identically is what used to push a rifle's butt stock behind the camera and
 * leave a pistol's hands below the bottom of the screen.
 *
 * `[x, y, z]`, plus an optional `[pitch, yaw, roll]` for the two weapons that
 * are not pointed at anything: a knife held square to the camera is a blade
 * seen end-on, and a rocket tube is carried across the shoulder rather than
 * levelled. Both are turned so you can see what you are holding.
 *
 * Applied to the hip pose only — the aim-down-sights pose is derived from the
 * sights and must not be nudged by anything.
 */
const REST = {
  rifle: [0, 0.01, -0.3],
  sniper: [0, 0, -0.4],
  smg: [0, 0.02, -0.3],
  lmg: [0, 0, -0.38],
  dmr: [0, 0.01, -0.3],
  shotgun: [0, 0.01, -0.37],
  rpg: [0.01, 0.02, -0.5, -0.05, 0.2, -0.12],
  revolver: [-0.01, 0.09, -0.22],
  pistol: [-0.01, 0.1, -0.22],
  akimbo: [0, 0.085, -0.18],
  knife: [0.02, 0.02, -0.2, -0.1, 0.66, 0.3],
};

/* ── Hands ───────────────────────────────────────────────────────────────── */

const SLEEVE = 0x2f353f;
const SKIN_TONE = 0xc79470;
const PAD = 0x1b1f25;

const handMatCache = new Map();

/** The five materials one pair of gloves needs, cached per finish colour. */
function handMaterials(glove) {
  let set = handMatCache.get(glove);
  if (set) return set;
  const phong = (color, shininess, specular) => {
    const m = new THREE.MeshPhongMaterial({ color, shininess, specular });
    // Cached and reused by every weapon this player ever draws, so `_clear`
    // must leave it alone — see the note there.
    m.userData.shared = true;
    return m;
  };
  const g = new THREE.Color(glove);
  set = {
    sleeve: phong(SLEEVE, 6, 0x14181d),
    cuff: phong(g.clone().multiplyScalar(0.55).getHex(), 12, 0x1c2128),
    skin: phong(SKIN_TONE, 10, 0x2a201a),
    glove: phong(glove, 18, g.clone().multiplyScalar(0.35).getHex()),
    pad: phong(PAD, 4, 0x101317),
  };
  handMatCache.set(glove, set);
  return set;
}

/**
 * One box of a hand.
 *
 * `sx` mirrors the whole rig for the left hand, which is why every offset below
 * is written for the right one and nothing is duplicated.
 */
function bone(group, mat, sx, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(skinnedBoxGeometry(w, h, d), mat);
  m.position.set(x * sx, y, z);
  m.rotation.set(rx, ry * sx, rz * sx);
  group.add(m);
  return m;
}

/**
 * A hand closed around a vertical column — a pistol grip, a vertical foregrip.
 *
 * The origin is the axis of whatever is being held. Palm behind and outboard,
 * the three lower fingers wrapping across the front, the thumb laid up the
 * inboard side, and the index finger reaching forward onto the trigger instead
 * of curling with the rest. That last one is the detail that makes a fist read
 * as a hand *on a gun* rather than a fist.
 */
function wrapHand(g, m, sx) {
  bone(g, m.glove, sx, 0.056, 0.13, 0.056, 0.016, 0.005, 0.058);        // palm
  bone(g, m.glove, sx, 0.056, 0.062, 0.062, 0.022, -0.062, 0.05);       // heel
  bone(g, m.glove, sx, 0.064, 0.038, 0.05, 0.012, 0.064, 0.03);         // knuckles
  bone(g, m.pad, sx, 0.066, 0.014, 0.04, 0.012, 0.082, 0.03);           // knuckle plate
  const rows = [0.05, 0.016, -0.018, -0.05];
  for (let i = 0; i < rows.length; i++) {
    const y = rows[i];
    bone(g, m.glove, sx, 0.032, 0.03, 0.072, 0.03, y, 0.012);           // proximal
    if (i === 0) {
      // Index: straight forward, on the trigger.
      bone(g, m.glove, sx, 0.028, 0.026, 0.08, 0.028, y, -0.052);
      bone(g, m.pad, sx, 0.03, 0.012, 0.03, 0.028, y - 0.012, -0.082);
    } else {
      bone(g, m.glove, sx, 0.078, 0.028, 0.032, -0.004, y, -0.032);     // distal, across the front
      bone(g, m.pad, sx, 0.03, 0.026, 0.03, -0.03, y, -0.034);
    }
  }
  bone(g, m.glove, sx, 0.034, 0.044, 0.05, -0.022, 0.03, 0.045);        // thumb metacarpal
  bone(g, m.glove, sx, 0.032, 0.034, 0.078, -0.034, 0.026, -0.006, 0, 0, 0.2);
  bone(g, m.skin, sx, 0.064, 0.072, 0.058, 0.028, -0.105, 0.07);        // bare wrist
}

/**
 * A hand closed around a horizontal tube — a handguard, a pump, a knife handle.
 *
 * Origin on the tube's axis. The palm sits inboard and under, the fingers run
 * up the far side one behind the other, and the thumb lies along the top
 * pointing at the muzzle: the C-clamp everybody actually shoots with.
 */
function clampHand(g, m, sx) {
  bone(g, m.glove, sx, 0.05, 0.075, 0.115, -0.05, -0.014, 0);           // palm
  bone(g, m.glove, sx, 0.05, 0.062, 0.072, -0.054, -0.058, 0.048);      // heel
  const cols = [0.052, 0.018, -0.016, -0.05];
  for (let i = 0; i < cols.length; i++) {
    const z = cols[i];
    bone(g, m.glove, sx, 0.05, 0.03, 0.032, -0.028, -0.052, z);         // under the tube
    bone(g, m.glove, sx, 0.03, 0.056, 0.032, 0.008, -0.03, z);          // up the far side
    bone(g, m.pad, sx, 0.028, 0.03, 0.03, 0.01, 0.0, z);
  }
  bone(g, m.glove, sx, 0.044, 0.038, 0.034, -0.036, 0.03, 0.05);        // thumb metacarpal
  bone(g, m.glove, sx, 0.032, 0.032, 0.082, -0.024, 0.038, -0.008, 0.18, 0, 0);
  bone(g, m.skin, sx, 0.058, 0.062, 0.066, -0.062, -0.05, 0.082);       // bare wrist
}

/** A relaxed, half-open hand — what the empty hand does while a knife is out. */
function openHand(g, m, sx) {
  bone(g, m.glove, sx, 0.052, 0.108, 0.062, 0, 0, 0.02);
  bone(g, m.glove, sx, 0.054, 0.05, 0.058, 0.004, -0.058, 0.026);
  const rows = [0.046, 0.014, -0.018, -0.05];
  for (const y of rows) {
    bone(g, m.glove, sx, 0.03, 0.028, 0.08, 0.012, y, -0.05, -0.35);
    bone(g, m.pad, sx, 0.028, 0.024, 0.03, 0.012, y - 0.026, -0.086);
  }
  bone(g, m.glove, sx, 0.032, 0.04, 0.05, -0.03, 0.028, 0.008, 0, 0, 0.3);
  bone(g, m.skin, sx, 0.06, 0.068, 0.06, 0.006, -0.1, 0.04);
}

const HANDS = { wrap: wrapHand, clamp: clampHand, open: openHand };

/**
 * A whole arm: a hand at the origin and a sleeved forearm running out of it.
 *
 * The forearm is a child group aimed by two angles rather than a hand-placed
 * box, so it always leaves the hand travelling down, back and outboard — into
 * the bottom corner of the frame, which is where an arm attached to a shoulder
 * you cannot see has to go.
 */
function buildArm({ pose, side, glove, tiltX = 1.3, tiltY = 0.4 }) {
  const g = new THREE.Group();
  const m = handMaterials(glove);
  (HANDS[pose] ?? wrapHand)(g, m, side);

  /*
   * The forearm runs steeply down and only slightly back.
   *
   * The angle is not a style choice. A forearm aimed *backwards* from a hand
   * that is already a third of a metre from the eye reaches the camera and out
   * the other side, and a box straddling the near plane projects across the
   * whole screen — which is exactly how an arm ends up looking like a plank
   * laid over the view. Steep keeps every vertex comfortably in front of the
   * eye and puts the elbow where an elbow belongs: off the bottom of the frame.
   */
  const fore = new THREE.Group();
  fore.position.set(0.03 * side, -0.1, 0.07);
  fore.rotation.set(tiltX, tiltY * side, 0);
  bone(fore, m.cuff, side, 0.086, 0.09, 0.045, 0, 0, 0.036);
  bone(fore, m.sleeve, side, 0.082, 0.086, 0.17, 0, 0, 0.145);
  bone(fore, m.sleeve, side, 0.094, 0.098, 0.18, 0, 0, 0.3);
  bone(fore, m.cuff, side, 0.098, 0.03, 0.085, 0, 0.05, 0.27);
  g.add(fore);
  // Nothing on a hand moves once it is built: the fingers are placed on the
  // grip and stay there. Welding the dozen boxes into four meshes takes the
  // pair of arms from roughly thirty draw calls a frame to eight.
  return collapseStatic(g);
}

/** Which hand shape holds what. */
const POSE_FOR = { fore: 'clamp', pump: 'clamp', vert: 'wrap', cup: 'wrap', idle: 'open' };

export class ViewModel {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.viewmodelFov ?? 64, 1, 0.01, 12);

    // A three-point rig: warm key from the upper left, cool rim from behind
    // right, and a soft ambient so nothing on the gun goes to pure black.
    this.scene.add(new THREE.AmbientLight(0x9fb4cc, 0.85));
    this.key = new THREE.DirectionalLight(0xfff2e0, 1.5);
    this.key.position.set(-0.7, 1.3, 0.85);
    this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0x88aaff, 0.75);
    this.rim.position.set(0.95, -0.2, -0.9);
    this.scene.add(this.rim);
    this.bounce = new THREE.DirectionalLight(0xffd9a8, 0.28);
    this.bounce.position.set(0.2, -1, 0.4);
    this.scene.add(this.bounce);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.gun = new THREE.Group();
    this.gunB = null;                 // second gun for akimbo classes
    this.root.add(this.gun);

    /** The two arms, rebuilt per weapon because they are posed on its grips. */
    this.armMain = null;
    this.armOff = null;
    /** Kept for the akimbo pair — the off hand rides the second gun. */
    this.armB = null;

    /** Parts the animation moves independently, collected by their tag. */
    this.tagged = { mag: [], bolt: [], pump: [], cyl: [], slide: [] };
    this.tagHome = new Map();

    // Muzzle flash: an emissive plate + a flash light, both toggled per shot.
    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.36, 0.36),
      new THREE.MeshBasicMaterial({
        color: 0xfff2c0, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    );
    this.flashLight = new THREE.PointLight(0xffd27a, 0, 3.4);
    this.scene.add(this.flashLight);
    this.flashTime = 0;

    // Animation state
    this.bobPhase = 0;
    this.breathe = 0;
    this.recoil = { z: 0, pitch: 0, roll: 0, yaw: 0, vz: 0, vp: 0, vr: 0, vy: 0 };
    this.sway = { x: 0, y: 0 };
    this.lag = { x: 0, y: 0 };
    this.adsAmount = 0;
    this.reloadT = 0;
    this.reloadDur = 0;
    this.reloadKind = 'mag';
    this.cycleT = 0;
    this.cycleDur = 0;
    this.drawT = 0;
    this.landDip = 0;
    this.rest = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
    /** Knife swing: seconds left, total length, and which way it travels. */
    this.slashT = 0;
    this.slashDur = 0;
    this.slashSide = 1;
    this.visible = true;
    this.hiddenForScope = false;
    this.shotCount = 0;
    this.akimboSide = 1;
    this._ejectTimer = 0;
    this._ejectAfter = 0;
    this.reloadEmpty = false;
    this.onEject = null;              // (localPos, localVel, scale) => void
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this.resize();
  }

  /* ── Building ──────────────────────────────────────────────────────────── */

  /** Rebuilds the gun mesh, and the hands that hold it, for a weapon definition. */
  setWeapon(def, skinId = 'default') {
    this.def = def;
    this.skinId = skinId;
    this.builtLeftHanded = !!settings.leftHanded;
    this._clear(this.gun);
    if (this.gunB) { this._clear(this.gunB); this.root.remove(this.gunB); this.gunB = null; }
    for (const arm of [this.armMain, this.armOff]) if (arm) this._clear(arm, true);
    this.armMain = this.armOff = this.armB = null;
    for (const k of Object.keys(this.tagged)) this.tagged[k].length = 0;
    this.tagHome.clear();

    const skin = SKINS[skinId] ?? SKINS.default;
    const model = def.model ?? {};
    const scale = model.scale ?? 1;
    const glove = gloveColor(skin);

    // Everything but the moving parts is welded into one mesh per material —
    // about forty draw calls a frame back, on the one object that is on screen
    // for the whole match. `_applyTagged` still gets its own magazine.
    const primary = buildWeaponMesh(def, skin, { collapse: 'static' });
    for (const [tag, mesh] of primary.userData.tagged) {
      if (!this.tagged[tag]) continue;
      this.tagged[tag].push(mesh);
      this.tagHome.set(mesh, mesh.position.clone());
    }
    this.gun.add(primary);
    this.gun.scale.setScalar(scale);

    /* Hands, placed on this weapon's own grips. */
    const hand = settings.leftHanded ? -1 : 1;
    const gripAt = model.grip ?? [0, -0.16, 0.08];
    const mainPose = model.gripAxis === 'z' ? 'clamp' : 'wrap';
    this.armMain = buildArm({ pose: mainPose, side: hand, glove });
    this.armMain.position.set(gripAt[0] * scale * hand, gripAt[1] * scale, gripAt[2] * scale);
    this.armMain.rotation.x = model.gripTilt ?? 0;
    this.root.add(this.armMain);

    const foreKind = model.foreKind ?? 'fore';
    if (model.fore && foreKind !== 'none') {
      this.armOff = buildArm({
        pose: POSE_FOR[foreKind] ?? 'clamp',
        side: -hand,
        glove,
        tiltX: foreKind === 'cup' ? 1.34 : 1.25,
        tiltY: 0.55,
      });
      this.armOff.position.set(model.fore[0] * scale * hand, model.fore[1] * scale, model.fore[2] * scale);
      this.armOff.rotation.x = foreKind === 'vert' ? -0.12 : foreKind === 'cup' ? 0.2 : 0;
      this.root.add(this.armOff);
    }

    if (def.akimbo) {
      // The off hand's gun is never animated — only the primary registers tags.
      this.gunB = buildWeaponMesh(def, skin, { collapse: 'all' });
      this.gunB.scale.setScalar(scale);
      this.root.add(this.gunB);
      // The second gun carries its own hand, so the pair reads as two weapons
      // held rather than one weapon and a spare.
      this.armB = buildArm({ pose: 'wrap', side: -hand, glove });
      this.armB.position.set(gripAt[0] * scale * -hand, gripAt[1] * scale, gripAt[2] * scale);
      this.armB.rotation.x = model.gripTilt ?? 0;
      this.gunB.add(this.armB);
    }

    const muzzle = model.muzzle ?? [0, 0, -0.6];
    this.flash.position.set(muzzle[0], muzzle[1], muzzle[2] - 0.05);
    this.gun.add(this.flash);
    this.muzzleLocal = new THREE.Vector3(...muzzle);
    this.ejectLocal = model.eject ? new THREE.Vector3(...model.eject) : null;

    // The whole ADS pose falls out of where the sights are.
    const sight = model.sight ?? [0, 0.08, 0];
    this.adsPose = {
      x: -sight[0] * scale,
      y: -sight[1] * scale,
      z: ADS_Z - sight[2] * scale,
    };
    const rest = REST[def.kind] ?? [0, 0, 0];
    this.rest = {
      x: rest[0], y: rest[1], z: rest[2],
      pitch: rest[3] ?? 0, yaw: rest[4] ?? 0, roll: rest[5] ?? 0,
    };

    this.shotCount = 0;
    this.reloadT = 0;
    this.cycleT = 0;
    this.slashT = 0;
    this.drawT = 0.28;                        // a short raise whenever we swap
  }

  /**
   * Empties a group.
   *
   * Geometry and materials marked `shared` belong to the finish cache and are
   * reused by every weapon and every player wearing it — disposing one here
   * would blank a gun somebody else is holding.
   */
  _clear(group, detach = false) {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const c = group.children[i];
      if (c === this.flash) { group.remove(c); continue; }
      group.remove(c);
      c.traverse?.((o) => {
        if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose?.();
        if (o.material && !o.material.userData?.shared) o.material.dispose?.();
      });
    }
    if (detach) group.parent?.remove(group);
  }

  /* ── Events ────────────────────────────────────────────────────────────── */

  fire() {
    this.shotCount++;
    const kick = this.def?.recoil?.up ?? this.def?.recoilV ?? 0.02;
    const heavy = Math.min(2.4, 0.6 + kick * 34);
    this.recoil.vz += 1.5 + heavy * 1.6;
    this.recoil.vp += 4.2 + heavy * 4.4;
    this.recoil.vr += (Math.random() * 2 - 1) * (2.4 + heavy);
    this.recoil.vy += (Math.random() * 2 - 1) * heavy * 0.9;
    this.flashTime = 0.042;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.material.opacity = 1;
    this.flash.scale.setScalar(0.85 + Math.random() * 0.5);
    this.flashLight.intensity = 3.2;
    if (this.gunB) this.akimboSide *= -1;

    // Bolt-action and pump guns cycle their action visibly after the shot.
    if (this.def?.boltTime) {
      this.cycleT = this.def.boltTime;
      this.cycleDur = this.def.boltTime;
    } else if (this.tagged.slide.length || this.tagged.bolt.length) {
      this.cycleT = 0.07;
      this.cycleDur = 0.07;
    }
    this._ejectAfter = this.def?.shell?.delay ?? 0;
    if (!this._ejectAfter) this._doEject();
    else this._ejectTimer = this._ejectAfter;
  }

  _doEject() {
    if (!this.onEject || !this.ejectLocal || !this.def?.shell) return;
    const scale = this.def.model?.scale ?? 1;
    this._v.copy(this.ejectLocal).multiplyScalar(scale);
    this.gun.localToWorld(this._v);
    // The viewmodel scene is camera-local, so this offset is already relative
    // to the eye — the game layer rotates it into the world.
    this._v2.set(2.2 + Math.random() * 1.4, 1.6 + Math.random() * 1.2, 0.6 + Math.random() * 0.8);
    this.onEject(this._v, this._v2, this.def.shell.size ?? 1);
  }

  /**
   * The knife attack.
   *
   * A slash is three beats, not a shove: the blade cocks back and inward over
   * the first fifth of the move, crosses the screen fast through the middle,
   * and settles back to the guard over the tail. `_slashPose` below is the
   * curve; this only starts it, and alternates the direction so a second swing
   * comes back the other way instead of replaying the first one.
   *
   * The kick that used to be the whole animation is still here, dialled well
   * down — it is the weight behind the swing now rather than a stand-in for it.
   */
  meleeSwing(duration = 0.42) {
    this.slashDur = Math.max(0.12, duration);
    this.slashT = this.slashDur;
    this.slashSide *= -1;
    this.recoil.vp += 2.2;
    this.recoil.vz += 0.6;
  }

  /**
   * Where the knife is at `t` (0-1) through a swing.
   *
   * Windup is slow and small, the cut is fast and wide, the recovery is a
   * settle. Reading the three phases off one eased parameter is what keeps the
   * blade from arriving before the arm does.
   */
  _slashPose(t) {
    const side = this.slashSide;
    // 0 → back at the shoulder, 1 → through and across, easing out at the end.
    const wind = t < 0.22 ? t / 0.22 : 1;
    const cut = t < 0.22 ? 0 : Math.min(1, (t - 0.22) / 0.34);
    const cutEase = 1 - (1 - cut) ** 3;
    const settle = t < 0.56 ? 0 : (t - 0.56) / 0.44;
    const through = cutEase * (1 - settle * 0.86);
    const back = wind * (1 - cutEase);

    return {
      // Cocked in and back, then thrown across and slightly down.
      x: (back * 0.16 - through * 0.30) * side,
      y: back * 0.10 - through * 0.13,
      z: back * 0.14 - through * 0.22,
      pitch: -back * 0.55 + through * 0.75,
      yaw: (back * 0.65 - through * 1.15) * side,
      roll: (back * -0.5 + through * 1.5) * side,
    };
  }

  /**
   * @param {number} duration seconds
   * @param {boolean} fromEmpty an empty reload also cycles the action
   */
  reload(duration, fromEmpty = false) {
    this.reloadT = duration;
    this.reloadDur = duration;
    this.reloadEmpty = fromEmpty;
    const kind = this.def?.kind ?? 'rifle';
    this.reloadKind = kind === 'revolver' ? 'cylinder'
      : kind === 'shotgun' ? 'shells'
        : kind === 'rpg' ? 'tube' : 'mag';
  }

  land(hard) {
    this.landDip = hard ? 0.085 : 0.04;
  }

  addSway(dx, dy) {
    this.sway.x += dx * 0.5;
    this.sway.y += dy * 0.5;
  }

  /** Look delta from the input layer, so the gun lags behind a fast flick. */
  addLookLag(dyaw, dpitch) {
    this.lag.x = Math.max(-0.09, Math.min(0.09, this.lag.x - dyaw * 0.55));
    this.lag.y = Math.max(-0.07, Math.min(0.07, this.lag.y + dpitch * 0.45));
  }

  /* ── Reload choreography ───────────────────────────────────────────────── */

  /**
   * Returns the reload's contribution to the pose plus how far the magazine has
   * been pulled out, for progress `p` in [0,1].
   */
  _reloadPose(p) {
    const out = { y: 0, z: 0, pitch: 0, roll: 0, yaw: 0, mag: 0, magSpin: 0, support: 0 };
    const ease = (t) => t * t * (3 - 2 * t);
    const seg = (a, b) => Math.max(0, Math.min(1, (p - a) / (b - a)));

    if (this.reloadKind === 'shells') {
      // Shell by shell: the gun rocks once per round, at 1/6 of the animation.
      const cyc = (p * 6) % 1;
      out.pitch = Math.sin(cyc * Math.PI) * 0.34;
      out.y = -Math.sin(cyc * Math.PI) * 0.085;
      out.roll = Math.sin(cyc * Math.PI * 2) * 0.1;
      out.support = Math.sin(cyc * Math.PI);
      return out;
    }
    if (this.reloadKind === 'cylinder') {
      const swing = Math.sin(Math.min(1, p * 1.1) * Math.PI);
      out.roll = swing * 1.0;
      out.pitch = swing * 0.5;
      out.y = -swing * 0.1;
      out.magSpin = seg(0.25, 0.75) * Math.PI * 2;
      out.support = swing;
      return out;
    }
    if (this.reloadKind === 'tube') {
      const swing = Math.sin(Math.min(1, p * 1.05) * Math.PI);
      out.pitch = swing * 0.62;
      out.yaw = swing * 0.35;
      out.y = -swing * 0.13;
      out.mag = seg(0.15, 0.5) - seg(0.5, 0.85);
      out.support = swing;
      return out;
    }

    // Magazine-fed: tilt in, drop the mag, slap a fresh one home, settle.
    const tilt = Math.min(1, p * 5) * (1 - ease(seg(0.78, 1)));
    out.pitch = tilt * 0.46;
    out.roll = tilt * 0.3;
    out.y = -tilt * 0.11;
    out.z = tilt * 0.06;
    // 0.10-0.34 the magazine falls away; 0.42-0.62 the new one goes in.
    const drop = ease(seg(0.1, 0.34));
    const insert = ease(seg(0.42, 0.62));
    out.mag = drop * (1 - insert);
    out.support = Math.max(ease(seg(0.06, 0.3)) * (1 - ease(seg(0.55, 0.75))), 0);
    if (this.reloadEmpty) {
      // A charge of the action once the fresh magazine is seated.
      const charge = Math.sin(Math.max(0, Math.min(1, seg(0.68, 0.9))) * Math.PI);
      out.bolt = charge;
      out.roll += charge * 0.16;
    }
    return out;
  }

  /* ── Frame ─────────────────────────────────────────────────────────────── */

  update(dt, st) {
    const { speed = 0, grounded = true, ads = false, sliding = false, scoped = false } = st;

    // ADS blend
    const adsSpeed = 1 / Math.max(0.05, this.def?.adsTime ?? 0.2);
    const wantAds = ads && this.reloadT <= 0;
    this.adsAmount += ((wantAds ? 1 : 0) - this.adsAmount) * Math.min(1, dt * adsSpeed * 3.2);

    // Hide the gun once a sniper is fully scoped — and, if the player asked for
    // it, whenever they are aiming at all. That one is theirs alone: it clears
    // the bottom of their own screen and changes nothing anybody else sees.
    const hideForAds = settings.hideWeaponAds && this.adsAmount > 0.55 && !this.def?.melee;
    this.hiddenForScope = (scoped && this.adsAmount > 0.85) || hideForAds;
    this.root.visible = this.visible && !this.hiddenForScope;

    // Weapon bob while running, plus a slow idle breathe when standing still.
    const bobbing = settings.viewBob && grounded && speed > 1.2 && this.adsAmount < 0.6;
    this.bobPhase += dt * Math.min(16, 4 + speed * 1.2);
    this.breathe += dt * 1.35;
    const bobAmp = bobbing ? Math.min(0.03, speed * 0.0028) * (1 - this.adsAmount) : 0;
    const bobX = Math.sin(this.bobPhase) * bobAmp;
    const bobY = Math.abs(Math.cos(this.bobPhase)) * bobAmp * 0.85;
    const idle = (1 - Math.min(1, speed / 3)) * (1 - this.adsAmount * 0.65);
    const breatheY = Math.sin(this.breathe) * 0.0035 * idle;
    const breatheX = Math.sin(this.breathe * 0.61) * 0.0028 * idle;

    // Sway and look-lag decay back to centre.
    this.sway.x += (0 - this.sway.x) * Math.min(1, dt * 9);
    this.sway.y += (0 - this.sway.y) * Math.min(1, dt * 9);
    this.lag.x += (0 - this.lag.x) * Math.min(1, dt * 8);
    this.lag.y += (0 - this.lag.y) * Math.min(1, dt * 8);
    const swayScale = 1 - this.adsAmount * 0.8;

    // Recoil spring — critically damped enough to settle before the next shot.
    const stiffness = 130, damping = 16;
    this.recoil.vz += (-this.recoil.z * stiffness - this.recoil.vz * damping) * dt;
    this.recoil.vp += (-this.recoil.pitch * stiffness - this.recoil.vp * damping) * dt;
    this.recoil.vr += (-this.recoil.roll * stiffness - this.recoil.vr * damping) * dt;
    this.recoil.vy += (-this.recoil.yaw * stiffness - this.recoil.vy * damping) * dt;
    this.recoil.z += this.recoil.vz * dt;
    this.recoil.pitch += this.recoil.vp * dt;
    this.recoil.roll += this.recoil.vr * dt;
    this.recoil.yaw += this.recoil.vy * dt;

    this.landDip *= Math.max(0, 1 - dt * 7);
    if (this.drawT > 0) this.drawT = Math.max(0, this.drawT - dt);

    // Knife swing, ahead of the pose below so it can ride on top of it.
    let slash = null;
    if (this.slashT > 0) {
      this.slashT = Math.max(0, this.slashT - dt);
      slash = this._slashPose(1 - this.slashT / this.slashDur);
    }

    // Delayed shell ejection (pump guns throw the case on the pump, not the shot).
    if (this._ejectTimer > 0) {
      this._ejectTimer -= dt;
      if (this._ejectTimer <= 0) { this._ejectTimer = 0; this._doEject(); }
    }

    // Action cycle: bolt back and forward, or the pump.
    let cycle = 0;
    if (this.cycleT > 0) {
      this.cycleT = Math.max(0, this.cycleT - dt);
      cycle = Math.sin((1 - this.cycleT / this.cycleDur) * Math.PI);
    }

    // Reload
    let r = null;
    if (this.reloadT > 0) {
      this.reloadT = Math.max(0, this.reloadT - dt);
      r = this._reloadPose(1 - this.reloadT / this.reloadDur);
    }

    this._applyTagged(cycle, r);

    const t = this.adsAmount;
    const ap = this.adsPose ?? { x: 0, y: -0.09, z: -0.32 };
    const hand = settings.leftHanded ? -1 : 1;
    const ox = (settings.viewmodelX ?? 0), oy = (settings.viewmodelY ?? 0), oz = (settings.viewmodelZ ?? 0);
    // The per-weapon rest offset belongs to the hip pose only: an aimed weapon
    // is placed by its sights and by nothing else.
    const hipX = HIP.x + ox + this.rest.x, hipY = HIP.y + oy + this.rest.y, hipZ = HIP.z + oz + this.rest.z;
    const baseX = hipX * hand + ((ap.x * hand) - hipX * hand) * t;
    const baseY = hipY + (ap.y - hipY) * t;
    const baseZ = hipZ + (ap.z - hipZ) * t;

    // A draw dip whenever the weapon is swapped in.
    const draw = this.drawT > 0 ? (this.drawT / 0.28) ** 2 : 0;

    this.root.position.set(
      baseX + (bobX * 1.6 + this.sway.x * swayScale + this.lag.x * swayScale + breatheX
        + (slash?.x ?? 0)) * hand,
      baseY + bobY + this.sway.y * swayScale + this.lag.y * swayScale + breatheY
        + (r?.y ?? 0) + (slash?.y ?? 0) - this.landDip - (sliding ? 0.05 : 0) - draw * 0.22,
      baseZ + this.recoil.z * 0.05 + (r?.z ?? 0) + (slash?.z ?? 0) - cycle * 0.012,
    );
    // The rest angle fades out with the rest offset: an aimed weapon is square.
    const rt = 1 - t;
    this.root.rotation.set(
      -this.recoil.pitch * 0.022 + (r?.pitch ?? 0) + (slash?.pitch ?? 0)
        + this.sway.y * 0.9 + this.lag.y * 1.4 + draw * 0.5 + this.rest.pitch * rt,
      (this.sway.x * -1.1 + this.lag.x * -1.5 + (r?.yaw ?? 0) + (slash?.yaw ?? 0)
        + this.recoil.yaw * 0.01 + this.rest.yaw * rt) * hand,
      (this.recoil.roll * 0.013 + (sliding ? 0.16 : 0) + bobX * 3 + (r?.roll ?? 0)
        + (slash?.roll ?? 0) + draw * 0.3 + this.rest.roll * rt) * hand,
    );

    this._poseSupport(r, cycle);

    if (this.gunB) {
      const side = this.akimboSide;
      this.gunB.position.set(-AKIMBO_OFFSET * (settings.leftHanded ? -1 : 1), 0, 0.02);
      this.gunB.rotation.set(this.root.rotation.x * 0.4 + (side < 0 ? -this.recoil.pitch * 0.02 : 0), 0, -this.recoil.roll * 0.01);
      this.gunB.visible = this.adsAmount < 0.7;
    }

    // Muzzle flash decay
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      const k = Math.max(0, this.flashTime / 0.042);
      this.flash.material.opacity = k;
      this.flashLight.intensity = k * 3.2;
      this.flashLight.position.copy(this.flash.getWorldPosition(this._v));
    } else if (this.flash.material.opacity !== 0) {
      this.flash.material.opacity = 0;
      this.flashLight.intensity = 0;
    }
  }

  /**
   * The support hand leaves the weapon when the reload needs it elsewhere, and
   * rides the pump when a pump gun cycles.
   */
  _poseSupport(r, cycle) {
    const arm = this.armOff;
    if (!arm) return;
    const away = r?.support ?? 0;
    const kind = this.def?.model?.foreKind;
    const home = this.def?.model?.fore ?? [0, 0, 0];
    const scale = this.def?.model?.scale ?? 1;
    const hand = settings.leftHanded ? -1 : 1;
    const pump = kind === 'pump' ? Math.max(cycle, away) * 0.17 : 0;
    arm.position.set(
      home[0] * scale * hand - away * 0.18 * hand,
      home[1] * scale - away * 0.32,
      home[2] * scale + away * 0.14 + pump,
    );
    arm.rotation.z = away * 0.9 * hand;
    arm.visible = away < 0.98;
  }

  /** Moves magazines, bolts, pumps and cylinders for the current animation. */
  _applyTagged(cycle, r) {
    const magOut = r?.mag ?? 0;
    for (const m of this.tagged.mag) {
      const home = this.tagHome.get(m);
      if (!home) continue;
      m.position.set(home.x, home.y - magOut * 0.32, home.z + magOut * 0.06);
      m.visible = magOut < 0.98;
      if (r?.magSpin) m.rotation.z = r.magSpin;
    }
    const boltPull = Math.max(cycle, r?.bolt ?? 0);
    for (const m of this.tagged.bolt) {
      const home = this.tagHome.get(m);
      if (home) m.position.set(home.x, home.y, home.z + boltPull * 0.13);
    }
    for (const m of this.tagged.slide) {
      const home = this.tagHome.get(m);
      if (home) m.position.set(home.x, home.y, home.z + cycle * 0.07);
    }
    for (const m of this.tagged.pump) {
      const home = this.tagHome.get(m);
      if (home) m.position.set(home.x, home.y, home.z + Math.max(cycle, r?.support ?? 0) * 0.17);
    }
    for (const m of this.tagged.cyl) {
      const home = this.tagHome.get(m);
      if (home) m.position.set(home.x - (r?.support ?? 0) * 0.07, home.y, home.z);
    }
  }

  applySettings() {
    const fov = settings.viewmodelFov ?? 64;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // The hands are mirrored at build time, not per frame, so switching hands
    // has to rebuild them — otherwise the gun swaps sides and the arms do not.
    if (this.def && !!settings.leftHanded !== this.builtLeftHanded) {
      this.setWeapon(this.def, this.skinId ?? 'default');
    }
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Drawn on top of the finished world with the depth buffer cleared. */
  render() {
    if (!this.root.visible) return;
    const auto = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = auto;
  }
}

export default ViewModel;
