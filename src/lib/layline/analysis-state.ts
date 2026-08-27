import {
  normalizeAnalysisRange,
  type AnalysisRange,
  type ComparisonReference,
} from "./comparison";
import { clampTimelineWindow, type TimelineWindow } from "./timeline";
import { FIX_HZ, type RaceData } from "./types";

export interface AnalysisState {
  focusSpanSeconds: number | null;
  focusCenterSeconds: number;
  selectedRange: AnalysisRange;
  rangePinned: boolean;
  reference: ComparisonReference;
}

export interface AnalysisOwnerState {
  followId: string;
  analysis: AnalysisState;
}

export type AnalysisEvidenceEdge = "in" | "out";

export type AnalysisAction =
  | { type: "set-focus"; spanSeconds: number | null; centerSeconds?: number }
  | { type: "recenter-focus"; centerSeconds: number }
  | { type: "set-range"; from: number; to: number; pinned?: boolean }
  | { type: "set-range-in"; at: number }
  | { type: "set-range-out"; at: number }
  | { type: "use-focus" }
  | { type: "reset-range" }
  | { type: "set-reference"; reference: ComparisonReference };

function copyReference(reference: ComparisonReference): ComparisonReference {
  return reference.kind === "boat"
    ? { kind: "boat", boatId: reference.boatId }
    : { kind: "fleet-median", boatIds: [...reference.boatIds] };
}

function fleetReference(race: RaceData): ComparisonReference {
  return { kind: "fleet-median", boatIds: race.boats.map((boat) => boat.id) };
}

function validReference(
  race: RaceData,
  reference: ComparisonReference,
  primaryBoatId: string,
): ComparisonReference {
  const knownIds = new Set(race.boats.map((boat) => boat.id));
  if (reference.kind === "boat") {
    if (knownIds.has(reference.boatId) && reference.boatId !== primaryBoatId) {
      return copyReference(reference);
    }
    const rival = race.boats.find((boat) => boat.id !== primaryBoatId);
    return rival === undefined ? fleetReference(race) : { kind: "boat", boatId: rival.id };
  }

  const requested = new Set(reference.boatIds);
  const boatIds = race.boats
    .map((boat) => boat.id)
    .filter((boatId) => requested.has(boatId));
  return boatIds.length === 0 ? fleetReference(race) : { kind: "fleet-median", boatIds };
}

export function analysisFocusWindow(race: RaceData, state: AnalysisState): TimelineWindow {
  return clampTimelineWindow(race, state.focusCenterSeconds, state.focusSpanSeconds);
}

export function createAnalysisState(
  race: RaceData,
  replayTime: number,
  reference: ComparisonReference = {
    kind: "fleet-median",
    boatIds: race.boats.map((boat) => boat.id),
  },
): AnalysisState {
  const center = Number.isFinite(replayTime)
    ? Math.min(race.tMax, Math.max(race.tMin, replayTime))
    : race.tMin;
  return {
    focusSpanSeconds: null,
    focusCenterSeconds: center,
    selectedRange: normalizeAnalysisRange(race, race.tMin, race.tMax),
    rangePinned: false,
    reference: copyReference(reference),
  };
}

/**
 * Clamp race-owned intent and repair a stale or self-referential rival. Viewer
 * and replay fields are deliberately outside this function.
 */
export function reconcileAnalysisState(
  race: RaceData,
  state: AnalysisState,
  primaryBoatId: string,
): AnalysisState {
  const focusSpanSeconds =
    state.focusSpanSeconds === null ||
    !Number.isFinite(state.focusSpanSeconds) ||
    state.focusSpanSeconds <= 0
      ? null
      : state.focusSpanSeconds;
  const focus = clampTimelineWindow(
    race,
    state.focusCenterSeconds,
    focusSpanSeconds,
  );
  const selectedRange =
    Number.isFinite(state.selectedRange.from) && Number.isFinite(state.selectedRange.to)
      ? normalizeAnalysisRange(race, state.selectedRange.from, state.selectedRange.to)
      : normalizeAnalysisRange(race, race.tMin, race.tMax);
  return {
    focusSpanSeconds,
    focusCenterSeconds: focus.from + focus.span / 2,
    selectedRange,
    rangePinned: state.rangePinned,
    reference: validReference(race, state.reference, primaryBoatId),
  };
}

/** Apply analysis intent without touching replay time, playback or viewer state. */
export function transitionAnalysisOwner<TState extends AnalysisOwnerState>(
  race: RaceData,
  state: TState,
  action: AnalysisAction,
): TState {
  return {
    ...state,
    analysis: reconcileAnalysisState(
      race,
      transitionAnalysisState(race, state.analysis, action),
      state.followId,
    ),
  };
}

/**
 * Existing follow selection is the primary-boat authority. Invalid IDs are
 * inert; a newly self-referential named rival heals deterministically.
 */
export function transitionAnalysisPrimary<TState extends AnalysisOwnerState>(
  race: RaceData,
  state: TState,
  primaryBoatId: string,
): TState {
  if (!race.boats.some((boat) => boat.id === primaryBoatId)) return state;
  return {
    ...state,
    followId: primaryBoatId,
    analysis: reconcileAnalysisState(race, state.analysis, primaryBoatId),
  };
}

/** Resolve a range evidence action without changing the selected range. */
export function analysisEvidenceTarget(
  state: AnalysisState,
  edge: AnalysisEvidenceEdge,
): { range: AnalysisRange; seekTo: number } {
  const range = { ...state.selectedRange };
  return { range, seekTo: edge === "in" ? range.from : range.to };
}

