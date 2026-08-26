import {
  ANALYSIS_WORKSPACE_IDS,
  ANALYSIS_WORKSPACE_PRESETS,
  ANALYSIS_LAYER_IDS,
  type AnalysisWorkspaceSession,
  type AnalysisPanelId,
  type LayerId,
  type LayerOverride,
  type AnalysisTimelineLaneId,
  type AnalysisWorkspaceId,
  type ResolvedAnalysisWorkspace,
} from "./analysis-state";
import type { AnalysisRange, RangeComparison } from "./comparison";
import { fixStamp } from "./format";
import {
  STAGE7_ANALYSIS_LAYER_CAPABILITIES,
  type AnalysisLayerCapabilities,
} from "./analysis-layers";

export const ANALYSIS_WORKSPACE_PANEL_ID = "analysis-workspace-panel";
export const ANALYSIS_TIMELINE_PHONE_MAX_HEIGHT_PX = 320;

export type AnalysisWorkspacePanelDock = "left" | "right";

/** Keep each task surface inside the console dock whose shape fits its facts. */
export function analysisWorkspacePanelDock(
  panel: AnalysisPanelId,
): AnalysisWorkspacePanelDock {
  if (panel === "truth-provenance") return "right";
  return "left";
}

export interface AnalysisWorkspaceTabModel {
  readonly id: AnalysisWorkspaceId;
  readonly label: string;
  readonly role: "tab";
  readonly selected: boolean;
  readonly tabIndex: 0 | -1;
  readonly tabId: string;
  readonly controls: typeof ANALYSIS_WORKSPACE_PANEL_ID;
}

export type AnalysisWorkspaceTabKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";
export type AnalysisWorkspaceSelect = (workspaceId: AnalysisWorkspaceId) => void;

const LAYER_LABELS: Readonly<Record<LayerId, string>> = Object.freeze({
  tracks: "Tracks",
  laylines: "Laylines",
  current: "Current",
  wind: "Wind",
  performance: "Performance",
  "raw-fixes": "Raw fixes",
});

export type AnalysisLayerControlValue = LayerOverride | "default";

export interface AnalysisLayerControlModel {
  readonly id: LayerId;
  readonly label: string;
  readonly value: AnalysisLayerControlValue;
  readonly defaultVisible: boolean;
  readonly resolvedVisible: boolean;
  readonly available: boolean;
  readonly unavailableWitness: string | null;
}

export function analysisLayerControlModels(
  session: Pick<AnalysisWorkspaceSession, "active" | "layerOverrides">,
  workspace: Pick<ResolvedAnalysisWorkspace, "layers">,
  capabilities: AnalysisLayerCapabilities = STAGE7_ANALYSIS_LAYER_CAPABILITIES,
): readonly Readonly<AnalysisLayerControlModel>[] {
  const presetValue = ANALYSIS_WORKSPACE_PRESETS[session.active];
  return Object.freeze(ANALYSIS_LAYER_IDS.map((id) => {
    const layerCapability = capabilities[id];
    return Object.freeze({
      id,
      label: LAYER_LABELS[id],
      value: session.layerOverrides[id] ?? "default",
      defaultVisible: presetValue.layerIntent[id] === "on",
      resolvedVisible: layerCapability.available && workspace.layers[id],
      available: layerCapability.available,
      unavailableWitness: layerCapability.unavailableWitness,
    });
  }));
}

export function analysisWorkspaceTabId(id: AnalysisWorkspaceId): string {
  return `analysis-workspace-tab-${id}`;
}

export function analysisWorkspaceTabModel(
  active: AnalysisWorkspaceId,
): readonly AnalysisWorkspaceTabModel[] {
  return Object.freeze(
    ANALYSIS_WORKSPACE_IDS.map((id) =>
      Object.freeze({
        id,
        label: ANALYSIS_WORKSPACE_PRESETS[id].label,
        role: "tab" as const,
        selected: id === active,
        tabIndex: id === active ? 0 as const : -1 as const,
        tabId: analysisWorkspaceTabId(id),
        controls: ANALYSIS_WORKSPACE_PANEL_ID,
      }),
    ),
  );
}

