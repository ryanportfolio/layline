"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import styles from "@/app/layline.module.css";
import type { AnalysisWorkspaceId } from "@/lib/layline/analysis-state";
import {
  ANALYSIS_TASK_PICKER_ID,
  analysisWorkspaceTabModel,
  selectAnalysisWorkspaceTab,
  workspaceTabSelectionIntent,
} from "@/lib/layline/analysis-workspace-ui";

export function AnalysisWorkspaceTabs({
  active,
  availableTaskIds,
  onSelect,
}: {
  active: AnalysisWorkspaceId;
  availableTaskIds: readonly AnalysisWorkspaceId[];
  onSelect: (workspaceId: AnalysisWorkspaceId) => void;
}) {
  const [open, setOpen] = useState(false);
  const tabs = analysisWorkspaceTabModel(active, availableTaskIds);
  const analyzeRef = useRef<HTMLButtonElement>(null);
  const refs = useRef(new Map<AnalysisWorkspaceId, HTMLButtonElement>());

  const leave = () => {
    selectAnalysisWorkspaceTab("overview", onSelect);
    setOpen(false);
    analyzeRef.current?.focus();
  };

  const move = (
    workspaceId: AnalysisWorkspaceId,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const intent = workspaceTabSelectionIntent(workspaceId, event.key, availableTaskIds);
    if (!intent.handled) return;
    event.preventDefault();
    event.stopPropagation();
    selectAnalysisWorkspaceTab(intent.workspaceId, onSelect);
    refs.current.get(intent.workspaceId)?.focus();
  };

  return (
    <div
      className={styles.analysisNavigation}
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        leave();
      }}
      data-analysis-flow="entry"
    >
      <button
        ref={analyzeRef}
        type="button"
        className={styles.analyzeButton}
        aria-expanded={open}
        aria-controls={ANALYSIS_TASK_PICKER_ID}
        onClick={() => setOpen((value) => !value)}
      >
        Analyze
      </button>
      {open ? (
        <div
          id={ANALYSIS_TASK_PICKER_ID}
          className={styles.analysisTaskPicker}
          data-analysis-flow="picker"
        >
          <div
            className={styles.analysisWorkspaceTabs}
            role="tablist"
            aria-label="Analysis tasks"
            data-analysis-flow="tabs"
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                ref={(node) => {
                  if (node === null) refs.current.delete(tab.id);
                  else refs.current.set(tab.id, node);
                }}
                id={tab.tabId}
                type="button"
                className={styles.analysisWorkspaceTab}
                role="tab"
                aria-controls={tab.controls}
                aria-selected={tab.selected}
                tabIndex={tab.tabIndex}
                data-workspace={tab.id}
                onClick={() => selectAnalysisWorkspaceTab(tab.id, onSelect)}
                onKeyDown={(event) => move(tab.id, event)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.analysisReplayButton}
            onClick={leave}
          >
            Back to replay
          </button>
        </div>
      ) : null}
    </div>
  );
}
