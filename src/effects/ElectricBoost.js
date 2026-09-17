import { Group, Mesh, PlaneGeometry, Vector3, Color } from 'three';
import { createBodyArcMaterial, ArcPass } from '../materials/BodyArcMaterial.js';
import {
  createChargeFieldMaterial,
  createChargeCoilMaterial,
  CoilPass,
  CoilAxis
} from '../materials/ChargeFieldMaterial.js';
import { syncFresnelAura } from '../materials/FresnelAura.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on arcs alive at once. The editor's `arcs` slider clamps here. */
const MAX_ARCS = 32;
/**
 * Samples along one arc. Lower than the bolt's, because these are short: a
 * metre of arc at 48 nodes is finer than twenty metres of bolt at 72.
 */
const NODES = 48;

/** Hard ceilings on the coil. The editor's two count sliders clamp here. */
const MAX_RINGS = 16;
const MAX_SPIRES = 32;
/**
 * Samples along one ring and one upright. A ring is a *long* curve — most of a
 * circle four metres across — so it needs far more nodes than a metre of body
 * arc before its kinks stop reading as a polyline.
 */
const RING_NODES = 160;
const SPIRE_NODES = 56;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _light = new Color();

/**
 * ELECTRIC BOOST — the self buff.
 *
 * Not an `Ability`: there is no line, no aim indicator, no travelling front and
 * no target, so none of the base class applies. It is triggered on its own key,
 * holds for `settings.boost.duration` seconds and lets go, and while it holds
 * the character is charged:
 *
 *   - a **fresnel** over every material on the rig (`materials/FresnelAura.js`)
 *   - **arcs** struck over and off the body (`materials/BodyArcMaterial.js`)
 *   - **the ground**: a crater of shattered, blackened floor with the charge
 *     burning in its seams, rings of lightning lying flat around it and
 *     uprights struck off its rim (`materials/ChargeFieldMaterial.js`)
 *   - **sparks, motes, burns and a light**, shed continuously
 *
 * One 0..1 envelope drives all of it — `rampIn` up, hold, `rampOut` down — so
 * the buff arrives and leaves as a single thing rather than as several effects
 * that happen to start together.
 *
 * ## Nothing is captured
 *
 * As with every ability in the sandbox, activation stores exactly one number
 * (`_seed`, so two activations do not strike the identical arcs) and one
 * timestamp. `duration`, the size of the body, how many arcs there are and how
 * often they strike are all resolved against `settings.boost` every frame, on a
 * zero-length frame included — so the whole Boost folder in the editor is live
 * against a charged, paused character.
 */
