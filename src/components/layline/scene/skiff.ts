/**
 * The boat, authored in code. A 49er flavoured skiff: 4.9 m overall, 1.74 m
 * across the hull and 2.7 m across the racks, 8 m of mast.
 *
 * The hull is a loft, not a box. Five curves run the length of it (sheer,
 * chine, keel, the chine's share of the beam, the freeboard) and every station
 * is read off them, which is how a boat gets bow flare: forward the chine is a
 * third of the deck beam and aft it is nine tenths, so the topsides lean out
 * over the water at the bow and stand up straight at the transom. Change a
 * number in one of those tables and the whole surface follows it.
 *
 * Waterline at y = 0. Everything above is freeboard and everything below is in
 * the water, so a hull placed at the sampled wave height sits in the sea rather
 * than on it, and heel turns about the join.
 *
 * Colour rides on the vertices. One material carries all six liveries, which
 * keeps a boat down to a single draw call for topsides, transom, rack frames,
 * spars and standing rigging together. The surfaces that face the sky are the
 * one exception and live in matteGeometry.
 */
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  type BufferAttribute,
  LinearMipmapLinearFilter,
  SRGBColorSpace,
  Vector3,
} from "three";
import type { BoatMeta } from "@/lib/layline/types";

const DEG = Math.PI / 180;

export const SKIFF = {
  loa: 4.9,
  bow: -2.45,
  transom: 2.45,
  /* Half the drawn beam. The sim keeps its boats clear on a 4.9 by 1.7 m hull,
   * so anything the renderer draws outside that has to earn its own room: at
   * 1.36 every part of every boat in this replay clears every part of every
   * other one, sprit and hiking crew included. */
  rack: 1.36,
  mastZ: -0.39,
  mastTop: 8.0,
  hounds: 6.28,
  /* Far enough forward to tack a gennaker off, near enough that a sprit does
   * not spear a rack on a port and starboard crossing. */
  spritTip: -2.95,
  /* Where the wake is laid down: the stem, not the transom. The arms of a
   * planing wake open from the bow and the hull covers the first four metres
   * of them, which is why the foam appears to start under the transom. */
  bowOffset: 2.2,
};

const JIB_TACK: [number, number, number] = [0, 0.72, -2.36];
const KITE_TACK: [number, number, number] = [0, 0.46, SKIFF.spritTip + 0.06];
export { JIB_TACK, KITE_TACK };

/* Stations run bow (0) to transom (1). Half beams and heights in metres. */
const SHEER_HALF = [0.045, 0.3, 0.53, 0.7, 0.81, 0.87, 0.87, 0.845, 0.8];
const CHINE_RATIO = [0.3, 0.34, 0.42, 0.53, 0.64, 0.74, 0.83, 0.88, 0.9];
const SHEER_Y = [0.68, 0.575, 0.495, 0.44, 0.4, 0.375, 0.36, 0.35, 0.345];
const CHINE_Y = [0.4, 0.295, 0.215, 0.15, 0.1, 0.066, 0.043, 0.029, 0.02];
const KEEL_Y = [-0.02, -0.145, -0.225, -0.275, -0.3, -0.3, -0.275, -0.225, -0.165];

const STATIONS = 24;
const SECTION = 10;
/* Spans across one side deck. Six across the whole beam left three quads a
 * side, which is not enough to put a lip on a footwell: the recess came out as
 * a smoothed bulge and the boat read as a plank. */
const DECK_SPAN = 5;
const SOLE_SPAN = 4;
/* The footwell, in station parameter and in metres. It is a step with walls,
 * not a colour: from a helicopter a painted floor and a real one look nothing
 * alike. */
const WELL_FROM = 0.34;
const WELL_TO = 0.9;
const WELL_RAMP = 0.045;
const WELL_HALF = 0.42;
const WELL_DROP = 0.24;
/* Where the chine falls in the section parameter. Below it the bottom panel,
 * above it the topside, and the crease between them is the chine itself. */
const CHINE_U = 0.55;
const STRIPE_U = 0.9;

/* Where the racks start, stop and hang their cross tubes. Shared, because the
 * frame is part of the hull shell and the netting slung in it is not. */
const RACK_FROM = 0.3;
const RACK_TO = 0.95;
const RACK_MID = (RACK_FROM + RACK_TO) * 0.5;
const RACK_STEPS = 6;
const RACK_COLS = 3;

export interface Livery {
  hull: string;
  trim: string;
  cockpit: string;
  /* Side decks and foredeck, drawn on the matte path with the netting. From a
   * helicopter this is most of the boat, and from a chase camera four metres up
   * it is still the widest flat thing in frame, so it has to agree with the
   * chip in the standings from both. A lighter stand in colour bought altitude
   * legibility at the price of the boat's identity at eye level; the rack rails
   * carry that job now. */
  panel: string;
  /* Helmets. Not derived from the hull: a near black boat put a near black cap
   * on a near black neck and the crew came back headless, which is the same
   * failure the pale liveries hit from the other end. Every value here has to
   * separate from GEAR and from AID, and it is checked against the hull it will
   * be seen over rather than assumed. */
  helmet: string;
  /* Rack netting. Dark on every boat, because a rack drawn as a plate in the
   * deck colour turns a 2.7 m skiff into a pale raft that owns the frame. */
  tramp: string;
  /* The head panel of the mainsail, the one identifier a chase camera can read
   * at any distance. Six values, pairwise apart in at least one channel. */
  head: string;
  /* Gennaker cloth. */
  kite: string;
}

