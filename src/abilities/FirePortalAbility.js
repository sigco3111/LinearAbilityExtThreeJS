import {
  Mesh,
  Vector3,
  Matrix4,
  Quaternion,
  PlaneGeometry,
  ShaderMaterial,
  AdditiveBlending,
  NormalBlending,
  DoubleSide,
  Color
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing } from '../utils/math.js';

const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _local = new Vector3();
const _radial = new Vector3();
const _tangent = new Vector3();
const _inherit = new Vector3();
const _up = new Vector3(0, 1, 0);
const _basis = new Matrix4();
const _quat = new Quaternion();

/**
 * The disc and the ring, in one fragment shader.
 *
 * Two passes and nothing else. `uSurface` 0 is the **way through** — a black
 * disc with a slow warm falloff off its lip, drawn with normal blending so it
 * genuinely paints over the room instead of glowing on top of it. `uSurface` 1
 * is the **ring** the sparks are born on: a bright line on the contour with a
 * short bloom outward and almost none inward, because everything that leaks
 * past the contour is light in the hole, and the hole is the ability.
 *
 * The ring is not simply switched on. It is *drawn*: `uScribe` is how far round
 * a running spark has got, the contour ahead of it does not exist yet, and the
 * contour just behind it is still white-hot. That one uniform is the whole of
 * the opening — the head is a blob at the same angle, the aperture is held shut
 * until it is nearly home, and the emitter follows it round.
 *
 * Everything else you can see is particles.
 */
