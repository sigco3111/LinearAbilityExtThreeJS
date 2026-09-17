import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The two passes a ribbon is drawn in — same geometry, same path, only the
 * width and the cross-ribbon profile differ. As `materials/BodyArcMaterial.js`.
 */
export const RibbonPass = Object.freeze({
  BAND: 0, // the sheet itself, lit along both of its edges
  GLOW: 1 // the halo it sits inside
});

/**
 * The ribbons turning around a character under Magic Boost.
 *
 * Where `BodyArcMaterial` strikes hairline filaments between two points on a
 * capsule, this draws **wide sheets wound around one**: a helix per instance,
 * turning about the body's own vertical axis, bulging out at the waist and
 * closing back in above the head. The CPU picks none of it — an instance index
 * and the clock give the shader the ribbon's bearing, its radius, how many
 * turns it makes, which way it spins and when it dies.
 *
 * ## The helix
 *
 * `t` runs 0 → 1 from the bottom of a ribbon to its top. Height comes off
 * `uLow`/`uHigh` (fractions of the body), bearing off `uTurns` about the axis,
 * and radius off `uRadius` shaped by `uFlare`, which blends a plain cylinder
 * into a barrel that is widest where the body is. Two bands of noise ride on
 * top — one on the radius, one on the height — so a ribbon wanders rather than
 * reading as a machined spring.
 *
 * `uSpin` turns the whole vortex; `uCounter` is the fraction of ribbons that
 * turn the other way, which is what stops the set reading as one rigid object.
 * Each ribbon also climbs by `uClimb` metres/second over its own life, so the
 * vortex is forever moving upward through itself.
 *
 * ## The cycle
 *
 * As the arcs do: `uTime * uRate + hash(index)`, the integer part seeding the
 * shape and the fractional part being its life. Unlike lightning, both ends of
 * that life are soft — a ribbon of smoke gathers and disperses, it does not
 * strike.
 *
 * ## The sheet
 *
 * Width is `uWidth`, tapered to nothing at both ends so a ribbon has no butt,
 * and turned to face the camera exactly like an arc — except for `uBank`, which
 * rolls it back toward the helix's own surface normal. At 0 the ribbons are
 * flat strokes on the screen; at 1 they are banked bands you see the edge of as
 * they come round the front. Between the two is what reads as cloth.
 */
