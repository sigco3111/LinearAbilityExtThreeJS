import { ShaderMaterial, NormalBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

const FIELD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The floor under a character running Magic Boost: **smoke, turning, with the
 * light of the buff pooled under it**.
 *
 * The sibling of `materials/ChargeFieldMaterial.js` and, like it, one of the
 * two ground passes in the sandbox that blend *normally* rather than
 * additively — for the same reason. The read here is that the stone has gone,
 * swallowed by something dark lying on it; additive blending can brighten a
 * floor but it can never darken one, and without the dark the violet in the
 * middle has nothing to be bright against.
 *
 * One pass carries both halves:
 *
 *   - **the smoke.** fbm in a frame that is *rotated by radius* — the further
 *     out a sample is, the further round it has been turned — so the cloud
 *     shears into a spiral and crawls around the caster instead of merely
 *     boiling in place. A domain warp on top of that keeps the billows from
 *     repeating.
 *   - **the light.** A pool at the centre falling off by `uPoolFalloff`, a soft
 *     ring seated inside the boundary, and glints scattered through the smoke.
 *     This is the part that blooms.
 *
 * Alpha is `max(smoke, light)`: near-opaque black where the cloud is thickest,
 * lit and far above 1.0 where the pool is, which is what puts the violet
 * through the bloom threshold while the smoke sits under the room.
 *
 * The boundary is dragged out of round by an angular lookup and feathered by
 * `uFeather` — unlike the crater, smoke has no lip to tear, so the edge is a
 * long soft fade rather than a line.
 *
 * Sized in metres from `uQuadSize` every frame rather than at spawn, so
 * `fieldRadius` re-scales a cloud that is already lying on the floor.
 */
const FIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;    // metres the quad covers, edge to edge
  uniform float uRadius;      // radius of the cloud, metres
  uniform float uFeather;     // fraction of the radius the edge fades over
  uniform float uTear;        // how far out of round the boundary is dragged

  uniform float uDark;        // opacity of the smoke — the actual darkness
  uniform float uSmokeScale;  // billows per metre
  uniform float uSmokeContrast;
  uniform float uSwirl;       // radians/second the whole cloud turns
  uniform float uCurl;        // extra turn per metre of radius — the shear
  uniform float uBillow;      // domain warp on the smoke
  uniform float uCrawl;       // how fast it boils

  uniform float uPool;        // the light gathered under the feet
  uniform float uPoolFalloff;
  uniform float uRing;        // a soft ring seated inside the boundary
  uniform float uRingWidth;
  uniform float uRingSeat;    // where it sits, fraction of the radius
  uniform float uGlints;      // single hot points glittering in the smoke
  uniform float uGlintScale;
  uniform float uPulse;
  uniform float uPulseSpeed;

  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorSmoke;
  uniform vec3  uColorSmokeLit;
  uniform vec3  uColorPool;
  uniform vec3  uColorGlint;

  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    /* ---- uv → metres, measured from the middle of the cloud ---- */
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    /* ---- the boundary, dragged out of round ---- */
    vec2  bearing = d > 1e-4 ? p / d : vec2(1.0, 0.0);
    float torn = 1.0 + uTear * snoise(vec3(bearing * 2.2, uSeed * 7.0 + uTime * 0.06));
    float rim = max(0.05, uRadius * torn);

    if (d > rim) discard;
    float radial = clamp(d / rim, 0.0, 1.0);
    // A long feather rather than a lip: smoke has no edge, it just runs out.
    float inside = 1.0 - smoothstep(1.0 - clamp(uFeather, 0.02, 1.0), 1.0, radial);
    if (inside < 0.004) discard;

    /* ---- the cloud, sheared into a spiral ---- */
    // Rotating the sample frame *by radius* is the whole trick: the outside of
    // the disc is dragged further round than the middle, so the billows wind
    // into arms instead of turning as one rigid plate.
    vec2 q = rot2(uTime * uSwirl + d * uCurl) * p;
    float warp = fbm3(vec3(q * 0.7, uTime * uCrawl * 0.7 + uSeed)) * uBillow;
    float smoke = fbm4(vec3(q * uSmokeScale + warp, uTime * uCrawl + uSeed * 5.0)) * 0.5 + 0.5;
    smoke = pow(clamp(smoke, 0.0, 1.0), max(uSmokeContrast, 0.05));

    vec3 dark = mix(uColorSmoke, uColorSmokeLit, smoke);
    // Thickest in the middle and thinning outward — a cloud has a centre.
    float smokeAlpha = uDark * inside * mix(0.55, 1.0, smoke) * mix(1.0, 0.55, radial);

    /* ---- the light under it ---- */
    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float pool = pow(1.0 - radial, max(uPoolFalloff, 0.05)) * uPool * mix(0.55, 1.0, smoke);
    float ring = smoothstep(max(uRingWidth, 1e-3), 0.0, abs(radial - clamp(uRingSeat, 0.0, 1.0))) * uRing;
    float glints = pow(max(0.0, snoise(vec3(q * uGlintScale, uSeed * 9.0 + uTime * 0.9))), 8.0) * uGlints;

    float light = (pool + ring + glints) * inside * breathe;

    float alpha = clamp(max(smokeAlpha, light), 0.0, 1.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = dark + (uColorPool * (pool + ring) + uColorGlint * glints) *
                        uGlow * uGlobalGlow * breathe;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The smoke under the boosted character. One quad, re-sized and re-shaded from
 * `settings.magic` every frame.
 */
export function createDarkFieldMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // Not additive — see above. This pass has to be able to take light away.
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 8 },
      uRadius: { value: 3 },
      uFeather: { value: 0.45 },
      uTear: { value: 0.12 },

      uDark: { value: 0.9 },
      uSmokeScale: { value: 0.55 },
      uSmokeContrast: { value: 1.5 },
      uSwirl: { value: 0.25 },
      uCurl: { value: 0.35 },
      uBillow: { value: 0.6 },
      uCrawl: { value: 0.25 },

      uPool: { value: 0.9 },
      uPoolFalloff: { value: 2.6 },
      uRing: { value: 0.5 },
      uRingWidth: { value: 0.12 },
      uRingSeat: { value: 0.72 },
      uGlints: { value: 0.7 },
      uGlintScale: { value: 4.5 },
      uPulse: { value: 0.16 },
      uPulseSpeed: { value: 0.6 },

      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.4 },
      uColorSmoke: { value: new Color(0.01, 0.005, 0.02) },
      uColorSmokeLit: { value: new Color(0.09, 0.03, 0.14) },
      uColorPool: { value: new Color(0.62, 0.16, 1) },
      uColorGlint: { value: new Color(0.94, 0.72, 1) }
    }),
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT
  });

  /** @param {object} state { radius, quadSize, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.magic;
    const g = settings.global;
    const u = material.uniforms;

    u.uRadius.value = state.radius;
    u.uQuadSize.value = state.quadSize;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uFeather.value = c.fieldFeather;
    u.uTear.value = c.fieldTear * g.randomness;

    u.uDark.value = c.fieldDark;
    u.uSmokeScale.value = c.fieldSmokeScale * g.noiseFrequency;
    u.uSmokeContrast.value = c.fieldSmokeContrast;
    u.uSwirl.value = c.fieldSwirl * g.speed;
    u.uCurl.value = c.fieldCurl;
    u.uBillow.value = c.fieldBillow * g.noiseStrength;
    u.uCrawl.value = c.fieldCrawl * g.noiseSpeed;

    u.uPool.value = c.fieldPool;
    u.uPoolFalloff.value = c.fieldPoolFalloff;
    u.uRing.value = c.fieldRing;
    u.uRingWidth.value = c.fieldRingWidth;
    u.uRingSeat.value = c.fieldRingSeat;
    u.uGlints.value = c.fieldGlints;
    u.uGlintScale.value = c.fieldGlintScale * g.noiseFrequency;
    u.uPulse.value = c.fieldPulse;
    u.uPulseSpeed.value = c.fieldPulseSpeed;

    u.uOpacity.value = c.fieldOpacity * g.opacity;
    u.uGlow.value = c.fieldGlow * g.shaderIntensity;

    u.uColorSmoke.value.copy(getColor(c.colorFieldSmoke));
    u.uColorSmokeLit.value.copy(getColor(c.colorFieldSmokeLit));
    u.uColorPool.value.copy(getColor(c.colorFieldPool));
    u.uColorGlint.value.copy(getColor(c.colorFieldGlint));
  };

  return material;
}
