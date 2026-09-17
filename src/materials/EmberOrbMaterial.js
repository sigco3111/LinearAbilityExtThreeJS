import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, FrontSide, Vector3, Vector4 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { MAX_FLAME_BONES } from './FireBodyMaterial.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/** The two passes an orb is drawn in. */
export const OrbPass = Object.freeze({
  BODY: 0, // the burning ball itself
  CORONA: 1 // the light it is sitting inside
});

/** The two passes a trail is drawn in. As every other ribbon in the project. */
export const TrailPass = Object.freeze({
  FLAME: 0, // the burning wake
  GLOW: 1 // the halo around it
});

/**
 * The golden angle. Used to space the orbital planes because it is the one
 * offset that never repeats and never clumps — the reason a sunflower head is
 * evenly covered — so eight orbs read as a sphere of rings rather than as two
 * rings of four.
 */
const GOLDEN = 2.399963229728653;

/* ==================================================================== */
/* The orbit                                                             */
/* ==================================================================== */

/**
 * One function, three readers: the orb's vertex shader, the trail's vertex
 * shader and `sampleOrbit()` below. Everything the effect knows about where an
 * orb is comes through here.
 *
 * ## Why it is deliberately hash-free
 *
 * Every other instanced effect in the project rolls its per-instance numbers out
 * of `hash11(index)`, and none of them needs the CPU to agree about the result.
 * This one does — embers are thrown off the orbs by `effects/FireBoost.js`, and
 * an ember shed from a position the GPU did not draw the orb at is a spark
 * coming out of thin air. GLSL hashes are `fract()` mills built to amplify tiny
 * differences, and a float32 GPU and a float64 CPU do not amplify them
 * identically, so a hashed orbit would drift apart between the two.
 *
 * So the lane's numbers come off `sin()` of its index instead. It is
 * deterministic, it agrees to the last useful digit on both sides of the bus,
 * and — because the orbits are meant to look *designed* rather than scattered —
 * it is also the better read.
 *
 * ## The construction
 *
 * A circle, leaned over, then turned. Three steps, in that order:
 *
 *   1. the orb runs a ring of its own radius at its own rate, half of them the
 *      other way round (`dir`), so nothing is ever in lock-step;
 *   2. the ring is leaned by `uTilt`, varied per lane, which is what turns a
 *      flat carousel into a sphere of rings;
 *   3. the leaned ring is turned about the body's own axis by the golden angle
 *      times the lane, plus `uPrecess` — so the whole armillary drifts, and no
 *      two orbs ever quite retrace each other's path.
 *
 * The result is a smooth, closed-form function of time, which is the property
 * the trail is built on: sample it in the past and you have the orb's *exact*
 * wake, with no history buffer to keep, nothing to reset when the sandbox is
 * paused, and a shape that re-derives itself the instant a slider moves.
 *
 * ## The limb, and why it is the default
 *
 * That armillary is a metre across, which puts the orbs and their wakes out in
 * the air beside the character rather than on them — handsome, and plainly
 * detached. So there is a second orbit: the same closed form, but a tight helix
 * about **one bone of the rig**, read out of the very joint arrays the tongues
 * are rooted on. Each lane binds to a limb and corkscrews along it, so the
 * wakes wind up a forearm and round a shin and swing with them through a cast.
 *
 * `orbCling` lerps between the two, and both ends of that lerp are still closed
 * forms of time — so the trail works untouched at any value of it, including
 * the ones in between.
 */
