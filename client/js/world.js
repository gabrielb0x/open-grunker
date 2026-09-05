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
import { PostFX, BASE_SATURATION, BASE_CONTRAST } from './postfx.js';

/**
 * `shadowHz` caps how often the shadow map is re-rendered.
 *
 * The shadow pass draws every casting solid in the level a second time, from
 * the light — on a busy map that is as much geometry as the visible frame. It
 * does not have to happen 144 times a second: the sun's *direction* never
 * changes (see `followSun`), so a map rendered a frame or two ago is still
 * correct in world space, it is only a couple of milliseconds behind the bodies
 * moving through it. Nothing on a 60 Hz screen can tell; a 144 Hz screen gets
 * more than half its shadow passes back.
 */
/*
 * `lights` is the size of the dynamic lamp pool — see effects.js.
 *
 * It is a *quality* number rather than an effects number because of how
 * three.js works: the count of lights in the scene is compiled into every
 * shader, so a light that exists costs every surface in the level whether it is
 * switched on or not. Explosions and muzzle flashes used to keep eighteen of
 * them alive permanently, which is eighteen light evaluations per fragment on
 * every wall of every map, at every setting — including Low. That is the single
 * biggest reason turning the quality down used to buy so little.
 *
 * `fillRig` is the same question asked of the map's own lighting: a sun, an
 * opposing fill and a bounce from below is three directional lights, and on the
 * preset meant for machines that are struggling, two of them are a luxury. The
 * hemisphere term is lifted to make up the brightness when they go.
 */
const QUALITY = {
  low: {
    shadowMap: 0, pixelRatio: 1, antialias: false, shadowRange: 0, sky: 24,
    texture: 128, aniso: 1, post: false, phong: false, fillLight: false, shadowHz: 30,
    lights: 0, fillRig: false,
  },
  medium: {
    shadowMap: 1024, pixelRatio: 1.2, antialias: false, shadowRange: 48, sky: 40,
    texture: 256, aniso: 4, post: true, phong: true, fillLight: false, shadowHz: 45,
    lights: 3, fillRig: true,
  },
  high: {
    shadowMap: 2048, pixelRatio: 1.6, antialias: true, shadowRange: 70, sky: 56,
    texture: 256, aniso: 8, post: true, phong: true, fillLight: true, shadowHz: 60,
    lights: 6, fillRig: true,
  },
  ultra: {
    shadowMap: 4096, pixelRatio: 2, antialias: true, shadowRange: 92, sky: 80,
    texture: 512, aniso: 16, post: true, phong: true, fillLight: true, shadowHz: 60,
    lights: 8, fillRig: true,
  },
};

const quality = () => QUALITY[settings.quality] ?? QUALITY.high;

/**
 * How many dynamic lights the current preset will pay for.
 *
 * Read by effects.js, which owns the pool. It lives here because the number is
 * part of the quality preset, and a second copy of that table in a second file
 * is a second copy that drifts.
 */
export const dynamicLightBudget = () => quality().lights ?? 0;

/** Resolution presets, as a cap on the drawing buffer's height in real pixels. */
const RESOLUTION_HEIGHT = { '720p': 720, '1080p': 1080, '1440p': 1440, '4K': 2160 };

/**
 * The tallest the drawing buffer is allowed to be, in real pixels.
 *
 * Never larger than the screen already asks for — picking "4K" on a 1080p
 * window buys nothing, so the cap can only ever trade detail for frame rate,
 * never spend GPU time supersampling nobody will see.
 */
const resolutionCap = () => Math.min(
  window.innerHeight * Math.min(window.devicePixelRatio, quality().pixelRatio),
  RESOLUTION_HEIGHT[settings.resolution] ?? RESOLUTION_HEIGHT['1080p'],
);

/**
 * How much post-processing the player asked for, 0–1.
 *
 * `Number` rather than a plain read so a build that stored the old switch is
 * still understood here: `true` is 1 and `false` is 0, which is exactly the
 * migration settings.js does on load, done again at the point of use because
 * this is the only place the value means anything.
 */
const postAmount = () => {
  const v = Number(settings.postProcessing ?? 1);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
};

/** How much brighter every map's ambient term runs than its own palette says. */
const AMBIENT_GAIN = 1.4;

/**
 * How big a chunk of map is, in metres, and how many boxes make chunking worth
 * doing at all. See `_buildBoxes`.
 *
 * Forty is about a third of the widest level in the game: small enough that
 * turning round drops most of the map out of the frustum, large enough that a
 * town does not become four hundred draw calls.
 */
