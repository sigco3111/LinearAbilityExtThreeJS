import { ShaderMaterial, AdditiveBlending, NormalBlending, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ==================================================================== */
/* The crater the crown stands in                                        */
/* ==================================================================== */

const FIELD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The circle the indicator promised, **burnt open** into the floor.
 *
 * Same signed-distance construction and the same thick boundary as the aim
 * circle, the Voltaic Snare's charred field and the Glacial Crown's sheet of
 * ice — the correspondence is the point: what you measured out before you
 * clicked is what is standing on the ground afterwards. What differs is what is
 * *in* it.
 *
 * This pass draws only the light. The dark is a `DecalType.SCORCH` the ability
 * lays underneath it, because burnt ground has to *subtract* from the floor and
 * this quad is additive; splitting the two is what lets the crust go genuinely
 * black while the seams in it go genuinely white. Additively, then:
 *
 *   - **the crust.** A voronoi field whose *seams* are molten, because that is
 *     where a cooling crust splits. The cell id also breaks the tone of each
 *     plate, so the floor has broken slabs on it rather than a wash.
 *   - **runnels.** Domain-warped ridged noise weighted to the radius: fire does
 *     not advance as a circle, it runs. Sampled in the *plane* and never on
 *     `atan()`, which would hand every radius along a bearing the same value and
 *     draw dead-straight spokes out of the middle.
 *   - **embers.** A high-frequency noise raised to a hard power, so single hot
 *     points glitter in the crust and drift as it breathes.
 *   - **a front.** `uBurn` is how far the fire has got, 0..1 of the boundary,
 *     with the same angular fingering dragging the edge out of round. It runs
 *     forward as the crown opens and *retreats* as the crown burns out, so the
 *     ground catches outward and dies back inward instead of fading in place.
 *
 * It is an ability-owned mesh rather than a pooled decal for one reason: a decal
 * captures its radius when it spawns, and this circle has to re-scale under
 * `zoneRadius` while it is still standing.
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
  uniform float uVeins;
  uniform float uVeinScale;
  uniform float uWarp;
  uniform float uCrawl;
  uniform float uEmbers;
  uniform float uEmberScale;
  uniform float uRings;
  uniform float uRingSpeed;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uBurn;        // 0..1 — how far the fire has spread
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorField;
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

    /* ---- how far the fire has actually got ---- */
    // The front is dragged out of round by an angular lookup — the one place an
    // angular function is the right tool, because this *is* a boundary.
    vec2  bearing = d > 1e-4 ? p / d : vec2(1.0, 0.0);
    float tongues = 0.76 + 0.32 * snoise(vec3(bearing * 3.4, uSeed * 6.0));
    float reach   = uBurn * outer * tongues;
    float burnt   = smoothstep(reach, reach - uBoundary * 1.6, d);
    if (burnt < 0.004) discard;

    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);

    /* ---- the crust, and the molten seams between its plates ---- */
    vec2  cell  = voronoi2(p * uCrackScale + uSeed * 20.0);
    float seams = smoothstep(uCrackWidth, 0.0, cell.x) * uCracks;
    float plate = mix(0.3, 1.0, cell.y) * uPlates;

    /* ---- runnels of fire crawling over it ---- */
    float warp = fbm3(vec3(p * 0.5, uTime * 0.15 + uSeed)) * uWarp;
    float fil  = ridged(vec3(p * uVeinScale + warp, uSeed * 11.0 - uTime * uCrawl), 4);
    float veins = smoothstep(0.62, 0.95, fil) * uVeins * (0.3 + 0.7 * radial);

    /* ---- single embers glittering in the crust ---- */
    float embers = pow(max(0.0, snoise(vec3(p * uEmberScale, uSeed * 9.0 + uTime * 0.9))), 7.0) *
                   uEmbers * interior;

    /* ---- heat rings travelling outward, away from the middle ---- */
    float ring = 0.5 + 0.5 * cos((radial * uRings - uTime * uRingSpeed) * TAU);
    ring = pow(ring, 8.0) * interior;

    /* ---- a slow sweep, so a standing crater is never quite still ---- */
    float ang = atan(p.y, p.x) / TAU + 0.5;
    float sweepPhase = fract(ang - uTime * uSweepSpeed);
    float sweep = pow(1.0 - sweepPhase, 6.0) * smoothstep(0.0, 0.05, sweepPhase) * uSweep * interior;

    /* ---- the pool of melt in the middle ---- */
    float core = smoothstep(uCoreSize * uRadius, 0.0, d) * uCore;

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float wash  = interior * pow(radial, uFalloff) * uFill * plate;
    float body  = (wash + veins * 0.7) * breathe;
    float lines = (band * uBoundaryGlow + seams * interior + ring * 0.5 + sweep + core + embers) * breathe;

    float alpha = clamp(body + lines, 0.0, 1.0) * burnt * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = uColorField * body + uColorEdge * lines;
    // The advancing lip is where the ground is actually catching, so it stays
    // hotter than anything behind it while it travels.
    color += uColorEdge * smoothstep(uBoundary * 1.2, 0.0, abs(d - reach)) * 1.2 *
             step(0.02, uBurn) * step(uBurn, 0.985);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The molten crater on the floor. One quad, re-sized and re-shaded from
 * `settings.pyre` every frame.
 */