const ORBIT_GLSL = /* glsl */ `
  #define TAU 6.283185307179586
  #define GOLDEN 2.399963229728653

  uniform vec3  uBase;
  uniform vec3  uRight;
  uniform vec3  uForward;
  uniform float uHeight;

  uniform float uOrbRadius;
  uniform float uOrbRadiusVary;
  uniform float uOrbSeat;
  uniform float uOrbTilt;
  uniform float uOrbPrecess;
  uniform float uOrbRate;
  uniform float uOrbRateVary;
  uniform float uOrbBob;
  uniform float uOrbBobRate;
  uniform float uOrbSize;
  uniform float uOrbSizeVary;

  uniform vec4  uOrbBoneA[ORB_BONES];
  uniform vec4  uOrbBoneB[ORB_BONES];
  uniform float uOrbBoneCount;
  uniform float uOrbThickness;
  uniform float uOrbCling;
  uniform float uOrbCloud;
  uniform float uOrbSpiral;
  uniform float uOrbWhip;

  /**
   * Which limb lane <lane> is bound to.
   *
   * Integer arithmetic on a small float, for the same reason the rest of this
   * block is hash-free: the CPU mirrors it exactly, and an orb the two sides
   * disagree about sheds its embers off a limb it is not on. The stride is
   * coprime with nothing in particular — it just has to walk the weighted
   * segment list fast enough that eight orbs do not all land on the spine.
   */
  int orbLimb(float lane) {
    float n = max(uOrbBoneCount, 1.0);
    return int(mod(floor(lane * 5.0 + 1.0), n));
  }

  /**
   * Where lane <lane> is if it is riding a *limb* rather than a ring.
   *
   * A tight helix about one bone: the orb runs the ring across the limb at
   * uOrbWhip times its own rate while sliding up and down the bone at
   * uOrbSpiral, so it corkscrews along a forearm and back. Because the radius
   * is the limb's own half-width plus uOrbCloud, it is *on* the arm at any
   * pose, and because the whole thing is read out of the same joint arrays the
   * tongues are, it swings through a cast with the arm.
   */
  vec3 limbPoint(float lane, float time) {
    int idx = orbLimb(lane);
    vec4 head = uOrbBoneA[idx];
    vec4 tail = uOrbBoneB[idx];

    vec3 axis = tail.xyz - head.xyz;
    float len = length(axis);
    vec3 dir = len > 1e-5 ? axis / len : vec3(0.0, 1.0, 0.0);

    vec3 ref = abs(dot(dir, uRight)) > 0.9 ? uForward : uRight;
    vec3 n1 = normalize(cross(dir, ref));
    vec3 n2 = cross(dir, n1);

    float rate = uOrbRate * (1.0 + uOrbRateVary * sin(lane * 3.3 + 0.7));
    float d = mod(lane, 2.0) < 1.0 ? 1.0 : -1.0;
    float a = lane * GOLDEN * 2.0 + time * rate * uOrbWhip * TAU * d;
    // Never quite reaching either joint: an orb sitting exactly on an elbow
    // stops dead for a moment at each end of its slide, and reads as stuck.
    float along = 0.5 + 0.42 * sin(time * uOrbSpiral * TAU * d + lane * 2.4);

    float radius = head.w * uOrbThickness + uOrbCloud;
    return mix(head.xyz, tail.xyz, along) + (n1 * cos(a) + n2 * sin(a)) * radius;
  }

  /** Where lane <lane> is at time <time>, in world space. */
  vec3 ringPoint(float lane, float time) {
    float radius = uOrbRadius * (1.0 + uOrbRadiusVary * sin(lane * 2.1 + 1.3));
    float rate   = uOrbRate * (1.0 + uOrbRateVary * sin(lane * 3.3 + 0.7));
    float tilt   = uOrbTilt * sin(lane * 1.7 + 0.5);
    float yaw    = lane * GOLDEN + time * uOrbPrecess * TAU;
    float dir    = mod(lane, 2.0) < 1.0 ? 1.0 : -1.0;
    float a      = lane * GOLDEN * 2.0 + time * rate * TAU * dir;

    /* 1 — on its own ring */
    vec3 p = vec3(cos(a) * radius, 0.0, sin(a) * radius);

    /* 2 — the ring, leaned over */
    float ct = cos(tilt);
    float st = sin(tilt);
    p = vec3(p.x, p.y * ct - p.z * st, p.y * st + p.z * ct);

    /* 3 — and turned about the body */
    float cy = cos(yaw);
    float sy = sin(yaw);
    p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);

    p.y += uOrbBob * sin(time * uOrbBobRate * TAU + lane * 2.4);

    return uBase
      + uRight * p.x
      + vec3(0.0, uOrbSeat * uHeight + p.y, 0.0)
      + uForward * p.z;
  }

  /**
   * The orbit the effect actually draws: the armillary ring at uOrbCling 0, the
   * helix about a bone at 1, and a lerp of the two in between — which is a
   * usable shape all the way across, because both are smooth closed forms of
   * time and the trail samples whichever one this is in the past.
   */
  vec3 orbitPoint(float lane, float time) {
    float cling = clamp(uOrbCling, 0.0, 1.0);
    if (cling >= 0.999) return limbPoint(lane, time);
    vec3 ring = ringPoint(lane, time);
    if (cling <= 0.001) return ring;
    return mix(ring, limbPoint(lane, time), cling);
  }

  /** How big lane <lane> is, metres. */
  float orbScale(float lane) {
    return uOrbSize * (1.0 + uOrbSizeVary * sin(lane * 4.7 + 2.1));
  }
`;

