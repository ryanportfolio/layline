/**
 * Evaluator: turns the 4 Hz fix buffers into a pose at any instant on the
 * clock. The scene, the instrument dock and the standings all read through
 * here, so they can only disagree with each other by asking about different
 * times, never by doing the arithmetic differently.
 *
 * Two honest modes. Smooth is a cubic Hermite whose tangents are the measured
 * SOG/COG at each fix rather than neighbour differences, so the curve carries
 * the velocity the boat actually reported. Raw is a zero-order hold: the fix
 * and nothing between it and the next, which is the whole point of the SNAP
 * lens and must not be softened.
 *
 * Every function writes into a caller-owned object or reuses a cached one, so
 * no call builds an object, array or closure and a frame leaves no garbage
 * worth collecting behind it.
 */
import type {
  Fix,
  LegName,
  Pose,
  ProgressSample,
  RaceData,
  RaceResult,
  ReplayMode,
  StandingsRow,
  WindSample,
} from "./types";

const DEG = Math.PI / 180;

/* A hull cannot yaw faster than this, so a fix pair implying more is telemetry
 * noise: the tangent gets capped instead of believed, which keeps a single bad
 * fix from spinning the boat. */
const MAX_TURN_RATE = 60; // deg/s

interface Timed {
  t: number;
}

/* Each series carries its own cursor because playback reads it in time order:
 * the next lookup starts where the last one finished and only falls back to a
 * bisection when the clock jumps, which is a scrub. Keyed by the array itself,
 * so two RaceData objects can never share a cursor and nothing has to be reset
 * when the race is regenerated. */
const cursors = new WeakMap<object, number>();

/* Index i with series[i].t <= t < series[i + 1].t. The caller clamps t into the
 * series range first, so the result is always a real segment. */
function locate(series: readonly Timed[], t: number): number {
  const last = series.length - 2;
  let i = cursors.get(series) ?? 0;
  if (i > last) i = last;
  else if (i < 0) i = 0;
  if (t >= series[i].t) {
    if (t < series[i + 1].t) return i;
    if (i < last && t < series[i + 2].t) {
      cursors.set(series, i + 1);
      return i + 1;
    }
  } else if (i > 0 && t >= series[i - 1].t) {
    cursors.set(series, i - 1);
    return i - 1;
  }
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  cursors.set(series, lo);
  return lo;
}

/* Tangents arrive pre-scaled by the segment length, so the derivative at a
 * join is the same from both sides even where fix spacing is uneven. */
function hermite(p0: number, m0: number, p1: number, m1: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * p0 +
    (u3 - 2 * u2 + u) * m0 +
    (-2 * u3 + 3 * u2) * p1 +
    (u3 - u2) * m1
  );
}

