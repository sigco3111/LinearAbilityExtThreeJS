/**
 * Ability sigils for the HUD — drawn inline so they inherit `currentColor` (the
 * slot's `--accent`) and need no image assets.
 *
 * A 100×100 box, stroke only, so the mark reads the same at 34px in the ability
 * slot as it does scaled up.
 */

const WRAP = (body) =>
  `<svg class="glyph-svg" viewBox="0 0 100 100" aria-hidden="true" fill="none"
     stroke="currentColor" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/**
 * Pyre — a crown of fire standing on a ring.
 *
 * Built on an ellipse: the slot has to say "footprint" before it says anything
 * else, so every far cast shares that boundary and differs in what stands on
 * it. This one puts five *tongues* up off the ring — curved, asymmetric,
 * leaning outward on both sides with the tallest in the middle — and two
 * sparks coming off them. Nothing here is a straight line, which is the whole
 * distinction at 34px.
 */
const PYRE = WRAP(`
  <ellipse cx="50" cy="76" rx="38" ry="12"/>
  <path d="M6 74 Q2 58 4 40 Q16 56 20 72"/>
  <path d="M20 70 Q14 48 18 26 Q32 50 36 66"/>
  <path d="M38 66 Q38 38 48 9 Q58 38 56 65"/>
  <path d="M60 66 Q64 46 80 27 Q84 47 76 69"/>
  <path d="M78 72 Q82 56 96 41 Q98 57 92 73"/>
  <path d="M27 17L30 8M72 19L69 10"/>
`);

/**
 * Kraken — arms over a ring, closing on the middle.
 *
 * The second sigil built on the far cast's ellipse, and the first one where the
 * marks *converge*. The Pyre Crown stands its blades up off the boundary and
 * leaves the middle alone; these four arms come up off the same ring
 * and curl in over it, with two rows of dots down the inside of the nearest pair
 * and a mark in the centre where they all land. At 34px what reads is a circle
 * with something closing over it, which is the ability.
 */
const KRAKEN = WRAP(`
  <ellipse cx="50" cy="76" rx="38" ry="12"/>
  <path d="M11 73 Q4 44 22 30 Q38 18 44 34"/>
  <path d="M31 76 Q24 50 38 40"/>
  <path d="M69 76 Q78 50 63 39"/>
  <path d="M89 73 Q96 44 78 30 Q62 18 56 34"/>
  <path d="M17 62h.01M20 52h.01M25 43h.01M83 62h.01M80 52h.01M75 43h.01"
        stroke-width="7"/>
  <path d="M43 62 L50 55 L57 62 L50 69 Z"/>
`);

/**
 * Electric Boost — a figure inside a charged ring.
 *
 * The only sigil in the set whose subject is *the caster*, so it is built around
 * a standing figure rather than around a projectile or a footprint: two arcs
 * wrap the body where the discharge runs, and four short bolts break off it. No
 * diagonal, because nothing is thrown.
 */
const BOOST = WRAP(`
  <circle cx="50" cy="19" r="9"/>
  <path d="M50 30V62"/>
  <path d="M50 38L33 50M50 38L67 50"/>
  <path d="M50 62L38 88M50 62L62 88"/>
  <path d="M22 34C13 44 12 60 19 71"/>
  <path d="M78 34C87 44 88 60 81 71"/>
  <path d="M12 18L20 27H14L20 36"/>
  <path d="M88 18L80 27H86L80 36"/>
`);

/**
 * Electrical Sphere — a contained plasma orb above a containment ring.
 *
 * Built on the same ellipse the other far-cast sigils share — the slot has to
 * say "footprint" first. The big circle is the
 * sphere itself, with a hot rim and a dark interior bisected by a vertical
 * glint line, and three arcs breaking out of the upper silhouette read as
 * the corona escaping. The ellipse underneath is the containment platform.
 */
const ELECTRICAL = WRAP(`
  <ellipse cx="50" cy="78" rx="38" ry="11"/>
  <circle cx="50" cy="44" r="26"/>
  <path d="M50 18V70" stroke-width="2.4"/>
  <path d="M27 32L20 18M73 32L80 18M50 14L46 6M50 14L54 6"/>
  <path d="M14 78L8 78M86 78L92 78"/>