/** Scratch for the CPU's own walk of a limb. Module-level, never allocated. */
const _axis = new Vector3();
const _n1 = new Vector3();
const _n2 = new Vector3();
const _ring = new Vector3();

/**
 * The CPU's copy of `limbPoint()`.
 *
 * Reads the very same `Vector4` arrays the shader is handed — the effect
 * writes the skeleton once a frame and passes it to both by identity — so the
 * two cannot be looking at different poses of the rig.
 */
function sampleLimb(out, lane, time, state) {
  const p = orbitParams();
  const count = Math.max(1, state.boneCount | 0);
  const idx = Math.floor(lane * 5 + 1) % count;
  const head = state.boneA[idx];
  const tail = state.boneB[idx];

  _axis.set(tail.x - head.x, tail.y - head.y, tail.z - head.z);
  const len = _axis.length();
  if (len > 1e-5) _axis.multiplyScalar(1 / len);
  else _axis.set(0, 1, 0);

  const ref = Math.abs(_axis.dot(state.right)) > 0.9 ? state.forward : state.right;
  _n1.crossVectors(_axis, ref).normalize();
  _n2.crossVectors(_axis, _n1);

  const rate = p.rate * (1 + p.rateVary * Math.sin(lane * 3.3 + 0.7));
  const d = lane % 2 < 1 ? 1 : -1;
  const a = lane * GOLDEN * 2 + time * rate * p.whip * Math.PI * 2 * d;
  const along = 0.5 + 0.42 * Math.sin(time * p.spiral * Math.PI * 2 * d + lane * 2.4);

  const radius = head.w * p.thickness + p.cloud;
  out.set(
    head.x + (tail.x - head.x) * along,
    head.y + (tail.y - head.y) * along,
    head.z + (tail.z - head.z) * along
  );
  out.addScaledVector(_n1, Math.cos(a) * radius);
  out.addScaledVector(_n2, Math.sin(a) * radius);
  return out;
}

/**
 * The CPU's copy of `orbitPoint()`.
 *
 * Line for line the same arithmetic as the GLSL above, reading the same
 * resolved settings through `orbitParams()` — which is the only reason the two
 * agree. **If you change the orbit, change it in both places**, and keep it free
 * of anything the two languages disagree about (hashes, `fract` mills, noise).
 *
 * @param {import('three').Vector3} out
 * @param {number} lane  the orb's index
 * @param {number} time  seconds; pass a time in the past to walk its wake
 * @param {object} state { base, right, forward, height, boneA, boneB, boneCount }
 */
export function sampleOrbit(out, lane, time, state) {
  const p = orbitParams();

  const cling = Math.min(1, Math.max(0, p.cling));
  if (cling >= 0.999) return sampleLimb(out, lane, time, state);

  const radius = p.radius * (1 + p.radiusVary * Math.sin(lane * 2.1 + 1.3));
  const rate = p.rate * (1 + p.rateVary * Math.sin(lane * 3.3 + 0.7));
  const tilt = p.tilt * Math.sin(lane * 1.7 + 0.5);
  const yaw = lane * GOLDEN + time * p.precess * Math.PI * 2;
  const dir = lane % 2 < 1 ? 1 : -1;
  const a = lane * GOLDEN * 2 + time * rate * Math.PI * 2 * dir;

  let x = Math.cos(a) * radius;
  let y = 0;
  let z = Math.sin(a) * radius;

  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const ty = y * ct - z * st;
  const tz = y * st + z * ct;
  y = ty;
  z = tz;

  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const rx = x * cy + z * sy;
  const rz = -x * sy + z * cy;
  x = rx;
  z = rz;

  y += p.bob * Math.sin(time * p.bobRate * Math.PI * 2 + lane * 2.4);

  out.copy(state.base);
  out.addScaledVector(state.right, x);
  out.y += p.seat * state.height + y;
  out.addScaledVector(state.forward, z);

  if (cling > 0.001) out.lerp(sampleLimb(_ring, lane, time, state), cling);
  return out;
}

/** How big lane `lane` is, metres. The mirror of `orbScale()` in the GLSL. */
export function sampleOrbScale(lane) {
  const p = orbitParams();
  return p.size * (1 + p.sizeVary * Math.sin(lane * 4.7 + 2.1));
}