export function createEmberFieldMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 12 },
      uRadius: { value: 4.2 },
      uBoundary: { value: 0.42 },
      uBoundaryGlow: { value: 3 },
      uFill: { value: 0.22 },
      uFalloff: { value: 1.6 },
      uPlates: { value: 0.8 },
      uCrackScale: { value: 2 },
      uCrackWidth: { value: 0.22 },
      uCracks: { value: 1.2 },
      uVeins: { value: 1 },
      uVeinScale: { value: 1.5 },
      uWarp: { value: 0.6 },
      uCrawl: { value: 0.16 },
      uEmbers: { value: 0.9 },
      uEmberScale: { value: 5 },
      uRings: { value: 2.2 },
      uRingSpeed: { value: 0.55 },
      uSweep: { value: 0.35 },
      uSweepSpeed: { value: -0.1 },
      uCore: { value: 1.4 },
      uCoreSize: { value: 0.3 },
      uPulse: { value: 0.3 },
      uPulseSpeed: { value: 2.4 },
      uBurn: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorField: { value: new Color(1, 0.35, 0.07) },
      uColorEdge: { value: new Color(1, 0.82, 0.48) }
    }),
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT
  });

  /**
   * @param {object} state { radius, quadSize, burn, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.pyre;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uBurn.value = state.burn;
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
    u.uVeins.value = c.fieldVeins * g.shaderIntensity;
    u.uVeinScale.value = c.fieldVeinScale * g.noiseFrequency;
    u.uWarp.value = c.fieldWarp * g.noiseStrength;
    u.uCrawl.value = c.fieldCrawl * g.noiseSpeed;
    u.uEmbers.value = c.fieldEmbers * g.shaderIntensity;
    u.uEmberScale.value = c.fieldEmberScale * g.noiseFrequency;
    u.uRings.value = c.fieldRings;
    u.uRingSpeed.value = c.fieldRingSpeed;
    u.uSweep.value = c.fieldSweep;
    u.uSweepSpeed.value = c.fieldSweepSpeed;
    u.uCore.value = c.fieldCore;
    u.uCoreSize.value = c.fieldCoreSize;
    u.uPulse.value = c.fieldPulse;
    u.uPulseSpeed.value = c.fieldPulseSpeed;
    u.uOpacity.value = c.fieldOpacity * g.opacity;
    u.uColorField.value.copy(getColor(c.colorField));
    u.uColorEdge.value.copy(getColor(c.colorFieldEdge));
  };

  return material;
}

/* ==================================================================== */
/* The wall of flame standing on the ring                                */
/* ==================================================================== */

