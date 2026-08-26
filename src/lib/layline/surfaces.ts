import { sampleSeededCurrentField } from "./current";
import { legAt, windAt } from "./interpolate";
import {
  cachedTraceLaylineInspection,
  INSPECTION_MAX_STEPS,
  INSPECTION_MAX_TRACES,
  type LaylineTrace,
  type WindFromVector,
} from "./laylines";
import { FICTIONAL_ONE_DESIGN_POLAR, targetBoatSpeed } from "./polar";
import type { Pose, RaceData, ReplayMode, Vec2, WindSample } from "./types";
import { velocityFromComponents, type DerivedVelocity } from "./velocity";

export const CURRENT_FIELD_PROVENANCE = "Seeded current field";
/* The one value the current field is drawn in, stated here rather than in the
 * scene, because the key on the story page has to name the same colour the
 * water carries and a second literal is a key that can go quietly wrong. It
 * lives in this module rather than the scene one so a server component can
 * read it without pulling three.js into its bundle. */
export const CURRENT_FIELD_INK = "#7dd9e8";
export const CURRENT_FIELD_3D_MAX_GLYPHS = 48;
export const CURRENT_FIELD_SVG_MAX_GLYPHS = 24;
export const INSPECTION_PAUSED_SETTLE_MS = 80;

export interface CurrentFieldGlyph {
  x: number;
  y: number;
  currentX: number;
  currentY: number;
  drift: number;
  set: number | null;
}

export interface CurrentFieldGrid {
  provenance: typeof CURRENT_FIELD_PROVENANCE;
  sampledAt: number;
  columns: number;
  rows: number;
  glyphs: CurrentFieldGlyph[];
  sample: Vec2;
}

function gridDimensions(limit: number): readonly [number, number] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CURRENT_FIELD_3D_MAX_GLYPHS) {
    throw new RangeError("current field glyph limit must be an integer from 1 through 48");
  }
  if (limit >= CURRENT_FIELD_3D_MAX_GLYPHS) return [8, 6];
  if (limit >= CURRENT_FIELD_SVG_MAX_GLYPHS) return [6, 4];
  const columns = Math.max(1, Math.ceil(Math.sqrt(limit * 1.5)));
  return [columns, Math.max(1, Math.floor(limit / columns))];
}

/** Fixed positions and caller-owned glyph objects; sampling rewrites them in place. */
export function createCurrentFieldGrid(race: RaceData, limit: number): CurrentFieldGrid {
  const [columns, rows] = gridDimensions(limit);
  const spec = race.environment.current;
  const minX = spec.halfWidthMeters * spec.uMin;
  const maxX = spec.halfWidthMeters * spec.uMax;
  const minY = spec.lengthMeters * spec.vMin;
  const maxY = spec.lengthMeters * spec.vMax;
  const glyphs: CurrentFieldGlyph[] = [];
  for (let row = 0; row < rows; row++) {
    const y = minY + ((row + 0.5) / rows) * (maxY - minY);
    for (let column = 0; column < columns; column++) {
      const x = minX + ((column + 0.5) / columns) * (maxX - minX);
      glyphs.push({ x, y, currentX: 0, currentY: 0, drift: 0, set: null });
    }
  }
  return {
    provenance: CURRENT_FIELD_PROVENANCE,
    sampledAt: Number.NaN,
    columns,
    rows,
    glyphs,
    sample: { x: 0, y: 0 },
  };
}

/** Direct field evidence. No boat pose or recorded component enters this model. */
export function sampleCurrentFieldGrid(
  race: RaceData,
  t: number,
  grid: CurrentFieldGrid,
): CurrentFieldGrid {
  for (let index = 0; index < grid.glyphs.length; index++) {
    const glyph = grid.glyphs[index];
    const sampled = sampleSeededCurrentField(
      race.environment.current,
      glyph.x,
      glyph.y,
      t,
      grid.sample,
    );
    glyph.currentX = sampled.x;
    glyph.currentY = sampled.y;
    glyph.drift = Math.hypot(sampled.x, sampled.y);
    glyph.set = glyph.drift <= 1e-12
      ? null
      : ((Math.atan2(sampled.x, sampled.y) * 180) / Math.PI + 360) % 360;
  }
  grid.sampledAt = t;
  return grid;
}

export interface VectorSurfaceLeg {
  x: number;
  y: number;
  speed: number;
  course: number | null;
}

export interface VectorSurfaceModel {
  status: "valid" | "invalid-components";
  caption: "Recorded fix components" | "Reconstructed from recorded fixes";
  currentCaption: "Recorded current sample" | "Reconstructed current from recorded fixes";
  telemetryProvenance: Pose["telemetryProvenance"];
  water: VectorSurfaceLeg | null;
  current: VectorSurfaceLeg | null;
  ground: VectorSurfaceLeg | null;
}

