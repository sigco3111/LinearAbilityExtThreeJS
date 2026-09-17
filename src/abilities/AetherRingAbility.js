import {
  InstancedMesh,
  Mesh,
  Object3D,
  Vector3,
  Matrix4,
  Quaternion,
  Euler,
  PlaneGeometry,
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  DoubleSide,
  Color
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createRockMaterial } from '../materials/RockMaterial.js';
import { createBlockGeometry } from '../assets/ProceduralGeometry.js';
import { RING_SDF } from '../effects/RingIndicator.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

/** Hard cap on the segments of the ring. The courses clamp to this. */
const MAX_SEGMENTS = 220;
/** The two block shapes the ring is forged out of. */
const SEGMENT_SEEDS = [61, 97];
const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _local = new Vector3();
const _slot = new Vector3();
const _tangent = new Vector3();
const _normal = new Vector3();
const _xAxis = new Vector3();
const _yAxis = new Vector3();
const _zAxis = new Vector3();
const _scale = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _basis = new Matrix4();
/** Where an instance goes when it is not standing: under the floor, at zero. */
const HIDDEN_MATRIX = new Matrix4().makeScale(0.0001, 0.0001, 0.0001).setPosition(0, -999, 0);
const _quat = new Quaternion();
const _spinQuat = new Quaternion();
const _euler = new Euler();
const _tint = new Color();

/**
 * The event horizon, the halo, and the rune band, in one fragment shader.
 *
 * Like the gate's surface this is not geometry — it is `ringDistance` evaluated
 * on a plain quad in metres — but what it draws is the opposite reading. The
 * gate is a doorway lit from its frame inward, brightest where it meets the
 * stone and hazy in the middle. A rift is a *hole*: the light lives at the rim
 * and dies toward the eye, and the eye is the darkest thing on screen. Every
 * term below is chosen to protect that gradient, because the moment the middle
 * lights up the whole thing reads as a plate instead of a depth.
 *
 * `uSurface` picks which half of the effect is being drawn: 0 is the pool
 * inside the contour, 1 is the halo spilling onto the segments *and* the band
 * of runes they carry. The halo has to be additive (it is light falling on
 * stone); the pool must not be, because it owns its own transparency — solid at
 * the rim, and thinning toward the eye you can very nearly see through.
 */
const RIFT_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIFT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;    // metres across the quad
  uniform float uRadius;      // the clear radius, metres
  uniform float uLobes;
  uniform float uLobeDepth;
  uniform float uIris;        // 0..1 how far the pool has filled outward
  uniform float uChurn;       // how hard that filling edge boils
  uniform float uSpin;        // turns/second the pool shears
  uniform float uTwist;       // how much harder the middle turns than the rim
  uniform float uTurbulence;
  uniform float uNoiseScale;
  uniform float uFlow;
  uniform float uRipples;     // rings across the radius
  uniform float uRippleSpeed; // how fast they run inward
  uniform float uRippleDepth;
  uniform float uRim;         // the light that hugs the segments
  uniform float uRimWidth;    // how far into the pool it reaches, metres
  uniform float uRimFalloff;
  uniform float uRimHot;      // the white lip right against the stone
  uniform float uEye;         // the dark at the middle — the way through
  uniform float uEyeSize;     // its radius, × the clear radius
  uniform float uEyeClear;    // how much of the scene behind shows through it
  uniform float uSparkle;     // motes caught in the pool
  uniform float uSparkleScale;
  uniform float uHalo;
  uniform float uHaloWidth;
  uniform float uRunes;       // the band of marks on the segments
  uniform float uRuneCount;   // marks per half of the contour
  uniform float uRuneRadius;  // how far outside the contour the band sits, m
  uniform float uRuneWidth;
  uniform float uRuneGap;
  uniform float uLock;        // 0..1 how much of that band has locked
  uniform float uIgnite;      // 0..1 spike the moment the rift lights
  uniform float uSurface;     // 0 = the pool, 1 = the halo and the runes
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorMid;
  uniform vec3  uColorDeep;
  uniform vec3  uColorRim;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${RING_SDF}

  #define TAU 6.28318530718

  /**
   * Motes hanging in the pool.
   *
   * A jittered point per cell of a rotating grid, most cells empty, each one
   * twinkling on its own clock. Cheap, and it is the single detail that stops
   * a vortex from reading as a gradient: something has to be *in* the water for
   * the eye to believe there is water.
   */
  float motes(vec2 q, float scale, float time) {
    vec2 g = q * scale;
    vec2 cell = floor(g);
    float h = hash13(vec3(cell, 3.0));
    if (h < 0.86) return 0.0;
    vec2 jitter = (vec2(hash11(h * 11.3), hash11(h * 27.1)) - 0.5) * 0.7;
    float spot = smoothstep(0.16, 0.0, length(fract(g) - 0.5 - jitter));
    return spot * (0.45 + 0.55 * sin(time * (2.0 + h * 7.0) + h * 60.0));
  }

  void main() {
    /* ---- uv → metres, measured from the middle of the ring ---- */
    vec2 p = (vUv - 0.5) * uQuadSize;
    float rr = max(0.1, uRadius);
    float d = ringDistance(p, rr, uLobes, uLobeDepth);
    float r = length(p);
    float aa = fwidth(d) + 0.012;
    float inside = smoothstep(-aa, aa, d);

    /* ---- the halo, and the runes the segments carry ---- */
    if (uSurface > 0.5) {
      float beyond = max(-d, 0.0);
      // The spill only exists once there is something in the ring to spill.
      float glow = exp(-beyond / max(0.03, uHaloWidth)) * uHalo * uIris * (1.0 - inside);

      // The band lights from the foot of the ring outward in both directions,
      // one mark per segment, keeping step with the stone as it lands — which
      // is the whole reason the assembly is legible while it is lying down.
      float contour = abs(ringContour(p));
      float index = floor(contour * max(1.0, uRuneCount));
      float cell = fract(contour * max(1.0, uRuneCount));
      float mark = 1.0 - smoothstep(uRuneGap, uRuneGap + 0.1, abs(cell - 0.5));
      float band = (1.0 - smoothstep(uRuneWidth, uRuneWidth + 0.03, abs(beyond - uRuneRadius)))
                 * step(0.0, -d);
      float lit = smoothstep(uLock + 0.04, uLock - 0.02, contour);
      float flicker = 0.72 + 0.28 * sin(uTime * (3.0 + hash11(index * 1.7) * 6.0) + index * 2.3);
      float runes = band * mark * lit * flicker * uRunes;

      float alpha = clamp(glow + runes, 0.0, 1.0) * uOpacity;
      if (alpha < 0.004) discard;

      vec3 color = mix(uColorRim, uColorMid, 0.35) * glow * (1.0 + uIgnite * 2.0)
                 + mix(uColorCore, uColorRim, 0.35) * runes;
      gl_FragColor = vec4(color * uGlobalGlow * uOpacity, alpha);
      return;
    }

    if (inside < 0.004) discard;

    /* ---- the iris: the pool fills outward, and it boils while it does ---- */
    // Not a disc growing behind a mask. The boundary is eaten into by noise, so
    // the pool arrives as something *poured* — and at full aperture that same
    // noise is the roiling fringe where the water meets the stone.
    float rn = r / rr;
    float churn = fbm3(vec3(p * uNoiseScale * 0.85, uTime * uFlow * 1.6));
    float edge = uIris * (1.0 + uChurn * churn);
    float pool = smoothstep(edge + 0.09, edge - 0.09, rn) * inside;
    if (pool < 0.004) discard;

    /* ---- the water ---- */
    // Sheared about the middle rather than spiralled into it: differential
    // rotation is what makes a surface read as turning, and the shear is
    // strongest at the eye, which is where the depth has to come from.
    float rot = uTime * uSpin * TAU + uTwist / max(rn, 0.2);
    float cs = cos(rot);
    float sn = sin(rot);
    vec2 q = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);

    float n1 = fbm3(vec3(q * uNoiseScale, uTime * uFlow));
    float n2 = fbm3(vec3(q * uNoiseScale * 2.3 + n1 * 1.5, uTime * uFlow * 1.4 + 9.0));
    float cloud = clamp(0.5 + (n1 * 0.6 + n2 * 0.7) * uTurbulence, 0.0, 1.0);

    // Rings running *inward*. A vortex that only rotates reads as a spinning
    // texture; something has to be falling into it.
    float ripple = 0.5 + 0.5 * sin((rn * uRipples - uTime * uRippleSpeed) * TAU);
    cloud = mix(cloud, cloud * (0.5 + 0.5 * ripple), uRippleDepth);

    /* ---- where the light sits: at the rim, never in the middle ---- */
    float rim = pow(clamp(1.0 - d / max(0.05, uRimWidth), 0.0, 1.0), uRimFalloff);
    float eye = min(1.0, pow(clamp(1.0 - rn / max(0.05, uEyeSize), 0.0, 1.0), 1.7) * uEye);

    vec3 color = mix(uColorDeep, uColorMid, cloud * (0.3 + 0.7 * pow(rn, 1.3)));
    color = mix(color, uColorRim, clamp(rim * uRim, 0.0, 1.0));
    // The one part of the pool allowed to blow out: the lip against the stone.
    color += uColorCore * pow(rim, 5.0) * uRimHot;
    color += uColorCore * motes(q, uSparkleScale, uTime) * uSparkle * (0.35 + 0.65 * rn);
    // And then the eye swallows all of it.
    color = mix(color, uColorDeep * 0.18, eye);
    color *= 1.0 + uIgnite * 2.4;

    // Solid where it meets the stone, thin over the eye — the way through is
    // the middle, which is the exact inverse of how the gate opens.
    float alpha = pool * uOpacity * mix(0.55 + 0.45 * cloud, 1.0, rim) * (1.0 - eye * uEyeClear);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * TIDEWROUGHT RING — the second cast that **builds**, and the first that is
 * assembled somewhere other than where it ends up.
 *
 * The Verdant Gate is masonry: stones come up out of the floor and stack into
 * an arch that was always going to stand exactly there. This is a *machine*,
 * and it arrives the way a machine is made — laid out flat, closed, and then
 * stood up. Four beats:
 *
 *   1. a tide of light runs along the aimed line to the site, which is the base
 *      class's travelling front doing its usual job;
 *   2. the ring is **forged lying down**: segments swing in out of a wide orbit
 *      in the ground plane, spiralling inward against the ring's own rotation
 *      and locking from the foot upward, both arcs closing together on the
 *      crown, with the runes lighting behind them one segment at a time;
 *   3. the finished ring **stands up** — it hinges off the floor about its own
 *      lateral axis, lifting clear of the ground and settling past vertical
 *      with a wobble, still turning down out of the spin it was closed with;
 *   4. the horizon **irises open** from the middle out, slams into the rim, and
 *      **stays lit** until another ring is raised (`AbilityManager` dismisses
 *      the standing one) or the sandbox is cleared.
 *
 * Nothing about the pose is stored. A segment holds where it sits along the
 * contour as a signed 0..1 — which arc, and how far up toward the crown — its
 * course, and its dice; the angle, radius, spin and the entire tip-up are
 * resolved against `settings.aether` every frame, from three ages. Drag the
 * radius of a ring that has been standing for a minute and it re-forges itself
 * around the new circle while the clock is paused; drag `stand up over` and it
 * re-poses mid-hinge. That is the same rule the rest of the project runs on,
 * and this is the cast that leans on it hardest, because *every* frame of the
 * animation is a function rather than a keyframe.
 */
