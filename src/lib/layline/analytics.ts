/**
 * Display-side analytics. Nothing here adds to the feed: every figure comes
 * out of the fixes, the progress samples and the course the engine already
 * emits, so a reading here and a reading in Debrief can differ only where the
 * two set out to measure different things, never because one of them made a
 * number up.
 *
 * A tack is a wind-angle sign flip taken inside 90 degrees off the wind, a
 * gybe is the same flip at 90 or wider, and flips inside three seconds of each
 * other are one maneuver settling: the same rules the analyst lane detects
 * turns by, so the markers on the timeline and the rows Debrief reads out
 * cannot disagree on how many turns a boat made or when.
 *
 * Speed loss is measured differently here and says so on screen. Debrief takes
 * entry as the first fix of its eight second window; this lane takes the
 * fastest reading in the four seconds up to the flip, which is why the marker
 * tooltip names its own definition rather than borrowing Debrief's wording.
 *
 * VMG here is speed along the course axis, signed toward whichever mark the
 * boat is sailing to, so a beat and a run both read positive. That is not the
 * dock's VMG, which is speed along the wind axis; the two are separate
 * quantities and the two surfaces label them apart.
 *
 * Everything is a pure function of the race and a time, and every series is
 * built once per race and cached against it: a scrub reads the same numbers a
 * play-through does, and the hot path never builds one.
 */
import { knots } from "./format";
import { legAt, poseAt } from "./interpolate";
import type { Course, LegName, Pose, RaceData, Vec2 } from "./types";

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Maneuvers                                                           */

export interface Maneuver {
  t: number;
  kind: "tack" | "gybe";
  /**
   * The drawdown off the speed the boat carried in: the fastest reading in the
   * four seconds up to the flip, minus the slowest reading between that peak
   * and four seconds past the flip, in knots.
   */
  lossKnots: string;
}

/* Merge window from the analyst tool, kept the same so the markers on the
 * timeline and the rows Debrief reads out cannot disagree on how many turns a
 * boat made. The speed window is the same four seconds either side. */
const MERGE_SECONDS = 3;
const LOSS_WINDOW = 4;

const maneuverCache = new WeakMap<RaceData, Map<string, Maneuver[]>>();

function detect(race: RaceData, boatId: string): Maneuver[] {
  const out: Maneuver[] = [];
  const fixes = race.fixes[boatId];
  if (fixes === undefined || fixes.length === 0) return out;

  let prevSign = 0;
  let prevIndex = -1;
  let lastFlipT = -Infinity;
  for (let i = 0; i < fixes.length; i++) {
    const sign = Math.sign(fixes[i].twa);
    if (sign === 0) continue;
    if (prevSign !== 0 && sign !== prevSign) {
      const tFlip = (fixes[prevIndex].t + fixes[i].t) / 2;
      if (tFlip - lastFlipT >= MERGE_SECONDS) {
        const width = (Math.abs(fixes[prevIndex].twa) + Math.abs(fixes[i].twa)) / 2;
        /* The flip is the middle of the turn, not the start of it, so the
         * first fix of the window and the fix immediately before the flip can
         * both be inside the deceleration already: on this fleet's gybes both
         * read slower than the trough and the loss came out at zero. Entry is
         * the fastest reading in the run-up instead, which is the speed the
         * boat carried into the turn. */
        let entry = -Infinity;
        let entryT = tFlip;
        for (let k = 0; k < fixes.length; k++) {
          const fix = fixes[k];
          if (fix.t < tFlip - LOSS_WINDOW) continue;
          if (fix.t > tFlip) break;
          if (fix.sog > entry) {
            entry = fix.sog;
            entryT = fix.t;
          }
        }
        /* The trough is measured from that peak forward, never behind it. A
         * boat is still winding up onto the run for the first half of the
         * window on this fleet's gybes, and a minimum taken off that run-up is
         * speed the boat had not made yet, not speed the turn cost. */
        let slowest = Infinity;
        for (let k = 0; k < fixes.length; k++) {
          const fix = fixes[k];
          if (fix.t < entryT) continue;
          if (fix.t > tFlip + LOSS_WINDOW) break;
          if (fix.sog < slowest) slowest = fix.sog;
        }
        out.push({
          /* Rounded the way the analyst tool rounds it, so a marker and the
           * row Debrief reads back name the same instant. */
          t: Math.round(tFlip * 100) / 100,
          kind: width < 90 ? "tack" : "gybe",
          lossKnots: knots(entry - slowest),
        });
      }
      lastFlipT = tFlip;
    }
    prevSign = sign;
    prevIndex = i;
  }
  return out;
}

