/**
 * The race brief: every number the boot cover puts on screen while the
 * renderer warms, read off the RaceData the replay is about to play.
 *
 * Nothing here is a per-race constant. The line comes from the course
 * endpoints, the fleet's places on it from each boat's own fix at the gun, the
 * first crossing from the fixes after it, the approach tracks from the same
 * evaluator the replay interpolates with, and the wind from the published 1 Hz
 * series through `windAt`, the same interpolation the instrument dock reads.
 * Change a seed and every figure below moves with it.
 *
 * The shapes here split on cost. `briefFacts`, `prestartTracks` and
 * `prestartTwdSeries` walk the feed once and are built at mount;
 * `windReadingAt` is called every frame and writes into a caller-owned object,
 * the same contract `poseAt` and `windAt` keep.
 */
import { startLineOf, startReadingAt, type StartReading } from "./analytics";
import { poseAt, windAt } from "./interpolate";
import { polarFrac } from "./sim";
import type { BoatMeta, Fix, Pose, RaceData, WindSample } from "./types";

const DEG = Math.PI / 180;

/* Inside this much of head to wind the line is square and neither end is the
 * shorter road. Below a twentieth of a degree the bias is smaller than the
 * one decimal the readout carries. */
const SQUARE_DEG = 0.05;

/* Metres of open water left around the fitted prestart. Four rather than the
 * chart's thirty-four because this drawing is a hundred metres across where
 * that one is a kilometre, and the same margin in metres would eat a third of
 * it. */
export const PRESTART_PAD = 4;

/* Metres of open water always kept up the beat of the line, so the rung
 * nearest it and the wind arrow have water to sit in rather than being pinned
 * against the top edge. A framing rule, not a claim about the race. */
export const PRESTART_HEADROOM = 6;

/* The steps a scale bar is allowed to take. A bar labelled 23 m is a bar the
 * reader has to do arithmetic against. */
const SCALE_STEPS = [10, 20, 50, 100];

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
  return { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
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
 * angle, `beatSpeed = polarFrac(beatTwa) * tws`, off the same polar the sim
 * sails (POLAR_TWA / POLAR_FRAC in lib/layline/sim.ts). At the shipped race's
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
  const beatSpeed = polarFrac(facts.beatTwa) * tws;
  out.t = t;
  out.twd = twd;
  out.tws = tws;
  out.biasMeters = facts.lineLength * Math.sin(Math.abs(twd) * DEG);
  out.biasSeconds = beatSpeed > 0 ? out.biasMeters / beatSpeed : 0;
  out.favored = twd > SQUARE_DEG ? "boat" : twd < -SQUARE_DEG ? "pin" : "square";
  return out;
}

/**
 * One boat's approach to the line, sampled off `poseAt` between `race.tMin`
 * and the gun.
 *
 * The shape is the chart's own `ChartTrack` down to the field names, so
 * `lengthAt` and `toPath` in components/layline/svg/chartFrame.ts draw and
 * reveal this track with the same code that draws the whole race: metres, with
 * y negated for the screen's downward axis, and an arc length measured along
 * the very polyline the path is built from.
 */
export interface PrestartTrack {
  boat: BoatMeta;
  /** x, -y pairs in metres. */
  points: number[];
  /** Race time of each point, same order. */
  times: number[];
  /** Arc length in metres from the first point to each one. */
  lengths: Float64Array;
  /** The whole approach, metres, for the dash the reveal is cut out of. */
  total: number;
  /** Heading at the first sample, degrees, which is what the server renders. */
  openHdg: number;
  /** Heading at the gun, degrees, so the ghost points where the hull will. */
  gunHdg: number;
}

/**
 * The fleet's approach tracks. Sampled by index rather than by accumulating a
 * step, so the last point is exactly the gun on any step and any tMin.
 */
export function prestartTracks(race: RaceData, step: number): PrestartTrack[] {
  const span = 0 - race.tMin;
  const steps = Math.max(1, Math.round(span / step));
  const pose = newPose();
  return race.boats.map((boat) => {
    const points: number[] = [];
    const times: number[] = [];
    let openHdg = 0;
    for (let i = 0; i <= steps; i += 1) {
      const t = race.tMin + (i / steps) * span;
      poseAt(race, boat.id, t, "smooth", pose);
      points.push(pose.x, -pose.y);
      times.push(t);
      if (i === 0) openHdg = pose.hdg;
    }
    const lengths = new Float64Array(times.length);
    for (let i = 1; i < times.length; i += 1) {
      const dx = points[i * 2] - points[i * 2 - 2];
      const dy = points[i * 2 + 1] - points[i * 2 - 1];
      lengths[i] = lengths[i - 1] + Math.hypot(dx, dy);
    }
    return {
      boat,
      points,
      times,
      lengths,
      total: lengths[lengths.length - 1],
      openHdg,
      gunHdg: pose.hdg,
    };
  });
}