export function transitionAnalysisState(
  race: RaceData,
  state: AnalysisState,
  action: AnalysisAction,
): AnalysisState {
  if (action.type === "set-focus") {
    if (
      (action.spanSeconds !== null &&
        (!Number.isFinite(action.spanSeconds) || action.spanSeconds <= 0)) ||
      (action.centerSeconds !== undefined && !Number.isFinite(action.centerSeconds))
    ) {
      return state;
    }
    const center = action.centerSeconds ?? state.focusCenterSeconds;
    const window = clampTimelineWindow(race, center, action.spanSeconds);
    return {
      ...state,
      focusSpanSeconds: action.spanSeconds,
      focusCenterSeconds: window.from + window.span / 2,
    };
  }
  if (action.type === "recenter-focus") {
    if (!Number.isFinite(action.centerSeconds)) return state;
    const window = clampTimelineWindow(race, action.centerSeconds, state.focusSpanSeconds);
    return { ...state, focusCenterSeconds: window.from + window.span / 2 };
  }
  if (action.type === "set-range") {
    if (!Number.isFinite(action.from) || !Number.isFinite(action.to)) return state;
    return {
      ...state,
      selectedRange: normalizeAnalysisRange(race, action.from, action.to),
      rangePinned: action.pinned ?? true,
    };
  }
  if (action.type === "set-range-in") {
    if (!Number.isFinite(action.at)) return state;
    return {
      ...state,
      selectedRange: normalizeAnalysisRange(race, action.at, state.selectedRange.to),
      rangePinned: true,
    };
  }
  if (action.type === "set-range-out") {
    if (!Number.isFinite(action.at)) return state;
    return {
      ...state,
      selectedRange: normalizeAnalysisRange(race, state.selectedRange.from, action.at),
      rangePinned: true,
    };
  }
  if (action.type === "use-focus") {
    const focus = analysisFocusWindow(race, state);
    return {
      ...state,
      selectedRange: normalizeAnalysisRange(race, focus.from, focus.to),
      rangePinned: true,
    };
  }
  if (action.type === "reset-range") {
    return {
      ...state,
      selectedRange: normalizeAnalysisRange(race, race.tMin, race.tMax),
      rangePinned: false,
    };
  }
  return { ...state, reference: copyReference(action.reference) };
}

export const ANALYSIS_WORKSPACE_IDS = Object.freeze([
  "overview",
  "start",
  "compare",
  "performance",
  "evidence",
] as const);

export type AnalysisWorkspaceId = (typeof ANALYSIS_WORKSPACE_IDS)[number];

export const ANALYSIS_LAYER_IDS = Object.freeze([
  "tracks",
  "laylines",
  "current",
  "wind",
  "performance",
  "raw-fixes",
] as const);

export type LayerId = (typeof ANALYSIS_LAYER_IDS)[number];
export type LayerOverride = "on" | "off";
export type LayerVisibility = Readonly<Record<LayerId, boolean>>;
export type CameraIntentOwner = "preset" | "manual";
export type AnalysisTimelineLaneId =
  | "phase"
  | "start"
  | "event"
  | "maneuver"
  | "gain-loss"
  | "raw-fix";
export type AnalysisPanelId =
  | "standings-leg-summary"
  | "start-line"
  | "comparison"
  | "performance"
  | "truth-provenance";
export type AnalysisRangePolicy =
  | "whole-race"
  | "start-window"
  | "current-focus-10"
  | "current-leg";
export type AnalysisSurfaceCapability = "available" | "requires-performance-analysis";
export type AnalysisWorkspaceControl = "truth-mode" | "replay-mode";
export type AnalysisCameraRecommendation =
  | "fleet-context"
  | "start-line-context"
  | "comparison-context"
  | "performance-context";

export interface AnalysisWorkspacePreset {
  readonly id: AnalysisWorkspaceId;
  readonly label: "Overview" | "Start review" | "Compare" | "Performance" | "Evidence";
  readonly panel: AnalysisPanelId;
  readonly timelineLaneIds: readonly AnalysisTimelineLaneId[];
  readonly rangePolicy: AnalysisRangePolicy;
  readonly layerIntent: Readonly<Record<LayerId, LayerOverride>>;
  readonly surfaceCapability: AnalysisSurfaceCapability;
  readonly defaultReference: "fleet-median" | null;
  readonly controls: readonly AnalysisWorkspaceControl[];
  readonly cameraIntent: AnalysisCameraRecommendation | null;
}

export interface AnalysisWorkspaceSession extends AnalysisState {
  active: AnalysisWorkspaceId;
  layerOverrides: Partial<Record<LayerId, LayerOverride>>;
  cameraIntentOwner: CameraIntentOwner;
}

export interface AnalysisWorkspaceContext {
  primaryBoatId?: string;
  performanceAvailable?: boolean;
}

export type AnalysisWorkspaceRangeStatus =
  | "pinned"
  | "preset"
  | "primary-leg"
  | "race-lifecycle-fallback"
  | "invalid-race";

export interface ResolvedAnalysisWorkspace {
  readonly workspaceId: AnalysisWorkspaceId;
  readonly panel: AnalysisPanelId;
  readonly surfaceAvailable: boolean;
  readonly timelineLaneIds: readonly AnalysisTimelineLaneId[];
  readonly range: Readonly<AnalysisRange>;
  readonly rangeStatus: AnalysisWorkspaceRangeStatus;
  readonly layers: LayerVisibility;
  readonly controls: readonly AnalysisWorkspaceControl[];
  readonly cameraIntent: Readonly<{
    owner: CameraIntentOwner;
    recommendation: AnalysisCameraRecommendation | null;
    mayApplyRecommendation: boolean;
  }>;
}

export type AnalysisWorkspaceAction =
  | { type: "select-workspace"; workspaceId: AnalysisWorkspaceId }
  | { type: "set-layer-override"; layerId: LayerId; override: LayerOverride }
  | { type: "clear-layer-override"; layerId: LayerId }
  | { type: "reset-workspace" }
  | { type: "acquire-manual-camera" }
  | { type: "release-camera-to-preset" };

/**
 * Bounded replay subscription key for time-derived workspace ranges. The
 * epsilon lands floating arithmetic on the telemetry boundary it represents;
 * zero is canonical so selectors never distinguish +0 from -0.
 */
export function analysisReplayCadenceKey(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const key = Math.floor(value * FIX_HZ + 1e-9);
  return key === 0 ? 0 : key;
}

type WorkspaceTransitionAction = AnalysisAction | AnalysisWorkspaceAction;

const WORKSPACE_ID_SET = new Set<string>(ANALYSIS_WORKSPACE_IDS);
const LAYER_ID_SET = new Set<string>(ANALYSIS_LAYER_IDS);
const LEG_NAME_SET = new Set<string>(["prestart", "beat", "run", "finished"]);

