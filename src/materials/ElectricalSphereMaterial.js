import { ShaderMaterial, Color, DoubleSide, FrontSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The Electrical Sphere materials — one solid shell and a floor disc.
 *
 * The shape the effect is chasing is a **dark polished ball carrying a
 * charge**: a hard, near-black sphere that mirrors the room it is standing in,
 * lit around its silhouette by Fresnel alone, with electricity crawling in a
 * flat net *across its skin* and arcs leaving that skin into the air.
 *
 * Everything about the body follows from "dark, reflective, opaque":
 *
 *   - the albedo is almost black. Every bright thing on the ball is the room
 *     reflected in it, the discharge burnt onto it, or the Fresnel wrapped
 *     around it — never the surface itself glowing.
 *   - it writes depth and draws front faces only, so bolts and sparks passing
 *     behind it are correctly hidden by it.
 *   - the **Fresnel** is the light. Two terms: a wide halo standing in for the
 *     atmosphere around the ball, and a tight rim right on the silhouette.
 *
 * There used to be a second, larger additive sphere around this one carrying a
 * corona of flame. It is gone. A blown-up shell of noise drawn additively over
 * a *reflective* body is a contradiction — whatever it adds sits in front of
 * the mirror and washes it out, and from any angle it reads as a smoky bubble
 * wrapped around the object rather than as energy coming off it. The
 * silhouette light it was there to provide is now the Fresnel terms below, and
 * the energy leaving the ball is the radial bolts, which start on the surface.
 *
 * The platform is a separate shader on a flat disc on the floor: a darker
 * mirror of the same vocabulary (concentric rings, hex grain, hot edges) so
 * the sphere reads as being seated on a containment device.
 *
 * ## Why everything is on the GPU
 *
 * The sphere wants reflection, a discharge net and pulsing all at once, and a
 * CPU loop on per-vertex data would burn the frame budget. Everything that can
 * be derived from the surface position and the clock is derived in the
 * fragment shader, and the editor sliders re-resolve themselves on a
 * zero-length frame so pausing still applies.
 */

/** A flat-top hex grid. Returns (x, y) in cell space and the cell centre. */
const HEX_GLSL = /* glsl */ `
  // Pointy-top hex grid in 2D. The two candidate cells are offset by (0.5, 0.5)
  // so the half-step lands exactly on the alternation, and whichever centre is
  // closer wins. The cell-centre output is what the rest of the shader uses
  // for paneling.
  vec4 hexCell(vec2 p) {
    vec2 s = vec2(1.7320508, 1.0); // sqrt(3), 1
    vec2 a = mod(p, s) - s * 0.5;
    vec2 b = mod(p + s * 0.5, s) - s * 0.5;
    vec2 gA = floor(p / s) * s + s * 0.5;
    vec2 gB = floor((p + s * 0.5) / s) * s;
    float dA = dot(a, a);
    float dB = dot(b, b);
    if (dA < dB) return vec4(a, gA);
    return vec4(b, gB);
  }
`;

/**
 * Vertex shader. The geometry is a unit sphere centred at the origin and the
 * mesh is uniformly scaled, so the local normal and the world normal only
 * differ by the model rotation — cheap to carry both.
 */
const SPHERE_VERTEX = /* glsl */ `
  varying vec3 vPosLocal;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying vec2 vSpherical;

  void main() {
    vPosLocal = position;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vViewDir = normalize(cameraPosition - wp.xyz);

    // A pair of stable spherical coordinates from the local position. The y
    // axis is the pole, so atan(x, z) is a clean longitude and the latitude
    // is derived from y — the seam sits at the back, which is fine for a
    // sphere you can orbit around.
    vSpherical = vec2(atan(position.x, position.z), position.y);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/**
 * Reflection helpers.
 *
 * The scene's HDR is kept around as a raw equirect texture (`frame.uEnvMap`)
 * precisely so custom shaders can do this: one `texture2D` in the mirror
 * direction is a convincing room reflection on a convex surface, and a convex
 * sphere is the one shape where the cheat is *exact* apart from parallax.
 *
 * `sampleEnv` blurs by taking four extra taps spread around the mirror
 * direction in its own tangent frame — cheaper and far more predictable than
 * a mip bias, since the HDR is not guaranteed to carry a mip chain.
 */
const ENV_GLSL = /* glsl */ `
  vec2 equirectUv(vec3 dir) {
    return vec2(atan(dir.z, dir.x) * 0.15915494 + 0.5,
                asin(clamp(dir.y, -1.0, 1.0)) * 0.31830989 + 0.5);
  }

  vec3 sampleEnv(vec3 dir, float rough) {
    dir = normalize(dir);
    vec3 c = texture2D(uEnvMap, equirectUv(dir)).rgb;
    if (rough > 0.002) {
      vec3 t1 = normalize(cross(dir, vec3(0.0, 1.0, 0.0) + vec3(1e-3)));
      vec3 t2 = cross(dir, t1);
      float s = rough * 0.5;
      c += texture2D(uEnvMap, equirectUv(dir + t1 * s)).rgb;
      c += texture2D(uEnvMap, equirectUv(dir - t1 * s)).rgb;
      c += texture2D(uEnvMap, equirectUv(dir + t2 * s)).rgb;
      c += texture2D(uEnvMap, equirectUv(dir - t2 * s)).rgb;
      c *= 0.2;
    }
    return c;
  }

  /**
   * Bend the normal by the gradient of an fbm field, so the mirror image
   * ripples the way it does over a charged skin. Two extra taps in a tangent
   * frame built from the normal — the sphere carries no tangent attribute.
   */
  vec3 rippleNormal(vec3 N, vec3 p, float scale, float amp) {
    if (amp < 1e-3) return N;
    vec3 t1 = normalize(cross(N, vec3(0.0, 1.0, 0.0) + vec3(1e-3)));
    vec3 t2 = cross(N, t1);
    float e = 0.18;
    float h0 = fbm3(p * scale);
    float h1 = fbm3((p + t1 * e) * scale);
    float h2 = fbm3((p + t2 * e) * scale);
    vec3 grad = (t1 * (h1 - h0) + t2 * (h2 - h0)) / e;
    return normalize(N - grad * amp);
  }
`;

/**
 * The body of the sphere — a **dark reflective shell with a discharge on it**.
 *
 * Built the way a real shaded surface is, in the order the reference reads:
 *
 *   1. a **rippled normal** — the skin is not geometrically smooth, and
 *      bending the normal by an fbm gradient is what stops the reflection
 *      reading as a decal pasted on a ball. `uDistortion` is its amplitude.
 *   2. the **surface discharge** — a ridged-noise filament net crawling over
 *      the shell and re-struck on a beat. This is the flat, 2D electricity
 *      *on* the black material, distinct from the bolts leaving it.
 *   3. the **room** — one equirect tap in the mirror direction, blurred by
 *      `uEnvRoughness` and weighted by a Schlick-ish Fresnel, so the limb goes
 *      near-mirror while the middle keeps `uReflectivity`.
 *   4. the **key highlight** — a tight power lobe on the sun direction, the
 *      hard glint the reference picks up off the ceiling light.
 *   5. the **Fresnel light** — a wide halo plus a tight rim. With the corona
 *      shell gone this is the entire silhouette read, so it carries weight.
 *
 * The albedo underneath all of that stays near black on purpose. The hex
 * paneling survives behind `uHexIntensity` (shipped at 0) — it is a different,
 * more sci-fi read of the same ball, and costs nothing when off.
 */
const SPHERE_FRAGMENT = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uFade;
  uniform float uPulse;

  uniform float uRadius;

  uniform sampler2D uEnvMap;
  uniform float uEnvIntensity;
  uniform float uEnvRoughness;
  uniform float uReflectivity;
  uniform float uFresnelPower;
  uniform float uSpecular;
  uniform float uSpecSharp;
  uniform float uShellDiffuse;
  uniform float uShellRipple;
  uniform vec3  uLightDir;

  uniform float uPlasmaScale;
  uniform float uPlasmaSpeed;
  uniform float uPlasmaIntensity;
  uniform float uPlasmaCore;
  uniform float uPlasmaWarp;

  uniform float uHexScale;
  uniform float uHexWidth;
  uniform float uHexIntensity;
  uniform float uHexPulse;

  uniform float uArcScale;
  uniform float uArcSpeed;
  uniform float uArcCrawl;
  uniform float uArcWidth;
  uniform float uArcGlowWidth;
  uniform float uArcIntensity;
  uniform float uArcFlicker;
  uniform float uArcRestrike;
  uniform float uArcWarp;
  uniform float uArcCharge;

  uniform float uRimPower;
  uniform float uRimIntensity;
  uniform float uRimWidth;
  uniform float uGlowPower;
  uniform float uGlowIntensity;

  uniform float uDistortion;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorShell;
  uniform vec3  uColorDeep;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorMid;
  uniform vec3  uColorOuter;
  uniform vec3  uColorEdge;
  uniform vec3  uColorArcCore;
  uniform vec3  uColorArcGlow;
  uniform vec3  uColorHex;
  uniform vec3  uColorPulse;

  varying vec3 vPosLocal;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying vec2 vSpherical;

  ${noiseGLSL}
  ${commonGLSL}
  ${HEX_GLSL}
  ${ENV_GLSL}

  /**
   * The surface discharge — the flat electricity crawling over the black skin.
   *
   * A ridged multifractal is a field whose *spines* are sharp lines, so slicing
   * a narrow band off the top of it gives a forked filament net; thresholding a
   * plain fbm the way the old molten veins did gives soft blobs instead, which
   * is why they read as lava rather than as current. The domain warp is what
   * buckles those spines into the wandering, branching path a discharge takes
   * across a surface — without it the field reads as marble.
   *
   * Re-rolling the sample point on the strike index is what makes the net
   * *re-strike* rather than drift: past a beat the whole pattern is a different
   * one, which the eye reads as a flash.
   *
   * Returns (core, glow): the thin white-hot filament, and the wider coloured
   * bleed around it.
   */
  vec2 surfaceArcs(vec3 p, float strike) {
    float t = uTime * uArcSpeed;
    vec3 w = vec3(
      snoise(p * 0.85 + vec3(0.0, t, strike * 5.1)),
      snoise(p * 0.85 + vec3(13.7, 4.1, 9.3) + strike * 2.3),
      snoise(p * 0.85 + vec3(31.1, 17.5, 5.2) - t * 0.5)
    ) * uArcWarp;

    vec3 q = p + w + vec3(strike * 7.31, t * uArcCrawl, strike * 3.7);
    // ridged() sums four octaves at 0.5, 0.25, 0.125 and 0.0625, so it tops
    // out at 0.9375. Normalising puts a spine at 1.0, which lets both widths
    // below be read straight off the slider as a fraction of the field.
    float r = ridged(q, 4) * 1.0666667;

    float core = smoothstep(1.0 - max(uArcWidth, 1e-3), 1.0, r);
    float glow = smoothstep(1.0 - max(uArcWidth + uArcGlowWidth, 2e-3), 1.0, r);
    return vec2(core, glow);
  }

  void main() {
    vec3 Ng = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float pt = uTime * uPlasmaSpeed;
    float strike = floor(uTime * max(uArcRestrike, 0.01));

    /* --- 1. the rippled surface --- */
    vec3 N = rippleNormal(Ng, vPosLocal + vec3(0.0, pt * 0.35, 0.0), uShellRipple, uDistortion);
    // Fresnel on the *geometric* normal — feeding the rippled one in here
    // makes the silhouette crawl, which reads as a wobbling outline.
    float ndv = clamp(dot(Ng, V), 0.0, 1.0);
    float fres = pow(1.0 - ndv, max(uFresnelPower, 0.05));

    /* --- 2. the discharge on the skin --- */
    vec2 arc = surfaceArcs(vPosLocal * uArcScale, strike);
    // A slow, coarse mask that keeps whole regions of the ball quiet, so the
    // net looks like current finding a path rather than a texture wrapped
    // uniformly around a sphere. It drifts and re-rolls with the strike, so
    // the live patch moves.
    float chargeField = fbm3(vPosLocal * uArcScale * 0.22 +
                             vec3(strike * 2.7, uTime * uArcSpeed * 0.35, 0.0)) * 0.5 + 0.5;
    float charge = mix(1.0, smoothstep(0.34, 0.72, chargeField), clamp(uArcCharge, 0.0, 1.0));
    // Quantised stutter: lightning gutters, it does not breathe.
    float stutter = 1.0 - uArcFlicker * hash11(floor(uTime * 34.0) + strike * 0.7 + floor(vPosLocal.y * 6.0));
    arc *= charge * stutter;

    /* --- a faint charge bleeding through the shell --- */
    vec3 warpP = vPosLocal * uPlasmaScale + vec3(0.0, pt, 0.0);
    vec3 warp = vec3(
      snoise(warpP),
      snoise(warpP + vec3(13.7, 4.1, 9.3)),
      snoise(warpP + vec3(31.1, 17.5, 5.2))
    ) * uPlasmaWarp;
    float field = fbm4(vPosLocal * uPlasmaScale + warp + vec3(0.0, pt, 0.0)) * 0.5 + 0.5;
    float sub = pow(field, max(uPlasmaCore, 0.05));

    /* --- 3. the room --- */
    vec3 refl = reflect(-V, N);
    vec3 env = sampleEnv(refl, uEnvRoughness) * uEnvIntensity;
    // Schlick: uReflectivity head-on, driven to a full mirror at the limb. The
    // filament cores are the one thing that suppresses it — a channel that is
    // actively conducting is not a mirror.
    float reflAmt = mix(clamp(uReflectivity, 0.0, 1.0), 1.0, fres) * (1.0 - arc.x * 0.55);

    /* --- 4. the key highlight --- */
    vec3 L = normalize(uLightDir);
    float spec = pow(max(dot(refl, L), 0.0), max(uSpecSharp, 1.0)) * uSpecular;
    float diff = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);

    /* --- the optional hex paneling --- */
    float hexLayer = 0.0;
    if (uHexIntensity > 1e-3 || uHexPulse > 1e-3) {
      vec2 hexUV = vec2(vSpherical.x * uRadius, vSpherical.y * uRadius * 1.6) * uHexScale;
      vec4 hex = hexCell(hexUV);
      float edge = 1.0 - smoothstep(0.0, uHexWidth, length(hex.xy));
      float panelHash = hash11(dot(hex.zw, vec2(12.3, 7.7)));
      float panelBreath = 0.5 + 0.5 * sin(uTime * 1.7 + panelHash * TAU);
      hexLayer = edge * (uHexIntensity * (0.4 + 0.6 * panelBreath) + uHexPulse * uPulse);
    }

    /* --- 5. the Fresnel light --- */
    // Two terms with different falloffs, each on its own power so the halo and
    // the edge can be shaped independently — sharing uFresnelPower with the
    // reflection above would tie the silhouette's look to how mirrored the
    // limb is. The wide one is the atmosphere the corona shell used to fake,
    // and because it is a function of the *body's* own normal it stays glued
    // to the silhouette instead of floating around it. The tight one is the
    // hard edge on the outline itself.
    float wide = pow(1.0 - ndv, max(uGlowPower, 0.05));
    float rimF = pow(1.0 - ndv, max(uRimPower, 0.05));
    float rimBand = smoothstep(1.0 - uRimWidth, 1.0, rimF + 0.2);

    /* --- assemble --- */
    // The shell: near black, lit only enough to hold a form where neither the
    // room nor the discharge is doing the work. Everything bright on this ball
    // is added on top of this.
    vec3 col = mix(uColorDeep, uColorShell, diff) * (0.25 + uShellDiffuse * diff);
    col += uColorMid * sub * uPlasmaIntensity * 0.12;

    // The room, and the glint off it.
    col += env * reflAmt;
    col += uColorCore * spec * reflAmt;

    // Panels, when they are switched on.
    col += uColorHex * hexLayer;

    // The discharge: a coloured bleed, then the white-hot filament on top of
    // it. The core is deliberately several times the glow — a thin line that
    // clips to white through the bloom is what reads as current.
    col += uColorArcGlow * arc.y * uArcIntensity;
    col += uColorArcCore * arc.x * uArcIntensity * 2.4;

    // The Fresnel light, and a lift where the discharge runs out to the limb.
    col += uColorOuter * wide * uGlowIntensity;
    col += uColorEdge * rimBand * uRimIntensity;
    col += uColorInner * fres * arc.y * uRimIntensity * 0.5;

    // Pulse: pushes the hot side toward white and lifts the whole ball.
    col = mix(col, uColorPulse, uPulse * 0.3);
    col *= 1.0 + uPulse * 0.7;
    col *= uGlow;

    // Soft ceiling. The room's HDR, the glint and the discharge all stack, and
    // the bloom downstream is happier with a rolloff than with a hard clamp:
    // this leaves anything under ~1 alone and asymptotes at 1/0.08.
    col /= 1.0 + col * 0.08;

    // Solid. The ball is an object, not a volume — the transparency the old
    // body leaned on is most of what made it read as smoke.
    float alpha = uOpacity * uFade;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * The ground platform shader.
 *
 * A flat disc on the floor that draws the same vocabulary as the sphere:
 * concentric containment rings, a hex grain, a hot inner band where the
 * sphere sits, and a pulse that breathes in time with the sphere above it.
 *
 * The disc is a `PlaneGeometry` rotated to lie on the floor; the fragment
 * shader works in the geometry's local 2D space and the radius is the
 * `uShellRadius` it shares with the sphere material.
 */
const PLATFORM_VERTEX = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // Metres from the disc's own centre. The geometry is a unit plane with the
    // -90° X rotation baked into its attributes, so its local coordinates are
    // (x, 0, z) spanning ±0.5 — position.xy is a degenerate axis, and a raw
    // local radius is in unit-plane space while every radius uniform below is
    // in metres. Going through the model matrix gives both a real second axis
    // and the scale, so uPlatformRadius and the ring spacing finally mean what
    // they say.
    vLocal = wp.xz - vec2(modelMatrix[3].x, modelMatrix[3].z);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const PLATFORM_FRAGMENT = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uFade;
  uniform float uPulse;
  uniform float uShellRadius;
  uniform float uPlatformRadius;

  uniform float uRingCount;
  uniform float uRingWidth;
  uniform float uRingGlow;
  uniform float uRingPulse;
  uniform float uInnerGlow;
  uniform float uInnerRadius;
  uniform float uHexScale;
  uniform float uHexIntensity;
  uniform float uPulseFrequency;

  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorRing;
  uniform vec3  uColorInner;
  uniform vec3  uColorEdge;
  uniform vec3  uColorHex;
  uniform vec3  uColorDeep;

  varying vec2 vLocal;

  ${noiseGLSL}
  ${commonGLSL}
  ${HEX_GLSL}

  void main() {
    vec2 p = vLocal;
    float r = length(p);
    if (r > uPlatformRadius) discard;
    float a = atan(p.y, p.x);
    float rn = r / max(uPlatformRadius, 0.01);

    /* --- concentric rings --- */
    float rings = 0.0;
    for (int i = 0; i < 16; i++) {
      if (float(i) >= uRingCount) break;
      float t = (float(i) + 0.5) / uRingCount;
      float ringR = t * uPlatformRadius;
      float d = abs(r - ringR);
      rings = max(rings, 1.0 - smoothstep(0.0, uRingWidth, d));
    }
    // Radar sweep — a single arc that crawls around the disc.
    float sweep = smoothstep(0.06, 0.0, abs(mod(a - uTime * 0.5, TAU) - PI)) * 0.6;

    /* --- the hot inner band, directly under the sphere --- */
    float inner = 1.0 - smoothstep(uInnerRadius * 0.4, uInnerRadius, r);
    inner *= mix(0.7, 1.0, uPulse * uRingPulse + 0.5);

    /* --- hex grain --- */
    vec2 hexUV = p * uHexScale;
    vec4 hex = hexCell(hexUV);
    float hexEdge = 1.0 - smoothstep(0.0, 0.06, length(hex.xy));
    float hexHash = hash11(dot(hex.zw, vec2(7.13, 113.17)));
    float hexBreath = 0.5 + 0.5 * sin(uTime * 1.3 + hexHash * TAU);
    float hexLayer = hexEdge * uHexIntensity * (0.3 + 0.7 * hexBreath);

    /* --- pulse rings travelling outward --- */
    float pulse = 0.0;
    float pTime = uTime * uPulseFrequency;
    for (int i = 0; i < 3; i++) {
      float phase = fract(pTime - float(i) * 0.33);
      float pr = phase * uPlatformRadius;
      float pd = abs(r - pr);
      pulse += (1.0 - phase) * (1.0 - smoothstep(0.0, 0.15, pd));
    }

    /* --- assembly --- */
    vec3 col = uColorDeep * 0.4;
    col += uColorRing * rings * uRingGlow;
    col += uColorRing * sweep * 0.4;
    col += uColorInner * inner * uInnerGlow;
    col += uColorEdge * inner * 1.4;
    col += uColorHex * hexLayer * 0.6;
    col += uColorEdge * pulse * 0.7;

    // Fade out toward the rim of the disc.
    float edgeFade = 1.0 - smoothstep(uPlatformRadius * 0.85, uPlatformRadius, r);
    float alpha = (rings * 0.4 + hexLayer * 0.3 + inner * 0.9 + pulse * 0.5) * edgeFade * uOpacity * uFade;
    if (alpha < 0.003) discard;

    col *= uGlow;
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * Build the body of the sphere.
 *
 * One material, one sphere geometry — this is now the *only* mesh the ball is
 * made of. It is an opaque object: it writes depth and draws front faces only,
 * which is what lets the bolts and the particles behind it sort correctly
 * against it instead of shining through the front of it.
 */
export function createSphereBodyMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    // The ball occludes: bolts and sparks that pass behind it must be hidden
    // by it, and additive VFX have no other way to know it is there.
    depthWrite: true,
    depthTest: true,
    blending: 2, // THREE.NormalBlending
    side: FrontSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uPulse: { value: 0 },

      uRadius: { value: 1.0 },

      // The room the ball is standing in.
      uEnvMap: frame.uEnvMap,
      uEnvIntensity: { value: 1.15 },
      uEnvRoughness: { value: 0.08 },
      uReflectivity: { value: 0.55 },
      uFresnelPower: { value: 2.6 },
      uSpecular: { value: 3.4 },
      uSpecSharp: { value: 220 },
      uShellDiffuse: { value: 0.3 },
      uShellRipple: { value: 3.0 },

      uPlasmaScale: { value: 2.4 },
      uPlasmaSpeed: { value: 0.45 },
      uPlasmaIntensity: { value: 0.5 },
      uPlasmaCore: { value: 2.2 },
      uPlasmaWarp: { value: 0.5 },

      uHexScale: { value: 6.0 },
      uHexWidth: { value: 0.18 },
      uHexIntensity: { value: 0.0 },
      uHexPulse: { value: 0.0 },

      uArcScale: { value: 3.2 },
      uArcSpeed: { value: 0.6 },
      uArcCrawl: { value: 0.5 },
      uArcWidth: { value: 0.07 },
      uArcGlowWidth: { value: 0.16 },
      uArcIntensity: { value: 1.6 },
      uArcFlicker: { value: 0.35 },
      uArcRestrike: { value: 5.0 },
      uArcWarp: { value: 0.6 },
      uArcCharge: { value: 0.7 },

      uRimPower: { value: 2.6 },
      uRimIntensity: { value: 2.2 },
      uRimWidth: { value: 0.45 },
      uGlowPower: { value: 4.0 },
      uGlowIntensity: { value: 1.6 },

      uDistortion: { value: 0.12 },
      uOpacity: { value: 1.0 },
      uGlow: { value: 1.2 },

      uColorShell: { value: new Color(0.05, 0.04, 0.045) },
      uColorDeep: { value: new Color(0.012, 0.008, 0.01) },
      uColorCore: { value: new Color(1, 0.97, 0.85) },
      uColorInner: { value: new Color(1, 0.82, 0.4) },
      uColorMid: { value: new Color(1, 0.45, 0.12) },
      uColorOuter: { value: new Color(1, 0.25, 0.06) },
      uColorEdge: { value: new Color(1, 0.15, 0.03) },
      uColorArcCore: { value: new Color(1, 1, 0.95) },
      uColorArcGlow: { value: new Color(1, 0.55, 0.1) },
      uColorHex: { value: new Color(1, 0.65, 0.2) },
      uColorPulse: { value: new Color(1, 1, 0.92) }
    }),
    vertexShader: SPHERE_VERTEX,
    fragmentShader: SPHERE_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.electrical;
    const g = settings.global;
    const u = material.uniforms;

    u.uSeed.value = state.seed;
    u.uFade.value = state.fade;
    u.uPulse.value = state.pulse;
    u.uRadius.value = state.sphereRadius;

    u.uEnvIntensity.value = c.envIntensity * g.shaderIntensity;
    u.uEnvRoughness.value = c.envRoughness;
    u.uReflectivity.value = c.reflectivity;
    u.uFresnelPower.value = c.fresnelPower;
    u.uSpecular.value = c.specular * g.shaderIntensity;
    u.uSpecSharp.value = c.specSharp;
    u.uShellDiffuse.value = c.shellDiffuse;
    u.uShellRipple.value = c.shellRipple * g.noiseFrequency;

    u.uPlasmaScale.value = c.plasmaScale * g.noiseFrequency;
    u.uPlasmaSpeed.value = c.plasmaSpeed * g.noiseSpeed;
    u.uPlasmaIntensity.value = c.plasmaIntensity * g.shaderIntensity;
    u.uPlasmaCore.value = c.plasmaCore;
    u.uPlasmaWarp.value = c.plasmaWarp * g.noiseStrength;

    u.uHexScale.value = c.hexScale;
    u.uHexWidth.value = c.hexWidth;
    u.uHexIntensity.value = c.hexIntensity * g.shaderIntensity;
    u.uHexPulse.value = c.hexPulse;

    u.uArcScale.value = c.surfaceArcScale * g.noiseFrequency;
    u.uArcSpeed.value = c.surfaceArcSpeed * g.noiseSpeed;
    u.uArcCrawl.value = c.surfaceArcCrawl;
    u.uArcWidth.value = c.surfaceArcWidth;
    u.uArcGlowWidth.value = c.surfaceArcGlowWidth;
    u.uArcIntensity.value = c.surfaceArcIntensity * g.shaderIntensity;
    u.uArcFlicker.value = c.surfaceArcFlicker;
    u.uArcRestrike.value = c.surfaceArcRestrike;
    u.uArcWarp.value = c.surfaceArcWarp * g.noiseStrength;
    u.uArcCharge.value = c.surfaceArcCharge;

    u.uRimPower.value = c.rimPower;
    u.uRimIntensity.value = c.rimIntensity * g.shaderIntensity;
    u.uRimWidth.value = c.rimWidth;
    u.uGlowPower.value = c.fresnelGlowPower;
    u.uGlowIntensity.value = c.fresnelGlow * g.shaderIntensity;

    u.uDistortion.value = c.distortion;
    u.uOpacity.value = c.opacity * g.opacity;
    u.uGlow.value = c.glow * g.glow * g.shaderIntensity;

    // A solid ball occludes; a ball that is halfway through its collapse must
    // not, or it goes on punching a hole in the bolts and sparks behind it
    // long after it has stopped being visible.
    material.depthWrite = u.uOpacity.value * state.fade > 0.5;

    u.uColorShell.value.copy(getColor(c.colorShell));
    u.uColorDeep.value.copy(getColor(c.colorDeep));
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorInner.value.copy(getColor(c.colorInner));
    u.uColorMid.value.copy(getColor(c.colorMid));
    u.uColorOuter.value.copy(getColor(c.colorOuter));
    u.uColorEdge.value.copy(getColor(c.colorEdge));
    u.uColorArcCore.value.copy(getColor(c.colorSurfaceArcCore));
    u.uColorArcGlow.value.copy(getColor(c.colorSurfaceArcGlow));
    u.uColorHex.value.copy(getColor(c.colorHex));
    u.uColorPulse.value.copy(getColor(c.colorPulse));
  };

  return material;
}

export function createPlatformMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: 2, // NormalBlending
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uTime: { value: 0 },
      uFade: { value: 1 },
      uPulse: { value: 0 },
      uShellRadius: { value: 1.0 },
      uPlatformRadius: { value: 6.0 },
      uRingCount: { value: 8.0 },
      uRingWidth: { value: 0.08 },
      uRingGlow: { value: 0.8 },
      uRingPulse: { value: 0.5 },
      uInnerGlow: { value: 1.0 },
      uInnerRadius: { value: 1.2 },
      uHexScale: { value: 4.0 },
      uHexIntensity: { value: 0.4 },
      uPulseFrequency: { value: 0.7 },
      uOpacity: { value: 1.0 },
      uGlow: { value: 1.2 },
      uColorRing: { value: new Color(1, 0.55, 0.15) },
      uColorInner: { value: new Color(1, 0.4, 0.1) },
      uColorEdge: { value: new Color(1, 0.15, 0.03) },
      uColorHex: { value: new Color(1, 0.5, 0.15) },
      uColorDeep: { value: new Color(0.08, 0.02, 0.01) }
    }),
    vertexShader: PLATFORM_VERTEX,
    fragmentShader: PLATFORM_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.electrical;
    const g = settings.global;
    const u = material.uniforms;

    u.uFade.value = state.fade;
    u.uPulse.value = state.pulse;
    u.uShellRadius.value = state.shellRadius;
    u.uPlatformRadius.value = c.platformRadius;
    u.uRingCount.value = Math.min(16, Math.max(0, Math.round(c.platformRings)));
    u.uRingWidth.value = c.platformRingWidth;
    u.uRingGlow.value = c.platformRingGlow * g.shaderIntensity;
    u.uRingPulse.value = c.pulseStrength;
    u.uInnerGlow.value = c.platformInnerGlow * g.shaderIntensity;
    u.uInnerRadius.value = state.shellRadius + c.platformInnerPad;
    u.uHexScale.value = c.platformHexScale;
    u.uHexIntensity.value = c.platformHexIntensity * g.shaderIntensity;
    u.uPulseFrequency.value = c.pulseFrequency;
    u.uOpacity.value = c.platformOpacity * g.opacity;
    u.uGlow.value = c.platformGlow * g.glow;

    u.uColorRing.value.copy(getColor(c.colorPlatformRing));
    u.uColorInner.value.copy(getColor(c.colorPlatformInner));
    u.uColorEdge.value.copy(getColor(c.colorEdge));
    u.uColorHex.value.copy(getColor(c.colorPlatformHex));
    u.uColorDeep.value.copy(getColor(c.colorPlatformDeep));
  };

  return material;
}
