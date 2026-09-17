import {
  BufferGeometry,
  BufferAttribute,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  Sphere,
  Vector3
} from 'three';
import { clamp, hash11, smoothstep } from '../utils/math.js';

/**
 * CPU-side procedural geometry.
 *
 * The project ships no mesh assets beyond the character, so the ice crystals are
 * generated here. A crystal is cheap enough to rebuild — a six-sided one is 108
 * triangles — that the *shape* sliders in the editor regenerate it outright
 * instead of approximating themselves in a vertex shader. That is what lets the
 * facet count, the taper and the surface roughness stay live controls, including
 * while the simulation is paused.
 *
 * Everything is deterministic in `seed`: the same seed always yields the same
 * crystal, so a rebuild mid-cast reshapes the field without reshuffling it.
 */

const TAU = Math.PI * 2;

/**
 * Height / radius profile of a crystal, sampled at the ring heights below.
 * `t` is the fraction of the way to the tip; the returned radius is a fraction
 * of the base radius.
 */
const RING_HEIGHTS = [0, 0.12, 0.22, 0.35, 0.5, 0.62, 0.75, 0.92];

/**
 * The belly: how much the profile is pushed out between the base and the tip.
 *
 * A cone is the wrong silhouette for a *flame*-blade — a fire tongue is pinched
 * where it leaves the ground, swells through its lower middle and runs from
 * there to a long point. This returns a hump that is zero at both ends, so the
 * base radius and the tip taper stay exactly what their own sliders say and the
 * bulge is purely a mid-height widening. `belly = 1` is the plain cone.
 */
function bellyBump(t, at) {
  if (t <= 0 || t >= 1) return 0;
  return t < at ? smoothstep(0, at, t) : smoothstep(1, at, t);
}

function profileRadius(t, taper, belly = 1, bellyAt = 0.35) {
  const cone = taper + (1 - taper) * Math.pow(1 - t, 1.15);
  return cone * (1 + (belly - 1) * bellyBump(t, clamp(bellyAt, 0.02, 0.98)));
}

/**
 * A single ice crystal: a tapered, faceted, slightly bent prism.
 *
 * Unit space — base ring on y = 0 with a circumscribed radius of 0.5, apex at
 * y = 1. An instance therefore scales footprint and height independently, and
 * `local.y` reads straight off as "how far up this crystal am I", which is what
 * the rime banding in `materials/IceMaterial.js` keys off.
 *
 * @param {object} options
 * @param {number} [options.seed]      deterministic shape seed
 * @param {number} [options.sides]     facet count around the prism (5–8 read best)
 * @param {number} [options.taper]     tip radius as a fraction of the base
 * @param {number} [options.roughness] how far facets are pushed off a clean prism
 * @param {number} [options.bend]      sideways curve from base to tip
 * @param {number} [options.belly]     mid-height radius, × the cone profile (1 = a cone)
 * @param {number} [options.bellyAt]   where along the height that widest point sits, 0..1
 */