/* Hull family per nation, trim second. Two hulls in this fleet cannot carry a
 * white stripe: the white boat and the black one both take the red. */
const COCKPIT = "#252c33";
/* Blue enough to stay blue. The netting is the largest flat panel on the boat
 * in a wide, so whatever it returns is what a reviewer reads the rack as. */
const TRAMP = "#1c242d";

export const LIVERY: Record<string, Livery> = {
  fra: {
    hull: "#3b74ff",
    trim: "#eef3f8",
    cockpit: COCKPIT,
    panel: "#3b74ff",
    helmet: "#eef3f8",
    tramp: TRAMP,
    head: "#3b74ff",
    kite: "#3b74ff",
  },
  usa: {
    hull: "#e4353f",
    trim: "#eef3f8",
    cockpit: COCKPIT,
    panel: "#e4353f",
    helmet: "#eef3f8",
    tramp: TRAMP,
    head: "#e4353f",
    kite: "#e4353f",
  },
  gbr: {
    hull: "#e8eef4",
    trim: "#e4353f",
    cockpit: COCKPIT,
    panel: "#e8eef4",
    /* The one crew who cannot wear the pale helmet: a white cap over a white
     * boat is the headless failure again, from the light end. It takes the
     * team red instead, because the near black the other end offers would land
     * on the near black neck under it. */
    helmet: "#e4353f",
    tramp: TRAMP,
    head: "#e8eef4",
    kite: "#e8eef4",
  },
  nzl: {
    hull: "#23282e",
    trim: "#e4353f",
    cockpit: COCKPIT,
    /* Near the hull, not a stand in slate. The deck is the largest thing a
     * chase camera sees of this boat and a mid grey plate on it contradicted
     * the near black chip in the standings, the near black head panel on the
     * main and the way the same hull reads from every other rig. A hair above
     * the topsides, so the two planes still part under the sun. */
    panel: "#2f363f",
    helmet: "#eef3f8",
    tramp: TRAMP,
    head: "#23282e",
    /* Same near black the chip, the head panel and the hull carry. A run hides
     * the sail numbers behind the kite, so the kite is the only identifier
     * left and it has to be one the standings can be matched against. The
     * cloth is dark and the trim bands at head and foot are the team red,
     * which is what stops it reading as a hole in the sea. */
    kite: "#23282e",
  },
  aus: {
    hull: "#2fae62",
    trim: "#eef3f8",
    cockpit: COCKPIT,
    panel: "#2fae62",
    helmet: "#eef3f8",
    tramp: TRAMP,
    head: "#2fae62",
    kite: "#2fae62",
  },
  jpn: {
    hull: "#ff5d8f",
    trim: "#eef3f8",
    cockpit: COCKPIT,
    panel: "#ff5d8f",
    helmet: "#eef3f8",
    tramp: TRAMP,
    head: "#ff5d8f",
    kite: "#ff5d8f",
  },
};

const SPAR = "#262c33";
const WIRE = "#aeb8c0";
const GEAR = "#2b323a";
/* Buoyancy aids, one value for the whole fleet the way a class supplies them.
 * It cannot be a team hue: the aid is the widest part of a crew silhouette and
 * it sits over the boat's own colour, so a hull hue there loses the sailor and
 * a pale trim under this sun comes back cream and loses the gear. Amber belongs
 * to the wind and violet to raw telemetry, so the aid takes the high visibility
 * orange neither of them is using. */
const AID = "#f4632a";

/** Sailcloth, the one white on the page that is not a whitecap. */
export const CLOTH = "#e6f0fb";

export function liveryOf(boat: BoatMeta): Livery {
  return LIVERY[boat.id] ?? LIVERY.gbr;
}

/* Cosine blend between knots, so a nine entry table still lofts without
 * leaving a crease across the topside at every station it names. */
function curveAt(table: readonly number[], s: number): number {
  const n = table.length - 1;
  const u = (s < 0 ? 0 : s > 1 ? 1 : s) * n;
  const i = Math.min(Math.floor(u), n - 1);
  const w = 0.5 - 0.5 * Math.cos(Math.PI * (u - i));
  return table[i] + (table[i + 1] - table[i]) * w;
}

function lerpTable(xs: readonly number[], ys: readonly number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  const n = xs.length - 1;
  if (x >= xs[n]) return ys[n];
  let i = 0;
  while (i < n && xs[i + 1] < x) i++;
  const span = xs[i + 1] - xs[i];
  return ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / span;
}

interface Shell {
  pos: number[];
  col: number[];
  uv: number[];
  /* Radial direction and radius for every vertex that belongs to a tube, zero
   * for every vertex that does not. A wire whose true diameter falls under a
   * pixel does not thin out, it breaks into a chain of beads, and the fix has
   * to happen where the pixel size is known. The renderer reads this to hold a
   * minimum screen width; see WIRE_GLSL. */
  wire: number[];
  idx: number[];
}

function shell(): Shell {
  return { pos: [], col: [], uv: [], wire: [], idx: [] };
}

function put(s: Shell, x: number, y: number, z: number, c: Color, u = 0, v = 0): number {
  const i = s.pos.length / 3;
  s.pos.push(x, y, z);
  s.col.push(c.r, c.g, c.b);
  s.uv.push(u, v);
  s.wire.push(0, 0, 0, 0);
  return i;
}

function quad(s: Shell, a: number, b: number, c: number, d: number): void {
  s.idx.push(a, b, c, a, c, d);
}

