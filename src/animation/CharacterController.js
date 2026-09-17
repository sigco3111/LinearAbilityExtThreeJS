import {
  AnimationMixer,
  Box3,
  Group,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector3
} from 'three';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { applyFresnelAura } from '../materials/FresnelAura.js';
import { LAYER } from '../core/Layers.js';
import { MaterialLibrary } from '../loaders/MaterialLibrary.js';
import { disposeObject } from '../utils/dispose.js';

const CHARACTER_URL = './models/Idle.fbx';
/**
 * The look, as a glTF export of the same model.
 *
 * FBX is the only format the rig survives, and it carries almost none of the
 * authored surface — no metallic/roughness, no normal, no emissive. So the
 * materials come from an unrigged GLB of the same body instead, matched onto
 * the rig by material name (see `loaders/MaterialLibrary.js`). Set it to null
 * to fall back to the flat diffuse skin below.
 */
const MATERIAL_LIBRARY_URL = './textures/textures.glb';

/**
 * Rig material name -> library material name, for exports that disagree.
 *
 * Normally empty: both files come out of the same scene, so the names already
 * line up and `MaterialLibrary` matches them without help. Add an entry only
 * when a rig arrives with a material the palette calls something else.
 */
const MATERIAL_ALIASES = {
  // 'skin_mat': 'body_mat'
};

/**
 * Whether the palette's textures have to be flipped to sit on this rig.
 *
 * glTF measures V from the top of the image, FBX from the bottom, so a glTF
 * material applied to an FBX body is upside down until one of them gives. Read
 * off the rig's own format rather than hardcoded, so swapping the body for a
 * glTF export turns the correction off by itself. See
 * `MaterialLibrary#flipTextureV` for why this is not simply `texture.flipY`.
 */
const MATERIAL_LIBRARY_FLIP_V = /\.fbx$/i.test(CHARACTER_URL);

/**
 * The flat colour map, for anything the palette cannot dress.
 *
 * The FBX carries no material of its own worth the name, so before the palette
 * existed this was the whole look. It is the fallback now: a rig material the
 * library has no match for still gets a skin rather than turning grey.
 */
const CHARACTER_TEXTURE_URL = './models/diffuse.png';
/** One file per entry in `CAST_ANIMATIONS`; only their clips are kept. */
const castUrl = (name) => `./models/${name}.fbx`;
/** Mixamo exports in centimetres. */
const FBX_SCALE = 0.01;
/** Rigs vary; normalise to a believable human height so the world scale holds. */
const TARGET_HEIGHT = 1.78;

/**
 * The skeleton, as the places a body effect can be hung on.
 *
 * Each entry names a bone; the **segment** it stands for is the line from its
 * parent's joint to its own, which is what actually tiles a body — a bone's
 * world position is the joint at its head, so `LeftHand` is the forearm,
 * `LeftFoot` is the shin, and so on. Anything with no parent bone, and every
 * finger, toe tip and twist helper, is left out: they are joints a rig needs and
 * not places anyone would look for fire.
 *
 * `weight` is how many slots the segment takes in the list `writeBoneSegments`
 * builds, and effects pick a slot uniformly — so a chest listed twice simply
 * catches twice as much fire as a forearm listed once. Doing the weighting by
 * repetition rather than by a distribution is what lets a shader pick a segment
 * with one array lookup instead of walking a table of probabilities.
 *
 * `radius` is the half-width of the limb there as a fraction of the character's
 * height, so it survives the rig being re-scaled.
 *
 * Keyed on the short Mixamo names, as `_measureFacing` already is: a rig that
 * names its bones something else simply contributes nothing here, and the
 * effects that use this fall back to the height alone rather than breaking.
 */
