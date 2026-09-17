import { ShaderMaterial, Color, Vector3, DoubleSide, NormalBlending } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * How many samples the bend integral takes up the arm.
 *
 * The centreline is the integral of a direction that turns as it climbs, and
 * that integral has no closed form for anything more interesting than a circular
 * arc — so it is evaluated numerically, per vertex, every frame. Twelve
 * trapezoid steps is the point where doubling it stops changing the silhouette:
 * the arm is forty-four rings long and the curvature profile is a quadratic, so
 * the error is far below the thickness of the arm it is bending.
 */
const BEND_STEPS = 12;

/**
 * The arm is deformed here, not on the CPU and not by its instance matrix.
 *
 * `assets/ProceduralGeometry.js#createTentacleGeometry` bakes a tentacle
 * standing straight up +Y with `position.y` carrying the arclength fraction.
 * This stage bends it, and the whole ability lives in that bend: a coil coming
 * out of the rift, a cocked rear, the whip down onto the middle and the peel
 * back off it are all one curvature profile with four numbers moved.
 *
 * **The profile.** The angle the arm has turned through by arclength `s`,
 * measured from straight up, is
 *
 *     θ(s) = A·s + C·s² + W·sin(2π·f·s + φ)·s
 *
 * — a lean (`A`), a curl that accelerates toward the point (`C`) and a
 * travelling wave that grows out of the base (`W`), which is what stops a
 * standing arm from reading as a bent pipe. Positive θ turns the arm toward its
 * own local +X, and the ability seats every arm with +X pointing at the middle
 * of the ring, so **positive is inward, over the crater** and negative leans it
 * out over the floor. That one convention is what makes the smash a single
 * number.
 *
 * **Why the smash lands.** Set `C` and `W` to zero and the profile is a constant
 * curvature — a circular arc — whose tip sits at
 *
 *     inward = L·(1 − cos Θ)/Θ,   up = L·sin Θ/Θ,   Θ = θ(1)
 *
 * At Θ = π that is exactly `(2L/π, 0)`: the point of the arm touches the floor,
 * `2L/π` metres inward of where it left the rift. So an arm `L = πR/2` long
 * strikes the **centre of a footprint of radius R**, dead on, at any radius, and
 * the ability derives its arm length from `zoneRadius` through precisely that
 * identity. Nothing is hand-tuned to make the arms meet in the middle, and
 * dragging the footprint slider keeps them meeting there.
 *
 * The centreline is integrated once per vertex up to that vertex's own `s`, and
 * the cross-section is placed on the frame that falls out of the same integral —
 * tangent, in-plane normal and a constant binormal — with a twist rolled around
 * the tangent so the sucker face turns as the arm turns.
 */
