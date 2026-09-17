import { ShaderMaterial, AdditiveBlending, NormalBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ==================================================================== */
/* The rift the arms come out of                                         */
/* ==================================================================== */

const FIELD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The circle the indicator promised, **torn open into deep water**.
 *
 * Third in a line — the Voltaic Snare's charred field, the Glacial Crown's sheet
 * of ice, the Pyre Crown's molten crater — and built on the same signed-distance
 * construction with the same thick boundary, because the correspondence is the
 * point: what you measured out before you clicked is what is standing on the
 * ground afterwards. What differs is what is in it, and here that is the one
 * thing none of the others has: **rotation**.
 *
 * Fire spreads, ice creeps, water *turns*. So the whole interior is built around
 * a maelstrom — an angular coordinate sheared by the radius, which is the entire
 * trick behind a spiral and the reason the arms of the vortex wind tighter as
 * they run into the middle instead of reading as spokes. Everything else hangs
 * off that:
 *
 *   - **the spiral**, several arms of it, turning at `uSpin`, with domain-warped
 *     noise dragging its arms out of true;
 *   - **the drowned crust**: the flagstones under the footprint, split by the
 *     thing that came through them, with cold light coming up between the
 *     plates. A voronoi field again — but read for its *seams*, which is where
 *     the light gets out;
 *   - **the throat**: a bright pool in the middle, which is both the mouth the
 *     arms came out of and, not by accident, the exact spot every arm smashes;
 *   - **the summoning ring**: a thin second boundary inside the first with ticks
 *     stepped around it. The only piece of deliberate iconography in the
 *     project, and it earns its place by saying *called* rather than *thrown*;
 *   - **a front.** `uOpen` is how far the water has spread, 0..1 of the
 *     boundary, dragged out of round by an angular lookup — the one place an
 *     angular function is the right tool, because this *is* a boundary. It runs
 *     outward as the rift tears and retreats as it closes.
 *
 * This pass draws only the light. The dark is a `SCORCH` decal the ability lays
 * underneath it in deep navy, for the same reason the Pyre Crown splits its
 * crater in two: drowned stone has to *subtract* from the floor and this quad is
 * additive. Trying to do both in one pass is how you get grey.
 */
const FIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;    // metres the quad covers, edge to edge
  uniform float uRadius;      // footprint radius, metres
  uniform float uBoundary;    // thickness of the band that is the edge
  uniform float uBoundaryGlow;
  uniform float uFill;
  uniform float uFalloff;
  uniform float uPlates;
  uniform float uCrackScale;
  uniform float uCrackWidth;
  uniform float uCracks;
  uniform float uSpiral;
  uniform float uSpiralArms;
  uniform float uSpiralTwist;
  uniform float uSpin;
  uniform float uWarp;
  uniform float uCrawl;
  uniform float uSparks;
  uniform float uSparkScale;
  uniform float uRings;
  uniform float uRingSpeed;
  uniform float uGlyphRing;
  uniform float uGlyphSeat;
  uniform float uGlyphTicks;
  uniform float uThroat;
  uniform float uThroatSize;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uOpen;        // 0..1 — how far the water has spread
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorWater;
  uniform vec3  uColorEdge;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    /* ---- uv → metres, measured from the centre of the footprint ---- */
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    float outer = uRadius + uBoundary * 0.4;
    float inner = max(0.01, uRadius - uBoundary * 0.6);

    float aa = fwidth(d) + 0.02;
    if (d > outer + aa * 4.0) discard;

    /* ---- how far the water has actually got ---- */
    vec2  bearing = d > 1e-4 ? p / d : vec2(1.0, 0.0);
    float tongues = 0.78 + 0.3 * snoise(vec3(bearing * 3.1, uSeed * 6.0));
    float reach   = uOpen * outer * tongues;
    float flooded = smoothstep(reach, reach - uBoundary * 1.6, d);
    if (flooded < 0.004) discard;

    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);
    float ang = atan(p.y, p.x);

    /* ---- the maelstrom ---- */
    // Shearing the angle by the radius is the whole spiral: at the rim the arms
    // are nearly radial, and they wind tighter every metre they run inward.
    float warp = fbm3(vec3(p * 0.45, uTime * 0.2 + uSeed)) * uWarp;
    float phase = ang * uSpiralArms + (1.0 - radial) * uSpiralTwist * TAU - uTime * uSpin * TAU + warp;
    float arms = pow(0.5 + 0.5 * cos(phase), 3.0) * uSpiral * interior * (0.25 + 0.75 * radial);

    /* ---- the drowned crust, lit from between its plates ---- */
    vec2  cell  = voronoi2(p * uCrackScale + uSeed * 20.0);
    float seams = smoothstep(uCrackWidth, 0.0, cell.x) * uCracks;
    float plate = mix(0.28, 1.0, cell.y) * uPlates;

    /* ---- cold sparks drifting in the water ---- */
    float sparks = pow(max(0.0, snoise(vec3(p * uSparkScale, uSeed * 9.0 - uTime * uCrawl))), 7.0) *
                   uSparks * interior;

    /* ---- swell rings running back in toward the throat ---- */
    float ring = 0.5 + 0.5 * cos((radial * uRings - uTime * uRingSpeed) * TAU);
    ring = pow(ring, 8.0) * interior;

    /* ---- the summoning ring: a thin second boundary, ticked ---- */
    float seat = uGlyphSeat * uRadius;
    float ticks = mix(1.0, pow(0.5 + 0.5 * cos(ang * uGlyphTicks), 6.0), 0.85);
    float glyph = smoothstep(uBoundary * 0.22, 0.0, abs(d - seat)) * ticks * uGlyphRing;

    /* ---- the throat in the middle — the mouth, and the anvil ---- */
    float throat = smoothstep(uThroatSize * uRadius, 0.0, d) * uThroat;

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float body  = (interior * pow(radial, uFalloff) * uFill * plate + arms * 0.8) * breathe;
    float lines = (band * uBoundaryGlow + seams * interior + ring * 0.5 + glyph + throat + sparks) * breathe;

    float alpha = clamp(body + lines, 0.0, 1.0) * flooded * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = uColorWater * body + uColorEdge * lines;
    // The advancing lip is where the stone is actually giving way, so it stays
    // brighter than anything behind it while it travels.
    color += uColorEdge * smoothstep(uBoundary * 1.2, 0.0, abs(d - reach)) * 1.3 *
             step(0.02, uOpen) * step(uOpen, 0.985);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The rift on the floor. One quad, re-sized and re-shaded from
 * `settings.kraken` every frame — an ability-owned mesh rather than a decal
 * because a decal captures its radius when it spawns and this circle has to
 * re-scale under `zoneRadius` while the arms are still standing in it.
 */