export function nextAnalysisWorkspaceTabId(
  current: AnalysisWorkspaceId,
  key: string,
): AnalysisWorkspaceId | null {
  const index = ANALYSIS_WORKSPACE_IDS.indexOf(current);
  if (index < 0) return null;
  if (key === "Home") return ANALYSIS_WORKSPACE_IDS[0];
  if (key === "End") return ANALYSIS_WORKSPACE_IDS[ANALYSIS_WORKSPACE_IDS.length - 1];
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const delta = key === "ArrowRight" ? 1 : -1;
  const next = (index + delta + ANALYSIS_WORKSPACE_IDS.length) % ANALYSIS_WORKSPACE_IDS.length;
  return ANALYSIS_WORKSPACE_IDS[next];
}

export function workspaceTabSelectionIntent(
  current: AnalysisWorkspaceId,
  key: string,
): Readonly<{ workspaceId: AnalysisWorkspaceId; handled: boolean }> {
  const workspaceId = nextAnalysisWorkspaceTabId(current, key);
  return workspaceId === null
    ? Object.freeze({ workspaceId: current, handled: false })
    : Object.freeze({ workspaceId, handled: true });
}

export function selectAnalysisWorkspaceTab(
  workspaceId: AnalysisWorkspaceId,
  onSelect: AnalysisWorkspaceSelect,
): AnalysisWorkspaceId {
  onSelect(workspaceId);
  return workspaceId;
}

export function analysisWorkspaceSelectedRange(
  workspace: Pick<ResolvedAnalysisWorkspace, "range"> | null,
  legacyRange: AnalysisRange,
): Readonly<AnalysisRange> {
  return Object.freeze({ ...(workspace?.range ?? legacyRange) });
}

export function analysisRangeEvidenceTarget(
  range: Readonly<AnalysisRange>,
  edge: "in" | "out",
): Readonly<{ range: Readonly<AnalysisRange>; seekTo: number }> {
  return Object.freeze({ range, seekTo: edge === "in" ? range.from : range.to });
}

export function comparisonRangeEvidence(
  comparison: Pick<RangeComparison, "range">,
): Readonly<{
  range: Readonly<AnalysisRange>;
  rangeLabel: string;
  in: Readonly<{ label: string; range: Readonly<AnalysisRange>; seekTo: number }>;
  out: Readonly<{ label: string; range: Readonly<AnalysisRange>; seekTo: number }>;
}> {
  const range = comparison.range;
  const inTarget = analysisRangeEvidenceTarget(range, "in");
  const outTarget = analysisRangeEvidenceTarget(range, "out");
  return Object.freeze({
    range,
    rangeLabel: `${fixStamp(inTarget.seekTo)} to ${fixStamp(outTarget.seekTo)}`,
    in: Object.freeze({ label: `Seek IN ${fixStamp(inTarget.seekTo)}`, ...inTarget }),
    out: Object.freeze({ label: `Seek OUT ${fixStamp(outTarget.seekTo)}`, ...outTarget }),
  });
}

export type AnalysisWorkspacePanelSurface =
  | "none"
  | "start-line"
  | "comparison"
  | "performance-unavailable"
  | "truth-inspector";

export interface AnalysisWorkspacePanelModel {
  readonly panelId: AnalysisPanelId;
  readonly surface: AnalysisWorkspacePanelSurface;
  readonly available: boolean;
  readonly title: string;
  readonly description: string;
}