function frozenLayerIntent(on: readonly LayerId[]): Readonly<Record<LayerId, LayerOverride>> {
  const enabled = new Set(on);
  return Object.freeze({
    tracks: enabled.has("tracks") ? "on" : "off",
    laylines: enabled.has("laylines") ? "on" : "off",
    current: enabled.has("current") ? "on" : "off",
    wind: enabled.has("wind") ? "on" : "off",
    performance: enabled.has("performance") ? "on" : "off",
    "raw-fixes": enabled.has("raw-fixes") ? "on" : "off",
  });
}

function preset(
  value: Omit<AnalysisWorkspacePreset, "timelineLaneIds" | "layerIntent" | "controls"> & {
    timelineLaneIds: AnalysisTimelineLaneId[];
    enabledLayers: LayerId[];
    controls: AnalysisWorkspaceControl[];
  },
): AnalysisWorkspacePreset {
  return Object.freeze({
    id: value.id,
    label: value.label,
    panel: value.panel,
    timelineLaneIds: Object.freeze([...value.timelineLaneIds]),
    rangePolicy: value.rangePolicy,
    layerIntent: frozenLayerIntent(value.enabledLayers),
    surfaceCapability: value.surfaceCapability,
    defaultReference: value.defaultReference,
    controls: Object.freeze([...value.controls]),
    cameraIntent: value.cameraIntent,
  });
}

export const ANALYSIS_WORKSPACE_PRESETS: Readonly<
  Record<AnalysisWorkspaceId, AnalysisWorkspacePreset>
> = Object.freeze({
  overview: preset({
    id: "overview",
    label: "Overview",
    panel: "standings-leg-summary",
    timelineLaneIds: ["phase", "event", "maneuver"],
    rangePolicy: "whole-race",
    enabledLayers: ["tracks", "laylines"],
    surfaceCapability: "available",
    defaultReference: null,
    controls: [],
    cameraIntent: "fleet-context",
  }),
  start: preset({
    id: "start",
    label: "Start review",
    panel: "start-line",
    timelineLaneIds: ["start", "phase", "event"],
    rangePolicy: "start-window",
    enabledLayers: ["tracks"],
    surfaceCapability: "available",
    defaultReference: null,
    controls: [],
    cameraIntent: "start-line-context",
  }),
  compare: preset({
    id: "compare",
    label: "Compare",
    panel: "comparison",
    timelineLaneIds: ["gain-loss", "event", "maneuver"],
    rangePolicy: "current-focus-10",
    enabledLayers: ["tracks"],
    surfaceCapability: "available",
    defaultReference: "fleet-median",
    controls: [],
    cameraIntent: "comparison-context",
  }),
  performance: preset({
    id: "performance",
    label: "Performance",
    panel: "performance",
    timelineLaneIds: ["maneuver"],
    rangePolicy: "current-leg",
    enabledLayers: ["tracks", "performance"],
    surfaceCapability: "requires-performance-analysis",
    defaultReference: null,
    controls: [],
    cameraIntent: "performance-context",
  }),
  evidence: preset({
    id: "evidence",
    label: "Evidence",
    panel: "truth-provenance",
    timelineLaneIds: ["phase", "raw-fix", "event", "maneuver"],
    rangePolicy: "current-focus-10",
    enabledLayers: ["raw-fixes"],
    surfaceCapability: "available",
    defaultReference: null,
    controls: ["truth-mode", "replay-mode"],
    cameraIntent: null,
  }),
});

