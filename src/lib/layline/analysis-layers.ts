import type { LayerId, LayerVisibility } from "./analysis-state";
import { createPose, telemetryTruthAt, truthFixWindow } from "./interpolate";
import { FIX_HZ, type Fix, type RaceData, type TelemetryTruth } from "./types";

export type AnalysisRendererSurface = "3d" | "2d" | "no-webgl";

export interface AnalysisLayerCapability {
  readonly available: boolean;
  readonly unavailableWitness: string | null;
}

export type AnalysisLayerCapabilities = Readonly<Record<LayerId, AnalysisLayerCapability>>;

export interface AnalysisLayerCapabilityFlags {
  readonly wind?: boolean;
  readonly performance?: boolean;
}

export const RAW_FIX_EVIDENCE_SPAN = 20;
export const RAW_FIX_EVIDENCE_SLOTS_PER_BOAT = RAW_FIX_EVIDENCE_SPAN * FIX_HZ + 1;

export type ReplayRawFixEvidenceKind = "none" | "fleet-window" | "truth-witness";

export interface ReplayRawFixEvidenceSlot {
  readonly slot: number;
  boatId: string | null;
  readonly boatIndex: number;
  fixIndex: number;
  fix: Fix | null;
  bracket: boolean;
}

/** Caller-owned evidence buffer. Sampling mutates slots but never replaces them. */
export interface ReplayRawFixEvidenceModel {
  readonly source: RaceData;
  kind: ReplayRawFixEvidenceKind;
  startTime: number | null;
  endTime: number | null;
  count: number;
  boatCount: number;
  truncated: boolean;
  readonly slots: ReplayRawFixEvidenceSlot[];
}

const evidenceTruthBuffers = new WeakMap<ReplayRawFixEvidenceModel, TelemetryTruth>();

const LAYERS: readonly LayerId[] = Object.freeze([
  "tracks",
  "laylines",
  "current",
  "wind",
  "performance",
  "raw-fixes",
]);

/** Story-view defaults retain the complete pre-workspace Stage 6 picture. */
export const LEGACY_REPLAY_LAYER_VISIBILITY: LayerVisibility = Object.freeze({
  tracks: true,
  laylines: true,
  current: true,
  wind: false,
  performance: false,
  "raw-fixes": false,
});

function capability(available: boolean, unavailableWitness: string): AnalysisLayerCapability {
  return Object.freeze({ available, unavailableWitness: available ? null : unavailableWitness });
}

/** Stage 8 can enable its two surfaces by passing local flags to this model. */
export function analysisLayerCapabilities(
  flags: AnalysisLayerCapabilityFlags = {},
): AnalysisLayerCapabilities {
  return Object.freeze({
    tracks: capability(true, ""),
    laylines: capability(true, ""),
    current: capability(true, ""),
    wind: capability(
      flags.wind === true,
      "Spatial wind analysis is not available yet.",
    ),
    performance: capability(
      flags.performance === true,
      "Spatial performance analysis is not available yet.",
    ),
    "raw-fixes": capability(true, ""),
  });
}

export const STAGE7_ANALYSIS_LAYER_CAPABILITIES = analysisLayerCapabilities();

function ownTrue(value: unknown, key: PropertyKey): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
  } catch {
    return false;
  }
}

function visible(value: unknown, key: LayerId): boolean {
  return ownTrue(value, key);
}

function available(value: unknown, key: LayerId): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return false;
    return ownTrue(descriptor.value, "available");
  } catch {
    return false;
  }
}

/** All renderer families receive the same sanitized booleans, never product preset IDs. */
export function rendererLayerVisibility(
  value: unknown,
  _surface: AnalysisRendererSurface,
  capabilities: AnalysisLayerCapabilities = STAGE7_ANALYSIS_LAYER_CAPABILITIES,
): LayerVisibility {
  const result = {} as Record<LayerId, boolean>;
  for (const layer of LAYERS) result[layer] = available(capabilities, layer) && visible(value, layer);
  return Object.freeze(result);
}


/** Raw evidence can be requested by its resolved layer/model or the independent truth lens. */
export function replayRawFixesVisible(value: unknown, truthMode: unknown): boolean {
  return truthMode === true || value === true || visible(value, "raw-fixes");
}

function newTruthBuffer(): TelemetryTruth {
  return {
    t: 0,
    beforeIndex: -1,
    afterIndex: -1,
    before: null,
    after: null,
    u: 0,
    raw: createPose(),
    reconstructed: createPose(),
  };
}

