/**
 * Open Grunker — tracers, impacts, decals, casings, blood, explosions.
 *
 * Everything is pooled and updated in one pass. Particles live in two Points
 * clouds — one additive for sparks and fire so they feed the bloom, one normal
 * for smoke, dust and blood — each driven by a small custom shader that gives
 * every particle its own size, rotation, colour and fade. Decals and shell
 * casings are single InstancedMeshes. Nothing allocates during a firefight, and
 * the whole system costs about six draw calls.
 */
import * as THREE from 'three';
import { SURFACE_FX } from '/shared/constants.js';
import { settings } from './settings.js';
import { spriteTexture } from './textures.js';

const MAX_PARTICLES = 1100;                 // per cloud
const MAX_TRACERS = 40;
const MAX_BLASTS = 8;
const MAX_FLASHES = 10;
const MAX_DECALS = 128;
const MAX_SHELLS = 28;

const PARTICLE_VS = /* glsl */`
attribute float size;
attribute float alpha;
attribute float rot;
attribute vec3 pcolor;
varying float vAlpha;
varying float vRot;
varying vec3 vColor;
uniform float uScale;
void main() {
  vAlpha = alpha;
  vRot = rot;
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * uScale / max(0.05, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying float vRot;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float s = sin(vRot), co = cos(vRot);
  vec2 uv = vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;
  vec4 t = texture2D(uMap, uv);
  if (t.a < 0.01) discard;
  gl_FragColor = vec4(vColor * t.rgb, vAlpha * t.a);
}`;

const DECAL_VS_HOOK = /* glsl */`
#include <common>
attribute float aAlpha;
varying float vDecalAlpha;
`;
const DECAL_FS_HOOK = /* glsl */`
#include <common>
varying float vDecalAlpha;
`;

