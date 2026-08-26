import type { CurrentFieldSpec } from "./current";
import {
  FICTIONAL_ONE_DESIGN_POLAR,
  normalizeDeclaredTwaAbs,
  polarModelFingerprint,
  targetBoatSpeed,
  type PolarModel,
} from "./polar";
import type { RaceData, Vec2 } from "./types";
import {
  simulationVectorFromSpeedCourse,
  simulationVelocityFromComponents,
} from "./simulation-math";
import {
  courseFromVector,
  projectVelocityOntoBearing,
  vectorFromSpeedCourse,
  velocityFromComponents,
  waterCourseFromHeading,
  wrap360,
} from "./velocity";

export const TACTICAL_GUIDANCE_TICKS = 10;
export const TACTICAL_GUIDANCE_MAX_CANDIDATES = 2;
export const INSPECTION_STEP_SECONDS = 0.25;
export const INSPECTION_HORIZON_SECONDS = 90;
export const INSPECTION_ANGLE_STEP_DEGREES = 1;
export const INSPECTION_MAX_STEPS = 360;
export const INSPECTION_MAX_CANDIDATES_PER_VELOCITY = 92;
export const INSPECTION_MAX_TRACES = 2;
export const LAYLINE_ARRIVAL_RADIUS_METERS = 4;
export const LAYLINE_STALL_SPEED_MPS = 0.05;
export const RACE_TRACE_CACHE_MAX_ENTRIES = 64;
export const LAYLINE_TRACE_ALGORITHM_VERSION = "midpoint-rk2-v1";

export interface TacticalGuidanceRequest {
  x: number; y: number; t: number;
  markX: number; markY: number;
  twd: number; tws: number;
  currentX: number; currentY: number;
  twaAbs: number; pace: number;
}
export interface TacticalSideGuidance {
  side: "port" | "starboard";
  heading: number; twa: number; ctw: number;
  groundX: number; groundY: number;
  signedCrossTrackMeters: number;
  alongTrackMeters: number;
  etaSeconds: number | null;
}
export interface WindFromVector { windFromX: number; windFromY: number }
export interface LaylineTraceRequest {
  start: { x: number; y: number; t: number; recordedFixIndex: number };
  mark: { x: number; y: number };
  leg: "beat" | "run";
  side: "port" | "starboard";
  pace: number;
  declaredTwaAbs: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  sampleWindField: (x: number, y: number, t: number, out: WindFromVector) => WindFromVector;
  sampleCurrentField: (x: number, y: number, t: number, out: Vec2) => Vec2;
  polarModel?: PolarModel;
}
export interface LaylineTrace {
  status: "arrived" | "horizon" | "boundary" | "stalled" | "invalid";
  points: readonly { x: number; y: number; t: number }[];
  etaSeconds: number | null;
  closestApproachMeters: number | null;
  closestApproachTime: number | null;
  steps: number;
  candidateEvaluations: number;
}

const finite = (value: number): boolean => Number.isFinite(value);
const positiveZero = (value: number): number => value === 0 ? 0 : value;

export function shouldRefreshTacticalGuidance(raceTick: number, active: boolean): boolean {
  return active && Number.isSafeInteger(raceTick) && raceTick >= 0 && raceTick % TACTICAL_GUIDANCE_TICKS === 0;
}

export function tacticalLaylineGuidance(
  request: TacticalGuidanceRequest,
): readonly [TacticalSideGuidance, TacticalSideGuidance] {
  return buildTacticalLaylineGuidance(request, false);
}

export function tacticalLaylineGuidanceForSimulator(
  request: TacticalGuidanceRequest,
): readonly [TacticalSideGuidance, TacticalSideGuidance] {
  return buildTacticalLaylineGuidance(request, true);
}