const CHUNK_SIZE = 40;
const CHUNK_MIN_BOXES = 400;
/** A surface has to be at least this many boxes before it is worth splitting… */
const CHUNK_MIN_SURFACE = 120;
/** …and a cell this many before it is worth its own draw call. */
const CHUNK_MIN_CELL = 40;

/**
 * A box's own tint jitter, 0-1, from where it stands.
 *
 * Position rather than index, so the shade a wall is painted does not depend on
 * which batch it happened to land in — otherwise splitting a material into
 * chunks would repaint every level in the game.
 */
function tintJitter(b) {
  let h = (Math.round(b.x * 8) * 73856093) ^ (Math.round(b.y * 8) * 19349663)
    ^ (Math.round(b.z * 8) * 83492791);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (((h ^ (h >>> 16)) >>> 0) % 1000) / 1000;
}

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

/* ── The nebula sky ──────────────────────────────────────────────────────────
 *
 * Every other map in the game gets its sky painted once into a 512×512 canvas
 * and wrapped round a dome, which is exactly right for them: a flat blue
 * daytime gradient with a cloud band is a *poster*, it does not move, and
 * baking it costs one texture and nothing per frame.
 *
 * A night sky is not a poster. What makes a nebula read as a nebula rather than
 * as wallpaper is that it has depth and that it *drifts* — two fields of gas at
 * different scales sliding past each other, stars coming and going behind them,
 * the occasional streak. None of that survives being baked, and all of it is
 * cheap procedurally: the dome is drawn last with the depth test on, so only
 * the sky the player can actually see through the level ever runs this.
 *
 * Written out by hand rather than pulled from a noise library for the same
 * reason the post chain is: the client ships one three.js module and no build
 * step. It is a hash, a value noise, an fbm and about thirty lines of art
 * direction on top.
 * ──────────────────────────────────────────────────────────────────────────*/

