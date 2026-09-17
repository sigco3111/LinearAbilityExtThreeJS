import { Mesh, ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The ring drawn at the caster's feet at maximum range.
 *
 * Shared by every indicator that places something *out there* rather than along
 * a line — the far-cast circle and the gate template both need to answer "how
 * far can this reach", and the answer is the same ring in both.
 *
 * It is the bolt's ribbon strip bent into a circle: `(t, side)` arrives as "how
 * far around" and "which lip", and comes out as a world position. A quad big
 * enough to hold a 20 m range would be 40 m across and shade a screenful of
 * discarded fragments for one thin line; the strip costs the ring itself and
 * nothing else.
 */
const REACH_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uSpin;

  varying float vAngle;
  varying float vSide;

  void main() {
    float t = position.x;
    float side = position.y;
    vAngle = t;
    vSide = side;

    float a = (t + uTime * uSpin) * TAU;
    vec3 dir = vec3(sin(a), 0.0, cos(a));
    vec3 world = uCentre + dir * (uRadius + side * uWidth);

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const REACH_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uDashes;
  uniform float uDashGap;
  uniform float uSpin;
  uniform float uLead;        // bearing of the cursor, as a 0..1 fraction
  uniform float uLeadStrength;
  uniform float uIntensity;
  uniform float uReveal;
  uniform float uInvalid;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying float vAngle;
  varying float vSide;

  void main() {
    float profile = 1.0 - clamp(abs(vSide), 0.0, 1.0);
    profile = pow(profile, 1.6);

    // The dash pattern is welded to the strip's own parameter, and the vertex
    // shader is what rotates the strip — so the dashes creep with the ring
    // rather than sitting still in the world while it turns under them.
    float dash = 1.0;
    if (uDashes > 0.5) {
      float phase = fract(vAngle * uDashes);
      dash = 1.0 - smoothstep(1.0 - uDashGap, 1.0 - uDashGap + 0.12, phase);
    }

    // The lead marker is pinned to a *world* bearing, so it has to undo the
    // spin the vertex shader applied. Shortest way round, 0..0.5.
    float world = fract(vAngle + uTime * uSpin);
    float delta = abs(fract(world - uLead + 0.5) - 0.5);
    float lead = smoothstep(0.12, 0.0, delta) * uLeadStrength;

    float alpha = profile * (dash * uIntensity + lead) * uReveal * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = mix(uColorEdge, uColorCore, clamp(lead + profile * 0.4, 0.0, 1.0));
    color = mix(color, uColorInvalid, uInvalid);

    gl_FragColor = vec4(color * uGlobalGlow, clamp(alpha, 0.0, 1.0));
  }
`;

export class ReachRing {
  /**
   * @param {object} config the indicator block this ring belongs to. Read live,
   *   never copied, so every slider in it applies on the next frame. It must
   *   carry `reach`, `reachWidth`, `reachSpin`, `reachDashes`, `reachDashGap`,
   *   `reachLead`, `reachSegments`, `height`, `opacity` and the three colours.
   */
  constructor(config) {
    this.config = config;

    this.geometry = createBoltRibbonGeometry(config.reachSegments + 1, 1);
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uCentre: { value: new Vector3() },
        uRadius: { value: 20 },
        uWidth: { value: 0.05 },
        uSpin: { value: 0.03 },
        uDashes: { value: 64 },
        uDashGap: { value: 0.42 },
        uLead: { value: 0 },
        uLeadStrength: { value: 0.9 },
        uIntensity: { value: 0.7 },
        uReveal: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new Color(0.92, 0.97, 1) },
        uColorEdge: { value: new Color(0.49, 0.42, 1) },
        uColorInvalid: { value: new Color(1, 0.41, 0.36) }
      }),
      vertexShader: REACH_VERTEX,
      fragmentShader: REACH_FRAGMENT
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'ReachRing';
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
  }

  get object3D() {
    return this.mesh;
  }

  /**
   * @param {THREE.Vector3} origin the caster's feet
   * @param {number} yaw    heading of the cursor, radians about +Y
   * @param {number} range  the ability's maximum reach, metres
   * @param {number} reveal 0..1
   * @param {boolean} valid false tints the ring to `colorInvalid`
   */
  update(origin, yaw, range, reveal, valid) {
    const c = this.config;
    const u = this.material.uniforms;

    u.uCentre.value.set(origin.x, c.height, origin.z);
    u.uRadius.value = Math.max(0.2, range);
    u.uWidth.value = c.reachWidth;
    u.uSpin.value = c.reachSpin;
    u.uDashes.value = Math.max(0, Math.round(c.reachDashes));
    u.uDashGap.value = c.reachDashGap;
    // The strip's `t` runs from +Z anticlockwise, which is how the vertex
    // shader lays it out — so the cursor's bearing is just its yaw over a turn.
    u.uLead.value = (((yaw / (Math.PI * 2)) % 1) + 1) % 1;
    u.uLeadStrength.value = c.reachLead;
    u.uIntensity.value = c.reach;
    u.uReveal.value = reveal;
    u.uInvalid.value = valid ? 0 : 1;
    u.uOpacity.value = c.opacity * settings.global.opacity;
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorEdge.value.copy(getColor(c.colorEdge));
    u.uColorInvalid.value.copy(getColor(c.colorInvalid));

    this.mesh.visible = c.reach > 0.001;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