function buildTacticalLaylineGuidance(
  request: TacticalGuidanceRequest,
  simulatorSources: boolean,
): readonly [TacticalSideGuidance, TacticalSideGuidance] {
  const values = [request.x, request.y, request.t, request.markX, request.markY, request.twd, request.tws, request.currentX, request.currentY, request.twaAbs, request.pace];
  if (!values.every(finite) || request.tws < 0 || request.pace < 0 || request.twaAbs < 0 || request.twaAbs > 180) {
    throw new RangeError("invalid tactical guidance request");
  }
  const make = (side: "port" | "starboard"): TacticalSideGuidance => {
    const heading = wrap360(request.twd + (side === "port" ? request.twaAbs : -request.twaAbs));
    const waterCourse = waterCourseFromHeading(request.twd, heading);
    const twa = waterCourse.twa;
    const ctw = waterCourse.ctw;
    const speed = targetBoatSpeed(FICTIONAL_ONE_DESIGN_POLAR, request.tws, Math.abs(twa));
    if (speed === null) throw new RangeError("invalid tactical polar target");
    const water = simulatorSources
      ? simulationVectorFromSpeedCourse(speed * request.pace, ctw, {})
      : vectorFromSpeedCourse(speed * request.pace, ctw, {});
    const velocity = simulatorSources
      ? simulationVelocityFromComponents(water.x, water.y, request.currentX, request.currentY, {})
      : velocityFromComponents(water.x, water.y, request.currentX, request.currentY, {});
    if (velocity.sog <= 1e-12) throw new RangeError("tactical ground ray is zero");
    const unitX = velocity.groundX / velocity.sog;
    const unitY = velocity.groundY / velocity.sog;
    const deltaX = request.markX - request.x;
    const deltaY = request.markY - request.y;
    const alongTrackMeters = deltaX * unitX + deltaY * unitY;
    const signedCrossTrackMeters = deltaX * unitY - deltaY * unitX;
    const etaSeconds = alongTrackMeters > 0 ? alongTrackMeters / velocity.sog : null;
    if (![alongTrackMeters, signedCrossTrackMeters].every(finite) || (etaSeconds !== null && !finite(etaSeconds))) {
      throw new RangeError("tactical projection overflowed");
    }
    return {
      side, heading, twa, ctw,
      groundX: velocity.groundX, groundY: velocity.groundY,
      signedCrossTrackMeters: positiveZero(signedCrossTrackMeters),
      alongTrackMeters: positiveZero(alongTrackMeters),
      etaSeconds,
    };
  };
  return [make("port"), make("starboard")];
}

function finalizeTrace(trace: LaylineTrace): LaylineTrace {
  for (const point of trace.points) Object.freeze(point);
  Object.freeze(trace.points);
  return Object.freeze(trace);
}

const ZERO_POINT_INVALID_TRACE = finalizeTrace({
  status: "invalid",
  points: [],
  etaSeconds: null,
  closestApproachMeters: null,
  closestApproachTime: null,
  steps: 0,
  candidateEvaluations: 0,
});

function invalidTrace(): LaylineTrace { return ZERO_POINT_INVALID_TRACE; }

interface ValidatedTraceRequest {
  declaredTwaAbs: number;
  initialDistance: number;
}

function validRequest(request: LaylineTraceRequest): ValidatedTraceRequest | null {
  if ((request.leg !== "beat" && request.leg !== "run") ||
    (request.side !== "port" && request.side !== "starboard")) return null;
  const angle = normalizeDeclaredTwaAbs(request.leg, request.declaredTwaAbs);
  const numeric = [request.start.x, request.start.y, request.start.t, request.start.recordedFixIndex,
    request.mark.x, request.mark.y, request.pace, request.bounds.minX, request.bounds.maxX,
    request.bounds.minY, request.bounds.maxY];
  if (angle === null || !numeric.every(finite) || !Number.isSafeInteger(request.start.recordedFixIndex) ||
    request.start.recordedFixIndex < 0 || request.pace < 0 ||
    !(request.bounds.minX <= request.bounds.maxX && request.bounds.minY <= request.bounds.maxY) ||
    typeof request.sampleWindField !== "function" || typeof request.sampleCurrentField !== "function") return null;
  const deltaX = request.mark.x - request.start.x;
  const deltaY = request.mark.y - request.start.y;
  const width = request.bounds.maxX - request.bounds.minX;
  const height = request.bounds.maxY - request.bounds.minY;
  const initialDistance = Math.hypot(deltaX, deltaY);
  const boundsDiagonal = Math.hypot(width, height);
  const derivedGeometry = [
    deltaX, deltaY, initialDistance, width, height, boundsDiagonal,
    request.start.x - request.bounds.minX, request.bounds.maxX - request.start.x,
    request.start.y - request.bounds.minY, request.bounds.maxY - request.start.y,
  ];
  if (!derivedGeometry.every(finite)) return null;
  return { declaredTwaAbs: angle, initialDistance };
}

