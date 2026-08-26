import { groundMadeGoodToMark, maneuversOf } from "./analytics";
import { currentFieldSpecValidity } from "./current";
import { createPose, legAt, poseAt } from "./interpolate";
import type { Fix, LegName, Pose, ProgressSample, RaceData } from "./types";
import { projectVelocityComponentsOntoBearing, velocityFromComponents } from "./velocity";

const MICROS_PER_SECOND = 1_000_000;

type FiniteResult =
  | { status: "ok"; value: number }
  | { status: "invalid-arithmetic"; value: null };

const INVALID_ARITHMETIC: FiniteResult = {
  status: "invalid-arithmetic",
  value: null,
};

function finiteResult(value: number): FiniteResult {
  if (!Number.isFinite(value)) return INVALID_ARITHMETIC;
  return { status: "ok", value: Object.is(value, -0) ? 0 : value };
}

function addFinite(left: number, right: number): FiniteResult {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return INVALID_ARITHMETIC;
  return finiteResult(left + right);
}

function subtractFinite(left: number, right: number): FiniteResult {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return INVALID_ARITHMETIC;
  return finiteResult(left - right);
}

function multiplyFinite(left: number, right: number): FiniteResult {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return INVALID_ARITHMETIC;
  return finiteResult(left * right);
}

function divideFinite(dividend: number, divisor: number): FiniteResult {
  if (!Number.isFinite(dividend) || !Number.isFinite(divisor) || divisor === 0) {
    return INVALID_ARITHMETIC;
  }
  return finiteResult(dividend / divisor);
}

export type ComparisonReference =
  | { kind: "boat"; boatId: string }
  | { kind: "fleet-median"; boatIds: readonly string[] };

export interface AnalysisRange {
  from: number;
  to: number;
  fromMicros: number;
  toMicros: number;
  durationMicros: number;
}

export interface ComparisonRequest {
  primaryBoatId: string;
  reference: ComparisonReference;
  range: { from: number; to: number };
}

export type CoverageReason =
  | "included"
  | "prestart-or-finished"
  | "missing-bracket"
  | "invalid-sample"
  | "invalid-arithmetic";

export interface CoverageBin {
  fromMicros: number;
  toMicros: number;
  reason: CoverageReason;
}

export interface RangeCoverage {
  durationMicros: number;
  coverageMicros: number;
  coverageSeconds: number;
  excludedByReasonMicros: {
    prestartOrFinished: number;
    missingBracket: number;
    invalidSample: number;
    invalidArithmetic: number;
  };
  excludedByReasonSeconds: {
    prestartOrFinished: number;
    missingBracket: number;
    invalidSample: number;
    invalidArithmetic: number;
  };
  bins: CoverageBin[];
}

export interface TrackRangeFacts {
  status:
    | "ok"
    | "zero-duration"
    | "invalid-request"
    | "missing-bracket"
    | "invalid-sample"
    | "invalid-arithmetic";
  boatId: string;
  range: AnalysisRange;
  durationMicros: number;
  sailedDistanceMeters: number | null;
  meanSogMps: number | null;
  meanVmgMps: number | null;
  vmgCoverageMicros: number;
}

export interface ManeuverRangeFact {
  t: number;
  kind: "tack" | "gybe";
  countedInRange: boolean;
  lossStatus: "available" | "invalid-arithmetic";
  lossMps: number | null;
  costMeters: null;
  costSeconds: null;
  window: AnalysisRange;
}

export interface BoatRangeFacts {
  boatId: string;
  groundFactsStatus: "ok" | "no-valid-coverage" | "invalid-arithmetic";
  groundFactsCoverageMicros: number;
  startDtfMeters: number | null;
  endDtfMeters: number | null;
  progressMeters: number | null;
  sailedDistanceMeters: number | null;
  meanSogMps: number | null;
  meanVmgMps: number | null;
  maneuverCount: number;
  maneuvers: ManeuverRangeFact[];
  straightMadeGoodMeters: number | null;
  maneuverWindowMadeGoodMeters: number | null;
  waterMadeGoodMeters: number | null;
  currentMadeGoodMeters: number | null;
  groundMadeGoodMeters: number | null;
}

export interface ReferenceRangeFacts {
  groundFactsStatus: "ok" | "no-valid-coverage" | "invalid-arithmetic";
  groundFactsCoverageMicros: number;
  startDtfMeters: number;
  endDtfMeters: number;
  progressMeters: number | null;
  sailedDistanceMeters: number | null;
  meanSogMps: number | null;
  meanVmgMps: number | null;
  maneuverCount: number | null;
  straightMadeGoodMeters: number | null;
  maneuverWindowMadeGoodMeters: number | null;
  waterMadeGoodMeters: number | null;
  currentMadeGoodMeters: number | null;
  groundMadeGoodMeters: number | null;
}

export type ComparisonStatus =
  | "ok"
  | "invalid-request"
  | "missing-boundary-data"
  | "insufficient-fleet-coverage"
  | "zero-duration"
  | "no-racing-coverage"
  | "invalid-arithmetic";

export type BoundaryFactsStatus =
  | "available"
  | "unavailable"
  | "missing-bracket"
  | "invalid-sample"
  | "missing-and-invalid"
  | "invalid-arithmetic";

export interface RangeComparison {
  status: ComparisonStatus;
  boundaryFactsStatus: BoundaryFactsStatus;
  invalidReason: string | null;
  primaryBoatId: string;
  range: AnalysisRange;
  reference: {
    kind: ComparisonReference["kind"];
    boatId: string | null;
    requestedCohortIds: string[];
    eligibleCohortIds: string[];
    ineligibleCohortIds: string[];
  };
  coverage: RangeCoverage;
  boats: BoatRangeFacts[];
  primary: BoatRangeFacts | null;
  referenceFacts: ReferenceRangeFacts | null;
  startAdvantageMeters: number | null;
  endAdvantageMeters: number | null;
  progressGainedMeters: number | null;
  sailedDistanceDeltaMeters: number | null;
  groundVmgDeltaMps: number | null;
  straightDeltaMeters: number | null;
  maneuverWindowDeltaMeters: number | null;
  residualMeters: number | null;
  componentCoverageMicros: number;
  componentExcludedMicros: number;
  waterDeltaMeters: number | null;
  currentDeltaMeters: number | null;
  groundGainMeters: number | null;
  referenceNonlinearityMeters: number | null;
  progressResidualMeters: number | null;
  componentResidualMeters: number | null;
  componentProvenance: {
    water: "reconstructed-water-from-fixes";
    current: "reconstructed-current-from-fixes";
    ground: "derived-water-plus-current";
  };
}

interface Timed {
  t: number;
}

interface Bracket<T extends Timed> {
  before: T;
  after: T;
  u: number;
}

export type ProgressBoundaryStatus =
  | "available"
  | "missing-bracket"
  | "invalid-sample"
  | "invalid-arithmetic";

export type RaceAnalysisValidityStatus =
  | "valid"
  | "invalid-race"
  | "missing-series"
  | "invalid-event"
  | "invalid-sample";

export interface RaceAnalysisBoatValidity {
  gunMicros: number;
  /** A missing finish is an open racing bound, represented only by null. */
  finishMicros: number | null;
}

export interface RaceAnalysisValidity {
  status: RaceAnalysisValidityStatus;
  reason: string | null;
  raceBounds: { from: number; to: number } | null;
  boats: Record<string, RaceAnalysisBoatValidity>;
}

interface IntegratedBoat {
  complete: boolean;
  failureStatus: "missing-bracket" | "invalid-sample" | "invalid-arithmetic" | null;
  sailedDistanceMeters: number | null;
  sogIntegral: number | null;
  vmgIntegral: number | null;
  vmgCoverageMicros: number;
  straightMadeGoodMeters: number | null;
  maneuverWindowMadeGoodMeters: number | null;
}

interface CanonicalTelemetryCell {
  fromMicros: number;
  toMicros: number;
  status: "ok" | "missing-bracket" | "invalid-sample" | "invalid-arithmetic";
  sailedDistanceMeters: number | null;
  sogFromMps: number | null;
  sogToMps: number | null;
  vmgFromMps: number | null;
  vmgToMps: number | null;
}

const EMPTY_POSE: Pose = createPose();

/**
 * Stage 5 time domain: finite seconds whose rounded microsecond value is a
 * safe integer. Validation happens here, before clamp, ordering, deduplication,
 * binary search, or bracket selection. Values outside this domain are invalid;
 * they are never clamped onto a real race time.
 */
function secondsToMicros(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const scaled = value * MICROS_PER_SECOND;
  if (!Number.isFinite(scaled)) return null;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded)) return null;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function microsToSeconds(value: number): number {
  return value / MICROS_PER_SECOND;
}

function rangeFromMicros(fromMicros: number, toMicros: number): AnalysisRange {
  return {
    from: microsToSeconds(fromMicros),
    to: microsToSeconds(toMicros),
    fromMicros,
    toMicros,
    durationMicros: toMicros - fromMicros,
  };
}

function raceBoundsMicros(race: RaceData): { from: number; to: number } | null {
  const from = secondsToMicros(race.tMin);
  const to = secondsToMicros(race.tMax);
  if (from === null || to === null || to <= from || !Number.isSafeInteger(to - from)) {
    return null;
  }
  return { from, to };
}

/* Validation and conversion are O(series) and the bracket search below runs
 * thousands of times per compareRange call, so the derived microsecond array
 * is computed once per series object and remembered. Race series are frozen
 * inputs: a different array is a different race, and the WeakMap lets a
 * replaced race's cache entries be collected with it. `null` records an
 * invalid series so failure is cached as cheaply as success. */
const SERIES_MICROS_CACHE = new WeakMap<readonly Timed[], readonly number[] | null>();