export class AetherRingAbility extends Ability {
  constructor(context) {
    super('aether', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* --- the segments of the ring --- */
    // The same quarried blocks the gate is stacked out of, in two shapes so no
    // two neighbours share a silhouette — but shaded as a *forging* rather than
    // as masonry: no moss, and the material's hot seam is turned all the way up
    // rather than held at zero. On the arch that seam read as circuitry cut
    // into the rock, which was wrong for a doorway somebody built out of a
    // quarry. On a ring that came out of a mould it is exactly right, and it is
    // where the light along the segments comes from.
    this.segmentMaterial = createRockMaterial(environment, 0);
    this.segmentGeometries = SEGMENT_SEEDS.map((seed, i) =>
      createBlockGeometry(seed, 0.16 + i * 0.04, 0.05 + i * 0.02)
    );
    this.segmentMeshes = this.segmentGeometries.map((geometry, i) => {
      const mesh = new InstancedMesh(geometry, this.segmentMaterial, MAX_SEGMENTS);
      mesh.name = `RingSegments:${i}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.layers.set(LAYER.WORLD);
      this.group.add(mesh);
      return mesh;
    });

    /* --- the horizon, and the halo and runes around it --- */
    // Centred unit quad in XY: a ring has no bottom edge to stand on, so unlike
    // the gate's surface this one is placed by its middle and oriented from the
    // ring's own basis.
    this.surfaceGeometry = new PlaneGeometry(1, 1, 1, 1);

    this.surfaceMaterial = this._createSurfaceMaterial(false);
    this.surface = new Mesh(this.surfaceGeometry, this.surfaceMaterial);
    this.surface.name = 'RiftHorizon';
    this.surface.layers.set(LAYER.VFX);
    this.surface.renderOrder = 3;
    this.surface.frustumCulled = false;
    this.surface.visible = false;
    this.group.add(this.surface);

    this.haloMaterial = this._createSurfaceMaterial(true);
    this.halo = new Mesh(this.surfaceGeometry, this.haloMaterial);
    this.halo.name = 'RiftHalo';
    this.halo.layers.set(LAYER.VFX);
    this.halo.renderOrder = 4;
    this.halo.frustumCulled = false;
    this.halo.visible = false;
    this.group.add(this.halo);

    /**
     * Fixed-size record pool — no allocation while casting.
     *
     * `contour` is the whole layout: its sign is which arc, its magnitude is
     * how far round from the foot of the ring toward the crown, 1 being the
     * crown segment itself. `course` is how many segment-widths outward from
     * the clear radius it is stacked, and is deliberately allowed to be
     * fractional so the spurs braced under the ring are the same record with a
     * looser number in it.
     */
    this.segmentRecords = [];
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      this.segmentRecords.push({
        active: false,
        landed: false,
        crown: false,
        variant: i % SEGMENT_SEEDS.length,
        contour: 0,
        course: 0,
        delay: 0,
        depthJitter: 0,
        sizeJitter: new Vector3(1, 1, 1),
        tiltJitter: new Vector3(),
        spinAxis: new Vector3(0, 1, 0),
        spinAmount: 0,
        swirl: 1,
        swarmJitter: 1,
        swarmSide: 1
      });
    }

    /* --- the ring's own frame, rebuilt every frame --- */
    this._centre = new Vector3();
    this._ringX = new Vector3(1, 0, 0);
    this._ringY = new Vector3(0, 1, 0);
    this._ringN = new Vector3(0, 0, 1);

    this._segmentCount = 0;
    /** How far along the line the last tide mark was left. */
    this._tideDistance = 0;
    /** Seconds since the first segment was called in. */
    this._buildAge = -1;
    /** Seconds since the horizon lit. Negative until it does. */
    this._riftAge = -1;
    /** Seconds since the ring was asked to come apart. Negative until it is. */
    this._closeAge = -1;
    this._ignite = 0;
  }

  /** @param {boolean} halo which half of the effect this material draws */
  _createSurfaceMaterial(halo) {
    return new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: halo ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: {
        uTime: frame.uTime,
        uGlobalGlow: frame.uGlobalGlow,
        uQuadSize: { value: 6 },
        uRadius: { value: 2 },
        uLobes: { value: 6 },
        uLobeDepth: { value: 0.035 },
        uIris: { value: 0 },
        uChurn: { value: 0.22 },
        uSpin: { value: 0.1 },
        uTwist: { value: 1.4 },
        uTurbulence: { value: 0.9 },
        uNoiseScale: { value: 1.5 },
        uFlow: { value: 0.3 },
        uRipples: { value: 3.5 },
        uRippleSpeed: { value: 0.5 },
        uRippleDepth: { value: 0.45 },
        uRim: { value: 1.0 },
        uRimWidth: { value: 0.8 },
        uRimFalloff: { value: 2.0 },
        uRimHot: { value: 1.1 },
        uEye: { value: 0.9 },
        uEyeSize: { value: 0.45 },
        uEyeClear: { value: 0.55 },
        uSparkle: { value: 0.9 },
        uSparkleScale: { value: 2.6 },
        uHalo: { value: 1.0 },
        uHaloWidth: { value: 0.5 },
        uRunes: { value: 1.0 },
        uRuneCount: { value: 11 },
        uRuneRadius: { value: 0.3 },
        uRuneWidth: { value: 0.08 },
        uRuneGap: { value: 0.3 },
        uLock: { value: 0 },
        uIgnite: { value: 0 },
        uSurface: { value: halo ? 1 : 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.9, 1, 1) },
        uColorMid: { value: new Color(0.2, 0.83, 1) },
        uColorDeep: { value: new Color(0.02, 0.09, 0.2) },
        uColorRim: { value: new Color(0.55, 0.96, 1) }
      },
      vertexShader: RIFT_VERTEX,
      fragmentShader: RIFT_FRAGMENT
    });
  }

  createParticles() {
    const particles = this.ctx.particles;

    /* --- what the rift pulls in --- */
    // The gate throws motes upward and lets them go. This one takes them: they
    // are born on the rim and thrown *at* the middle, and the drag is low
    // enough that they get there. Nothing about a particle system can attract,
    // but a mote aimed at the eye and dying just short of it reads as drawn.
    this.motes = particles.get('aether.motes', {
      capacity: 2600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.motes.uniforms.uGravity.value.set(0, 0, 0);
    this.motes.uniforms.uDrag.value = 0.35;
    this.motes.uniforms.uEndSize.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.12;
    this.motes.uniforms.uFadeOut.value = 0.75;
    this.motes.uniforms.uTurbFrequency.value = 1.1;

    /* --- and what it breathes back out --- */
    this.spray = particles.get('aether.spray', {
      capacity: 2000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.35
    });
    this.spray.uniforms.uGravity.value.set(0, -1.2, 0);
    this.spray.uniforms.uDrag.value = 1.1;
    this.spray.uniforms.uEndSize.value = 0.2;
    this.spray.uniforms.uFadeOut.value = 0.55;

    /* --- the cold that falls out of the bottom of it --- */
    // Positive drag, real gravity: the gate's haze rises through the opening,
    // this one pours out of the underside and pools on the floor.
    this.mist = particles.get('aether.mist', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.mist.uniforms.uGravity.value.set(0, -0.9, 0);
    this.mist.uniforms.uDrag.value = 2.4;
    this.mist.uniforms.uEndSize.value = 3.0;
    this.mist.uniforms.uFadeIn.value = 0.3;
    this.mist.uniforms.uFadeOut.value = 0.45;

    /* --- what the forging throws --- */
    this.debris = particles.get('aether.debris', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.debris.uniforms.uGravity.value.set(0, -12.0, 0);
    this.debris.uniforms.uDrag.value = 0.3;
    this.debris.uniforms.uEndSize.value = 0.9;
    this.debris.uniforms.uFadeOut.value = 0.7;

    this.moteEmitter = new RateEmitter();
    this.sprayEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
    this.tideEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._segmentCount;
  }

  /** A standing ring has no impact phase to run out of. @see PortalAbility */
  get impactDuration() {
    return Infinity;
  }

  /** How long the break-up takes, once something has asked for one. */
  get fadeDuration() {
    return Math.max(0.2, settings.aether.closeTime);
  }

  get isPersistent() {
    return true;
  }

  /** The camera watches the ring being forged and stood up, then hands back. */
  get wantsCamera() {
    if (!this.isActive) return false;
    if (this._closeAge >= 0) return false;
    return this._riftAge < 0 || this._riftAge < settings.aether.openTime + 0.7;
  }

  /**
   * Seconds from the first segment to the last one seating.
   *
   * Every later beat is measured off the end of this, so the whole sequence
   * re-times itself when either half of it is dragged.
   */
  _assembleSpan(c) {
    // The crown is issued a beat after its arc (see `_layRing`) and each course
    // lags the one inside it, so the honest end of the forging is the last
    // delay plus one flight — not simply the assembly time.
    const courseLag = (Math.max(1, Math.round(c.courses)) - 1) * 0.06;
    return Math.max(0.1, c.assembleTime) + 0.05 + courseLag + Math.max(0.05, c.segmentFly);
  }

  /** 0..1 through the tip-up, from flat on the sigil to standing. */
  _riseProgress(c) {
    if (this._buildAge < 0) return 0;
    const start = this._assembleSpan(c) + Math.max(0, c.riseDelay);
    return saturate((this._buildAge - start) / Math.max(0.05, c.riseTime));
  }

  /** 0..1 how much of the rune band has locked behind the segments. */
  _lockProgress(c) {
    if (this._buildAge < 0) return 0;
    // Offset by one flight: a segment at |contour| = x lands at
    // `x * assembleTime + segmentFly`, and the mark behind it is supposed to
    // light when the stone arrives, not when it was called.
    return saturate((this._buildAge - Math.max(0.05, c.segmentFly)) / Math.max(0.05, c.assembleTime));
  }

  /**
   * The turn the ring is closed with, radians.
   *
   * Analytic rather than integrated, so it survives being scrubbed: the spin-up
   * is a fixed number of turns eased off over the assembly, and what is left
   * afterwards is a slow constant idle. Drag `closing turns` on a ring that has
   * been standing for a minute and it re-poses on the spot.
   */
  _spinAngle(c) {
    if (this._buildAge < 0) return 0;
    const closing = Easing.outCubic(saturate(this._buildAge / this._assembleSpan(c)));
    return TAU * (c.spinTurns * closing + c.idleSpin * this._buildAge);
  }

  /**
   * The light is the horizon's, so it does not exist before the horizon does.
   * Through the travel, the forging and the tip-up this is the faintest
   * glimmer off the runes, and it only comes up as the pool floods.
   */
  lightShimmer() {
    const c = settings.aether;
    if (this._riftAge < 0) return 0.04 + 0.06 * this._lockProgress(c);

    const open = saturate(this._riftAge / Math.max(0.05, c.openTime));
    // Keyed off the same ripple rate as the surface, so the light in the room
    // breathes with the rings running into the eye rather than against them.
    const swell =
      1 - c.lightFlicker * (0.5 + 0.5 * Math.sin(this.age * c.rippleSpeed * TAU * 0.5));
    const closing = this._closeAge >= 0 ? 1 - saturate(this._closeAge / (this.fadeDuration * 0.4)) : 1;
    return open * swell * closing;
  }

  onSpawn() {
    this.moteEmitter.reset();
    this.sprayEmitter.reset();
    this.mistEmitter.reset();
    this.tideEmitter.reset();

    for (const record of this.segmentRecords) record.active = false;
    for (const mesh of this.segmentMeshes) mesh.count = 0;
    this._segmentCount = 0;
    this._buildAge = -1;
    this._riftAge = -1;
    this._closeAge = -1;
    this._tideDistance = 0;
    this._ignite = 0;
    this.surface.visible = false;
    this.halo.visible = false;

    const c = settings.aether;
    const g = settings.global;
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);

    // The spray thrown off the hand as the tide is let go.
    _emit.position = this._handPoint(_pos);
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction).setY(0.28).normalize();
    _emit.speed = 7.5;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.5;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.spraySize * 1.2;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sprayLife * 0.5;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spray.emit(Math.round(30 * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* The ring: its frame, and where a segment belongs in it              */
  /* ------------------------------------------------------------------ */

  /**
   * Where the cast leaves the caster, in world space.
   *
   * The same anchor every other ability carries.
   */
  _handPoint(out) {
    const c = settings.aether;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /**
   * Rebuild the ring's own frame for this instant.
   *
   * This is the whole tip-up, and it is four lines: the pitch hinges the ring's
   * up-axis toward the caster's heading, the centre lifts by the same
   * progress, and the in-plane axes are then turned by whatever the ring is
   * spinning at. Because every one of those is read out of the settings and the
   * ages, the animation has no state — pausing halfway up and dragging
   * `stand up over` moves the ring on the spot.
   *
   *   pitch = 0     → standing: the plane holds `side` and `up`, facing along
   *                   the heading, which is the pose the indicator promised
   *   pitch = -90°  → flat: the plane holds `side` and the heading, lying on
   *                   the floor exactly where the sigil was drawn
   */
  _updateFrame() {
    const c = settings.aether;
    const radius = Math.max(0.3, c.ringRadius);
    // `outBack` overshoots, so the ring goes a few degrees past upright and
    // rocks back — the settle that says the thing has mass.
    const rise = this._buildAge < 0 ? 0 : Easing.outBack(this._riseProgress(c));
    const pitch = -HALF_PI * (1 - rise);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    // Hinged about the ring's own lateral axis: the hinge stays put and the
    // other two axes swing round it.
    _yAxis.copy(_up).multiplyScalar(cosP).addScaledVector(this.direction, sinP);
    _zAxis.copy(this.direction).multiplyScalar(cosP).addScaledVector(_up, -sinP);
    // Crossed rather than taken from `side`, which points the other way: a
    // left-handed basis would mirror every segment and every quad hung in it.
    _xAxis.crossVectors(_yAxis, _zAxis);

    const spin = this._spinAngle(c);
    const cosS = Math.cos(spin);
    const sinS = Math.sin(spin);
    // The whole frame turns, so the segments, the runes and the pool are all
    // carried round together by construction and can never drift apart.
    this._ringX.copy(_xAxis).multiplyScalar(cosS).addScaledVector(_yAxis, sinS);
    this._ringY.copy(_yAxis).multiplyScalar(cosS).addScaledVector(_xAxis, -sinS);
    this._ringN.copy(_zAxis);

    const clear = radius * (1 + c.lobeDepth) + Math.max(0, c.ringHover);
    this._centre
      .copy(this.origin)
      .addScaledVector(this.direction, this.length)
      .setY(lerp(c.layHeight, clear, rise));
  }

  /** Signed 0..1 along the contour → the angle it sits at, radians. */
  _contourAngle(contour) {
    return -HALF_PI + contour * Math.PI;
  }

  /** The lobed clear radius at one angle, metres. */
  _radiusAt(c, angle) {
    return Math.max(0.3, c.ringRadius) * (1 + c.lobeDepth * Math.cos(angle * Math.round(c.lobes)));
  }

  /**
   * Resolve a contour parameter into the ring's own plane.
   *
   * `out` comes back as (across, up, through the ring) in metres, and
   * `_tangent` / `_normal` as the frame at that point — along the contour, and
   * outward from the opening. Everything is derived from the live settings, so
   * this is what makes a standing ring re-forge itself when the radius is
   * dragged.
   *
   * @param {number} contour signed 0..1 — sign is the arc, magnitude is how far
   *   round from the foot of the ring toward the crown
   * @param {number} course  how far outward from the opening, in courses
   */
  _segmentFrame(contour, course, c, out) {
    const angle = this._contourAngle(contour);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Stand the segment off the opening so the ring frames it rather than
    // covering it, then stack the courses outward from there.
    const radius =
      this._radiusAt(c, angle) + c.segmentSize * 0.45 + course * Math.max(0.05, c.courseStep);

    out.set(cos * radius, sin * radius, 0);
    _tangent.set(-sin, cos, 0);
    _normal.set(cos, sin, 0);
    return out;
  }

  /** Ring-local (x across, y up the plane, z through it) → world. */
  _toWorld(local, out) {
    return out
      .copy(this._centre)
      .addScaledVector(this._ringX, local.x)
      .addScaledVector(this._ringY, local.y)
      .addScaledVector(this._ringN, local.z);
  }

  _spawnSegment(contour, course, delay) {
    if (this._segmentCount >= MAX_SEGMENTS) return;
    const record = this.segmentRecords[this._segmentCount++];
    const randomness = settings.aether.segmentRandomness * settings.global.randomness;

    record.active = true;
    record.landed = false;
    record.crown = Math.abs(contour) >= 0.999;
    record.contour = contour;
    record.course = course;
    record.delay = delay;
    record.depthJitter = randRange(-1, 1);
    record.sizeJitter.set(
      1 + randRange(-0.14, 0.22) * randomness,
      1 + randRange(-0.2, 0.16) * randomness,
      1 + randRange(-0.18, 0.3) * randomness
    );
    record.tiltJitter.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1));
    record.spinAxis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize();
    record.spinAmount = randRange(-1, 1);
    // Which way round the segment swings in, and how wide it comes from.
    record.swirl = randRange(0.6, 1.4) * (contour < 0 ? -1 : 1);
    record.swarmJitter = randRange(0.75, 1.35);
    // Signed in the ring's own plane, but never negative: while the ring is
    // being forged that plane is the floor, and a segment that starts below it
    // spends its swing underground.
    record.swarmSide = randRange(0.25, 1);
  }

  /**
   * Lay the whole ring out.
   *
   * The count is chosen here, once, from the spacing — the *positions* are not,
   * and are re-derived every frame. Both arcs are walked from the foot of the
   * ring upward so that a segment's delay is simply how far round the contour
   * it sits, which is what makes the two sides close together and the crown
   * seat last. It is the arch's own rhythm, bent into a circle.
   */
  _layRing() {
    const c = settings.aether;
    this._segmentCount = 0;
    for (const record of this.segmentRecords) record.active = false;

    const courses = Math.max(1, Math.round(c.courses));
    const halfLength = Math.PI * Math.max(0.3, c.ringRadius);
    const perSide = Math.max(3, Math.round(halfLength / Math.max(0.12, c.segmentStep)));

    for (let course = 0; course < courses; course++) {
      // Outer courses lag, so the ring reads as being built up in layers rather
      // than as one hoop snapping together.
      const courseLag = course * 0.06;
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < perSide; i++) {
          const contour = ((i + 0.5) / perSide) * side;
          this._spawnSegment(contour, course, Math.abs(contour) * c.assembleTime + courseLag);
        }
      }
      // The crown, on the centreline, last of its course.
      this._spawnSegment(1, course, c.assembleTime + courseLag + 0.05);
    }

    /* --- the spurs braced under the ring --- */
    // Same record, looser numbers: a fractional course past the outermost one
    // puts a block outside the hoop, and a small contour keeps it near the
    // foot. Off by default — a closed hoop reads better hanging clear of the
    // floor than propped on rubble — but the slider is here for a ring that
    // wants to look bolted down.
    const spurs = Math.min(MAX_SEGMENTS - this._segmentCount, Math.max(0, Math.round(c.spurs)));
    for (let i = 0; i < spurs; i++) {
      const contour = randRange(0.03, 0.26) * (i % 2 === 0 ? 1 : -1);
      this._spawnSegment(contour, courses - 1 + randRange(0.5, 1.7), randRange(0, 0.3));
    }
  }

  /* ------------------------------------------------------------------ */
  /* The forging                                                         */
  /* ------------------------------------------------------------------ */

  /** Chips, a spark of light and a knock when one segment locks in. */
  _lockFx(position, crown) {
    const c = settings.aether;
    const g = settings.global;
    const time = frame.uTime.value;

    _emit.position = _pos.copy(position);
    _emit.radius = c.segmentSize * 0.4;
    _emit.direction = _dir.copy(this._ringN);
    _emit.speed = c.debrisVelocity * (crown ? 1.5 : 0.6);
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.debrisSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.debrisLifetime * 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = time;
    this.debris.emit(Math.round((crown ? 24 : 4) * g.particleCount), _emit);

    // The lock itself is light, not dust: a machine seating a part.
    _emit.speed = crown ? 6.5 : 3.0;
    _emit.spread = 0.85;
    _emit.size = c.spraySize;
    _emit.sizeVariance = 0.6;
    _emit.life = c.sprayLife * 0.45;
    _emit.spin = 0;
    this.spray.emit(Math.round((crown ? 40 : 6) * g.particleCount), _emit);

    this.ctx.shake.add(
      (crown ? c.crownShake : c.lockShake) * c.shakeIntensity * g.explosionIntensity,
      crown ? 1.5 : 5.0,
      crown ? 14 : 24
    );
    if (crown) this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /** Collapse slot `i` in every segment mesh — nothing is standing there. */
  _hideSegment(index) {
    for (const mesh of this.segmentMeshes) mesh.setMatrixAt(index, HIDDEN_MATRIX);
  }

  /**
   * Place every segment for this frame.
   *
   * A segment is one of three things at any moment: still out of play (before
   * its delay), swinging in (a spiral from a wide orbit down into its slot,
   * interpolated in *polar* coordinates so the path curves round the ring
   * instead of cutting across it), or locked. The break-up rides on top of all
   * three as an outward fling, so a ring can be dismissed mid-forge and the
   * half-closed hoop still comes apart properly.
   */
  _updateSegments(dt) {
    const c = settings.aether;
    const g = settings.global;
    const fly = Math.max(0.05, c.segmentFly);
    const closing = this._closeAge >= 0;
    const closeSpan = Math.max(0.2, c.closeTime);

    // Nothing has been called in yet: draw no instances at all rather than a
    // couple of hundred collapsed ones.
    if (this._buildAge < 0) {
      for (const mesh of this.segmentMeshes) mesh.count = 0;
      return;
    }

    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const record = this.segmentRecords[i];
      const age = this._buildAge - record.delay;

      if (!record.active || age < 0) {
        this._hideSegment(i);
        continue;
      }

      /* --- the slot, resolved from the live settings --- */
      this._segmentFrame(record.contour, record.course, c, _local);
      const slotAngle = Math.atan2(_local.y, _local.x);
      const slotRadius = Math.hypot(_local.x, _local.y);
      const slotDepth = record.depthJitter * Math.max(0, c.ringDepth * 0.5 - c.segmentSize * 0.3);
      _local.z = slotDepth;
      this._toWorld(_local, _slot);

      /* --- the swing in --- */
      // Interpolated as (angle, radius) rather than as two points: a segment
      // that lerps between endpoints slides across the middle of the ring, and
      // a segment that lerps in polar *orbits* into place. The angle and the
      // radius are eased differently on purpose — the piece swings most of the
      // way round while it is still far out, and only then falls inward.
      const t = saturate(age / fly);
      const swing = Easing.outQuad(t);
      const fall = Easing.inOutCubic(t);

      const angle = slotAngle + record.swirl * c.swarmTurns * TAU * (1 - swing);
      const radius = lerp(slotRadius * Math.max(1, c.swarmRadius) * record.swarmJitter, slotRadius, fall);
      const depth = lerp(record.swarmSide * c.swarmDepth, slotDepth, fall);

      _local.set(Math.cos(angle) * radius, Math.sin(angle) * radius, depth);
      this._toWorld(_local, _dummy.position);

      if (t >= 1 && !record.landed) {
        record.landed = true;
        this._lockFx(_slot, record.crown);
      }

      /* --- the frame at the slot, plus the tumble it settles out of --- */
      // The segment's own X runs along the contour and its Y points out of the
      // ring, which seats a block as a voussoir rather than as a bead. The
      // third axis is crossed rather than taken from the ring's normal so the
      // basis is always right-handed — handing `makeBasis` a left-handed one
      // mirrors the block and inverts its normals.
      _xAxis
        .copy(this._ringX)
        .multiplyScalar(_tangent.x)
        .addScaledVector(this._ringY, _tangent.y);
      _yAxis
        .copy(this._ringX)
        .multiplyScalar(_normal.x)
        .addScaledVector(this._ringY, _normal.y);
      _zAxis.crossVectors(_xAxis, _yAxis).normalize();
      _basis.makeBasis(_xAxis.normalize(), _yAxis.normalize(), _zAxis);
      _quat.setFromRotationMatrix(_basis);

      const tilt = c.segmentTilt * settings.global.randomness;
      _euler.set(record.tiltJitter.x * tilt, record.tiltJitter.y * tilt, record.tiltJitter.z * tilt);
      _quat.multiply(_spinQuat.setFromEuler(_euler));

      if (t < 1) {
        // Spin decays as the square of what is left, so the piece is visibly
        // still by the time it touches its neighbours.
        const left = 1 - t;
        _spinQuat.setFromAxisAngle(record.spinAxis, record.spinAmount * c.segmentSpin * left * left);
        _quat.premultiply(_spinQuat);
      }

      _scale.copy(record.sizeJitter).multiplyScalar(Math.max(0.02, c.segmentSize));
      // Elongated along the contour and shallow through the ring: a segment of
      // a hoop, not a brick.
      _scale.x *= 1.25;
      _scale.y *= 0.78;
      // Called in from nothing rather than uncovered, and it snaps the last of
      // the way — the one beat in the sequence that is not smooth.
      if (t < 1) _scale.multiplyScalar(Math.max(0.05, Easing.outBack(t)));

      /* --- the break-up --- */
      if (closing) {
        // The crown lets go first and the feet last, and the pieces are thrown
        // *outward*: the ring does not fall down, it comes off the spindle.
        const lead = (1 - saturate(Math.abs(record.contour))) * closeSpan * 0.35;
        const off = saturate((this._closeAge - lead) / (closeSpan * 0.6));
        const thrown = Easing.inQuad(off);
        _dummy.position.addScaledVector(_yAxis, thrown * c.scatterOut);
        _dummy.position.addScaledVector(_xAxis, thrown * c.scatterSpin * record.spinAmount);
        _dummy.position.y -= thrown * thrown * (this._centre.y + 1.5);
        _spinQuat.setFromAxisAngle(record.spinAxis, record.spinAmount * thrown * 3.4);
        _quat.premultiply(_spinQuat);
        _scale.multiplyScalar(1 - thrown * 0.25);
      }

      _dummy.quaternion.copy(_quat);
      _dummy.scale.copy(_scale);
      _dummy.updateMatrix();
      // Each record owns slot `i` in *both* meshes and fills the one its
      // variant belongs to, leaving the other collapsed.
      for (let m = 0; m < this.segmentMeshes.length; m++) {
        if (m === record.variant) this.segmentMeshes[m].setMatrixAt(i, _dummy.matrix);
        else this.segmentMeshes[m].setMatrixAt(i, HIDDEN_MATRIX);
      }
    }

    for (const mesh of this.segmentMeshes) {
      mesh.count = MAX_SEGMENTS;
      mesh.instanceMatrix.needsUpdate = true;
    }

    // A low hum for as long as anything is still moving into place or standing.
    if (this._riftAge < 0) {
      this.ctx.shake.rumble(0.04 * c.shakeIntensity * g.explosionIntensity, dt);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Uniforms                                                            */
  /* ------------------------------------------------------------------ */

  /** 0..1 aperture: how far the pool has filled toward the rim. */
  _aperture() {
    const c = settings.aether;
    if (this._riftAge < 0) return 0;
    // `outBack` again, and here it is the kawoosh: the pool overfills, slams
    // into the segments and drops back to sit inside them.
    const open = Easing.outBack(saturate(this._riftAge / Math.max(0.05, c.openTime)));
    if (this._closeAge < 0) return open;
    // The horizon shuts to a point well before the segments stop flying — the
    // rift closes, and then the machine holding it comes apart.
    return open * (1 - Easing.inCubic(saturate(this._closeAge / (this.fadeDuration * 0.4))));
  }

  _syncUniforms() {
    const c = settings.aether;
    const g = settings.global;

    /* --- the segments --- */
    // Written straight rather than through `RockMaterial`'s sync, which reads
    // the earth ability's palette: a ring is lit by its own rift.
    const rock = getColor(c.colorMetal);
    const dark = getColor(c.colorMetalDark);
    const u = this.segmentMaterial.userData.uniforms;
    u.uColorRock.value.copy(rock);
    u.uColorDark.value.copy(dark);
    u.uColorMoss.value.copy(dark);
    u.uGlowColor.value.copy(getColor(c.colorRim));
    // The seam in the stone is this ability's *runes*, so unlike the gate it is
    // driven rather than held at zero — and it is driven by how much of the
    // ring has locked, which is why the marks come alive behind the segments as
    // they arrive rather than all at once.
    u.uGlow.value =
      c.runeGlow * g.glow * this._lockProgress(c) * (0.45 + 0.55 * this._aperture());

    /* --- the horizon and its halo --- */
    const radius = Math.max(0.3, c.ringRadius);
    const outer = (radius + Math.max(0, c.overlap)) * (1 + c.lobeDepth);
    const quadSize = (outer + c.runeRadius + c.haloWidth + 0.6) * 2;
    const aperture = this._aperture();
    const lock = this._lockProgress(c);

    for (const material of [this.surfaceMaterial, this.haloMaterial]) {
      const s = material.uniforms;
      s.uQuadSize.value = quadSize;
      // Grown past the opening by `overlap` so the pool's own edge finishes
      // *underneath* the segments: a surface that stops exactly on the contour
      // shows a clean bright arc through every gap the blocks leave, and that
      // arc is the one thing that reads as a quad rather than as a rift.
      s.uRadius.value = radius + Math.max(0, c.overlap);
      s.uLobes.value = Math.max(0, Math.round(c.lobes));
      s.uLobeDepth.value = c.lobeDepth;
      s.uIris.value = aperture;
      s.uChurn.value = c.churn;
      s.uSpin.value = c.spin;
      s.uTwist.value = c.twist;
      s.uTurbulence.value = c.turbulence * g.turbulence;
      s.uNoiseScale.value = c.noiseScale;
      s.uFlow.value = c.flow;
      s.uRipples.value = c.ripples;
      s.uRippleSpeed.value = c.rippleSpeed;
      s.uRippleDepth.value = c.rippleDepth;
      s.uRim.value = c.rim;
      s.uRimWidth.value = c.rimWidth;
      s.uRimFalloff.value = c.rimFalloff;
      s.uRimHot.value = c.rimHot;
      s.uEye.value = c.eye;
      s.uEyeSize.value = c.eyeSize;
      s.uEyeClear.value = c.eyeClear;
      s.uSparkle.value = c.sparkle;
      s.uSparkleScale.value = c.sparkleScale;
      s.uHalo.value = c.halo;
      s.uHaloWidth.value = c.haloWidth;
      s.uRunes.value = c.runes;
      s.uRuneCount.value = Math.max(1, Math.round(c.runeCount));
      s.uRuneRadius.value = c.runeRadius;
      s.uRuneWidth.value = c.runeWidth;
      s.uRuneGap.value = c.runeGap;
      s.uLock.value = lock;
      s.uIgnite.value = this._ignite;
      s.uColorCore.value.copy(getColor(c.colorCore));
      s.uColorMid.value.copy(getColor(c.colorMid));
      s.uColorDeep.value.copy(getColor(c.colorDeep));
      s.uColorRim.value.copy(getColor(c.colorRim));
    }
    this.surfaceMaterial.uniforms.uOpacity.value = c.surfaceOpacity * g.opacity;
    this.haloMaterial.uniforms.uOpacity.value = g.opacity;

    /* --- place both quads in the ring's own frame --- */
    _basis.makeBasis(this._ringX, this._ringY, this._ringN);
    _quat.setFromRotationMatrix(_basis);
    for (const mesh of [this.surface, this.halo]) {
      mesh.position.copy(this._centre);
      mesh.quaternion.copy(_quat);
      mesh.scale.set(quadSize, quadSize, 1);
    }
    this.surface.visible = aperture > 0.002;
    // The runes are the readout of the forging, so the halo pass is up from the
    // first segment — it is what makes the ring legible while it is still lying
    // on the floor with nothing in it.
    this.halo.visible = this._buildAge >= 0 && (c.halo > 0.001 || c.runes > 0.001);

    /* --- the particles --- */
    const core = getColor(c.colorCore);
    const mid = getColor(c.colorMid);
    const rim = getColor(c.colorRim);
    const deep = getColor(c.colorDeep);

    this.motes.setGradient(core, rim, mid, deep);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 6;
    this.motes.uniforms.uLifeScale.value = c.moteLife * 0.5 * g.particleLifetime;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uTurbulence.value = 0.6 * g.turbulence;

    this.spray.setGradient(core, core, rim, mid);
    this.spray.uniforms.uSizeScale.value = c.spraySize * g.particleSize * 7;
    this.spray.uniforms.uLifeScale.value = c.sprayLife * 0.5 * g.particleLifetime;
    this.spray.uniforms.uOpacity.value = g.opacity;
    this.spray.uniforms.uSpeedScale.value = g.particleSpeed;

    this.mist.setGradient(_tint.copy(mid).multiplyScalar(0.7), mid, deep, deep);
    this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize;
    this.mist.uniforms.uLifeScale.value = c.mistLife * 0.5 * g.particleLifetime;
    this.mist.uniforms.uOpacity.value = 0.45 * g.opacity;
    this.mist.uniforms.uTurbulence.value = 0.35 * g.turbulence;

    this.debris.setGradient(_tint.copy(rock).multiplyScalar(1.4), rock, dark, dark);
    this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
    this.debris.uniforms.uLifeScale.value = g.particleLifetime;
    this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
    this.debris.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Travel — the tide running out to the site                           */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    // The frame is needed even now: the emitters below place themselves in it,
    // and it is what the site resolves to before anything has been forged.
    this._updateFrame();
    this._syncUniforms();

    const c = settings.aether;
    const g = settings.global;
    const time = frame.uTime.value;

    const count = Math.round(this.tideEmitter.tick(dt, 120) * g.particleCount);
    if (count > 0) {
      _emit.position = _pos.copy(this.position).setY(0.08);
      _emit.radius = 0.3;
      // Thrown sideways off the line rather than up: a wave breaking along a
      // wall, not a fuse burning.
      _emit.direction = _dir.copy(this.side).multiplyScalar(randRange(-1, 1)).setY(0.5).normalize();
      _emit.speed = 3.4;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.spraySize * 0.9;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sprayLife * 0.4;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spray.emit(count, _emit);
    }

    // A ripple on the floor every couple of metres — the tide the ring is being
    // called along has to leave something behind, or the travel reads as the
    // camera panning rather than as a cast.
    if (this.front - this._tideDistance > 2.4) {
      this._tideDistance = this.front;
      this.ctx.decals.spawn(DecalType.RIPPLE, this.position, {
        radius: randRange(1.1, 1.9),
        life: 1.8,
        width: 0.08,
        intensity: 0.55,
        colorA: getColor(c.colorRim),
        colorB: getColor(c.colorDeep)
      });
    }

    this._updateSegments(dt);
  }

  /* ------------------------------------------------------------------ */
  /* Impact — the ring is laid out on the floor                          */
  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = settings.aether;
    const g = settings.global;

    this._buildAge = 0;
    this._updateFrame();
    this._layRing();

    /* the sigil burning itself into the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.position, {
      radius: Math.max(c.ringRadius, 1) * 2.4 * g.explosionIntensity,
      life: 0.9,
      width: 0.06,
      intensity: 0.9,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorRim)
    });
    this.ctx.decals.spawn(DecalType.RIPPLE, this.position, {
      radius: Math.max(c.ringRadius, 1) * 1.5,
      life: 2.2,
      width: 0.1,
      intensity: 0.8,
      colorA: getColor(c.colorRim),
      colorB: getColor(c.colorMid)
    });

    /* spray thrown up off the whole circle, not just its middle: the segments
       are coming in around a ring, not through a point */
    const time = frame.uTime.value;
    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * TAU;
      _local.set(
        Math.cos(angle) * c.ringRadius,
        Math.sin(angle) * c.ringRadius,
        randRange(-0.2, 0.2)
      );
      this._toWorld(_local, _pos);
      _emit.position = _pos;
      _emit.radius = 0.3;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 3.2;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.spraySize;
      _emit.sizeVariance = 0.6;
      _emit.life = c.sprayLife * 0.7;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spray.emit(Math.round(8 * g.particleCount), _emit);
    }

    this.ctx.shake.add(0.26 * c.shakeIntensity * g.explosionIntensity, 2.4, 20);
    this.lightBoost = c.lightIntensity * 0.2 * g.explosionIntensity;
    this._syncUniforms();
  }

  /**
   * The moment the horizon lights.
   *
   * One spike out of the *front* of the ring rather than a sphere at its
   * middle: what opens is a surface with a facing, and the pressure it lets go
   * of has somewhere to be.
   */
  _igniteRift() {
    const c = settings.aether;
    const g = settings.global;

    this._riftAge = 0;
    this._ignite = 1;

    _pos.copy(this._centre).addScaledVector(this._ringN, Math.max(0.3, c.ringRadius) * 0.35);

    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: Math.max(0.3, c.ringRadius * 0.3),
      endRadius: Math.max(1, c.ringRadius) * 1.9 * g.explosionIntensity,
      life: 0.8,
      intensity: 1.0,
      opacity: 0.5,
      displace: 0.4,
      squash: 0.75,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorMid),
      colorC: getColor(c.colorDeep)
    });

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.position, {
      radius: Math.max(c.ringRadius, 1) * 2.8 * g.explosionIntensity,
      life: 0.65,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorRim)
    });

    // The surge itself: a cone of spray blown out of the opening, both ways,
    // because a hole is open on both sides.
    const time = frame.uTime.value;
    for (const sign of [1, -1]) {
      _emit.position = _pos;
      _emit.radius = Math.max(0.2, c.ringRadius * 0.55);
      _emit.direction = _dir.copy(this._ringN).multiplyScalar(sign);
      _emit.speed = c.surgeSpeed * (sign > 0 ? 1 : 0.55);
      _emit.speedVariance = 0.7;
      _emit.spread = 0.45;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.spraySize * 1.4;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sprayLife;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spray.emit(Math.round((sign > 0 ? 150 : 60) * g.particleCount), _emit);
    }

    this.ctx.flash.trigger(getColor(c.colorMid), c.explosionFlash * g.explosionIntensity);
    this.ctx.shake.add(0.4 * c.shakeIntensity * g.explosionIntensity, 2.4, 15);
    this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Standing                                                            */
  /* ------------------------------------------------------------------ */

  /** What the rift takes in and gives back for as long as it is open. */
  _standingFx(dt) {
    const c = settings.aether;
    const g = settings.global;
    const time = frame.uTime.value;
    const aperture = this._aperture();
    if (aperture < 0.05) return;

    const radius = Math.max(0.3, c.ringRadius);

    /* --- what it pulls in --- */
    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * aperture) * g.particleCount);
    if (moteCount > 0) {
      const angle = Math.random() * TAU;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // Born just outside the rim and thrown at the middle, with a tangential
      // lean so they come in on a curve rather than down a spoke.
      _local.set(cos * radius * 1.12, sin * radius * 1.12, randRange(-0.5, 0.5) * c.ringDepth);
      _emit.position = this._toWorld(_local, _pos);
      _local.set(-cos, -sin, 0);
      _dir
        .copy(this._ringX)
        .multiplyScalar(_local.x)
        .addScaledVector(this._ringY, _local.y)
        .addScaledVector(this._ringX, -sin * c.moteCurl)
        .addScaledVector(this._ringY, cos * c.moteCurl)
        .normalize();
      _emit.radius = 0.1;
      _emit.direction = _dir;
      _emit.speed = c.moteDraw;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.18;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.8;
      _emit.life = c.moteLife;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    /* --- and what it breathes back --- */
    const sprayCount = Math.round(
      this.sprayEmitter.tick(dt, c.sprayRate * aperture) * g.particleCount
    );
    if (sprayCount > 0) {
      _local.set(randRange(-1, 1) * radius * 0.5, randRange(-1, 1) * radius * 0.5, 0);
      _emit.position = this._toWorld(_local, _pos);
      _emit.radius = 0.15;
      _emit.direction = _dir.copy(this._ringN).multiplyScalar(Math.random() < 0.7 ? 1 : -1);
      _emit.speed = c.sprayRise;
      _emit.speedVariance = 0.9;
      _emit.spread = 0.6;
      _emit.size = c.spraySize * 0.8;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sprayLife * 0.7;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.spray.emit(sprayCount, _emit);
    }

    /* --- the cold falling out of the underside --- */
    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * aperture) * g.particleCount);
    if (mistCount > 0) {
      _local.set(randRange(-1, 1) * radius * 0.7, -radius * randRange(0.55, 0.95), randRange(-1, 1) * c.ringDepth * 0.6);
      _emit.position = this._toWorld(_local, _pos);
      _emit.radius = 0.28;
      _emit.direction = _dir.set(randRange(-0.3, 0.3), -1, randRange(-0.3, 0.3)).normalize();
      _emit.speed = 0.8;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.5;
      _emit.size = c.mistSize;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLife;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* The frame loop, in every phase after the travel                     */
  /* ------------------------------------------------------------------ */

  onFade(dt) {
    const c = settings.aether;

    if (this._buildAge >= 0) this._buildAge += dt;
    if (this._riftAge >= 0) this._riftAge += dt;
    if (this._closeAge >= 0) this._closeAge += dt;

    this._updateFrame();

    // The horizon lights once the ring has finished standing up.
    if (this._riftAge < 0 && this._closeAge < 0) {
      const built =
        this._assembleSpan(c) + Math.max(0, c.riseDelay) + c.riseTime + Math.max(0, c.openDelay);
      if (this._buildAge >= built) this._igniteRift();
    }

    // The ignition spike is a decay, not a keyframe, so it survives being
    // dragged around in the editor.
    this._ignite = Math.max(0, this._ignite - dt * 2.6);

    // The light hangs in the middle of the opening, which is also what the
    // camera frames — so it rides up with the ring as it stands.
    this.position.copy(this._centre);

    this._syncUniforms();
    this._updateSegments(dt);
    if (this._closeAge < 0) this._standingFx(dt);
  }

  /* ------------------------------------------------------------------ */
  /* Coming apart                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Shut the rift.
   *
   * Called by `AbilityManager` when a second ring is raised. The base machine
   * has been sitting in IMPACT with an infinite duration; this hands it a FADE
   * to run, which is the only thing that ever retires this ability.
   */
  dismiss() {
    if (!this.isActive || this._closeAge >= 0) return;

    this._closeAge = 0;
    this.phase = AbilityPhase.FADE;
    this.fadeTime = 0;

    const c = settings.aether;
    const g = settings.global;

    if (this._riftAge >= 0) {
      // An implosion, not a blast: the pool is pulled down to a point.
      this.ctx.bursts.spawn(BurstMode.WATER, this._centre, {
        radius: Math.max(1, c.ringRadius) * 0.8,
        endRadius: Math.max(0.2, c.ringRadius * 0.1),
        life: 0.55,
        intensity: 1.2,
        opacity: 0.6,
        displace: 0.35,
        colorA: getColor(c.colorCore),
        colorB: getColor(c.colorMid),
        colorC: getColor(c.colorDeep)
      });
      this.ctx.shake.add(0.24 * c.shakeIntensity * g.explosionIntensity, 3.2, 18);
    }
  }

  onDestroy() {
    this.surface.visible = false;
    this.halo.visible = false;
    for (const mesh of this.segmentMeshes) mesh.count = 0;
    this._segmentCount = 0;
    this._buildAge = -1;
    this._riftAge = -1;
    this._closeAge = -1;
    for (const record of this.segmentRecords) record.active = false;
  }

  dispose() {
    for (const geometry of this.segmentGeometries) geometry.dispose();
    for (const mesh of this.segmentMeshes) mesh.dispose();
    this.segmentMaterial.dispose();
    this.surfaceGeometry.dispose();
    this.surfaceMaterial.dispose();
    this.haloMaterial.dispose();
    super.dispose();
  }
}
