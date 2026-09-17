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
 * The floor **burnt out** under a character who is on fire.
 *
 * The third ground pass in the sandbox that blends *normally* rather than
 * additively, and for the same reason as the charge's crater and the channel's
 * smoke: the read is stone that has been damaged, and additive blending can only
 * ever brighten what is behind it. Burnt ground has to subtract. So this pass
 * carries both halves of the picture at once — the char that takes the floor
 * away, and the fire in it that is bright against what is left:
 *
 *   - **the char.** Two octaves of warped fbm, pushed through a contrast curve
 *     and weighted to the middle, so the stone is soot-black under the caster's
 *     feet and merely stained out at the rim. `fieldChar` is how far it goes;
 *     at 0 the floor is untouched and only the fire is drawn.
 *   - **the cracks.** fbm measured to its *zero crossing* rather than
 *     thresholded — `1 - smoothstep(0, width, abs(field))` — which is what makes
 *     these read as a network of splits with molten light in them instead of as
 *     blotches. Domain-warped, and crawling, so the crust is working.
 *   - **the embers.** High-frequency noise raised to a hard power: single hot
 *     points glittering in the char, drifting as it breathes.
 *   - **the lip.** The boundary is dragged out of round by an angular lookup and
 *     lit where it sits, because the edge of a burn is the part still burning.
 *     `uFront` runs it outward as the buff arrives and pulls it back in as the
 *     buff lets go, so the ground catches and dies back rather than fading in
 *     place.
 *
 * Alpha is `max(char, light)`: opaque and black where the crust is, far above
 * 1.0 where a crack is — which is what puts the seams through the bloom
 * threshold while the char sits under the room.
 *
 * Sized in metres from `uQuadSize` every frame rather than at spawn, so
 * `fieldRadius` re-scales a burn that is already on the floor.
 */
const FIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;    // metres the quad covers, edge to edge
  uniform float uRadius;      // burn radius, metres
  uniform float uFeather;     // metres the edge fades over
  uniform float uTear;        // how far out of round the boundary is dragged

  uniform float uChar;        // opacity of the crust — the actual darkness
  uniform float uCharScale;
  uniform float uCharContrast;
  uniform float uCrackScale;
  uniform float uCrackWidth;
  uniform float uCracks;
  uniform float uWarp;
  uniform float uCrawl;
  uniform float uEmbers;
  uniform float uEmberScale;
  uniform float uRing;
  uniform float uRingWidth;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uFalloff;     // how the light dies back toward the lip
  uniform float uPulse;
  uniform float uPulseSpeed;

  uniform float uFront;       // 0..1 — how far the burn has spread
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorChar;
  uniform vec3  uColorCrack;
  uniform vec3  uColorEmber;
  uniform vec3  uColorRing;

  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  void main() {
    /* ---- uv → metres, measured from the centre of the burn ---- */
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    /* ---- the boundary, dragged out of round ---- */
    // Sampled on the *bearing* — the one place angular noise is the right tool,
    // because this is a boundary and nothing else is measured off it.
    vec2 bearing = d > 1e-4 ? p / d : vec2(1.0, 0.0);
    float lobe = snoise(vec3(bearing * 2.3, uSeed)) * 0.6
               + snoise(vec3(bearing * 5.1, uSeed + 7.3)) * 0.4;
    float edge = uRadius * max(uFront, 0.0) * (1.0 + lobe * uTear);

    float inside = 1.0 - smoothstep(edge - max(uFeather, 1e-3), edge, d);
    if (inside <= 0.001) discard;

    /* ---- how far in we are, and how the light falls off with it ---- */
    float u = clamp(d / max(edge, 1e-3), 0.0, 1.0);
    float core = pow(1.0 - u, max(uFalloff, 0.05));

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU + uSeed);
    float crawl = uTime * uCrawl;

    /* ---- the char ---- */
    vec3 cp = vec3(p * uCharScale, uSeed);
    float grain = fbm3(cp) * 0.5 + 0.5;
    grain = pow(clamp(grain, 0.0, 1.0), max(uCharContrast, 0.05));
    // Blackest under the feet, only stained at the rim.
    float char_ = clamp(uChar * grain * mix(0.35, 1.0, core), 0.0, 1.0) * inside;

    /* ---- the cracks ---- */
    vec3 wp = vec3(p * uCrackScale, crawl + uSeed);
    vec3 warp = vec3(fbm3(wp * 0.5), fbm3(wp.yzx * 0.5 + 11.3), 0.0) * uWarp;
    float field = fbm3(wp + warp);
    // Distance to the zero crossing: a network of splits, not a field of blobs.
    float crack = 1.0 - smoothstep(0.0, max(uCrackWidth, 1e-3), abs(field));
    crack *= uCracks * core;

    /* ---- the embers glittering in it ---- */
    float speck = snoise01(vec3(p * uEmberScale, crawl * 0.6 + uSeed + 31.7));
    float embers = pow(clamp(speck, 0.0, 1.0), 9.0) * uEmbers * mix(0.3, 1.0, core);

    /* ---- the lip, still burning ---- */
    float lip = 1.0 - smoothstep(0.0, max(uRingWidth, 1e-3), abs(d - edge));
    lip *= uRing;

    // One bright arc turning around the burn, so the ring is never uniform.
    float sweep = 0.5 + 0.5 * sin(atan(bearing.y, bearing.x) - uTime * uSweepSpeed * TAU);
    lip *= mix(1.0, sweep, clamp(uSweep, 0.0, 1.0));

    /* ---- put it together ---- */
    vec3 light = uColorCrack * crack + uColorEmber * embers + uColorRing * lip;
    light *= breathe * uGlow * uGlobalGlow;

    float lit = clamp(crack + embers + lip, 0.0, 4.0);
    vec3 color = mix(uColorChar, light, clamp(lit, 0.0, 1.0));

    // Black where the stone is, blown out where a seam is.
    float alpha = max(char_, lit * inside) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The burn on the floor.
 *
 * Nothing about it is captured: the radius, the char, the crack network and the
 * front are all re-resolved from `settings.fire` every frame, so the whole
 * folder is a live slider against a burn that is already standing — with the
 * clock stopped included.
 */