/**
 * A cylinder in *parameter* space: `uv.x` runs once around the boundary and
 * `uv.y` from the floor to the top of the wall, and the vertex stage flares it
 * outward with height and pushes the silhouette off round with the same noise
 * the fragment stage erodes it with. Without that displacement the wall is a
 * cylinder no matter how hard the fragment shader is worked, and it reads as a
 * gas ring rather than as fire standing between the blades.
 */
const VEIL_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uFlare;
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

    // Flame leans outward as it climbs — much less than cold air spills, which
    // is why this ships far below the Glacial Crown veil flare.
    pos.xz *= 1.0 + uFlare * pow(clamp(uv.y, 0.0, 1.0), 1.6);

    // Metre-scale lobes, so the wall bulges and pinches around the ring.
    float lobe = snoise(vec3(outward * uScale * 1.4, uTime * uFlow * 0.5 + uSeed));
    pos.xz += outward * lobe * uBillow * (0.25 + 0.75 * uv.y);

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The wall itself: ridged noise stretched hard vertically and scrolled *up*,
 * thresholded harder the higher it goes, so the sheet tears into separate licks
 * toward the top instead of ending on a line. Its colour is a temperature that
 * falls with height — white at the floor, orange through the middle, and smoke
 * at the crests, which under additive blending is very nearly nothing and so
 * takes the tops out on their own.
 *
 * Soft-faded against the depth prepass, which is what lets it stand *between*
 * the blades without cutting into them.
 */
const VEIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uStretch;
  uniform float uFlow;
  uniform float uErode;
  uniform float uFalloff;
  uniform float uSoftFade;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorVeil;
  uniform vec3  uColorCrest;
  uniform vec3  uColorSmoke;
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

    // Sampled in world space so the wall does not swim when the ring is
    // re-scaled, squashed on Y so the structures are licks rather than clouds,
    // and scrolled the opposite way to the Glacial Crown's curtain: that one
    // pours down, this one climbs.
    vec3 sp = vec3(vWorld.xz * uScale, vWorld.y * uScale * uStretch - uTime * uFlow + uSeed * 7.0);
    float fil = ridged(sp, 4);

    // Erode harder with height: the top of the wall is mostly gaps.
    float threshold = mix(0.48, 0.95, up * uErode);
    float flame = smoothstep(threshold, threshold + 0.2, fil);

    // Weighted to the floor, and pinched off right at it so the wall does not
    // end in a hard line where it meets the ground.
    float profile = pow(1.0 - up, uFalloff) * smoothstep(0.0, 0.06, up);

    float alpha = flame * profile * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    // Temperature falls with height, and rises where the sheet is thick.
    float heat = clamp((1.0 - up) * mix(0.55, 1.35, flame), 0.0, 1.0);
    vec3 color = gradient4(uColorSmoke, uColorVeil, uColorCrest, uColorCrest, heat);

    gl_FragColor = vec4(color * uGlobalGlow, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * The standing wall of flame. One open cylinder seated on the boundary,
 * re-sized and re-shaded from `settings.pyre` every frame.
 */
export function createFlameVeilMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uFlare: { value: 0.18 },
      uBillow: { value: 0.3 },
      uScale: { value: 1.6 },
      uStretch: { value: 0.35 },
      uFlow: { value: 1.6 },
      uErode: { value: 0.75 },
      uFalloff: { value: 1.5 },
      uSoftFade: { value: 0.7 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 0.85 },
      uColorVeil: { value: new Color(1, 0.29, 0.03) },
      uColorCrest: { value: new Color(1, 0.85, 0.54) },
      uColorSmoke: { value: new Color(0.16, 0.07, 0.04) }
    }),
    vertexShader: VEIL_VERTEX,
    fragmentShader: VEIL_FRAGMENT
  });

  /**
   * @param {object} state { fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.pyre;
    const g = settings.global;
    const u = material.uniforms;

    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uFlare.value = c.veilFlare;
    u.uBillow.value = c.veilBillow * g.noiseStrength;
    u.uScale.value = c.veilScale * g.noiseFrequency;
    u.uStretch.value = c.veilStretch;
    u.uFlow.value = c.veilFlow * g.noiseSpeed;
    u.uErode.value = c.veilErode;
    u.uFalloff.value = c.veilFalloff;
    u.uSoftFade.value = c.veilSoftFade;
    u.uOpacity.value = c.veil * g.opacity;
    u.uColorVeil.value.copy(getColor(c.colorVeil));
    u.uColorCrest.value.copy(getColor(c.colorVeilCrest));
    u.uColorSmoke.value.copy(getColor(c.colorVeilSmoke));
  };

  return material;
}

/* ==================================================================== */
/* The air over it                                                       */
/* ==================================================================== */