const BONE_SEGMENTS = [
  { bone: 'Spine', weight: 2, radius: 0.085 },
  { bone: 'Spine1', weight: 2, radius: 0.09 },
  { bone: 'Spine2', weight: 2, radius: 0.09 },
  { bone: 'Neck', weight: 1, radius: 0.055 },
  { bone: 'Head', weight: 2, radius: 0.05 },
  { bone: 'LeftShoulder', weight: 1, radius: 0.05 },
  { bone: 'RightShoulder', weight: 1, radius: 0.05 },
  { bone: 'LeftArm', weight: 1, radius: 0.045 },
  { bone: 'RightArm', weight: 1, radius: 0.045 },
  { bone: 'LeftForeArm', weight: 2, radius: 0.04 }, // the upper arm
  { bone: 'RightForeArm', weight: 2, radius: 0.04 },
  { bone: 'LeftHand', weight: 2, radius: 0.033 }, // the forearm
  { bone: 'RightHand', weight: 2, radius: 0.033 },
  { bone: 'LeftUpLeg', weight: 1, radius: 0.06 },
  { bone: 'RightUpLeg', weight: 1, radius: 0.06 },
  { bone: 'LeftLeg', weight: 2, radius: 0.056 }, // the thigh
  { bone: 'RightLeg', weight: 2, radius: 0.056 },
  { bone: 'LeftFoot', weight: 2, radius: 0.042 }, // the shin
  { bone: 'RightFoot', weight: 2, radius: 0.042 },
  { bone: 'LeftToeBase', weight: 1, radius: 0.035 }, // the foot
  { bone: 'RightToeBase', weight: 1, radius: 0.035 }
];

/** Scratch for the world-space joint lookups. */
const _joint = new Vector3();

/** Strip the exporter's namespace: "mixamorig:LeftFoot", "mixamorigLeftFoot". */
const shortBoneName = (name) => name.split(':').pop().replace(/^mixamorig/i, '');

/**
 * Loads the rigged FBX, normalises it for the scene and drives its animation.
 *
 * The character never leaves the spot — it breathes on a loop, turns to face
 * where you are aiming, and throws one of the cast clips when you fire. Those
 * clips ship as separate Mixamo exports of the *same* skeleton, so only their
 * `AnimationClip` is kept: the mixer binds tracks by bone name, which is all
 * that a shared rig needs for a clip authored in another file to play here.
 *
 * Which clip an ability throws is `settings[element].castAnim` — a per-ability
 * choice, editable live, which is why `playCast` takes the name each time
 * rather than caching one.
 */
export class CharacterController {
  constructor(environment) {
    this.environment = environment;
    this.root = new Group();
    this.root.name = 'Character';

    // Position and heading live on `root`; the bank (walk mode leans into its
    // turns) lives on a joint underneath it, so the two never fight over the
    // same rotation.
    this.tilt = new Group();
    this.tilt.name = 'CharacterTilt';
    this.root.add(this.tilt);

    this.mixer = null;
    /** The looping breath, always running underneath a cast. */
    this.idle = null;
    /** name → one-shot cast action. */
    this.casts = new Map();
    /** The cast currently being thrown, null while idling. */
    this._cast = null;
    /** The authored palette the rig is dressed from, null if it failed to load. */
    this.materialLibrary = null;
    /** Materials already carrying the aura patch, so none of them gets it twice. */
    this._patched = new Set();
    this.height = 1.8;
    this.headPosition = new Vector3(0, 1.5, 0);
    /** The rig's own forward, in model space — the axis a bank rotates about. */
    this.forwardAxis = new Vector3(0, 0, 1);
    /**
     * The skeleton as a flat, already-weighted list of limb segments — see
     * `BONE_SEGMENTS`. Empty until the rig loads, and empty forever if the rig
     * does not use Mixamo's bone names.
     */
    this.boneSegments = [];

    /**
     * Yaw of the rig's own forward in model space. Bind poses are not
     * necessarily axis aligned, so `setFacing` subtracts this to make "0 faces
     * +Z" true for the caller regardless of how the FBX was authored.
     */
    this._forwardYaw = 0;
    /** 0..1 lunge envelope, decays on its own after `castLunge()`. */
    this._lunge = 0;
    this._rightAxis = new Vector3(1, 0, 0);
  }

