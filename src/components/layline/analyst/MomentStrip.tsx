"use client";

import clsx from "clsx";
import { memo, useMemo, useState, type CSSProperties } from "react";
import { clock } from "@/lib/layline/format";
import { raceData } from "../store";
import { useMounted } from "./useMounted";
import styles from "./analyst.module.css";

/* The race as a strip of time above the input, the transport bar's echo:
 * three leg bands, the gun, and a lit buoy for every moment chip in the
 * latest answer.
 *
 * The furniture is decorative: the bands and the gun are hidden from the tree
 * and never hit-testable. The buoys are not furniture. Each one is a moment
 * the answer cited, so hovering it names the moment and clicking it seeks the
 * replay there, the same jump the chip makes.
 *
 * The strip used to carry a tick per rounding and per finish as well, one per
 * boat per event. Sixteen unlabelled hairlines encoding boat by hue and event
 * by height, none of them hoverable, read as texture rather than as data, and
 * they crowded the marks that are worth reading. Gone; the engine room's own
 * window strip still draws them, next to the readouts that name them.
 *
 * They are deliberately not focusable. The chip that put each buoy on the
 * strip sits a few lines above as a real button with a fuller label, so tab
 * stops down here would only repeat it, once per citation.
 */

export interface StripBuoy {
  t: number;
  hue: string;
  dark: boolean;
  boatId?: string;
  sail?: string;
}

/* How close to an edge a buoy has to be before its label stops centring and
 * starts hugging that edge instead, so a tip never hangs off the strip. */
const EDGE_PCT = 14;

/* Memoized for the same reason as the backdrop: the bands and ticks are
 * fixed race furniture, and the buoy list holds its identity while an answer
 * streams. */
export const MomentStrip = memo(function MomentStrip({
  buoys,
  onBuoy,
}: {
  buoys: StripBuoy[];
  onBuoy: (t: number, boatId?: string) => void;
}) {
  /* Client-only drawing: event times differ across engine float math, so SSR
   * ships the strip empty at its CSS-fixed height (see useMounted). */
  const mounted = useMounted();

  /* Which buoy is under the pointer, by index. Read back through the current
   * array rather than held as an object, so an answer landing mid-hover can
   * never leave a tip describing a moment the strip no longer shows. */
  const [hovered, setHovered] = useState<number | null>(null);

  const built = useMemo(() => {
    if (!mounted) return null;
    const race = raceData();
    const span = race.tMax - race.tMin;
    const pos = (t: number) => ((t - race.tMin) / span) * 100;
    let firstRounding = race.tMax;
    for (const event of race.events) {
      if (event.kind === "rounding" && event.t < firstRounding) firstRounding = event.t;
    }
    return {
      pos,
      gunLeft: pos(0),
      bands: [
        { className: styles.bandPre, label: "PRESTART", left: 0, width: pos(0) },
        { className: styles.bandBeat, label: "BEAT", left: pos(0), width: pos(firstRounding) - pos(0) },
        { className: styles.bandRun, label: "RUN", left: pos(firstRounding), width: 100 - pos(firstRounding) },
      ],
    };
  }, [mounted]);

  if (built === null) {
    return (
      <div className={styles.stripWrap}>
        <div className={styles.strip} aria-hidden="true" />
      </div>
    );
  }

  const place = (t: number) => Math.min(100, Math.max(0, built.pos(t)));
  const active = hovered === null ? null : (buoys[hovered] ?? null);
  const activeAt = active === null ? 0 : place(active.t);

  return (
    <div className={styles.stripWrap}>
      {/* The tip lives outside the strip, which clips its own comet, so it can
          stand clear of a 30px band that already carries labels and ticks. */}
      {active !== null ? (
        <span
          className={styles.buoyTip}
          aria-hidden="true"
          data-anchor={activeAt < EDGE_PCT ? "start" : activeAt > 100 - EDGE_PCT ? "end" : "mid"}
          style={{ left: `${activeAt.toFixed(3)}%`, "--tip-hue": active.hue } as CSSProperties}
        >
          <span className={styles.tipTime}>{clock(active.t)}</span>
          {active.sail === undefined ? null : (
            <span className={styles.tipSail}>{active.sail}</span>
          )}
        </span>
      ) : null}

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
        <div className={styles.comet} />
        {buoys.map((buoy, index) => (
          <button
            key={`${buoy.t}-${index}`}
            type="button"
            /* Hidden from the tree and out of the tab order on purpose: the
               chip this buoy mirrors is the keyboard path to the same seek. */
            aria-hidden="true"
            tabIndex={-1}
            className={clsx(styles.buoy, buoy.dark && styles.buoyOutlined)}
            style={
              {
                left: `${place(buoy.t).toFixed(3)}%`,
                "--buoy-hue": buoy.hue,
              } as CSSProperties
            }
            onPointerEnter={() => setHovered(index)}
            onPointerLeave={() => setHovered((at) => (at === index ? null : at))}
            onClick={() => {
              /* A tap fires enter then click and then the console scrolls up
                 under the pointer, so nothing would ever fire leave. */
              setHovered(null);
              onBuoy(buoy.t, buoy.boatId);
            }}
          />
        ))}
      </div>
    </div>
  );
});
