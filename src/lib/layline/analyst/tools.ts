/**
 * Analyst tools. Every tool is a pure function over one RaceData, so the
 * route binds them to the memoized race and the tests bind them to fresh
 * generateRace output and both read the same numbers. SI stays SI inside;
 * anything the HUD shows in display units crosses format.ts on the way out,
 * the same edge every on-screen number crosses.
 */
import { groundMadeGoodToMark, maneuversOf } from "@/lib/layline/analytics";
import {
  compareRange,
  raceAnalysisValidity,
  type BoatRangeFacts,
  type ComparisonRequest,
  type ManeuverRangeFact,
  type RangeComparison,
  type RangeCoverage,
  type ReferenceRangeFacts,
} from "@/lib/layline/comparison";
import { MISSING, clock, deg, knots } from "@/lib/layline/format";
import { windAt as interpolateWindAt } from "@/lib/layline/interpolate";
import type { BoatMeta, Fix, LegName, RaceData } from "@/lib/layline/types";
import { velocityFromComponents, windAxisVmgFromComponents } from "@/lib/layline/velocity";
import { lookupTerms } from "./knowledge";

/* The window analytics.ts measures a turn over, mirrored so the entry and exit
 * speeds this tool reports bracket the loss that detector computed. */
const LOSS_WINDOW = 4;

/* ------------------------------------------------------------------ */
/* Shared lookups                                                      */

function boatById(race: RaceData, id: string): BoatMeta | undefined {
  return race.boats.find((boat) => boat.id === id);
}

function clampT(race: RaceData, t: number): number {
  if (!Number.isFinite(t)) return race.tMin;
  if (t < race.tMin) return race.tMin;
  if (t > race.tMax) return race.tMax;
  return t;
}

/** Nearest fix to t. Fixes are sorted, 4 per second. */
function fixNear(fixes: Fix[], t: number): Fix {
  let lo = 0;
  let hi = fixes.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return t - fixes[lo].t <= fixes[hi].t - t ? fixes[lo] : fixes[hi];
}

/** Last progress sample at or before t, else the first. */
function progressAt(race: RaceData, boatId: string, t: number): RaceData["progress"][string][number] {
  const samples = race.progress[boatId];
  let found = samples[0];
  for (const sample of samples) {
    if (sample.t > t) break;
    found = sample;
  }
  return found;
}

/**
 * Speed made good toward the mark the boat is sailing for: along-course speed,
 * signed so positive always points at that mark. The same quantity the strip
 * beside the dock prints as "To mark".
 *
 * Only the beat and the run have a mark to make good toward. Before the gun a
 * boat is working the line, and after it finishes there is nothing left to
 * sail for, so the strip prints nothing on those legs and this returns null
 * rather than a number about a mark that is not there.
 */
function racingLeg(leg: LegName): boolean {
  return leg === "beat" || leg === "run";
}

function fixVelocity(fix: Fix) {
  return velocityFromComponents(fix.waterX, fix.waterY, fix.currentX, fix.currentY, {});
}

function toMarkOf(fix: Fix, leg: LegName): number | null {
  if (!racingLeg(leg)) return null;
  return groundMadeGoodToMark(fix, leg);
}

/**
 * VMG the way the instrument dock means it: speed resolved onto the wind axis.
 * Positive climbing to windward, negative running away from the wind, which is
 * why it is a different number from the one above whenever the wind sits off
 * the course axis. The analyst gets both so it can quote either surface
 * without either of them being wrong.
 */
