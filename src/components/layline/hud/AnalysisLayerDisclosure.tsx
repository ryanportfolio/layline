"use client";

import styles from "@/app/layline.module.css";
import type {
  AnalysisWorkspaceSession,
  LayerId,
  LayerOverride,
  ResolvedAnalysisWorkspace,
} from "@/lib/layline/analysis-state";
import { analysisLayerControlModels } from "@/lib/layline/analysis-workspace-ui";

/* The preset's call is not a third state. The checked segment reports the
 * resolved visibility; data-layer-override separately records whether the
 * workspace preset or a manual choice produced it. */
const LAYER_CHOICES: readonly { value: LayerOverride; label: string }[] = Object.freeze([
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
]);

export function AnalysisLayerDisclosure({
  session,
  workspace,
  onLayerChange,
  onReset,
}: {
  session: AnalysisWorkspaceSession;
  workspace: ResolvedAnalysisWorkspace;
  onLayerChange: (layerId: LayerId, override: LayerOverride | "default") => void;
  onReset: () => void;
}) {
  const layerControls = analysisLayerControlModels(session, workspace);

  return (
    <details className={styles.analysisLayerDisclosure}>
      <summary>Analysis layers</summary>
      <fieldset className={styles.analysisLayerControls}>
        <legend>Visible analysis layers</legend>
        <div className={styles.analysisLayerGrid}>
          {layerControls.map((layer) => (
            layer.available ? (
              <div
                key={layer.id}
                className={styles.analysisLayerControl}
                data-layer-override={layer.value}
                data-layer-resolved={layer.resolvedVisible ? "on" : "off"}
              >
                <span id={`analysis-layer-name-${layer.id}`}>{layer.label}</span>
                {/* Native radios provide arrow-key roving and one tab stop;
                    the browser's checked state is also the painted state. */}
                <div
                  className={styles.analysisLayerChoices}
                  role="radiogroup"
                  aria-labelledby={`analysis-layer-name-${layer.id}`}
                >
                  {LAYER_CHOICES.map((choice) => (
                    <label
                      key={choice.value}
                      className={styles.analysisLayerChoice}
                      data-choice={choice.value}
                      data-selected={
                        layer.resolvedVisible === (choice.value === "on") ? "yes" : "no"
                      }
                    >
                      <input
                        type="radio"
                        name={`analysis-layer-${layer.id}`}
                        value={choice.value}
                        checked={layer.resolvedVisible === (choice.value === "on")}
                        onChange={() => onLayerChange(layer.id, choice.value)}
                      />
                      <span>{choice.label}</span>
                    </label>
                  ))}
                </div>
              </div>
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
  );
}
