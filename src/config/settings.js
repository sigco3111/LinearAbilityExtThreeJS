/**
 * settings.js — the single source of truth for every tweakable value in the sandbox.
 *
 * Nothing in the renderer owns state that lives here: shaders, particle systems,
 * lights and post processing all *read* these objects every frame. That is what
 * makes the real-time editor work without rebuilding anything — mutating a field
 * is immediately visible on screen, including on a crown that is already
 * standing, and including while the clock is paused (`P`), which is when the
 * shapes are actually worth tuning.
 *
 * The one rule that keeps that promise: a system may only ever *sample* these
 * values. It must never copy one into a record at spawn time and read it back
 * later — see `PyreAbility`, whose blade records hold nothing but unitless dice
 * rolls, and resolve every metre, radian and second against this file each frame.
 *
 * Conventions
 *  - Colours are stored as `#rrggbb` strings so lil-gui can bind them directly.
 *    Use `utils/color.js#getColor()` to read them as a cached THREE.Color.
 *  - `global` holds multipliers that scale everything at once (1 = neutral).
 *  - The per-ability blocks (`pyre`, `kraken`, `electrical`) hold absolute values.
 *
 * Every ability block is keyed by its id in `ELEMENTS`, and the shared systems
 * that need to know about "the ability the player is currently holding" — the
 * aim controller, the cooldown, the HUD — look it up as `settings[element]`.
 * The four fields they rely on being present are `range`, `minRange`, `speed`
 * and `cooldown`; everything else in a block is that ability's own business.
 * A **far cast** (`CastShape.ZONE`, declared in `ELEMENT_META`) adds a fifth:
 * `zoneRadius`, the footprint the circle indicator measures out.
 */

/**
 * The cast animations shipped alongside the rig, in `public/models/<id>.fbx`.
 *
 * Every ability block carries a `castAnim` naming one of these, so each spell
 * can throw the body differently; `CharacterController` loads all of them once
 * at boot and keeps only their clips, and the editor turns this array straight
 * into the per-ability dropdown.
 */
export const CAST_ANIMATIONS = ['cast1', 'cast2', 'cast3'];

