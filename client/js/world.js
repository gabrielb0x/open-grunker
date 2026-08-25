/**
 * Open Grunker — renderer and map geometry.
 *
 * The map is still instanced boxes, but now batched **per surface material**:
 * one InstancedMesh for every concrete/brick/metal/wood group in the level. A
 * dozen draw calls for a whole map, and in exchange every solid gets a real
 * tiling texture, its own specular response, and world-aligned UVs — so a wall
 * assembled from thirty boxes reads as one continuous surface the way a Source
 * brush does, instead of thirty flat-shaded blocks.
 *
 * Three layers of shading stack on top of each other, none of which costs
 * anything per frame: per-face brightness and contact darkening baked into the
 * cube's vertex colours, a deterministic per-instance tint, and the map's own
 * light rig feeding an HDR buffer that the post chain tone-maps.
 */
import * as THREE from 'three';
import { SURFACE } from '/shared/constants.js';
import { settings } from './settings.js';
import { surfaceTexture, SURFACE_SHADING, SURFACE_TILE, configureTextures } from './textures.js';
import { PostFX } from './postfx.js';

const QUALITY = {
  low: {
    shadowMap: 0, pixelRatio: 1, antialias: false, shadowRange: 0, sky: 24,
    texture: 128, aniso: 1, post: false, phong: false, fillLight: false,
  },
  medium: {
    shadowMap: 1024, pixelRatio: 1.2, antialias: false, shadowRange: 48, sky: 40,
    texture: 256, aniso: 4, post: true, phong: true, fillLight: false,
  },
  high: {
    shadowMap: 2048, pixelRatio: 1.6, antialias: true, shadowRange: 70, sky: 56,
    texture: 256, aniso: 8, post: true, phong: true, fillLight: true,
  },
  ultra: {
    shadowMap: 4096, pixelRatio: 2, antialias: true, shadowRange: 92, sky: 80,
    texture: 512, aniso: 16, post: true, phong: true, fillLight: true,
  },
};

const quality = () => QUALITY[settings.quality] ?? QUALITY.high;

/** How much brighter every map's ambient term runs than its own palette says. */
const AMBIENT_GAIN = 1.4;

/** Pulls a colour toward white — used to keep dark skies from killing the fill. */
function lighten(color, amount) {
  color.r += (1 - color.r) * amount;
  color.g += (1 - color.g) * amount;
  color.b += (1 - color.b) * amount;
  return color;
}

/**
 * Per-face brightness baked into the cube: top lit, sides shaded, base dark.
 * The floor of this range matters more than it looks — the tone curve squeezes
 * the bottom end hard, so a face baked at 0.4 came out nearly black.
 */
const FACE_TINT = [0.94, 0.94, 1.0, 0.62, 0.85, 0.85];   // +x -x +y -y +z -z

/* ── Shader injection ────────────────────────────────────────────────────── */

const BOX_COMMON = /* glsl */`
uniform float uTile;
varying vec3 ogWorld;
varying vec3 ogNormal;
`;

const BOX_VERTEX = /* glsl */`
#include <begin_vertex>
#ifdef USE_INSTANCING
  ogWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  ogNormal = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal );
#else
  ogWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  ogNormal = normalize( mat3( modelMatrix ) * objectNormal );
#endif
`;

/**
 * World-aligned triplanar sampling. Because the UV comes from world position
 * rather than the cube's own [0,1] face UVs, texel density is identical on a
 * 0.4-unit trim piece and a 26-unit deck, and neighbouring boxes line up.
 */
const BOX_MAP = /* glsl */`
#ifdef USE_MAP
  vec3 ogA = abs( ogNormal );
  vec2 ogUv = ogA.y > max( ogA.x, ogA.z )
    ? ogWorld.xz
    : ( ogA.x > ogA.z ? ogWorld.zy : ogWorld.xy );
  vec4 ogTex = texture2D( map, ogUv * uTile );
  diffuseColor *= ogTex;
#endif
`;

