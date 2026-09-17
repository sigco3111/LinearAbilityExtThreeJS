import { Group, Mesh, PlaneGeometry, Vector3, Vector4, Color } from 'three';
import {
  createFireBodyMaterial,
  FlamePass,
  MAX_FLAME_BONES
} from '../materials/FireBodyMaterial.js';
import {
  createEmberOrbMaterial,
  createOrbTrailMaterial,
  sampleOrbit,
  sampleOrbScale,
  OrbPass,
  TrailPass
} from '../materials/EmberOrbMaterial.js';
import { createCinderFieldMaterial } from '../materials/CinderFieldMaterial.js';
import { syncFresnelAura } from '../materials/FresnelAura.js';
import { createBoltRibbonGeometry, createOrbFieldGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing, randRange } from '../utils/math.js';

/**
 * Hard ceiling on tongues alive at once. The editor's `flames` slider clamps
 * here.
 *
 * Raised from 64 when the tongues were re-rooted to climb *along* the limbs:
 * they are shorter now and sized to the bone under them, so covering a body in
 * fire takes more of them than it did when each one was half a metre of flame
 * going straight up. They are still one draw call per pass.
 */
const MAX_TONGUES = 96;
/**
 * Samples along one tongue. Fewer than a ribbon of smoke needs and more than a
 * body arc does: a tongue is short, but it is a *curve* — a polyline shows
 * itself the moment the sway starts bending it.
 */
const TONGUE_NODES = 44;

/** Hard ceiling on orbs. The editor's `orbs` slider clamps here. */
const MAX_ORBS = 16;
/** Subdivisions of the icosphere one orb is drawn on. */
const ORB_DETAIL = 2;
/**
 * Samples along one trail. The highest count in the project, and it has to be:
 * the trail is a *whole second* of a fast orbit, which is most of a circle
 * metres across, and every kink in it is visible against the dark.
 */
const TRAIL_NODES = 96;

const _emit = {};
const _pos = new Vector3();
const _ahead = new Vector3();
const _dir = new Vector3();
const _light = new Color();
/** Scratch for the CPU's own walk of a bone segment. */
const _axis = new Vector3();
const _n1 = new Vector3();
const _n2 = new Vector3();
const _away = new Vector3();

/**
 * FIRE BOOST — the third self buff.
 *
 * The sibling of `ElectricBoost` and `MagicBoost`, and the third reading of the
 * same idea. Same shape of thing: not an `Ability` (there is no line, no aim
 * indicator, no travelling front and no target), triggered on its own key, held
 * for `settings.fire.duration` seconds and let go. What is different is the
 * vocabulary. The charge is *struck* in filaments; the channel is *wound* in
 * sheets; this one **burns**:
 *
 *   - a **fresnel** over every material on the rig (`materials/FresnelAura.js`),
 *     the same patch the other two use, shaded as heat from this block — the
 *     mask that puts the fire *on the character* rather than in front of them
 *   - **tongues** rooted on the rig's **own bones** and climbing off them
 *     (`materials/FireBodyMaterial.js`) — so the fire is on the forearm rather
 *     than in the air near it, and swings with the arm through a cast
 *   - **orbs**, turning about the body on leaning rings, each dragging a wake of
 *     fire behind it (`materials/EmberOrbMaterial.js`)
 *   - **the ground**: the floor burnt black under the caster with the fire still
 *     working in the cracks (`materials/CinderFieldMaterial.js`)
 *   - **embers, smoke, scorches and a light**, shed continuously
 *
 * One 0..1 envelope drives all of it — `rampIn` up, hold, `rampOut` down. The
 * ramps sit between the other two buffs': fire catches faster than weather
 * arrives and slower than a charge snaps on.
 *
 * ## Nothing is captured
 *
 * As with every effect in the sandbox, activation stores exactly one number
 * (`_seed`, so two activations do not roll the identical tongues) and one
 * timestamp. `duration`, the size of the body, how many orbs there are and how
 * far they lean are all resolved against `settings.fire` every frame, on a
 * zero-length frame included — so the whole Fire Boost folder in the editor is
 * live against a burning, paused character.
 *
 * The orbs are the strongest case for that rule in the project. Their trails are
 * not recorded, they are **derived**: each is its orb's own orbit sampled
 * backward in time (see `materials/EmberOrbMaterial.js`), so dragging the tilt
 * of the rings with the clock stopped re-sweeps a second of wake instantly,
 * which no history buffer could do.
 */
