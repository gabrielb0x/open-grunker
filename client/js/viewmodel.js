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
 * Reloads are staged rather than a single swing — magazine out, magazine in,
 * action cycled — with a per-weapon flavour, because the reload is the
 * animation a player watches more than any other.
 */
import * as THREE from 'three';
import { SKINS, MAT } from '/shared/weapons.js';
import { settings } from './settings.js';

/** Where the gun rests when hip-firing, before per-player offsets. */
const HIP = { x: 0.24, y: -0.2, z: -0.46 };
/** How far in front of the eye the aligned sight sits when aiming. */
const ADS_Z = -0.42;
const AKIMBO_OFFSET = 0.5;

/** Shading per model material — this is what separates steel from polymer. */
const FINISH = {
  [MAT.METAL]: { shininess: 78, specular: 0x8b939c, emissive: 0x05070a },
  [MAT.ALLOY]: { shininess: 46, specular: 0xa9b2bd, emissive: 0x070a0d },
  [MAT.POLY]: { shininess: 14, specular: 0x2a2e33, emissive: 0x050607 },
  [MAT.WOOD]: { shininess: 26, specular: 0x4a3a28, emissive: 0x0a0705 },
  [MAT.RUBBER]: { shininess: 3, specular: 0x101214, emissive: 0x030405 },
  [MAT.GLASS]: { shininess: 110, specular: 0xcfe8ff, emissive: 0x0a1a24 },
};

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

    this.hands = this._buildHands();
    this.root.add(this.hands);

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

  _buildHands() {
    const g = new THREE.Group();
    const sleeve = new THREE.MeshPhongMaterial({ color: 0x333b47, shininess: 8, specular: 0x1a1f26 });
    const glove = new THREE.MeshPhongMaterial({ color: 0x2a2f37, shininess: 16, specular: 0x22272e });
    const skin = new THREE.MeshPhongMaterial({ color: 0xc28f68, shininess: 12, specular: 0x2a201a });

    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.125, 0.4), sleeve);
    fore.position.set(0.055, -0.195, 0.2);
    fore.rotation.x = 0.26;
    const wrist = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.11, 0.09), skin);
    wrist.position.set(0.05, -0.165, 0.01);
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.12, 0.13), glove);
    palm.position.set(0.05, -0.15, -0.06);
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.04, 0.09), glove);
    thumb.position.set(0.0, -0.115, -0.06);
    thumb.rotation.z = 0.4;
    g.add(fore, wrist, palm, thumb);

    // The support hand — parented separately so a reload can pull it away.
    this.support = new THREE.Group();
    const sFore = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.115, 0.34), sleeve);
    sFore.position.set(-0.13, -0.235, 0.05);
    sFore.rotation.set(0.1, 0.32, 0);
    const sHand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.11, 0.16), glove);
    sHand.position.set(-0.085, -0.19, -0.14);
    sHand.rotation.set(0.22, 0.3, 0);
    this.support.add(sFore, sHand);
    g.add(this.support);
    return g;
  }

  /** Rebuilds the gun mesh for a weapon definition. */
  setWeapon(def, skinId = 'default') {
    this.def = def;
    this._clear(this.gun);
    if (this.gunB) { this._clear(this.gunB); this.root.remove(this.gunB); this.gunB = null; }
    for (const k of Object.keys(this.tagged)) this.tagged[k].length = 0;
    this.tagHome.clear();

    const skin = SKINS[skinId] ?? SKINS.default;
    const scale = def.model?.scale ?? 1;

    const build = (collectTags) => {
      const grp = new THREE.Group();
      for (const p of def.model?.parts ?? []) {
        const color = new THREE.Color(p.c);
        const finish = FINISH[p.m] ?? FINISH[MAT.POLY];
        if (skin.tint !== null && p.m !== MAT.EMIT && p.m !== MAT.GLASS) {
          color.lerp(new THREE.Color(skin.tint), 0.66);
        }
        const material = p.m === MAT.EMIT
          ? new THREE.MeshBasicMaterial({ color: p.c })
          : new THREE.MeshPhongMaterial({
            color: color.getHex(),
            shininess: finish.shininess * (1 + (skin.gloss ?? 0) * 0.8),
            specular: new THREE.Color(finish.specular).multiplyScalar(1 + (skin.gloss ?? 0) * 0.5),
            emissive: finish.emissive,
          });
        const m = new THREE.Mesh(new THREE.BoxGeometry(p.s[0], p.s[1], p.s[2]), material);
        m.position.set(p.p[0], p.p[1], p.p[2]);
        if (p.r) m.rotation.set(p.r[0], p.r[1], p.r[2]);
        grp.add(m);
        if (collectTags && p.tag && this.tagged[p.tag]) {
          this.tagged[p.tag].push(m);
          this.tagHome.set(m, m.position.clone());
        }
      }
      return grp;
    };

    const primary = build(true);
    this.gun.add(primary);
    this.gun.scale.setScalar(scale);

    if (def.akimbo) {
      this.gunB = build(false);
      this.gunB.scale.setScalar(scale);
      this.root.add(this.gunB);
      this.hands.visible = false;
    } else {
      this.hands.visible = !def.melee;
      this.support.visible = !def.melee && def.kind !== 'pistol';
    }

    const muzzle = def.model?.muzzle ?? [0, 0, -0.6];
    this.flash.position.set(muzzle[0], muzzle[1], muzzle[2] - 0.05);
    this.gun.add(this.flash);
    this.muzzleLocal = new THREE.Vector3(...muzzle);
    this.ejectLocal = def.model?.eject ? new THREE.Vector3(...def.model.eject) : null;

    // The whole ADS pose falls out of where the sights are.
    const sight = def.model?.sight ?? [0, 0.08, 0];
    this.adsPose = {
      x: -sight[0] * scale,
      y: -sight[1] * scale,
      z: ADS_Z - sight[2] * scale,
    };

    this.shotCount = 0;
    this.reloadT = 0;
    this.cycleT = 0;
    this.slashT = 0;
    this.drawT = 0.28;                        // a short raise whenever we swap
  }

  _clear(group) {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const c = group.children[i];
      if (c === this.flash) { group.remove(c); continue; }
      group.remove(c);
      c.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    }
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
    const baseX = (HIP.x + ox) * hand + ((ap.x * hand) - (HIP.x + ox) * hand) * t;
    const baseY = (HIP.y + oy) + (ap.y - (HIP.y + oy)) * t;
    const baseZ = (HIP.z + oz) + (ap.z - (HIP.z + oz)) * t;

    // A draw dip whenever the weapon is swapped in.
    const draw = this.drawT > 0 ? (this.drawT / 0.28) ** 2 : 0;

    this.root.position.set(
      baseX + (bobX * 1.6 + this.sway.x * swayScale + this.lag.x * swayScale + breatheX
        + (slash?.x ?? 0)) * hand,
      baseY + bobY + this.sway.y * swayScale + this.lag.y * swayScale + breatheY
        + (r?.y ?? 0) + (slash?.y ?? 0) - this.landDip - (sliding ? 0.05 : 0) - draw * 0.22,
      baseZ + this.recoil.z * 0.05 + (r?.z ?? 0) + (slash?.z ?? 0) - cycle * 0.012,
    );
    this.root.rotation.set(
      -this.recoil.pitch * 0.022 + (r?.pitch ?? 0) + (slash?.pitch ?? 0)
        + this.sway.y * 0.9 + this.lag.y * 1.4 + draw * 0.5,
      (this.sway.x * -1.1 + this.lag.x * -1.5 + (r?.yaw ?? 0) + (slash?.yaw ?? 0)
        + this.recoil.yaw * 0.01) * hand,
      (this.recoil.roll * 0.013 + (sliding ? 0.16 : 0) + bobX * 3 + (r?.roll ?? 0)
        + (slash?.roll ?? 0) + draw * 0.3) * hand,
    );

    if (this.support) {
      // The support hand drops away while the reload needs it elsewhere.
      const away = r?.support ?? 0;
      this.support.position.set(-away * 0.16, -away * 0.3, away * 0.12);
      this.support.rotation.z = away * 0.9;
      this.support.visible = !this.def?.melee && this.def?.kind !== 'pistol' && away < 0.98;
    }

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
