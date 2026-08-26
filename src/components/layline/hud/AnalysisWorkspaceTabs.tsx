"use client";

import { useRef, type KeyboardEvent } from "react";
import styles from "@/app/layline.module.css";
import type { AnalysisWorkspaceId } from "@/lib/layline/analysis-state";
import {
  analysisWorkspaceTabModel,
  selectAnalysisWorkspaceTab,
  workspaceTabSelectionIntent,
} from "@/lib/layline/analysis-workspace-ui";

export function AnalysisWorkspaceTabs({
  active,
  onSelect,
}: {
  active: AnalysisWorkspaceId;
  onSelect: (workspaceId: AnalysisWorkspaceId) => void;
}) {
  const tabs = analysisWorkspaceTabModel(active);
  const refs = useRef(new Map<AnalysisWorkspaceId, HTMLButtonElement>());

  const move = (
    workspaceId: AnalysisWorkspaceId,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const intent = workspaceTabSelectionIntent(workspaceId, event.key);
    if (!intent.handled) return;
    event.preventDefault();
    event.stopPropagation();
    selectAnalysisWorkspaceTab(intent.workspaceId, onSelect);
    refs.current.get(intent.workspaceId)?.focus();
  };

  return (
    <div
      className={styles.analysisWorkspaceTabs}
      role="tablist"
      aria-label="Analysis task workspace"
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
  );
}
