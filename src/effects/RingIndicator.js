import {
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  AdditiveBlending,
  Color,
  DoubleSide
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { ReachRing } from './ReachRing.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing } from '../utils/math.js';

/**
 * The **ring SDF**, shared by the ghost here and by the rift surface itself.
 *
 * `p` is in metres from the middle of the ring, in the ring's own plane.
 * Positive is inside the opening, so the sign convention matches `ARCH_SDF`
 * and both surfaces can be written against the same `d`.
 *
 * The contour is not a circle. A true circle is the one shape that reads as
 * *drawn* rather than as *made* — nothing forged is that perfect — so the
 * radius is modulated by a few shallow lobes. `lobeDepth` is small by default
 * (a few per cent), which is enough for the silhouette to catch the light
 * unevenly and not nearly enough to stop it reading as a ring.
 *
 * The value is the radial distance to the contour rather than the true
 * Euclidean one; with lobes this shallow the two differ by less than the width
 * of the line either shader draws with it.
 */
export const RING_SDF = /* glsl */ `
  float ringRadiusAt(float angle, float radius, float lobes, float lobeDepth) {
    return radius * (1.0 + lobeDepth * cos(angle * lobes));
  }

  float ringDistance(vec2 p, float radius, float lobes, float lobeDepth) {
    return ringRadiusAt(atan(p.y, p.x), radius, lobes, lobeDepth) - length(p);
  }

  /**
   * Where a point sits along the contour, signed, measured **from the bottom**.
   *
   * 0 is the foot of the ring, ±1 the crown, and the sign is which way round
   * you got there — the exact parameter the segments are laid and ordered by,
   * so the runes light in step with the stone that carries them.
   */
  float ringContour(vec2 p) {
    float t = (atan(p.y, p.x) + 1.5707963) / 3.14159265;
    return t > 1.0 ? -(2.0 - t) : t;
  }
`;

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The sigil: the disc of floor the ring is assembled on.
 *
 * Not a footprint in the far-cast sense. The ring is *built lying down* and
 * then stood up, so this circle is not an area of effect — it is the workshop
 * floor, and every mark on it is a real measurement of the ring that will be
 * laid there: the contour band is the ring's own lobed silhouette, the ticks
 * around it are the segments, and the spokes are the courses stacked outward.
 */
const SIGIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;    // metres across the quad
  uniform float uRadius;      // ring radius, metres
  uniform float uLobes;
  uniform float uLobeDepth;
  uniform float uBand;        // thickness of the contour band, metres
  uniform float uGlow;
  uniform float uSoftness;
  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uSpokes;
  uniform float uSpokeWidth;
  uniform float uSpokeLength;
  uniform float uTicks;
  uniform float uTickWidth;
  uniform float uTickLength;
  uniform float uSpin;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uReveal;
  uniform float uSweep;       // 0..1 how far round the contour has been drawn
  uniform float uInvalid;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}
  ${RING_SDF}

  #define TAU 6.28318530718

  void main() {
    vec2 p = (vUv - 0.5) * uQuadSize;
    float turn = uTime * uSpin * TAU;
    // Everything but the reveal is drawn in a slowly turning frame, so the
    // sigil reads as a mechanism idling rather than as a decal.
    vec2 q = vec2(p.x * cos(turn) - p.y * sin(turn), p.x * sin(turn) + p.y * cos(turn));

    float d = ringDistance(q, max(0.1, uRadius), uLobes, uLobeDepth);

    // The sigil is drawn *from the foot of the ring outward in both
    // directions* — the order the segments will arrive in.
    float contour = abs(ringContour(q));
    float drawn = smoothstep(uSweep + 0.12, uSweep - 0.08, contour);

    float aa = fwidth(d) + uSoftness;
    if (d < -uBand - uTickLength - aa * 3.0) discard;

    float band = (1.0 - smoothstep(uBand - aa, uBand + aa, abs(d))) * uGlow * drawn;

    // Ticks stepping outward from the band: one per segment of the ring.
    float cell = fract(contour * max(1.0, uTicks));
    float tick = (1.0 - smoothstep(uTickWidth, uTickWidth + 0.08, abs(cell - 0.5)))
               * (1.0 - smoothstep(0.0, uTickLength, max(-d - uBand, 0.0)))
               * step(-d, uTickLength + uBand) * step(0.0, -d) * drawn;

    // Spokes: the courses, read inward from the contour.
    float spokePhase = fract(atan(q.y, q.x) / TAU * max(1.0, uSpokes));
    float spoke = (1.0 - smoothstep(uSpokeWidth, uSpokeWidth + 0.1, abs(spokePhase - 0.5)))
                * smoothstep(0.0, 0.35, d / max(0.05, uRadius))
                * smoothstep(uSpokeLength, uSpokeLength * 0.55, d / max(0.05, uRadius))
                * drawn;

    float interior = smoothstep(-aa, aa, d) * drawn;
    float wash = pow(clamp(1.0 - d / max(0.2, uRadius), 0.0, 1.0), uFillFalloff);
    float n = fbm3(vec3(p * uNoiseScale, uTime * 0.3)) * 0.5 + 0.5;
    wash *= mix(1.0, n, uNoise);

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float fill = interior * wash * uFill;
    float lines = (band + tick * 0.8 + spoke * 0.45) * breathe;

    float alpha = clamp(fill + lines, 0.0, 1.0) * uOpacity * uReveal;
    if (alpha < 0.004) discard;

    vec3 color = uColorEdge * fill + uColorCore * lines;
    color = mix(color, uColorInvalid * (fill + lines), uInvalid);
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The ghost: the ring itself, in the plane it will end up in.
 *
 * The gate template stands its silhouette up and leaves it standing, because a
 * doorway is built where it stands. This one is drawn *lying on the sigil* and
 * **tips upright as the cast arms** — the preview performs the animation the
 * cast is about to perform, which is the only honest way to promise a thing
 * that arrives flat and then stands.
 */
const GHOST_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uLobes;
  uniform float uLobeDepth;
  uniform float uLine;
  uniform float uGlow;
  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uDashes;      // dashes per metre along the contour
  uniform float uDashGap;
  uniform float uScroll;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uReveal;
  uniform float uInvalid;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}
  ${RING_SDF}

  #define TAU 6.28318530718

  void main() {
    vec2 p = (vUv - 0.5) * uQuadSize;
    float d = ringDistance(p, max(0.1, uRadius), uLobes, uLobeDepth);

    float aa = fwidth(d) + 0.012;
    if (d < -uLine - aa * 3.0) discard;

    float line = 1.0 - smoothstep(uLine - aa, uLine + aa, abs(d));
    if (uDashes > 0.05) {
      // Arc length round the contour, in metres, so the dash spacing is a real
      // measurement and does not stretch with the radius.
      float along = ringContour(p) * 3.14159265 * max(0.1, uRadius);
      float phase = fract((along - uTime * uScroll) * uDashes);
      line *= mix(0.35, 1.0, 1.0 - smoothstep(1.0 - uDashGap, 1.0 - uDashGap + 0.15, phase));
    }

    float interior = smoothstep(-aa, aa, d);
    float wash = pow(clamp(1.0 - d / max(0.2, uRadius), 0.0, 1.0), uFillFalloff);
    float n = fbm3(vec3(p * uNoiseScale, uTime * 0.25)) * 0.5 + 0.5;
    wash *= mix(1.0, n, uNoise);

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float fill = interior * wash * uFill;
    float lines = line * uGlow * breathe;

    float alpha = clamp(fill + lines, 0.0, 1.0) * uOpacity * uReveal;
    if (alpha < 0.004) discard;

    vec3 color = uColorEdge * fill + uColorCore * lines;
    color = mix(color, uColorInvalid * (fill + lines), uInvalid);
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The indicator drawn while a **ring cast** is armed.
 *
 * The fourth targeting shape, and the first one that shows a *sequence* rather
 * than a shape. An arrow answers "which way"; a circle answers "how much
 * ground"; the gate template answers "what will be standing here". A ring
 * arrives lying down and then stands up, and neither half of that on its own is
 * the promise — so the template draws both at once: the sigil it will be
 * assembled on, and the ghost tipping up out of it as the cast arms.
 *
 * Everything is measured off the ability's own `ringRadius` and `ringHover`, so
 * the preview and the built ring can never disagree.
 */
export class RingIndicator {
  constructor() {
    this.group = new Group();
    this.group.name = 'RingIndicator';
    this.group.matrixAutoUpdate = false;

    /* ---- the sigil, flat on the floor ---- */
    this.sigilGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.sigilMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uQuadSize: { value: 6 },
        uRadius: { value: 2 },
        uLobes: { value: 6 },
        uLobeDepth: { value: 0.03 },
        uBand: { value: 0.16 },
        uGlow: { value: 2.3 },
        uSoftness: { value: 0.05 },
        uFill: { value: 0.16 },
        uFillFalloff: { value: 1.6 },
        uSpokes: { value: 12 },
        uSpokeWidth: { value: 0.16 },
        uSpokeLength: { value: 0.55 },
        uTicks: { value: 24 },
        uTickWidth: { value: 0.35 },
        uTickLength: { value: 0.3 },
        uSpin: { value: 0.05 },
        uNoise: { value: 0.3 },
        uNoiseScale: { value: 1.2 },
        uPulse: { value: 0.22 },
        uPulseSpeed: { value: 2 },
        uReveal: { value: 0 },
        uSweep: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.92, 0.99, 1) },
        uColorEdge: { value: new Color(0.18, 0.85, 1) },
        uColorInvalid: { value: new Color(1, 0.41, 0.36) }
      }),
      vertexShader: QUAD_VERTEX,
      fragmentShader: SIGIL_FRAGMENT
    });

    this.sigil = new Mesh(this.sigilGeometry, this.sigilMaterial);
    this.sigil.name = 'RingSigil';
    this.sigil.layers.set(LAYER.VFX);
    this.sigil.renderOrder = 5;
    this.sigil.frustumCulled = false;

    /* ---- the ghost, tipping up out of it ---- */
    // Centred quad in XY: the ring has no bottom edge to stand on, so unlike
    // the gate's ghost this one is placed by its middle.
    this.ghostGeometry = new PlaneGeometry(1, 1, 1, 1);
    this.ghostMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uQuadSize: { value: 6 },
        uRadius: { value: 2 },
        uLobes: { value: 6 },
        uLobeDepth: { value: 0.03 },
        uLine: { value: 0.07 },
        uGlow: { value: 2 },
        uFill: { value: 0.12 },
        uFillFalloff: { value: 1.5 },
        uDashes: { value: 2.2 },
        uDashGap: { value: 0.45 },
        uScroll: { value: 0.8 },
        uNoise: { value: 0.3 },
        uNoiseScale: { value: 1.2 },
        uPulse: { value: 0.22 },
        uPulseSpeed: { value: 2 },
        uReveal: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.92, 0.99, 1) },
        uColorEdge: { value: new Color(0.18, 0.85, 1) },
        uColorInvalid: { value: new Color(1, 0.41, 0.36) }
      }),
      vertexShader: QUAD_VERTEX,
      fragmentShader: GHOST_FRAGMENT
    });

    this.ghost = new Mesh(this.ghostGeometry, this.ghostMaterial);
    this.ghost.name = 'RingGhost';
    this.ghost.layers.set(LAYER.VFX);
    this.ghost.renderOrder = 6;
    this.ghost.frustumCulled = false;

    this.reach = new ReachRing(settings.ring);

    this.group.add(this.sigil, this.ghost, this.reach.object3D);
    this.group.visible = false;
  }

  get object3D() {
    return this.group;
  }

  /**
   * Place and re-shape the template.
   *
   * @param {THREE.Vector3} origin the caster's feet
   * @param {number} yaw       heading of the aim, radians about +Y — the way
   *                           the ring will face once it is up
   * @param {number} distance  how far out the site is, metres
   * @param {number} radius    the ability's ring radius, metres
   * @param {number} hover     how far the foot of the ring clears the floor
   * @param {number} range     the ability's maximum reach, metres
   * @param {number} reveal    0..1 draw-out
   * @param {boolean} valid    false tints the template to `colorInvalid`
   */
  update(origin, yaw, distance, radius, hover, range, reveal, valid) {
    const g = settings.ring;
    const opacity = g.opacity * settings.global.opacity;
    const invalid = valid ? 0 : 1;
    const t = saturate(reveal);

    const x = origin.x + Math.sin(yaw) * distance;
    const z = origin.z + Math.cos(yaw) * distance;
    const outer = radius * (1 + g.lobeDepth) + g.band + g.tickLength + 0.4;

    /* ---- the sigil ---- */
    const quadSize = outer * 2;
    const u = this.sigilMaterial.uniforms;

    u.uQuadSize.value = quadSize;
    u.uRadius.value = radius;
    u.uLobes.value = Math.max(0, Math.round(g.lobes));
    u.uLobeDepth.value = g.lobeDepth;
    u.uBand.value = g.band;
    u.uGlow.value = g.bandGlow;
    u.uSoftness.value = g.softness;
    u.uFill.value = g.fill;
    u.uFillFalloff.value = g.fillFalloff;
    u.uSpokes.value = Math.max(1, Math.round(g.spokes));
    u.uSpokeWidth.value = g.spokeWidth;
    u.uSpokeLength.value = g.spokeLength;
    u.uTicks.value = Math.max(1, Math.round(g.ticks));
    u.uTickWidth.value = g.tickWidth;
    u.uTickLength.value = g.tickLength;
    u.uSpin.value = g.spin;
    u.uNoise.value = g.noise;
    u.uNoiseScale.value = g.noiseScale;
    u.uPulse.value = g.pulse;
    u.uPulseSpeed.value = g.pulseSpeed;
    u.uReveal.value = t;
    // The contour is swept out from the foot of the ring over the first part of
    // the reveal, which is the order the segments will arrive in.
    u.uSweep.value = Easing.outCubic(saturate(t / Math.max(0.05, g.sweep)));
    u.uInvalid.value = invalid;
    u.uOpacity.value = opacity;
    u.uColorCore.value.copy(getColor(g.colorCore));
    u.uColorEdge.value.copy(getColor(g.colorEdge));
    u.uColorInvalid.value.copy(getColor(g.colorInvalid));

    this.sigil.position.set(x, g.height, z);
    this.sigil.rotation.set(0, yaw, 0);
    this.sigil.scale.set(quadSize, 1, quadSize);

    /* ---- the ghost ---- */
    const ghostSize = (radius * (1 + g.lobeDepth) + g.ghostLine + 0.35) * 2;
    const v = this.ghostMaterial.uniforms;

    v.uQuadSize.value = ghostSize;
    v.uRadius.value = radius;
    v.uLobes.value = Math.max(0, Math.round(g.lobes));
    v.uLobeDepth.value = g.lobeDepth;
    v.uLine.value = g.ghostLine;
    v.uGlow.value = g.ghostGlow * g.ghost;
    v.uFill.value = g.ghostFill * g.ghost;
    v.uFillFalloff.value = g.ghostFillFalloff;
    v.uDashes.value = g.ghostDashes;
    v.uDashGap.value = g.ghostDashGap;
    v.uScroll.value = g.ghostScroll;
    v.uNoise.value = g.ghostNoise;
    v.uNoiseScale.value = g.ghostNoiseScale;
    v.uPulse.value = g.pulse;
    v.uPulseSpeed.value = g.pulseSpeed;
    v.uReveal.value = t;
    v.uInvalid.value = invalid;
    v.uOpacity.value = opacity;
    v.uColorCore.value.copy(getColor(g.colorCore));
    v.uColorEdge.value.copy(getColor(g.colorEdge));
    v.uColorInvalid.value.copy(getColor(g.colorInvalid));

    // The tip-up. `rise` runs over the tail of the reveal so the ring is drawn
    // lying on the sigil first and only then swings upright — and it is the
    // same `outBack` settle the cast itself uses, so arming rehearses it.
    const rise = Easing.outBack(saturate((t - (1 - g.ghostRise)) / Math.max(0.05, g.ghostRise)));
    const pitch = -Math.PI * 0.5 * (1 - rise);
    const lift = 0.01 + rise * (radius * (1 + g.lobeDepth) + hover);

    this.ghost.position.set(x, lift, z);
    // 'YXZ': the yaw is applied first, so the pitch that follows is about the
    // *ring's* own lateral axis — the hinge it will actually tip on.
    this.ghost.rotation.set(pitch, yaw, 0, 'YXZ');
    this.ghost.scale.set(ghostSize, ghostSize, 1);
    this.ghost.visible = g.ghost > 0.001;

    /* ---- the reach ring ---- */
    this.reach.update(origin, yaw, range, t, valid);
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  dispose() {
    this.sigilGeometry.dispose();
    this.sigilMaterial.dispose();
    this.ghostGeometry.dispose();
    this.ghostMaterial.dispose();
    this.reach.dispose();
  }
}