function ownData(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeIsArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function plainRecord(value: unknown): Record<PropertyKey, unknown> | null {
  if (typeof value !== "object" || value === null || safeIsArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? (value as Record<PropertyKey, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface WorkspaceRaceBoatSnapshot {
  readonly id: string;
}

interface WorkspaceRaceEventSnapshot {
  readonly kind: "gun" | "rounding" | "finish";
  readonly t: number;
  readonly boatId?: string;
}

interface WorkspaceProgressSampleSnapshot {
  readonly t: number;
  readonly leg: string;
}

interface WorkspaceRaceSnapshot {
  readonly bounds: Readonly<{ tMin: number; tMax: number }> | null;
  readonly boats: readonly WorkspaceRaceBoatSnapshot[];
  readonly events: readonly WorkspaceRaceEventSnapshot[];
  readonly progress: Readonly<Record<string, readonly WorkspaceProgressSampleSnapshot[]>>;
}

interface WorkspaceContextSnapshot {
  readonly primaryBoatId?: string;
  readonly performanceAvailable: boolean;
}

type OwnDataRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

const INVALID_OWN_DATA: OwnDataRead = Object.freeze({ ok: false });

function readOwnData(value: unknown, key: PropertyKey): OwnDataRead {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return INVALID_OWN_DATA;
  }
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? { ok: true, value: descriptor.value }
      : INVALID_OWN_DATA;
  } catch {
    return INVALID_OWN_DATA;
  }
}

function hasPlainPrototype(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || safeIsArray(value)) return false;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function snapshotArray<T>(
  value: unknown,
  snapshotItem: (item: unknown) => T | null,
): readonly T[] | null {
  if (!safeIsArray(value)) return null;
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return null;
  } catch {
    return null;
  }
  const lengthRead = readOwnData(value, "length");
  if (!lengthRead.ok || typeof lengthRead.value !== "number" ||
      !Number.isSafeInteger(lengthRead.value) || lengthRead.value < 0 ||
      lengthRead.value > 1_000_000) return null;
  const result: T[] = [];
  for (let index = 0; index < lengthRead.value; index++) {
    const itemRead = readOwnData(value, index);
    if (!itemRead.ok) return null;
    const item = snapshotItem(itemRead.value);
    if (item === null) return null;
    result.push(item);
  }
  return Object.freeze(result);
}

function snapshotBoats(value: unknown): readonly WorkspaceRaceBoatSnapshot[] {
  const boats = snapshotArray(value, (item): WorkspaceRaceBoatSnapshot | null => {
    if (!hasPlainPrototype(item)) return null;
    const idRead = readOwnData(item, "id");
    return idRead.ok && typeof idRead.value === "string" && idRead.value !== ""
      ? Object.freeze({ id: idRead.value })
      : null;
  });
  if (boats === null) return Object.freeze([]);
  const seen = new Set<string>();
  for (const boat of boats) {
    if (seen.has(boat.id)) return Object.freeze([]);
    seen.add(boat.id);
  }
  return boats;
}

function snapshotEvents(value: unknown): readonly WorkspaceRaceEventSnapshot[] {
  return snapshotArray(value, (item): WorkspaceRaceEventSnapshot | null => {
    if (!hasPlainPrototype(item)) return null;
    const kindRead = readOwnData(item, "kind");
    const timeRead = readOwnData(item, "t");
    const boatIdRead = readOwnData(item, "boatId");
    if (!kindRead.ok || !timeRead.ok ||
        (kindRead.value !== "gun" && kindRead.value !== "rounding" && kindRead.value !== "finish") ||
        typeof timeRead.value !== "number" || !Number.isFinite(timeRead.value)) return null;
    if (kindRead.value === "gun") {
      if (boatIdRead.ok && typeof boatIdRead.value !== "string") return null;
      return Object.freeze(boatIdRead.ok
        ? { kind: kindRead.value, t: timeRead.value, boatId: boatIdRead.value as string }
        : { kind: kindRead.value, t: timeRead.value });
    }
    return boatIdRead.ok && typeof boatIdRead.value === "string" && boatIdRead.value !== ""
      ? Object.freeze({ kind: kindRead.value, t: timeRead.value, boatId: boatIdRead.value })
      : null;
  }) ?? Object.freeze([]);
}

function snapshotProgress(
  value: unknown,
  boats: readonly WorkspaceRaceBoatSnapshot[],
): Readonly<Record<string, readonly WorkspaceProgressSampleSnapshot[]>> {
  const empty = (): Readonly<Record<string, readonly WorkspaceProgressSampleSnapshot[]>> =>
    Object.freeze(Object.create(null) as Record<string, readonly WorkspaceProgressSampleSnapshot[]>);
  if (!hasPlainPrototype(value)) return empty();
  const result = Object.create(null) as Record<string, readonly WorkspaceProgressSampleSnapshot[]>;
  for (const boat of boats) {
    const seriesRead = readOwnData(value, boat.id);
    if (!seriesRead.ok) return empty();
    let previous = -Infinity;
    const series = snapshotArray(seriesRead.value, (item): WorkspaceProgressSampleSnapshot | null => {
      if (!hasPlainPrototype(item)) return null;
      const timeRead = readOwnData(item, "t");
      const legRead = readOwnData(item, "leg");
      if (!timeRead.ok || typeof timeRead.value !== "number" || !Number.isFinite(timeRead.value) ||
          timeRead.value < previous || !legRead.ok || typeof legRead.value !== "string" ||
          !LEG_NAME_SET.has(legRead.value)) return null;
      previous = timeRead.value;
      return Object.freeze({ t: timeRead.value, leg: legRead.value });
    });
    if (series === null) return empty();
    result[boat.id] = series;
  }
  return Object.freeze(result);
}

function snapshotWorkspaceRace(value: unknown): WorkspaceRaceSnapshot {
  const invalid = (): WorkspaceRaceSnapshot => Object.freeze({
    bounds: null,
    boats: Object.freeze([]),
    events: Object.freeze([]),
    progress: Object.freeze(Object.create(null)),
  });
  if (!hasPlainPrototype(value)) return invalid();

  const tMinRead = readOwnData(value, "tMin");
  const tMaxRead = readOwnData(value, "tMax");
  const boatsRead = readOwnData(value, "boats");
  const eventsRead = readOwnData(value, "events");
  const progressRead = readOwnData(value, "progress");
  const boats = boatsRead.ok ? snapshotBoats(boatsRead.value) : Object.freeze([]);
  const events = eventsRead.ok ? snapshotEvents(eventsRead.value) : Object.freeze([]);
  const progress = progressRead.ok
    ? snapshotProgress(progressRead.value, boats)
    : Object.freeze(Object.create(null));

  let bounds: Readonly<{ tMin: number; tMax: number }> | null = null;
  if (tMinRead.ok && tMaxRead.ok && typeof tMinRead.value === "number" &&
      typeof tMaxRead.value === "number" && Number.isFinite(tMinRead.value) &&
      Number.isFinite(tMaxRead.value) && tMaxRead.value >= tMinRead.value) {
    const fromMicros = Math.round(tMinRead.value * 1_000_000);
    const toMicros = Math.round(tMaxRead.value * 1_000_000);
    if (Number.isSafeInteger(fromMicros) && Number.isSafeInteger(toMicros)) {
      bounds = Object.freeze({
        tMin: fromMicros === 0 ? 0 : fromMicros / 1_000_000,
        tMax: toMicros === 0 ? 0 : toMicros / 1_000_000,
      });
    }
  }
  return Object.freeze({ bounds, boats, events, progress });
}

function snapshotWorkspaceContext(value: unknown): WorkspaceContextSnapshot {
  if (!hasPlainPrototype(value)) {
    return Object.freeze({ performanceAvailable: false });
  }
  const primaryRead = readOwnData(value, "primaryBoatId");
  const performanceRead = readOwnData(value, "performanceAvailable");
  return Object.freeze({
    ...(primaryRead.ok && typeof primaryRead.value === "string"
      ? { primaryBoatId: primaryRead.value }
      : {}),
    performanceAvailable: performanceRead.ok && performanceRead.value === true,
  });
}

function safeRaceBounds(race: WorkspaceRaceSnapshot): Readonly<{ tMin: number; tMax: number }> | null {
  return race.bounds;
}

function zeroRange(): AnalysisRange {
  return { from: 0, to: 0, fromMicros: 0, toMicros: 0, durationMicros: 0 };
}

function safeNormalizeRange(race: WorkspaceRaceSnapshot, from: unknown, to: unknown): AnalysisRange | null {
  const bounds = safeRaceBounds(race);
  if (bounds === null || typeof from !== "number" || typeof to !== "number") return null;
  if (bounds.tMin === bounds.tMax) {
    const atMicros = Math.round(bounds.tMin * 1_000_000);
    return {
      from: bounds.tMin,
      to: bounds.tMax,
      fromMicros: atMicros,
      toMicros: atMicros,
      durationMicros: 0,
    };
  }
  try {
    return normalizeAnalysisRange(bounds as RaceData, from, to);
  } catch {
    return null;
  }
}

function wholeRaceRange(race: WorkspaceRaceSnapshot): AnalysisRange {
  const bounds = safeRaceBounds(race);
  return bounds === null ? zeroRange() : safeNormalizeRange(race, bounds.tMin, bounds.tMax) ?? zeroRange();
}

function safeReplayTime(race: WorkspaceRaceSnapshot, replayTime: unknown): number {
  const bounds = safeRaceBounds(race);
  if (bounds === null) return 0;
  const at = typeof replayTime === "number" && Number.isFinite(replayTime)
    ? replayTime
    : bounds.tMin;
  return Math.min(bounds.tMax, Math.max(bounds.tMin, at));
}

function safeFocusWindow(
  race: WorkspaceRaceSnapshot,
  center: unknown,
  span: unknown,
): TimelineWindow | null {
  const bounds = safeRaceBounds(race);
  if (bounds === null) return null;
  const safeCenter = typeof center === "number" && Number.isFinite(center) ? center : bounds.tMin;
  const safeSpan = span === null || (typeof span === "number" && Number.isFinite(span) && span > 0)
    ? span
    : null;
  try {
    return clampTimelineWindow(bounds as Pick<RaceData, "tMin" | "tMax">, safeCenter, safeSpan);
  } catch {
    return null;
  }
}

function raceBoatIds(race: WorkspaceRaceSnapshot): string[] {
  return race.boats.map((boat) => boat.id);
}

function stringArrayData(value: unknown, rejectInvalid: boolean): string[] | null {
  if (!safeIsArray(value)) return null;
  const length = ownData(value, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 1_024) {
    return null;
  }
  const strings: string[] = [];
  for (let index = 0; index < length; index++) {
    const entry = ownData(value, index);
    if (typeof entry === "string") strings.push(entry);
    else if (rejectInvalid) return null;
  }
  return strings;
}

function sanitizeWorkspaceReference(
  race: WorkspaceRaceSnapshot,
  value: unknown,
  primaryBoatId?: string,
): ComparisonReference {
  const record = plainRecord(value);
  const knownIds = raceBoatIds(race);
  const known = new Set(knownIds);
  if (record === null) return { kind: "fleet-median", boatIds: knownIds };
  const kind = ownData(record, "kind");
  if (kind === "boat") {
    const boatId = ownData(record, "boatId");
    return typeof boatId === "string" && known.has(boatId) && boatId !== primaryBoatId
      ? { kind: "boat", boatId }
      : { kind: "fleet-median", boatIds: knownIds };
  }
  if (kind === "fleet-median") {
    const requested = ownData(record, "boatIds");
    const requestedValues = stringArrayData(requested, false);
    if (requestedValues === null) return { kind: "fleet-median", boatIds: knownIds };
    const requestedIds = new Set(requestedValues);
    const boatIds = knownIds.filter((id) => requestedIds.has(id));
    return { kind: "fleet-median", boatIds: boatIds.length === 0 ? knownIds : boatIds };
  }
  return { kind: "fleet-median", boatIds: knownIds };
}

function sanitizeLayerOverrides(value: unknown): Partial<Record<LayerId, LayerOverride>> {
  const record = plainRecord(value);
  if (record === null) return {};
  const result: Partial<Record<LayerId, LayerOverride>> = {};
  for (const layerId of ANALYSIS_LAYER_IDS) {
    const override = ownData(record, layerId);
    if (override === "on" || override === "off") result[layerId] = override;
  }
  return result;
}

function workspaceIdOf(value: unknown): AnalysisWorkspaceId {
  return typeof value === "string" && WORKSPACE_ID_SET.has(value)
    ? (value as AnalysisWorkspaceId)
    : "overview";
}

function sanitizeAnalysisWorkspaceSessionSnapshot(
  value: unknown,
  race: WorkspaceRaceSnapshot,
  replayTime: number,
  context: WorkspaceContextSnapshot,
): AnalysisWorkspaceSession {
  const record = plainRecord(value);
  const primaryBoatId = context.primaryBoatId;
  const whole = wholeRaceRange(race);
  const safeAt = safeReplayTime(race, replayTime);
  const spanValue = record === null ? null : ownData(record, "focusSpanSeconds");
  const focusSpanSeconds = spanValue === null ||
      (typeof spanValue === "number" && Number.isFinite(spanValue) && spanValue > 0)
    ? spanValue
    : null;
  const centerValue = record === null ? safeAt : ownData(record, "focusCenterSeconds");
  const focus = safeFocusWindow(race, centerValue, focusSpanSeconds);
  const rangeValue = record === null ? null : plainRecord(ownData(record, "selectedRange"));
  const selectedRange = rangeValue === null
    ? whole
    : safeNormalizeRange(
      race,
      ownData(rangeValue, "from"),
      ownData(rangeValue, "to"),
    ) ?? whole;
  const active = workspaceIdOf(record === null ? undefined : ownData(record, "active"));
  const cameraOwner = record === null ? undefined : ownData(record, "cameraIntentOwner");
  return {
    focusSpanSeconds,
    focusCenterSeconds: focus === null ? safeAt : focus.from + focus.span / 2,
    selectedRange,
    rangePinned: record !== null && ownData(record, "rangePinned") === true,
    reference: sanitizeWorkspaceReference(
      race,
      record === null ? undefined : ownData(record, "reference"),
      primaryBoatId,
    ),
    active,
    layerOverrides: sanitizeLayerOverrides(
      record === null ? undefined : ownData(record, "layerOverrides"),
    ),
    cameraIntentOwner: cameraOwner === "manual" ? "manual" : "preset",
  };
}

export function sanitizeAnalysisWorkspaceSession(
  value: unknown,
  race: RaceData,
  replayTime: number,
  context: AnalysisWorkspaceContext = {},
): AnalysisWorkspaceSession {
  return sanitizeAnalysisWorkspaceSessionSnapshot(
    value,
    snapshotWorkspaceRace(race),
    replayTime,
    snapshotWorkspaceContext(context),
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle];
  return values[middle - 1] + (values[middle] - values[middle - 1]) / 2;
}

function eventTimes(
  race: WorkspaceRaceSnapshot,
  kind: "gun" | "rounding" | "finish",
): number[] {
  const bounds = safeRaceBounds(race);
  if (bounds === null) return [];
  const times: number[] = [];
  for (const event of race.events) {
    if (event.kind !== kind) continue;
    if (event.t >= bounds.tMin && event.t <= bounds.tMax) {
      times.push(event.t);
    }
  }
  return times;
}

function primaryLegRange(
  race: WorkspaceRaceSnapshot,
  replayTime: number,
  primaryBoatId: unknown,
): AnalysisRange | null {
  if (typeof primaryBoatId !== "string" || !raceBoatIds(race).includes(primaryBoatId)) return null;
  try {
    const series = race.progress[primaryBoatId];
    if (!safeIsArray(series) || series.length === 0) return null;
    let index = 0;
    while (index + 1 < series.length && series[index + 1].t <= replayTime) index++;
    const leg = series[index].leg;
    let first = index;
    let last = index;
    while (first > 0 && series[first - 1].leg === leg) first--;
    while (last + 1 < series.length && series[last + 1].leg === leg) last++;
    return safeNormalizeRange(
      race,
      series[first].t,
      last + 1 < series.length ? series[last + 1].t : safeRaceBounds(race)?.tMax,
    );
  } catch {
    return null;
  }
}

/**
 * Race-level fallback uses the global gun plus median fleet rounding/finish
 * events. It never chooses a boat by array position.
 */
function raceLifecycleRange(race: WorkspaceRaceSnapshot, replayTime: number): AnalysisRange {
  const bounds = safeRaceBounds(race);
  if (bounds === null) return zeroRange();
  const candidates = [
    bounds.tMin,
    median(eventTimes(race, "gun")),
    median(eventTimes(race, "rounding")),
    median(eventTimes(race, "finish")),
    bounds.tMax,
  ].filter((value): value is number => value !== null && Number.isFinite(value));
  const boundaries = [...new Set(candidates.map((value) => Math.min(bounds.tMax, Math.max(bounds.tMin, value))))]
    .sort((a, b) => a - b);
  if (boundaries.length <= 1) return safeNormalizeRange(race, bounds.tMin, bounds.tMax) ?? zeroRange();
  const at = safeReplayTime(race, replayTime);
  for (let index = 0; index < boundaries.length - 1; index++) {
    if (at < boundaries[index + 1] || index === boundaries.length - 2) {
      return safeNormalizeRange(race, boundaries[index], boundaries[index + 1]) ?? zeroRange();
    }
  }
  return safeNormalizeRange(race, bounds.tMin, bounds.tMax) ?? zeroRange();
}

function presetRange(
  presetValue: AnalysisWorkspacePreset,
  race: WorkspaceRaceSnapshot,
  replayTime: number,
  context: WorkspaceContextSnapshot,
): { range: AnalysisRange; status: AnalysisWorkspaceRangeStatus } {
  const bounds = safeRaceBounds(race);
  if (bounds === null) return { range: zeroRange(), status: "invalid-race" };
  if (presetValue.rangePolicy === "whole-race") {
    return { range: wholeRaceRange(race), status: "preset" };
  }
  if (presetValue.rangePolicy === "start-window") {
    return {
      range: safeNormalizeRange(race, -10, 0) ?? wholeRaceRange(race),
      status: "preset",
    };
  }
  if (presetValue.rangePolicy === "current-focus-10") {
    const focus = safeFocusWindow(race, replayTime, 10);
    return {
      range: focus === null
        ? wholeRaceRange(race)
        : safeNormalizeRange(race, focus.from, focus.to) ?? wholeRaceRange(race),
      status: "preset",
    };
  }
  const at = safeReplayTime(race, replayTime);
  const primaryRange = primaryLegRange(race, at, context.primaryBoatId);
  return primaryRange === null
    ? { range: raceLifecycleRange(race, at), status: "race-lifecycle-fallback" }
    : { range: primaryRange, status: "primary-leg" };
}

function resolveAnalysisWorkspaceSnapshot(
  value: unknown,
  race: WorkspaceRaceSnapshot,
  replayTime: number,
  context: WorkspaceContextSnapshot,
): ResolvedAnalysisWorkspace {
  const session = sanitizeAnalysisWorkspaceSessionSnapshot(value, race, replayTime, context);
  const presetValue = ANALYSIS_WORKSPACE_PRESETS[session.active];
  const defaultRange = presetRange(presetValue, race, replayTime, context);
  const layers = {} as Record<LayerId, boolean>;
  for (const layerId of ANALYSIS_LAYER_IDS) {
    layers[layerId] = (session.layerOverrides[layerId] ?? presetValue.layerIntent[layerId]) === "on";
  }
  const recommendation = presetValue.cameraIntent;
  return Object.freeze({
    workspaceId: session.active,
    panel: presetValue.panel,
    surfaceAvailable:
      presetValue.surfaceCapability === "available" ||
      context.performanceAvailable,
    timelineLaneIds: Object.freeze([...presetValue.timelineLaneIds]),
    range: Object.freeze({ ...(session.rangePinned ? session.selectedRange : defaultRange.range) }),
    rangeStatus: session.rangePinned ? "pinned" : defaultRange.status,
    layers: Object.freeze(layers),
    controls: Object.freeze([...presetValue.controls]),
    cameraIntent: Object.freeze({
      owner: session.cameraIntentOwner,
      recommendation,
      mayApplyRecommendation: session.cameraIntentOwner === "preset" && recommendation !== null,
    }),
  });
}

export function resolveAnalysisWorkspace(
  value: unknown,
  race: RaceData,
  replayTime: number,
  context: AnalysisWorkspaceContext = {},
): ResolvedAnalysisWorkspace {
  return resolveAnalysisWorkspaceSnapshot(
    value,
    snapshotWorkspaceRace(race),
    replayTime,
    snapshotWorkspaceContext(context),
  );
}

export function reconcileAnalysisWorkspaceSession(
  race: RaceData,
  value: unknown,
  replayTime: number,
  context: AnalysisWorkspaceContext = {},
): AnalysisWorkspaceSession {
  const raceSnapshot = snapshotWorkspaceRace(race);
  const contextSnapshot = snapshotWorkspaceContext(context);
  const session = sanitizeAnalysisWorkspaceSessionSnapshot(
    value,
    raceSnapshot,
    replayTime,
    contextSnapshot,
  );
  if (session.rangePinned) return session;
  const resolved = resolveAnalysisWorkspaceSnapshot(
    session,
    raceSnapshot,
    replayTime,
    contextSnapshot,
  );
  return { ...session, selectedRange: { ...resolved.range } };
}

type SnapshotAction = WorkspaceTransitionAction;

function snapshotTransitionAction(value: unknown): SnapshotAction | null {
  const record = plainRecord(value);
  if (record === null) return null;
  const type = ownData(record, "type");
  if (type === "select-workspace") {
    const workspaceId = ownData(record, "workspaceId");
    return typeof workspaceId === "string" && WORKSPACE_ID_SET.has(workspaceId)
      ? { type, workspaceId: workspaceId as AnalysisWorkspaceId }
      : null;
  }
  if (type === "set-layer-override") {
    const layerId = ownData(record, "layerId");
    const override = ownData(record, "override");
    return typeof layerId === "string" && LAYER_ID_SET.has(layerId) &&
        (override === "on" || override === "off")
      ? { type, layerId: layerId as LayerId, override }
      : null;
  }
  if (type === "clear-layer-override") {
    const layerId = ownData(record, "layerId");
    return typeof layerId === "string" && LAYER_ID_SET.has(layerId)
      ? { type, layerId: layerId as LayerId }
      : null;
  }
  if (
    type === "reset-workspace" || type === "acquire-manual-camera" ||
    type === "release-camera-to-preset" || type === "use-focus" || type === "reset-range"
  ) {
    return { type } as SnapshotAction;
  }
  if (type === "set-focus") {
    const spanSeconds = ownData(record, "spanSeconds");
    const centerSeconds = ownData(record, "centerSeconds");
    if (
      spanSeconds !== null &&
      (typeof spanSeconds !== "number" || !Number.isFinite(spanSeconds) || spanSeconds <= 0)
    ) return null;
    if (centerSeconds !== undefined &&
        (typeof centerSeconds !== "number" || !Number.isFinite(centerSeconds))) return null;
    return centerSeconds === undefined
      ? { type, spanSeconds }
      : { type, spanSeconds, centerSeconds };
  }
  if (type === "recenter-focus") {
    const centerSeconds = ownData(record, "centerSeconds");
    return typeof centerSeconds === "number" && Number.isFinite(centerSeconds)
      ? { type, centerSeconds }
      : null;
  }
  if (type === "set-range") {
    const from = ownData(record, "from");
    const to = ownData(record, "to");
    const pinned = ownData(record, "pinned");
    if (typeof from !== "number" || !Number.isFinite(from) ||
        typeof to !== "number" || !Number.isFinite(to) ||
        (pinned !== undefined && typeof pinned !== "boolean")) return null;
    return pinned === undefined ? { type, from, to } : { type, from, to, pinned };
  }
  if (type === "set-range-in" || type === "set-range-out") {
    const at = ownData(record, "at");
    return typeof at === "number" && Number.isFinite(at) ? { type, at } : null;
  }
  if (type === "set-reference") {
    const reference = ownData(record, "reference");
    const referenceRecord = plainRecord(reference);
    if (referenceRecord === null) return null;
    const kind = ownData(referenceRecord, "kind");
    if (kind === "boat") {
      const boatId = ownData(referenceRecord, "boatId");
      return typeof boatId === "string" ? { type, reference: { kind, boatId } } : null;
    }
    if (kind === "fleet-median") {
      const boatIds = ownData(referenceRecord, "boatIds");
      const copiedBoatIds = stringArrayData(boatIds, true);
      return copiedBoatIds !== null
        ? { type, reference: { kind, boatIds: copiedBoatIds } }
        : null;
    }
  }
  return null;
}

function transitionAnalysisWorkspaceSnapshot(
  race: WorkspaceRaceSnapshot,
  value: AnalysisState | AnalysisWorkspaceSession,
  replayTime: number,
  actionValue: unknown,
  context: WorkspaceContextSnapshot,
): AnalysisWorkspaceSession {
  const action = snapshotTransitionAction(actionValue);
  if (action === null) {
    return sanitizeAnalysisWorkspaceSessionSnapshot(value, race, replayTime, context);
  }
  const session = sanitizeAnalysisWorkspaceSessionSnapshot(value, race, replayTime, context);
  if (action.type === "select-workspace") {
    const selected = { ...session, active: action.workspaceId };
    if (selected.rangePinned) return selected;
    const resolved = resolveAnalysisWorkspaceSnapshot(selected, race, replayTime, context);
    return { ...selected, selectedRange: { ...resolved.range } };
  }
  if (action.type === "set-layer-override") {
    return {
      ...session,
      layerOverrides: { ...session.layerOverrides, [action.layerId]: action.override },
    };
  }
  if (action.type === "clear-layer-override") {
    const layerOverrides = { ...session.layerOverrides };
    delete layerOverrides[action.layerId];
    return { ...session, layerOverrides };
  }
  if (action.type === "reset-workspace") {
    const reset = { ...session, rangePinned: false, layerOverrides: {} };
    const resolved = resolveAnalysisWorkspaceSnapshot(reset, race, replayTime, context);
    return { ...reset, selectedRange: { ...resolved.range } };
  }
  if (action.type === "acquire-manual-camera") {
    return { ...session, cameraIntentOwner: "manual" };
  }
  if (action.type === "release-camera-to-preset") {
    return { ...session, cameraIntentOwner: "preset" };
  }
  try {
    const bounds = safeRaceBounds(race);
    const inertRace = Object.freeze({
      tMin: bounds?.tMin ?? 0,
      tMax: bounds?.tMax ?? 0,
    }) as RaceData;
    const transitioned = transitionAnalysisState(inertRace, session, action);
    return sanitizeAnalysisWorkspaceSessionSnapshot(transitioned, race, replayTime, context);
  } catch {
    return session;
  }
}

export function transitionAnalysisWorkspace(
  race: RaceData,
  value: AnalysisState | AnalysisWorkspaceSession,
  replayTime: number,
  actionValue: unknown,
  context: AnalysisWorkspaceContext = {},
): AnalysisWorkspaceSession {
  return transitionAnalysisWorkspaceSnapshot(
    snapshotWorkspaceRace(race),
    value,
    replayTime,
    actionValue,
    snapshotWorkspaceContext(context),
  );
}

export interface AnalysisWorkspaceOwnerState {
  t: number;
  followId: string;
  analysis: AnalysisState | AnalysisWorkspaceSession;
}

interface WorkspaceOwnerSnapshot {
  readonly prototype: object | null;
  readonly extensible: boolean;
  readonly keys: readonly PropertyKey[];
  readonly descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>;
  readonly analysis: AnalysisState | AnalysisWorkspaceSession;
  readonly t: number;
  readonly followId: string;
}

function snapshotWorkspaceOwner(value: unknown): WorkspaceOwnerSnapshot | null {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return null;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    const extensible = Reflect.isExtensible(value);
    const descriptors = new Map<PropertyKey, PropertyDescriptor>();
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return null;
      descriptors.set(key, descriptor);
    }
    const analysisDescriptor = descriptors.get("analysis");
    const timeDescriptor = descriptors.get("t");
    const followDescriptor = descriptors.get("followId");
    if (analysisDescriptor === undefined || !("value" in analysisDescriptor) ||
        timeDescriptor === undefined || !("value" in timeDescriptor) ||
        followDescriptor === undefined || !("value" in followDescriptor) ||
        typeof timeDescriptor.value !== "number" || !Number.isFinite(timeDescriptor.value) ||
        typeof followDescriptor.value !== "string") return null;
    return {
      prototype,
      extensible,
      keys: Object.freeze([...keys]),
      descriptors,
      analysis: analysisDescriptor.value as AnalysisState | AnalysisWorkspaceSession,
      t: timeDescriptor.value,
      followId: followDescriptor.value,
    };
  } catch {
    return null;
  }
}