const SKY_VS = /* glsl */`
varying vec3 vDir;
void main() {
  // The dome is a sphere centred on the camera, so the object-space position
  // *is* the view direction. No matrices needed to get it.
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FS = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uDensity;
uniform vec3 uTop, uBottom, uHaze, uFog, uWarm, uCool;
varying vec3 vDir;

// Three-dimensional value hash. Deterministic, so the sky is the same sky on
// every screen in the match — which matters more than it sounds: a landmark
// that is only on your monitor is not a landmark.
float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3(0, 0, 0)), hash13(i + vec3(1, 0, 0)), f.x),
        mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
        mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float a = 0.5, sum = 0.0;
  for (int i = 0; i < OG_OCTAVES; i++) {
    sum += a * vnoise(p);
    p *= 2.03;                       // not exactly 2: powers of two line the
    a *= 0.5;                        // octaves up and the lattice shows through
  }
  return sum;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // The bare sky behind everything: deep at the zenith, warmer at the horizon.
  vec3 col = mix(uBottom, uTop, smoothstep(-0.15, 0.85, h));

  /*
   * Two gas fields at different scales, drifting in different directions.
   *
   * One field alone is a stain. What reads as *volume* is a second, finer field
   * sliding across the first at a different rate and warping it — so the shapes
   * pull apart and rejoin instead of translating rigidly, which is the tell
   * that gives away a single scrolling layer immediately.
   */
  float t = uTime;
  vec3 q = dir * 2.1;
  float f1 = fbm(q + vec3(t * 0.009, t * 0.0035, -t * 0.007));
  float f2 = fbm(q * 1.9 + vec3(-t * 0.013, t * 0.002, t * 0.0055) + f1 * 0.8);
  float cloud = smoothstep(0.30, 0.92, f1 * 0.7 + f2 * 0.55);

  // Which of the two colours this part of the sky belongs to. The split runs
  // diagonally rather than by height, so the two never stack into bands.
  float lean = clamp(0.5 + dir.x * 0.55 + dir.z * 0.25 - dir.y * 0.30, 0.0, 1.0);
  vec3 gas = mix(uCool, uWarm, clamp(lean * (0.45 + f2 * 0.85), 0.0, 1.0));
  col += gas * cloud * uDensity;

  // The bright heart of it, where the finer field piles up. Squared so it stays
  // a *core* — anything gentler and the whole sky lifts instead.
  float core = smoothstep(0.58, 1.02, f2);
  col += uWarm * core * core * 0.45 * uDensity;

  /*
   * Stars, behind the gas rather than in front of it.
   *
   * A grid of cells, most of them empty; the ones that are not get a jittered
   * position inside the cell, or the whole sky is a lattice. The twinkle is per
   * star and at a per-star rate, because a sky that pulses in unison reads as
   * the screen flickering rather than as stars.
   */
  vec3 sp = dir * 190.0;
  vec3 si = floor(sp);
  float sh = hash13(si);
  if (sh > 0.9955) {
    vec3 jitter = vec3(hash13(si + 11.0), hash13(si + 23.0), hash13(si + 37.0)) * 0.6 + 0.2;
    float d = length(fract(sp) - jitter);
    float rate = 1.2 + fract(sh * 71.0) * 3.4;
    float twinkle = 0.55 + 0.45 * sin(t * rate + sh * 120.0);
    // Dimmed where the gas is thick, so the cloud reads as being in front.
    col += vec3(0.86, 0.91, 1.0) * smoothstep(0.34, 0.0, d) * twinkle
      * (1.0 - cloud * 0.75) * smoothstep(0.0, 0.25, h);
  }

  /*
   * One meteor at a time, on a fresh arc every few seconds.
   *
   * floor(t / period) names the meteor and seeds where it goes, fract() is
   * how far along it is — so there is no state to keep and every client draws
   * the same streak at the same moment without anything being sent about it.
   */
  float mt = t / 6.5;
  float mi = floor(mt), mf = fract(mt);
  vec3 axis = normalize(vec3(hash13(vec3(mi, 1.0, 2.0)) - 0.5,
    0.30 + hash13(vec3(mi, 3.0, 4.0)) * 0.55,
    hash13(vec3(mi, 5.0, 6.0)) - 0.5));
  vec3 side = normalize(cross(axis, vec3(0.0, 1.0, 0.0)));
  vec3 head = normalize(axis + side * (mf * 1.5 - 0.75));
  vec3 tail = normalize(axis + side * (max(0.0, mf - 0.055) * 1.5 - 0.75));
  vec3 seg = head - tail;
  float along = clamp(dot(dir - tail, seg) / max(1e-5, dot(seg, seg)), 0.0, 1.0);
  float dSeg = length(dir - (tail + seg * along));
  // Brightest at the head, fading down the tail, and faded in and out at both
  // ends of its run so it never pops into or out of existence.
  col += vec3(1.0, 0.95, 0.98) * smoothstep(0.016, 0.0, dSeg) * (0.2 + 0.8 * along)
    * 2.0 * smoothstep(0.0, 0.06, mf) * smoothstep(0.9, 0.6, mf);

  // Down into the haze, then into the fog the level itself is standing in, so
  // there is never a visible seam where the dome meets the ground.
  col = mix(uHaze, col, smoothstep(-0.03, 0.40, h));
  col = mix(uFog, col, smoothstep(-0.30, -0.01, h));
  gl_FragColor = vec4(col, 1.0);
}`;