/**
 * The orbit's numbers, resolved from live settings.
 *
 * One place, three readers: both `userData.sync()` implementations push these
 * into their uniforms and `sampleOrbit()` reads them directly, so the global
 * multipliers cannot be applied to one side of the bus and not the other.
 */
function orbitParams() {
  const c = settings.fire;
  const g = settings.global;
  return {
    radius: c.orbRadius,
    radiusVary: c.orbRadiusVary,
    seat: c.orbSeat,
    tilt: c.orbTilt,
    precess: c.orbPrecess * g.speed,
    rate: c.orbRate * g.speed,
    rateVary: c.orbRateVary,
    bob: c.orbBob,
    bobRate: c.orbBobRate * g.speed,
    size: c.orbSize,
    sizeVary: c.orbSizeVary,
    cling: c.orbCling,
    thickness: c.boneThickness,
    cloud: c.orbCloud,
    spiral: c.orbSpiral * g.speed,
    whip: c.orbWhip
  };
}

/** Push the resolved orbit into one material's uniforms. */
function syncOrbit(u, state) {
  const p = orbitParams();

  u.uBase.value.copy(state.base);
  u.uRight.value.copy(state.right);
  u.uForward.value.copy(state.forward);
  u.uHeight.value = state.height;

  u.uOrbRadius.value = p.radius;
  u.uOrbRadiusVary.value = p.radiusVary;
  u.uOrbSeat.value = p.seat;
  u.uOrbTilt.value = p.tilt;
  u.uOrbPrecess.value = p.precess;
  u.uOrbRate.value = p.rate;
  u.uOrbRateVary.value = p.rateVary;
  u.uOrbBob.value = p.bob;
  u.uOrbBobRate.value = p.bobRate;
  u.uOrbSize.value = p.size;
  u.uOrbSizeVary.value = p.sizeVary;

  // By identity, exactly as the flame passes take them: the effect writes the
  // skeleton once a frame and every reader looks at the same `Vector4`s.
  u.uOrbBoneA.value = state.boneA;
  u.uOrbBoneB.value = state.boneB;
  u.uOrbBoneCount.value = state.boneCount;
  u.uOrbThickness.value = p.thickness;
  u.uOrbCling.value = p.cling;
  u.uOrbCloud.value = p.cloud;
  u.uOrbSpiral.value = p.spiral;
  u.uOrbWhip.value = p.whip;
}

/** The uniform block `ORBIT_GLSL` needs. Shared by both materials. */
function orbitUniforms() {
  return {
    uBase: { value: new Vector3() },
    uRight: { value: new Vector3(1, 0, 0) },
    uForward: { value: new Vector3(0, 0, 1) },
    uHeight: { value: 1.8 },

    uOrbRadius: { value: 1.05 },
    uOrbRadiusVary: { value: 0.18 },
    uOrbSeat: { value: 0.55 },
    uOrbTilt: { value: 0.8 },
    uOrbPrecess: { value: 0.06 },
    uOrbRate: { value: 0.42 },
    uOrbRateVary: { value: 0.22 },
    uOrbBob: { value: 0.08 },
    uOrbBobRate: { value: 0.35 },
    uOrbSize: { value: 0.12 },
    uOrbSizeVary: { value: 0.25 },

    // Replaced by identity with the effect's own arrays on the first sync.
    uOrbBoneA: { value: Array.from({ length: MAX_FLAME_BONES }, () => new Vector4()) },
    uOrbBoneB: { value: Array.from({ length: MAX_FLAME_BONES }, () => new Vector4()) },
    uOrbBoneCount: { value: 0 },
    uOrbThickness: { value: 1 },
    uOrbCling: { value: 1 },
    uOrbCloud: { value: 0.07 },
    uOrbSpiral: { value: 0.22 },
    uOrbWhip: { value: 2.6 }
  };
}

/* ==================================================================== */
/* The orbs                                                              */
/* ==================================================================== */

/**
 * The ball itself.
 *
 * Placed entirely in the vertex shader: the geometry is a unit sphere, the mesh
 * sits at identity, and every vertex is `orbitPoint(aOrb, uTime)` plus its own
 * offset. That is the same world-space construction the arcs and the ribbons
 * use, and it buys the same thing — the CPU writes no matrices, and the orbs
 * re-place themselves on a zero-length frame, so `orbTilt` re-winds an armillary
 * that is already standing with the clock paused.
 *
 * One term is not spherical: `uStretch` elongates the ball along its own
 * direction of travel, taken as the difference between where it is and where it
 * will be a fiftieth of a second later. It is a small number, and it is what
 * separates a ball that is *moving* from a ball that has been placed.
 */