interface PolarModelSnapshot {
  source: object;
  model: Readonly<PolarModel>;
  fingerprint: string;
}

interface TraceRequestSnapshot {
  request: LaylineTraceRequest & { polarModel: Readonly<PolarModel> };
  validation: ValidatedTraceRequest;
  polar: PolarModelSnapshot;
}

function snapshotNumberArray(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const snapshot: number[] = [];
  for (let index = 0; index < length; index++) snapshot.push(value[index]);
  return Object.freeze(snapshot);
}

function snapshotPolarModel(value: unknown): PolarModelSnapshot | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const kind = source.kind;
  const version = source.version;
  const provenance = source.provenance;
  const twaDegrees = snapshotNumberArray(source.twaDegrees);
  const speedFractions = snapshotNumberArray(source.speedFractions);
  const lowTailAngleDegrees = source.lowTailAngleDegrees;
  const lowTailFraction = source.lowTailFraction;
  const highTailAngleDegrees = source.highTailAngleDegrees;
  const highTailFraction = source.highTailFraction;
  const highTailDropFraction = source.highTailDropFraction;
  if (twaDegrees === null || speedFractions === null) return null;
  const model = Object.freeze({
    kind,
    version,
    provenance,
    twaDegrees,
    speedFractions,
    lowTailAngleDegrees,
    lowTailFraction,
    highTailAngleDegrees,
    highTailFraction,
    highTailDropFraction,
  }) as Readonly<PolarModel>;
  const fingerprint = polarModelFingerprint(model);
  return fingerprint === "invalid-polar-model" ? null : { source: value, model, fingerprint };
}

function snapshotTraceRequest(value: unknown, polarOverride?: PolarModelSnapshot): TraceRequestSnapshot | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const startValue = source.start;
  const markValue = source.mark;
  const leg = source.leg;
  const side = source.side;
  const pace = source.pace;
  const declaredTwaAbs = source.declaredTwaAbs;
  const boundsValue = source.bounds;
  const sampleWindField = source.sampleWindField;
  const sampleCurrentField = source.sampleCurrentField;
  const tracePolarModel = source.polarModel;
  if (startValue === null || typeof startValue !== "object" ||
    markValue === null || typeof markValue !== "object" ||
    boundsValue === null || typeof boundsValue !== "object") return null;
  const startSource = startValue as Record<string, unknown>;
  const markSource = markValue as Record<string, unknown>;
  const boundsSource = boundsValue as Record<string, unknown>;
  const start = {
    x: startSource.x,
    y: startSource.y,
    t: startSource.t,
    recordedFixIndex: startSource.recordedFixIndex,
  };
  const mark = { x: markSource.x, y: markSource.y };
  const bounds = {
    minX: boundsSource.minX,
    maxX: boundsSource.maxX,
    minY: boundsSource.minY,
    maxY: boundsSource.maxY,
  };
  const polar = polarOverride ?? snapshotPolarModel(tracePolarModel ?? FICTIONAL_ONE_DESIGN_POLAR);
  if (polar === null) return null;
  const request = {
    start,
    mark,
    leg,
    side,
    pace,
    declaredTwaAbs,
    bounds,
    sampleWindField,
    sampleCurrentField,
    polarModel: polar.model,
  } as LaylineTraceRequest & { polarModel: Readonly<PolarModel> };
  const validation = validRequest(request);
  return validation === null ? null : { request, validation, polar };
}