function vectorLeg(): VectorSurfaceLeg {
  return { x: 0, y: 0, speed: 0, course: null };
}

export function createVectorSurfaceModel(): VectorSurfaceModel {
  return {
    status: "invalid-components",
    caption: "Recorded fix components",
    currentCaption: "Recorded current sample",
    telemetryProvenance: "recorded-fix",
    water: null,
    current: null,
    ground: null,
  };
}

function writeLeg(
  leg: VectorSurfaceLeg | null,
  x: number,
  y: number,
  speed: number,
  course: number | null,
): VectorSurfaceLeg {
  const target = leg ?? vectorLeg();
  target.x = x === 0 ? 0 : x;
  target.y = y === 0 ? 0 : y;
  target.speed = speed === 0 ? 0 : speed;
  target.course = course;
  return target;
}

/** Selected-boat replay evidence. Direct seeded field values are forbidden here. */
export function sampleVectorSurface(pose: Pose, out: VectorSurfaceModel): VectorSurfaceModel {
  const recorded = pose.telemetryProvenance === "recorded-fix";
  out.caption = recorded ? "Recorded fix components" : "Reconstructed from recorded fixes";
  out.currentCaption = recorded
    ? "Recorded current sample"
    : "Reconstructed current from recorded fixes";
  out.telemetryProvenance = pose.telemetryProvenance;
  let velocity: DerivedVelocity;
  try {
    velocity = velocityFromComponents(
      pose.waterX,
      pose.waterY,
      pose.currentX,
      pose.currentY,
      {},
    );
  } catch {
    out.status = "invalid-components";
    out.water = null;
    out.current = null;
    out.ground = null;
    return out;
  }
  out.status = "valid";
  out.water = writeLeg(out.water, velocity.waterX, velocity.waterY, velocity.stw, velocity.ctw);
  out.current = writeLeg(
    out.current,
    velocity.currentX,
    velocity.currentY,
    velocity.currentDrift,
    velocity.currentSet,
  );
  out.ground = writeLeg(
    out.ground,
    velocity.groundX,
    velocity.groundY,
    velocity.sog,
    velocity.cog,
  );
  return out;
}

const truthRaceIds = new WeakMap<RaceData, number>();
let nextTruthRaceId = 1;

/** Weak identity: regenerated same-ID races cannot share marker coordinates. */
export function chartTruthMarkerCacheKey(
  race: RaceData,
  followId: string,
  mode: ReplayMode,
  truthMode: boolean,
  windowStart: number,
  windowEnd: number,
): string {
  let raceId = truthRaceIds.get(race);
  if (raceId === undefined) {
    raceId = nextTruthRaceId++;
    truthRaceIds.set(race, raceId);
  }
  return `${raceId}|${followId}|${mode}|${truthMode ? 1 : 0}|${windowStart}|${windowEnd}`;
}

interface FieldAdapters {
  wind: (x: number, y: number, t: number, out: WindFromVector) => WindFromVector;
  current: (x: number, y: number, t: number, out: Vec2) => Vec2;
}

const fieldAdapters = new WeakMap<RaceData, FieldAdapters>();

function adaptersFor(race: RaceData): FieldAdapters {
  const known = fieldAdapters.get(race);
  if (known !== undefined) return known;
  const windSample: WindSample = { t: 0, twd: 0, tws: 0 };
  const adapters: FieldAdapters = {
    wind: (_x, _y, t, out) => {
      windAt(race, t, windSample);
      const radians = (windSample.twd * Math.PI) / 180;
      out.windFromX = windSample.tws * Math.sin(radians);
      out.windFromY = windSample.tws * Math.cos(radians);
      return out;
    },
    current: (x, y, t, out) =>
      sampleSeededCurrentField(race.environment.current, x, y, t, out),
  };
  fieldAdapters.set(race, adapters);
  return adapters;
}

function fixAtOrBefore(race: RaceData, boatId: string, t: number): number {
  const fixes = race.fixes[boatId] ?? [];
  if (fixes.length === 0) return -1;
  if (t <= fixes[0].t) return 0;
  const last = fixes.length - 1;
  if (t >= fixes[last].t) return last;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (fixes[middle].t <= t) low = middle;
    else high = middle;
  }
  return low;
}

export interface InspectionTraceSurfaceEntry {
  side: "port" | "starboard";
  trace: LaylineTrace;
}

export interface LaylineInspectionSurface {
  boatId: string;
  fixIndex: number;
  sampledAt: number | null;
  leg: "beat" | "run" | null;
  pace: number | null;
  declaredTwaAbs: number | null;
  provenance: typeof CURRENT_FIELD_PROVENANCE;
  traces: readonly InspectionTraceSurfaceEntry[];
}

