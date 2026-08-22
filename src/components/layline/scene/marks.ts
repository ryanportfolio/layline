/**
 * The furniture on the racecourse: two inflatable marks and the race committee
 * boat that makes the starboard end of the line. Both are authored here for the
 * same reason the skiffs are, that a primitive box reads as a placeholder from
 * any distance, and the committee boat in particular is the object a viewer
 * uses to tell a start line from a piece of open water.
 *
 * Everything is built with its waterline at y = 0, so floating it is a matter of
 * putting the origin on the sea surface and letting the swell do the rest.
 */
import { BufferGeometry, Color, Float32BufferAttribute, LatheGeometry, Vector2 } from "three";

/* High visibility orange, the same value the crew buoyancy aids carry. Amber
 * belongs to the wind and violet to raw telemetry, so course furniture takes the
 * one warm colour neither of them is using. */
const MARK_SKIN = "#f4632a";
const MARK_WET = "#a8401a";
const MARK_BAND = "#22272d";

/* Deck and topsides sit near white on purpose. This sun is warm and it is aimed
 * at a mid grey exposure, so a mid grey deck comes back tan: the same trap the
 * pale liveries hit, and the same answer, which is to put the value high enough
 * that the tone curve rolls it back toward white. The roof and the cockpit are
 * the two values allowed to be dark, because from a hundred and sixty metres up
 * they are the only thing that says there is a boat under the deck. */
const VESSEL_TOPSIDE = "#eef3f7";
const VESSEL_STRIPE = "#16324f";
const VESSEL_BOTTOM = "#1b2730";
const VESSEL_DECK = "#e9eef2";
const VESSEL_ROOF = "#8e9ba5";
const VESSEL_WELL = "#2b343d";
const VESSEL_SOLE = "#7f8d99";
const VESSEL_WINDOW = "#141a21";
const VESSEL_SPAR = "#262c33";
const FLAG_FIELD = "#16324f";
const FLAG_PANEL = "#eef3f7";

type Rgb = [number, number, number];

const scratch = new Color();

function rgb(hex: string): Rgb {
  scratch.set(hex);
  return [scratch.r, scratch.g, scratch.b];
}

interface Shell {
  position: number[];
  color: number[];
  index: number[];
}

function newShell(): Shell {
  return { position: [], color: [], index: [] };
}

/* Every face gets its own four vertices. Sharing them would let the averaged
 * normal round the chine and the deck edge off, and a hard chine is most of what
 * says workboat rather than bath toy. */
function quad(
  shell: Shell,
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
  colour: Rgb,
): void {
  const base = shell.position.length / 3;
  for (const point of [a, b, c, d]) {
    shell.position.push(point[0], point[1], point[2]);
    shell.color.push(colour[0], colour[1], colour[2]);
  }
  shell.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function tri(
  shell: Shell,
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  colour: Rgb,
): void {
  const base = shell.position.length / 3;
  for (const point of [a, b, c]) {
    shell.position.push(point[0], point[1], point[2]);
    shell.color.push(colour[0], colour[1], colour[2]);
  }
  shell.index.push(base, base + 1, base + 2);
}

function toGeometry(shell: Shell): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(shell.position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(shell.color, 3));
  geometry.setIndex(shell.index);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/* Radius against height, waterline at zero. A racing inflatable is a squat
 * cylinder with the shoulder above the water and the taper on top, which is what
 * keeps it upright when a boat rounds it hard enough to lean on it. */
const MARK_PROFILE: [number, number][] = [
  [0.0, -0.62],
  [0.4, -0.56],
  [0.68, -0.4],
  [0.82, -0.16],
  [0.86, 0.1],
  [0.86, 0.62],
  [0.82, 0.9],
  [0.66, 1.12],
  [0.36, 1.28],
  [0.0, 1.34],
];

/**
 * One inflatable mark. Lathed rather than quad built: the sides are a smooth
 * revolve and faceting them would put a highlight seam down every panel.
 */
export function markGeometry(): BufferGeometry {
  const points = MARK_PROFILE.map(([radius, y]) => new Vector2(radius, y));
  const geometry = new LatheGeometry(points, 22);
  const position = geometry.getAttribute("position");
  const colours = new Float32Array(position.count * 3);
  const wet = rgb(MARK_WET);
  const skin = rgb(MARK_SKIN);
  const band = rgb(MARK_BAND);
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    /* Wet below the waterline, the team of one colour above it, and a dark band
     * under the shoulder so the mark has a horizon of its own from a helicopter
     * where the whole thing is thirty pixels tall. */
    const tone = y < 0 ? wet : y > 0.86 && y < 1.16 ? band : skin;
    colours[i * 3] = tone[0];
    colours[i * 3 + 1] = tone[1];
    colours[i * 3 + 2] = tone[2];
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colours, 3));
  return geometry;
}

