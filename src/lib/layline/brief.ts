/**
 * The race brief: every number the boot cover puts on screen while the
 * renderer warms, read off the RaceData the replay is about to play.
 *
 * Nothing here is a per-race constant. The line comes from the course
 * endpoints, the fleet's places on it from each boat's own fix at the gun, the
 * first crossing from the fixes after it, and the wind from the published 1 Hz
 * series through `windAt`, the same interpolation the instrument dock reads.
 * Change a seed and every figure below moves with it.
 *
 * The shapes here split on cost. `briefFacts` and `prestartTrace` walk the feed
 * once and are built at mount; `windReadingAt` is called every frame and writes
 * into a caller-owned object, the same contract `poseAt` and `windAt` keep.
 *
 * The race after the gun is not here. Performance reads it through
 * lib/layline/analytics.ts, which is where the console's own VMG, maneuver and
 * start-line evaluators already live.
 */
import { startLineOf, startReadingAt, type StartReading } from "./analytics";
import { createPose, poseAt, windAt } from "./interpolate";
import { FICTIONAL_ONE_DESIGN_POLAR, targetBoatSpeed } from "./polar";
import type { Fix, Pose, RaceData, WindSample } from "./types";

const DEG = Math.PI / 180;

/* Inside this much of head to wind the line is square and neither end is the
 * shorter road. Below a twentieth of a degree the bias is smaller than the
 * one decimal the readout carries. */
const SQUARE_DEG = 0.05;