function vmgOf(fix: Fix, twd: number): number | null {
  return windAxisVmgFromComponents(
    fix.waterX,
    fix.waterY,
    fix.currentX,
    fix.currentY,
    twd,
  )?.ground ?? null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                                */

export interface AnalystError {
  error: string;
}

export interface StandingsRowOut {
  rank: number;
  boatId: string;
  sail: string;
  leg: LegName;
  dtfMeters: number;
  gapSeconds: number;
  finished: boolean;
}

export interface StandingsOut {
  raceClock: string;
  rows: StandingsRowOut[];
  error?: string;
}

export function standingsAt(race: RaceData, tRaw: number): StandingsOut {
  const telemetryError = analystTelemetryError(race, race.boats.map((boat) => boat.id));
  if (telemetryError !== null) return { raceClock: MISSING, rows: [], ...telemetryError };
  const t = clampT(race, tRaw);
  const rows = race.boats.map((boat): StandingsRowOut => {
    const p = progressAt(race, boat.id, t);
    return {
      rank: p.rank,
      boatId: boat.id,
      sail: boat.sail,
      leg: p.leg,
      dtfMeters: Math.round(p.dtf),
      gapSeconds: p.rank <= 1 ? 0 : Math.round(p.gapSeconds),
      finished: p.leg === "finished",
    };
  });

  /* Progress samples land twice a second while a finish time is exact, so for
   * up to half a second after a boat crosses, its held sample still reads as
   * racing. The crossing itself is the authority, the same override the HUD
   * standings apply, so the analyst cannot say a boat is still on the run
   * while the screen shows it finished. */
  for (const row of rows) {
    const result = race.results.find((entry) => entry.boatId === row.boatId);
    if (result === undefined || result.elapsed > t) continue;
    row.finished = true;
    row.leg = "finished";
    row.rank = result.rank;
    /* The rest of the row follows the crossing too. A boat over the line is no
     * distance from it and no seconds behind anyone, which is what the next
     * progress sample holds anyway; without this the row would read finished
     * with meters still to run. */
    row.dtfMeters = 0;
    row.gapSeconds = 0;
  }

  rows.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.boatId < b.boatId ? -1 : a.boatId > b.boatId ? 1 : 0;
  });
  for (let i = 0; i < rows.length; i++) rows[i].rank = i + 1;
  return { raceClock: clock(t), rows };
}

export interface BoatStateOut {
  boatId: string;
  sail: string;
  raceClock: string;
  leg: LegName;
  xMeters: number;
  yMeters: number;
  sogKnots: string;
  cogDeg: string;
  stwKnots: string;
  ctwDeg: string;
  currentDriftKnots: string;
  currentSetDeg: string;
  waterX: number;
  waterY: number;
  currentX: number;
  currentY: number;
  groundX: number;
  groundY: number;
  telemetryProvenance: "recorded-fix";
  hdgDeg: string;
  heelDeg: string;
  twaDeg: string;
  kite: number;
  /* Both readings the page shows, under the names the page shows them by:
   * "To mark" on the strip, "VMG" on the dock. To mark is null off the racing
   * legs, the same place the strip prints nothing. */
  toMarkKnots: string | null;
  vmgKnots: string;
}

function analystTelemetryError(
  race: RaceData,
  requiredBoatIds: readonly string[],
): AnalystError | null {
  const validity = raceAnalysisValidity(race, requiredBoatIds);
  return validity.status === "valid"
    ? null
    : { error: validity.reason ?? "race analysis preflight failed" };
}

export function boatState(race: RaceData, boatId: string, tRaw: number): BoatStateOut | AnalystError {
  const raceError = analystTelemetryError(race, []);
  if (raceError !== null) return raceError;
  const boat = boatById(race, boatId);
  if (boat === undefined) return { error: unknownBoat(race, boatId) };
  const telemetryError = analystTelemetryError(race, [boat.id]);
  if (telemetryError !== null) return telemetryError;
  const t = clampT(race, tRaw);
  const fix = fixNear(race.fixes[boat.id], t);
  const leg = progressAt(race, boat.id, fix.t).leg;
  const toMark = toMarkOf(fix, leg);
  const velocity = fixVelocity(fix);
  const wind = interpolateWindAt(race, fix.t, { t: 0, twd: 0, tws: 0 });
  const vmg = vmgOf(fix, wind.twd);
  return {
    boatId: boat.id,
    sail: boat.sail,
    raceClock: clock(fix.t),
    leg,
    xMeters: round1(fix.x),
    yMeters: round1(fix.y),
    sogKnots: knots(velocity.sog),
    cogDeg: velocity.cog === null ? MISSING : deg(velocity.cog),
    stwKnots: knots(velocity.stw),
    ctwDeg: velocity.ctw === null ? MISSING : deg(velocity.ctw),
    currentDriftKnots: knots(velocity.currentDrift),
    currentSetDeg: velocity.currentSet === null ? MISSING : deg(velocity.currentSet),
    waterX: fix.waterX,
    waterY: fix.waterY,
    currentX: fix.currentX,
    currentY: fix.currentY,
    groundX: velocity.groundX,
    groundY: velocity.groundY,
    telemetryProvenance: "recorded-fix",
    hdgDeg: deg(fix.hdg),
    heelDeg: deg(fix.heel),
    twaDeg: deg(fix.twa),
    kite: round2(fix.kite),
    toMarkKnots: toMark === null ? null : knots(toMark),
    vmgKnots: vmg === null ? MISSING : knots(vmg),
  };
}

