"use client";

import clsx from "clsx";
import { useEffect, useRef } from "react";
import styles from "@/app/layline.module.css";
import { startLineOf, startReadingAt, type StartReading } from "@/lib/layline/analytics";
import { MISSING, clock, knots, meters } from "@/lib/layline/format";
import type { RaceData } from "@/lib/layline/types";
import { onLive, sampleLive, setText } from "./live";

/**
 * The prestart, and only the prestart. Three readings for the boat the console
 * is following: how far it is off the line, how long until the gun, and how
 * fast it is closing on the line. When the boat gets there before the gun does,
 * the row says so.
 *
 * At zero the row takes itself off the panel rather than sitting there showing
 * a start nobody is sailing any more, and it does that through the same DOM
 * write every other reading here goes through: no re-render, no layout pass.
 */
export function StartLine({ race }: { race: RaceData }) {
  const line = useRef(startLineOf(race.course));
  const reading = useRef<StartReading>({ distance: 0, closing: 0, toLine: 0, early: false });
  const row = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLSpanElement>(null);
  const sail = useRef<HTMLSpanElement>(null);
  const teamName = useRef<HTMLSpanElement>(null);
  const distance = useRef<HTMLSpanElement>(null);
  const gun = useRef<HTMLSpanElement>(null);
  const closing = useRef<HTMLSpanElement>(null);
  const flag = useRef<HTMLSpanElement>(null);

  /* Every render reads the clock the listener is writing against, so a
   * re-render this row did not ask for (the console following another boat,
   * the chart mode opening) cannot hand it back a reading from mount time. */
  const sample = sampleLive(race);
  const open = sample.t < 0;
  /* Whose start this is. The readings follow the console's followed boat, and
   * the row says so instead of leaving the reader to infer it. */
  const followedBoat =
    race.boats.find((entry) => entry.id === sample.followId) ?? race.boats[0];
  /* After the gun there is no start to read, so the row holds nothing rather
   * than a distance to a line the boat is a hundred metres up the course from. */
  const seed = open ? startReadingAt(line.current, sample.pose, sample.t, reading.current) : null;

  useEffect(
    () =>
      onLive(race, (live) => {
        const prestart = live.t < 0;
        const node = row.current;
        /* Compared against what is on the element rather than a remembered
         * flag, for the same reason: React may have written it since. */
        const want = prestart ? "" : "none";
        if (node !== null && node.style.display !== want) node.style.display = want;
        if (!prestart) return;

        /* The identity travels with the follow, through the same DOM writes as
         * the readings, so switching boats never re-renders the row. */
        const boat = race.boats.find((entry) => entry.id === live.followId);
        if (boat !== undefined) {
          setText(sail.current, boat.sail);
          setText(teamName.current, boat.name);
          const dot = chip.current;
          if (dot !== null) {
            if (dot.style.background !== boat.hue) dot.style.background = boat.hue;
            dot.classList.toggle(styles.chipOutlined, boat.dark === true);
          }
        }

        const read = startReadingAt(line.current, live.pose, live.t, reading.current);
        setText(distance.current, meters(read.distance));
        setText(gun.current, clock(live.t));
        setText(closing.current, knots(read.closing));
        const lit = flag.current;
        const early = read.early ? "" : "none";
        if (lit !== null && lit.style.display !== early) lit.style.display = early;
      }),
    [race],
  );

  return (
    <div
      className={styles.startRow}
      ref={row}
      style={{ display: open ? undefined : "none" }}
      data-dock="start"
      aria-label="Start line"
    >
      <span className={styles.startTitle}>Start</span>

      <span className={styles.startBoat} data-live="follow">
        <span
          className={clsx(styles.standingChip, followedBoat.dark === true && styles.chipOutlined)}
          style={{ background: followedBoat.hue }}
          ref={chip}
          aria-hidden="true"
        />
        <strong ref={sail}>{followedBoat.sail}</strong>
        <span className={styles.startBoatName} ref={teamName}>
          {followedBoat.name}
        </span>
      </span>

      <div className={styles.startCell}>
        <span className={styles.hudLabel}>
          To line <span className={styles.hudUnit}>M</span>
        </span>
        <span className={styles.startValue} ref={distance} data-live="to-line">
          {seed === null ? MISSING : meters(seed.distance)}
        </span>
      </div>

      <div className={styles.startCell}>
        <span className={styles.hudLabel}>To gun</span>
        <span className={styles.startValue} ref={gun} data-live="to-gun">
          {open ? clock(sample.t) : MISSING}
        </span>
      </div>

      {/* Speed straight at the line, not speed through the water: a boat
          reaching along the line at seven knots is closing on it at none. */}
      <div className={styles.startCell}>
        <span className={styles.hudLabel}>
          Closing <span className={styles.hudUnit}>KN</span>
        </span>
        <span className={styles.startValue} ref={closing} data-live="closing">
          {seed === null ? MISSING : knots(seed.closing)}
        </span>
      </div>

      <span
        className={styles.startFlag}
        ref={flag}
        style={{ display: seed !== null && seed.early ? undefined : "none" }}
        data-live="ocs"
      >
        Over early
      </span>
    </div>
  );
}