export const settings = {
  /* ------------------------------------------------------------------ */
  /* Global multipliers                                                  */
  /* ------------------------------------------------------------------ */
  global: {
    timeScale: 1.0, // slow-mo / fast forward for the whole simulation
    speed: 1.0, // eruption travel speed multiplier
    lifetime: 1.0, // ability lifetime multiplier
    glow: 1.0, // emissive multiplier fed into bloom
    shaderIntensity: 1.0, // master strength of every procedural shader effect
    noiseStrength: 1.0,
    noiseFrequency: 1.0,
    noiseSpeed: 1.0,
    turbulence: 1.0,
    randomness: 1.0, // per-instance / per-particle jitter multiplier
    particleCount: 1.0,
    particleLifetime: 1.0,
    particleSpeed: 1.0,
    particleSize: 1.0,
    emissionRate: 1.0,
    lightIntensity: 1.0,
    lightRadius: 1.0,
    distortion: 1.0,
    fresnel: 1.0,
    opacity: 1.0,
    animationSpeed: 1.0, // character animation playback rate
    cameraShake: 1.0,
    explosionIntensity: 1.0
  },

  /* ------------------------------------------------------------------ */
  /* The aim indicator — the ground arrow drawn while the cast is armed  */
  /* ------------------------------------------------------------------ */
  /**
   * A League-style skillshot indicator: one ground quad with a signed-distance
   * arrow in its fragment shader, so every dimension below is in *metres* and
   * nothing is a texture. The quad is rebuilt from these numbers each frame,
   * which is why dragging `range` while aiming stretches the arrow live.
   */
  aim: {
    /* --- silhouette (metres) --- */
    shaftWidth: 0.42, // half-width of the shaft
    headLength: 2.6, // length of the arrowhead
    headWidth: 1.35, // half-width at the base of the head
    round: 0.12, // corner rounding of the whole silhouette
    startOffset: 0.9, // gap between the caster and the tail of the arrow

    /* --- rendering --- */
    edge: 0.09, // outline thickness, metres
    edgeGlow: 2.6, // how hard the outline blooms
    softness: 0.06, // feather on the outer edge
    fill: 0.3, // opacity of the interior wash
    fillFalloff: 1.1, // how fast the wash fades from the axis to the edge
    opacity: 1.0,

    /* --- energy running up the shaft --- */
    stripes: 0.55, // chevrons per metre
    stripeSharp: 0.62, // 0 = soft gradient, 1 = hard bars
    stripeDepth: 0.55, // how much they modulate the fill
    scrollSpeed: 2.4, // metres/second they travel toward the tip
    pulse: 0.28, // brightness breathing
    pulseSpeed: 2.2,

    /* --- frost break-up --- */
    noise: 0.45, // how much noise eats into the fill
    noiseScale: 1.6, // features per metre
    noiseSpeed: 0.35,
    crystals: 0.55, // voronoi frost plates over the interior
    crystalScale: 2.4,

    /* --- furniture --- */
    baseRing: 0.62, // radius of the ring at the caster's feet, metres
    baseRingWidth: 0.06,
    tipGlyph: 0.9, // strength of the crystal rosette at the impact point
    tipGlyphSize: 1.15, // radius of that rosette, metres
    tipSpin: 0.45, // revolutions/second
    rangeArc: 0.55, // brightness of the max-range cap
    reveal: 0.055, // seconds for the arrow to sweep out when armed

    /* --- colour --- */
    colorCore: '#ecfbff',
    colorEdge: '#3fb4ff',
    colorInvalid: '#ff6a5c', // shown when the target is inside `minRange`

    height: 0.035 // hover distance above the floor, metres
  },

  /* ------------------------------------------------------------------ */
  /* The far-cast indicator — the circle drawn at the target point       */
  /* ------------------------------------------------------------------ */
  /**
   * The other half of the targeting vocabulary. Where `aim` draws an arrow
   * along a line, this draws the **footprint**: a disc dropped at the cursor
   * with a deliberately thick boundary, because the one thing a ground-targeted
   * AoE has to answer before you click is *how much space is this going to
   * take*. The band is the answer, and the ability's own field is built to land
   * exactly on it.
   *
   * Two meshes, both parametric:
   *  - the **footprint**, a quad whose fragment shader is a signed-distance
   *    ring evaluated in metres from the target;
   *  - the **reach ring**, a ribbon strip bent into a circle at the caster's
   *    feet at `range` — a far cast needs to show where its arm ends.
   *
   * Shared by every far cast, so a new one inherits the whole indicator and
   * only brings its own `zoneRadius`.
   */
  zone: {
    /* --- the boundary (metres) --- */
    boundary: 0.34, // thickness of the band that *is* the footprint edge
    // Held under 2: the band is already the widest mark on the circle, and
    // pushing the gain past this clips it to flat white and throws away the
    // hue that says which ability you are holding.
    boundaryGlow: 1.8, // how hard it blooms
    boundaryBias: 0.35, // <0.5 grows the band inward, >0.5 outward
    liner: 0.05, // thin bright liner riding the inside of the band
    softness: 0.05, // feather on both lips

    /* --- the interior --- */
    fill: 0.22, // opacity of the wash inside the circle
    fillFalloff: 1.5, // >1 keeps the middle clear and crowds it to the rim
    rings: 2.0, // concentric contour rings across the radius
    ringWidth: 0.05,
    ringSpeed: 0.35, // how fast they travel outward, radii/second
    crawl: 0.75, // filaments crawling over the interior
    crawlScale: 1.3, // filaments per metre
    crawlSpeed: 0.45,
    noise: 0.4, // break-up eating into the wash
    noiseScale: 1.2,

    /* --- furniture --- */
    ticks: 24, // marks stepping around the boundary
    tickLength: 0.42, // how far they reach in, metres
    tickWidth: 0.2, // duty cycle, 0..1
    tickSpin: 0.06, // revolutions/second
    sweep: 0.55, // radar sweep brightness
    sweepSpeed: 0.4, // revolutions/second
    core: 0.85, // the mark at the exact target point
    coreSize: 0.4, // its radius, metres
    crosshair: 0.5, // four arms pointing out of the core
    crosshairLength: 1.1,
    pulse: 0.22, // brightness breathing
    pulseSpeed: 2.0,

    /* --- the reach ring at the caster --- */
    reach: 0.7, // brightness of the max-range circle, 0 hides it
    reachWidth: 0.05, // its half-width, metres
    reachDashes: 64, // dashes around it (0 = solid)
    reachDashGap: 0.42, // fraction of each dash that is gap
    reachSpin: 0.03, // revolutions/second the dashes creep
    reachLead: 0.9, // how much brighter the arc nearest the cursor is
    reachSegments: 192, // tessellation of that circle

    /* --- rendering --- */
    opacity: 1.0,
    reveal: 0.07, // seconds the circle takes to snap out when armed
    snap: 1.18, // how far past its radius it overshoots on the way out
    height: 0.035, // hover distance above the floor, metres

    /* --- colour --- */
    colorCore: '#eaf7ff',
    colorEdge: '#7c6bff',
    colorInvalid: '#ff6a5c' // shown when the target is inside `minRange`
  },

  /* ------------------------------------------------------------------ */
  /* The gate template — the indicator drawn for a *built* structure     */
  /* ------------------------------------------------------------------ */
  /**
   * The third targeting shape, and the first one that leaves the floor.
   *
   * An arrow answers "which way", a circle answers "how much ground". Neither
   * answers the question a structure raises, which is **what is going to be
   * standing there and which way will it face** — so this template draws the
   * thing itself, as a ghost:
   *
   *  - the **threshold**, a ground slot the width of the opening with a heavy
   *    pad under each jamb, so the footprint the stones will take is honest;
   *  - the **arch ghost**, an upright contour standing in the gate's own plane,
   *    drawn as one SDF in metres — the exact silhouette the stones will be
   *    laid along, with a wash inside it where the portal will hang;
   *  - the shared **reach ring** at the caster's feet.
   *
   * Every dimension below is a real measurement, and the opening itself is not
   * one of them: the ghost reads `gateWidth` / `gateHeight` off the ability, so
   * the preview and the built gate can never disagree.
   */
  gate: {
    /* --- the threshold on the floor (metres) --- */
    thresholdDepth: 0.55, // half-depth of the slot the gate stands in
    jambPad: 0.62, // radius of the heavy pad under each jamb
    edge: 0.075, // outline thickness
    edgeGlow: 2.4, // how hard that outline blooms
    softness: 0.05, // feather on the outer lip
    fill: 0.24, // opacity of the wash inside the slot
    ticks: 9, // rungs laid across the threshold
    tickWidth: 0.055,

    /* --- the arch ghost, standing in the gate's plane --- */
    ghost: 1.0, // master strength of the upright preview
    ghostLine: 0.075, // thickness of the contour line, metres
    ghostGlow: 2.2, // how hard it blooms
    ghostFill: 0.14, // wash inside the opening
    ghostFillFalloff: 1.4, // how fast that wash fades from the contour inward
    ghostDashes: 1.6, // dashes per metre along the contour
    ghostDashGap: 0.42,
    ghostScroll: 1.1, // metres/second the dashes climb toward the keystone
    ghostRise: 0.55, // fraction of the reveal spent drawing it floor-upward
    ghostNoise: 0.35, // break-up on the wash
    ghostNoiseScale: 1.3,

    /* --- the reach ring (shared with the far-cast circle) --- */
    reach: 0.6,
    reachWidth: 0.05,
    reachDashes: 64,
    reachDashGap: 0.42,
    reachSpin: 0.02,
    reachLead: 0.9,
    reachSegments: 192,

    /* --- rendering --- */
    pulse: 0.2, // brightness breathing
    pulseSpeed: 1.8,
    opacity: 1.0,
    reveal: 0.09, // seconds the template takes to draw itself when armed
    height: 0.035, // hover distance of the threshold above the floor, metres

    /* --- colour --- */
    colorCore: '#f2ffd8',
    colorEdge: '#6ee02a',
    colorInvalid: '#ff6a5c' // shown when the target is inside `minRange`
  },

  /* ------------------------------------------------------------------ */
  /* The ring template — the indicator drawn for a *machine*             */
  /* ------------------------------------------------------------------ */
  /**
   * The fourth targeting shape, and the first one that previews a **sequence**
   * rather than a shape.
   *
   * The gate template answers "what will be standing here". A ring cannot be
   * answered that way, because the ring is not built where it ends up: it is
   * forged flat on the floor and then stood upright, and either half of that on
   * its own is a lie. So the template draws both at once:
   *
   *  - the **sigil**, the disc of floor the segments will be laid on, marked
   *    with the ring's own lobed contour, one tick per segment and one spoke
   *    per course — every mark a real measurement;
   *  - the **ghost**, the ring drawn lying on that sigil and **tipping upright
   *    as the cast arms**, on the same overshooting settle the cast itself
   *    uses, so arming is a rehearsal of what the click will do;
   *  - the shared **reach ring** at the caster's feet.
   *
   * The circle itself is not a dimension here: the ghost reads `ringRadius` and
   * `ringHover` off the ability, so the preview and the built ring can never
   * disagree.
   */
  ring: {
    /* --- the contour, shared with the ability's own surface --- */
    lobes: 6, // shallow lobes around the rim — nothing forged is a true circle
    lobeDepth: 0.035, // how deep they run, as a fraction of the radius

    /* --- the sigil on the floor (metres) --- */
    band: 0.16, // thickness of the contour band
    bandGlow: 2.3, // how hard it blooms
    softness: 0.05, // feather on the outer lip
    fill: 0.16, // opacity of the wash inside the circle
    fillFalloff: 1.6, // how fast that wash gives way toward the middle
    spokes: 12, // radial marks reading inward — the courses
    spokeWidth: 0.16, // duty cycle, 0..1
    spokeLength: 0.55, // how far in they reach, as a fraction of the radius
    ticks: 24, // marks stepping outward — one per segment
    tickWidth: 0.35, // duty cycle, 0..1
    tickLength: 0.3, // how far out they reach, metres
    spin: 0.05, // revolutions/second the whole sigil idles at
    noise: 0.3, // break-up eating into the wash
    noiseScale: 1.2,
    sweep: 0.6, // fraction of the reveal spent drawing it out from the foot

    /* --- the ghost, tipping up out of it --- */
    ghost: 1.0, // master strength of the upright preview
    ghostLine: 0.07, // thickness of the contour line, metres
    ghostGlow: 2.0,
    ghostFill: 0.12, // wash inside the opening
    ghostFillFalloff: 1.5,
    ghostDashes: 2.2, // dashes per metre around the contour
    ghostDashGap: 0.45,
    ghostScroll: 0.8, // metres/second they creep round it
    ghostNoise: 0.3,
    ghostNoiseScale: 1.2,
    ghostRise: 0.55, // fraction of the reveal spent standing it up

    /* --- the reach ring (shared with every other template) --- */
    reach: 0.6,
    reachWidth: 0.05,
    reachDashes: 64,
    reachDashGap: 0.42,
    reachSpin: -0.02,
    reachLead: 0.9,
    reachSegments: 192,

    /* --- rendering --- */
    opacity: 1.0,
    pulse: 0.22, // brightness breathing
    pulseSpeed: 2.0,
    reveal: 0.075, // seconds the template takes to draw itself when armed
    height: 0.035, // hover distance of the sigil above the floor, metres

    /* --- colour --- */
    colorCore: '#eafdff',
    colorEdge: '#2fd8ff',
    colorInvalid: '#ff6a5c' // shown when the target is inside `minRange`
  },

  /* ------------------------------------------------------------------ */
  /* The scribe template — the circle cut in the air at the target       */
  /* ------------------------------------------------------------------ */
  /**
   * The fifth targeting shape, and the only one that never touches the floor.
   *
   * The other four are all drawn on the ground, because the other four casts
   * land on it: an arrow says which way, a circle says how much ground, a
   * threshold says what will be standing here, a sigil says what is about to be
   * assembled on it. A portal hanging in the air lands on nothing, so the
   * template is simply the circle itself, standing exactly where the ring will
   * be and drawn out from the foot as the cast arms. The distance read that the
   * other templates get from their footprint is carried by the reach ring.
   *
   * There is deliberately almost no fill. What ends up in the middle of this
   * circle is *nothing*, and a wash there would be promising light.
   */
  scribe: {
    /* --- the circle standing in the air (metres) --- */
    line: 0.055, // thickness of the contour
    lineGlow: 2.1, // how hard it blooms
    fill: 0.08, // the little wash there is inside it
    fillFalloff: 2.4, // how fast it gives way toward the middle
    dashes: 1.6, // embers per metre along the contour
    dashGap: 0.4, // duty cycle, 0..1
    scroll: 0.9, // metres/second they creep round it
    sweep: 0.7, // fraction of the reveal spent drawing it out from the foot

    /* --- the reach ring (shared with every other template) --- */
    reach: 0.6,
    reachWidth: 0.05,
    reachDashes: 64,
    reachDashGap: 0.42,
    reachSpin: -0.02,
    reachLead: 0.9,
    reachSegments: 192,

    /* --- rendering --- */
    opacity: 1.0,
    pulse: 0.2, // brightness breathing
    pulseSpeed: 2.4,
    reveal: 0.11, // seconds the template takes to draw itself when armed
    height: 0.035, // hover distance of the reach ring above the floor, metres

    /* --- colour --- */
    colorCore: '#fff2d0',
    colorEdge: '#ff7a1e',
    colorInvalid: '#ff5142' // shown when the target is inside `minRange`
  },

  /* ------------------------------------------------------------------ */
  /* Character                                                           */
  /* ------------------------------------------------------------------ */
  character: {
    /* --- blending the cast clip over the idle --- */
    // The idle loops forever; a cast clip is a one-shot laid over the top of it,
    // so these are the two edges of that overlap. In fast, out soft: the throw
    // has to land on the frame you clicked, the recovery does not.
    castBlendIn: 0.12, // seconds to cross-fade from the idle into the cast
    castBlendOut: 0.3, // seconds to fall back to the idle once it finishes

    /* --- how the body sells the cast --- */
    turnToAim: true, // face the arrow while aiming
    turnRate: 0.0002, // fraction of the heading gap left after 1s (lower = snappier)
    castLean: 0.34, // radians the torso pitches forward on release
    castRecoil: 0.16, // metres the body is shoved back
    castSettle: 2.6 // seconds⁻¹ the lunge decays at
  },
  /* ================================================================== */
  /* PYRE CROWN — the third far cast, and the Glacial Crown in fire      */
  /* ================================================================== */
  /**
   * The same silhouette as `glacier`, answered in the opposite element — which
   * makes the two of them the sandbox's clearest statement of where an ability's
   * identity actually lives. The layout controls below are deliberately the
   * *same names with different numbers*: a ring seated at the boundary, a skirt
   * banked against its foot, an empty middle. Everything that tells them apart
   * is either material or timing:
   *
   *   - the blades are opaque fire rather than transparent glass
   *     (`materials/PyreMaterial.js`), and they are longer, thinner and far more
   *     uneven — the reference's tallest blade is three times its shortest;
   *   - they **rise without a bounce** (`riseSnap`, `creep` — and note there is
   *     no overshoot control here at all, which is the point: see
   *     `PyreAbility#_emergence`);
   *   - the air inside the ring *climbs* instead of falling (`updraft*`);
   *   - and it ends by burning down from the points rather than shattering
   *     (`burnDelay`, `burnSweep`, `ashTime`).
   */
  pyre: {
    /* --- the cast --- */
    range: 18.0, // maximum cast distance, metres
    minRange: 0.0, // a ring of fire around your own feet is a legitimate play
    zoneRadius: 4.2, // the footprint — what the circle indicator measures out
    speed: 46.0, // how fast the fire line races to the point, metres/second
    snapTime: 0.2, // seconds the crater takes to burn out to the boundary
    lifetime: 4.0, // seconds the crown burns
    burnDelay: 0.45, // seconds after `lifetime` before it starts going out
    burnSweep: 0.5, // seconds the burn-out takes to sweep back around the ring
    burnStagger: 0.4, // seconds of random delay between neighbours
    ashTime: 1.1, // seconds one blade takes to burn down to nothing
    cooldown: 1.6,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the fire leaves the caster --- */
    handHeight: 1.22, // metres above the floor
    handForward: 0.6, // metres in front of the caster
    handSide: 0.18, // metres to the side (+ follows `Ability#side`)

    /* --- how the footprint is filled --- */
    /**
     * Everything is seated in a band about `zoneRadius`; the middle of the
     * circle is left empty on purpose, because the read of the ability is a wall
     * you are looking *into* and filling the disc stops it being a ring. The
     * pyre in the middle is kept as a control and ships at zero.
     */
    spikeCount: 159, // instances spent on one cast (capped at 320)
    density: 0.65, // multiplier on that count
    ringShare: 0.66, // fraction of them spent on the wall at the boundary
    coreShare: 0.0, // ... on the pyre in the middle (0 = the middle stays open)
    lateShare: 0.14, // ... held back to catch during the blaze
    ringSeat: 0.93, // where the wall stands, × zoneRadius
    ringScatter: 0.2, // radial jitter of the wall, × zoneRadius
    skirtSeat: 0.7, // inner lip of the wreckage banked against it, × zoneRadius
    skirtBand: 0.46, // how wide that band is, × zoneRadius
    skirtBias: 0.9, // <1 pushes the skirt outward, >1 crowds it inward
    coreSpread: 0.16, // radius of the cluster in the middle, × zoneRadius

    /* --- the silhouette --- */
    /**
     * Much less even than the ice, and shipped short and inward-leaning: the
     * blades are barely taller than a person and tip *in* over the crater rather
     * than out over the floor. `ringLean` is still the single control that
     * decides whether this reads as a crown or a picket line — at 0 it is a
     * fence, positive throws the blades outward, negative closes them over the
     * middle.
     */
    ringHeight: 1.5, // length of a blade on the wall, metres
    ringWave: 0.33, // how uneven the crest of that wall is, 0..1
    skirtHeight: 1.35, // length of a shard in the skirt, metres
    coreHeight: 6.05, // length of the pyre, metres
    heightJitter: 0.98,
    ringLean: -0.46, // radians the wall leans — negative tips it *inward* (≈26°)
    skirtLean: 0.34, // ... and the skirt
    coreLean: 0.16, // the pyre stands nearly upright
    leanJitter: 1.35,
    fan: 1.25, // radians a blade is splayed off its own radius, ± — the crossing
    twist: 1.0, // random yaw, 0..1 of a full turn
    rubble: 0.52, // fraction of the skirt demoted to ankle-height wreckage
    rubbleScale: 0.24,

    /* --- an individual blade --- */
    /**
     * Broad, heavily faceted tongues with a hard curve in them: a wide base
     * that still runs to a point, ragged enough that no two read the same.
     *
     * `belly` is what separates a fire-blade from an ice one. The ice is a cone
     * — widest where it leaves the floor, straight to the tip. A flame is not:
     * it is pinched at the ground, swells through its lower middle and runs
     * from there to a long point, and that swelling is most of what makes the
     * reference read as burning rather than as a shard painted orange. It is a
     * multiplier on the profile at `bellyAt`, pinned to zero effect at the base
     * and the tip, so `radius` and `taper` keep meaning exactly what they say
     * and `belly: 1` is the plain cone.
     */
    radius: 0.45, // base radius, metres
    radiusJitter: 0.58,
    belly: 1.67, // mid-height radius, × the cone profile (1 = a cone)
    bellyAt: 0.34, // where the blade is widest, 0 = the floor, 1 = the tip
    taper: 0.12, // tip radius as a fraction of the base
    facets: 10, // sides of the prism
    roughness: 0.68, // how far the facets are pushed off a clean prism
    bend: 1.5, // sideways curve from base to tip — a real hook, not a lean

    /* --- the eruption: when each blade catches, and how it arrives --- */
    /**
     * **There is no overshoot here, and that is deliberate.** The Glacial Crown
     * punches through the floor and springs back onto its height, which is most
     * of what sells ice as something hard arriving. A flame that bounces onto
     * its height reads as rubber. So the curve is monotonic in two pieces: a
     * front-loaded surge (`riseSnap`) that lands exactly on full height, and
     * then a `creep` that approaches a little past it from below and never
     * arrives — which is what a flame does when it settles.
     */
    riseTime: 0.18, // seconds from buried to full height
    riseSnap: 0.65, // 0 = a heavy shove, 1 = a snap that is done almost at once
    creep: 0.06, // how much further it reaches, forever, × its own height
    creepTime: 1.4, // seconds that reach takes to (nearly) finish
    sweepTime: 0.38, // seconds the wave takes to run around the ring
    skirtDelay: 0.09, // seconds before the skirt starts
    skirtWave: 0.24, // ... and how long it takes to cross the band
    coreDelay: 0.18, // seconds before the pyre comes up
    stagger: 0.06, // seconds of random delay on top of all of it
    bloomSpread: 0.7, // fraction of the blaze the late blades are scattered over
    sink: 0.3, // how far a dying blade settles into the floor, × its height

    /* --- the fire: opaque, and lit by nothing but itself --- */
    /**
     * Deliberately the *inverse* treatment to `glacier`. Where those blades are
     * near-empty glass carried by their edges, these are solid and almost
     * entirely emissive: one domain-warped flame field, run through one
     * four-stop heat ramp, shaped so the heat crowds to the point and chokes at
     * the foot. `sharp` is the control that matters most — it is the contrast
     * curve that turns a soft gradient into tongues with black voids between
     * them. See `materials/PyreMaterial.js`.
     */
    colorChar: '#150402', // the voids in the flame — coolest stop of the ramp
    colorEmber: '#c01807', // deep red
    colorFlame: '#ff7d1a', // orange
    colorCore: '#fff0bd', // the incandescent white-hot stop
    colorRock: '#2a1310', // the charred stone under it, when `rock` is turned up
    colorRim: '#ff9a3c', // the hot fringe at the silhouette
    colorAsh: '#4a4038', // what is left where the fire has passed
    rock: 0.0, // how much charred stone shows through (0 = pure fire)
    flameScale: 3.25, // flame features per unit of the blade
    flameStretch: 0.77, // <1 draws the tongues out along its length
    flameSpeed: 1.0, // how fast they climb it
    flameGain: 1.52, // master gain on the heat — how hot the whole blade runs
    curl: 0.71, // domain warp — the licking
    sharp: 0.15, // 0 = a soft gradient, 1 = hard tongue edges
    heatBias: 1.24, // how hard the heat crowds toward the point
    soot: 0.48, // how dark the foot of the blade goes
    sootHeight: 0.3, // over what fraction of the blade
    rim: 0.5, // hot fringe at the silhouette
    rimPower: 2.2, // how tightly that fringe hugs the edge
    tipStart: 0.51, // where the incandescent point begins, 0..1 up the blade
    tipGlow: 1.6,
    flicker: 0.22, // depth of the per-blade gutter
    flickerSpeed: 7.5,
    envIntensity: 0.71, // how much of the HDR probe the stone catches
    specular: 1.35, // the tight sun lobe off it
    glow: 1.28, // overall emissive gain
    opacity: 1.0,
    birthGlow: 2.6, // extra glow on a blade that has just torn out of the ground
    birthFade: 0.45, // seconds that birth flash lasts

    /* --- the combustion front and the burn-down --- */
    /**
     * The two things that make this ability's fire *catch* and *go out* rather
     * than fade in and out. Both are per-instance ramps the ability drives; what
     * lives here is only their look. The second one runs the first one backwards
     * from the point down — which is why the Crown is consumed rather than
     * broken.
     */
    frontRough: 0.4, // how ragged the leading edge of the fire is
    frontWidth: 0.14, // how much of the blade is white-hot behind that edge
    frontGlow: 3.2, // how hard it burns
    charRough: 0.5, // how ragged the line the ash eats down is
    charEdge: 0.09, // width of the ember rim riding it
    charGlow: 3.4,
    ashDrain: 0.85, // how completely the body cools behind that edge

    /* --- the crater on the floor --- */
    /**
     * The indicator's promise, made real: the same circle and the same thick
     * boundary, now split open and glowing. An ability-owned mesh rather than a
     * decal precisely because a decal captures its radius when it spawns — this
     * one has to re-scale under `zoneRadius` while the crown is standing, and to
     * run its own front outward and back. The *dark* half of the crater is a
     * `SCORCH` decal underneath it, because this pass is additive and burnt
     * ground has to subtract.
     */
    fieldBoundary: 0.56, // thickness of the band at the edge, metres
    fieldBoundaryGlow: 0.75,
    fieldFill: 1.39, // the wash inside it
    fieldFalloff: 0.65, // how hard that wash crowds to the rim
    fieldPlates: 0.8, // tonal break-up between plates of cooling crust
    fieldCrackScale: 3.45, // plates per metre
    fieldCrackWidth: 0.22, // how wide the molten seams between them read
    fieldCracks: 1.99, // how hard those seams burn
    fieldVeins: 1.36, // runnels of fire crawling over the crust
    fieldVeinScale: 1.5, // runnels per metre
    fieldWarp: 0.6, // domain warp — what stops them reading as spokes
    fieldCrawl: 0.16, // how fast they writhe
    fieldEmbers: 0.9, // single embers glittering in the crust
    fieldEmberScale: 5.0,
    fieldRings: 4.2, // heat rings travelling out from the middle
    fieldRingSpeed: -0.75, // rings/second (positive travels outward)
    fieldSweep: 0.0, // slow sweep around the disc
    fieldSweepSpeed: -0.58, // revolutions/second
    fieldCore: 1.4, // brightness of the pool of melt in the middle
    fieldCoreSize: 0.31, // its radius, × zoneRadius
    fieldPulse: 0.35, // brightness breathing
    fieldPulseSpeed: 2.4,
    fieldOpacity: 1.0,
    fieldHeight: 0.03, // hover distance above the floor, metres
    colorField: '#ff4314', // the wash, the crust and the runnels
    colorFieldEdge: '#ffbd80', // the boundary band, the seams and the pool

    /* --- the wall of flame standing on the ring --- */
    /**
     * An open cylinder seated on the boundary, eroded by ridged noise stretched
     * hard vertically and scrolled *upward* — the exact opposite of the Glacial
     * Crown's curtain, which pours down. This is the piece that frames the crown
     * from the outside and fills the gaps between the blades; without it the
     * wall ends at its own silhouette and the ring reads as a fence of lit
     * cones. Set `veil` to 0 to take it off.
     */
    veil: 0.84, // master opacity of the wall, 0 hides it
    veilHeight: 1.5, // how high it stands, metres
    veilRadius: 0.99, // where it stands, × zoneRadius
    veilFlare: 0.18, // how far it leans outward at the top
    veilBillow: 0.3, // metre-scale lobes pushing its silhouette off round
    veilScale: 1.6, // noise features per metre
    veilStretch: 0.35, // <1 draws the structures out into vertical licks
    veilFlow: 1.6, // how fast they climb
    veilErode: 0.75, // how much harder the top is eaten away than the base
    veilFalloff: 1.5, // how fast it thins with height
    veilSpin: 0.125, // revolutions/second the whole wall turns
    veilSoftFade: 2.25, // metres of soft fade where it meets geometry
    colorVeil: '#ff9f80', // the body of it
    colorVeilCrest: '#f4930b', // the hottest part, at the floor
    colorVeilSmoke: '#2a1109', // what the tops go as they cool

    /* --- the air over it --- */
    /**
     * Heat haze, written into the distortion buffer on `LAYER.DISTORTION` and
     * never drawn directly. It ships **off**: the crown already carries its heat
     * in the crater and the wall of flame, and over water the shimmer fought the
     * reflection rather than reading as air. Turn `haze` up and the tell comes
     * straight back — the floor behind the crown starts wobbling.
     */
    haze: 0.0, // master strength — off by default; turn it up to bend the room
    hazeHeight: 3.4, // how far up the shimmer reaches, metres
    hazeRadius: 1.3, // where it stands, × zoneRadius
    hazeFrequency: 2.4, // cells per metre
    hazeSpeed: 1.6, // how fast they rise
    hazeFalloff: 1.2, // how fast the warp thins with height

    /* --- what the ground does --- */
    trailScorchRate: 2.2, // scorch patches laid per metre of front travel
    trailScorchRadius: 1.0, // radius of one, metres
    scorchSpread: 1.5, // the burnt sheet under the crown, × zoneRadius
    scorchLife: 7.5, // seconds a scorch patch lingers
    scorchIntensity: 0.9,
    scorchCollar: 2.4, // scorch around the foot of a blade, × its own radius
    scorchRate: 3.0, // scorch patches creeping around the boundary, per second
    scorchRadius: 1.0, // radius of one, metres
    fractureSpread: 1.15, // the star of molten cracks at the bloom, × zoneRadius
    fractureWidth: 0.45, // how wide those cracks run
    fractureIntensity: 1.1,
    colorScorch: '#140b08', // the burnt ground itself
    colorScorchEmber: '#ff7a22', // the embers still cooling in it
    colorFracture: '#ffb347', // what shows through the cracks
    shockRadius: 8.0, // the ring that snaps out when the crown catches, metres
    ringRate: 0.9, // heat rings pushed out while it burns, per second
    colorShockA: '#ff7a22', // body of the shockwave ring
    colorShockB: '#ffe6b0', // its crest

    /* --- smoke, cinders, embers and the updraft --- */
    /**
     * As in every other block: a four-stop gradient sampled over the particle's
     * own lifetime, `A` at birth through `D` as it dies. The **updraft** is this
     * ability's signature system — embers released at the floor inside the ring
     * and carried up the column of hot air over the crater, orbiting its middle
     * as they climb. It is the Glacial Crown's falling snow run in reverse, and
     * a rising spiral inside the ring is what says the air over it is burning
     * rather than freezing.
     */
    smokeRate: 220, // smoke rolling off the fire, particles/second
    smokeSize: 1.15,
    smokeSpeed: 2.2,
    smokeLifetime: 3.2,
    smokeOpacity: 0.075,
    smokeRise: 0.85, // positive: it is buoyant, and it leaves over the top
    smokeTurbulence: 0.55,
    colorSmokeA: '#5a3020',
    colorSmokeB: '#3a2418',
    colorSmokeC: '#241a15',
    colorSmokeD: '#0d0908',
    cinderSize: 0.07, // burning fragments
    cinderSpeed: 6.5,
    cinderLifetime: 1.8,
    cinderGravity: -14.0,
    breachCinders: 3, // fragments thrown as a blade breaks the surface
    gutterCinders: 4, // ... and as it burns down
    colorCinderA: '#fff0bd',
    colorCinderB: '#ff8a2a',
    colorCinderC: '#8e2408',
    colorCinderD: '#1a0f0b',
    emberRate: 260, // the sparks coming off everything
    emberSize: 0.05,
    emberSpeed: 3.4,
    emberLifetime: 2.2,
    emberRise: 1.4, // buoyancy, metres/second²
    emberTurbulence: 0.9,
    emberStretch: 0.4, // how far a spark is drawn out along its own velocity
    emberGlow: 1.4,
    breachEmbers: 6, // sparks thrown as a blade breaks the surface
    gutterEmbers: 10, // ... and as it goes out
    colorEmberA: '#fff4cf',
    colorEmberB: '#ffb03c',
    colorEmberC: '#ff4a10',
    colorEmberD: '#4a0d04',
    updraftRate: 120, // embers climbing the column inside the ring
    updraftSize: 0.06,
    updraftSpeed: 1.2, // how hard they are pushed up to start with
    updraftLifetime: 3.4,
    updraftLift: 1.1, // buoyancy, metres/second²
    updraftSwirl: 1.35, // radians/second the column turns
    updraftExpand: 0.7, // how far the spiral opens out as it climbs
    updraftGlow: 1.2,
    updraftInset: 0.8, // how far inside the boundary it rises, × zoneRadius
    colorUpdraftA: '#ffdc8a',
    colorUpdraftB: '#ff8a2a',
    colorUpdraftC: '#c02a08',
    colorUpdraftD: '#2a0a04',

    /* --- dynamic light --- */
    lightIntensity: 4,
    lightRadius: 17,
    lightHeight: 0.45, // how far up the crown the light sits, 0..1
    lightColor: '#ff7a26',

    /* --- the throw, the bloom and the blaze --- */
    castFlash: 0.09, // screen flash on release
    colorCastFlash: '#ffb066',
    burstCinders: 130, // extra fragments at the bloom
    burstSmoke: 80,
    burstEmbers: 170,
    impactShake: 0.95,
    shakeDuration: 0.85,
    holdShake: 0.06, // continuous rumble while the crown burns
    impactFlash: 0.24,
    rumble: 0.05, // rumble while the fire line races out
    colorFlash: '#ffb066' // the full-screen flash when it catches
  },

  /* ================================================================== */
  /* KRAKEN CROWN — the fourth far cast, and the one that moves          */
  /* ================================================================== */
  /**
   * The Glacial and Pyre Crowns argue that an ability's identity lives in its
   * material. This one is the counter-argument: it lives in the **motion**.
   *
   * Both of those bloom once and then stand — nothing about either silhouette
   * changes after the first half second. Here nothing about the silhouette is
   * the same on two consecutive frames: a ring of cephalopod arms hauls itself
   * out of a rift, rears back, and then hammers the middle of the footprint
   * over and over for the whole cast, ending on one synchronised slam.
   *
   * So the controls below are laid out by *beat* rather than by layer, and the
   * ones that matter most are not in the material group:
   *
   *   - **`reach`** decides where the arms land. Length is derived from the
   *     footprint through the arc identity in `KrakenAbility` — an arm of length
   *     `πR/2` turning through π puts its point on the exact centre of a circle
   *     of radius `R` — so `reach` is a multiplier on *that*, and 1.0 means dead
   *     centre at any footprint. Above 1 the arms overshoot and cross.
   *   - **`smashPeriod` and `cycleScatter`** decide whether this reads as
   *     rolling thunder or as a drum machine. At `cycleScatter: 0` every arm
   *     lands on the same frame all cast long, which is much less interesting
   *     than it sounds — the finale is the only moment that should do that.
   *   - **`strikeTime`** is the whip itself, and it wants to stay short: the
   *     pose is eased with a quartic, so almost the whole arc is covered in the
   *     last few frames, and stretching this control is the fastest way to make
   *     a heavy limb read as a pool noodle.
   *   - **`strikeTurn`** is π for a reason. Less and the arms punch the floor
   *     short of the middle with their points still up; more and they drive past
   *     it and hammer with the *back* of the curl, which is a different and much
   *     angrier ability. Both are worth a look.
   */
  kraken: {
    /* --- the cast --- */
    range: 18.0, // maximum cast distance, metres
    minRange: 0.0, // dropping it on your own feet is a legitimate play
    zoneRadius: 4.6, // the footprint — what the circle indicator measures out
    speed: 42.0, // how fast the wet surge races to the point, metres/second
    openTime: 0.3, // seconds the rift takes to tear out to the boundary
    lifetime: 5.5, // seconds the arms stand and hammer
    withdrawDelay: 0.35, // seconds after `lifetime` before they are pulled back
    withdrawTime: 0.85, // seconds one arm takes to go under
    withdrawStagger: 0.4, // seconds of random delay between neighbours
    withdrawSink: 0.8, // how far the arm settles into the rift as it goes, metres
    cooldown: 2.2,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the cast leaves the caster --- */
    handHeight: 1.22, // metres above the floor
    handForward: 0.6, // metres in front of the caster
    handSide: 0.18, // metres to the side (+ follows `Ability#side`)

    /* --- how the ring is filled --- */
    /**
     * Two roles, stepped separately around the circle and offset half a stride
     * from each other so the whips fall *between* the arms rather than on top of
     * them. The heavy arms are what smash; the whips are there so the gaps
     * between them are never empty and so something is always moving somewhere
     * in the ring even at the bottom of a strike cycle.
     */
    armCount: 9, // heavy limbs on the boundary — these do the hammering
    whipCount: 12, // thin cords lashing between them
    density: 1.0, // multiplier on both counts (26 arms total, hard cap)
    ringSeat: 0.97, // where the heavy arms come up, × zoneRadius
    ringScatter: 0.06, // radial jitter on that seat, × zoneRadius
    whipSeat: 1.05, // ... and where the whips do
    whipScatter: 0.14,

    /* --- the arm --- */
    /**
     * `reach` is the one number that decides where the arms land, and it is a
     * multiplier on a derivation rather than a length: see the block comment.
     * `splay` is what stops nine arms converging on a single point like the ribs
     * of an umbrella — each is aimed a little off the middle, so they cross over
     * the throat and pile onto each other.
     */
    reach: 1.06, // × the length that lands the point dead centre
    lengthJitter: 0.12,
    thickness: 0.4, // radius where the arm leaves the rift, metres
    thicknessJitter: 0.22,
    whipLength: 0.72, // × an arm's length
    whipThickness: 0.42, // × an arm's thickness
    splay: 0.32, // radians a strike is aimed off the radius, ±

    /* --- the tube it is built from --- */
    rings: 44, // cross-sections up the arm — this is the bend's resolution
    sides: 12, // vertices around one cross-section
    taper: 0.05, // radius at the point, × the base
    swell: 1.32, // radius through the muscle, × the cone profile
    swellAt: 0.17, // where that swell sits, 0 = the rift, 1 = the point
    armRoughness: 0.15, // muscle segmentation up the length
    flatten: 0.85, // cross-section flattening across the sucker face

    /* --- the poses, in radians of total turn --- */
    /**
     * Every shape the arm ever takes is four numbers: a lean, a curl, a wave and
     * a twist. Positive turns the arm *inward*, over the middle; negative leans
     * it out over the floor. The strike is the only pose with the turn in the
     * lean rather than the curl, and that is not a style choice — a constant
     * curvature is the only profile whose tip has a closed form, and that closed
     * form is what places every shockwave, crack and chip of stone.
     */
    coilLean: 0.2, // how it arrives: a tight curl, because that is what
    coilCurl: 5.4, // ... comes out of a hole
    idleLean: -0.7, // at rest: leaning out over the floor
    idleCurl: 2.4, // ... with the point curling back in over the ring
    rearLean: -1.3, // cocked: bowed hard out, and the curl only half as strong,
    rearCurl: 1.6, // ... so the point stands up *behind* the ring, poised
    strikeTurn: 3.14159, // π — the turn that lands the point on the middle
    turnJitter: 0.09, // extra turn, per arm — one-sided, and never less
    strikeSquash: 0.35, // how much the arm thickens as it whips, × its radius
    settle: 0.22, // radians of ring-out after it lands
    settleSpeed: 26.0, // how fast that ringing beats

    /* --- the travelling wave, which is what keeps a resting arm alive --- */
    waveIdle: 0.55, // amplitude at rest
    waveRear: 0.3, // ... while it is cocked
    waveStrike: 0.04, // ... during the whip: a whip is smooth
    waveCoil: 0.8, // ... while it is still coming out
    waveFreq: 1.15, // waves along the arm
    waveSpeed: 0.55, // how fast they travel, revolutions/second
    twist: 0.9, // radians the section rolls from the rift to the point

    /* --- the beat --- */
    /**
     * The arms erupt as a sweep from the near side, then each runs its own
     * strike cycle — rear, whip, press, peel — scattered around the ring by
     * `cycleScatter` so the slams arrive as rolling thunder. `finaleLead` is the
     * exception: that many seconds before the end, every arm abandons its own
     * clock and lands together.
     */
    riseTime: 0.45, // seconds from the first of it out of the rift to uncoiled
    sweepTime: 0.7, // seconds the wave of arms takes to run around the ring
    stagger: 0.14, // seconds of random delay on top of that
    whipDelay: 0.12, // seconds the thin cords come up behind the heavy arms
    smashPeriod: 1.35, // seconds between one arm's strikes
    whipPeriod: 0.62, // × that, for the whips — they lash far more often
    cycleScatter: 0.85, // fraction of a period the ring is scattered over
    rearTime: 0.38, // seconds spent winding up
    strikeTime: 0.19, // seconds the whip itself takes — short, but still visible
    holdTime: 0.22, // seconds pressed against the floor
    peelTime: 0.45, // seconds lifting back off it
    finaleLead: 0.75, // seconds before the end that every arm lands together

    /* --- the flesh --- */
    /**
     * The only *shaded* material in the project that is not energy: it is lit by
     * the room's own sun, it has a wet coat, and it has to hold up close. Three
     * controls carry it. `chroma` runs the bands of colour that travel the arm —
     * real cephalopods do exactly this and it is what sells the thing as alive;
     * `suckers` lays two staggered rows down the inside of every curl, which is
     * the read at any distance; and `biolume` is what the arm makes for itself,
     * spent almost entirely on the sucker rims because the inside of a curl is
     * the side that faces you across the ring.
     */
    colorSkin: '#7a2f56', // the body of it
    colorSkinDeep: '#2a0f22', // the dark in the mottling
    colorBelly: '#e8b9a8', // the pale underside, where the suckers are
    colorFlush: '#ff3b5c', // what a chromatophore wave floods it toward
    colorBiolume: '#4ff2d8', // the light it makes itself
    colorSucker: '#f2d8c8', // the rims of the cups
    colorRim: '#ff6f9c', // the fresnel at the silhouette
    mottle: 0.65, // depth of the blotching
    mottleScale: 3.2, // blotches along the arm
    mottleWarp: 0.55, // domain warp on them
    bellyBlend: 0.8, // how far the pale underside reaches around
    depthShade: 0.5, // how dark the foot of the arm is, down in the rift
    chroma: 0.5, // strength of the travelling colour bands
    chromaScale: 2.4, // bands along the arm
    chromaSpeed: 0.45, // how fast they travel (a strike speeds them up)
    chromaSharp: 3.4, // 0 = a wash, high = distinct bands
    chromaWarp: 0.7, // how far the mottling drags them out of line
    suckers: 1.0, // master — 0 takes the rows off entirely
    suckerDensity: 30.0, // cups down the length of the arm
    suckerSize: 0.62, // how much of its cell one cup fills
    suckerSpan: 0.85, // radians of the circumference they cover, ±
    suckerRows: 0.46, // radians between the two rows
    suckerRelief: 0.65, // how deep the cups read
    suckerGlow: 1.2, // how hard the rims carry the biolume
    suckerStart: 0.06, // how far up the arm the rows begin
    biolume: 0.85, // strength of the light the arm makes
    biolumeScale: 2.6, // veins along the arm
    biolumeSpeed: 0.7, // how fast they crawl
    biolumePulse: 0.4, // depth of the slow breathing
    specular: 1.5, // the wet highlight
    gloss: 52.0, // how tight that highlight is
    envIntensity: 0.55, // how much of the HDR probe the wet coat catches
    rim: 0.65, // fresnel at the silhouette
    rimPower: 3.2, // how tightly it hugs the edge
    translucency: 0.5, // light coming through the thin end
    glow: 1.0,
    opacity: 1.0,
    frontRough: 0.3, // how ragged the arm's leading edge is as it emerges
    frontWidth: 0.12, // how much of it glows behind that edge
    frontGlow: 2.0,
    strikeFlash: 1.5, // how hard the arm floods when it lands

    /* --- the rift on the floor --- */
    /**
     * The same circle and the same thick boundary as the three far casts before
     * it, torn open into deep water. What it does that none of them do is
     * *turn*: the interior is a maelstrom, and shearing the angle by the radius
     * is the whole spiral. `fieldGlyphRing` is the project's one piece of
     * deliberate iconography, and it earns its place by saying *called* rather
     * than *thrown*. The dark half of the rift is a `SCORCH` decal underneath
     * this quad, because drowned stone has to subtract and this pass is
     * additive.
     */
    fieldBoundary: 0.5, // thickness of the band at the edge, metres
    fieldBoundaryGlow: 1.5,
    fieldFill: 0.45, // the wash inside it
    fieldFalloff: 1.15, // how hard that wash crowds to the rim
    fieldPlates: 0.7, // tonal break-up between the drowned flagstones
    fieldCrackScale: 2.6, // plates per metre
    fieldCrackWidth: 0.2, // how wide the lit seams between them read
    fieldCracks: 1.25, // how hard those seams glow
    fieldSpiral: 0.75, // the maelstrom
    fieldSpiralArms: 3, // how many arms it has
    fieldSpiralTwist: 1.1, // how tightly they wind going inward
    fieldSpin: 0.1, // revolutions/second the whole thing turns
    fieldWarp: 0.65, // domain warp — what stops the arms reading as spokes
    fieldCrawl: 0.45, // how fast the sparks drift
    fieldSparks: 1.0, // cold points glittering in the water
    fieldSparkScale: 5.0,
    fieldRings: 3.0, // swell rings travelling over the disc
    fieldRingSpeed: -0.55, // rings/second (negative runs them inward)
    fieldGlyphRing: 0.8, // the summoning ring — 0 takes it off
    fieldGlyphSeat: 0.6, // where it sits, × zoneRadius
    fieldGlyphTicks: 18, // marks stepped around it
    fieldThroat: 1.4, // the mouth in the middle — and the anvil
    fieldThroatSize: 0.28, // its radius, × zoneRadius
    fieldPulse: 0.28, // brightness breathing
    fieldPulseSpeed: 1.3,
    fieldOpacity: 1.0,
    fieldHeight: 0.03, // hover distance above the floor, metres
    colorField: '#0e6f7a', // the water, the crust and the spiral
    colorFieldEdge: '#7ff5e2', // the boundary band, the seams and the throat

    /* --- the curtain of spray on its rim --- */
    /**
     * The Pyre Crown's wall of flame, answered by the one thing that behaves the
     * opposite way: fire climbs, spray *hangs*. It leans inward over the hole
     * instead of flaring out, it is dragged around the ring rather than up it,
     * and it is the only veil in the project that is **not additive** — spray is
     * matter, and half of what makes the crown look deep is that the far arms
     * are seen through a haze of it while the near ones are not.
     */
    veil: 0.55, // master opacity of the curtain, 0 hides it
    veilHeight: 1.6, // how high it stands, metres
    veilRadius: 1.0, // where it stands, × zoneRadius
    veilLean: -0.14, // negative closes it over the rift
    veilBillow: 0.35, // metre-scale lobes pushing its silhouette off round
    veilScale: 1.1, // noise features per metre
    veilStretch: 0.6, // <1 draws the structures out vertically
    veilFlow: 0.45, // how fast it settles downward
    veilSwirl: 0.12, // how fast it is dragged around the ring
    veilErode: 0.8, // how much harder the top is eaten away than the base
    veilFalloff: 1.35, // how fast it thins with height
    veilSpin: 0.05, // revolutions/second the whole curtain turns
    veilSoftFade: 1.8, // metres of soft fade where it meets geometry
    veilGlint: 0.7, // droplets catching the light as the sheet falls
    colorVeil: '#2c5b63', // the body of it
    colorVeilFoam: '#cfeff5', // where the sheet tears
    colorVeilInk: '#070d12', // what it goes at the floor, where it is thickest

    /* --- what the ground does --- */
    trailSlickRate: 2.0, // wet patches laid per metre of surge travel
    trailSlickRadius: 1.1, // radius of one, metres
    slickSpread: 1.5, // the drowned sheet under the crown, × zoneRadius
    slickLife: 8.0, // seconds a wet patch lingers
    slickIntensity: 0.9,
    slickRate: 2.5, // wet patches creeping around the boundary, per second
    slickRadius: 1.0, // radius of one, metres
    rippleRate: 0.8, // swell rings pushed out while it stands, per second
    tearShock: 8.5, // the ring that snaps out when the rift opens, metres
    colorSlick: '#0a1a20', // wet stone
    colorFoam: '#bfe8ef', // the foam drying on it
    colorDrowned: '#050d14', // the dark half of the rift
    colorShockA: '#3fd8d0', // body of a shockwave ring
    colorShockB: '#e8fffb', // its crest
    colorRippleA: '#2aa7b8', // body of a swell ring
    colorRippleB: '#d8fbff', // its crest
    colorDust: '#3a4a4e', // the dust ring a slam throws out

    /* --- the smash --- */
    /**
     * Four layers per landing, because a single shockwave decal reads as a UI
     * element: a ring snapping out from under the point, a ground-hugging ring
     * of dust, the stone itself thrown up, and the water that was standing there
     * thrown flat and outward. `whipPower` scales all of it down for the thin
     * cords — they lash, they do not hammer — and `finalePower` scales it up for
     * the one strike every arm makes together.
     */
    smashShock: 0.85, // the ring under the point, × zoneRadius
    smashDust: 0.7, // the dust ring, × zoneRadius
    smashDebris: 26, // chips of floor thrown up
    smashSpray: 44, // water thrown flat and outward
    smashInk: 10,
    smashShake: 0.5, // how hard one landing hits the camera
    smashShakeDecay: 0.5, // seconds that hit takes to die away
    whipPower: 0.42, // × everything above, for a whip's landing
    finalePower: 1.7, // ... and for the synchronised one
    finaleFlash: 0.26, // screen flash when every arm lands together
    finaleShock: 13.0, // the ring that answers it, metres

    /* --- the tear, and the standing crown --- */
    tearSpray: 150, // water blown out of the rift as it opens
    tearInk: 70,
    tearDebris: 90,
    tearShake: 0.9,
    shakeDuration: 0.8,
    tearFlash: 0.18,
    holdShake: 0.05, // continuous rumble while the arms stand
    rumble: 0.05, // rumble while the surge races out
    castFlash: 0.08, // screen flash on release
    colorCastFlash: '#5fe6dc',
    colorFlash: '#8ff5e6', // the full-screen flash when the rift tears
    breachSpray: 22, // water thrown as one arm hauls itself out
    breachInk: 5,
    breachDebris: 10,

    /* --- ink, spray, stone and the marine snow --- */
    /**
     * As in every other block: a four-stop gradient sampled over the particle's
     * own lifetime, `A` at birth through `D` as it dies. The **marine snow** is
     * this ability's signature system, and it is defined by what it does *not*
     * do. Every other crown's air is in a hurry — the Glacial Crown's snow falls
     * through its ring, the Pyre Crown's embers race up out of its crater. This
     * hangs: high drag, almost no gravity, turning slowly about the throat. It
     * is what says the space inside this ring is full of water.
     */
    inkRate: 153, // ink rolling off the rift, particles/second
    inkSize: 0.56,
    inkSpeed: 0,
    inkLifetime: 2.55,
    inkOpacity: 0.105,
    inkRise: 0.36, // barely buoyant: ink spreads, it does not climb
    inkTurbulence: 0,
    colorInkA: '#123838',
    colorInkB: '#0b1d26',
    colorInkC: '#9fbedf',
    colorInkD: '#ffffff',
    sprayRate: 180, // water running off the arms, particles/second
    spraySize: 0.08,
    sprayFxSpeed: 9.1,
    sprayLifetime: 2.45,
    sprayGravity: -13.0,
    sprayOpacity: 0.75,
    sprayTurbulence: 0.35,
    colorSprayA: '#ffffff',
    colorSprayB: '#cfeef5',
    colorSprayC: '#7fb8c6',
    colorSprayD: '#2a4a55',
    debrisSize: 0.07, // the floor, broken
    debrisSpeed: 7.5,
    debrisLifetime: 1.9,
    debrisGravity: -16.0,
    colorDebrisA: '#6b7a7e',
    colorDebrisB: '#4a585c',
    colorDebrisC: '#2c3639',
    colorDebrisD: '#141a1c',
    moteRate: 90, // marine snow hanging inside the ring
    moteSize: 0.05,
    moteSpeed: 0.9, // the push it is released with, immediately lost to drag
    moteLifetime: 4.5,
    moteDrift: 0.06, // buoyancy, metres/second² — very nearly neutral
    moteSwirl: 0.55, // radians/second it turns about the throat
    moteExpand: 0.35, // how far the spiral opens as it climbs
    moteGlow: 1.3,
    moteTurbulence: 0.6,
    moteInset: 0.85, // how far inside the boundary it rises, × zoneRadius
    moteSeat: 2.2, // how high above the floor it is released, metres
    colorMoteA: '#d8fff6',
    colorMoteB: '#5ef0d8',
    colorMoteC: '#1e9fb0',
    colorMoteD: '#06202c',

    /* --- dynamic light --- */
    lightIntensity: 14,
    lightRadius: 16,
    lightHeight: 0.9, // metres above the floor — down in the water, not up
    lightColor: '#2ed6c8'
  },

  /* ================================================================== */
  /* ELECTRIC BOOST — the self buff                                      */
  /* ================================================================== */
  /**
   * A self cast, and the only thing in the sandbox that is not a skillshot:
   * there is no line, no circle and no travelling front. Press the key and the
   * character is *charged* for `duration` seconds.
   *
   * It is made of three parts, all driven by one 0..1 envelope (`rampIn` → hold
   * → `rampOut`) so the whole effect arrives and leaves as one thing:
   *
   *   - **the fresnel** — every material on the rig is patched once at load
   *     (`materials/FresnelAura.js`), so the rim of the body lights up from the
   *     inside, with veins crawling over the skin and a band sweeping up it.
   *     The patch is inert while the envelope is zero, which is why it costs
   *     nothing when the buff is not running.
   *   - **the arcs** — filaments struck between two points on a capsule around
   *     the body (`materials/BodyArcMaterial.js`), re-rolled `arcRate` times a
   *     second. A fraction of them (`arcEscape`) leave the body instead of
   *     crawling over it, which is what reads as lightning coming *off* the
   *     character rather than being painted on it.
   *   - **the ground** — a crater of shattered, blackened floor with the charge
   *     burning in the seams (`materials/ChargeFieldMaterial.js`), rings of
   *     lightning lying flat around it and uprights struck off its rim. The
   *     crater is the only ground pass in the sandbox that blends normally
   *     rather than additively, because it has to *darken* the stone.
   *   - **the shed** — sparks, ionised motes, electric burns under the feet and
   *     a dynamic light, all at a continuous rate while the buff holds.
   *
   * As everywhere else, nothing here is captured at activation: the envelope is
   * resolved against `duration` every frame, and both shaders resolve every
   * metre and radian below on a zero-length frame — so dragging `arcs`,
   * `bodyRadius` or `fresnelPower` while paused re-strikes the character live.
   */
  boost: {
    /* --- the buff --- */
    duration: 13.7, // seconds it holds, from the moment it is triggered
    rampIn: 0.35, // seconds the envelope takes to arrive
    rampOut: 0.9, // seconds it takes to let go at the end
    cooldown: 1.0, // seconds before it can be triggered again
    playAnimation: true, // throw a cast clip on activation
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` that is

    /* --- the fresnel on every material of the character --- */
    // `fresnel` is the master: at 0 the rig is shaded exactly as it is when the
    // buff is not running, whatever the rest of this group says.
    fresnel: 0.2, // master strength of the rim light
    fresnelPower: 1.55, // how tightly it hugs the silhouette (higher = thinner)
    fresnelBias: 0.0, // glow added to the lit body, not just the rim
    fresnelGlow: 2.35, // emissive gain — this is what blooms
    fresnelPulse: 0.5, // depth of the slow breathing
    fresnelPulseSpeed: 4.2,
    fresnelFlicker: 0.2, // depth of the electric stutter on top of it
    fresnelFlickerSpeed: 20,
    veins: 0.72, // filaments crawling over the skin
    veinScale: 1.1, // features per metre, world space
    veinSpeed: 2.05, // how fast they crawl
    veinSharp: 1.0, // 0 = soft blotches, 1 = thin filaments
    scan: 0.45, // brightness of the band sweeping up the body
    scanSpeed: 0.5, // sweeps/second
    scanWidth: 0.18, // height of the band, fraction of the body
    colorRim: '#7fc9ff',
    colorCore: '#009dff', // the hottest part of the rim
    colorVein: '#4a92ff',

    /* --- the arcs struck over and off the body --- */
    arcs: 25, // filaments alive at once (capped at 32)
    arcRate: 5.4, // times/second each one re-rolls its shape
    arcLife: 0.74, // fraction of that cycle it stays lit
    arcSpan: 0.47, // how far up or down the body one arc travels
    arcSweep: 3.2, // radians around the body it travels
    arcEscape: 0.09, // fraction of arcs that leave the body
    arcReach: 0.9, // metres an escaping arc reaches out
    arcBow: 0.035, // metres an arc bows off the skin at mid-span

    /* --- the capsule the arcs are struck on --- */
    bodyRadius: 0.39, // half-width of the body at its widest, metres
    bodyDepth: 0.1, // front-to-back radius as a fraction of that
    bodyLow: -0.2, // lowest point arcs are struck from, fraction of height
    bodyHigh: 1.01, // ... and the highest
    bodyProfile: 1.0, // 0 = a cylinder, 1 = the shoulders/ankles silhouette

    /* --- the shape of one arc (as `thunder`, per metre) --- */
    arcJitter: 0.16, // metres of kink at the coarsest octave
    arcJitterScale: 3.3, // kinks per metre
    arcOctaves: 4, // 1–5
    arcJitterFalloff: 0.53,
    arcCrawl: 4.2, // how fast the kinks slide along the arc
    arcPinch: 0.225, // fraction of the span the ends are pulled straight over

    /* --- the ribbon --- */
    arcWidth: 0.017, // half-width of a filament, metres
    arcTaper: 1.02, // how hard it tapers to nothing at both ends
    arcCoreWidth: 1.39, // multiplier on the hot spine
    arcCoreSharp: 3.4, // how hard the core falls off across the ribbon
    arcGlowWidth: 6.0, // the halo, × the core width
    arcGlowFalloff: 2.4,
    arcGlowOpacity: 0.4,
    arcSoftFade: 0.35, // metres of soft fade where an arc meets geometry
    arcFlicker: 0.33, // whole-bundle brightness stutter
    arcFlickerSpeed: 30,
    arcStrandFlash: 0.45, // how much individual arcs blink out
    arcGlow: 3.24, // emissive gain
    arcOpacity: 1.0,
    colorArcCore: '#ffffff',
    colorArcInner: '#c9ecff',
    colorArcOuter: '#3aa0ff',
    colorArcHalo: '#0b3fc8',

    /* --- sparks & motes shed while it holds --- */
    sparkRate: 800, // particles/second
    sparkSize: 0.045,
    sparkSpeed: 16.5,
    sparkLifetime: 1.12,
    sparkGravity: -11.0,
    sparkStretch: 0.16,
    colorSparkA: '#73ccf2',
    colorSparkB: '#4d9aff',
    colorSparkC: '#c9ecff',
    colorSparkD: '#1e5b95',
    moteRate: 70,
    moteSize: 0.05,
    moteSpeed: 1.1,
    moteLifetime: 1.5,
    moteRise: 2.0, // upward drift, metres/second
    moteTurbulence: 0.8,
    colorMoteA: '#53c7ee',
    colorMoteB: '#c9ecff',
    colorMoteC: '#3aa0ff',
    colorMoteD: '#02195f',

    /* --- what the floor under the caster does --- */
    groundRate: 3.5, // electric burns laid per second
    groundRadius: 1.0, // radius of one, metres
    groundSpread: 0.9, // how far off the feet they are scattered, metres
    groundLife: 0.55,
    groundIntensity: 0.9,
    groundBranches: 0.6, // how finely a burn splits into filaments
    colorGround: '#9fdcff',
    colorGroundEmber: '#4aa8ff',

    /* --- the crater the charge stands in --- */
    /**
     * The floor, shattered and gone dark under the character
     * (`materials/ChargeFieldMaterial.js`). The one ground pass in the sandbox
     * that blends *normally* rather than additively, because the read is a hole
     * in the room: `fieldDark` is how far the stone inside the circle is pushed
     * toward `colorFieldCrust`, and the light in the seams is what it is bright
     * against. Turn `fieldOpacity` to 0 and the whole crater — plates, seams and
     * lip — costs one discarded quad.
     */
    fieldRadius: 1.0, // radius of the broken circle, metres
    fieldHeight: 0.01, // metres above the floor the quad is seated
    fieldEdge: 0.02, // width of the torn lip, metres
    fieldEdgeGlow: 6.0, // how hot the lip burns
    fieldTear: 0.055, // how far out of round the boundary is dragged
    fieldDark: 1.0, // how black the crust goes, 0 = the floor is untouched
    fieldDarkScale: 1.7, // grain over the plates, features per metre
    fieldDarkContrast: 1.6,
    fieldPlateScale: 5.65, // shards per metre
    fieldPlateTone: 0.68, // how differently one shard is toned from the next
    fieldSeamWidth: 0.04, // width of a lit seam, in cell units
    fieldSeams: 1.31, // how brightly the seams burn
    fieldVeins: 0.75, // filaments crawling over the shards
    fieldVeinScale: 2.4,
    fieldWarp: 0.55, // domain warp on them, so they wander
    fieldCrawl: 0.45,
    fieldEmbers: 0.85, // single hot points glittering in the crust
    fieldEmberScale: 5.0,
    fieldFalloff: 3.5, // how the light dies back toward the lip
    fieldPulse: 0.21,
    fieldPulseSpeed: 1.8,
    fieldOpacity: 1.0,
    fieldGlow: 2.6,
    colorFieldCrust: '#03060c', // the bottom of the hole
    colorFieldPlate: '#0b1622', // the face of a shard
    colorFieldSeam: '#3aa0ff',
    colorFieldEmber: '#c9ecff',

    /* --- the rings running around the crater --- */
    /**
     * Filaments lying flat on the ground, each a partial loop with its radius
     * pushed in and out by noise sampled **on the bearing** — so a lobe belongs
     * to a patch of floor and every ring in the stack agrees about where the
     * ground bulges, instead of reading as unrelated hoops.
     */
    ringCount: 6, // rings alive at once (capped at 16)
    ringRate: 3.2, // times/second each one re-rolls
    ringLife: 0.8, // fraction of that cycle it stays lit
    ringInner: 1.43, // innermost ring, × fieldRadius
    ringOuter: 1.02, // ... and the outermost
    ringLift: 0.55, // metres above the floor the stack reaches
    ringSweep: 0.78, // fraction of the full turn one ring covers
    ringWobble: 0.22, // metres its radius is pushed in and out
    ringWobbleScale: 2.1, // lobes around the circle
    ringRipple: 0.1, // metres it lifts and dips as it runs
    ringWrithe: 0.4, // how fast the lobes crawl around the floor
    ringWidth: 0.016, // half-width of a ring filament, metres

    /* --- the uprights struck off the rim --- */
    /**
     * `spireCross` of them arch clear over the middle and earth on the far side
     * — that is the roof of the cage; the rest climb to `spireHeight` and end in
     * the air, leaning outward by `spireLean` — that is the crown standing
     * around the edge.
     */
    spireCount: 30, // uprights alive at once (capped at 32)
    spireRate: 9.4, // strikes/second
    spireLife: 0.64, // fraction of the cycle one stays lit
    spireHeight: 0.7, // metres a climbing upright reaches
    spireCross: 0.28, // fraction that arch across the circle instead
    spireSpan: 1.9, // radians of rim a crossing arch spans
    spireSpread: 0.3, // ... and how far a climbing one drifts around
    spireLean: 0.3, // metres a climbing one bows outward
    spireWidth: 0.02, // half-width of an upright filament, metres

    /* --- the ribbon both of them are drawn on --- */
    coilJitter: 0.035, // metres of kink at the coarsest octave
    coilJitterScale: 4.2, // kinks per metre
    coilOctaves: 4, // 1–5
    coilJitterFalloff: 0.62,
    coilCrawl: 3.0, // how fast the kinks slide along a filament
    coilPinch: 0.16, // fraction of the span the ends are pulled straight over
    coilTaper: 0.6, // how hard a filament tapers to nothing at both ends
    coilCoreWidth: 1.4, // multiplier on the hot spine
    coilCoreSharp: 3.4,
    coilGlowWidth: 6.0, // the halo, × the core width
    coilGlowFalloff: 4.05,
    coilGlowOpacity: 0.37,
    coilSoftFade: 0.8, // metres of soft fade where a filament meets geometry
    coilFlicker: 0.28, // whole-coil brightness stutter
    coilFlickerSpeed: 62,
    coilStrandFlash: 0.4, // how much individual filaments blink out
    coilGlow: 3.0, // emissive gain
    coilOpacity: 1.0,
    colorCoilCore: '#ffffff',
    colorCoilInner: '#c9ecff',
    colorCoilOuter: '#3aa0ff',
    colorCoilHalo: '#0b3fc8',

    /* --- dynamic light --- */
    lightIntensity: 11,
    lightRadius: 9,
    lightHeight: 1.1, // metres above the floor the light sits
    lightColor: '#63b8ff',
    lightFlicker: 0.35, // depth of its gutter, 0 = steady
    lightFlickerSpeed: 22,

    /* --- the moment it is triggered, and the moment it lets go --- */
    burstSparks: 140,
    ringRadius: 4.5, // shockwave ring across the floor, metres
    activateFlash: 0.16, // screen flash on activation
    activateShake: 0.5,
    shakeDuration: 0.5,
    endFlash: 0.1, // ... and when it expires
    rumble: 0.018, // continuous shake while it holds
    colorFlash: '#c9ecff'
  },

  /* ================================================================== */
  /* MAGIC BOOST — the second self buff                                  */
  /* ================================================================== */
  /**
   * The other thing in the sandbox that is not a skillshot, and the opposite
   * reading of the same idea: where Electric Boost is a charge — hard, fast,
   * struck in filaments — this is a **channelling**. Slow, wide and dark. Press
   * the key and the character is lit from the inside in violet, wrapped in
   * turning ribbons, and standing in smoke.
   *
   * Built out of the same four parts, driven by the same single 0..1 envelope
   * (`rampIn` → hold → `rampOut`):
   *
   *   - **the fresnel** — the *same* patch on the character's own materials
   *     that the electric buff uses (`materials/FresnelAura.js`), shaded from
   *     this block instead. The two file claims against one uniform block and
   *     the stronger claim wins, so holding both does not fight.
   *   - **the ribbons** — wide sheets wound around the body on helices
   *     (`materials/ArcaneRibbonMaterial.js`), turning about it, climbing
   *     through themselves and dissolving at both tips. The signature of the
   *     buff, and the one thing in the project drawn as a *sheet* rather than
   *     as a filament, a shell or a quad.
   *   - **the ground** — smoke lying on the floor, sheared into a spiral by a
   *     frame that rotates with radius, with the light of the buff pooled under
   *     it (`materials/DarkFieldMaterial.js`). The second ground pass in the
   *     sandbox that blends normally rather than additively, and for the same
   *     reason as the crater: it has to *darken* the stone.
   *   - **the shed** — dark smoke rolling off the body, motes orbiting it, soft
   *     burns on the floor and a dynamic light that swells rather than gutters.
   *
   * As everywhere else, nothing is captured at activation: the envelope is
   * resolved against `duration` every frame and both shaders resolve every
   * metre and radian below on a zero-length frame — so dragging `ribbonRadius`
   * or `fieldDark` while paused re-winds the vortex live.
   */
  magic: {
    /* --- the buff --- */
    duration: 14.0, // seconds it holds, from the moment it is triggered
    rampIn: 0.7, // seconds the envelope takes to arrive — a channel, not a snap
    rampOut: 1.4, // seconds it takes to let go at the end
    cooldown: 1.0, // seconds before it can be triggered again
    playAnimation: true, // throw a cast clip on activation
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` that is

    /* --- the fresnel on every material of the character --- */
    // Same uniform names as the electric buff, because it is the same patch —
    // see `materials/FresnelAura.js`. `fresnel` is the master: at 0 the rig is
    // shaded exactly as it is when nothing is running.
    fresnel: 0.8, // master strength of the rim light
    fresnelPower: 1.35, // how tightly it hugs the silhouette (higher = thinner)
    fresnelBias: 0.05, // glow added to the lit body, not just the rim
    fresnelGlow: 2.6, // emissive gain — this is what blooms
    fresnelPulse: 0.35, // depth of the slow breathing
    fresnelPulseSpeed: 1.9, // slower than the charge: this one breathes
    fresnelFlicker: 0.06, // barely any stutter — magic does not gutter
    fresnelFlickerSpeed: 9,
    veins: 0.85, // filaments crawling over the skin
    veinScale: 1.35, // features per metre, world space
    veinSpeed: 0.9, // how fast they crawl
    veinSharp: 0.88, // 0 = soft blotches, 1 = thin filaments
    scan: 0.5, // brightness of the band sweeping up the body
    scanSpeed: 0.32, // sweeps/second
    scanWidth: 0.22, // height of the band, fraction of the body
    colorRim: '#c46bff',
    colorCore: '#ffffff', // the hottest part of the rim
    colorVein: '#8b3cff',

    /* --- the ribbons wound around the body --- */
    /**
     * One instance is one helix. `ribbonTurns` is how far round the body a
     * single ribbon travels over its own length, `ribbonSpin` is how fast the
     * whole vortex turns, and `ribbonClimb` is how fast a ribbon rises through
     * it — those three together are the motion, and they are deliberately
     * separate so the vortex can turn without the ribbons sliding, or the other
     * way round.
     */
    ribbons: 12, // sheets alive at once (capped at 24)
    ribbonRate: 0.96, // times/second each one re-rolls its shape
    ribbonLife: 0.81, // fraction of that cycle it is visible
    ribbonRadius: 0.7, // radius of the vortex, metres
    ribbonRadiusVary: 0.28, // per-ribbon variation on it
    ribbonDepth: 1.0, // front-to-back radius as a fraction of that
    ribbonFlare: 0.5, // 0 = a cylinder, 1 = a barrel widest at the waist
    ribbonLow: -0.08, // where a ribbon starts, fraction of body height
    ribbonHigh: 1.86, // ... and where it ends
    ribbonScatter: 2.6, // radians of jitter on the even fan around the body
    ribbonTurns: 1.05, // turns about the body over one ribbon's length
    ribbonTurnVary: 0.25,
    ribbonSpin: 0.26, // revolutions/second the vortex turns
    ribbonSpinVary: 0.3,
    ribbonCounter: 0.22, // fraction of ribbons turning the other way
    ribbonClimb: 0.32, // metres/second a ribbon rises over its life

    /* --- how far a ribbon wanders off its helix --- */
    ribbonWobble: 0.2, // metres its radius is pushed in and out
    ribbonWobbleScale: 2.4, // lobes along its length
    ribbonWave: 0.22, // metres it lifts and dips as it runs
    ribbonWaveScale: 1.9,
    ribbonCrawl: 0.3, // how fast that wander crawls

    /* --- the sheet --- */
    ribbonWidth: 0.17, // half-width of a sheet, metres
    ribbonWidthVary: 0.55, // how much narrower the thinnest ones are
    ribbonTaper: 2.12, // how hard it tapers to nothing at both ends
    ribbonBank: 1.0, // 0 = flat to the camera, 1 = banked into the helix
    ribbonFill: 0.22, // opacity of the interior wash
    ribbonFillFalloff: 1.7, // how fast that wash dies toward the edges
    ribbonEdge: 0.6, // brightness of the lit band at each lip
    ribbonEdgeWidth: 0.36, // how much of the sheet that band covers
    ribbonGlowWidth: 2.2, // the halo, × the sheet width
    ribbonGlowFalloff: 2.2,
    ribbonGlowOpacity: 0.22,
    ribbonWisp: 0.8, // how hard the strands eat into the sheet
    ribbonWispScale: 3.2, // strands along its length
    ribbonWispCross: 0.9, // ... and how much they vary across it
    ribbonWispSpeed: 0.55, // how fast they scroll backward
    ribbonWispSharp: 1.5, // 0 = a soft wash, high = separated strands
    ribbonEndFade: 0.24, // fraction of the length that dissolves at each tip
    ribbonSoftFade: 0.6, // metres of soft fade where a sheet meets geometry
    ribbonFlicker: 0.1, // whole-vortex brightness stutter
    ribbonFlickerSpeed: 8,
    ribbonStrandFade: 0.5, // how far the dimmest ribbons drop back
    ribbonGlow: 1.7, // emissive gain
    ribbonOpacity: 1.0,
    colorRibbonCore: '#ffdcff', // the lit lip
    colorRibbonInner: '#e05cff',
    colorRibbonOuter: '#8a1fd6',
    colorRibbonHalo: '#2b0455',

    /* --- the smoke on the floor --- */
    /**
     * `materials/DarkFieldMaterial.js`. `fieldDark` is how far the stone under
     * the character is pushed toward `colorFieldSmoke`, and `fieldPool` is the
     * light it is dark against. `fieldCurl` is the one that matters most: it is
     * how much further round the *outside* of the disc is dragged than the
     * middle, which is what winds the cloud into arms.
     */
    fieldRadius: 1.8, // radius of the cloud, metres
    fieldHeight: 0.012, // metres above the floor the quad is seated
    fieldFeather: 0.33, // fraction of the radius the edge fades over
    fieldTear: 0.015, // how far out of round the boundary is dragged
    fieldDark: 1.0, // how black it goes, 0 = the floor is untouched
    fieldSmokeScale: 0.6, // billows per metre
    fieldSmokeContrast: 1.5,
    fieldSwirl: 0.22, // radians/second the whole cloud turns
    fieldCurl: 0.4, // extra turn per metre of radius — the shear
    fieldBillow: 0.65, // domain warp on the smoke
    fieldCrawl: 0.28, // how fast it boils
    fieldPool: 0.7, // the light gathered under the feet
    fieldPoolFalloff: 2.8, // how fast it dies outward
    fieldRing: 0.25, // a soft ring seated inside the boundary
    fieldRingWidth: 0.14,
    fieldRingSeat: 0.7, // where it sits, fraction of the radius
    fieldGlints: 2.03, // single hot points glittering in the smoke
    fieldGlintScale: 8.8,
    fieldPulse: 0.18,
    fieldPulseSpeed: 1.5,
    fieldOpacity: 1.0,
    fieldGlow: 2.0,
    colorFieldSmoke: '#171032', // the deepest part of the cloud
    colorFieldSmokeLit: '#160828',
    colorFieldPool: '#8a2be2',
    colorFieldGlint: '#e3b6ff',

    /* --- the smoke shed off the body --- */
    smokeRate: 33, // puffs/second
    smokeSize: 0.28, // ≈ a metre across at birth, two and a half by the end
    smokeSpeed: 0.35,
    smokeLifetime: 1.85,
    smokeRise: 0.0, // upward drift, metres/second²
    smokeSpread: 0.25, // radius it is released on, metres
    smokeSeat: 0.32, // how high off the floor it is released, metres
    smokeTurbulence: 0.16,
    smokeGlow: 0.46, // held low: this is shadow, not light
    colorSmokeA: '#2a1240',
    colorSmokeB: '#1f0835',
    colorSmokeC: '#1f0042',
    colorSmokeD: '#1b0d30',

    /* --- the motes orbiting it --- */
    moteRate: 138, // particles/second
    moteSize: 0.055,
    moteSpeed: 0.5,
    moteLifetime: 2.4,
    moteRise: 0.75, // upward drift, metres/second²
    moteRadius: 1.05, // radius of the ring they are released on, metres
    moteLow: 0.0, // lowest point they are released from, fraction of height
    moteHigh: 1.15, // ... and the highest
    moteSwirl: 1.15, // radians/second they turn about the body
    moteExpand: -0.29, // negative = the orbit closes in as they climb
    moteTurbulence: 0.0,
    moteGlow: 1.4,
    colorMoteA: '#ffe4ff',
    colorMoteB: '#d07bff',
    colorMoteC: '#8a2be2',
    colorMoteD: '#1e0538',

    /* --- what the floor under the caster does --- */
    groundRate: 1.6, // soft smoke rings laid per second
    groundRadius: 1.4, // radius of one, metres
    groundSpread: 1.1, // how far off the feet they are scattered, metres
    groundLife: 1.6,
    groundIntensity: 0.55,
    colorGround: '#7b3cff',
    colorGroundEmber: '#d9a6ff',

    /* --- dynamic light --- */
    lightIntensity: 9,
    lightRadius: 10,
    lightHeight: 1.0, // metres above the floor the light sits
    lightColor: '#a44bff',
    lightPulse: 0.3, // depth of its swell, 0 = steady
    lightPulseSpeed: 0.55, // ... and how slowly it breathes

    /* --- the moment it is triggered, and the moment it lets go --- */
    burstMotes: 220,
    ringRadius: 4.2, // shockwave ring across the floor, metres
    activateFlash: 0.14, // screen flash on activation
    activateShake: 0.42,
    shakeDuration: 0.7,
    endFlash: 0.09, // ... and when it expires
    rumble: 0.012, // continuous shake while it holds
    colorFlash: '#c98bff'
  },

  /* ================================================================== */
  /* FIRE BOOST — the third self buff                                    */
  /* ================================================================== */
  /**
   * The third thing in the sandbox that is not a skillshot, and the third
   * reading of the same idea. Electric Boost is a **charge** — hard, fast,
   * struck in filaments. Magic Boost is a **channel** — slow, wide and dark.
   * This one **burns**: press the key and the character catches fire, is masked
   * in heat, and is orbited by embers dragging fire behind them.
   *
   * Built out of the same parts as the other two, driven by the same single
   * 0..1 envelope (`rampIn` → hold → `rampOut`):
   *
   *   - **the fresnel** — the *same* patch on the character's own materials the
   *     other two buffs use (`materials/FresnelAura.js`), shaded as heat from
   *     this block. This is the mask: the rim, the veins crawling up the skin
   *     and the band sweeping the body are what put the fire *on the character*
   *     rather than in front of them, and every one of them is a control below.
   *   - **the tongues** — flame rooted on the body's own capsule and climbing
   *     off it (`materials/FireBodyMaterial.js`). The signature of the buff, and
   *     the third thing in the project drawn on that capsule after the charge's
   *     arcs and the channel's ribbons.
   *   - **the orbs** — burning spheres turning about the body on leaning rings,
   *     each dragging a wake of fire (`materials/EmberOrbMaterial.js`). The one
   *     effect in the sandbox whose trail is not recorded but *derived*: it is
   *     the orb's own orbit sampled backward in time, which is why dragging
   *     `orbTilt` below re-sweeps a second of wake instantly, paused or not.
   *   - **the ground** — the floor burnt black under the caster with the fire
   *     still working in the cracks (`materials/CinderFieldMaterial.js`). The
   *     third ground pass that blends normally rather than additively, and for
   *     the same reason as the other two: it has to *darken* the stone.
   *   - **the shed** — embers off the body and off the orbs, smoke rolling over
   *     them, scorches on the floor and a light that gutters like a fire does.
   *
   * As everywhere else, nothing is captured at activation: every metre, radian
   * and rate below is re-resolved on a zero-length frame.
   */
  fire: {
    /* --- the buff --- */
    duration: 13.5, // seconds it holds, from the moment it is triggered
    rampIn: 0.5, // seconds the envelope takes to arrive
    rampOut: 1.4, // seconds it takes to burn down at the end
    cooldown: 1.0, // seconds before it can be triggered again
    playAnimation: true, // throw a cast clip on activation
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` that is

    /* --- the fresnel mask on every material of the character --- */
    // `fresnel` is the master: at 0 the rig is shaded exactly as it is when the
    // buff is not running, whatever the rest of this group says.
    fresnel: 0.42, // master strength of the rim light
    fresnelPower: 1.5, // how tightly it hugs the silhouette (higher = thinner)
    fresnelBias: 0.02, // heat added to the lit body, not just the rim
    fresnelGlow: 2.4, // emissive gain — this is what blooms
    fresnelPulse: 0.35, // depth of the slow breathing
    fresnelPulseSpeed: 3.0,
    fresnelFlicker: 0.28, // depth of the guttering on top of it
    fresnelFlickerSpeed: 16,
    veins: 0.85, // filaments of fire crawling over the skin
    veinScale: 1.6, // features per metre, world space
    veinSpeed: 2.6, // how fast they crawl (positive = up the body)
    veinSharp: 0.85, // 0 = soft blotches, 1 = thin filaments
    scan: 0.3, // brightness of the band sweeping up the body
    scanSpeed: 0.7, // sweeps/second
    scanWidth: 0.22, // height of the band, fraction of the body
    colorRim: '#ff6a1e',
    colorCore: '#ffd27a', // the hottest part of the rim
    colorVein: '#ff9a2e',

    /* --- the skeleton the fire is rooted on --- */
    /**
     * There is no capsule here. The tongues are rooted on the rig's *own* limb
     * segments, resolved out of the skeleton by `CharacterController` and handed
     * to the shader as world-space joints every frame — which is why fire on a
     * forearm swings with the arm. The only control the shape needs is how
     * thick the limbs are taken to be, since the rig carries no such number.
     */
    boneThickness: 1.0, // multiplier on every limb's half-width

    /* --- the tongues climbing off it --- */
    flames: 80, // tongues alive at once (capped at 96)
    flameRate: 1.15, // times/second each one re-rolls
    flameLife: 0.59, // fraction of that cycle it is burning
    flameSprout: 0.56, // how long it starts out, fraction of full length
    flameLength: 0.5, // metres a tongue reaches at full size, on a chest
    flameLengthVary: 0.5, // how differently one is sized from the next
    // The three controls that hold the fire *on* the rig. `bend` is the one
    // that matters: at 1 a tongue leaves the skin on a straight diagonal, and
    // the higher it goes the longer the tongue lies along the limb before it
    // turns upward. `limbTaper` sizes each tongue to the bone under it, so a
    // toe carries a lick and a ribcage carries a sheet.
    flameBend: 2.1, // how late the climb turns from the limb to the vertical
    flameLimbTaper: 0.85, // how far length and width follow the limb's own girth
    flameWrap: 1.2, // radians a tongue winds about the limb as it climbs
    flameLean: 0.06, // metres its tip peels away from the body
    flameClimb: 0, // metres/second the whole tongue drifts upward
    flameOffset: 0, // metres its root sits off the skin
    flameSway: 0.16, // metres its tip wanders, x its length
    flameSwayPower: 2.9, // how hard the wander is held to the root
    flameSwayScale: 2.2, // waves along one tongue
    flameSwaySpeed: 1.8, // how fast the wander travels up it

    /* --- the sheet one tongue is drawn on --- */
    flameWidth: 0.1, // half-width at the root, metres
    flameWidthVary: 0.45,
    flameTaper: 1.2, // how hard it tapers to a point at the tip
    flameRootPinch: 0.1, // fraction of its length the root is pinched over
    flameBank: 0.35, // 0 = camera-facing, 1 = standing off the skin
    flameGlowWidth: 2.8, // the heat around it, × the sheet width
    flameGlowFalloff: 2.4,
    flameGlowOpacity: 0.28,
    flameSharp: 1.3, // how hard the sheet falls off across itself
    flameTear: 0.9, // how far the tip breaks into separate licks
    flameTearScale: 3.0, // licks along one tongue
    flameTearCross: 0.9, // ... and across it
    flameTearSpeed: 1.2, // how fast they travel
    flameTearBias: 0.6, // where the tearing starts, up the tongue
    flameHeat: 1.55, // how hard the temperature ramp is driven
    flameCoreSize: 0.85, // <1 opens the white core out, >1 closes it down
    flameSmoke: 0.5, // how far what is going out goes to smoke
    flameFlicker: 0.2, // brightness gutter
    flameFlickerSpeed: 18,
    flameStrandFade: 0.5, // how much individual tongues dim
    flameSoftFade: 0.3, // metres of soft fade where a tongue meets geometry
    flameGlow: 2.5, // emissive gain
    flameOpacity: 1.0,
    colorFlameCore: '#fff3d0',
    colorFlameBody: '#ff8a20',
    colorFlameEmber: '#e0430a',
    colorFlameSmoke: '#160705',

    /* --- the orbs turning about the body --- */
    /**
     * By default each orb is bound to **one bone of the rig** and corkscrews
     * along it, dragging its wake around the limb — which is what keeps the
     * brightest thing in the buff on the character rather than a metre out in
     * the air beside them.
     *
     * The armillary the six `orbRadius`…`orbBob` sliders describe is still
     * here, underneath: each orb runs its own ring, the ring is leaned over by
     * `orbTilt` and turned about the body by the golden angle times the orb's
     * index, and `orbPrecess` drifts the whole thing. `orbCling` lerps between
     * the two, so winding it to 0 gives back the sphere of rings.
     */
    orbs: 8, // orbs alive at once (capped at 16)
    // At 1 the orbs abandon the ring entirely and ride the rig's own limbs —
    // a tight helix about one bone each, dragging their wakes around it. Wind
    // it down toward 0 to lerp back out to the armillary the six sliders below
    // describe; anywhere in between is a usable shape.
    orbCling: 1.0, // 0 = the ring, 1 = wound about a bone
    orbCloud: 0.075, // metres its helix stands off the limb's surface
    orbSpiral: 0.26, // slides/second it runs up and down the bone
    orbWhip: 2.8, // x orbRate — how fast it whips around the limb
    orbRadius: 1.09, // radius of a ring, metres
    orbRadiusVary: 0.16, // how differently one ring is sized from the next
    orbSeat: 0.55, // height of the centre, fraction of the body
    orbTilt: 0.95, // radians the rings lean over
    orbPrecess: 0.385, // turns/second the whole armillary drifts
    orbRate: 0.38, // turns/second one orb runs its ring
    orbRateVary: 0.25,
    orbBob: 0.12, // metres it rises and falls as it goes
    orbBobRate: 0.3,
    orbSize: 0.025, // radius of one orb, metres
    orbSizeVary: 0.04,
    orbStretch: 0.43, // how far it is drawn out along its own travel
    orbFalloff: 0.78, // how the ball fades toward its silhouette
    orbRim: 0.81, // hot ring at that silhouette
    orbRimPower: 2.4,
    orbCells: 0.78, // convection churning over the surface
    orbCellScale: 2.8, // cells per orb
    orbCellWarp: 0.6, // domain warp on them, so they are not a lattice
    orbBoil: 1.0, // how fast the surface boils upward
    orbHeat: 1.4, // how hard the temperature ramp is driven
    orbCoreSize: 0.8, // <1 opens the white core out, >1 closes it down
    orbCoronaSize: 2.8, // the light it sits inside, × the ball
    orbCoronaFalloff: 1.5,
    orbCoronaOpacity: 0.3,
    orbFlicker: 0.15,
    orbFlickerSpeed: 16,
    orbGlow: 2.8,
    orbOpacity: 1.0,
    orbEmberRate: 160, // embers/second dribbling off the orbs
    orbEmberSpeed: 1.6,
    colorOrbCore: '#fff7e0',
    colorOrbFlame: '#ff9524',
    colorOrbEmber: '#e6440a',
    colorOrbSmoke: '#180806',

    /* --- the fire each orb drags behind it --- */
    /**
     * Not a recorded trail: `trailSpan` seconds of the orb's *own* orbit,
     * sampled backward in time in the vertex shader. It is exact, it is full
     * length on the first frame, and it re-sweeps the instant any orbit control
     * above is moved — which is the whole reason it is built this way.
     */
    trailSpan: 0.95, // seconds of the orbit's past the wake covers
    trailRise: 0.12, // metres/second the wake lifts off the path
    trailWander: 0.035, // metres it frays as it ages
    trailWanderScale: 2.9,
    trailWanderSpeed: 0.7,
    trailWidth: 1.15, // half-width at the head, × the orb's own radius
    trailTaper: 0.9, // how hard it narrows toward the far end
    trailHeadSwell: 0.4, // extra width where it leaves the ball
    trailGlowWidth: 2.8, // the halo, × the wake
    trailGlowFalloff: 2.2,
    trailGlowOpacity: 0.3,
    trailSharp: 1.35, // how hard the wake falls off across itself
    trailTear: 0.75, // how far it breaks into separate puffs
    trailTearScale: 3.4,
    trailTearSpeed: 1.0,
    trailTearBias: 0.55,
    trailHeat: 1.5,
    trailCoreSize: 0.75,
    trailCool: 1.4, // how fast it cools with age — high keeps a white collar
    trailEndFade: 0.28, // fraction of the tail dissolved away
    trailFlicker: 0.12,
    trailFlickerSpeed: 14,
    trailSoftFade: 0.35, // metres of soft fade where a wake meets geometry
    trailGlow: 1.88,
    trailOpacity: 0.95,
    colorTrailCore: '#fff2cc',
    colorTrailFlame: '#ff7a14',
    colorTrailEmber: '#cc2c06',
    colorTrailSmoke: '#140705',

    /* --- the floor burnt out under the caster --- */
    /**
     * The char *subtracts* from the room and the cracks in it burn — one pass,
     * blended normally, alpha `max(char, light)`. Turn `fieldOpacity` to 0 and
     * the whole burn — char, cracks, embers and lip — costs one discarded quad.
     */
    fieldRadius: 1.5, // radius of the burn, metres
    fieldHeight: 0.065, // metres above the floor the quad is seated
    fieldFeather: 0.17, // metres the edge fades over
    fieldTear: 0.075, // how far out of round the boundary is dragged
    fieldChar: 0.57, // how black the stone goes, 0 = the floor is untouched
    fieldCharScale: 3.1, // grain over it, features per metre
    fieldCharContrast: 1.6,
    fieldCrackScale: 1.8, // splits per metre
    fieldCrackWidth: 0.15, // how wide a split is
    fieldCracks: 1.3, // how brightly they burn
    fieldWarp: 0.6, // domain warp on them, so they wander
    fieldCrawl: 0.22, // how fast the crust works
    fieldEmbers: 1.0, // single hot points glittering in the char
    fieldEmberScale: 5.5,
    fieldRing: 1.1, // the lip, still burning
    fieldRingWidth: 0.14, // metres
    fieldSweep: 0.4, // one bright arc turning around the lip
    fieldSweepSpeed: 0.15, // turns/second
    fieldFalloff: 1.3, // how the light dies back toward the lip
    fieldPulse: 0.18,
    fieldPulseSpeed: 0.55,
    fieldOpacity: 2,
    fieldGlow: 5.94,
    colorFieldChar: '#0a0503', // the burnt stone
    colorFieldCrack: '#ff5a10',
    colorFieldEmber: '#ffc46a',
    colorFieldRing: '#ff7a1e',

    /* --- embers & smoke shed while it holds --- */
    emberRate: 220, // particles/second off the body
    emberSize: 0.03,
    emberSpeed: 2.2,
    emberLifetime: 1.25,
    emberRise: 1.6, // upward drift, metres/second
    emberTurbulence: 0.9,
    emberGlow: 1.6,
    colorEmberA: '#fff0c0',
    colorEmberB: '#ffa32e',
    colorEmberC: '#e0430a',
    colorEmberD: '#3a0a02',
    smokeRate: 8, // puffs/second
    smokeSize: 0.28,
    smokeSpeed: 0.9,
    smokeLifetime: 2.6,
    smokeRise: 1.1,
    smokeTurbulence: 0,
    smokeGlow: 2.1, // held under 1: this is the shadow in the effect
    colorSmokeA: '#3a2118',
    colorSmokeB: '#241611',
    colorSmokeC: '#150d0a',
    colorSmokeD: '#080505',

    /* --- what the floor around the caster does --- */
    groundRate: 3.0, // scorches laid per second
    groundRadius: 0.9, // radius of one, metres
    groundSpread: 1.0, // how far off the feet they are scattered, metres
    groundLife: 2.6,
    groundIntensity: 0.9,
    colorGround: '#120806',
    colorGroundEmber: '#ff6a1e',

    /* --- dynamic light --- */
    lightIntensity: 13,
    lightRadius: 9.5,
    lightHeight: 1.0, // metres above the floor the light sits
    lightColor: '#ff8a3c',
    lightFlicker: 0.3, // depth of its gutter, 0 = steady
    lightFlickerSpeed: 9,

    /* --- the moment it catches, and the moment it goes out --- */
    burstEmbers: 260,
    burstSpread: 0.55, // radius embers are thrown from on the beats, metres
    ringRadius: 4.8, // shockwave ring across the floor, metres
    activateFlash: 0.18, // screen flash on ignition
    activateShake: 0.55,
    shakeDuration: 0.55,
    endFlash: 0.1, // ... and when it burns out
    endSmoke: 70, // puffs thrown as it goes
    rumble: 0.016, // continuous shake while it holds
    colorFlash: '#ffb066'
  },

  /* ------------------------------------------------------------------ */
  /* Camera rig                                                          */
  /* ------------------------------------------------------------------ */
  camera: {
    distance: 11.5,
    minDistance: 3.5,
    maxDistance: 30,
    zoomSpeed: 1.0,
    zoomDamping: 0.002,
    minPolar: 0.35,
    maxPolar: 1.32,
    fov: 46,
    targetHeight: 1.35,
    damping: 0.06,
    autoFrame: 0.35 // how strongly the rig drifts toward an active cast
  },

  /* ------------------------------------------------------------------ */
  /* Environment & lighting                                              */
  /* ------------------------------------------------------------------ */
  environment: {
    // A dark cinematic stage: one cool key, a colder rim from behind, and very
    // little fill, so the ice is the brightest thing on screen and the fog can
    // swallow the floor into the backdrop.
    sunIntensity: 2.6,
    sunColor: '#e8f3ff',
    sunAzimuth: 2.95,
    sunElevation: 0.6,
    ambientIntensity: 0.14,
    ambientColor: '#8ea8d8',
    hemiIntensity: 0.36,
    hemiSkyColor: '#bdd7ff',
    hemiGroundColor: '#3a4552',
    rimIntensity: 1.1,
    rimColor: '#9ec2ff',
    rimAzimuth: 5.45,
    rimElevation: 0.35,
    envIntensity: 0.32,
    backgroundColor: '#121820',
    // Fog is pulled well back so it only dissolves the far edge of the floor into
    // the backdrop rather than sitting on top of the action. Toggle and range are
    // both live in the editor (Environment → Backdrop, fog & dust).
    fogEnabled: true,
    fogColor: '#121820',
    fogNear: 26,
    fogFar: 135,
    shadowBias: -0.0008,
    shadowRadius: 2.2,
    floorColor: '#191f27',
    floorTint: '#232b35',
    floorRoughness: 0.88,
    floorSheen: 0.34,
    floorPool: 0.8,
    // The stone tiling that dresses the floor: ambientCG Rock030 (CC0), a rough
    // natural rock, living in public/textures/cathedral. `floorTextureScale` is metres of floor
    // one tile covers; `floorTexTint` grades the grey stone toward `floorTint` so
    // it sits inside the cool stage palette instead of fighting it.
    floorTexture: false,
    floorTextureScale: 12.0,
    floorNormalScale: 0.85,
    floorTexTint: 0.4,
    dustAmount: 0.85,
    contactShadow: 0.55
  },

  /* ------------------------------------------------------------------ */
  /* Post processing                                                     */
  /* ------------------------------------------------------------------ */
  post: {
    enabled: true,
    exposure: 1.05,
    // Threshold sits above the ice body's lit value on purpose: only the rim,
    // the glints and the impact should bloom, not the whole crystal field.
    // Strength is deliberately near zero — the crystal silhouette carries the
    // read, and bloom was the thing eating it. Push it up if you want the halo.
    bloomStrength: 0.03,
    bloomRadius: 0.6,
    bloomThreshold: 0.88,
    vignette: 0.52,
    chromaticAberration: 0.4,
    contrast: 1.12,
    saturation: 1.08,
    temperature: -0.03, // + warm / - cool
    lift: -0.008,
    gain: 1.0,
    grain: 0.045,
    // Master gain on the screen-space warp written by LAYER.DISTORTION — the
    // last link in the heat-haze chain. Screen widths, so it stays put when the
    // window resizes.
    distortion: 0.045,
    flashStrength: 1.0
  },

  /* ================================================================== */
  /* ELECTRICAL SPHERE — ability nine, far cast                          */
  /* ================================================================== */
  /**
   * A charged orb dropped at the aimed point: the caster whips a line of
   * current out across the floor, the platform blooms where it lands, and a
   * **dark, polished sphere** rises out of the middle — mirroring the room,
   * ringed in Fresnel light, electricity crawling flat across its skin and
   * arcs tearing off it into the air — until it collapses inward and blinks
   * out.
   *
   * Three GPU shaders do the whole thing: the **sphere body** (a near-black
   * reflective shell, the 2D discharge net on it, the Fresnel light around
   * it, and the pulse beat), the **ground platform** (a flat disc with rings,
   * hex grain, a hot inner band and outward pulse rings), and the **radial
   * corona** (an instanced ribbon of arcs leaving random points *on the
   * sphere's surface* out into the air, re-struck on their own clocks so the
   * corona is constantly forming and dying).
   *
   * There was a fourth — a larger additive shell around the body carrying a
   * corona of flame. It is gone: additive noise drawn over a mirror washes the
   * mirror out, and it read as a smoky bubble wrapped around the ball rather
   * than as energy coming off it. `fresnelGlow` below is what replaced it.
   *
   * The pulse is an organic envelope — two sine waves multiplied plus a
   * quantised spike — multiplied into the material's `uPulse` and into the
   * particle emitter rates, so the whole effect breathes in time. It is
   * *not* a scale animation; nothing on screen actually moves on a beat, the
   * brightness and the noise just lift.
   *
   * As in every other block, a cast captures nothing but a seed. Every metre,
   * colour stop, noise scale and rate is read off this block each frame —
   * including a zero-length one, which is why the editor reshapes a standing
   * sphere with the clock stopped.
   */
  electrical: {
    /* --- the cast --- */
    range: 18.0, // maximum cast distance, metres
    minRange: 0.0, // can drop on your own feet
    zoneRadius: 4.5, // the platform footprint, what the indicator measures out
    speed: 60.0, // how fast the front races to the point, metres/second
    snapTime: 0.35, // seconds the platform takes to bloom open
    lifetime: 3.6, // seconds the sphere stands
    collapseTime: 0.55, // seconds it takes to collapse inward
    fadeTime: 0.45, // seconds after the collapse until the meshes blink out
    cooldown: 2.0,
    castAnim: 'cast3',

    /* --- where the front leaves the caster --- */
    handHeight: 1.28, // metres above the floor
    handForward: 0.55, // metres in front of the caster
    handSide: 0.16, // metres to the side

    /* --- the sphere itself --- */
    sphereRadius: 1.4, // radius once it is up to power, metres
    hoverHeight: 2.0, // high enough that the arcs clear the floor
    hoverAmplitude: 0.06, // tiny floating motion
    hoverSpeed: 0.5, // oscillations per second
    opacity: 1.0, // the ball is a solid object, not a volume
    distortion: 0.12, // how hard the skin bends the reflection
    glow: 1.2, // overall emissive gain

    /* --- the reflective shell --- */
    // The ball is a *dark mirror*. Its albedo is near black on purpose: every
    // bright thing on it is the room reflected in it, the discharge burnt onto
    // it, or the Fresnel wrapped around it. `reflectivity` is what it returns
    // head-on and `fresnelPower` decides how fast that climbs to a full mirror
    // at the silhouette; `envRoughness` blurs the reflection and `distortion`
    // above ripples it.
    envIntensity: 0.0, // how bright the room reads in the ball
    envRoughness: 0.08, // blur on the reflection, 0 = a perfect mirror
    reflectivity: 0.55, // reflection strength facing the camera
    fresnelPower: 2.6, // how fast reflection climbs toward the limb
    specular: 3.4, // the hard key glint
    specSharp: 220, // how tight that glint is
    shellDiffuse: 0.3, // how much plain lighting the black skin takes
    shellRipple: 3.0, // scale of the skin ripple bending the reflection
    colorShell: '#0d0b0c', // the lit side of the black skin
    colorDeep: '#030203', // the unlit side of it

    /* --- the faint charge under the skin --- */
    // Deliberately weak. Turned up, this is the layer that stops the ball
    // reading as a solid object and turns it back into a lantern.
    plasmaScale: 2.4, // features over the sphere
    plasmaSpeed: 0.45, // how fast the noise scrolls
    plasmaIntensity: 0.5, // strength of the glow bleeding through the skin
    plasmaCore: 2.2, // how concentrated it is
    plasmaWarp: 0.5, // domain warp — folds it into turbulent sheets
    colorCore: '#fff7d6', // tint on the key glint
    colorInner: '#ffd166', // yellow lift where the discharge runs to the limb
    colorMid: '#ff7a20', // the charge under the skin
    colorOuter: '#ff3a0a', // the wide Fresnel halo
    colorEdge: '#ff1503', // the tight Fresnel rim

    /* --- the hex panelling (off by default: the sci-fi read) --- */
    hexScale: 6.0, // panels per sphere radius
    hexWidth: 0.18, // edge thickness
    hexIntensity: 0.0, // how much the panels lift
    hexPulse: 0.0, // extra brightness on a pulse beat
    colorHex: '#ffa040',
    // What the whole ball is pushed toward on a pulse beat. The body shader
    // has always read this; the block never actually defined it.
    colorPulse: '#fff8e6',

    /* --- the discharge crawling over the skin (the flat, 2D electricity) --- */
    // A ridged-noise filament net, not a thresholded fbm: ridged noise has
    // sharp *spines*, and slicing a narrow band off the top of it gives forked
    // hairlines rather than the soft blobs that used to read as lava. Both
    // widths are fractions of the normalised field, so `surfaceArcWidth` is
    // literally how much of the ball a filament covers.
    surfaceArcScale: 3.2, // filaments per sphere radius
    surfaceArcSpeed: 0.6, // how fast the net evolves
    surfaceArcCrawl: 0.5, // how fast it slides across the skin
    surfaceArcWidth: 0.07, // white-hot filament thickness
    surfaceArcGlowWidth: 0.16, // extra width of the coloured bleed around it
    surfaceArcIntensity: 1.6, // overall discharge brightness
    surfaceArcFlicker: 0.35, // depth of the per-patch stutter
    surfaceArcRestrike: 5.0, // re-strikes per second — the net re-rolls on a beat
    surfaceArcWarp: 0.0, // domain warp — how hard the filaments buckle and fork
    surfaceArcCharge: 0.7, // 0 = the whole ball conducts, 1 = only live patches do
    colorSurfaceArcCore: '#fffbf0',
    colorSurfaceArcGlow: '#ff8614',

    /* --- the Fresnel light --- */
    // With the corona shell gone this is the whole silhouette read, so it does
    // real work. Two terms: `fresnelGlow` is the wide halo that stands in for
    // the atmosphere around the ball, `rim*` is the hard edge on the outline.
    rimPower: 2.5, // how tight the rim is
    rimIntensity: 3.56, // how bright
    rimWidth: 0.86, // how wide the band is
    fresnelGlowPower: 5.25, // falloff of the wide halo — higher hugs the limb
    fresnelGlow: 4.36, // brightness of the wide halo

    /* --- the ground platform --- */
    platformRadius: 4.5, // metres from centre to edge
    platformRings: 8, // concentric rings (capped at 16)
    platformRingWidth: 0.08, // half-width of one ring
    platformRingGlow: 0.5, // brightness of the rings
    platformInnerGlow: 0.55, // brightness of the hot band under the sphere
    platformInnerPad: 0.4, // how far past the sphere the inner band reaches
    platformHexScale: 4.0, // hex grain scale
    platformHexIntensity: 0.3, // hex grain strength
    platformOpacity: 0.85,
    platformGlow: 0.9,
    colorPlatformRing: '#ff8c25',
    colorPlatformInner: '#ff661a',
    colorPlatformHex: '#ff8024',
    colorPlatformDeep: '#150503',

    /* --- the radial corona arcs --- */
    arcCount: 35, // strands in the corona (capped at 80)
    arcLength: 2.7, // metres the average arc reaches
    arcVariance: 0.7, // 0 = uniform, 1 = some are short, some dramatic
    arcJitter: 0.35, // lateral wander of the far end
    arcEscape: 1.01, // origin offset from sphere surface, × sphere radius
    arcCurl: 0.45, // in-flight bend
    arcReach: 1.0,
    arcUpBias: 0.05, // how much the arcs lean upward
    arcBranchFraction: 0.45, // fraction demoted to short secondary arcs
    arcBow: 0.25, // mid-span bow

    /* --- the shape of a single arc --- */
    arcJitterAmp: 0.16, // kink amplitude, metres
    arcJitterFreq: 2.2, // kinks per metre
    arcOctaves: 4,
    arcJitterFalloff: 0.56,
    arcCrawl: -3.7, // how fast the kinks slide
    arcPinch: 0.285, // fraction of the span the ends are pulled straight over
    arcConverge: 0.5,

    /* --- the ribbon --- */
    arcWidth: 0.03, // half-width where the arc leaves the sphere, metres
    arcWidthTip: 0.3, // that width at the far tip, as a fraction of the base
    arcCoreWidth: 1.5, // spine multiplier
    arcCoreSharp: 3.0, // how hard the hot core falls off across the ribbon
    arcGlowFalloff: 2.0, // halo falloff
    arcHaloWidth: 3.0, // halo multiplier on the core
    arcHaloOpacity: 0.6, // halo pass opacity
    arcOpacity: 1.0,
    arcGlow: 2.0, // emissive gain
    arcSoftFade: 0.4, // soft intersection with geometry
    arcFlicker: 0.45, // depth of the bolt's stutter
    arcFlickerSpeed: 32, // stutters/second
    arcStrandFlash: 0.5, // how much individual strands blink
    arcRate: 16, // cycles per second
    arcLife: 0.62, // fraction of the cycle each arc is lit
    colorArcCore: '#fff4d6',
    colorArcInner: '#ffb24a',
    colorArcOuter: '#ff6a18',
    colorArcHalo: '#ff3a0c',

    /* --- the pulse --- */
    pulseFrequency: 8.0, // pulses per second
    pulseStrength: 0.51, // peak envelope of each beat
    pulseParticleBoost: 3.15, // how much harder particles fire on a beat

    /* --- sparks, motes, embers and smoke --- */
    sparkRate: 240, // sparks shed off the front, particles/second
    sparkSize: 0.16,
    sparkSpeed: 9.0,
    sparkLifetime: 0.5,
    sparkGravity: -8.0,
    sparkStretch: 0.18,
    sparkGlow: 2.0,
    colorSparkA: '#fff4d6',
    colorSparkB: '#ffd07a',
    colorSparkC: '#ff6a14',
    colorSparkD: '#7a1d04',
    moteRate: 120,
    moteSize: 0.06,
    moteSpeed: 1.8,
    moteLifetime: 1.5,
    moteRise: 0.8,
    moteTurbulence: 0.7,
    colorMoteA: '#ffd07a',
    colorMoteB: '#ff8a30',
    colorMoteC: '#ff3a0a',
    colorMoteD: '#1c0500',
    emberRate: 90,
    emberSize: 0.05,
    emberSpeed: 1.5,
    emberLifetime: 1.2,
    emberRise: 1.2,
    emberTurbulence: 0.4,
    emberGlow: 1.4,
    emberStretch: 0.16,
    colorEmberA: '#ffe8a0',
    colorEmberB: '#ff7a1a',
    colorEmberC: '#ff2a08',
    colorEmberD: '#220a02',
    smokeRate: 35,
    smokeSize: 1.1,
    smokeSpeed: 1.2,
    smokeLifetime: 2.4,
    smokeOpacity: 0.06,
    smokeRise: 0.5,
    colorSmokeA: '#3a2a1c',
    colorSmokeB: '#2a1c14',
    colorSmokeC: '#1a0e0a',
    colorSmokeD: '#0a0604',

    /* --- sparks, motes and embers shed by the standing sphere --- */
    fieldSparkRate: 380, // particles/second off the surface
    fieldSparkSpeed: 6.0,
    fieldSparkLifetime: 0.5,
    fieldMoteRate: 180,
    fieldMoteSpeed: 2.0,
    fieldMoteLifetime: 1.4,
    fieldEmberRate: 140,
    fieldEmberSpeed: 2.5,
    fieldEmberLifetime: 1.3,
    fieldSmokeRate: 30,
    fieldSmokeSpeed: 1.0,
    fieldSmokeLifetime: 2.0,

    /* --- the front burns on the floor --- */
    platformScorchRate: 1.4, // burns per metre of front travel
    platformScorchRadius: 0.7,
    platformScorchLife: 4.5,
    platformScorchIntensity: 0.3,
    platformInnerScorchRadius: 3.0,
    platformInnerScorchLife: 7.0,
    platformInnerScorchIntensity: 0.3,
    colorScorch: '#0a0302',
    colorEmber: '#ff3a0a',

    /* --- the impact --- */
    burstSparks: 200,
    burstEmbers: 80,
    shockRadius: 6.5,
    colorShockA: '#ff8a30',
    colorShockB: '#fff7d6',
    scorchRadius: 3.6,
    scorchLife: 6.0,
    scorchIntensity: 0.35,
    muzzleSize: 0.6,
    muzzleIntensity: 1.8,
    colorMuzzleA: '#ff4a0a',
    colorMuzzleB: '#ffb04a',
    colorMuzzleC: '#fff4d6',
    castFlash: 0.1,
    colorCastFlash: '#ffd07a',
    impactShake: 0.8,
    impactFlash: 0.22,
    shakeDuration: 0.6,
    colorFlash: '#ffd07a',

    /* --- dynamic light --- */
    lightIntensity: 18,
    lightRadius: 14,
    // No lightHeight: the light sits in the sphere, so `hoverHeight` above is
    // already the answer to where it goes.
    lightColor: '#ff7a30',
    lightFlicker: 0.35, // depth of the light's gutter
    lightFlickerSpeed: 28,
    holdShake: 0.05, // continuous shake while the sphere is standing
    rumble: 0.025 // continuous shake while the front travels
  },

  /* ================================================================== */
  /* EARTHEN SPIRE — the first line cast: stone laid, then stone torn    */
  /* ================================================================== */
  /**
   * Three beats, in order:
   *   1. a crust of stone plates is laid down along the aimed line, surfacing
   *      flush with the floor as the front passes over them;
   *   2. a fracture wave trails the head and breaks that crust — plates
   *      heave, tip over, drop into the seams and slide apart, with
   *      boulders punched up through the cracks;
   *   3. the cast ends with a stone tower climbing out of the floor where
   *      the arrow was pointing, shouldering a ring of boulders up around
   *      its base.
   *
   * All three are real geometry (instanced plates, instanced rocks, one
   * tower mesh) so they take the scene's shadows, and everything is
   * pooled — a cast allocates nothing. The arrow indicator is the existing
   * ground arrow the sandbox already uses for line casts.
   */
  earth: {
    /* --- the cast --- */
    range: 18.0, // maximum cast distance, metres
    minRange: 0.0, // dropping it on your own feet is a legitimate play
    speed: 26.0, // how fast the crust wave races to the point, metres/second
    crackDelay: 0.35, // seconds the fracture wave trails the head by
    crackSharpness: 0.16, // how hard a plate snaps when it lets go
    crustDensity: 1.6, // multiplier on plate spacing
    crustWidth: 1.2, // width of the paved band, metres
    paintTime: 0.18, // seconds a plate takes to surface after the head
    plateSize: 0.7, // base radius of one plate, metres
    plateThickness: 0.16, // height of one plate, metres
    plateTilt: 0.33, // how hard a plate can lever up, radians
    plateLift: 0.0, // metres a plate can be thrown on fracture
    plateSpread: 0.0, // how far a plate slides apart, metres
    crackDepth: 0.33, // how far a down-falling plate can drop, × plateLift
    towerRiseTime: 0.76, // seconds the tower takes to climb out of the floor
    towerHold: 1.3, // seconds the tower stands at full height
    towerWidth: 1.35, // base half-width of the tower, metres
    towerHeight: 5.8, // full height, metres
    towerRockRadius: 1.8, // radius of the boulder ring around the tower, metres
    towerRocks: 18, // boulders in that ring (capped at MAX_ROCKS - 8)
    lifetime: 3.65, // seconds the travelling crust and the loose rocks stand
    sinkDelay: 0.22, // extra seconds a crack-side rock lingers before sinking
    cooldown: 1.4,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the wave leaves the caster --- */
    handHeight: 0.25, // metres above the floor (low — earth is grounded)
    handForward: 0.7, // metres in front of the caster
    handSide: 0.18, // metres to the side (+ follows `Ability#side`)

    /* --- boulders heaved up through the crust --- */
    rockCount: 14, // rough count of travelling rocks (capped at MAX_ROCKS)
    rockSpacing: 3.3, // metres between them at full density
    rockSize: 0.43, // base size of a travelling boulder, metres
    rockRandomness: 0.0, // multiplier on per-rock jitters
    tumble: 5.9, // radians/second a boulder spins about its own up axis
    riseHeight: 1.0, // how high a boulder heaves out of the floor, metres
    riseSpeed: 4.6, // how fast it arrives, boulder's own × height
    groundDisplacement: 0.2, // how much `riseHeight` is multiplied for the tower ring

    /* --- what the rock looks like --- */
    colorRock: '#7c5634', // the warm body of every stone
    colorRockDark: '#3a2618', // the shadows and the moss under it
    colorMoss: '#5a6b3a', // moss on the upward faces
    glow: 0.76, // master emissive on the hot crack seams

    /* --- the tower's glass body --- */
    /**
     * PBR glass for the tower shaft. `transmission` is the dominant control
     * (0 = opaque stone, 1 = clear glass); `roughness` controls the blur of
     * what's seen through it; `thickness` and `ior` drive the refraction; and
     * `attenuationColor`/`attenuationDistance` tint the light as it travels
     * through the body, so a deep yellow reads as a warm crystal.
     * `emissive` is a small constant glow that keeps the surface from going
     * black on the back side, and `opacity` is the standard transparency
     * multiplier that sits on top of `transmission` for the alpha sort.
     */
    glassColor: '#ffe9a8', // base tint of the glass
    glassTransmission: 0.95, // 0 = opaque, 1 = fully transmissive
    glassRoughness: 0.08, // how much the refraction blurs
    glassIor: 1.5, // index of refraction
    glassThickness: 0.45, // metres — refraction depth through the body
    glassAttenuationColor: '#ffd54a', // tint applied to refracted light
    glassAttenuationDistance: 0.4, // metres — how quickly the tint saturates
    glassOpacity: 0.55, // 0 = invisible, 1 = solid (sits on top of transmission)
    glassEmissive: '#2a1a05', // small constant glow so the back side reads
    glassEmissiveStrength: 0.4, // multiplier on `glassEmissive`

    /* --- the tower's outline glow --- */
    /**
     * A second copy of the tower geometry is rendered as an inverted-hull
     * shell: the vertex shader pushes every vertex along its world-space
     * normal by `outlineThickness` metres, the mesh is drawn with
     * `side: BackSide` and additive blending, and depth writes are off so
     * the shell never occludes the glass body. The result is a clean,
     * smooth glow that hugs the silhouette without showing the polygonal
     * facets a wireframe would expose.
     *
     * The pulse envelope is the same shape as before: a peak on impact
     * that decays exponentially into a standing hum, with a depth-modulated
     * sine riding on top so the outline *flashes* rather than just glows.
     */
    outlineColor: '#ffd54a', // the rim colour
    outlineThickness: 0.06, // metres — how far the shell sits off the body
    outlineStrength: 1.6, // master gain on the rim
    outlinePulseSpeed: 2.4, // sine rate on top of the impact envelope, Hz
    outlinePulseDepth: 0.6, // 0 = steady glow, 1 = full off-and-on flash
    outlinePulseOnImpact: 2.4, // peak brightness the moment the tower appears
    outlinePulseSettle: 0.6, // baseline once the tower is standing
    outlinePulseRampDown: 1.5, // exponential decay rate of the on-impact boost, /s

    /* --- dust and debris --- */
    dustAmount: 1.0, // master strength of the dust trail
    dustSize: 0.85,
    dustLifetime: 2.2,
    debrisSize: 0.1,
    debrisVelocity: 5.7, // metres/second debris leaves a fracture
    debrisLifetime: 1.6,
    pebbleRate: 22, // pebbles/second shed at the head
    shakeIntensity: 1.0,

    /* --- the impact --- */
    explosionFlash: 0.59, // screen flash when the tower lands
    impactShake: 0.65,
    shakeDuration: 0.9,
    castFlash: 0.06, // screen flash on release
    colorCastFlash: '#cba37a',
    colorFlash: '#e9a56c',

    /* --- dynamic light --- */
    lightIntensity: 9, // the warm light that follows the front
    lightRadius: 12,
    lightColor: '#ff9a3c',

    /* --- ground kept clear in front of the caster --- */
    startOffset: 1.8 // metres skipped before the crust begins
  },

  /* ------------------------------------------------------------------ */
  /* The gate — a built structure that stays                             */
  /* ------------------------------------------------------------------ */
  /**
   * VERDANT GATE — the first cast that *builds* something and leaves it there.
   *
   * Three beats: a seam races to the site, an arch of stone is constructed
   * around the opening one voussoir at a time, and the portal ignites inside
   * it and stays lit until another gate is raised.
   *
   * The stones hold no metres of their own. Each one stores where it sits along
   * the **contour** (a signed 0..1: which jamb, and how far up toward the
   * keystone), which course it is in, and its dice — every position, size and
   * angle is resolved against `gateWidth` / `gateHeight` / `stone*` below on
   * each frame. Widen the opening on a gate that is already standing and the
   * whole arch re-lays itself around the new span, keystone included, while the
   * clock is paused.
   *
   * The portal surface is one quad with the arch's exact SDF in its fragment
   * shader, so it costs one draw call whatever the opening is doing, and the
   * halo around it is the same quad drawn a second time additively.
   */
  portal: {
    /* --- the cast --- */
    range: 17.0, // maximum cast distance, metres
    minRange: 3.0, // a gate you build on your own feet is a gate in your face
    speed: 34.0, // how fast the seam races to the site, metres/second
    cooldown: 2.6,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the seam leaves the caster --- */
    handHeight: 0.9, // metres above the floor
    handForward: 0.75, // metres in front of the caster
    handSide: 0.2, // metres to the side (+ follows `Ability#side`)
    castFlash: 0.12, // screen flash on release
    colorCastFlash: '#9bff5a',

    /* --- the opening (metres) --- */
    gateWidth: 3.6, // clear span between the jambs
    gateHeight: 2.5, // height of the springing line — the arch starts here
    gateDepth: 0.85, // how thick the wall of stone is, front to back

    /* --- the stones --- */
    stoneSize: 0.66, // base diameter of one stone, metres
    stoneStep: 0.58, // spacing between stones along the contour, metres
    stoneCourses: 2, // how many courses are stacked outward from the opening
    stoneCourseStep: 0.52, // metres between those courses
    stoneRandomness: 1.0, // multiplier on every per-stone jitter
    stoneTilt: 0.22, // radians a stone can be knocked off its slot angle

    /* --- the construction --- */
    buildTime: 1.25, // seconds from the first stone to the keystone
    stoneFly: 0.5, // seconds one stone takes to reach its slot
    stoneStart: 1.4, // metres below the floor a stone starts from
    stoneArc: 0.9, // how far outward it bows on the way up, metres
    stoneSpin: 3.2, // radians/second it tumbles while it flies
    landShake: 0.09, // shake each stone lands with
    keystoneShake: 0.5, // extra shake when the keystone seats

    /* --- the portal --- */
    openDelay: 0.1, // seconds after the keystone before the surface lights
    openTime: 0.85, // seconds the aperture takes to flood the opening
    closeTime: 1.3, // seconds the whole gate takes to come apart
    spin: 0.22, // turns/second the wisps rotate about the focus
    twist: 1.1, // how much harder the middle turns than the edge — the shear
    focus: 0.62, // height of the vortex focus, × the springing line
    turbulence: 1.0, // how hard the wisps read against the fog
    noiseScale: 1.1, // features per metre across the surface
    flow: 0.18, // how fast they boil as they turn
    core: 0.3, // a faint glow left hanging at the focus
    coreSize: 0.5, // radius of it, as a fraction of the half-span
    column: 0.15, // the column of light standing up the middle of the doorway
    rim: 0.9, // brightness of the glow that hugs the arch
    rimWidth: 0.95, // how far into the opening it reaches, metres
    rimFalloff: 2.2, // how fast it gives way to the fog in the middle
    rimHot: 1.2, // the white lip right against the stone
    updraft: 0.6, // light streaming up the inside of the jambs
    clear: 0.85, // how far the middle opens up — 0 is a solid wall of light
    clearSize: 0.6, // radius of that clearing, as a fraction of the half-span
    clearFalloff: 0.2, // how sharply it closes back into the solid surface
    halo: 0.0, // glow spilling out past the contour onto the stones
    haloWidth: 0.7, // how far it reaches, metres
    // How far the surface reaches *under* the stones. Its own edge is the one
    // thing that gives the opening away as a quad, so it is tucked behind the
    // blocks and the edge you see is the stone's.
    overlap: 0.34,
    surfaceOpacity: 1.0, // how solid the surface reads (1 = nothing shows through)

    /* --- colour --- */
    colorCore: '#f4ffd6', // the white lip where the surface meets the stone
    colorMid: '#86e02a', // the wisps — the colour of the gate itself
    colorDeep: '#3b5138', // the fog between them: desaturated, and the middle
    colorRim: '#c9f757', // the glow hugging the arch, and the halo
    colorRock: '#6f5b41', // the stones of the arch
    colorRockDark: '#2f271c',
    colorMoss: '#4d6b30',

    /* --- motes, mist and construction dust --- */
    moteRate: 34, // glowing motes/second while the gate stands
    moteSize: 0.11,
    moteLife: 2.6,
    moteRise: 1.5, // metres/second they drift upward
    mistRate: 16, // slow haze bleeding out of the opening
    mistSize: 0.9,
    mistLife: 2.4,
    dustAmount: 1.0, // dust thrown by the construction
    dustSize: 0.8,
    dustLifetime: 1.8,
    debrisSize: 0.11,
    debrisVelocity: 4.6,
    debrisLifetime: 1.4,

    /* --- dynamic light --- */
    lightIntensity: 11, // the green light the gate throws on the floor
    lightRadius: 15,
    lightColor: '#7bff33',
    lightHeight: 1.5, // metres above the floor the light hangs
    lightFlicker: 0.12, // depth of the surface's own unrest in that light

    /* --- the impact --- */
    explosionFlash: 0.34, // screen flash when the portal lights
    shakeIntensity: 1.0
  },

  /* ================================================================== */
  /* TIDEWROUGHT RING — the second standing cast, and the first machine  */
  /* ================================================================== */
  /**
   * The gate's answer to the same question, given by an engineer instead of a
   * mason — which makes the pair the sandbox's clearest statement about
   * *animation* the way `pyre` and `glacier` are its statement about material.
   * Both build something and leave it standing. Everything that tells them
   * apart is when and where the pieces move:
   *
   *   - masonry is stacked where it stands, so the gate's stones come **up out
   *     of the floor** into slots directly above them. A machine is laid out
   *     flat and then raised, so these segments swing in out of a wide orbit
   *     **in the ground plane** (`swarmRadius`, `swarmTurns`) and the finished
   *     hoop **hinges upright** afterwards (`riseTime`, and note it is one
   *     control, because the tip-up is one motion);
   *   - the ring turns while it closes and keeps turning after (`spinTurns`,
   *     `idleSpin`) — nothing about an arch rotates;
   *   - the light in the gate hugs the frame and fogs the middle; a rift is a
   *     hole, so the light lives at the rim and `eye` takes the middle away;
   *   - and it ends by being thrown off the spindle (`scatterOut`) rather than
   *     falling down.
   *
   * The segments store no metres. Each holds where it sits along the contour as
   * a signed 0..1 — which arc, and how far round toward the crown — plus its
   * course and its dice; every angle, radius and second below is resolved
   * against this block each frame, from three ages. Drag `clear radius` on a
   * ring that has been standing for a minute and it re-forges itself around the
   * new circle; drag `stand up over` while it is halfway up and it re-poses on
   * the spot, with the clock paused.
   */
  aether: {
    /* --- the cast --- */
    range: 18.0, // maximum cast distance, metres
    minRange: 3.5, // a ring you raise on your own feet is a ring in your face
    speed: 40.0, // how fast the tide races to the site, metres/second
    cooldown: 2.8,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the tide leaves the caster --- */
    handHeight: 1.0, // metres above the floor
    handForward: 0.8, // metres in front of the caster
    handSide: 0.15, // metres to the side (+ follows `Ability#side`)
    castFlash: 0.14, // screen flash on release
    colorCastFlash: '#7ff0ff',

    /* --- the ring (metres) --- */
    ringRadius: 2.15, // the clear radius the horizon hangs in
    ringDepth: 0.2, // how thick the hoop is, front to back
    ringHover: 0.28, // how far the foot of the ring clears the floor
    layHeight: 0.06, // how high it lies while it is being forged
    lobes: 6, // shallow lobes around the rim — see `settings.ring`
    lobeDepth: 0.035,

    /* --- the segments --- */
    segmentSize: 0.5, // base diameter of one segment, metres
    segmentStep: 0.42, // spacing between them along the contour, metres
    courses: 1, // how many courses are stacked outward from the opening
    courseStep: 0.42, // metres between those courses
    spurs: 0, // loose blocks braced under the foot — off: the ring floats clean
    segmentRandomness: 1.0, // multiplier on every per-segment jitter
    segmentTilt: 0.13, // radians a segment can be knocked off its slot angle

    /* --- the forging --- */
    assembleTime: 1.15, // seconds from the first segment to the crown
    segmentFly: 0.55, // seconds one segment takes to swing into its slot
    swarmRadius: 3.4, // how far out it comes from, × its own slot radius
    swarmTurns: 0.42, // turns it swings through on the way in
    swarmDepth: 1.1, // how far out of the ring's plane it starts, metres
    segmentSpin: 5.0, // radians/second it tumbles while it flies
    spinTurns: 0.85, // turns the whole ring makes while it closes
    idleSpin: 0.015, // turns/second it keeps making afterwards
    lockShake: 0.05, // shake each segment locks with
    crownShake: 0.45, // extra shake when the crown seats

    /* --- standing up --- */
    riseDelay: 0.15, // seconds after the crown before the hoop lifts
    riseTime: 0.95, // seconds the tip-up takes, overshoot and settle included

    /* --- the rift --- */
    openDelay: 0.14, // seconds after it is upright before the horizon lights
    openTime: 0.55, // seconds the pool takes to fill — short, it is a surge
    closeTime: 1.4, // seconds the whole ring takes to come apart
    churn: 0.22, // how hard the filling edge boils
    spin: 0.09, // turns/second the pool shears about the eye
    twist: 1.3, // how much harder the middle turns than the rim
    turbulence: 1.6, // how hard the water reads against the deep
    noiseScale: 1.25, // features per metre across the surface
    flow: 0.61, // how fast they boil as they turn
    ripples: 3.5, // rings across the radius
    rippleSpeed: 0.5, // how fast they run *inward*
    rippleDepth: 0.45, // how much they modulate the water
    rim: 1.0, // brightness of the light hugging the segments
    rimWidth: 0.85, // how far into the pool it reaches, metres
    rimFalloff: 2.0, // how fast it gives way toward the eye
    rimHot: 1.1, // the white lip right against the stone
    eye: 0.95, // the dark at the middle — the way through
    eyeSize: 0.46, // its radius, as a fraction of the clear radius
    eyeClear: 0.55, // how much of the scene behind shows through it
    sparkle: 0.9, // motes hanging in the pool
    sparkleScale: 3.1, // how many, per metre
    halo: 2.17, // glow spilling out past the contour onto the segments
    haloWidth: 0.31, // how far it reaches, metres
    runes: 1.18, // the band of marks that lights as the ring locks
    runeCount: 14, // marks per half of the contour
    runeRadius: 0, // how far outside the contour the band sits, metres
    runeWidth: 0.01, // half-thickness of the band, metres
    runeGap: 0.21, // duty cycle of one mark, 0..1
    runeGlow: 0.14, // the same marks, burned into the stone itself
    // How far the pool reaches *under* the segments. Tuned to zero: the gate
    // needs its surface tucked behind the stones because the arch leaves gaps
    // for a bright arc to show through, and a closed hoop does not — the pool
    // stops on the contour and the churn at its edge is what hides the seam.
    overlap: 0,
    surfaceOpacity: 1.0, // how solid the pool reads (1 = nothing shows through)

    /* --- coming apart --- */
    scatterOut: 2.6, // metres the segments are flung outward
    scatterSpin: 1.2, // and tangentially, off the spindle

    /* --- colour --- */
    colorCore: '#e6ffff', // the white lip where the pool meets the stone
    colorMid: '#31d9ff', // the water — the colour of the rift itself
    colorDeep: '#03142c', // the deep between the ripples, and the eye
    colorRim: '#8ef4ff', // the light hugging the ring, the halo and the runes
    colorMetal: '#3d5468', // the segments
    colorMetalDark: '#101a26',

    /* --- motes, spray and mist --- */
    moteRate: 40, // motes/second drawn into the eye while the rift stands
    moteSize: 0.09,
    moteLife: 1.5,
    moteDraw: 2.4, // metres/second they are pulled inward at
    moteCurl: 0.55, // how much they lean into the turn on the way
    sprayRate: 26, // sparks/second breathed back out of the pool
    spraySize: 0.14,
    sprayLife: 1.1,
    sprayRise: 2.6, // metres/second they leave the surface at
    surgeSpeed: 11.0, // and how hard the surge throws them when it opens
    mistRate: 14, // cold falling out of the underside of the ring
    mistSize: 1.0,
    mistLife: 2.2,
    debrisSize: 0.09,
    debrisVelocity: 4.2,
    debrisLifetime: 1.3,

    /* --- dynamic light --- */
    lightIntensity: 13, // the cyan light the rift throws on the floor
    lightRadius: 16,
    lightColor: '#3fd8ff',
    lightFlicker: 0.14, // depth of the pool's own swell in that light

    /* --- the impact --- */
    explosionFlash: 0.38, // screen flash when the horizon lights
    shakeIntensity: 1.0
  },

  /* ================================================================== */
  /* FIRE PORTAL — a black disc with a ring of fire throwing lines off it */
  /* ================================================================== */
  /**
   * Deliberately the smallest ability block in the file.
   *
   * The gate needs fourteen controls to say how its stones are stacked and the
   * ring needs ten to say how its segments swing in. This one has no pieces,
   * no assembly and no dressing: it is a **black disc** with a **ring emitter**
   * standing in front of it, and everything you can see other than those two is
   * one particle system.
   *
   * Which means the colour design is `The sparks`, and only that. The four
   * stops are a lifetime gradient — white where a spark is born, orange through
   * the middle of its life, red as it goes out, and gone — and nothing else in
   * the ability tints anything. `spark speed` and `drag` between them are the
   * shape of the fan: the sparks leave on a straight tangent and the drag is
   * what bends them into the long curved lines, so a low drag gives a starburst
   * and a high one gives a tight scroll. Nothing in the ability draws a curve.
   *
   * `licks back over the hole` is the one slider that can ruin it. Push it past
   * a couple of centimetres and the ring's bloom crosses the contour, the middle
   * lights, and the hole is gone — and the hole is the ability.
   */
  firePortal: {
    /* --- the cast --- */
    range: 18.0, // maximum cast distance, metres
    minRange: 3.0, // a portal cut on your own feet is a portal in your face
    speed: 48.0, // how fast the cast races to the site, metres/second
    cooldown: 3.0,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the circle (metres) --- */
    ringRadius: 2.15, // the clear radius of the way through
    ringHover: 0.55, // how far the foot of it clears the floor
    lean: 0.0, // radians the top tips away from the caster

    /* --- opening: the circle is struck, not switched on --- */
    // A spark leaves the foot of the circle and runs all the way round it,
    // laying the ring down behind it and throwing its shower as it goes. Only
    // once it is nearly home does the way through start to open inside what it
    // drew. `scribeTime` is the beat the whole opening is cut to.
    scribeTime: 0.62, // seconds the spark takes to run round
    scribeFeather: 0.16, // metres of contour the line takes to come up behind it
    scribeHead: 3.6, // brightness of the spark itself
    scribeHeadSize: 0.19, // metres — how big a blob that spark is
    scribeTrail: 2.4, // metres behind it that are still white-hot
    scribeTrailHeat: 1.8, // how much hotter than the settled ring that is
    scribeRate: 6500, // sparks/second thrown off the running head
    scribeTail: 0.55, // metres of contour behind it they are born on
    scribeSpeed: 7.4, // metres/second they leave it at
    scribeOut: 0.85, // how much of that throw is straight out of the circle
    scribeSpread: 0.4, // cone spread at the head — wider than the settled fan
    // The head peaks at better than 40 m/s — twice the average, because the
    // sweep is eased at both ends — so this is a small number by design.
    scribeInherit: 0.15, // how much of the head's own travel they carry away
    openTime: 0.22, // seconds the stroke takes to reach its settled brightness
    apertureDelay: 0.76, // fraction of the draw before the hole starts to open
    apertureTime: 0.5, // seconds the hole takes to iris open

    /* --- going out --- */
    closeTime: 1.0, // seconds the whole thing takes to go out

    /* --- the ring --- */
    ring: 1.42, // brightness of the bloom around the line
    ringWidth: 0.33, // how far that bloom reaches outward, metres
    ringInner: 0.06, // and inward, metres — keep this small
    ringHot: 1.24, // the white core of the line itself
    colorRing: '#ff8c1e', // the bloom
    surfaceOpacity: 1.0, // how solid the way through reads

    /* --- the middle --- */
    voidDark: 0.26, // how black it is — 0 leaves a ring with nothing in it
    voidWarm: 1.27, // warm bounce on the inside of the lip
    voidFeather: 0.02, // metres the black feathers out into the ring
    colorVoid: '#150400', // the middle. Very nearly black, and meant to be

    /* --- the sparks: the whole of the rest of it --- */
    sparkRate: 3200, // sparks/second thrown off the ring
    sparkSize: 0.085, // width of one streak, metres
    sparkLife: 0.89, // seconds — with the gradient below, this is the fan's length
    sparkLifeVariance: 0.64,
    // Speed over drag is how far a spark actually gets (metres): 6.1 / 3.56 is
    // a little under two metres, so the fan sits inside a radius of the ring
    // and sweeps round it. Wind the speed up or the drag down and the tangents
    // straighten into a starburst that reads as a sun rather than as a portal.
    sparkSpeed: 6.1, // metres/second, along the tangent
    sparkSpeedVariance: 0.51,
    sparkSwirl: 1.45, // which way round they are thrown — negative reverses it
    sparkOut: 0.3, // how much of the throw is straight out instead
    sparkSpread: 0.11, // 0..1 cone widening — keep it tight or the fan breaks up
    sparkJitter: 0.0, // metres of scatter at the birth point — off, so the line stays crisp
    sparkDrag: 3.56, // what pulls a straight tangent up into a curved line
    sparkGravity: -0.8, // metres/second², so the fan sags a little
    sparkStretch: 0.7, // how long the streak is drawn per unit of speed
    sparkEndSize: 0.12, // how much of its width is left when it dies
    sparkFadeOut: 0.55, // fraction of its life spent fading
    sparkWander: 0.0, // wobble — off, so the fan keeps its clean sweep

    /* --- the lifetime gradient, and the entire colour design --- */
    colorBirth: '#fff6e0', // white, on the ring
    colorEarly: '#ffab34', // orange, through the middle of the throw
    colorLate: '#ff4a0a', // red, out at the ends
    colorDeath: '#4a0a00', // and gone

    /* --- dynamic light --- */
    lightIntensity: 40, // the firelight the portal throws on the floor
    lightRadius: 18.5,
    lightColor: '#ff7a22',
    lightFlicker: 0.38 // depth of the gutter in that light
  }
};