`);

/**
 * Earthen Spire — a paved crust running forward to a stepped obelisk.
 *
 * The first *line* cast in the set, and the only sigil whose footprint is a
 * band rather than a circle: the slot has to say "direction" before it says
 * anything else, so the bottom of the mark is a row of irregular plates
 * running off to one side. The obelisk at the impact point is a stepped
 * plinth rising to a small pyramidion, with a boulder shouldered against its
 * base. Two small chips at the foot of the obelisk are the leftover rocks the
 * band is still shaking loose.
 */
const EARTH = WRAP(`
  <path d="M5 78 L46 70 L54 70 L95 78 L95 84 L54 76 L46 76 L5 84 Z"/>
  <path d="M14 73 L20 70 M30 71 L36 68 M64 68 L70 71 M82 70 L88 73" stroke-width="3"/>
  <path d="M42 60 L58 60 L60 64 L40 64 Z"/>
  <path d="M44 38 L56 38 L58 60 L42 60 Z"/>
  <path d="M46 22 L54 22 L56 38 L44 38 Z"/>
  <path d="M50 6 L55 22 L45 22 Z"/>
  <path d="M30 64 L38 60 M62 60 L70 64" stroke-width="3.4"/>
`);

/**
 * Verdant Gate — a stone archway with a swirl standing in it.
 *
 * The only sigil whose footprint is a *threshold*: two heavy jambs on a ground
 * line, the courses of the arch stepped over the top of them, and inside the
 * opening a spiral rather than a fill, because the one thing the slot has to
 * say at 34px is that the doorway is not empty. The joints between the blocks
 * are drawn on both jambs — an arch you can count the stones of reads as
 * built, and every other mark in the bar reads as thrown.
 */
const PORTAL = WRAP(`
  <path d="M8 92H92"/>
  <path d="M20 92V46C20 30 33 18 50 18C67 18 80 30 80 46V92"/>
  <path d="M32 92V47C32 37 40 29 50 29C60 29 68 37 68 47V92"/>
  <path d="M20 62H32M20 78H32M68 62H80M68 78H80"/>
  <path d="M27 33L36 40M50 18V29M73 33L64 40"/>
  <path d="M52 43C59 44 63 50 62 57C61 66 53 71 45 69C36 67 32 58 34 50"
        stroke-width="3.2"/>
`);

/**
 * Tidewrought Ring — a segmented hoop standing clear of the ground.
 *
 * The second sigil built on a threshold, and it has to disagree with the gate's
 * at 34px or the bar has two doorways in it. Everything that separates them is
 * in the mark: the gate sits *on* the ground line and the ring **hovers over
 * it** on two spurs, the gate's opening is stepped masonry and the ring is one
 * continuous hoop with the joints ticked across it, and where the gate puts a
 * spiral in the middle this one puts a spiral **and leaves the centre empty**,
 * because the one thing this ability is about is the hole.
 */
const AETHER = WRAP(`
  <path d="M8 92H92"/>
  <circle cx="50" cy="45" r="34"/>
  <circle cx="50" cy="45" r="25"/>
  <path d="M50 20V11M50 70V79M25 45H16M75 45H84M32 27L26 21M68 27L74 21M32 63L26 69M68 63L74 69"/>
  <path d="M38 76L33 92M62 76L67 92"/>
  <path d="M60 35C69 42 67 55 57 58C46 61 37 52 41 42" stroke-width="3.2"/>
  <path d="M43 33h.01M60 55h.01" stroke-width="5"/>
