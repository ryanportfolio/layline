/**
 * Bench data: the twelve seconds of USA 4 that every figure in the engine room
 * points at. Pure functions over one RaceData, no React and no DOM, so
 * tests/layline-engine-room.test.ts pins exactly the numbers the page prints.
 *
 * Nothing here invents a figure. Every value is read out of race.fixes,
 * race.events or race.results, or built from them with the same arithmetic
 * interpolate.ts uses, so a change to the seed redraws the section by itself.
 */
import { poseAt } from "@/lib/layline/interpolate";
import { FIX_HZ, SIM_HZ } from "@/lib/layline/types";
import type { BoatMeta, Fix, Pose, RaceData } from "@/lib/layline/types";

/** The bench boat. USA 4 wins the seeded race and tacks inside the window. */
export const BENCH_BOAT = "usa";

/* The first tack is off the start line. The beat's second one is the turn the
 * three cameras are pointed at, so the search opens after the first is spent
 * and closes before the run. Sign flips of twa is the signal detectManeuvers
 * reads for the analyst; one boat, one definition of a tack. */
const TACK_FROM = 15;
const TACK_TO = 45;

/** Six seconds either side of the tack fix, so the window ends on whole seconds. */
const WINDOW_HALF = 6;

/** Half a second of the reported velocity: the tangent the curve leaves on. */
export const TANGENT_SECONDS = 0.5;

/* A parked frame has to show the raw feed and the engine in two different
 * places or reduced motion gets a picture with nothing in it. Three pixels at
 * ten pixels per metre is the floor. */
const MIN_PARK_DIVERGENCE = 0.3; // m

/* Every float that reaches markup goes through one of these two. Node and the
 * browser disagree in the last printed digit of poseAt's arithmetic often
 * enough to trip React's hydration diff, and a fixed number of decimals is the
 * one thing both engines agree on. Never template-literal a raw float. */
export function fmt1(value: number): string {
  return value.toFixed(1);
}

export function fmt2(value: number): string {
  return value.toFixed(2);
}

