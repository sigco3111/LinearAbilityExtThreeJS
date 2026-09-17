import { ShaderMaterial, AdditiveBlending, NormalBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/* ==================================================================== */
/* The ground the charge stands on                                       */
/* ==================================================================== */

const FIELD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The floor under a charged character, **broken open and gone dark**.
 *
 * Every other ground pass in the sandbox is additive, because every other one
 * only ever *adds* light to the stone. This one cannot be: the read here is a
 * hole — a plate of floor that has been shattered and pushed below the room,
 * with the charge burning in the gaps between the pieces. Additive blending can
 * make the seams white but it can never make the plates black, and without the
 * black the seams have nothing to be bright against.
 *
 * So it blends normally, and carries both halves of the picture in one pass:
 *
 *   - **the crust.** A voronoi field measured to its *edges* rather than to its
 *     cell points (`plates()` below), which is what gives real straight-sided
 *     shards instead of a field of blobs. Each plate takes its own tone off the
 *     cell id, and an fbm grain rides over the lot, so what darkens the floor is
 *     broken stone rather than a wash of paint.
 *   - **the seams.** The same edges, thresholded hard and lit — this is where
 *     the charge earths. Ridged filaments crawl through the plates on top of
 *     them so the light is not confined to the geometry of the cells.
 *   - **the boundary.** The circle is dragged out of round by an angular lookup
 *     — the one place `atan()`-free angular noise is the right tool, because
 *     this *is* a boundary — and lit at the lip, where the floor is still
 *     tearing.
 *
 * Alpha is `max(crust, light)`: black where the stone is, opaque and far above
 * 1.0 where a seam is, which is what puts the seams through the bloom
 * threshold while the plates sit under the room.
 *
 * Sized in metres from `uQuadSize` every frame rather than at spawn, so
 * `fieldRadius` re-scales a crater that is already standing.
 */
const FIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;    // metres the quad covers, edge to edge
  uniform float uRadius;      // crater radius, metres
  uniform float uEdge;        // width of the torn lip, metres
  uniform float uEdgeGlow;
  uniform float uTear;        // how far out of round the boundary is dragged

  uniform float uDark;        // opacity of the crust — the actual darkness
  uniform float uDarkScale;
  uniform float uDarkContrast;
  uniform float uPlateScale;  // shards per metre
  uniform float uPlateTone;   // how differently one shard is toned from the next
  uniform float uSeamWidth;
  uniform float uSeams;

  uniform float uVeins;       // filaments crawling over the shards
  uniform float uVeinScale;
  uniform float uWarp;
  uniform float uCrawl;
  uniform float uEmbers;
  uniform float uEmberScale;
  uniform float uFalloff;     // how the light dies toward the lip
  uniform float uPulse;
  uniform float uPulseSpeed;

  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorCrust;
  uniform vec3  uColorPlate;
  uniform vec3  uColorSeam;
  uniform vec3  uColorEmber;

  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}

  #define TAU 6.28318530718

  /**
   * Voronoi measured to the *edge* between the two nearest cells, not to the
   * nearest cell point. x is that distance (0 on a seam), y the cell id.
   *
   * The lib's voronoi2 returns F1, whose zero set is the cell *centres* — fine
   * for scattering, useless for cracks. This is the standard two-pass version:
   * find the closest point, then measure every neighbour against the plane
   * halfway between it and that one.
   */
  vec2 plates(vec2 p) {
    vec2 n = floor(p);
    vec2 f = p - n;

    vec2 best = vec2(0.0);
    vec2 bestPoint = vec2(0.0);
    float bestDist = 8.0;
    float id = 0.0;

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < bestDist) {
          bestDist = d;
          best = g;
          bestPoint = r;
          id = hash11(dot(n + g, vec2(31.7, 57.1)));
        }
      }
    }

    float edge = 8.0;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        vec2 g = best + vec2(float(i), float(j));
        vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
        vec2 r = g + o - f;
        vec2 delta = r - bestPoint;
        float len = dot(delta, delta);
        if (len > 1e-5) {
          edge = min(edge, dot(0.5 * (bestPoint + r), normalize(delta)));
        }
      }
    }
    return vec2(edge, id);
  }

  void main() {
    /* ---- uv → metres, measured from the centre of the crater ---- */
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    /* ---- the boundary, dragged out of round ---- */
    vec2  bearing = d > 1e-4 ? p / d : vec2(1.0, 0.0);
    float torn  = 1.0 + uTear * snoise(vec3(bearing * 2.6, uSeed * 6.0));
    float rim   = max(0.05, uRadius * torn);

    float aa = fwidth(d) + 0.01;
    if (d > rim + aa * 3.0) discard;

    float inside = smoothstep(rim + aa, rim - max(uEdge, aa), d);
    if (inside < 0.004) discard;
    float radial = clamp(d / rim, 0.0, 1.0);

    /* ---- the shattered crust ---- */
    vec2  cell  = plates(p * uPlateScale + uSeed * 20.0);
    float tone  = mix(1.0 - uPlateTone, 1.0, cell.y);
    float grain = fbm4(vec3(p * uDarkScale, uSeed * 3.0)) * 0.5 + 0.5;
    float crust = pow(clamp(grain, 0.0, 1.0), max(uDarkContrast, 0.05));

    // Deepest in the middle and lifting toward the lip: a hole has a floor
    // somewhere, and shading it flat reads as a sticker.
    vec3 dark = mix(uColorCrust, uColorPlate, crust * tone);
    float crustAlpha = uDark * inside * mix(1.0, 0.72, radial);

    /* ---- the charge in the seams ---- */
    float seam = smoothstep(uSeamWidth, 0.0, cell.x) * uSeams;

    float warp = fbm3(vec3(p * 0.55, uTime * 0.12 + uSeed)) * uWarp;
    float fil  = ridged(vec3(p * uVeinScale + warp, uSeed * 11.0 - uTime * uCrawl), 4);
    float veins = smoothstep(0.66, 0.97, fil) * uVeins;

    float embers = pow(max(0.0, snoise(vec3(p * uEmberScale, uSeed * 9.0 + uTime * 1.4))), 7.0) *
                   uEmbers;

    // The lip is where the floor is still tearing, so it stays the hottest line
    // on the ground however far the light inside has died back.
    float lip = smoothstep(max(uEdge, aa), 0.0, abs(d - rim)) * uEdgeGlow;

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float weight  = pow(1.0 - radial * 0.75, max(uFalloff, 0.05));
    float light   = ((seam + veins) * weight + embers) * inside * breathe + lip * inside;

    float alpha = clamp(max(crustAlpha, light), 0.0, 1.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = dark + (uColorSeam * (seam + veins) * weight + uColorEmber * (embers + lip)) *
                        uGlow * uGlobalGlow * breathe;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The crater under the charged character. One quad, re-sized and re-shaded from
 * `settings.boost` every frame.
 */
export function createChargeFieldMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // The one ground pass in the sandbox that is *not* additive — see above.
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuadSize: { value: 6 },
      uRadius: { value: 2.2 },
      uEdge: { value: 0.22 },
      uEdgeGlow: { value: 1.1 },
      uTear: { value: 0.16 },

      uDark: { value: 0.92 },
      uDarkScale: { value: 1.6 },
      uDarkContrast: { value: 1.5 },
      uPlateScale: { value: 1.5 },
      uPlateTone: { value: 0.6 },
      uSeamWidth: { value: 0.06 },
      uSeams: { value: 1.2 },

      uVeins: { value: 0.7 },
      uVeinScale: { value: 1.8 },
      uWarp: { value: 0.5 },
      uCrawl: { value: 0.5 },
      uEmbers: { value: 0.8 },
      uEmberScale: { value: 5 },
      uFalloff: { value: 1.1 },
      uPulse: { value: 0.18 },
      uPulseSpeed: { value: 1.6 },

      uSeed: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.4 },
      uColorCrust: { value: new Color(0.01, 0.02, 0.04) },
      uColorPlate: { value: new Color(0.05, 0.09, 0.15) },
      uColorSeam: { value: new Color(0.23, 0.63, 1) },
      uColorEmber: { value: new Color(0.79, 0.93, 1) }
    }),
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT
  });

  /**
   * @param {object} state { radius, quadSize, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.boost;
    const g = settings.global;
    const u = material.uniforms;

    u.uQuadSize.value = state.quadSize;
    u.uRadius.value = state.radius;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uEdge.value = c.fieldEdge;
    u.uEdgeGlow.value = c.fieldEdgeGlow * g.shaderIntensity;
    u.uTear.value = c.fieldTear * g.randomness;

    u.uDark.value = c.fieldDark;
    u.uDarkScale.value = c.fieldDarkScale * g.noiseFrequency;
    u.uDarkContrast.value = c.fieldDarkContrast;
    u.uPlateScale.value = c.fieldPlateScale * g.noiseFrequency;
    u.uPlateTone.value = c.fieldPlateTone;
    u.uSeamWidth.value = c.fieldSeamWidth;
    u.uSeams.value = c.fieldSeams * g.shaderIntensity;

    u.uVeins.value = c.fieldVeins * g.shaderIntensity;
    u.uVeinScale.value = c.fieldVeinScale * g.noiseFrequency;
    u.uWarp.value = c.fieldWarp * g.noiseStrength;
    u.uCrawl.value = c.fieldCrawl * g.noiseSpeed;
    u.uEmbers.value = c.fieldEmbers * g.shaderIntensity;
    u.uEmberScale.value = c.fieldEmberScale * g.noiseFrequency;
    u.uFalloff.value = c.fieldFalloff;
    u.uPulse.value = c.fieldPulse;
    u.uPulseSpeed.value = c.fieldPulseSpeed;

    u.uOpacity.value = c.fieldOpacity * g.opacity;
    u.uGlow.value = c.fieldGlow * g.glow;
    u.uColorCrust.value.copy(getColor(c.colorFieldCrust));
    u.uColorPlate.value.copy(getColor(c.colorFieldPlate));
    u.uColorSeam.value.copy(getColor(c.colorFieldSeam));
    u.uColorEmber.value.copy(getColor(c.colorFieldEmber));
  };

  return material;
}

/* ==================================================================== */
/* The coil standing on it                                               */
/* ==================================================================== */

