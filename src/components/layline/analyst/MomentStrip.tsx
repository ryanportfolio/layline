"use client";

import clsx from "clsx";
import { memo, useMemo, type CSSProperties } from "react";
import { raceData } from "../store";
import { useMounted } from "./useMounted";
import styles from "./analyst.module.css";

/* The race as a strip of time above the input, the transport bar's echo:
 * three leg bands, the gun, a tick per rounding and per finish, and a lit
 * buoy for every moment chip in the latest answer. Decorative, so the whole
 * strip is hidden from the tree and never hit-testable; the chips inside the
 * answer stay the interactive way to those moments. */

export interface StripBuoy {
  t: number;
  hue: string;
  dark: boolean;
}

/* Memoized for the same reason as the backdrop: the bands and ticks are
 * fixed race furniture, and the buoy list holds its identity while an answer
 * streams. */
export const MomentStrip = memo(function MomentStrip({ buoys }: { buoys: StripBuoy[] }) {
  /* Client-only drawing: event times differ across engine float math, so SSR
   * ships the strip empty at its CSS-fixed height (see useMounted). */
  const mounted = useMounted();
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
    const ticks = race.events
      .filter((event) => event.kind !== "gun")
      .sort((a, b) => a.t - b.t)
      .map((event, index) => {
        const hue = event.boatId === undefined ? "var(--wind)" : fleet.get(event.boatId)?.hue;
        return {
          key: `${event.kind}-${event.boatId ?? "race"}`,
          round: event.kind === "rounding",
          left: pos(event.t),
          background:
            event.kind === "rounding"
              ? `color-mix(in srgb, ${hue ?? "var(--wind)"} 70%, transparent)`
              : (hue ?? "var(--wind)"),
          outlined: event.boatId === "nzl",
          index,
        };
      });
    return {
      pos,
      gunLeft: pos(0),
      bands: [
        { className: styles.bandPre, label: "PRESTART", left: 0, width: pos(0) },
        { className: styles.bandBeat, label: "BEAT", left: pos(0), width: pos(firstRounding) - pos(0) },
        { className: styles.bandRun, label: "RUN", left: pos(firstRounding), width: 100 - pos(firstRounding) },
      ],
      ticks,
    };
  }, [mounted]);

  if (built === null) return <div className={styles.strip} aria-hidden="true" />;

  return (
    <div className={styles.strip} aria-hidden="true">
      {built.bands.map((band) => (
        <div
          key={band.label}
          className={band.className}
          style={{ left: `${band.left.toFixed(3)}%`, width: `${band.width.toFixed(3)}%` }}
        >
          <span className={styles.bandLabel}>{band.label}</span>
        </div>
      ))}
      <span className={styles.gunTick} style={{ left: `${built.gunLeft.toFixed(3)}%` }} />
      {built.ticks.map((tick) => (
        <span
          key={tick.key}
          className={clsx(
            tick.round ? styles.roundTick : styles.finishTick,
            tick.outlined && styles.tickOutlined,
          )}
          style={
            {
              left: `${tick.left.toFixed(3)}%`,
              background: tick.background,
              "--i": tick.index,
            } as CSSProperties
          }
        />
      ))}
      <div className={styles.comet} />
      {buoys.map((buoy, index) => (
        <span
          key={`${buoy.t}-${index}`}
          className={clsx(styles.buoy, buoy.dark && styles.buoyOutlined)}
          style={
            {
              left: `${Math.min(100, Math.max(0, built.pos(buoy.t))).toFixed(3)}%`,
              "--buoy-hue": buoy.hue,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
});