const ORB_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uSizeScale;
  uniform float uStretch;

  attribute float aOrb;

  varying vec3  vDir;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vLane;
  varying float vViewZ;

  ${ORBIT_GLSL}

  void main() {
    vLane = aOrb;
    vDir = normalize(position);

    vec3 here = orbitPoint(aOrb, uTime);
    vec3 ahead = orbitPoint(aOrb, uTime + 0.02);
    vec3 travel = ahead - here;
    travel = length(travel) > 1e-5 ? normalize(travel) : vec3(0.0, 1.0, 0.0);

    vec3 offset = position * orbScale(aOrb) * uSizeScale * max(uStrength, 0.0);
    offset += travel * dot(offset, travel) * uStretch;

    vec3 world = here + offset;

    // The stretch is small enough that the sphere's own normal is still the
    // right one to shade with — and a fireball is a volume, not a surface.
    vNormalW = vDir;
    vViewDir = cameraPosition - world;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * A small sun, not a shaded ball.
 *
 * Nothing here is lit by the room. What you see is:
 *
 *   - **the core.** `pow(N·V, uCoreFalloff)` — brightest where you are looking
 *     straight through the middle of the volume and falling off toward the
 *     silhouette, which is what a ball of burning gas actually does and the
 *     opposite of what a Fresnel-lit shell does.
 *   - **convection.** Domain-warped fbm sampled on the sphere's own direction
 *     and boiling *upward*, so the surface churns instead of sitting still.
 *     Each lane samples a different part of the field, so no two orbs are the
 *     same ball.
 *   - **the rim.** A thin hot ring is added back at the silhouette (`uRim`) —
 *     the flame being seen edge-on through more gas than anywhere else.
 *
 * The corona pass is the same sphere blown up by `uCoronaSize` with the
 * convection switched off: a soft ball of light with no detail in it at all,
 * which is what keeps the orbs reading as *bright* rather than as big.
 */
const ORB_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uSeed;

  uniform float uCoreFalloff;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uCells;
  uniform float uCellScale;
  uniform float uCellWarp;
  uniform float uBoil;
  uniform float uHeat;
  uniform float uCoreSize;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;

  uniform vec3  uColorCore;
  uniform vec3  uColorFlame;
  uniform vec3  uColorEmber;
  uniform vec3  uColorSmoke;

  uniform float uGlobalGlow;

  varying vec3  vDir;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vLane;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float ndv = clamp(dot(N, V), 0.0, 1.0);

    float core = pow(ndv, max(uCoreFalloff, 0.05));
    float rim = pow(1.0 - ndv, max(uRimPower, 0.05));

    #ifdef ORB_CORONA
      float alpha = core * uPassOpacity;
      float heat = clamp(core * uHeat, 0.0, 1.0);
      vec3 color = mix(uColorEmber, uColorFlame, heat);
    #else
      /* --- the convection, warped so the cells are not a lattice --- */
      vec3 seed = vec3(vLane * 7.31 + uSeed, 0.0, vLane * 3.17);
      vec3 p = vDir * uCellScale + seed;
      vec3 drift = vec3(0.0, -uTime * uBoil, uTime * uBoil * 0.31);
      vec3 warp = vec3(
        fbm3(p + drift),
        fbm3(p.yzx + drift * 1.3 + 19.7),
        fbm3(p.zxy + drift * 0.7 + 41.3)
      );
      float field = fbm3(p + warp * uCellWarp + drift) * 0.5 + 0.5;
      float cells = mix(1.0, field * 1.7, clamp(uCells, 0.0, 1.0));

      float heat = clamp(core * cells * uHeat + rim * uRim, 0.0, 1.0);
      vec3 color = gradient4(uColorSmoke, uColorEmber, uColorFlame, uColorCore,
                             pow(heat, max(uCoreSize, 0.05)));
      float alpha = clamp(core * mix(0.55, 1.0, cells) + rim * uRim * 0.7, 0.0, 1.0);
      alpha *= uPassOpacity;
    #endif

    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + vLane * 5.3 + uSeed);

    alpha *= flicker * uOpacity * clamp(uStrength, 0.0, 1.0);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow * flicker;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of the orbs.
 *
 * @param {number} pass OrbPass.*
 */