function finish(s: Shell): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(s.pos, 3));
  g.setAttribute("color", new Float32BufferAttribute(s.col, 3));
  g.setAttribute("uv", new Float32BufferAttribute(s.uv, 2));
  g.setAttribute("aWire", new Float32BufferAttribute(s.wire, 4));
  g.setIndex(s.idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Holds a tube at a minimum width on screen. Radius is authored in metres, so a
 * shroud drawn honestly is under a pixel wide by the time the boat is twenty
 * metres out and the rasteriser turns it into a dotted chain. Widening the
 * radius by whatever one pixel is worth at that vertex's depth costs nothing up
 * close, where the true radius already wins the max, and keeps the wire a
 * continuous line all the way to the far end of the course.
 *
 * aWire.w is zero on everything that is not a tube, and a geometry that never
 * declares the attribute reads the default zero vector, so both cases fall
 * through to the authored position untouched.
 */
export const WIRE_GLSL = /* glsl */ `
  vec3 wireOffset = aWire.xyz * aWire.w;
  vec3 wireCore = transformed - wireOffset;
  vec4 wireView = modelViewMatrix * vec4(wireCore, 1.0);
  float wireDepth = max(-wireView.z, 0.1);
  float wirePerPixel = 2.0 * wireDepth / (projectionMatrix[1][1] * uWireHeight);
  float wireGrow = mix(
    1.0,
    max(1.0, uWirePixels * wirePerPixel / max(aWire.w, 1e-4)),
    step(1e-5, aWire.w));
  transformed = wireCore + wireOffset * wireGrow;
`;

const AXIS = new Vector3();
const RADIAL_U = new Vector3();
const RADIAL_V = new Vector3();

/* Spars and wires are the same primitive at two thicknesses. Standing rigging
 * is drawn thicker than the 4 mm it would really be, but only far enough to
 * survive a chase camera at five metres: holding it together at course distance
 * is the shader's job, and every ring vertex carries the radial direction and
 * radius that job needs. */
function tube(
  s: Shell,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r0: number,
  r1: number,
  sides: number,
  c: Color,
  u = 0,
  v = 0,
): void {
  AXIS.set(bx - ax, by - ay, bz - az).normalize();
  RADIAL_U.set(0, 1, 0);
  if (Math.abs(AXIS.y) > 0.9) RADIAL_U.set(1, 0, 0);
  RADIAL_V.crossVectors(AXIS, RADIAL_U).normalize();
  RADIAL_U.crossVectors(RADIAL_V, AXIS).normalize();
  const first = s.pos.length / 3;
  for (let ring = 0; ring < 2; ring++) {
    const r = ring === 0 ? r0 : r1;
    const px = ring === 0 ? ax : bx;
    const py = ring === 0 ? ay : by;
    const pz = ring === 0 ? az : bz;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const dx = RADIAL_U.x * cs + RADIAL_V.x * sn;
      const dy = RADIAL_U.y * cs + RADIAL_V.y * sn;
      const dz = RADIAL_U.z * cs + RADIAL_V.z * sn;
      const i = put(s, px + dx * r, py + dy * r, pz + dz * r, c, u, v);
      s.wire[i * 4] = dx;
      s.wire[i * 4 + 1] = dy;
      s.wire[i * 4 + 2] = dz;
      s.wire[i * 4 + 3] = r;
    }
  }
  const capA = put(s, ax, ay, az, c, u, v);
  const capB = put(s, bx, by, bz, c, u, v);
  for (let k = 0; k < sides; k++) {
    const k2 = (k + 1) % sides;
    quad(s, first + k, first + k2, first + sides + k2, first + sides + k);
    s.idx.push(capA, first + k2, first + k);
    s.idx.push(capB, first + sides + k, first + sides + k2);
  }
}

function sectionAt(s: number, u: number, out: [number, number]): void {
  const sheerHalf = curveAt(SHEER_HALF, s);
  const chineHalf = sheerHalf * curveAt(CHINE_RATIO, s);
  const sheerY = curveAt(SHEER_Y, s);
  const chineY = curveAt(CHINE_Y, s);
  const keelY = curveAt(KEEL_Y, s);
  if (u <= CHINE_U) {
    const b = u / CHINE_U;
    out[0] = chineHalf * Math.pow(b, 0.72);
    out[1] = keelY + (chineY - keelY) * (0.65 * b + 0.35 * b * b);
    return;
  }
  const c = (u - CHINE_U) / (1 - CHINE_U);
  out[0] = chineHalf + (sheerHalf - chineHalf) * Math.pow(c, 0.85);
  out[1] = chineY + (sheerY - chineY) * Math.pow(c, 1.12);
}

function stationZ(s: number): number {
  return SKIFF.bow + SKIFF.loa * s;
}

function deckY(s: number): number {
  return curveAt(SHEER_Y, s);
}

/* Crown across the side deck. The hull shell and the footwell both step off it,
 * so they read one value or they leave a lip along the coaming. */
function camber(across: number): number {
  return 0.045 * (1 - across * across);
}

function smoothstep(a: number, b: number, x: number): number {
  const u = (x - a) / (b - a);
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return c * c * (3 - 2 * c);
}

/* How open the footwell is at this station: 0 forward of it and aft of it, 1
 * through the middle. The coaming and the floor both scale by it, so the ends
 * of the well close themselves and no bulkhead has to be authored. */
function wellAt(s: number): number {
  return (
    smoothstep(WELL_FROM, WELL_FROM + WELL_RAMP, s) *
    (1 - smoothstep(WELL_TO - WELL_RAMP, WELL_TO, s))
  );
}

