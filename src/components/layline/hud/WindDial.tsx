"use client";

import { useEffect, useRef } from "react";
import styles from "@/app/layline.module.css";
import { knots } from "@/lib/layline/format";
import type { RaceData } from "@/lib/layline/types";
import { onLive, sampleLive, setText } from "./live";

/* Course frame on a dial face: straight up is dead down the course, and the
 * needle points at the water the breeze is coming from. The band is the range
 * the course was surveyed for, +-8 deg, and it is the one thing here that does
 * not move. */
const BAND = 8;
const R = 16;
const CX = 20;
const CY = 20;

function rim(angle: number, radius: number): string {
  const a = (angle * Math.PI) / 180;
  return `${(CX + radius * Math.sin(a)).toFixed(3)} ${(CY - radius * Math.cos(a)).toFixed(3)}`;
}

const BAND_PATH = `M ${CX} ${CY} L ${rim(-BAND, R)} A ${R} ${R} 0 0 1 ${rim(BAND, R)} Z`;

export function WindDial({ race }: { race: RaceData }) {
  const needleRef = useRef<SVGGElement>(null);
  const twsRef = useRef<HTMLSpanElement>(null);
  const sample = sampleLive(race);

  useEffect(
    () =>
      onLive(race, (live) => {
        const needle = needleRef.current;
        if (needle !== null) {
          needle.setAttribute("transform", `rotate(${live.wind.twd.toFixed(2)} ${CX} ${CY})`);
        }
        setText(twsRef.current, knots(live.wind.tws));
      }),
    [race],
  );

  return (
    <div className={styles.windBlock}>
      <svg
        className={styles.windDial}
        viewBox="0 0 40 40"
        role="img"
        aria-label="Wind direction dial, needle at true wind direction"
      >
        <path className={styles.windBand} d={BAND_PATH} />
        <circle className={styles.windFace} cx={CX} cy={CY} r={R} />
        <g className={styles.windTicks}>
          <line x1={CX} y1={CY - R} x2={CX} y2={CY - R + 4} />
          <line x1={CX + R} y1={CY} x2={CX + R - 3} y2={CY} />
          <line x1={CX} y1={CY + R} x2={CX} y2={CY + R - 3} />
          <line x1={CX - R} y1={CY} x2={CX - R + 3} y2={CY} />
        </g>
        <g ref={needleRef} transform={`rotate(${sample.wind.twd.toFixed(2)} ${CX} ${CY})`}>
          <line className={styles.windNeedle} x1={CX} y1={CY} x2={CX} y2={CY - R + 5} />
          <polygon
            className={styles.windHead}
            points={`${CX} ${CY - R + 1}, ${CX - 2.6} ${CY - R + 6}, ${CX + 2.6} ${CY - R + 6}`}
          />
        </g>
        <circle className={styles.windHub} cx={CX} cy={CY} r={1.6} />
      </svg>
      <div className={styles.windReadout}>
        <span className={styles.hudLabel}>TWS</span>
        <span className={styles.windValueRow}>
          <span className={styles.windValue} ref={twsRef} data-live="tws">
            {knots(sample.wind.tws)}
          </span>
          <span className={styles.hudUnit}>KN</span>
        </span>
      </div>
    </div>
  );
}
