import { MeshPhysicalMaterial, Color } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Procedurally shaded glass for the tower shaft.
 *
 * Built on `MeshPhysicalMaterial` so it gets proper PBR transmission,
 * refraction and attenuation — the obelisk reads as a warm yellow crystal
 * sitting on the floor, not as a flat decal. A shader patch applies the
 * same strata/glow terms the rest of the ability uses so the surface
 * still carries procedural detail at the silhouette and through bloom.
 *
 * A dedicated material instance is built per cast because
 * `MeshPhysicalMaterial.onBeforeCompile` is shared by reference and a
 * single patch would otherwise compile once and silently leak the wrong
 * uniforms to every mesh that holds it.
 *
 * @param {import('../world/Environment.js').Environment} environment
 *   the scene's environment (calls `registerShadowCasterWithPatch` to
 *   compose the CSM shadow injection with this shader patch)
 */
export function createGlassMaterial(environment) {
  const material = new MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0.0,
    roughness: 0.08,
    transmission: 0.95,
    ior: 1.5,
    thickness: 0.45,
    attenuationColor: new Color(1, 0.84, 0.29),
    attenuationDistance: 0.4,
    transparent: true,
    opacity: 0.55,
    emissive: new Color(0.16, 0.10, 0.02),
    emissiveIntensity: 0.4,
    flatShading: true,
    side: 0
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorRock: { value: getColor(settings.earth.colorRock).clone() },
    uColorDark: { value: getColor(settings.earth.colorRockDark).clone() },
    uColorMoss: { value: getColor(settings.earth.colorMoss).clone() },
    uGlowColor: { value: new Color(1, 0.45, 0.12) },
    uGlow: { value: 0 }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // Bring our world-space and local-space varyings into the vertex stage.
    // `vWorldPosition` and `vViewPosition` are the standard three.js names
    // in MeshStandardMaterial; the moss term reads the world normal, the
    // strata term reads the local position so the bands are welded to the
    // geometry rather than swimming through it.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vGlassWorld;
         varying vec3 vGlassLocal;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vGlassWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vGlassLocal = transformed;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3 uColorRock;
         uniform vec3 uColorDark;
         uniform vec3 uColorMoss;
         uniform vec3 uGlowColor;
         uniform float uGlow;
         varying vec3 vGlassWorld;
         varying vec3 vGlassLocal;
         ${noiseGLSL}`
      )
      // The glass reads mostly through the surface; the strata and moss
      // terms are what give it visual life at the silhouette and stop it
      // looking like a flat decal. Cracks stay — they bloom under the
      // emissive even on a transmissive material.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           float strata = snoise01(vGlassLocal * vec3(2.0, 9.0, 2.0));
           float grain = fbm3(vGlassWorld * 5.5) * 0.5 + 0.5;
           vec3 rock = mix(uColorDark, uColorRock, strata * 0.6 + grain * 0.5);

           vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
           float upness = clamp(dot(normalize(normal), upView), 0.0, 1.0);
           float moss = smoothstep(0.55, 0.95, upness) * smoothstep(0.35, 0.7, grain);
           rock = mix(rock, uColorMoss, moss * 0.4);

           float crack = smoothstep(0.90, 0.99, 1.0 - abs(strata - 0.5) * 2.0);
           diffuseColor.rgb *= rock;
           totalEmissiveRadiance += uGlowColor * crack * uGlow;
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /**
   * Refresh the glass and the underlying strata palette from the editor.
   *
   * @param {number} glow  the hot-seam emissive gain (0..1)
   */
  material.userData.sync = (glow = 0) => {
    const c = settings.earth;
    const g = settings.global;
    uniforms.uColorRock.value.copy(getColor(c.colorRock));
    uniforms.uColorDark.value.copy(getColor(c.colorRockDark));
    uniforms.uColorMoss.value.copy(getColor(c.colorMoss));
    uniforms.uGlowColor.value.copy(getColor(c.lightColor));
    uniforms.uGlow.value = glow * c.glow * g.glow;

    // Glass parameters — every value the editor exposes is wired here.
    material.color.copy(getColor(c.glassColor));
    material.transmission = c.glassTransmission;
    material.roughness = c.glassRoughness;
    material.ior = c.glassIor;
    material.thickness = c.glassThickness;
    material.attenuationColor.copy(getColor(c.glassAttenuationColor));
    material.attenuationDistance = c.glassAttenuationDistance;
    material.opacity = c.glassOpacity;
    material.emissive.copy(getColor(c.glassEmissive));
    material.emissiveIntensity = c.glassEmissiveStrength;
  };

  return material;
}