/** Hull, deck, racks, spars and standing rigging as one coloured shell. */
export function hullGeometry(livery: Livery): BufferGeometry {
  const s = shell();
  const hull = new Color(livery.hull);
  const trim = new Color(livery.trim);
  const panel = new Color(livery.panel);
  const spar = new Color(SPAR);
  const wire = new Color(WIRE);
  const probe: [number, number] = [0, 0];

  for (const side of [1, -1]) {
    const base = s.pos.length / 3;
    for (let j = 0; j < STATIONS; j++) {
      const st = j / (STATIONS - 1);
      const z = stationZ(st);
      for (let k = 0; k <= SECTION; k++) {
        const u = k / SECTION;
        sectionAt(st, u, probe);
        put(s, side * probe[0], probe[1], z, u >= STRIPE_U ? trim : hull);
      }
    }
    for (let j = 0; j < STATIONS - 1; j++) {
      for (let k = 0; k < SECTION; k++) {
        const a = base + j * (SECTION + 1) + k;
        const b = a + SECTION + 1;
        if (side > 0) quad(s, a, a + 1, b + 1, b);
        else quad(s, a, b, b + 1, a + 1);
      }
    }
  }

  /* Transom: a fan around the middle of the last station, running port sheer
   * down round the keel and back across the deck edge. */
  const tz = stationZ(1);
  const centre = put(s, 0, (curveAt(SHEER_Y, 1) + curveAt(KEEL_Y, 1)) * 0.5, tz, hull);
  const ring: number[] = [];
  for (let k = SECTION; k >= 0; k--) {
    sectionAt(1, k / SECTION, probe);
    ring.push(put(s, -probe[0], probe[1], tz, k / SECTION >= STRIPE_U ? trim : hull));
  }
  for (let k = 1; k <= SECTION; k++) {
    sectionAt(1, k / SECTION, probe);
    ring.push(put(s, probe[0], probe[1], tz, k / SECTION >= STRIPE_U ? trim : hull));
  }
  const transomHalf = curveAt(SHEER_HALF, 1);
  const transomY = curveAt(SHEER_Y, 1);
  for (let k = DECK_SPAN - 1; k >= 1; k--) {
    const across = (k / DECK_SPAN) * 2 - 1;
    ring.push(
      put(s, across * transomHalf, transomY + 0.045 * (1 - across * across), tz, panel),
    );
  }
  for (let k = 0; k < ring.length; k++) {
    s.idx.push(centre, ring[k], ring[(k + 1) % ring.length]);
  }

  /* Rack frames: three cross tubes and an outboard rail. The rail takes the
   * trim rather than the deck panel, which is what draws the boat's own outline
   * around it from above: a 2.7 m wide bright line either side reads at
   * helicopter range where a deck colour has already gone to mush, and it is
   * the element the near black boat is identified by. The netting the frame
   * carries is built separately, because the frame wants the sun on it and the
   * netting cannot have it. */
  const yRail = deckY(RACK_MID) + 0.05;
  for (const side of [1, -1]) {
    tube(
      s,
      side * SKIFF.rack,
      yRail,
      stationZ(RACK_FROM),
      side * SKIFF.rack,
      yRail,
      stationZ(RACK_TO),
      0.042,
      0.042,
      5,
      trim,
    );
    for (const st of [RACK_FROM, RACK_MID, RACK_TO]) {
      tube(
        s,
        side * curveAt(SHEER_HALF, st),
        deckY(st) + 0.02,
        stationZ(st),
        side * SKIFF.rack,
        yRail,
        stationZ(st),
        0.03,
        0.028,
        4,
        spar,
      );
    }
  }

  /* Bowsprit, mast, boom vang tang, spreaders, then the wires. */
  tube(s, 0, 0.52, SKIFF.bow + 0.16, 0, 0.4, SKIFF.spritTip, 0.055, 0.032, 6, spar);
  const mastBase = deckY(0.42) + 0.02;
  const mastZ = SKIFF.mastZ;
  const headZ = mastZ + 0.3;
  tube(s, 0, mastBase, mastZ, 0, SKIFF.mastTop, headZ, 0.078, 0.034, 8, spar);
  const houndsY = SKIFF.hounds;
  const houndsZ = mastZ + 0.3 * ((houndsY - mastBase) / (SKIFF.mastTop - mastBase));
  for (const side of [1, -1]) {
    tube(s, 0, houndsY, houndsZ, side * 0.3, houndsY - 0.08, houndsZ + 0.16, 0.03, 0.022, 6, spar);
    /* Six sides, not three. A three sided prism two pixels wide alternates its
     * facets down the run of the wire and the shading beats against the pixel
     * grid, which is half of what turned these into dotted chains; the other
     * half is the radius, and the renderer holds that. */
    tube(
      s,
      side * 0.3,
      houndsY - 0.08,
      houndsZ + 0.16,
      side * (SKIFF.rack - 0.08),
      deckY(0.44) + 0.05,
      stationZ(0.44),
      0.017,
      0.017,
      6,
      wire,
    );
    /* Trapeze wires, hanging from just under the masthead to the rack the crew
     * are standing on. */
    tube(
      s,
      0,
      SKIFF.mastTop - 0.75,
      headZ - 0.03,
      side * (SKIFF.rack - 0.14),
      deckY(0.6) + 0.06,
      stationZ(0.6),
      0.014,
      0.014,
      6,
      wire,
    );
  }
  tube(s, 0, houndsY, houndsZ, 0, 0.66, SKIFF.bow + 0.05, 0.017, 0.017, 6, wire);

  return finish(s);
}

