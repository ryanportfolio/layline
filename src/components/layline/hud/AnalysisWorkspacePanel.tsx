"use client";

import type { ReactNode } from "react";
import styles from "@/app/layline.module.css";
import type {
  AnalysisWorkspaceSession,
  LayerId,
  LayerOverride,
  ResolvedAnalysisWorkspace,
} from "@/lib/layline/analysis-state";
import type { RangeComparison } from "@/lib/layline/comparison";
import type { LaylineInspectionSurface } from "@/lib/layline/surfaces";
import type { RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { ComparisonPanel } from "./ComparisonPanel";
import { StartLine } from "./StartLine";
import { TruthInspector } from "./TruthInspector";
import {
  ANALYSIS_WORKSPACE_PANEL_ID,
  analysisLayerControlModels,
  analysisWorkspacePanelModel,
  analysisWorkspaceTabId,
} from "@/lib/layline/analysis-workspace-ui";

export function AnalysisWorkspacePanel({
  race,
  workspace,
  session,
  comparison,
  inspection,
  vector = true,
  onLayerChange,
  onReset,
}: {
  race: RaceData;
  workspace: ResolvedAnalysisWorkspace;
  session: AnalysisWorkspaceSession;
  comparison: RangeComparison;
  inspection?: LaylineInspectionSurface | null;
  /* Forwarded to the embedded truth inspector: false while the app docks the
   * velocity triangle on its own plate. */
  vector?: boolean;
  onLayerChange: (layerId: LayerId, override: LayerOverride | "default") => void;
  onReset: () => void;
}) {
  const model = analysisWorkspacePanelModel(workspace);
  const layerControls = analysisLayerControlModels(session, workspace);
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
    surface = <TruthInspector race={race} inspection={inspection} vector={vector} />;
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
      aria-labelledby={analysisWorkspaceTabId(workspace.workspaceId)}
      tabIndex={0}
      data-analysis-panel={model.panelId}
      data-analysis-capability={model.available ? "available" : "unavailable"}
      data-analysis-flow="panel"
    >
      <details className={styles.analysisLayerDisclosure}>
        <summary>Analysis layers</summary>
        <fieldset className={styles.analysisLayerControls}>
          <legend>Visible analysis layers</legend>
          <div className={styles.analysisLayerGrid}>
            {layerControls.map((layer) => (
              layer.available ? (
                <label
                  key={layer.id}
                  className={styles.analysisLayerControl}
                  data-layer-override={layer.value}
                  data-layer-resolved={layer.resolvedVisible ? "on" : "off"}
                >
                  <span>{layer.label}</span>
                  <select
                    value={layer.value}
                    aria-label={`${layer.label} layer`}
                    onChange={(event) =>
                      onLayerChange(
                        layer.id,
                        event.currentTarget.value as LayerOverride | "default",
                      )
                    }
                  >
                    <option value="default">
                      Default ({layer.defaultVisible ? "on" : "off"})
                    </option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </label>
              ) : (
                <div
                  key={layer.id}
                  className={styles.analysisLayerUnavailable}
                  data-layer-capability="unavailable"
                  data-layer-resolved="off"
                  aria-disabled="true"
                >
                  <span>{layer.label}</span>
                  <span role="status">{layer.unavailableWitness}</span>
                </div>
              )
            ))}
          </div>
          <button type="button" className={styles.analysisLayerReset} onClick={onReset}>
            Reset range and layers
          </button>
        </fieldset>
      </details>
      {surface}
    </div>
  );
}