export class FireBoost {
  /**
   * @param {object} context { scene, particles, lights, decals, bursts, shake,
   *   flash, character }
   */
  constructor(context) {
    this.ctx = context;
    this.character = context.character;

    this.group = new Group();
    this.group.name = 'FireBoost';
    this.group.layers.set(LAYER.VFX);
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    context.scene.add(this.group);

    this.active = false;
    /** Seconds since activation. */
    this.age = 0;
    /** Seconds left before it can be triggered again. */
    this.cooldown = 0;
    /** 0..1 envelope — the one number the whole effect is driven by. */
    this.strength = 0;

    this._seed = 0;
    this._tongueCount = 1;
    this._orbCount = 1;

    /**
     * The rig's limb segments, packed the way the flame shader reads them:
     * `_boneA[i]` is a segment's start joint with the limb's half-width in `w`,
     * `_boneB[i]` its end joint. Allocated once and rewritten in place every
     * frame; both flame passes hold these exact objects, so writing them here is
     * the only work the skeleton costs.
     */
    this._boneA = Array.from({ length: MAX_FLAME_BONES }, () => new Vector4());
    this._boneB = Array.from({ length: MAX_FLAME_BONES }, () => new Vector4());
    this._boneCount = 0;
    this._light = null;
    /** Transient additive light punch, decays on its own. */
    this._lightBoost = 0;

    this._createFlames();
    this._createOrbs();
    this._createGround();
    this._createParticles();

    // Scratch handed to every pass each frame. One object, reused.
    this._state = {
      base: new Vector3(),
      right: new Vector3(1, 0, 0),
      forward: new Vector3(0, 0, 1),
      height: 1.8,
      strength: 0,
      seed: 0,
      boneA: this._boneA,
      boneB: this._boneB,
      boneCount: 0
    };
    /** Scratch for the burn on the floor. Also reused. */
    this._fieldState = { radius: 1, quadSize: 1, fade: 0, front: 0, seed: 0 };
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  _createFlames() {
    this.flameGeometry = createBoltRibbonGeometry(TONGUE_NODES, MAX_TONGUES);

    // Heat underneath, the burning sheet on top — the same two passes over the
    // same tongues, so the glow stays welded to every lick.
    this.glowMaterial = createFireBodyMaterial(FlamePass.GLOW);
    this.flameMaterial = createFireBodyMaterial(FlamePass.FLAME);
    this.flameMaterials = [this.glowMaterial, this.flameMaterial];

    this.flameMeshes = [];
    for (const [index, material] of this.flameMaterials.entries()) {
      const mesh = new Mesh(this.flameGeometry, material);
      mesh.name = `FireBoost:flame${index}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 11 + index * 2;
      this.group.add(mesh);
      this.flameMeshes.push(mesh);
    }
  }

  /**
   * The orbs and their wakes.
   *
   * Four meshes over two geometries, all four at identity: the orbs are placed
   * by their vertex shader and the trails are swept by theirs, so the only thing
   * that crosses the bus is the body's frame. The trail geometry and the orb
   * geometry carry the *same* instance count, because instance `n` of one is the
   * wake of instance `n` of the other — that is the whole correspondence, and
   * letting the two counts drift apart would draw a trail behind an orb that is
   * not there.
   */
  _createOrbs() {
    this.trailGeometry = createBoltRibbonGeometry(TRAIL_NODES, MAX_ORBS);
    this.orbGeometry = createOrbFieldGeometry(ORB_DETAIL, MAX_ORBS);

    this.trailMaterials = [
      createOrbTrailMaterial(TrailPass.GLOW),
      createOrbTrailMaterial(TrailPass.FLAME)
    ];
    this.trailMeshes = [];
    for (const [index, material] of this.trailMaterials.entries()) {
      const mesh = new Mesh(this.trailGeometry, material);
      mesh.name = `FireBoost:trail${index}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      // Under the body flames: the character is what the eye reads first.
      mesh.renderOrder = 9 + index;
      this.group.add(mesh);
      this.trailMeshes.push(mesh);
    }

    this.orbMaterials = [
      createEmberOrbMaterial(OrbPass.CORONA),
      createEmberOrbMaterial(OrbPass.BODY)
    ];
    this.orbMeshes = [];
    for (const [index, material] of this.orbMaterials.entries()) {
      const mesh = new Mesh(this.orbGeometry, material);
      mesh.name = `FireBoost:orb${index}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      // Over everything else the buff draws: they are the brightest thing in it.
      mesh.renderOrder = 15 + index;
      this.group.add(mesh);
      this.orbMeshes.push(mesh);
    }
  }

  /**
   * The floor the fire stands on.
   *
   * Unlike the flames and the orbs — built in world space in their vertex
   * shaders, leaving their meshes at identity — the quad has to be placed and
   * scaled, so it keeps its own matrix.
   */
  _createGround() {
    this.fieldGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.fieldMaterial = createCinderFieldMaterial();
    this.field = new Mesh(this.fieldGeometry, this.fieldMaterial);
    this.field.name = 'FireBoost:burn';
    this.field.layers.set(LAYER.VFX);
    this.field.frustumCulled = false;
    this.field.renderOrder = 6; // over the floor, under the scorches and the fire
    this.group.add(this.field);
  }

  _createParticles() {
    const particles = this.ctx.particles;

    // Its own pools, for the same reason the other two buffs have theirs: this
    // sheds at its own rate for a quarter of a minute, and a buffer shared with
    // an ability would recycle its embers out from under it.
    this.embers = particles.get('fire.embers', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.embers.uniforms.uDrag.value = 1.3;
    this.embers.uniforms.uEndSize.value = 0.1; // an ember burns down to nothing
    this.embers.uniforms.uSizeIn.value = 0.04;
    this.embers.uniforms.uFadeIn.value = 0.05;
    this.embers.uniforms.uFadeOut.value = 0.5;

    // Normal blending, not additive. The same argument the channel's smoke
    // makes: additive smoke can only brighten what is behind it, and the point
    // of smoke over a fire is that it takes the light away again.
    this.smoke = particles.get('fire.smoke', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.smoke.uniforms.uDrag.value = 1.0;
    this.smoke.uniforms.uEndSize.value = 2.8; // billows out as it climbs
    this.smoke.uniforms.uSizeIn.value = 0.2;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.35;
    this.smoke.uniforms.uTurbFrequency.value = 0.4;
    this.smoke.uniforms.uTurbSpeed.value = 0.25;

    this.emberEmitter = new RateEmitter();
    this.orbEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.groundEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  /** Tongues, orbs and wakes currently drawn, over every pass. HUD readout only. */
  get instanceCount() {
    if (!this.active) return 0;
    return this._tongueCount * this.flameMeshes.length + this._orbCount * 4;
  }

  /** Seconds of fire left, against the *live* duration. */
  get remaining() {
    return this.active ? Math.max(0, settings.fire.duration - this.age) : 0;
  }

  get isReady() {
    return !this.active && this.cooldown <= 0;
  }

  /**
   * The envelope, resolved from live settings rather than stored.
   *
   * Ramping out over the *last* `rampOut` seconds of the buff rather than after
   * it means the duration the ability advertises is the time it is on screen
   * for — the tail is part of it, not appended to it.
   */
  _envelope() {
    const c = settings.fire;
    const duration = Math.max(0.1, c.duration);
    const rampIn = Math.max(0.01, c.rampIn);
    const rampOut = Math.max(0.01, c.rampOut);
    const left = duration - this.age;

    // Fire catches fast and dies slowly: a sharp rise, and a fall that lingers.
    const rise = Easing.outCubic(saturate(this.age / rampIn));
    const fall = Easing.inOutCubic(saturate(left / rampOut));
    return saturate(Math.min(rise, fall));
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Catch fire.
   * @returns {boolean} false if it is still cooling down
   */
  activate() {
    if (this.cooldown > 0) return false;

    // Re-triggering while it is already running re-rolls the fire and puts the
    // full duration back on the clock, rather than stacking a second buff.
    this.age = 0;
    this.strength = 0;
    this.active = true;
    this._seed = Math.random() * 100;
    this.emberEmitter.reset();
    this.orbEmitter.reset();
    this.smokeEmitter.reset();
    this.groundEmitter.reset();

    this.group.visible = true;
    if (!this._light) this._light = this.ctx.lights.acquire();

    this._sync(0);
    this._activateFx();
    return true;
  }

  /** Let go early. The tail is skipped — this is a cut, not a burn down. */
  cancel() {
    if (!this.active) return;
    this.active = false;
    this.age = 0;
    this.strength = 0;
    this.group.visible = false;
    this.ctx.lights.release(this._light);
    this._light = null;
    this._sync(0);
    this._releaseAura();
  }

  /** The fire burning out on its own, with the last flare that goes with it. */
  _expire() {
    this._expireFx();
    this.active = false;
    this.age = 0;
    this.strength = 0;
    this.group.visible = false;
    this.ctx.lights.release(this._light);
    this._light = null;
    this.cooldown = Math.max(0, settings.fire.cooldown);
    this._sync(0);
  }

  /**
   * Drop this buff's claim on the character's shader.
   *
   * Never a bare `syncFresnelAura(0)`: the claim has to be filed under *this*
   * buff's key or it would release one of the other two buffs' hold on the rig
   * instead of its own (see `materials/FresnelAura.js`).
   */
  _releaseAura() {
    syncFresnelAura(0, this.character.position.y, this.character.height, settings.fire, 'fire');
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);

    if (!this.active) {
      // Still pushed every frame: the aura block in the character's shader is
      // gated on this claim, and leaving it stale would keep the rig burning.
      this.strength = 0;
      this._releaseAura();
      return;
    }

    this.age += dt;
    this.strength = this._envelope();
    this._sync(this.strength);

    this._bodyFx(dt);
    this._orbFx(dt);
    this._groundFx(dt);
    this._updateLight(dt);

    this.ctx.shake.rumble(
      settings.fire.rumble * settings.global.cameraShake * this.strength,
      dt
    );

    if (this.age >= Math.max(0.1, settings.fire.duration)) this._expire();
  }

  /**
   * Push the live settings, the body's frame and the envelope into every pass,
   * the character's own materials and the two particle systems.
   */
  _sync(strength) {
    const c = settings.fire;
    const g = settings.global;
    const state = this._state;
    const character = this.character;

    // The body's own frame: yaw 0 faces +Z, so forward and right come off the
    // same angle and the rings of orbs turn with the rig.
    const yaw = character.facing;
    state.base.copy(character.position);
    state.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    state.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    state.height = character.height;
    state.strength = strength;
    state.seed = this._seed;

    this._syncSkeleton();

    /* --- the tongues --- */
    this._tongueCount = Math.max(1, Math.min(MAX_TONGUES, Math.round(c.flames)));
    this.flameGeometry.instanceCount = this._tongueCount;
    for (const material of this.flameMaterials) material.userData.sync(state);

    /* --- the orbs, and the wakes that belong to them --- */
    this._orbCount = Math.max(0, Math.min(MAX_ORBS, Math.round(c.orbs)));
    // One count, both geometries: instance n of the trail is the wake of
    // instance n of the orbs.
    this.orbGeometry.instanceCount = this._orbCount;
    this.trailGeometry.instanceCount = this._orbCount;
    for (const material of this.orbMaterials) material.userData.sync(state);
    for (const material of this.trailMaterials) material.userData.sync(state);

    const lit = strength > 0.002 && this._orbCount > 0;
    for (const mesh of this.orbMeshes) mesh.visible = lit && c.orbOpacity > 0.001;
    for (const mesh of this.trailMeshes) mesh.visible = lit && c.trailOpacity > 0.001;

    this._syncGround(strength);

    syncFresnelAura(strength, state.base.y, state.height, c, 'fire');

    /* --- the two particle systems --- */
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

    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize * 7;
    this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = g.opacity;
    // Deliberately not taking the global glow multiplier the lit systems take:
    // this is the shadow in the effect, and its gain is held under 1 so the
    // puffs stay darker than the fire they are rolling off.
    this.smoke.uniforms.uGlow.value = c.smokeGlow;
    this.smoke.uniforms.uTurbulence.value = c.smokeTurbulence * g.turbulence;
  }

  /**
   * The burn on the floor, re-sized and re-shaded against live settings.
   *
   * `front` is the envelope rather than the age, which is what makes the burn
   * spread outward as the fire catches and *retreat* as it goes out, instead of
   * fading in place. It is held a little ahead of the fade so the ground is
   * already dark before the light in the cracks arrives.
   */
  _syncGround(strength) {
    const c = settings.fire;
    const state = this._state;
    const radius = Math.max(0.05, c.fieldRadius);

    const field = this._fieldState;
    field.radius = radius;
    // Room for the boundary at its most torn, plus the feather and a little
    // slack: a quad any tighter clips the burn it is meant to contain.
    field.quadSize = (radius * (1 + Math.max(0, c.fieldTear)) + c.fieldFeather + 0.3) * 2;
    field.fade = strength;
    field.front = Math.pow(saturate(strength), 0.45);
    field.seed = this._seed;
    this.fieldMaterial.userData.sync(field);

    this.field.visible = strength > 0.002 && c.fieldOpacity > 0.001;
    this.field.position.set(state.base.x, state.base.y + c.fieldHeight, state.base.z);
    this.field.scale.set(field.quadSize, 1, field.quadSize);
  }

  /**
   * Pull this frame's pose out of the rig.
   *
   * The whole skeleton, once per frame, into the arrays both flame passes and
   * every CPU-side emitter below read. `CharacterController` has already
   * refreshed the joints' world matrices for exactly this.
   *
   * A rig whose bones this project cannot name gives nothing back, and the fire
   * would have nowhere to stand — so one segment is invented for that case,
   * running the character's own height with a plausible thickness. It is the
   * capsule the other two buffs use, arrived at from the other direction, and it
   * keeps a strange rig burning instead of burning at the world origin.
   */
  _syncSkeleton() {
    const state = this._state;
    let count = this.character.writeBoneSegments(this._boneA, this._boneB);

    if (count === 0) {
      const height = state.height;
      this._boneA[0].set(state.base.x, state.base.y + height * 0.08, state.base.z, height * 0.09);
      this._boneB[0].set(state.base.x, state.base.y + height * 0.95, state.base.z, 0);
      count = 1;
    }

    this._boneCount = count;
    state.boneCount = count;
  }

  /**
   * A point on the same skeleton the tongues are rooted on, so what the CPU
   * throws comes off the limb the GPU is burning rather than out of a box near
   * it.
   *
   * The arithmetic is `bonePoint()` from `materials/FireBodyMaterial.js`, in the
   * other language. It does not have to agree with the shader to the last digit
   * — an ember is not a drawn object the way an orb is — but it has to agree
   * about *where the body is*, and reading the same two arrays is how it does.
   *
   * @param {number} outward metres out from the limb's surface
   */
  _bonePoint(outward, out) {
    const c = settings.fire;
    const state = this._state;
    const count = Math.max(1, this._boneCount);
    const index = Math.min(count - 1, Math.floor(Math.random() * count));
    const head = this._boneA[index];
    const tail = this._boneB[index];

    _axis.set(tail.x - head.x, tail.y - head.y, tail.z - head.z);
    const length = _axis.length();
    if (length > 1e-5) _axis.multiplyScalar(1 / length);
    else _axis.set(0, 1, 0);

    const ref = Math.abs(_axis.dot(state.right)) > 0.9 ? state.forward : state.right;
    _n1.crossVectors(_axis, ref).normalize();
    _n2.crossVectors(_axis, _n1);

    const angle = Math.random() * Math.PI * 2;
    _away.copy(_n1).multiplyScalar(Math.cos(angle)).addScaledVector(_n2, Math.sin(angle));

    const along = Math.random();
    out.set(
      head.x + (tail.x - head.x) * along,
      head.y + (tail.y - head.y) * along,
      head.z + (tail.z - head.z) * along
    );
    out.addScaledVector(_away, head.w * c.boneThickness + outward);
    return out;
  }

  /** Embers coming off the burning body, and the smoke over them. */
  _bodyFx(dt) {
    const c = settings.fire;
    const g = settings.global;
    const time = frame.uTime.value;
    const scale = this.strength;

    const emberCount = Math.round(
      this.emberEmitter.tick(dt, c.emberRate * scale) * g.particleCount
    );
    if (emberCount > 0) {
      // One limb per frame, but a different one each frame: the body burns all
      // over, and a fixed emitter would read as a single sputtering jet.
      this._bonePoint(0.05, _pos);

      // Off the limb and biased hard upward: embers are carried by the draught
      // the fire is making, they are not thrown.
      _dir.copy(_away).setY(0);
      if (_dir.lengthSq() < 1e-6) _dir.copy(this._state.right);
      _dir.normalize().multiplyScalar(0.35).setY(1).normalize();

      _emit.position = _pos;
      _emit.radius = 0.1;
      _emit.direction = _dir;
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(emberCount, _emit);
    }

    const smokeCount = Math.round(
      this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount
    );
    if (smokeCount > 0) {
      this._bonePoint(0.12, _pos);
      _emit.position = _pos;
      _emit.radius = 0.22;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.55;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.34;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /**
   * Embers dribbling off the orbs.
   *
   * The reason `materials/EmberOrbMaterial.js` keeps a CPU mirror of the orbit
   * at all: these are released from where an orb *is being drawn*, with the
   * velocity it is being drawn moving at, so they fall off the ball rather than
   * appearing near it. The velocity is a finite difference on the same function
   * — a hundredth of a second either side — because differentiating three
   * chained rotations by hand is a second copy of the orbit to keep in step, and
   * this one cannot drift.
   */
  _orbFx(dt) {
    const c = settings.fire;
    const g = settings.global;
    if (this._orbCount <= 0) return;

    const count = Math.round(this.orbEmitter.tick(dt, c.orbEmberRate * this.strength) * g.particleCount);
    if (count <= 0) return;

    const time = frame.uTime.value;
    const lane = Math.floor(Math.random() * this._orbCount);
    sampleOrbit(_pos, lane, time, this._state);
    sampleOrbit(_ahead, lane, time + 0.01, this._state);

    _dir.copy(_ahead).sub(_pos);
    if (_dir.lengthSq() < 1e-9) _dir.set(0, 1, 0);
    // Shed *backward* along the orbit and lifted a little: what comes off a
    // burning ball is left behind by it.
    _dir.normalize().multiplyScalar(-1).setY(0.55).normalize();

    _emit.position = _pos;
    _emit.radius = sampleOrbScale(lane) * 0.9;
    _emit.direction = _dir;
    _emit.speed = c.orbEmberSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.65;
    _emit.life = c.emberLifetime * 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(count, _emit);
  }

  /** Scorches licking outward across the floor around the caster's feet. */
  _groundFx(dt) {
    const c = settings.fire;
    const burns = this.groundEmitter.tick(dt, c.groundRate * this.strength);
    if (burns <= 0) return;

    for (let i = 0; i < burns; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * c.groundSpread;
      _pos.copy(this._state.base);
      _pos.x += Math.cos(angle) * distance;
      _pos.z += Math.sin(angle) * distance;

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.groundRadius * randRange(0.7, 1.3),
        life: c.groundLife,
        intensity: c.groundIntensity * this.strength,
        colorA: getColor(c.colorGround),
        colorB: getColor(c.colorGroundEmber),
        height: 0.016
      });
    }
  }

  _updateLight(dt) {
    if (!this._light) return;
    const c = settings.fire;
    const time = frame.uTime.value;

    // A fire's light is neither the charge's quantised gutter nor the channel's
    // smooth swell: it is two sines that never share a period, so the flicker
    // never settles into a rhythm you can hear counting.
    const flicker =
      1 -
      saturate(c.lightFlicker) *
        (0.5 + 0.5 * Math.sin(time * c.lightFlickerSpeed)) *
        (0.6 + 0.4 * Math.sin(time * c.lightFlickerSpeed * 2.7 + 1.3));

    _pos.copy(this._state.base);
    _pos.y += c.lightHeight;
    _light.copy(getColor(c.lightColor));

    this.ctx.lights.set(
      this._light,
      _pos,
      _light,
      c.lightIntensity * this.strength * flicker + this._lightBoost,
      c.lightRadius * (1 + this._lightBoost * 0.02),
      dt
    );
    this._lightBoost = Math.max(0, this._lightBoost - this._lightBoost * 3.8 * dt - 0.45 * dt);
  }

  /* ------------------------------------------------------------------ */
  /* The two beats                                                       */
  /* ------------------------------------------------------------------ */

  /** The ignition. */
  _activateFx() {
    const c = settings.fire;
    const g = settings.global;
    const time = frame.uTime.value;
    const state = this._state;

    /* the ring running out across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, state.base, {
      radius: c.ringRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.06,
      intensity: 1.0,
      colorA: getColor(c.colorGroundEmber),
      colorB: getColor(c.colorBurstC)
    });

    /* the mark it leaves where it caught */
    this.ctx.decals.spawn(DecalType.SCORCH, state.base, {
      radius: c.groundRadius * 2.6,
      life: c.groundLife * 2.0,
      intensity: c.groundIntensity * 1.4,
      colorA: getColor(c.colorGround),
      colorB: getColor(c.colorGroundEmber),
      height: 0.014
    });

    /* embers blown off the body */
    _pos.copy(state.base);
    _pos.y += state.height * 0.45;
    _emit.position = _pos;
    _emit.radius = c.burstSpread;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.emberSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.75;
    _emit.life = c.emberLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.embers.emit(Math.round(c.burstEmbers * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorFlash), c.activateFlash * g.explosionIntensity);
    this.ctx.shake.add(
      c.activateShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18 // between the charge's crack and the channel's roll
    );
    this._lightBoost = c.lightIntensity * 0.85 * g.explosionIntensity;
  }

  /** The smaller flare as the fire goes out, and the smoke that outlives it. */
  _expireFx() {
    const c = settings.fire;
    const g = settings.global;
    const state = this._state;

    _pos.copy(state.base);
    _pos.y += state.height * 0.5;

    // The smoke is let go rather than pulled in: one last billow off the whole
    // body, so what is left of the fire is the thing you cannot see through.
    _pos.copy(state.base);
    _pos.y += state.height * 0.5;
    _emit.position = _pos;
    _emit.radius = c.burstSpread * 1.1;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.smokeSpeed * 1.8;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.42;
    _emit.sizeVariance = 0.5;
    _emit.life = c.smokeLifetime * 1.3;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.35;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.smoke.emit(Math.round(c.endSmoke * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorFlash), c.endFlash * g.explosionIntensity);
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.cancel();
    this.flameGeometry.dispose();
    this.trailGeometry.dispose();
    this.orbGeometry.dispose();
    this.fieldGeometry.dispose();
    this.fieldMaterial.dispose();
    for (const material of this.flameMaterials) material.dispose();
    for (const material of this.trailMaterials) material.dispose();
    for (const material of this.orbMaterials) material.dispose();
    this.group.parent?.remove(this.group);
  }
}