function seriesMicrosOf(series: readonly Timed[]): readonly number[] | null {
  const cached = SERIES_MICROS_CACHE.get(series);
  if (cached !== undefined) return cached;
  let times: number[] | null = [];
  let previous: number | null = null;
  for (const sample of series) {
    const at = secondsToMicros(sample.t);
    if (at === null || (previous !== null && at <= previous)) {
      times = null;
      break;
    }
    previous = at;
    times.push(at);
  }
  SERIES_MICROS_CACHE.set(series, times);
  return times;
}

function validSeriesTimes(series: readonly Timed[] | undefined): series is readonly Timed[] {
  if (series === undefined) return false;
  return seriesMicrosOf(series) !== null;
}

function seriesMicros(series: readonly Timed[] | undefined): readonly number[] | null {
  if (series === undefined) return null;
  return seriesMicrosOf(series);
}

const LEG_NAMES = new Set<LegName>(["prestart", "beat", "run", "finished"]);

function finiteCourseForAnalysis(race: RaceData): boolean {
  return [
    race.course?.startPin?.x,
    race.course?.startPin?.y,
    race.course?.startBoat?.x,
    race.course?.startBoat?.y,
    race.course?.windward?.x,
    race.course?.windward?.y,
  ].every((value) => Number.isFinite(value));
}

function validFixSeries(series: readonly Fix[]): boolean {
  return (
    validSeriesTimes(series) &&
    series.every((fix) => {
      if (![fix.x, fix.y, fix.waterX, fix.waterY, fix.currentX, fix.currentY, fix.twa].every(Number.isFinite)) {
        return false;
      }
      try {
        const velocity = velocityFromComponents(
          fix.waterX,
          fix.waterY,
          fix.currentX,
          fix.currentY,
          {},
        );
        return [
          velocity.stw,
          velocity.currentDrift,
          velocity.groundX,
          velocity.groundY,
          velocity.sog,
        ].every(Number.isFinite) &&
          (velocity.ctw === null || Number.isFinite(velocity.ctw)) &&
          (velocity.currentSet === null || Number.isFinite(velocity.currentSet)) &&
          (velocity.cog === null || Number.isFinite(velocity.cog));
      } catch {
        return false;
      }
    })
  );
}

function validProgressSeries(series: readonly ProgressSample[]): boolean {
  return (
    validSeriesTimes(series) &&
    series.every((sample) => Number.isFinite(sample.dtf) && LEG_NAMES.has(sample.leg))
  );
}

interface ValidatedEventBounds {
  gunMicros: number;
  finishMicrosByBoat: Map<string, number>;
}

type EventBoundsValidity =
  | { status: "valid"; bounds: ValidatedEventBounds }
  | { status: "invalid-event"; reason: string };

type BoatEventLifecycle = "not-rounded" | "rounded" | "finished";

function validateStoredEvents(
  race: RaceData,
  raceBounds: { from: number; to: number },
): EventBoundsValidity {
  if (!Array.isArray(race.events)) {
    return { status: "invalid-event", reason: "race events must be an array" };
  }
  const knownBoatIds = new Set(race.boats.map((boat) => boat.id));
  const finishMicrosByBoat = new Map<string, number>();
  const boatEvents: Array<{
    kind: "rounding" | "finish";
    boatId: string;
    at: number;
    rank: number | null;
  }> = [];
  let gunMicros: number | null = null;
  let gunCount = 0;
  let previousMicros: number | null = null;

  for (let index = 0; index < race.events.length; index++) {
    const event: unknown = race.events[index];
    if (typeof event !== "object" || event === null) {
      return { status: "invalid-event", reason: `race event ${index} must be an object` };
    }
    const candidate = event as {
      kind?: unknown;
      t?: unknown;
      boatId?: unknown;
      rank?: unknown;
    };
    if (typeof candidate.t !== "number") {
      return { status: "invalid-event", reason: `race event ${index} time must be numeric` };
    }
    const at = secondsToMicros(candidate.t);
    if (at === null) {
      return {
        status: "invalid-event",
        reason: `race event ${index} time must resolve to safe integer microseconds`,
      };
    }
    if (at < raceBounds.from || at > raceBounds.to) {
      return { status: "invalid-event", reason: `race event ${index} is outside race bounds` };
    }
    if (previousMicros !== null && at <= previousMicros) {
      return {
        status: "invalid-event",
        reason: "race events must be stored in strict integer-microsecond order",
      };
    }
    previousMicros = at;

    if (candidate.kind === "gun") {
      if (candidate.boatId !== undefined || candidate.rank !== undefined) {
        return { status: "invalid-event", reason: "gun events cannot bind a boat or rank" };
      }
      gunCount++;
      gunMicros = at;
      continue;
    }
    if (candidate.kind !== "rounding" && candidate.kind !== "finish") {
      return { status: "invalid-event", reason: `race event ${index} has an unknown kind` };
    }
    if (
      typeof candidate.boatId !== "string" ||
      candidate.boatId.length === 0 ||
      !knownBoatIds.has(candidate.boatId)
    ) {
      return {
        status: "invalid-event",
        reason: `${candidate.kind} event ${index} must bind a registered boat`,
      };
    }
    if (candidate.kind === "rounding") {
      if (candidate.rank !== undefined) {
        return { status: "invalid-event", reason: "rounding events cannot carry a rank" };
      }
      boatEvents.push({ kind: candidate.kind, boatId: candidate.boatId, at, rank: null });
      continue;
    }
    if (
      typeof candidate.rank !== "number" ||
      !Number.isSafeInteger(candidate.rank) ||
      candidate.rank < 1 ||
      candidate.rank > race.boats.length
    ) {
      return {
        status: "invalid-event",
        reason: "finish events require a recognized fleet rank",
      };
    }
    boatEvents.push({ kind: candidate.kind, boatId: candidate.boatId, at, rank: candidate.rank });
  }

  if (gunCount !== 1 || gunMicros === null) {
    return { status: "invalid-event", reason: "exactly one gun event is required" };
  }
  const lifecycleByBoat = new Map<string, BoatEventLifecycle>(
    race.boats.map((boat): [string, BoatEventLifecycle] => [boat.id, "not-rounded"]),
  );
  let nextFinishRank = 1;
  for (const event of boatEvents) {
    if (event.at <= gunMicros) {
      return { status: "invalid-event", reason: "boat events must occur strictly after the gun" };
    }
    const lifecycle = lifecycleByBoat.get(event.boatId);
    if (lifecycle === undefined) {
      return { status: "invalid-event", reason: `boat ${event.boatId} is not registered` };
    }
    if (lifecycle === "finished") {
      return {
        status: "invalid-event",
        reason: `boat ${event.boatId} cannot have events after its finish`,
      };
    }
    if (event.kind === "rounding") {
      if (lifecycle !== "not-rounded") {
        return {
          status: "invalid-event",
          reason: `boat ${event.boatId} cannot round more than once`,
        };
      }
      lifecycleByBoat.set(event.boatId, "rounded");
      continue;
    }
    if (lifecycle !== "rounded") {
      return {
        status: "invalid-event",
        reason: `boat ${event.boatId} must round before finishing`,
      };
    }
    if (event.rank !== nextFinishRank) {
      return {
        status: "invalid-event",
        reason: "finish ranks must increase without gaps in stored event order",
      };
    }
    lifecycleByBoat.set(event.boatId, "finished");
    finishMicrosByBoat.set(event.boatId, event.at);
    nextFinishRank++;
  }
  return { status: "valid", bounds: { gunMicros, finishMicrosByBoat } };
}

function eventBoundsForBoat(
  race: RaceData,
  boatId: string,
):
  | { status: "valid"; gunMicros: number; finishMicros: number | null }
  | { status: "invalid-event"; reason: string } {
  const raceBounds = raceBoundsMicros(race);
  if (raceBounds === null) {
    return { status: "invalid-event", reason: "race bounds are invalid" };
  }
  const events = validateStoredEvents(race, raceBounds);
  if (events.status !== "valid") return events;
  return {
    status: "valid",
    gunMicros: events.bounds.gunMicros,
    finishMicros: events.bounds.finishMicrosByBoat.get(boatId) ?? null,
  };
}

/**
 * Full Stage 5 fact preflight. Every required feed is classified before range
 * normalization, interpolation, maneuver detection, or numeric fact creation.
 */
export function raceAnalysisValidity(
  race: RaceData,
  requiredBoatIds: readonly string[],
): RaceAnalysisValidity {
  const raceBounds = raceBoundsMicros(race);
  const boats: Record<string, RaceAnalysisBoatValidity> = {};
  if (raceBounds === null) {
    return {
      status: "invalid-race",
      reason: "race bounds must have a positive safe integer-microsecond span",
      raceBounds: null,
      boats,
    };
  }
  const events = validateStoredEvents(race, raceBounds);
  if (events.status !== "valid") {
    return {
      status: events.status,
      reason: events.reason,
      raceBounds,
      boats,
    };
  }
  if (!finiteCourseForAnalysis(race)) {
    return {
      status: "invalid-sample",
      reason: "analysis course coordinates must be finite",
      raceBounds,
      boats,
    };
  }
  const currentValidity = currentFieldSpecValidity(
    race.environment?.current,
    race.seed,
    race.course,
  );
  if (currentValidity.status !== "valid") {
    return {
      status: "invalid-sample",
      reason: `analysis requires a valid serialized current field: ${currentValidity.reason}`,
      raceBounds,
      boats,
    };
  }
  for (const boatId of [...new Set(requiredBoatIds)]) {
    const fixes = race.fixes?.[boatId];
    const progress = race.progress?.[boatId];
    if (!Array.isArray(fixes) || fixes.length === 0 || !Array.isArray(progress) || progress.length === 0) {
      return {
        status: "missing-series",
        reason: `boat ${boatId} requires non-empty fix and progress series`,
        raceBounds,
        boats,
      };
    }
    if (!validFixSeries(fixes) || !validProgressSeries(progress)) {
      return {
        status: "invalid-sample",
        reason: `boat ${boatId} has invalid analysis samples`,
        raceBounds,
        boats,
      };
    }
    boats[boatId] = {
      gunMicros: events.bounds.gunMicros,
      finishMicros: events.bounds.finishMicrosByBoat.get(boatId) ?? null,
    };
  }
  return { status: "valid", reason: null, raceBounds, boats };
}