function inside(bounds: LaylineTraceRequest["bounds"], x: number, y: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

function candidateAngles(leg: "beat" | "run", declared: number, model: PolarModel): number[] {
  const values: number[] = [];
  const start = leg === "beat" ? 0 : 91;
  for (let angle = start; angle <= (leg === "beat" ? 90 : 180); angle += INSPECTION_ANGLE_STEP_DEGREES) values.push(angle);
  for (const angle of model.twaDegrees) {
    if ((leg === "beat" && angle >= 0 && angle <= 90) || (leg === "run" && angle > 90 && angle <= 180)) values.push(angle);
  }
  values.push(declared);
  return [...new Set(values)].sort((left, right) => left - right);
}

interface Evaluation { x: number; y: number; speed: number; candidates: number; valid: boolean }

/* One evaluation runs up to 92 candidate angles and a trace runs two
 * evaluations per step for up to 360 steps, all synchronous inside one frame.
 * The helpers take out-parameters, so the intermediates below are module
 * scratch rather than fresh objects: every value is copied out before the next
 * call writes over it, and a surface build stops paying a six-figure
 * allocation bill to the collector mid-frame. */
const WIND_SCRATCH: WindFromVector = { windFromX: 0, windFromY: 0 };
const CURRENT_SCRATCH: Vec2 = { x: 0, y: 0 };
const WATER_SCRATCH: Vec2 = { x: 0, y: 0 };
const VELOCITY_SCRATCH = {};

function evaluateVelocity(request: LaylineTraceRequest, x: number, y: number, t: number, angles: readonly number[], model: PolarModel): Evaluation {
  let windFromX: number;
  let windFromY: number;
  let currentX: number;
  let currentY: number;
  try {
    const wind = request.sampleWindField(x, y, t, WIND_SCRATCH);
    windFromX = wind.windFromX;
    windFromY = wind.windFromY;
    const current = request.sampleCurrentField(x, y, t, CURRENT_SCRATCH);
    currentX = current.x;
    currentY = current.y;
  } catch {
    return { x: 0, y: 0, speed: 0, candidates: 0, valid: false };
  }
  if (!finite(windFromX) || !finite(windFromY) || !finite(currentX) || !finite(currentY)) return { x: 0, y: 0, speed: 0, candidates: 0, valid: false };
  const tws = Math.hypot(windFromX, windFromY);
  if (!finite(tws)) return { x: 0, y: 0, speed: 0, candidates: 0, valid: false };
  const twd = courseFromVector(windFromX, windFromY);
  if (twd === null) return { x: 0, y: 0, speed: 0, candidates: 0, valid: false };
  const dx = request.mark.x - x;
  const dy = request.mark.y - y;
  const markDistance = Math.hypot(dx, dy);
  if (!(markDistance > 0) || !finite(markDistance)) return { x: 0, y: 0, speed: 0, candidates: 0, valid: false };
  const markBearing = courseFromVector(dx, dy);
  if (markBearing === null) return { x: 0, y: 0, speed: 0, candidates: 0, valid: false };
  let count = 0;
  let bestProjection = -Infinity;
  let bestAngle = Infinity;
  let best: Evaluation | null = null;
  for (const angle of angles) {
    count++;
    const heading = wrap360(twd + (request.side === "port" ? angle : -angle));
    const course = waterCourseFromHeading(twd, heading);
    const target = targetBoatSpeed(model, tws, Math.abs(course.twa));
    if (target === null) continue;
    const scaledTarget = target * request.pace;
    if (!finite(scaledTarget)) return { x: 0, y: 0, speed: 0, candidates: count, valid: false };
    if (scaledTarget <= LAYLINE_STALL_SPEED_MPS) continue;
    let velocity;
    try {
      const water = vectorFromSpeedCourse(scaledTarget, course.ctw, WATER_SCRATCH);
      velocity = velocityFromComponents(water.x, water.y, currentX, currentY, VELOCITY_SCRATCH);
    } catch {
      return { x: 0, y: 0, speed: 0, candidates: count, valid: false };
    }
    const projection = projectVelocityOntoBearing(velocity.groundX, velocity.groundY, markBearing);
    if (projection === null) return { x: 0, y: 0, speed: 0, candidates: count, valid: false };
    if (projection > bestProjection || (projection === bestProjection && angle < bestAngle)) {
      bestProjection = projection;
      bestAngle = angle;
      best = { x: velocity.groundX, y: velocity.groundY, speed: velocity.sog, candidates: 0, valid: true };
    }
  }
  return best ? { ...best, candidates: count } : { x: 0, y: 0, speed: 0, candidates: count, valid: false };
}

function arrivalFraction(ax: number, ay: number, bx: number, by: number, mx: number, my: number): number | null {
  const dx = bx - ax, dy = by - ay, fx = ax - mx, fy = ay - my;
  const aa = dx * dx + dy * dy;
  if (aa <= 1e-18) return null;
  const bb = 2 * (fx * dx + fy * dy);
  const cc = fx * fx + fy * fy - LAYLINE_ARRIVAL_RADIUS_METERS ** 2;
  const discriminant = bb * bb - 4 * aa * cc;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const first = (-bb - root) / (2 * aa);
  if (first >= 0 && first <= 1) return first;
  const second = (-bb + root) / (2 * aa);
  return second >= 0 && second <= 1 ? second : null;
}

function boundaryFraction(bounds: LaylineTraceRequest["bounds"], ax: number, ay: number, bx: number, by: number): number | null {
  if (inside(bounds, bx, by)) return null;
  const fractions: number[] = [];
  if (bx !== ax) {
    for (const edge of [bounds.minX, bounds.maxX]) { const u = (edge - ax) / (bx - ax); const y = ay + u * (by - ay); if (u >= 0 && u <= 1 && y >= bounds.minY && y <= bounds.maxY) fractions.push(u); }
  }
  if (by !== ay) {
    for (const edge of [bounds.minY, bounds.maxY]) { const u = (edge - ay) / (by - ay); const x = ax + u * (bx - ax); if (u >= 0 && u <= 1 && x >= bounds.minX && x <= bounds.maxX) fractions.push(u); }
  }
  return fractions.length ? Math.min(...fractions) : 0;
}

function updateClosest(ax: number, ay: number, at: number, bx: number, by: number, bt: number, mark: Vec2, current: { distance: number; time: number }): void {
  const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
  const u = length2 <= 1e-18 ? 0 : Math.max(0, Math.min(1, ((mark.x - ax) * dx + (mark.y - ay) * dy) / length2));
  const distance = Math.hypot(ax + u * dx - mark.x, ay + u * dy - mark.y);
  const time = at + u * (bt - at);
  if (distance < current.distance || (distance === current.distance && time < current.time)) { current.distance = distance; current.time = time; }
}

function traceLaylineInspectionSnapshot(snapshot: TraceRequestSnapshot): LaylineTrace {
  const { request, validation } = snapshot;
  const model = request.polarModel;
  const start = { x: positiveZero(request.start.x), y: positiveZero(request.start.y), t: positiveZero(request.start.t) };
  const points = [start];
  const initialDistance = validation.initialDistance;
  const closest = { distance: initialDistance, time: start.t };
  const finish = (status: LaylineTrace["status"], steps: number, candidates: number, eta: number | null): LaylineTrace => finalizeTrace({
    status, points, etaSeconds: eta, closestApproachMeters: finite(closest.distance) ? closest.distance : null,
    closestApproachTime: finite(closest.time) ? closest.time : null, steps, candidateEvaluations: candidates,
  });
  if (initialDistance <= LAYLINE_ARRIVAL_RADIUS_METERS) return finish("arrived", 0, 0, 0);
  if (!inside(request.bounds, start.x, start.y)) return finish("boundary", 0, 0, null);
  const angles = candidateAngles(request.leg, validation.declaredTwaAbs, model);
  if (angles.length > INSPECTION_MAX_CANDIDATES_PER_VELOCITY) return invalidTrace();
  let x = start.x, y = start.y, t = start.t, candidates = 0;
  for (let step = 0; step < INSPECTION_MAX_STEPS; step++) {
    const first = evaluateVelocity(request, x, y, t, angles, model); candidates += first.candidates;
    if (!first.valid) return finish("invalid", step, candidates, null);
    if (first.speed < LAYLINE_STALL_SPEED_MPS) return finish("stalled", step, candidates, null);
    const midX = x + 0.5 * INSPECTION_STEP_SECONDS * first.x;
    const midY = y + 0.5 * INSPECTION_STEP_SECONDS * first.y;
    const midT = t + 0.5 * INSPECTION_STEP_SECONDS;
    const middle = evaluateVelocity(request, midX, midY, midT, angles, model); candidates += middle.candidates;
    if (!middle.valid) return finish("invalid", step, candidates, null);
    if (middle.speed < LAYLINE_STALL_SPEED_MPS) return finish("stalled", step, candidates, null);
    const nextX = x + INSPECTION_STEP_SECONDS * middle.x;
    const nextY = y + INSPECTION_STEP_SECONDS * middle.y;
    const nextT = t + INSPECTION_STEP_SECONDS;
    if (![nextX, nextY, nextT].every(finite)) return finish("invalid", step, candidates, null);
    const arrival = arrivalFraction(x, y, nextX, nextY, request.mark.x, request.mark.y);
    const boundary = boundaryFraction(request.bounds, x, y, nextX, nextY);
    if (arrival !== null && (boundary === null || arrival <= boundary)) {
      const point = { x: x + arrival * (nextX - x), y: y + arrival * (nextY - y), t: t + arrival * INSPECTION_STEP_SECONDS };
      updateClosest(x, y, t, point.x, point.y, point.t, request.mark, closest); points.push(point);
      return finish("arrived", step + 1, candidates, point.t - start.t);
    }
    if (boundary !== null) {
      const point = { x: x + boundary * (nextX - x), y: y + boundary * (nextY - y), t: t + boundary * INSPECTION_STEP_SECONDS };
      updateClosest(x, y, t, point.x, point.y, point.t, request.mark, closest); points.push(point);
      return finish("boundary", step + 1, candidates, null);
    }
    updateClosest(x, y, t, nextX, nextY, nextT, request.mark, closest);
    points.push({ x: positiveZero(nextX), y: positiveZero(nextY), t: positiveZero(nextT) });
    x = nextX; y = nextY; t = nextT;
  }
  return finish("horizon", INSPECTION_MAX_STEPS, candidates, null);
}

export function traceLaylineInspection(request: LaylineTraceRequest): LaylineTrace {
  try {
    const snapshot = snapshotTraceRequest(request);
    return snapshot === null ? invalidTrace() : traceLaylineInspectionSnapshot(snapshot);
  } catch {
    return invalidTrace();
  }
}

export interface CachedLaylineTraceRequest {
  race: RaceData;
  boatId: string;
  windSpec: unknown;
  currentSpec: CurrentFieldSpec;
  polarModel: PolarModel;
  trace: LaylineTraceRequest;
}
const raceCaches = new WeakMap<RaceData, Map<string, LaylineTrace>>();
const functionIds = new WeakMap<object, number>();
const objectIds = new WeakMap<object, number>();
let nextIdentity = 1;
function identity(map: WeakMap<object, number>, value: object): number {
  let id = map.get(value); if (id === undefined) { id = nextIdentity++; map.set(value, id); } return id;
}
function exactFingerprint(value: unknown, seen = new Set<object>()): string | null {
  if (typeof value === "number") return finite(value) ? (Object.is(value, -0) ? "n:-0" : `n:${value}`) : null;
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `b:${value}`;
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    const parts = value.map((item) => exactFingerprint(item, seen));
    seen.delete(value);
    return parts.includes(null) ? null : `[${parts.join(",")}]`;
  }
  if (typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) { const part = exactFingerprint((value as Record<string, unknown>)[key], seen); if (part === null) return null; parts.push(`${JSON.stringify(key)}:${part}`); }
  seen.delete(value);
  return `{${parts.join(",")}}`;
}
export const LAYLINE_TRACE_ALGORITHM_FINGERPRINT = [LAYLINE_TRACE_ALGORITHM_VERSION, INSPECTION_STEP_SECONDS, INSPECTION_HORIZON_SECONDS, INSPECTION_ANGLE_STEP_DEGREES, INSPECTION_MAX_STEPS, INSPECTION_MAX_CANDIDATES_PER_VELOCITY, INSPECTION_MAX_TRACES, LAYLINE_ARRIVAL_RADIUS_METERS, LAYLINE_STALL_SPEED_MPS].join("|");

