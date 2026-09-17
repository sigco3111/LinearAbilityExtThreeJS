import { ShaderMaterial, AdditiveBlending, Color } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Radial lightning bolts — the chaotic corona around the sphere.
 *
 * One instanced ribbon strip, every instance a bolt. A bolt's two ends, its
 * direction, when it strikes and when it dies are all derived in the vertex
 * shader from the instance's index, the sphere centre and the clock.
 *
 * `RadialBoltPass` splits the draw into a hot white **core** and a wider
 * orange **halo** — the same trick the Storm Lance uses. The two passes share
 * every uniform except the ones that define the pass itself (`uWidthScale`,
 * `uPassOpacity`), so one editor folder drives them together.
 */

/**
 * The two passes a radial bolt is drawn in. Same path, only the width and
 * opacity differ.
 */
export const RadialBoltPass = Object.freeze({
  CORE: 0, // the white-hot filament
  GLOW: 1 // the orange halo around it
});

/**
 * The vertex shader. A vertex arrives as `(t, side)` — its position along the
 * bolt (`t` = 0..1) and which edge of the ribbon it is on (`side` = -1..1).
 *
 * The bolt itself is computed from `aStrand` (the instance index) and the
 * sphere centre. Each strand gets its own direction, its own strike clock, its
 * own endpoints, and its own noise pattern, so the corona is N independent
 * arcs drawn from the same geometry.
 *
 * The path:
 *   1. **Origin** — a random point on (or just outside) the sphere surface.
 *   2. **Direction** — a unit vector with a slight upward bias.
 *   3. **Target** — origin + direction * arcLength, modulated by sin so the
 *      longest arcs read as the dramatic ones.
 *   4. **Kinks** — octaves of value noise in the plane perpendicular to the
 *      axis (same linear value noise the Storm Lance uses — sharp corners).
 *   5. **Branches** — a fraction of strands are demoted to short secondary
 *      arcs so the corona has texture.
 */