export function normalizeAnalysisRange(race: RaceData, from: number, to: number): AnalysisRange {
  const bounds = raceBoundsMicros(race);
  const rawFrom = secondsToMicros(from);
  const rawTo = secondsToMicros(to);
  if (bounds === null || rawFrom === null || rawTo === null) {
    throw new RangeError("race and analysis range times must resolve to safe integer microseconds");
  }
  const low = Math.min(rawFrom, rawTo);
  const high = Math.max(rawFrom, rawTo);
  const fromMicros = Math.min(bounds.to, Math.max(bounds.from, low));
  const toMicros = Math.min(bounds.to, Math.max(bounds.from, high));
  return rangeFromMicros(fromMicros, toMicros);
}

function bracketAtValid<T extends Timed>(series: readonly T[], atMicros: number): Bracket<T> | null {
  if (series.length === 0 || !Number.isSafeInteger(atMicros)) return null;
  /* The cached microsecond array: one conversion per series, not one per
   * binary-search probe. A series that fails conversion has no brackets. */
  const times = seriesMicrosOf(series);
  if (times === null) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const sampleMicros = times[mid];
    if (sampleMicros < atMicros) lo = mid + 1;
    else if (sampleMicros > atMicros) hi = mid - 1;
    else return { before: series[mid], after: series[mid], u: 0 };
  }
  if (hi < 0 || lo >= series.length) return null;
  const before = series[hi];
  const after = series[lo];
  const beforeMicros = times[hi];
  const afterMicros = times[lo];
  if (!(afterMicros > beforeMicros)) return null;
  return { before, after, u: (atMicros - beforeMicros) / (afterMicros - beforeMicros) };
}

function bracketAt<T extends Timed>(series: readonly T[] | undefined, atMicros: number): Bracket<T> | null {
  if (!validSeriesTimes(series)) return null;
  return bracketAtValid(series, atMicros);
}

function dtfFromBracket(bracket: Bracket<ProgressSample>): FiniteResult {
  const span = subtractFinite(bracket.after.dtf, bracket.before.dtf);
  if (span.status !== "ok") return span;
  const offset = multiplyFinite(span.value, bracket.u);
  if (offset.status !== "ok") return offset;
  return addFinite(bracket.before.dtf, offset.value);
}

export function progressBoundaryStatusAt(
  race: RaceData,
  boatId: string,
  t: number,
): ProgressBoundaryStatus {
  const validity = raceAnalysisValidity(race, [boatId]);
  if (validity.status === "missing-series") return "missing-bracket";
  if (validity.status !== "valid") return "invalid-sample";
  const atMicros = secondsToMicros(t);
  if (atMicros === null) return "invalid-sample";
  const fixes = race.fixes[boatId];
  const progress = race.progress[boatId];
  if (progress === undefined || progress.length === 0) {
    return "missing-bracket";
  }
  if (
    (fixes !== undefined && fixes.length > 0 && !validSeriesTimes(fixes)) ||
    !validSeriesTimes(progress)
  ) {
    return "invalid-sample";
  }
  if (progress.some((sample) => !Number.isFinite(sample.dtf))) return "invalid-sample";
  const bracket = bracketAtValid(progress, atMicros);
  if (bracket === null) return "missing-bracket";
  return dtfFromBracket(bracket).status === "ok" ? "available" : "invalid-arithmetic";
}

export function dtfAt(race: RaceData, boatId: string, t: number): number | null {
  if (progressBoundaryStatusAt(race, boatId, t) !== "available") return null;
  const atMicros = secondsToMicros(t);
  if (atMicros === null) return null;
  const bracket = bracketAt(race.progress[boatId], atMicros);
  if (bracket === null) return null;
  return dtfFromBracket(bracket).value;
}

function poseAtMicros(race: RaceData, boatId: string, atMicros: number): Pose | null {
  if (bracketAt(race.fixes[boatId], atMicros) === null) return null;
  const out = { ...EMPTY_POSE };
  try {
    poseAt(race, boatId, microsToSeconds(atMicros), "smooth", out);
    return out;
  } catch {
    return null;
  }
}

function finitePose(pose: Pose | null): pose is Pose {
  return (
    pose !== null &&
    [
      pose.x, pose.y, pose.waterX, pose.waterY, pose.currentX, pose.currentY,
      pose.stw, pose.currentDrift, pose.groundX, pose.groundY, pose.sog,
    ].every(Number.isFinite) &&
    (pose.ctw === null || Number.isFinite(pose.ctw)) &&
    (pose.currentSet === null || Number.isFinite(pose.currentSet)) &&
    (pose.cog === null || Number.isFinite(pose.cog))
  );
}

function sortedUniqueAllMicros(values: number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

function seriesTimes(series: readonly Timed[] | undefined, out: number[]): void {
  const times = seriesMicros(series);
  if (times !== null) out.push(...times);
}

type RacingBounds =
  | { status: "ok"; gun: number; finish: number | null }
  | { status: "invalid-sample"; gun: null; finish: null };

function racingBounds(race: RaceData, boatId: string): RacingBounds {
  const bounds = eventBoundsForBoat(race, boatId);
  if (bounds.status !== "valid") {
    return { status: "invalid-sample", gun: null, finish: null };
  }
  return {
    status: "ok",
    gun: bounds.gunMicros,
    finish: bounds.finishMicros,
  };
}

function markForLeg(race: RaceData, leg: LegName): { x: number; y: number } | null {
  if (leg === "beat") return race.course.windward;
  if (leg === "run") {
    return {
      x: (race.course.startPin.x + race.course.startBoat.x) / 2,
      y: (race.course.startPin.y + race.course.startBoat.y) / 2,
    };
  }
  return null;
}

type TelemetryValidity =
  | "ok"
  | "missing-bracket"
  | "invalid-sample"
  | "invalid-arithmetic";

function classifyFixProgressLeg(
  race: RaceData,
  boatId: string,
  sampleMicros: readonly number[],
  intervalLeg: LegName,
): TelemetryValidity {
  const fixes = race.fixes[boatId];
  const progress = race.progress[boatId];
  if (fixes === undefined || fixes.length === 0 || progress === undefined || progress.length === 0) {
    return "missing-bracket";
  }
  if (!validSeriesTimes(fixes) || !validSeriesTimes(progress)) {
    return "invalid-sample";
  }
  const samples = sampleMicros.map((atMicros) => ({
    atMicros,
    fix: bracketAtValid(fixes, atMicros),
    progress: bracketAtValid(progress, atMicros),
  }));
  if (samples.some((sample) => sample.fix === null || sample.progress === null)) {
    return "missing-bracket";
  }
  const mark = markForLeg(race, intervalLeg);
  if (mark === null) return "invalid-sample";
  for (const sample of samples) {
    const fixBracket = sample.fix as Bracket<Fix>;
    const progressBracket = sample.progress as Bracket<ProgressSample>;
    if (
      [fixBracket.before, fixBracket.after].some(
        (fix) =>
          !Number.isFinite(fix.x) ||
          !Number.isFinite(fix.y) ||
          !Number.isFinite(fix.waterX) ||
          !Number.isFinite(fix.waterY) ||
          !Number.isFinite(fix.currentX) ||
          !Number.isFinite(fix.currentY),
      ) ||
      !Number.isFinite(progressBracket.before.dtf) ||
      !Number.isFinite(progressBracket.after.dtf) ||
      !Number.isFinite(mark.x) ||
      !Number.isFinite(mark.y)
    ) {
      return "invalid-sample";
    }
    const pose = poseAtMicros(race, boatId, sample.atMicros);
    const dtf = dtfFromBracket(progressBracket);
    if (dtf.status !== "ok" || !finitePose(pose)) return "invalid-arithmetic";
    const dx = subtractFinite(mark.x, pose.x);
    const dy = subtractFinite(mark.y, pose.y);
    if (dx.status !== "ok" || dy.status !== "ok") return "invalid-arithmetic";
    const markDistance = finiteResult(Math.hypot(dx.value, dy.value));
    if (markDistance.status !== "ok") return "invalid-arithmetic";
    if (markDistance.value <= 0) return "invalid-sample";
    if (groundMadeGoodToMark(pose, intervalLeg) === null) {
      return "invalid-arithmetic";
    }
  }
  return "ok";
}

function classifyAtomic(
  race: RaceData,
  boatIds: readonly string[],
  fromMicros: number,
  toMicros: number,
): CoverageReason {
  const midpoint = fromMicros + Math.floor((toMicros - fromMicros) / 2);
  for (const boatId of boatIds) {
    const bounds = racingBounds(race, boatId);
    if (bounds.status !== "ok") return "invalid-sample";
    if (midpoint < bounds.gun || (bounds.finish !== null && midpoint >= bounds.finish)) {
      return "prestart-or-finished";
    }
  }
  const samples = [fromMicros, midpoint, toMicros];
  const validity: TelemetryValidity[] = [];
  for (const boatId of boatIds) {
    const intervalLeg = legAt(race, boatId, microsToSeconds(midpoint));
    validity.push(classifyFixProgressLeg(race, boatId, samples, intervalLeg));
  }
  if (validity.includes("missing-bracket")) return "missing-bracket";
  if (validity.includes("invalid-sample")) return "invalid-sample";
  if (validity.includes("invalid-arithmetic")) return "invalid-arithmetic";
  return "included";
}

function coverageFor(race: RaceData, boatIds: readonly string[], range: AnalysisRange): RangeCoverage {
  if (range.durationMicros === 0) return emptyCoverage(range);
  /* Source and race times define the classifier cells. A request boundary may
   * clip a cell, but it cannot move the representative point or change that
   * cell's reason. Splitting one request therefore preserves integer closure. */
  const raceBounds = raceBoundsMicros(race);
  if (raceBounds === null) return emptyCoverage(range);
  const partition = [raceBounds.from, raceBounds.to];
  for (const boatId of boatIds) {
    seriesTimes(race.fixes[boatId], partition);
    seriesTimes(race.progress[boatId], partition);
    const bounds = racingBounds(race, boatId);
    if (bounds.status === "ok") {
      partition.push(bounds.gun);
      if (bounds.finish !== null) partition.push(bounds.finish);
    }
  }
  const times = sortedUniqueAllMicros(partition);
  const atomic: CoverageBin[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const canonicalFrom = times[i];
    const canonicalTo = times[i + 1];
    if (canonicalTo <= range.fromMicros || canonicalFrom >= range.toMicros) continue;
    const fromMicros = Math.max(range.fromMicros, canonicalFrom);
    const toMicros = Math.min(range.toMicros, canonicalTo);
    if (toMicros > fromMicros) {
      atomic.push({
        fromMicros,
        toMicros,
        reason: classifyAtomic(race, boatIds, canonicalFrom, canonicalTo),
      });
    }
  }
  let coverageMicros = 0;
  let prestartOrFinished = 0;
  let missingBracket = 0;
  let invalidSample = 0;
  let invalidArithmetic = 0;
  for (const bin of atomic) {
    const width = bin.toMicros - bin.fromMicros;
    if (bin.reason === "included") coverageMicros += width;
    else if (bin.reason === "prestart-or-finished") prestartOrFinished += width;
    else if (bin.reason === "missing-bracket") missingBracket += width;
    else if (bin.reason === "invalid-sample") invalidSample += width;
    else invalidArithmetic += width;
  }
  return {
    durationMicros: range.durationMicros,
    coverageMicros,
    coverageSeconds: microsToSeconds(coverageMicros),
    excludedByReasonMicros: {
      prestartOrFinished,
      missingBracket,
      invalidSample,
      invalidArithmetic,
    },
    excludedByReasonSeconds: {
      prestartOrFinished: microsToSeconds(prestartOrFinished),
      missingBracket: microsToSeconds(missingBracket),
      invalidSample: microsToSeconds(invalidSample),
      invalidArithmetic: microsToSeconds(invalidArithmetic),
    },
    bins: atomic,
  };
}

interface ComponentMadeGood {
  status: "ok" | "no-valid-coverage" | "invalid-arithmetic";
  waterMeters: number | null;
  currentMeters: number | null;
  groundMeters: number | null;
}

interface CanonicalComponentCell {
  fromMicros: number;
  toMicros: number;
  waterFromMps: number;
  waterToMps: number;
  currentFromMps: number;
  currentToMps: number;
  groundFromMps: number;
  groundToMps: number;
}

function projectedComponents(
  pose: Pick<Pose, "x" | "y" | "waterX" | "waterY" | "currentX" | "currentY">,
  mark: { x: number; y: number },
): { water: number; current: number; ground: number } | null {
  const dx = mark.x - pose.x;
  const dy = mark.y - pose.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance <= 0) return null;
  const bearing = Math.atan2(dx, dy) / (Math.PI / 180);
  return projectVelocityComponentsOntoBearing(
    pose.waterX,
    pose.waterY,
    pose.currentX,
    pose.currentY,
    bearing,
  );
}