export class ElectricBoost {
  /**
   * @param {object} context { scene, particles, lights, decals, bursts, shake,
   *   flash, character }
   */
  constructor(context) {
    this.ctx = context;
    this.character = context.character;

    this.group = new Group();
    this.group.name = 'ElectricBoost';
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
    this._arcCount = 1;
    this._ringCount = 0;
    this._spireCount = 0;
    this._light = null;
    /** Transient additive light punch, decays on its own. */
    this._lightBoost = 0;

    this._createArcs();
    this._createGround();
    this._createParticles();

    // Scratch handed to both arc passes each frame. One object, reused.
    this._state = {
      base: new Vector3(),
      right: new Vector3(1, 0, 0),
      forward: new Vector3(0, 0, 1),
      height: 1.8,
      strength: 0,
      seed: 0
    };
    /** Scratch for the crater, and for the four coil passes. Also reused. */
    this._fieldState = { radius: 1, quadSize: 1, fade: 0, seed: 0 };
    this._coilState = { base: this._state.base, radius: 1, strength: 0, seed: 0, count: 1 };
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  _createArcs() {
    this.geometry = createBoltRibbonGeometry(NODES, MAX_ARCS);

    // Halo underneath, hot core on top — the same two passes over the same
    // filaments the bolt is drawn in, so the glow stays welded to every kink.
    this.glowMaterial = createBodyArcMaterial(ArcPass.GLOW);
    this.coreMaterial = createBodyArcMaterial(ArcPass.CORE);
    this.arcMaterials = [this.glowMaterial, this.coreMaterial];

    this.meshes = [];
    for (const [index, material] of this.arcMaterials.entries()) {
      const mesh = new Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 11 + index * 2;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }

  /**
   * The floor the charge stands on: one quad for the crater, and two instanced
   * ribbons — rings lying flat on it, uprights struck off its rim — each drawn
   * in the same halo-then-core pair as the body arcs.
   *
   * All three are built in world space in their vertex shaders, exactly like the
   * arcs, so the meshes stay at identity and the only thing that moves is a
   * `uBase` uniform. The crater is the exception: it is a quad that has to be
   * placed and scaled, so it keeps its own matrix.
   */
  _createGround() {
    /* ---- the crater ---- */
    this.fieldGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.fieldMaterial = createChargeFieldMaterial();
    this.field = new Mesh(this.fieldGeometry, this.fieldMaterial);
    this.field.name = 'ElectricBoost:crater';
    this.field.layers.set(LAYER.VFX);
    this.field.frustumCulled = false;
    this.field.renderOrder = 6; // over the floor, under the burns and the arcs
    this.group.add(this.field);

    /* ---- the coil ---- */
    this.ringGeometry = createBoltRibbonGeometry(RING_NODES, MAX_RINGS);
    this.spireGeometry = createBoltRibbonGeometry(SPIRE_NODES, MAX_SPIRES);

    this.coilMaterials = [];
    this.coilMeshes = [];
    const passes = [
      [this.ringGeometry, CoilAxis.RING, CoilPass.GLOW],
      [this.ringGeometry, CoilAxis.RING, CoilPass.CORE],
      [this.spireGeometry, CoilAxis.UPRIGHT, CoilPass.GLOW],
      [this.spireGeometry, CoilAxis.UPRIGHT, CoilPass.CORE]
    ];

    for (const [index, [geometry, axis, pass]] of passes.entries()) {
      const material = createChargeCoilMaterial(pass, axis);
      const mesh = new Mesh(geometry, material);
      mesh.name = `ElectricBoost:coil${index}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      // Under the body arcs (11+): the character is what the eye reads first.
      mesh.renderOrder = 9 + (pass === CoilPass.CORE ? 1 : 0);
      this.group.add(mesh);
      this.coilMaterials.push(material);
      this.coilMeshes.push(mesh);
    }

    this.ringMaterials = [this.coilMaterials[0], this.coilMaterials[1]];
    this.spireMaterials = [this.coilMaterials[2], this.coilMaterials[3]];
  }

  _createParticles() {
    const particles = this.ctx.particles;

    // Shared with nothing: the boost sheds at its own rate for ten seconds, and
    // a ring buffer it shares with the Storm Lance would recycle the bolt's
    // sparks out from under it.
    this.sparks = particles.get('boost.sparks', {
      capacity: 3000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.5;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    this.motes = particles.get('boost.motes', {
      capacity: 2000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.6;
    this.motes.uniforms.uEndSize.value = 0.15;
    this.motes.uniforms.uSizeIn.value = 0.06;
    this.motes.uniforms.uFadeIn.value = 0.08;
    this.motes.uniforms.uFadeOut.value = 0.4;

    this.sparkEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.groundEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  /** Filaments currently drawn, over every pass. HUD readout only. */
  get instanceCount() {
    if (!this.active) return 0;
    return (
      this._arcCount * this.meshes.length +
      (this._ringCount + this._spireCount) * 2
    );
  }

  /** Seconds of charge left, against the *live* duration. */
  get remaining() {
    return this.active ? Math.max(0, settings.boost.duration - this.age) : 0;
  }

  get isReady() {
    return !this.active && this.cooldown <= 0;
  }

  /**
   * The envelope, resolved from live settings rather than stored.
   *
   * Ramping out over the *last* `rampOut` seconds of the buff rather than after
   * it means the ten seconds the ability advertises are the ten seconds it is
   * on screen for — the tail is part of the duration, not appended to it.
   */
  _envelope() {
    const c = settings.boost;
    const duration = Math.max(0.1, c.duration);
    const rampIn = Math.max(0.01, c.rampIn);
    const rampOut = Math.max(0.01, c.rampOut);
    const left = duration - this.age;

    const rise = Easing.outQuad(saturate(this.age / rampIn));
    const fall = Easing.inQuad(saturate(left / rampOut));
    return saturate(Math.min(rise, fall));
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Charge up.
   * @returns {boolean} false if it is still cooling down
   */
  activate() {
    if (this.cooldown > 0) return false;

    // Re-triggering while it is already running re-rolls the arcs and puts the
    // full duration back on the clock, rather than stacking a second buff.
    this.age = 0;
    this.strength = 0;
    this.active = true;
    this._seed = Math.random() * 100;
    this.sparkEmitter.reset();
    this.moteEmitter.reset();
    this.groundEmitter.reset();

    this.group.visible = true;
    if (!this._light) this._light = this.ctx.lights.acquire();

    this._sync(0);
    this._activateFx();
    return true;
  }

  /** Let go early. The tail is skipped — this is a cut, not a ramp out. */
  cancel() {
    if (!this.active) return;
    this.active = false;
    this.age = 0;
    this.strength = 0;
    this.group.visible = false;
    this.ctx.lights.release(this._light);
    this._light = null;
    this._sync(0);
    syncFresnelAura(0);
  }

  /** The buff running out on its own, with the pop that goes with it. */
  _expire() {
    this._expireFx();
    this.active = false;
    this.age = 0;
    this.strength = 0;
    this.group.visible = false;
    this.ctx.lights.release(this._light);
    this._light = null;
    this.cooldown = Math.max(0, settings.boost.cooldown);
    this._sync(0);
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);

    if (!this.active) {
      // Still pushed every frame: the aura block in the character's shader is
      // gated on this uniform, and leaving it stale would keep the rig lit.
      this.strength = 0;
      syncFresnelAura(0, this.character.position.y, this.character.height);
      return;
    }

    this.age += dt;
    this.strength = this._envelope();
    this._sync(this.strength);

    this._bodyFx(dt);
    this._groundFx(dt);
    this._updateLight(dt);

    this.ctx.shake.rumble(
      settings.boost.rumble * settings.global.cameraShake * this.strength,
      dt
    );

    if (this.age >= Math.max(0.1, settings.boost.duration)) this._expire();
  }

  /**
   * Push the live settings, the body's frame and the envelope into both arc
   * passes and into the character's own materials.
   */
  _sync(strength) {
    const c = settings.boost;
    const g = settings.global;
    const state = this._state;
    const character = this.character;

    // The body's own frame: yaw 0 faces +Z, so forward and right come off the
    // same angle and the ellipse the arcs are struck on turns with the rig.
    const yaw = character.facing;
    state.base.copy(character.position);
    state.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    state.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    state.height = character.height;
    state.strength = strength;
    state.seed = this._seed;

    this._arcCount = Math.max(1, Math.min(MAX_ARCS, Math.round(c.arcs)));
    this.geometry.instanceCount = this._arcCount;
    for (const material of this.arcMaterials) material.userData.sync(state);

    this._syncGround(strength);

    syncFresnelAura(strength, state.base.y, state.height);

    /* --- the two particle systems --- */
    this.sparks.setGradient(
      getColor(c.colorSparkA),
      getColor(c.colorSparkB),
      getColor(c.colorSparkC),
      getColor(c.colorSparkD)
    );
    this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
    this.sparks.uniforms.uSizeScale.value = c.sparkSize * g.particleSize * 7;
    this.sparks.uniforms.uLifeScale.value = c.sparkLifetime * 0.5 * g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uOpacity.value = g.opacity;
    this.sparks.uniforms.uGlow.value = c.arcGlow * 0.6 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.3 * g.turbulence;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = 0.9 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /**
   * The crater and the coil, re-sized and re-shaded against live settings.
   *
   * One radius (`fieldRadius`) serves all three: the crater is drawn to it, the
   * rings are spread across fractions of it and the uprights are struck off it.
   * That is deliberate — the circle on the floor is one thing, and letting the
   * rings own a radius of their own is how it stops being one.
   */
  _syncGround(strength) {
    const c = settings.boost;
    const state = this._state;
    const radius = Math.max(0.05, c.fieldRadius);

    /* --- the crater --- */
    const field = this._fieldState;
    field.radius = radius;
    // Room for the boundary at its most torn, plus the lip and a little slack:
    // a quad any tighter clips the crater it is meant to contain.
    field.quadSize = (radius * (1 + Math.max(0, c.fieldTear)) + c.fieldEdge + 0.3) * 2;
    field.fade = strength;
    field.seed = this._seed;
    this.fieldMaterial.userData.sync(field);

    this.field.visible = strength > 0.002 && c.fieldOpacity > 0.001;
    this.field.position.set(state.base.x, state.base.y + c.fieldHeight, state.base.z);
    this.field.scale.set(field.quadSize, 1, field.quadSize);

    /* --- the coil --- */
    const coil = this._coilState;
    coil.radius = radius;
    coil.strength = strength;
    coil.seed = this._seed;

    const lit = strength > 0.002 && c.coilOpacity > 0.001;

    this._ringCount = Math.max(0, Math.min(MAX_RINGS, Math.round(c.ringCount)));
    coil.count = Math.max(1, this._ringCount);
    this.ringGeometry.instanceCount = this._ringCount;
    for (const material of this.ringMaterials) material.userData.sync(coil);

    this._spireCount = Math.max(0, Math.min(MAX_SPIRES, Math.round(c.spireCount)));
    coil.count = Math.max(1, this._spireCount);
    this.spireGeometry.instanceCount = this._spireCount;
    for (const material of this.spireMaterials) material.userData.sync(coil);

    this.coilMeshes[0].visible = this.coilMeshes[1].visible = lit && this._ringCount > 0;
    this.coilMeshes[2].visible = this.coilMeshes[3].visible = lit && this._spireCount > 0;
  }

  /**
   * A point on the same capsule the arcs are struck on, so what the CPU throws
   * comes off the body the GPU is drawing rather than out of a box near it.
   *
   * @param {number} h 0..1 up the body
   * @param {number} a radians around it
   * @param {number} outward metres out from the surface
   */
  _bodyPoint(h, a, outward, out) {
    const c = settings.boost;
    const state = this._state;
    const shape = 0.42 + 0.72 * Math.sin(saturate(h) * Math.PI);
    const r = c.bodyRadius * (1 + (shape - 1) * saturate(c.bodyProfile)) + outward;

    out.copy(state.base);
    out.y += h * state.height;
    out.addScaledVector(state.right, Math.cos(a) * r);
    out.addScaledVector(state.forward, Math.sin(a) * r * c.bodyDepth);
    return out;
  }

  /** Sparks and motes coming off the charged body. */
  _bodyFx(dt) {
    const c = settings.boost;
    const g = settings.global;
    const time = frame.uTime.value;
    const scale = this.strength;

    const sparkCount = Math.round(
      this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount
    );
    if (sparkCount > 0) {
      // One point per frame, but a different one each frame: the body sheds all
      // over, and a fixed emitter would read as a single sputtering jet.
      const h = randRange(c.bodyLow, c.bodyHigh);
      const a = Math.random() * Math.PI * 2;
      this._bodyPoint(h, a, 0.06, _pos);

      // Thrown outward off the surface, biased up — sparks come off a charge,
      // they do not fall out of it.
      _dir.copy(_pos).sub(this._state.base).setY(0);
      if (_dir.lengthSq() < 1e-6) _dir.copy(this._state.right);
      _dir.normalize().multiplyScalar(0.7).setY(0.7).normalize();

      _emit.position = _pos;
      _emit.radius = 0.08;
      _emit.direction = _dir;
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      this._bodyPoint(randRange(c.bodyLow, c.bodyHigh), Math.random() * Math.PI * 2, 0.12, _pos);
      _emit.position = _pos;
      _emit.radius = 0.18;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }
  }

  /** Burns grounding out around the caster's feet. */
  _groundFx(dt) {
    const c = settings.boost;
    const burns = this.groundEmitter.tick(dt, c.groundRate * this.strength);
    if (burns <= 0) return;

    for (let i = 0; i < burns; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * c.groundSpread;
      _pos.copy(this._state.base);
      _pos.x += Math.cos(angle) * distance;
      _pos.z += Math.sin(angle) * distance;

      this.ctx.decals.spawn(DecalType.ARC, _pos, {
        radius: c.groundRadius * randRange(0.7, 1.25),
        life: c.groundLife,
        width: c.groundBranches,
        intensity: c.groundIntensity * this.strength,
        colorA: getColor(c.colorGroundEmber),
        colorB: getColor(c.colorGround)
      });
    }
  }

  _updateLight(dt) {
    if (!this._light) return;
    const c = settings.boost;

    // Quantised, like the bolt's: a charge gutters between levels, it does not
    // breathe between them.
    const step = Math.floor(frame.uTime.value * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
    const shimmer = 1 - saturate(c.lightFlicker) * noise;

    _pos.copy(this._state.base);
    _pos.y += c.lightHeight;
    _light.copy(getColor(c.lightColor));

    this.ctx.lights.set(
      this._light,
      _pos,
      _light,
      c.lightIntensity * this.strength * shimmer + this._lightBoost,
      c.lightRadius * (1 + this._lightBoost * 0.02),
      dt
    );
    this._lightBoost = Math.max(0, this._lightBoost - this._lightBoost * 4.5 * dt - 0.5 * dt);
  }

  /* ------------------------------------------------------------------ */
  /* The two beats                                                       */
  /* ------------------------------------------------------------------ */

  /** The discharge that announces the buff. */
  _activateFx() {
    const c = settings.boost;
    const g = settings.global;
    const time = frame.uTime.value;
    const state = this._state;

    /* the ring snapping out across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, state.base, {
      radius: c.ringRadius * g.explosionIntensity,
      life: 0.6,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorGround),
      colorB: getColor(c.colorBurstC)
    });

    /* a burn where it earthed */
    this.ctx.decals.spawn(DecalType.ARC, state.base, {
      radius: c.groundRadius * 2.2,
      life: c.groundLife * 1.8,
      width: c.groundBranches,
      intensity: c.groundIntensity * 1.3,
      colorA: getColor(c.colorGroundEmber),
      colorB: getColor(c.colorGround)
    });

    /* sparks blown off the body */
    _pos.copy(state.base);
    _pos.y += state.height * 0.5;
    _emit.position = _pos;
    _emit.radius = c.bodyRadius * 1.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 2.0;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorFlash), c.activateFlash * g.explosionIntensity);
    this.ctx.shake.add(
      c.activateShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this._lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  /** The smaller pop as the charge earths itself and goes. */
  _expireFx() {
    const c = settings.boost;
    const g = settings.global;
    const state = this._state;

    _pos.copy(state.base);
    _pos.y += state.height * 0.5;

    _emit.position = _pos;
    _emit.radius = c.bodyRadius * 1.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 1.3;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.burstSparks * 0.4 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorFlash), c.endFlash * g.explosionIntensity);
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.cancel();
    this.geometry.dispose();
    this.fieldGeometry.dispose();
    this.ringGeometry.dispose();
    this.spireGeometry.dispose();
    this.fieldMaterial.dispose();
    for (const material of this.arcMaterials) material.dispose();
    for (const material of this.coilMaterials) material.dispose();
    this.group.parent?.remove(this.group);
  }
}