export function createCrystalGeometry({
  seed = 1,
  sides = 6,
  taper = 0.13,
  roughness = 0.28,
  bend = 0.22,
  belly = 1,
  bellyAt = 0.35
} = {}) {
  const facets = Math.max(3, Math.round(sides));
  const tipRadius = Math.min(0.9, Math.max(0.01, taper));

  // One fixed bend direction per crystal, so a whole field leans convincingly
  // instead of every spike curving the same way.
  const bendAngle = hash11(seed * 1.77) * TAU;
  const bendX = Math.cos(bendAngle);
  const bendZ = Math.sin(bendAngle);

  /** Lateral drift of the crystal's axis at height `t`. */
  const axisOffset = (t) => bend * 0.5 * Math.pow(t, 1.6);

  // --- rings -------------------------------------------------------------
  // Angles are jittered once and shared by every ring, so the facets stay
  // continuous edges up the crystal rather than twisting into a screw.
  const angles = [];
  for (let i = 0; i < facets; i++) {
    const jitter = (hash11(seed * 3.13 + i * 7.7) - 0.5) * (TAU / facets) * 0.55 * roughness * 3;
    angles.push((i / facets) * TAU + jitter);
  }

  const rings = RING_HEIGHTS.map((t, ringIndex) => {
    const baseR = profileRadius(t, tipRadius, belly, bellyAt) * 0.5;
    const drift = axisOffset(t);
    // Height wobble keeps the shoulder lines from stacking into clean bands.
    const y = t + (hash11(seed * 5.9 + ringIndex * 2.3) - 0.5) * 0.06 * roughness * (t > 0 ? 1 : 0);

    return angles.map((angle, i) => {
      // Irregularity grows toward the tip: a crystal is roughly round where it
      // leaves the ground and increasingly ragged where it was torn.
      const wobble = 1 + (hash11(seed * 11.1 + ringIndex * 13.7 + i * 3.9) - 0.5) * roughness * 1.3 * (0.35 + 0.65 * t);
      const r = Math.max(0.002, baseR * wobble);
      return [Math.cos(angle) * r + bendX * drift, y, Math.sin(angle) * r + bendZ * drift];
    });
  });

  // The apex is offset a little off-axis so the tip reads as chipped rather
  // than as the vertex of a cone.
  const apexDrift = axisOffset(1);
  const apex = [
    bendX * apexDrift + (hash11(seed * 17.3) - 0.5) * 0.09 * roughness,
    1,
    bendZ * apexDrift + (hash11(seed * 19.7) - 0.5) * 0.09 * roughness
  ];
  const floorCentre = [0, 0, 0];

  // --- triangles ---------------------------------------------------------
  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    for (let i = 0; i < facets; i++) {
      const j = (i + 1) % facets;
      push(lower[i]); push(lower[j]); push(upper[i]);
      push(lower[j]); push(upper[j]); push(upper[i]);
    }
  }

  const top = rings[rings.length - 1];
  const base = rings[0];
  for (let i = 0; i < facets; i++) {
    const j = (i + 1) % facets;
    push(top[i]); push(top[j]); push(apex); // the point
    push(floorCentre); push(base[j]); push(base[i]); // the underside
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Non-indexed + per-face normals: this is what makes the facets crisp.
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A short, wide crystal shard — the ankle-height rubble that fills in around the
 * main spikes. Same unit space, so it instances through the identical path.
 */
export function createShardGeometry(seed = 5, sides = 5) {
  return createCrystalGeometry({
    seed: seed * 2.7 + 41,
    sides,
    taper: 0.22,
    roughness: 0.55,
    bend: 0.35
  });
}

/* ---------------------------------------------------------------------- */
/* Tentacle                                                                */
/* ---------------------------------------------------------------------- */

/**
 * A cephalopod arm, generated **straight** — the bend lives in the shader.
 *
 * This is the one piece of geometry in the project that is never drawn in the
 * shape it is built in. A tentacle has to coil, rear and whip down inside a
 * single cast, and none of that can be expressed as an instance transform: the
 * arm is not moved, it is *deformed*, continuously, along its own length. So the
 * mesh is baked as a tapered tube standing straight up the +Y axis and
 * `materials/KrakenMaterial.js` bends it every frame, integrating a curvature
 * profile up the arm and rebuilding the local frame at every ring. The CPU
 * never touches a vertex after this function returns.
 *
 * Which makes the parameterisation the important part, and it is deliberately
 * redundant so the vertex stage never has to guess:
 *
 *   - **`position.y` is the arclength fraction**, 0 at the mouth of the rift and
 *     1 at the point, so the bend integral has its parameter for free.
 *   - **`position.xz` is the cross-section**, already carrying the taper — the
 *     shader multiplies it by one thickness in metres and is done.
 *   - **`uv.x` runs once around the arm** with `uv.x = 0` on the **ventral**
 *     face, the side the suckers are on and the side the arm curls *toward*.
 *     That is what lets the fragment stage lay two rows of suckers down the
 *     inside of a curl without knowing anything about how the curl was made.
 *   - **`uv.y` is `position.y` again**, so the fragment stage can band the arm
 *     without reconstructing it from a bent position.
 *
 * Normals are computed analytically rather than by `computeVertexNormals`: the
 * seam where the tube closes needs duplicated vertices for continuous `uv.x`,
 * and averaged normals would leave a lit crease running the length of every
 * arm. A surface of revolution has an exact normal — `(cos a, -r'(t), sin a)`,
 * corrected for the flattening — so there is no reason to approximate it.
 *
 * @param {object} options
 * @param {number} [options.seed]      deterministic shape seed
 * @param {number} [options.rings]     cross-sections up the arm (the bend's resolution)
 * @param {number} [options.sides]     vertices around one cross-section
 * @param {number} [options.taper]     radius at the point, as a fraction of the base
 * @param {number} [options.swell]     radius through the muscle, × the cone profile
 * @param {number} [options.swellAt]   where that swell sits, 0 = the rift, 1 = the point
 * @param {number} [options.roughness] per-ring radius wobble — an arm is not a lathe part
 * @param {number} [options.flatten]   cross-section flattening across the sucker face
 */
export function createTentacleGeometry({
  seed = 1,
  rings = 44,
  sides = 12,
  taper = 0.05,
  swell = 1.3,
  swellAt = 0.16,
  roughness = 0.12,
  flatten = 0.84
} = {}) {
  const R = Math.max(6, Math.round(rings));
  const S = Math.max(4, Math.round(sides));
  const tip = clamp(taper, 0.005, 0.6);
  const flat = clamp(flatten, 0.35, 1.6);

  /**
   * Radius at arclength `t`, as a fraction of the base radius.
   *
   * A tentacle is not a cone: it is thickest just clear of the mantle, holds
   * that thickness through the muscle and then runs a long way to a fine point.
   * `swell` is the same zero-at-both-ends bump the fire-blades use, so `taper`
   * keeps meaning exactly what it says.
   */
  const profile = (t) => {
    const cone = tip + (1 - tip) * Math.pow(1 - t, 0.85);
    const bump = 1 + (swell - 1) * bellyBump(t, clamp(swellAt, 0.02, 0.98));
    // Slow, long-period wobble: the arm has muscle segments, not ripples.
    const wobble = 1 + Math.sin(t * 9.4 + seed * 3.1) * 0.05 * roughness * 3;
    return Math.max(0.004, cone * bump * wobble);
  };

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const ringVertices = S + 1; // duplicated seam, for a continuous uv.x

  for (let r = 0; r <= R; r++) {
    const t = r / R;
    const radius = profile(t);
    // Central difference for the profile slope, which is what tips the normal
    // off the cross-section plane and stops the arm shading like a cylinder.
    const e = 1 / (R * 2);
    const slope = (profile(Math.min(1, t + e)) - profile(Math.max(0, t - e))) / (2 * e);

    for (let i = 0; i <= S; i++) {
      const u = i / S;
      const a = u * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);

      positions.push(ca * radius, t, sa * radius * flat);
      uvs.push(u, t);

      // Ellipse gradient in the cross-section, plus the taper's own slope.
      const nx = ca;
      const nz = sa / flat;
      const ny = -slope * 0.5;
      const len = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / len, ny / len, nz / len);
    }
  }

  for (let r = 0; r < R; r++) {
    for (let i = 0; i < S; i++) {
      const a = r * ringVertices + i;
      const b = a + 1;
      const c = a + ringVertices;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  // The arm is bent in the vertex shader, so its resting bounds say nothing
  // about where it ends up. Every mesh built from this is drawn unculled.
  geometry.computeBoundingSphere();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* Asteroid                                                                */
/* ---------------------------------------------------------------------- */

/** One lattice corner of the value noise below. */
function lattice(ix, iy, iz, seed) {
  return hash11(ix * 127.1 + iy * 311.7 + iz * 74.7 + seed * 19.19);
}

/**
 * Deterministic 3D value noise, 0..1.
 *
 * The GLSL library has simplex noise, but the asteroid is displaced on the CPU
 * (a vertex shader cannot move a shadow caster's silhouette or its normals), so
 * it needs a JS counterpart. Value noise on a smoothstepped lattice is plenty:
 * the shape is read at the silhouette, not up close, and the rock's *detail*
 * comes from the flat facets and the crack shader on top.
 */
function valueNoise3(x, y, z, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = lattice(ix, iy, iz, seed);
  const c100 = lattice(ix + 1, iy, iz, seed);
  const c010 = lattice(ix, iy + 1, iz, seed);
  const c110 = lattice(ix + 1, iy + 1, iz, seed);
  const c001 = lattice(ix, iy, iz + 1, seed);
  const c101 = lattice(ix + 1, iy, iz + 1, seed);
  const c011 = lattice(ix, iy + 1, iz + 1, seed);
  const c111 = lattice(ix + 1, iy + 1, iz + 1, seed);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;

  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;

  return y0 + (y1 - y0) * uz;
}

/** Signed fbm over `valueNoise3`, roughly -1..1. */
function fbmValue(x, y, z, seed, octaves) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * (valueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 7.7) * 2 - 1);
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

/**
 * A meteor: a fractured, cratered ball of rock.
 *
 * Unit space — an icosphere of radius 1 whose vertices are pushed in and out
 * along their own direction, so an instance scales it straight to metres and
 * `local` reads as a direction on the rock. That matters because
 * `materials/MeteorMaterial.js` samples its lava seams in exactly that space:
 * the cracks are welded to the rock and tumble with it instead of swimming
 * through it.
 *
 * Three things stack to make it read as *stone* rather than as a wobbly ball:
 *
 *  1. **fbm lumps** — the big shape, so no two directions look alike.
 *  2. **planar cuts** — the rock is sliced by a handful of random half-spaces:
 *     anything outside a plane is pushed back onto it. That leaves genuine flat
 *     faces meeting at hard edges, which is what quarried and shattered stone
 *     actually looks like, and it is the single biggest difference between this
 *     and a displaced sphere.
 *  3. **craters** — bowls with a heaped ejecta rim, punched through the lot.
 *
 * The displacement is a pure function of the vertex *direction*, which is what
 * lets the geometry be non-indexed (needed for flat facets) without splitting
 * open — duplicated vertices share a direction, so they are moved identically.
 *
 * @param {object} options
 * @param {number} [options.seed]        deterministic shape seed
 * @param {number} [options.detail]      icosphere subdivisions, 0–3
 * @param {number} [options.lumpiness]   low-frequency deformation, × the radius
 * @param {number} [options.noiseScale]  lumps per unit radius
 * @param {number} [options.roughness]   high-frequency chipping
 * @param {number} [options.cuts]        planar fracture faces sliced off it
 * @param {number} [options.cutDepth]    how far in those planes bite, × the radius
 * @param {number} [options.craters]     impact bowls punched into it
 * @param {number} [options.craterDepth] how deep those bowls go, × the radius
 * @param {number} [options.craterSize]  their angular radius, radians
 */
export function createAsteroidGeometry({
  seed = 1,
  detail = 3,
  lumpiness = 0.26,
  noiseScale = 1.5,
  roughness = 0.16,
  cuts = 7,
  cutDepth = 0.2,
  craters = 5,
  craterDepth = 0.18,
  craterSize = 0.5
} = {}) {
  // IcosahedronGeometry is already non-indexed, so the vertex loop below can
  // displace each triangle corner independently without splitting anything.
  const geometry = new IcosahedronGeometry(1, clamp(Math.round(detail), 0, 3));
  const array = geometry.attributes.position.array;

  /** A deterministic point on the unit sphere. */
  const direction = (a, b) => {
    const phi = Math.acos(2 * hash11(a) - 1);
    const theta = hash11(b) * TAU;
    const sinPhi = Math.sin(phi);
    return { x: sinPhi * Math.cos(theta), y: Math.cos(phi), z: sinPhi * Math.sin(theta) };
  };

  // Cuts and craters are picked once per seed and shared by every vertex, so the
  // vertex loop below stays a pure lookup.
  const planes = [];
  for (let i = 0; i < Math.max(0, Math.round(cuts)); i++) {
    const n = direction(seed * 2.3 + i * 9.1, seed * 5.7 + i * 4.3);
    // How far along its own normal the plane sits: 1 is tangent (no bite), less
    // shaves a face off. Kept above 0.55 so a cut never lops the rock in half.
    n.offset = 1 - cutDepth * (0.35 + 0.9 * hash11(seed * 13.1 + i * 6.7));
    planes.push(n);
  }

  const bowls = [];
  for (let i = 0; i < Math.max(0, Math.round(craters)); i++) {
    const c = direction(seed * 3.1 + i * 12.9, seed * 7.7 + i * 5.3);
    c.radius = Math.max(0.08, craterSize * (0.45 + 0.8 * hash11(seed * 11.3 + i * 3.7)));
    c.depth = craterDepth * (0.5 + hash11(seed * 17.9 + i * 2.1));
    bowls.push(c);
  }

  for (let i = 0; i < array.length; i += 3) {
    // IcosahedronGeometry(1) hands us unit-length vertices already.
    const x = array[i];
    const y = array[i + 1];
    const z = array[i + 2];

    /* --- 1. the lumpy body --- */
    let radius = 1;
    radius += fbmValue(x * noiseScale, y * noiseScale, z * noiseScale, seed, 3) * lumpiness;
    radius +=
      fbmValue(x * noiseScale * 4.3, y * noiseScale * 4.3, z * noiseScale * 4.3, seed + 31.7, 2) *
      roughness *
      0.5;

    /* --- 2. craters, before the cuts so a cut can shear one in half --- */
    for (const bowl of bowls) {
      const angle = Math.acos(clamp(x * bowl.x + y * bowl.y + z * bowl.z, -1, 1));
      const q = angle / bowl.radius;
      if (q >= 1.4) continue;
      radius -= bowl.depth * Math.max(0, 1 - q * q);
      radius += bowl.depth * 0.5 * smoothstep(0.72, 1.0, q) * (1 - smoothstep(1.0, 1.4, q));
    }

    radius = Math.max(0.35, radius);
    let px = x * radius;
    let py = y * radius;
    let pz = z * radius;

    /* --- 3. slice off the flat faces --- */
    for (const plane of planes) {
      const along = px * plane.x + py * plane.y + pz * plane.z;
      const over = along - plane.offset;
      if (over <= 0) continue;
      // Project back onto the plane. Every vertex outside it lands *on* it, so
      // the result is a genuinely flat facet, not a squashed curve.
      px -= plane.x * over;
      py -= plane.y * over;
      pz -= plane.z * over;
    }

    array[i] = px;
    array[i + 1] = py;
    array[i + 2] = pz;
  }

  geometry.attributes.position.needsUpdate = true;
  // Non-indexed + per-face normals: the facets stay crisp, like the crystals.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The strip a lightning filament is drawn on — a flat ladder of quads, in
 * *parameter* space rather than world space.
 *
 * Every vertex carries `position = (t, side, 0)`, where `t` runs 0 → 1 from the
 * caster's hand to the impact point and `side` is ±1 across the ribbon. There
 * are no metres in here at all: `materials/LightningMaterial.js` turns that pair
 * into a world position every frame, so one strip serves a bolt of any length,
 * any shape and any width, and the whole path stays a live slider.
 *
 * One instance is one filament, and `aStrand` is simply its index — the shader
 * derives the filament's seed, its place in the fan and its width from it.
 *
 * @param {number} nodes   samples along the bolt; the kink detail ceiling
 * @param {number} strands instance capacity (the live count is `instanceCount`)
 */
export function createBoltRibbonGeometry(nodes = 72, strands = 24) {
  const steps = Math.max(2, Math.round(nodes));
  const count = Math.max(1, Math.round(strands));

  const positions = new Float32Array(steps * 2 * 3);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const o = i * 6;
    positions[o + 0] = t;
    positions[o + 1] = -1;
    positions[o + 3] = t;
    positions[o + 4] = 1;
  }

  const indices = new Uint16Array((steps - 1) * 6);
  for (let i = 0; i < steps - 1; i++) {
    const a = i * 2;
    const o = i * 6;
    indices[o + 0] = a;
    indices[o + 1] = a + 1;
    indices[o + 2] = a + 2;
    indices[o + 3] = a + 1;
    indices[o + 4] = a + 3;
    indices[o + 5] = a + 2;
  }

  const strandIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) strandIndex[i] = i;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aStrand', new InstancedBufferAttribute(strandIndex, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  // The bolt is built in world space in the vertex shader, so the geometry's own
  // bounds are meaningless — cull it manually instead (the ability sets
  // `frustumCulled = false`).
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* Beam                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * The column a beam is drawn on — a tube in *parameter* space.
 *
 * Same trick as the bolt ribbon, one dimension richer: every vertex carries
 * `position = (t, a, 0)`, where `t` runs 0 → 1 from the muzzle to the impact
 * point and `a` runs 0 → 1 once around the barrel. There are no metres in here
 * either; `materials/BeamMaterial.js` turns that pair into a world position
 * every frame, so one tube serves a beam of any length and any profile.
 *
 * Real tube rather than the camera-facing ribbon the bolt uses, because a beam
 * this thick has to *have* a cross-section: the silhouette has to bow correctly
 * when you orbit around it, the far wall has to add through the near one, and
 * the shock rings have to be able to hug it. A ribbon can fake none of that.
 *
 * The seam column is duplicated so `a` reaches a full 1.0 instead of wrapping
 * to 0 — the angular noise in the shader would otherwise show a hard join line
 * down the length of the beam.
 *
 * @param {number} nodes samples along the column; the profile detail ceiling
 * @param {number} sides facets around the barrel (20–32 reads clean)
 */
export function createBeamTubeGeometry(nodes = 96, sides = 26) {
  const steps = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;

  const positions = new Float32Array(steps * columns * 3);
  let v = 0;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    for (let j = 0; j < columns; j++) {
      positions[v++] = t;
      positions[v++] = j / facets;
      positions[v++] = 0;
    }
  }

  const indices = new Uint16Array((steps - 1) * facets * 6);
  let k = 0;
  for (let i = 0; i < steps - 1; i++) {
    for (let j = 0; j < facets; j++) {
      const a = i * columns + j;
      const b = a + columns;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  // Placed in world space by the vertex shader, like the bolt — its own bounds
  // mean nothing (the ability sets `frustumCulled = false`).
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/**
 * The shock discs that race down a beam — an instanced annulus, again in
 * parameter space: `position = (band, a, 0)` with `band` 0 at the inner lip and
 * 1 at the outer one, and `a` once around.
 *
 * One instance is one disc, and `aRing` is only its index — the shader spaces
 * the discs evenly along the column from it and slides them downrange, so the
 * whole train is a function of the clock rather than a queue on the CPU.
 *
 * @param {number} rings    instance capacity (the live count is `instanceCount`)
 * @param {number} segments facets around one disc
 */
export function createBeamRingGeometry(rings = 10, segments = 44) {
  const count = Math.max(1, Math.round(rings));
  const facets = Math.max(6, Math.round(segments));
  const columns = facets + 1;

  const positions = new Float32Array(2 * columns * 3);
  let v = 0;
  for (let band = 0; band < 2; band++) {
    for (let j = 0; j < columns; j++) {
      positions[v++] = band;
      positions[v++] = j / facets;
      positions[v++] = 0;
    }
  }

  const indices = new Uint16Array(facets * 6);
  let k = 0;
  for (let j = 0; j < facets; j++) {
    const a = j;
    const b = columns + j;
    indices[k++] = a;
    indices[k++] = b;
    indices[k++] = a + 1;
    indices[k++] = b;
    indices[k++] = b + 1;
    indices[k++] = a + 1;
  }

  const ringIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) ringIndex[i] = i;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aRing', new InstancedBufferAttribute(ringIndex, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* Orbs                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * A unit sphere, instanced, with nothing in it but an instance index.
 *
 * The counterpart of `createBoltRibbonGeometry` for the one effect that needs a
 * *volume* per instance rather than a ribbon: the Fire Boost's orbiting embers.
 * As with the ribbon, the geometry carries no transform and no bounds worth
 * having — every instance is placed in world space by its vertex shader from
 * `aOrb` and the clock (see `materials/EmberOrbMaterial.js`), so the mesh stays
 * at identity and is culled manually by the effect.
 *
 * An icosphere rather than a UV sphere: it has no pole, which matters when the
 * shader is sampling a noise field on the surface direction — a UV sphere gathers
 * every one of its poles' triangles into a point and the convection knots there.
 *
 * @param {number} detail subdivisions; 2 is 320 faces, which is plenty at the
 *   size these are drawn
 * @param {number} count  instances to allocate — the ceiling, not the live count
 */
export function createOrbFieldGeometry(detail = 2, count = 8) {
  const instances = Math.max(1, Math.round(count));
  const source = new IcosahedronGeometry(1, Math.max(0, Math.round(detail)));

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', source.getAttribute('position').clone());
  if (source.index) geometry.setIndex(source.index.clone());

  const orbIndex = new Float32Array(instances);
  for (let i = 0; i < instances; i++) orbIndex[i] = i;
  geometry.setAttribute('aOrb', new InstancedBufferAttribute(orbIndex, 1));

  geometry.instanceCount = instances;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);

  source.dispose();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* Earth — rocks, slabs, tower                                              */
/* ---------------------------------------------------------------------- */

/**
 * Seeded 3D value noise, signed (-1..1). Smooth enough that flat-shaded
 * boulders read as stone rather than as terraced crystal.
 *
 * Prefixed `rock` so it does not collide with the unsigned `valueNoise3`
 * already in this file (used by the asteroid section, which interprets
 * its 0..1 output differently).
 */
function rockValueNoise3(x, y, z, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;

  const fade = (t) => t * t * (3 - 2 * t);
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  const corner = (i, j, k) =>
    hash11((xi + i) * 157.1 + (yi + j) * 311.7 + (zi + k) * 74.7 + seed * 13.3) * 2 - 1;

  const lerp = (a, b, t) => a + (b - a) * t;

  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), u);
  const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), u);
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), u);
  const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), u);

  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

