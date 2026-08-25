/**
 * Open Grunker — post-processing.
 *
 * A deliberately small chain: the world renders into a half-float buffer, a
 * quarter-resolution bright pass is blurred twice, and one composite shader
 * does bloom, ACES tone mapping, colour grade, vignette, chromatic aberration
 * and film grain in a single pass. That is four extra draws per frame, three of
 * them at a sixteenth of the pixels — cheap enough that the whole thing fits
 * inside the frame budget of an integrated GPU, and it is most of the reason
 * the game stops looking like flat WebGL.
 *
 * Nothing here depends on three's example add-ons: the client ships one
 * three.js module and no build step, so the passes are written out by hand.
 */
import * as THREE from 'three';

const QUAD_VS = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT_FS = `
uniform sampler2D tDiffuse;
uniform vec2 texel;
uniform float threshold;
uniform float knee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * texel).rgb;
  c += texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * texel).rgb;
  c += texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * texel).rgb;
  c += texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * texel).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float k = threshold * knee + 1e-5;
  float soft = clamp(br - threshold + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k);
  float contrib = max(soft, br - threshold) / max(br, 1e-5);
  gl_FragColor = vec4(c * contrib, 1.0);
}`;

const BLUR_FS = `
uniform sampler2D tDiffuse;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  // Nine-tap gaussian, sampled between texels so it costs five fetches.
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
  vec2 o1 = dir * 1.3846153846;
  vec2 o2 = dir * 3.2307692308;
  sum += texture2D(tDiffuse, vUv + o1).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv - o1).rgb * 0.3162162162;
  sum += texture2D(tDiffuse, vUv + o2).rgb * 0.0702702703;
  sum += texture2D(tDiffuse, vUv - o2).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

const COMPOSITE_FS = `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float bloom;
uniform float exposure;
uniform float gamma;
uniform float vignette;
uniform float grain;
uniform float chroma;
uniform float saturation;
uniform float contrast;
uniform float time;
uniform float flash;
uniform vec3  flashColor;
uniform float damage;
varying vec2 vUv;

