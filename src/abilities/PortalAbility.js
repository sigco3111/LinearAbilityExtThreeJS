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
import { ARCH_SDF } from '../effects/GateIndicator.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing, randRange } from '../utils/math.js';

/** Hard cap on the stones of the arch. The courses clamp to this. */
const MAX_STONES = 160;
/** The two block shapes the arch is stacked out of. */
const STONE_SEEDS = [17, 43];
const HALF_PI = Math.PI / 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _local = new Vector3();
const _slot = new Vector3();
const _start = new Vector3();
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
 * The portal surface, and the halo around it, in one fragment shader.
 *
 * The opening is not geometry: it is the same `archDistance` field the gate
 * template draws its ghost with, evaluated on a plain quad in metres. That is
 * what lets the aperture flood open, the span be dragged in the editor and the
 * whole surface cost one draw call — there is no mesh to rebuild when the arch
 * changes shape, because there never was a mesh of the arch.
 *
 * `uSurface` picks which half of the effect this material draws: 0 is the
 * vortex inside the contour, 1 is the glow that spills out past it onto the
 * stones. Two meshes, two blend modes, one shader — the halo has to be additive
 * (it is light falling on rock) and the surface must not be, because the
 * surface controls its own transparency: it is solid where it meets the stone
 * and opens up through the middle, which an additive pass could not do.
 */
const PORTAL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PORTAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadW;
  uniform float uQuadH;
  uniform float uHalfWidth;   // half the clear span, metres
  uniform float uSpring;      // height of the springing line, metres
  uniform float uOpen;        // 0..1 aperture — the surface floods the opening
  uniform float uSpin;
  uniform float uTwist;
  uniform float uFocus;       // height of the vortex focus, × uSpring
  uniform float uTurbulence;
  uniform float uNoiseScale;
  uniform float uFlow;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uColumn;
  uniform float uRim;         // the glow that hugs the arch
  uniform float uRimWidth;    // how far into the opening it reaches, metres
  uniform float uRimFalloff;  // how fast it gives way to the middle
  uniform float uRimHot;      // the white lip right against the stone
  uniform float uUpdraft;
  uniform float uClear;       // how far the middle of the funnel opens up
  uniform float uClearSize;   // radius of that clearing, × the half-span
  uniform float uClearFalloff;
  uniform float uHalo;
  uniform float uHaloWidth;
  uniform float uIgnite;      // 0..1 spike the moment the gate lights
  uniform float uSurface;     // 0 = the vortex, 1 = the halo around it
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorMid;
  uniform vec3  uColorDeep;
  uniform vec3  uColorRim;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${ARCH_SDF}

  #define TAU 6.28318530718

  void main() {
    /* ---- uv → metres, measured from the middle of the threshold ---- */
    vec2 p = vec2((vUv.x - 0.5) * uQuadW, vUv.y * uQuadH);

    float hw = max(0.05, uHalfWidth * uOpen);
    float spring = max(0.05, uSpring * uOpen);
    float d = archDistance(p, hw, spring);
    float aa = fwidth(d) + 0.012;
    float inside = smoothstep(-aa, aa, d);

    /* ---- the halo: light spilling out onto the stones ---- */
    if (uSurface > 0.5) {
      float beyond = max(-d, 0.0);
      float glow = exp(-beyond / max(0.03, uHaloWidth));
      float alpha = glow * (1.0 - inside) * uHalo * uOpen;
      // Nothing glows below the floor line, or the halo reads as a puddle the
      // gate is floating on.
      alpha *= smoothstep(-0.15, 0.3, p.y);
      alpha *= uOpacity;
      if (alpha < 0.004) discard;

      vec3 haloColor = mix(uColorRim, uColorMid, 0.4) * (1.0 + uIgnite * 1.8);
      gl_FragColor = vec4(haloColor * uGlobalGlow * alpha, alpha);
      return;
    }

    if (inside < 0.004) discard;

    /* ---- the wisps ---- */
    vec2 q = vec2(p.x, p.y - spring * uFocus);
    float r = length(q) / max(0.2, hw);

    // The sampling frame is *sheared* about the focus, harder toward the
    // middle, rather than a spiral being drawn into it. Differential rotation
    // is what makes a surface read as turning; a literal log-spiral band reads
    // as a decal stuck over the opening, which is exactly what it looked like.
    float rot = uTime * uSpin * TAU + uTwist / max(r, 0.22);
    float cs = cos(rot);
    float sn = sin(rot);
    vec2 sheared = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);

    // Two octaves, the second warped by the first: long curved wisps that fold
    // over each other, the way smoke caught in a draught does.
    float n1 = fbm3(vec3(sheared * uNoiseScale, uTime * uFlow));
    float n2 = fbm3(vec3(sheared * uNoiseScale * 2.1 + n1 * 1.6, uTime * uFlow * 1.3 + 7.0));
    float wisp = clamp(0.5 + (n1 * 0.55 + n2 * 0.75) * uTurbulence, 0.0, 1.0);

    /* ---- where the light sits ---- */
    // Driven by the distance *into the opening*, so the bright band follows the
    // jambs up and round the keystone — it hugs the arch the way light does
    // where a portal meets its frame. The middle is the dimmest part of the
    // surface, and that contrast is the whole depth of the thing: a gate lit
    // evenly from edge to edge is a sheet of paper.
    float edge = pow(clamp(1.0 - d / max(0.05, uRimWidth), 0.0, 1.0), uRimFalloff);

    // Fog in the middle, the gate's own green in the wisps, and more of it the
    // closer to the frame you get.
    vec3 color = mix(uColorDeep, uColorMid, wisp * (0.45 + 0.5 * edge));
    color = mix(color, uColorRim, clamp(edge * uRim, 0.0, 1.0));
    // The white lip right against the stone. A high power, so it is a lip and
    // not a wash — this is the only part of the surface allowed to blow out.
    color += uColorCore * pow(edge, 4.0) * uRimHot;

    /* ---- what is left hanging in the middle ---- */
    float core = pow(clamp(1.0 - r / max(0.05, uCoreSize), 0.0, 1.0), 2.0) * uCore;
    float column = exp(-abs(p.x) / max(0.05, hw * 0.5)) * uColumn;
    // Tinted with the body colour rather than the core white: whatever light is
    // left in the middle is haze hanging in the opening, not a lamp behind it.
    color += uColorMid * (core + column * (0.4 + 0.6 * wisp));

    // Light streaming up the inside of the jambs — the read that says the gate
    // is pouring energy rather than hanging it.
    float updraft = fbm3(vec3(p.x * 3.0, p.y * 0.7 - uTime * 1.7, 11.0)) * 0.5 + 0.5;
    color += uColorRim * updraft * edge * uUpdraft * 0.5;

    color *= 1.0 + uIgnite * 2.2;

    /* ---- the way through ---- */
    // A gate is a hole in the world, so the middle of the funnel opens up: the
    // alpha falls away toward the focus and the scene behind shows through it,
    // while the surface stays solid out at the frame. The wisps still cross the
    // clearing — what opens is the *space between* them — so a wisp sweeping
    // through the middle still catches the light on its way past.
    float clearing = uClear * pow(clamp(1.0 - r / max(0.05, uClearSize), 0.0, 1.0), uClearFalloff);
    float body = clamp(0.9 + 0.1 * wisp + edge, 0.0, 1.0);
    float alpha = inside * uOpacity * mix(body, body * (0.2 + 0.55 * wisp), clearing);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * VERDANT GATE — the first cast that **builds** something and leaves it there.
 *
 * Everything else in the sandbox is an event: it happens, it fades, the pool
 * takes it back. A gate is a *place*. Three beats:
 *
 *   1. a seam of green races along the aimed line to the site, which is the
 *      base class's travelling front doing its usual job;
 *   2. the arch is **constructed** — stones break out of the floor outside the
 *      footprint and swing up into their slots one course at a time, both jambs
 *      climbing together, the keystone seating last;
 *   3. the portal floods the opening and **stays lit**, until another gate is
 *      raised somewhere else (`AbilityManager` dismisses the standing one) or
 *      the sandbox is cleared.
 *
 * The stones store no metres. Each one holds where it sits along the contour as
 * a signed 0..1 — which jamb, and how far up toward the keystone — plus its
 * course and its dice; every position, angle and size is resolved against
 * `settings.portal` on each frame. Drag the span of a gate that has been
 * standing for a minute and the whole arch re-lays itself around the new
 * opening, keystone included, while the clock is paused. That is the same rule
 * the rest of the project runs on, and a standing structure is where it pays
 * the most: this is the one cast you can actually walk around and study.
 *
 * The opening itself is never geometry — the surface is one quad carrying the
 * arch's SDF (see `PORTAL_FRAGMENT`), which is why the aperture can flood open
 * and the span can change without anything being rebuilt.
 */