export interface CompareSideOut {
  boatId: string;
  sail: string;
  avgSogKnots: string;
  avgToMarkKnots: string | null;
  avgVmgKnots: null;
  distanceSailedMeters: number | null;
}

export interface CompareEquationOut {
  observedGainMeters: number | null;
  straightMadeGoodDeltaMeters: number | null;
  maneuverWindowMadeGoodDeltaMeters: number | null;
  residualMeters: number | null;
  waterMadeGoodDeltaMeters: number | null;
  currentMadeGoodDeltaMeters: number | null;
  groundMadeGoodGainMeters: number | null;
  componentResidualMeters: number | null;
  provenance: RangeComparison["componentProvenance"];
}

export interface CompareOut {
  fromClock: string;
  toClock: string;
  a: CompareSideOut;
  b: CompareSideOut;
  aAheadByMetersAtStart: number | null;
  aAheadByMetersAtEnd: number | null;
  comparison: RangeComparison;
  equation: CompareEquationOut;
}

type CompareSideFacts = Pick<
  BoatRangeFacts | ReferenceRangeFacts,
  "meanSogMps" | "meanVmgMps" | "sailedDistanceMeters"
>;

function compareSide(
  boat: Pick<BoatMeta, "id" | "sail"> | null,
  facts: CompareSideFacts | null,
): CompareSideOut {
  return {
    boatId: boat?.id ?? "fleet-median",
    sail: boat?.sail ?? "Fixed fleet median",
    avgSogKnots: facts?.meanSogMps == null ? MISSING : knots(facts.meanSogMps),
    avgToMarkKnots: facts?.meanVmgMps == null ? null : knots(facts.meanVmgMps),
    /* Legacy dock-VMG key stays present, but compareRange does not compute the
     * distinct wind-axis quantity. Null is honest; copying mark VMG here would
     * collapse two different reference frames. */
    avgVmgKnots: null,
    distanceSailedMeters:
      facts?.sailedDistanceMeters == null ? null : finiteRounded(facts.sailedDistanceMeters),
  };
}

function finiteRounded(value: number | null): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value as number);
  if (!Number.isFinite(rounded)) return null;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Exact analyst adapter. Canonical arithmetic is returned unchanged for
 * in-process callers; the model wire gets compareWireView of this instead.
 */
export function compareRangeForAnalyst(
  race: RaceData,
  request: ComparisonRequest,
): CompareOut | AnalystError {
  const telemetryError = analystTelemetryError(race, []);
  if (telemetryError !== null) return telemetryError;
  const result = compareRange(race, request);
  if (result.status === "invalid-request" || result.primary === null) {
    return { error: result.invalidReason ?? "comparison request is invalid" };
  }
  const primary = boatById(race, result.primaryBoatId);
  if (primary === undefined) return { error: unknownBoat(race, result.primaryBoatId) };
  const rival =
    result.reference.boatId === null ? null : boatById(race, result.reference.boatId) ?? null;
  const rivalFacts =
    result.reference.boatId === null
      ? result.referenceFacts
      : result.boats.find((facts) => facts.boatId === result.reference.boatId) ?? null;
  return {
    fromClock: clock(result.range.from),
    toClock: clock(result.range.to),
    a: compareSide(primary, result.primary),
    b: compareSide(rival, rivalFacts),
    aAheadByMetersAtStart: finiteRounded(result.startAdvantageMeters),
    aAheadByMetersAtEnd: finiteRounded(result.endAdvantageMeters),
    comparison: result,
    equation: {
      observedGainMeters: result.progressGainedMeters,
      straightMadeGoodDeltaMeters: result.straightDeltaMeters,
      maneuverWindowMadeGoodDeltaMeters: result.maneuverWindowDeltaMeters,
      residualMeters: result.residualMeters,
      waterMadeGoodDeltaMeters: result.waterDeltaMeters,
      currentMadeGoodDeltaMeters: result.currentDeltaMeters,
      groundMadeGoodGainMeters: result.groundGainMeters,
      componentResidualMeters: result.componentResidualMeters,
      provenance: result.componentProvenance,
    },
  };
}