function rockFbm3(x, y, z, seed, octaves = 3) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * rockValueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 7);
    frequency *= 2.07;
    amplitude *= 0.5;
  }
  return value;
}

/**
 * A chunky, faceted boulder — the unit the earth crust's travelling fracture
 * heaves up through the floor.
 *
 * Unit space: an icosphere of radius 0.5 whose vertices are pushed in and
 * out along their own direction, so an instance scales to metres directly
 * and `local` reads as a direction on the rock. The `RockMaterial` then
 * samples its strata, moss and crack seams in that space — which is what
 * makes a tumbling rock keep its features welded to it rather than
 * swimming through it.
 *
 * @param {number} seed     deterministic shape seed
 * @param {number} detail   icosahedron subdivision (0–2)
 */
export function createRockGeometry(seed = 1, detail = 1) {
  const geometry = new IcosahedronGeometry(0.5, detail);
  const position = geometry.attributes.position;
  const v = new Vector3();

  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const n = rockFbm3(v.x * 3.4, v.y * 3.4, v.z * 3.4, seed, 3);
    // Rocks sit wider than they are tall — a sphere with noise reads as
    // a cloud; squashing it on Y is the single biggest step toward stone.
    const flatten = 1 - Math.abs(v.y) * 0.18;
    v.multiplyScalar((1 + n * 0.42) * flatten);
    position.setXYZ(i, v.x, v.y, v.z);
  }

  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  geometry.computeVertexNormals(); // faceted look: the icosphere is non-indexed
  return geometry;
}