function canonicalComponentCells(
  race: RaceData,
  boatId: string,
): CanonicalComponentCell[] | null {
  const fixes = race.fixes[boatId];
  if (!Array.isArray(fixes) || fixes.length < 2) return null;
  const cells: CanonicalComponentCell[] = [];
  for (let index = 0; index + 1 < fixes.length; index++) {
    const from = fixes[index];
    const to = fixes[index + 1];
    const fromMicros = secondsToMicros(from.t);
    const toMicros = secondsToMicros(to.t);
    if (fromMicros === null || toMicros === null || toMicros <= fromMicros) return null;
    const midpoint = fromMicros + Math.floor((toMicros - fromMicros) / 2);
    const leg = legAt(race, boatId, microsToSeconds(midpoint));
    const mark = markForLeg(race, leg);
    if (mark === null) continue;
    const fromProjection = projectedComponents(from, mark);
    const toProjection = projectedComponents(to, mark);
    if (fromProjection === null || toProjection === null) return null;
    cells.push({
      fromMicros,
      toMicros,
      waterFromMps: fromProjection.water,
      waterToMps: toProjection.water,
      currentFromMps: fromProjection.current,
      currentToMps: toProjection.current,
      groundFromMps: fromProjection.ground,
      groundToMps: toProjection.ground,
    });
  }
  return cells;
}

function integrateComponentMadeGood(
  race: RaceData,
  boatId: string,
  intervals: readonly CoverageBin[],
): ComponentMadeGood {
  if (intervals.length === 0) {
    return { status: "no-valid-coverage", waterMeters: null, currentMeters: null, groundMeters: null };
  }
  let waterMeters = 0;
  let currentMeters = 0;
  let groundMeters = 0;
  const cells = canonicalComponentCells(race, boatId);
  if (cells === null) {
    return { status: "invalid-arithmetic", waterMeters: null, currentMeters: null, groundMeters: null };
  }
  let cellIndex = 0;
  for (const interval of intervals) {
    while (cellIndex < cells.length && cells[cellIndex].toMicros <= interval.fromMicros) {
      cellIndex++;
    }
    let visitedMicros = 0;
    for (let index = cellIndex; index < cells.length; index++) {
      const cell = cells[index];
      if (cell.fromMicros >= interval.toMicros) break;
      const fromMicros = Math.max(interval.fromMicros, cell.fromMicros);
      const toMicros = Math.min(interval.toMicros, cell.toMicros);
      if (toMicros <= fromMicros) continue;
      visitedMicros += toMicros - fromMicros;
      const water = integrateLinearCell(
        cell.waterFromMps,
        cell.waterToMps,
        cell,
        fromMicros,
        toMicros,
      );
      const current = integrateLinearCell(
        cell.currentFromMps,
        cell.currentToMps,
        cell,
        fromMicros,
        toMicros,
      );
      const ground = integrateLinearCell(
        cell.groundFromMps,
        cell.groundToMps,
        cell,
        fromMicros,
        toMicros,
      );
      if (water === null || current === null || ground === null) {
        return { status: "invalid-arithmetic", waterMeters: null, currentMeters: null, groundMeters: null };
      }
      const waterTotal = addFinite(waterMeters, water);
      const currentTotal = addFinite(currentMeters, current);
      const groundTotal = addFinite(groundMeters, ground);
      if (waterTotal.status !== "ok" || currentTotal.status !== "ok" || groundTotal.status !== "ok") {
        return { status: "invalid-arithmetic", waterMeters: null, currentMeters: null, groundMeters: null };
      }
      waterMeters = waterTotal.value;
      currentMeters = currentTotal.value;
      groundMeters = groundTotal.value;
    }
    if (visitedMicros !== interval.toMicros - interval.fromMicros) {
      return { status: "invalid-arithmetic", waterMeters: null, currentMeters: null, groundMeters: null };
    }
  }
  if (Math.abs(groundMeters - waterMeters - currentMeters) > 1e-9) {
    return { status: "invalid-arithmetic", waterMeters: null, currentMeters: null, groundMeters: null };
  }
  return { status: "ok", waterMeters, currentMeters, groundMeters };
}

function maneuverRanges(race: RaceData, boatId: string, range: AnalysisRange): AnalysisRange[] {
  if (seriesMicros(race.fixes[boatId]) === null) return [];
  const raw = maneuversOf(race, boatId)
    .map((maneuver) => {
      const from = secondsToMicros(maneuver.t - 4);
      const to = secondsToMicros(maneuver.t + 4);
      return from === null || to === null
        ? null
        : {
            from: Math.max(range.fromMicros, from),
            to: Math.min(range.toMicros, to),
          };
    })
    .filter((window): window is { from: number; to: number } => window !== null)
    .filter((window) => window.to > window.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const window of raw) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && window.from <= previous.to) previous.to = Math.max(previous.to, window.to);
    else merged.push({ ...window });
  }
  return merged.map((window) => rangeFromMicros(window.from, window.to));
}

