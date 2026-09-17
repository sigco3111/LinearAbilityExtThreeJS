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
 * The **arch SDF**, shared by the ghost here and by the portal surface itself.
 *
 * `p` is in metres from the middle of the threshold, `p.y` up. Positive is
 * inside the opening, and the value is the true distance to the contour, so a
 * line of a given thickness stays that thickness whether the gate is 2 m or
 * 6 m across — the same promise the arrow and the circle make.
 *
 * The opening is a doorway: two parallel jambs up to the springing line, a
 * semicircle of radius `hw` on top of them. Below the floor there is nothing to
 * measure, so `p.y` is clamped and the bottom stays open.
 */
export const ARCH_SDF = /* glsl */ `
  float archDistance(vec2 p, float hw, float spring) {
    return p.y <= spring
      ? hw - abs(p.x)
      : hw - length(vec2(p.x, p.y - spring));
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
 * The threshold: the ground slot the gate will stand in.
 *
 * One quad, remapped into metres, with `p.x` across the opening and `p.y`
 * through the wall. It draws a rounded slot the width of the span, a heavy pad
 * under each jamb — the two places that actually carry stone — and rungs laid
 * across it, so the footprint reads as a doorway rather than a stripe.
 */
const THRESHOLD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadW;
  uniform float uQuadD;
  uniform float uHalfWidth;   // half the clear span, metres
  uniform float uDepth;       // half-depth of the slot, metres
  uniform float uJambPad;
  uniform float uEdge;
  uniform float uEdgeGlow;
  uniform float uSoftness;
  uniform float uFill;
  uniform float uTicks;
  uniform float uTickWidth;
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

  #define TAU 6.28318530718

  float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  void main() {
    vec2 p = vec2((vUv.x - 0.5) * uQuadW, (vUv.y - 0.5) * uQuadD);

    // The slot sweeps open from the middle of the span outward, so the
    // threshold is drawn *by* the caster rather than switched on.
    float span = uHalfWidth * Easing_outCubic(uReveal);

    float slot = sdBox(p, vec2(span, uDepth)) - 0.1;
    float padL = length(p - vec2(-span, 0.0)) - uJambPad;
    float padR = length(p - vec2( span, 0.0)) - uJambPad;
    float d = min(slot, min(padL, padR));

    float aa = fwidth(d) + uSoftness;
    if (d > uEdge + aa * 3.0) discard;

    float outline = (1.0 - smoothstep(uEdge - aa, uEdge + aa, abs(d))) * uEdgeGlow;
    float interior = smoothstep(aa, -aa, d);

    // Rungs across the slot: the stones will land on a spacing, and the rungs
    // are the reading of that spacing before anything is built.
    float rung = 0.0;
    if (uTicks > 0.5) {
      float phase = fract((p.x / max(0.05, span * 2.0) + 0.5) * uTicks);
      rung = (1.0 - smoothstep(uTickWidth, uTickWidth + 0.05, abs(phase - 0.5)))
             * interior * smoothstep(0.0, 0.35, 1.0 - abs(p.y) / max(0.05, uDepth));
    }

    // A centre line down the middle of the wall — where the surface will hang.
    float spine = (1.0 - smoothstep(0.02, 0.05, abs(p.y))) * interior;

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float fill = interior * uFill;
    float lines = (outline + rung * 0.7 + spine * 0.5) * breathe;

    float alpha = clamp(fill + lines, 0.0, 1.0) * uOpacity * uReveal;
    if (alpha < 0.004) discard;

    vec3 color = uColorEdge * fill + uColorCore * lines;
    color = mix(color, uColorInvalid * (fill + lines), uInvalid);
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The ghost: the arch itself, standing upright in the gate's own plane.
 *
 * This is the part a line or a circle cannot say. The contour is the exact one
 * the stones will be laid along — the same `archDistance` the portal surface
 * uses — drawn as a dashed line that climbs toward the keystone, over a wash
 * that fills the opening. It draws itself from the floor up as the cast is
 * armed, which is the same order the gate will be built in.
 */
const GHOST_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadW;
  uniform float uQuadH;
  uniform float uHalfWidth;
  uniform float uSpring;
  uniform float uLine;
  uniform float uGlow;
  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uDashes;
  uniform float uDashGap;
  uniform float uScroll;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uReveal;      // 0..1 overall
  uniform float uDraw;        // 0..1 how far up the contour has been drawn
  uniform float uInvalid;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}
  ${ARCH_SDF}

  #define TAU 6.28318530718

  void main() {
    vec2 p = vec2((vUv.x - 0.5) * uQuadW, vUv.y * uQuadH);

    float hw = max(0.05, uHalfWidth);
    float spring = max(0.05, uSpring);
    float d = archDistance(p, hw, spring);

    float aa = fwidth(d) + 0.012;
    if (d < -uLine - aa * 3.0) discard;

    /* --- how far up the contour we have got --- */
    // Arc length from the floor, along the jamb and then round the arch, in
    // metres — the same parameter the stones are ordered by when they fly in.
    float along = p.y <= spring
      ? p.y
      : spring + atan(max(p.y - spring, 0.0), max(abs(p.x), 1e-4)) * hw;
    float total = spring + hw * 1.5708;
    float drawn = smoothstep(uDraw * total + 0.35, uDraw * total - 0.25, along);

    /* --- the contour line, dashed and climbing --- */
    float line = 1.0 - smoothstep(uLine - aa, uLine + aa, abs(d));
    float dash = 1.0;
    if (uDashes > 0.05) {
      float phase = fract((along - uTime * uScroll) * uDashes);
      dash = 1.0 - smoothstep(1.0 - uDashGap, 1.0 - uDashGap + 0.15, phase);
    }
    line *= mix(0.35, 1.0, dash) * drawn;

    /* --- the wash inside the opening --- */
    float interior = smoothstep(-aa, aa, d) * drawn;
    // Weighted to the contour, not the middle: what is being promised is where
    // the stone goes, and a flat panel of light reads as a wall.
    float wash = pow(clamp(1.0 - d / max(0.2, hw), 0.0, 1.0), uFillFalloff);
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
 * The indicator drawn while a **gate cast** is armed.
 *
 * Three meshes, no textures, everything in metres: the threshold on the floor,
 * the arch ghost standing in the gate's plane, and the shared reach ring at the
 * caster's feet. All three are rebuilt from `settings.gate` and the ability's
 * own `gateWidth` / `gateHeight` every frame, so dragging the span of a gate
 * that has not been cast yet re-shapes the promise under the cursor.
 *
 * The ghost is what makes this a different template rather than a differently
 * coloured circle: a structure has a *facing*, and the only honest way to show
 * a facing is to stand the silhouette up and let the camera see it edge-on when
 * you are about to build it edge-on.
 */
export class GateIndicator {
  constructor() {
    this.group = new Group();
    this.group.name = 'GateIndicator';
    this.group.matrixAutoUpdate = false;

    /* ---- the threshold, flat on the floor ---- */
    // Unit square in the ground plane: local +Z runs through the wall, local +X
    // across the span, so placing it is a yaw and a scale.
    this.thresholdGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.thresholdMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uQuadW: { value: 6 },
        uQuadD: { value: 3 },
        uHalfWidth: { value: 1.8 },
        uDepth: { value: 0.55 },
        uJambPad: { value: 0.62 },
        uEdge: { value: 0.075 },
        uEdgeGlow: { value: 2.4 },
        uSoftness: { value: 0.05 },
        uFill: { value: 0.24 },
        uTicks: { value: 9 },
        uTickWidth: { value: 0.055 },
        uPulse: { value: 0.2 },
        uPulseSpeed: { value: 1.8 },
        uReveal: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.95, 1, 0.85) },
        uColorEdge: { value: new Color(0.43, 0.88, 0.16) },
        uColorInvalid: { value: new Color(1, 0.41, 0.36) }
      }),
      vertexShader: QUAD_VERTEX,
      fragmentShader: `
        float Easing_outCubic(float t) { return 1.0 - pow(1.0 - clamp(t, 0.0, 1.0), 3.0); }
        ${THRESHOLD_FRAGMENT}
      `
    });

    this.threshold = new Mesh(this.thresholdGeometry, this.thresholdMaterial);
    this.threshold.name = 'GateThreshold';
    this.threshold.layers.set(LAYER.VFX);
    this.threshold.renderOrder = 5;
    this.threshold.frustumCulled = false;

    /* ---- the arch ghost, upright in the gate's plane ---- */
    // Unit square in XY with its bottom edge on the floor: local +X is across
    // the span and local +Z is the gate's facing, so placing it is the same yaw.
    this.ghostGeometry = new PlaneGeometry(1, 1, 1, 1).translate(0, 0.5, 0);
    this.ghostMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uQuadW: { value: 6 },
        uQuadH: { value: 5 },
        uHalfWidth: { value: 1.8 },
        uSpring: { value: 2.5 },
        uLine: { value: 0.075 },
        uGlow: { value: 2.2 },
        uFill: { value: 0.14 },
        uFillFalloff: { value: 1.4 },
        uDashes: { value: 1.6 },
        uDashGap: { value: 0.42 },
        uScroll: { value: 1.1 },
        uNoise: { value: 0.35 },
        uNoiseScale: { value: 1.3 },
        uPulse: { value: 0.2 },
        uPulseSpeed: { value: 1.8 },
        uReveal: { value: 0 },
        uDraw: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.95, 1, 0.85) },
        uColorEdge: { value: new Color(0.43, 0.88, 0.16) },
        uColorInvalid: { value: new Color(1, 0.41, 0.36) }
      }),
      vertexShader: QUAD_VERTEX,
      fragmentShader: GHOST_FRAGMENT
    });

    this.ghost = new Mesh(this.ghostGeometry, this.ghostMaterial);
    this.ghost.name = 'GateGhost';
    this.ghost.layers.set(LAYER.VFX);
    this.ghost.renderOrder = 6;
    this.ghost.frustumCulled = false;

    /* ---- the reach ring ---- */
    this.reach = new ReachRing(settings.gate);

    this.group.add(this.threshold, this.ghost, this.reach.object3D);
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
   *                           the gate will face
   * @param {number} distance  how far out the site is, metres
   * @param {number} width     the ability's clear span, metres
   * @param {number} height    the ability's springing line, metres
   * @param {number} range     the ability's maximum reach, metres
   * @param {number} reveal    0..1 draw-out
   * @param {boolean} valid    false tints the template to `colorInvalid`
   */
  update(origin, yaw, distance, width, height, range, reveal, valid) {
    const g = settings.gate;
    const opacity = g.opacity * settings.global.opacity;
    const invalid = valid ? 0 : 1;
    const t = saturate(reveal);

    const halfWidth = Math.max(0.1, width * 0.5);
    const spring = Math.max(0.1, height);

    const x = origin.x + Math.sin(yaw) * distance;
    const z = origin.z + Math.cos(yaw) * distance;

    /* ---- the threshold ---- */
    const quadW = (halfWidth + g.jambPad + 0.4) * 2;
    const quadD = (g.thresholdDepth + g.jambPad + 0.4) * 2;
    const u = this.thresholdMaterial.uniforms;

    u.uQuadW.value = quadW;
    u.uQuadD.value = quadD;
    u.uHalfWidth.value = halfWidth;
    u.uDepth.value = g.thresholdDepth;
    u.uJambPad.value = g.jambPad;
    u.uEdge.value = g.edge;
    u.uEdgeGlow.value = g.edgeGlow;
    u.uSoftness.value = g.softness;
    u.uFill.value = g.fill;
    u.uTicks.value = Math.max(0, Math.round(g.ticks));
    u.uTickWidth.value = g.tickWidth;
    u.uPulse.value = g.pulse;
    u.uPulseSpeed.value = g.pulseSpeed;
    u.uReveal.value = t;
    u.uInvalid.value = invalid;
    u.uOpacity.value = opacity;
    u.uColorCore.value.copy(getColor(g.colorCore));
    u.uColorEdge.value.copy(getColor(g.colorEdge));
    u.uColorInvalid.value.copy(getColor(g.colorInvalid));

    this.threshold.position.set(x, g.height, z);
    this.threshold.rotation.set(0, yaw, 0);
    this.threshold.scale.set(quadW, 1, quadD);

    /* ---- the arch ghost ---- */
    const ghostW = (halfWidth + 0.5) * 2;
    const ghostH = spring + halfWidth + 0.6;
    const v = this.ghostMaterial.uniforms;

    v.uQuadW.value = ghostW;
    v.uQuadH.value = ghostH;
    v.uHalfWidth.value = halfWidth;
    v.uSpring.value = spring;
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
    // The contour is drawn floor-upward over the first `ghostRise` of the
    // reveal and then holds, so arming reads as the gate being *sketched*.
    v.uDraw.value = Easing.outCubic(saturate(t / Math.max(0.05, g.ghostRise)));
    v.uInvalid.value = invalid;
    v.uOpacity.value = opacity;
    v.uColorCore.value.copy(getColor(g.colorCore));
    v.uColorEdge.value.copy(getColor(g.colorEdge));
    v.uColorInvalid.value.copy(getColor(g.colorInvalid));

    this.ghost.position.set(x, 0.01, z);
    this.ghost.rotation.set(0, yaw, 0);
    this.ghost.scale.set(ghostW, ghostH, 1);
    this.ghost.visible = g.ghost > 0.001;

    /* ---- the reach ring ---- */
    this.reach.update(origin, yaw, range, t, valid);
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  dispose() {
    this.thresholdGeometry.dispose();
    this.thresholdMaterial.dispose();
    this.ghostGeometry.dispose();
    this.ghostMaterial.dispose();
    this.reach.dispose();
  }
}