/**
 * What compare_boats actually puts on the model wire. CompareOut carries the
 * canonical RangeComparison for in-process callers and tests, but serializing
 * it verbatim buries the model: coverage.bins alone is one JSON entry per
 * 250ms telemetry bin (72 entries for an 18s range, ~4.6KB of "included"),
 * and boats/primary/referenceFacts restate what a/b already summarize.
 * Measured before this view existed, one compare result ran 9.9KB and a
 * fleet-median one 13.8KB; a fleet-wide question then blew the round budget
 * and the forced answer arrived as an unscannable wall. The wire keeps every
 * fact the system prompt tells the analyst to state (status, coverage and
 * exclusions in seconds, cohort ids, in-range maneuvers with their null
 * costs, both equations) and drops the rest.
 */
export interface CompareWireComparisonOut {
  status: RangeComparison["status"];
  boundaryFactsStatus: RangeComparison["boundaryFactsStatus"];
  invalidReason: string | null;
  reference: RangeComparison["reference"];
  coverage: {
    coverageSeconds: number;
    excludedByReasonSeconds: RangeCoverage["excludedByReasonSeconds"];
  };
  primaryManeuverCount: number;
  primaryManeuvers: Omit<ManeuverRangeFact, "window">[];
  referenceNonlinearityMeters: number | null;
  progressResidualMeters: number | null;
}

export interface CompareWireOut {
  fromClock: string;
  toClock: string;
  a: CompareSideOut;
  b: CompareSideOut;
  aAheadByMetersAtStart: number | null;
  aAheadByMetersAtEnd: number | null;
  comparison: CompareWireComparisonOut;
  equation: CompareEquationOut;
}

export function compareWireView(out: CompareOut | AnalystError): CompareWireOut | AnalystError {
  if ("error" in out) return out;
  const full = out.comparison;
  return {
    fromClock: out.fromClock,
    toClock: out.toClock,
    a: out.a,
    b: out.b,
    aAheadByMetersAtStart: out.aAheadByMetersAtStart,
    aAheadByMetersAtEnd: out.aAheadByMetersAtEnd,
    comparison: {
      status: full.status,
      boundaryFactsStatus: full.boundaryFactsStatus,
      invalidReason: full.invalidReason,
      reference: full.reference,
      coverage: {
        coverageSeconds: full.coverage.coverageSeconds,
        excludedByReasonSeconds: full.coverage.excludedByReasonSeconds,
      },
      primaryManeuverCount: full.primary?.maneuverCount ?? 0,
      primaryManeuvers: (full.primary?.maneuvers ?? []).map((fact) => {
        const { window: dropped, ...wire } = fact;
        void dropped;
        return wire;
      }),
      referenceNonlinearityMeters: full.referenceNonlinearityMeters,
      progressResidualMeters: full.progressResidualMeters,
    },
    equation: out.equation,
  };
}

export function compareBoats(
  race: RaceData,
  aId: string,
  bId: string,
  t0Raw: number,
  t1Raw: number,
): CompareOut | AnalystError {
  const telemetryError = analystTelemetryError(race, []);
  if (telemetryError !== null) return telemetryError;
  const a = boatById(race, aId);
  const b = boatById(race, bId);
  if (a === undefined) return { error: unknownBoat(race, aId) };
  if (b === undefined) return { error: unknownBoat(race, bId) };
  return compareRangeForAnalyst(race, {
    primaryBoatId: a.id,
    reference: { kind: "boat", boatId: b.id },
    /* compareRange owns safe integer-microsecond validation before clamping. */
    range: { from: t0Raw, to: t1Raw },
  });
}

export interface ManeuverOut {
  boatId: string;
  sail: string;
  kind: "tack" | "gybe";
  t: number;
  raceClock: string;
  entrySogKnots: string;
  exitSogKnots: string;
  speedLossKnots: string | null;
}

/**
 * Tacks and gybes, read from the same detector the timeline markers use
 * ([`analytics.maneuversOf`]). The two used to be separate loops kept in step
 * by hand, and they drifted the moment either side improved: the markers
 * measured the drawdown off the speed carried into the turn while the tool
 * still took the slowest reading against the first fix of its window, so on
 * this fleet every gybe read 0.0 to a viewer and 0.5 to 1.0 on the tooltip
 * beside it. One detector, one number, no way to disagree.
 *
 * Entry is the reading the loss is measured from, the fastest in the four
 * seconds up to the flip; exit is the last reading four seconds past it.
 */
