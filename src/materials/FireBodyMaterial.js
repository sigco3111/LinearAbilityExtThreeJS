import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3, Vector4 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The two passes a tongue is drawn in — same geometry, same path, only the
 * width and the cross-ribbon profile differ. As `materials/BodyArcMaterial.js`
 * and `materials/ArcaneRibbonMaterial.js`.
 */
export const FlamePass = Object.freeze({
  FLAME: 0, // the burning sheet itself
  GLOW: 1 // the heat it sits inside
});

/**
 * Slots in the skeleton the shader is handed.
 *
 * `CharacterController.BONE_SEGMENTS` is a *weighted* list — a chest appears in
 * it more than once — so this has to be comfortably larger than the number of
 * limbs on a body. Two `vec4` arrays this long is 80 vertex uniform registers,
 * which leaves room under the 256 every WebGL2 context guarantees.
 */
export const MAX_FLAME_BONES = 40;

/**
 * The character **on fire**.
 *
 * The third thing in the sandbox drawn on the caster's own capsule, and the
 * third reading of it. `BodyArcMaterial` strikes hairline filaments *between*
 * two points on the body; `ArcaneRibbonMaterial` winds sheets *around* it. This
 * does neither: every instance is a **tongue rooted on the skin and climbing off
 * it**, which is the one thing fire does that neither of the others can fake.
 *
 * As everywhere else the CPU picks nothing. Where a tongue is rooted, how long
 * it grows, which way it leans, when it catches and when it burns out are all
 * derived in the vertex shader from the instance index and the clock.
 *
 * ## The skeleton, not a capsule
 *
 * The charge's arcs and the channel's ribbons are hung on an *idealised* body —
 * an ellipse of a fixed radius, swept up a fixed height. That is enough for
 * something struck across a silhouette, and it is not enough for fire: a
 * capsule has no arms, so flame hung on one sits in the air where the arms are
 * not, and it stays there while the character throws a cast.
 *
 * So this material is handed the **actual rig**. `CharacterController` resolves
 * its skeleton into a flat list of limb segments once at load and writes their
 * live world-space joints into `uBoneA` / `uBoneB` every frame (see
 * `writeBoneSegments`), with the limb's own half-width packed into `uBoneA.w`.
 * A tongue picks a slot, a point along that limb and a bearing around it, and
 * that is where it is rooted — so the fire is *on the forearm*, and when the
 * arm swings through a cast the fire on it swings too.
 *
 * The list is pre-weighted by repetition, so picking a slot uniformly is all the
 * shader has to do to put more fire on a chest than on a foot.
 *
 * ## Why a tongue climbs rather than hangs
 *
 * Three terms, in the order the eye reads them:
 *
 *   - **the climb.** `t` runs 0 → 1 from the root to the tip and carries the
 *     point `uLength` metres — but *along the limb* at the root and only
 *     turning over into the vertical near the tip, on a curve `uBend` sets. A
 *     tongue that went straight up from the skin would be touching the body at
 *     exactly one point; this one lies along the forearm it is burning on.
 *   - **the lean.** Fire leaves the surface it is burning on: the tip is pushed
 *     out along the body's own radial by `uLean`, quadratically in `t`, so a
 *     tongue peels off a shoulder instead of standing on it like a hair. The
 *     radial itself turns about the limb by `uWrap` as the tongue climbs, so a
 *     bone's worth of tongues winds around it rather than combing off it.
 *   - **the limb.** Length and width are both scaled by how thick the bone
 *     under the root is, against `uLimbRef`. The fire is then a coat that
 *     follows the body's own proportions instead of one flame size everywhere.
 *   - **the sway.** Two bands of noise in the horizontal plane, scaled by
 *     `pow(t, uSwayPower)` so the root is pinned and only the tip wanders, and
 *     scrolled *downward* through the noise domain so the wander travels **up**
 *     the tongue. That sign is the difference between fire and seaweed.
 *
 * ## The cycle
 *
 * As the arcs: `uTime * uRate + hash(index)`, the integer part seeding the
 * tongue and the fractional part being its life. A tongue does not strike, it
 * *catches* — so it grows from `uSprout` of its length to all of it over the
 * front of that life, drifts upward by `uClimb` while it burns, and both ends
 * of the envelope are soft.
 */