function canonicalTelemetryCells(race: RaceData, boatId: string): CanonicalTelemetryCell[] {
  /* This source-time partition owns every ground integral. Request edges and
   * detected maneuver windows are masks over its measure, never new samples. */
  const raceBounds = raceBoundsMicros(race);
  if (raceBounds === null) return [];
  const values = [raceBounds.from, raceBounds.to];
  seriesTimes(race.fixes[boatId], values);
  seriesTimes(race.progress[boatId], values);
  const bounds = racingBounds(race, boatId);
  if (bounds.status === "ok") {
    values.push(bounds.gun);
    if (bounds.finish !== null) values.push(bounds.finish);
  }
  const times = sortedUniqueAllMicros(values);
  const cells: CanonicalTelemetryCell[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const fromMicros = times[i];
    const toMicros = times[i + 1];
    if (toMicros <= fromMicros) continue;
    const midpoint = fromMicros + Math.floor((toMicros - fromMicros) / 2);
    const leg = legAt(race, boatId, microsToSeconds(midpoint));
    const status = classifyFixProgressLeg(
      race,
      boatId,
      [fromMicros, midpoint, toMicros],
      leg,
    );
    if (status !== "ok") {
      cells.push({
        fromMicros,
        toMicros,
        status,
        sailedDistanceMeters: null,
        sogFromMps: null,
        sogToMps: null,
        vmgFromMps: null,
        vmgToMps: null,
      });
      continue;
    }
    const from = poseAtMicros(race, boatId, fromMicros) as Pose;
    const to = poseAtMicros(race, boatId, toMicros) as Pose;
    const hasVmg = leg === "beat" || leg === "run";
    const vmgFromMps = hasVmg ? groundMadeGoodToMark(from, leg) : null;
    const vmgToMps = hasVmg ? groundMadeGoodToMark(to, leg) : null;
    const dx = subtractFinite(to.x, from.x);
    const dy = subtractFinite(to.y, from.y);
    const sailedDistanceMeters =
      dx.status === "ok" && dy.status === "ok"
        ? finiteResult(Math.hypot(dx.value, dy.value))
        : INVALID_ARITHMETIC;
    if (
      sailedDistanceMeters.status !== "ok" ||
      !Number.isFinite(from.sog) ||
      !Number.isFinite(to.sog) ||
      (vmgFromMps !== null && !Number.isFinite(vmgFromMps)) ||
      (vmgToMps !== null && !Number.isFinite(vmgToMps))
    ) {
      cells.push({
        fromMicros,
        toMicros,
        status: "invalid-arithmetic",
        sailedDistanceMeters: null,
        sogFromMps: null,
        sogToMps: null,
        vmgFromMps: null,
        vmgToMps: null,
      });
      continue;
    }
    cells.push({
      fromMicros,
      toMicros,
      status: "ok",
      sailedDistanceMeters: sailedDistanceMeters.value,
      sogFromMps: from.sog,
      sogToMps: to.sog,
      vmgFromMps,
      vmgToMps,
    });
  }
  return cells;
}

function integrateLinearCell(
  fromValue: number,
  toValue: number,
  cell: Pick<CanonicalTelemetryCell, "fromMicros" | "toMicros">,
  fromMicros: number,
  toMicros: number,
): number | null {
  const width = cell.toMicros - cell.fromMicros;
  const fromU = divideFinite(fromMicros - cell.fromMicros, width);
  const toU = divideFinite(toMicros - cell.fromMicros, width);
  if (fromU.status !== "ok" || toU.status !== "ok") return null;
  const uSpan = subtractFinite(toU.value, fromU.value);
  const linear = uSpan.status === "ok" ? multiplyFinite(fromValue, uSpan.value) : INVALID_ARITHMETIC;
  const valueSpan = subtractFinite(toValue, fromValue);
  const toSquare = multiplyFinite(toU.value, toU.value);
  const fromSquare = multiplyFinite(fromU.value, fromU.value);
  const squareSpan =
    toSquare.status === "ok" && fromSquare.status === "ok"
      ? subtractFinite(toSquare.value, fromSquare.value)
      : INVALID_ARITHMETIC;
  const curvedProduct =
    valueSpan.status === "ok" && squareSpan.status === "ok"
      ? multiplyFinite(valueSpan.value, squareSpan.value)
      : INVALID_ARITHMETIC;
  const curved =
    curvedProduct.status === "ok" ? divideFinite(curvedProduct.value, 2) : INVALID_ARITHMETIC;
  const sum =
    linear.status === "ok" && curved.status === "ok"
      ? addFinite(linear.value, curved.value)
      : INVALID_ARITHMETIC;
  const seconds = finiteResult(microsToSeconds(width));
  return sum.status === "ok" && seconds.status === "ok"
    ? multiplyFinite(seconds.value, sum.value).value
    : null;
}

function integrateCanonicalIntervals(
  race: RaceData,
  boatId: string,
  intervals: readonly { fromMicros: number; toMicros: number }[],
  windows: readonly AnalysisRange[],
  requireVmg: boolean,
): IntegratedBoat {
  const out: IntegratedBoat = {
    complete: true,
    failureStatus: null,
    sailedDistanceMeters: 0,
    sogIntegral: 0,
    vmgIntegral: 0,
    vmgCoverageMicros: 0,
    straightMadeGoodMeters: 0,
    maneuverWindowMadeGoodMeters: 0,
  };
  const invalidateArithmetic = (): IntegratedBoat => {
    out.complete = false;
    out.failureStatus = "invalid-arithmetic";
    out.sailedDistanceMeters = null;
    out.sogIntegral = null;
    out.vmgIntegral = null;
    out.vmgCoverageMicros = 0;
    out.straightMadeGoodMeters = null;
    out.maneuverWindowMadeGoodMeters = null;
    return out;
  };
  const cells = canonicalTelemetryCells(race, boatId);
  let cellIndex = 0;
  for (const interval of intervals) {
    while (cellIndex < cells.length && cells[cellIndex].toMicros <= interval.fromMicros) cellIndex++;
    let visitedMicros = 0;
    for (let i = cellIndex; i < cells.length; i++) {
      const cell = cells[i];
      if (cell.fromMicros >= interval.toMicros) break;
      const fromMicros = Math.max(interval.fromMicros, cell.fromMicros);
      const toMicros = Math.min(interval.toMicros, cell.toMicros);
      if (toMicros <= fromMicros) continue;
      visitedMicros += toMicros - fromMicros;
      if (
        cell.status !== "ok" ||
        cell.sailedDistanceMeters === null ||
        cell.sogFromMps === null ||
        cell.sogToMps === null
      ) {
        out.complete = false;
        if (cell.status === "missing-bracket") out.failureStatus = "missing-bracket";
        else if (cell.status === "invalid-arithmetic") return invalidateArithmetic();
        else if (out.failureStatus === null) out.failureStatus = "invalid-sample";
        continue;
      }
      /* The measured chord is the cell's distance measure. Exact partial
       * boundaries receive their elapsed-time fraction of that fixed measure. */
      const cellFraction = divideFinite(
        toMicros - fromMicros,
        cell.toMicros - cell.fromMicros,
      );
      const distanceContribution =
        cellFraction.status === "ok"
          ? multiplyFinite(cell.sailedDistanceMeters, cellFraction.value)
          : INVALID_ARITHMETIC;
      const distanceTotal =
        distanceContribution.status === "ok" && out.sailedDistanceMeters !== null
          ? addFinite(out.sailedDistanceMeters, distanceContribution.value)
          : INVALID_ARITHMETIC;
      if (distanceTotal.status !== "ok") return invalidateArithmetic();
      out.sailedDistanceMeters = distanceTotal.value;
      const sogContribution = integrateLinearCell(
        cell.sogFromMps,
        cell.sogToMps,
        cell,
        fromMicros,
        toMicros,
      );
      if (sogContribution === null || out.sogIntegral === null) return invalidateArithmetic();
      const sogTotal = addFinite(out.sogIntegral, sogContribution);
      if (sogTotal.status !== "ok") return invalidateArithmetic();
      out.sogIntegral = sogTotal.value;
      if (cell.vmgFromMps === null || cell.vmgToMps === null) {
        if (requireVmg) {
          out.complete = false;
          if (out.failureStatus === null) out.failureStatus = "invalid-sample";
        }
        continue;
      }
      const madeGood = integrateLinearCell(
        cell.vmgFromMps,
        cell.vmgToMps,
        cell,
        fromMicros,
        toMicros,
      );
      if (madeGood === null || out.vmgIntegral === null) return invalidateArithmetic();
      const vmgTotal = addFinite(out.vmgIntegral, madeGood);
      if (vmgTotal.status !== "ok") return invalidateArithmetic();
      out.vmgIntegral = vmgTotal.value;
      out.vmgCoverageMicros += toMicros - fromMicros;
      /* Maneuver classification integrates the same linear cell primitive.
       * It cannot change total VMG or add a quadrature point. */
      for (const window of windows) {
        const overlapFrom = Math.max(fromMicros, window.fromMicros);
        const overlapTo = Math.min(toMicros, window.toMicros);
        if (overlapTo <= overlapFrom) continue;
        const maneuverContribution = integrateLinearCell(
          cell.vmgFromMps,
          cell.vmgToMps,
          cell,
          overlapFrom,
          overlapTo,
        );
        if (maneuverContribution === null || out.maneuverWindowMadeGoodMeters === null) {
          return invalidateArithmetic();
        }
        const maneuverTotal = addFinite(
          out.maneuverWindowMadeGoodMeters,
          maneuverContribution,
        );
        if (maneuverTotal.status !== "ok") return invalidateArithmetic();
        out.maneuverWindowMadeGoodMeters = maneuverTotal.value;
      }
    }
    if (visitedMicros !== interval.toMicros - interval.fromMicros) {
      out.complete = false;
      out.failureStatus = "missing-bracket";
    }
  }
  if (out.vmgIntegral === null || out.maneuverWindowMadeGoodMeters === null) {
    return invalidateArithmetic();
  }
  const straight = subtractFinite(out.vmgIntegral, out.maneuverWindowMadeGoodMeters);
  if (straight.status !== "ok") return invalidateArithmetic();
  out.straightMadeGoodMeters = straight.value;
  return out;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (Math.sign(lower) === Math.sign(upper)) {
    const span = subtractFinite(upper, lower);
    if (span.status !== "ok") return null;
    const halfSpan = divideFinite(span.value, 2);
    if (halfSpan.status !== "ok") return null;
    return addFinite(lower, halfSpan.value).value;
  }
  const sum = addFinite(lower, upper);
  return sum.status === "ok" ? divideFinite(sum.value, 2).value : null;
}

function finiteDifference(minuend: number, subtrahend: number): number | null {
  return subtractFinite(minuend, subtrahend).value;
}