export class GameWorld {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {?THREE.WebGLRenderer} renderer an existing renderer to draw with.
   *        Only the tests pass one; the game always makes its own.
   */
  constructor(canvas, renderer = null) {
    this.canvas = canvas;
    const q = quality();

    this.renderer = renderer ?? new THREE.WebGLRenderer({
      canvas, antialias: q.antialias, powerPreference: 'high-performance',
      stencil: false, depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.shadowMap.enabled = settings.shadows && q.shadowMap > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = true;

    configureTextures({ resolution: q.texture, aniso: Math.min(q.aniso, this.renderer.capabilities.getMaxAnisotropy()) });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 900);
    this.camera.rotation.order = 'YXZ';

    this.mapGroup = new THREE.Group();
    this.scene.add(this.mapGroup);

    this.sunTarget = new THREE.Object3D();
    this.scene.add(this.sunTarget);

    /** Scratch for size queries, so `resize` allocates nothing. */
    this._size = new THREE.Vector2();
    this.boxGeo = this._buildShadedBox();
    this.batches = [];
    this._perMapTextures = [];
    this._buildLights();

    this.post = new PostFX(this.renderer);
    this._applyToneMapping();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * A unit cube whose vertex colours carry per-face shading plus a soft
   * bottom-to-top gradient and darkened edges. Multiplied by the instance tint
   * in the shader, so every box gets grounded contact shading and a hint of
   * ambient occlusion at its corners for free.
   */
  _buildShadedBox() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const face = Math.floor(i / 4);
      let shade = FACE_TINT[face] ?? 1;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // Side faces darken toward the ground.
      if (face !== 2 && face !== 3) shade *= 0.88 + (y + 0.5) * 0.18;
      // Corner darkening — a cheap stand-in for baked occlusion.
      const edge = (Math.abs(x) + Math.abs(y) + Math.abs(z)) / 1.5;
      shade *= 1 - (edge - 0.7) * 0.11;
      colors[i * 3] = shade;
      colors[i * 3 + 1] = shade;
      colors[i * 3 + 2] = shade;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xbcd7ff, 0x6b5c42, AMBIENT_GAIN * 0.75);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff3dd, 1.3);
    this.sun.castShadow = this.renderer.shadowMap.enabled;
    this._configureShadow();
    this.sun.target = this.sunTarget;
    this.scene.add(this.sun);

    // A dim opposing fill keeps shadowed faces from going flat black, and a
    // cold bounce from below stops undersides reading as holes.
    this.fill = new THREE.DirectionalLight(0x9fc0ff, 0.46);
    this.fill.position.set(-40, 30, -30);
    this.scene.add(this.fill);