/**
 * Heat haze: the one thing in this ability that is not drawn at all.
 *
 * This material writes **screen-space refraction offsets** instead of colour, on
 * `LAYER.DISTORTION`, which the composer renders into its own buffer before the
 * scene is composited and then uses to warp the finished image:
 *
 *   R,G → offset, encoded around 0.5   B → per-fragment strength   A → coverage
 *
 * A fire that does not bend the room behind it reads as a decal on the lens, and
 * no amount of extra flame geometry fixes that — the tell is *the floor tiles
 * behind the crown wobbling*, which nothing an emissive pass can do will fake.
 * It is a second open cylinder standing a little outside the wall of flame, and
 * it costs one draw into a half-resolution buffer.
 */
const HAZE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const HAZE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uFrequency;
  uniform float uSpeed;
  uniform float uFalloff;
  uniform float uSeed;
  uniform float uShaderIntensity;

  varying vec2 vUv;
  varying vec3 vWorld;

  ${noiseGLSL}

  void main() {
    // Scrolled downward through the noise so the cells appear to rise: hot air
    // over a fire goes exactly one way, and a haze that drifts sideways or sits
    // still is the fastest way to lose the read.
    vec3 np = vec3(vWorld.xz * uFrequency, vWorld.y * uFrequency * 0.55 - uTime * uSpeed + uSeed);
    float nx = snoise(np);
    float ny = snoise(np + vec3(19.3, 7.7, 31.1));

    // Strongest just off the floor and gone by the top, so the warp sits where
    // the fire actually is instead of hanging over the crown as a dome.
    float mask = pow(1.0 - clamp(vUv.y, 0.0, 1.0), uFalloff) * smoothstep(0.0, 0.06, vUv.y);

    float strength = uStrength * uShaderIntensity * mask;
    if (strength < 0.002) discard;

    gl_FragColor = vec4(vec2(nx, ny) * 0.5 + 0.5, strength, mask);
  }
`;

/**
 * The column of shimmering air over the crown. Lives on `LAYER.DISTORTION`, so
 * it is never seen directly — only the warp it writes.
 */
export function createHeatHazeMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // No depth test, matching every other distortion proxy: the buffer is a
    // screen-space field, not a rendering of the scene.
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uStrength: { value: 1 },
      uFrequency: { value: 2.4 },
      uSpeed: { value: 1.6 },
      uFalloff: { value: 1.2 },
      uSeed: { value: 0 }
    }),
    vertexShader: HAZE_VERTEX,
    fragmentShader: HAZE_FRAGMENT
  });

  /**
   * @param {object} state { fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.pyre;
    const g = settings.global;
    const u = material.uniforms;

    u.uSeed.value = state.seed;
    u.uStrength.value = c.haze * state.fade * g.distortion;
    u.uFrequency.value = c.hazeFrequency * g.noiseFrequency;
    u.uSpeed.value = c.hazeSpeed * g.noiseSpeed;
    u.uFalloff.value = c.hazeFalloff;
  };

  return material;
}
