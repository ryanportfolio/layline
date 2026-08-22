"use client";

import clsx from "clsx";
import { useEffect, useRef } from "react";
import styles from "@/app/layline.module.css";
import { deg, knots } from "@/lib/layline/format";
import type { RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { onLive, sampleLive, setText, tackOf, vmgOf } from "./live";

export function Instruments({ race }: { race: RaceData }) {
  const followId = useReplay((state) => state.followId);
  const boat = race.boats.find((entry) => entry.id === followId) ?? race.boats[0];
  const sog = useRef<HTMLSpanElement>(null);
  const vmg = useRef<HTMLSpanElement>(null);
  const hdg = useRef<HTMLSpanElement>(null);
  const twa = useRef<HTMLSpanElement>(null);
  const tack = useRef<HTMLSpanElement>(null);
  const tws = useRef<HTMLSpanElement>(null);
  const twd = useRef<HTMLSpanElement>(null);
  const sample = sampleLive(race);

  useEffect(
    () =>
      onLive(race, (live) => {
        setText(sog.current, knots(live.pose.sog));
        setText(vmg.current, knots(vmgOf(live.pose)));
        setText(hdg.current, deg(live.pose.hdg));
        setText(twa.current, deg(Math.abs(live.pose.twa)));
        setText(tack.current, tackOf(live.pose));
        setText(tws.current, knots(live.wind.tws));
        setText(twd.current, deg(live.wind.twd));
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
        <span className={styles.instrNation}>{boat.nation}</span>
        <span className={styles.instrSail} data-live="sail">
          {boat.sail}
        </span>
      </div>
      <p className={styles.instrName} data-live="name">
        {boat.name}
      </p>

      <div className={styles.instrGrid}>
        <div className={styles.instrCell}>
          <span className={styles.hudLabel}>
            SOG <span className={styles.hudUnit}>KN</span>
          </span>
          <span className={styles.instrValue} ref={sog} data-live="sog">
            {knots(sample.pose.sog)}
          </span>
        </div>

        {/* Made good straight up the wind axis, so a boat on the run reads
            negative and a boat head to wind reads its own speed. */}
        <div className={styles.instrCell}>
          <span className={styles.hudLabel}>
            VMG <span className={styles.hudUnit}>KN</span>
          </span>
          <span className={styles.instrValue} ref={vmg} data-live="vmg">
            {knots(vmgOf(sample.pose))}
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
      </div>
    </section>
  );
}