export function analysisWorkspacePanelModel(
  workspace: ResolvedAnalysisWorkspace,
): Readonly<AnalysisWorkspacePanelModel> {
  if (workspace.panel === "standings-leg-summary") {
    return Object.freeze({
      panelId: workspace.panel,
      surface: "none",
      available: true,
      title: "Overview",
      description: "Replay overview with fleet order in the selected race sidebar.",
    });
  }
  if (workspace.panel === "start-line") {
    return Object.freeze({
      panelId: workspace.panel,
      surface: "start-line",
      available: true,
      title: "Start",
      description: "Start-line evidence is available before the gun.",
    });
  }
  if (workspace.panel === "comparison") {
    return Object.freeze({
      panelId: workspace.panel,
      surface: "comparison",
      available: true,
      title: "Compare",
      description: "Ground-reference comparison over the selected replay range.",
    });
  }
  if (workspace.panel === "truth-provenance") {
    return Object.freeze({
      panelId: workspace.panel,
      surface: "truth-inspector",
      available: true,
      title: "Evidence",
      description: "Recorded fixes and reconstructed state on the shared replay clock.",
    });
  }
  return Object.freeze({
    panelId: workspace.panel,
    surface: "performance-unavailable",
    available: false,
    title: "Performance",
    description: "Polar performance evidence is unavailable in this build.",
  });
}

const TIMELINE_LANE_SET = new Set<AnalysisTimelineLaneId>([
  "phase",
  "start",
  "event",
  "maneuver",
  "gain-loss",
  "raw-fix",
]);

const TIMELINE_ROW_HEIGHT: Readonly<Record<Exclude<AnalysisTimelineLaneId, "raw-fix">, number>> =
  Object.freeze({
    start: 24,
    phase: 24,
    event: 64,
    maneuver: 64,
    "gain-loss": 40,
  });

export interface AnalysisTimelineRowModel {
  readonly id: Exclude<AnalysisTimelineLaneId, "raw-fix">;
  readonly labelGridRow: number;
  readonly railGridRow: number;
}

export interface AnalysisTimelineLayout {
  readonly visibleLaneIds: readonly AnalysisTimelineLaneId[];
  readonly rows: readonly AnalysisTimelineRowModel[];
  readonly showRawFixes: boolean;
  readonly replayLabelGridRow: number;
  readonly replayRailGridRow: number;
  readonly clockGridRow: number;
  readonly heightBudgetPx: number;
}

export function analysisTimelineLayout(
  laneIds: readonly unknown[],
  comparisonAvailable: boolean,
): Readonly<AnalysisTimelineLayout> {
  const seen = new Set<AnalysisTimelineLaneId>();
  const visibleLaneIds: AnalysisTimelineLaneId[] = [];
  for (const value of laneIds) {
    if (typeof value !== "string" || !TIMELINE_LANE_SET.has(value as AnalysisTimelineLaneId)) {
      continue;
    }
    const laneId = value as AnalysisTimelineLaneId;
    if (seen.has(laneId) || (laneId === "gain-loss" && !comparisonAvailable)) continue;
    seen.add(laneId);
    visibleLaneIds.push(laneId);
  }

  const rows: AnalysisTimelineRowModel[] = [];
  for (const laneId of visibleLaneIds) {
    if (laneId === "raw-fix") continue;
    const labelGridRow = rows.length * 2 + 2;
    rows.push(Object.freeze({ id: laneId, labelGridRow, railGridRow: labelGridRow + 1 }));
  }
  const replayLabelGridRow = rows.length * 2 + 2;
  const replayRailGridRow = replayLabelGridRow + 1;
  const rowHeight = rows.reduce((total, row) => total + TIMELINE_ROW_HEIGHT[row.id], 0);
  const heightBudgetPx = Math.min(
    ANALYSIS_TIMELINE_PHONE_MAX_HEIGHT_PX,
    76 + rowHeight + rows.length * 14 + (rows.length * 2 + 3) * 4,
  );

  return Object.freeze({
    visibleLaneIds: Object.freeze(visibleLaneIds),
    rows: Object.freeze(rows),
    showRawFixes: seen.has("raw-fix"),
    replayLabelGridRow,
    replayRailGridRow,
    clockGridRow: replayRailGridRow + 1,
    heightBudgetPx,
  });
}