vec3 acesFilm(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 sRGB(vec3 v) {
  return mix(pow(v, vec3(0.41666)) * 1.055 - 0.055, v * 12.92,
             vec3(lessThanEqual(v, vec3(0.0031308))));
}

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);

  vec3 col;
  if (chroma > 0.0001) {
    // Lens fringing that only shows at the edge of the frame, never on the dot.
    vec2 off = d * chroma * r2;
    col.r = texture2D(tDiffuse, uv + off).r;
    col.g = texture2D(tDiffuse, uv).g;
    col.b = texture2D(tDiffuse, uv - off).b;
  } else {
    col = texture2D(tDiffuse, uv).rgb;
  }

  col += texture2D(tBloom, uv).rgb * bloom;
  col *= exposure;
  col = acesFilm(col);

  // ACES has a long, dark toe. A gamma lift on the tone-mapped result opens the
  // shadows back up without touching the highlights (pow(1, x) is still 1), so
  // an interior or a night map reads instead of going to mud.
  col = pow(max(col, 0.0), vec3(1.0 / gamma));

  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, saturation);
  col = (col - 0.5) * contrast + 0.5;

  // Muzzle / explosion wash, then the damage vignette on top of it.
  col = mix(col, flashColor, flash);
  if (damage > 0.0001) {
    float edge = smoothstep(0.06, 0.5, r2);
    col = mix(col, vec3(0.62, 0.03, 0.03), edge * damage);
  }

  col *= 1.0 - vignette * smoothstep(0.18, 0.82, r2 * 1.7);

  if (grain > 0.0001) {
    float n = fract(sin(dot(uv * 1024.0 + time, vec2(12.9898, 78.233))) * 43758.5453);
    col += (n - 0.5) * grain;
  }

  gl_FragColor = vec4(sRGB(max(col, 0.0)), 1.0);
}`;

/** Bloom resolution divisor per quality level. */
const BLOOM_DIV = { low: 6, medium: 5, high: 4, ultra: 3 };

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = false;
    this.width = 1;
    this.height = 1;
    this.div = 4;

    const type = renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.hdrType = type;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.sceneRT = this._makeRT(1, 1, true);
    this.brightRT = this._makeRT(1, 1, false);
    this.blurRT = this._makeRT(1, 1, false);

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: BRIGHT_FS, depthTest: false, depthWrite: false,
      uniforms: {
        tDiffuse: { value: null }, texel: { value: new THREE.Vector2() },
        threshold: { value: 0.85 }, knee: { value: 0.6 },
      },
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false,
      uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } },
    });
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: COMPOSITE_FS, depthTest: false, depthWrite: false,
      uniforms: {
        tDiffuse: { value: null }, tBloom: { value: null },
        bloom: { value: 0.62 }, exposure: { value: 1.16 }, gamma: { value: 1.16 },
        vignette: { value: 0.2 },
        grain: { value: 0.022 }, chroma: { value: 0.5 },
        // ACES rolls the highlights off and takes a little colour with them.
        // The maps are painted in flat, saturated hex; putting some of it back
        // here is what keeps a cobalt-blue house cobalt blue in full sun
        // instead of powder blue.
        saturation: { value: 1.14 },
        contrast: { value: 1.03 }, time: { value: 0 },
        flash: { value: 0 }, flashColor: { value: new THREE.Color(1, 0.86, 0.6) },
        damage: { value: 0 },
      },
    });

    /** Transient screen wash, driven by the game layer. */
    this.flash = 0;
    this.damage = 0;
    /** Scratch for the drawing-buffer size query, which runs every frame. */
    this._size = new THREE.Vector2();
  }

  _makeRT(w, h, hdr) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: hdr ? this.hdrType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: hdr,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return rt;
  }

  /** Applies the quality preset and the player's toggles. */
  configure({
    enabled, quality = 'high', bloom = 0.62, vignette = 0.2, grain = 0.022,
    chroma = 0.5, exposure = 1.16, gamma = 1.16,
  }) {
    this.enabled = !!enabled;
    this.div = BLOOM_DIV[quality] ?? 4;
    const u = this.compositeMat.uniforms;
    u.bloom.value = bloom;
    u.vignette.value = vignette;
    u.grain.value = grain;
    u.chroma.value = chroma;
    u.exposure.value = exposure;
    u.gamma.value = Math.max(0.6, gamma);
    this.setSize(this.width, this.height, true);
  }

  setSize(w, h, force = false) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (!force && w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.sceneRT.setSize(w, h);
    const bw = Math.max(1, Math.floor(w / this.div));
    const bh = Math.max(1, Math.floor(h / this.div));
    this.brightRT.setSize(bw, bh);
    this.blurRT.setSize(bw, bh);
    this.brightMat.uniforms.texel.value.set(1 / w, 1 / h);
  }

  /** Points the renderer at the offscreen buffer. */
  begin() {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(this._size);
    this.setSize(size.x, size.y);
    r.setRenderTarget(this.sceneRT);
    r.clear();
  }

  _blit(material) {
    this.quad.material = material;
    this.renderer.render(this.scene, this.camera);
  }

  /** Runs the chain and presents to the default framebuffer. */
  end(dt = 0.016) {
    const r = this.renderer;

    // Bright pass at 1/div resolution.
    this.brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
    r.setRenderTarget(this.brightRT);
    this._blit(this.brightMat);

    const bw = this.brightRT.width, bh = this.brightRT.height;
    this.blurMat.uniforms.tDiffuse.value = this.brightRT.texture;
    this.blurMat.uniforms.dir.value.set(1 / bw, 0);
    r.setRenderTarget(this.blurRT);
    this._blit(this.blurMat);

    this.blurMat.uniforms.tDiffuse.value = this.blurRT.texture;
    this.blurMat.uniforms.dir.value.set(0, 1 / bh);
    r.setRenderTarget(this.brightRT);
    this._blit(this.blurMat);

    const u = this.compositeMat.uniforms;
    u.tDiffuse.value = this.sceneRT.texture;
    u.tBloom.value = this.brightRT.texture;
    u.time.value = (u.time.value + dt * 60) % 1000;
    this.flash = Math.max(0, this.flash - dt * 6.5);
    this.damage = Math.max(0, this.damage - dt * 3.2);
    u.flash.value = Math.min(0.6, this.flash);
    u.damage.value = Math.min(0.85, this.damage);

    r.setRenderTarget(null);
    this._blit(this.compositeMat);
  }

  /** A brief full-screen wash — explosions, being blinded, big hits. */
  addFlash(amount, color = null) {
    this.flash = Math.min(0.75, this.flash + amount);
    if (color) this.compositeMat.uniforms.flashColor.value.setHex(color);
  }

  addDamage(amount) {
    this.damage = Math.min(1, this.damage + amount);
  }

  dispose() {
    this.sceneRT.dispose();
    this.brightRT.dispose();
    this.blurRT.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.quad.geometry.dispose();
  }
}

export default PostFX;
