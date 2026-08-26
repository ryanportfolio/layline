"use client";

import clsx from "clsx";
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import styles from "@/app/layline.module.css";
import { groundMadeGoodToMark, VMG_STEP, vmgSeries } from "@/lib/layline/analytics";
import { MISSING, knots } from "@/lib/layline/format";
import type { LegName, RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { onLive, sampleLive, setText } from "./live";

/* User units. The strip is drawn without an aspect ratio so it can be any
 * width the dock leaves it; every stroke carries non-scaling-stroke so the
 * lines stay one pixel through the stretch. */
const W = 1000;
const H = 100;

const MPS_TO_KNOTS = 3600 / 1852;

const LEG_LABEL: Record<LegName, string> = {
  prestart: "PRESTART",
  beat: "BEAT",
  run: "RUN",
  finished: "FINISH",
};

/** The next whole knot above the fastest reading anyone posted, in m/s. */
function ceilingOf(peak: number): number {
  const kn = Math.ceil(peak * MPS_TO_KNOTS);
  return (kn < 1 ? 1 : kn) / MPS_TO_KNOTS;
}

function displayedToMark(pose: Parameters<typeof groundMadeGoodToMark>[0], leg: LegName): string {
  const value = groundMadeGoodToMark(pose, leg);
  return value === null ? MISSING : knots(Math.max(0, value));
}

/**
 * One trace. A run of samples where the boat was not on a leg breaks the line
 * rather than bridging it, so a gap on the strip is a gap in the racing.
 *
 * Sample i is placed by its own race time, not by its index: the playhead, the
 * reveal clip, the maneuver markers and the scrub track below all divide by
 * the full race span, and dividing by count - 1 instead stretched the picture
 * past the clock by a few pixels at the end of the race.
 *
 * Readings below zero are drawn on the floor. A boat reads negative wherever
 * it is losing ground to its mark, which includes the samples either side of a
 * rounding but also any stretch mid-leg where it is sailing across the course
 * rather than up it. The strip floors those deliberately: it is a picture of
 * how fast the boat is gaining, and the loss is left to the trace flattening
 * onto the axis rather than given its own depth below it.
 */
function trace(
  values: Float32Array,
  count: number,
  ceiling: number,
  t0: number,
  tMin: number,
  span: number,
): string {
  let d = "";
  let open = false;
  for (let i = 0; i < count; i++) {
    const value = values[i];
    if (Number.isNaN(value)) {
      open = false;
      continue;
    }
    const x = ((t0 + i * VMG_STEP - tMin) / span) * W;
    const held = value < 0 ? 0 : value > ceiling ? ceiling : value;
    const y = H - (held / ceiling) * H;
    d += `${open ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    open = true;
  }
  return d;
}

/**
 * Speed made good toward the mark, the followed boat against the best anyone
 * in the fleet was making at the same instant. It fills in as the race runs
 * and it is clipped to the clock, so the strip never shows a viewer water the
 * replay has not reached.
 *
 * A different quantity from the dock's VMG, not the same one drawn with a
 * different sign: this resolves speed onto the fixed course axis toward the
 * next mark, the dock resolves it onto the shifting wind axis. It carries its
 * own label for that reason, and the leg beside it names which mark.
 */
export function VmgStrip({ race }: { race: RaceData }) {
  const followId = useReplay((state) => state.followId);
  const series = vmgSeries(race);
  const boat = race.boats.find((entry) => entry.id === followId) ?? race.boats[0];
  const ceiling = ceilingOf(series.peak);
  const span = race.tMax - race.tMin;

  const paths = useMemo(
    () => ({
      boat: trace(series.byBoat[boat.id], series.count, ceiling, series.t0, race.tMin, span),
      best: trace(series.best, series.count, ceiling, series.t0, race.tMin, span),
    }),
    [series, boat.id, ceiling, race.tMin, span],
  );

  const plot = useRef<SVGSVGElement>(null);
  const scrubbing = useRef(false);
  const clip = useRef<SVGRectElement>(null);
  const head = useRef<SVGLineElement>(null);
  const now = useRef<HTMLSpanElement>(null);
  const best = useRef<HTMLSpanElement>(null);
  const leg = useRef<HTMLSpanElement>(null);

  /* Every render is seeded off the clock the listener writes against, so a
   * re-render this strip did not ask for (the console following another boat)
   * cannot hand the reveal and the playhead back a position from mount. */
  const sample = sampleLive(race);
  const seedX = (((sample.t - race.tMin) / span) * W).toFixed(1);
  const seedIndex = Math.floor((sample.t - series.t0) / VMG_STEP);
  const seedBest =
    seedIndex >= 0 && seedIndex < series.count ? series.best[seedIndex] : Number.NaN;

  useEffect(() => {
    let drawn = Number.NaN;
    return onLive(race, (live) => {
      const x = ((live.t - race.tMin) / span) * W;
      /* Half a user unit is well under a pixel at every width this strip is
       * given, so the clip and the playhead only move when the picture does. */
      if (!(Math.abs(x - drawn) < 0.5)) {
        drawn = x;
        const reading = x.toFixed(1);
        if (clip.current !== null) clip.current.setAttribute("width", reading);
        if (head.current !== null) {
          head.current.setAttribute("x1", reading);
          head.current.setAttribute("x2", reading);
        }
      }

      const racing = live.leg === "beat" || live.leg === "run";
      setText(
        now.current,
        racing ? displayedToMark(live.pose, live.leg) : MISSING,
      );
      /* The fleet best comes off the same half second grid the trace is drawn
       * from, floored so it reads the latest sample the reveal has reached
       * rather than one still hidden ahead of the playhead. */
      const i = Math.floor((live.t - series.t0) / VMG_STEP);
      const top = i >= 0 && i < series.count ? series.best[i] : Number.NaN;
      setText(best.current, Number.isNaN(top) ? MISSING : knots(Math.max(0, top)));
      setText(leg.current, LEG_LABEL[live.leg]);
    });
  }, [race, series, span]);

  /* The strip and the scrub track under it are the same 1fr column of the same
   * grid, so a pixel on one is the same race time as the pixel below it. That
   * is the whole reason this row can be scrubbed: a viewer who reads the dip
   * in the trace aims at the dip, not at the track under it. Pointer only; the
   * track below is the focusable slider and owns the keyboard. */
  const seekFromPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = plot.current?.getBoundingClientRect();
    if (box === undefined || box.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    useReplay.getState().seek(race.tMin + fraction * span);
  };

  const seedRacing = sample.leg === "beat" || sample.leg === "run";

  return (
    <div className={styles.vmgRow} aria-label="Speed made good toward the mark">
      <span className={styles.vmgGutter}>
        {/* Named for the axis it measures on, so it cannot be read as the
            dock's VMG: that one is speed along the wind. */}
        <span className={`${styles.hudLabel} ${styles.vmgLabel}`}>
          To mark <span className={styles.hudUnit}>KN</span>
        </span>
        <span className={styles.vmgLeg} ref={leg} data-live="vmg-leg">
          {LEG_LABEL[sample.leg]}
        </span>
      </span>

      <svg
        ref={plot}
        className={styles.vmgPlot}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        data-view="vmg"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          scrubbing.current = true;
          useReplay.getState().pause();
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!scrubbing.current) return;
          seekFromPointer(event);
        }}
        onPointerUp={(event) => {
          scrubbing.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          scrubbing.current = false;
        }}
      >
        <defs>
          <clipPath id="laylineVmgSoFar">
            <rect ref={clip} x="0" y="0" width={seedX} height={H} />
          </clipPath>
        </defs>
        <g clipPath="url(#laylineVmgSoFar)">
          <path d={paths.best} className={styles.vmgBestLine} data-line="best" />
          {/* A near-black hull colour has nothing to hold against the panel
              ground, so it gets a light edge under it, the same treatment its
              standings chip and its track carry. */}
          {boat.dark === true ? (
            <path d={paths.boat} className={styles.vmgBoatEdge} />
          ) : null}
          <path
            d={paths.boat}
            className={styles.vmgBoatLine}
            stroke={boat.hue}
            data-line="follow"
          />
        </g>
        <line ref={head} className={styles.vmgHead} x1={seedX} y1="0" x2={seedX} y2={H} />
      </svg>

      <span className={styles.vmgReadout}>
        <span className={styles.vmgNowRow}>
          <span
            className={clsx(styles.vmgChip, boat.dark === true && styles.chipOutlined)}
            style={{ background: boat.hue }}
            aria-hidden="true"
          />
          <span className={styles.vmgNow} ref={now} data-live="vmg-now">
            {seedRacing
              ? displayedToMark(sample.pose, sample.leg)
              : MISSING}
          </span>
        </span>
        <span className={styles.vmgBestRow}>
          <span className={styles.vmgBestLabel}>Best</span>
          <span className={styles.vmgBestValue} ref={best} data-live="vmg-best">
            {Number.isNaN(seedBest) ? MISSING : knots(Math.max(0, seedBest))}
          </span>
        </span>
      </span>
    </div>
  );
}