const PORTAL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PORTAL_FRAGMENT = /* glsl */ `
  uniform float uQuadSize;    // metres across the quad
  uniform float uRadius;      // the clear radius, metres
  uniform float uOpen;        // 0..1 how far the ring has come up
  uniform float uAperture;    // 0..1 how far the way through has opened
  uniform float uRing;        // brightness of the ring
  uniform float uRingWidth;   // how far its bloom reaches outward, metres
  uniform float uRingInner;   // and inward, metres — keep this small
  uniform float uRingHot;     // the white core of the line itself
  uniform float uVoid;        // how black the middle is
  uniform float uVoidWarm;    // warm bounce on the inside of the lip
  uniform float uVoidFeather; // metres the black feathers out into the ring
  uniform float uScribe;      // 0..1 how far round the running spark has got
  uniform float uScribeFeather; // metres of contour the line takes to come up
  uniform float uHead;        // brightness of the running spark itself
  uniform float uHeadSize;    // metres — how big a blob that spark is
  uniform float uTrail;       // metres behind it that are still white-hot
  uniform float uTrailHeat;   // how much hotter than the settled ring that is
  uniform float uSurface;     // 0 = the way through, 1 = the ring
  uniform float uOpacity;
  uniform vec3  uColorRing;
  uniform vec3  uColorHot;
  uniform vec3  uColorVoid;
  uniform vec3  uColorWarm;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  #define TAU 6.28318530718
  #define HALF_PI 1.57079632679

  void main() {
    vec2 p = (vUv - 0.5) * uQuadSize;
    float r = length(p);
    float radius = max(0.1, uRadius);
    float dm = r - radius;              // metres outside the contour, signed

    /* ---- the way through ---- */
    if (uSurface < 0.5) {
      float aperture = uAperture * radius;
      if (aperture < 0.01) discard;
      float hole = smoothstep(aperture, aperture - max(0.02, uVoidFeather), r);
      float alpha = hole * uVoid * uOpacity;
      if (alpha < 0.004) discard;
      // A hint of the fire on the inside of the lip and nothing else. Held
      // deliberately steep and mixed toward the *dead* end of the spark
      // gradient rather than the live one: anything brighter turns the way
      // through into a red plate, and the middle has to go to nearly black or
      // there is no way through to speak of.
      float lip = pow(clamp(r / max(0.05, aperture), 0.0, 1.0), 5.0);
      gl_FragColor = vec4(mix(uColorVoid, uColorWarm, lip * uVoidWarm), alpha);
      return;
    }

    /* ---- the ring the sparks are born on ---- */
    // One falloff with two different widths, NOT two falloffs combined: a
    // one-sided exp is 1 on the side it does not fall off on, so max() of an
    // inward and an outward one is 1 everywhere and floods the whole quad with
    // a flat plate of light. The asymmetry is the point — a long tail outward,
    // nearly a step inward — because light that leaks past the contour is light
    // in the hole, and the hole is the ability.
    float width = dm >= 0.0 ? max(0.02, uRingWidth) : max(0.02, uRingInner);
    float band = exp(-abs(dm) / width);

    // 0..1 round from the foot of the circle, the same zero the emitter counts
    // its turn from — the two have to agree or the sparks come off a place
    // the line has not reached.
    float turn = fract((atan(p.y, p.x) + HALF_PI) / TAU);
    // How far behind the head this piece of contour is, in metres of arc.
    // Negative is ahead of it, and ahead of it there is nothing yet.
    float behind = (uScribe - turn) * TAU * radius;

    // What is NOT drawn is the gap: the arc past the head and short of the
    // seam. Masking on behind alone would be one step at the head and a
    // *cliff* at the seam, where turn wraps 1 to 0 and the mask jumps with it
    // — which slices the ring's bloom down a radial line and hangs a straight
    // edge in the air below the circle. Feathering both ends of the gap instead
    // lets the glow bleed a little back round the start, which is what the
    // beginning of a stroke actually looks like.
    //
    // Both feathers widen with distance off the contour, because the mask is
    // angular and the bloom is not: at the line itself the cut wants to be
    // crisp, and a metre out it wants to be a taper.
    float feather = max(0.02, uScribeFeather) + abs(dm) * 2.5;
    float gap = smoothstep(0.0, feather, -behind)
              * smoothstep(0.0, feather, (1.0 - turn) * TAU * radius);
    float drawn = 1.0 - gap;
    // Still cooling. A settled ring is uRing; a stroke laid down a moment ago
    // is several times that, which is what makes the line read as *drawn*
    // rather than as revealed. Only behind the head — contour it has not
    // reached has nothing to cool from.
    float heat = exp(-max(behind, 0.0) / max(0.05, uTrail)) * uTrailHeat * step(0.0, behind);

    float glow = band * uRing * (1.0 + heat) * drawn;
    // The line itself. Only this is allowed to blow out.
    float core = pow(band, 4.0) * uRingHot * drawn * (1.0 + heat);

    // The running spark. A blob on the contour at the head's own angle, not a
    // piece of the band — it has to sit proud of the line it is laying down.
    float headAngle = -HALF_PI + min(uScribe, 1.0) * TAU;
    float headDist = length(p - vec2(cos(headAngle), sin(headAngle)) * radius);
    float head = exp(-headDist / max(0.03, uHeadSize)) * uHead;

    float fire = (glow + core) * uOpen + head + pow(head, 3.0) * 0.5;
    float alpha = clamp(fire, 0.0, 1.0) * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = mix(uColorRing, uColorHot, clamp(core + head, 0.0, 1.0));
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * FIRE PORTAL — a circle struck in the air, then a black disc behind it.
 *
 * Deliberately the smallest ability in the project, and the only one whose whole
 * picture is made of two things:
 *
 *   - **the way through**, a black disc that irises open from the middle out.
 *     It is drawn with normal blending and writes depth, so it removes the room
 *     rather than glowing over it — every other portal here puts light in its
 *     opening, and this is the one that takes the opening away;
 *   - **the ring**, which is not really a shape at all. It is an *emitter*: a
 *     circle standing in the air that throws stretched sparks off itself on a
 *     tangent, all the way round, every frame. The system's drag is what bends
 *     them into the long curved lines — nothing in here draws a curve, and the
 *     fan is what a wheel throwing sparks actually leaves behind.
 *
 * The colour is the particle system's own lifetime gradient and nothing else:
 * white where a spark is born, orange through the middle of its life, red as it
 * goes out. There is no noise, no shear, no second surface and no dressing —
 * the whole of the look is the ring's line, the disc behind it, and how those
 * four colours are spread across `sparkLife`.
 *
 * It is not switched on, it is **drawn**. A spark is struck at the foot of the
 * circle and runs all the way round it, and three things happen off that one
 * clock: the shader refuses to draw contour the spark has not reached yet, the
 * stroke immediately behind it burns several times hotter than the settled ring
 * and cools over the next couple of metres, and the emitter stops dressing the
 * whole circle and fires from a hand's width of contour behind the head instead
 * — carrying the head's own travel, so the shower trails it. Only once the
 * spark is nearly home is the way through allowed to start irising open inside
 * what it drew. Nothing anywhere holds a stroke: `_scribe` is a function of one
 * age, so scrubbing `draws over` re-times an opening that is already running.
 *
 * It stays lit until another one is cast (`AbilityManager` dismisses the
 * standing one) or the sandbox is cleared. Nothing about it is stored: the ring
 * and the aperture are functions of two ages and of `settings.firePortal`,
 * resolved every frame, so dragging `clear radius` re-hangs a portal that has
 * been standing for a minute — with the clock paused.
 */
export class FirePortalAbility extends Ability {
  constructor(context) {
    super('firePortal', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // Centred unit quad in XY, shared by both passes: a circle hanging in the
    // air has no bottom edge to stand on, so it is placed by its middle.
    this.quadGeometry = new PlaneGeometry(1, 1, 1, 1);

    this.voidMaterial = this._createSurfaceMaterial(false);
    this.voidMesh = new Mesh(this.quadGeometry, this.voidMaterial);
    this.voidMesh.name = 'FirePortalVoid';
    this.voidMesh.layers.set(LAYER.VFX);
    this.voidMesh.renderOrder = 3;
    this.voidMesh.frustumCulled = false;
    this.voidMesh.visible = false;
    this.group.add(this.voidMesh);

    this.ringMaterial = this._createSurfaceMaterial(true);
    this.ringMesh = new Mesh(this.quadGeometry, this.ringMaterial);
    this.ringMesh.name = 'FirePortalRing';
    this.ringMesh.layers.set(LAYER.VFX);
    this.ringMesh.renderOrder = 4;
    this.ringMesh.frustumCulled = false;
    this.ringMesh.visible = false;
    this.group.add(this.ringMesh);

    /* --- the portal's own frame, rebuilt every frame --- */
    this._centre = new Vector3();
    this._ringX = new Vector3(1, 0, 0);
    this._ringY = new Vector3(0, 1, 0);
    this._ringN = new Vector3(0, 0, 1);

    /** Seconds since the portal opened. Negative until it does. */
    this._openAge = -1;
    /** Seconds since it was asked to go out. Negative until it is. */
    this._closeAge = -1;
    /** Where the running spark was last frame, 0..1 round. */
    this._lastScribe = 0;
    /** How fast it is travelling along the contour, metres/second. */
    this._headSpeed = 0;
  }

  /** @param {boolean} ring which of the two passes this material draws */
  _createSurfaceMaterial(ring) {
    return new ShaderMaterial({
      transparent: true,
      // The way through is the one transparent surface here that writes depth,
      // and it has to: sparks on the far side of the portal have no business
      // showing through a hole. The ring is coplanar and drawn after, which a
      // `LessEqualDepth` test passes, so the two never fight.
      depthWrite: !ring,
      depthTest: true,
      blending: ring ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: {
        uGlobalGlow: frame.uGlobalGlow,
        uQuadSize: { value: 6 },
        uRadius: { value: 2 },
        uOpen: { value: 0 },
        uAperture: { value: 0 },
        uRing: { value: 0.85 },
        uRingWidth: { value: 0.18 },
        uRingInner: { value: 0.06 },
        uRingHot: { value: 2.6 },
        uVoid: { value: 1 },
        uVoidWarm: { value: 0.75 },
        uVoidFeather: { value: 0.3 },
        uScribe: { value: 0 },
        uScribeFeather: { value: 0.16 },
        uHead: { value: 0 },
        uHeadSize: { value: 0.2 },
        uTrail: { value: 2.4 },
        uTrailHeat: { value: 1.7 },
        uSurface: { value: ring ? 1 : 0 },
        uOpacity: { value: 1 },
        uColorRing: { value: new Color(1, 0.55, 0.12) },
        uColorHot: { value: new Color(1, 0.96, 0.86) },
        uColorVoid: { value: new Color(0.08, 0.02, 0) },
        uColorWarm: { value: new Color(0.35, 0.07, 0.01) }
      },
      vertexShader: PORTAL_VERTEX,
      fragmentShader: PORTAL_FRAGMENT
    });
  }

  createParticles() {
    // One system, and it is the whole effect. Stretched streaks so what is
    // drawn is the *trail* rather than the spark, high drag so a tangent bends
    // into an arc on its own, and no curl — the fan has to stay coherent.
    this.sparks = this.ctx.particles.get('firePortal.sparks', {
      capacity: 6000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.sparkEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** A standing portal has no impact phase to run out of. @see PortalAbility */
  get impactDuration() {
    return Infinity;
  }

  /** How long it takes to go out, once something has asked it to. */
  get fadeDuration() {
    return Math.max(0.2, settings.firePortal.closeTime);
  }

  get isPersistent() {
    return true;
  }

  /** The camera watches it open, then hands back. */
  get wantsCamera() {
    if (!this.isActive) return false;
    if (this._closeAge >= 0) return false;
    const c = settings.firePortal;
    return this._openAge < 0 || this._openAge < c.scribeTime + c.apertureTime + 0.7;
  }

  /**
   * 0..1 how far round the running spark has got.
   *
   * The single clock the whole opening is hung off: the shader will not draw
   * contour ahead of it, the emitter rides it, and the aperture is not allowed
   * to start until it is nearly home. Eased in *and* out, because a spark that
   * is already at speed on the first frame reads as a wipe rather than as
   * something being struck.
   *
   * Once it is home it stays home — going out is the ring dimming, not the
   * stroke being rubbed back out.
   */
  _scribe(c) {
    if (this._openAge < 0) return 0;
    return Easing.inOutQuad(saturate(this._openAge / Math.max(0.05, c.scribeTime)));
  }

  /** 0..1 how lit the settled ring is, *behind* the head. */
  _open(c) {
    if (this._openAge < 0) return 0;
    const up = Easing.outCubic(saturate(this._openAge / Math.max(0.05, c.openTime)));
    if (this._closeAge < 0) return up;
    return up * (1 - saturate(this._closeAge / (this.fadeDuration * 0.8)));
  }

  /** 0..1 how far the way through has opened. */
  _aperture(c) {
    if (this._openAge < 0) return 0;
    // Held shut until the stroke is nearly closed. The hole cannot appear
    // inside a circle that is not a circle yet — that is the whole reason the
    // draw is worth having, so the delay is a fraction of the *draw*, not of
    // the aperture's own time.
    const delay = Math.max(0, c.scribeTime * saturate(c.apertureDelay));
    const up = Easing.outCubic(
      saturate((this._openAge - delay) / Math.max(0.05, c.apertureTime))
    );
    if (this._closeAge < 0) return up;
    return up * (1 - Easing.inCubic(saturate(this._closeAge / (this.fadeDuration * 0.6))));
  }

  /** Fire gutters rather than shimmers. Two beats at unrelated rates. */
  lightShimmer() {
    const c = settings.firePortal;
    const gutter =
      1 - c.lightFlicker * (0.5 + 0.5 * Math.sin(this.age * 11.3) * Math.sin(this.age * 4.1));
    // The floor is only lit by as much ring as has actually been laid down.
    return gutter * this._open(c) * (0.25 + 0.75 * this._scribe(c));
  }

  onSpawn() {
    this.sparkEmitter.reset();
    this._openAge = -1;
    this._closeAge = -1;
    this._lastScribe = 0;
    this._headSpeed = 0;
    this.voidMesh.visible = false;
    this.ringMesh.visible = false;
  }

  /* ------------------------------------------------------------------ */
  /* The portal's frame                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuild the frame for this instant.
   *
   * Nothing hinges, nothing is stood up and nothing spins as a body: the circle
   * hangs where it was cast, facing the way the cast was aimed. `lean` is the
   * only pose control it has.
   */
  _updateFrame() {
    const c = settings.firePortal;
    const radius = Math.max(0.3, c.ringRadius);
    const cos = Math.cos(c.lean);
    const sin = Math.sin(c.lean);

    // Pitched about the portal's own lateral axis, which is crossed back out of
    // the other two — handing `makeBasis` a left-handed frame would mirror it.
    this._ringY.copy(_up).multiplyScalar(cos).addScaledVector(this.direction, sin);
    this._ringN.copy(this.direction).multiplyScalar(cos).addScaledVector(_up, -sin);
    this._ringX.crossVectors(this._ringY, this._ringN);

    this._centre
      .copy(this.origin)
      .addScaledVector(this.direction, this.length)
      .setY(radius + Math.max(0, c.ringHover));
  }

  /**
   * A point on the ring, and the frame at it.
   *
   * `out` comes back in world space, `_tangent` as the way round the circle and
   * `_radial` as straight out of it — which between them are the entire
   * emission direction.
   */
  _ringPoint(c, turn, out) {
    const angle = -HALF_PI + turn * TAU;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const radius = Math.max(0.3, c.ringRadius);

    _local.set(cos * radius, sin * radius, 0);
    out
      .copy(this._centre)
      .addScaledVector(this._ringX, _local.x)
      .addScaledVector(this._ringY, _local.y);
    _tangent.copy(this._ringX).multiplyScalar(-sin).addScaledVector(this._ringY, cos).normalize();
    _radial.copy(this._ringX).multiplyScalar(cos).addScaledVector(this._ringY, sin).normalize();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Uniforms                                                            */
  /* ------------------------------------------------------------------ */

  _syncUniforms() {
    const c = settings.firePortal;
    const g = settings.global;

    const radius = Math.max(0.3, c.ringRadius);
    const quadSize = (radius + Math.max(c.ringWidth, 0.05) * 6 + 0.3) * 2;
    const open = this._open(c);
    const aperture = this._aperture(c);
    const scribe = this._scribe(c);
    // Once the head is home the mask has to be *unambiguously* off, not merely
    // at its last value: at exactly 1.0 the piece of contour at the seam is
    // zero metres behind the head and would feather back out. Anything past
    // one turn puts every angle a full turn behind it.
    const scribeMask = scribe >= 1 ? 2 : scribe;
    // The head is a spark, and a spark that has arrived has nowhere left to go.
    const head = c.scribeHead * (1 - Easing.inQuad(scribe)) * (this._closeAge < 0 ? 1 : 0);

    for (const material of [this.voidMaterial, this.ringMaterial]) {
      const u = material.uniforms;
      u.uQuadSize.value = quadSize;
      u.uRadius.value = radius;
      u.uOpen.value = open;
      u.uAperture.value = aperture;
      u.uRing.value = c.ring * g.shaderIntensity;
      u.uRingWidth.value = c.ringWidth;
      u.uRingInner.value = c.ringInner;
      u.uRingHot.value = c.ringHot;
      u.uVoid.value = c.voidDark;
      u.uVoidWarm.value = c.voidWarm;
      u.uVoidFeather.value = c.voidFeather;
      u.uScribe.value = scribeMask;
      u.uScribeFeather.value = c.scribeFeather;
      u.uHead.value = head * g.shaderIntensity;
      u.uHeadSize.value = c.scribeHeadSize;
      u.uTrail.value = c.scribeTrail;
      u.uTrailHeat.value = c.scribeTrailHeat;
      u.uColorRing.value.copy(getColor(c.colorRing));
      u.uColorHot.value.copy(getColor(c.colorBirth));
      u.uColorVoid.value.copy(getColor(c.colorVoid));
      // The *dead* end of the spark gradient, not the live one — see the lip.
      u.uColorWarm.value.copy(getColor(c.colorDeath));
    }
    // The black is deliberately not scaled by the global opacity slider — a
    // translucent hole is not a dimmer hole, it is a smear.
    this.voidMaterial.uniforms.uOpacity.value = c.surfaceOpacity;
    this.ringMaterial.uniforms.uOpacity.value = g.opacity;

    _basis.makeBasis(this._ringX, this._ringY, this._ringN);
    _quat.setFromRotationMatrix(_basis);
    for (const mesh of [this.voidMesh, this.ringMesh]) {
      mesh.position.copy(this._centre);
      mesh.quaternion.copy(_quat);
      mesh.scale.set(quadSize, quadSize, 1);
    }
    this.voidMesh.visible = aperture > 0.004;
    this.ringMesh.visible = open > 0.004 || head > 0.004;

    /* --- the sparks: white at birth, orange through, red as they go out --- */
    // This gradient is the entire colour design of the ability. Nothing else
    // tints anything.
    this.sparks.setGradient(
      getColor(c.colorBirth),
      getColor(c.colorEarly),
      getColor(c.colorLate),
      getColor(c.colorDeath)
    );
    const u = this.sparks.uniforms;
    u.uGravity.value.set(0, c.sparkGravity, 0);
    u.uDrag.value = c.sparkDrag;
    u.uStretch.value = c.sparkStretch;
    u.uEndSize.value = c.sparkEndSize;
    u.uFadeIn.value = 0.02;
    u.uFadeOut.value = c.sparkFadeOut;
    u.uTurbulence.value = c.sparkWander * g.turbulence;
    // These are scales on what `emit` was handed, and `emit` is handed the real
    // metres and the real seconds — so they carry the global multiplier and
    // nothing else. Folding the size in here as well (which is what the older
    // abilities do) squares it, and 0.055 squared is a two-centimetre quad
    // fourteen metres from the camera: emitted, alive, and invisible.
    u.uSizeScale.value = g.particleSize;
    u.uLifeScale.value = g.particleLifetime;
    u.uSpeedScale.value = g.particleSpeed;
    u.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* The ring, throwing                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * The emitter, in its two states.
   *
   * **Being drawn.** Every spark is born in a short length of contour *behind
   * the running head* and nowhere else, at a much higher rate, thrown wider and
   * carrying a share of the head's own travel. That is the whole reason the
   * draw reads: the shower is a moving source running round a circle, which is
   * what a struck spark does, rather than a ring dissolving into view.
   *
   * **Settled.** Spread round the circle rather than fired from one place: a
   * few thousand sparks a second is only a few dozen per frame, and putting
   * that handful at one point makes a clump that orbits — a firefly, not a
   * wheel. Each of these is a different place on the ring, so it is dressed all
   * the way round on every frame.
   */
  _throw(dt) {
    const c = settings.firePortal;
    const g = settings.global;
    if (this._openAge < 0 || this._closeAge >= 0) return;

    const scribe = this._scribe(c);
    const drawing = scribe < 1;
    const open = this._open(c);
    if (!drawing && open < 0.02) return;

    // How fast the head is travelling along the contour right now, in metres
    // per second. Differenced rather than derived, so it follows whatever
    // easing `_scribe` happens to be using and costs nothing when paused.
    const radius = Math.max(0.3, c.ringRadius);
    this._headSpeed = dt > 0 ? ((scribe - this._lastScribe) * TAU * radius) / dt : 0;
    this._lastScribe = scribe;

    const rate = drawing ? c.scribeRate : c.sparkRate * open;
    const count = Math.round(this.sparkEmitter.tick(dt, rate) * g.particleCount);
    if (count <= 0) return;

    // The arc a spark may be born on this frame, as a fraction of a turn: a
    // short tail behind the head while it runs, the whole circle once it has.
    const span = drawing ? Math.min(1, c.scribeTail / (TAU * radius)) : 1;
    const outward = drawing ? c.scribeOut : c.sparkOut;
    const speed = drawing ? c.scribeSpeed : c.sparkSpeed;
    const spread = drawing ? c.scribeSpread : c.sparkSpread;

    const time = frame.uTime.value;
    const steps = Math.min(24, count);
    const share = Math.max(1, Math.round(count / steps));
    for (let i = 0; i < steps; i++) {
      this._ringPoint(c, scribe - Math.random() * span, _pos);
      _emit.position = _pos;
      _emit.radius = c.sparkJitter;
      // On a tangent, with a share thrown straight out. The drag on the system
      // does the rest — a straight tangent under drag *is* the curve.
      _emit.direction = _dir
        .copy(_tangent)
        .multiplyScalar(c.sparkSwirl)
        .addScaledVector(_radial, outward)
        .normalize();
      _emit.speed = speed;
      _emit.speedVariance = c.sparkSpeedVariance;
      _emit.spread = spread;
      // A spark struck off something moving leaves with what was carrying it.
      // Without this the shower sits still while its source runs away from it.
      _emit.inherit = drawing
        ? _inherit.copy(_tangent).multiplyScalar(this._headSpeed * c.scribeInherit)
        : null;
      _emit.anchor = null;
      _emit.size = c.sparkSize;
      _emit.sizeVariance = 0.8;
      _emit.life = c.sparkLife;
      _emit.lifeVariance = c.sparkLifeVariance;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(share, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onTravel() {
    // Nothing on the way out. The frame is still rebuilt, because it is what
    // the site resolves to before the portal exists.
    this._updateFrame();
    this._syncUniforms();
  }

  onImpact() {
    this._openAge = 0;
    this._updateFrame();
    this._syncUniforms();
  }

  onFade(dt) {
    if (this._openAge >= 0) this._openAge += dt;
    if (this._closeAge >= 0) this._closeAge += dt;

    this._updateFrame();
    // The light hangs in the middle of the opening, which is also what the
    // camera frames.
    this.position.copy(this._centre);
    this._syncUniforms();
    this._throw(dt);
  }

  /**
   * Put the portal out.
   *
   * Called by `AbilityManager` when a second one is cast. The base machine has
   * been sitting in IMPACT with an infinite duration; this hands it a FADE to
   * run, which is the only thing that ever retires this ability. The ring dims,
   * the hole shuts, and the sparks already in the air live out their lifetimes.
   */
  dismiss() {
    if (!this.isActive || this._closeAge >= 0) return;
    this._closeAge = 0;
    this.phase = AbilityPhase.FADE;
    this.fadeTime = 0;
  }

  onDestroy() {
    this.voidMesh.visible = false;
    this.ringMesh.visible = false;
    this._openAge = -1;
    this._closeAge = -1;
  }

  dispose() {
    this.quadGeometry.dispose();
    this.voidMaterial.dispose();
    this.ringMaterial.dispose();
    super.dispose();
  }
}