export interface PrestartFrame {
  /** Left edge, metres across the course. */
  x: number;
  /** Top edge, metres in the screen's downward axis. */
  y: number;
  w: number;
  h: number;
  viewBox: string;
  /**
   * The padded data's own width over its own height, before any of it is grown
   * to fill a box. A drawing box given this aspect holds the prestart and
   * almost nothing else; given a squarer one, the scale stays honest and the
   * difference is spent on empty water. It is independent of the `aspect`
   * argument, so a layout can ask for it and then hand it straight back.
   */
  natural: number;
}

/**
 * The window the prestart is drawn in: every sampled fix and both ends of the
 * line, padded, then grown to the aspect of the box it has to fill.
 *
 * The whole deficit goes on the up-the-beat side rather than being split, so
 * the spare water lands where the ladder rungs and the wind arrow are and no
 * track is ever pushed off the bottom edge. Where the deficit is not enough,
 * PRESTART_HEADROOM keeps six metres up there anyway and the width grows
 * instead. The scale stays isotropic: a metre across is a metre up, which is
 * the only reason a scale bar can be honest.
 */
export function prestartFrame(
  race: RaceData,
  tracks: PrestartTrack[],
  aspect: number,
): PrestartFrame {
  const { startPin, startBoat } = race.course;
  let minX = Math.min(startPin.x, startBoat.x);
  let maxX = Math.max(startPin.x, startBoat.x);
  let minY = Math.min(-startPin.y, -startBoat.y, -PRESTART_HEADROOM);
  let maxY = Math.max(-startPin.y, -startBoat.y);
  for (const track of tracks) {
    for (let i = 0; i < track.points.length; i += 2) {
      const x = track.points[i];
      const y = track.points[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  minX -= PRESTART_PAD;
  maxX += PRESTART_PAD;
  minY -= PRESTART_PAD;
  maxY += PRESTART_PAD;

  let w = maxX - minX;
  let h = maxY - minY;
  const natural = h > 0 ? w / h : 1;
  const want = aspect > 0 ? w / aspect : h;
  if (want >= h) {
    minY = maxY - want;
    h = want;
  } else {
    const grow = h * aspect - w;
    minX -= grow / 2;
    maxX += grow / 2;
    w = maxX - minX;
  }
  return {
    x: minX,
    y: minY,
    w,
    h,
    viewBox: `${minX.toFixed(2)} ${minY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`,
    natural,
  };
}

/**
 * The prestart breeze as a direction series, for the strip under the plot.
 *
 * Sampled off `windAt` rather than off `race.wind` directly so the curve drawn
 * is the curve the replay reads between the 1 Hz samples. Direction and not
 * speed: the speed moves about half a metre a second across the ten seconds,
 * where the direction swings four to eight degrees and takes the favored end
 * with it.
 */
export function prestartTwdSeries(race: RaceData, steps: number): { t: number; twd: number }[] {
  const points: { t: number; twd: number }[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = race.tMin + (i / steps) * (0 - race.tMin);
    windAt(race, t, scratch);
    points.push({ t, twd: wrapSigned(scratch.twd) });
  }
  return points;
}

/**
 * The strip's own vertical window, in degrees.
 *
 * The series' own range rather than a symmetric window about the course axis,
 * because the prestart breeze is one-sided on every shipped seed: it sits five
 * to eight degrees off the axis and works back toward it. A symmetric window
 * would spend half the band on degrees the wind never reached and draw the
 * whole shift as a shallow line near the bottom edge. The axis is always
 * inside the band, so the rule the favored end changes hands across is always
 * drawn, and a tenth of a span either side keeps it off the edge.
 */
export function twdBand(series: { twd: number }[]): { lo: number; hi: number } {
  let lo = 0;
  let hi = 0;
  for (const point of series) {
    if (point.twd < lo) lo = point.twd;
    if (point.twd > hi) hi = point.twd;
  }
  /* A breeze that never moved would otherwise be drawn in a band of no height. */
  const span = Math.max(hi - lo, 1);
  const pad = span * 0.15;
  return { lo: lo - pad, hi: hi + pad };
}

/** How far the breeze moved across the whole prestart, degrees. */
export function twdSwing(series: { twd: number }[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const point of series) {
    if (point.twd < lo) lo = point.twd;
    if (point.twd > hi) hi = point.twd;
  }
  return hi - lo;
}

/** The round step nearest a fifth of the drawing's width, for the scale bar. */
export function scaleStep(across: number): number {
  const want = across * 0.2;
  let best = SCALE_STEPS[0];
  for (const step of SCALE_STEPS) {
    if (Math.abs(step - want) < Math.abs(best - want)) best = step;
  }
  return best;
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

/** Course x to the panel diagram's own -1..1 across the line, clamped to the ends. */
export function acrossLine(x: number, half: number): number {
  const u = half > 0 ? x / half : 0;
  return u < -1 ? -1 : u > 1 ? 1 : u;
}

export function lineEndsOf(course: RaceData["course"]): { pinX: number; boatX: number } {
  return { pinX: course.startPin.x, boatX: course.startBoat.x };
}
