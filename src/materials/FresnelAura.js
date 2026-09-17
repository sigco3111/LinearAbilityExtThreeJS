import { Color } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The fresnel charge that runs over the character while a self buff holds.
 *
 * Every material on the rig is patched **once, at load** — not swapped when the
 * buff fires. The patch adds four terms to the emissive of a stock
 * `MeshStandardMaterial`, all of them gated behind a single envelope uniform:
 *
 *   - **the rim** — the fresnel itself, `(1 - N·V)^power`, ramped from
 *     `colorRim` at the edge to `colorCore` where it is hottest. `fresnelBias`
 *     lifts the lit body off zero so the charge is visible head-on too, instead
 *     of only in silhouette.
 *   - **the veins** — filaments crawling over the skin. The field is sampled in
 *     the rig's **bind pose**, so the pattern is welded to the surface and
 *     travels with the arm rather than swimming through it as the body moves.
 *   - **the scan** — a band sweeping up the body, keyed off *world* height, so
 *     it sweeps the character rather than the mesh.
 *   - **breath and stutter** — a slow sine, and a quantised hash on top of it,
 *     because a charge gutters the way lightning does.
 *
 * ## Why one shared uniform block
 *
 * The rig arrives as several materials (three.js gives one per FBX material),
 * and every one of them is handed *the same uniform objects by identity* —
 * exactly as `core/FrameUniforms.js` does for the frame globals. One call to
 * `syncFresnelAura()` per frame therefore drives all of them, whatever the FBX
 * happened to be split into.
 *
 * ## Why it is free when the buff is off
 *
 * `uAuraStrength` is zero unless the buff is running, and the whole block sits
 * behind a branch on it. The patched shader is the shader the character always
 * uses — there is no recompile when the boost fires, and nothing to swap back.
 *
 * ## Why there are claims
 *
 * There is one uniform block and more than one buff that wants it: Electric
 * Boost lights the rig blue, Magic Boost lights it violet, Fire Boost masks it
 * in heat, and all three push their envelope every frame — including the zero
 * they push while they are *off*. Whoever ran last would win, so nobody writes
 * the uniforms directly: each buff files a claim under its own key and the
 * **strongest claim** is what the rig is shaded from. Buffs held at once
 * therefore look like the strongest one rather than like whichever happened to
 * update second, and a buff letting go hands the body back to the others
 * instead of switching it off.
 */

/** Handed to every character material by identity. */
const uniforms = {
  uTime: frame.uTime,

  /** 0..1 envelope. Zero disables the whole block. */
  uAuraStrength: { value: 0 },

  uAuraPower: { value: 2.5 },
  uAuraBias: { value: 0.06 },
  uAuraGlow: { value: 2.6 },
  uAuraPulse: { value: 0.22 },
  uAuraPulseSpeed: { value: 3.2 },
  uAuraFlicker: { value: 0.2 },
  uAuraFlickerSpeed: { value: 20 },

  uAuraVeins: { value: 0.6 },
  uAuraVeinScale: { value: 5.5 },
  uAuraVeinSpeed: { value: 1.3 },
  uAuraVeinSharp: { value: 0.6 },

  uAuraScan: { value: 0.45 },
  uAuraScanSpeed: { value: 0.5 },
  uAuraScanWidth: { value: 0.18 },

  /** Where the character's feet are and how tall it is — the scan's frame. */
  uAuraBaseY: { value: 0 },
  uAuraHeight: { value: 1.8 },

  uAuraColorRim: { value: new Color(0.5, 0.79, 1) },
  uAuraColorCore: { value: new Color(0.92, 0.97, 1) },
  uAuraColorVein: { value: new Color(0.29, 0.57, 1) }
};

const VERTEX_HEAD = /* glsl */ `
  varying vec3 vAuraBind;
  varying vec3 vAuraWorld;
`;

const FRAGMENT_HEAD = /* glsl */ `
  uniform float uTime;
  uniform float uAuraStrength;
  uniform float uAuraPower;
  uniform float uAuraBias;
  uniform float uAuraGlow;
  uniform float uAuraPulse;
  uniform float uAuraPulseSpeed;
  uniform float uAuraFlicker;
  uniform float uAuraFlickerSpeed;
  uniform float uAuraVeins;
  uniform float uAuraVeinScale;
  uniform float uAuraVeinSpeed;
  uniform float uAuraVeinSharp;
  uniform float uAuraScan;
  uniform float uAuraScanSpeed;
  uniform float uAuraScanWidth;
  uniform float uAuraBaseY;
  uniform float uAuraHeight;
  uniform vec3  uAuraColorRim;
  uniform vec3  uAuraColorCore;
  uniform vec3  uAuraColorVein;
  varying vec3  vAuraBind;
  varying vec3  vAuraWorld;
`;

