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
import { legAt, poseAt, windAt } from "./interpolate";
import { polarFrac } from "./sim";
import type { Course, LegName, Pose, RaceData, Vec2, WindSample } from "./types";

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
  /**
   * The same drawdown in m/s, which is what a mean over several turns has to
   * be taken in. Averaging the formatted strings would round every turn to a
   * tenth of a knot first and then average the rounding.
   */
  loss: number;
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
          loss: entry - slowest,
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

/* ------------------------------------------------------------------ */
/* Polar and target speed                                              */

/**
 * Seconds either side of a turn that are not steady sailing.
 *
 * The same three seconds the detector merges flips across, and deliberately:
 * a window that called two flips one maneuver and then counted the water
 * between them as sailing would be arguing with itself.
 *
 * Not a taste setting. A boat swinging through head to wind passes through a
 * target speed of nearly nothing, so its speed as a fraction of target goes to
 * infinity there. Measured on the shipped race with no window at all, the
 * fleet's mean beat performance came out between 257 and 864 per cent; with
 * this window it is 87.5 to 90.4. The excluded seconds are not thrown away,
 * they are accounted separately as the speed each turn cost.
 */
export const STEADY_WINDOW = MERGE_SECONDS;

/**
 * The speed the polar says a boat should be making at this wind angle in this
 * breeze, m/s.
 *
 * The same curve the engine sails the fleet along, so a review cannot hold the
 * boats to a standard the simulation never used.
 */
export function targetSpeed(twaAbs: number, tws: number): number {
  return polarFrac(twaAbs) * tws;
}

export interface PolarSample {
  t: number;
  /** Signed degrees off the breeze. Positive is wind over starboard. */
  twa: number;
  /**
   * Speed through the water scaled to the race's mean breeze, m/s.
   *
   * The breeze runs 12.1 to 16.2 knots across the shipped race, so a plot of
   * raw speed against one polar curve would read a boat's puff as pace. Every
   * sample is scaled by mean over its own TWS instead, which leaves the ratio
   * to target untouched: a dot's distance past the curve drawn at the mean
   * breeze is exactly `fraction`, whatever the wind was doing at the time.
   */
  speed: number;
  /** That distance stated as a number: speed over target, 1 is on the polar. */
  fraction: number;
  /** Signed degrees. Positive leans the mast to the boat's own starboard. */
  heel: number;
  leg: "beat" | "run";
}

export interface BoatPerformance {
  boatId: string;
  /** Steady-sailing samples behind every mean on this row. */
  steady: number;
  /** Mean speed over target, 1 is sailing the polar. NaN with no samples. */
  beatFraction: number;
  runFraction: number;
  /** Mean speed made good toward the mark, m/s, steady sailing only. */
  beatVmg: number;
  runVmg: number;
  tacks: number;
  gybes: number;
  /** Mean speed each turn cost, m/s. NaN if the boat never turned. */
  lossPerTurn: number;
  samples: PolarSample[];
}

export interface FleetPerformance {
  /** Median of the fleet, column by column. */
  beatFraction: number;
  runFraction: number;
  beatVmg: number;
  runVmg: number;
  lossPerTurn: number;
  /** Totals, which a median would say nothing useful about. */
  turns: number;
  steady: number;
}

export interface PolarReview {
  /** The breeze the plot is normalized to, m/s, and what it ran between. */
  meanTws: number;
  twsMin: number;
  twsMax: number;
  boats: BoatPerformance[];
  fleet: FleetPerformance;
}

function median(values: number[]): number {
  const kept = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (kept.length === 0) return Number.NaN;
  const mid = kept.length >> 1;
  return kept.length % 2 === 1 ? kept[mid] : (kept[mid - 1] + kept[mid]) / 2;
}

const reviewCache = new WeakMap<RaceData, PolarReview>();