export function createEmberOrbMaterial(pass = OrbPass.BODY) {
  const corona = pass === OrbPass.CORONA;

  const material = new ShaderMaterial({
    defines: corona
      ? { ORB_CORONA: '', ORB_BONES: MAX_FLAME_BONES }
      : { ORB_BONES: MAX_FLAME_BONES },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    // The corona is a shell you are meant to see the far side of; the body is
    // dense enough that drawing its back faces only doubles the fill.
    side: corona ? DoubleSide : FrontSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...orbitUniforms(),
      uSeed: { value: 0 },
      uStrength: { value: 0 },
      uSizeScale: { value: corona ? 2.6 : 1 },
      uStretch: { value: 0.35 },

      uCoreFalloff: { value: corona ? 1.6 : 0.85 },
      uRim: { value: 0.55 },
      uRimPower: { value: 2.4 },
      uCells: { value: 0.85 },
      uCellScale: { value: 2.6 },
      uCellWarp: { value: 0.55 },
      uBoil: { value: 0.9 },
      uHeat: { value: 1.35 },
      uCoreSize: { value: 0.8 },
      uFlicker: { value: 0.16 },
      uFlickerSpeed: { value: 16 },
      uPassOpacity: { value: corona ? 0.32 : 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.6 },

      uColorCore: { value: new Color(1, 0.97, 0.86) },
      uColorFlame: { value: new Color(1, 0.62, 0.16) },
      uColorEmber: { value: new Color(0.9, 0.22, 0.03) },
      uColorSmoke: { value: new Color(0.1, 0.03, 0.01) }
    }),
    vertexShader: ORB_VERTEX,
    fragmentShader: ORB_FRAGMENT
  });

  /**
   * @param {object} state
   *   { base, right, forward, height, strength, seed, boneA, boneB, boneCount }
   */
  material.userData.sync = (state) => {
    const c = settings.fire;
    const g = settings.global;
    const u = material.uniforms;

    syncOrbit(u, state);
    u.uStrength.value = state.strength;
    u.uSeed.value = state.seed;

    u.uSizeScale.value = corona ? c.orbCoronaSize : 1;
    u.uStretch.value = c.orbStretch;

    u.uCoreFalloff.value = corona ? c.orbCoronaFalloff : c.orbFalloff;
    u.uRim.value = c.orbRim;
    u.uRimPower.value = c.orbRimPower;
    u.uCells.value = c.orbCells;
    u.uCellScale.value = c.orbCellScale * g.noiseFrequency;
    u.uCellWarp.value = c.orbCellWarp * g.noiseStrength;
    u.uBoil.value = c.orbBoil * g.noiseSpeed;
    u.uHeat.value = c.orbHeat * g.shaderIntensity;
    u.uCoreSize.value = c.orbCoreSize;
    u.uFlicker.value = c.orbFlicker;
    u.uFlickerSpeed.value = c.orbFlickerSpeed;
    u.uPassOpacity.value = corona ? c.orbCoronaOpacity : 1;
    u.uOpacity.value = c.orbOpacity * g.opacity;
    u.uGlow.value = c.orbGlow;

    u.uColorCore.value.copy(getColor(c.colorOrbCore));
    u.uColorFlame.value.copy(getColor(c.colorOrbFlame));
    u.uColorEmber.value.copy(getColor(c.colorOrbEmber));
    u.uColorSmoke.value.copy(getColor(c.colorOrbSmoke));
  };

  return material;
}

/* ==================================================================== */
/* The trails                                                            */
/* ==================================================================== */

/**
 * The fire an orb leaves behind it.
 *
 * `t` runs 0 → 1 from the orb to the end of the trail, and the position at `t`
 * is **where that orb actually was** `t * uSpan` seconds ago:
 *
 *     orbitPoint(lane, uTime - t * uSpan)
 *
 * That is the whole technique, and it is worth being explicit about why it is
 * better than the obvious one. A trail is normally a ring buffer of past
 * positions pushed by the CPU each frame, which means: memory per orb, a warm-up
 * before the trail has any length, a discontinuity every time the effect is
 * re-activated, garbage in the buffer while the sandbox is paused, and — the one
 * that actually matters here — a shape that **cannot** respond to the editor,
 * because the history was recorded under the old settings. Sampling a closed
 * form in the past has none of those: the trail is exact, it is full length on
 * the first frame, it costs nothing to keep, and dragging `orbTilt` with the
 * clock stopped re-sweeps the whole wake instantly.
 *
 * Two terms are then added *on top* of the true path, because a wake is not a
 * curve — it is gas that has been left behind and has had time to misbehave:
 *
 *   - **the rise.** `uRise` metres per second of age. Hot gas goes up, so the
 *     tail of the trail lifts off the path the orb took.
 *   - **the wander.** Noise growing with age, so the tail frays outward while
 *     the head stays welded to the ball.
 */
