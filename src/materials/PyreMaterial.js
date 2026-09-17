import { ShaderMaterial, Color, Vector3, DoubleSide, NormalBlending } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

const PYRE_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aBirth;
  attribute float aGrow;
  attribute float aChar;

  varying vec3  vLocal;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vView;
  varying vec3  vAxis;
  varying float vSeed;
  varying float vBirth;
  varying float vGrow;
  varying float vChar;

  void main() {
    vLocal = position;
    vSeed = aSeed;
    vBirth = aBirth;
    vGrow = aGrow;
    vChar = aChar;

    vec3 objectNormal = normal;
    vec3 objectAxis = vec3(0.0, 1.0, 0.0);
    vec4 world;

    #ifdef USE_INSTANCING
      // A blade is scaled (radius, height, radius), which is anisotropic — the
      // instance matrix would tip every normal toward the long axis. Dividing by
      // the squared column lengths is the inverse-transpose three itself uses.
      mat3 im = mat3(instanceMatrix);
      vec3 invScale = vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
      objectNormal = im * (objectNormal / invScale);
      objectAxis = im * (objectAxis / invScale);
      world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    #else
      world = modelMatrix * vec4(position, 1.0);
    #endif

    vWorld = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * objectNormal);
    vAxis = normalize(mat3(modelMatrix) * objectAxis);
    vView = cameraPosition - world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * Not a rock that is on fire — **fire in the shape of a blade**.
 *
 * The Glacial Crown's shards are near-empty glass carried by their edges: you
 * look *through* them and what you see is the room behind. This is the exact
 * inverse, and deliberately so, because the two abilities share a silhouette and
 * the material is the only thing that can tell them apart at a glance. A pyre
 * blade is **opaque**, it is lit by nothing but its own combustion, and almost
 * every pixel of it is emissive. What you see is:
 *
 *   - **a flame field, not a texture.** Domain-warped fbm sampled in the blade's
 *     own space, squashed hard along its axis (`flameStretch`) and scrolled
 *     *down* the noise so the pattern climbs *up* the blade. A ridged term is
 *     mixed in for the hard lip a real flame edge has, and `sharp` pushes the
 *     whole field through a contrast curve — which is what turns a soft gradient
 *     into the tongues-with-black-voids read the reference has.
 *   - **a four-stop heat ramp.** That field is a temperature, and temperature is
 *     colour: `colorChar` in the voids, through `colorEmber` and `colorFlame`,
 *     to an incandescent `colorCore`. One field, one ramp — which is why moving
 *     a single slider re-tempers the whole crown coherently instead of
 *     recolouring four unrelated layers.
 *   - **a shape on top of it.** Heat crowds toward the point (`heatBias`), the
 *     foot of the blade is choked with soot (`soot`, `sootHeight`) and the
 *     silhouette runs hot (`rim`) so every blade carries a fringe against the
 *     dark. That is the whole difference between a flame texture on a cone and
 *     something that reads as burning.
 *   - **stone underneath, optionally.** `rock` fades in a charred basalt body,
 *     lit by the stage's own key and catching one sample of its HDR probe. At 0
 *     the blade is pure fire, which is where it ships; turn it up and the fire
 *     is running over obsidian.
 *
 * On top of that sit the ability's two signatures, the reason this is a material
 * and not a colour swap:
 *
 *   - **the combustion front.** `aGrow` is a per-instance height, 0 at the floor
 *     and 1 at the point, and everything above it is discarded against a noisy
 *     cut — so a blade *catches* from the ground up rather than sliding out of a
 *     hole. The travelling lip is white-hot (`frontGlow`).
 *   - **the burn-down.** `aChar` is the same construction run from the *other
 *     end*: the point is eaten away first and the line walks down toward the
 *     floor, with an ember rim riding it (`charGlow`) and the body behind it
 *     draining to ash (`ashDrain`). The Crown does not shatter — it is
 *     **consumed**, and that asymmetry is what makes the two abilities end
 *     differently even though they begin the same way.
 *
 * Per-instance inputs arrive as instanced attributes (`aSeed`, `aBirth`,
 * `aGrow`, `aChar`), which is why this material is only ever used on an
 * InstancedMesh. The geometry is non-indexed with per-face normals, so the
 * facets come out crisp without a `flatShading` flag to ask for it.
 */