export function createAbyssFieldMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 12 },
      uRadius: { value: 4.6 },
      uBoundary: { value: 0.5 },
      uBoundaryGlow: { value: 1.6 },
      uFill: { value: 0.5 },
      uFalloff: { value: 1.2 },
      uPlates: { value: 0.7 },
      uCrackScale: { value: 2.4 },
      uCrackWidth: { value: 0.2 },
      uCracks: { value: 1.3 },
      uSpiral: { value: 0.7 },
      uSpiralArms: { value: 3 },
      uSpiralTwist: { value: 0.9 },
      uSpin: { value: 0.12 },
      uWarp: { value: 0.7 },
      uCrawl: { value: 0.5 },
      uSparks: { value: 1.1 },
      uSparkScale: { value: 5 },
      uRings: { value: 3.2 },
      uRingSpeed: { value: 0.6 },
      uGlyphRing: { value: 0.9 },
      uGlyphSeat: { value: 0.62 },
      uGlyphTicks: { value: 18 },
      uThroat: { value: 1.5 },
      uThroatSize: { value: 0.3 },
      uPulse: { value: 0.3 },
      uPulseSpeed: { value: 1.4 },
      uOpen: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorWater: { value: new Color(0.05, 0.4, 0.5) },
      uColorEdge: { value: new Color(0.4, 1.0, 0.9) }
    }),
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT
  });

  /**
   * @param {object} state { radius, quadSize, open, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.kraken;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uOpen.value = state.open;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uBoundary.value = c.fieldBoundary;
    u.uBoundaryGlow.value = c.fieldBoundaryGlow;
    u.uFill.value = c.fieldFill;
    u.uFalloff.value = c.fieldFalloff;
    u.uPlates.value = c.fieldPlates;
    u.uCrackScale.value = c.fieldCrackScale * g.noiseFrequency;
    u.uCrackWidth.value = c.fieldCrackWidth;
    u.uCracks.value = c.fieldCracks * g.shaderIntensity;
    u.uSpiral.value = c.fieldSpiral * g.shaderIntensity;
    u.uSpiralArms.value = Math.round(c.fieldSpiralArms);
    u.uSpiralTwist.value = c.fieldSpiralTwist;
    u.uSpin.value = c.fieldSpin;
    u.uWarp.value = c.fieldWarp * g.noiseStrength;
    u.uCrawl.value = c.fieldCrawl * g.noiseSpeed;
    u.uSparks.value = c.fieldSparks * g.shaderIntensity;
    u.uSparkScale.value = c.fieldSparkScale * g.noiseFrequency;
    u.uRings.value = c.fieldRings;
    u.uRingSpeed.value = c.fieldRingSpeed;
    u.uGlyphRing.value = c.fieldGlyphRing * g.shaderIntensity;
    u.uGlyphSeat.value = c.fieldGlyphSeat;
    u.uGlyphTicks.value = Math.round(c.fieldGlyphTicks);
    u.uThroat.value = c.fieldThroat;
    u.uThroatSize.value = c.fieldThroatSize;
    u.uPulse.value = c.fieldPulse;
    u.uPulseSpeed.value = c.fieldPulseSpeed;
    u.uOpacity.value = c.fieldOpacity * g.opacity;
    u.uColorWater.value.copy(getColor(c.colorField));
    u.uColorEdge.value.copy(getColor(c.colorFieldEdge));
  };

  return material;
}

/* ==================================================================== */
/* The brine hanging over the rim                                        */
/* ==================================================================== */