export function createCinderFieldMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 4 },
      uRadius: { value: 1.4 },
      uFeather: { value: 0.25 },
      uTear: { value: 0.12 },

      uChar: { value: 0.9 },
      uCharScale: { value: 1.6 },
      uCharContrast: { value: 1.5 },
      uCrackScale: { value: 1.9 },
      uCrackWidth: { value: 0.16 },
      uCracks: { value: 1.4 },
      uWarp: { value: 0.6 },
      uCrawl: { value: 0.25 },
      uEmbers: { value: 1.1 },
      uEmberScale: { value: 5.5 },
      uRing: { value: 1.2 },
      uRingWidth: { value: 0.16 },
      uSweep: { value: 0.45 },
      uSweepSpeed: { value: 0.18 },
      uFalloff: { value: 1.4 },
      uPulse: { value: 0.18 },
      uPulseSpeed: { value: 0.6 },

      uFront: { value: 1 },
      uSeed: { value: 0 },
      uFade: { value: 0 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.4 },

      uColorChar: { value: new Color(0.02, 0.012, 0.008) },
      uColorCrack: { value: new Color(1, 0.35, 0.05) },
      uColorEmber: { value: new Color(1, 0.75, 0.3) },
      uColorRing: { value: new Color(1, 0.5, 0.1) }
    }),
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT
  });

  /** @param {object} state { radius, quadSize, fade, front, seed } */
  material.userData.sync = (state) => {
    const c = settings.fire;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uFade.value = state.fade;
    u.uFront.value = state.front;
    u.uSeed.value = state.seed;

    u.uFeather.value = c.fieldFeather;
    u.uTear.value = c.fieldTear;
    u.uChar.value = c.fieldChar;
    u.uCharScale.value = c.fieldCharScale * g.noiseFrequency;
    u.uCharContrast.value = c.fieldCharContrast;
    u.uCrackScale.value = c.fieldCrackScale * g.noiseFrequency;
    u.uCrackWidth.value = c.fieldCrackWidth;
    u.uCracks.value = c.fieldCracks * g.shaderIntensity;
    u.uWarp.value = c.fieldWarp * g.noiseStrength;
    u.uCrawl.value = c.fieldCrawl * g.noiseSpeed;
    u.uEmbers.value = c.fieldEmbers * g.shaderIntensity;
    u.uEmberScale.value = c.fieldEmberScale * g.noiseFrequency;
    u.uRing.value = c.fieldRing * g.shaderIntensity;
    u.uRingWidth.value = c.fieldRingWidth;
    u.uSweep.value = c.fieldSweep;
    u.uSweepSpeed.value = c.fieldSweepSpeed * g.speed;
    u.uFalloff.value = c.fieldFalloff;
    u.uPulse.value = c.fieldPulse;
    u.uPulseSpeed.value = c.fieldPulseSpeed;
    u.uOpacity.value = c.fieldOpacity * g.opacity;
    u.uGlow.value = c.fieldGlow;

    u.uColorChar.value.copy(getColor(c.colorFieldChar));
    u.uColorCrack.value.copy(getColor(c.colorFieldCrack));
    u.uColorEmber.value.copy(getColor(c.colorFieldEmber));
    u.uColorRing.value.copy(getColor(c.colorFieldRing));
  };

  return material;
}