export class GameWorld {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {?THREE.WebGLRenderer} renderer an existing renderer to draw with.
   *        Only the tests pass one; the game always makes its own.
   */
  constructor(canvas, renderer = null) {
    this.canvas = canvas;
    const q = quality();

    /*
     * Multisampling on the *canvas* is only worth asking for when the world is
     * drawn straight onto it.
     *
     * With the post chain on, every triangle lands in `PostFX.sceneRT` and the
     * default framebuffer only ever sees one full-screen quad — so an MSAA back
     * buffer antialiases the edges of two triangles that have no visible edges,
     * and charges a multisample resolve of the whole screen for it, every
     * frame, at up to twice the device pixel ratio. It is pure cost with
     * nothing on the other side of it.
     *
     * Read once, at construction, because a WebGL context cannot change its
     * sample count afterwards: somebody who plays with post-processing off gets
     * the buffer from the moment the page loads, and toggling the setting
     * mid-session moves the antialiasing at the next reload.
     */
    const wantsPost = q.post && postAmount() > 0;

    this.renderer = renderer ?? new THREE.WebGLRenderer({
      canvas, antialias: q.antialias && !wantsPost, powerPreference: 'high-performance',
      stencil: false, depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.shadowMap.enabled = settings.shadows && q.shadowMap > 0;
    // PCFSoft is a deprecated alias that three downgrades to PCF on the first
    // frame anyway; naming the real one skips the warning and the recompile.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Driven by hand from `render`, at `shadowHz` rather than at frame rate.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = true;
    /** Seconds since the shadow map was last redrawn — see `render`. */
    this._shadowAcc = 1;

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
    // cold bounce from below stops undersides reading as holes. Both are built
    // whatever the preset says; `_applyRig` decides whether they are *in* the
    // scene, because that is the part a shader pays for.
    this.fill = new THREE.DirectionalLight(0x9fc0ff, 0.46);
    this.fill.position.set(-40, 30, -30);

    this.bounce = new THREE.DirectionalLight(0xffe6c0, 0.24);
    this.bounce.position.set(10, -40, 10);

    this.rigLit = false;
    this._applyRig();
  }

  /**
   * Adds or removes the two support lights, and pays for their absence.
   *
   * Only ever called from construction and from a settings change: three.js
   * recompiles every material in the scene when the light counts move, which is
   * a one-frame hitch where it belongs (the moment you press the setting) and
   * an unacceptable one anywhere else.
   */
  _applyRig() {
    const want = quality().fillRig !== false;
    if (want === this.rigLit) return false;
    this.rigLit = want;
    if (want) {
      this.scene.add(this.fill);
      this.scene.add(this.bounce);
    } else {
      this.scene.remove(this.fill);
      this.scene.remove(this.bounce);
    }
    this._applyAmbient();
    return true;
  }

  /**
   * The hemisphere term, lifted when the rig is not there to help it.
   *
   * A map's palette says how much ambient it wants; this is that number plus
   * whatever the fill and the bounce would have contributed had they been in
   * the scene, so dropping them changes how the light *falls* without changing
   * how bright the level is.
   */
  _applyAmbient() {
    const base = (this.map?.ambient?.intensity ?? 0.7) * AMBIENT_GAIN;
    this.hemi.intensity = this.rigLit ? base : base * 1.34;
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
    const amount = postAmount();
    const usePost = quality().post && amount > 0;
    const want = usePost ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    const bright = settings.brightness ?? 0;
    const sat = Math.max(0, settings.saturation ?? 1);
    const con = Math.max(0.1, settings.contrast ?? 1);
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
      /*
       * The four effects, scaled together by the amount.
       *
       * Each one keeps its own switch — somebody who wants the bloom and not
       * the grain still gets to say so — and the amount is a master fader over
       * whichever of them are on. Scaled rather than switched off in turn
       * because the chain is a look rather than a list: half the bloom with
       * half the vignette and half the fringing is the same picture, quieter,
       * and dropping them one at a time is three different pictures.
       *
       * Tone mapping and the grade are deliberately *not* faded. They are what
       * makes the render correct rather than what makes it pretty — an
       * un-tone-mapped frame is not a subtler frame, it is a blown-out one —
       * so they are on in full for every amount above zero, and handed to the
       * renderer itself at zero.
       */
      bloom: (settings.bloom ?? 0.62) * amount,
      // One vignette, in the post chain. #grade used to stack a second, far
      // heavier one on top of this in CSS.
      vignette: (settings.vignette ? 0.2 : 0.05) * amount,
      grain: (settings.filmGrain ? 0.024 : 0) * amount,
      chroma: (settings.chromatic ? 0.55 : 0) * amount,
      exposure: 1.14 + bright,
      gamma: 1.16 + Math.max(0, bright) * 0.4,
      saturation: BASE_SATURATION * sat,
      contrast: BASE_CONTRAST * con,
    });

    /*
     * The same grade, for the frames the post chain does not draw.
     *
     * With post-processing off there is no composite pass to put a grade in, so
     * a saturation slider would move and nothing would happen — which is worse
     * than not having one. The browser's compositor can do both, on the canvas,
     * and it is exactly free while the values are at their defaults: the filter
     * string is empty and there is no extra layer to composite. It is only ever
     * one of the two, never both.
     */
    const css = usePost || (sat === 1 && con === 1) ? '' : `saturate(${sat}) contrast(${con})`;
    const canvas = this.renderer.domElement;
    if (canvas?.style && canvas.style.filter !== css) canvas.style.filter = css;
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
    this._applyAmbient();
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
    this.invalidateShadows();
  }

  /**
   * Gradient dome with a sun disc, horizon haze and a band of soft cloud.
   *
   * `sky.clouds` scales the cloud band from 0 (a clean poster-flat sky, which
   * is what the town maps want) up through 1 (the default overcast drift).
   */
  _buildSky(sky, map) {
    // A map that declares a nebula gets the shader dome instead of the painted
    // one. Both end up as a 600-unit sphere on `this.skyDome` drawn last, so
    // everything downstream — the camera follow in `render`, the teardown in
    // `setMap` — is the same for either.
    if (sky.nebula) return this._buildNebulaSky(sky, map);

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
    /*
     * Drawn *after* the world, not before it.
     *
     * The dome used to render first, which meant shading a full screen of sky
     * texture and then covering nearly all of it with the level — a whole
     * frame's worth of overdraw thrown away every frame. Sorted last among the
     * opaques it still writes no depth, so it cannot occlude anything, but the
     * depth test rejects it wherever the map already stands: only the sky you
     * can actually see costs anything to draw.
     */
    dome.renderOrder = 1000;
    dome.frustumCulled = false;
    this.mapGroup.add(dome);
    this.skyDome = dome;
    this._perMapTextures.push(tex);
  }