export class PortalAbility extends Ability {
  constructor(context) {
    super('portal', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* --- the stones of the arch --- */
    // Quarried blocks, not boulders: an arch is a thing somebody *stacked*, and
    // the round rock the spire heaves up reads as the opposite of built.
    //
    // Two shapes, drawn as two instanced meshes off one material. A single
    // geometry would give every stone in the arch the same silhouette, which is
    // the one thing that gives a procedural wall away; two is enough to break
    // it, and every record picks its variant once. The pair shares the material
    // because both are instanced and therefore compile the same program.
    this.stoneMaterial = createRockMaterial(environment, 0.5);
    this.stoneGeometries = STONE_SEEDS.map((seed, i) =>
      createBlockGeometry(seed, 0.13 + i * 0.05, 0.07 + i * 0.02)
    );
    this.stoneMeshes = this.stoneGeometries.map((geometry, i) => {
      const mesh = new InstancedMesh(geometry, this.stoneMaterial, MAX_STONES);
      mesh.name = `PortalStones:${i}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid world geometry: the arch belongs in the depth prepass so that the
      // motes and the mist fade softly against it.
      mesh.layers.set(LAYER.WORLD);
      this.group.add(mesh);
      return mesh;
    });

    /* --- the surface, and the halo it throws on the stones --- */
    // Unit quad in XY with its bottom edge on the floor: local +X runs across
    // the span and local +Z is the way the gate faces, so placing it is one yaw.
    this.surfaceGeometry = new PlaneGeometry(1, 1, 1, 1).translate(0, 0.5, 0);

    this.surfaceMaterial = this._createSurfaceMaterial(false);
    this.surface = new Mesh(this.surfaceGeometry, this.surfaceMaterial);
    this.surface.name = 'PortalSurface';
    this.surface.layers.set(LAYER.VFX);
    this.surface.renderOrder = 3;
    this.surface.frustumCulled = false;
    this.surface.visible = false;
    this.group.add(this.surface);

    this.haloMaterial = this._createSurfaceMaterial(true);
    this.halo = new Mesh(this.surfaceGeometry, this.haloMaterial);
    this.halo.name = 'PortalHalo';
    this.halo.layers.set(LAYER.VFX);
    this.halo.renderOrder = 4;
    this.halo.frustumCulled = false;
    this.halo.visible = false;
    this.group.add(this.halo);

    /**
     * Fixed-size record pool — no allocation while casting.
     *
     * `contour` is the whole layout: its sign is which jamb, its magnitude is
     * how far up toward the keystone, 1 being the keystone itself. `course` is
     * how many stone-widths out from the opening it is stacked, and is
     * deliberately allowed to be fractional so the piles at the feet of the
     * jambs are the same record with a looser number in it.
     */
    this.stoneRecords = [];
    for (let i = 0; i < MAX_STONES; i++) {
      this.stoneRecords.push({
        active: false,
        landed: false,
        keystone: false,
        variant: i % STONE_SEEDS.length,
        contour: 0,
        course: 0,
        delay: 0,
        depthJitter: 0,
        sizeJitter: new Vector3(1, 1, 1),
        tiltJitter: new Vector3(),
        spinAxis: new Vector3(0, 1, 0),
        spinAmount: 0,
        arcJitter: 1,
        startJitter: 1
      });
    }

    this._stoneCount = 0;
    /** How far along the line the last seam mark was burned. */
    this._seamDistance = 0;
    /** Seconds since the first stone was called out of the floor. */
    this._buildAge = -1;
    /** Seconds since the surface lit. Negative until it does. */
    this._portalAge = -1;
    /** Seconds since the gate was asked to come apart. Negative until it is. */
    this._closeAge = -1;
    this._yaw = 0;
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
        uQuadW: { value: 4 },
        uQuadH: { value: 4 },
        uHalfWidth: { value: 1.8 },
        uSpring: { value: 2.5 },
        uOpen: { value: 0 },
        uSpin: { value: 0.22 },
        uTwist: { value: 1.1 },
        uFocus: { value: 0.62 },
        uTurbulence: { value: 0.55 },
        uNoiseScale: { value: 2.2 },
        uFlow: { value: 0.35 },
        uCore: { value: 1.35 },
        uCoreSize: { value: 0.42 },
        uColumn: { value: 0.6 },
        uRim: { value: 0.9 },
        uRimWidth: { value: 0.95 },
        uRimFalloff: { value: 2.2 },
        uRimHot: { value: 1.2 },
        uUpdraft: { value: 0.8 },
        uClear: { value: 1 },
        uClearSize: { value: 0.66 },
        uClearFalloff: { value: 1.5 },
        uHalo: { value: 1.1 },
        uHaloWidth: { value: 0.55 },
        uIgnite: { value: 0 },
        uSurface: { value: halo ? 1 : 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.96, 1, 0.85) },
        uColorMid: { value: new Color(0.47, 0.94, 0.15) },
        uColorDeep: { value: new Color(0.07, 0.25, 0.08) },
        uColorRim: { value: new Color(0.78, 1, 0.43) }
      },
      vertexShader: PORTAL_VERTEX,
      fragmentShader: PORTAL_FRAGMENT
    });
  }

  createParticles() {
    const particles = this.ctx.particles;

    /* --- what the gate sheds while it stands --- */
    this.motes = particles.get('portal.motes', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    // Negative gravity: the motes in the reference rise past the arch rather
    // than falling through it.
    this.motes.uniforms.uGravity.value.set(0, 0.35, 0);
    this.motes.uniforms.uDrag.value = 0.7;
    this.motes.uniforms.uEndSize.value = 0.15;
    this.motes.uniforms.uFadeIn.value = 0.18;
    this.motes.uniforms.uFadeOut.value = 0.55;
    this.motes.uniforms.uTurbFrequency.value = 0.7;

    this.mist = particles.get('portal.mist', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.mist.uniforms.uGravity.value.set(0, 0.5, 0);
    this.mist.uniforms.uDrag.value = 1.8;
    this.mist.uniforms.uEndSize.value = 2.6;
    this.mist.uniforms.uFadeIn.value = 0.25;
    this.mist.uniforms.uFadeOut.value = 0.5;

    /* --- what the construction throws --- */
    this.dust = particles.get('portal.dust', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.dust.uniforms.uGravity.value.set(0, 0.2, 0);
    this.dust.uniforms.uDrag.value = 2.2;
    this.dust.uniforms.uEndSize.value = 2.8;
    this.dust.uniforms.uFadeOut.value = 0.35;

    this.debris = particles.get('portal.debris', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.debris.uniforms.uGravity.value.set(0, -13.0, 0);
    this.debris.uniforms.uDrag.value = 0.25;
    this.debris.uniforms.uEndSize.value = 0.9;
    this.debris.uniforms.uFadeOut.value = 0.7;

    this.moteEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
    this.seamEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._stoneCount;
  }

  /**
   * A gate has no impact phase to run out of.
   *
   * The base machine advances IMPACT → FADE when `impactTime` reaches this, so
   * an infinite one is exactly the statement "this cast does not end on its
   * own". `dismiss()` is the only thing that moves it on.
   */
  get impactDuration() {
    return Infinity;
  }

  /** How long the collapse takes, once something has asked for one. */
  get fadeDuration() {
    return Math.max(0.2, settings.portal.closeTime);
  }

  get isPersistent() {
    return true;
  }

  /** The camera watches the gate being built, then hands itself back. */
  get wantsCamera() {
    if (!this.isActive) return false;
    if (this._closeAge >= 0) return false;
    return this._portalAge < 0 || this._portalAge < settings.portal.openTime + 0.6;
  }

  /**
   * The light is the surface's, so it does not exist before the surface does:
   * during the travel and the whole construction this is a bare glimmer off the
   * seam, and it only comes up as the aperture floods.
   */
  lightShimmer() {
    const c = settings.portal;
    if (this._portalAge < 0) return 0.05;

    const open = saturate(this._portalAge / Math.max(0.05, c.openTime));
    const unrest =
      1 - c.lightFlicker * (0.5 + 0.5 * Math.sin(this.age * 7.3) * Math.sin(this.age * 2.1));
    const closing = this._closeAge >= 0 ? 1 - saturate(this._closeAge / (this.fadeDuration * 0.5)) : 1;
    return open * unrest * closing;
  }

  onSpawn() {
    this.moteEmitter.reset();
    this.mistEmitter.reset();
    this.seamEmitter.reset();

    for (const record of this.stoneRecords) record.active = false;
    for (const mesh of this.stoneMeshes) mesh.count = 0;
    this._stoneCount = 0;
    this._buildAge = -1;
    this._portalAge = -1;
    this._closeAge = -1;
    this._seamDistance = 0;
    this._ignite = 0;
    this.surface.visible = false;
    this.halo.visible = false;

    this._yaw = Math.atan2(this.direction.x, this.direction.z);

    const c = settings.portal;
    const g = settings.global;
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);

    // The handful of motes the gate is called with, thrown off the hand.
    _emit.position = this._handPoint(_pos);
    _emit.radius = 0.18;
    _emit.direction = _dir.copy(this.direction).setY(0.35).normalize();
    _emit.speed = 4.2;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.moteSize * 1.2;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLife * 0.5;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(26 * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* The arch: where a stone belongs                                     */
  /* ------------------------------------------------------------------ */

  /** Arc length of one half of the contour, floor to keystone, metres. */
  _contourLength(c) {
    return Math.max(0.2, c.gateHeight) + Math.max(0.1, c.gateWidth * 0.5) * HALF_PI;
  }

  /**
   * Resolve a contour parameter into the gate's own frame.
   *
   * `out` comes back as (across the span, up, through the wall) in metres, and
   * `_tangent` / `_normal` as the frame at that point — along the contour, and
   * outward from the opening. Everything is derived from the live settings, so
   * this is what makes a standing gate re-lay itself when the span is dragged.
   *
   * @param {number} contour signed 0..1 — sign is the jamb, magnitude is how
   *   far up toward the keystone
   * @param {number} course  how far out from the opening, in courses
   */
  _contourFrame(contour, course, c, out) {
    const hw = Math.max(0.1, c.gateWidth * 0.5);
    const spring = Math.max(0.2, c.gateHeight);
    const sign = contour < 0 ? -1 : 1;
    const along = saturate(Math.abs(contour)) * this._contourLength(c);

    if (along <= spring) {
      // Up the jamb: straight, outward is straight out to the side.
      out.set(sign * hw, along, 0);
      _tangent.set(0, 1, 0);
      _normal.set(sign, 0, 0);
    } else {
      // Round the arch: the angle is the arc length over the radius, so the
      // stones stay evenly spaced however wide the opening is dragged.
      const angle = Math.min(HALF_PI, (along - spring) / hw);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      out.set(sign * hw * cos, spring + hw * sin, 0);
      _tangent.set(-sign * sin, cos, 0);
      _normal.set(sign * cos, sin, 0);
    }

    // Stand the stone off the opening so the arch frames it instead of
    // covering it, then stack the courses outward from there.
    const offset = c.stoneSize * 0.45 + course * Math.max(0.05, c.stoneCourseStep);
    out.addScaledVector(_normal, offset);
    return out;
  }

  /**
   * Where the cast leaves the caster, in world space.
   *
   * The same anchor the other abilities carry, and it is what the first mote of
   * the seam is thrown from — a gate that starts at the character's feet reads
   * as ground opening by itself rather than as something they did.
   */
  _handPoint(out) {
    const c = settings.portal;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** Gate-local (x across, y up, z through) → world. */
  _toWorld(local, out) {
    return out
      .copy(this.position)
      .setY(0)
      .addScaledVector(this.side, local.x)
      .addScaledVector(_up, local.y)
      .addScaledVector(this.direction, local.z);
  }

  _spawnStone(contour, course, delay) {
    if (this._stoneCount >= MAX_STONES) return;
    const record = this.stoneRecords[this._stoneCount++];
    const randomness = settings.portal.stoneRandomness * settings.global.randomness;

    record.active = true;
    record.landed = false;
    record.keystone = Math.abs(contour) >= 0.999;
    record.contour = contour;
    record.course = course;
    record.delay = delay;
    record.depthJitter = randRange(-1, 1);
    record.sizeJitter.set(
      1 + randRange(-0.18, 0.3) * randomness,
      1 + randRange(-0.25, 0.2) * randomness,
      1 + randRange(-0.2, 0.35) * randomness
    );
    record.tiltJitter.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1));
    record.spinAxis
      .set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1))
      .normalize();
    record.spinAmount = randRange(-1, 1);
    record.arcJitter = randRange(0.6, 1.4);
    record.startJitter = randRange(0.75, 1.3);
  }

  /**
   * Lay the whole arch out.
   *
   * The count is chosen here, once, from the spacing — the *positions* are not,
   * and are re-derived every frame. Both jambs are walked from the floor up so
   * that a stone's build delay is simply how far up the contour it sits, which
   * is what makes the two sides climb together and the keystone seat last.
   */
  _layArch() {
    const c = settings.portal;
    this._stoneCount = 0;
    for (const record of this.stoneRecords) record.active = false;

    const courses = Math.max(1, Math.round(c.stoneCourses));
    const perSide = Math.max(3, Math.round(this._contourLength(c) / Math.max(0.15, c.stoneStep)));

    for (let course = 0; course < courses; course++) {
      // Outer courses lag a little, so the arch reads as being built up in
      // layers rather than as one wall sliding into place.
      const courseLag = course * 0.07;
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < perSide; i++) {
          const contour = ((i + 0.5) / perSide) * side;
          this._spawnStone(contour, course, Math.abs(contour) * c.buildTime + courseLag);
        }
      }
      // The keystone, on the centreline, last of its course.
      this._spawnStone(1, course, c.buildTime + courseLag + 0.05);
    }

    /* --- the piles at the feet of the jambs --- */
    // Same record, looser numbers: a fractional course past the outermost one
    // puts a stone outside the jamb, and a small contour keeps it near the
    // floor. Weight where the gate meets the ground, for free.
    const feet = Math.min(MAX_STONES - this._stoneCount, 10);
    for (let i = 0; i < feet; i++) {
      const contour = randRange(0.02, 0.3) * (i % 2 === 0 ? 1 : -1);
      this._spawnStone(contour, courses - 1 + randRange(0.55, 1.5), randRange(0, 0.35));
    }
  }

  /* ------------------------------------------------------------------ */
  /* The construction                                                    */
  /* ------------------------------------------------------------------ */

  /** Dust, chips and a knock when one stone seats in its slot. */
  _landFx(position, size, keystone) {
    const c = settings.portal;
    const g = settings.global;

    _emit.position = _pos.copy(position);
    _emit.radius = size * 0.5;
    _emit.direction = _dir.set(randRange(-0.4, 0.4), -0.4, randRange(-0.4, 0.4)).normalize();
    _emit.speed = c.debrisVelocity * (keystone ? 1.4 : 0.7);
    _emit.speedVariance = 0.7;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.debrisSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.debrisLifetime * 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.debris.emit(Math.round((keystone ? 26 : 5) * g.particleCount), _emit);

    _emit.speed = 0.9;
    _emit.spread = 1.0;
    _emit.size = c.dustSize * (keystone ? 1.6 : 0.8);
    _emit.sizeVariance = 0.5;
    _emit.life = c.dustLifetime * 0.7;
    _emit.spin = 0.6;
    this.dust.emit(Math.round((keystone ? 22 : 4) * c.dustAmount * g.particleCount), _emit);

    this.ctx.shake.add(
      (keystone ? c.keystoneShake : c.landShake) * c.shakeIntensity * g.explosionIntensity,
      keystone ? 1.4 : 4.5,
      keystone ? 15 : 22
    );
  }

  /** Collapse slot `i` in every stone mesh — nothing is standing there. */
  _hideStone(index) {
    for (const mesh of this.stoneMeshes) mesh.setMatrixAt(index, HIDDEN_MATRIX);
  }

  /**
   * Place every stone for this frame.
   *
   * A stone is one of three things at any moment: still underground (before its
   * delay), in flight (a lerp from where it broke the floor to its slot, bowed
   * along the contour and spun down to rest), or seated. The collapse rides on
   * top of all three as a single downward offset, so a gate can be dismissed
   * mid-build and the half-finished arch still falls apart properly.
   */
  _updateStones(dt) {
    const c = settings.portal;
    const g = settings.global;
    const fly = Math.max(0.05, c.stoneFly);
    const closing = this._closeAge >= 0;
    const closeSpan = Math.max(0.2, c.closeTime);

    // Nothing has been called out of the floor yet: draw no instances at all
    // rather than a couple of hundred collapsed ones.
    if (this._buildAge < 0) {
      for (const mesh of this.stoneMeshes) mesh.count = 0;
      return;
    }

    for (let i = 0; i < MAX_STONES; i++) {
      const record = this.stoneRecords[i];
      const age = this._buildAge - record.delay;

      if (!record.active || age < 0) {
        this._hideStone(i);
        continue;
      }

      /* --- the slot, resolved from the live settings --- */
      this._contourFrame(record.contour, record.course, c, _local);
      _local.z += record.depthJitter * Math.max(0, c.gateDepth * 0.5 - c.stoneSize * 0.3);
      this._toWorld(_local, _slot);

      // Where it broke out of the floor: outside its own slot and below it, so
      // it swings up and inward into place. Only the lateral half of the
      // outward push survives — the vertical half is overwritten by the start
      // depth, which is the point: every stone comes up through the floor.
      _start
        .copy(_slot)
        .addScaledVector(this.side, _normal.x * c.stoneArc * record.arcJitter);
      _start.y = -c.stoneStart * record.startJitter;

      const t = saturate(age / fly);
      const flight = Easing.outCubic(t);
      _dummy.position.lerpVectors(_start, _slot, flight);
      // A bow along the contour, so the stone arrives on a curve rather than
      // sliding up a rail.
      const bow = Math.sin(Math.PI * t) * c.stoneArc * 0.35 * record.spinAmount;
      _dummy.position.addScaledVector(this.side, _tangent.x * bow);
      _dummy.position.y += _tangent.y * bow;

      if (t >= 1 && !record.landed) {
        record.landed = true;
        this._landFx(_slot, c.stoneSize, record.keystone);
      }

      /* --- the frame at the slot, plus the tumble it settles out of --- */
      // The stone's own X runs along the contour and its Y points out of the
      // opening, which is what seats a block as a voussoir rather than as a
      // bead. The third axis is crossed rather than taken from the gate's
      // facing so the basis is always right-handed — handing `makeBasis` a
      // left-handed one mirrors the block and inverts its normals.
      _xAxis.copy(this.side).multiplyScalar(_tangent.x).addScaledVector(_up, _tangent.y).normalize();
      _yAxis.copy(this.side).multiplyScalar(_normal.x).addScaledVector(_up, _normal.y).normalize();
      _zAxis.crossVectors(_xAxis, _yAxis).normalize();
      _basis.makeBasis(_xAxis, _yAxis, _zAxis);
      _quat.setFromRotationMatrix(_basis);

      const tilt = c.stoneTilt * settings.global.randomness;
      _euler.set(record.tiltJitter.x * tilt, record.tiltJitter.y * tilt, record.tiltJitter.z * tilt);
      _quat.multiply(_spinQuat.setFromEuler(_euler));

      if (t < 1) {
        // Spin decays as the square of what is left, so it is visibly still by
        // the time the stone touches its neighbours.
        const left = 1 - t;
        _spinQuat.setFromAxisAngle(record.spinAxis, record.spinAmount * c.stoneSpin * left * left);
        _quat.premultiply(_spinQuat);
      }

      _scale.copy(record.sizeJitter).multiplyScalar(Math.max(0.02, c.stoneSize));
      // Elongated along the contour: a voussoir is wider than it is deep, and
      // that alone is most of the difference between an arch and a bead string.
      _scale.x *= 1.18;
      _scale.y *= 0.86;

      /* --- the collapse --- */
      if (closing) {
        // The keystone lets go first and the feet last: an arch comes apart
        // from the top, because the top is the part nothing is holding.
        const lead = (1 - saturate(Math.abs(record.contour))) * closeSpan * 0.4;
        const fall = saturate((this._closeAge - lead) / (closeSpan * 0.55));
        const drop = Easing.inCubic(fall);
        _dummy.position.y -= drop * (_slot.y + c.stoneSize * 2 + 0.6);
        _dummy.position.addScaledVector(this.side, _normal.x * drop * 0.35);
        _spinQuat.setFromAxisAngle(record.spinAxis, record.spinAmount * drop * 2.2);
        _quat.premultiply(_spinQuat);
        _scale.multiplyScalar(1 - drop * 0.2);
      }

      _dummy.quaternion.copy(_quat);
      _dummy.scale.copy(_scale);
      _dummy.updateMatrix();
      // Each record owns slot `i` in *both* meshes and fills the one its
      // variant belongs to, leaving the other collapsed. Keeping the slot the
      // same in both is what lets a stone be placed without any per-mesh
      // cursor bookkeeping.
      for (let m = 0; m < this.stoneMeshes.length; m++) {
        if (m === record.variant) this.stoneMeshes[m].setMatrixAt(i, _dummy.matrix);
        else this.stoneMeshes[m].setMatrixAt(i, HIDDEN_MATRIX);
      }
    }

    for (const mesh of this.stoneMeshes) {
      mesh.count = MAX_STONES;
      mesh.instanceMatrix.needsUpdate = true;
    }

    // A low grind for as long as anything is still moving into place.
    if (this._buildAge >= 0 && this._portalAge < 0) {
      this.ctx.shake.rumble(0.05 * c.shakeIntensity * g.explosionIntensity, dt);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Uniforms                                                            */
  /* ------------------------------------------------------------------ */

  /** 0..1 aperture: how much of the opening the surface has flooded. */
  _aperture() {
    const c = settings.portal;
    if (this._portalAge < 0) return 0;
    const open = Easing.outCubic(saturate(this._portalAge / Math.max(0.05, c.openTime)));
    if (this._closeAge < 0) return open;
    // The surface implodes well before the stones finish falling — the gate
    // shuts, and then the arch that held it comes down.
    return open * (1 - Easing.inCubic(saturate(this._closeAge / (this.fadeDuration * 0.45))));
  }

  _syncUniforms() {
    const c = settings.portal;
    const g = settings.global;

    /* --- the stones --- */
    // Written straight rather than through `RockMaterial`'s sync, which reads
    // the earth ability's palette: a gate is lit by its own portal, not by
    // whatever the spire is set to.
    const rock = getColor(c.colorRock);
    const dark = getColor(c.colorRockDark);
    const u = this.stoneMaterial.userData.uniforms;
    u.uColorRock.value.copy(rock);
    u.uColorDark.value.copy(dark);
    u.uColorMoss.value.copy(getColor(c.colorMoss));
    // Held at zero, deliberately. `RockMaterial` can burn a hot seam through
    // the stone, and on an arch it reads as circuitry cut into the blocks
    // rather than as rock near a light. The green on these stones has to come
    // from *outside* them — the halo falling on the faces near the opening and
    // the dynamic light in the doorway — because that is what makes them read
    // as stone lit by the gate instead of stone made of the gate.
    u.uGlowColor.value.copy(getColor(c.colorMid));
    u.uGlow.value = 0;

    /* --- the surface and its halo --- */
    // The surface is grown past the opening by `overlap` so that its own edge
    // finishes *underneath* the blocks. A surface that stops exactly on the
    // contour shows a clean bright arc through every gap the stones leave, and
    // that arc is the one thing that reads as a quad rather than as a portal —
    // the edge you are meant to see is the stone's.
    const overlap = Math.max(0, c.overlap);
    const hw = Math.max(0.1, c.gateWidth * 0.5) + overlap;
    const spring = Math.max(0.2, c.gateHeight) + overlap;
    const quadW = (hw + c.haloWidth + 0.5) * 2;
    const quadH = spring + hw + c.haloWidth + 0.5;
    const aperture = this._aperture();

    for (const material of [this.surfaceMaterial, this.haloMaterial]) {
      const s = material.uniforms;
      s.uQuadW.value = quadW;
      s.uQuadH.value = quadH;
      s.uHalfWidth.value = hw;
      s.uSpring.value = spring;
      s.uOpen.value = aperture;
      s.uSpin.value = c.spin;
      s.uTwist.value = c.twist;
      s.uFocus.value = c.focus;
      s.uTurbulence.value = c.turbulence;
      s.uNoiseScale.value = c.noiseScale;
      s.uFlow.value = c.flow;
      s.uCore.value = c.core;
      s.uCoreSize.value = c.coreSize;
      s.uColumn.value = c.column;
      s.uRim.value = c.rim;
      s.uRimWidth.value = c.rimWidth;
      s.uRimFalloff.value = c.rimFalloff;
      s.uRimHot.value = c.rimHot;
      s.uUpdraft.value = c.updraft;
      s.uClear.value = c.clear;
      s.uClearSize.value = c.clearSize;
      s.uClearFalloff.value = c.clearFalloff;
      s.uHalo.value = c.halo;
      s.uHaloWidth.value = c.haloWidth;
      s.uIgnite.value = this._ignite;
      s.uColorCore.value.copy(getColor(c.colorCore));
      s.uColorMid.value.copy(getColor(c.colorMid));
      s.uColorDeep.value.copy(getColor(c.colorDeep));
      s.uColorRim.value.copy(getColor(c.colorRim));
    }
    this.surfaceMaterial.uniforms.uOpacity.value = c.surfaceOpacity * g.opacity;
    this.haloMaterial.uniforms.uOpacity.value = g.opacity;

    for (const mesh of [this.surface, this.halo]) {
      // Yawed so its +Z is the gate's facing, which puts its +X along the
      // opening — mirrored against `side`, because a right-handed frame facing
      // one way has its X the other. The arch is symmetric across that axis, so
      // the surface and the stones still describe the same doorway.
      mesh.position.copy(this.position).setY(0.01);
      mesh.rotation.set(0, this._yaw, 0);
      mesh.scale.set(quadW, quadH, 1);
      mesh.visible = aperture > 0.002;
    }
    // With the spill turned off the halo pass would shade a ring of fragments
    // for nothing, so it is skipped outright rather than discarded per pixel.
    this.halo.visible = this.halo.visible && c.halo > 0.001;

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
    this.motes.uniforms.uTurbulence.value = 0.55 * g.turbulence;

    this.mist.setGradient(mid, mid, deep, deep);
    this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize;
    this.mist.uniforms.uLifeScale.value = c.mistLife * 0.5 * g.particleLifetime;
    this.mist.uniforms.uOpacity.value = 0.5 * g.opacity;
    this.mist.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.dust.setGradient(_tint.copy(rock).multiplyScalar(1.3), rock, dark, dark);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uOpacity.value = c.dustAmount * 0.6 * g.opacity;

    this.debris.setGradient(rock, rock, dark, dark);
    this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
    this.debris.uniforms.uLifeScale.value = g.particleLifetime;
    this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
    this.debris.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Travel — the seam running out to the site                           */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._syncUniforms();

    const c = settings.portal;
    const g = settings.global;
    const time = frame.uTime.value;

    const count = Math.round(this.seamEmitter.tick(dt, 90) * g.particleCount);
    if (count > 0) {
      _emit.position = _pos.copy(this.position).setY(0.1);
      _emit.radius = 0.28;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 1.6;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLife * 0.45;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(count, _emit);
    }

    // A burn on the floor every couple of metres — the seam the gate is being
    // called along has to leave something behind, or the travel reads as the
    // camera panning rather than as a cast.
    if (this.front - this._seamDistance > 2.2) {
      this._seamDistance = this.front;
      this.ctx.decals.spawn(DecalType.ARC, this.position, {
        radius: randRange(0.9, 1.6),
        life: 2.4,
        width: 0.1,
        intensity: 0.5,
        colorA: getColor(c.colorMid),
        colorB: getColor(c.colorDeep)
      });
    }

    this._updateStones(dt);
  }

  /* ------------------------------------------------------------------ */
  /* Impact — the arch is called out of the floor                        */
  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = settings.portal;
    const g = settings.global;

    this._buildAge = 0;
    this._yaw = Math.atan2(this.direction.x, this.direction.z);
    this._layArch();

    /* the ground opening up for them */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.position, {
      radius: Math.max(c.gateWidth, 2) * 1.4 * g.explosionIntensity,
      life: 0.9,
      width: 0.07,
      intensity: 0.8,
      colorA: getColor(c.colorRim),
      colorB: getColor(c.colorMid)
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, this.position, {
      radius: Math.max(c.gateWidth, 2) * 0.9,
      life: 1.6,
      intensity: c.dustAmount * 0.8,
      colorA: getColor(c.colorRock),
      colorB: getColor(c.colorRockDark)
    });

    /* dust along the whole footprint, not just its middle: the stones are
       coming through a line, not a point */
    const time = frame.uTime.value;
    const half = c.gateWidth * 0.5;
    for (let i = 0; i < 7; i++) {
      _local.set(randRange(-half - 0.6, half + 0.6), 0.1, randRange(-0.5, 0.5) * c.gateDepth);
      this._toWorld(_local, _pos);
      _emit.position = _pos;
      _emit.radius = 0.35;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 1.9;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.dustSize * 1.2;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.7;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(Math.round(9 * c.dustAmount * g.particleCount), _emit);

      _emit.speed = c.debrisVelocity;
      _emit.size = c.debrisSize;
      _emit.life = c.debrisLifetime;
      _emit.spin = 8;
      this.debris.emit(Math.round(7 * g.particleCount), _emit);
    }

    this.ctx.shake.add(0.3 * c.shakeIntensity * g.explosionIntensity, 2.2, 18);
    this.lightBoost = c.lightIntensity * 0.25 * g.explosionIntensity;
    this._syncUniforms();
  }

  /** The moment the surface lights: one spike, and then it simply stands. */
  _ignitePortal() {
    const c = settings.portal;
    const g = settings.global;

    this._portalAge = 0;
    this._ignite = 1;

    _local.set(0, Math.max(0.2, c.gateHeight) * 0.6, 0);
    this._toWorld(_local, _pos);

    // A thin pressure shell rather than a fireball: the gate opens, it does not
    // detonate.
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: Math.max(0.3, c.gateWidth * 0.25),
      endRadius: Math.max(1, c.gateWidth) * 1.6 * g.explosionIntensity,
      life: 0.85,
      intensity: 0.9,
      opacity: 0.55,
      displace: 0.35,
      squash: 1.0,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorMid),
      colorC: getColor(c.colorDeep)
    });

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.position, {
      radius: Math.max(c.gateWidth, 2) * 1.8 * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorRim)
    });

    _emit.position = _pos;
    _emit.radius = Math.max(0.3, c.gateWidth * 0.35);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 3.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.moteSize * 1.4;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLife;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(150 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorMid), c.explosionFlash * g.explosionIntensity);
    this.ctx.shake.add(0.35 * c.shakeIntensity * g.explosionIntensity, 2.6, 16);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Standing                                                            */
  /* ------------------------------------------------------------------ */

  /** A point somewhere inside the opening, in world space. */
  _openingPoint(c, out) {
    const hw = Math.max(0.1, c.gateWidth * 0.5);
    const spring = Math.max(0.2, c.gateHeight);
    let x = 0;
    let y = 0;
    // Rejection sampling over the bounding box. Four tries is plenty — the arch
    // fills most of it — and the fallback is the middle of the doorway, which
    // is never wrong.
    for (let i = 0; i < 4; i++) {
      x = randRange(-hw, hw);
      y = randRange(0, spring + hw);
      const dy = y - spring;
      if (y <= spring || x * x + dy * dy <= hw * hw) break;
      x = 0;
      y = spring * 0.5;
    }
    _local.set(x, y, randRange(-0.25, 0.25) * c.gateDepth);
    return this._toWorld(_local, out);
  }

  /** What the gate sheds for as long as it is open. */
  _standingFx(dt) {
    const c = settings.portal;
    const g = settings.global;
    const time = frame.uTime.value;
    const aperture = this._aperture();
    if (aperture < 0.05) return;

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * aperture) * g.particleCount);
    if (moteCount > 0) {
      _emit.position = this._openingPoint(c, _pos);
      _emit.radius = 0.12;
      _emit.direction = _dir.set(randRange(-0.2, 0.2), 1, randRange(-0.2, 0.2));
      _emit.speed = c.moteRise;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.8;
      _emit.life = c.moteLife;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * aperture) * g.particleCount);
    if (mistCount > 0) {
      // The mist bleeds out of the *threshold*, low and wide, so it pools at
      // the foot of the gate the way the reference does.
      _local.set(randRange(-1, 1) * c.gateWidth * 0.45, randRange(0, 0.5), randRange(-1, 1) * c.gateDepth * 0.6);
      _emit.position = this._toWorld(_local, _pos);
      _emit.radius = 0.3;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 0.7;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.size = c.mistSize;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLife;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* The frame loop, in every phase after the travel                     */
  /* ------------------------------------------------------------------ */

  onFade(dt) {
    const c = settings.portal;

    if (this._buildAge >= 0) this._buildAge += dt;
    if (this._portalAge >= 0) this._portalAge += dt;
    if (this._closeAge >= 0) this._closeAge += dt;

    // The surface lights once the keystone has had time to seat.
    if (this._portalAge < 0 && this._closeAge < 0) {
      const built = c.buildTime + c.stoneFly + Math.max(0, c.openDelay);
      if (this._buildAge >= built) this._ignitePortal();
    }

    // The ignition spike is a decay, not a keyframe, so it survives being
    // dragged around in the editor.
    this._ignite = Math.max(0, this._ignite - dt * 2.6);

    // The light hangs in the doorway rather than on the floor. Resolved every
    // frame so the height stays live, and so the camera frames the opening.
    this.position.y = this._portalAge >= 0 ? c.lightHeight : 0;

    this._syncUniforms();
    this._updateStones(dt);
    if (this._closeAge < 0) this._standingFx(dt);
  }

  /* ------------------------------------------------------------------ */
  /* Coming apart                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Shut the gate.
   *
   * Called by `AbilityManager` when a second gate is raised. The base machine
   * has been sitting in IMPACT with an infinite duration; this hands it a FADE
   * to run, which is the only thing that ever retires this ability.
   */
  dismiss() {
    if (!this.isActive || this._closeAge >= 0) return;

    this._closeAge = 0;
    this.phase = AbilityPhase.FADE;
    this.fadeTime = 0;

    const c = settings.portal;
    const g = settings.global;

    if (this._portalAge >= 0) {
      _local.set(0, Math.max(0.2, c.gateHeight) * 0.6, 0);
      this._toWorld(_local, _pos);
      this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
        radius: Math.max(1, c.gateWidth) * 0.7,
        endRadius: Math.max(0.3, c.gateWidth * 0.15),
        life: 0.6,
        intensity: 1.1,
        opacity: 0.6,
        displace: 0.3,
        colorA: getColor(c.colorCore),
        colorB: getColor(c.colorMid),
        colorC: getColor(c.colorDeep)
      });
      this.ctx.shake.add(0.22 * c.shakeIntensity * g.explosionIntensity, 3.0, 18);
    }
  }

  onDestroy() {
    this.surface.visible = false;
    this.halo.visible = false;
    for (const mesh of this.stoneMeshes) mesh.count = 0;
    this._stoneCount = 0;
    this._buildAge = -1;
    this._portalAge = -1;
    this._closeAge = -1;
    for (const record of this.stoneRecords) record.active = false;
  }

  dispose() {
    for (const geometry of this.stoneGeometries) geometry.dispose();
    for (const mesh of this.stoneMeshes) mesh.dispose();
    this.stoneMaterial.dispose();
    this.surfaceGeometry.dispose();
    this.surfaceMaterial.dispose();
    this.haloMaterial.dispose();
    super.dispose();
  }
}