`);

/**
 * Fire Portal — a ring of sparks with nothing inside it.
 *
 * The third mark in the bar built on a doorway, and the one that has to lose
 * every structural cue the other two have or there are three archways down
 * there. So: no ground line, because this one touches nothing; no joints,
 * no ticks and no second hoop, because nothing is made of pieces; and the
 * contour itself is **broken into arcs** rather than drawn as a circle, since
 * what is standing there is a cut and not a rim. Round the outside, six sparks
 * flung off on tangents — which no other sigil in the set has and which is the
 * whole ability at 34px — and in the middle, deliberately, nothing at all. The
 * spark at the foot is the one drawing it, caught mid-lap.
 */
const FIRE_PORTAL = WRAP(`
  <path d="M23 72A32 32 0 0 1 30 25"/>
  <path d="M39 19A32 32 0 0 1 71 23"/>
  <path d="M78 30A32 32 0 0 1 79 66"/>
  <path d="M72 75A32 32 0 0 1 34 79"/>
  <path d="M26 24L14 12M69 21L79 8M83 41L96 34M79 70L92 79M33 83L26 95"
        stroke-width="3"/>
  <path d="M14 55L3 52" stroke-width="3"/>
  <circle cx="50" cy="82" r="5" fill="currentColor" stroke="none"/>
  <path d="M55 86L70 93M52 88L58 98" stroke-width="3"/>
`);

/** Keyed by the ids in `ELEMENTS`. */
export const ELEMENT_SIGILS = {
  pyre: PYRE,
  kraken: KRAKEN,
  electrical: ELECTRICAL,
  earth: EARTH,
  portal: PORTAL,
  aether: AETHER,
  firePortal: FIRE_PORTAL
};

/**
 * Magic Boost — a figure inside a wound ribbon.
 *
 * The companion to the charge's mark, and deliberately the same standing figure
 * so the two read as a pair. What differs is everything around it: no bolts and
 * no broken arcs, but one continuous line spiralling around the body — passing
 * behind it at the waist and in front of it at the shoulders — over a shallow
 * pool of smoke at the feet.
 */
const MAGIC = WRAP(`
  <circle cx="50" cy="19" r="9"/>
  <path d="M50 30V62"/>
  <path d="M50 38L34 48M50 38L66 48"/>
  <path d="M50 62L39 88M50 62L61 88"/>
  <path d="M17 40C17 30 32 24 50 24C68 24 83 30 83 40"/>
  <path d="M83 40C83 50 68 56 50 56C32 56 17 62 17 72"/>
  <path d="M17 72C17 82 32 88 50 88" opacity="0.9"/>
  <path d="M14 84C22 92 78 92 86 84"/>
`);

/**
 * Fire Boost — a figure inside a ring of orbiting embers.
 *
 * The third of the trio, and the same standing figure again so all three read
 * as a set. What is around it is neither struck nor wound: two leaning ellipses
 * cross behind and in front of the body — the rings the orbs run — with a filled
 * dot on each where the ember is, and a tongue of flame climbing off each
 * shoulder.
 */
const FIRE = WRAP(`
  <circle cx="50" cy="19" r="9"/>
  <path d="M50 30V62"/>
  <path d="M50 38L34 48M50 38L66 48"/>
  <path d="M50 62L39 88M50 62L61 88"/>
  <ellipse cx="50" cy="52" rx="36" ry="14" transform="rotate(22 50 52)"/>
  <ellipse cx="50" cy="52" rx="36" ry="14" transform="rotate(-22 50 52)"/>
  <circle cx="82" cy="66" r="4.5" fill="currentColor" stroke="none"/>
  <circle cx="18" cy="66" r="4.5" fill="currentColor" stroke="none"/>
  <path d="M34 34C31 27 34 22 38 19C37 25 42 26 41 33"/>
  <path d="M66 34C69 27 66 22 62 19C63 25 58 26 59 33"/>
`);

/**
 * The self buffs' marks. Kept out of `ELEMENT_SIGILS` for the same reason they
 * are kept out of `ELEMENTS`: none of them is an ability, and nothing that walks
 * that map should find them.
 */
export const BOOST_SIGIL = BOOST;
export const MAGIC_SIGIL = MAGIC;
export const FIRE_SIGIL = FIRE;