const RIBBON_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;
  uniform float uCount;

  uniform vec3  uBase;
  uniform vec3  uRight;
  uniform vec3  uForward;
  uniform float uHeight;

  uniform float uRadius;
  uniform float uRadiusVary;
  uniform float uDepth;
  uniform float uFlare;
  uniform float uLow;
  uniform float uHigh;
  uniform float uScatter;

  uniform float uTurns;
  uniform float uTurnVary;
  uniform float uSpin;
  uniform float uSpinVary;
  uniform float uCounter;
  uniform float uClimb;

  uniform float uWobble;
  uniform float uWobbleScale;
  uniform float uWave;
  uniform float uWaveScale;
  uniform float uCrawl;

  uniform float uRate;
  uniform float uLife;

  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uWidthVary;
  uniform float uTaper;
  uniform float uBank;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vSeed;
  varying float vLive;
  varying float vViewZ;

  ${noiseGLSL}

  /**
   * A point on one ribbon's helix.
   *
   * @param t      0..1 from the bottom of the ribbon to its top
   * @param a0     the bearing it starts on
   * @param radius its own radius, metres
   * @param turns  turns about the axis over its whole length
   * @param spin   radians the vortex has turned by now
   * @param lift   metres it has climbed since it was born
   */
  vec3 ribbonPoint(float t, float a0, float radius, float turns, float spin, float lift, float seed) {
    float k = clamp(t, 0.0, 1.0);
    float a = a0 + k * turns * TAU + spin;

    // Widest where the body is, closing in at the floor and above the head —
    // the barrel is what makes the set read as wrapped *around* someone rather
    // than as a tube they happen to be standing in.
    float profile = mix(1.0, 0.55 + 0.72 * sin(k * PI), clamp(uFlare, 0.0, 1.0));
    float r = radius * profile +
              uWobble * snoise(vec3(k * uWobbleScale, seed, uTime * uCrawl));

    float h = mix(uLow, uHigh, k) * uHeight + lift +
              uWave * snoise(vec3(k * uWaveScale + 11.7, seed * 1.7, uTime * uCrawl * 0.8));

    return uBase
      + vec3(0.0, h, 0.0)
      + uRight * (cos(a) * r)
      + uForward * (sin(a) * r * uDepth);
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* ---- this ribbon's own clock ---- */
    float phase = hash11(aStrand * 5.17 + uSeed * 0.19);
    float cycle = uTime * max(uRate, 0.001) + phase;
    float turn = floor(cycle);
    float k = fract(cycle);
    float seed = hash11(aStrand * 9.31 + turn * 4.13 + uSeed) * 83.0;
    vSeed = seed;

    // Soft at both ends: smoke gathers and disperses. A ribbon that snapped in
    // the way lightning does would read as a glitch rather than as a strike.
    float life = clamp(uLife, 0.05, 1.0);
    vLive = smoothstep(0.0, life * 0.45, k) * (1.0 - smoothstep(life * 0.55, life, k));

    /* ---- where it hangs ---- */
    // Spread evenly around the body first, then scattered — the even fan is
    // what keeps a low count from leaving one side of the character bare.
    float a0 = (aStrand / max(uCount, 1.0)) * TAU + hash11(seed + 1.3) * uScatter;
    float radius = uRadius * (1.0 + (hash11(seed + 2.7) - 0.5) * 2.0 * uRadiusVary);
    float turns = uTurns * (1.0 + (hash11(seed + 3.9) - 0.5) * 2.0 * uTurnVary);

    // A fraction of them turn the other way, so the vortex has shear in it
    // instead of rotating as one piece.
    float dir = mix(1.0, -1.0, step(hash11(seed + 4.5), clamp(uCounter, 0.0, 1.0)));
    float rate = uSpin * (1.0 + (hash11(seed + 5.1) - 0.5) * 2.0 * uSpinVary);
    float spin = uTime * rate * TAU * dir;
    // Metres climbed since it was born, from its own phase — so it rises and
    // fades rather than snapping back to the floor.
    float lift = uClimb * (k / max(uRate, 0.001));

    vec3 here = ribbonPoint(t, a0, radius, turns, spin, lift, seed);

    /* ---- the frame the sheet is built on ---- */
    float step_ = 0.02;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = ribbonPoint(ahead, a0, radius, turns, spin, lift, seed);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);

    // Outward from the vortex axis at this height — the surface the helix lies
    // on, and what uBank rolls the sheet back into.
    vec3 spine = uBase + vec3(0.0, here.y - uBase.y, 0.0);
    vec3 radial = here - spine;
    radial = length(radial) > 1e-4 ? normalize(radial) : uRight;

    vec3 geo = cross(tangent, radial);
    geo = length(geo) > 1e-4 ? normalize(geo) : vec3(0.0, 1.0, 0.0);

    vec3 toCamera = normalize(cameraPosition - here);
    vec3 billboard = cross(tangent, toCamera);
    billboard = length(billboard) > 1e-4 ? normalize(billboard) : geo;

    vec3 binormal = mix(billboard, geo, clamp(uBank, 0.0, 1.0));
    binormal = length(binormal) > 1e-4 ? normalize(binormal) : billboard;

    /* ---- width ---- */
    vStrand = hash11(seed + 6.8);
    float taper = pow(max(sin(t * PI), 0.0), max(uTaper, 0.01));
    float halfWidth = uWidth * uWidthScale * taper;
    halfWidth *= mix(1.0 - clamp(uWidthVary, 0.0, 0.95), 1.0, vStrand);
    halfWidth *= vLive * uStrength;

    // World space throughout: the group is an identity transform.
    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The sheet, shaded.
 *
 * A ribbon this wide cannot be a plain gradient across itself or it reads as a
 * painted stripe, so three things break it up:
 *
 *   - **the edges.** `uEdge` lights a band at each lip, which is the whole
 *     reason these read as sheets of energy with a hollow between them rather
 *     than as solid bars. Both edges, not one: a ribbon seen flat-on has to
 *     show two bright lines.
 *   - **the wisps.** fbm sampled along the ribbon (and a little across it),
 *     scrolling backward, eats the interior into strands.
 *   - **the fade.** Alpha falls off toward both tips, so a ribbon dissolves
 *     into the air instead of ending.
 */