/**
 * Everything on this boat that faces the sky: side decks, footwell, rack
 * netting. They are built apart from the shell because they are the surfaces
 * that must not answer the sun. Under a standard dielectric lobe a horizontal
 * panel hands back the sun's hue instead of its own, and these are flat and
 * large, so six differently liveried skiffs came back sharing one brown raft
 * with one brown floor in it, and the near black boat's own deck read as warm
 * taupe with the sun behind the camera. The material that draws this carries no
 * specular term at all, which is what mesh trampoline and non skid deck paint
 * do with the light anyway.
 */
export function matteGeometry(livery: Livery): BufferGeometry {
  const s = shell();
  const tramp = new Color(livery.tramp);
  const cockpit = new Color(livery.cockpit);
  const panel = new Color(livery.panel);

  /* Deck in three surfaces rather than one sheet across the beam: side decks
   * out to the coaming, a vertical coaming wall, and the floor of the well
   * between them. Where the well is closed the wall has no height and the floor
   * meets the side decks on the centreline, so the foredeck comes out solid
   * without a second grid.
   *
   * The side decks carry the team panel and everything the crew stand in is
   * dark. Six pale platforms all the same colour was the whole reason a fleet
   * of six read as one boat repeated. */
  for (const side of [1, -1]) {
    const base = s.pos.length / 3;
    for (let j = 0; j < STATIONS; j++) {
      const st = j / (STATIONS - 1);
      const z = stationZ(st);
      const half = curveAt(SHEER_HALF, st);
      const y = curveAt(SHEER_Y, st);
      const open = wellAt(st);
      const coam = WELL_HALF * open;
      for (let k = 0; k <= DECK_SPAN; k++) {
        const across = side * (1 - (1 - coam) * (k / DECK_SPAN));
        put(s, across * half, y + camber(across), z, panel);
      }
    }
    /* Both strips run outboard to inboard, so the side that steps toward
     * positive x winds the other way round to keep its face up. */
    for (let j = 0; j < STATIONS - 1; j++) {
      for (let k = 0; k < DECK_SPAN; k++) {
        const a = base + j * (DECK_SPAN + 1) + k;
        const b = a + DECK_SPAN + 1;
        if (side > 0) quad(s, a, a + 1, b + 1, b);
        else quad(s, a, b, b + 1, a + 1);
      }
    }
  }

  for (const side of [1, -1]) {
    const base = s.pos.length / 3;
    for (let j = 0; j < STATIONS; j++) {
      const st = j / (STATIONS - 1);
      const z = stationZ(st);
      const half = curveAt(SHEER_HALF, st);
      const y = curveAt(SHEER_Y, st);
      const open = wellAt(st);
      const across = side * WELL_HALF * open;
      put(s, across * half, y + camber(across), z, cockpit);
      put(s, across * half, y + camber(across) - WELL_DROP * open, z, cockpit);
    }
    for (let j = 0; j < STATIONS - 1; j++) {
      const a = base + j * 2;
      if (side > 0) quad(s, a, a + 1, a + 3, a + 2);
      else quad(s, a, a + 2, a + 3, a + 1);
    }
  }

  const soleBase = s.pos.length / 3;
  for (let j = 0; j < STATIONS; j++) {
    const st = j / (STATIONS - 1);
    const z = stationZ(st);
    const half = curveAt(SHEER_HALF, st);
    const y = curveAt(SHEER_Y, st);
    const open = wellAt(st);
    for (let k = 0; k <= SOLE_SPAN; k++) {
      const across = WELL_HALF * open * ((k / SOLE_SPAN) * 2 - 1);
      put(s, across * half, y + camber(across) - WELL_DROP * open, z, cockpit);
    }
  }
  for (let j = 0; j < STATIONS - 1; j++) {
    for (let k = 0; k < SOLE_SPAN; k++) {
      const a = soleBase + j * (SOLE_SPAN + 1) + k;
      const b = a + SOLE_SPAN + 1;
      quad(s, a, b, b + 1, a + 1);
    }
  }

  for (const side of [1, -1]) {
    const base = s.pos.length / 3;
    /* Netting sags between the frames, and the sag is what stops the plate
     * being flat: a flat panel takes one grazing shading value across the whole
     * of it and comes back reading as a lid. */
    for (let j = 0; j <= RACK_STEPS; j++) {
      const st = RACK_FROM + (RACK_TO - RACK_FROM) * (j / RACK_STEPS);
      const z = stationZ(st);
      const y = deckY(st);
      const inner = curveAt(SHEER_HALF, st);
      const outer = SKIFF.rack - 0.06;
      for (let c = 0; c <= RACK_COLS; c++) {
        const w = c / RACK_COLS;
        put(
          s,
          side * (inner + (outer - inner) * w),
          y - 0.005 + 0.011 * w - 0.035 * Math.sin(Math.PI * w),
          z,
          tramp,
        );
      }
    }
    for (let j = 0; j < RACK_STEPS; j++) {
      for (let c = 0; c < RACK_COLS; c++) {
        const a = base + j * (RACK_COLS + 1) + c;
        const b = a + RACK_COLS + 1;
        if (side > 0) quad(s, a, b, b + 1, a + 1);
        else quad(s, a, a + 1, b + 1, b);
      }
    }
  }
  return finish(s);
}

/* Hips at the origin, feet on the rack, facing the bow. The group carrying the
 * pair slides outboard and rolls with the heel, which is what turns a standing
 * figure into a hiking one without a second pose. */
