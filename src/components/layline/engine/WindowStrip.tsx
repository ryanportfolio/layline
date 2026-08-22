"use client";

import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { raceData } from "../store";
import { useMounted } from "../analyst/useMounted";
import { BENCH_BOAT, benchWindow } from "./benchData";
import styles from "./engine.module.css";

/* Two 2px ticks whose centres land inside this of each other are one tick on
 * screen, and the later one wins: NZL and AUS finish 0.05s apart, which is
 * eight tenths of a pixel here. Colliding ticks get pushed apart to this
 * spacing so every event on the strip is an event you can see. */
const MIN_TICK_PX = 3;

interface Tick {
  key: string;
  round: boolean;
  left: number;
  background: string;
  outlined: boolean;
}

/**
 * Push ticks apart until no two centres are closer than MIN_TICK_PX, walking
 * the sorted list once and carrying each collision forward. Positions move by
 * hundredths of a second on a strip that is a hundred seconds wide, and the
 * alternative is an event the strip claims to show and does not.
 */
function spread(ticks: Tick[], width: number): Tick[] {
  if (width <= 0) return ticks;
  const min = (MIN_TICK_PX / width) * 100;
  let previous = -Infinity;
  return ticks.map((tick) => {
    const left = tick.left < previous + min ? previous + min : tick.left;
    previous = left;
    return left === tick.left ? tick : { ...tick, left };
  });
}

/* The whole race as a strip of time, drawn a second time under the Debrief
 * panel's own so the seam reads as one timeline shown twice: three leg bands,
 * the gun, a tick per rounding and per finish, and the twelve seconds the
 * cameras below are pointed at marked in the bench boat's hue. Decorative
 * repetition of what the transport says, so it is hidden from the tree and
 * never hit-testable. */
export function WindowStrip() {
  /* Client-only drawing: event times differ across engine float math, so SSR
   * ships the strip empty at its CSS-fixed height (see useMounted). */
  const mounted = useMounted();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [stripWidth, setStripWidth] = useState(0);

  /* The nudge below is in pixels, so it needs the width the strip actually
     got: 1088 on a desktop, 358 on a phone, and a different percentage of the
     race in each. */
  useEffect(() => {
    const node = stripRef.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setStripWidth((current) => (Math.abs(current - width) < 1 ? current : width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [mounted]);

  const built = useMemo(() => {
    if (!mounted) return null;
    const race = raceData();
    const span = race.tMax - race.tMin;
    const pos = (t: number) => ((t - race.tMin) / span) * 100;
    let firstRounding = race.tMax;
    for (const event of race.events) {
      if (event.kind === "rounding" && event.t < firstRounding) firstRounding = event.t;
    }
    const fleet = new Map(race.boats.map((boat) => [boat.id, boat]));
    const window = benchWindow(race, BENCH_BOAT);
    return {
      gunLeft: pos(0),
      bands: [
        { className: styles.bandPre, label: "PRESTART", left: 0, width: pos(0) },
        {
          className: styles.bandBeat,
          label: "BEAT",
          left: pos(0),
          width: pos(firstRounding) - pos(0),
        },
        {
          className: styles.bandRun,
          label: "RUN",
          left: pos(firstRounding),
          width: 100 - pos(firstRounding),
        },
      ],
      ticks: spread(
        race.events
          .filter((event) => event.kind !== "gun")
          .sort((a, b) => a.t - b.t)
          .map((event) => {
            const hue = event.boatId === undefined ? undefined : fleet.get(event.boatId)?.hue;
            return {
              key: `${event.kind}-${event.boatId ?? "race"}`,
              round: event.kind === "rounding",
              left: pos(event.t),
              background:
                event.kind === "rounding"
                  ? `color-mix(in srgb, ${hue ?? "var(--wind)"} 70%, transparent)`
                  : (hue ?? "var(--wind)"),
              outlined: fleet.get(event.boatId ?? "")?.dark === true,
            };
          }),
        stripWidth,
      ),
      window: { left: pos(window.from), width: pos(window.to) - pos(window.from) },
    };
  }, [mounted, stripWidth]);

  if (built === null) return <div ref={stripRef} className={styles.strip} aria-hidden="true" />;

  return (
    <div ref={stripRef} className={styles.strip} aria-hidden="true">
      {built.bands.map((band) => (
        <div
          key={band.label}
          className={band.className}
          style={{ left: `${band.left.toFixed(3)}%`, width: `${band.width.toFixed(3)}%` }}
        >
          <span className={styles.bandLabel}>{band.label}</span>
        </div>
      ))}
      <span
        className={styles.windowSpan}
        style={{ left: `${built.window.left.toFixed(3)}%`, width: `${built.window.width.toFixed(3)}%` }}
      />
      <span className={styles.gunTick} style={{ left: `${built.gunLeft.toFixed(3)}%` }} />
      {built.ticks.map((tick) => (
        <span
          key={tick.key}
          className={clsx(
            tick.round ? styles.roundTick : styles.finishTick,
            tick.outlined && styles.tickOutlined,
          )}
          style={{ left: `${tick.left.toFixed(3)}%`, background: tick.background } as CSSProperties}
        />
      ))}
    </div>
  );
}
