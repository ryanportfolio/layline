"use client";

import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import styles from "@/app/layline.module.css";
import { maneuversOf } from "@/lib/layline/analytics";
import { clock } from "@/lib/layline/format";
import { FIX_HZ, type RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { onLive, sampleLive, setText } from "./live";

/* Ten units across, drawn into a 10px glyph. A tack turns the bow up through
 * the wind and a gybe turns it down through it, so the chevrons point the way
 * the turn goes and a viewer can tell the two apart without reading a key. */
const TACK_GLYPH = "M1.5 6.9 L5 2.7 L8.5 6.9";
const GYBE_GLYPH = "M1.5 3.1 L5 7.3 L8.5 3.1";

/* The strip shows the fixes either side of the playhead rather than the whole
 * race: 4 Hz across five minutes is more ticks than there are pixels. */
const WINDOW = 10;
const FIX_STEP = 1 / FIX_HZ;
const TICKS = Math.round(WINDOW / FIX_STEP) + 1;

const NUDGE = 1;
const NUDGE_SHIFT = 10;

interface Band {
  label: string;
  from: number;
  to: number;
  weight: string;
}

function bandsFor(race: RaceData, boatId: string): Band[] {
  let rounding: number | null = null;
  let finish: number | null = null;
  for (const event of race.events) {
    if (event.boatId !== boatId) continue;
    if (event.kind === "rounding") rounding = event.t;
    else if (event.kind === "finish") finish = event.t;
  }
  const beatEnd = rounding ?? finish ?? race.tMax;
  const bands: Band[] = [
    { label: "Prestart", from: race.tMin, to: 0, weight: styles.bandQuiet },
    { label: "Beat", from: 0, to: beatEnd, weight: styles.bandStrong },
  ];
  if (rounding !== null) {
    bands.push({
      label: "Run",
      from: rounding,
      to: finish ?? race.tMax,
      weight: styles.bandMid,
    });
  }
  return bands;
}

export function Timeline({ race }: { race: RaceData }) {
  const followId = useReplay((state) => state.followId);
  const raw = useReplay((state) => state.mode === "raw");
  const span = race.tMax - race.tMin;
  const pct = (t: number) => `${(((t - race.tMin) / span) * 100).toFixed(4)}%`;

  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const ticksRef = useRef<(HTMLDivElement | null)[]>([]);
  const dragging = useRef(false);

  const bands = useMemo(() => bandsFor(race, followId), [race, followId]);
  const roundings = useMemo(
    () => race.events.filter((event) => event.kind === "rounding"),
    [race],
  );
  const finishes = useMemo(() => race.events.filter((event) => event.kind === "finish"), [race]);
  const hues = useMemo(
    () => new Map(race.boats.map((boat) => [boat.id, boat.hue])),
    [race],
  );
  /* Only the followed boat's turns. Six boats' worth would be a fence, and the
     rest of this panel already reads one boat at a time. Re-derived when the
     console follows somebody else; every marker is a race time, so nothing
     here is on the clock's path. */
  const maneuvers = useMemo(() => maneuversOf(race, followId), [race, followId]);
  const followed = race.boats.find((entry) => entry.id === followId) ?? race.boats[0];

  /* Frozen at mount so React never rewrites what the listener below owns. */
  const seed = useRef({
    now: sampleLive(race).t,
    text: `${clock(sampleLive(race).t)} of ${clock(race.tMax)}`,
  });

  /* Re-subscribing when the lens opens repaints the strip immediately: the
     ticks are mounted by the render that follows the toggle, and a paused page
     has no next frame to place them on. */
  useEffect(() => {
    let stamp = "";
    return onLive(race, (live) => {
      const head = headRef.current;
      if (head !== null) head.style.left = `${(((live.t - race.tMin) / span) * 100).toFixed(4)}%`;

      const reading = clock(live.t);
      if (reading !== stamp) {
        stamp = reading;
        setText(elapsedRef.current, reading);
        const track = trackRef.current;
        if (track !== null) {
          track.setAttribute("aria-valuenow", live.t.toFixed(2));
          track.setAttribute("aria-valuetext", `${reading} of ${clock(race.tMax)}`);
        }
      }

      if (live.mode !== "raw") return;
      const frame = windowRef.current;
      if (frame !== null) {
        frame.style.left = `${(((live.t - WINDOW / 2 - race.tMin) / span) * 100).toFixed(4)}%`;
        frame.style.width = `${((WINDOW / span) * 100).toFixed(4)}%`;
      }
      const first = Math.ceil((live.t - WINDOW / 2 - race.tMin) / FIX_STEP);
      for (let i = 0; i < TICKS; i++) {
        const node = ticksRef.current[i];
        if (node === null || node === undefined) continue;
        const at = race.tMin + (first + i) * FIX_STEP;
        if (at < race.tMin || at > race.tMax || at > live.t + WINDOW / 2) {
          node.style.display = "none";
          continue;
        }
        node.style.display = "block";
        node.style.left = `${(((at - race.tMin) / span) * 100).toFixed(4)}%`;
      }
    });
  }, [race, span, raw]);

  const seekFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (track === null) return;
    const box = track.getBoundingClientRect();
    if (box.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    useReplay.getState().seek(race.tMin + fraction * span);
  };

  return (
    <div className={styles.timelineRow}>
      <span className={styles.timeClockNow} ref={elapsedRef} data-live="elapsed">
        {clock(seed.current.now)}
      </span>

      <div
        className={styles.track}
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Race time"
        aria-valuemin={race.tMin}
        aria-valuemax={race.tMax}
        aria-valuenow={seed.current.now}
        aria-valuetext={seed.current.text}
        onPointerDown={(event) => {
          dragging.current = true;
          useReplay.getState().pause();
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!dragging.current) return;
          seekFromPointer(event);
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onKeyDown={(event) => {
          const store = useReplay.getState();
          const step = event.shiftKey ? NUDGE_SHIFT : NUDGE;
          if (event.key === "ArrowRight" || event.key === "ArrowUp") store.seek(store.t + step);
          else if (event.key === "ArrowLeft" || event.key === "ArrowDown")
            store.seek(store.t - step);
          else if (event.key === "Home") store.seek(race.tMin);
          else if (event.key === "End") store.seek(race.tMax);
          else if (event.key === ",") store.step(-1);
          else if (event.key === ".") store.step(1);
          else return;
          event.preventDefault();
        }}
      >
        {bands.map((band) => (
          <div
            key={band.label}
            className={`${styles.band} ${band.weight}`}
            style={{ left: pct(band.from), width: `${((band.to - band.from) / span) * 100}%` }}
          >
            <span className={styles.bandLabel}>{band.label}</span>
          </div>
        ))}

        {roundings.map((event) => (
          <div
            key={`mark-${event.boatId}`}
            className={styles.tick}
            style={{ left: pct(event.t), background: hues.get(event.boatId ?? "") }}
            aria-hidden="true"
          />
        ))}

        {finishes.map((event) => (
          <svg
            key={`fin-${event.boatId}`}
            className={styles.flag}
            style={{ left: pct(event.t) }}
            viewBox="0 0 8 11"
            aria-hidden="true"
          >
            <line x1="0.5" y1="0" x2="0.5" y2="11" stroke="currentColor" strokeWidth="1" />
            <polygon points="1,0.5 7,2.75 1,5" fill={hues.get(event.boatId ?? "")} />
          </svg>
        ))}

        {raw ? (
          <div className={styles.rawStrip} aria-hidden="true">
            <div className={styles.rawWindow} ref={windowRef} />
            {Array.from({ length: TICKS }, (item, index) => (
              <div
                key={index}
                className={styles.rawTick}
                data-raw-tick=""
                ref={(node) => {
                  ticksRef.current[index] = node;
                }}
              />
            ))}
          </div>
        ) : null}

        <div
          className={styles.playhead}
          ref={headRef}
          data-live="playhead"
          style={{ left: pct(seed.current.now) }}
        >
          <span className={styles.playheadGrip} />
        </div>
      </div>

      <span className={styles.timeClockTotal}>{clock(race.tMax)}</span>

      <span className={styles.manLabel}>Turns</span>
      <div
        className={styles.manRail}
        role="group"
        aria-label={`Tacks and gybes for ${followed.sail}`}
      >
        {maneuvers.map((maneuver) => (
          <button
            key={maneuver.t}
            type="button"
            className={styles.manMark}
            style={{ left: pct(maneuver.t) }}
            data-maneuver={maneuver.kind}
            data-at={maneuver.t}
            /* The reading names its own definition: Debrief measures the same
               turn from the first fix of its window, which is a different
               number, and a tooltip that said only "off the entry speed" would
               be claiming to be that one. */
            title={`${maneuver.kind === "tack" ? "Tack" : "Gybe"} at ${clock(maneuver.t)}, ${maneuver.lossKnots} kn below its fastest reading in the 4 s before the turn`}
            aria-label={`Go to the ${maneuver.kind} at ${clock(maneuver.t)}`}
            onClick={() => {
              const store = useReplay.getState();
              store.pause();
              store.seek(maneuver.t);
            }}
          >
            <svg className={styles.manGlyph} viewBox="0 0 10 10" aria-hidden="true">
              <path d={maneuver.kind === "tack" ? TACK_GLYPH : GYBE_GLYPH} />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