export type ManeuverOutList = ManeuverOut[] & { error?: string };

function invalidManeuvers(error: AnalystError): ManeuverOutList {
  return Object.assign([] as ManeuverOut[], error);
}

export function detectManeuvers(race: RaceData, boatId?: string): ManeuverOutList {
  const raceError = analystTelemetryError(race, []);
  if (raceError !== null) return invalidManeuvers(raceError);
  const boats =
    boatId === undefined ? race.boats : race.boats.filter((boat) => boat.id === boatId);
  const telemetryError = analystTelemetryError(race, boats.map((boat) => boat.id));
  if (telemetryError !== null) return invalidManeuvers(telemetryError);
  const out: ManeuverOutList = [];
  for (const boat of boats) {
    const fixes = race.fixes[boat.id];
    for (const move of maneuversOf(race, boat.id)) {
      let entry = -Infinity;
      let exit = fixes[0];
      for (const fix of fixes) {
        if (fix.t < move.t - LOSS_WINDOW) continue;
        if (fix.t > move.t + LOSS_WINDOW) break;
        const sog = fixVelocity(fix).sog;
        if (fix.t <= move.t && sog > entry) entry = sog;
        exit = fix;
      }
      out.push({
        boatId: boat.id,
        sail: boat.sail,
        kind: move.kind,
        t: move.t,
        raceClock: clock(move.t),
        entrySogKnots: knots(entry),
        exitSogKnots: knots(fixVelocity(exit).sog),
        speedLossKnots: move.lossKnots,
      });
    }
  }
  out.sort((a, b) => a.t - b.t || (a.boatId < b.boatId ? -1 : 1));
  return out;
}

export interface StartRowOut {
  boatId: string;
  sail: string;
  distanceToLineMeters: number;
  sogAtGunKnots: string;
  crossedAfterGunSeconds: number | null;
  nearerEnd: "pin" | "boat";
}

export interface StartReportOut {
  lineLengthMeters: number | null;
  rows: StartRowOut[];
  error?: string;
}

export function startReport(race: RaceData): StartReportOut {
  const telemetryError = analystTelemetryError(race, race.boats.map((boat) => boat.id));
  if (telemetryError !== null) return { lineLengthMeters: null, rows: [], ...telemetryError };
  const rows = race.boats.map((boat): StartRowOut => {
    const fixes = race.fixes[boat.id];
    const atGun = fixNear(fixes, 0);
    let crossed: number | null = null;
    for (let i = 1; i < fixes.length; i++) {
      const before = fixes[i - 1];
      const after = fixes[i];
      if (after.t <= 0) continue;
      if (before.y < 0 && after.y >= 0) {
        crossed = round2(before.t + ((0 - before.y) / (after.y - before.y)) * (after.t - before.t));
        break;
      }
    }
    const toPin = Math.hypot(atGun.x - race.course.startPin.x, atGun.y - race.course.startPin.y);
    const toBoat = Math.hypot(atGun.x - race.course.startBoat.x, atGun.y - race.course.startBoat.y);
    return {
      boatId: boat.id,
      sail: boat.sail,
      distanceToLineMeters: round1(Math.abs(atGun.y)),
      sogAtGunKnots: knots(fixVelocity(atGun).sog),
      crossedAfterGunSeconds: crossed,
      nearerEnd: toPin < toBoat ? "pin" : "boat",
    };
  });
  rows.sort((a, b) => {
    const ca = a.crossedAfterGunSeconds ?? Infinity;
    const cb = b.crossedAfterGunSeconds ?? Infinity;
    return ca - cb || (a.boatId < b.boatId ? -1 : 1);
  });
  return {
    lineLengthMeters: Math.round(race.course.startBoat.x - race.course.startPin.x),
    rows,
  };
}

export interface WindOut {
  raceClock: string;
  twdDeg: string;
  twsKnots: string;
}

export function windAt(race: RaceData, tRaw: number): WindOut {
  const t = clampT(race, tRaw);
  let nearest = race.wind[0];
  for (const sample of race.wind) {
    if (Math.abs(sample.t - t) < Math.abs(nearest.t - t)) nearest = sample;
  }
  return { raceClock: clock(t), twdDeg: deg(nearest.twd), twsKnots: knots(nearest.tws) };
}

export interface LookupOut {
  matches: { title: string; text: string }[];
}

