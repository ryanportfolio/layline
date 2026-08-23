/**
 * Which side the cloth is on, and how long it takes to get there.
 *
 * A boat's leeward side is the sign of its true wind angle, and that sign
 * changes on one frame. The rig does not. A gybing boom swings through a
 * hundred and seventy degrees, the sails go soft on the way across, and the
 * whole thing takes about a second; a tack is slower on the cloth than on the
 * helm, because the sails flog head to wind while the boat comes round.
 *
 * So the sign becomes a number that runs from one side to the other across the
 * manoeuvre. The crossings are solved once per boat off the same evaluator the
 * scene poses from, which is what keeps the answer a pure function of the
 * clock: seeking to an instant and playing into it draw the same rig.
 */
import { poseAt } from "@/lib/layline/interpolate";
import type { Pose, RaceData } from "@/lib/layline/types";

/* Half the time the cloth takes to change sides, in seconds. Read off the
 * manoeuvres in the feed: the turn through a gybe runs a little over a second
 * at the measured yaw rates, and a tack holds the sails luffing longer than it
 * holds the helm over. */
const GYBE_HALF = 0.5;
const TACK_HALF = 0.7;

/* The grid the crossings are hunted on. The hardest turn in the race is 38
 * deg/s, so a step this long cannot straddle a crossing and come back on the
 * side it started; the bisection then lands the instant itself to well under a
 * frame. */
const SCAN_STEP = 0.05;
const BISECT = 24;

interface Swing {
  /* When the wind angle changes sign. */
  t: number;
  /* Which side the cloth is on afterwards: -1 to port, 1 to starboard. */
  lee: number;
  half: number;
}

interface Swings {
  /* The side the boat starts the feed on, before any crossing. */
  first: number;
  list: Swing[];
}

const tables = new WeakMap<RaceData, Map<string, Swings>>();
const probe: Pose = { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };

/* Leeward is where the cloth goes: to port with the wind over starboard. */
function leeOf(twa: number): number {
  return twa >= 0 ? -1 : 1;
}

/* Crossings are hunted on the smooth lens, which is the one that carries the
 * angle continuously across the wrap; the raw lens holds fixes and would put
 * every crossing on a quarter second boundary of its own. */
function twaAt(race: RaceData, boatId: string, t: number): number {
  return poseAt(race, boatId, t, "smooth", probe).twa;
}

function buildSwings(race: RaceData, boatId: string): Swings {
  const first = leeOf(twaAt(race, boatId, race.tMin));
  const list: Swing[] = [];
  const steps = Math.max(1, Math.round((race.tMax - race.tMin) / SCAN_STEP));
  let prev = first;
  let prevT = race.tMin;
  for (let i = 1; i <= steps; i++) {
    const t = race.tMin + i * SCAN_STEP;
    const twa = twaAt(race, boatId, t);
    const lee = leeOf(twa);
    if (lee !== prev) {
      /* Which manoeuvre it is decides how long the cloth has, and the wind
       * angle says which: it passes through zero on a tack and through a
       * hundred and eighty on a gybe. */
      const half = Math.abs(twa) > 90 ? GYBE_HALF : TACK_HALF;
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < BISECT; k++) {
        const mid = (lo + hi) / 2;
        if (leeOf(twaAt(race, boatId, mid)) === prev) lo = mid;
        else hi = mid;
      }
      list.push({ t: (lo + hi) / 2, lee, half });
      prev = lee;
    }
    prevT = t;
  }
  return { first, list };
}

function swingsOf(race: RaceData, boatId: string): Swings {
  let table = tables.get(race);
  if (table === undefined) {
    table = new Map();
    tables.set(race, table);
  }
  let swings = table.get(boatId);
  if (swings === undefined) {
    swings = buildSwings(race, boatId);
    table.set(boatId, swings);
  }
  return swings;
}

/* Odd about the middle, continuous in its slope there, and flat at both ends:
 * the cloth leaves the old side at its fastest and settles onto the new one. */
function ease(x: number): number {
  return x * (2 - x);
}

/**
 * Where the rig is between the two sides, -1 to port and 1 to starboard, and
 * everywhere except inside a manoeuvre exactly one or the other. Zero is the
 * boom on the centreline halfway through the crossing.
 *
 * The same answer in either lens. The raw one holds each fix and shows the feed
 * at the rate it arrives, and which side a boom is on is not in the feed: held
 * onto the 4 Hz grid the swing became a 155 px jump of its own, which is the
 * artifact this replaces rather than the telemetry it exists to show. The boom
 * angle it is multiplied by is read off the held wind angle, so a raw frame
 * still steps.
 */
export function clothSide(race: RaceData, boatId: string, t: number): number {
  const { first, list } = swingsOf(race, boatId);
  let lee = first;
  let x = 1;
  for (let i = 0; i < list.length; i++) {
    const swing = list[i];
    if (t >= swing.t) lee = swing.lee;
    const d = Math.abs(t - swing.t) / swing.half;
    if (d < x) x = d;
  }
  return lee * ease(x);
}

/**
 * How much of its camber a sail is carrying: full on either side, flat through
 * the middle of the manoeuvre. The same ease again, because the boom takes the
 * whole swing to cross while the cloth only goes soft near the middle of it.
 */
export function clothCamber(side: number): number {
  return ease(side < 0 ? -side : side);
}
