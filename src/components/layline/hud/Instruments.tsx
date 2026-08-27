"use client";

import clsx from "clsx";
import { useEffect, useRef } from "react";
import styles from "@/app/layline.module.css";
import { MISSING, deg, knots } from "@/lib/layline/format";
import type { RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { onLive, sampleLive, setText, tackOf, vmgOf } from "./live";

function windVmgKnots(pose: Parameters<typeof vmgOf>[0], twd: number): string {
  const value = vmgOf(pose, twd);
  return value === null ? MISSING : knots(value);
}

export function Instruments({ race }: { race: RaceData }) {
  const followId = useReplay((state) => state.followId);
  const boat = race.boats.find((entry) => entry.id === followId) ?? race.boats[0];
  const sog = useRef<HTMLSpanElement>(null);
  const vmg = useRef<HTMLSpanElement>(null);
  const twa = useRef<HTMLSpanElement>(null);
  const tack = useRef<HTMLSpanElement>(null);
  const sample = sampleLive(race);

  useEffect(
    () =>
      onLive(race, (live) => {
        setText(sog.current, knots(live.pose.sog));
        setText(vmg.current, windVmgKnots(live.pose, live.wind.twd));
        setText(twa.current, deg(Math.abs(live.pose.twa)));
        setText(tack.current, tackOf(live.pose));
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
            SOG · GROUND SPEED <span className={styles.hudUnit}>KN</span>
          </span>
          <span className={styles.instrValue} ref={sog} data-live="sog">
            {knots(sample.pose.sog)}
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

      </div>
    </section>
  );
}