/** The two passes one filament is drawn in, as everywhere else. */
export const CoilPass = Object.freeze({
  CORE: 0, // the hot filament
  GLOW: 1 // the halo it sits inside
});

/**
 * What a filament is laid along. Same shader, same ribbon, same noise — only
 * the curve the CPU never sees differs.
 */
export const CoilAxis = Object.freeze({
  RING: 0, // lying flat, running around the crater
  UPRIGHT: 1 // standing on it, arching over the middle or reaching for the sky
});

/**
 * Lightning laid **around** the crater and **across** it.
 *
 * Like `BodyArcMaterial`, the CPU picks nothing: one instanced ribbon per
 * filament, and where it starts, where it ends, when it strikes and when it
 * dies all fall out of the instance index and the clock in the vertex shader.
 * The only numbers crossing the bus are the centre of the circle, its radius
 * and the buff's envelope.
 *
 * ## Rings (`CoilAxis.RING`)
 *
 * A partial loop: a start bearing, a sweep of `uSweep` of the full turn, and a
 * radius that is pushed in and out by noise **sampled on the bearing itself**
 * rather than on `t`. That distinction is the whole trick — noise on `t` is a
 * wobble that happens to be bent into a circle and it swims when the ring is
 * re-scaled, while noise on the bearing is a property *of the ground*, so the
 * same lobe sits over the same patch of floor at every radius and the rings
 * read as one field rather than as unrelated hoops. They are seated at
 * staggered heights from the floor up to `uLift`, so the crater has a stack
 * rather than one contour.
 *
 * ## Uprights (`CoilAxis.UPRIGHT`)
 *
 * Struck off the rim. `uCross` of them arch clear over the middle and earth on
 * the far side; the rest climb to `uHeight` and end in the air, leaning outward
 * by `uLean`. The first group is what gives the cage its roof, the second is the
 * jagged crown standing around the edge.
 *
 * Both share the ribbon, the kinks and the strike cycle below, because they are
 * the same electricity — one editor group tunes the look, two tune the layout.
 */