function wrapSigned(a: number): number {
  const w = ((a % 360) + 360) % 360;
  return w > 180 ? w - 360 : w;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function newPose(): Pose {
  return createPose();
}

/** The fix closest in time to `t`. Fixes are written in order at FIX_HZ. */
function fixNear(fixes: Fix[], t: number): Fix {
  let best = fixes[0];
  for (const fix of fixes) {
    if (Math.abs(fix.t - t) < Math.abs(best.t - t)) best = fix;
    else if (fix.t > t) break;
  }
  return best;
}

/**
 * When this boat's hull first got to the line after the gun, linearly between
 * the two fixes that straddle it, or null for a boat that never did.
 *
 * Deliberately the same rule as `startReport` in lib/layline/analyst/tools.ts,
 * so the crossing the cover names is the crossing the analyst would name.
 * `briefAgreesWithStartReport` in tests/layline-races.test.ts holds the two
 * together.
 */
function crossTime(fixes: Fix[]): number | null {
  for (let i = 1; i < fixes.length; i += 1) {
    const before = fixes[i - 1];
    const after = fixes[i];
    if (after.t <= 0) continue;
    if (before.y < 0 && after.y >= 0) {
      return before.t + ((0 - before.y) / (after.y - before.y)) * (after.t - before.t);
    }
  }
  return null;
}

export interface BriefBoat {
  id: string;
  sail: string;
  name: string;
  hue: string;
  dark: boolean;
  /** Meters across the course at this boat's fix nearest the gun. */
  gunX: number;
  /**
   * Meters short of the line at the gun, measured along the line's own normal
   * by `startReadingAt`, so the ledger and the start readout in the console
   * are the same measurement rather than two that agree by luck.
   */
  offLine: number;
}

export interface BriefFacts {
  /** Meters between the two ends of the line, off the course endpoints. */
  lineLength: number;
  /** Half the line, so a diagram can scale a boat's gunX against it. */
  lineHalf: number;
  /** In `race.boats` order, which is the order the rail and the docks use. */
  boats: BriefBoat[];
  /** First hull to the line after the gun. Null if no boat crossed. */
  first: { sail: string; t: number } | null;
  /**
   * The fleet's own tacking half-angle, degrees. Median absolute TWA over
   * every boat's beat fixes, dropping the first 2 s off the line and the last
   * 3 s into the mark, which is gate 8 of the seed audit in
   * tests/layline-races.test.ts. The boats sail 45 to 47 degrees by
   * `twaBeat: 45 + 2 * rand()` in lib/layline/sim.ts, and this measures what
   * they actually sailed rather than repeating that line.
   */
  beatTwa: number;
  /** First fix time, the instant the brief's prestart loop opens on. */
  tMin: number;
}

export function briefFacts(race: RaceData): BriefFacts {
  const { startPin, startBoat } = race.course;
  const lineLength = Math.hypot(startBoat.x - startPin.x, startBoat.y - startPin.y);

  const rounding = new Map<string, number>();
  for (const event of race.events) {
    if (event.kind === "rounding" && event.boatId !== undefined) {
      rounding.set(event.boatId, event.t);
    }
  }

  const line = startLineOf(race.course);
  const pose = newPose();
  const reading: StartReading = { distance: 0, closing: 0, toLine: 0, early: false };

  const beatTwa: number[] = [];
  let first: { sail: string; t: number } | null = null;

  const boats = race.boats.map((boat): BriefBoat => {
    const fixes = race.fixes[boat.id] ?? [];
    const roundAt = rounding.get(boat.id) ?? Infinity;
    for (const fix of fixes) {
      if (fix.t > 2 && fix.t < roundAt - 3) beatTwa.push(Math.abs(fix.twa));
    }
    const crossed = crossTime(fixes);
    /* Ties break on boat id, the tiebreak `startReport` sorts by, so two hulls
     * to the line in the same millisecond name the same one on both surfaces. */
    if (
      crossed !== null &&
      (first === null || crossed < first.t || (crossed === first.t && boat.sail < first.sail))
    ) {
      first = { sail: boat.sail, t: crossed };
    }
    poseAt(race, boat.id, 0, "smooth", pose);
    startReadingAt(line, pose, 0, reading);
    return {
      id: boat.id,
      sail: boat.sail,
      name: boat.name,
      hue: boat.hue,
      dark: boat.dark === true,
      gunX: fixes.length === 0 ? 0 : fixNear(fixes, 0).x,
      offLine: reading.distance,
    };
  });

  return {
    lineLength,
    lineHalf: lineLength / 2,
    boats,
    first,
    beatTwa: beatTwa.length === 0 ? 45 : median(beatTwa),
    tMin: race.tMin,
  };
}

export type FavoredEnd = "pin" | "boat" | "square";

export interface WindReading {
  t: number;
  /** Signed degrees, the direction the wind comes from, 0 straight down the course. */
  twd: number;
  /** m/s. */
  tws: number;
  /** How far the favored end lies up the beat of the other one, in meters. */
  biasMeters: number;
  /** How much shorter the favored end's road up the beat is, in seconds. */
  biasSeconds: number;
  favored: FavoredEnd;
}

/** A reading object for `windReadingAt` to write into. */
export function windReading(): WindReading {
  return { t: 0, twd: 0, tws: 0, biasMeters: 0, biasSeconds: 0, favored: "square" };
}

const scratch: WindSample = { t: 0, twd: 0, tws: 0 };

/**
 * The wind, and what the line is worth in it, at a race time.
 *
 * Bias in meters is the line's length across the wind, `lineLength *
 * sin(|twd|)`, which is how much further up the beat the favored end already
 * sits. Bias in seconds divides that by the speed the fleet makes at its beat
 * angle, `beatSpeed = targetBoatSpeed(model, tws, beatTwa)`, off the same polar
 * the simulator sails. At the shipped race's
 * 46.3 degree beat and 7.2 m/s mean that is 0.846 of the breeze, 6.09 m/s. The
 * two are one quantity in two units and the layer states each of them once.
 *
 * Favored is the end sitting closer to the wind, which is the shorter road up
 * the beat: knowledge.ts, "start-bias". Course angles grow clockwise from +y,
 * so the upwind unit vector is (sin twd, cos twd), the pin sits at -x and the
 * committee boat at +x, and the boat end wins the projection whenever twd is
 * positive. A wind from the starboard side of the course favors the starboard
 * end of the line.
 */
export function windReadingAt(
  race: RaceData,
  facts: BriefFacts,
  t: number,
  out: WindReading,
): WindReading {
  windAt(race, t, scratch);
  const twd = wrapSigned(scratch.twd);
  const tws = scratch.tws;
  const beatSpeed = targetBoatSpeed(FICTIONAL_ONE_DESIGN_POLAR, tws, facts.beatTwa) ?? 0;
  out.t = t;
  out.twd = twd;
  out.tws = tws;
  out.biasMeters = facts.lineLength * Math.sin(Math.abs(twd) * DEG);
  out.biasSeconds = beatSpeed > 0 ? out.biasMeters / beatSpeed : 0;
  out.favored = twd > SQUARE_DEG ? "boat" : twd < -SQUARE_DEG ? "pin" : "square";
  return out;
}

/**
 * The prestart breeze as a polyline, for the trace under the panel view's dial.
 * Sampled off `windAt` rather than off `race.wind` directly, so the curve drawn
 * is the curve the replay reads between the 1 Hz samples.
 */
export function prestartTrace(race: RaceData, steps: number): { t: number; tws: number }[] {
  const points: { t: number; tws: number }[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = race.tMin + (i / steps) * (0 - race.tMin);
    windAt(race, t, scratch);
    points.push({ t, tws: scratch.tws });
  }
  return points;
}