const FLAME_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;

  uniform vec3  uRight;
  uniform vec3  uForward;
  uniform vec4  uBoneA[FLAME_BONES];
  uniform vec4  uBoneB[FLAME_BONES];
  uniform float uBoneCount;
  uniform float uThickness;
  uniform float uOffset;
  uniform float uLimbRef;
  uniform float uLimbTaper;
  uniform float uBend;
  uniform float uWrap;

  uniform float uRate;
  uniform float uLife;
  uniform float uSprout;
  uniform float uLength;
  uniform float uLengthVary;
  uniform float uLean;
  uniform float uClimb;

  uniform float uSway;
  uniform float uSwayPower;
  uniform float uSwayScale;
  uniform float uSwaySpeed;

  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uWidthVary;
  uniform float uTaper;
  uniform float uRootPinch;
  uniform float uBank;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vSeed;
  varying float vLive;
  varying float vHeat;
  varying float vViewZ;

  ${noiseGLSL}

  /**
   * The limb a tongue is rooted on, resolved into everything the tongue needs
   * to stay welded to it.
   *
   * Four things come back rather than one point, because a tongue that only
   * knows *where* it starts is a tongue that leaves the body the instant it
   * grows: it also has to know which way the limb runs (so it can climb along
   * it), how thick the limb is (so a toe does not carry a bonfire) and the two
   * vectors of the ring around it (so it can wind as it climbs).
   *
   * @param slot     which segment, 0 .. uBoneCount
   * @param along    0..1 from the segment's parent joint to its own
   * @param a        radians around the limb
   * @param outward  metres out from the limb's surface (0 = on it)
   * @param away     out: the radial there, which is the way fire peels off
   * @param limbUp   out: the limb's own axis, flipped to point upward
   * @param n1       out: the ring's first axis, for the wind around the limb
   * @param n2       out: the ring's second axis
   * @param radius   out: the limb's half-width in metres, before uThickness
   */
  vec3 bonePoint(float slot, float along, float a, float outward,
                 out vec3 away, out vec3 limbUp, out vec3 n1, out vec3 n2,
                 out float radius) {
    float top = max(uBoneCount - 1.0, 0.0);
    int idx = int(clamp(floor(slot), 0.0, top));
    // Dynamically indexed, which GLSL ES only guarantees for uniform arrays in
    // a vertex stage — the one place this is allowed to be, and is.
    vec4 head = uBoneA[idx];
    vec4 tail = uBoneB[idx];

    vec3 axis = tail.xyz - head.xyz;
    float len = length(axis);
    vec3 dir = len > 1e-5 ? axis / len : vec3(0.0, 1.0, 0.0);

    // A frame across the limb. The reference is the body's own right, swapped
    // for its forward wherever the limb runs along it — an arm held out
    // sideways — so the ring around the bone never collapses to a line.
    vec3 ref = abs(dot(dir, uRight)) > 0.9 ? uForward : uRight;
    n1 = normalize(cross(dir, ref));
    n2 = cross(dir, n1);

    // The limb pointed the way fire travels along it, which is *up* it — a
    // thigh is authored hip-to-knee, so half the rig's segments run downward
    // and flame licking along them unflipped would run down the leg.
    limbUp = dir * (dot(dir, vec3(0.0, 1.0, 0.0)) >= 0.0 ? 1.0 : -1.0);
    radius = head.w;

    away = n1 * cos(a) + n2 * sin(a);
    return mix(head.xyz, tail.xyz, clamp(along, 0.0, 1.0))
         + away * (head.w * uThickness + outward);
  }

  /**
   * A point on one tongue.
   *
   * ## Why it does not simply go up
   *
   * A tongue that rises along world +Y from the moment it leaves the skin is
   * only attached to the body at one point — its root — and every millimetre
   * above that is in the air. On a 1.8 m rig with half-metre tongues that reads
   * as a character *standing in* a fire rather than as a character on fire, and
   * it is the whole of the complaint this shape is built to answer.
   *
   * So the climb is a **bend**, not a line. Near the root the tongue runs along
   * the limb's own axis — up the forearm, up the shin — and only as t
   * approaches the tip does it turn over into the vertical that fire actually
   * wants. uBend is where in that range the turn happens: at 1 it is a
   * straight ramp, higher holds the tongue on the limb for longer and snaps it
   * upward late, which is the setting that reads as *clinging*.
   *
   * uWrap then winds the tongue around the limb as it climbs, by rotating the
   * radial it peels off along. It is what stops a set of tongues on one bone
   * reading as a comb of parallel sheets.
   *
   * @param t       0..1 from the root to the tip
   * @param root    where it is rooted on the skin
   * @param away    the body's radial there — the direction it peels off along
   * @param limbUp  the limb's axis, pointing upward
   * @param n1      the ring around the limb, first axis
   * @param n2      the ring around the limb, second axis
   * @param a       the bearing the root sits at, radians
   * @param len     how long it is right now, metres
   * @param scale   this tongue's length as a fraction of the longest — the
   *                wander is scaled by it, so a toe's flame does not thrash the
   *                distance a chest's does
   * @param seed    its own seed
   */
  vec3 tonguePoint(float t, vec3 root, vec3 away, vec3 limbUp, vec3 n1, vec3 n2,
                   float a, float len, float scale, float seed) {
    float k = clamp(t, 0.0, 1.0);

    // Along the limb at the root, vertical by the tip. Both ends are unit and
    // limbUp is never antiparallel to +Y, so the mix cannot collapse.
    float bend = pow(k, max(uBend, 0.05));
    vec3 climb = normalize(mix(limbUp, vec3(0.0, 1.0, 0.0), bend));
    vec3 p = root + climb * (k * len);

    // Fire leaves the surface, and leaves it harder the further it has climbed
    // — along a radial that is itself turning about the limb, so the tongue
    // winds rather than standing in one plane.
    float wound = a + uWrap * k;
    vec3 radial = n1 * cos(wound) + n2 * sin(wound);
    p += mix(away, radial, smoothstep(0.0, 0.5, k)) * uLean * k * k;

    // Pinned at the root, loose at the tip, and never wider than the tongue is
    // long — an absolute wander is what tears a short flame off a small bone.
    float sway = uSway * pow(k, max(uSwayPower, 0.05)) * scale;
    float y = k * uSwayScale - uTime * uSwaySpeed;
    p += uRight * snoise(vec3(seed, y, 0.0)) * sway;
    p += uForward * snoise(vec3(seed + 31.7, y, 5.13)) * sway;
    return p;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* ---- this tongue's own clock ---- */
    float phase = hash11(aStrand * 3.71 + uSeed * 0.13);
    float cycle = uTime * max(uRate, 0.01) + phase;
    float born = floor(cycle);
    float k = fract(cycle);
    float seed = hash11(aStrand * 7.13 + born * 3.77 + uSeed) * 97.0;
    vSeed = seed;

    // Soft at both ends. Fire catches and gutters out; nothing here snaps.
    float life = clamp(uLife, 0.05, 1.0);
    vLive = smoothstep(0.0, life * 0.22, k) * (1.0 - smoothstep(life * 0.45, life, k));

    /* ---- where it is rooted, on the rig ---- */
    // The slot list is already weighted by repetition, so a uniform pick over it
    // is what puts more fire on a chest than on a foot.
    vec3 away, limbUp, n1, n2;
    float radius;
    float bearing = hash11(seed + 4.7) * TAU;
    vec3 root = bonePoint(
      hash11(seed + 1.7) * uBoneCount,
      hash11(seed + 2.3),
      bearing,
      uOffset,
      away, limbUp, n1, n2, radius
    );

    // It catches rather than appearing: stubby at first, full length by the
    // time it is burning properly, and drifting upward the whole while — so the
    // fire is forever rising through itself.
    float grow = mix(clamp(uSprout, 0.0, 1.0), 1.0, smoothstep(0.0, life * 0.55, k));
    // Sized to the limb it stands on. The rig's own half-widths run about 2.5:1
    // from a chest to a toe, and letting that through is what keeps the fire
    // reading as a *coat* on the body: one length for every bone puts the same
    // half-metre flame on a foot as on a ribcage, and the foot's is all air.
    float limb = mix(1.0, clamp(radius / max(uLimbRef, 1e-4), 0.35, 1.5),
                     clamp(uLimbTaper, 0.0, 1.0));
    float vary = mix(1.0 - clamp(uLengthVary, 0.0, 0.95), 1.0, hash11(seed + 3.1));
    float scale = limb * vary;
    float len = uLength * scale * grow;
    root.y += uClimb * (k / max(uRate, 0.01));

    vec3 here = tonguePoint(t, root, away, limbUp, n1, n2, bearing, len, scale, seed);

    /* ---- the frame the sheet is built on ---- */
    float step_ = 0.03;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = tonguePoint(ahead, root, away, limbUp, n1, n2, bearing, len, scale, seed);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);

    // Camera-facing by default, rolled back toward the body's own surface by
    // uBank — at 1 the tongues are sheets standing off the skin, which is what
    // stops the ones on the far side of the body reading as stickers.
    vec3 toCamera = normalize(cameraPosition - here);
    vec3 billboard = cross(tangent, toCamera);
    billboard = length(billboard) > 1e-4 ? normalize(billboard) : away;
    vec3 sheet = cross(tangent, away);
    sheet = length(sheet) > 1e-4 ? normalize(sheet) : billboard;
    vec3 binormal = normalize(mix(billboard, sheet, clamp(uBank, 0.0, 1.0)));

    /* ---- width ---- */
    vStrand = hash11(seed + 8.4);
    // Pinched where it meets the skin, tapering to a point at the tip. Not
    // sin(t * PI): a flame is fattest low down, not in the middle.
    float taper = pow(1.0 - t, max(uTaper, 0.05)) * smoothstep(0.0, max(uRootPinch, 1e-3), t);
    float halfWidth = uWidth * uWidthScale * taper;
    halfWidth *= mix(1.0 - clamp(uWidthVary, 0.0, 0.95), 1.0, vStrand);
    // ... and with the limb, for the same reason its length is: a tongue on a
    // toe that is a third the height and full width is a paddle, not a flame.
    halfWidth *= mix(1.0, limb, clamp(uLimbTaper, 0.0, 1.0));
    halfWidth *= vLive * uStrength;

    // Hottest at the root and cooling as it climbs; a young tongue burns hotter
    // than one that is going out.
    vHeat = (1.0 - t) * mix(0.55, 1.0, vLive);

    // World space throughout: the group is an identity transform.
    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The sheet, shaded as a temperature.
 *
 * One field is sampled and everything is read off it, which is why one slider
 * re-tempers the whole body coherently instead of recolouring layers:
 *
 *   - **the tear.** fbm along the tongue (and a little across it), scrolling
 *     backward, thresholded against a cut that *rises with `t`* — so the root
 *     is solid burning gas and the tip breaks into separate licks with dark
 *     between them. A flame that fades out uniformly reads as a gradient; one
 *     that tears reads as fire.
 *   - **the ramp.** That field, weighted by the cross-ribbon profile and by how
 *     far up the tongue the fragment is, *is* the temperature — and temperature
 *     is colour: `colorSmoke` in the cold voids, through `colorEmber` and
 *     `colorFlame`, to an incandescent `colorCore` down in the root.
 *   - **the gutter.** Two hashes on two quantised clocks, one per bundle and one
 *     per tongue, because a fire's brightness is never steady for two frames
 *     together and never uniform across it either.
 */