    this.bounce = new THREE.DirectionalLight(0xffe6c0, 0.24);
    this.bounce.position.set(10, -40, 10);
    this.scene.add(this.bounce);
  }

  _configureShadow() {
    const q = quality();
    if (!this.sun.castShadow) return;
    this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 320;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 1.6;
    // A frustum that hugs the player is what makes shadows crisp instead of mushy.
    const half = q.shadowRange;
    const c = this.sun.shadow.camera;
    c.left = -half; c.right = half; c.top = half; c.bottom = -half;
    c.updateProjectionMatrix();
  }

  /**
   * Tone mapping lives in the post chain when it is on, and in the renderer
   * when it is off. Flipping it recompiles shaders, so it only ever changes
   * when the setting actually does.
   */
  _applyToneMapping() {
    const usePost = quality().post && settings.postProcessing !== false;
    const want = usePost ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    const bright = settings.brightness ?? 0;
    if (this.renderer.toneMapping !== want) {
      this.renderer.toneMapping = want;
      this.scene.traverse((o) => { if (o.isMesh && o.material) markDirty(o.material); });
    }
    // Without the post chain there is no gamma lift to open the shadows, so the
    // plain renderer needs the headroom in its exposure instead.
    this.renderer.toneMappingExposure = usePost ? 1 : 1.32 + bright;
    this.post.configure({
      enabled: usePost,
      quality: settings.quality,
      bloom: settings.bloom ?? 0.62,
      // One vignette, in the post chain. #grade used to stack a second, far
      // heavier one on top of this in CSS.
      vignette: settings.vignette ? 0.2 : 0.05,
      grain: settings.filmGrain ? 0.024 : 0,
      chroma: settings.chromatic ? 0.55 : 0,
      exposure: 1.14 + bright,
      gamma: 1.16 + Math.max(0, bright) * 0.4,
    });
  }

  /* ── Map ───────────────────────────────────────────────────────────────── */

  /** Tears down the previous map and builds the new one. */
  setMap(map) {
    this.map = map;
    this._disposeGroup(this.mapGroup);

    const sky = map.sky ?? { top: 0x6ea8ff, bottom: 0xdfefff };
    const fog = map.fog ?? { color: 0xcfe6ff, near: 60, far: 180 };

    this.scene.fog = new THREE.Fog(fog.color, fog.near, fog.far);
    this.scene.background = new THREE.Color(fog.color);
    this._buildSky(sky, map);

    // Sun / ambient from the map palette
    const dir = map.sun?.dir ?? [0.5, 0.8, 0.35];
    const dist = (map.size ?? 100) * 1.1;
    this.sun.position.set(dir[0] * dist, dir[1] * dist, dir[2] * dist);
    this.sun.color.setHex(map.sun?.color ?? 0xfff3dd);
    this.sun.intensity = map.sun?.intensity ?? 1.3;
    this.hemi.color.setHex(map.ambient?.color ?? sky.top);
    this.hemi.groundColor.setHex(map.ground?.color ?? 0x6b5c42);
    this.hemi.intensity = (map.ambient?.intensity ?? 0.7) * AMBIENT_GAIN;
    // The fill borrows the sky's hue but not its darkness: on an overcast or
    // night palette the raw sky colour is almost black and fills nothing.
    this.fill.color.setHex(sky.top);
    lighten(this.fill.color, 0.45);
    this.fill.intensity = quality().fillLight ? 0.46 : 0.3;
    this.fill.position.set(-dir[0] * dist, dist * 0.5, -dir[2] * dist);
    this.bounce.color.setHex(map.ground?.color ?? 0x8a7a5a);
    lighten(this.bounce.color, 0.3);

    this._configureShadow();
    this._buildGround(map);
    this._buildBoxes(map);
  }

  /**
   * Gradient dome with a sun disc, horizon haze and a band of soft cloud.
   *
   * `sky.clouds` scales the cloud band from 0 (a clean poster-flat sky, which
   * is what the town maps want) up through 1 (the default overcast drift).
   */
  _buildSky(sky, map) {
    const cnv = document.createElement('canvas');
    cnv.width = 512; cnv.height = 512;
    const g = cnv.getContext('2d');
    const hex = (n) => '#' + n.toString(16).padStart(6, '0');
    const W = 512;

    const grad = g.createLinearGradient(0, 0, 0, W);
    grad.addColorStop(0, hex(sky.top));
    grad.addColorStop(0.36, hex(sky.top));
    grad.addColorStop(0.56, hex(sky.haze ?? sky.bottom));
    grad.addColorStop(0.72, hex(sky.bottom));
    grad.addColorStop(1, hex(sky.bottom));
    g.fillStyle = grad;
    g.fillRect(0, 0, W, W);

    // Sun glow, placed on the horizon side the light comes from.
    const dir = map.sun?.dir ?? [0.5, 0.8, 0.35];
    const sunX = W / 2 + Math.atan2(dir[0], dir[2]) * 80;
    const sunY = W / 2 - Math.max(-0.9, Math.min(0.9, dir[1])) * 150;
    const sunHex = hex(map.sun?.color ?? 0xfff3dd);
    const halo = g.createRadialGradient(sunX, sunY, 2, sunX, sunY, 190);
    halo.addColorStop(0, 'rgba(255,255,255,1)');
    halo.addColorStop(0.05, 'rgba(255,255,255,.95)');
    halo.addColorStop(0.14, `${sunHex}aa`);
    halo.addColorStop(0.4, `${sunHex}33`);
    halo.addColorStop(1, `${sunHex}00`);
    g.fillStyle = halo;
    g.fillRect(0, 0, W, W);

    // Deterministic cloud band — layered soft blobs, no noise texture needed.
    const clouds = sky.clouds ?? 1;
    let seed = (map.size ?? 100) * 7919 + 17;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    if (clouds > 0) {
      for (let layer = 0; layer < 3; layer++) {
        g.globalAlpha = (0.055 + layer * 0.045) * clouds;
        g.fillStyle = layer === 2 ? '#ffffff' : hex(sky.haze ?? 0xffffff);
        const yBase = 120 + layer * 46;
        for (let i = 0; i < 54; i++) {
          const x = rnd() * W, y = yBase + rnd() * 90, r = 14 + rnd() * 52;
          g.beginPath();
          g.ellipse(x, y, r * (1.6 + rnd()), r * (0.32 + rnd() * 0.2), 0, 0, Math.PI * 2);
          g.fill();
        }
      }
      // A handful of fat, opaque cumulus on top of the haze band. The soft
      // layers above only ever read as a smear; these are what actually make a
      // player look up and see weather.
      g.globalAlpha = 0.9 * Math.min(1, clouds);
      g.fillStyle = '#ffffff';
      for (let i = 0; i < Math.round(7 * Math.min(1, clouds)); i++) {
        const cx0 = rnd() * W, cy0 = 96 + rnd() * 110, scale = 0.7 + rnd() * 0.9;
        for (let p = 0; p < 6; p++) {
          const px = cx0 + (p - 2.5) * 22 * scale + (rnd() - 0.5) * 14;
          const py = cy0 + Math.abs(p - 2.5) * 6 * scale + (rnd() - 0.5) * 8;
          const pr = (26 - Math.abs(p - 2.5) * 4) * scale;
          g.beginPath(); g.ellipse(px, py, pr * 1.25, pr * 0.72, 0, 0, Math.PI * 2); g.fill();
        }
        // Flat, slightly grey base — a cumulus is lit from above, not all round.
        g.globalAlpha = 0.26 * Math.min(1, clouds);
        g.fillStyle = hex(sky.haze ?? sky.bottom);
        g.beginPath();
        g.ellipse(cx0, cy0 + 14 * scale, 78 * scale, 11 * scale, 0, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 0.9 * Math.min(1, clouds);
        g.fillStyle = '#ffffff';
      }
    }
    // Ground haze so the dome never shows a hard seam at the horizon.
    g.globalAlpha = 1;
    const hz = g.createLinearGradient(0, W * 0.62, 0, W);
    hz.addColorStop(0, `${hex(map.fog?.color ?? sky.bottom)}00`);
    hz.addColorStop(1, `${hex(map.fog?.color ?? sky.bottom)}ff`);
    g.fillStyle = hz;
    g.fillRect(0, W * 0.62, W, W * 0.38);

    const tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    const q = quality();
    const geo = new THREE.SphereGeometry(600, Math.max(16, q.sky / 2), Math.max(12, q.sky / 3));
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false });
    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = -1;
    dome.frustumCulled = false;
    this.mapGroup.add(dome);
    this.skyDome = dome;
    this._perMapTextures.push(tex);
  }

  _buildGround(map) {
    const size = map.ground?.size ?? 220;
    const mat = map.ground?.mat ?? SURFACE.DIRT;
    const tex = surfaceTexture(mat).clone();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(size / (SURFACE_TILE[mat] ?? 4), size / (SURFACE_TILE[mat] ?? 4));
    tex.needsUpdate = true;
    this._perMapTextures.push(tex);

    const shading = SURFACE_SHADING[mat] ?? { shininess: 4, specular: 0x101010 };
    const material = quality().phong
      ? new THREE.MeshPhongMaterial({
        map: tex, color: map.ground?.color ?? 0xffffff,
        shininess: shading.shininess * 0.6, specular: shading.specular,
      })
      : new THREE.MeshLambertMaterial({ map: tex, color: map.ground?.color ?? 0xffffff });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0;
    mesh.receiveShadow = this.renderer.shadowMap.enabled;
    this.mapGroup.add(mesh);
    this.ground = mesh;
  }

  /**
   * One InstancedMesh per surface material, so every box gets a real texture.
   *
   * Three kinds of box arrive here and only two of them are drawn:
   *
   *   • solid      — collides and renders. The map.
   *   • `decor`    — renders, never collides. Grass tufts, road paint, the
   *                  bodywork of a parked car, a hedge you can run through the
   *                  corner of. This is what lets a map be dense without being
   *                  a maze of invisible corners.
   *   • `clip`     — collides, never renders. The invisible boundary that has
   *                  replaced the fourteen-metre perimeter walls: the player
   *                  sees the town keep going, and simply cannot walk into it.
   *
   * Batches are keyed by material *and* by whether they cast shadows, because
   * shadow casting is a per-mesh flag: road markings and lawn trim would
   * otherwise throw hard little shadows onto the very surface they sit on.
   */
  _buildBoxes(map) {
    const boxes = (map.boxes ?? []).filter((b) => !b.clip);
    if (!boxes.length) return;
    this.batches.length = 0;

    const groups = new Map();
    for (const b of boxes) {
      const mat = b.mat ?? SURFACE.CONCRETE;
      const key = `${mat}|${b.noShadow ? 1 : 0}`;
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push(b);
    }

    const shadows = this.renderer.shadowMap.enabled;
    const usePhong = quality().phong;
    const m = new THREE.Matrix4();
    const col = new THREE.Color();

    for (const [key, list] of groups) {
      const surface = key.slice(0, key.indexOf('|'));
      const casts = shadows && key.endsWith('|0');
      const tex = surfaceTexture(surface);
      const shading = SURFACE_SHADING[surface] ?? { shininess: 6, specular: 0x101010 };
      const tile = SURFACE_TILE[surface] ?? 4;

      const material = usePhong
        ? new THREE.MeshPhongMaterial({
          map: tex, vertexColors: true,
          shininess: shading.shininess, specular: shading.specular,
        })
        : new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
      material.onBeforeCompile = (shader) => {
        // All four hooks or none: a half-applied injection would declare a
        // varying the other stage never writes, and the program would not link.
        const hooks = ['#include <common>', '#include <begin_vertex>'];
        const ok = hooks.every((h) => shader.vertexShader.includes(h))
          && shader.fragmentShader.includes('#include <common>')
          && shader.fragmentShader.includes('#include <map_fragment>');
        if (!ok) return;
        shader.uniforms.uTile = { value: 1 / tile };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${BOX_COMMON}`)
          .replace('#include <begin_vertex>', BOX_VERTEX);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${BOX_COMMON}`)
          .replace('#include <map_fragment>', BOX_MAP);
      };
      // Every batch compiles to the same program; only the tile uniform differs.
      material.customProgramCacheKey = () => `og-box-${usePhong ? 'p' : 'l'}`;

      const mesh = new THREE.InstancedMesh(this.boxGeo, material, list.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.castShadow = casts;
      mesh.receiveShadow = shadows;
      mesh.frustumCulled = false;
      mesh.userData.noShadow = !casts;

      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        m.makeScale(b.w, b.h, b.d);
        m.setPosition(b.x, b.y + b.h / 2, b.z);
        mesh.setMatrixAt(i, m);
        // Deterministic per-box tint jitter breaks up large flat surfaces.
        col.setHex(b.c ?? 0x999999);
        const j = (((i * 2654435761) >>> 0) % 100) / 100;
        col.offsetHSL(0, 0, (j - 0.5) * 0.055);
        if (b.roof) col.offsetHSL(0, 0, 0.025);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.mapGroup.add(mesh);
      this.batches.push(mesh);
    }
  }

  _disposeGroup(group) {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      group.remove(child);
      // The shared box geometry and the cached surface textures outlive every
      // map; only per-map geometry and cloned textures get released.
      if (child.geometry && child.geometry !== this.boxGeo) child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) mat?.dispose();
    }
    // Surface textures are cached and shared across maps; only the ones built
    // for this map in particular (the sky dome, the ground's own repeat clone)
    // are ours to release.
    for (const tex of this._perMapTextures) tex.dispose();
    this._perMapTextures.length = 0;
    this.batches.length = 0;
    this.ground = null;
    this.skyDome = null;
  }

  /* ── Frame ─────────────────────────────────────────────────────────────── */

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const size = this.renderer.getDrawingBufferSize(this._size);
    this.post.setSize(size.x, size.y, true);
  }

  /** Applies quality/FOV changes made in the settings panel. */
  applySettings() {
    const q = quality();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    const wantShadow = settings.shadows && q.shadowMap > 0;
    if (this.renderer.shadowMap.enabled !== wantShadow) {
      this.renderer.shadowMap.enabled = wantShadow;
      this.sun.castShadow = wantShadow;
      for (const b of this.batches) {
        b.castShadow = wantShadow && !b.userData.noShadow;
        b.receiveShadow = wantShadow;
      }
      if (this.ground) this.ground.receiveShadow = wantShadow;
      this.scene.traverse((o) => { if (o.isMesh && o.material) markDirty(o.material); });
    }
    this._configureShadow();
    this._applyToneMapping();
    this.camera.fov = settings.fov;
    this.camera.updateProjectionMatrix();
    this.resize();
  }

  /** Rebuilds textures and geometry after a quality change that needs it. */
  rebuild() {
    const q = quality();
    configureTextures({
      resolution: q.texture,
      aniso: Math.min(q.aniso, this.renderer.capabilities.getMaxAnisotropy()),
    });
    if (this.map) this.setMap(this.map);
  }

  /** Keeps the sun's shadow frustum centred on the player. */
  followSun(x, z) {
    this.sunTarget.position.set(x, 0, z);
    const dir = this.map?.sun?.dir ?? [0.5, 0.8, 0.35];
    const dist = 90;
    this.sun.position.set(x + dir[0] * dist, dir[1] * dist, z + dir[2] * dist);
  }

  get postEnabled() { return this.post.enabled; }

  /**
   * Draws the world, then hands the buffer to the viewmodel to draw its gun on
   * top with a cleared depth buffer, then resolves post-processing.
   * @param {?function} drawOverlay called with the render target still bound
   */
  render(dt = 0.016, drawOverlay = null) {
    if (this.skyDome) this.skyDome.position.copy(this.camera.position);

    if (this.post.enabled) {
      this.post.begin();
      this.renderer.render(this.scene, this.camera);
      if (drawOverlay) drawOverlay(this.renderer);
      this.post.end(dt);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      if (drawOverlay) drawOverlay(this.renderer);
    }
  }

  get info() {
    return this.renderer.info.render;
  }
}

function markDirty(material) {
  if (Array.isArray(material)) material.forEach(markDirty);
  else if (material) material.needsUpdate = true;
}

export default GameWorld;