/**
 * How an ability is aimed.
 *
 * `LINE` is the skillshot the sandbox started with: an arrow swung about the
 * caster, cast along its length. `ZONE` is the **far cast** — a circle with a
 * thick boundary dropped at the cursor, which answers the only question a
 * ground-targeted AoE has to answer before you commit: how much space is this
 * going to take. Both resolve to the same `cast(origin, direction, distance)`
 * event, so an ability never has to care which one aimed it; a zone ability
 * simply reads its target as `pointAt(1)` and works outward from there.
 *
 * `GATE` is the third, and the first that leaves the floor: a threshold slot on
 * the ground plus a ghost of the arch standing upright in the gate's own plane,
 * for casts that *build* something. It resolves to the same three-argument
 * event as the other two — the site is `pointAt(1)` and the heading is the
 * direction, which is the way the gate faces.
 *
 * `RING` is the fourth, and the first that previews a *sequence*: a sigil on
 * the floor with the ring itself lying on it, tipping upright as the cast arms.
 * A machine is not built where it stands, so a template that only drew the
 * standing pose would be promising the wrong half of the cast.
 *
 * `SCRIBE` is the fifth, and the only one that never touches the floor: a
 * circle standing in the air with a spark running round it, for a cast that is
 * *drawn* rather than built or dropped. It is the same three-argument event as
 * the rest — the site is `pointAt(1)` and the heading is the direction the
 * circle faces — and the ground read it gives up is carried by the reach ring
 * instead, because a portal cut in mid-air has a reach and has no footprint.
 */