function replaceOwnerAnalysis<TState>(
  original: TState,
  snapshot: WorkspaceOwnerSnapshot,
  analysis: AnalysisWorkspaceSession,
): TState {
  try {
    const result = Object.create(snapshot.prototype) as object;
    for (const key of snapshot.keys) {
      const descriptor = snapshot.descriptors.get(key);
      if (descriptor === undefined) return original;
      const nextDescriptor = key === "analysis"
        ? { ...descriptor, value: analysis }
        : descriptor;
      if (!Reflect.defineProperty(result, key, nextDescriptor)) return original;
    }
    if (!snapshot.extensible && !Reflect.preventExtensions(result)) return original;
    return result as TState;
  } catch {
    return original;
  }
}

/** Stage 7A-only owner adapter. It replaces only the own analysis data value. */
export function transitionAnalysisWorkspaceOwner<TState extends AnalysisWorkspaceOwnerState>(
  race: RaceData,
  state: TState,
  action: unknown,
): TState {
  const owner = snapshotWorkspaceOwner(state);
  if (owner === null) return state;
  const raceSnapshot = snapshotWorkspaceRace(race);
  const context = Object.freeze({
    primaryBoatId: owner.followId,
    performanceAvailable: false,
  });
  const analysis = transitionAnalysisWorkspaceSnapshot(
    raceSnapshot,
    owner.analysis,
    owner.t,
    action,
    context,
  );
  return replaceOwnerAnalysis(state, owner, analysis);
}