function crewFigure(s: Shell, z: number, gear: Color, vest: Color, helmet: Color): void {
  for (const side of [1, -1]) {
    tube(s, side * 0.15, 0, z + 0.1, side * 0.11, 0.4, z - 0.05, 0.058, 0.052, 5, gear);
    tube(s, side * 0.11, 0.4, z - 0.05, side * 0.075, 0.76, z + 0.04, 0.068, 0.062, 5, gear);
    tube(s, side * 0.19, 1.18, z - 0.04, side * 0.13, 0.86, z - 0.22, 0.046, 0.04, 4, gear);
  }
  tube(s, 0, 0.76, z + 0.04, 0, 1.22, z - 0.03, 0.1, 0.128, 6, vest);
  /* A neck, ten centimetres of it. Without the gap the helmet cap lands
   * straight on the buoyancy aid cap and the pair read as one post the moment
   * their two values land close, which four of these six liveries do. */
  tube(s, 0, 1.16, z - 0.03, 0, 1.34, z - 0.04, 0.05, 0.048, 5, gear);
  tube(s, 0, 1.32, z - 0.04, 0, 1.5, z - 0.05, 0.098, 0.09, 6, helmet);
}

/**
 * The two crew. Wetsuit dark on the limbs so the shape reads as a person
 * against any hull in the fleet, class orange on the buoyancy aid where it is
 * the widest part of the silhouette, and a helmet chosen per boat to part from
 * both. This is the one assembly on the skiff with three values inside half a
 * metre, so none of them may be derived from another.
 */
export function crewGeometry(livery: Livery): BufferGeometry {
  const s = shell();
  const gear = new Color(GEAR);
  const vest = new Color(AID);
  const helmet = new Color(livery.helmet);
  crewFigure(s, -0.35, gear, vest, helmet);
  crewFigure(s, 1.05, gear, vest, helmet);
  return finish(s);
}

export interface SailSpec {
  tack: readonly [number, number, number];
  head: readonly [number, number, number];
  chord: readonly number[];
  twist: number;
  draft: number;
  trim: number;
  luffBow: number;
  rise: number;
  spans: number;
  chords: number;
  uSpan: number;
}

/* Foot chord to head chord, up the luff. The main is a square top: the head is
 * a third of the foot rather than a point, which is what gives a skiff its
 * silhouette. */
export const MAIN_CHORD = [2.6, 2.58, 2.5, 2.38, 2.22, 2.02, 1.76, 1.42, 0.88];
const JIB_CHORD = [1.86, 1.8, 1.7, 1.56, 1.38, 1.16, 0.9, 0.6, 0.1];
const KITE_CHORD = [4.1, 4.4, 4.5, 4.4, 4.15, 3.75, 3.15, 2.25, 0.42];

export const MAIN_SPEC: SailSpec = {
  tack: [0, 1.06, 0.026],
  head: [0, 7.62, 0.285],
  chord: MAIN_CHORD,
  twist: 8.5,
  draft: 0.085,
  trim: 0,
  luffBow: 0,
  rise: 0.02,
  spans: 11,
  chords: 9,
  /* The last twenty six texels of the sheet are spar, not cloth, which is what
   * lets the boom share the mainsail's one draw call. */
  uSpan: 0.94,
};

const JIB_SPEC: SailSpec = {
  tack: [0, 0, 0],
  head: [0, 5.56, 2.2],
  chord: JIB_CHORD,
  twist: 11,
  draft: 0.065,
  trim: 0,
  luffBow: 0,
  rise: 0.015,
  spans: 9,
  chords: 7,
  uSpan: 1,
};

/* The gennaker's trim is built into the shape rather than applied to the mesh:
 * its luff is pinned at both ends, between the sprit and the masthead, so only
 * the clew swings and rotating the whole sail would drag the head off the
 * mast. */
export const KITE_SPEC: SailSpec = {
  tack: [0, 0, 0],
  /* Measured off the sprit tip the sail is tacked to, so the head lands on the
   * masthead. Move the sprit and this number moves with it. */
  head: [0, 6.84, 2.8],
  chord: KITE_CHORD,
  twist: 16,
  draft: 0.2,
  trim: 58,
  luffBow: 0.55,
  rise: 0.05,
  /* Fifteen rather than the eleven every other sail carries. The drape can
   * only bend the cloth where there is cloth to bend, and at eleven spans a
   * single panel is half a metre of flat sheet that cuts the mainsail between
   * its own corners whatever the drape does to those corners. Fifteen takes
   * the pair from crossing in all fifty wind and sheet combinations to nine.
   * Past this the panels stop being the limit and it buys nothing. */
  spans: 15,
  chords: 9,
  uSpan: 1,
};

/**
 * A sail as two skins a centimetre apart, each facing outward and each carrying
 * its own reading of the sheet. One double sided surface would show the sail
 * number backwards from the other side; real cloth carries it twice and so does
 * this.
 *
 * Spread is how much of the sheet has been let out to leeward: 1 for a sail
 * drawing and 0 for one shaken onto the centreline. Only the sideways half of
 * the cloth answers to it, so a sail at spread 0 is the same shape whichever
 * side it was cut for, and the swap between the two costs no movement.
 */