export interface LaylineSvgPath {
  readonly side: "port" | "starboard";
  readonly d: string;
  readonly pointCount: number;
  readonly sampledAt: number;
  readonly provenance: typeof CURRENT_FIELD_PROVENANCE;
}

function surfaceOwnData(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function surfaceArray(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function svgNumber(value: number): string {
  return String(value === 0 ? 0 : value);
}

/** Pure adapter: consumes cached inspection traces and never derives a layline. */
export function laylineInspectionSvgPaths(value: unknown): readonly LaylineSvgPath[] {
  const provenance = surfaceOwnData(value, "provenance");
  const sampledAt = surfaceOwnData(value, "sampledAt");
  const traces = surfaceOwnData(value, "traces");
  if (
    provenance !== CURRENT_FIELD_PROVENANCE ||
    typeof sampledAt !== "number" ||
    !Number.isFinite(sampledAt) ||
    !surfaceArray(traces)
  ) {
    return Object.freeze([]);
  }
  const paths: LaylineSvgPath[] = [];
  for (let index = 0; index < traces.length && paths.length < INSPECTION_MAX_TRACES; index++) {
    const entry = surfaceOwnData(traces, index);
    const side = surfaceOwnData(entry, "side");
    const trace = surfaceOwnData(entry, "trace");
    const status = surfaceOwnData(trace, "status");
    const points = surfaceOwnData(trace, "points");
    if (
      (side !== "port" && side !== "starboard") ||
      status === "invalid" ||
      !surfaceArray(points) ||
      points.length < 2 ||
      points.length > INSPECTION_MAX_STEPS + 1
    ) {
      continue;
    }
    const commands: string[] = [];
    let valid = true;
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      const point = surfaceOwnData(points, pointIndex);
      const x = surfaceOwnData(point, "x");
      const y = surfaceOwnData(point, "y");
      const t = surfaceOwnData(point, "t");
      if (
        typeof x !== "number" || !Number.isFinite(x) ||
        typeof y !== "number" || !Number.isFinite(y) ||
        typeof t !== "number" || !Number.isFinite(t)
      ) {
        valid = false;
        break;
      }
      commands.push(`${pointIndex === 0 ? "M" : "L"}${svgNumber(x)} ${svgNumber(-y)}`);
    }
    if (!valid) continue;
    paths.push(Object.freeze({
      side,
      d: commands.join(" "),
      pointCount: points.length,
      sampledAt,
      provenance: CURRENT_FIELD_PROVENANCE,
    }));
  }
  return Object.freeze(paths);
}

const EMPTY_TRACES: readonly InspectionTraceSurfaceEntry[] = Object.freeze([]);

/** Max port + starboard for one selected boat, anchored to one recorded fix. */
export function buildLaylineInspectionSurface(
  race: RaceData,
  boatId: string,
  replayTime: number,
): LaylineInspectionSurface {
  const fixIndex = fixAtOrBefore(race, boatId, replayTime);
  const fix = fixIndex < 0 ? null : race.fixes[boatId][fixIndex];
  if (fix === null) {
    return Object.freeze({
      boatId,
      fixIndex: -1,
      sampledAt: null,
      leg: null,
      pace: null,
      declaredTwaAbs: null,
      provenance: CURRENT_FIELD_PROVENANCE,
      traces: EMPTY_TRACES,
    });
  }
  const replayLeg = legAt(race, boatId, fix.t);
  const leg = replayLeg === "beat" || replayLeg === "run" ? replayLeg : null;
  const declaredTwaAbs = leg === null ? null : Math.abs(fix.twa);
  const wind = windAt(race, fix.t, { t: 0, twd: 0, tws: 0 });
  const target = declaredTwaAbs === null
    ? null
    : targetBoatSpeed(FICTIONAL_ONE_DESIGN_POLAR, wind.tws, declaredTwaAbs);
  const stw = Math.hypot(fix.waterX, fix.waterY);
  const pace = target !== null && target > 0 ? stw / target : null;
  if (leg === null || declaredTwaAbs === null || pace === null || !Number.isFinite(pace)) {
    return Object.freeze({
      boatId,
      fixIndex,
      sampledAt: fix.t,
      leg,
      pace: null,
      declaredTwaAbs,
      provenance: CURRENT_FIELD_PROVENANCE,
      traces: EMPTY_TRACES,
    });
  }

  const spec = race.environment.current;
  const bounds = {
    minX: spec.halfWidthMeters * spec.uMin,
    maxX: spec.halfWidthMeters * spec.uMax,
    minY: spec.lengthMeters * spec.vMin,
    maxY: spec.lengthMeters * spec.vMax,
  };
  const mark = leg === "beat"
    ? race.course.windward
    : {
        x: (race.course.startPin.x + race.course.startBoat.x) * 0.5,
        y: (race.course.startPin.y + race.course.startBoat.y) * 0.5,
      };
  const adapters = adaptersFor(race);
  const traces: InspectionTraceSurfaceEntry[] = (["port", "starboard"] as const).map((side) => ({
    side,
    trace: cachedTraceLaylineInspection({
      race,
      boatId,
      windSpec: race.wind,
      currentSpec: spec,
      polarModel: FICTIONAL_ONE_DESIGN_POLAR,
      trace: {
        start: { x: fix.x, y: fix.y, t: fix.t, recordedFixIndex: fixIndex },
        mark,
        leg,
        side,
        pace,
        declaredTwaAbs,
        bounds,
        sampleWindField: adapters.wind,
        sampleCurrentField: adapters.current,
        polarModel: FICTIONAL_ONE_DESIGN_POLAR,
      },
    }),
  }));
  for (const entry of traces) Object.freeze(entry);
  Object.freeze(traces);
  return Object.freeze({
    boatId,
    fixIndex,
    sampledAt: fix.t,
    leg,
    pace,
    declaredTwaAbs,
    provenance: CURRENT_FIELD_PROVENANCE,
    traces,
  });
}

export interface InspectionCadenceInput {
  race: RaceData;
  boatId: string;
  mode: ReplayMode;
  t: number;
  playing: boolean;
  frozen: boolean;
}

export interface InspectionPlayingCadenceBudget {
  playingSecond: number | null;
}

export interface InspectionCadenceState {
  race: RaceData | null;
  boatId: string;
  mode: ReplayMode;
  playingSecond: number | null;
  refreshedT: number | null;
  pendingT: number | null;
  dueAtMs: number | null;
  budget: InspectionPlayingCadenceBudget;
}

export interface InspectionCadenceResult {
  action: "refresh" | "schedule" | "hold";
  dueAtMs: number | null;
  state: InspectionCadenceState;
}

export function createInspectionPlayingCadenceBudget(): InspectionPlayingCadenceBudget {
  return { playingSecond: null };
}

export function createInspectionCadence(
  budget = createInspectionPlayingCadenceBudget(),
): InspectionCadenceState {
  return {
    race: null,
    boatId: "",
    mode: "smooth",
    playingSecond: budget.playingSecond,
    refreshedT: null,
    pendingT: null,
    dueAtMs: null,
    budget,
  };
}

function cadenceResult(
  state: InspectionCadenceState,
  action: InspectionCadenceResult["action"],
): InspectionCadenceResult {
  return { action, dueAtMs: state.dueAtMs, state };
}

/** Replay-time cadence only; wall time controls the paused debounce, never trace inputs. */
export function inspectionCadenceStep(
  previous: InspectionCadenceState,
  input: InspectionCadenceInput,
  nowMs: number,
): InspectionCadenceResult {
  const identityChanged =
    previous.race !== input.race ||
    previous.boatId !== input.boatId ||
    previous.mode !== input.mode;
  if (input.frozen) {
    if (!identityChanged && previous.refreshedT === input.t) return cadenceResult(previous, "hold");
    return cadenceResult({
      ...previous,
      race: input.race,
      boatId: input.boatId,
      mode: input.mode,
      refreshedT: input.t,
      pendingT: null,
      dueAtMs: null,
    }, "refresh");
  }
  if (input.playing) {
    const second = Math.floor(input.t);
    if (previous.budget.playingSecond === second) {
      return cadenceResult({
        ...previous,
        race: input.race,
        boatId: input.boatId,
        mode: input.mode,
        playingSecond: second,
        refreshedT: identityChanged ? null : previous.refreshedT,
        pendingT: null,
        dueAtMs: null,
      }, "hold");
    }
    previous.budget.playingSecond = second;
    return cadenceResult({
      ...previous,
      race: input.race,
      boatId: input.boatId,
      mode: input.mode,
      playingSecond: second,
      refreshedT: input.t,
      pendingT: null,
      dueAtMs: null,
    }, "refresh");
  }
  if (!identityChanged && previous.refreshedT === input.t) return cadenceResult(previous, "hold");
  if (identityChanged || previous.pendingT !== input.t || previous.dueAtMs === null) {
    return cadenceResult({
      ...previous,
      race: input.race,
      boatId: input.boatId,
      mode: input.mode,
      pendingT: input.t,
      dueAtMs: nowMs + INSPECTION_PAUSED_SETTLE_MS,
    }, "schedule");
  }
  if (nowMs < previous.dueAtMs) return cadenceResult(previous, "hold");
  return cadenceResult({
    ...previous,
    refreshedT: input.t,
    pendingT: null,
    dueAtMs: null,
  }, "refresh");
}
