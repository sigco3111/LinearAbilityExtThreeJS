import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The two passes an arc is drawn in — same geometry, same path, only the ribbon
 * width and the cross-ribbon profile differ. As `materials/LightningMaterial.js`.
 */
export const ArcPass = Object.freeze({
  CORE: 0, // the hot filament
  GLOW: 1 // the halo it sits inside
});

/**
 * Lightning struck over and off the caster's own body.
 *
 * Where `LightningMaterial` draws one bundle of filaments between two points a
 * cast decided on, this draws **many independent arcs on a body**, and the CPU
 * never picks a single one of them: an arc's two ends, its shape, when it
 * strikes and when it dies are all derived in the vertex shader from the arc's
 * index and the clock.
 *
 * ## The capsule
 *
 * The body is described to the shader as five numbers — `uBase` (the feet),
 * `uHeight`, `uRadius`, `uDepth` (front-to-back, so the cross-section is the
 * ellipse a person actually is) and `uProfile`, which blends between a plain
 * cylinder and a silhouette that narrows at the ankles and the head. Two angles
 * and two heights therefore name any pair of points on the body, which is all
 * an arc is.
 *
 * ## The cycle
 *
 * Each arc runs its own clock: `uTime * uRate + hash(index)`. The integer part
 * seeds the strike — new endpoints, new kinks — and the fractional part is its
 * life, lit for `uLife` of the cycle and dark for the rest. Staggering the
 * phase by index is what stops the whole set strobing in unison; re-seeding on
 * the integer part is what makes each strike a *different* arc rather than the
 * same one flickering.
 *
 * ## On the body, and off it
 *
 * `uEscape` is the fraction of arcs whose far end leaves the capsule instead of
 * landing back on it, reaching `uReach` metres out and biased upward. Those are
 * the ones that read as lightning coming *off* the character; the rest crawl
 * over the skin and hold the silhouette together. Every arc also bows off the
 * surface at mid-span by `uBow`, along the body's own radial — without it an
 * arc between two points on the chest would be buried inside the mesh.
 */