  /**
   * The animated sky: two drifting gas fields, stars behind them and a meteor.
   *
   * `sky.nebula` carries the art direction and nothing structural:
   *
   *   warm / cool   the two colours the gas is mixed between. On the map this
   *                 was written for they are magenta and cyan; nothing stops
   *                 them being anything else.
   *   density       how far the gas is allowed to lift the sky. Past about 1.4
   *                 it stops reading as gas and starts reading as fog.
   *   speed         a multiplier on the whole animation, so a map can have a
   *                 sky that barely moves without editing the shader.
   *
   * The octave count comes off the quality setting rather than the map: it is
   * the only knob in here that costs frame time, and which of the two it should
   * answer to is the player's machine, not the level designer's taste.
   */
  _buildNebulaSky(sky, map) {
    const q = quality();
    const neb = sky.nebula;
    const hex = (n, fallback) => new THREE.Color(n ?? fallback);

    const material = new THREE.ShaderMaterial({
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      defines: { OG_OCTAVES: q.sky >= 56 ? 5 : q.sky >= 40 ? 4 : 3 },
      uniforms: {
        uTime: { value: 0 },
        uTop: { value: hex(sky.top, 0x0a0a1e) },
        uBottom: { value: hex(sky.bottom, 0x1b1030) },
        uHaze: { value: hex(sky.haze ?? sky.bottom, 0x2a1840) },
        uFog: { value: hex(map.fog?.color, 0x1a1130) },
        uWarm: { value: hex(neb.warm, 0xff4fa3) },
        uCool: { value: hex(neb.cool, 0x3a7dff) },
        uDensity: { value: neb.density ?? 1 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(600, Math.max(24, q.sky), Math.max(16, q.sky / 2)),
      material);
    // Same contract as the painted dome: written last, writes no depth, so it
    // only shades the sky that is actually visible past the level.
    dome.renderOrder = 1000;
    dome.frustumCulled = false;
    this.mapGroup.add(dome);
    this.skyDome = dome;
    /** Non-null only while an animated sky is up; `render` advances it. */
    this.skyTime = material.uniforms.uTime;
    this.skySpeed = neb.speed ?? 1;
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
    // The floor is where it is for the life of the map; nothing has to walk it
    // through `updateMatrixWorld` sixty times a second to find that out.
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
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

    /*
     * …and, on a level big enough for it to matter, per *place* as well.
     *
     * One mesh per material for the whole map is the fewest draw calls, and it
     * was the wrong trade the moment a map got large. A batch that spans the
     * level can never be frustum-culled, so every box in it is transformed and
     * submitted whichever way the player is facing; and because the renderer
     * sorts opaques by distance *per object*, one map-wide batch also sorts as
     * one thing, which throws away early-Z and makes the GPU shade every wall
     * the player cannot see behind the wall they can.
     *
     * Splitting each material into a grid of chunks fixes both. Château is six
     * thousand three hundred boxes over a hundred and twenty metres — five
     * times the next biggest map in the game — and standing in a hedge alley
     * looking north, most of that is behind the player. Chunks let it be
     * skipped, and let the rest reach the depth buffer nearest-first.
     *
     * Small maps are left in one piece on purpose: a draw call the renderer
     * cannot skip is a draw call paid for twice, and a level that fits inside
     * one chunk has nothing to cull.
     */
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const b of boxes) {
      if (b.x < minX) minX = b.x;
      if (b.x > maxX) maxX = b.x;
      if (b.z < minZ) minZ = b.z;
      if (b.z > maxZ) maxZ = b.z;
    }
    const span = Math.max(maxX - minX, maxZ - minZ);
    const chunked = boxes.length >= CHUNK_MIN_BOXES && span > CHUNK_SIZE * 1.5;

    // By surface first — the material decides the texture, shadow casting
    // decides which of two meshes a box lands in, and `glow` decides whether it
    // is lit at all. A glowing box never casts, so the two flags collapse.
    const surfaces = new Map();
    for (const b of boxes) {
      const mat = b.mat ?? SURFACE.CONCRETE;
      const surface = `${mat}|${b.glow || b.noShadow ? 1 : 0}|${b.glow ? 1 : 0}`;
      let list = surfaces.get(surface);
      if (!list) surfaces.set(surface, (list = []));
      list.push(b);
    }

    /*
     * …then by place, but only where that buys something.
     *
     * A chunk earns its draw call by being skippable, and a chunk of twenty
     * boxes cannot possibly save more time than submitting it costs. So a
     * surface is only split when there is enough of it to be worth splitting,
     * and inside that split every cell too thin to matter is swept back into
     * one leftover batch that is never culled. Château ends up with the
     * façade, the terrace and each bosquet as their own chunks — which is
     * exactly the granularity that turning round can skip — instead of three
     * hundred batches of nothing.
     */
    const groups = new Map();
    for (const [surface, list] of surfaces) {
      if (!chunked || list.length < CHUNK_MIN_SURFACE) {
        groups.set(`${surface}#all`, list);
        continue;
      }
      const cells = new Map();
      for (const b of list) {
        const cell = `${Math.floor((b.x - minX) / CHUNK_SIZE)},${Math.floor((b.z - minZ) / CHUNK_SIZE)}`;
        let bucket = cells.get(cell);
        if (!bucket) cells.set(cell, (bucket = []));
        bucket.push(b);
      }
      const rest = [];
      for (const [cell, bucket] of cells) {
        if (bucket.length >= CHUNK_MIN_CELL) groups.set(`${surface}#${cell}`, bucket);
        else rest.push(...bucket);
      }
      if (rest.length) groups.set(`${surface}#all`, rest);
    }

    const shadows = this.renderer.shadowMap.enabled;
    const usePhong = quality().phong;
    const m = new THREE.Matrix4();
    const col = new THREE.Color();

    // One material per surface, shared by every chunk that wears it: the
    // uniforms and the compiled program are identical, and a second copy is a
    // second set of state changes for nothing.
    const materials = new Map();

    for (const [key, list] of groups) {
      const surfaceKey = key.slice(0, key.indexOf('#'));
      const flags = surfaceKey.split('|');
      const surface = flags[0];
      const glows = flags[2] === '1';
      const casts = shadows && flags[1] === '0';
      const tex = surfaceTexture(surface);
      const shading = SURFACE_SHADING[surface] ?? { shininess: 6, specular: 0x101010 };
      const tile = SURFACE_TILE[surface] ?? 4;

      /*
       * A light source, drawn rather than lit.
       *
       * A sun-lit box at midnight is a dark box, and a night map built out of
       * them is a night map you cannot read. What makes neon *look* like neon
       * is that it is brighter than white: the scene renders into a half-float
       * buffer, so a basic material whose colour multiplies past 1.0 survives
       * as an over-bright value all the way to the composite, where the bright
       * pass picks it up (threshold 0.85) and blooms it, and ACES pulls the
       * core toward white while keeping the halo's hue. That is the entire
       * lighting model for a strip light, and it costs one more draw call.
       *
       * Fog stays on. A sign two hundred metres away that does not fade into
       * the haze reads as a decal on the lens rather than as something standing
       * in the world.
       */
      let material = materials.get(surfaceKey);
      if (!material) {
        material = glows
          ? new THREE.MeshBasicMaterial({ map: tex, vertexColors: true })
          : usePhong
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
        material.customProgramCacheKey = () => `og-box-${glows ? 'e' : usePhong ? 'p' : 'l'}`;
        materials.set(surfaceKey, material);
      }

      const mesh = new THREE.InstancedMesh(this.boxGeo, material, list.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.castShadow = casts;
      mesh.receiveShadow = shadows;
      // A chunk is worth testing against the frustum; a batch that spans the
      // level is not, because the test can only ever come back "yes".
      mesh.frustumCulled = chunked && !key.endsWith('#all');
      mesh.userData.noShadow = !casts;

      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        m.makeScale(b.w, b.h, b.d);
        m.setPosition(b.x, b.y + b.h / 2, b.z);
        mesh.setMatrixAt(i, m);
        col.setHex(b.c ?? 0x999999);
        if (glows) {
          // No jitter on a light. The tint variation below exists to break up
          // large flat surfaces that would otherwise read as one poster-flat
          // slab; a strip light that is randomly a shade dimmer than the strip
          // next to it reads as a fault in the strip. What varies here is
          // deliberate: `glow` is how far past white this particular fitting
          // pushes, which is what decides whether it merely reads as lit or
          // throws a halo. The instance colour buffer is floats, so it holds
          // values over 1 without clipping.
          col.multiplyScalar(typeof b.glow === 'number' ? b.glow : 1.55);
        } else {
          // Deterministic per-box tint jitter breaks up large flat surfaces.
          // Seeded from where the box *is* rather than from its index in the
          // batch, so splitting a material into chunks cannot repaint the map.
          col.offsetHSL(0, 0, (tintJitter(b) - 0.5) * 0.055);
          if (b.roof) col.offsetHSL(0, 0, 0.025);
        }
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;              // static for the life of the map
      // Worked out now rather than on the first frame that needs it: the bound
      // is what the frustum test reads, and computing it mid-match would be a
      // hitch on exactly the frame the player turned round.
      if (mesh.frustumCulled) mesh.computeBoundingSphere();
      this.mapGroup.add(mesh);
      this.batches.push(mesh);
    }
  }

  _disposeGroup(group) {
    // One material is now worn by every chunk that shares its surface, so the
    // set is collected first and released once — disposing the same material
    // per mesh would fire its teardown a dozen times over.
    const mats = new Set();
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      group.remove(child);
      // The shared box geometry and the cached surface textures outlive every
      // map; only per-map geometry and cloned textures get released.
      if (child.geometry && child.geometry !== this.boxGeo) child.geometry.dispose();
      for (const mat of Array.isArray(child.material) ? child.material : [child.material]) {
        if (mat) mats.add(mat);
      }
    }
    for (const mat of mats) mat.dispose();
    // Surface textures are cached and shared across maps; only the ones built
    // for this map in particular (the sky dome, the ground's own repeat clone)
    // are ours to release.
    for (const tex of this._perMapTextures) tex.dispose();
    this._perMapTextures.length = 0;
    this.batches.length = 0;
    this.ground = null;
    this.skyDome = null;
    // Cleared with the dome that owned it: a stale uniform reference would keep
    // being ticked every frame for a sky that is no longer in the scene, and on
    // the next map would be the one thing left pointing at a disposed material.
    this.skyTime = null;
    this.skySpeed = 1;
  }

  /* ── Frame ─────────────────────────────────────────────────────────────── */

  resize() {
    const winW = window.innerWidth, winH = window.innerHeight;
    // `setSize` takes CSS pixels and multiplies by whatever pixel ratio is
    // already set on the renderer to get the real drawing buffer — so the
    // height that lands on the resolution cap is winH scaled back down by
    // that same ratio, not winH itself. Computed rather than read off the
    // renderer because it is set to exactly this, right before every call
    // that reaches here — see the constructor and `applySettings` below.
    const pixelRatio = Math.min(window.devicePixelRatio, quality().pixelRatio);
    const h = Math.min(winH, resolutionCap() / pixelRatio);
    const w = h * (winW / winH);
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
    // three.js tracks the lights' state version itself and rebuilds any program
    // whose light counts no longer match, so nothing has to be marked here.
    this._applyRig();
    this._configureShadow();
    this.invalidateShadows();
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
   * Decides whether this frame redraws the shadow map.
   *
   * `shadowMap.autoUpdate` is off, so three only runs the depth pass on the
   * frames this arms it for. Skipping one leaves the *previous* map in place
   * along with the matrix it was rendered with — three computes both together
   * — so a stale shadow stays pinned to the world exactly where it was rather
   * than swimming, which is what makes the saving free.
   */
  _tickShadow(dt) {
    if (!this.renderer.shadowMap.enabled) return;
    const hz = quality().shadowHz ?? 60;
    this._shadowAcc += dt;
    // The same slack the frame cap uses: a display running at exactly `hz`
    // must not drop every other update to floating-point noise.
    if (this._shadowAcc < 1 / hz - 0.0008) return;
    this._shadowAcc = 0;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** Redraws the shadow map on the next frame, whatever the clock says. */
  invalidateShadows() {
    this._shadowAcc = 1;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Draws the world, then hands the buffer to the viewmodel to draw its gun on
   * top with a cleared depth buffer, then resolves post-processing.
   * @param {?function} drawOverlay called with the render target still bound
   */
  render(dt = 0.016, drawOverlay = null) {
    if (this.skyDome) this.skyDome.position.copy(this.camera.position);
    // An animated sky is one uniform. It is advanced here rather than from a
    // clock inside the shader because that is the only place that knows the
    // frame actually happened: a tab in the background stops drawing, and a sky
    // driven by wall time would have jumped a minute when it came back.
    if (this.skyTime) this.skyTime.value += dt * this.skySpeed;
    this._tickShadow(dt);

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

  /* ── Developer render toggles ─────────────────────────────────────────────
   *
   * Four local drawing choices, driven by the overlay in devmode.js. Every one
   * of them changes only how this client draws a frame — none touches the
   * simulation, none is sent anywhere, and none shows a player anything about
   * anybody else. The collision overlay in particular draws the *map's* own
   * volumes, which is static data this client downloaded before the match
   * started; it has never known where a person is and cannot be made to.
   * ─────────────────────────────────────────────────────────────────────── */

  /**
   * Wireframe over the whole scene.
   *
   * The flag is remembered as well as applied, because the scene is not a
   * fixed set of materials — a map change rebuilds it and a player joining adds
   * to it — so `_applyWireframe` runs again over whatever is there now on the
   * next toggle rather than leaving half a scene solid.
   */
  setWireframe(on) {
    this._wireframe = !!on;
    this.scene.traverse((obj) => {
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) if ('wireframe' in m) m.wireframe = this._wireframe;
    });
    this.invalidateShadows();
  }

  /**
   * Bypasses the post chain, so what reaches the screen is what the renderer
   * actually drew. Bloom, grain and chromatic aberration hide a surprising
   * amount, and "is that artefact mine or the post's" is the question this
   * exists to answer in one keypress.
   */
  setPostEnabled(on) {
    this.post.enabled = !!on && postAmount() > 0;
  }

  /**
   * Draws the map's collision volumes — the boxes the *server* is stepping
   * against, which is the whole reason this is worth looking at. A prop you
   * can walk through and a wall you cannot see are the same bug from two
   * sides, and both of them are one glance at this.
   *
   * One `LineSegments` over one merged buffer, not a mesh per box. A map is a
   * few hundred volumes and three hundred extra draw calls would show up in
   * the performance panel sitting directly above this one — a debug overlay
   * that moves the numbers on the other debug overlay is worse than useless.
   *
   * Built once and kept: collision does not move. Toggling off hides the
   * object rather than throwing it away, and a different World is what
   * rebuilds it.
   */
  setCollisionDebug(on, world) {
    if (!on) { if (this._collision) this._collision.visible = false; return; }
    if (!world) return;

    if (!this._collision || this._collisionFor !== world) {
      if (this._collision) {
        this.scene.remove(this._collision);
        this._collision.geometry.dispose();
      }
      // Twelve edges a box, two vertices an edge.
      const verts = new Float32Array(world.count * 24 * 3);
      let v = 0;
      const put = (x, y, z) => { verts[v++] = x; verts[v++] = y; verts[v++] = z; };
      const edge = (ax, ay, az, bx, by, bz) => { put(ax, ay, az); put(bx, by, bz); };
      for (let i = 0; i < world.count; i++) {
        const x0 = world.min[i * 3], y0 = world.min[i * 3 + 1], z0 = world.min[i * 3 + 2];
        const x1 = world.max[i * 3], y1 = world.max[i * 3 + 1], z1 = world.max[i * 3 + 2];
        // Bottom ring, top ring, then the four uprights joining them.
        edge(x0, y0, z0, x1, y0, z0); edge(x1, y0, z0, x1, y0, z1);
        edge(x1, y0, z1, x0, y0, z1); edge(x0, y0, z1, x0, y0, z0);
        edge(x0, y1, z0, x1, y1, z0); edge(x1, y1, z0, x1, y1, z1);
        edge(x1, y1, z1, x0, y1, z1); edge(x0, y1, z1, x0, y1, z0);
        edge(x0, y0, z0, x0, y1, z0); edge(x1, y0, z0, x1, y1, z0);
        edge(x1, y0, z1, x1, y1, z1); edge(x0, y0, z1, x0, y1, z1);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: 0x4ddb7a, transparent: true, opacity: 0.7, depthTest: true,
      }));
      lines.name = 'dev:collision';
      lines.frustumCulled = false;
      this._collision = lines;
      this._collisionFor = world;
      this.scene.add(lines);
    }
    this._collision.visible = true;
  }

  /**
   * Stops the camera's frustum from being recomputed, so culling freezes where
   * it stands and you can fly out and look at what was really being drawn.
   *
   * three culls against `camera.matrixWorld`, so freezing means taking the
   * matrix out of the automatic update and putting it back untouched.
   */
  setFrustumFrozen(on) {
    this.camera.matrixAutoUpdate = !on;
    if (!on) this.camera.updateMatrixWorld(true);
  }
}

function markDirty(material) {
  if (Array.isArray(material)) material.forEach(markDirty);
  else if (material) material.needsUpdate = true;
}

export default GameWorld;