interface CachedTraceSnapshot {
  race: RaceData;
  boatId: string;
  specsFingerprint: string;
  polarIdentity: number;
  windSamplerIdentity: number;
  currentSamplerIdentity: number;
  trace: TraceRequestSnapshot;
}

function snapshotCachedRequest(value: unknown): CachedTraceSnapshot | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const race = source.race;
  const boatId = source.boatId;
  const windSpec = source.windSpec;
  const currentSpec = source.currentSpec;
  const polarModel = source.polarModel;
  const traceValue = source.trace;
  if (race === null || typeof race !== "object" || typeof boatId !== "string" || !boatId) return null;
  const specsFingerprint = exactFingerprint({ wind: windSpec, current: currentSpec });
  if (specsFingerprint === null) return null;
  const polar = snapshotPolarModel(polarModel);
  if (polar === null) return null;
  const trace = snapshotTraceRequest(traceValue, polar);
  if (trace === null) return null;
  return {
    race: race as RaceData,
    boatId,
    specsFingerprint,
    polarIdentity: identity(objectIds, polar.source),
    windSamplerIdentity: identity(functionIds, trace.request.sampleWindField),
    currentSamplerIdentity: identity(functionIds, trace.request.sampleCurrentField),
    trace,
  };
}

function cacheKey(snapshot: CachedTraceSnapshot): string | null {
  const { request: trace, validation } = snapshot.trace;
  const values = [snapshot.boatId, trace.start.recordedFixIndex, trace.start.x, trace.start.y, trace.start.t,
    trace.mark.x, trace.mark.y, trace.leg, trace.side, trace.pace, validation.declaredTwaAbs,
    trace.bounds.minX, trace.bounds.maxX, trace.bounds.minY, trace.bounds.maxY,
    snapshot.windSamplerIdentity, snapshot.currentSamplerIdentity, snapshot.polarIdentity,
    snapshot.specsFingerprint, snapshot.trace.polar.fingerprint, LAYLINE_TRACE_ALGORITHM_FINGERPRINT];
  return exactFingerprint(values);
}

export function cachedTraceLaylineInspection(request: CachedLaylineTraceRequest): LaylineTrace {
  try {
    const snapshot = snapshotCachedRequest(request);
    if (snapshot === null) return invalidTrace();
    const key = cacheKey(snapshot);
    if (key === null) return invalidTrace();
    let cache = raceCaches.get(snapshot.race);
    const hit = cache?.get(key);
    if (hit) {
      cache!.delete(key);
      cache!.set(key, hit);
      return hit;
    }
    const result = traceLaylineInspectionSnapshot(snapshot.trace);
    if (!cache) {
      cache = new Map();
      raceCaches.set(snapshot.race, cache);
    }
    cache.set(key, result);
    if (cache.size > RACE_TRACE_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    return result;
  } catch {
    return invalidTrace();
  }
}

export function clearLaylineInspectionCache(race: RaceData): void { raceCaches.delete(race); }