export const CastShape = Object.freeze({
  LINE: 'line',
  ZONE: 'zone',
  GATE: 'gate',
  RING: 'ring',
  SCRIBE: 'scribe'
});

/**
 * Ability ids, in slot order.
 *
 * `AbilityManager`, the HUD, the aim controller and the editor all key off this
 * array, and the index is the slot the keyboard binds to — adding a third
 * ability is a new file, an entry here and a settings block above.
 */
export const ELEMENTS = [
  'pyre',
  'kraken',
  'electrical',
  'earth',
  'portal',
  'aether',
  'firePortal'
];

/**
 * Registry metadata: how an ability is presented, and how it is aimed.
 *
 * `key` must match `InputManager`. `cast` is read by `AimController` to pick
 * between the arrow and the circle; omit it and the ability is a line cast.
 */
export const ELEMENT_META = {
  pyre: {
    label: 'Pyre Crown',
    accent: '#ff6a1e',
    key: 'Q',
    hint: 'Pyre Crown',
    cast: CastShape.ZONE
  },
  kraken: {
    label: 'Kraken Crown',
    accent: '#3fe0c8',
    key: 'E',
    hint: 'Kraken Crown',
    cast: CastShape.ZONE
  },
  electrical: {
    label: 'Electrical Sphere',
    accent: '#ff7a30',
    key: 'R',
    hint: 'Electrical Sphere',
    cast: CastShape.ZONE
  },
  earth: {
    label: 'Earthen Spire',
    accent: '#a8704a',
    key: 'F',
    hint: 'Earthen Spire',
    cast: CastShape.LINE
  },
  portal: {
    label: 'Verdant Gate',
    accent: '#79ef27',
    key: 'V',
    hint: 'Verdant Gate',
    cast: CastShape.GATE
  },
  aether: {
    label: 'Tidewrought Ring',
    accent: '#3fd8ff',
    key: 'X',
    hint: 'Tidewrought Ring',
    cast: CastShape.RING
  },
  firePortal: {
    label: 'Fire Portal',
    accent: '#ffb02e',
    key: 'Z',
    hint: 'Fire Portal',
    cast: CastShape.SCRIBE
  }
};