const PYRE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uEnvMap;
  uniform vec3  uSunDir;

  uniform vec3  uColorChar;
  uniform vec3  uColorEmber;
  uniform vec3  uColorFlame;
  uniform vec3  uColorCore;
  uniform vec3  uColorRock;
  uniform vec3  uColorRim;
  uniform vec3  uColorAsh;

  uniform float uRock;
  uniform float uFlameScale;
  uniform float uFlameStretch;
  uniform float uFlameSpeed;
  uniform float uFlameGain;
  uniform float uCurl;
  uniform float uSharp;
  uniform float uHeatBias;
  uniform float uSoot;
  uniform float uSootHeight;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uTipStart;
  uniform float uTipGlow;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uEnvIntensity;
  uniform float uSpecular;
  uniform float uBirthGlow;

  uniform float uFrontRough;
  uniform float uFrontWidth;
  uniform float uFrontGlow;
  uniform float uCharRough;
  uniform float uCharEdge;
  uniform float uCharGlow;
  uniform float uAshDrain;

  uniform float uGlow;
  uniform float uOpacity;
  uniform float uGlobalGlow;

  varying vec3  vLocal;
  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying vec3  vView;
  varying vec3  vAxis;
  varying float vSeed;
  varying float vBirth;
  varying float vGrow;
  varying float vChar;

  ${noiseGLSL}
  ${commonGLSL}

  vec2 equirectUv(vec3 dir) {
    return vec2(atan(dir.z, dir.x) * 0.15915494 + 0.5,
                asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vView);
    // Double-sided, because the burn-down opens a blade up and you end up
    // looking at the inside of one. Flip, or it shades inside out.
    if (dot(N, V) < 0.0) N = -N;

    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float h = clamp(vLocal.y, 0.0, 1.0);

    /* ---- the combustion front: nothing above it has caught yet ---- */
    // The roughness is added back on before the noise is taken off again, so a
    // fully lit blade (aGrow = 1) can never cut into itself.
    float ragged = snoise01(vLocal * 5.5 + vSeed * 7.0) * uFrontRough;
    float front  = vGrow * (1.0 + uFrontRough) - ragged;
    if (h > front) discard;
    float igniting = smoothstep(front - uFrontWidth, front, h) *
                     (1.0 - smoothstep(0.985, 1.0, vGrow));

    /* ---- the burn-down: the point goes to ash first ---- */
    // The same construction, run from the other end. The cut line is how far down the
    // blade the fire has eaten; at aChar = 0 it sits above the tip and takes
    // nothing away.
    float ashRim = 0.0;
    if (vChar > 0.001) {
      float bite = snoise01(vLocal * 4.2 - vSeed * 3.3) * uCharRough;
      float line = 1.0 - vChar * (1.0 + uCharRough) + bite;
      if (h > line) discard;
      ashRim = smoothstep(line - uCharEdge, line, h);
    }

    /* ---- the flame running up the blade ---- */
    // Scrolled *down* the noise so the pattern climbs, squashed on the axis so
    // the structures come out as tongues rather than as blobs.
    vec3 fp = vec3(vLocal.xz * uFlameScale,
                   vLocal.y * uFlameScale * uFlameStretch - uTime * uFlameSpeed + vSeed * 9.0);
    float warp = fbm3(fp * 0.55 + vec3(0.0, 0.0, uTime * uFlameSpeed * 0.3)) * uCurl;
    float soft = fbm4(fp + warp) * 0.5 + 0.5;
    // Ridged noise has the hard lip a flame edge has; fbm alone is all shoulder.
    float lips = ridged(fp * 0.85 + warp * 1.3, 4);
    float flame = clamp(mix(soft, lips * 1.15, 0.45), 0.0, 1.0);

    /* ---- where on the blade it is allowed to be hot ---- */
    float shape = mix(0.22, 1.0, pow(h, uHeatBias));                  // toward the point
    shape *= mix(1.0 - uSoot, 1.0, smoothstep(0.0, uSootHeight, h));  // choked at the foot
    shape += pow(1.0 - ndv, uRimPower) * uRim;                        // hot silhouette

    // Per-blade flicker, seeded off the instance so no two blades gutter
    // together — a whole crown breathing in unison reads as one flat card.
    float flicker = 1.0 + uFlicker * snoise(vec3(vSeed * 31.0, uTime * uFlickerSpeed, vSeed * 7.0));

    float heat = flame * shape * uFlameGain * flicker;
    // The contrast curve. This is what makes tongues instead of a wash.
    heat = mix(heat, smoothstep(0.34, 0.62, heat), uSharp);
    heat += igniting * uFrontGlow * 0.3;
    heat = clamp(heat * (1.0 - vChar * uAshDrain), 0.0, 1.6);

    vec3 fire = gradient4(uColorChar, uColorEmber, uColorFlame, uColorCore, heat);

    /* ---- the stone under it, if any is asked for ---- */
    vec3 L = -uSunDir;
    vec3 refl = reflect(-V, N);
    vec3 stone = vec3(0.0);
    if (uRock > 0.001) {
      float diff = 0.18 + 0.82 * clamp(dot(N, L), 0.0, 1.0);
      vec3 env = texture2D(uEnvMap, equirectUv(refl)).rgb * uEnvIntensity;
      float sun = pow(max(dot(refl, L), 0.0), 60.0) * uSpecular;
      stone = (mix(uColorRock, uColorAsh, vChar) * diff +
               env * (0.3 + 0.7 * pow(1.0 - ndv, 2.0)) +
               uColorRim * sun) * uRock;
    }

    float tip = smoothstep(uTipStart, 1.0, h) * (0.35 + 0.65 * flame);

    // Emission is superlinear in heat: the difference between orange and
    // white-hot has to be a difference in *level*, not only in hue, or the bloom
    // pass has nothing to find.
    vec3 color = stone * (1.0 - clamp(heat, 0.0, 1.0));
    color += fire * (0.22 + 1.4 * heat);
    color += uColorCore * tip * uTipGlow;
    color += uColorCore * igniting * uFrontGlow;
    color += uColorEmber * ashRim * uCharGlow;
    color += uColorCore * vBirth * uBirthGlow;
    color *= uGlow;

    // Soft ceiling. Every term above stacks at the hot end; a Reinhard rolloff
    // leaves anything under ~1 alone and asymptotes at 1/0.14 ≈ 7, so the
    // sliders keep biting at the top of their range without flattening the blade
    // into a white cutout.
    color /= 1.0 + color * 0.14;

    // Opaque: this is a solid thing standing in the world, and the crown has to
    // occlude itself or the far wall of blades shows through the near one.
    float alpha = clamp(uOpacity, 0.0, 1.0);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The blades of a Pyre Crown. One material for every shard in the cast; the
 * per-shard state rides in on instanced attributes.
 */
export function createPyreMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    // Kept on. The blades are opaque and they overlap heavily at the rim, so
    // depth writes are what stop the crown sorting through itself, and what let
    // the smoke and the heat haze fade against it.
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

      uColorChar: { value: new Color() },
      uColorEmber: { value: new Color() },
      uColorFlame: { value: new Color() },
      uColorCore: { value: new Color() },
      uColorRock: { value: new Color() },
      uColorRim: { value: new Color() },
      uColorAsh: { value: new Color() },

      uRock: { value: 0.0 },
      uFlameScale: { value: 3.4 },
      uFlameStretch: { value: 0.34 },
      uFlameSpeed: { value: 1.35 },
      uFlameGain: { value: 1.35 },
      uCurl: { value: 0.55 },
      uSharp: { value: 0.62 },
      uHeatBias: { value: 1.25 },
      uSoot: { value: 0.55 },
      uSootHeight: { value: 0.3 },
      uRim: { value: 0.5 },
      uRimPower: { value: 2.2 },
      uTipStart: { value: 0.66 },
      uTipGlow: { value: 1.6 },
      uFlicker: { value: 0.22 },
      uFlickerSpeed: { value: 7.5 },
      uEnvIntensity: { value: 0.35 },
      uSpecular: { value: 1.2 },
      uBirthGlow: { value: 2.6 },

      uFrontRough: { value: 0.4 },
      uFrontWidth: { value: 0.14 },
      uFrontGlow: { value: 3.2 },
      uCharRough: { value: 0.5 },
      uCharEdge: { value: 0.09 },
      uCharGlow: { value: 3.4 },
      uAshDrain: { value: 0.85 },

      uGlow: { value: 1.0 },
      uOpacity: { value: 1.0 }
    },
    vertexShader: PYRE_VERTEX,
    fragmentShader: PYRE_FRAGMENT
  });

  const u = material.uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.pyre;
    const g = settings.global;
    const env = settings.environment;

    u.uColorChar.value.copy(getColor(c.colorChar));
    u.uColorEmber.value.copy(getColor(c.colorEmber));
    u.uColorFlame.value.copy(getColor(c.colorFlame));
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorRock.value.copy(getColor(c.colorRock));
    u.uColorRim.value.copy(getColor(c.colorRim));
    u.uColorAsh.value.copy(getColor(c.colorAsh));

    u.uRock.value = c.rock;
    u.uFlameScale.value = c.flameScale * g.noiseFrequency;
    u.uFlameStretch.value = c.flameStretch;
    u.uFlameSpeed.value = c.flameSpeed * g.noiseSpeed;
    u.uFlameGain.value = c.flameGain * g.shaderIntensity;
    u.uCurl.value = c.curl * g.noiseStrength;
    u.uSharp.value = c.sharp;
    u.uHeatBias.value = c.heatBias;
    u.uSoot.value = c.soot;
    u.uSootHeight.value = Math.max(0.01, c.sootHeight);
    u.uRim.value = c.rim * g.fresnel;
    u.uRimPower.value = c.rimPower;
    u.uTipStart.value = c.tipStart;
    u.uTipGlow.value = c.tipGlow;
    u.uFlicker.value = c.flicker;
    u.uFlickerSpeed.value = c.flickerSpeed * g.noiseSpeed;
    u.uEnvIntensity.value = c.envIntensity;
    u.uSpecular.value = c.specular;
    u.uBirthGlow.value = c.birthGlow;

    u.uFrontRough.value = c.frontRough * g.noiseStrength;
    u.uFrontWidth.value = c.frontWidth;
    u.uFrontGlow.value = c.frontGlow;
    u.uCharRough.value = c.charRough * g.noiseStrength;
    u.uCharEdge.value = c.charEdge;
    u.uCharGlow.value = c.charGlow;
    u.uAshDrain.value = c.ashDrain;

    u.uGlow.value = c.glow * g.glow;
    u.uOpacity.value = c.opacity * g.opacity;

    // The sun the stage is actually lit by, so the stone — when it is turned up
    // — sits in the same key as everything else in the room.
    const cosE = Math.cos(env.sunElevation);
    u.uSunDir.value
      .set(-Math.cos(env.sunAzimuth) * cosE, -Math.sin(env.sunElevation), -Math.sin(env.sunAzimuth) * cosE)
      .normalize();
  };

  material.userData.sync();
  return material;
}