const TRAIL_VERTEX = /* glsl */ `
  #define PI 3.141592653589793

  uniform float uTime;
  uniform float uStrength;
  uniform float uSeed;

  uniform float uSpan;
  uniform float uRise;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;

  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uTaper;
  uniform float uHeadSwell;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vLane;
  varying float vViewZ;

  ${noiseGLSL}
  ${ORBIT_GLSL}

  /** A point on one trail. @param t 0 at the orb, 1 at the far end. */
  vec3 trailPoint(float t, float lane) {
    float age = clamp(t, 0.0, 1.0) * uSpan;
    vec3 p = orbitPoint(lane, uTime - age);

    // What the gas did after the orb left it.
    p.y += uRise * age;
    float y = age * uWanderScale - uTime * uWanderSpeed;
    float grow = uWander * age;
    p += uRight * snoise(vec3(lane * 4.1 + uSeed, y, 0.0)) * grow;
    p += uForward * snoise(vec3(lane * 4.1 + uSeed + 17.3, y, 3.7)) * grow;
    return p;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;
    vLane = aStrand;

    vec3 here = trailPoint(t, aStrand);

    float step_ = 0.02;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = trailPoint(ahead, aStrand);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);

    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : vec3(1.0, 0.0, 0.0);

    /* ---- width ---- */
    // Scaled by the orb's own size, so a bigger ball drags a fatter wake without
    // a second slider to keep in step. Swollen at the head so the trail leaves
    // the ball rather than being stuck to it with a seam.
    float taper = pow(1.0 - t, max(uTaper, 0.05));
    float swell = 1.0 + uHeadSwell * (1.0 - smoothstep(0.0, 0.25, t));
    float halfWidth = uWidth * uWidthScale * orbScale(aStrand) * taper * swell;
    halfWidth *= max(uStrength, 0.0);

    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The wake, shaded as a temperature that falls with **age** rather than with
 * position — which is the same thing here, because `vT` is literally how many
 * seconds ago the orb was at this point. White where it has just left the ball,
 * through flame, to smoke at the end.
 *
 * The tear is the flame material's, with one difference: the cut rises with age
 * as well as with the cross-ribbon coordinate, so a wake dissolves into
 * separate puffs behind the orb instead of thinning to a wire.
 */
const TRAIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;

  uniform float uSharp;
  uniform float uGlowFalloff;
  uniform float uTear;
  uniform float uTearScale;
  uniform float uTearSpeed;
  uniform float uTearBias;
  uniform float uHeat;
  uniform float uCoreSize;
  uniform float uCool;
  uniform float uEndFade;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;

  uniform vec3  uColorCore;
  uniform vec3  uColorFlame;
  uniform vec3  uColorEmber;
  uniform vec3  uColorSmoke;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vLane;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float v = clamp(abs(vSide), 0.0, 1.0);

    float field = fbm3(vec3(
      vT * uTearScale - uTime * uTearSpeed,
      v * 1.3,
      vLane * 6.7 + uSeed
    )) * 0.5 + 0.5;

    // Temperature falls with age, and the fall is sharpened by uCool so the
    // orb keeps a white-hot collar instead of fading out of one.
    float cooled = pow(1.0 - clamp(vT, 0.0, 1.0), max(uCool, 0.05));

    #ifdef TRAIL_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      float alpha = profile * cooled;
      vec3 color = mix(uColorEmber, uColorFlame, cooled);
    #else
      float profile = pow(1.0 - v, max(uSharp, 0.05));
      float cut = mix(uTearBias * 0.2, uTearBias, vT) * clamp(uTear, 0.0, 1.0);
      float burn = smoothstep(cut, cut + 0.25, field);

      float alpha = profile * burn;
      float heat = clamp(field * profile * cooled * uHeat, 0.0, 1.0);
      vec3 color = gradient4(uColorSmoke, uColorEmber, uColorFlame, uColorCore,
                             pow(heat, max(uCoreSize, 0.05)));
    #endif

    // Dissolved at the far end, so a trail has no visible cut.
    alpha *= 1.0 - smoothstep(1.0 - max(uEndFade, 1e-3), 1.0, vT);

    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + vLane * 3.9 + uSeed);
    alpha *= flicker * uStrength * uPassOpacity * uOpacity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of the trails.
 *
 * @param {number} pass TrailPass.*
 */
export function createOrbTrailMaterial(pass = TrailPass.FLAME) {
  const glow = pass === TrailPass.GLOW;

  const material = new ShaderMaterial({
    defines: glow
      ? { TRAIL_GLOW: '', ORB_BONES: MAX_FLAME_BONES }
      : { ORB_BONES: MAX_FLAME_BONES },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...orbitUniforms(),
      uSeed: { value: 0 },
      uStrength: { value: 0 },

      uSpan: { value: 0.9 },
      uRise: { value: 0.35 },
      uWander: { value: 0.22 },
      uWanderScale: { value: 2.4 },
      uWanderSpeed: { value: 0.8 },

      uWidth: { value: 1.35 },
      uWidthScale: { value: glow ? 2.8 : 1 },
      uTaper: { value: 0.85 },
      uHeadSwell: { value: 0.45 },

      uSharp: { value: 1.4 },
      uGlowFalloff: { value: 2.2 },
      uTear: { value: 0.8 },
      uTearScale: { value: 3.2 },
      uTearSpeed: { value: 0.9 },
      uTearBias: { value: 0.6 },
      uHeat: { value: 1.5 },
      uCoreSize: { value: 0.75 },
      uCool: { value: 1.3 },
      uEndFade: { value: 0.25 },
      uFlicker: { value: 0.14 },
      uFlickerSpeed: { value: 14 },
      uPassOpacity: { value: glow ? 0.32 : 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.4 },
      uSoftFade: { value: 0.35 },

      uColorCore: { value: new Color(1, 0.96, 0.84) },
      uColorFlame: { value: new Color(1, 0.55, 0.12) },
      uColorEmber: { value: new Color(0.8, 0.17, 0.02) },
      uColorSmoke: { value: new Color(0.08, 0.03, 0.02) }
    }),
    vertexShader: TRAIL_VERTEX,
    fragmentShader: TRAIL_FRAGMENT
  });

  /**
   * @param {object} state
   *   { base, right, forward, height, strength, seed, boneA, boneB, boneCount }
   */
  material.userData.sync = (state) => {
    const c = settings.fire;
    const g = settings.global;
    const u = material.uniforms;

    syncOrbit(u, state);
    u.uStrength.value = state.strength;
    u.uSeed.value = state.seed;

    u.uSpan.value = c.trailSpan;
    u.uRise.value = c.trailRise;
    u.uWander.value = c.trailWander * g.noiseStrength;
    u.uWanderScale.value = c.trailWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.trailWanderSpeed * g.noiseSpeed;

    u.uWidth.value = c.trailWidth;
    u.uWidthScale.value = glow ? c.trailGlowWidth : 1;
    u.uTaper.value = c.trailTaper;
    u.uHeadSwell.value = c.trailHeadSwell;

    u.uSharp.value = c.trailSharp;
    u.uGlowFalloff.value = c.trailGlowFalloff;
    u.uTear.value = c.trailTear;
    u.uTearScale.value = c.trailTearScale * g.noiseFrequency;
    u.uTearSpeed.value = c.trailTearSpeed * g.noiseSpeed;
    u.uTearBias.value = c.trailTearBias;
    u.uHeat.value = c.trailHeat * g.shaderIntensity;
    u.uCoreSize.value = c.trailCoreSize;
    u.uCool.value = c.trailCool;
    u.uEndFade.value = c.trailEndFade;
    u.uFlicker.value = c.trailFlicker;
    u.uFlickerSpeed.value = c.trailFlickerSpeed;
    u.uPassOpacity.value = glow ? c.trailGlowOpacity : 1;
    u.uOpacity.value = c.trailOpacity * g.opacity;
    u.uGlow.value = c.trailGlow;
    u.uSoftFade.value = c.trailSoftFade;

    u.uColorCore.value.copy(getColor(c.colorTrailCore));
    u.uColorFlame.value.copy(getColor(c.colorTrailFlame));
    u.uColorEmber.value.copy(getColor(c.colorTrailEmber));
    u.uColorSmoke.value.copy(getColor(c.colorTrailSmoke));
  };

  return material;
}