/** Signed short way round from a to b, in (-180, 180]. */
function arc(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/* Values already inside the canonical range come back bit-identical, which is
 * what makes an evaluation at a fix time return that fix exactly. */
function wrap360(a: number): number {
  if (a >= 0 && a < 360) return a;
  const r = a % 360;
  return r < 0 ? r + 360 : r;
}

function wrapSigned(a: number): number {
  if (a >= -180 && a <= 180) return a;
  const r = a % 360;
  if (r > 180) return r - 360;
  if (r < -180) return r + 360;
  return r;
}

function clampRate(r: number): number {
  if (r > MAX_TURN_RATE) return MAX_TURN_RATE;
  if (r < -MAX_TURN_RATE) return -MAX_TURN_RATE;
  return r;
}

/* Angular channels interpolate along the short arc off an unwrapped copy of
 * the far end, so 358 to 2 crosses north instead of driving the long way
 * round. Passing aPrev = a (and tPrev = ta) at a series end turns the central
 * difference into the one-sided one. */
function angleAt(
  aPrev: number,
  a: number,
  b: number,
  bNext: number,
  tPrev: number,
  ta: number,
  tb: number,
  tNext: number,
  u: number,
): number {
  const dt = tb - ta;
  const step = arc(a, b);
  const m0 = clampRate((arc(aPrev, a) + step) / (tb - tPrev)) * dt;
  const m1 = clampRate((step + arc(b, bNext)) / (tNext - ta)) * dt;
  return hermite(a, m0, a + step, m1, u);
}

function scalarAt(
  aPrev: number,
  a: number,
  b: number,
  bNext: number,
  tPrev: number,
  ta: number,
  tb: number,
  tNext: number,
  u: number,
): number {
  const dt = tb - ta;
  return hermite(a, ((b - aPrev) / (tb - tPrev)) * dt, b, ((bNext - a) / (tNext - ta)) * dt, u);
}

/* Hoist state is bounded 0..1 and a ramp only travels one way, so its tangents
 * get the monotone treatment: flat at a turning point, capped at three times
 * the neighbouring secants. A plain central difference dips the gennaker below
 * zero between two stowed fixes, and a negative hoist is not a thing. */
function kiteRate(fixes: readonly Fix[], i: number, n: number): number {
  const here = fixes[i];
  const sPrev = i > 0 ? (here.kite - fixes[i - 1].kite) / (here.t - fixes[i - 1].t) : 0;
  const sNext = i < n - 1 ? (fixes[i + 1].kite - here.kite) / (fixes[i + 1].t - here.t) : 0;
  if (i === 0) return sNext;
  if (i === n - 1) return sPrev;
  if (sPrev * sNext <= 0) return 0;
  const r = (fixes[i + 1].kite - fixes[i - 1].kite) / (fixes[i + 1].t - fixes[i - 1].t);
  const cap = 3 * Math.min(Math.abs(sPrev), Math.abs(sNext));
  if (r > cap) return cap;
  if (r < -cap) return -cap;
  return r;
}

function holdFix(f: Fix, out: Pose): Pose {
  out.x = f.x;
  out.y = f.y;
  out.hdg = f.hdg;
  out.heel = f.heel;
  out.twa = f.twa;
  out.sog = f.sog;
  out.cog = f.cog;
  out.kite = f.kite;
  return out;
}

export function poseAt(
  race: RaceData,
  boatId: string,
  t: number,
  mode: ReplayMode,
  out: Pose,
): Pose {
  const fixes: Fix[] | undefined = race.fixes[boatId];
  if (fixes === undefined || fixes.length === 0) return out;
  const n = fixes.length;
  const first = fixes[0];
  /* Clamped at both ends. A boat whose series has finished holds its last fix
   * rather than sailing on into water nobody measured. */
  if (n === 1 || t <= first.t) return holdFix(first, out);
  const final = fixes[n - 1];
  if (t >= final.t) return holdFix(final, out);

  const i = locate(fixes, t);
  const a = fixes[i];
  if (mode === "raw" || t === a.t) return holdFix(a, out);
  const b = fixes[i + 1];
  const dt = b.t - a.t;
  if (!(dt > 0)) return holdFix(a, out);
  const u = (t - a.t) / dt;
  const prev = i > 0 ? fixes[i - 1] : a;
  const next = i + 2 < n ? fixes[i + 2] : b;

  /* Position tangents are the reported velocity vectors, so the curve leaves
   * each fix on the heading the instrument recorded. Course frame: 0 deg is
   * +y and angles grow clockwise, hence sin on x and cos on y. */
  const ca = a.cog * DEG;
  const cb = b.cog * DEG;
  out.x = hermite(a.x, a.sog * Math.sin(ca) * dt, b.x, b.sog * Math.sin(cb) * dt, u);
  out.y = hermite(a.y, a.sog * Math.cos(ca) * dt, b.y, b.sog * Math.cos(cb) * dt, u);

  out.hdg = wrap360(angleAt(prev.hdg, a.hdg, b.hdg, next.hdg, prev.t, a.t, b.t, next.t, u));
  /* Recomputing cog from the position derivative would report a heading the
   * boat never sent, so it interpolates on its own short arc like hdg. */
  out.cog = wrap360(angleAt(prev.cog, a.cog, b.cog, next.cog, prev.t, a.t, b.t, next.t, u));
  /* twa is an angle too: a gybe steps 175 to -176 and only the short arc keeps
   * the boat downwind through it instead of sweeping it head to wind. */
  out.twa = wrapSigned(angleAt(prev.twa, a.twa, b.twa, next.twa, prev.t, a.t, b.t, next.t, u));
  out.heel = scalarAt(prev.heel, a.heel, b.heel, next.heel, prev.t, a.t, b.t, next.t, u);
  out.sog = scalarAt(prev.sog, a.sog, b.sog, next.sog, prev.t, a.t, b.t, next.t, u);
  out.kite = hermite(a.kite, kiteRate(fixes, i, n) * dt, b.kite, kiteRate(fixes, i + 1, n) * dt, u);
  return out;
}

/* Wind is uniform over the course, so one sample pair covers every boat. Linear
 * between samples; twd takes the short arc for the same reason hdg does. */
export function windAt(race: RaceData, t: number, out: WindSample): WindSample {
  const wind = race.wind;
  const n = wind.length;
  out.t = t;
  if (n === 0) return out;
  const first = wind[0];
  if (n === 1 || t <= first.t) {
    out.twd = first.twd;
    out.tws = first.tws;
    return out;
  }
  const final = wind[n - 1];
  if (t >= final.t) {
    out.twd = final.twd;
    out.tws = final.tws;
    return out;
  }
  const i = locate(wind, t);
  const a = wind[i];
  const b = wind[i + 1];
  const span = b.t - a.t;
  const u = span > 0 ? (t - a.t) / span : 0;
  out.twd = wrap360(a.twd + arc(a.twd, b.twd) * u);
  out.tws = a.tws + (b.tws - a.tws) * u;
  return out;
}

/* Progress holds rather than interpolates: rank and leg are step quantities and
 * a boat is not two thirds of the way into a rounding. */
function heldProgress(race: RaceData, boatId: string, t: number): ProgressSample | null {
  const series: ProgressSample[] | undefined = race.progress[boatId];
  if (series === undefined || series.length === 0) return null;
  const n = series.length;
  if (n === 1 || t <= series[0].t) return series[0];
  if (t >= series[n - 1].t) return series[n - 1];
  return series[locate(series, t)];
}

/* A boat with no progress series has not started, which is the only leg that
 * makes no claim about where it is on the course. */
export function legAt(race: RaceData, boatId: string, t: number): LegName {
  const p = heldProgress(race, boatId, t);
  return p === null ? "prestart" : p.leg;
}

/* Finished boats first, in crossing order; the rest by their held rank. The
 * boats across the line by time t always hold result ranks 1..k, so a held
 * rank can collide with a fresh finisher only from below, and ordering the
 * finishers first is what makes the positional rewrite in standingsAt give
 * every row a unique place. */
function byRank(a: StandingsRow, b: StandingsRow): number {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.boatId < b.boatId ? -1 : a.boatId > b.boatId ? 1 : 0;
}

const tables = new WeakMap<RaceData, StandingsRow[]>();
const finishTables = new WeakMap<RaceData, Map<string, RaceResult>>();

/* Returns the same array every call for a given race: the dock re-renders off
 * the clock, not off array identity, and a fresh array per frame would be an
 * allocation on the hot path. Sorted rank first, then id, so two boats holding
 * the same rank across the end of one series still order deterministically. */
export function standingsAt(race: RaceData, t: number): StandingsRow[] {
  let rows = tables.get(race);
  if (rows === undefined) {
    rows = [];
    for (let k = 0; k < race.boats.length; k++) {
      rows.push({
        boatId: race.boats[k].id,
        rank: k + 1,
        leg: "prestart",
        gapMeters: 0,
        gapSeconds: 0,
        finished: false,
      });
    }
    tables.set(race, rows);
  }
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k];
    const p = heldProgress(race, row.boatId, t);
    if (p === null) continue;
    row.rank = p.rank;
    row.leg = p.leg;
    row.gapMeters = p.gapMeters;
    row.gapSeconds = p.gapSeconds;
    row.finished = p.leg === "finished";
  }
  /* A crossing lands between held samples: tFinish is sub-tick while progress
   * arrives at PROGRESS_HZ, so a boat's finished leg can lag its own line by
   * half a second. The results are the authority on who has crossed; a row
   * whose finish time has passed reads finished now, at its result rank, not
   * at the next progress sample. */
  let crossed = finishTables.get(race);
  if (crossed === undefined) {
    crossed = new Map(race.results.map((result) => [result.boatId, result]));
    finishTables.set(race, crossed);
  }
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k];
    const result = crossed.get(row.boatId);
    if (result !== undefined && result.elapsed <= t) {
      row.finished = true;
      row.leg = "finished";
      row.rank = result.rank;
    }
  }
  rows.sort(byRank);
  /* Positions are the sort order, not the raw ranks: a boat that crosses
   * between progress samples takes its result rank while a rival still holds
   * the same number from the last sample, and two rows must never show one
   * place. Finished rows keep their result rank (they sort 1..k), held rows
   * take the places after the finishers. */
  for (let k = 0; k < rows.length; k++) rows[k].rank = k + 1;
  return rows;
}