/** One pooled particle cloud. */
class ParticleCloud {
  constructor(scene, { blending, texture, max = MAX_PARTICLES }) {
    this.max = max;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.rot = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('rot', new THREE.BufferAttribute(this.rot, 1));
    geo.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending,
      uniforms: { uMap: { value: texture }, uScale: { value: 320 } },
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);

    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.spin = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.baseAlpha = new Float32Array(max);
    this.head = 0;
    this.high = 0;
  }

  spawn(x, y, z, vx, vy, vz, color, size, life, opts = {}) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (i + 1 > this.high) this.high = i + 1;
    const j = i * 3;
    this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    this.col[j] = color.r; this.col[j + 1] = color.g; this.col[j + 2] = color.b;
    this.size[i] = size;
    this.baseSize[i] = size;
    this.alpha[i] = opts.alpha ?? 1;
    this.baseAlpha[i] = opts.alpha ?? 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = opts.gravity ?? 22;
    this.drag[i] = opts.drag ?? 0;
    this.spin[i] = opts.spin ?? 0;
    this.grow[i] = opts.grow ?? 0;
    this.rot[i] = opts.rot ?? Math.random() * Math.PI * 2;
  }

  update(dt) {
    // Nothing alive and nothing drawn: there is no buffer to re-upload and no
    // draw range to set. Between firefights this is the whole of the work, and
    // it used to be five full attribute uploads a frame — about twelve
    // thousand floats — for eleven hundred dead particles.
    if (this.high === 0) return 0;

    let live = 0;
    let last = -1;
    for (let i = 0; i < this.high; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      live++;
      last = i;
      const j = i * 3;
      const d = this.drag[i];
      if (d > 0) {
        const k = Math.max(0, 1 - d * dt);
        this.vel[j] *= k; this.vel[j + 1] *= k; this.vel[j + 2] *= k;
      }
      this.vel[j + 1] -= this.grav[i] * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      // Cheap bounce off the ground plane so debris settles instead of sinking.
      if (this.pos[j + 1] < 0.02) {
        this.pos[j + 1] = 0.02;
        this.vel[j + 1] *= -0.3;
        this.vel[j] *= 0.55;
        this.vel[j + 2] *= 0.55;
      }
      const t = this.life[i] / this.maxLife[i];
      this.rot[i] += this.spin[i] * dt;
      this.size[i] = this.baseSize[i] * (1 + this.grow[i] * (1 - t));
      // Hold full opacity for the first half of the life, then fade out.
      this.alpha[i] = this.baseAlpha[i] * Math.min(1, t / 0.5);
    }
    // The watermark follows the *live* tail rather than the write head, so a
    // cloud that fired once and settled shrinks back down instead of uploading
    // its whole capacity for the rest of the match.
    this.high = live === 0 ? 0 : last + 1;

    const geo = this.points.geometry;
    geo.setDrawRange(0, this.high);
    if (this.high > 0) {
      geo.attributes.position.needsUpdate = true;
      geo.attributes.pcolor.needsUpdate = true;
      geo.attributes.size.needsUpdate = true;
      geo.attributes.alpha.needsUpdate = true;
      geo.attributes.rot.needsUpdate = true;
    }
    return live;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.head = 0;
    this.high = 0;
    this.points.geometry.setDrawRange(0, 0);
  }
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.sparks = new ParticleCloud(scene, {
      blending: THREE.AdditiveBlending, texture: spriteTexture('spark'), max: MAX_PARTICLES,
    });
    this.smoke = new ParticleCloud(scene, {
      blending: THREE.NormalBlending, texture: spriteTexture('smoke'), max: MAX_PARTICLES,
    });
    this._initTracers();
    this._initBlasts();
    this._initFlashes();
    this._initDecals();
    this._initShells();
    this.tmpA = new THREE.Vector3();
    this.tmpB = new THREE.Vector3();
    this.tmpQ = new THREE.Quaternion();
    this.tmpM = new THREE.Matrix4();
    this.tmpS = new THREE.Vector3(1, 1, 1);
    this.up = new THREE.Vector3(0, 1, 0);
    this.onShellLand = null;
    this.budget = 1;
  }

  /** 0-1 scale applied to every particle count, driven by the quality setting. */
  setBudget(v) { this.budget = Math.max(0, Math.min(1, v)); }

  _count(n) {
    if (!settings.particles) return 0;
    const scaled = n * this.budget;
    const whole = Math.floor(scaled);
    return whole + (Math.random() < scaled - whole ? 1 : 0);
  }

  /**
   * A random direction inside a cone around `(nx, ny, nz)`, written into
   * `this.tmpA`.
   *
   * What comes off a surface leaves *along the surface's normal*, spread by
   * how rough the collision was. Spraying into a sphere and hoping — which is
   * the cheap version — puts half of every impact inside the wall it just hit,
   * where it is either invisible or, worse, visible through it.
   *
   * @param {number} spread 0 = straight out, 1 = a full hemisphere
   */
  _cone(nx, ny, nz, spread = 0.6) {
    // An orthonormal pair across the normal. The seed axis is whichever of X
    // or Y the normal is least parallel to, so the cross product never
    // degenerates on a wall or on a floor.
    const ax = Math.abs(nx) < 0.9 ? 1 : 0;
    const ay = Math.abs(nx) < 0.9 ? 0 : 1;
    let ux = ay * nz - 0 * ny;
    let uy = 0 * nx - ax * nz;
    let uz = ax * ny - ay * nx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;

    const a = Math.random() * Math.PI * 2;
    // sqrt keeps the distribution even across the cap instead of bunched at
    // the axis, which is what makes a spray read as a spray.
    const r = Math.sqrt(Math.random()) * spread;
    const k = Math.sqrt(Math.max(0, 1 - r * r));
    this.tmpA.set(
      nx * k + (ux * Math.cos(a) + vx * Math.sin(a)) * r,
      ny * k + (uy * Math.cos(a) + vy * Math.sin(a)) * r,
      nz * k + (uz * Math.cos(a) + vz * Math.sin(a)) * r,
    );
    return this.tmpA;
  }

  /* ── Tracers ───────────────────────────────────────────────────────────── */

  _initTracers() {
    this.tracers = [];
    // Tapering toward the far end reads as a round travelling, not a stick.
    const geo = new THREE.CylinderGeometry(0.16, 0.5, 1, 5, 1, true);
    geo.rotateX(Math.PI / 2);
    this.tracerGeo = geo;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffdc8c, transparent: true, opacity: 0, depthWrite: false, fog: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      this.tracers.push({ mesh, life: 0, maxLife: 0.07, peak: 0.9 });
    }
    this.tracerIndex = 0;
  }

  /** Draws a bullet trail between two world points. */
  tracer(from, to, { color = 0xffdc8c, width = 0.035, life = 0.07, bright = 1 } = {}) {
    if (!settings.tracers) return;
    const t = this.tracers[this.tracerIndex];
    this.tracerIndex = (this.tracerIndex + 1) % MAX_TRACERS;

    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return;

    t.mesh.position.set(from.x + dx / 2, from.y + dy / 2, from.z + dz / 2);
    t.mesh.lookAt(to.x, to.y, to.z);
    t.mesh.scale.set(width, width, len);
    t.mesh.material.color.setHex(color);
    t.peak = 0.85 * bright;
    t.mesh.material.opacity = t.peak;
    t.mesh.visible = true;
    t.life = life;
    t.maxLife = life;
  }

  _updateTracers(dt) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) { t.mesh.visible = false; t.mesh.material.opacity = 0; continue; }
      const k = t.life / t.maxLife;
      t.mesh.material.opacity = t.peak * k * k;
    }
  }

  /* ── Explosions ────────────────────────────────────────────────────────── */

  _initBlasts() {
    this.blasts = [];
    const core = new THREE.SphereGeometry(1, 12, 8);
    const ring = new THREE.RingGeometry(0.75, 1, 28);
    for (let i = 0; i < MAX_BLASTS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffb257, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false,
      });
      const mesh = new THREE.Mesh(core, mat);
      mesh.visible = false;
      this.scene.add(mesh);

      const shockMat = new THREE.MeshBasicMaterial({
        color: 0xffe6b0, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
      });
      const shock = new THREE.Mesh(ring, shockMat);
      shock.rotation.x = -Math.PI / 2;
      shock.visible = false;
      this.scene.add(shock);

      const light = new THREE.PointLight(0xff8a3d, 0, 26);
      this.scene.add(light);
      this.blasts.push({ mesh, shock, light, life: 0, maxLife: 0.5, radius: 5, peakLight: 12 });
    }
    this.blastIndex = 0;
  }

  /**
   * A rocket going off.
   *
   * Everything here scales off `radius`, which is the blast's real kill radius
   * as the server computed it — so a warhead that reaches further looks like
   * one, rather than a fixed puff of fire with a bigger number behind it. The
   * fireball, the ground shock, the light and how far the debris is thrown all
   * follow it; only the counts are capped, because particle budget is the
   * player's setting and not the weapon's.
   */
  explosion(x, y, z, radius = 5) {
    // 5.4 was the old blast; `k` is how much bigger this one is than that, and
    // it is deliberately sub-linear so a wide splash reads as heavy rather than
    // as a wall of orange filling the screen.
    const k = Math.sqrt(Math.max(0.5, radius / 5.4));

    const b = this.blasts[this.blastIndex];
    this.blastIndex = (this.blastIndex + 1) % MAX_BLASTS;
    b.mesh.position.set(x, y, z);
    b.mesh.visible = true;
    // A bigger fireball takes longer to collapse; it is more mass burning.
    b.maxLife = 0.5 * k;
    b.life = b.maxLife;
    b.radius = radius;
    b.shock.position.set(x, Math.max(0.05, y - radius * 0.35), z);
    b.shock.visible = true;
    b.light.position.set(x, y + 0.5, z);
    b.light.intensity = settings.dynamicLights ? 12 * k : 0;
    b.light.distance = radius * 5;
    b.peakLight = b.light.intensity;

    const fire = new THREE.Color(0xffb347);
    const hot = new THREE.Color(0xfff0c0);
    const dark = new THREE.Color(0x3a3a3a);
    const n = this._count(Math.round(30 * k));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      const sp = (8 + Math.random() * 18) * k;
      this.sparks.spawn(
        x, y, z,
        Math.sin(p) * Math.cos(a) * sp, Math.cos(p) * sp * 0.85 + 5 * k, Math.sin(p) * Math.sin(a) * sp,
        i % 3 === 0 ? hot : fire,
        (0.16 + Math.random() * 0.22) * k, 0.28 + Math.random() * 0.4,
        { gravity: 16, drag: 2.2 },
      );
    }
    // A rising smoke column that lingers after the fire is gone.
    const ns = this._count(Math.round(16 * k));
    for (let i = 0; i < ns; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (1.5 + Math.random() * 4.5) * k;
      this.smoke.spawn(
        x + Math.cos(a) * 0.6 * k, y + Math.random() * 0.8, z + Math.sin(a) * 0.6 * k,
        Math.cos(a) * sp, 2.4 + Math.random() * 3.4, Math.sin(a) * sp,
        dark, (0.9 + Math.random() * 0.9) * k, 1.3 + Math.random() * 1.1,
        { gravity: -1.2, drag: 1.5, grow: 1.9, spin: (Math.random() - 0.5) * 1.6 },
      );
    }
    const nd = this._count(Math.round(10 * k));
    for (let i = 0; i < nd; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (5 + Math.random() * 12) * k;
      this.smoke.spawn(x, y, z, Math.cos(a) * sp, (5 + Math.random() * 8) * k, Math.sin(a) * sp,
        new THREE.Color(0x6b6255), 0.1 + Math.random() * 0.14, 0.9 + Math.random() * 0.7,
        { gravity: 24 });
    }
  }

  _updateBlasts(dt) {
    for (const b of this.blasts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.mesh.visible = false; b.shock.visible = false; b.light.intensity = 0;
        continue;
      }
      const p = 1 - b.life / b.maxLife;
      b.mesh.scale.setScalar(b.radius * (0.2 + p * 0.85));
      b.mesh.material.opacity = 0.9 * (1 - p) ** 1.6;
      b.shock.scale.setScalar(b.radius * (0.4 + p * 2.2));
      b.shock.material.opacity = 0.65 * (1 - p) ** 2.2;
      b.light.intensity = (settings.dynamicLights ? (b.peakLight ?? 12) : 0) * (1 - p) ** 2;
    }
  }

  /* ── Muzzle flashes ────────────────────────────────────────────────────── */

  _initFlashes() {
    this.flashes = [];
    const geo = new THREE.PlaneGeometry(1, 1);
    const tex = spriteTexture('flash');
    for (let i = 0; i < MAX_FLASHES; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      this.scene.add(mesh);
      const light = new THREE.PointLight(0xffc978, 0, 9);
      this.scene.add(light);
      this.flashes.push({ mesh, light, life: 0, maxLife: 0.05, scale: 1 });
    }
    this.flashIndex = 0;
  }

  /**
   * A brief flare, a puff of propellant smoke and a light where a shot leaves a
   * barrel. This is what makes other players' fire readable in dark corners —
   * and it only ever appears where a shot actually came from.
   */
  muzzleFlash(x, y, z, scale = 1, dir = null) {
    const f = this.flashes[this.flashIndex];
    this.flashIndex = (this.flashIndex + 1) % MAX_FLASHES;
    f.mesh.position.set(x, y, z);
    f.mesh.rotation.z = Math.random() * Math.PI;
    f.scale = 0.62 * scale;
    f.mesh.scale.setScalar(f.scale);
    f.mesh.material.opacity = 1;
    f.mesh.visible = true;
    f.life = f.maxLife;
    if (settings.dynamicLights) {
      f.light.position.set(x, y, z);
      f.light.intensity = 6 * scale;
      f.light.distance = 11 * scale;
    }

    const n = this._count(3 * scale);
    const smokeCol = new THREE.Color(0x8d8b84);
    for (let i = 0; i < n; i++) {
      const d = dir ?? { x: 0, y: 0, z: 0 };
      this.smoke.spawn(
        x, y, z,
        d.x * 3 + (Math.random() - 0.5) * 1.6,
        d.y * 3 + 0.7 + Math.random() * 0.9,
        d.z * 3 + (Math.random() - 0.5) * 1.6,
        smokeCol, 0.14 + Math.random() * 0.12, 0.3 + Math.random() * 0.35,
        { gravity: -0.6, drag: 3.4, grow: 2.6, alpha: 0.5, spin: (Math.random() - 0.5) * 3 },
      );
    }
  }

  _updateFlashes(dt, camera) {
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.mesh.visible = false; f.mesh.material.opacity = 0; f.light.intensity = 0; continue; }
      const p = f.life / f.maxLife;
      f.mesh.material.opacity = p;
      f.mesh.scale.setScalar(f.scale * (1.25 - p * 0.25));
      f.light.intensity *= 0.68;
      if (camera) f.mesh.quaternion.copy(camera.quaternion);
    }
  }

  /* ── Decals ────────────────────────────────────────────────────────────── */

  /**
   * Bullet holes and blood, as two InstancedMeshes with a per-instance alpha
   * attribute — one draw call each, and they fade out instead of popping.
   */
  _initDecals() {
    this.decalSets = {};
    for (const kind of ['hole', 'blood']) {
      const geo = new THREE.PlaneGeometry(1, 1);
      const alphas = new Float32Array(MAX_DECALS);
      geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

      const material = new THREE.MeshBasicMaterial({
        map: spriteTexture(kind), transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
        fog: true, side: THREE.DoubleSide,
      });
      material.onBeforeCompile = (shader) => {
        if (!shader.vertexShader.includes('#include <common>')) return;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', DECAL_VS_HOOK)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vDecalAlpha = aAlpha;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', DECAL_FS_HOOK)
          .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragColor.a *= vDecalAlpha;');
      };
      material.customProgramCacheKey = () => 'og-decal';

      const mesh = new THREE.InstancedMesh(geo, material, MAX_DECALS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      mesh.count = MAX_DECALS;
      this.scene.add(mesh);

      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < MAX_DECALS; i++) mesh.setMatrixAt(i, zero);
      mesh.instanceMatrix.needsUpdate = true;

      this.decalSets[kind] = {
        mesh, alphas, geo,
        life: new Float32Array(MAX_DECALS),
        maxLife: new Float32Array(MAX_DECALS),
        head: 0,
      };
    }
  }

  /** Sticks a decal to a surface, oriented by its normal. */
  decal(kind, x, y, z, nx, ny, nz, size = 0.22, life = 14) {
    if (!settings.decals) return;
    const set = this.decalSets[kind];
    if (!set) return;
    const i = set.head;
    set.head = (set.head + 1) % MAX_DECALS;

    this.tmpA.set(nx, ny, nz);
    if (this.tmpA.lengthSq() < 1e-6) this.tmpA.set(0, 1, 0);
    this.tmpA.normalize();
    this.tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.tmpA);
    // Random roll so repeated hits on one wall never look stamped.
    const roll = new THREE.Quaternion().setFromAxisAngle(this.tmpA, Math.random() * Math.PI * 2);
    this.tmpQ.premultiply(roll);
    this.tmpS.set(size, size, size);
    this.tmpM.compose(
      this.tmpB.set(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02),
      this.tmpQ, this.tmpS,
    );
    set.mesh.setMatrixAt(i, this.tmpM);
    set.mesh.instanceMatrix.needsUpdate = true;
    set.alphas[i] = 1;
    set.life[i] = life;
    set.maxLife[i] = life;
    set.geo.attributes.aAlpha.needsUpdate = true;
  }

  _updateDecals(dt) {
    for (const kind of ['hole', 'blood']) {
      const set = this.decalSets[kind];
      let dirty = false;
      for (let i = 0; i < MAX_DECALS; i++) {
        if (set.life[i] <= 0) continue;
        set.life[i] -= dt;
        const t = set.life[i] / set.maxLife[i];
        // Only the last fifth of the lifetime fades, so decals stay legible.
        const a = t <= 0 ? 0 : Math.min(1, t / 0.2);
        if (a !== set.alphas[i]) { set.alphas[i] = a; dirty = true; }
        if (set.life[i] <= 0) {
          this.tmpM.makeScale(0, 0, 0);
          set.mesh.setMatrixAt(i, this.tmpM);
          set.mesh.instanceMatrix.needsUpdate = true;
        }
      }
      if (dirty) set.geo.attributes.aAlpha.needsUpdate = true;
    }
  }

  /* ── Shell casings ─────────────────────────────────────────────────────── */

  _initShells() {
    const geo = new THREE.CylinderGeometry(0.021, 0.023, 0.085, 6);
    const mat = new THREE.MeshLambertMaterial({ color: 0xc9a227, emissive: 0x2a1d05 });
    this.shellMesh = new THREE.InstancedMesh(geo, mat, MAX_SHELLS);
    this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shellMesh.frustumCulled = false;
    this.shellMesh.castShadow = false;
    this.scene.add(this.shellMesh);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_SHELLS; i++) this.shellMesh.setMatrixAt(i, zero);

    this.shells = [];
    for (let i = 0; i < MAX_SHELLS; i++) {
      this.shells.push({
        life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0, scale: 1, landed: false,
      });
    }
    this.shellHead = 0;
    this.shellEuler = new THREE.Euler();
  }

  /** Ejects a spent case. Tiny, but the single cheapest hit of gun feel there is. */
  ejectShell(x, y, z, vx, vy, vz, scale = 1) {
    if (!settings.shells) return;
    const s = this.shells[this.shellHead];
    this.shellHead = (this.shellHead + 1) % MAX_SHELLS;
    s.life = 3.2;
    s.x = x; s.y = y; s.z = z;
    s.vx = vx; s.vy = vy; s.vz = vz;
    s.rx = Math.random() * 6; s.ry = Math.random() * 6; s.rz = Math.random() * 6;
    s.sx = (Math.random() - 0.5) * 26;
    s.sy = (Math.random() - 0.5) * 26;
    s.sz = (Math.random() - 0.5) * 26;
    s.scale = scale;
    s.landed = false;
  }

  _updateShells(dt) {
    let any = false;
    for (let i = 0; i < MAX_SHELLS; i++) {
      const s = this.shells[i];
      if (s.life <= 0) continue;
      any = true;
      s.life -= dt;
      if (s.life <= 0) {
        this.tmpM.makeScale(0, 0, 0);
        this.shellMesh.setMatrixAt(i, this.tmpM);
        continue;
      }
      s.vy -= 26 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.rx += s.sx * dt; s.ry += s.sy * dt; s.rz += s.sz * dt;
      if (s.y < 0.024) {
        s.y = 0.024;
        if (!s.landed && s.vy < -1.4) {
          s.landed = true;
          this.onShellLand?.(s.x, s.y, s.z);
        }
        s.vy *= -0.34;
        s.vx *= 0.6; s.vz *= 0.6;
        s.sx *= 0.5; s.sy *= 0.5; s.sz *= 0.5;
      }
      const fade = Math.min(1, s.life / 0.4);
      this.shellEuler.set(s.rx, s.ry, s.rz);
      this.tmpQ.setFromEuler(this.shellEuler);
      this.tmpS.setScalar(s.scale * fade);
      this.tmpM.compose(this.tmpB.set(s.x, s.y, s.z), this.tmpQ, this.tmpS);
      this.shellMesh.setMatrixAt(i, this.tmpM);
    }
    if (any) this.shellMesh.instanceMatrix.needsUpdate = true;
  }

  /* ── High-level effects ────────────────────────────────────────────────── */

  /**
   * What happens where a bullet meets geometry.
   *
   * Five things, and the surface decides how much of each: the flash of the
   * strike itself, sparks off anything hard, debris of the material's own
   * colour, a puff of dust that hangs and spreads, and the hole left behind.
   *
   * Everything that leaves the surface leaves *along its normal* through
   * `_cone`, at a spread that says how rough the hit was — sparks come off
   * tight and fast, dust comes off wide and slow. Debris and dust are the
   * surface's own colour; the flash and the sparks are the round's, so a hit
   * on snow and a hit on steel differ in what comes off rather than only in
   * how much.
   */
  impact(x, y, z, nx = 0, ny = 1, nz = 0, surface = 'concrete') {
    const fx = SURFACE_FX[surface] ?? SURFACE_FX.concrete;
    // The map boundary is one of these. Nothing is drawn there because there is
    // nothing there — the town simply carries on, out of reach.
    if (fx.silent) return;
    const dust = new THREE.Color(fx.dust);
    // Debris is the surface a shade darker: a chip out of a wall is the inside
    // of the wall, and the inside has not been in the sun.
    const chip = dust.clone().multiplyScalar(0.62);
    const spark = new THREE.Color(0xffd07a);
    const hot = new THREE.Color(0xfff3d0);

    // Stand the origin a hair off the surface so nothing spawns inside it.
    const ox = x + nx * 0.04, oy = y + ny * 0.04, oz = z + nz * 0.04;

    // 1 — the strike. One very short, very bright point: the eye reads this as
    //     the moment of contact and everything after it as consequence.
    if (settings.particles) {
      this.sparks.spawn(ox, oy, oz, 0, 0, 0, hot,
        0.13 + Math.random() * 0.06 + fx.sparks * 0.1, 0.05,
        { gravity: 0, alpha: 0.9 });
    }

    // 2 — sparks, tight around the normal and fast, on anything hard enough.
    if (fx.sparks > 0.02) {
      const nSpark = this._count(9 * fx.sparks);
      for (let i = 0; i < nSpark; i++) {
        const d = this._cone(nx, ny, nz, 0.55);
        const sp = 5 + Math.random() * 11;
        this.sparks.spawn(ox, oy, oz,
          d.x * sp, d.y * sp + 1.4, d.z * sp,
          // A few burn white before they cool; the rest are already orange.
          i % 4 === 0 ? hot : spark,
          0.025 + Math.random() * 0.035, 0.16 + Math.random() * 0.34,
          { gravity: 26, drag: 1.1 });
      }
      // A second, slower shower that bounces along the ground. Two speeds is
      // what separates "sparks" from "one puff of orange".
      const nSlow = this._count(3 * fx.sparks);
      for (let i = 0; i < nSlow; i++) {
        const d = this._cone(nx, ny, nz, 0.85);
        const sp = 1.8 + Math.random() * 4;
        this.sparks.spawn(ox, oy, oz, d.x * sp, d.y * sp + 0.8, d.z * sp,
          spark, 0.02 + Math.random() * 0.02, 0.5 + Math.random() * 0.5,
          { gravity: 20, drag: 0.6 });
      }
    }

    // 3 — debris. Heavier than the dust, tumbling, and it settles rather than
    //     fading in mid-air: the ground bounce in the cloud does the rest.
    const nChip = this._count(4);
    for (let i = 0; i < nChip; i++) {
      const d = this._cone(nx, ny, nz, 0.7);
      const sp = 2.5 + Math.random() * 6;
      this.smoke.spawn(ox, oy, oz, d.x * sp, d.y * sp + 1.6, d.z * sp,
        chip, 0.035 + Math.random() * 0.05, 0.5 + Math.random() * 0.5,
        { gravity: 26, drag: 0.35, spin: (Math.random() - 0.5) * 14, alpha: 0.95 });
    }

    // 4 — dust. Wide, slow, growing as it goes, and the part that lingers.
    const nDust = this._count(6);
    for (let i = 0; i < nDust; i++) {
      const d = this._cone(nx, ny, nz, 0.95);
      const sp = 1.4 + Math.random() * 3.4;
      this.smoke.spawn(ox, oy, oz, d.x * sp, d.y * sp + 1.1, d.z * sp,
        dust, 0.09 + Math.random() * 0.13, 0.3 + Math.random() * 0.4,
        { gravity: 9, drag: 2.4, grow: 1.9, alpha: 0.72, spin: (Math.random() - 0.5) * 3 });
    }
    // …and one lazy puff that hangs where the round went in.
    if (this._count(1.2) > 0) {
      this.smoke.spawn(ox, oy, oz, nx * 0.5, ny * 0.5 + 0.35, nz * 0.5,
        dust, 0.16 + Math.random() * 0.12, 0.75 + Math.random() * 0.5,
        { gravity: -0.4, drag: 3.4, grow: 3.2, alpha: 0.3, spin: (Math.random() - 0.5) * 1.4 });
    }

    this.decal('hole', x, y, z, nx, ny, nz, 0.16 + Math.random() * 0.08, 18);
  }

  /**
   * Blood where a shot connects with a player.
   *
   * `dir` is the direction the round was travelling, when the caller knows it.
   * Given one, the spray leaves the far side of the hit the way it actually
   * would; without one it puffs outwards, which is what this did for every hit
   * before and is still the right answer for a hit whose geometry we never saw.
   */
  blood(x, y, z, big = false, dir = null) {
    const c = new THREE.Color(0xa8121f);
    const mist = new THREE.Color(0x6d0a12);
    const n = this._count(big ? 15 : 8);
    for (let i = 0; i < n; i++) {
      const sp = 1.8 + Math.random() * (big ? 8 : 4.5);
      // Along the round where we have it, spherical where we do not.
      const d = dir
        ? this._cone(dir.x, dir.y, dir.z, 0.75)
        : this.tmpA.set(Math.random() - 0.5, Math.random() * 0.8 + 0.3, Math.random() - 0.5).normalize();
      this.smoke.spawn(
        x, y, z,
        d.x * sp, d.y * sp + 1.4, d.z * sp,
        i % 4 === 0 ? mist : c, 0.05 + Math.random() * 0.09, 0.3 + Math.random() * 0.4,
        { gravity: 20, drag: 1.4, spin: (Math.random() - 0.5) * 6 },
      );
    }
    if (big) {
      const nm = this._count(5);
      for (let i = 0; i < nm; i++) {
        this.smoke.spawn(x, y, z,
          (Math.random() - 0.5) * 2.2, Math.random() * 1.6, (Math.random() - 0.5) * 2.2,
          mist, 0.3 + Math.random() * 0.3, 0.5 + Math.random() * 0.4,
          { gravity: 1.5, drag: 3, grow: 1.4, alpha: 0.42 });
      }
      // Splatter on the floor beneath the hit.
      this.decal('blood', x + (Math.random() - 0.5) * 0.6, 0.015, z + (Math.random() - 0.5) * 0.6,
        0, 1, 0, 0.75 + Math.random() * 0.5, 22);
    }
  }

  /**
   * Dust kicked up on a hard landing or the start of a slide.
   *
   * A ring rather than a cloud: the dust a boot displaces leaves from *under*
   * it and outwards, so the particles start on a small circle and move away
   * from its centre. That one change is the difference between reading as
   * something that landed and reading as a puff of smoke at ankle height.
   */
  dust(x, y, z, amount = 6, color = 0xbfb4a0) {
    const c = new THREE.Color(color);
    const n = this._count(amount);
    for (let i = 0; i < n; i++) {
      // Spread around the ring rather than randomly on it, so a small count
      // still reads as a circle instead of as three particles in a corner.
      const a = ((i + Math.random() * 0.7) / Math.max(1, n)) * Math.PI * 2;
      const r = 0.12 + Math.random() * 0.22;
      const sp = 1.4 + Math.random() * 3.2;
      this.smoke.spawn(
        x + Math.cos(a) * r, y + 0.04 + Math.random() * 0.06, z + Math.sin(a) * r,
        Math.cos(a) * sp, 0.6 + Math.random() * 1.4, Math.sin(a) * sp,
        c, 0.16 + Math.random() * 0.2, 0.4 + Math.random() * 0.5,
        { gravity: 2.6, drag: 2.8, grow: 2.4, alpha: 0.5, spin: (Math.random() - 0.5) * 2.4 });
    }
  }

  /**
   * A rocket in flight: a flame at the nozzle and a trail that outlives it.
   *
   * Three lifetimes on purpose. The flame is gone in a twentieth of a second,
   * so it reads as attached to the rocket rather than as a line behind it. The
   * hot smoke lingers a fraction and keeps its colour. The cold smoke hangs for
   * a second and a half and spreads to five times its size, which is what
   * leaves a trail across the sky after the rocket has gone.
   */
  rocketTrail(x, y, z) {
    if (!settings.particles) return;
    // The flame, at the nozzle.
    this.sparks.spawn(x, y, z, 0, 0, 0, new THREE.Color(0xfff0c4), 0.3, 0.05, { gravity: 0 });
    this.sparks.spawn(x, y, z,
      (Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 2.4,
      new THREE.Color(0xffa640), 0.16 + Math.random() * 0.1, 0.12,
      { gravity: 0, drag: 3 });
    // Hot exhaust, still glowing.
    this.smoke.spawn(x, y, z,
      (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4 + 0.3, (Math.random() - 0.5) * 1.4,
      new THREE.Color(0x6a5a4c), 0.15 + Math.random() * 0.1, 0.35,
      { gravity: -0.4, drag: 2.4, grow: 2, alpha: 0.7, spin: (Math.random() - 0.5) * 3 });
    // …and the cold trail it leaves behind.
    this.smoke.spawn(x, y, z,
      (Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.7 + 0.5, (Math.random() - 0.5) * 0.7,
      new THREE.Color(0xa8a49c), 0.22 + Math.random() * 0.16, 1.5,
      { gravity: -0.5, drag: 1.6, grow: 4.5, alpha: 0.42, spin: (Math.random() - 0.5) * 1.6 });
  }

  update(dt, camera = null) {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this._updateTracers(dt);
    this._updateBlasts(dt);
    this._updateFlashes(dt, camera);
    this._updateDecals(dt);
    this._updateShells(dt);
  }

  clear() {
    this.sparks.clear();
    this.smoke.clear();
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; }
    for (const b of this.blasts) {
      b.life = 0; b.mesh.visible = false; b.shock.visible = false; b.light.intensity = 0;
    }
    for (const f of this.flashes) { f.life = 0; f.mesh.visible = false; f.light.intensity = 0; }
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const kind of ['hole', 'blood']) {
      const set = this.decalSets[kind];
      set.life.fill(0);
      set.alphas.fill(0);
      for (let i = 0; i < MAX_DECALS; i++) set.mesh.setMatrixAt(i, zero);
      set.mesh.instanceMatrix.needsUpdate = true;
      set.geo.attributes.aAlpha.needsUpdate = true;
    }
    for (let i = 0; i < MAX_SHELLS; i++) {
      this.shells[i].life = 0;
      this.shellMesh.setMatrixAt(i, zero);
    }
    this.shellMesh.instanceMatrix.needsUpdate = true;
  }
}

export default Effects;