function sailShell(s: Shell, spec: SailSpec, lee: number, cloth: Color, spread: number): void {
  const spans = spec.spans;
  const chords = spec.chords;
  for (let skin = 0; skin < 2; skin++) {
    const face = skin === 0 ? 1 : -1;
    const base = s.pos.length / 3;
    for (let j = 0; j <= spans; j++) {
      const v = j / spans;
      const c = curveAt(spec.chord, v);
      const theta = (spec.trim + spec.twist * Math.pow(v, 1.3)) * DEG;
      const dirX = lee * spread * Math.sin(theta);
      const dirZ = Math.cos(theta);
      const nX = lee * Math.cos(theta);
      const nZ = -Math.sin(theta);
      const lx =
        spec.tack[0] +
        (spec.head[0] - spec.tack[0]) * v +
        lee * spread * spec.luffBow * Math.pow(Math.sin(Math.PI * v), 0.8);
      const ly = spec.tack[1] + (spec.head[1] - spec.tack[1]) * v;
      const lz = spec.tack[2] + (spec.head[2] - spec.tack[2]) * v;
      /* Which way the sheet has to run so the number reads the right way round
       * from the side that can see it. Standing off a skin, the chord points
       * across the frame in the direction the other skin's chord does not, and
       * the tack decides which of the two is facing you. */
      const mirrored = skin === 0 ? lee > 0 : lee < 0;
      for (let i = 0; i <= chords; i++) {
        const w = i / chords;
        /* Draft answers to the sheet. The centimetre that holds the two skins
         * apart does not, or a sail shaken flat would fold its faces together
         * and fight itself for the pixel. */
        const camber =
          spread * spec.draft * c * Math.sin(Math.PI * Math.pow(w, 0.82)) + face * 0.011;
        put(
          s,
          lx + dirX * w * c + nX * camber,
          ly + w * c * spec.rise * (1 - v),
          lz + dirZ * w * c + nZ * camber,
          cloth,
          (mirrored ? 1 - w : w) * spec.uSpan,
          v,
        );
      }
    }
    /* Winding decides which way a skin looks, and the leeward side changes with
     * the tack, so the same grid gets wound both ways. */
    const outward = face * lee > 0;
    for (let j = 0; j < spans; j++) {
      for (let i = 0; i < chords; i++) {
        const a = base + j * (chords + 1) + i;
        const b = a + chords + 1;
        if (outward) quad(s, a, b, b + 1, a + 1);
        else quad(s, a, a + 1, b + 1, b);
      }
    }
  }
}

/* The mainsail's outline in the boom node's own frame: the luff at the tack and
 * the head, then the leech sampled up the span. Anything that has to know how
 * much of the picture a boat covers has to look here as well as at the hull: the
 * cloth is the widest thing on the boat and it swings with the boom, so the
 * hull's own corners do not follow it.
 *
 * The leech is sampled rather than taken as the chord between clew and peak,
 * because this is a square top with roach in it: at mid hoist the cut stands
 * nearly half a metre outboard of that chord, and at chase range half a metre is
 * the strip of cloth a label placed off the corners alone comes down on. Both
 * lateral signs, since the twist swings the leech toward whichever side the
 * boat is on and one box has to hold either. Derived from the numbers the sail
 * is cut from, because an envelope typed in by hand drifts away from the cloth
 * the first time the cut changes. */
function mainOutline(): number[] {
  const points: number[] = [
    MAIN_SPEC.tack[0],
    MAIN_SPEC.tack[1],
    MAIN_SPEC.tack[2],
    MAIN_SPEC.head[0],
    MAIN_SPEC.head[1],
    MAIN_SPEC.head[2],
  ];
  const spans = 4;
  for (let step = 0; step <= spans; step++) {
    const v = step / spans;
    const chord = curveAt(MAIN_CHORD, v);
    const theta = (MAIN_SPEC.trim + MAIN_SPEC.twist * Math.pow(v, 1.3)) * DEG;
    const y =
      MAIN_SPEC.tack[1] +
      (MAIN_SPEC.head[1] - MAIN_SPEC.tack[1]) * v +
      chord * MAIN_SPEC.rise * (1 - v);
    const z =
      MAIN_SPEC.tack[2] +
      (MAIN_SPEC.head[2] - MAIN_SPEC.tack[2]) * v +
      Math.cos(theta) * chord;
    const x = Math.sin(theta) * chord;
    points.push(x, y, z, -x, y, z);
  }
  return points;
}

export const MAIN_CORNERS = mainOutline();

/**
 * A sail, and the same sail shaken flat hung off it as a morph target. Every
 * sail on the boat changes sides at some point in a race, and swapping the
 * drawn shape for its mirror is a manoeuvre that takes one frame; blending the
 * draft out and back in instead lets the cloth go soft across the crossing,
 * which is both what cloth does and the only way the two cut sides can meet
 * without a step.
 *
 * Position and normal only. The flat build is the same vertices in the same
 * order carrying the same sheet, so nothing else has to travel with it.
 */
function luffing(build: (s: Shell, spread: number) => void): BufferGeometry {
  const full = shell();
  build(full, 1);
  const flat = shell();
  build(flat, 0);
  const drawing = finish(full);
  const shaken = finish(flat);
  drawing.morphAttributes.position = [shaken.getAttribute("position") as BufferAttribute];
  drawing.morphAttributes.normal = [shaken.getAttribute("normal") as BufferAttribute];
  /* Again, now that the targets are on: culling reads one sphere per mesh, and
   * the one finish left covers the drawn shape alone. A sail that leaves its own
   * bounds mid gybe is culled at the moment it is being watched. */
  drawing.computeBoundingSphere();
  return drawing;
}

/** Mainsail and boom, in a frame whose origin is the mast at the waterline. */
export function mainGeometry(lee: number): BufferGeometry {
  return luffing((s, spread) => {
    sailShell(s, MAIN_SPEC, lee, new Color(CLOTH), spread);
    const spar = new Color(SPAR);
    tube(s, 0, 1.0, 0.06, 0, 1.05, 2.64, 0.055, 0.045, 6, spar, 0.98, 0.017);
  });
}

