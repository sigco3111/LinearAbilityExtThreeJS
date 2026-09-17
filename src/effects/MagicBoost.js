import { Group, Mesh, PlaneGeometry, Vector3, Color } from 'three';
import { createArcaneRibbonMaterial, RibbonPass } from '../materials/ArcaneRibbonMaterial.js';
import { createDarkFieldMaterial } from '../materials/DarkFieldMaterial.js';
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

/** Hard ceiling on ribbons alive at once. The editor's `ribbons` slider clamps here. */
const MAX_RIBBONS = 24;
/**
 * Samples along one ribbon. Far more than a body arc needs: an arc is a metre
 * of deliberately kinked line, this is several metres of curve that has to read
 * as *smooth* — a polyline shows itself immediately on a sheet this wide.
 */
const NODES = 112;

const _emit = {};
const _pos = new Vector3();
const _anchor = new Vector3();
const _dir = new Vector3();
const _light = new Color();

/**
 * MAGIC BOOST — the second self buff.
 *
 * The sibling of `ElectricBoost`, and its opposite reading. Same shape of
 * thing: not an `Ability` (there is no line, no aim indicator, no travelling
 * front and no target), triggered on its own key, held for
 * `settings.magic.duration` seconds and let go. What is different is the
 * vocabulary — where the charge is struck in hairline filaments at twenty
 * strikes a second, this is *channelled*:
 *
 *   - a **fresnel** over every material on the rig (`materials/FresnelAura.js`),
 *     the same patch the charge uses, shaded violet from this block
 *   - **ribbons** wound around the body and turning about it
 *     (`materials/ArcaneRibbonMaterial.js`)
 *   - **the ground**: smoke lying on the floor, sheared into a spiral, with the
 *     light of the buff pooled under it (`materials/DarkFieldMaterial.js`)
 *   - **smoke, motes, burns and a light**, shed continuously
 *
 * One 0..1 envelope drives all of it — `rampIn` up, hold, `rampOut` down. The
 * ramps are deliberately several times longer than the charge's: this arrives
 * the way weather does.
 *
 * ## Nothing is captured
 *
 * As with every effect in the sandbox, activation stores exactly one number
 * (`_seed`, so two activations do not wind the identical vortex) and one
 * timestamp. `duration`, the size of the body, how many ribbons there are and
 * how fast they turn are all resolved against `settings.magic` every frame, on
 * a zero-length frame included — so the whole Magic Boost folder in the editor
 * is live against a channelling, paused character.
 */