const FLAME_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;

  uniform float uSharp;
  uniform float uGlowFalloff;
  uniform float uTear;
  uniform float uTearScale;
  uniform float uTearCross;
  uniform float uTearSpeed;
  uniform float uTearBias;
  uniform float uHeatBias;
  uniform float uCoreSize;
  uniform float uSmoke;

  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uStrandFade;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;

  uniform vec3  uColorCore;
  uniform vec3  uColorFlame;
  uniform vec3  uColorEmber;
  uniform vec3  uColorSmoke;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vSeed;
  varying float vLive;
  varying float vHeat;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (vLive <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    /* ---- the one field the fragment is read off ---- */
    float field = fbm3(vec3(
      vT * uTearScale - uTime * uTearSpeed,
      vSide * uTearCross,
      vSeed * 2.7
    )) * 0.5 + 0.5;

    #ifdef FLAME_GLOW
      // The halo does not tear — it is the heat *around* the fire, and heat has
      // no edges. It only thins with height, as everything here does.
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      float alpha = profile * mix(1.0, 0.35, vT);
      float heat = clamp(vHeat * uHeatBias * profile, 0.0, 1.0);
      vec3 color = mix(uColorEmber, uColorFlame, heat);
    #else
      float profile = pow(1.0 - v, max(uSharp, 0.05));

      // The cut rises with height: solid at the root, shredded at the tip.
      float cut = mix(uTearBias * 0.35, uTearBias, vT) * clamp(uTear, 0.0, 1.0);
      float burn = smoothstep(cut, cut + 0.22, field);

      float alpha = profile * burn;
      // Temperature: the field, how far up the tongue it is, and how much of
      // the ribbon's width is left under it.
      float heat = clamp(field * profile * vHeat * uHeatBias, 0.0, 1.0);
      vec3 color = gradient4(uColorSmoke, uColorEmber, uColorFlame, uColorCore,
                             pow(heat, max(uCoreSize, 0.05)));
      // What is nearly out goes to smoke rather than merely dimming — the term
      // that keeps the crests of the fire from glowing as they die.
      color = mix(color, uColorSmoke, clamp((1.0 - burn) * uSmoke, 0.0, 1.0));
    #endif

    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);
    flicker *= 1.0 - uFlicker * 0.5 * hash11(floor(uTime * uFlickerSpeed * 1.7) + vSeed);

    alpha *= vLive * flicker * uStrength * uPassOpacity * uOpacity;
    // Some tongues are the body of the fire, most are wisps off it.
    alpha *= mix(1.0, clamp(uStrandFade, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of the body flames.
 *
 * Both passes share every uniform but the two that define the pass itself
 * (`uWidthScale`, `uPassOpacity`), so `userData.sync()` takes the same state for
 * each and one editor folder drives them together.
 *
 * @param {number} pass FlamePass.*
 */
export function createFireBodyMaterial(pass = FlamePass.FLAME) {
  const glow = pass === FlamePass.GLOW;

  const material = new ShaderMaterial({
    defines: glow
      ? { FLAME_GLOW: '', FLAME_BONES: MAX_FLAME_BONES }
      : { FLAME_BONES: MAX_FLAME_BONES },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: 0 },
      uStrength: { value: 0 },

      uRight: { value: new Vector3(1, 0, 0) },
      uForward: { value: new Vector3(0, 0, 1) },
      // Replaced by identity with the effect's own arrays on the first sync, so
      // the skeleton is written once per frame and read by both passes.
      uBoneA: { value: Array.from({ length: MAX_FLAME_BONES }, () => new Vector4()) },
      uBoneB: { value: Array.from({ length: MAX_FLAME_BONES }, () => new Vector4()) },
      uBoneCount: { value: 0 },
      uThickness: { value: 1 },
      uOffset: { value: 0.02 },
      // The half-width of a chest on this rig, in metres — the limb every
      // other limb is sized against. Resolved from the character's height each
      // frame, so it survives the rig being re-scaled.
      uLimbRef: { value: 0.153 },
      uLimbTaper: { value: 0.85 },
      uBend: { value: 1.9 },
      uWrap: { value: 1.1 },

      uRate: { value: 1.35 },
      uLife: { value: 0.95 },
      uSprout: { value: 0.35 },
      uLength: { value: 0.62 },
      uLengthVary: { value: 0.5 },
      uLean: { value: 0.16 },
      uClimb: { value: 0.35 },

      uSway: { value: 0.13 },
      uSwayPower: { value: 1.4 },
      uSwayScale: { value: 2.1 },
      uSwaySpeed: { value: 1.6 },

      uWidth: { value: 0.11 },
      uWidthScale: { value: glow ? 2.6 : 1 },
      uWidthVary: { value: 0.45 },
      uTaper: { value: 1.15 },
      uRootPinch: { value: 0.12 },
      uBank: { value: 0.3 },

      uSharp: { value: 1.35 },
      uGlowFalloff: { value: 2.3 },
      uTear: { value: 0.85 },
      uTearScale: { value: 2.9 },
      uTearCross: { value: 0.8 },
      uTearSpeed: { value: 1.1 },
      uTearBias: { value: 0.62 },
      uHeatBias: { value: 1.5 },
      uCoreSize: { value: 0.85 },
      uSmoke: { value: 0.55 },

      uFlicker: { value: 0.22 },
      uFlickerSpeed: { value: 18 },
      uStrandFade: { value: 0.55 },
      uPassOpacity: { value: glow ? 0.3 : 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.4 },
      uSoftFade: { value: 0.3 },

      uColorCore: { value: new Color(1, 0.96, 0.82) },
      uColorFlame: { value: new Color(1, 0.6, 0.14) },
      uColorEmber: { value: new Color(0.85, 0.2, 0.02) },
      uColorSmoke: { value: new Color(0.09, 0.03, 0.02) }
    }),
    vertexShader: FLAME_VERTEX,
    fragmentShader: FLAME_FRAGMENT
  });

  /**
   * Push the live settings and the buff's state into the uniforms.
   *
   * @param {object} state
   *   { right, forward, strength, seed, boneA, boneB, boneCount }
   */
  material.userData.sync = (state) => {
    const c = settings.fire;
    const g = settings.global;
    const u = material.uniforms;

    u.uRight.value.copy(state.right);
    u.uForward.value.copy(state.forward);
    u.uStrength.value = state.strength;
    u.uSeed.value = state.seed;

    // Taken by identity rather than copied: the effect writes the skeleton once
    // a frame and both passes read the same `Vector4`s, exactly as every
    // material here shares the frame globals.
    u.uBoneA.value = state.boneA;
    u.uBoneB.value = state.boneB;
    u.uBoneCount.value = state.boneCount;
    u.uThickness.value = c.boneThickness;
    u.uOffset.value = c.flameOffset;
    // The fattest entry in `CharacterController.BONE_SEGMENTS`, times the
    // character's height — which is exactly how the radii in `uBoneA.w` were
    // built, so the ratio the shader takes is 1 on a chest by construction.
    u.uLimbRef.value = 0.09 * state.height;
    u.uLimbTaper.value = c.flameLimbTaper;
    u.uBend.value = c.flameBend;
    u.uWrap.value = c.flameWrap;

    u.uRate.value = c.flameRate * g.speed;
    u.uLife.value = c.flameLife;
    u.uSprout.value = c.flameSprout;
    u.uLength.value = c.flameLength;
    u.uLengthVary.value = c.flameLengthVary * g.randomness;
    u.uLean.value = c.flameLean;
    u.uClimb.value = c.flameClimb * g.speed;

    // The wander is where the global noise multipliers bite, as they do on the
    // kinks of an arc and the wobble of a ribbon.
    u.uSway.value = c.flameSway * g.noiseStrength;
    u.uSwayPower.value = c.flameSwayPower;
    u.uSwayScale.value = c.flameSwayScale * g.noiseFrequency;
    u.uSwaySpeed.value = c.flameSwaySpeed * g.noiseSpeed;

    u.uWidth.value = c.flameWidth;
    u.uWidthScale.value = glow ? c.flameGlowWidth : 1;
    u.uWidthVary.value = c.flameWidthVary * g.randomness;
    u.uTaper.value = c.flameTaper;
    u.uRootPinch.value = c.flameRootPinch;
    u.uBank.value = c.flameBank;

    u.uSharp.value = c.flameSharp;
    u.uGlowFalloff.value = c.flameGlowFalloff;
    u.uTear.value = c.flameTear;
    u.uTearScale.value = c.flameTearScale * g.noiseFrequency;
    u.uTearCross.value = c.flameTearCross;
    u.uTearSpeed.value = c.flameTearSpeed * g.noiseSpeed;
    u.uTearBias.value = c.flameTearBias;
    u.uHeatBias.value = c.flameHeat * g.shaderIntensity;
    u.uCoreSize.value = c.flameCoreSize;
    u.uSmoke.value = c.flameSmoke;

    u.uFlicker.value = c.flameFlicker;
    u.uFlickerSpeed.value = c.flameFlickerSpeed;
    u.uStrandFade.value = c.flameStrandFade;
    u.uPassOpacity.value = glow ? c.flameGlowOpacity : 1;
    u.uOpacity.value = c.flameOpacity * g.opacity;
    u.uGlow.value = c.flameGlow;
    u.uSoftFade.value = c.flameSoftFade;

    u.uColorCore.value.copy(getColor(c.colorFlameCore));
    u.uColorFlame.value.copy(getColor(c.colorFlameBody));
    u.uColorEmber.value.copy(getColor(c.colorFlameEmber));
    u.uColorSmoke.value.copy(getColor(c.colorFlameSmoke));
  };

  return material;
}
