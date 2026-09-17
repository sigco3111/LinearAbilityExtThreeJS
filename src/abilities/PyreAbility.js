import {
  InstancedMesh,
  InstancedBufferAttribute,
  Mesh,
  PlaneGeometry,
  CylinderGeometry,
  Object3D,
  Vector3,
  Quaternion
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createPyreMaterial } from '../materials/PyreMaterial.js';
import {
  createEmberFieldMaterial,
  createFlameVeilMaterial,
  createHeatHazeMaterial
} from '../materials/EmberFieldMaterial.js';
import { createCrystalGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on blades per cast. The editor's count slider clamps to this. */
const MAX_SPIKES = 320;
/**
 * Distinct blade shapes in the crown. Each is its own InstancedMesh — three
 * draw calls buys real silhouette variety that per-instance scaling alone
 * cannot, because the *facets* differ, not just the proportions.
 */
const VARIANTS = 3;
const SLOTS = Math.ceil(MAX_SPIKES / VARIANTS);
const TAU = Math.PI * 2;

/**
 * What a blade is for. The role decides where it stands, how tall it is, which
 * way it leans and — the part that carries the whole cast — *when* it catches.
 */
const Role = Object.freeze({
  RING: 0, // the wall of fire-blades on the boundary
  SKIRT: 1, // the burning wreckage banked against its foot, inside and out
  CORE: 2 // the pyre in the middle — off by default, the middle stays clear
});

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lean = new Vector3();
const _axis = new Vector3();
/**
 * The axis the updraft orbits: the centre of the crater, at the height the
 * particle is released from. `ParticleSystem` reads `anchor` once at spawn and
 * never again, so one shared scratch vector is enough — but it has to be its
 * own, because `_pos` and `_dir` are already spoken for in the same emit block.
 */
const _anchor = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _tilt = new Quaternion();

/** Shortest signed angle from `b` to `a`, radians, -π..π. */
function angleDelta(a, b) {
  const d = a - b;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/**
 * PYRE CROWN — the Glacial Crown answered in fire, and the third **far cast**.
 *
 * A line of fire runs out across the floor to the aimed point, the ground inside
 * the circle splits and goes molten, and a ring of burning blades tears up out
 * of it — leaning outward, fanned so they cross, of wildly uneven height — which
 * stands, burns, throws embers up through its own middle on the column of hot
 * air over the crater, and then **is consumed**: eaten down from the points to
 * the floor and left as ash.
 *
 * The **middle stays open**. Every blade is seated in a band about `zoneRadius`
 * and nothing is planted in the centre of the footprint, because the read of the
 * ability is a wall you are looking *into*: fill the disc and the ring stops
 * being a ring. What lives inside it is air — the updraft, the embers riding it,
 * the smoke leaving over the top — and the split, glowing ground under that. The
 * pyre is kept as a control (`coreShare`) but ships at zero.
 *
 * **Where it deliberately diverges from the Glacial Crown**, because two
 * abilities with one silhouette have to be told apart in a glance and in a
 * second:
 *
 *   - the blades are **opaque fire**, not transparent glass (`PyreMaterial`);
 *   - they **rise without a bounce.** The ice punches through the floor and
 *     springs back onto its height; fire does not do that. The eruption here is
 *     strictly monotonic — a fast, front-loaded surge that decelerates onto full
 *     height and then only ever *creeps* upward, asymptotically, the way a flame
 *     climbs. See `_emergence`: there is no overshoot term to turn on.
 *   - the air inside **rises.** The Crown's signature is snow falling through
 *     the ring; this one's is an updraft — embers caught in the column over the
 *     crater and spiralling up out of it.
 *   - it **ends by burning out, not by breaking.** The collapse runs the
 *     combustion front backwards from the tips down, and it sweeps back the way
 *     the bloom came, so the crown closes and opens on the same axis.
 *   - and it **bends the room**: a heat-haze proxy on `LAYER.DISTORTION` warps
 *     the floor behind it, which no amount of emissive geometry can fake.
 *
 * Four beats, though only three phases:
 *
 *   1. **travel** — the fire front runs out across the floor, scorching it.
 *   2. **catch** — the first `snapTime` of the impact phase: the crater burns
 *      outward and the ring erupts as a *sweep*. The blade nearest the caster
 *      goes first and the wave runs around both sides to meet at the far side,
 *      so the crown closes rather than appearing, with the skirt catching behind
 *      the wave.
 *   3. **blaze** — the rest of `lifetime`: the blades burn and gutter, the wall
 *      of flame stands between them, the crater breathes, embers pour off the
 *      rim and up through the middle, and late blades keep catching.
 *   4. **burn out** — the points go to ash first and the line walks down each
 *      blade to the floor, sweeping back around the ring, while the crater cools
 *      inward.
 *
 * Everything is generated. The blades are procedural crystals shaded by
 * `materials/PyreMaterial.js` (which owns the combustion front and the
 * burn-down), the crater, the wall of flame and the haze are three shaders in
 * `materials/EmberFieldMaterial.js`, and the smoke, cinders, embers and updraft
 * are GPU particles.
 *
 * **The rule that makes the editor work.** A blade record holds nothing but dice
 * — a role, a bearing, a unitless radial fraction and a handful of jitters. Not
 * one metre, radian or second is captured: the seat of the ring, the height of a
 * blade, the lean, the crater and the wall of flame are all resolved against
 * `settings.pyre` inside the update loop, which runs on a zero-length frame too.
 * Dragging `zoneRadius` re-scales a crown that is already burning, with the
 * clock stopped.
 *
 * The only values a record *does* capture are timestamps — the moment its own
 * eruption was triggered. Those are events, not dimensions.
 */
export class PyreAbility extends Ability {
  constructor(context) {
    super('pyre', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.material = createPyreMaterial();

    /** Signature of the geometry controls, so a rebuild only happens on a change. */
    this._shapeKey = '';

    this.meshes = [];
    this.seedAttributes = [];
    this.birthAttributes = [];
    this.growAttributes = [];
    this.charAttributes = [];

    for (let v = 0; v < VARIANTS; v++) {
      const geometry = this._buildGeometry(v);

      const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const births = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const grows = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const chars = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      for (let i = 0; i < SLOTS; i++) seeds.array[i] = Math.random() * 10;
      geometry.setAttribute('aSeed', seeds);
      geometry.setAttribute('aBirth', births);
      geometry.setAttribute('aGrow', grows);
      geometry.setAttribute('aChar', chars);

      const mesh = new InstancedMesh(geometry, this.material, SLOTS);
      // Fire does not cast a shadow, and it does not sit in one. Turning both
      // off is also what keeps the shadow map honest: the growth and the
      // burn-down are `discard`s in the fragment shader, and the depth-only
      // pass three renders for a shadow caster would know nothing about either
      // — a blade would throw its full silhouette across the floor before it had
      // finished coming out of it.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid world geometry: it belongs in the depth prepass so the smoke, the
      // embers and the wall of flame all fade softly where they intersect it.
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      this.group.add(mesh);

      this.meshes.push(mesh);
      this.seedAttributes.push(seeds);
      this.birthAttributes.push(births);
      this.growAttributes.push(grows);
      this.charAttributes.push(chars);
    }

    /* ---- the molten crater on the floor ---- */
    this.fieldGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.fieldMaterial = createEmberFieldMaterial();
    this.field = new Mesh(this.fieldGeometry, this.fieldMaterial);
    this.field.name = 'EmberField';
    this.field.layers.set(LAYER.VFX);
    this.field.renderOrder = 7; // over the decals, under the blades
    this.field.frustumCulled = false;
    this.field.visible = false;
    this.group.add(this.field);

    /* ---- the wall of flame standing on the boundary ---- */
    // Open-ended unit cylinder: radius 1, height 1 about the origin, so placing
    // it is a scale and a lift. The flare and the billow happen in the shader.
    this.veilGeometry = new CylinderGeometry(1, 1, 1, 72, 12, true);
    this.veilMaterial = createFlameVeilMaterial();
    this.veil = new Mesh(this.veilGeometry, this.veilMaterial);
    this.veil.name = 'FlameVeil';
    this.veil.layers.set(LAYER.VFX);
    this.veil.renderOrder = 9;
    this.veil.frustumCulled = false;
    this.veil.visible = false;
    this.group.add(this.veil);

    /* ---- and the shimmering air over the whole thing ---- */
    this.hazeGeometry = new CylinderGeometry(1, 1, 1, 32, 6, true);
    this.hazeMaterial = createHeatHazeMaterial();
    this.haze = new Mesh(this.hazeGeometry, this.hazeMaterial);
    this.haze.name = 'PyreHaze';
    // Never rendered into the picture — only into the distortion buffer.
    this.haze.layers.set(LAYER.DISTORTION);
    this.haze.frustumCulled = false;
    this.haze.visible = false;
    this.group.add(this.haze);

    /**
     * Fixed-size record pool — a cast allocates nothing.
     *
     * See the class comment: dice only, no dimensions.
     */
    this.records = [];
    for (let i = 0; i < MAX_SPIKES; i++) {
      this.records.push({
        role: Role.SKIRT,
        angle: 0, // bearing about the centre, radians
        radial: 0, // RING: -1..1 seat jitter. SKIRT: 0..1 across the band. CORE: 0..1 out
        late: false, // held back to catch during the blaze
        rubble: false, // demoted to ankle-height burning wreckage
        heightJitter: 0,
        radiusJitter: 0,
        leanJitter: 0,
        fanJitter: 0, // -1..1 splay off its own radius
        yaw: 0,
        stagger: 0, // 0..1 of the per-role scatter
        eruptTime: -1, // absolute age it was triggered at, or -1
        breached: false,
        guttered: false
      });
    }

    this._activeCount = 0;
    this._drawn = 0;
    /** Re-rolled per cast so no two crowns draw the same ring. */
    this._seed = 0;
    /** Seconds since the crown started catching. Drives the bloom, nothing else. */
    this._openTime = 0;
    /** Bearing the front arrived on — where the sweep starts, and where it ends. */
    this._entryAngle = 0;
    this._scorchDistance = 0;

    // Scratch state handed to the three shaders each frame. One object apiece,
    // reused — syncing a standing crown allocates nothing.
    this._state = { centre: new Vector3() };
    this._fieldState = { radius: 1, quadSize: 1, burn: 0, fade: 1, seed: 0 };
    this._veilState = { fade: 1, seed: 0 };
    this._hazeState = { fade: 1, seed: 0 };
  }

  /** One blade shape. Variant index only perturbs the seed. */
  _buildGeometry(variant) {
    const c = settings.pyre;
    return createCrystalGeometry({
      seed: 7.1 + variant * 23.9,
      sides: c.facets,
      taper: c.taper,
      roughness: c.roughness,
      bend: c.bend,
      belly: c.belly,
      bellyAt: c.bellyAt
    });
  }

  /**
   * Regenerate the blade meshes when a *shape* control moves.
   *
   * Facet count, taper, belly, roughness and bend cannot be expressed as a per-instance
   * transform, so they are baked into the geometry — and a five-sided blade is
   * ninety triangles, cheap enough to simply rebuild rather than approximate in
   * a vertex shader. That is what keeps them live sliders.
   */
  _syncGeometry() {
    const c = settings.pyre;
    const key =
      `${Math.round(c.facets)}|${c.taper.toFixed(3)}|${c.roughness.toFixed(3)}` +
      `|${c.bend.toFixed(3)}|${c.belly.toFixed(3)}|${c.bellyAt.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.meshes[v];
      const previous = mesh.geometry;
      const geometry = this._buildGeometry(v);
      // The per-instance attributes are state, not shape — carry them over.
      geometry.setAttribute('aSeed', this.seedAttributes[v]);
      geometry.setAttribute('aBirth', this.birthAttributes[v]);
      geometry.setAttribute('aGrow', this.growAttributes[v]);
      geometry.setAttribute('aChar', this.charAttributes[v]);
      mesh.geometry = geometry;
      previous.dispose();
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Smoke rolling off the fire. Non-additive: it has to *occlude*, which is
    // what gives the crown depth from the outside and stops the whole effect
    // reading as one flat sheet of bloom.
    this.smoke = particles.get('pyre.smoke', {
      capacity: 3600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.smoke.uniforms.uDrag.value = 1.6;
    this.smoke.uniforms.uEndSize.value = 4.2;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.12;
    this.smoke.uniforms.uFadeOut.value = 0.3;

    // Burning fragments thrown off as the blades punch through the floor, and
    // again as they come apart. Lit rather than emissive, so they read as *mass*
    // — the one solid thing in an effect otherwise made entirely of light.
    this.cinders = particles.get('pyre.cinders', {
      capacity: 3000,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.cinders.uniforms.uDrag.value = 0.2;
    this.cinders.uniforms.uEndSize.value = 0.7;
    this.cinders.uniforms.uFadeOut.value = 0.7;

    // The embers coming off everything. Velocity-stretched, because a spark that
    // is not a streak is a dot, and a field of dots reads as noise.
    this.embers = particles.get('pyre.embers', {
      capacity: 3600,
      shape: ParticleShape.STREAK,
      additive: true,
      curl: true,
      stretch: true,
      softFade: 0.4
    });
    this.embers.uniforms.uDrag.value = 0.9;
    this.embers.uniforms.uEndSize.value = 0.12;
    this.embers.uniforms.uSizeIn.value = 0.05;
    this.embers.uniforms.uFadeIn.value = 0.05;
    this.embers.uniforms.uFadeOut.value = 0.4;
    this.embers.uniforms.uStretch.value = 0.4;

    // This ability's signature system: the **updraft**. Embers caught in the
    // column of hot air standing over the crater, orbiting the middle as they
    // climb and opening outward as they cool. The Glacial Crown's signature is
    // snow falling through its ring; this is the same idea run the other way,
    // and it is what says the air over this circle is burning rather than
    // freezing.
    this.updraft = particles.get('pyre.updraft', {
      capacity: 2600,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.5
    });
    this.updraft.uniforms.uDrag.value = 0.5;
    this.updraft.uniforms.uEndSize.value = 0.35;
    this.updraft.uniforms.uSizeIn.value = 0.08;
    this.updraft.uniforms.uFadeIn.value = 0.1;
    this.updraft.uniforms.uFadeOut.value = 0.45;

    this.smokeEmitter = new RateEmitter();
    this.emberEmitter = new RateEmitter();
    this.updraftEmitter = new RateEmitter();
    this.scorchEmitter = new RateEmitter();
    this.ringEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._drawn;
  }

  /** The crown catches, then burns. */
  get impactDuration() {
    return Math.max(0.2, settings.pyre.lifetime * settings.global.lifetime);
  }

  /** Burning out: a hold, the sweep back around the ring, then the ash. */
  get fadeDuration() {
    const c = settings.pyre;
    return Math.max(0.2, c.burnDelay + c.burnSweep + c.burnStagger + c.ashTime);
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.pyre.zoneRadius);
  }

  /**
   * Fire *gutters*. The base class's default is a slow shimmer, which is right
   * for ice and wrong for this: two fast beats against one slow one, so the
   * light never settles into a rhythm you can read.
   */
  lightShimmer() {
    const t = this.age;
    return (
      0.84 +
      0.16 * Math.sin(t * 21.3) * Math.sin(t * 7.9) +
      0.07 * Math.sin(t * 43.7)
    );
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The centre of the crown — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the fire leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.pyre;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /**
   * How far the crater has spread, 0..1 of the boundary.
   *
   * A pure function of `_openTime` against the live `snapTime`, so the bloom
   * re-times itself if the slider moves mid-cast.
   */
  _openAmount() {
    const snap = Math.max(0.02, settings.pyre.snapTime);
    return Easing.outCubic(saturate(this._openTime / snap));
  }

  /** How far the crater has cooled back toward the middle, 0..1. */
  _coolAmount() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const c = settings.pyre;
    const hold = c.burnDelay * 0.4;
    return saturate((this.fadeTime - hold) / Math.max(0.05, this.fadeDuration - hold));
  }

  /** Where a blade stands, at the live footprint settings. */
  _spikePosition(record, c, out) {
    const centre = this._state.centre;
    const R = this.radius;
    let r;

    if (record.role === Role.RING) {
      r = R * (c.ringSeat + record.radial * c.ringScatter);
    } else if (record.role === Role.CORE) {
      r = R * c.coreSpread * record.radial;
    } else {
      // A band around the wall, not a disc: the middle of the crown is meant to
      // stay open, so the burning wreckage banks up against the ring on both
      // sides of it rather than filling the footprint.
      r = R * (c.skirtSeat + Math.pow(record.radial, c.skirtBias) * c.skirtBand);
    }

    return out.set(centre.x + Math.cos(record.angle) * r, 0, centre.z + Math.sin(record.angle) * r);
  }

  /**
   * Full height of a blade, metres.
   *
   * The ring's height is modulated by two harmonics of its own bearing, seeded
   * per cast: a wall of blades all the same height reads as a fence, and the
   * uneven crest is most of what makes the silhouette look grown rather than
   * placed. The reference leans on this harder than the ice does — its tallest
   * blades are three times its shortest — so `ringWave` and `heightJitter` both
   * ship higher here.
   */
  _spikeHeight(record, c, g) {
    let h;

    if (record.role === Role.RING) {
      const wave =
        Math.sin(record.angle * 3 + this._seed) * 0.62 +
        Math.sin(record.angle * 5 - this._seed * 2.1) * 0.38;
      h = c.ringHeight * (1 + c.ringWave * wave);
    } else if (record.role === Role.CORE) {
      h = c.coreHeight * lerp(1, 0.55, record.radial);
    } else {
      // Tallest where it meets the wall and tapering away on both sides, so the
      // skirt reads as ground heaved up by the ring rather than as a second one.
      h = c.skirtHeight * lerp(0.55, 1.2, 1 - Math.abs(record.radial - 0.5) * 2);
    }

    h *= 1 + record.heightJitter * c.heightJitter * g.randomness;
    if (record.rubble) h *= c.rubbleScale;

    return Math.max(0.02, h);
  }

  /** Base radius of a blade, metres. */
  _spikeRadius(record, c, g) {
    const role = record.role === Role.RING ? 1 : record.role === Role.CORE ? 1.35 : 0.85;
    const jitter = 1 + record.radiusJitter * c.radiusJitter * g.randomness;
    return Math.max(0.01, c.radius * role * jitter * (record.rubble ? 1.35 : 1));
  }

  /** How far a blade leans away from the middle, radians. */
  _spikeLean(record, c, g) {
    const base =
      record.role === Role.RING ? c.ringLean : record.role === Role.CORE ? c.coreLean : c.skirtLean;
    return base * (1 + record.leanJitter * c.leanJitter * g.randomness);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.pyre;

    this.smokeEmitter.reset();
    this.emberEmitter.reset();
    this.updraftEmitter.reset();
    this.scorchEmitter.reset();
    this.ringEmitter.reset();

    this._scorchDistance = 0;
    this._openTime = 0;
    // The one thing a cast captures, besides the timestamps below.
    this._seed = Math.random() * 100;
    // The sweep starts on the near side: the bearing from the centre back toward
    // the caster, which is the bearing the front arrives on.
    this._entryAngle = Math.atan2(-this.direction.z, -this.direction.x);

    const wanted = Math.min(MAX_SPIKES, Math.max(1, Math.round(c.spikeCount * c.density)));
    const ringCount = Math.round(wanted * saturate(c.ringShare));
    const coreCount = Math.round(wanted * saturate(c.coreShare));
    const lateCount = Math.round(wanted * saturate(c.lateShare));

    this._activeCount = wanted;

    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];

      record.eruptTime = -1;
      record.breached = false;
      record.guttered = false;
      record.yaw = Math.random() * TAU;
      record.stagger = Math.random();
      record.heightJitter = randRange(-1, 1);
      record.radiusJitter = randRange(-1, 1);
      record.leanJitter = randRange(-1, 1);
      record.fanJitter = randRange(-1, 1);

      if (i < ringCount) {
        record.role = Role.RING;
        // Evenly stepped around the circle with a jittered stride, so the wall
        // has no gaps but never looks stamped.
        record.angle = ((i + randRange(-0.4, 0.4)) / Math.max(1, ringCount)) * TAU;
        record.radial = randRange(-1, 1);
        record.rubble = Math.random() < c.rubble * 0.35;
      } else if (i < ringCount + coreCount) {
        record.role = Role.CORE;
        record.angle = Math.random() * TAU;
        record.radial = Math.sqrt(Math.random());
        record.rubble = false;
      } else {
        record.role = Role.SKIRT;
        record.angle = Math.random() * TAU;
        // Flat across the band. The skirt is an annulus, not a disc, so the
        // sqrt() that keeps a disc evenly dense would only bias it outward.
        record.radial = Math.random();
        record.rubble = Math.random() < c.rubble;
      }

      // Only the skirt is held back. Sharing the wall out over the blaze would
      // break the sweep, which is the read the whole bloom is built on.
      record.late = record.role === Role.SKIRT && i >= wanted - lateCount;
    }

    for (let i = wanted; i < MAX_SPIKES; i++) this.records[i].eruptTime = -1;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    this._drawn = 0;

    this.field.visible = false;
    this.veil.visible = false;
    this.haze.visible = false;

    this._sync(1);
    this._muzzleFx();
  }

  /**
   * Hand every blade the moment it catches.
   *
   * Timestamps, not dimensions — the same allowance `IceAbility` takes. The
   * shape of the wave is the whole bloom: the ring sweeps around from the near
   * side, the skirt follows it outward, the pyre (if any) comes up last, and
   * late catchers are scattered across the blaze.
   */
  _scheduleEruption() {
    const c = settings.pyre;
    const hold = Math.max(0.2, c.lifetime * settings.global.lifetime);

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      let delay;

      if (record.late) {
        delay = hold * (0.12 + record.stagger * saturate(c.bloomSpread));
      } else if (record.role === Role.RING) {
        // 0 on the near side, 1 at the far side — the two arms of the wave meet
        // behind the crown.
        const around = Math.abs(angleDelta(record.angle, this._entryAngle)) / Math.PI;
        delay = around * c.sweepTime + record.stagger * c.stagger;
      } else if (record.role === Role.CORE) {
        delay = c.coreDelay + record.stagger * c.stagger;
      } else {
        delay = c.skirtDelay + record.radial * c.skirtWave + record.stagger * c.stagger;
      }

      record.eruptTime = this.age + delay;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The eruption                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * How far out of the ground a blade is. Negative while it is still buried and
   * waiting, 0 → 1 as it comes up, and **greater than 1 only ever by creeping**.
   *
   * This is the one function that separates this ability's eruption from the
   * Glacial Crown's, and it is worth being explicit about why. Ice punches
   * through a floor: it overshoots its height and springs back, and that damped
   * oscillation is most of what sells it as something *hard* arriving. Fire does
   * not do that — a flame that bounces onto its height reads as rubber, and it
   * is the single most common way a fire effect goes wrong.
   *
   * So there is no spring here and no overshoot term to turn on. The curve is
   * strictly monotonic in two pieces:
   *
   *   - the **surge**, `riseTime` long: a blend between `outCubic` and
   *     `outExpo`, both of which land exactly on 1 and neither of which crosses
   *     it. `riseSnap` picks between them — 0 is a heavy shove, 1 is a snap that
   *     is 90% done in the first fifth of the rise.
   *   - the **creep**, forever after: an exponential approach to `1 + creep`
   *     from *below*. It never arrives, so it never turns around. That is what a
   *     flame does when it settles — it keeps reaching, slower and slower.
   */
  _emergence(record, c) {
    if (record.eruptTime < 0) return -1;
    const elapsed = this.age - record.eruptTime;
    if (elapsed < 0) return -1;

    const riseTime = Math.max(0.02, c.riseTime);
    if (elapsed <= riseTime) {
      const x = saturate(elapsed / riseTime);
      return lerp(Easing.outCubic(x), Easing.outExpo(x), saturate(c.riseSnap));
    }

    const after = elapsed - riseTime;
    return 1 + c.creep * (1 - Math.exp(-after / Math.max(0.05, c.creepTime)));
  }

  /** How far the fire has climbed the blade's own axis, 0..1. */
  _ignition(record, c) {
    if (record.eruptTime < 0) return 0;
    const elapsed = this.age - record.eruptTime;
    // Finished just before the blade tops out, so the combustion front is still
    // travelling while the body is still moving.
    return saturate(elapsed / Math.max(0.02, c.riseTime * 0.8));
  }

  /**
   * How far a blade has burned down, 0..1. Only ever non-zero in the collapse.
   *
   * The sweep runs *back* the way the bloom came — the far side goes out first
   * and the wave closes on the near side — so the crown opens and closes on the
   * same axis instead of dying in a random order.
   */
  _charAmount(record, c) {
    if (this.phase !== AbilityPhase.FADE) return 0;

    let delay = c.burnDelay + record.stagger * c.burnStagger;
    if (record.role === Role.RING) {
      const around = Math.abs(angleDelta(record.angle, this._entryAngle)) / Math.PI;
      delay += (1 - around) * c.burnSweep;
    }

    return saturate((this.fadeTime - delay) / Math.max(0.05, c.ashTime));
  }

  /**
   * Rebuild every instance matrix and per-instance attribute from the live
   * settings.
   */
  _updateSpikes() {
    const c = settings.pyre;
    const g = settings.global;
    const birthFade = Math.max(0.02, c.birthFade);
    const used = [0, 0, 0];

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      const variant = i % VARIANTS;
      const slot = (i / VARIANTS) | 0;
      const emerge = this._emergence(record, c);

      if (emerge < 0) {
        // Still buried. Park it outside the view rather than drawing a
        // degenerate matrix at the origin.
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        this.birthAttributes[variant].array[slot] = 0;
        this.growAttributes[variant].array[slot] = 0;
        this.charAttributes[variant].array[slot] = 0;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      const height = this._spikeHeight(record, c, g);
      const radius = this._spikeRadius(record, c, g);
      const char = this._charAmount(record, c);

      /* --- cinders as it breaks the surface, and again as it goes out --- */
      if (!record.breached && emerge > 0.2) {
        record.breached = true;
        this._breachFx(record, c, g, radius);
      }
      if (!record.guttered && char > 0.1) {
        record.guttered = true;
        this._gutterFx(record, c, g, radius, height);
      }

      /* --- lean: thrown outward, and fanned off its own radius --- */
      // The fan is what makes the wall a starburst instead of a picket line:
      // neighbouring blades are splayed to either side of the radius they stand
      // on, so they cross in front of each other as they go over.
      const bearing = record.angle + record.fanJitter * c.fan;
      _lean.set(Math.cos(bearing), 0, Math.sin(bearing));
      if (_lean.lengthSq() < 1e-6) _lean.copy(this.direction);
      _lean.normalize();

      // Rotating about (up × lean) tips the blade's own +Y toward `lean`.
      _axis.crossVectors(_up, _lean).normalize();
      _tilt.setFromAxisAngle(_axis, this._spikeLean(record, c, g));
      _spin.setFromAxisAngle(_up, record.yaw * c.twist);
      _tilt.multiply(_spin);

      /* --- slide it up out of the floor, then let it reach --- */
      // The two halves of `_emergence` are applied to two different things, and
      // that is the whole trick: the part below 1 slides the blade up out of the
      // ground with its base still buried, and the part above 1 *lengthens* it
      // with its base planted. A creep applied as a lift would pull the blade
      // out of the floor and leave it hovering.
      const surfaced = Math.min(1, emerge);
      const creep = Math.max(0, emerge - 1);
      const drawn = height * (1 + creep);

      this._spikePosition(record, c, _dummy.position);
      _dummy.position.y = (surfaced - 1) * drawn * 0.92;
      if (char > 0) _dummy.position.y -= Easing.inCubic(char) * drawn * c.sink;

      _dummy.quaternion.copy(_tilt);
      _dummy.scale.set(radius, drawn, radius).multiplyScalar(lerp(0.82, 1, surfaced));
      _dummy.updateMatrix();

      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
      this.birthAttributes[variant].array[slot] = saturate(
        1 - (this.age - record.eruptTime) / birthFade
      );
      this.growAttributes[variant].array[slot] = this._ignition(record, c);
      this.charAttributes[variant].array[slot] = char;
      used[variant] = Math.max(used[variant], slot + 1);
    }

    this._drawn = 0;
    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.birthAttributes[v].needsUpdate = true;
      this.growAttributes[v].needsUpdate = true;
      this.charAttributes[v].needsUpdate = true;
      this._drawn += used[v];
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into the blade material,
   * the crater, the wall of flame, the haze and the four particle systems.
   *
   * @param {number} fade 1 while the crown burns, ramping to 0 as it goes out
   */
  _sync(fade) {
    const c = settings.pyre;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(this._state.centre);
    this._syncGeometry();
    this.material.userData.sync();

    const centre = this._state.centre;
    const radius = this.radius;
    const open = travelling ? 0 : this._openAmount();
    const cool = this._coolAmount();
    const burn = open * (1 - cool);

    /* --- the crater --- */
    const fieldState = this._fieldState;
    fieldState.radius = radius;
    fieldState.quadSize = (radius + c.fieldBoundary + 0.8) * 2;
    fieldState.burn = burn;
    fieldState.fade = fade;
    fieldState.seed = this._seed;
    this.fieldMaterial.userData.sync(fieldState);

    this.field.visible = !travelling && burn > 0.002 && fade > 0.002;
    this.field.position.set(centre.x, c.fieldHeight, centre.z);
    this.field.scale.set(fieldState.quadSize, 1, fieldState.quadSize);

    /* --- the wall of flame --- */
    const veilHeight = Math.max(0.05, c.veilHeight * Easing.outCubic(open));
    const veilState = this._veilState;
    veilState.fade = fade * (1 - cool);
    veilState.seed = this._seed;
    this.veilMaterial.userData.sync(veilState);

    this.veil.visible = !travelling && c.veil > 0.001 && open > 0.02 && veilState.fade > 0.004;
    this.veil.position.set(centre.x, veilHeight * 0.5, centre.z);
    this.veil.scale.set(radius * c.veilRadius, veilHeight, radius * c.veilRadius);
    this.veil.rotation.y = this._seed + this.age * c.veilSpin * TAU;

    /* --- and the air over it --- */
    const hazeHeight = Math.max(0.05, c.hazeHeight * Easing.outCubic(open));
    const hazeState = this._hazeState;
    hazeState.fade = fade * (1 - cool * 0.7);
    hazeState.seed = this._seed;
    this.hazeMaterial.userData.sync(hazeState);

    this.haze.visible = !travelling && c.haze > 0.001 && open > 0.02 && hazeState.fade > 0.004;
    this.haze.position.set(centre.x, hazeHeight * 0.5, centre.z);
    this.haze.scale.set(radius * c.hazeRadius, hazeHeight, radius * c.hazeRadius);

    /* --- the four particle systems --- */
    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
    this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = c.smokeSpeed * g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
    this.smoke.uniforms.uTurbulence.value = c.smokeTurbulence * g.turbulence;

    this.cinders.setGradient(
      getColor(c.colorCinderA),
      getColor(c.colorCinderB),
      getColor(c.colorCinderC),
      getColor(c.colorCinderD)
    );
    this.cinders.uniforms.uGravity.value.set(0, c.cinderGravity, 0);
    this.cinders.uniforms.uSizeScale.value = c.cinderSize * g.particleSize * 7;
    this.cinders.uniforms.uLifeScale.value = g.particleLifetime;
    this.cinders.uniforms.uSpeedScale.value = g.particleSpeed;
    this.cinders.uniforms.uOpacity.value = g.opacity;

    this.embers.setGradient(
      getColor(c.colorEmberA),
      getColor(c.colorEmberB),
      getColor(c.colorEmberC),
      getColor(c.colorEmberD)
    );
    this.embers.uniforms.uGravity.value.set(0, c.emberRise, 0);
    this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 7;
    this.embers.uniforms.uLifeScale.value = c.emberLifetime * 0.5 * g.particleLifetime;
    this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
    this.embers.uniforms.uOpacity.value = g.opacity;
    this.embers.uniforms.uGlow.value = c.emberGlow * g.glow;
    this.embers.uniforms.uTurbulence.value = c.emberTurbulence * g.turbulence;
    this.embers.uniforms.uStretch.value = c.emberStretch;

    this.updraft.setGradient(
      getColor(c.colorUpdraftA),
      getColor(c.colorUpdraftB),
      getColor(c.colorUpdraftC),
      getColor(c.colorUpdraftD)
    );
    // Positive: this is the one system in the project that is *climbing* under
    // its own buoyancy rather than falling back.
    this.updraft.uniforms.uGravity.value.set(0, c.updraftLift, 0);
    this.updraft.uniforms.uSizeScale.value = c.updraftSize * g.particleSize * 7;
    this.updraft.uniforms.uLifeScale.value = c.updraftLifetime * 0.5 * g.particleLifetime;
    this.updraft.uniforms.uSpeedScale.value = g.particleSpeed;
    this.updraft.uniforms.uOpacity.value = g.opacity;
    this.updraft.uniforms.uGlow.value = c.updraftGlow * g.glow;
    this.updraft.uniforms.uSwirl.value = c.updraftSwirl;
    this.updraft.uniforms.uSwirlExpand.value = c.updraftExpand;
  }

  /**
   * What the caster's hand throws off as the fire leaves it. Cinders, embers
   * and a flash only — no shell: a sphere at the hand reads as a bubble stuck
   * to the character, and the particles alone carry the launch.
   */
  _muzzleFx() {
    const c = settings.pyre;
    const g = settings.global;

    this._handPoint(_pos);

    _emit.position = _pos;
    _emit.radius = 0.18;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.7).setY(0.45).normalize();
    _emit.speed = c.cinderSpeed * 0.9;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.7;
    _emit.life = c.cinderLifetime * 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.cinders.emit(Math.round(16 * g.particleCount), _emit);

    _emit.speed = c.emberSpeed * 0.9;
    _emit.spread = 0.9;
    _emit.size = 0.08;
    _emit.life = c.emberLifetime * 0.7;
    _emit.spin = 0;
    this.embers.emit(Math.round(34 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /** Smoke, embers and scorch laid under the front while it races out. */
  _frontFx(dt) {
    const c = settings.pyre;
    const g = settings.global;
    const time = frame.uTime.value;

    /* --- smoke boiling off the burning floor --- */
    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * 0.4) * g.particleCount);
    if (smokeCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.15);
      _emit.radius = 0.45;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.65;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime * 0.7;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.5;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }

    /* --- embers thrown up off the burning line --- */
    const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * 0.45) * g.particleCount);
    if (emberCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.3);
      _emit.radius = 0.4;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.8;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.6;
      _emit.life = c.emberLifetime * 0.8;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.embers.emit(emberCount, _emit);
    }

    /* --- scorch burnt into the floor as the front passes over it --- */
    const step = 1 / Math.max(0.05, c.trailScorchRate);
    while (this.front - this._scorchDistance >= step) {
      this._scorchDistance += step;
      const s = saturate(this._scorchDistance / this.length);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.9, 0.9);
      _pos.z += this.side.z * randRange(-0.9, 0.9);

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.trailScorchRadius * randRange(0.55, 1.1),
        life: c.scorchLife * 0.8,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorScorchEmber)
      });
    }
  }

  /** Cinders and a puff where a blade tears out of the ground. */
  _breachFx(record, c, g, radius) {
    const time = frame.uTime.value;

    this._spikePosition(record, c, _pos).setY(0.08);

    _emit.position = _pos;
    _emit.radius = radius * 0.9;
    // Thrown outward, away from the middle of the crown — the same direction the
    // blade itself leans.
    _emit.direction = _dir
      .set(Math.cos(record.angle) * 0.6, 1, Math.sin(record.angle) * 0.6)
      .normalize();
    _emit.speed = c.cinderSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.cinderLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = time;
    this.cinders.emit(Math.round(c.breachCinders * g.particleCount), _emit);

    // Embers straight up the blade it just made, so the fire looks like it is
    // coming *off* the thing rather than being painted on it.
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.emberSpeed * 1.2;
    _emit.spread = 0.35;
    _emit.size = 0.07;
    _emit.life = c.emberLifetime;
    _emit.spin = 0;
    this.embers.emit(Math.round(c.breachEmbers * g.particleCount), _emit);

    // Only some blades smoke: a few hundred smoking at once buries the crown in
    // haze and hides the silhouette that is the whole point.
    if (Math.random() < 0.3) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed * 0.7;
      _emit.spread = 0.9;
      _emit.size = 0.5;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime * 0.7;
      _emit.spin = 0.5;
      this.smoke.emit(Math.round(2 * g.particleCount), _emit);
    }

    // A collar of scorch around the foot of a ring blade, so the wall is seated
    // on the ground rather than stuck through it.
    if (record.role === Role.RING && Math.random() < 0.5) {
      this._spikePosition(record, c, _pos);
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: radius * c.scorchCollar * randRange(0.7, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity * 0.9,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorScorchEmber)
      });
    }
  }

  /** The burst of embers as a blade starts going out. */
  _gutterFx(record, c, g, radius, height) {
    const time = frame.uTime.value;

    this._spikePosition(record, c, _pos).setY(height * 0.75);

    _emit.position = _pos;
    _emit.radius = radius * 1.2;
    // Straight up and a little outward: this is the last of the fire leaving the
    // blade, not debris being thrown off it.
    _emit.direction = _dir
      .set(Math.cos(record.angle) * 0.35, 1, Math.sin(record.angle) * 0.35)
      .normalize();
    _emit.speed = c.emberSpeed * 0.9;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.55;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.7;
    _emit.life = c.emberLifetime * 1.3;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(c.gutterEmbers * g.particleCount), _emit);

    // And the ash it leaves, falling out of the bottom of it.
    _emit.direction = _dir.set(0, -0.3, 0).normalize();
    _emit.speed = c.cinderSpeed * 0.35;
    _emit.spread = 0.9;
    _emit.size = 0.09;
    _emit.life = c.cinderLifetime * 1.2;
    _emit.spin = 6;
    this.cinders.emit(Math.round(c.gutterCinders * g.particleCount), _emit);

    if (Math.random() < 0.45) {
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed * 0.9;
      _emit.spread = 0.8;
      _emit.size = 0.6;
      _emit.life = c.smokeLifetime;
      _emit.spin = 0.5;
      this.smoke.emit(Math.round(3 * g.particleCount), _emit);
    }
  }

  /**
   * Everything the standing crown sheds: smoke rolling off the rim, embers
   * pouring off it, the updraft climbing through the middle, scorch creeping
   * around the boundary and heat rings across the floor.
   *
   * @param {number} scale 0..1 — thinned out as the crown goes out
   */
  _fieldFx(dt, scale) {
    const c = settings.pyre;
    const g = settings.global;
    const time = frame.uTime.value;
    const centre = this._state.centre;
    const radius = this.radius;
    const open = this._openAmount();

    /* --- smoke rolling off the rim and away over the floor --- */
    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.8, 1.08);
      _pos.set(
        centre.x + Math.cos(a) * r,
        randRange(0.1, c.ringHeight * 0.6) * open,
        centre.z + Math.sin(a) * r
      );
      _emit.position = _pos;
      _emit.radius = radius * 0.16;
      // Up and outward. The opposite of the Glacial Crown's mist, which falls
      // off its wall because cold air is heavy — this is buoyant, and it leaves
      // over the top.
      _emit.direction = _dir.set(Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55).normalize();
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.65;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }

    /* --- embers coming off the blades --- */
    const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * scale) * g.particleCount);
    if (emberCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.82, 1.02);
      _pos.set(
        centre.x + Math.cos(a) * r,
        randRange(0.1, c.ringHeight) * open,
        centre.z + Math.sin(a) * r
      );
      _emit.position = _pos;
      _emit.radius = radius * 0.1;
      _emit.direction = _dir.set(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3).normalize();
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.6;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(emberCount, _emit);
    }

    /* --- and the column of hot air carrying them up through the middle --- */
    const updraftCount = Math.round(
      this.updraftEmitter.tick(dt, c.updraftRate * scale) * g.particleCount
    );
    if (updraftCount > 0) {
      const a = Math.random() * TAU;
      const r = radius * c.updraftInset * Math.sqrt(Math.random());
      // `anchor` is the axis the swirl orbits and `position` is where the
      // particle starts, so the offset between them *is* the orbit radius.
      // Anchoring on the centre of the crater is what makes the column turn.
      _pos.set(centre.x + Math.cos(a) * r, randRange(0.05, 0.4), centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.1;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.updraftSpeed;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.18;
      _emit.inherit = null;
      _emit.anchor = _anchor.set(centre.x, _pos.y, centre.z);
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.updraftLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.updraft.emit(updraftCount, _emit);
      _emit.anchor = null;
    }

    /* --- scorch creeping around the boundary --- */
    const scorchCount = this.scorchEmitter.tick(dt, c.scorchRate * scale);
    for (let i = 0; i < scorchCount; i++) {
      const a = Math.random() * TAU;
      const r = radius * randRange(0.7, 1.05);
      _pos.set(centre.x + Math.cos(a) * r, 0, centre.z + Math.sin(a) * r);
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.scorchRadius * randRange(0.7, 1.3),
        life: c.scorchLife,
        intensity: c.scorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorScorchEmber)
      });
    }

    /* --- heat rings pushed out across the floor --- */
    const ringCount = this.ringEmitter.tick(dt, c.ringRate * scale);
    for (let i = 0; i < ringCount; i++) {
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, centre, {
        radius: radius * 1.1,
        life: 0.8,
        width: 0.05,
        intensity: 0.5,
        colorA: getColor(c.colorShockA),
        colorB: getColor(c.colorShockB)
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    this._updateSpikes();

    // The light rides the front, a little off the floor.
    this.position.y = 0.35;

    this._frontFx(dt);
    this.ctx.shake.rumble(settings.pyre.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.pyre;
    const g = settings.global;
    const time = frame.uTime.value;

    this._openTime = 0;
    this._scheduleEruption();
    this._centrePoint(_pos);
    _pos.y = 0.5;

    /* the ring that snaps outward across the floor, past the boundary */
    this._centrePoint(_pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.8,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* the star of molten fractures the crown is seated in */
    this.ctx.decals.spawn(DecalType.CRACK, _pos, {
      radius: this.radius * c.fractureSpread,
      life: c.scorchLife,
      width: c.fractureWidth,
      intensity: c.fractureIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorFracture)
    });

    /* and the burnt sheet under all of it */
    this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
      radius: this.radius * c.scorchSpread,
      life: c.scorchLife * 1.4,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorScorchEmber)
    });

    /* cinders, smoke and embers blown out of the bloom */
    this._centrePoint(_pos).setY(0.4);
    _emit.position = _pos;
    _emit.radius = this.radius * 0.5;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.cinderSpeed * 1.7;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.8;
    _emit.life = c.cinderLifetime * 1.3;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = time;
    this.cinders.emit(Math.round(c.burstCinders * g.particleCount), _emit);

    _emit.radius = this.radius * 0.8;
    _emit.speed = c.smokeSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.3;
    _emit.life = c.smokeLifetime * 1.3;
    _emit.spin = 0.6;
    this.smoke.emit(Math.round(c.burstSmoke * g.particleCount), _emit);

    _emit.radius = this.radius * 0.6;
    _emit.speed = c.emberSpeed * 1.6;
    _emit.spread = 0.9;
    _emit.size = 0.09;
    _emit.life = c.emberLifetime * 1.2;
    _emit.spin = 0;
    this.embers.emit(Math.round(c.burstEmbers * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      21
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.pyre;
    this._openTime += dt;

    // `t` runs 0..1 while the crown burns, then 1..2 while it goes out. The
    // crater and the wall of flame are carried out by the cooling inside
    // `_sync`, so the fade here only has to take the last of the alpha with it.
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));

    this._sync(fade);
    this._updateSpikes();

    // The light climbs into the crown and stays there.
    this._centrePoint(this.position);
    this.position.y = c.ringHeight * saturate(c.lightHeight) * this._openAmount();

    this._fieldFx(dt, fade * (t <= 1 ? 1 : 0.35));
    this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._activeCount = 0;
    this._drawn = 0;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
    this.field.visible = false;
    this.veil.visible = false;
    this.haze.visible = false;
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
    this.hazeGeometry.dispose();
    this.hazeMaterial.dispose();
    super.dispose();
  }
}