const BOLT_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uFade;
  uniform float uPulse;
  uniform vec3  uCenter;
  uniform float uSphereRadius;
  uniform float uArcCount;
  uniform float uArcLength;
  uniform float uArcJitter;
  uniform float uEscape;
  uniform float uCurl;
  uniform float uReach;
  uniform float uUpBias;
  uniform float uStrandVariance;

  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;
  uniform float uConverge;

  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uWidthScale;
  uniform float uCoreWidth;
  uniform float uFlickerSpeed;
  uniform float uStrandFlash;
  uniform float uBranchFraction;
  uniform float uRate;
  uniform float uLife;
  uniform float uBow;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vLive;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  /** Linear value noise — sharp corners, no smoothstep. */
  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

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

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* --- this strand's own clock and shape --- */
    float strand = aStrand;
    float phase = hash11(strand * 3.71 + uSeed * 0.13);
    float cycle = uTime * max(uRate, 0.01) + phase;
    float strike = floor(cycle);
    float k = fract(cycle);
    float seed = hash11(strand * 7.13 + strike * 3.77 + uSeed) * 97.0;

    // Lit for the front of the cycle, dark after — the corona is constantly
    // re-striking, not breathing.
    float life = clamp(uLife, 0.02, 1.0);
    vLive = smoothstep(0.0, 0.06 * life, k) * (1.0 - smoothstep(life * 0.5, life, k));
    // Pulse adds a layer of brightness on top.
    vLive = clamp(vLive * (1.0 + uPulse * 1.5), 0.0, 1.5);

    /* --- endpoints --- */
    // Random direction on the unit sphere. Two unit random pairs, normalised
    // — the input uniform is just an index and the clock.
    vec3 dir = vec3(
      hash11(seed + 1.1) * 2.0 - 1.0,
      hash11(seed + 2.3) * 2.0 - 1.0,
      hash11(seed + 3.7) * 2.0 - 1.0
    );
    dir.y = dir.y * (1.0 - uUpBias) + uUpBias;
    dir = length(dir) > 1e-4 ? normalize(dir) : vec3(0.0, 1.0, 0.0);

    // Per-strand length variance: most arcs are short, a few are dramatic.
    float len = uArcLength * mix(0.4, 1.0, hash11(seed + 4.1) * uStrandVariance + (1.0 - uStrandVariance) * 0.5);

    // Branch: a fraction of strands are demoted to short secondary arcs.
    bool branch = hash11(seed + 5.5) < uBranchFraction;
    if (branch) len *= 0.45;

    // Origin: a point on the sphere surface, slightly displaced by the noise
    // so it does not sit at the exact equator.
    vec3 origin = uCenter + dir * (uSphereRadius * uEscape);
    // Target: along the same direction, with a small lateral wander so the
    // longest arcs do not all point exactly outward.
    vec3 wander = vec3(
      hash11(seed + 6.1) * 2.0 - 1.0,
      hash11(seed + 7.3) * 2.0 - 1.0,
      hash11(seed + 8.7) * 2.0 - 1.0
    ) * uArcJitter;
    vec3 axisEnd = origin + dir * len;
    vec3 target = axisEnd + wander * len * 0.2;

    // The bolt also bends in flight: a perpendicular sway driven by fbm, so
    // the path is not a straight line.
    float midAmount = uCurl * len;
    vec3 mid = mix(origin, target, 0.5);
    vec3 perp = normalize(cross(dir, vec3(0.0, 1.0, 0.0) + vec3(0.001)));
    mid += perp * sin(uTime * 3.0 + strand) * midAmount * 0.4;
    mid += dir * cos(uTime * 2.0 + strand * 0.7) * midAmount * 0.2;

    /* --- frame the kinks live in --- */
    vec3 delta = target - origin;
    float span = max(length(delta), 0.01);
    vec3 axis = delta / span;
    vec3 n1 = perp - axis * dot(perp, axis);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(axis, vec3(0.0, 1.0, 0.0)));
    vec3 n2 = normalize(cross(axis, n1));

    /* --- kinks and bow --- */
    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) * smoothstep(0.0, pinch, 1.0 - t);
    vec2 offset = kink(t, seed, span) * uJitter * ends;

    // Bow the mid-span out away from the sphere, scaled by reach.
    vec3 bow = dir * uBow * 0.4;

    vec3 here = mix(origin, target, t) + bow * sin(t * PI) + mid * 0.0;
    here += n1 * offset.x + n2 * offset.y;

    // Tangent by finite difference.
    float step_ = 0.025;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = mix(origin, target, ahead) + bow * sin(ahead * PI) +
                n1 * kink(ahead, seed, span).x * uJitter * smoothstep(0.0, pinch, ahead) * smoothstep(0.0, pinch, 1.0 - ahead) +
                n2 * kink(ahead, seed, span).y * uJitter * smoothstep(0.0, pinch, ahead) * smoothstep(0.0, pinch, 1.0 - ahead);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : axis;

    /* --- camera-facing ribbon --- */
    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* --- width --- */
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + strand * 3.7 + strike), uStrandFlash);
    vFlash = flash;
    vStrand = hash11(seed + 8.4);

    // Rooted at the ball, narrowing toward the tip. A ribbon that pinches to
    // zero at *both* ends reads as a detached filament floating near the
    // sphere; an arc is anchored in the surface it leaves, so the base keeps
    // its full width and only the far end tapers. uWidthTip is that far end's
    // width as a fraction of the base, and the short smoothstep is only there
    // to keep the very first quad from ending in a blunt square cut.
    float taper = mix(1.0, max(uWidthTip, 0.0), t) * smoothstep(0.0, 0.05, t);
    float halfWidth = uWidth * uWidthScale * taper;
    halfWidth *= mix(uCoreWidth, 1.0, vStrand);
    halfWidth *= flash * vLive * uFade;

    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The fragment shader. Draws a single strand of one bolt.
 *
 * The two passes (core, halo) use the same shader but `#define BOLT_GLOW` and
 * a softer profile, so the core is sharp and the halo is a soft outer bloom.
 */
const BOLT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
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

    #ifdef BOLT_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif

    // Quantised flicker, not sinusoidal: lightning stutters, it does not breathe.
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed + vT * 7.3);

    alpha *= vLive * flicker * vFlash * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of a radial bolt.
 *
 * @param {number} pass RadialBoltPass.*
 */