/** poseAt writes into a caller-owned pose; this is the empty one to hand it. */
export function newPose(): Pose {
  return { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
}

/** Signed short way round from a to b, in (-180, 180]. */
export function shortArc(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/**
 * The beat's second tack, as the time of the first fix reporting wind on the
 * other side. On the fix grid, so the window and the scrubber tick land on a
 * reading rather than between two.
 */
export function secondTack(race: RaceData, boatId: string): number {
  const fixes = race.fixes[boatId];
  for (let i = 1; i < fixes.length; i += 1) {
    const fix = fixes[i];
    if (fix.t < TACK_FROM) continue;
    if (fix.t > TACK_TO) break;
    const before = Math.sign(fixes[i - 1].twa);
    const now = Math.sign(fix.twa);
    if (before !== 0 && now !== 0 && before !== now) return fix.t;
  }
  /* No flip in the beat means no bench: fall back to the middle of the search
   * so the section still draws twelve seconds of something real. */
  return (TACK_FROM + TACK_TO) / 2;
}

export interface BenchWindow {
  from: number;
  to: number;
  span: number;
  tack: number;
  fixes: Fix[];
}

/** The twelve second window, whole seconds either side of the tack fix. */
export function benchWindow(race: RaceData, boatId: string): BenchWindow {
  const tack = secondTack(race, boatId);
  const from = Math.round(tack) - WINDOW_HALF;
  const to = Math.round(tack) + WINDOW_HALF;
  return {
    from,
    to,
    span: to - from,
    tack,
    fixes: race.fixes[boatId].filter((fix) => fix.t >= from && fix.t <= to),
  };
}

/** Closest and furthest a fix lands from the one before it, in metres. */
export function gapRange(fixes: Fix[]): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (let i = 1; i < fixes.length; i += 1) {
    const step = Math.hypot(fixes[i].x - fixes[i - 1].x, fixes[i].y - fixes[i - 1].y);
    if (step < min) min = step;
    if (step > max) max = step;
  }
  return { min: min === Infinity ? 0 : min, max };
}

export interface NorthPair {
  a: Fix;
  b: Fix;
  /** What the two headings look like subtracted as plain numbers. */
  plain: number;
  /** What they are round the circle, signed the way the boat turned. */
  short: number;
}

/**
 * The second inside the window where reading heading as a plain number is most
 * wrong: two fixes one second apart that straddle north, picked for the widest
 * plain-number span. That span is the whole lesson of the compass.
 */
export function northPair(race: RaceData, window: BenchWindow): NorthPair {
  const fixes = window.fixes;
  let best: NorthPair | null = null;
  for (let i = 0; i + FIX_HZ < fixes.length; i += 1) {
    const a = fixes[i];
    const b = fixes[i + FIX_HZ];
    const straddles = (a.hdg <= 90 && b.hdg >= 270) || (a.hdg >= 270 && b.hdg <= 90);
    if (!straddles) continue;
    const plain = Math.abs(b.hdg - a.hdg);
    if (best === null || plain > best.plain) {
      best = { a, b, plain, short: shortArc(a.hdg, b.hdg) };
    }
  }
  /* A window with no north crossing still has to draw a compass: fall back to
   * the first pair a second apart and let the arcs say what they say. */
  if (best === null) {
    const a = fixes[0];
    const b = fixes[Math.min(FIX_HZ, fixes.length - 1)];
    return { a, b, plain: Math.abs(b.hdg - a.hdg), short: shortArc(a.hdg, b.hdg) };
  }
  return best;
}

/**
 * When the boat's head actually passed north: the linear zero crossing of the
 * short-arc-unwrapped heading between the two consecutive fixes that bracket
 * it inside the pair's second.
 */
export function crossingInstant(race: RaceData, boatId: string, pair: NorthPair): number {
  const fixes = race.fixes[boatId];
  for (let i = 0; i + 1 < fixes.length; i += 1) {
    const a = fixes[i];
    const b = fixes[i + 1];
    if (a.t < pair.a.t || b.t > pair.b.t) continue;
    /* Signed space puts north at zero, so the crossing is a sign change. */
    const s0 = shortArc(0, a.hdg);
    const s1 = s0 + shortArc(a.hdg, b.hdg);
    if (s0 === 0) return a.t;
    if (s0 > 0 === s1 > 0) continue;
    return a.t + (s0 / (s0 - s1)) * (b.t - a.t);
  }
  return (pair.a.t + pair.b.t) / 2;
}

/** How far the held fix sits from the engine's answer at t, in metres. */
export function divergenceAt(race: RaceData, boatId: string, t: number): number {
  const raw = poseAt(race, boatId, t, "raw", newPose());
  const smooth = poseAt(race, boatId, t, "smooth", newPose());
  return Math.hypot(raw.x - smooth.x, raw.y - smooth.y);
}

/**
 * Where reduced motion parks the clock. The north crossing first, because the
 * compass is the figure with a payoff second; if the raw and smooth boats sit
 * on top of each other there, the widest gap inside the same second instead,
 * so CAM 01 still shows two boats rather than one.
 */
export function parkTime(race: RaceData, boatId: string, pair: NorthPair): number {
  const cross = crossingInstant(race, boatId, pair);
  if (divergenceAt(race, boatId, cross) >= MIN_PARK_DIVERGENCE) return cross;
  let best = cross;
  let widest = -1;
  const steps = Math.round((pair.b.t - pair.a.t) * 60);
  for (let k = 0; k <= steps; k += 1) {
    const t = pair.a.t + (k / steps) * (pair.b.t - pair.a.t);
    const d = divergenceAt(race, boatId, t);
    if (d > widest) {
      widest = d;
      best = t;
    }
  }
  return best;
}

export interface ChordPoint {
  t: number;
  x: number;
  y: number;
}

/**
 * The plainest construction there is: straight from each fix to the next, no
 * tangents at all. Sampled at the curve's own rate so the two are comparable
 * point for point.
 */
export function chordPath(fixes: Fix[], from: number, to: number): ChordPoint[] {
  const points: ChordPoint[] = [];
  const steps = Math.round((to - from) * SIM_HZ);
  let i = 0;
  for (let k = 0; k <= steps; k += 1) {
    const t = from + k / SIM_HZ;
    while (i + 2 < fixes.length && fixes[i + 1].t <= t) i += 1;
    const a = fixes[i];
    const b = fixes[i + 1];
    const dt = b.t - a.t;
    const u = dt > 0 ? (t - a.t) / dt : 0;
    points.push({ t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  }
  return points;
}

/**
 * How far the straight-line track strays from the engine's curve across the
 * window, in metres. At four fixes a second this is centimetres, which is the
 * measured reason CAM 02 argues about direction rather than about shape: a
 * neighbour-difference guess lands even closer (0.01 m on this seed), so no
 * rejected construction is drawable at figure scale and none is drawn.
 */
export function chordDrift(race: RaceData, boatId: string, window: BenchWindow): number {
  const pose = newPose();
  let worst = 0;
  for (const point of chordPath(race.fixes[boatId], window.from, window.to)) {
    poseAt(race, boatId, point.t, "smooth", pose);
    const d = Math.hypot(point.x - pose.x, point.y - pose.y);
    if (d > worst) worst = d;
  }
  return worst;
}

export interface FinishGap {
  boatId: string;
  sail: string;
  hue: string;
  dark: boolean;
  rank: number;
  elapsed: number;
  /** Seconds behind the winner; zero for the winner itself. */
  delta: number;
}

/**
 * Finishing order with the gaps the results already carry.
 *
 * These numbers are the one part of the section that has to be built on the
 * server and handed down as props. A finish time is a sub-tick crossing
 * ratio taken at the far end of a two-minute simulation, and V8 in Node and
 * V8 in the browser disagree about it by up to fifteen milliseconds, which is
 * enough to move a printed centisecond. So the page prints the server's
 * numbers, the test pins the same ones, and the client never recomputes them.
 */
export function finishGaps(race: RaceData): FinishGap[] {
  const fleet = new Map<string, BoatMeta>(race.boats.map((boat) => [boat.id, boat]));
  const order = [...race.results].sort((a, b) => a.rank - b.rank);
  const winner = order.length === 0 ? 0 : order[0].elapsed;
  return order.map((result) => {
    const boat = fleet.get(result.boatId);
    return {
      boatId: result.boatId,
      sail: boat === undefined ? result.boatId.toUpperCase() : boat.sail,
      hue: boat === undefined ? "var(--ink-dim)" : boat.hue,
      dark: boat?.dark === true,
      rank: result.rank,
      elapsed: result.elapsed,
      delta: result.elapsed - winner,
    };
  });
}

/** The seconds between the fourth and fifth boats across the line. */
export function finishGap45(order: FinishGap[]): number {
  const fourth = order[3];
  const fifth = order[4];
  return fourth === undefined || fifth === undefined ? 0 : fifth.elapsed - fourth.elapsed;
}

/** Every fix the sim wrote, across the fleet. */
export function totalFixes(race: RaceData): number {
  let n = 0;
  for (const boat of race.boats) n += race.fixes[boat.id].length;
  return n;
}

/** When the bench boat rounded the windward mark, if it does so in the window. */
export function roundingTime(race: RaceData, boatId: string): number | null {
  const event = race.events.find((entry) => entry.kind === "rounding" && entry.boatId === boatId);
  return event === undefined ? null : event.t;
}

/** Index of the last fix at or before t, or -1 before the series opens. */
export function fixIndexAt(fixes: Fix[], t: number): number {
  let lo = 0;
  let hi = fixes.length - 1;
  if (fixes.length === 0 || t < fixes[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fixes[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Bench {
  boat: BoatMeta;
  window: BenchWindow;
  gaps: { min: number; max: number };
  pair: NorthPair;
  park: number;
  /** Metres between the straight-line track and the curve, over the window. */
  drift: number;
  rounding: number | null;
  /* No finish order here. The bench is built in the browser, and the note over
     finishGaps is the reason: those six numbers are the one part of the section
     that has to come down from the server as props. A copy on the client bench
     is a second answer nobody asked for, waiting to be printed by mistake. */
}

/** Everything the engine room reads, built once per race. */
export function buildBench(race: RaceData, boatId: string = BENCH_BOAT): Bench {
  const window = benchWindow(race, boatId);
  const pair = northPair(race, window);
  const boat = race.boats.find((entry) => entry.id === boatId);
  return {
    boat: boat ?? { id: boatId, nation: boatId.toUpperCase(), sail: boatId.toUpperCase(), name: "", hue: "var(--ink-dim)" },
    window,
    gaps: gapRange(window.fixes),
    pair,
    park: parkTime(race, boatId, pair),
    drift: chordDrift(race, boatId, window),
    rounding: roundingTime(race, boatId),
  };
}