export type AnalysisWorkspaceStorePatch = Readonly<{
  analysis: AnalysisWorkspaceSession;
}>;

export type AnalysisWorkspacePrimaryStorePatch = Readonly<{
  followId: string;
  analysis: AnalysisWorkspaceSession;
}>;

/**
 * Zustand-facing adapter. Unlike the descriptor-preserving generic owner
 * transition, this deliberately returns only the nested value the store may
 * merge. Invalid/revoked owners return an inert empty patch.
 */
export function transitionAnalysisWorkspacePatch(
  race: RaceData,
  state: unknown,
  action: unknown,
): AnalysisWorkspaceStorePatch | Readonly<Record<never, never>> {
  const owner = snapshotWorkspaceOwner(state);
  if (owner === null) return Object.freeze({});
  const raceSnapshot = snapshotWorkspaceRace(race);
  const context = Object.freeze({
    primaryBoatId: owner.followId,
    performanceAvailable: false,
  });
  return Object.freeze({
    analysis: transitionAnalysisWorkspaceSnapshot(
      raceSnapshot,
      owner.analysis,
      owner.t,
      action,
      context,
    ),
  });
}

/** Existing follow selection remains primary authority; this only reconciles its analysis companion. */
export function transitionAnalysisWorkspacePrimaryPatch(
  race: RaceData,
  state: unknown,
  primaryBoatId: unknown,
): AnalysisWorkspacePrimaryStorePatch | Readonly<Record<never, never>> {
  const owner = snapshotWorkspaceOwner(state);
  if (owner === null || typeof primaryBoatId !== "string") return Object.freeze({});
  const raceSnapshot = snapshotWorkspaceRace(race);
  if (!raceBoatIds(raceSnapshot).includes(primaryBoatId)) return Object.freeze({});
  const context = Object.freeze({ primaryBoatId, performanceAvailable: false });
  let session = sanitizeAnalysisWorkspaceSessionSnapshot(
    owner.analysis,
    raceSnapshot,
    owner.t,
    context,
  );
  if (!session.rangePinned) {
    const resolved = resolveAnalysisWorkspaceSnapshot(
      session,
      raceSnapshot,
      owner.t,
      context,
    );
    session = { ...session, selectedRange: { ...resolved.range } };
  }
  return Object.freeze({ followId: primaryBoatId, analysis: session });
}