export function createRadialBoltMaterial(pass = RadialBoltPass.CORE) {
  const glow = pass === RadialBoltPass.GLOW;

  const material = new ShaderMaterial({
    defines: glow ? { BOLT_GLOW: '' } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: 2, // DoubleSide
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uPulse: { value: 0 },
      uCenter: { value: { x: 0, y: 0, z: 0 } },
      uSphereRadius: { value: 1.0 },
      uArcCount: { value: 24 },
      uArcLength: { value: 3.0 },
      uArcJitter: { value: 0.3 },
      uEscape: { value: 1.05 },
      uCurl: { value: 0.4 },
      uReach: { value: 1.0 },
      uUpBias: { value: 0.3 },
      uStrandVariance: { value: 0.7 },

      uJitter: { value: 0.18 },
      uJitterScale: { value: 4.0 },
      uOctaves: { value: 4 },
      uJitterFalloff: { value: 0.55 },
      uCrawl: { value: 3.5 },
      uPinch: { value: 0.18 },
      uConverge: { value: 0.5 },

      uWidth: { value: 0.05 },
      uWidthTip: { value: 1.0 },
      uWidthScale: { value: glow ? 4.0 : 1.0 },
      uCoreWidth: { value: 1.5 },
      uCoreSharp: { value: 3.0 },
      uGlowFalloff: { value: 2.0 },
      uPassOpacity: { value: glow ? 0.6 : 1.0 },
      uSoftFade: { value: 0.4 },

      uFlicker: { value: 0.45 },
      uFlickerSpeed: { value: 32 },
      uStrandFlash: { value: 0.5 },
      uBranchFraction: { value: 0.35 },
      uRate: { value: 18 },
      uLife: { value: 0.45 },
      uBow: { value: 0.2 },

      uOpacity: { value: 1.0 },
      uGlow: { value: 1.4 },
      uColorCore: { value: new Color(1, 0.97, 0.85) },
      uColorInner: { value: new Color(1, 0.7, 0.3) },
      uColorOuter: { value: new Color(1, 0.3, 0.05) },
      uColorHalo: { value: new Color(1, 0.15, 0.03) }
    }),
    vertexShader: BOLT_VERTEX,
    fragmentShader: BOLT_FRAGMENT
  });

  /**
   * Push the live settings and the cast state into the uniforms.
   *
   * `uCenter` is the **sphere's** world position, not the cast point on the
   * floor: every bolt's origin is `uCenter + dir * radius * escape`, so feeding
   * the floor point in here builds the whole corona around a point a couple of
   * metres below the ball — arcs erupting out of the ground instead of off the
   * surface. The mesh carrying these instances cannot fix that by being moved:
   * it runs with `matrixAutoUpdate` off, so its transform stays identity.
   *
   * @param {object} state { sphereCenter, sphereRadius, seed, fade, pulse }
   */
  material.userData.sync = (state) => {
    const c = settings.electrical;
    const g = settings.global;
    const u = material.uniforms;

    const centre = state.sphereCenter ?? state.center;
    u.uCenter.value.x = centre.x;
    u.uCenter.value.y = centre.y;
    u.uCenter.value.z = centre.z;
    u.uSphereRadius.value = state.sphereRadius;
    u.uSeed.value = state.seed;
    u.uFade.value = state.fade;
    u.uPulse.value = state.pulse;

    u.uArcCount.value = c.arcCount;
    u.uArcLength.value = c.arcLength;
    u.uArcJitter.value = c.arcJitter;
    u.uEscape.value = c.arcEscape;
    u.uCurl.value = c.arcCurl;
    u.uReach.value = c.arcReach;
    u.uUpBias.value = c.arcUpBias;
    u.uStrandVariance.value = c.arcVariance;

    u.uJitter.value = c.arcJitterAmp * g.randomness * g.noiseStrength;
    u.uJitterScale.value = c.arcJitterFreq * g.noiseFrequency;
    u.uOctaves.value = Math.round(c.arcOctaves);
    u.uJitterFalloff.value = c.arcJitterFalloff;
    u.uCrawl.value = c.arcCrawl * g.noiseSpeed;
    u.uPinch.value = c.arcPinch;
    u.uConverge.value = c.arcConverge;

    u.uWidth.value = c.arcWidth;
    u.uWidthTip.value = c.arcWidthTip;
    u.uWidthScale.value = glow ? c.arcHaloWidth : 1.0;
    u.uCoreWidth.value = c.arcCoreWidth;
    u.uCoreSharp.value = c.arcCoreSharp;
    u.uGlowFalloff.value = c.arcGlowFalloff;
    u.uPassOpacity.value = glow ? c.arcHaloOpacity : 1.0;
    u.uSoftFade.value = c.arcSoftFade;

    u.uFlicker.value = c.arcFlicker;
    u.uFlickerSpeed.value = c.arcFlickerSpeed;
    u.uStrandFlash.value = c.arcStrandFlash;
    u.uBranchFraction.value = c.arcBranchFraction;
    u.uRate.value = c.arcRate;
    u.uLife.value = c.arcLife;
    u.uBow.value = c.arcBow;

    u.uOpacity.value = c.arcOpacity * g.opacity;
    u.uGlow.value = c.arcGlow * g.glow * g.shaderIntensity;

    u.uColorCore.value.copy(getColor(c.colorArcCore));
    u.uColorInner.value.copy(getColor(c.colorArcInner));
    u.uColorOuter.value.copy(getColor(c.colorArcOuter));
    u.uColorHalo.value.copy(getColor(c.colorArcHalo));
  };

  return material;
}