const RIBBON_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;

  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uEdge;
  uniform float uEdgeWidth;
  uniform float uGlowFalloff;

  uniform float uWisp;
  uniform float uWispScale;
  uniform float uWispCross;
  uniform float uWispSpeed;
  uniform float uWispSharp;
  uniform float uEndFade;

  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uStrandFade;
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
  varying float vSeed;
  varying float vLive;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (vLive <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    /* ---- the strands running down the ribbon ---- */
    float field = fbm3(vec3(
      vT * uWispScale - uTime * uWispSpeed,
      vSide * uWispCross,
      vSeed * 3.1
    )) * 0.5 + 0.5;
    float wisp = mix(1.0, pow(clamp(field, 0.0, 1.0), max(uWispSharp, 0.05)) * 1.6,
                     clamp(uWisp, 0.0, 1.0));

    #ifdef RIBBON_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float fill = pow(1.0 - v, max(uFillFalloff, 0.05));
      // A band at each lip rather than a hard line at v = 1: the edge has to
      // survive being a couple of pixels wide on screen.
      float edge = smoothstep(1.0 - clamp(uEdgeWidth, 0.01, 1.0), 1.0, v);

      vec3 color = mix(uColorOuter, uColorInner, fill);
      color = mix(color, uColorCore, smoothstep(0.2, 1.0, edge) * clamp(uEdge, 0.0, 1.0));
      float alpha = fill * uFill + edge * uEdge;
    #endif

    // Dissolved at both tips, so a ribbon has no visible end.
    float ends = smoothstep(0.0, max(uEndFade, 1e-3), vT) *
                 smoothstep(0.0, max(uEndFade, 1e-3), 1.0 - vT);

    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    alpha *= wisp * ends * vLive * flicker * uStrength * uPassOpacity * uOpacity;
    // Some ribbons are the body of the vortex, most are veils behind it.
    alpha *= mix(1.0, clamp(uStrandFade, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of the ribbons.
 *
 * Both passes share every uniform but the two that define the pass itself
 * (`uWidthScale`, `uPassOpacity`), so `userData.sync()` takes the same state for
 * each and one editor folder drives them together.
 *
 * @param {number} pass RibbonPass.*
 */
export function createArcaneRibbonMaterial(pass = RibbonPass.BAND) {
  const glow = pass === RibbonPass.GLOW;

  const material = new ShaderMaterial({
    defines: glow ? { RIBBON_GLOW: '' } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: 0 },
      uStrength: { value: 0 },
      uCount: { value: 7 },

      uBase: { value: new Vector3() },
      uRight: { value: new Vector3(1, 0, 0) },
      uForward: { value: new Vector3(0, 0, 1) },
      uHeight: { value: 1.8 },

      uRadius: { value: 1.15 },
      uRadiusVary: { value: 0.22 },
      uDepth: { value: 1 },
      uFlare: { value: 0.65 },
      uLow: { value: -0.05 },
      uHigh: { value: 1.15 },
      uScatter: { value: 1.4 },

      uTurns: { value: 1.15 },
      uTurnVary: { value: 0.35 },
      uSpin: { value: 0.28 },
      uSpinVary: { value: 0.3 },
      uCounter: { value: 0.25 },
      uClimb: { value: 0.35 },

      uWobble: { value: 0.16 },
      uWobbleScale: { value: 2.2 },
      uWave: { value: 0.18 },
      uWaveScale: { value: 1.8 },
      uCrawl: { value: 0.35 },

      uRate: { value: 0.32 },
      uLife: { value: 0.92 },

      uWidth: { value: 0.42 },
      uWidthScale: { value: glow ? 2.4 : 1 },
      uWidthVary: { value: 0.4 },
      uTaper: { value: 0.75 },
      uBank: { value: 0.35 },

      uFill: { value: 0.35 },
      uFillFalloff: { value: 1.6 },
      uEdge: { value: 0.9 },
      uEdgeWidth: { value: 0.34 },
      uGlowFalloff: { value: 2.2 },

      uWisp: { value: 0.75 },
      uWispScale: { value: 3.4 },
      uWispCross: { value: 0.9 },
      uWispSpeed: { value: 0.5 },
      uWispSharp: { value: 1.4 },
      uEndFade: { value: 0.22 },

      uFlicker: { value: 0.12 },
      uFlickerSpeed: { value: 9 },
      uStrandFade: { value: 0.55 },
      uPassOpacity: { value: glow ? 0.35 : 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.2 },
      uSoftFade: { value: 0.5 },

      uColorCore: { value: new Color(1, 0.86, 1) },
      uColorInner: { value: new Color(0.85, 0.35, 1) },
      uColorOuter: { value: new Color(0.45, 0.09, 0.85) },
      uColorHalo: { value: new Color(0.16, 0.02, 0.36) }
    }),
    vertexShader: RIBBON_VERTEX,
    fragmentShader: RIBBON_FRAGMENT
  });

  /**
   * Push the live settings and the buff's state into the uniforms.
   *
   * @param {object} state { base, right, forward, height, strength, seed, count }
   */
  material.userData.sync = (state) => {
    const c = settings.magic;
    const g = settings.global;
    const u = material.uniforms;

    u.uBase.value.copy(state.base);
    u.uRight.value.copy(state.right);
    u.uForward.value.copy(state.forward);
    u.uHeight.value = state.height;
    u.uStrength.value = state.strength;
    u.uSeed.value = state.seed;
    u.uCount.value = Math.max(1, state.count);

    u.uRadius.value = c.ribbonRadius;
    u.uRadiusVary.value = c.ribbonRadiusVary * g.randomness;
    u.uDepth.value = c.ribbonDepth;
    u.uFlare.value = c.ribbonFlare;
    u.uLow.value = c.ribbonLow;
    u.uHigh.value = c.ribbonHigh;
    u.uScatter.value = c.ribbonScatter * g.randomness;

    u.uTurns.value = c.ribbonTurns;
    u.uTurnVary.value = c.ribbonTurnVary * g.randomness;
    u.uSpin.value = c.ribbonSpin * g.speed;
    u.uSpinVary.value = c.ribbonSpinVary * g.randomness;
    u.uCounter.value = c.ribbonCounter;
    u.uClimb.value = c.ribbonClimb * g.speed;

    // The wander is where the global noise multipliers bite, as they do on the
    // kinks of an arc.
    u.uWobble.value = c.ribbonWobble * g.noiseStrength;
    u.uWobbleScale.value = c.ribbonWobbleScale * g.noiseFrequency;
    u.uWave.value = c.ribbonWave * g.noiseStrength;
    u.uWaveScale.value = c.ribbonWaveScale * g.noiseFrequency;
    u.uCrawl.value = c.ribbonCrawl * g.noiseSpeed;

    u.uRate.value = c.ribbonRate;
    u.uLife.value = c.ribbonLife;

    u.uWidth.value = c.ribbonWidth;
    u.uWidthScale.value = glow ? c.ribbonGlowWidth : 1;
    u.uWidthVary.value = c.ribbonWidthVary * g.randomness;
    u.uTaper.value = c.ribbonTaper;
    u.uBank.value = c.ribbonBank;

    u.uFill.value = c.ribbonFill;
    u.uFillFalloff.value = c.ribbonFillFalloff;
    u.uEdge.value = c.ribbonEdge;
    u.uEdgeWidth.value = c.ribbonEdgeWidth;
    u.uGlowFalloff.value = c.ribbonGlowFalloff;

    u.uWisp.value = c.ribbonWisp;
    u.uWispScale.value = c.ribbonWispScale * g.noiseFrequency;
    u.uWispCross.value = c.ribbonWispCross;
    u.uWispSpeed.value = c.ribbonWispSpeed * g.noiseSpeed;
    u.uWispSharp.value = c.ribbonWispSharp;
    u.uEndFade.value = c.ribbonEndFade;

    u.uFlicker.value = c.ribbonFlicker;
    u.uFlickerSpeed.value = c.ribbonFlickerSpeed;
    u.uStrandFade.value = c.ribbonStrandFade;
    u.uPassOpacity.value = glow ? c.ribbonGlowOpacity : 1;
    u.uOpacity.value = c.ribbonOpacity * g.opacity;
    u.uGlow.value = c.ribbonGlow;
    u.uSoftFade.value = c.ribbonSoftFade;

    u.uColorCore.value.copy(getColor(c.colorRibbonCore));
    u.uColorInner.value.copy(getColor(c.colorRibbonInner));
    u.uColorOuter.value.copy(getColor(c.colorRibbonOuter));
    u.uColorHalo.value.copy(getColor(c.colorRibbonHalo));
  };

  return material;
}
