"use client";

import type { ReactNode } from "react";
import styles from "@/app/layline.module.css";
import type { ResolvedAnalysisWorkspace } from "@/lib/layline/analysis-state";
import type { RangeComparison } from "@/lib/layline/comparison";
import type { LaylineInspectionSurface } from "@/lib/layline/surfaces";
import type { RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { ComparisonPanel } from "./ComparisonPanel";
import { StartLine } from "./StartLine";
import { TruthInspector } from "./TruthInspector";
import {
  ANALYSIS_WORKSPACE_PANEL_ID,
  analysisWorkspacePanelModel,
} from "@/lib/layline/analysis-workspace-ui";

export function AnalysisWorkspacePanel({
  race,
  workspace,
  comparison,
  inspection,
}: {
  race: RaceData;
  workspace: ResolvedAnalysisWorkspace;
  comparison: RangeComparison;
  inspection?: LaylineInspectionSurface | null;
}) {
  const model = analysisWorkspacePanelModel(workspace);
  let surface: ReactNode = null;
  if (model.surface === "none") {
    surface = null;
  } else if (model.surface === "start-line") {
    surface = (
      <div className={styles.analysisWorkspacePanelSurface}>
        <p className={styles.analysisWorkspacePanelNote}>{model.description}</p>
        <StartLine race={race} />
        {/* After the gun the readings above take themselves off the panel, so
            this is the way back: one seek to the head of the prestart. */}
        <button
          type="button"
          className={styles.startSeek}
          data-control="seek-start"
          onClick={() => useReplay.getState().seek(race.tMin)}
        >
          Go to the start
        </button>
      </div>
    );
  } else if (model.surface === "comparison") {
    surface = <ComparisonPanel race={race} comparison={comparison} />;
  } else if (model.surface === "truth-inspector") {
    surface = <TruthInspector race={race} inspection={inspection} />;
  } else {
    surface = (
      <section className={styles.analysisWorkspaceUnavailable} aria-label={model.title}>
        <h2 className={styles.dockLabel}>{model.title}</h2>
        <p role="status">{model.description}</p>
        <p>Replay telemetry and maneuver evidence remain available on the shared timeline.</p>
      </section>
    );
  }

  return (
    <div
      id={ANALYSIS_WORKSPACE_PANEL_ID}
      className={styles.analysisWorkspacePanel}
      role="tabpanel"
      aria-label={model.title}
      tabIndex={0}
      data-analysis-panel={model.panelId}
      data-analysis-capability={model.available ? "available" : "unavailable"}
      data-analysis-flow="panel"
    >
      {surface}
    </div>
  );
}