/**
 * The self buffs, presented like abilities but registered nowhere near one.
 *
 * `ELEMENTS` is the list of things that are *aimed and cast*; none of the buffs
 * is, so they stay out of that array — the aim controller, the ability pool and
 * the cast cooldowns never hear about them. All any of them needs is the same
 * three facts the HUD asks an ability for, and its own key.
 */
export const BOOST_META = Object.freeze({
  label: 'Electric Boost',
  accent: '#7fc9ff',
  key: 'B',
  hint: 'Electric Boost'
});

export const MAGIC_META = Object.freeze({
  label: 'Magic Boost',
  accent: '#c46bff',
  key: 'M',
  hint: 'Magic Boost'
});

export const FIRE_META = Object.freeze({
  label: 'Fire Boost',
  accent: '#ff7a1e',
  key: 'K',
  hint: 'Fire Boost'
});

/** How the given ability is aimed. Line unless its metadata says otherwise. */
export function castShapeOf(element) {
  return ELEMENT_META[element]?.cast ?? CastShape.LINE;
}

/**
 * The clear radius of an upright circular cast, metres. 0 for anything else.
 *
 * Both shapes that hang a circle in the air — the ring that is forged and stood
 * up, and the portal that is cut where it hangs — measure it out of the same
 * `ringRadius` field, because from the targeting side they are asking for the
 * same number.
 */
export function ringRadiusOf(element) {
  const shape = castShapeOf(element);
  const circular = shape === CastShape.RING || shape === CastShape.SCRIBE;
  return circular ? (settings[element]?.ringRadius ?? 0) : 0;
}

/** The footprint a far cast will cover, metres. 0 for a line cast. */
export function zoneRadiusOf(element) {
  return castShapeOf(element) === CastShape.ZONE ? (settings[element]?.zoneRadius ?? 0) : 0;
}

/** Immutable snapshot used by "Reset to defaults" and the preset system. */
export const DEFAULT_SETTINGS = structuredClone(settings);

/**
 * Deep-merge a plain object into `settings` in place.
 * Existing object identity is preserved so every live binding keeps working.
 */
export function applySettings(patch, target = settings) {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (target[key] && typeof target[key] === 'object') applySettings(value, target[key]);
    } else if (key in target) {
      target[key] = value;
    }
  }
  return target;
}

/** Restore every value to the shipped defaults (in place). */
export function resetSettings() {
  applySettings(structuredClone(DEFAULT_SETTINGS));
}

/** Serialisable clone of the current state. */
export function snapshotSettings() {
  return structuredClone(settings);
}