function review(race: RaceData): PolarReview {
  let twsSum = 0;
  let twsMin = Infinity;
  let twsMax = -Infinity;
  for (const sample of race.wind) {
    twsSum += sample.tws;
    if (sample.tws < twsMin) twsMin = sample.tws;
    if (sample.tws > twsMax) twsMax = sample.tws;
  }
  const meanTws = race.wind.length > 0 ? twsSum / race.wind.length : 0;
  if (!Number.isFinite(twsMin)) twsMin = 0;
  if (!Number.isFinite(twsMax)) twsMax = 0;

  const wind: WindSample = { t: 0, twd: 0, tws: 0 };
  const boats: BoatPerformance[] = race.boats.map((boat) => {
    /* Racing turns only. `maneuversOf` reports every wind-angle flip in the
     * feed, which is right for the timeline: a marker belongs wherever the
     * boat turned. It is wrong for this row three times over.
     *
     * NZL 7 finishes Kestrel Sound at 55.512 s and gybes at 56.13 s, luffing
     * out its way. Counted, that turn made the boat read four turns instead of
     * three, carried its own drawdown into a mean of what a racing turn cost
     * (4.74 knots against 4.23), and took eleven samples of real racing out of
     * the cloud through STEADY_WINDOW, since the window reaches back 3 s from
     * a turn that happened after the finish. A prestart turn would do the same
     * at the other end; no shipped seed has one, and the rule covers it. */
    const moves = maneuversOf(race, boat.id).filter((move) => {
      const leg = legAt(race, boat.id, move.t);
      return leg === "beat" || leg === "run";
    });
    const samples: PolarSample[] = [];
    let beatSum = 0;
    let beatN = 0;
    let beatVmg = 0;
    let runSum = 0;
    let runN = 0;
    let runVmg = 0;

    for (const fix of race.fixes[boat.id] ?? []) {
      const leg = legAt(race, boat.id, fix.t);
      /* Before the gun there is no mark to sail to and no reason to sail
       * fast: a boat killing time to arrive at the line on the second is
       * doing its job at half of target. After the finish it is luffing out
       * its way. Neither is performance. */
      if (leg !== "beat" && leg !== "run") continue;
      let turning = false;
      for (const move of moves) {
        if (Math.abs(fix.t - move.t) <= STEADY_WINDOW) {
          turning = true;
          break;
        }
      }
      if (turning) continue;
      windAt(race, fix.t, wind);
      const target = targetSpeed(Math.abs(fix.twa), wind.tws);
      if (!(target > 0) || !(wind.tws > 0)) continue;
      const speed = (fix.sog * meanTws) / wind.tws;
      const fraction = fix.sog / target;
      const made = vmgToMark(fix.sog, fix.cog, leg);
      samples.push({ t: fix.t, twa: fix.twa, speed, fraction, heel: fix.heel, leg });
      if (leg === "beat") {
        beatSum += fraction;
        beatVmg += made;
        beatN += 1;
      } else {
        runSum += fraction;
        runVmg += made;
        runN += 1;
      }
    }

    let lossSum = 0;
    let tacks = 0;
    let gybes = 0;
    for (const move of moves) {
      lossSum += move.loss;
      if (move.kind === "tack") tacks += 1;
      else gybes += 1;
    }

    return {
      boatId: boat.id,
      steady: samples.length,
      beatFraction: beatN > 0 ? beatSum / beatN : Number.NaN,
      runFraction: runN > 0 ? runSum / runN : Number.NaN,
      beatVmg: beatN > 0 ? beatVmg / beatN : Number.NaN,
      runVmg: runN > 0 ? runVmg / runN : Number.NaN,
      tacks,
      gybes,
      lossPerTurn: moves.length > 0 ? lossSum / moves.length : Number.NaN,
      samples,
    };
  });

  return {
    meanTws,
    twsMin,
    twsMax,
    boats,
    fleet: {
      beatFraction: median(boats.map((b) => b.beatFraction)),
      runFraction: median(boats.map((b) => b.runFraction)),
      beatVmg: median(boats.map((b) => b.beatVmg)),
      runVmg: median(boats.map((b) => b.runVmg)),
      lossPerTurn: median(boats.map((b) => b.lossPerTurn)),
      turns: boats.reduce((sum, b) => sum + b.tacks + b.gybes, 0),
      steady: boats.reduce((sum, b) => sum + b.steady, 0),
    },
  };
}

/**
 * The fleet's race against its own polar, built once and cached against the
 * race the way every other series here is.
 *
 * Steady sailing only, on the legs only, and that holds for the turns as well
 * as for the samples: a boat that gybes after it has finished has not made a
 * racing turn. What the figures leave out is stated on screen, because a
 * performance figure whose exclusions are not stated is a figure a reader
 * cannot check.
 */
export function polarReview(race: RaceData): PolarReview {
  let found = reviewCache.get(race);
  if (found === undefined) {
    found = review(race);
    reviewCache.set(race, found);
  }
  return found;
}