const FRAGMENT_BODY = /* glsl */ `
  if (uAuraStrength > 0.001) {
    vec3  N   = normalize(normal);
    vec3  V   = normalize(vViewPosition);
    float ndv = clamp(dot(N, V), 0.0, 1.0);

    /* --- the rim --- */
    float rim = pow(1.0 - ndv, max(uAuraPower, 0.05)) + uAuraBias;
    rim = clamp(rim, 0.0, 2.0);

    /* --- the veins, in the bind pose so they stay welded to the skin --- */
    // Scrolled downward: the charge reads as running *up* the body, and the
    // pattern has to travel the other way for that to be what you see.
    vec3  vp    = vAuraBind * uAuraVeinScale + vec3(0.0, -uTime * uAuraVeinSpeed, uTime * 0.27);
    float field = fbm3(vp);
    // Distance to the zero crossing, thresholded — the same trick the meteor's
    // lava seams use, and the reason these read as filaments and not blotches.
    float width = mix(0.42, 0.045, clamp(uAuraVeinSharp, 0.0, 1.0));
    float vein  = 1.0 - smoothstep(0.0, width, abs(field));

    /* --- the band sweeping up the body --- */
    float h    = (vAuraWorld.y - uAuraBaseY) / max(uAuraHeight, 0.01);
    // The sweep starts below the feet and ends above the head, so the band is
    // fully off screen between passes rather than clipping at the ankles.
    float head = fract(uTime * uAuraScanSpeed) * 1.4 - 0.2;
    float d    = (h - head) / max(uAuraScanWidth, 0.01);
    float band = exp(-d * d);

    /* --- how hard all of it is driven --- */
    float pulse   = 1.0 + uAuraPulse * sin(uTime * uAuraPulseSpeed);
    float flicker = 1.0 - uAuraFlicker * hash11(floor(uTime * uAuraFlickerSpeed) * 1.37);

    vec3 aura = mix(uAuraColorRim, uAuraColorCore, smoothstep(0.35, 1.0, rim)) * rim;
    // Veins are brightest where the surface turns away, so they gather into the
    // rim instead of sitting flat across the chest.
    aura += uAuraColorVein * vein * uAuraVeins * (0.35 + 0.85 * rim);
    aura += uAuraColorCore * band * uAuraScan;
    aura *= pulse * flicker * uAuraStrength * uAuraGlow;

    totalEmissiveRadiance += aura;
    // A touch of it in the albedo as well: charged skin, not a decal floating
    // in front of it.
    diffuseColor.rgb += uAuraColorVein * vein * uAuraVeins * uAuraStrength * 0.06;
  }
`;

/**
 * Patch one character material so it can carry the charge.
 *
 * Goes through `Environment#registerShadowCasterWithPatch` rather than
 * assigning `onBeforeCompile`, because the shadow system patches these same
 * materials and the two must compose (see `utils/shaderPatch.js`).
 *
 * @param {import('three').Material} material
 * @param {import('../world/Environment.js').Environment} environment
 */
export function applyFresnelAura(material, environment) {
  return environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
      // Before skinning: the bind pose, which is what welds the veins to the
      // surface instead of letting the body slide through them.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n         vAuraBind = transformed;')
      // After it: where this vertex actually is, for the sweeping band.
      .replace(
        '#include <skinning_vertex>',
        '#include <skinning_vertex>\n         vAuraWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}\n${noiseGLSL}`)
      // `normal` and `vViewPosition` are both resolved by this point, and
      // `totalEmissiveRadiance` has not been used yet.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAGMENT_BODY}`);
  });
}

/** One entry per buff that can light the rig. The strongest one wins. */
const claims = new Map();

/**
 * Push the live settings and a buff's envelope into every patched material.
 *
 * Called once per frame by `effects/ElectricBoost.js`, `effects/MagicBoost.js`
 * and `effects/FireBoost.js`, on a zero-length frame included — which is what
 * keeps every control in the editor's three buff folders a live slider against a
 * paused, charged character.
 *
 * @param {number} strength 0..1 envelope; 0 releases this buff's claim
 * @param {number} baseY    world height of the character's feet
 * @param {number} height   the character's height, metres
 * @param {object} [config] the settings block to shade from
 * @param {string} [key]    which buff is claiming the rig
 */
export function syncFresnelAura(
  strength,
  baseY = 0,
  height = 1.8,
  config = settings.boost,
  key = 'boost'
) {
  let claim = claims.get(key);
  if (!claim) {
    claim = { strength: 0, baseY, height, config };
    claims.set(key, claim);
  }
  claim.strength = Math.max(0, strength);
  claim.baseY = baseY;
  claim.height = height;
  claim.config = config;

  // Resolved here rather than at the call site, so the answer does not depend
  // on which buff happened to update first this frame.
  let winner = claim;
  for (const other of claims.values()) {
    if (other.strength > winner.strength) winner = other;
  }
  applyClaim(winner);
}

/** Shade the rig from one claim. */
function applyClaim({ strength, baseY, height, config }) {
  const c = config;
  const g = settings.global;

  uniforms.uAuraStrength.value = Math.max(0, strength) * c.fresnel * g.fresnel;
  uniforms.uAuraPower.value = c.fresnelPower;
  uniforms.uAuraBias.value = c.fresnelBias;
  uniforms.uAuraGlow.value = c.fresnelGlow * g.glow * g.shaderIntensity;
  uniforms.uAuraPulse.value = c.fresnelPulse;
  uniforms.uAuraPulseSpeed.value = c.fresnelPulseSpeed;
  uniforms.uAuraFlicker.value = c.fresnelFlicker;
  uniforms.uAuraFlickerSpeed.value = c.fresnelFlickerSpeed;

  uniforms.uAuraVeins.value = c.veins;
  uniforms.uAuraVeinScale.value = c.veinScale * g.noiseFrequency;
  uniforms.uAuraVeinSpeed.value = c.veinSpeed * g.noiseSpeed;
  uniforms.uAuraVeinSharp.value = c.veinSharp;

  uniforms.uAuraScan.value = c.scan;
  uniforms.uAuraScanSpeed.value = c.scanSpeed;
  uniforms.uAuraScanWidth.value = c.scanWidth;

  uniforms.uAuraBaseY.value = baseY;
  uniforms.uAuraHeight.value = height;

  uniforms.uAuraColorRim.value.copy(getColor(c.colorRim));
  uniforms.uAuraColorCore.value.copy(getColor(c.colorCore));
  uniforms.uAuraColorVein.value.copy(getColor(c.colorVein));
}