  /**
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async load(assets) {
    // The cast files are the same character again, so they cost a parse each
    // but nothing at run time — everything but the clip is thrown away below.
    const [fbx, skin, library, ...castFiles] = await Promise.all([
      assets.loadFBX(CHARACTER_URL),
      assets.loadTexture(CHARACTER_TEXTURE_URL),
      MATERIAL_LIBRARY_URL
        ? MaterialLibrary.load(assets, MATERIAL_LIBRARY_URL, {
            aliases: MATERIAL_ALIASES,
            flipV: MATERIAL_LIBRARY_FLIP_V
          })
        : Promise.resolve(null),
      ...CAST_ANIMATIONS.map((name) => assets.loadFBX(castUrl(name)))
    ]);
    // The FBX resolves before its textures do; material prep inspects them.
    await assets.settled();

    fbx.scale.setScalar(FBX_SCALE);
    fbx.updateMatrixWorld(true);

    const box = new Box3().setFromObject(fbx);
    const size = new Vector3();
    const center = new Vector3();
    box.getSize(size);

    // Normalise the rig's height, then drop it onto y = 0 and centre it.
    fbx.scale.setScalar(FBX_SCALE * (TARGET_HEIGHT / Math.max(0.001, size.y)));
    fbx.updateMatrixWorld(true);
    box.setFromObject(fbx);
    box.getSize(size);
    box.getCenter(center);
    this.height = size.y;
    fbx.position.x -= center.x;
    fbx.position.z -= center.z;
    fbx.position.y -= box.min.y;

    this.materialLibrary = library;
    this._prepareMaterials(fbx, skin, library);
    this._measureFacing(fbx);
    this._measureSkeleton(fbx);

    this.tilt.add(fbx);
    this.model = fbx;
    this.headPosition.set(0, size.y * 0.86, 0);

    this.mixer = new AnimationMixer(fbx);
    this.mixer.addEventListener('finished', this._onCastFinished);

    // The breath ships inside the character file itself.
    const idleClip = (fbx.animations ?? [])[0];
    if (!idleClip) {
      console.warn('[CharacterController] no idle clip found in the FBX');
    } else {
      this.idle = this.mixer.clipAction(idleClip);
      this.idle.setLoop(LoopRepeat, Infinity);
      this.idle.play();
    }

    const bones = new Set();
    fbx.traverse((node) => bones.add(node.name));
    CAST_ANIMATIONS.forEach((name, index) => this._registerCast(name, castFiles[index], bones));

    return this;
  }

  /**
   * Keep one cast file's clip and release the duplicate rig that came with it.
   *
   * @param {string} name                 the id used by `settings[element].castAnim`
   * @param {import('three').Group} file  the freshly loaded FBX
   * @param {Set<string>} bones           every node name in *this* rig
   */
  _registerCast(name, file, bones) {
    const clip = (file?.animations ?? [])[0];
    if (!clip) {
      console.warn(`[CharacterController] "${name}.fbx" carries no animation`);
      return;
    }

    // A clip authored against another export of this rig binds by bone name, so
    // a mismatch shows up as a track that resolves to nothing rather than as an
    // error — say so here instead of letting the cast silently do nothing.
    if (!clip.tracks.some((track) => bones.has(track.name.split('.')[0]))) {
      console.warn(`[CharacterController] "${name}.fbx" does not match this skeleton`);
      return;
    }

    clip.name = name;
    const action = this.mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    // Hold the last frame rather than snapping home; the fade back to the idle
    // is what actually ends the cast.
    action.clampWhenFinished = true;
    this.casts.set(name, action);

    disposeObject(file);
  }