/** Every tack and gybe one boat made, in time order. Built once per boat. */
export function maneuversOf(race: RaceData, boatId: string): Maneuver[] {
  let byBoat = maneuverCache.get(race);
  if (byBoat === undefined) {
    byBoat = new Map();
    maneuverCache.set(race, byBoat);
  }
  let found = byBoat.get(boatId);
  if (found === undefined) {
    found = detect(race, boatId);
    byBoat.set(boatId, found);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* VMG                                                                 */

/**
 * Speed made good toward the mark the boat is sailing to. The course axis is
 * +y up the beat, so the along-course component is sog times cos(cog), and a
 * boat running back down the course has that component negated: both legs read
 * positive when the boat is gaining on its mark.
 *
 * Not the dock's VMG. That one resolves speed onto the wind axis and reads
 * negative all the way down the run; this one resolves onto the fixed course
 * axis. The wind shifts through the race and the course does not, so the two
 * disagree in size as well as in sign.
 */
export function vmgToMark(sog: number, cog: number, leg: LegName): number {
  const along = sog * Math.cos(cog * DEG);
  return leg === "run" || leg === "finished" ? -along : along;
}

/* Half a second between samples. The whole race runs a little over a minute,
 * so this is about 150 points across a strip a few hundred pixels wide: fine
 * enough to keep the notch a tack puts in the trace, coarse enough that the
 * trace is not drawing points nobody can see. */
export const VMG_STEP = 0.5;

export interface VmgSeries {
  /** Sample times are t0 + i * VMG_STEP, i < count. */
  t0: number;
  count: number;
  /** Per boat, NaN wherever that boat was not on a leg. */
  byBoat: Record<string, Float32Array>;
  /** Best of the fleet at each sample, NaN where nobody was racing. */
  best: Float32Array;
  /** Highest reading anyone posted, the strip's ceiling. */
  peak: number;
  /** Lowest reading anyone posted while on a leg. */
  floor: number;
}

const seriesCache = new WeakMap<RaceData, VmgSeries>();

const scratch: Pose = { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };

function build(race: RaceData): VmgSeries {
  const t0 = race.tMin;
  const count = Math.floor((race.tMax - t0) / VMG_STEP) + 1;
  const byBoat: Record<string, Float32Array> = {};
  const best = new Float32Array(count);
  let peak = 0;
  let floor = 0;

  for (const boat of race.boats) byBoat[boat.id] = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const t = t0 + i * VMG_STEP;
    let topHere = Number.NaN;
    for (const boat of race.boats) {
      const leg = legAt(race, boat.id, t);
      /* Before the gun there is no mark to make good toward, and a boat that
       * has crossed is luffing out its way: neither is a VMG. */
      if (leg === "prestart" || leg === "finished") {
        byBoat[boat.id][i] = Number.NaN;
        continue;
      }
      poseAt(race, boat.id, t, "smooth", scratch);
      const value = vmgToMark(scratch.sog, scratch.cog, leg);
      byBoat[boat.id][i] = value;
      if (value > peak) peak = value;
      if (value < floor) floor = value;
      if (Number.isNaN(topHere) || value > topHere) topHere = value;
    }
    best[i] = topHere;
  }

  return { t0, count, byBoat, best, peak, floor };
}

/** The whole fleet's VMG on the VMG_STEP grid, built once per race. */
export function vmgSeries(race: RaceData): VmgSeries {
  let found = seriesCache.get(race);
  if (found === undefined) {
    found = build(race);
    seriesCache.set(race, found);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Start line                                                          */

export interface StartLine {
  /** Unit normal, pointing up the course from the line. */
  nx: number;
  ny: number;
  pin: Vec2;
  boat: Vec2;
  lengthMeters: number;
}

/**
 * The line as the readout needs it: a unit normal to measure across and a
 * length to measure along. Taken off the course rather than assumed, so a
 * course whose line is not square to the axis still reads correctly.
 */
export function startLineOf(course: Course): StartLine {
  const dx = course.startBoat.x - course.startPin.x;
  const dy = course.startBoat.y - course.startPin.y;
  const length = Math.hypot(dx, dy);
  const ux = length > 0 ? dx / length : 1;
  const uy = length > 0 ? dy / length : 0;
  return {
    nx: -uy,
    ny: ux,
    pin: course.startPin,
    boat: course.startBoat,
    lengthMeters: length,
  };
}

export interface StartReading {
  /** Metres from the line on the prestart side; negative once past it. */
  distance: number;
  /** Speed toward the line along the normal, m/s. Negative is backing off. */
  closing: number;
  /** Seconds until the boat reaches the line at this speed, NaN if never. */
  toLine: number;
  /** True when the boat reaches the line before the gun at this speed. */
  early: boolean;
}

/** Reused by the readout so a frame leaves nothing behind. */
export function startReadingAt(
  line: StartLine,
  pose: Pose,
  t: number,
  out: StartReading,
): StartReading {
  const distance =
    -((pose.x - line.pin.x) * line.nx + (pose.y - line.pin.y) * line.ny);
  const heading = pose.cog * DEG;
  const closing = pose.sog * Math.sin(heading) * line.nx + pose.sog * Math.cos(heading) * line.ny;
  /* A boat already across is early with nothing left to predict; a boat
   * backing off or stopped never gets there on this reading. */
  const toLine = distance <= 0 ? 0 : closing > 0 ? distance / closing : Number.NaN;
  out.distance = distance;
  out.closing = closing;
  out.toLine = toLine;
  out.early = distance <= 0 || (Number.isFinite(toLine) && t + toLine < 0);
  return out;
}