function boatOrder(race: RaceData, ids: readonly string[]): string[] {
  const order = new Map(race.boats.map((boat, index) => [boat.id, index]));
  return [...new Set(ids)].sort((a, b) => {
    const ai = order.get(a);
    const bi = order.get(b);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.localeCompare(b);
  });
}

type ComponentEligibility = "eligible" | "missing-bracket" | "invalid-sample";

function componentEligibilityForRange(
  race: RaceData,
  boatId: string,
  range: AnalysisRange,
): ComponentEligibility {
  if (!race.boats.some((boat) => boat.id === boatId)) return "missing-bracket";
  const fixes = race.fixes[boatId];
  const progress = race.progress[boatId];
  if (!Array.isArray(fixes) || fixes.length === 0 || !Array.isArray(progress) || progress.length === 0) {
    return "missing-bracket";
  }
  if (!validSeriesTimes(fixes)) return "invalid-sample";
  const from = bracketAtValid(fixes, range.fromMicros);
  const to = bracketAtValid(fixes, range.toMicros);
  if (from === null || to === null) return "missing-bracket";
  const requiredFrom = secondsToMicros(from.before.t);
  const requiredTo = secondsToMicros(to.after.t);
  if (requiredFrom === null || requiredTo === null) return "invalid-sample";
  const componentsValid = fixes.every((fix) => {
    const at = secondsToMicros(fix.t);
    if (at === null) return false;
    if (at < requiredFrom || at > requiredTo) return true;
    return [fix.waterX, fix.waterY, fix.currentX, fix.currentY].every(Number.isFinite);
  });
  return componentsValid ? "eligible" : "invalid-sample";
}

function emptyCoverage(
  range: AnalysisRange,
  reason: "missing-bracket" | "invalid-sample" = "invalid-sample",
): RangeCoverage {
  const missingBracket = reason === "missing-bracket" ? range.durationMicros : 0;
  const invalidSample = reason === "invalid-sample" ? range.durationMicros : 0;
  return {
    durationMicros: range.durationMicros,
    coverageMicros: 0,
    coverageSeconds: 0,
    excludedByReasonMicros: {
      prestartOrFinished: 0,
      missingBracket,
      invalidSample,
      invalidArithmetic: 0,
    },
    excludedByReasonSeconds: {
      prestartOrFinished: 0,
      missingBracket: microsToSeconds(missingBracket),
      invalidSample: microsToSeconds(invalidSample),
      invalidArithmetic: 0,
    },
    bins:
      range.durationMicros > 0
        ? [{ fromMicros: range.fromMicros, toMicros: range.toMicros, reason }]
        : [],
  };
}

function invalidComparison(
  race: RaceData,
  request: ComparisonRequest,
  reason: string,
  range?: AnalysisRange,
  status: ComparisonStatus = "invalid-request",
  boundaryFactsStatus: BoundaryFactsStatus = "unavailable",
  referenceState?: RangeComparison["reference"],
): RangeComparison {
  const fallbackMicros = raceBoundsMicros(race)?.from ?? 0;
  const safeRange = range ?? rangeFromMicros(fallbackMicros, fallbackMicros);
  return {
    status,
    boundaryFactsStatus,
    invalidReason: reason,
    primaryBoatId: request.primaryBoatId,
    range: safeRange,
    reference: referenceState ?? {
      kind: request.reference.kind,
      boatId: request.reference.kind === "boat" ? request.reference.boatId : null,
      requestedCohortIds: request.reference.kind === "fleet-median" ? boatOrder(race, request.reference.boatIds) : [],
      eligibleCohortIds: [],
      ineligibleCohortIds: [],
    },
    coverage: emptyCoverage(
      safeRange,
      boundaryFactsStatus === "missing-bracket" ? "missing-bracket" : "invalid-sample",
    ),
    boats: [],
    primary: null,
    referenceFacts: null,
    startAdvantageMeters: null,
    endAdvantageMeters: null,
    progressGainedMeters: null,
    sailedDistanceDeltaMeters: null,
    groundVmgDeltaMps: null,
    straightDeltaMeters: null,
    maneuverWindowDeltaMeters: null,
    residualMeters: null,
    componentCoverageMicros: 0,
    componentExcludedMicros: safeRange.durationMicros,
    waterDeltaMeters: null,
    currentDeltaMeters: null,
    groundGainMeters: null,
    referenceNonlinearityMeters: null,
    progressResidualMeters: null,
    componentResidualMeters: null,
    componentProvenance: {
      water: "reconstructed-water-from-fixes",
      current: "reconstructed-current-from-fixes",
      ground: "derived-water-plus-current",
    },
  };
}

function maneuverFacts(race: RaceData, boatId: string, range: AnalysisRange): ManeuverRangeFact[] {
  if (seriesMicros(race.fixes[boatId]) === null) return [];
  return maneuversOf(race, boatId)
    .filter((maneuver) => {
      const windowFrom = secondsToMicros(maneuver.t - 4);
      const windowTo = secondsToMicros(maneuver.t + 4);
      return (
        windowFrom !== null &&
        windowTo !== null &&
        windowTo > range.fromMicros &&
        windowFrom < range.toMicros
      );
    })
    .map((maneuver) => {
      const at = secondsToMicros(maneuver.t);
      const windowFrom = secondsToMicros(maneuver.t - 4);
      const windowTo = secondsToMicros(maneuver.t + 4);
      if (at === null || windowFrom === null || windowTo === null) return null;
      return {
        t: maneuver.t,
        kind: maneuver.kind,
        countedInRange: at >= range.fromMicros && at < range.toMicros,
        lossStatus: Number.isFinite(maneuver.lossMps)
          ? "available"
          : "invalid-arithmetic",
        lossMps: Number.isFinite(maneuver.lossMps) ? maneuver.lossMps : null,
        costMeters: null,
        costSeconds: null,
        window: rangeFromMicros(
          Math.max(range.fromMicros, windowFrom),
          Math.min(range.toMicros, windowTo),
        ),
      };
    })
    .filter((fact): fact is ManeuverRangeFact => fact !== null);
}

function referenceFromBoats(boats: readonly BoatRangeFacts[]): ReferenceRangeFacts | null {
  if (
    boats.length === 0 ||
    boats.some(
      (boat) =>
        boat.startDtfMeters === null ||
        boat.endDtfMeters === null,
    )
  ) {
    return null;
  }
  const startDtfMeters = median(boats.map((boat) => boat.startDtfMeters as number));
  const endDtfMeters = median(boats.map((boat) => boat.endDtfMeters as number));
  if (startDtfMeters === null || endDtfMeters === null) return null;
  const groundFactsAvailable = boats.every(
    (boat) =>
      boat.groundFactsStatus === "ok" &&
      boat.sailedDistanceMeters !== null &&
      boat.meanSogMps !== null &&
      boat.meanVmgMps !== null &&
      boat.straightMadeGoodMeters !== null &&
      boat.maneuverWindowMadeGoodMeters !== null &&
      boat.waterMadeGoodMeters !== null &&
      boat.currentMadeGoodMeters !== null &&
      boat.groundMadeGoodMeters !== null,
  );
  const groundArithmeticInvalid = boats.some(
    (boat) => boat.groundFactsStatus === "invalid-arithmetic",
  );
  const sailedDistanceMeters = groundFactsAvailable
    ? median(boats.map((boat) => boat.sailedDistanceMeters as number))
    : null;
  const meanSogMps = groundFactsAvailable
    ? median(boats.map((boat) => boat.meanSogMps as number))
    : null;
  const meanVmgMps = groundFactsAvailable
    ? median(boats.map((boat) => boat.meanVmgMps as number))
    : null;
  const maneuverCount = groundFactsAvailable
    ? median(boats.map((boat) => boat.maneuverCount))
    : null;
  const straightMadeGoodMeters = groundFactsAvailable
    ? median(boats.map((boat) => boat.straightMadeGoodMeters as number))
    : null;
  const maneuverWindowMadeGoodMeters = groundFactsAvailable
    ? median(boats.map((boat) => boat.maneuverWindowMadeGoodMeters as number))
    : null;
  const waterMadeGoodMeters = groundFactsAvailable
    ? median(boats.map((boat) => boat.waterMadeGoodMeters as number))
    : null;
  const currentMadeGoodMeters = groundFactsAvailable
    ? median(boats.map((boat) => boat.currentMadeGoodMeters as number))
    : null;
  const groundMadeGoodMeters = groundFactsAvailable
    ? median(boats.map((boat) => boat.groundMadeGoodMeters as number))
    : null;
  const referenceArithmeticInvalid =
    groundFactsAvailable &&
    [
      sailedDistanceMeters,
      meanSogMps,
      meanVmgMps,
      maneuverCount,
      straightMadeGoodMeters,
      maneuverWindowMadeGoodMeters,
      waterMadeGoodMeters,
      currentMadeGoodMeters,
      groundMadeGoodMeters,
    ].some((value) => value === null);
  return {
    groundFactsStatus:
      groundArithmeticInvalid || referenceArithmeticInvalid
        ? "invalid-arithmetic"
        : groundFactsAvailable
          ? "ok"
          : "no-valid-coverage",
    groundFactsCoverageMicros:
      groundFactsAvailable && !referenceArithmeticInvalid
        ? boats[0].groundFactsCoverageMicros
        : 0,
    startDtfMeters,
    endDtfMeters,
    progressMeters: finiteDifference(startDtfMeters, endDtfMeters),
    sailedDistanceMeters,
    meanSogMps,
    meanVmgMps,
    maneuverCount,
    straightMadeGoodMeters,
    maneuverWindowMadeGoodMeters,
    waterMadeGoodMeters,
    currentMadeGoodMeters,
    groundMadeGoodMeters,
  };
}

