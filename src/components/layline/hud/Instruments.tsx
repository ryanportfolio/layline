"use client";

import clsx from "clsx";
import { useEffect, useRef } from "react";
import styles from "@/app/layline.module.css";
import { MISSING, deg, knots } from "@/lib/layline/format";
import type { RaceData } from "@/lib/layline/types";
import type { LaylineInspectionSurface } from "@/lib/layline/surfaces";
import { useReplay } from "../store";
import { onLive, sampleLive, setText, tackOf, vmgOf } from "./live";
import { VectorTriangle } from "./VectorTriangle";

function windVmgKnots(pose: Parameters<typeof vmgOf>[0], twd: number): string {
  const value = vmgOf(pose, twd);
  return value === null ? MISSING : knots(value);
}

/* A reading with no sample leaves the panel instead of holding a dash cell.
 * The panel is a live surface, so presence is toggled alongside the text at
 * the same listener cadence. */
function setPresent(node: HTMLElement | null, present: boolean) {
  if (node !== null) node.hidden = !present;
}

export function Instruments({
  race,
  inspection,
  vector = true,
}: {
  race: RaceData;
  inspection?: LaylineInspectionSurface | null;
  /* False when the app docks the velocity triangle on its own plate. */
  vector?: boolean;
}) {
  const followId = useReplay((state) => state.followId);
  const boat = race.boats.find((entry) => entry.id === followId) ?? race.boats[0];
  const sog = useRef<HTMLSpanElement>(null);
  const vmg = useRef<HTMLSpanElement>(null);
  const hdg = useRef<HTMLSpanElement>(null);
  const twa = useRef<HTMLSpanElement>(null);
  const tack = useRef<HTMLSpanElement>(null);
  const tws = useRef<HTMLSpanElement>(null);
  const twd = useRef<HTMLSpanElement>(null);
  const stw = useRef<HTMLSpanElement>(null);
  const ctw = useRef<HTMLSpanElement>(null);
  const ctwWrap = useRef<HTMLSpanElement>(null);
  const drift = useRef<HTMLSpanElement>(null);
  const currentSet = useRef<HTMLSpanElement>(null);
  const currentSetWrap = useRef<HTMLSpanElement>(null);
  const cog = useRef<HTMLSpanElement>(null);
  const cogCell = useRef<HTMLDivElement>(null);
  const sample = sampleLive(race);

  useEffect(
    () =>
      onLive(race, (live) => {
        setText(sog.current, knots(live.pose.sog));
        setText(vmg.current, windVmgKnots(live.pose, live.wind.twd));
        setText(hdg.current, deg(live.pose.hdg));
        setText(twa.current, deg(Math.abs(live.pose.twa)));
        setText(tack.current, tackOf(live.pose));
        setText(tws.current, knots(live.wind.tws));
        setText(twd.current, deg(live.wind.twd));
        setText(stw.current, knots(live.pose.stw));
        setText(ctw.current, live.pose.ctw === null ? "" : deg(live.pose.ctw));
        setPresent(ctwWrap.current, live.pose.ctw !== null);
        setText(drift.current, knots(live.pose.currentDrift));
        setText(
          currentSet.current,
          live.pose.currentSet === null ? "" : deg(live.pose.currentSet),
        );
        setPresent(currentSetWrap.current, live.pose.currentSet !== null);
        setText(cog.current, live.pose.cog === null ? "" : deg(live.pose.cog));
        setPresent(cogCell.current, live.pose.cog !== null);
      }),
    [race],
  );

  return (
    <section className={styles.panel} aria-label="Instruments">
      <h2 className={styles.dockLabel}>Instruments</h2>

      <div className={styles.instrHeader}>
        <span
          className={clsx(styles.standingChip, boat.dark === true && styles.chipOutlined)}
          style={{ background: boat.hue }}
          aria-hidden="true"
        />
        {/* The sail number already leads with the nation code, so the header
            states it once. */}
        <span className={styles.instrSail} data-live="sail">
          {boat.sail}
        </span>
      </div>
      <p className={styles.instrName} data-live="name">
        {boat.name}
      </p>

      {/* Made good straight up the wind axis, so a boat on the run reads
          negative and a boat head to wind reads its own speed. The one number
          this panel leads with; everything else reads as support. */}
      <div className={styles.instrPrimary}>
        <span className={styles.hudLabel}>
          VMG <span className={styles.hudUnit}>KN</span>
        </span>
        <span className={styles.instrPrimaryValue} ref={vmg} data-live="vmg">
          {windVmgKnots(sample.pose, sample.wind.twd)}
        </span>
      </div>

      <div className={styles.instrGrid}>
        <div className={styles.instrCell}>
          <span className={styles.hudLabel}>
            SOG · GROUND <span className={styles.hudUnit}>KN</span>
          </span>
          <span className={styles.instrValue} ref={sog} data-live="sog">
            {knots(sample.pose.sog)}
          </span>
        </div>

        <div className={styles.instrCell}>
          <span className={styles.hudLabel}>
            HDG <span className={styles.hudUnit}>DEG</span>
          </span>
          <span className={styles.instrValue} ref={hdg} data-live="hdg">
            {deg(sample.pose.hdg)}
          </span>
        </div>

        <div className={styles.instrCell}>
          <span className={styles.hudLabel}>
            TWA <span className={styles.hudUnit}>DEG</span>
          </span>
          <span className={styles.instrValueRow}>
            <span className={styles.instrValue} ref={twa} data-live="twa">
              {deg(Math.abs(sample.pose.twa))}
            </span>
            <span className={styles.instrTack} ref={tack} data-live="tack">
              {tackOf(sample.pose)}
            </span>
          </span>
        </div>

        <div className={styles.instrCell}>
          <span className={styles.hudLabel}>
            TWS <span className={styles.hudUnit}>KN</span>
          </span>
          <span className={styles.instrValue} ref={tws} data-live="tws">
            {knots(sample.wind.tws)}
          </span>
        </div>

        <div className={styles.instrCell}>
          <span className={styles.hudLabel}>
            TWD <span className={styles.hudUnit}>DEG</span>
          </span>
          <span className={styles.instrValue} ref={twd} data-live="twd">
            {deg(sample.wind.twd)}
          </span>
        </div>

        <div className={styles.instrCell}>
          <span className={styles.hudLabel}>STW · WATER <span className={styles.hudUnit}>KN</span></span>
          <span className={styles.instrValueRow}>
            <span className={styles.instrValue} ref={stw} data-live="stw">{knots(sample.pose.stw)}</span>
            <span
              className={styles.instrTack}
              ref={ctwWrap}
              hidden={sample.pose.ctw === null}
            >
              CTW <span ref={ctw} data-live="ctw">{sample.pose.ctw === null ? "" : deg(sample.pose.ctw)}</span>°
            </span>
          </span>
        </div>

        <div className={styles.instrCell}>
          <span className={styles.hudLabel}>CURRENT · DRIFT <span className={styles.hudUnit}>KN</span></span>
          <span className={styles.instrValueRow}>
            <span className={styles.instrValue} ref={drift} data-live="current-drift">{knots(sample.pose.currentDrift)}</span>
            <span
              className={styles.instrTack}
              ref={currentSetWrap}
              hidden={sample.pose.currentSet === null}
            >
              SET <span ref={currentSet} data-live="current-set">{sample.pose.currentSet === null ? "" : deg(sample.pose.currentSet)}</span>° TOWARD
            </span>
          </span>
        </div>

        <div
          className={styles.instrCell}
          ref={cogCell}
          hidden={sample.pose.cog === null}
        >
          <span className={styles.hudLabel}>COG · GROUND <span className={styles.hudUnit}>DEG TOWARD</span></span>
          <span className={styles.instrValue} ref={cog} data-live="cog">
            {sample.pose.cog === null ? "" : deg(sample.pose.cog)}
          </span>
        </div>
      </div>
      {vector ? <VectorTriangle race={race} inspection={inspection} /> : null}
    </section>
  );
}