export function lookupTerm(query: string): LookupOut {
  return { matches: lookupTerms(query).map(({ title, text }) => ({ title, text })) };
}

function unknownBoat(race: RaceData, id: string): string {
  return `unknown boat id "${id}"; use one of ${race.boats.map((boat) => boat.id).join(", ")}`;
}

/* ------------------------------------------------------------------ */
/* Tool schemas, provider-neutral JSON Schema                          */

export interface AnalystTool {
  name: string;
  description: string;
  strict: true;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

/* Two speeds made good, and the page prints both under these names. Saying
 * which is which in every description that returns them is what keeps an
 * answer from calling the strip's number by the dock's name. */
const SPEED_NOTE =
  "Two made-good readings come back and they are different numbers. toMark is ground speed along the course axis, SOG*cos(COG), signed toward whichever mark the boat is sailing for, so it is positive whenever the boat is gaining; the strip beside the instrument dock prints it as \"To mark\". vmg is ground wind-axis VMG = SOG*cos(COG - TWD), positive climbing to windward and negative running away from the wind; that is the number the dock's VMG tile shows. The water wind-axis counterpart = STW*cos(CTW - TWD), but boat_state reports the ground quantity. They differ whenever the wind sits off the course axis, and they differ in sign on the run. toMark is null before the gun and after a boat finishes, when there is no mark to make good toward and the strip prints nothing; the strip also floors its display at zero, so a small negative reading here shows on screen as 0.0.";

const T_NOTE = "Race time in seconds relative to the gun; negative is the prestart.";

export const ANALYST_TOOLS: AnalystTool[] = [
  {
    name: "standings_at",
    description:
      "Fleet standings at a race time: rank, current leg, distance to finish in meters, gap to the leader in seconds, and whether each boat has finished. During the prestart, rank is entry order and gaps are not meaningful.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { t: { type: "number", description: T_NOTE } },
      required: ["t"],
      additionalProperties: false,
    },
  },
  {
    name: "boat_state",
    description:
      `One boat's recorded-fix telemetry at a race time: position, water/current components in meters per second, derived speed/course through water, current drift/set, derived speed/course over ground, heading, heel, wind angle, gennaker state, and both made-good speeds. ${SPEED_NOTE}`,
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        boatId: { type: "string", description: "Lowercase boat id, for example nzl" },
        t: { type: "number", description: T_NOTE },
      },
      required: ["boatId", "t"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_boats",
    description:
      "Compare one selected boat with either a named rival or a fixed fleet median over an exact race-time range: per-side average sog and speed to the mark in knots with distance sailed, the along-course advantage at both range ends, comparison status with coverage seconds and exclusions, cohort ids, the selected boat's in-range maneuvers with unsupported costs left null, the straight plus maneuver-window equation, and the alternative water plus current equation. Water and current are reconstructed fix components, ground is their derived sum, and current contribution is descriptive rather than a tactical cause. Positive advantage means the selected boat is ahead; positive gain means it improved over the range. Legacy avgVmgKnots remains null because wind-axis dock VMG is distinct from ground-to-mark VMG.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        a: { type: "string", description: "Lowercase id of the selected boat" },
        referenceKind: {
          type: "string",
          enum: ["boat", "fleet-median"],
          description: "Named rival or fixed fleet-median reference",
        },
        b: {
          type: ["string", "null"],
          description: "Named rival id when referenceKind is boat; otherwise null",
        },
        cohortBoatIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Fixed requested boat ids when referenceKind is fleet-median; otherwise an empty array",
        },
        t0: { type: "number", description: `Exact range start. ${T_NOTE}` },
        t1: { type: "number", description: `Exact range end. ${T_NOTE}` },
      },
      required: ["a", "referenceKind", "b", "cohortBoatIds", "t0", "t1"],
      additionalProperties: false,
    },
  },
  {
    name: "maneuvers",
    description:
      "Every tack and gybe, for one boat or the whole fleet: when it happened, entry and exit speed in knots, and speed lost through the turn. A tack is a wind-angle sign flip under 90 degrees off the wind, a gybe at 90 or wider. Speed lost is the drawdown off the speed carried in: the fastest reading in the four seconds up to the turn minus the slowest between that peak and four seconds past it, the same figure the timeline marker shows.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        boatId: {
          type: ["string", "null"],
          description: "Lowercase boat id, or null for the whole fleet",
        },
      },
      required: ["boatId"],
      additionalProperties: false,
    },
  },
  {
    name: "start_report",
    description:
      "The start, boat by boat: distance short of the line at the gun in meters, speed at the gun in knots, seconds to cross the line after the gun, and which end each boat started nearer, the pin or the committee boat. Rows are ordered by crossing time.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "wind_at",
    description:
      "True wind at a race time: direction in degrees in the course frame, where 0 blows straight down the course, and speed in knots.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { t: { type: "number", description: T_NOTE } },
      required: ["t"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_sailing_term",
    description:
      "Look up a sailing term in the glossary: layline, VMG, tack, gybe, gennaker, start bias, OCS, and the rest. Returns the two best matching entries.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "The term or phrase to look up" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function comparisonRequest(args: Record<string, unknown>): ComparisonRequest {
  const primaryBoatId = str(args.a);
  if (args.referenceKind === "fleet-median") {
    const boatIds = Array.isArray(args.cohortBoatIds)
      ? args.cohortBoatIds.filter((id): id is string => typeof id === "string")
      : [];
    return {
      primaryBoatId,
      reference: { kind: "fleet-median", boatIds },
      range: { from: num(args.t0), to: num(args.t1) },
    };
  }
  return {
    primaryBoatId,
    reference: { kind: "boat", boatId: str(args.b) },
    range: { from: num(args.t0), to: num(args.t1) },
  };
}

/** Run one tool by name against one race. Returns the tool_result JSON. */
export function runTool(race: RaceData, name: string, input: unknown): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  if (["standings_at", "boat_state", "compare_boats", "maneuvers", "start_report"].includes(name)) {
    const telemetryError = analystTelemetryError(race, []);
    if (telemetryError !== null) return JSON.stringify(telemetryError);
  }
  switch (name) {
    case "standings_at":
      return JSON.stringify(standingsAt(race, num(args.t)));
    case "boat_state":
      return JSON.stringify(boatState(race, str(args.boatId), num(args.t)));
    case "compare_boats":
      return JSON.stringify(compareWireView(compareRangeForAnalyst(race, comparisonRequest(args))));
    case "maneuvers": {
      const boatId = typeof args.boatId === "string" && args.boatId.length > 0 ? args.boatId : undefined;
      if (boatId !== undefined && boatById(race, boatId) === undefined) {
        return JSON.stringify({ error: unknownBoat(race, boatId) });
      }
      const moves = detectManeuvers(race, boatId);
      if (moves.error !== undefined) return JSON.stringify({ error: moves.error });
      return JSON.stringify({
        tacks: moves.filter((move) => move.kind === "tack").length,
        gybes: moves.filter((move) => move.kind === "gybe").length,
        moves,
      });
    }
    case "start_report":
      return JSON.stringify(startReport(race));
    case "wind_at":
      return JSON.stringify(windAt(race, num(args.t)));
    case "lookup_sailing_term":
      return JSON.stringify(lookupTerm(str(args.query)));
    default:
      return JSON.stringify({ error: `unknown tool "${name}"` });
  }
}

/** Human status line for the stream while a tool runs. Display text: no periods. */
export function toolStatusLabel(race: RaceData, name: string, input: unknown): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const sail = (id: unknown): string => {
    const boat = typeof id === "string" ? boatById(race, id) : undefined;
    return boat === undefined ? "the fleet" : boat.sail;
  };
  switch (name) {
    case "standings_at":
      return `checking standings at ${clock(clampT(race, num(args.t)))}`;
    case "boat_state":
      return `reading ${sail(args.boatId)} at ${clock(clampT(race, num(args.t)))}`;
    case "compare_boats":
      return args.referenceKind === "fleet-median"
        ? `comparing ${sail(args.a)} with the fixed fleet median`
        : `comparing ${sail(args.a)} and ${sail(args.b)}`;
    case "maneuvers":
      return typeof args.boatId === "string" && args.boatId.length > 0
        ? `counting ${sail(args.boatId)} tacks and gybes`
        : "counting tacks and gybes";
    case "start_report":
      return "reviewing the start";
    case "wind_at":
      return `checking the wind at ${clock(clampT(race, num(args.t)))}`;
    case "lookup_sailing_term":
      return `looking up ${str(args.query).slice(0, 40) || "a term"}`;
    default:
      return "reading the race data";
  }
}