const ARC_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;

  uniform vec3  uBase;
  uniform vec3  uRight;
  uniform vec3  uForward;
  uniform float uHeight;
  uniform float uRadius;
  uniform float uDepth;
  uniform float uLow;
  uniform float uHigh;
  uniform float uProfile;

  uniform float uRate;
  uniform float uLife;
  uniform float uSpan;
  uniform float uSweep;
  uniform float uEscape;
  uniform float uReach;
  uniform float uBow;

  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;

  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uTaper;
  uniform float uCoreWidth;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vLive;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  /** Value noise with a *linear* ramp: piecewise-linear output, sharp corners. */
  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  /** Octaves of it, in the plane perpendicular to the arc. */
  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;

    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }

  /**
   * A point on the body.
   * @param h  0..1 up the body   @param a  radians around it
   * @param outward  metres out from the surface (0 = on it)
   */
  vec3 bodyPoint(float h, float a, float outward) {
    // Widest at the waist, narrow at the ankles and the head — enough of a
    // silhouette that arcs gather where the body is, and cheap enough to be one
    // sine. uProfile flattens it back to a cylinder.
    float shape = 0.42 + 0.72 * sin(clamp(h, 0.0, 1.0) * PI);
    float r = uRadius * mix(1.0, shape, clamp(uProfile, 0.0, 1.0)) + outward;
    return uBase
      + vec3(0.0, h * uHeight, 0.0)
      + uRight * (cos(a) * r)
      + uForward * (sin(a) * r * uDepth);
  }

  vec3 arcPoint(float t, vec3 p0, vec3 p1, vec3 bow, float seed, vec3 n1, vec3 n2, float span) {
    vec3 axis = mix(p0, p1, t) + bow * sin(t * PI);
    // Both ends are pinned: an arc has to actually touch the body it leaves.
    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) * smoothstep(0.0, pinch, 1.0 - t);
    vec2 offset = kink(t, seed, span) * uJitter * ends;
    return axis + n1 * offset.x + n2 * offset.y;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* ---- this arc's own clock ---- */
    float phase = hash11(aStrand * 3.71 + uSeed * 0.13);
    float cycle = uTime * max(uRate, 0.01) + phase;
    float strike = floor(cycle);
    float k = fract(cycle);
    float seed = hash11(aStrand * 7.13 + strike * 3.77 + uSeed) * 97.0;

    // Lit for the front of its cycle: on hard, off soft. Lightning arrives.
    float life = clamp(uLife, 0.02, 1.0);
    vLive = smoothstep(0.0, 0.06 * life, k) * (1.0 - smoothstep(life * 0.4, life, k));

    /* ---- where it is struck from, and to ---- */
    float h0 = mix(uLow, uHigh, hash11(seed + 1.7));
    float a0 = hash11(seed + 2.3) * TAU;
    float escape = step(hash11(seed + 3.1), clamp(uEscape, 0.0, 1.0));

    float h1 = clamp(h0 + (hash11(seed + 4.9) - 0.5) * 2.0 * uSpan + escape * 0.2, -0.05, 1.3);
    float a1 = a0 + (hash11(seed + 5.5) - 0.5) * 2.0 * uSweep;
    float out1 = escape * uReach * (0.35 + 0.65 * hash11(seed + 6.2));

    vec3 p0 = bodyPoint(h0, a0, 0.0);
    vec3 p1 = bodyPoint(h1, a1, out1);

    /* ---- the frame the kinks and the bow live in ---- */
    float hm = (h0 + h1) * 0.5;
    vec3 mid = bodyPoint(hm, (a0 + a1) * 0.5, 0.0);
    vec3 spine = uBase + vec3(0.0, hm * uHeight, 0.0);
    vec3 radial = mid - spine;
    radial = length(radial) > 1e-4 ? normalize(radial) : uRight;

    vec3 delta = p1 - p0;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    vec3 n1 = radial - dir * dot(radial, dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    // Off the skin at mid-span, and further out for the ones that are leaving.
    vec3 bow = radial * uBow * (1.0 + escape * 1.6);

    vec3 here = arcPoint(t, p0, p1, bow, seed, n1, n2, span);

    // Tangent by finite difference, mirrored at the far end.
    float step_ = 0.03;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = arcPoint(ahead, p0, p1, bow, seed, n1, n2, span);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    /* ---- turn the ribbon to face the camera ---- */
    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* ---- width ---- */
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;
    // Per-arc thickness, and the same roll dims it in the fragment: some strikes
    // are the spine of the discharge, most are hairs off it.
    vStrand = hash11(seed + 8.4);

    // Tapered to nothing at both ends rather than cut off — an arc has no butt.
    float taper = pow(max(sin(t * PI), 0.0), max(uTaper, 0.01));
    float halfWidth = uWidth * uWidthScale * taper;
    halfWidth *= mix(uCoreWidth, 1.0, vStrand);
    halfWidth *= flash * vLive * uStrength;

    // World space throughout: the group is an identity transform.
    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const ARC_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vLive;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (vLive <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef ARC_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
    #endif

    float alpha = profile;
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    alpha *= vLive * flicker * vFlash * uStrength * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of the body arcs.
 *
 * Both passes share every uniform but the two that define the pass itself
 * (`uWidthScale`, `uPassOpacity`), so `userData.sync()` takes the same state for
 * each and one editor folder drives them together.
 *
 * @param {number} pass ArcPass.*
 */
export function createBodyArcMaterial(pass = ArcPass.CORE) {
  const glow = pass === ArcPass.GLOW;

  const material = new ShaderMaterial({
    defines: glow ? { ARC_GLOW: '' } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: 0 },
      uStrength: { value: 0 },

      uBase: { value: new Vector3() },
      uRight: { value: new Vector3(1, 0, 0) },
      uForward: { value: new Vector3(0, 0, 1) },
      uHeight: { value: 1.8 },
      uRadius: { value: 0.4 },
      uDepth: { value: 0.62 },
      uLow: { value: 0.04 },
      uHigh: { value: 1.02 },
      uProfile: { value: 1 },

      uRate: { value: 3 },
      uLife: { value: 0.5 },
      uSpan: { value: 0.3 },
      uSweep: { value: 1.6 },
      uEscape: { value: 0.34 },
      uReach: { value: 0.9 },
      uBow: { value: 0.16 },

      uJitter: { value: 0.09 },
      uJitterScale: { value: 5 },
      uOctaves: { value: 4 },
      uJitterFalloff: { value: 0.55 },
      uCrawl: { value: 2.4 },
      uPinch: { value: 0.18 },

      uWidth: { value: 0.022 },
      uWidthScale: { value: glow ? 6 : 1 },
      uTaper: { value: 0.55 },
      uCoreWidth: { value: 1.5 },
      uCoreSharp: { value: 3.4 },
      uGlowFalloff: { value: 2.4 },
      uPassOpacity: { value: glow ? 0.4 : 1 },
      uBranchDim: { value: 0.7 },
      uSoftFade: { value: 0.35 },

      uFlicker: { value: 0.32 },
      uFlickerSpeed: { value: 30 },
      uStrandFlash: { value: 0.45 },

      uOpacity: { value: 1 },
      uGlow: { value: 2.2 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorInner: { value: new Color(0.78, 0.92, 1) },
      uColorOuter: { value: new Color(0.22, 0.62, 1) },
      uColorHalo: { value: new Color(0.04, 0.24, 0.78) }
    }),
    vertexShader: ARC_VERTEX,
    fragmentShader: ARC_FRAGMENT
  });

  /**
   * Push the live settings and the buff's state into the uniforms.
   *
   * @param {object} state { base, right, forward, height, strength, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.boost;
    const g = settings.global;
    const u = material.uniforms;

    u.uBase.value.copy(state.base);
    u.uRight.value.copy(state.right);
    u.uForward.value.copy(state.forward);
    u.uHeight.value = state.height;
    u.uStrength.value = state.strength;
    u.uSeed.value = state.seed;

    u.uRadius.value = c.bodyRadius;
    u.uDepth.value = c.bodyDepth;
    u.uLow.value = c.bodyLow;
    u.uHigh.value = c.bodyHigh;
    u.uProfile.value = c.bodyProfile;

    u.uRate.value = c.arcRate;
    u.uLife.value = c.arcLife;
    u.uSpan.value = c.arcSpan;
    u.uSweep.value = c.arcSweep;
    u.uEscape.value = c.arcEscape;
    u.uReach.value = c.arcReach;
    u.uBow.value = c.arcBow;

    // As in the bolt, the kinks are where the global noise multipliers bite.
    u.uJitter.value = c.arcJitter * g.randomness * g.noiseStrength;
    u.uJitterScale.value = c.arcJitterScale * g.noiseFrequency;
    u.uOctaves.value = Math.round(c.arcOctaves);
    u.uJitterFalloff.value = c.arcJitterFalloff;
    u.uCrawl.value = c.arcCrawl * g.noiseSpeed;
    u.uPinch.value = c.arcPinch;

    u.uWidth.value = c.arcWidth;
    u.uTaper.value = c.arcTaper;
    u.uCoreWidth.value = c.arcCoreWidth;
    u.uCoreSharp.value = c.arcCoreSharp;
    u.uGlowFalloff.value = c.arcGlowFalloff;
    u.uWidthScale.value = glow ? c.arcGlowWidth : 1;
    u.uPassOpacity.value = glow ? c.arcGlowOpacity : 1;
    u.uSoftFade.value = c.arcSoftFade;

    u.uFlicker.value = c.arcFlicker;
    u.uFlickerSpeed.value = c.arcFlickerSpeed;
    u.uStrandFlash.value = c.arcStrandFlash;

    u.uOpacity.value = c.arcOpacity * g.opacity;
    u.uGlow.value = c.arcGlow;
    u.uColorCore.value.copy(getColor(c.colorArcCore));
    u.uColorInner.value.copy(getColor(c.colorArcInner));
    u.uColorOuter.value.copy(getColor(c.colorArcOuter));
    u.uColorHalo.value.copy(getColor(c.colorArcHalo));
  };

  return material;
}