  /**
   * Dress the rig: authored materials where the palette has them, converted
   * FBX materials everywhere else.
   *
   * Each of the rig's materials is offered to `library` by name first, and the
   * match — a full glTF PBR material, with its metallic/roughness, normal and
   * emissive maps — is used as-is. Only what the palette cannot answer for goes
   * through `_toStandard`, which turns the FBX's Phong into something the HDR
   * probe and the sun's shadows can light.
   *
   * Either way the result is patched with the fresnel aura before it is applied,
   * so a body dressed from the palette still carries the self-buff charge.
   *
   * The FBX's own textures — and the diffuse skin loaded beside it — are dropped
   * once nothing is left using them: a matched palette makes them redundant, and
   * they are megabytes of decoded image.
   *
   * @param {import('three').Object3D} root
   * @param {import('three').Texture} skin the fallback colour map
   * @param {MaterialLibrary|null} library authored materials, matched by name
   */
  _prepareMaterials(root, skin, library) {
    const converted = new Map();
    /** Textures the FBX arrived with, and the subset still referenced after. */
    const imported = new Set();
    const live = new Set();
    /** Materials this class built, i.e. the ones the palette had nothing for. */
    const fallbacks = [];
    const unmatched = new Set();

    // TextureLoader assumes linear data; this one is authored colour.
    skin.colorSpace = SRGBColorSpace;
    imported.add(skin);

    root.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      node.layers.enable(LAYER.CONTACT); // captured by the contact shadow pass

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const result = source.map((material) => {
        if (!material) return material;
        collectTextures(material, imported);
        if (converted.has(material)) return converted.get(material);

        const authored = library?.resolve(material.name, node.name) ?? null;
        if (!authored && library) unmatched.add(material.name || '(unnamed)');

        let applied = authored;
        if (!applied) {
          applied = this._toStandard(material, skin);
          fallbacks.push(applied);
        }

        // Patched once, here, rather than swapped when the buff fires: the
        // charge lives in this material's own shader behind a strength uniform,
        // so Electric Boost costs no recompile and nothing to put back. Two rig
        // materials can resolve to one palette material, and patching that twice
        // would stack the block — `converted` cannot catch it, since it is keyed
        // by the material on the way in rather than the one on the way out.
        if (!this._patched.has(applied)) {
          this._patched.add(applied);
          applyFresnelAura(applied, this.environment);
        }

        material.dispose(); // its textures are released below, not here
        converted.set(material, applied);
        return applied;
      });

      node.material = Array.isArray(node.material) ? result : result[0];
    });

    // A converted material shares the FBX's textures; an authored one does not,
    // so anything the palette displaced — the skin included — is unreferenced.
    for (const material of fallbacks) collectTextures(material, live);
    for (const texture of imported) if (!live.has(texture)) texture.dispose();

    if (unmatched.size) {
      console.warn(
        `[CharacterController] no palette material for ${[...unmatched].join(', ')} — ` +
          `the library offers ${library.names.join(', ')}. ` +
          'Rename to match, or add an entry to MATERIAL_ALIASES.'
      );
    }
  }

  /**
   * Convert one imported FBX material to PBR.
   *
   * FBX gives us Phong/Lambert; Standard is what picks up the HDR probe and the
   * sun's shadows. This export ships no texture of its own, so the skin loaded
   * alongside it is the colour map — but a file that *does* carry one embedded
   * still wins, since that map is authored against its own UVs. Exporters
   * disagree on which slot the normal map lands in, so both are passed through
   * and the empty one costs nothing.
   *
   * The tint is dropped with the map: an untextured FBX defaults to a flat grey
   * that would otherwise darken every texel of the skin.
   *
   * @param {import('three').Material} material
   * @param {import('three').Texture} skin
   */
  _toStandard(material, skin) {
    const standard = new MeshStandardMaterial({
      name: material.name,
      color: material.map ? (material.color ?? 0xffffff) : 0xffffff,
      map: material.map ?? skin,
      normalMap: material.normalMap ?? null,
      bumpMap: material.normalMap ? null : (material.bumpMap ?? null),
      roughness: 0.85,
      metalness: 0,
      transparent: material.transparent ?? false,
      opacity: material.opacity ?? 1,
      side: material.side
    });

    // Worth the samples: the character is the one thing on screen the camera
    // gets close to, and its texels sit at a grazing angle across the torso.
    for (const map of [standard.map, standard.normalMap, standard.bumpMap]) {
      if (map) map.anisotropy = 4;
    }

    return standard;
  }

  /**
   * Derive the rig's own forward from the bind pose.
   *
   * The heel → toe vector is the most reliable indicator of facing on a bind
   * pose that may not be axis aligned, and everything that turns the body reads
   * the yaw it produces.
   */
  _measureFacing(root) {
    root.updateMatrixWorld(true);

    let foot = null;
    let toe = null;
    root.traverse((node) => {
      if (!node.isBone) return;
      const short = shortBoneName(node.name);
      if (short === 'LeftFoot' && !foot) foot = node;
      else if (short === 'LeftToeBase' && !toe) toe = node;
    });

    if (foot && toe) {
      const heel = foot.getWorldPosition(new Vector3());
      const tip = toe.getWorldPosition(new Vector3()).sub(heel).setY(0);
      if (tip.lengthSq() > 1e-6) this.forwardAxis.copy(tip).normalize();
    }

    this._forwardYaw = Math.atan2(this.forwardAxis.x, this.forwardAxis.z);
    this._rightAxis.set(0, 1, 0).cross(this.forwardAxis).normalize();
  }

  /* ------------------------------------------------------------------ */
  /* cast clips                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Throw one cast clip over the idle, once.
   *
   * @param {string} [name] an id from `CAST_ANIMATIONS`; falls back to the first
   *   one so an ability configured with a clip that failed to load still moves.
   */
  playCast(name) {
    const next = this.casts.get(name) ?? this.casts.get(CAST_ANIMATIONS[0]);
    if (!next || !this.idle) return;

    const previous = this._cast;
    this._cast = next;

    next.reset();
    next.setEffectiveTimeScale(1);
    next.play();

    // Fade from whatever is actually on screen — the idle on a first cast, the
    // clip still finishing on a re-cast — so the body never drops to the bind
    // pose for a frame in between two throws. Re-throwing the *same* clip only
    // restarts it: `reset()` has already left it at full weight.
    const from = previous ?? this.idle;
    if (from !== next) next.crossFadeFrom(from, settings.character.castBlendIn, false);
  }

  /** True while a cast clip is playing. */
  get isCasting() {
    return this._cast !== null;
  }

  _onCastFinished = (event) => {
    // Anything else finishing is an older clip that a re-cast already faded out.
    if (event.action !== this._cast) return;
    this._cast = null;

    // The fade in disabled the idle once its weight hit zero; wake it back up
    // before asking it to come in again.
    this.idle.enabled = true;
    this.idle.setEffectiveTimeScale(1);
    this.idle.crossFadeFrom(event.action, settings.character.castBlendOut, false);
  };

  /* ------------------------------------------------------------------ */
  /* placement — driven by walk mode, inert otherwise                    */
  /* ------------------------------------------------------------------ */

  /** Heading, radians about world +Y. 0 faces +Z, whichever way the rig binds. */
  setFacing(yaw) {
    this.root.rotation.y = yaw - this._forwardYaw;
  }

  get facing() {
    return this.root.rotation.y + this._forwardYaw;
  }

  /**
   * Turn toward `yaw` over time rather than snapping.
   * @param {number} rate fraction of the angle gap left after one second
   */
  turnToward(yaw, rate, dt) {
    const current = this.facing;
    // Shortest way round, so aiming across the -Z seam does not spin the body.
    const delta = MathUtils.euclideanModulo(yaw - current + Math.PI, Math.PI * 2) - Math.PI;
    this.setFacing(current + delta * (1 - Math.pow(MathUtils.clamp(rate, 1e-6, 1), dt)));
  }

  /**
   * Punch the body forward, then let it settle.
   *
   * An accent laid over the cast clip rather than a substitute for it: a pitch
   * about the body's own right axis plus a shove back along its forward axis,
   * both riding on one decaying envelope. Applied to `tilt` rather than `root`
   * so it composes with the heading instead of fighting it, and turned off by
   * dropping `castLean` and `castRecoil` to zero when the clip says it all.
   */
  castLunge() {
    this._lunge = 1;
  }

  _applyLunge(dt) {
    const c = settings.character;
    if (this._lunge > 0) {
      this._lunge = Math.max(0, this._lunge - c.castSettle * dt);
    }
    // A short overshoot at the front of the envelope reads as a snap rather than
    // a slow bow.
    const envelope = this._lunge * this._lunge * (1 + 0.35 * Math.sin(this._lunge * Math.PI));
    this.tilt.quaternion.setFromAxisAngle(this._rightAxis, envelope * c.castLean);
    this.tilt.position.copy(this.forwardAxis).multiplyScalar(-envelope * c.castRecoil);
  }

  /** Put the character back on the floor, upright and facing where it was. */
  resetPlacement() {
    this.root.position.y = 0;
    this._lunge = 0;
    this.tilt.quaternion.identity();
    this.tilt.position.set(0, 0, 0);
  }

  /**
   * Resolve `BONE_SEGMENTS` against this rig, once.
   *
   * Bones are looked up by their short name and kept *by reference*, so what is
   * stored here is the live joint — no name is looked up again, and nothing is
   * copied per frame but the two positions each segment is between.
   */
  _measureSkeleton(root) {
    const bones = new Map();
    root.traverse((node) => {
      if (!node.isBone) return;
      const short = shortBoneName(node.name);
      if (!bones.has(short)) bones.set(short, node);
    });

    this.boneSegments = [];
    const missing = [];

    for (const entry of BONE_SEGMENTS) {
      const bone = bones.get(entry.bone);
      // The parent has to be a bone as well: the topmost joint's parent is the
      // rig's own transform node, and a segment reaching down to that would run
      // from the character's feet to its hips through nothing.
      if (!bone || !bone.parent?.isBone) {
        missing.push(entry.bone);
        continue;
      }
      const radius = entry.radius * this.height;
      // Weighted by repetition — see BONE_SEGMENTS.
      for (let i = 0; i < entry.weight; i++) {
        this.boneSegments.push({ bone, parent: bone.parent, radius });
      }
    }

    if (missing.length === BONE_SEGMENTS.length) {
      console.warn(
        '[CharacterController] no Mixamo bone names on this rig — body effects have no skeleton to hang on'
      );
    }
  }

  /**
   * Write the live skeleton into a pair of world-space endpoint arrays.
   *
   * Packed for a shader rather than for reading: `a[i]` is the segment's start
   * joint with its radius in `w`, `b[i]` is its end joint. Both arrays are
   * written in place and neither is allocated here, so this can run every frame
   * for nothing.
   *
   * The world matrices are the ones `update()` refreshed after the mixer ran,
   * which is what makes a flame rooted on a forearm swing with the arm through a
   * cast instead of trailing a frame behind it.
   *
   * @param {import('three').Vector4[]} a start joints; `w` is the limb radius
   * @param {import('three').Vector4[]} b end joints
   * @returns {number} how many segments were written
   */
  writeBoneSegments(a, b) {
    const count = Math.min(this.boneSegments.length, a.length, b.length);
    for (let i = 0; i < count; i++) {
      const segment = this.boneSegments[i];
      _joint.setFromMatrixPosition(segment.parent.matrixWorld);
      a[i].set(_joint.x, _joint.y, _joint.z, segment.radius);
      _joint.setFromMatrixPosition(segment.bone.matrixWorld);
      b[i].set(_joint.x, _joint.y, _joint.z, 0);
    }
    return count;
  }

  update(dt) {
    // Driven by the *simulation* delta, and re-applied every frame even at
    // dt = 0: pausing mid-cast holds the lunge, and `castLean` stays a live
    // slider against that frozen pose.
    this._applyLunge(dt);

    if (!this.mixer) return;

    this.mixer.timeScale = settings.global.animationSpeed;
    this.mixer.update(dt);

    // The renderer would do this at draw time, which is too late for anything
    // that reads the pose: the buffs run *between* this update and the render,
    // and a flame rooted on a bone whose matrix is still last frame's is a
    // flame hanging behind the arm it belongs to. Cheap enough to simply do
    // here — the rig is a few dozen joints, and the renderer's own pass then
    // finds everything already clean.
    //
    // From `root` rather than from the model: the heading lives up there and
    // the lunge on the joint under it, so starting any lower would resolve the
    // pose against a stale body.
    this.root.updateMatrixWorld(true);
  }

  get position() {
    return this.root.position;
  }

  dispose() {
    this.mixer?.removeEventListener('finished', this._onCastFinished);
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.idle = null;
    this.casts.clear();
    this._cast = null;
    this.materialLibrary = null;
    this._patched.clear();
    disposeObject(this.root);
  }
}

/* -------------------------------------------------------------------- */

/** Add every texture a material references to `out`. */
function collectTextures(material, out) {
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture) out.add(value);
  }
}
