import {
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  AdditiveBlending,
  Color,
  DoubleSide
} from 'three';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { ReachRing } from './ReachRing.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing } from '../utils/math.js';

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The template of a **scribe cast**: the circle the portal will hang in.
 *
 * Every other indicator in the project is drawn on the floor, because every
 * other cast lands on it — an arrow saying which way, a circle saying how much
 * ground, a threshold saying what will be standing here, a sigil saying what is
 * about to be assembled on it. This cast lands on nothing, so the template is
 * simply the circle itself, standing in the air exactly where the ring is going
 * to be, drawn out from the foot as the cast arms.
 *
 * There is deliberately almost no fill. What ends up in the middle of this
 * circle is *nothing*, and a wash there would be promising light.
 */
const SCRIBE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;    // metres across the quad
  uniform float uRadius;      // the clear radius, metres
  uniform float uLine;        // thickness of the contour, metres
  uniform float uGlow;
  uniform float uFill;        // the little wash there is inside it
  uniform float uFillFalloff;
  uniform float uSweep;       // 0..1 how far round it has been drawn
  uniform float uDashes;      // embers per metre along the contour
  uniform float uDashGap;
  uniform float uScroll;      // metres/second they creep round it
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

  #define TAU 6.28318530718

  void main() {
    vec2 p = (vUv - 0.5) * uQuadSize;
    float r = length(p);
    float radius = max(0.1, uRadius);
    float dm = r - radius;
    // 0..1 round from the foot of the circle: the way it is drawn out.
    float turn = fract((atan(p.y, p.x) + 1.5707963) / TAU);

    float aa = fwidth(dm) + 0.012;
    if (dm > uLine * 3.0 + aa * 3.0) discard;

    float edge = uSweep * 1.05;
    float drawn = smoothstep(edge, edge - 0.05, turn);

    float line = 1.0 - smoothstep(uLine - aa, uLine + aa, abs(dm));
    if (uDashes > 0.05) {
      // Arc length round the contour, in metres, so the spacing is a real
      // measurement and does not stretch when the radius is dragged.
      float arc = turn * TAU * radius;
      float phase = fract((arc - uTime * uScroll) * uDashes);
      line *= mix(0.3, 1.0, 1.0 - smoothstep(1.0 - uDashGap, 1.0 - uDashGap + 0.15, phase));
    }

    float interior = smoothstep(aa, -aa, dm) * drawn;
    float wash = pow(clamp(1.0 - max(-dm, 0.0) / max(0.2, uRadius), 0.0, 1.0), uFillFalloff);

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float fill = interior * wash * uFill;
    float lines = line * drawn * uGlow * breathe;

    float alpha = clamp(fill + lines, 0.0, 1.0) * uOpacity * uReveal;
    if (alpha < 0.004) discard;

    vec3 color = uColorEdge * fill + mix(uColorEdge, uColorCore, clamp(lines, 0.0, 1.0)) * lines;
    color = mix(color, uColorInvalid * (fill + lines), uInvalid);
    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * The indicator drawn while a **scribe cast** is armed.
 *
 * Two objects and no floor mark: the circle standing in the air where it will
 * be cut, and the shared reach ring at the caster's feet. The reach ring is
 * what carries the distance read that the other templates get from their
 * footprint — which is the honest division of labour, because a portal cut in
 * the air has a *reach* and does not have a footprint.
 *
 * Everything is measured off the ability's own `ringRadius` and `ringHover`, so
 * the preview and the portal can never disagree about where the hole will hang.
 */
export class ScribeIndicator {
  constructor() {
    this.group = new Group();
    this.group.name = 'ScribeIndicator';
    this.group.matrixAutoUpdate = false;

    // Centred quad in XY: a circle cut in the air has no bottom edge to stand
    // on, so it is placed by its middle.
    this.geometry = new PlaneGeometry(1, 1, 1, 1);
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uQuadSize: { value: 6 },
        uRadius: { value: 2 },
        uLine: { value: 0.055 },
        uGlow: { value: 2.1 },
        uFill: { value: 0.08 },
        uFillFalloff: { value: 2.4 },
        uSweep: { value: 0 },
        uDashes: { value: 1.6 },
        uDashGap: { value: 0.4 },
        uScroll: { value: 0.9 },
        uPulse: { value: 0.2 },
        uPulseSpeed: { value: 2.4 },
        uReveal: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(1, 0.95, 0.82) },
        uColorEdge: { value: new Color(1, 0.48, 0.12) },
        uColorInvalid: { value: new Color(1, 0.32, 0.26) }
      }),
      vertexShader: QUAD_VERTEX,
      fragmentShader: SCRIBE_FRAGMENT
    });

    this.circle = new Mesh(this.geometry, this.material);
    this.circle.name = 'ScribeCircle';
    this.circle.layers.set(LAYER.VFX);
    this.circle.renderOrder = 6;
    this.circle.frustumCulled = false;

    this.reach = new ReachRing(settings.scribe);

    this.group.add(this.circle, this.reach.object3D);
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
   *                           the circle will face once it is cut
   * @param {number} distance  how far out the site is, metres
   * @param {number} radius    the ability's clear radius, metres
   * @param {number} hover     how far the foot of the circle clears the floor
   * @param {number} range     the ability's maximum reach, metres
   * @param {number} reveal    0..1 draw-out — the spark's own progress
   * @param {boolean} valid    false tints the template to `colorInvalid`
   */
  update(origin, yaw, distance, radius, hover, range, reveal, valid) {
    const g = settings.scribe;
    const t = saturate(reveal);
    const u = this.material.uniforms;

    const x = origin.x + Math.sin(yaw) * distance;
    const z = origin.z + Math.cos(yaw) * distance;
    // Sized off the same reach the fragment shader bails at, so the glow round
    // the contour is never clipped by the quad it is drawn on.
    const quadSize = (radius + g.line * 3 + 0.2) * 2;

    u.uQuadSize.value = quadSize;
    u.uRadius.value = radius;
    u.uLine.value = g.line;
    u.uGlow.value = g.lineGlow;
    u.uFill.value = g.fill;
    u.uFillFalloff.value = g.fillFalloff;
    // Drawn out from the foot of the circle over the first part of the reveal.
    u.uSweep.value = Easing.outCubic(saturate(t / Math.max(0.05, g.sweep)));
    u.uDashes.value = g.dashes;
    u.uDashGap.value = g.dashGap;
    u.uScroll.value = g.scroll;
    u.uPulse.value = g.pulse;
    u.uPulseSpeed.value = g.pulseSpeed;
    u.uReveal.value = t;
    u.uInvalid.value = valid ? 0 : 1;
    u.uOpacity.value = g.opacity * settings.global.opacity;
    u.uColorCore.value.copy(getColor(g.colorCore));
    u.uColorEdge.value.copy(getColor(g.colorEdge));
    u.uColorInvalid.value.copy(getColor(g.colorInvalid));

    this.circle.position.set(x, radius + Math.max(0, hover), z);
    this.circle.rotation.set(0, yaw, 0);
    this.circle.scale.set(quadSize, quadSize, 1);

    this.reach.update(origin, yaw, range, t, valid);
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.reach.dispose();
  }
}