export function jibGeometry(lee: number): BufferGeometry {
  return luffing((s, spread) => sailShell(s, JIB_SPEC, lee, new Color(CLOTH), spread));
}

export function kiteGeometry(lee: number): BufferGeometry {
  return luffing((s, spread) => sailShell(s, KITE_SPEC, lee, new Color("#ffffff"), spread));
}

/* How far the boom carries off the centreline for a given true wind angle.
 * Read off how these boats are actually trimmed: sheeted almost on the
 * centreline upwind, squared off on the run. */
const TRIM_TWA = [0, 30, 45, 60, 90, 120, 140, 165, 180];
const TRIM_DEG = [5, 6, 9, 18, 38, 58, 70, 82, 85];

export function boomAngle(twa: number): number {
  return lerpTable(TRIM_TWA, TRIM_DEG, Math.abs(twa));
}

/**
 * The sail sheet: cloth, panel seams, a head panel in the livery and the sail
 * number, plus the spar strip the boom is mapped to. Painted at the family the
 * page already loaded rather than at a name written in here, so the numbers on
 * a sail are set in the same face as the numbers in the dock.
 */
export function sailTexture(boat: BoatMeta, livery: Livery): CanvasTexture {
  const width = 256;
  const height = 512;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  texture.minFilter = LinearMipmapLinearFilter;
  if (ctx === null) return texture;

  const family =
    getComputedStyle(document.documentElement).getPropertyValue("--font-archivo").trim() ||
    "sans-serif";
  const cloth = width * MAIN_SPEC.uSpan;

  const paint = (): void => {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = CLOTH;
    ctx.fillRect(0, 0, cloth, height);
    ctx.fillStyle = SPAR;
    ctx.fillRect(cloth, 0, width - cloth, height);

    ctx.strokeStyle = "rgba(120,138,150,0.28)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 11; i++) {
      const y = (i / 11) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cloth, y);
      ctx.stroke();
    }

    /* The head panel names the boat, so it is the one colour on the sheet that
     * no two boats share. The keyline is what saves the white one: its panel is
     * the colour of the cloth it is painted on and nothing else would separate
     * them. */
    const band = height * 0.16;
    ctx.fillStyle = livery.head;
    ctx.fillRect(0, 0, cloth, band);
    ctx.strokeStyle = "#1c2126";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, cloth - 6, band - 6);
    /* Trim at the foot, well clear of the head panel. A rule laid under the
     * panel gets read as part of it at any distance the panel matters at, and
     * two of these boats trim in the same red another one flies. */
    ctx.fillStyle = livery.trim;
    ctx.fillRect(0, height * 0.972, cloth, height * 0.028);

    const [nation, number] = boat.sail.split(" ");
    ctx.fillStyle = "#1c2126";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 58px ${family}`;
    ctx.fillText(nation, cloth * 0.46, height * 0.5);
    ctx.font = `700 104px ${family}`;
    ctx.fillText(number, cloth * 0.46, height * 0.62);
    texture.needsUpdate = true;
  };

  paint();
  /* Repainted once the page's own faces are in: the first pass can land before
   * the loader finishes and fall back to whatever the browser had. */
  if (typeof document.fonts !== "undefined") void document.fonts.ready.then(paint);
  return texture;
}

/**
 * Gennaker cloth. The panels are radial, fanning down from the head the way a
 * kite is actually cut, and the head and foot bands are the team trim. Without
 * a sheet a kite comes out as one flat value and the sail turns into a coloured
 * hole in the sea whatever the camber underneath it is doing.
 *
 * The head band is cut to the same share of the luff the mainsail gives its
 * head panel, because on a run the kite hides the sail number and this band is
 * what is left to name the boat by.
 */
export function kiteTexture(livery: Livery): CanvasTexture {
  const width = 128;
  const height = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  texture.minFilter = LinearMipmapLinearFilter;
  if (ctx === null) return texture;

  ctx.fillStyle = livery.kite;
  ctx.fillRect(0, 0, width, height);

  /* Every seam twice, once dark and once light a pixel to the side: a single
   * stroke disappears into whichever of the six cloths it happens to match. */
  const seam = (ax: number, ay: number, bx: number, by: number): void => {
    ctx.strokeStyle = "rgba(16,22,28,0.20)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax + 1.6, ay);
    ctx.lineTo(bx + 1.6, by);
    ctx.stroke();
  };

  /* Sail v runs up the luff and the sampler flips it, so the top of the canvas
   * is the head and the fan opens downward from there. */
  for (let i = 0; i <= 7; i++) seam(width * 0.42, 0, (i / 7) * width, height);
  for (let i = 1; i < 4; i++) {
    const y = height * (0.62 + i * 0.11);
    seam(0, y, width, y);
  }

  const band = height * 0.16;
  ctx.fillStyle = livery.trim;
  ctx.fillRect(0, 0, width, band);
  ctx.fillRect(0, height - height * 0.06, width, height * 0.06);
  /* Tack and clew patches, where the loads land. */
  ctx.fillStyle = "rgba(28,33,38,0.55)";
  ctx.fillRect(0, height - 26, 26, 26);
  ctx.fillRect(width - 26, height - 26, 26, 26);

  texture.needsUpdate = true;
  return texture;
}

/** Soft round droplet, the one sprite the bow spray is drawn from. */
export function sprayTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const texture = new CanvasTexture(canvas);
  if (ctx === null) return texture;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.42, "rgba(255,255,255,0.5)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  texture.needsUpdate = true;
  return texture;
}