export function compareRange(race: RaceData, request: ComparisonRequest): RangeComparison {
  const raceBounds = raceBoundsMicros(race);
  if (
    typeof request.primaryBoatId !== "string" ||
    request.primaryBoatId.length === 0 ||
    raceBounds === null
  ) {
    return invalidComparison(
      race,
      request,
      "primary boat and positive safe integer-microsecond race bounds are required",
    );
  }
  const knownIds = new Set(race.boats.map((boat) => boat.id));
  if (!knownIds.has(request.primaryBoatId)) {
    return invalidComparison(race, request, "primary boat ID is not registered");
  }
  const requestFrom = secondsToMicros(request.range.from);
  const requestTo = secondsToMicros(request.range.to);
  if (requestFrom === null || requestTo === null) {
    return invalidComparison(
      race,
      request,
      "analysis range endpoints must resolve to safe integer microseconds",
    );
  }
  const range = normalizeAnalysisRange(race, request.range.from, request.range.to);

  let requestedCohortIds: string[] = [];
  let eligibleCohortIds: string[] = [];
  let ineligibleCohortIds: string[] = [];
  let referenceBoatId: string | null = null;
  if (request.reference.kind === "boat") {
    referenceBoatId = request.reference.boatId;
    if (!knownIds.has(referenceBoatId)) {
      return invalidComparison(race, request, "rival boat ID is not registered");
    }
    if (referenceBoatId === request.primaryBoatId) {
      return invalidComparison(race, request, "a boat cannot be its own named rival");
    }
    eligibleCohortIds = [referenceBoatId];
  } else {
    requestedCohortIds = boatOrder(race, request.reference.boatIds);
    if (requestedCohortIds.length === 0) {
      return invalidComparison(race, request, "fleet median cohort cannot be empty");
    }
    const eligibility = new Map(
      requestedCohortIds.map((boatId) => [
        boatId,
        componentEligibilityForRange(race, boatId, range),
      ]),
    );
    eligibleCohortIds = requestedCohortIds.filter((boatId) => eligibility.get(boatId) === "eligible");
    ineligibleCohortIds = requestedCohortIds.filter((boatId) => eligibility.get(boatId) !== "eligible");
    const referenceState: RangeComparison["reference"] = {
      kind: "fleet-median",
      boatId: null,
      requestedCohortIds,
      eligibleCohortIds,
      ineligibleCohortIds,
    };
    if (eligibleCohortIds.length < 2) {
      return invalidComparison(
        race,
        request,
        "fleet median requires at least two boats with complete finite component coverage",
        range,
        "insufficient-fleet-coverage",
        "unavailable",
        referenceState,
      );
    }
    const selectedEligible =
      eligibility.get(request.primaryBoatId) ??
      componentEligibilityForRange(race, request.primaryBoatId, range);
    if (selectedEligible !== "eligible") {
      return invalidComparison(
        race,
        request,
        "selected boat lacks complete finite component coverage for the normalized range",
        range,
        "missing-boundary-data",
        selectedEligible,
        referenceState,
      );
    }
  }

  const requiredBoatIds = boatOrder(race, [request.primaryBoatId, ...eligibleCohortIds]);
  const validity = raceAnalysisValidity(race, requiredBoatIds);
  if (validity.status !== "valid") {
    if (validity.status === "invalid-race") {
      return invalidComparison(race, request, validity.reason ?? "race analysis preflight failed");
    }
    return invalidComparison(
      race,
      request,
      validity.reason ?? "race analysis preflight failed",
      undefined,
      "missing-boundary-data",
      validity.status === "missing-series" ? "missing-bracket" : "invalid-sample",
    );
  }
  const coverage = coverageFor(race, requiredBoatIds, range);
  const coverageSeconds = coverage.coverageSeconds;
  const includedIntervals = coverage.bins.filter((bin) => bin.reason === "included");
  const boats = requiredBoatIds.map((boatId): BoatRangeFacts => {
    const startDtfMeters = dtfAt(race, boatId, range.from);
    const endDtfMeters = dtfAt(race, boatId, range.to);
    const windows = maneuverRanges(race, boatId, range);
    const integrated = integrateCanonicalIntervals(race, boatId, includedIntervals, windows, true);
    const componentMadeGood = integrateComponentMadeGood(race, boatId, includedIntervals);
    const groundFactsAvailable =
      coverage.coverageMicros > 0 &&
      integrated.complete &&
      integrated.vmgCoverageMicros === coverage.coverageMicros &&
      integrated.sailedDistanceMeters !== null &&
      integrated.sogIntegral !== null &&
      integrated.vmgIntegral !== null &&
      integrated.straightMadeGoodMeters !== null &&
      integrated.maneuverWindowMadeGoodMeters !== null;
    const meanSog =
      groundFactsAvailable && integrated.sogIntegral !== null
        ? divideFinite(integrated.sogIntegral, coverageSeconds)
        : INVALID_ARITHMETIC;
    const meanVmg =
      groundFactsAvailable && integrated.vmgIntegral !== null
        ? divideFinite(integrated.vmgIntegral, coverageSeconds)
        : INVALID_ARITHMETIC;
    const finalizedGroundFacts =
      groundFactsAvailable && meanSog.status === "ok" && meanVmg.status === "ok";
    const arithmeticInvalid =
      integrated.failureStatus === "invalid-arithmetic" ||
      (groundFactsAvailable && !finalizedGroundFacts);
    const maneuvers = maneuverFacts(race, boatId, range);
    return {
      boatId,
      groundFactsStatus: arithmeticInvalid
        ? "invalid-arithmetic"
        : finalizedGroundFacts
          ? "ok"
          : "no-valid-coverage",
      groundFactsCoverageMicros: finalizedGroundFacts ? coverage.coverageMicros : 0,
      startDtfMeters,
      endDtfMeters,
      progressMeters:
        startDtfMeters === null || endDtfMeters === null
          ? null
          : finiteDifference(startDtfMeters, endDtfMeters),
      sailedDistanceMeters: finalizedGroundFacts ? integrated.sailedDistanceMeters : null,
      meanSogMps: finalizedGroundFacts ? meanSog.value : null,
      meanVmgMps: finalizedGroundFacts ? meanVmg.value : null,
      maneuverCount: maneuvers.filter((maneuver) => maneuver.countedInRange).length,
      maneuvers,
      straightMadeGoodMeters: finalizedGroundFacts ? integrated.straightMadeGoodMeters : null,
      maneuverWindowMadeGoodMeters: finalizedGroundFacts
        ? integrated.maneuverWindowMadeGoodMeters
        : null,
      waterMadeGoodMeters:
        componentMadeGood.status === "ok" ? componentMadeGood.waterMeters : null,
      currentMadeGoodMeters:
        componentMadeGood.status === "ok" ? componentMadeGood.currentMeters : null,
      groundMadeGoodMeters:
        componentMadeGood.status === "ok" ? componentMadeGood.groundMeters : null,
    };
  });
  const primary = boats.find((boat) => boat.boatId === request.primaryBoatId) ?? null;
  const referenceBoats =
    request.reference.kind === "boat"
      ? boats.filter((boat) => boat.boatId === referenceBoatId)
      : eligibleCohortIds.map((boatId) => boats.find((boat) => boat.boatId === boatId) as BoatRangeFacts);
  const referenceFacts = referenceFromBoats(referenceBoats);
  const boundaryInputsAvailable =
    primary !== null &&
    primary.startDtfMeters !== null &&
    primary.endDtfMeters !== null &&
    referenceBoats.every((boat) => boat.startDtfMeters !== null && boat.endDtfMeters !== null);
  const referenceStart = boundaryInputsAvailable
    ? request.reference.kind === "boat"
      ? (referenceBoats[0].startDtfMeters as number)
      : median(referenceBoats.map((boat) => boat.startDtfMeters as number))
    : null;
  const referenceEnd = boundaryInputsAvailable
    ? request.reference.kind === "boat"
      ? (referenceBoats[0].endDtfMeters as number)
      : median(referenceBoats.map((boat) => boat.endDtfMeters as number))
    : null;
  const startAdvantageMeters =
    primary?.startDtfMeters === null || primary?.startDtfMeters === undefined || referenceStart === null
      ? null
      : finiteDifference(referenceStart, primary.startDtfMeters);
  const endAdvantageMeters =
    primary?.endDtfMeters === null || primary?.endDtfMeters === undefined || referenceEnd === null
      ? null
      : finiteDifference(referenceEnd, primary.endDtfMeters);
  const progressGainedMeters =
    startAdvantageMeters === null || endAdvantageMeters === null
      ? null
      : finiteDifference(endAdvantageMeters, startAdvantageMeters);

  const boundaryStatuses = requiredBoatIds.flatMap((boatId) => [
    progressBoundaryStatusAt(race, boatId, range.from),
    progressBoundaryStatusAt(race, boatId, range.to),
  ]);
  const hasMissingBoundary = boundaryStatuses.includes("missing-bracket");
  const hasInvalidBoundary = boundaryStatuses.includes("invalid-sample");
  let boundaryFactsStatus: BoundaryFactsStatus;
  if (hasMissingBoundary && hasInvalidBoundary) boundaryFactsStatus = "missing-and-invalid";
  else if (hasMissingBoundary) boundaryFactsStatus = "missing-bracket";
  else if (hasInvalidBoundary) boundaryFactsStatus = "invalid-sample";
  else {
    const derivedBoundaryFacts = [
      startAdvantageMeters,
      endAdvantageMeters,
      progressGainedMeters,
      primary?.progressMeters ?? null,
      referenceFacts?.progressMeters ?? null,
      ...boats.map((boat) => boat.progressMeters),
    ];
    boundaryFactsStatus = derivedBoundaryFacts.every(
      (value): value is number => value !== null && Number.isFinite(value),
    )
      ? "available"
      : "invalid-arithmetic";
  }

  let status: ComparisonStatus = "ok";
  if (range.durationMicros === 0) status = "zero-duration";
  else if (boundaryFactsStatus !== "available") status = "missing-boundary-data";
  else if (
    coverage.coverageMicros === 0 &&
    coverage.excludedByReasonMicros.invalidArithmetic > 0
  ) {
    status = "invalid-arithmetic";
  }
  else if (coverage.coverageMicros === 0) status = "no-racing-coverage";
  else if (
    boats.some((boat) => boat.groundFactsStatus === "invalid-arithmetic") ||
    boats.some((boat) =>
      boat.maneuvers.some((maneuver) => maneuver.lossStatus === "invalid-arithmetic"),
    ) ||
    boats.some(
      (boat) =>
        boat.waterMadeGoodMeters === null ||
        boat.currentMadeGoodMeters === null ||
        boat.groundMadeGoodMeters === null,
    ) ||
    referenceFacts?.groundFactsStatus === "invalid-arithmetic"
  ) {
    status = "invalid-arithmetic";
  }

  const sailedDistanceDeltaMeters =
    status === "ok" && primary?.sailedDistanceMeters != null && referenceFacts?.sailedDistanceMeters != null
      ? finiteDifference(primary.sailedDistanceMeters, referenceFacts.sailedDistanceMeters)
      : null;
  const groundVmgDeltaMps =
    status === "ok" && primary?.meanVmgMps != null && referenceFacts?.meanVmgMps != null
      ? finiteDifference(primary.meanVmgMps, referenceFacts.meanVmgMps)
      : null;

  const straightDeltaMeters =
    status === "ok" &&
    primary?.straightMadeGoodMeters != null &&
    referenceFacts?.straightMadeGoodMeters != null
      ? finiteDifference(primary.straightMadeGoodMeters, referenceFacts.straightMadeGoodMeters)
      : null;
  const maneuverWindowDeltaMeters =
    status === "ok" &&
    primary?.maneuverWindowMadeGoodMeters != null &&
    referenceFacts?.maneuverWindowMadeGoodMeters != null
      ? finiteDifference(
          primary.maneuverWindowMadeGoodMeters,
          referenceFacts.maneuverWindowMadeGoodMeters,
        )
      : null;
  let residualMeters: number | null = null;
  if (
    straightDeltaMeters !== null &&
    maneuverWindowDeltaMeters !== null &&
    progressGainedMeters !== null
  ) {
    const afterStraight = subtractFinite(progressGainedMeters, straightDeltaMeters);
    residualMeters =
      afterStraight.status === "ok"
        ? subtractFinite(afterStraight.value, maneuverWindowDeltaMeters).value
        : null;
  }
  if (
    status === "ok" &&
    [
      sailedDistanceDeltaMeters,
      groundVmgDeltaMps,
      straightDeltaMeters,
      maneuverWindowDeltaMeters,
      residualMeters,
    ].some((value) => value === null)
  ) {
    status = "invalid-arithmetic";
  }

  const waterDeltaMeters =
    status === "ok" && primary?.waterMadeGoodMeters != null && referenceFacts?.waterMadeGoodMeters != null
      ? finiteDifference(primary.waterMadeGoodMeters, referenceFacts.waterMadeGoodMeters)
      : null;
  const currentDeltaMeters =
    status === "ok" && primary?.currentMadeGoodMeters != null && referenceFacts?.currentMadeGoodMeters != null
      ? finiteDifference(primary.currentMadeGoodMeters, referenceFacts.currentMadeGoodMeters)
      : null;
  const groundGainMeters =
    status === "ok" && primary?.groundMadeGoodMeters != null && referenceFacts?.groundMadeGoodMeters != null
      ? finiteDifference(primary.groundMadeGoodMeters, referenceFacts.groundMadeGoodMeters)
      : null;
  let referenceNonlinearityMeters: number | null = null;
  let progressResidualMeters: number | null = null;
  let componentResidualMeters: number | null = null;
  if (
    waterDeltaMeters !== null &&
    currentDeltaMeters !== null &&
    groundGainMeters !== null &&
    progressGainedMeters !== null
  ) {
    const groundMinusWater = subtractFinite(groundGainMeters, waterDeltaMeters);
    referenceNonlinearityMeters = groundMinusWater.status === "ok"
      ? subtractFinite(groundMinusWater.value, currentDeltaMeters).value
      : null;
    progressResidualMeters = subtractFinite(progressGainedMeters, groundGainMeters).value;
    const progressMinusWater = subtractFinite(progressGainedMeters, waterDeltaMeters);
    componentResidualMeters = progressMinusWater.status === "ok"
      ? subtractFinite(progressMinusWater.value, currentDeltaMeters).value
      : null;
  }
  if (
    status === "ok" &&
    [
      waterDeltaMeters,
      currentDeltaMeters,
      groundGainMeters,
      referenceNonlinearityMeters,
      progressResidualMeters,
      componentResidualMeters,
    ].some((value) => value === null)
  ) status = "invalid-arithmetic";

  return {
    status,
    boundaryFactsStatus,
    invalidReason: null,
    primaryBoatId: request.primaryBoatId,
    range,
    reference: {
      kind: request.reference.kind,
      boatId: referenceBoatId,
      requestedCohortIds,
      eligibleCohortIds,
      ineligibleCohortIds,
    },
    coverage,
    boats,
    primary,
    referenceFacts,
    startAdvantageMeters,
    endAdvantageMeters,
    progressGainedMeters,
    sailedDistanceDeltaMeters,
    groundVmgDeltaMps,
    straightDeltaMeters,
    maneuverWindowDeltaMeters,
    residualMeters,
    componentCoverageMicros: coverage.coverageMicros,
    componentExcludedMicros: coverage.durationMicros - coverage.coverageMicros,
    waterDeltaMeters,
    currentDeltaMeters,
    groundGainMeters,
    referenceNonlinearityMeters,
    progressResidualMeters,
    componentResidualMeters,
    componentProvenance: {
      water: "reconstructed-water-from-fixes",
      current: "reconstructed-current-from-fixes",
      ground: "derived-water-plus-current",
    },
  };
}

