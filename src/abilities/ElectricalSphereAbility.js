import { Mesh, InstancedMesh, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import {
  createSphereBodyMaterial,
  createPlatformMaterial
} from '../materials/ElectricalSphereMaterial.js';
import { RadialBoltPass, createRadialBoltMaterial } from '../materials/RadialBoltMaterial.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

/**
 * The **max** number of radial bolt strands. The editor's `arcCount` slider
 * clamps to this; the ability allocates exactly the geometry it needs and the
 * vertex shader picks the strand from the instance index.
 */
const MAX_ARC_STRANDS = 80;
/** Knots along one ribbon strand. 56 is enough to read every kink. */
const ARC_NODES = 56;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const TAU = Math.PI * 2;

/**
 * ELECTRICAL SPHERE — a far cast that drops a contained plasma orb.
 *
 * The caster whips a line of current out across the floor to the aimed point;
 * where it lands the ground splits, a containment platform blooms out, and a
 * dark polished sphere rises out of the middle and hovers there — mirroring
 * the room, ringed in Fresnel light, electricity crawling flat across its skin
 * and arcs tearing off it — until it collapses inward and vanishes.
 *
 * The whole effect is three GPU shaders, all of which read `settings.electrical`
 * every frame and re-resolve themselves on a zero-length frame, so the
 * editor's sliders reshape a sphere that is already standing, with the clock
 * paused. That is the only reason the editor is useful.
 *
 * ## The three shaders
 *
 *   - **`createSphereBodyMaterial`** — the sphere itself: an opaque, near-black
 *     reflective shell. It mirrors the scene HDR in the view-reflection
 *     direction with a Fresnel weight, takes a hard specular glint, carries a
 *     restriking discharge net across its skin, and is lit around its
 *     silhouette by Fresnel alone. It writes depth, so it occludes properly.
 *   - **`createPlatformMaterial`** — the containment disc on the floor. Same
 *     vocabulary (rings, hex grain, hot inner band, outward pulse rings) so
 *     the sphere reads as seated on a device.
 *   - **`createRadialBoltMaterial`** — the chaotic arcs. Instanced ribbon
 *     geometry; every instance is a bolt from a random point on the sphere
 *     surface to a random point out in space, re-struck on its own clock.
 *
 * There was a fourth: a larger additive shell carrying a corona of flame. It
 * washed out the reflection it was drawn over and read as a smoky bubble
 * around the ball rather than as energy coming off it, so the silhouette light
 * is now the body's own Fresnel terms — and the energy leaving the ball is the
 * bolts, which start **on its surface**, at its hovering centre, not at the
 * point on the floor underneath it.
 *
 * ## The pulse
 *
 * The pulse is a `pulse()` function of `age` — a smooth organic envelope
 * that fires roughly twice a second. It is *added* to the materials' `uPulse`
 * uniform and *multiplied* into the particle emitter rates, so the whole
 * effect breathes in time. It is **not** a scale animation.
 *
 * ## What a cast captures
 *
 * A seed, and a few timestamps (the cast's own phases, and the per-particle
 * spawn moment). Nothing else. The radius, the noise scale, the arc count,
 * the pulse frequency — every one of them is read off `settings.electrical`
 * inside the update loop, which is what makes the editor live.
 */
export class ElectricalSphereAbility extends Ability {
  constructor(context) {
    super('electrical', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the sphere body ---- */
    this.sphereGeometry = new SphereGeometry(1, 64, 48);
    this.sphereMaterial = createSphereBodyMaterial();
    this.sphere = new Mesh(this.sphereGeometry, this.sphereMaterial);
    this.sphere.name = 'ElectricalSphere:body';
    this.sphere.layers.set(LAYER.VFX);
    this.sphere.frustumCulled = false;
    this.sphere.renderOrder = 11;
    this.sphere.visible = false;
    this.group.add(this.sphere);

    /* ---- the ground platform ---- */
    this.platformGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.platformMaterial = createPlatformMaterial();
    this.platform = new Mesh(this.platformGeometry, this.platformMaterial);
    this.platform.name = 'ElectricalSphere:platform';
    this.platform.layers.set(LAYER.VFX);
    this.platform.frustumCulled = false;
    this.platform.renderOrder = 8;
    this.platform.visible = false;
    this.group.add(this.platform);

    /* ---- the radial bolt corona ---- */
    // One ribbon, instanced. Each instance is one strand; the vertex shader
    // computes the path from the instance index.
    this.boltGeometry = createBoltRibbonGeometry(ARC_NODES, MAX_ARC_STRANDS);
    this.coreBoltMaterial = createRadialBoltMaterial(RadialBoltPass.CORE);
    this.haloBoltMaterial = createRadialBoltMaterial(RadialBoltPass.GLOW);
    this.boltMaterials = [this.coreBoltMaterial, this.haloBoltMaterial];

    this.boltMeshes = [];
    for (const [index, material] of this.boltMaterials.entries()) {
      const mesh = new InstancedMesh(this.boltGeometry, material, MAX_ARC_STRANDS);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      // Halo first so the core draws on top of it.
      mesh.renderOrder = 13 + index * 2;
      mesh.count = 0;
      this.group.add(mesh);
      this.boltMeshes.push(mesh);
    }

    /** Re-rolled per cast so two spheres draw different arcs. */
    this._seed = 0;
    /** Seconds since the bloom started opening. Drives the formation. */
    this._bloomTime = 0;
    /** Last decoded pulse value, used by the corona. */
    this._pulse = 0;
    /** Metres the front has paid out in platform decals. */
    this._platformDistance = 0;

    // Scratch state handed to every shader each frame. One object, reused —
    // syncing the cast allocates nothing.
    this._state = {
      /** The cast point, on the floor. What the platform and particles use. */
      center: new Vector3(),
      /**
       * The sphere's own world position — the floor point lifted by the hover.
       * The bolts are built around *this*, which is the difference between arcs
       * leaving the ball and arcs erupting from the ground underneath it.
       */
      sphereCenter: new Vector3(),
      sphereRadius: 1.0,
      shellRadius: 1.0,
      seed: 0,
      fade: 1,
      pulse: 0
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Sparks — bright streaks thrown out from the sphere. The corona's
    // signature particle.
    this.sparks = particles.get('electrical.sparks', {
      capacity: 6000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.0;
    this.sparks.uniforms.uEndSize.value = 0.18;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.4;

    // Motes — slow ionised particles drifting off the surface, lit by the
    // sphere's pulse.
    this.motes = particles.get('electrical.motes', {
      capacity: 4000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.2;
    this.motes.uniforms.uEndSize.value = 0.16;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.08;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // Embers — small hot chips drifting up and away. Catches the orange end
    // of the palette without competing with the sparks.
    this.embers = particles.get('electrical.embers', {
      capacity: 3000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.embers.uniforms.uDrag.value = 0.7;
    this.embers.uniforms.uEndSize.value = 0.12;
    this.embers.uniforms.uSizeIn.value = 0.03;
    this.embers.uniforms.uFadeIn.value = 0.05;
    this.embers.uniforms.uFadeOut.value = 0.5;

    // Smoke — the haze off the scorched platform under the sphere. Sparse.
    this.smoke = particles.get('electrical.smoke', {
      capacity: 2000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.smoke.uniforms.uDrag.value = 1.6;
    this.smoke.uniforms.uEndSize.value = 2.5;
    this.smoke.uniforms.uSizeIn.value = 0.1;
    this.smoke.uniforms.uFadeIn.value = 0.15;
    this.smoke.uniforms.uFadeOut.value = 0.35;

    this.sparkEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.emberEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._arcCount;
  }

  /** The sphere rises, the corona forms, and it holds. */
  get impactDuration() {
    const c = settings.electrical;
    return Math.max(0.3, c.snapTime + c.lifetime * settings.global.lifetime);
  }

  /** Collapse inward, then blink out. */
  get fadeDuration() {
    const c = settings.electrical;
    return Math.max(0.2, c.collapseTime + c.fadeTime);
  }

  /** The footprint, metres. What the zone indicator measures out. */
  get radius() {
    return Math.max(0.1, settings.electrical.zoneRadius);
  }

  /** Sphere radius at this frame, metres. */
  get sphereRadius() {
    return Math.max(0.05, settings.electrical.sphereRadius);
  }

  /** A live arc count that respects the editor's slider. */
  get _arcCount() {
    return Math.max(0, Math.min(MAX_ARC_STRANDS, Math.round(settings.electrical.arcCount)));
  }

  /**
   * The pulse envelope, 0..1.
   *
   * A pair of sine waves multiplied together so the beat feels organic: a
   * primary wave at `pulseFrequency` Hz and a slower one that drifts the
   * rhythm slightly, then a quantised spike layered on top so the pulse
   * actually *peaks* rather than merely oscillating.
   */
  _pulseAt(t, c) {
    const freq = c.pulseFrequency;
    const primary = 0.5 + 0.5 * Math.sin(t * freq * TAU);
    const drift = 0.5 + 0.5 * Math.sin(t * freq * 0.43 * TAU + 1.7);
    const beat = primary * drift;
    // A quantised spike on top, so the pulse reads as discrete events.
    const strike = Math.floor(t * freq);
    const strikePhase = (t * freq - strike) * freq;
    const spike = Math.exp(-strikePhase * 3.0) * c.pulseStrength;
    return saturate(beat * 0.5 + spike);
  }

  /** Sphere scale at this moment of the cast, 0..1. */
  _openAmount() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    const c = settings.electrical;
    return Easing.outCubic(saturate(this._bloomTime / Math.max(0.05, c.snapTime)));
  }

  /** Collapse factor, 0..1, while the fade is in progress. */
  _collapseAmount() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const c = settings.electrical;
    const collapse = Math.max(0.05, c.collapseTime);
    return saturate(this.fadeTime / collapse);
  }

  /** The height the sphere hovers at, metres. */
  _hoverHeight() {
    const c = settings.electrical;
    return c.hoverHeight;
  }

  /** Tiny floating motion the sphere makes while it holds. */
  _hoverOffset(t, c) {
    return Math.sin(t * c.hoverSpeed * TAU) * c.hoverAmplitude;
  }

  /** Light stutters like lightning — quantised hash, not sinusoidal. */
  lightShimmer() {
    const c = settings.electrical;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise * 0.7;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The centre of the cast — the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the front leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.electrical;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sparkEmitter.reset();
    this.moteEmitter.reset();
    this.emberEmitter.reset();
    this.smokeEmitter.reset();
    this._platformDistance = 0;
    this._bloomTime = 0;
    this._pulse = 0;

    // The one thing a cast captures.
    this._seed = Math.random() * 100;

    this._sync(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into all five materials.
   *
   * @param {number} fade 1 while the sphere is lit, ramping to 0 as it dies
   */
  _sync(fade) {
    const c = settings.electrical;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(this._state.center);
    const open = this._openAmount();
    const collapse = this._collapseAmount();
    const sphereScale = lerp(0.001, 1.0, open) * (1 - collapse);
    const sphereRadius = this.sphereRadius * sphereScale;
    this._state.sphereRadius = sphereRadius;
    this._state.shellRadius = sphereRadius;
    this._state.fade = fade;
    this._state.pulse = this._pulse;
    this._state.seed = this._seed;

    /* --- sphere --- */
    // The hovering centre is resolved whether or not the ball is drawn, because
    // the bolts are built around it and they are a separate mesh.
    this._state.sphereCenter.copy(this._state.center);
    this._state.sphereCenter.y = this._hoverHeight() + this._hoverOffset(this.age, c);

    this.sphere.visible = fade > 0.001 && open > 0.001 && sphereRadius > 0.001;
    if (this.sphere.visible) {
      this.sphere.scale.setScalar(sphereRadius);
      this.sphere.position.copy(this._state.sphereCenter);
      this.sphereMaterial.userData.sync(this._state);
    }

    /* --- platform --- */
    this.platform.visible = fade > 0.001 && open > 0.001;
    if (this.platform.visible) {
      const platformScale = c.platformRadius * 2 * (0.4 + 0.6 * open);
      this.platform.scale.set(platformScale, 1, platformScale);
      this.platform.position.copy(this._state.center);
      this.platform.position.y = 0.02;
      this.platformMaterial.userData.sync(this._state);
    }

    /* --- corona bolts --- */
    const arcCount = this._arcCount;
    this.boltGeometry.instanceCount = arcCount;
    for (const mesh of this.boltMeshes) {
      mesh.count = arcCount;
      if (arcCount > 0) {
        // Identity matrix per instance: the vertex shader computes the bolt
        // from `aStrand` (instance index) and `uCenter`, not from any matrix.
        const m = mesh.instanceMatrix.array;
        for (let i = 0; i < arcCount; i++) {
          m[i * 16 + 0] = 1;
          m[i * 16 + 5] = 1;
          m[i * 16 + 10] = 1;
          m[i * 16 + 15] = 1;
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.visible = fade > 0.001 && open > 0.001;
        // The mesh itself stays at the origin: `matrixAutoUpdate` is off, so
        // moving it would do nothing anyway. The bolts are placed in world
        // space by `uCenter`, which the material reads off `state.sphereCenter`
        // — the ball's hovering centre, not the floor point under it.
        mesh.material.userData.sync(this._state);
      } else {
        mesh.visible = false;
      }
    }

    /* --- particle systems --- */
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
    this.sparks.uniforms.uGlow.value = c.sparkGlow * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

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
    this.smoke.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /** The flash at the caster's hand as the line of current leaves it. */
  _muzzleFx() {
    const c = settings.electrical;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.muzzleSize * 0.2,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.3,
      intensity: c.muzzleIntensity,
      opacity: 0.9,
      fresnel: 1.5,
      displace: 0.5,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    _emit.position = _pos;
    _emit.radius = 0.2;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.sparkSpeed * 1.5;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(45 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  /**
   * Sparks, motes, embers and smoke shed by the front as it races to the
   * target.
   */
  _frontFx(dt) {
    const c = settings.electrical;
    const g = settings.global;
    const time = frame.uTime.value;

    // Sparks thrown off the front.
    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate) * g.particleCount);
    if (sparkCount > 0) {
      _emit.position = this.position;
      _emit.radius = 0.4;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.6).normalize();
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    // Scorch burnt into the floor as the front passes over it.
    const step = 1 / Math.max(0.05, c.platformScorchRate);
    while (this.front - this._platformDistance >= step) {
      this._platformDistance += step;
      const s = saturate(this._platformDistance / this.length);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.6, 0.6);
      _pos.z += this.side.z * randRange(-0.6, 0.6);

      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: c.platformScorchRadius * randRange(0.6, 1.2),
        life: c.platformScorchLife,
        intensity: c.platformScorchIntensity,
        colorA: getColor(c.colorScorch),
        colorB: getColor(c.colorEmber)
      });
    }
  }

  /**
   * Everything the standing sphere sheds: sparks, motes, embers and smoke.
   * All of these ride the pulse — they fire harder on a beat than in the
   * troughs between them.
   *
   * @param {number} scale 0..1 — thinned out as the sphere collapses
   */
  _fieldFx(dt, scale) {
    const c = settings.electrical;
    const g = settings.global;
    const time = frame.uTime.value;
    // The ball's own centre. The surface emitters below spawn on its skin, so
    // they need the hovering position — the floor point would put every spark
    // in the ground, and adding the hover to a centre that already carries it
    // would put them a second ball's height into the air.
    const centre = this._state.sphereCenter;
    const sphereR = this._state.sphereRadius;
    if (sphereR < 0.05) return;

    const pulseRate = 1.0 + this._pulse * (c.pulseParticleBoost - 1.0);

    /* --- sparks thrown off the surface in random directions --- */
    const sparkCount = Math.round(
      this.sparkEmitter.tick(dt, c.fieldSparkRate * pulseRate * scale) * g.particleCount
    );
    if (sparkCount > 0) {
      for (let i = 0; i < sparkCount; i++) {
        // Random point on the sphere surface.
        const theta = Math.random() * TAU;
        const phi = Math.acos(2 * Math.random() - 1);
        const dx = Math.sin(phi) * Math.cos(theta);
        const dy = Math.cos(phi);
        const dz = Math.sin(phi) * Math.sin(theta);
        _pos.set(centre.x + dx * sphereR, centre.y + dy * sphereR, centre.z + dz * sphereR);
        _emit.position = _pos;
        _emit.radius = 0.05;
        _emit.direction = _dir.set(dx, dy, dz).normalize();
        _emit.speed = c.fieldSparkSpeed;
        _emit.speedVariance = 0.85;
        _emit.spread = 0.6;
        _emit.size = 0.08;
        _emit.sizeVariance = 0.7;
        _emit.life = c.fieldSparkLifetime;
        _emit.lifeVariance = 0.55;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.sparks.emit(1, _emit);
      }
    }

    /* --- motes drifting off the surface --- */
    const moteCount = Math.round(
      this.moteEmitter.tick(dt, c.fieldMoteRate * pulseRate * scale) * g.particleCount
    );
    if (moteCount > 0) {
      for (let i = 0; i < moteCount; i++) {
        const theta = Math.random() * TAU;
        const phi = Math.acos(2 * Math.random() - 1);
        const dx = Math.sin(phi) * Math.cos(theta);
        const dy = Math.cos(phi);
        const dz = Math.sin(phi) * Math.sin(theta);
        _pos.set(centre.x + dx * sphereR, centre.y + dy * sphereR, centre.z + dz * sphereR);
        _emit.position = _pos;
        _emit.radius = 0.05;
        _emit.direction = _dir.set(dx, dy * 0.5, dz).normalize();
        _emit.speed = c.fieldMoteSpeed;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.7;
        _emit.size = 0.06;
        _emit.sizeVariance = 0.6;
        _emit.life = c.fieldMoteLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.motes.emit(1, _emit);
      }
    }

    /* --- embers rising up from the platform --- */
    const emberCount = Math.round(
      this.emberEmitter.tick(dt, c.fieldEmberRate * pulseRate * scale) * g.particleCount
    );
    if (emberCount > 0) {
      for (let i = 0; i < emberCount; i++) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * sphereR * 1.3;
        _pos.set(centre.x + Math.cos(a) * r, 0.1, centre.z + Math.sin(a) * r);
        _emit.position = _pos;
        _emit.radius = 0.1;
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.fieldEmberSpeed;
        _emit.speedVariance = 0.7;
        _emit.spread = 0.7;
        _emit.size = 0.05;
        _emit.sizeVariance = 0.6;
        _emit.life = c.fieldEmberLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.embers.emit(1, _emit);
      }
    }

    /* --- smoke rolling off the platform --- */
    const smokeCount = Math.round(
      this.smokeEmitter.tick(dt, c.fieldSmokeRate * scale) * g.particleCount
    );
    if (smokeCount > 0) {
      for (let i = 0; i < smokeCount; i++) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * sphereR * 1.4;
        _pos.set(centre.x + Math.cos(a) * r, 0.2, centre.z + Math.sin(a) * r);
        _emit.position = _pos;
        _emit.radius = 0.2;
        _emit.direction = _dir.set(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3).normalize();
        _emit.speed = c.fieldSmokeSpeed;
        _emit.speedVariance = 0.7;
        _emit.spread = 0.85;
        _emit.size = 0.7;
        _emit.sizeVariance = 0.5;
        _emit.life = c.fieldSmokeLifetime;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0.4;
        _emit.tint = null;
        _emit.time = time;
        this.smoke.emit(1, _emit);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    this._pulse = 0;

    // The light rides the front, lifted off the floor.
    this.position.y = 0.4;

    this._frontFx(dt);

    this.ctx.shake.rumble(settings.electrical.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.electrical;
    const g = settings.global;
    const time = frame.uTime.value;

    this._bloomTime = 0;
    this._centrePoint(_centre);
    _pos.copy(_centre);
    _pos.y = 0.3;

    /* the shockwave that snaps out across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* the burnt patch the sphere sits in */
    this.ctx.decals.spawn(DecalType.SCORCH, _centre, {
      radius: c.scorchRadius * g.explosionIntensity,
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber)
    });

    /* sparks and embers thrown out of the bloom */
    _emit.position = _pos;
    _emit.radius = c.sphereRadius;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 1.8;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.radius = c.sphereRadius * 0.8;
    _emit.speed = c.emberSpeed * 1.6;
    _emit.spread = 0.85;
    _emit.size = 0.12;
    _emit.life = c.emberLifetime * 1.3;
    _emit.spin = 6;
    this.embers.emit(Math.round(c.burstEmbers * g.particleCount), _emit);

    _emit.radius = c.sphereRadius * 1.2;
    _emit.speed = c.smokeSpeed * 2.0;
    _emit.spread = 1.0;
    _emit.size = 1.4;
    _emit.life = c.smokeLifetime * 1.3;
    _emit.spin = 0.5;
    this.smoke.emit(Math.round(35 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.electrical;
    this._bloomTime += dt;

    // `t` runs 0..1 while the sphere holds, then 1..2 while it collapses.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));

    // Pulse only while the sphere is alive.
    this._pulse = t <= 1 ? this._pulseAt(this._bloomTime, c) : 0;

    this._sync(fade);

    // The light sits *in* the sphere. `_state.center` is left alone: it is the
    // floor point, and the platform and the ground emitters below read it.
    this.position.copy(this._state.sphereCenter);

    this._fieldFx(dt, fade * (t <= 1 ? 1 : 0.3));

    // A continuous shake while the sphere is alive — a steady hum.
    if (t <= 1) {
      this.ctx.shake.rumble(c.holdShake * fade * settings.global.cameraShake, dt);
    }
  }

  onDestroy() {
    this.boltGeometry.instanceCount = 0;
    for (const mesh of this.boltMeshes) mesh.count = 0;
    this.sphere.visible = false;
    this.platform.visible = false;
    for (const material of this.boltMaterials) material.uniforms.uFade.value = 0;
  }

  dispose() {
    this.sphereGeometry.dispose();
    this.platformGeometry.dispose();
    this.sphereMaterial.dispose();
    this.platformMaterial.dispose();
    this.boltGeometry.dispose();
    for (const material of this.boltMaterials) material.dispose();
    super.dispose();
  }
}
