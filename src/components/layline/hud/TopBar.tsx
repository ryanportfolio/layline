"use client";

import { useEffect, useRef } from "react";
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

export function TopBar({ race }: { race: RaceData }) {
  const clockRef = useRef<HTMLSpanElement>(null);
  const legRef = useRef<HTMLSpanElement>(null);
  const raw = useReplay((state) => state.mode === "raw");
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
    <header className={styles.dockTop}>
      <div className={styles.wordmarkBlock}>
        <span className={styles.wordmark}>LAYLINE</span>
        <span className={styles.wordmarkMeta}>Fleet race · Long Beach</span>
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
        {raw ? (
          <span className={styles.rawChip} data-chip="raw">
            RAW 4 HZ
          </span>
        ) : null}
        {sceneUp ? <WindDial race={race} /> : null}
      </div>
    </header>
  );
}