/* Stations bow to stern for a 10.4 m committee boat, waterline at zero. Half
 * beams, sheer height, the turn of the bilge and the keel under it. Twice the
 * length of the skiffs starting off her, which is the size a boat has to be for
 * six of them to line up on it. */
const HULL_HALF = [
  0.11, 0.56, 0.92, 1.2, 1.39, 1.52, 1.58, 1.6, 1.6, 1.58, 1.55, 1.52, 1.48, 1.44,
];
const HULL_SHEER = [
  1.55, 1.36, 1.22, 1.12, 1.05, 1.0, 0.97, 0.95, 0.94, 0.94, 0.95, 0.97, 1.0, 1.02,
];
const HULL_CHINE = [
  0.55, 0.28, 0.1, 0.0, -0.06, -0.1, -0.13, -0.15, -0.16, -0.17, -0.18, -0.19, -0.2, -0.21,
];
const HULL_KEEL = [
  0.42, 0.05, -0.2, -0.36, -0.46, -0.52, -0.56, -0.58, -0.6, -0.6, -0.59, -0.57, -0.55, -0.52,
];
const HULL_BOW = -5.6;
const HULL_STERN = 4.8;
const CHINE_RATIO = 0.72;
/* Where the navy sheer stripe starts, as a fraction of the way up the topside.
 * A workboat's stripe is a hand's width, not a band. */
const STRIPE_FROM = 0.82;

const DECK_Y = 0.98;
const CABIN_BOW = -2.8;
const CABIN_STERN = 0.5;
const CABIN_HALF = 1.14;
const CABIN_TOP = 2.2;
const WINDOW_LOW = 1.54;
const WINDOW_HIGH = 1.98;
/* The working cockpit, aft of the wheelhouse, where the line is called from.
 * The sole is at deck level with a coaming standing above it and a rail capping
 * the coaming, because from a helicopter astern the whole aft end is one plane
 * otherwise and a single plane the width of the boat reads as an open box. */
const WELL_BOW = 0.7;
const WELL_STERN = 4.1;
const WELL_HALF = 1.16;
const WELL_LIP = 0.26;
const WELL_RAIL = 0.11;
const STAFF_Z = 2.4;
const STAFF_TOP = 4.32;
/* A signal staff is a broomstick, but a broomstick is a third of a pixel at the
 * ranges these rigs frame her from, and a staff nobody can see makes the flag
 * on it look like a sticker. Wide enough to hold a couple of pixels from the
 * helicopter, still slim against a 1.6 m half beam. */
const STAFF_HALF = 0.1;

function stationZ(i: number): number {
  return HULL_BOW + ((HULL_STERN - HULL_BOW) * i) / (HULL_HALF.length - 1);
}

function boxShell(
  shell: Shell,
  halfX: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  colour: Rgb,
  lid: Rgb | null,
): void {
  quad(shell, [-halfX, y0, z0], [halfX, y0, z0], [halfX, y1, z0], [-halfX, y1, z0], colour);
  quad(shell, [halfX, y0, z1], [-halfX, y0, z1], [-halfX, y1, z1], [halfX, y1, z1], colour);
  quad(shell, [halfX, y0, z0], [halfX, y0, z1], [halfX, y1, z1], [halfX, y1, z0], colour);
  quad(shell, [-halfX, y0, z1], [-halfX, y0, z0], [-halfX, y1, z0], [-halfX, y1, z1], colour);
  if (lid !== null) {
    quad(shell, [-halfX, y1, z0], [halfX, y1, z0], [halfX, y1, z1], [-halfX, y1, z1], lid);
  }
}

/**
 * The race committee boat: a small motor vessel, not a silhouette. It lies at
 * the starboard end of the line on its anchor with the staff that makes the line
 * over its stern quarter, which is where a real one puts it.
 */