const KRAKEN_VERTEX = /* glsl */ `
  attribute vec4 aShape;  // x length (m), y base radius (m), z lean A, w curl C
  attribute vec4 aWave;   // x amplitude, y phase, z twist, w frequency
  attribute vec4 aLife;   // x emerged 0..1, y strike flash, z seed, w sink (m)

  uniform float uTime;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vView;
  varying float vT;
  varying float vGirth;
  varying float vSeed;
  varying float vEmerge;
  varying float vFlash;

  float angleAt(float s) {
    return aShape.z * s +
           aShape.w * s * s +
           aWave.x * sin(s * aWave.w * 6.28318530718 + aWave.y) * s;
  }

  // Centreline offset at t, for a unit-length arm: x along the bend, y up.
  vec2 centreAt(float t) {
    float dt = t / float(${BEND_STEPS});
    float th = angleAt(0.0);
    vec2 prev = vec2(sin(th), cos(th));
    vec2 acc = vec2(0.0);
    for (int i = 1; i <= ${BEND_STEPS}; i++) {
      float s = dt * float(i);
      float a = angleAt(s);
      vec2 cur = vec2(sin(a), cos(a));
      acc += (prev + cur) * 0.5 * dt;
      prev = cur;
    }
    return acc;
  }

  void main() {
    vUv = uv;
    vT = position.y;
    vGirth = length(position.xz);
    vSeed = aLife.z;
    vEmerge = aLife.x;
    vFlash = aLife.y;

    float t = position.y;
    float th = angleAt(t);

    // The frame the cross-section is carried on. It is exact for a planar bend:
    // the tangent is the direction the integral was accumulating, the in-plane
    // normal is that tangent turned a quarter turn, and the binormal never
    // moves — which is why this needs no rotation-minimising pass.
    vec3 T = vec3(sin(th), cos(th), 0.0);
    vec3 N = vec3(cos(th), -sin(th), 0.0);
    vec3 B = vec3(0.0, 0.0, 1.0);

    // Roll the section around the tangent as it climbs, so the sucker face
    // turns with the arm instead of facing one fixed way up a curling limb.
    float roll = aWave.z * t;
    float cr = cos(roll);
    float sr = sin(roll);
    vec2 off = position.xz * aShape.y;
    vec2 rolled = vec2(off.x * cr - off.y * sr, off.x * sr + off.y * cr);
    vec2 nrm = vec2(normal.x * cr - normal.z * sr, normal.x * sr + normal.z * cr);

    vec2 spine = centreAt(t) * aShape.x;
    vec3 local = vec3(spine.x, spine.y - aLife.w, 0.0) + N * rolled.x + B * rolled.y;
    vec3 localN = normalize(N * nrm.x + T * normal.y + B * nrm.y);

    vec4 world;
    #ifdef USE_INSTANCING
      // The instance matrix is a translation and a yaw only — the length and the
      // thickness are attributes, not scales, precisely so the bend is not
      // squashed by an anisotropic transform on the way out. That also means it
      // is rigid, and the normal needs no inverse transpose.
      world = modelMatrix * instanceMatrix * vec4(local, 1.0);
      localN = mat3(instanceMatrix) * localN;
    #else
      world = modelMatrix * vec4(local, 1.0);
    #endif

    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * localN);
    vView = cameraPosition - world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * **Flesh** — the one thing in this project that is neither fire, ice nor light.
 *
 * Every other ability here is made of energy, and energy is easy: it is
 * emissive, it does not have to survive being looked at closely, and a bloom
 * pass forgives it. An arm does not get any of that. It is lit by the room's own
 * sun, it has a wet coat that has to catch a highlight, and it has to hold up
 * with the camera two metres from it while it is pressed against the floor. So
 * this is a *shaded* material with a small emissive budget spent in exactly two
 * places, and the read is built out of five things:
 *
 *   - **A dorsal-to-ventral gradient.** `uv.x = 0` is the sucker face, and the
 *     arm is dark over the back and pale underneath, the way almost everything
 *     that swims is. That one gradient does more for the silhouette than any
 *     amount of detail, because it is what makes a curling arm read as having a
 *     front and a back.
 *   - **Mottle.** Domain-warped fbm sampled on the *cross-section direction*
 *     rather than on `uv.x` — an arm has a seam in its parameterisation and no
 *     seam in its skin, and sampling the angle directly is how you get a stripe
 *     down every limb.
 *   - **Chromatophores.** Bands of colour that travel the length of the arm and
 *     flush it toward `colorFlush`. This is the detail that sells the thing as
 *     *alive*: real cephalopods run exactly these waves down their arms, they
 *     are unmistakable, and nothing else in the sandbox moves like it. They
 *     accelerate on a strike, because the ability drives their speed off the
 *     same flash that fires when an arm lands.
 *   - **Suckers.** Two staggered rows laid down the ventral face, in a cell grid
 *     that packs tighter toward the point the way a real arm's do. Each is a cup
 *     — dark in the bowl, bright on the rim — and the rims carry the arm's
 *     bioluminescence, so the underside of a curl lights up as it turns over.
 *     They are the reason `uv.x` is anchored where it is.
 *   - **Wet.** A tight specular lobe, one sample of the room's HDR probe, and a
 *     fresnel that goes to `colorRim` — the standard trio for something with a
 *     film of water on it, and the thing that makes the arm look heavy.
 *
 * Two per-instance ramps sit on top, both mirroring the Pyre Crown's:
 * `aLife.x` is how far out of the rift the arm is, cut with a noisy front so it
 * *emerges* rather than sliding out of a hole, and `aLife.y` is the strike
 * flash, which floods the biolume and the chromatophores for a moment when an
 * arm hits the ground.
 */
const KRAKEN_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uEnvMap;
  uniform vec3  uSunDir;

  uniform vec3  uColorSkin;
  uniform vec3  uColorDeep;
  uniform vec3  uColorBelly;
  uniform vec3  uColorFlush;
  uniform vec3  uColorBiolume;
  uniform vec3  uColorSucker;
  uniform vec3  uColorRim;

  uniform float uMottle;
  uniform float uMottleScale;
  uniform float uMottleWarp;
  uniform float uBellyBlend;
  uniform float uDepthShade;

  uniform float uChroma;
  uniform float uChromaScale;
  uniform float uChromaSpeed;
  uniform float uChromaSharp;
  uniform float uChromaWarp;

  uniform float uSuckers;
  uniform float uSuckerDensity;
  uniform float uSuckerSize;
  uniform float uSuckerSpan;
  uniform float uRowSpacing;
  uniform float uSuckerRelief;
  uniform float uSuckerGlow;
  uniform float uSuckerStart;

  uniform float uBiolume;
  uniform float uBiolumeScale;
  uniform float uBiolumeSpeed;
  uniform float uBiolumePulse;

  uniform float uSpecular;
  uniform float uGloss;
  uniform float uEnvIntensity;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uTranslucency;

  uniform float uFrontRough;
  uniform float uFrontWidth;
  uniform float uFrontGlow;
  uniform float uFlashGain;

  uniform float uGlow;
  uniform float uOpacity;
  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vView;
  varying float vT;
  varying float vGirth;
  varying float vSeed;
  varying float vEmerge;
  varying float vFlash;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718
  #define PI 3.14159265359

  vec2 equirectUv(vec3 dir) {
    return vec2(atan(dir.z, dir.x) * 0.15915494 + 0.5,
                asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vView);
    if (dot(N, V) < 0.0) N = -N;
    float ndv = clamp(dot(N, V), 0.0, 1.0);

    /* ---- how far out of the rift this arm has come ---- */
    // Identical construction to the Pyre Crown's combustion front, and for the
    // same reason: an arm that is *revealed* along its own length climbs out of
    // the ground, where an arm that is translated up slides out of a hole.
    float ragged = snoise01(vec3(vUv.x * 3.0, vT * 6.0, vSeed * 7.0)) * uFrontRough;
    float front = vEmerge * (1.0 + uFrontRough) - ragged;
    if (vT > front) discard;
    float breaching = smoothstep(front - uFrontWidth, front, vT) *
                      (1.0 - smoothstep(0.985, 1.0, vEmerge));

    /* ---- where we are on the arm ---- */
    float aw = vUv.x * TAU;
    if (aw > PI) aw -= TAU;              // -π..π, 0 on the sucker face
    vec2 dir = vec2(cos(aw), sin(aw));   // seam-free coordinate around the arm
    float ventral = 0.5 + 0.5 * cos(aw); // 1 underneath, 0 over the back

    /* ---- mottled skin ---- */
    vec3 mp = vec3(dir * 1.6, vT * uMottleScale + vSeed * 4.0);
    float warp = fbm3(mp * 0.7) * uMottleWarp;
    float mottle = mix(0.5, fbm4(mp + warp) * 0.5 + 0.5, uMottle);

    vec3 skin = mix(uColorDeep, uColorSkin, mottle);
    // Pale underneath, and paler still right on the sucker face.
    skin = mix(skin, uColorBelly, pow(ventral, 1.6) * uBellyBlend);
    // Dark where it leaves the rift: the base of the arm is still in the hole.
    skin *= mix(1.0 - uDepthShade, 1.0, smoothstep(0.0, 0.22, vT));

    /* ---- chromatophore waves running the length of it ---- */
    // Sped up by the strike flash, so an arm that has just hit the ground
    // visibly floods before it settles back.
    float speed = uChromaSpeed * (1.0 + vFlash * 2.5);
    float band = sin((vT * uChromaScale - uTime * speed + mottle * uChromaWarp) * TAU);
    float flush = pow(max(0.0, band), uChromaSharp) * uChroma * (0.35 + 0.65 * vFlash + 0.3);
    skin = mix(skin, uColorFlush, clamp(flush, 0.0, 1.0));

    /* ---- two staggered rows of suckers down the ventral face ---- */
    float cup = 0.0;
    float rim = 0.0;
    if (uSuckers > 0.001) {
      float across = aw / max(0.05, uRowSpacing);
      float rowIdx = floor(across) + 0.5;          // rows sit at ±0.5
      float fr = across - rowIdx;
      // Packed tighter toward the point, and staggered row against row — which
      // is what makes it read as an arm rather than as a strip of polka dots.
      float along = pow(vT, 0.8) * uSuckerDensity + rowIdx;
      float fs = fract(along) - 0.5;

      float dd = length(vec2(fs, fr)) * 2.0;
      // Wider where the arm is thick, so the rows shrink with the limb they
      // are sitting on instead of crawling to the point at full size.
      float size = uSuckerSize * clamp(0.55 + vGirth * 0.6, 0.35, 1.0);
      float mask = step(abs(rowIdx), 0.9) *                    // the two inner rows only
                   smoothstep(uSuckerSpan, uSuckerSpan * 0.4, abs(aw)) *
                   smoothstep(uSuckerStart, uSuckerStart + 0.06, vT) *
                   smoothstep(1.0, 0.86, vT) * uSuckers;

      cup = smoothstep(size, size - 0.22, dd) * mask;
      rim = (smoothstep(size, size - 0.14, dd) - smoothstep(size * 0.6, size * 0.6 - 0.18, dd)) * mask;
    }

    /* ---- shading ---- */
    vec3 L = -uSunDir;
    // The cups are relief, not paint: they take light out of the bowl and put a
    // lit lip around it. Cheaper than perturbing the normal and, on something
    // this curved, indistinguishable.
    float relief = 1.0 - cup * uSuckerRelief + rim * uSuckerRelief * 0.8;
    float lambert = clamp(dot(N, L), 0.0, 1.0);
    float wrap = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0); // soft terminator — flesh scatters
    float diffuse = (0.22 + 0.78 * mix(lambert, wrap * wrap, 0.6)) * relief;

    vec3 refl = reflect(-V, N);
    vec3 env = texture2D(uEnvMap, equirectUv(refl)).rgb * uEnvIntensity;
    vec3 H = normalize(L + V);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), uGloss) * uSpecular * relief;
    float fres = pow(1.0 - ndv, uRimPower);

    // Light coming through the thin end of the arm.
    float thin = smoothstep(0.45, 1.0, vT) * pow(clamp(dot(-N, L) * 0.5 + 0.5, 0.0, 1.0), 2.0);

    vec3 color = skin * diffuse;
    color += env * (0.25 + 0.75 * fres) * skin;
    color += vec3(spec);
    color += uColorRim * fres * uRim;
    color += uColorFlush * thin * uTranslucency;

    /* ---- what light it makes itself ---- */
    // Bioluminescence: veins crawling up the arm, and the sucker rims, which is
    // where a curling limb reads brightest — the inside of the curl is the side
    // that faces you across the ring.
    float veins = pow(max(0.0, snoise(vec3(dir * 2.2, vT * uBiolumeScale - uTime * uBiolumeSpeed + vSeed))), 3.0);
    float pulse = 1.0 + uBiolumePulse * sin(uTime * 2.1 + vSeed * 9.0 + vT * 3.0);
    float lume = (veins * 0.7 + rim * uSuckerGlow) * uBiolume * pulse;
    color += uColorBiolume * (lume + vFlash * uFlashGain * (0.35 + rim));
    color += uColorSucker * rim * 0.35;

    // The wet lip where the arm is still coming out of the ground.
    color += uColorBiolume * breaching * uFrontGlow;

    color *= uGlow;
    // Same Reinhard ceiling every other material here uses: the sliders keep
    // biting at the top without flattening the arm into a white cutout.
    color /= 1.0 + color * 0.16;

    float alpha = clamp(uOpacity, 0.0, 1.0);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The arms of a Kraken Crown. One material for every arm in the cast; the
 * per-arm pose and state ride in on instanced attributes.
 */
export function createKrakenMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    // Opaque flesh: it must occlude itself, and the arms cross heavily over the
    // middle when they land on top of each other.
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: frame.uTime,
      uEnvMap: frame.uEnvMap,
      uGlobalGlow: frame.uGlobalGlow,
      uSunDir: { value: new Vector3(0, -1, 0) },

      uColorSkin: { value: new Color() },
      uColorDeep: { value: new Color() },
      uColorBelly: { value: new Color() },
      uColorFlush: { value: new Color() },
      uColorBiolume: { value: new Color() },
      uColorSucker: { value: new Color() },
      uColorRim: { value: new Color() },

      uMottle: { value: 0.6 },
      uMottleScale: { value: 3.4 },
      uMottleWarp: { value: 0.5 },
      uBellyBlend: { value: 0.75 },
      uDepthShade: { value: 0.55 },

      uChroma: { value: 0.55 },
      uChromaScale: { value: 2.2 },
      uChromaSpeed: { value: 0.5 },
      uChromaSharp: { value: 3.0 },
      uChromaWarp: { value: 0.6 },

      uSuckers: { value: 1.0 },
      uSuckerDensity: { value: 26 },
      uSuckerSize: { value: 0.66 },
      uSuckerSpan: { value: 0.8 },
      uRowSpacing: { value: 0.44 },
      uSuckerRelief: { value: 0.6 },
      uSuckerGlow: { value: 1.1 },
      uSuckerStart: { value: 0.05 },

      uBiolume: { value: 0.9 },
      uBiolumeScale: { value: 2.4 },
      uBiolumeSpeed: { value: 0.8 },
      uBiolumePulse: { value: 0.35 },

      uSpecular: { value: 1.6 },
      uGloss: { value: 48 },
      uEnvIntensity: { value: 0.5 },
      uRim: { value: 0.7 },
      uRimPower: { value: 3.0 },
      uTranslucency: { value: 0.45 },

      uFrontRough: { value: 0.3 },
      uFrontWidth: { value: 0.1 },
      uFrontGlow: { value: 2.2 },
      uFlashGain: { value: 1.6 },

      uGlow: { value: 1.0 },
      uOpacity: { value: 1.0 }
    },
    vertexShader: KRAKEN_VERTEX,
    fragmentShader: KRAKEN_FRAGMENT
  });

  const u = material.uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.kraken;
    const g = settings.global;
    const env = settings.environment;

    u.uColorSkin.value.copy(getColor(c.colorSkin));
    u.uColorDeep.value.copy(getColor(c.colorSkinDeep));
    u.uColorBelly.value.copy(getColor(c.colorBelly));
    u.uColorFlush.value.copy(getColor(c.colorFlush));
    u.uColorBiolume.value.copy(getColor(c.colorBiolume));
    u.uColorSucker.value.copy(getColor(c.colorSucker));
    u.uColorRim.value.copy(getColor(c.colorRim));

    u.uMottle.value = c.mottle;
    u.uMottleScale.value = c.mottleScale * g.noiseFrequency;
    u.uMottleWarp.value = c.mottleWarp * g.noiseStrength;
    u.uBellyBlend.value = c.bellyBlend;
    u.uDepthShade.value = c.depthShade;

    u.uChroma.value = c.chroma * g.shaderIntensity;
    u.uChromaScale.value = c.chromaScale;
    u.uChromaSpeed.value = c.chromaSpeed * g.noiseSpeed;
    u.uChromaSharp.value = c.chromaSharp;
    u.uChromaWarp.value = c.chromaWarp * g.noiseStrength;

    u.uSuckers.value = c.suckers;
    u.uSuckerDensity.value = c.suckerDensity;
    u.uSuckerSize.value = c.suckerSize;
    u.uSuckerSpan.value = c.suckerSpan;
    u.uRowSpacing.value = c.suckerRows;
    u.uSuckerRelief.value = c.suckerRelief;
    u.uSuckerGlow.value = c.suckerGlow;
    u.uSuckerStart.value = c.suckerStart;

    u.uBiolume.value = c.biolume * g.shaderIntensity;
    u.uBiolumeScale.value = c.biolumeScale * g.noiseFrequency;
    u.uBiolumeSpeed.value = c.biolumeSpeed * g.noiseSpeed;
    u.uBiolumePulse.value = c.biolumePulse;

    u.uSpecular.value = c.specular;
    u.uGloss.value = Math.max(2, c.gloss);
    u.uEnvIntensity.value = c.envIntensity;
    u.uRim.value = c.rim * g.fresnel;
    u.uRimPower.value = c.rimPower;
    u.uTranslucency.value = c.translucency;

    u.uFrontRough.value = c.frontRough * g.noiseStrength;
    u.uFrontWidth.value = c.frontWidth;
    u.uFrontGlow.value = c.frontGlow;
    u.uFlashGain.value = c.strikeFlash;

    u.uGlow.value = c.glow * g.glow;
    u.uOpacity.value = c.opacity * g.opacity;

    // The room's own key, so the wet coat picks up its highlight from the same
    // direction everything else in the scene is lit from.
    const cosE = Math.cos(env.sunElevation);
    u.uSunDir.value
      .set(
        -Math.cos(env.sunAzimuth) * cosE,
        -Math.sin(env.sunElevation),
        -Math.sin(env.sunAzimuth) * cosE
      )
      .normalize();
  };

  material.userData.sync();
  return material;
}
