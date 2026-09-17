import {
  InstancedMesh,
  InstancedBufferAttribute,
  Mesh,
  PlaneGeometry,
  CylinderGeometry,
  Object3D,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createKrakenMaterial } from '../materials/KrakenMaterial.js';
import {
  createAbyssFieldMaterial,
  createBrineVeilMaterial
} from '../materials/AbyssFieldMaterial.js';
import { createTentacleGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on arms per cast. The editor's count sliders clamp to this. */
const MAX_ARMS = 26;
/**
 * Two silhouettes: the heavy arms that do the hammering and the thin whips that
 * lash between them. They are separate meshes rather than one scaled mesh
 * because the *taper* differs — a whip is a cord that runs to a hair, an arm is
 * a muscled limb — and no per-instance number recovers that.
 */
const VARIANT = Object.freeze({ ARM: 0, WHIP: 1 });
const VARIANTS = 2;
const TAU = Math.PI * 2;

/**
 * What an arm is for. The role decides where it is seated, how long and how
 * thick it is, how often it strikes and how hard the floor answers.
 */
const Role = Object.freeze({
  ARM: 0, // the heavy limbs on the boundary — these are the ones that smash
  WHIP: 1 // thin lashing cords between them, faster and much lighter
});

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _tip = new Vector3();
const _anchor = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();

/** Shortest signed angle from `b` to `a`, radians, -π..π. */
function angleDelta(a, b) {
  const d = a - b;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * KRAKEN CROWN — the fourth **far cast**, and the first ability in the sandbox
 * made of something that is *alive*.
 *
 * A slick of black water runs out across the floor to the aimed point, the
 * flagstones inside the circle give way, and a ring of cephalopod arms hauls
 * itself out of the rift — uncoiling as it comes, rearing back over the floor —
 * and then **hammers the middle**. Not once: the arms cock and whip down onto
 * the centre of the footprint one after another in a rolling wave for the whole
 * cast, each landing throwing stone, spray and ink, until they all rear
 * together for one synchronised slam and drag themselves back into the hole.
 *
 * **Everything the other crowns are not.** The Glacial and Pyre Crowns are the
 * same ability twice, and their point is that identity lives in the material.
 * This one is the counter-argument: identity can live in the *motion*. Both of
 * those are static once they have bloomed — the shapes stand, they shimmer, they
 * go out. Nothing in either one moves after the first half second. Here the
 * silhouette is never the same on two consecutive frames, and the ability has to
 * be watched rather than glanced at, because the beat is the content:
 *
 *   1. **travel** — the wet surge runs out across the floor, slicking it.
 *   2. **tear** — the rift opens outward to the boundary and the arms come up as
 *      a sweep, the nearest first, the wave running around both sides. Each
 *      arrives *coiled* and uncoils onto its rear as it rises, because that is
 *      what actually comes out of a hole: a curl, opening.
 *   3. **the hammering** — the body of the cast. Every arm runs its own strike
 *      cycle — rear, whip, press, peel — scattered around the ring so the slams
 *      arrive as rolling thunder rather than in unison. The whips run theirs
 *      faster and land far lighter.
 *   4. **the finale** — one strike that ignores the scatter: every arm lands on
 *      the same frame, on the same spot, and the room is hit accordingly.
 *   5. **withdrawal** — the arms shorten back into the rift, tips last, and the
 *      water closes over them.
 *
 * **Why the arms actually hit the middle.** The strike pose is a circular arc —
 * constant curvature, no wave — and for an arc of length `L` turning through
 * `Θ`, the tip lands `L(1−cosΘ)/Θ` along the bend and `L·sinΘ/Θ` above the
 * floor. At `Θ = π` that is `(2L/π, 0)`: on the ground, `2L/π` inward. So an arm
 * of length `πR/2` seated on a footprint of radius `R` strikes its exact centre,
 * and `KrakenAbility` derives every arm's length from `zoneRadius` through that
 * identity rather than from a tuned constant. Drag the footprint slider
 * mid-cast, while the arms are hammering, and they keep hitting the middle. The
 * same closed form gives the CPU the impact point for free — no readback, no
 * guess — which is what every slam's shockwave, debris and spray is
 * placed with.
 *
 * The arms are procedural tubes (`assets/ProceduralGeometry.js`) bent entirely
 * in the vertex shader (`materials/KrakenMaterial.js`, which also owns the skin,
 * the chromatophore waves and the two rows of suckers); the rift and the curtain
 * of spray on its rim are two shaders in `materials/AbyssFieldMaterial.js`; and
 * the ink, spray, marine snow and shattered stone are GPU particles.
 *
 * **The rule that makes the editor work,** as everywhere else here: an arm's
 * record holds nothing but dice — a role, a bearing, a splay and a handful of
 * jitters. Not one metre, radian or second is captured. Length, thickness, seat,
 * every pose and every beat of the strike cycle are resolved against
 * `settings.kraken` inside the update loop, which runs on a zero-length frame
 * too. The only value a record stores is the timestamp of the strike it last
 * fired an impact for — an event, not a dimension.
 */
export class KrakenAbility extends Ability {
  constructor(context) {
    super('kraken', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createKrakenMaterial();

    /** Signature of the geometry controls, so a rebuild only happens on a change. */
    this._shapeKey = '';

    this.meshes = [];
    this.shapeAttributes = [];
    this.waveAttributes = [];
    this.lifeAttributes = [];

    for (let v = 0; v < VARIANTS; v++) {
      const geometry = this._buildGeometry(v);

      const shapes = new InstancedBufferAttribute(new Float32Array(MAX_ARMS * 4), 4);
      const waves = new InstancedBufferAttribute(new Float32Array(MAX_ARMS * 4), 4);
      const lives = new InstancedBufferAttribute(new Float32Array(MAX_ARMS * 4), 4);
      geometry.setAttribute('aShape', shapes);
      geometry.setAttribute('aWave', waves);
      geometry.setAttribute('aLife', lives);

      const mesh = new InstancedMesh(geometry, this.material, MAX_ARMS);
      // No shadows, for the same reason the fire-blades cast none: the arm's
      // length is a `discard` against a noisy front in the fragment shader and
      // its *shape* is a vertex-stage bend, neither of which a depth-only
      // shadow pass would know anything about. A shadow caster here would throw
      // a straight, full-length silhouette of an arm that is neither.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // The resting geometry is a straight tube; the drawn one is a bent arm
      // several metres away from it. Culling on the baked bounds pops arms out
      // of the picture at the edge of the frame.
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid, lit world geometry — it belongs in the depth prepass so the ink,
      // the spray and the brine curtain all fade softly against it.
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      this.group.add(mesh);

      this.meshes.push(mesh);
      this.shapeAttributes.push(shapes);
      this.waveAttributes.push(waves);
      this.lifeAttributes.push(lives);
    }

    /* ---- the rift on the floor ---- */
    this.fieldGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.fieldMaterial = createAbyssFieldMaterial();
    this.field = new Mesh(this.fieldGeometry, this.fieldMaterial);
    this.field.name = 'AbyssField';
    this.field.layers.set(LAYER.VFX);
    this.field.renderOrder = 7; // over the decals, under the arms
    this.field.frustumCulled = false;
    this.field.visible = false;
    this.group.add(this.field);

    /* ---- the curtain of spray hanging over its rim ---- */
    this.veilGeometry = new CylinderGeometry(1, 1, 1, 64, 10, true);
    this.veilMaterial = createBrineVeilMaterial();
    this.veil = new Mesh(this.veilGeometry, this.veilMaterial);
    this.veil.name = 'BrineVeil';
    this.veil.layers.set(LAYER.VFX);
    this.veil.renderOrder = 9;
    this.veil.frustumCulled = false;
    this.veil.visible = false;
    this.group.add(this.veil);

    /**
     * Fixed-size record pool — a cast allocates nothing.
     *
     * See the class comment: dice only, no dimensions.
     */
    this.records = [];
    for (let i = 0; i < MAX_ARMS; i++) {
      this.records.push({
        role: Role.ARM,
        slot: 0, // instance slot within its variant's mesh
        angle: 0, // bearing about the centre, radians
        splay: 0, // -1..1 — how far off the radius it strikes
        seatJitter: 0,
        lengthJitter: 0,
        thickJitter: 0,
        turnJitter: 0, // -1..1 on the strike's total turn
        twistJitter: 0,
        wavePhase: 0,
        waveJitter: 0,
        cyclePhase: 0, // 0..1 — where in the ring's rolling wave it strikes
        stagger: 0,
        breached: false,
        lastStrike: -1 // the strike timestamp it last threw an impact for
      });
    }

    this._activeCount = 0;
    this._drawn = 0;
    /** Re-rolled per cast so no two crowns come up the same. */
    this._seed = 0;
    /** Seconds since the rift started tearing. The clock the whole beat runs on. */
    this._openTime = 0;
    /** Bearing the surge arrived on — where the sweep starts, and where it ends. */
    this._entryAngle = 0;
    this._slickDistance = 0;
    /** Set the frame the synchronised finale lands, so it is only staged once. */
    this._finaleFired = false;

    // Scratch state handed to the shaders and the pose solver each frame. One
    // object apiece, reused — a standing crown allocates nothing.
    this._state = { centre: new Vector3() };
    this._fieldState = { radius: 1, quadSize: 1, open: 0, fade: 1, seed: 0 };
    this._veilState = { fade: 1, seed: 0 };
    /** The pose the solver writes into: lean, curl, wave amplitude, twist. */
    this._pose = { lean: 0, curl: 0, wave: 0, twist: 0, flash: 0, squash: 1 };
    /** The strike solver's answer: when this arm's current strike lands. */
    this._strike = { time: 0, finale: false, wind: 1 };
  }

  /** One arm shape. `variant` picks the heavy limb or the thin whip. */
  _buildGeometry(variant) {
    const c = settings.kraken;
    const whip = variant === VARIANT.WHIP;
    return createTentacleGeometry({
      seed: 3.7 + variant * 17.3,
      rings: Math.round(c.rings),
      sides: Math.round(c.sides),
      // A whip runs to a hair; an arm keeps some meat all the way out.
      taper: whip ? c.taper * 0.35 : c.taper,
      swell: whip ? 1 + (c.swell - 1) * 0.4 : c.swell,
      swellAt: c.swellAt,
      roughness: c.armRoughness,
      flatten: c.flatten
    });
  }

  /**
   * Regenerate the arm meshes when a *shape* control moves.
   *
   * Ring count, side count, taper, swell and flattening are baked into the tube
   * because none of them is expressible as a per-instance number — and a
   * forty-four-ring arm is about a thousand triangles, cheap enough to simply
   * rebuild rather than approximate. That is what keeps them live sliders.
   */
  _syncGeometry() {
    const c = settings.kraken;
    const key =
      `${Math.round(c.rings)}|${Math.round(c.sides)}|${c.taper.toFixed(3)}` +
      `|${c.swell.toFixed(3)}|${c.swellAt.toFixed(3)}|${c.armRoughness.toFixed(3)}` +
      `|${c.flatten.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.meshes[v];
      const previous = mesh.geometry;
      const geometry = this._buildGeometry(v);
      // The per-instance attributes are state, not shape — carry them over.
      geometry.setAttribute('aShape', this.shapeAttributes[v]);
      geometry.setAttribute('aWave', this.waveAttributes[v]);
      geometry.setAttribute('aLife', this.lifeAttributes[v]);
      mesh.geometry = geometry;
      previous.dispose();
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Ink. Non-additive and very dark: this is the one particle system in the
    // project whose whole job is to *take light away*, and it is what makes the
    // rift read as deep rather than as a lit disc on the floor.
    this.ink = particles.get('kraken.ink', {
      capacity: 3600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.ink.uniforms.uDrag.value = 1.9;
    this.ink.uniforms.uEndSize.value = 4.0;
    this.ink.uniforms.uSizeIn.value = 0.1;
    this.ink.uniforms.uFadeIn.value = 0.1;
    this.ink.uniforms.uFadeOut.value = 0.35;

    // Water thrown off the arms and off the floor they hit. Lit rather than
    // emissive, so a slam throws something with weight in it.
    this.spray = particles.get('kraken.spray', {
      capacity: 3600,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      curl: true,
      softFade: 0.3
    });
    this.spray.uniforms.uDrag.value = 0.7;
    this.spray.uniforms.uEndSize.value = 0.55;
    this.spray.uniforms.uSizeIn.value = 0.06;
    this.spray.uniforms.uFadeOut.value = 0.45;

    // The stone the arms break out of the floor. Chips, lit, heavy.
    this.debris = particles.get('kraken.debris', {
      capacity: 2600,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.debris.uniforms.uDrag.value = 0.15;
    this.debris.uniforms.uEndSize.value = 0.75;
    this.debris.uniforms.uFadeOut.value = 0.75;

    // This ability's signature system: **marine snow**. Bioluminescent motes
    // that came up with the water and are now drifting through the ring, barely
    // falling, turning slowly around the throat.
    //
    // Every other crown's air is in a hurry — the Glacial Crown's snow falls
    // through its ring, the Pyre Crown's embers race up out of its crater. This
    // one's hangs. At `uDrag` this high with near-zero gravity the motes lose
    // their launch speed almost immediately and then simply *sit* there, which
    // is exactly what suspended matter in water does and what nothing else in
    // the project does at all.
    this.motes = particles.get('kraken.motes', {
      capacity: 2600,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      curl: true,
      softFade: 0.5
    });
    this.motes.uniforms.uDrag.value = 2.6;
    this.motes.uniforms.uEndSize.value = 0.5;
    this.motes.uniforms.uSizeIn.value = 0.1;
    this.motes.uniforms.uFadeIn.value = 0.18;
    this.motes.uniforms.uFadeOut.value = 0.5;

    this.inkEmitter = new RateEmitter();
    this.sprayEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.slickEmitter = new RateEmitter();
    this.rippleEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._drawn;
  }

  /** The rift opens, the arms hammer, the finale lands. */
  get impactDuration() {
    return Math.max(0.6, settings.kraken.lifetime * settings.global.lifetime);
  }

  /** Withdrawal: a beat after the finale, then the arms are pulled back in. */
  get fadeDuration() {
    const c = settings.kraken;
    return Math.max(0.2, c.withdrawDelay + c.withdrawTime + c.withdrawStagger);
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.kraken.zoneRadius);
  }

  /**
   * The light under a rift does not flicker — it *swells*. Two slow beats
   * against each other, so the ring breathes rather than gutters, and one fast
   * ripple far down in the mix so it never sits perfectly still.
   */
  lightShimmer() {
    const t = this.age;
    return 0.82 + 0.18 * Math.sin(t * 1.7) * Math.sin(t * 0.9) + 0.04 * Math.sin(t * 11.3);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The centre of the crown — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the cast leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.kraken;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /**
   * How far the rift has torn open, 0..1 of the boundary.
   *
   * A pure function of `_openTime` against the live `openTime`, so it re-times
   * itself if the slider moves mid-cast.
   */
  _openAmount() {
    const open = Math.max(0.02, settings.kraken.openTime);
    return Easing.outCubic(saturate(this._openTime / open));
  }

  /** How far the rift has closed back over the arms, 0..1. */
  _closeAmount() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const c = settings.kraken;
    const hold = c.withdrawDelay * 0.5;
    return saturate((this.fadeTime - hold) / Math.max(0.05, this.fadeDuration - hold));
  }

  /** How far out the arm is seated, metres from the centre. */
  _seatRadius(record, c) {
    const R = this.radius;
    return record.role === Role.ARM
      ? R * (c.ringSeat + record.seatJitter * c.ringScatter)
      : R * (c.whipSeat + record.seatJitter * c.whipScatter);
  }

  /**
   * The bearing the arm bends *along* — inward, plus its own splay.
   *
   * The splay is what stops nine arms converging on a single point like the ribs
   * of an umbrella: each one is aimed a little off the centre, so they cross
   * over the throat and pile onto each other instead of meeting in a rosette.
   */
  _bendBearing(record, c) {
    return record.angle + Math.PI + record.splay * c.splay;
  }

  /**
   * Length of the arm, metres.
   *
   * Derived from the footprint through the arc identity in the class comment:
   * `L = reach · (π/2) · R` puts the point of the arm on the centre of the
   * circle when it turns through π. `reach` above 1 sends it past the middle,
   * which is what makes the arms cross rather than kiss.
   */
  _armLength(record, c) {
    const base = this.radius * (Math.PI / 2) * c.reach;
    const roleScale = record.role === Role.ARM ? 1 : c.whipLength;
    return Math.max(
      0.2,
      base * roleScale * (1 + record.lengthJitter * c.lengthJitter * settings.global.randomness)
    );
  }

  /** Base radius of the arm where it leaves the rift, metres. */
  _armThickness(record, c) {
    const roleScale = record.role === Role.ARM ? 1 : c.whipThickness;
    return Math.max(
      0.01,
      c.thickness * roleScale * (1 + record.thickJitter * c.thicknessJitter * settings.global.randomness)
    );
  }

  /**
   * The total turn of this arm's strike, radians. π puts the tip exactly on the
   * floor.
   *
   * The jitter is deliberately **one-sided**. Turning less than π leaves the
   * point hanging in the air above the crater with a shockwave going off under
   * it, which is the one way this can look wrong; turning more drives the last
   * of the arm *through* the floor, where the ground hides it and it reads as
   * having hit something. So every arm lands at or past the surface, never short
   * of it.
   */
  _strikeTurn(record, c) {
    return c.strikeTurn * (1 + Math.abs(record.turnJitter) * c.turnJitter);
  }

  /**
   * Where this arm's point lands, in world space.
   *
   * The closed form for a circular arc, which is exactly the pose the strike
   * uses — so this is not an estimate of the impact point, it *is* the impact
   * point, available on the CPU without reading anything back off the GPU.
   */
  _strikePoint(record, c, out) {
    const centre = this._state.centre;
    const seat = this._seatRadius(record, c);
    const bearing = this._bendBearing(record, c);
    const L = this._armLength(record, c);
    const turn = Math.max(0.05, this._strikeTurn(record, c));

    const along = (L * (1 - Math.cos(turn))) / turn;
    const up = (L * Math.sin(turn)) / turn;

    return out.set(
      centre.x + Math.cos(record.angle) * seat + Math.cos(bearing) * along,
      Math.max(0, up),
      centre.z + Math.sin(record.angle) * seat + Math.sin(bearing) * along
    );
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.kraken;

    this.inkEmitter.reset();
    this.sprayEmitter.reset();
    this.moteEmitter.reset();
    this.slickEmitter.reset();
    this.rippleEmitter.reset();

    this._slickDistance = 0;
    this._openTime = 0;
    this._finaleFired = false;
    this._seed = Math.random() * 100;
    // The sweep starts on the near side: the bearing from the centre back toward
    // the caster, which is the bearing the surge arrives on.
    this._entryAngle = Math.atan2(-this.direction.z, -this.direction.x);

    const density = Math.max(0.05, c.density);
    const arms = Math.max(1, Math.round(c.armCount * density));
    const whips = Math.max(0, Math.round(c.whipCount * density));
    const wanted = Math.min(MAX_ARMS, arms + whips);
    const armCount = Math.min(arms, wanted);

    this._activeCount = wanted;

    const used = [0, 0];
    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];
      const isArm = i < armCount;

      record.role = isArm ? Role.ARM : Role.WHIP;
      const variant = isArm ? VARIANT.ARM : VARIANT.WHIP;
      record.slot = used[variant]++;

      // Evenly stepped around the circle with a jittered stride, so the ring has
      // no gaps but never looks stamped. The two roles are stepped separately
      // and the whips are offset half a stride, so they fall *between* the arms.
      const count = isArm ? armCount : Math.max(1, wanted - armCount);
      const index = isArm ? i : i - armCount;
      const offset = isArm ? 0 : 0.5;
      record.angle = ((index + offset + randRange(-0.3, 0.3)) / count) * TAU;

      record.splay = randRange(-1, 1);
      record.seatJitter = randRange(-1, 1);
      record.lengthJitter = randRange(-1, 1);
      record.thickJitter = randRange(-1, 1);
      record.turnJitter = randRange(-1, 1);
      record.twistJitter = randRange(-1, 1);
      record.waveJitter = randRange(-1, 1);
      record.wavePhase = Math.random() * TAU;
      record.cyclePhase = Math.random();
      record.stagger = Math.random();
      record.breached = false;
      record.lastStrike = -1;
    }

    for (let i = wanted; i < MAX_ARMS; i++) this.records[i].lastStrike = -1;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    this._drawn = 0;

    this.field.visible = false;
    this.veil.visible = false;

    this._sync(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* The beat                                                            */
  /* ------------------------------------------------------------------ */

  /** Seconds after the rift opens before this arm starts coming out. */
  _armDelay(record, c) {
    // 0 on the near side, 1 at the far side — the two arms of the wave meet
    // behind the crown, exactly as the two crowns before it.
    const around = Math.abs(angleDelta(record.angle, this._entryAngle)) / Math.PI;
    const roleDelay = record.role === Role.ARM ? 0 : c.whipDelay;
    return around * c.sweepTime + record.stagger * c.stagger + roleDelay;
  }

  /** How long one full rear-whip-press-peel cycle takes for this arm. */
  _cyclePeriod(record, c) {
    const scale = record.role === Role.ARM ? 1 : c.whipPeriod;
    return Math.max(0.25, c.smashPeriod * scale);
  }

  /**
   * How far the four beats of a strike have to be squeezed to fit the period.
   *
   * The whips lash at well under half an arm's period, and rear-whip-press-peel
   * at full length simply does not fit inside it. Scaling all four by one factor
   * is not only how they fit — it is what keeps the pose *continuous* across the
   * seam: at exactly 1 the peel ends on the resting pose and the next wind-up
   * starts from it, and at anything below 1 the peel of one strike ends on the
   * very frame the next wind-up begins. Let the beats overrun the period instead
   * and the arm snaps from resting straight into the middle of a whip.
   */
  _cycleFit(c, period) {
    const beats = c.rearTime + c.strikeTime + c.holdTime + c.peelTime;
    return beats > 1e-4 ? Math.min(1, period / beats) : 1;
  }

  /**
   * When this arm's current strike lands, whether it is the finale, and how far
   * the wind-up to it has to be compressed — written into `this._strike`.
   *
   * Strikes run on a fixed period from the arm's own first one, scattered around
   * the ring by `cycleScatter`, on a clock already offset by the sweep that
   * brought the arm out of the rift — so the slams arrive as rolling thunder.
   * Then the last one is not on that clock at all: every arm lands on the
   * finale, together, on the same spot. That contrast is the whole point of
   * scattering them in the first place — a wave of slams reads as many things
   * hammering, and one slam after a wave of them reads as all of them agreeing.
   *
   * **Making that switch invisible is the hard part**, and it is worth spelling
   * out, because the obvious implementations all pop. An arm cannot simply
   * abandon its cycle for the finale at some fixed lead: it may be halfway
   * through peeling off its last landing at that moment, and jumping from there
   * into a wind-up teleports the point of the arm several metres in one frame.
   * So instead:
   *
   *   - the arm runs its cycle out to the **last strike whose aftermath finishes
   *     before the finale**, so it is never interrupted;
   *   - at the instant that aftermath ends — which is exactly the instant it
   *     reaches its resting pose — it takes the finale as its target;
   *   - and the wind-up is **compressed into the time actually left** (`wind`).
   *     That is what closes the last gap: whether there is a second to spare or
   *     a tenth, the arm is at rest on the frame it switches and the rear begins
   *     from zero, so the pose is continuous either way.
   *
   * Every branch is a pure function of the live settings and the arm's dice, so
   * dragging the period, the blaze length or the finale's lead re-times a crown
   * that is already hammering.
   */
  _strikeTime(record, c, local, delay) {
    const out = this._strike;
    const period = this._cyclePeriod(record, c);
    const fit = this._cycleFit(c, period);
    const rise = Math.max(0.05, c.riseTime);
    const tail = (c.holdTime + c.peelTime) * fit;
    const windup = (c.rearTime + c.strikeTime) * fit;

    // The earliest a strike may land is a full wind-up after the arm has
    // finished coming out of the rift. Without that term the wind-up would start
    // while the arm was still uncoiling, and the pose would jump from the middle
    // of the emergence straight into the middle of a whip on the frame the two
    // met.
    const first = rise + windup + record.cyclePhase * period * saturate(c.cycleScatter);
    const finale = this.impactDuration - c.finaleLead - delay;

    if (finale > 0) {
      // The last cyclic strike with room to finish *and* be wound up out of
      // before the finale. Subtracting the wind-up here is what guarantees the
      // arm has the whole authored rear to play once it takes the finale as its
      // target; below zero there is room for none, and it goes from the rift
      // straight to the finale.
      const n = Math.floor((finale - tail - windup - first) / period);
      const handover = n >= 0 ? first + n * period + tail : rise;

      if (local >= handover) {
        out.time = finale;
        out.finale = true;
        out.wind = saturate(Math.max(0.02, finale - handover) / Math.max(0.02, windup));
        return out;
      }
    }

    // Before the arm's first strike there is nothing behind it to peel off —
    // clamping here rather than letting the floor division run negative is what
    // stops a freshly risen arm snapping into the aftermath of a landing that
    // never happened.
    if (local < first) {
      out.time = first;
    } else {
      const current = first + Math.floor((local - first) / period) * period;
      // Past the aftermath of the current strike we are already winding up to
      // the next one, which is what the pose has to be solved against.
      out.time = local < current + tail ? current : current + period;
    }
    out.finale = false;
    out.wind = 1;
    return out;
  }

  /**
   * Solve the arm's pose for this frame into `this._pose`.
   *
   * Four named poses and a clock. `d` is seconds relative to the strike landing,
   * so it is negative on the way in and positive on the way out, and the whole
   * cycle is a walk between poses on that one number:
   *
   *   - **coil** — how it arrives. A tight curl, because that is what comes out
   *     of a hole. Only used while the arm is still rising.
   *   - **idle** — arched over the ring with the point curling back in over the
   *     middle, carrying the travelling wave. This is the arm at rest, and it is
   *     never still.
   *   - **rear** — cocked: bowed hard *out* over the floor, and with only half
   *     the curl of the idle pose, so the point stands up behind the ring rather
   *     than over it. That combination is what makes a wind-up read as a wind-up
   *     — the tip has to move *away* from where it is about to go. Reached with
   *     an ease-out, so the arm settles into it and hangs there for a beat.
   *   - **strike** — the circular arc that lands the point on the middle.
   *     Reached with a quadratic ease-*in*, which is the read of the smash: the
   *     first half of the strike covers a quarter of the arc and the second half
   *     covers the rest. A linear whip has no snap in it, and a steeper curve
   *     than this puts most of a nine-metre sweep into a single frame, which is
   *     not a fast strike — it is an invisible one.
   *
   * After it lands the arm holds, ringing on a decaying wobble, then peels back
   * to idle and starts the next wind-up.
   */
  _solvePose(record, c, d, emerge, fit, wind) {
    const pose = this._pose;
    const wave = c.waveIdle * (1 + record.waveJitter * 0.4);

    /* ---- still coming out of the rift ---- */
    if (emerge < 1) {
      const x = Easing.outCubic(emerge);
      pose.lean = lerp(c.coilLean, c.idleLean, x);
      pose.curl = lerp(c.coilCurl, c.idleCurl, x);
      pose.wave = lerp(c.waveCoil, wave, x);
      pose.twist = c.twist * (1 + record.twistJitter * 0.5) * lerp(1.6, 1, x);
      pose.flash = 0;
      pose.squash = lerp(1.35, 1, x); // thicker as it hauls itself out
      return pose;
    }

    pose.twist = c.twist * (1 + record.twistJitter * 0.5);
    pose.squash = 1;
    pose.flash = 0;

    // `fit` squeezes the four beats into the period; `wind` squeezes the two
    // that lead into a landing down to the time actually left before it. Both
    // are applied here rather than in the schedule, so the pose stays a pure
    // function of one clock.
    const budget = (c.rearTime + c.strikeTime) * fit * wind;
    // The whip keeps its authored length wherever there is room for it, and is
    // never allowed more than most of the budget: a strike squeezed into three
    // frames stops being a strike and becomes a cut. Everything else the
    // compression takes comes out of the rear, which can absorb it — a shorter
    // wind-up is just a faster wind-up.
    const strikeDur = Math.max(0.02, Math.min(c.strikeTime * fit, budget * 0.6));
    const rearDur = Math.max(0.02, budget - strikeDur);
    const holdDur = Math.max(0.02, c.holdTime * fit);
    const peelDur = Math.max(0.02, c.peelTime * fit);
    const turn = this._strikeTurn(record, c);

    if (d < -(rearDur + strikeDur)) {
      /* ---- at rest, writhing ---- */
      pose.lean = c.idleLean;
      pose.curl = c.idleCurl;
      pose.wave = wave;
    } else if (d < -strikeDur) {
      /* ---- rearing back ---- */
      const x = Easing.outCubic(saturate((d + rearDur + strikeDur) / rearDur));
      pose.lean = lerp(c.idleLean, c.rearLean, x);
      pose.curl = lerp(c.idleCurl, c.rearCurl, x);
      pose.wave = lerp(wave, c.waveRear, x);
    } else if (d < 0) {
      /* ---- the whip ---- */
      const x = saturate(1 + d / strikeDur);
      // Quadratic ease-*in*: the first half of the strike covers a quarter of
      // the arc and the second half covers the rest, which is the whole read of
      // a whip. It is deliberately not steeper than that — the tip travels about
      // nine metres, and a quartic here puts forty per cent of that into the
      // final frame, at which point the strike stops being visible at all and
      // becomes a cut between two poses.
      const e = x * x;
      // Landing on `lean = Θ, curl = 0` and not the other way round: a constant
      // curvature is the *only* profile whose tip position has a closed form,
      // and that closed form is what places the impact. Putting the turn in the
      // quadratic term would land the point somewhere else entirely.
      pose.lean = lerp(c.rearLean, turn, e);
      pose.curl = lerp(c.rearCurl, 0, e);
      pose.wave = lerp(c.waveRear, c.waveStrike, e);
      pose.squash = 1 + e * c.strikeSquash;
    } else if (d < holdDur) {
      /* ---- pressed against the floor, ringing ---- */
      const x = saturate(d / holdDur);
      // A decaying wobble on the curl only: the tip stays planted and the length
      // of the arm shivers, which is what a heavy thing that just landed does.
      const ring = Math.exp(-x * 5.0) * Math.sin(d * c.settleSpeed) * c.settle;
      pose.lean = turn;
      pose.curl = ring;
      pose.wave = c.waveStrike;
      pose.flash = 1 - Easing.outQuad(x);
      pose.squash = 1 + c.strikeSquash * (1 - x) * 0.6;
    } else {
      /* ---- peeling back off it ---- */
      const x = Easing.inOutCubic(saturate((d - holdDur) / peelDur));
      pose.lean = lerp(turn, c.idleLean, x);
      pose.curl = lerp(0, c.idleCurl, x);
      pose.wave = lerp(c.waveStrike, wave, x);
    }

    return pose;
  }

  /**
   * Rebuild every instance matrix and per-instance attribute from the live
   * settings. This is the ability.
   */
  _updateArms() {
    const c = settings.kraken;
    const used = [0, 0];
    const t = this._openTime;
    const rise = Math.max(0.05, c.riseTime);
    const withdrawing = this.phase === AbilityPhase.FADE;

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      const variant = record.role === Role.ARM ? VARIANT.ARM : VARIANT.WHIP;
      const slot = record.slot;
      used[variant] = Math.max(used[variant], slot + 1);

      const delay = this._armDelay(record, c);
      const local = t - delay;
      const fit = this._cycleFit(c, this._cyclePeriod(record, c));

      if (local < 0) {
        // Still below. Park it outside the view rather than drawing a
        // degenerate matrix at the origin.
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        this._parkAttributes(variant, slot);
        continue;
      }

      const emerge = saturate(local / rise);
      const solved = this._strikeTime(record, c, local, delay);
      const strike = solved.time;
      const finale = solved.finale;
      const d = local - strike;

      const pose = this._solvePose(record, c, d, emerge, fit, solved.wind);

      /* --- the moment it lands --- */
      if (d >= 0 && record.lastStrike !== strike && emerge >= 1) {
        record.lastStrike = strike;
        this._strikePoint(record, c, _tip);
        this._smashFx(record, c, _tip, finale);
      }
      if (!record.breached && emerge > 0.15) {
        record.breached = true;
        this._breachFx(record, c);
      }

      /* --- withdrawal: pulled back down into the rift, point last --- */
      let retract = 0;
      if (withdrawing) {
        const start = c.withdrawDelay + record.stagger * c.withdrawStagger;
        retract = Easing.inOutCubic(
          saturate((this.fadeTime - start) / Math.max(0.05, c.withdrawTime))
        );
      }

      /* --- resolve it into metres and radians --- */
      const length = this._armLength(record, c) * (1 - retract * 0.96);
      const reveal = emerge * (1 - retract * 0.15);
      const thickness = this._armThickness(record, c) * pose.squash * (1 - retract * 0.3);
      const seat = this._seatRadius(record, c);
      const bearing = this._bendBearing(record, c);
      const centre = this._state.centre;

      _dummy.position.set(
        centre.x + Math.cos(record.angle) * seat,
        0,
        centre.z + Math.sin(record.angle) * seat
      );
      // Yaw the instance so the arm's own +X — the direction its bend turns
      // toward, and the side its suckers are on — points at the middle.
      _dummy.quaternion.setFromAxisAngle(_up, -bearing);
      _dummy.updateMatrix();
      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);

      // While it is retracting the whole arm also settles into the hole, so the
      // last of it goes under rather than shrinking to a stub on the floor.
      const sink = retract * c.withdrawSink;

      this._writeAttributes(variant, slot, record, pose, length, thickness, reveal, sink);
    }

    this._drawn = 0;
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.shapeAttributes[v].needsUpdate = true;
      this.waveAttributes[v].needsUpdate = true;
      this.lifeAttributes[v].needsUpdate = true;
      this._drawn += used[v];
    }
  }

  /** Pack one arm's pose into the three instanced vec4s the material reads. */
  _writeAttributes(variant, slot, record, pose, length, thickness, emerge, sink) {
    const c = settings.kraken;
    const i4 = slot * 4;

    const shape = this.shapeAttributes[variant].array;
    shape[i4 + 0] = length;
    shape[i4 + 1] = thickness;
    shape[i4 + 2] = pose.lean;
    shape[i4 + 3] = pose.curl;

    const waves = this.waveAttributes[variant].array;
    waves[i4 + 0] = pose.wave;
    // The wave travels because its phase advances with time. Everything else
    // about the arm is a pose; this is the one thing that is a *motion*, and it
    // is what keeps a resting arm alive between strikes.
    waves[i4 + 1] = record.wavePhase - this.age * c.waveSpeed * TAU;
    waves[i4 + 2] = pose.twist;
    waves[i4 + 3] = Math.max(0.1, c.waveFreq * (1 + record.waveJitter * 0.25));

    const lives = this.lifeAttributes[variant].array;
    lives[i4 + 0] = emerge;
    lives[i4 + 1] = pose.flash;
    lives[i4 + 2] = record.wavePhase * 1.7 + record.cyclePhase * 3.3;
    lives[i4 + 3] = sink;
  }

  /** Zero an instance that has not come out of the rift yet. */
  _parkAttributes(variant, slot) {
    const i4 = slot * 4;
    const shape = this.shapeAttributes[variant].array;
    const waves = this.waveAttributes[variant].array;
    const lives = this.lifeAttributes[variant].array;
    for (let k = 0; k < 4; k++) {
      shape[i4 + k] = 0;
      waves[i4 + k] = 0;
      lives[i4 + k] = 0;
    }
    // A zero wave frequency is a divide-free no-op in the shader, but a zero
    // *length* is what actually makes the instance disappear.
    waves[i4 + 3] = 1;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into the arm material,
   * the rift, the curtain of spray and the four particle systems.
   *
   * @param {number} fade 1 while the crown stands, ramping to 0 as it leaves
   */
  _sync(fade) {
    const c = settings.kraken;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(this._state.centre);
    this._syncGeometry();
    this.material.userData.sync();

    const centre = this._state.centre;
    const radius = this.radius;
    const open = travelling ? 0 : this._openAmount();
    const close = this._closeAmount();
    const spread = open * (1 - close);

    /* --- the rift --- */
    const fieldState = this._fieldState;
    fieldState.radius = radius;
    fieldState.quadSize = (radius + c.fieldBoundary + 0.8) * 2;
    fieldState.open = spread;
    fieldState.fade = fade;
    fieldState.seed = this._seed;
    this.fieldMaterial.userData.sync(fieldState);

    this.field.visible = !travelling && spread > 0.002 && fade > 0.002;
    this.field.position.set(centre.x, c.fieldHeight, centre.z);
    this.field.scale.set(fieldState.quadSize, 1, fieldState.quadSize);

    /* --- the curtain of spray on its rim --- */
    const veilHeight = Math.max(0.05, c.veilHeight * Easing.outCubic(open));
    const veilState = this._veilState;
    veilState.fade = fade * (1 - close);
    veilState.seed = this._seed;
    this.veilMaterial.userData.sync(veilState);

    this.veil.visible = !travelling && c.veil > 0.001 && open > 0.02 && veilState.fade > 0.004;
    this.veil.position.set(centre.x, veilHeight * 0.5, centre.z);
    this.veil.scale.set(radius * c.veilRadius, veilHeight, radius * c.veilRadius);
    this.veil.rotation.y = this._seed + this.age * c.veilSpin * TAU;

    /* --- the four particle systems --- */
    this.ink.setGradient(
      getColor(c.colorInkA),
      getColor(c.colorInkB),
      getColor(c.colorInkC),
      getColor(c.colorInkD)
    );
    this.ink.uniforms.uGravity.value.set(0, c.inkRise, 0);
    this.ink.uniforms.uSizeScale.value = c.inkSize * g.particleSize;
    this.ink.uniforms.uLifeScale.value = c.inkLifetime * 0.5 * g.particleLifetime;
    this.ink.uniforms.uSpeedScale.value = c.inkSpeed * g.particleSpeed;
    this.ink.uniforms.uOpacity.value = c.inkOpacity * g.opacity;
    this.ink.uniforms.uTurbulence.value = c.inkTurbulence * g.turbulence;

    this.spray.setGradient(
      getColor(c.colorSprayA),
      getColor(c.colorSprayB),
      getColor(c.colorSprayC),
      getColor(c.colorSprayD)
    );
    this.spray.uniforms.uGravity.value.set(0, c.sprayGravity, 0);
    this.spray.uniforms.uSizeScale.value = c.spraySize * g.particleSize * 7;
    this.spray.uniforms.uLifeScale.value = c.sprayLifetime * 0.5 * g.particleLifetime;
    this.spray.uniforms.uSpeedScale.value = g.particleSpeed;
    this.spray.uniforms.uOpacity.value = c.sprayOpacity * g.opacity;
    this.spray.uniforms.uTurbulence.value = c.sprayTurbulence * g.turbulence;

    this.debris.setGradient(
      getColor(c.colorDebrisA),
      getColor(c.colorDebrisB),
      getColor(c.colorDebrisC),
      getColor(c.colorDebrisD)
    );
    this.debris.uniforms.uGravity.value.set(0, c.debrisGravity, 0);
    this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
    this.debris.uniforms.uLifeScale.value = g.particleLifetime;
    this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
    this.debris.uniforms.uOpacity.value = g.opacity;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    // Barely anything: marine snow is very nearly neutrally buoyant, and that
    // is the whole read of the system.
    this.motes.uniforms.uGravity.value.set(0, c.moteDrift, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uSwirl.value = c.moteSwirl;
    this.motes.uniforms.uSwirlExpand.value = c.moteExpand;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /**
   * What the caster's hand throws off as the cast leaves it. Ink and spray only
   * — no shell: a sphere at the hand reads as a bubble stuck to the character.
   */
  _muzzleFx() {
    const c = settings.kraken;
    const g = settings.global;

    this._handPoint(_pos);

    _emit.position = _pos;
    _emit.radius = 0.2;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.8).setY(0.3).normalize();
    _emit.speed = c.sprayFxSpeed * 0.9;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sprayLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spray.emit(Math.round(26 * g.particleCount), _emit);

    _emit.speed = c.inkSpeed * 1.2;
    _emit.spread = 0.9;
    _emit.size = 0.5;
    _emit.life = c.inkLifetime * 0.5;
    _emit.spin = 0.4;
    this.ink.emit(Math.round(10 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /** The wet surge running out across the floor ahead of the cast. */
  _frontFx(dt) {
    const c = settings.kraken;
    const g = settings.global;
    const time = frame.uTime.value;

    /* --- ink boiling off the slick --- */
    const inkCount = Math.round(this.inkEmitter.tick(dt, c.inkRate * 0.35) * g.particleCount);
    if (inkCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.12);
      _emit.radius = 0.5;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.inkSpeed * 0.7;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.6;
      _emit.sizeVariance = 0.5;
      _emit.life = c.inkLifetime * 0.6;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.ink.emit(inkCount, _emit);
    }

    /* --- water thrown up off it --- */
    const sprayCount = Math.round(this.sprayEmitter.tick(dt, c.sprayRate * 0.5) * g.particleCount);
    if (sprayCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.2);
      _emit.radius = 0.45;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.sprayFxSpeed * 0.8;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.8;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.6;
      _emit.life = c.sprayLifetime * 0.7;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.spray.emit(sprayCount, _emit);
    }

    /* --- the slick itself, laid into the floor as the surge passes --- */
    const step = 1 / Math.max(0.05, c.trailSlickRate);
    while (this.front - this._slickDistance >= step) {
      this._slickDistance += step;
      const s = saturate(this._slickDistance / this.length);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.9, 0.9);
      _pos.z += this.side.z * randRange(-0.9, 0.9);

      this.ctx.decals.spawn(DecalType.FOAM, _pos, {
        radius: c.trailSlickRadius * randRange(0.6, 1.15),
        life: c.slickLife * 0.7,
        intensity: c.slickIntensity,
        colorA: getColor(c.colorSlick),
        colorB: getColor(c.colorFoam)
      });
    }
  }

  /** Spray, ink and a ripple where an arm hauls itself out of the floor. */
  _breachFx(record, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const centre = this._state.centre;
    const seat = this._seatRadius(record, c);

    _pos.set(
      centre.x + Math.cos(record.angle) * seat,
      0.1,
      centre.z + Math.sin(record.angle) * seat
    );

    _emit.position = _pos;
    _emit.radius = this._armThickness(record, c) * 1.6;
    _emit.direction = _dir
      .set(Math.cos(record.angle) * 0.5, 1, Math.sin(record.angle) * 0.5)
      .normalize();
    _emit.speed = c.sprayFxSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sprayLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spray.emit(Math.round(c.breachSpray * g.particleCount), _emit);

    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.inkSpeed * 0.8;
    _emit.spread = 0.9;
    _emit.size = 0.55;
    _emit.sizeVariance = 0.5;
    _emit.life = c.inkLifetime * 0.8;
    _emit.spin = 0.4;
    this.ink.emit(Math.round(c.breachInk * g.particleCount), _emit);

    // Only the heavy arms break stone on the way out.
    if (record.role === Role.ARM) {
      _emit.direction = _dir
        .set(Math.cos(record.angle) * 0.8, 1, Math.sin(record.angle) * 0.8)
        .normalize();
      _emit.speed = c.debrisSpeed * 0.7;
      _emit.spread = 0.6;
      _emit.size = 0.09;
      _emit.life = c.debrisLifetime;
      _emit.spin = 8;
      this.debris.emit(Math.round(c.breachDebris * g.particleCount), _emit);

      _pos.y = 0;
      this.ctx.decals.spawn(DecalType.RIPPLE, _pos, {
        radius: this.radius * 0.35,
        life: 0.9,
        width: 0.1,
        intensity: 0.8,
        colorA: getColor(c.colorRippleA),
        colorB: getColor(c.colorRippleB)
      });
    }
  }

  /**
   * **The smash.** One arm's point has just reached the floor in the middle of
   * the ring, at a position this ability knows in closed form.
   *
   * The ground answers in four layers, because a single shockwave decal reads as
   * a UI element: a ring snapping out, a ground-hugging ring of dust, the stone
   * itself thrown up as chips, and the water that was standing there thrown out
   * sideways. The finale gets the same four, scaled, plus the room shaking and
   * a flash.
   */
  _smashFx(record, c, point, finale) {
    const g = settings.global;
    const time = frame.uTime.value;
    const heavy = record.role === Role.ARM;
    // How hard this particular landing hits: the whips barely count, and the
    // finale is every arm landing on the same frame, so each one is dialled up.
    const power = (heavy ? 1 : c.whipPower) * (finale ? c.finalePower : 1);

    _pos.copy(point).setY(0.05);

    /* --- the ring that snaps out from under the point --- */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: this.radius * c.smashShock * power,
      life: 0.7,
      width: 0.05,
      intensity: 0.9 * power,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* --- the ground-hugging ring of dust --- */
    if (heavy || finale) {
      this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
        radius: this.radius * c.smashDust * power,
        life: 0.9,
        intensity: 0.7,
        colorA: getColor(c.colorDust),
        colorB: getColor(c.colorFoam)
      });
    }

    /* --- stone thrown out of the floor --- */
    _emit.position = _pos;
    _emit.radius = 0.35 * power;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.debrisSpeed * power;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.8;
    _emit.life = c.debrisLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 10;
    _emit.tint = null;
    _emit.time = time;
    this.debris.emit(Math.round(c.smashDebris * power * g.particleCount), _emit);

    /* --- and the water standing on it, thrown flat and outward --- */
    // Low and wide rather than up: a heavy thing landing in a puddle throws a
    // sheet sideways, and a vertical plume would read as an explosion.
    _emit.radius = 0.5 * power;
    _emit.direction = _dir.set(0, 0.35, 0).normalize();
    _emit.speed = c.sprayFxSpeed * 1.8 * power;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.size = 0.1;
    _emit.life = c.sprayLifetime;
    _emit.spin = 0;
    this.spray.emit(Math.round(c.smashSpray * power * g.particleCount), _emit);

    _emit.radius = 0.6 * power;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.inkSpeed * 1.4;
    _emit.spread = 1.0;
    _emit.size = 0.8;
    _emit.life = c.inkLifetime;
    _emit.spin = 0.5;
    this.ink.emit(Math.round(c.smashInk * power * g.particleCount), _emit);

    /* --- and the room --- */
    this.ctx.shake.add(
      c.smashShake * power * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.smashShakeDecay),
      26
    );
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.5 * power * g.explosionIntensity);

    if (finale) {
      // Every arm lands on this frame, so the room is only allowed to answer
      // once — otherwise the flash and the ring are stacked twenty times over.
      if (!this._finaleFired) {
        this._finaleFired = true;
        this.ctx.flash.trigger(getColor(c.colorFlash), c.finaleFlash * g.explosionIntensity);
        // One ring from the middle of the footprint, far wider than any single
        // arm's — the sound of all of them landing together.
        this._centrePoint(_pos);
        this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
          radius: c.finaleShock * g.explosionIntensity,
          life: 0.9,
          width: 0.06,
          intensity: 1.0,
          colorA: getColor(c.colorShockA),
          colorB: getColor(c.colorShockB)
        });
      }
    }
  }

  /**
   * Everything the standing crown sheds: ink rolling off the rim, spray coming
   * off the arms, the marine snow hanging inside the ring, and the water working
   * at the floor around it.
   *
   * @param {number} scale 0..1 — thinned out as the crown leaves
   */
  _fieldFx(dt, scale) {
    const c = settings.kraken;
    const g = settings.global;
    const time = frame.uTime.value;
    const centre = this._state.centre;
    const radius = this.radius;
    const open = this._openAmount();

    /* --- ink rolling off the rim and out over the floor --- */
    const inkCount = Math.round(this.inkEmitter.tick(dt, c.inkRate * scale) * g.particleCount);
    if (inkCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.85, 1.1);
      _pos.set(centre.x + Math.cos(a) * r, randRange(0.05, 0.5) * open, centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = radius * 0.14;
      // Outward and barely upward: ink is heavier than the air over it and it
      // *spreads* rather than climbing. The exact opposite of the Pyre Crown's
      // smoke, which leaves over the top.
      _emit.direction = _dir.set(Math.cos(a) * 1.4, 0.5, Math.sin(a) * 1.4).normalize();
      _emit.speed = c.inkSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.95;
      _emit.sizeVariance = 0.5;
      _emit.life = c.inkLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.ink.emit(inkCount, _emit);
    }

    /* --- water running off the arms --- */
    const sprayCount = Math.round(this.sprayEmitter.tick(dt, c.sprayRate * scale) * g.particleCount);
    if (sprayCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.8, 1.02);
      _pos.set(
        centre.x + Math.cos(a) * r,
        randRange(0.3, Math.max(0.4, c.thickness * 8)) * open,
        centre.z + Math.sin(a) * r
      );
      _emit.position = _pos;
      _emit.radius = radius * 0.12;
      // Running *off* a limb, so it falls: down and a little outward.
      _emit.direction = _dir.set(Math.cos(a) * 0.4, -0.6, Math.sin(a) * 0.4).normalize();
      _emit.speed = c.sprayFxSpeed * 0.5;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.6;
      _emit.life = c.sprayLifetime * 0.8;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spray.emit(sprayCount, _emit);
    }

    /* --- the marine snow hanging inside the ring --- */
    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * c.moteInset * Math.sqrt(Math.random());
      // `anchor` is the axis the swirl turns about and `position` is where the
      // mote starts, so the offset between them is the orbit radius. Anchoring
      // on the throat is what makes the whole column turn with the rift.
      _pos.set(centre.x + Math.cos(a) * r, randRange(0.1, c.moteSeat), centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.15;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.anchor = _anchor.set(centre.x, _pos.y, centre.z);
      _emit.size = 0.08;
      _emit.sizeVariance = 0.8;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
      _emit.anchor = null;
    }

    /* --- the wet stone creeping around the boundary --- */
    const slickCount = this.slickEmitter.tick(dt, c.slickRate * scale);
    for (let i = 0; i < slickCount; i++) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.75, 1.1);
      _pos.set(centre.x + Math.cos(a) * r, 0, centre.z + Math.sin(a) * r);
      this.ctx.decals.spawn(DecalType.FOAM, _pos, {
        radius: c.slickRadius * randRange(0.7, 1.3),
        life: c.slickLife,
        intensity: c.slickIntensity,
        colorA: getColor(c.colorSlick),
        colorB: getColor(c.colorFoam)
      });
    }

    /* --- and the swell pushed out across the floor --- */
    const rippleCount = this.rippleEmitter.tick(dt, c.rippleRate * scale);
    for (let i = 0; i < rippleCount; i++) {
      this.ctx.decals.spawn(DecalType.RIPPLE, centre, {
        radius: radius * 1.15,
        life: 1.1,
        width: 0.07,
        intensity: 0.55,
        colorA: getColor(c.colorRippleA),
        colorB: getColor(c.colorRippleB)
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    this._updateArms();

    // The light rides the surge, just off the floor.
    this.position.y = 0.3;

    this._frontFx(dt);
    this.ctx.shake.rumble(settings.kraken.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.kraken;
    const g = settings.global;
    const time = frame.uTime.value;

    this._openTime = 0;
    this._centrePoint(_pos);

    /* the ring that snaps outward across the floor as the stone gives way */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.tearShock * g.explosionIntensity,
      life: 0.8,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* and the drowned sheet of stone under all of it — the dark half of the
       rift, laid as a decal because this pass's own quad is additive */
    this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
      radius: this.radius * c.slickSpread,
      life: c.slickLife * 1.4,
      intensity: c.slickIntensity,
      colorA: getColor(c.colorDrowned),
      colorB: getColor(c.colorFieldEdge)
    });

    /* water, ink and stone blown out of the tear */
    this._centrePoint(_pos).setY(0.35);
    _emit.position = _pos;
    _emit.radius = this.radius * 0.55;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sprayFxSpeed * 1.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sprayLifetime * 1.2;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spray.emit(Math.round(c.tearSpray * g.particleCount), _emit);

    _emit.radius = this.radius * 0.75;
    _emit.speed = c.inkSpeed * 2.0;
    _emit.spread = 1.0;
    _emit.size = 1.2;
    _emit.life = c.inkLifetime * 1.3;
    _emit.spin = 0.5;
    this.ink.emit(Math.round(c.tearInk * g.particleCount), _emit);

    _emit.radius = this.radius * 0.6;
    _emit.speed = c.debrisSpeed * 1.1;
    _emit.spread = 0.9;
    _emit.size = 0.1;
    _emit.life = c.debrisLifetime * 1.2;
    _emit.spin = 9;
    this.debris.emit(Math.round(c.tearDebris * g.particleCount), _emit);

    this.ctx.shake.add(
      c.tearShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      19
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.tearFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.kraken;
    this._openTime += dt;

    // `t` runs 0..1 while the crown hammers, then 1..2 while it leaves. The rift
    // and the curtain are carried out by the closing inside `_sync`, so the fade
    // here only has to take the last of the alpha with it.
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));

    this._sync(fade);
    this._updateArms();

    // The light sits low in the ring, in the water rather than up in the arms.
    this._centrePoint(this.position);
    this.position.y = c.lightHeight;

    this._fieldFx(dt, fade * (t <= 1 ? 1 : 0.4));
    this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._activeCount = 0;
    this._drawn = 0;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    this.field.visible = false;
    this.veil.visible = false;
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
    this.fieldGeometry.dispose();
    this.fieldMaterial.dispose();
    this.veilGeometry.dispose();
    this.veilMaterial.dispose();
    super.dispose();
  }
}