export function committeeGeometry(): BufferGeometry {
  const shell = newShell();
  const bottom = rgb(VESSEL_BOTTOM);
  const topside = rgb(VESSEL_TOPSIDE);
  const stripe = rgb(VESSEL_STRIPE);
  const deck = rgb(VESSEL_DECK);
  const roof = rgb(VESSEL_ROOF);
  const well = rgb(VESSEL_WELL);
  const glass = rgb(VESSEL_WINDOW);
  const spar = rgb(VESSEL_SPAR);

  for (let i = 0; i + 1 < HULL_HALF.length; i++) {
    const z0 = stationZ(i);
    const z1 = stationZ(i + 1);
    for (const side of [1, -1]) {
      const c0 = HULL_HALF[i] * CHINE_RATIO * side;
      const c1 = HULL_HALF[i + 1] * CHINE_RATIO * side;
      const s0 = HULL_HALF[i] * side;
      const s1 = HULL_HALF[i + 1] * side;
      const mid0 = HULL_CHINE[i] + (HULL_SHEER[i] - HULL_CHINE[i]) * STRIPE_FROM;
      const mid1 = HULL_CHINE[i + 1] + (HULL_SHEER[i + 1] - HULL_CHINE[i + 1]) * STRIPE_FROM;
      const shoulder0 = c0 + (s0 - c0) * STRIPE_FROM;
      const shoulder1 = c1 + (s1 - c1) * STRIPE_FROM;
      quad(
        shell,
        [0, HULL_KEEL[i], z0],
        [0, HULL_KEEL[i + 1], z1],
        [c1, HULL_CHINE[i + 1], z1],
        [c0, HULL_CHINE[i], z0],
        bottom,
      );
      quad(
        shell,
        [c0, HULL_CHINE[i], z0],
        [c1, HULL_CHINE[i + 1], z1],
        [shoulder1, mid1, z1],
        [shoulder0, mid0, z0],
        topside,
      );
      quad(
        shell,
        [shoulder0, mid0, z0],
        [shoulder1, mid1, z1],
        [s1, HULL_SHEER[i + 1], z1],
        [s0, HULL_SHEER[i], z0],
        stripe,
      );
      /* The side deck, crowned on the centreline so rain runs off it and so the
       * deck reads as a surface rather than as a lid. */
      quad(
        shell,
        [s0, HULL_SHEER[i], z0],
        [s1, HULL_SHEER[i + 1], z1],
        [0, HULL_SHEER[i + 1] + 0.06, z1],
        [0, HULL_SHEER[i] + 0.06, z0],
        deck,
      );
    }
  }

  const last = HULL_HALF.length - 1;
  const transomHalf = HULL_HALF[last];
  quad(
    shell,
    [-transomHalf * CHINE_RATIO, HULL_CHINE[last], HULL_STERN],
    [transomHalf * CHINE_RATIO, HULL_CHINE[last], HULL_STERN],
    [transomHalf, HULL_SHEER[last], HULL_STERN],
    [-transomHalf, HULL_SHEER[last], HULL_STERN],
    topside,
  );
  tri(
    shell,
    [0, HULL_KEEL[last], HULL_STERN],
    [transomHalf * CHINE_RATIO, HULL_CHINE[last], HULL_STERN],
    [-transomHalf * CHINE_RATIO, HULL_CHINE[last], HULL_STERN],
    bottom,
  );
  /* The stem. Two narrow faces closing the bow, because the forward station is
   * a fifth of a metre across rather than a point. */
  quad(
    shell,
    [-HULL_HALF[0], HULL_SHEER[0], HULL_BOW],
    [HULL_HALF[0], HULL_SHEER[0], HULL_BOW],
    [HULL_HALF[0] * CHINE_RATIO, HULL_CHINE[0], HULL_BOW],
    [-HULL_HALF[0] * CHINE_RATIO, HULL_CHINE[0], HULL_BOW],
    topside,
  );
  tri(
    shell,
    [-HULL_HALF[0] * CHINE_RATIO, HULL_CHINE[0], HULL_BOW],
    [HULL_HALF[0] * CHINE_RATIO, HULL_CHINE[0], HULL_BOW],
    [0, HULL_KEEL[0], HULL_BOW],
    bottom,
  );

  /* The wheelhouse in three bands, so the window is a recessed value rather than
   * paint: from a helicopter the dark band is the only thing that says there is
   * a cabin there at all. */
  boxShell(shell, CABIN_HALF, DECK_Y, WINDOW_LOW, CABIN_BOW, CABIN_STERN, topside, null);
  boxShell(shell, CABIN_HALF, WINDOW_LOW, WINDOW_HIGH, CABIN_BOW, CABIN_STERN, glass, null);
  boxShell(shell, CABIN_HALF, WINDOW_HIGH, CABIN_TOP, CABIN_BOW, CABIN_STERN, topside, roof);

  /* The cockpit: a sole at deck level, a coaming standing off it, a rail on top
   * of the coaming and the shadow line of the coaming's inner face between them.
   * Four values across the aft deck rather than one, which is what tells a
   * camera astern that there is a boat there and not a crate. */
  const wellIn = WELL_HALF - WELL_RAIL;
  const railY = DECK_Y + WELL_LIP;
  boxShell(shell, WELL_HALF, DECK_Y, railY, WELL_BOW, WELL_STERN, topside, null);
  quad(
    shell,
    [-wellIn, DECK_Y, WELL_BOW + WELL_RAIL],
    [wellIn, DECK_Y, WELL_BOW + WELL_RAIL],
    [wellIn, DECK_Y, WELL_STERN - WELL_RAIL],
    [-wellIn, DECK_Y, WELL_STERN - WELL_RAIL],
    rgb(VESSEL_SOLE),
  );
  boxShell(
    shell,
    wellIn,
    DECK_Y,
    railY,
    WELL_BOW + WELL_RAIL,
    WELL_STERN - WELL_RAIL,
    well,
    null,
  );
  /* The rail itself, four flat strips around the top of the coaming. */
  for (const side of [1, -1]) {
    quad(
      shell,
      [wellIn * side, railY, WELL_BOW],
      [WELL_HALF * side, railY, WELL_BOW],
      [WELL_HALF * side, railY, WELL_STERN],
      [wellIn * side, railY, WELL_STERN],
      deck,
    );
  }
  for (const end of [WELL_BOW, WELL_STERN]) {
    const inner = end === WELL_BOW ? end + WELL_RAIL : end - WELL_RAIL;
    quad(
      shell,
      [-WELL_HALF, railY, end],
      [WELL_HALF, railY, end],
      [WELL_HALF, railY, inner],
      [-WELL_HALF, railY, inner],
      deck,
    );
  }

  boxShell(
    shell,
    STAFF_HALF,
    DECK_Y,
    STAFF_TOP,
    STAFF_Z - STAFF_HALF,
    STAFF_Z + STAFF_HALF,
    spar,
    spar,
  );

  /* The code flag, three bands the way a signal flag is made. She lies head to
   * wind on her anchor and the wind runs up the course, so a panel of cloth with
   * no width is the same nothing from every position the rigs ever frame her
   * from, and pointing that panel somewhere else only moves which rig loses it:
   * the helicopter looks down the course and the chase looks along the line.
   *
   * The answer is a flag with body. It flies out off the quarter, and the cloth
   * waves ACROSS the fly rather than along it, half a metre of curl with the head
   * carried further round than the foot. So the surface turns through most of a
   * half circle between hoist and fly, and whichever way a camera is pointed some
   * of it is facing the eye while the rest takes different light. The material
   * draws both faces, because a flag has two sides and she swings all replay. */
  const flagLow = 3.0;
  const flagHigh = 4.02;
  const flagRoot = 0.1;
  const flagFly = 1.62;
  /* Fifty two degrees off the centreline for the fly, and the curl runs square
   * to it. Both resolved here rather than left as trig inside a build loop. */
  const FLY_ACROSS = 0.788;
  const FLY_AFT = 0.6157;
  const CURL = 0.46;
  const FLAG_SPANS = 9;
  const bands: [number, Rgb][] = [
    [0.34, rgb(FLAG_FIELD)],
    [0.68, rgb(FLAG_PANEL)],
    [1.0, rgb(FLAG_FIELD)],
  ];
  /* How far off the fly line the cloth is at this point, and how much more of
   * that the head takes than the foot. */
  const flagWave = (u: number): number => Math.sin(u * Math.PI * 1.75) * CURL * (0.4 + 0.6 * u);
  const flagX = (u: number, twist: number): number =>
    flagRoot + u * flagFly * FLY_ACROSS - flagWave(u) * twist * FLY_AFT;
  const flagZ = (u: number, twist: number): number =>
    STAFF_Z + 0.05 + u * flagFly * FLY_AFT + flagWave(u) * twist * FLY_ACROSS;
  /* The cloth sags toward the fly, which is what stops the strip reading as a
   * painted board. */
  const flagDrop = (u: number): number => u * u * 0.12;
  const FOOT_TWIST = 0.45;
  const HEAD_TWIST = 1.35;
  for (let i = 0; i < FLAG_SPANS; i++) {
    const u0 = i / FLAG_SPANS;
    const u1 = (i + 1) / FLAG_SPANS;
    const mid = (u0 + u1) * 0.5;
    const colour = (bands.find(([edge]) => mid <= edge) ?? bands[bands.length - 1])[1];
    const drop0 = flagDrop(u0);
    const drop1 = flagDrop(u1);
    quad(
      shell,
      [flagX(u0, FOOT_TWIST), flagLow - drop0, flagZ(u0, FOOT_TWIST)],
      [flagX(u1, FOOT_TWIST), flagLow - drop1, flagZ(u1, FOOT_TWIST)],
      [flagX(u1, HEAD_TWIST), flagHigh - drop1, flagZ(u1, HEAD_TWIST)],
      [flagX(u0, HEAD_TWIST), flagHigh - drop0, flagZ(u0, HEAD_TWIST)],
      colour,
    );
  }

  return toGeometry(shell);
}

/* Where the staff sits relative to the hull origin, so the vessel can be placed
 * with its staff exactly on the end of the line rather than near it. */
export const COMMITTEE_STAFF_Z = STAFF_Z;