export class MagicBoost {
  /**
   * @param {object} context { scene, particles, lights, decals, bursts, shake,
   *   flash, character }
   */
  constructor(context) {
    this.ctx = context;
    this.character = context.character;

    this.group = new Group();
    this.group.name = 'MagicBoost';
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
    this._ribbonCount = 1;
    this._light = null;
    /** Transient additive light punch, decays on its own. */
    this._lightBoost = 0;

    this._createRibbons();
    this._createGround();
    this._createParticles();

    // Scratch handed to both ribbon passes each frame. One object, reused.
    this._state = {
      base: new Vector3(),
      right: new Vector3(1, 0, 0),
      forward: new Vector3(0, 0, 1),
      height: 1.8,
      strength: 0,
      seed: 0,
      count: 1
    };
    /** Scratch for the smoke on the floor. Also reused. */
    this._fieldState = { radius: 1, quadSize: 1, fade: 0, seed: 0 };
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  _createRibbons() {
    this.geometry = createBoltRibbonGeometry(NODES, MAX_RIBBONS);

    // Halo underneath, sheet on top — the same two passes over the same helices
    // the arcs use, so the glow stays welded to every turn of the vortex.
    this.glowMaterial = createArcaneRibbonMaterial(RibbonPass.GLOW);
    this.bandMaterial = createArcaneRibbonMaterial(RibbonPass.BAND);
    this.ribbonMaterials = [this.glowMaterial, this.bandMaterial];

    this.meshes = [];
    for (const [index, material] of this.ribbonMaterials.entries()) {
      const mesh = new Mesh(this.geometry, material);
      mesh.name = `MagicBoost:ribbon${index}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 11 + index * 2;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }

  /**
   * The floor the channel stands on: one quad of turning smoke with the buff's
   * light pooled under it.
   *
   * Unlike the ribbons — which are built in world space in their vertex shader
   * and leave their mesh at identity — the quad has to be placed and scaled, so
   * it keeps its own matrix.
   */
  _createGround() {
    this.fieldGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.fieldMaterial = createDarkFieldMaterial();
    this.field = new Mesh(this.fieldGeometry, this.fieldMaterial);
    this.field.name = 'MagicBoost:smoke';
    this.field.layers.set(LAYER.VFX);
    this.field.frustumCulled = false;
    this.field.renderOrder = 6; // over the floor, under the burns and the ribbons
    this.group.add(this.field);
  }

  _createParticles() {
    const particles = this.ctx.particles;

    // Its own pools, for the same reason the charge has its own: this sheds at
    // its own rate for a quarter of a minute, and a buffer shared with an
    // ability would recycle its smoke out from under it.
    //
    // Normal blending, not additive — the only shed system in the project that
    // is. Additive smoke is a contradiction: it can only ever brighten what is
    // behind it, and the whole point of this cloud is that it takes the room
    // away.
    this.smoke = particles.get('magic.smoke', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.7
    });
    this.smoke.uniforms.uDrag.value = 1.1;
    this.smoke.uniforms.uEndSize.value = 2.4; // billows out as it climbs
    this.smoke.uniforms.uSizeIn.value = 0.25;
    this.smoke.uniforms.uFadeIn.value = 0.22;
    this.smoke.uniforms.uFadeOut.value = 0.3;
    this.smoke.uniforms.uTurbFrequency.value = 0.35;
    this.smoke.uniforms.uTurbSpeed.value = 0.2;

    // Swirl: these orbit the character rather than flying off it, which is what
    // ties the loose particles to the ribbons instead of leaving them as a
    // separate effect happening in the same place.
    this.motes = particles.get('magic.motes', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.4;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.08;
    this.motes.uniforms.uFadeIn.value = 0.12;
    this.motes.uniforms.uFadeOut.value = 0.45;

    this.smokeEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.groundEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  /** Ribbons currently drawn, over both passes. HUD readout only. */
  get instanceCount() {
    return this.active ? this._ribbonCount * this.meshes.length : 0;
  }

  /** Seconds of channel left, against the *live* duration. */
  get remaining() {
    return this.active ? Math.max(0, settings.magic.duration - this.age) : 0;
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
    const c = settings.magic;
    const duration = Math.max(0.1, c.duration);
    const rampIn = Math.max(0.01, c.rampIn);
    const rampOut = Math.max(0.01, c.rampOut);
    const left = duration - this.age;

    // Smooth at both ends, where the charge is quadratic: this one has to swell
    // rather than snap on.
    const rise = Easing.inOutCubic(saturate(this.age / rampIn));
    const fall = Easing.inOutCubic(saturate(left / rampOut));
    return saturate(Math.min(rise, fall));
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Open the channel.
   * @returns {boolean} false if it is still cooling down
   */
  activate() {
    if (this.cooldown > 0) return false;

    // Re-triggering while it is already running re-rolls the vortex and puts
    // the full duration back on the clock, rather than stacking a second buff.
    this.age = 0;
    this.strength = 0;
    this.active = true;
    this._seed = Math.random() * 100;
    this.smokeEmitter.reset();
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
    this._releaseAura();
  }

  /** The channel running out on its own, with the sigh that goes with it. */
  _expire() {
    this._expireFx();
    this.active = false;
    this.age = 0;
    this.strength = 0;
    this.group.visible = false;
    this.ctx.lights.release(this._light);
    this._light = null;
    this.cooldown = Math.max(0, settings.magic.cooldown);
    this._sync(0);
  }

  /**
   * Drop this buff's claim on the character's shader.
   *
   * Never a bare `syncFresnelAura(0)`: the claim has to be filed under *this*
   * buff's key or it would release the electric one's hold on the rig instead
   * of its own (see `materials/FresnelAura.js`).
   */
  _releaseAura() {
    syncFresnelAura(0, this.character.position.y, this.character.height, settings.magic, 'magic');
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);

    if (!this.active) {
      // Still pushed every frame: the aura block in the character's shader is
      // gated on this claim, and leaving it stale would keep the rig lit.
      this.strength = 0;
      this._releaseAura();
      return;
    }

    this.age += dt;
    this.strength = this._envelope();
    this._sync(this.strength);

    this._bodyFx(dt);
    this._groundFx(dt);
    this._updateLight(dt);

    this.ctx.shake.rumble(
      settings.magic.rumble * settings.global.cameraShake * this.strength,
      dt
    );

    if (this.age >= Math.max(0.1, settings.magic.duration)) this._expire();
  }

  /**
   * Push the live settings, the body's frame and the envelope into both ribbon
   * passes, the floor, the character's own materials and the two particle
   * systems.
   */
  _sync(strength) {
    const c = settings.magic;
    const g = settings.global;
    const state = this._state;
    const character = this.character;

    // The body's own frame: yaw 0 faces +Z, so forward and right come off the
    // same angle and the vortex turns with the rig.
    const yaw = character.facing;
    state.base.copy(character.position);
    state.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    state.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    state.height = character.height;
    state.strength = strength;
    state.seed = this._seed;

    this._ribbonCount = Math.max(1, Math.min(MAX_RIBBONS, Math.round(c.ribbons)));
    state.count = this._ribbonCount;
    this.geometry.instanceCount = this._ribbonCount;
    for (const material of this.ribbonMaterials) material.userData.sync(state);

    this._syncGround(strength);

    syncFresnelAura(strength, state.base.y, state.height, c, 'magic');

    /* --- the two particle systems --- */
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
    // this one is the shadow in the effect, and its gain is held under 1 so the
    // puffs stay darker than the floor they are lying on.
    this.smoke.uniforms.uGlow.value = c.smokeGlow;
    this.smoke.uniforms.uTurbulence.value = c.smokeTurbulence * g.turbulence;

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
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uSwirl.value = c.moteSwirl * g.speed;
    this.motes.uniforms.uSwirlExpand.value = c.moteExpand;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /** The smoke on the floor, re-sized and re-shaded against live settings. */
  _syncGround(strength) {
    const c = settings.magic;
    const state = this._state;
    const radius = Math.max(0.05, c.fieldRadius);

    const field = this._fieldState;
    field.radius = radius;
    // Room for the boundary at its most torn, plus a little slack: a quad any
    // tighter clips the cloud it is meant to contain.
    field.quadSize = (radius * (1 + Math.max(0, c.fieldTear)) + 0.3) * 2;
    field.fade = strength;
    field.seed = this._seed;
    this.fieldMaterial.userData.sync(field);

    this.field.visible = strength > 0.002 && c.fieldOpacity > 0.001;
    this.field.position.set(state.base.x, state.base.y + c.fieldHeight, state.base.z);
    this.field.scale.set(field.quadSize, 1, field.quadSize);
  }

  /**
   * A point on the ring the vortex turns on, so what the CPU throws comes off
   * the same cylinder the GPU is drawing the ribbons around.
   *
   * @param {number} h 0..1 up the body
   * @param {number} a radians around it
   * @param {number} radius metres out from the axis
   */
  _ringPoint(h, a, radius, out) {
    const state = this._state;
    out.copy(state.base);
    out.y += h * state.height;
    out.addScaledVector(state.right, Math.cos(a) * radius);
    out.addScaledVector(state.forward, Math.sin(a) * radius);
    return out;
  }

  /** Smoke rolling off the body, and motes turning around it. */
  _bodyFx(dt) {
    const c = settings.magic;
    const g = settings.global;
    const time = frame.uTime.value;
    const scale = this.strength;
    const state = this._state;

    const smokeCount = Math.round(
      this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount
    );
    if (smokeCount > 0) {
      // Released low and wide: this is the cloud the character is standing in,
      // not something pouring off their shoulders.
      const angle = Math.random() * Math.PI * 2;
      this._ringPoint(0, angle, c.smokeSpread * Math.sqrt(Math.random()), _pos);
      _pos.y += c.smokeSeat;

      _dir.copy(_pos).sub(state.base).setY(0);
      if (_dir.lengthSq() < 1e-6) _dir.copy(state.right);
      _dir.normalize().multiplyScalar(0.55).setY(0.45).normalize();

      _emit.position = _pos;
      _emit.radius = 0.25;
      _emit.direction = _dir;
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.8;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.42;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const h = randRange(c.moteLow, c.moteHigh);
      this._ringPoint(h, Math.random() * Math.PI * 2, c.moteRadius * randRange(0.7, 1.15), _pos);

      // The swirl anchor is the axis the orbit turns about, so it has to be the
      // caster's own feet — anchoring on the emission point instead would give
      // every mote a private little circle to spin in.
      _anchor.copy(state.base);

      _emit.position = _pos;
      _emit.radius = 0.12;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.35;
      _emit.inherit = null;
      _emit.anchor = _anchor;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }
  }

  /** Soft rings of smoke settling on the floor around the caster's feet. */
  _groundFx(dt) {
    const c = settings.magic;
    const rings = this.groundEmitter.tick(dt, c.groundRate * this.strength);
    if (rings <= 0) return;

    for (let i = 0; i < rings; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * c.groundSpread;
      _pos.copy(this._state.base);
      _pos.x += Math.cos(angle) * distance;
      _pos.z += Math.sin(angle) * distance;

      this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
        radius: c.groundRadius * randRange(0.7, 1.3),
        life: c.groundLife,
        intensity: c.groundIntensity * this.strength,
        colorA: getColor(c.colorGroundEmber),
        colorB: getColor(c.colorGround)
      });
    }
  }

  _updateLight(dt) {
    if (!this._light) return;
    const c = settings.magic;

    // A swell, not a gutter: two things separate this light from the charge's,
    // and the fact that it never stutters is the louder of them.
    const swell =
      1 + saturate(c.lightPulse) * Math.sin(frame.uTime.value * c.lightPulseSpeed * Math.PI * 2);

    _pos.copy(this._state.base);
    _pos.y += c.lightHeight;
    _light.copy(getColor(c.lightColor));

    this.ctx.lights.set(
      this._light,
      _pos,
      _light,
      c.lightIntensity * this.strength * swell + this._lightBoost,
      c.lightRadius * (1 + this._lightBoost * 0.02),
      dt
    );
    this._lightBoost = Math.max(0, this._lightBoost - this._lightBoost * 3.0 * dt - 0.4 * dt);
  }

  /* ------------------------------------------------------------------ */
  /* The two beats                                                       */
  /* ------------------------------------------------------------------ */

  /** The bloom of displaced air that opens the channel. */
  _activateFx() {
    const c = settings.magic;
    const g = settings.global;
    const time = frame.uTime.value;
    const state = this._state;

    /* a shell of displaced air around the whole body */
    _pos.copy(state.base);
    _pos.y += state.height * 0.55;

    /* the ring pushing out across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, state.base, {
      radius: c.ringRadius * g.explosionIntensity,
      life: 0.85,
      width: 0.07,
      intensity: 0.9,
      colorA: getColor(c.colorGround),
      colorB: getColor(c.colorBurstC)
    });

    /* the first of the smoke, laid where it opened */
    this.ctx.decals.spawn(DecalType.DUSTRING, state.base, {
      radius: c.groundRadius * 2.4,
      life: c.groundLife * 2.0,
      intensity: c.groundIntensity * 1.4,
      colorA: getColor(c.colorGroundEmber),
      colorB: getColor(c.colorGround)
    });

    /* motes drawn up off the floor */
    _pos.copy(state.base);
    _pos.y += state.height * 0.35;
    _anchor.copy(state.base);
    _emit.position = _pos;
    _emit.radius = c.moteRadius * 1.3;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed * 3.0;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = _anchor;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime * 1.3;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.motes.emit(Math.round(c.burstMotes * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorFlash), c.activateFlash * g.explosionIntensity);
    this.ctx.shake.add(
      c.activateShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      14 // slower than the charge's: this one rolls rather than cracks
    );
    this._lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  /** The smaller sigh as the channel closes. */
  _expireFx() {
    const c = settings.magic;
    const g = settings.global;
    const state = this._state;

    _pos.copy(state.base);
    _pos.y += state.height * 0.5;

    // The cloud is let go rather than pulled in: one last billow, thrown wide
    // and low, so the smoke outlives the light that was in it.
    _pos.copy(state.base);
    _pos.y += c.smokeSeat;
    _emit.position = _pos;
    _emit.radius = c.smokeSpread * 1.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.smokeSpeed * 1.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.5;
    _emit.sizeVariance = 0.5;
    _emit.life = c.smokeLifetime * 1.2;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.smoke.emit(Math.round(60 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorFlash), c.endFlash * g.explosionIntensity);
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.cancel();
    this.geometry.dispose();
    this.fieldGeometry.dispose();
    this.fieldMaterial.dispose();
    for (const material of this.ribbonMaterials) material.dispose();
    this.group.parent?.remove(this.group);
  }
}