const COIL_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;

  uniform vec3  uBase;
  uniform float uRadius;
  uniform float uCount;

  uniform float uRate;
  uniform float uLife;

  uniform float uInner;
  uniform float uOuter;
  uniform float uLift;
  uniform float uSweep;
  uniform float uWobble;
  uniform float uWobbleScale;
  uniform float uRipple;
  uniform float uWrithe;

  uniform float uHeight;
  uniform float uCross;
  uniform float uSpan;
  uniform float uSpread;
  uniform float uLean;

  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;

  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uTaper;
  uniform float uCoreWidth;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vLive;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  /** Value noise with a linear ramp — piecewise-linear, sharp corners. */
  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  /** Octaves of it, in the plane perpendicular to the filament. */
  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;

    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }

  /** A point on the floor of the crater, at bearing a and radius r. */
  vec3 groundPoint(float a, float r, float y) {
    return uBase + vec3(cos(a) * r, y, sin(a) * r);
  }

  #ifdef COIL_UPRIGHT
  /* ---- struck off the rim, arching over or climbing away ---- */
  vec3 axisPoint(float t, vec3 p0, vec3 p1, vec3 bow) {
    return mix(p0, p1, t) + bow * sin(t * PI);
  }
  #else
  /* ---- lying flat, running around the crater ---- */
  vec3 ringPoint(float t, float a0, float cover, float r0, float y0, float seed) {
    float a = a0 + t * TAU * cover;
    vec2 bearing = vec2(cos(a), sin(a));

    // Sampled on the bearing, so a lobe belongs to a patch of ground rather
    // than to a position along the ribbon. Two octaves: one that owns the
    // silhouette, one that roughens it.
    float drift = uTime * uWrithe + seed;
    float w = snoise(vec3(bearing * uWobbleScale, drift)) +
              0.45 * snoise(vec3(bearing * uWobbleScale * 2.3, drift * 1.31 + 11.0));
    float r = max(0.02, r0 + w * uWobble);

    float lift = uRipple * snoise(vec3(bearing * uWobbleScale * 1.7, drift * 0.83 + 31.0));
    return groundPoint(a, r, y0 + lift);
  }
  #endif

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    /* ---- this filament's own clock ---- */
    float phase = hash11(aStrand * 3.71 + uSeed * 0.13);
    float cycle = uTime * max(uRate, 0.01) + phase;
    float strike = floor(cycle);
    float k = fract(cycle);
    float seed = hash11(aStrand * 7.13 + strike * 3.77 + uSeed) * 97.0;

    float life = clamp(uLife, 0.02, 1.0);
    vLive = smoothstep(0.0, 0.06 * life, k) * (1.0 - smoothstep(life * 0.4, life, k));

    // Slot 0..1 across the *live* count, so thinning the coil in the editor
    // re-spaces what is left instead of leaving gaps where instances were.
    float slot = (aStrand + 0.5) / max(uCount, 1.0);

    vec3 here;
    vec3 next;
    float span;

    #ifdef COIL_UPRIGHT
      /* ---- where it is struck from, and to ---- */
      float a0 = slot * TAU + (hash11(seed + 1.3) - 0.5) * TAU / max(uCount, 1.0);
      float r0 = uRadius * mix(0.82, 1.02, hash11(seed + 2.1));
      vec3 p0 = groundPoint(a0, r0, 0.0);

      float crosses = step(hash11(seed + 3.3), clamp(uCross, 0.0, 1.0));
      // Signed, but never small: an arch that lands where it took off is a
      // hairpin, not an arch, and half of a uniform roll is close to zero.
      float turn = hash11(seed + 4.7) * 2.0 - 1.0;
      float bearing = (turn >= 0.0 ? 1.0 : -1.0) * mix(0.4, 1.0, abs(turn));
      float a1 = a0 + bearing * mix(uSpread, uSpan, crosses);
      float r1 = uRadius * mix(0.82, 1.02, hash11(seed + 5.9));
      float y1 = (1.0 - crosses) * uHeight * mix(0.45, 1.0, hash11(seed + 6.5));
      vec3 p1 = groundPoint(a1, r1, y1);

      vec3 radial = normalize(vec3(cos(a0), 0.0, sin(a0)));
      // A crosser is an arch and carries its bow up; a climber is a spike and
      // carries it outward, so the crown leans away from the body.
      vec3 bow = mix(
        radial * uLean * mix(0.4, 1.0, hash11(seed + 7.7)),
        vec3(0.0, uHeight * mix(0.7, 1.15, hash11(seed + 8.3)), 0.0),
        crosses
      );

      vec3 axis = axisPoint(t, p0, p1, bow);
      span = max(length(p1 - p0) + length(bow), 0.05);
    #else
      // Radius from the slot so the rings stay spread across the crater, height
      // from the dice so the stack is shuffled rather than a funnel.
      float r0 = uRadius * mix(uInner, uOuter, slot) * mix(0.94, 1.06, hash11(seed + 1.9));
      // Never quite on the floor: a ribbon seated at y = 0 is half-eaten by
      // the depth test the moment the camera drops toward the ground.
      float y0 = uLift * mix(0.12, 1.0, hash11(seed + 4.3));
      float a0 = hash11(seed + 2.7) * TAU;
      float cover = clamp(uSweep, 0.02, 1.0) * mix(0.75, 1.0, hash11(seed + 3.5));

      vec3 axis = ringPoint(t, a0, cover, r0, y0, seed);
      span = max(TAU * cover * r0, 0.05);
    #endif

    /* ---- the same curve a hair further along, for the tangent ---- */
    float step_ = 0.03;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }

    #ifdef COIL_UPRIGHT
      vec3 axisNext = axisPoint(ahead, p0, p1, bow);
    #else
      vec3 axisNext = ringPoint(ahead, a0, cover, r0, y0, seed);
    #endif

    vec3 dir = axisNext - axis;
    dir = length(dir) > 1e-5 ? normalize(dir * flip) : vec3(0.0, 1.0, 0.0);

    // The frame the kinks live in: up-ish and sideways, both perpendicular to
    // the run of the filament.
    vec3 n1 = vec3(0.0, 1.0, 0.0) - dir * dot(vec3(0.0, 1.0, 0.0), dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(1.0, 0.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    // Both ends pinned: a filament has to touch what it is struck between.
    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) * smoothstep(0.0, pinch, 1.0 - t);
    vec2 offset = kink(t, seed, span) * uJitter * ends;
    here = axis + n1 * offset.x + n2 * offset.y;

    vec2 offsetNext = kink(ahead, seed, span) * uJitter *
                      smoothstep(0.0, pinch, ahead) * smoothstep(0.0, pinch, 1.0 - ahead);
    next = axisNext + n1 * offsetNext.x + n2 * offsetNext.y;

    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    /* ---- turn the ribbon to face the camera ---- */
    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    /* ---- width ---- */
    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;
    vStrand = hash11(seed + 8.4);

    float taper = pow(max(sin(t * PI), 0.0), max(uTaper, 0.01));
    float halfWidth = uWidth * uWidthScale * taper;
    halfWidth *= mix(uCoreWidth, 1.0, vStrand);
    halfWidth *= flash * vLive * uStrength;

    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const COIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uStrength;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vLive;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (vLive <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef COIL_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
    #endif

    float alpha = profile;
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    alpha *= vLive * flicker * vFlash * uStrength * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One pass of one axis of the coil.
 *
 * The four materials (ring/upright × core/glow) share every uniform but the two
 * that define the pass (`uWidthScale`, `uPassOpacity`) and the handful the axis
 * uses, so `userData.sync()` takes the same state object for all of them and one
 * editor group drives the look of the lot.
 *
 * @param {number} pass CoilPass.*
 * @param {number} axis CoilAxis.*
 */
export function createChargeCoilMaterial(pass = CoilPass.CORE, axis = CoilAxis.RING) {
  const glow = pass === CoilPass.GLOW;
  const upright = axis === CoilAxis.UPRIGHT;

  const defines = {};
  if (glow) defines.COIL_GLOW = '';
  if (upright) defines.COIL_UPRIGHT = '';

  const material = new ShaderMaterial({
    defines,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: 0 },
      uStrength: { value: 0 },

      uBase: { value: new Vector3() },
      uRadius: { value: 2.2 },
      uCount: { value: 6 },

      uRate: { value: 1.6 },
      uLife: { value: 0.85 },

      uInner: { value: 0.34 },
      uOuter: { value: 1.0 },
      uLift: { value: 0.7 },
      uSweep: { value: 0.75 },
      uWobble: { value: 0.2 },
      uWobbleScale: { value: 2.2 },
      uRipple: { value: 0.12 },
      uWrithe: { value: 0.35 },

      uHeight: { value: 1.7 },
      uCross: { value: 0.25 },
      uSpan: { value: 1.7 },
      uSpread: { value: 0.3 },
      uLean: { value: 0.3 },

      uJitter: { value: 0.09 },
      uJitterScale: { value: 3 },
      uOctaves: { value: 4 },
      uJitterFalloff: { value: 0.55 },
      uCrawl: { value: 2.4 },
      uPinch: { value: 0.18 },

      uWidth: { value: 0.018 },
      uWidthScale: { value: glow ? 6 : 1 },
      uTaper: { value: 0.6 },
      uCoreWidth: { value: 1.5 },
      uCoreSharp: { value: 3.4 },
      uGlowFalloff: { value: 2.4 },
      uPassOpacity: { value: glow ? 0.4 : 1 },
      uBranchDim: { value: 0.7 },
      uSoftFade: { value: 0.35 },

      uFlicker: { value: 0.3 },
      uFlickerSpeed: { value: 30 },
      uStrandFlash: { value: 0.4 },

      uOpacity: { value: 1 },
      uGlow: { value: 2.6 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorInner: { value: new Color(0.78, 0.92, 1) },
      uColorOuter: { value: new Color(0.22, 0.62, 1) },
      uColorHalo: { value: new Color(0.04, 0.24, 0.78) }
    }),
    vertexShader: COIL_VERTEX,
    fragmentShader: COIL_FRAGMENT
  });

  /**
   * @param {object} state { base, radius, strength, seed, count }
   */
  material.userData.sync = (state) => {
    const c = settings.boost;
    const g = settings.global;
    const u = material.uniforms;

    u.uBase.value.copy(state.base);
    u.uRadius.value = state.radius;
    u.uStrength.value = state.strength;
    u.uSeed.value = state.seed + (upright ? 37.0 : 0.0);
    u.uCount.value = state.count;

    u.uRate.value = upright ? c.spireRate : c.ringRate;
    u.uLife.value = upright ? c.spireLife : c.ringLife;

    u.uInner.value = c.ringInner;
    u.uOuter.value = c.ringOuter;
    u.uLift.value = c.ringLift;
    u.uSweep.value = c.ringSweep;
    u.uWobble.value = c.ringWobble * g.noiseStrength;
    u.uWobbleScale.value = c.ringWobbleScale * g.noiseFrequency;
    u.uRipple.value = c.ringRipple * g.noiseStrength;
    u.uWrithe.value = c.ringWrithe * g.noiseSpeed;

    u.uHeight.value = c.spireHeight;
    u.uCross.value = c.spireCross;
    u.uSpan.value = c.spireSpan;
    u.uSpread.value = c.spireSpread;
    u.uLean.value = c.spireLean;

    u.uJitter.value = c.coilJitter * g.randomness * g.noiseStrength;
    u.uJitterScale.value = c.coilJitterScale * g.noiseFrequency;
    u.uOctaves.value = Math.round(c.coilOctaves);
    u.uJitterFalloff.value = c.coilJitterFalloff;
    u.uCrawl.value = c.coilCrawl * g.noiseSpeed;
    u.uPinch.value = c.coilPinch;

    u.uWidth.value = upright ? c.spireWidth : c.ringWidth;
    u.uWidthScale.value = glow ? c.coilGlowWidth : 1;
    u.uPassOpacity.value = glow ? c.coilGlowOpacity : 1;
    u.uTaper.value = c.coilTaper;
    u.uCoreWidth.value = c.coilCoreWidth;
    u.uCoreSharp.value = c.coilCoreSharp;
    u.uGlowFalloff.value = c.coilGlowFalloff;
    u.uSoftFade.value = c.coilSoftFade;

    u.uFlicker.value = c.coilFlicker;
    u.uFlickerSpeed.value = c.coilFlickerSpeed;
    u.uStrandFlash.value = c.coilStrandFlash;

    u.uOpacity.value = c.coilOpacity * g.opacity;
    u.uGlow.value = c.coilGlow;
    u.uColorCore.value.copy(getColor(c.colorCoilCore));
    u.uColorInner.value.copy(getColor(c.colorCoilInner));
    u.uColorOuter.value.copy(getColor(c.colorCoilOuter));
    u.uColorHalo.value.copy(getColor(c.colorCoilHalo));
  };

  return material;
}