export function integrateTrackRange(
  race: RaceData,
  boatId: string,
  inputRange: { from: number; to: number },
): TrackRangeFacts {
  const validity = raceAnalysisValidity(race, [boatId]);
  const raceBounds = validity.raceBounds;
  if (validity.status !== "valid") {
    const fallbackMicros = raceBounds?.from ?? 0;
    const range = rangeFromMicros(fallbackMicros, fallbackMicros);
    return {
      status:
        validity.status === "invalid-race"
          ? "invalid-request"
          : validity.status === "missing-series"
            ? "missing-bracket"
            : "invalid-sample",
      boatId,
      range,
      durationMicros: 0,
      sailedDistanceMeters: null,
      meanSogMps: null,
      meanVmgMps: null,
      vmgCoverageMicros: 0,
    };
  }
  const inputFrom = secondsToMicros(inputRange.from);
  const inputTo = secondsToMicros(inputRange.to);
  if (inputFrom === null || inputTo === null) {
    const fallbackMicros = raceBounds?.from ?? 0;
    const range = rangeFromMicros(fallbackMicros, fallbackMicros);
    return {
      status: "invalid-request",
      boatId,
      range,
      durationMicros: 0,
      sailedDistanceMeters: null,
      meanSogMps: null,
      meanVmgMps: null,
      vmgCoverageMicros: 0,
    };
  }
  const range = normalizeAnalysisRange(race, inputRange.from, inputRange.to);
  if (range.durationMicros === 0) {
    return {
      status: "zero-duration",
      boatId,
      range,
      durationMicros: 0,
      sailedDistanceMeters: null,
      meanSogMps: null,
      meanVmgMps: null,
      vmgCoverageMicros: 0,
    };
  }
  const integrated = integrateCanonicalIntervals(race, boatId, [range], [], false);
  if (!integrated.complete) {
    return {
      status: integrated.failureStatus ?? "invalid-sample",
      boatId,
      range,
      durationMicros: range.durationMicros,
      sailedDistanceMeters: null,
      meanSogMps: null,
      meanVmgMps: null,
      vmgCoverageMicros: 0,
    };
  }
  if (
    integrated.sailedDistanceMeters === null ||
    integrated.sogIntegral === null ||
    integrated.vmgIntegral === null
  ) {
    return {
      status: "invalid-arithmetic",
      boatId,
      range,
      durationMicros: range.durationMicros,
      sailedDistanceMeters: null,
      meanSogMps: null,
      meanVmgMps: null,
      vmgCoverageMicros: 0,
    };
  }
  const meanSog = divideFinite(
    integrated.sogIntegral,
    microsToSeconds(range.durationMicros),
  );
  const meanVmg =
    integrated.vmgCoverageMicros > 0
      ? divideFinite(
          integrated.vmgIntegral,
          microsToSeconds(integrated.vmgCoverageMicros),
        )
      : null;
  if (meanSog.status !== "ok" || (meanVmg !== null && meanVmg.status !== "ok")) {
    return {
      status: "invalid-arithmetic",
      boatId,
      range,
      durationMicros: range.durationMicros,
      sailedDistanceMeters: null,
      meanSogMps: null,
      meanVmgMps: null,
      vmgCoverageMicros: 0,
    };
  }
  return {
    status: "ok",
    boatId,
    range,
    durationMicros: range.durationMicros,
    sailedDistanceMeters: integrated.sailedDistanceMeters,
    meanSogMps: meanSog.value,
    meanVmgMps: meanVmg?.value ?? null,
    vmgCoverageMicros: integrated.vmgCoverageMicros,
  };
}