export function createReplayRawFixEvidenceModel(race: RaceData): ReplayRawFixEvidenceModel {
  const slots = Array.from(
    { length: race.boats.length * RAW_FIX_EVIDENCE_SLOTS_PER_BOAT },
    (_, slot): ReplayRawFixEvidenceSlot => ({
      slot,
      boatId: null,
      boatIndex: Math.floor(slot / RAW_FIX_EVIDENCE_SLOTS_PER_BOAT),
      fixIndex: -1,
      fix: null,
      bracket: false,
    }),
  );
  const model: ReplayRawFixEvidenceModel = {
    source: race,
    kind: "none",
    startTime: null,
    endTime: null,
    count: 0,
    boatCount: 0,
    truncated: false,
    slots,
  };
  evidenceTruthBuffers.set(model, newTruthBuffer());
  return model;
}

function clearRawFixEvidence(model: ReplayRawFixEvidenceModel): void {
  model.kind = "none";
  model.startTime = null;
  model.endTime = null;
  model.count = 0;
  model.boatCount = 0;
  model.truncated = false;
  for (const slot of model.slots) {
    slot.boatId = null;
    slot.fixIndex = -1;
    slot.fix = null;
    slot.bracket = false;
  }
}

function finiteRawFix(fix: Fix): boolean {
  return Number.isFinite(fix.t) && Number.isFinite(fix.x) && Number.isFinite(fix.y);
}

function writeRawFix(
  model: ReplayRawFixEvidenceModel,
  boatIndex: number,
  boatId: string,
  fixIndex: number,
  fix: Fix,
  bracket: boolean,
  writtenForBoat: number,
): void {
  if (writtenForBoat >= RAW_FIX_EVIDENCE_SLOTS_PER_BOAT) {
    model.truncated = true;
    return;
  }
  const slot = model.slots[boatIndex * RAW_FIX_EVIDENCE_SLOTS_PER_BOAT + writtenForBoat];
  if (slot === undefined) {
    model.truncated = true;
    return;
  }
  slot.boatId = boatId;
  slot.fixIndex = fixIndex;
  slot.fix = fix;
  slot.bracket = bracket;
  model.count++;
}

/**
 * Samples the measured evidence shared by 3D, 2D, and no-WebGL renderers.
 * Replay mode is deliberately absent: raw/smooth owns interpolation, not evidence.
 */
export function sampleReplayRawFixEvidence(
  race: RaceData,
  t: number,
  followId: string,
  rawFixLayer: unknown,
  truthMode: unknown,
  model: ReplayRawFixEvidenceModel,
): ReplayRawFixEvidenceModel {
  clearRawFixEvidence(model);
  if (model.source !== race || !Number.isFinite(t) || !replayRawFixesVisible(rawFixLayer, truthMode)) {
    return model;
  }

  if (truthMode === true) {
    model.kind = "truth-witness";
    const boatIndex = race.boats.findIndex((boat) => boat.id === followId);
    const fixes = race.fixes[followId];
    const truth = evidenceTruthBuffers.get(model);
    if (boatIndex < 0 || fixes === undefined || fixes.length === 0 || truth === undefined) return model;

    const reading = telemetryTruthAt(race, followId, t, truth);
    const window = truthFixWindow(fixes.length, reading.beforeIndex);
    let written = 0;
    for (let fixIndex = window.start; fixIndex < window.end; fixIndex++) {
      const fix = fixes[fixIndex];
      if (!finiteRawFix(fix)) continue;
      writeRawFix(
        model,
        boatIndex,
        followId,
        fixIndex,
        fix,
        fixIndex === reading.beforeIndex || fixIndex === reading.afterIndex,
        written,
      );
      written++;
    }
    if (written > 0) {
      model.boatCount = 1;
      const first = model.slots[boatIndex * RAW_FIX_EVIDENCE_SLOTS_PER_BOAT].fix;
      const final = model.slots[boatIndex * RAW_FIX_EVIDENCE_SLOTS_PER_BOAT + written - 1].fix;
      model.startTime = first?.t ?? null;
      model.endTime = final?.t ?? null;
    }
    return model;
  }

  model.kind = "fleet-window";
  const windowStart = Math.max(
    Number.isFinite(race.tMin) ? race.tMin : t - RAW_FIX_EVIDENCE_SPAN,
    t - RAW_FIX_EVIDENCE_SPAN,
  );
  model.startTime = windowStart;
  model.endTime = t;
  for (let boatIndex = 0; boatIndex < race.boats.length; boatIndex++) {
    const boatId = race.boats[boatIndex].id;
    const fixes = race.fixes[boatId];
    if (fixes === undefined) continue;
    let written = 0;
    for (let fixIndex = 0; fixIndex < fixes.length; fixIndex++) {
      const fix = fixes[fixIndex];
      if (!finiteRawFix(fix) || fix.t < windowStart || fix.t > t) continue;
      writeRawFix(model, boatIndex, boatId, fixIndex, fix, false, written);
      written++;
    }
    if (written > 0) model.boatCount++;
  }
  return model;
}
