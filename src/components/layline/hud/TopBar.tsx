"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "@/app/layline.module.css";
import { clock } from "@/lib/layline/format";
import type { LegName, RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { onLive, sampleLive, setText } from "./live";
import { WindDial } from "./WindDial";

const LEG_LABEL: Record<LegName, string> = {
  prestart: "PRESTART",
  beat: "BEAT",
  run: "RUN",
  finished: "FINISH",
};

/* The venue arrives as a prop rather than off the store: the bar renders on
 * the server, where the store holds the default race whatever the URL asked
 * for, and a venue read there would hydrate into a different string. The
 * default is the shipped race's own, so the story page passes nothing. */
export function TopBar({
  race,
  venue = "Long Beach",
  analysisNavigation,
}: {
  race: RaceData;
  venue?: string;
  analysisNavigation?: ReactNode;
}) {
  const clockRef = useRef<HTMLSpanElement>(null);
  const legRef = useRef<HTMLSpanElement>(null);
  const raw = useReplay((state) => state.mode === "raw");
  const truthMode = useReplay((state) => state.truthMode);
  const setTruthMode = useReplay((state) => state.setTruthMode);
  /* No renderer, no readings: the bar keeps its wordmark and gives the stage
     back to the chart standing in for the replay. */
  const sceneUp = useReplay((state) => state.webglOk);
  const sample = sampleLive(race);

  useEffect(
    () =>
      onLive(race, (live) => {
        setText(clockRef.current, clock(live.t));
        setText(legRef.current, LEG_LABEL[live.leg]);
      }),
    [race],
  );

  return (
    <header
      className={analysisNavigation === undefined
        ? styles.dockTop
        : `${styles.dockTop} ${styles.dockTopAnalysis}`}
    >
      <div className={styles.wordmarkBlock}>
        <span className={styles.wordmark}>LAYLINE</span>
        <span className={styles.wordmarkMeta}>{`Fleet race · ${venue}`}</span>
      </div>

      <div className={styles.clockBlock}>
        {sceneUp ? (
          <>
            <span className={styles.raceClock} ref={clockRef} data-live="clock">
              {clock(sample.t)}
            </span>
            {/* The leg belongs to the boat the console is following, the same
                one the instrument dock reads. */}
            <span className={styles.legChip} ref={legRef} data-live="leg">
              {LEG_LABEL[sample.leg]}
            </span>
          </>
        ) : null}
      </div>

      <div className={styles.windGroup}>
        {/* Independent of the playback lens. It exposes both evaluator answers
            without changing which one poses the fleet. Kept in the bar so a
            no-WebGL visitor can still open the 2D truth path. */}
        <button
          type="button"
          className={truthMode ? `${styles.truthButton} ${styles.truthButtonOn}` : styles.truthButton}
          aria-label={`Telemetry truth mode, ${truthMode ? "on" : "off"}`}
          aria-pressed={truthMode}
          aria-controls={truthMode ? "truth-inspector" : undefined}
          aria-expanded={truthMode}
          data-control="truth-mode"
          onClick={() => setTruthMode(!truthMode)}
        >
          <span>Truth</span>
          <span className={styles.truthButtonState}>{truthMode ? "ON" : "OFF"}</span>
        </button>
        <span
          className={raw ? `${styles.replayStatus} ${styles.rawChip}` : styles.replayStatus}
          data-chip="replay-status"
        >
          {raw ? "RAW 4 HZ" : "SMOOTH"}
        </span>
        {sceneUp ? <WindDial race={race} /> : null}
      </div>
      {analysisNavigation}
    </header>
  );
}