/**
 * A flat, irregular ground plate — the unit the earth crust is paved with.
 *
 * Unit space: an n-gon of radius 0.5 in XZ whose top surface sits slightly
 * above y = 0 and whose underside reaches y = -1. Thickness is therefore
 * the instance's Y scale alone, so a plate can be made thicker without
 * changing its footprint, and its top stays flush with the floor at y = 0.
 */
export function createSlabGeometry(seed = 7, sides = 7) {
  const rim = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + (hash11(seed * 3.1 + i * 1.7) - 0.5) * 0.75;
    const radius = 0.5 * (0.72 + hash11(seed * 7.7 + i * 2.3) * 0.5);
    // A little relief on the top face: a perfectly flat card reads as paper.
    rim.push([Math.cos(angle) * radius, 0.06 + hash11(seed + i * 5.5) * 0.16, Math.sin(angle) * radius]);
  }

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);
  const centre = [0, 0.25, 0];

  for (let i = 0; i < sides; i++) {
    const a = rim[i];
    const b = rim[(i + 1) % sides];
    const aDown = [a[0], -1, a[2]];
    const bDown = [b[0], -1, b[2]];

    push(centre); push(b); push(a); // top face, fan from the centre
    push(a); push(b); push(aDown); // fracture wall
    push(b); push(bDown); push(aDown);
    push([0, -1, 0]); push(aDown); push(bDown); // underside
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The finale tower: a squared-off obelisk on a stepped plinth.
 *
 * Unit space: base at y = 0, apex at y = 1, one unit wide at the plinth —
 * so an instance scales height and footprint independently, and driving
 * `position.y` from -height to 0 slides the whole thing up out of the
 * floor.
 */
export function createTowerGeometry(seed = 11) {
  const SIDES = 4;

  /** Square cross-section of half-width `r`, weathered by noise. */
  const ring = (y, r) =>
    Array.from({ length: SIDES }, (_, i) => {
      const angle = (i / SIDES) * Math.PI * 2 + Math.PI / SIDES;
      const x = Math.cos(angle) * Math.SQRT2;
      const z = Math.sin(angle) * Math.SQRT2;
      const wear = 1 + rockFbm3(x * 2.0, y * 3.0, z * 2.0, seed, 2) * 0.07;
      return [x * r * wear, y, z * r * wear];
    });

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);

  const bridge = (lower, upper) => {
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      push(upper[i]); push(upper[j]); push(lower[i]);
      push(upper[j]); push(lower[j]); push(lower[i]);
    }
  };

  const plinthBottom = ring(0, 0.6);
  const plinthTop = ring(0.045, 0.575);
  const shaftBottom = ring(0.05, 0.5);
  const shaftTop = ring(0.87, 0.32);
  const apex = [0, 1, 0];

  bridge(plinthBottom, plinthTop);
  bridge(plinthTop, shaftBottom); // the ledge where the shaft meets the plinth
  bridge(shaftBottom, shaftTop);

  for (let i = 0; i < SIDES; i++) {
    const j = (i + 1) % SIDES;
    push(shaftTop[i]); push(apex); push(shaftTop[j]); // pyramidion
    push([0, 0, 0]); push(plinthBottom[i]); push(plinthBottom[j]); // underside
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A rough-hewn masonry block — the unit an arch is built out of.
 *
 * The boulder above is the wrong stone for a *built* thing: an icosphere
 * pushed about reads as something the ground threw up, and a gateway is
 * something somebody stacked. This is the other silhouette — a quarried
 * block with **flat faces and chipped edges**, which is what an arch of
 * stone actually looks like from ten metres away.
 *
 * It is a chamfered box, built the way a mason would describe one: eight
 * corners, each knocked off along all three axes, leaving six flat faces,
 * twelve bevel strips along the edges and a small triangle where each
 * corner used to be. Every corner is jittered independently, so no two
 * faces are quite parallel and no edge is quite straight — and because the
 * jitter is deterministic in `seed`, two different seeds give two visibly
 * different blocks that can be instanced side by side.
 *
 * Unit space: a box of side 1 centred on the origin, so an instance's scale
 * *is* the block's dimensions in metres, and `local` reads as a direction on
 * the stone for `RockMaterial`'s strata and moss.
 *
 * @param {number} seed      deterministic shape seed
 * @param {number} bevel     how far each corner is knocked off, 0..0.3
 * @param {number} roughness how far the corners wander off a true box
 */
export function createBlockGeometry(seed = 3, bevel = 0.14, roughness = 0.075) {
  /** Signed unit corner (sx, sy, sz) → its three chamfer vertices. */
  const corners = new Map();
  const cornerKey = (sx, sy, sz) => (sx > 0 ? 1 : 0) | (sy > 0 ? 2 : 0) | (sz > 0 ? 4 : 0);

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const k = cornerKey(sx, sy, sz);
        const jitter = (n) => (hash11(seed * 17.3 + k * 5.1 + n * 2.7) - 0.5) * 2 * roughness;
        const p = [sx * (0.5 + jitter(1)), sy * (0.5 + jitter(2)), sz * (0.5 + jitter(3))];
        // How hard this particular corner was knocked off. Varying it is what
        // stops the block from reading as a machined chamfer.
        const b = bevel * (0.55 + hash11(seed * 3.7 + k * 9.4) * 0.9);
        corners.set(k, {
          sign: [sx, sy, sz],
          // One chamfer vertex per face meeting at this corner. Each stays
          // *on* its own face and is pulled back along the other two axes:
          // `v[0]` belongs to the ±X face, `v[1]` to ±Y, `v[2]` to ±Z.
          // Pulling one back along its own face normal instead would lift the
          // corner facets and bevel strips clear of the faces, and the block
          // would come out a spiky, self-overlapping shell rather than a solid.
          v: [
            [p[0], p[1] - sy * b, p[2] - sz * b],
            [p[0] - sx * b, p[1], p[2] - sz * b],
            [p[0] - sx * b, p[1] - sy * b, p[2]]
          ]
        });
      }
    }
  }

  const positions = [];
  const centroid = [0, 0, 0];

  /** Push one triangle, wound so that it faces away from the middle. */
  const tri = (a, b, c) => {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const mx = (a[0] + b[0] + c[0]) / 3 - centroid[0];
    const my = (a[1] + b[1] + c[1]) / 3 - centroid[1];
    const mz = (a[2] + b[2] + c[2]) / 3 - centroid[2];
    // The block is star-shaped about its middle, so "outward" is simply "away
    // from the centroid" — which saves working the winding out per face.
    const outward = nx * mx + ny * my + nz * mz > 0;
    const [p, q, r] = outward ? [a, b, c] : [a, c, b];
    positions.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  };

  const quad = (a, b, c, d) => {
    tri(a, b, c);
    tri(a, c, d);
  };

  /* --- the six flat faces --- */
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [-1, 1]) {
      const ring = [];
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const sign = [0, 0, 0];
          sign[axis] = side;
          sign[(axis + 1) % 3] = sa;
          sign[(axis + 2) % 3] = sb;
          ring.push(corners.get(cornerKey(sign[0], sign[1], sign[2])).v[axis]);
        }
      }
      // The loop above walks the ring as (-,-), (-,+), (+,+), (+,-) once the
      // last two are swapped; anything else folds the quad over itself.
      quad(ring[0], ring[1], ring[3], ring[2]);
    }
  }

  /* --- the twelve bevel strips, one along each edge --- */
  for (let axis = 0; axis < 3; axis++) {
    const i = (axis + 1) % 3;
    const j = (axis + 2) % 3;
    for (const si of [-1, 1]) {
      for (const sj of [-1, 1]) {
        const signA = [0, 0, 0];
        const signB = [0, 0, 0];
        signA[axis] = -1;
        signB[axis] = 1;
        signA[i] = signB[i] = si;
        signA[j] = signB[j] = sj;
        const a = corners.get(cornerKey(signA[0], signA[1], signA[2]));
        const b = corners.get(cornerKey(signB[0], signB[1], signB[2]));
        quad(a.v[i], a.v[j], b.v[j], b.v[i]);
      }
    }
  }

  /* --- the eight corner facets --- */
  for (const corner of corners.values()) {
    tri(corner.v[0], corner.v[1], corner.v[2]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); // flat: the soup is non-indexed
  return geometry;
}