/**
 * The Pyre Crown's wall of flame, answered by the one thing that behaves the
 * opposite way. Fire climbs; this **hangs**.
 *
 * An open cylinder seated on the boundary, eroded by ridged noise that is
 * dragged *around* the ring rather than up it and that sinks slowly with time,
 * so the sheet reads as spray thrown up when the rift opened and now falling
 * back into it. The vertex stage pulls it inward with height instead of flaring
 * it out — a curtain of water leans over the hole it came out of.
 */
const VEIL_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uLean;
  uniform float uBillow;
  uniform float uScale;
  uniform float uFlow;
  uniform float uSeed;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    vUv = uv;

    vec3 pos = position;
    vec2 outward = normalize(pos.xz + vec2(1e-5));

    // A negative uLean closes the curtain over the rift, which is what makes the
    // ring read as a mouth rather than as a fountain.
    pos.xz *= 1.0 + uLean * pow(clamp(uv.y, 0.0, 1.0), 1.4);

    float lobe = snoise(vec3(outward * uScale * 1.3, uTime * uFlow * 0.35 + uSeed));
    pos.xz += outward * lobe * uBillow * (0.3 + 0.7 * uv.y);

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * Non-additive on purpose, and the only veil in the project that is.
 *
 * A wall of flame is light, so it adds. Spray is *matter* — it hides what is
 * behind it, and half of what makes the crown look deep is that the far arms are
 * seen through a haze of it while the near ones are not. Additive brine simply
 * glows, and a glowing mist over dark water reads as smoke.
 */
const VEIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uStretch;
  uniform float uFlow;
  uniform float uSwirl;
  uniform float uErode;
  uniform float uFalloff;
  uniform float uSoftFade;
  uniform float uGlint;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorBrine;
  uniform vec3  uColorFoam;
  uniform vec3  uColorInk;
  uniform float uGlobalGlow;

  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float up = clamp(vUv.y, 0.0, 1.0);

    // Sampled in world space so the curtain does not swim when the ring is
    // re-scaled. Dragged around the ring by uSwirl and settling downward with
    // uFlow — the opposite of the Pyre Crown's veil, which climbs.
    vec3 sp = vec3(vWorld.xz * uScale + uTime * uSwirl,
                   vWorld.y * uScale * uStretch + uTime * uFlow + uSeed * 7.0);
    float fil = ridged(sp, 4);

    float threshold = mix(0.42, 0.9, up * uErode);
    float sheet = smoothstep(threshold, threshold + 0.25, fil);

    float profile = pow(1.0 - up, uFalloff) * smoothstep(0.0, 0.08, up);

    float alpha = sheet * profile * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    // Ink at the floor where it is thickest, brine through the body, and foam
    // where the sheet tears — the bright fringe that gives spray its edge.
    float tear = smoothstep(0.35, 0.85, sheet);
    vec3 color = mix(uColorInk, uColorBrine, up * 0.7 + 0.3);
    color = mix(color, uColorFoam, tear * (0.35 + 0.65 * up));

    // Droplets catching the light as the sheet falls.
    float glint = pow(max(0.0, snoise(vec3(vWorld.xz * 6.0, vWorld.y * 3.0 - uTime * 2.0))), 8.0);
    color += uColorFoam * glint * uGlint;

    gl_FragColor = vec4(color * uGlobalGlow, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * The curtain of spray standing on the rim. One open cylinder seated on the
 * boundary, re-sized and re-shaded from `settings.kraken` every frame.
 */
export function createBrineVeilMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uLean: { value: -0.12 },
      uBillow: { value: 0.35 },
      uScale: { value: 1.1 },
      uStretch: { value: 0.6 },
      uFlow: { value: 0.5 },
      uSwirl: { value: 0.14 },
      uErode: { value: 0.8 },
      uFalloff: { value: 1.3 },
      uSoftFade: { value: 1.6 },
      uGlint: { value: 0.8 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 0.6 },
      uColorBrine: { value: new Color(0.12, 0.3, 0.36) },
      uColorFoam: { value: new Color(0.75, 0.95, 1.0) },
      uColorInk: { value: new Color(0.03, 0.05, 0.08) }
    }),
    vertexShader: VEIL_VERTEX,
    fragmentShader: VEIL_FRAGMENT
  });

  /**
   * @param {object} state { fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.kraken;
    const g = settings.global;
    const u = material.uniforms;

    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uLean.value = c.veilLean;
    u.uBillow.value = c.veilBillow;
    u.uScale.value = c.veilScale * g.noiseFrequency;
    u.uStretch.value = c.veilStretch;
    u.uFlow.value = c.veilFlow * g.noiseSpeed;
    u.uSwirl.value = c.veilSwirl * g.noiseSpeed;
    u.uErode.value = c.veilErode;
    u.uFalloff.value = c.veilFalloff;
    u.uSoftFade.value = c.veilSoftFade;
    u.uGlint.value = c.veilGlint * g.glow;
    u.uOpacity.value = c.veil * g.opacity;
    u.uColorBrine.value.copy(getColor(c.colorVeil));
    u.uColorFoam.value.copy(getColor(c.colorVeilFoam));
    u.uColorInk.value.copy(getColor(c.colorVeilInk));
  };

  return material;
}
