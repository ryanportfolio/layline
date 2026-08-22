"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { poseAt } from "@/lib/layline/interpolate";
import type { Pose } from "@/lib/layline/types";
import { raceData } from "../store";
import { chartFrame, lengthAt, toPath } from "../svg/chartFrame";
import { CourseFurniture } from "../svg/CourseFurniture";
import { clock } from "@/lib/layline/format";
import styles from "./analyst.module.css";

/**
 * The loaded race, sailing itself, on the empty slate.
 *
 * The panel used to open on a stopped clock reading the last boat's elapsed
 * time, beside a header ident reading the length of the feed: two race clocks
 * an arm's length apart, neither of them saying what it measured. This draws
 * the same race instead. Six tracks lay themselves down as their boats sail
 * them, on the same fitted frame the console's 2D mode uses, and the clock
 * beside them counts the race it is drawing.
 *
 * Its own clock, not the replay's: the console above may be paused, seeked or
 * mid-tack, and this is the panel's attract loop rather than a second view of
 * the console's state. A whole race takes LOOP_S, holds on the finished
 * picture, then starts again from the gun.
 */
const LOOP_S = 9; // wall seconds for the whole race
const HOLD_MS = 1600; // the finished course holds before the next lap
const GAP = 100000; // one dash gap that outruns the longest track

/* The handover between laps.
 *
 * A drawing that snaps back to bare water is a cut, and a cut in the corner of
 * the eye reads as a glitch. Instead the finished plot is handed to a ghost
 * layer: the same six tracks, complete and faint, which fades up while the
 * live ones still hold the picture. The live layer resets to nothing behind
 * that cover, the fleet sets off again, and the ghost fades away over the
 * first quarter of the new lap. Nothing ever disappears on a frame boundary,
 * and the last lap is still on the water while the next one draws over it,
 * which is how a plot on a chart table actually accumulates.
 */
const GHOST_IN_MS = 520; // the finished plot handed to the ghost
const GHOST_OUT_MS = 2600; // and let go of, over the new lap's opening

interface Node {
  line: SVGPathElement;
  hull: SVGGElement;
  length: number;
}

/* Six metres of hull, pointing up the course before its heading turns it. */
const HULL = "M0 -4.6 L2.6 3.4 L0 1.9 L-2.6 3.4 Z";

export function SlateReplay({ reduced }: { reduced: boolean }) {
  const race = useMemo(() => raceData(), []);
  const frame = useMemo(() => chartFrame(race), [race]);
  const lines = useRef(new Map<string, SVGPathElement | null>());
  const hulls = useRef(new Map<string, SVGGElement | null>());
  const clockRef = useRef<HTMLParagraphElement | null>(null);
  const ghostRef = useRef<SVGGElement | null>(null);
  const liveRef = useRef<SVGGElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pose = useRef<Pose>({ x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 });
  const [inView, setInView] = useState(false);

  /* The race ends when the last boat crosses, not when the fixes stop: the
   * feed runs on a few seconds past the line while boats coast. */
  const end = useMemo(() => {
    let last = race.tMin;
    for (const result of race.results) if (result.elapsed > last) last = result.elapsed;
    return last;
  }, [race]);

  useEffect(() => {
    const node = hostRef.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting === true),
      { threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const nodes: Array<Node & { boatId: string }> = [];
    for (const track of frame.tracks) {
      const line = lines.current.get(track.boat.id);
      const hull = hulls.current.get(track.boat.id);
      if (line == null || hull == null) continue;
      const length = track.lengths[track.lengths.length - 1];
      line.style.strokeDasharray = `0 ${GAP}`;
      nodes.push({ line, hull, length, boatId: track.boat.id });
    }

    const draw = (t: number) => {
      for (const node of nodes) {
        const track = frame.tracks.find((entry) => entry.boat.id === node.boatId);
        if (track === undefined) continue;
        const drawn = lengthAt(track, t);
        node.line.style.strokeDasharray = `${drawn.toFixed(1)} ${GAP}`;
        poseAt(race, node.boatId, t, "smooth", pose.current);
        node.hull.setAttribute(
          "transform",
          `translate(${pose.current.x.toFixed(1)} ${(-pose.current.y).toFixed(1)}) rotate(${pose.current.hdg.toFixed(1)})`,
        );
      }
      if (clockRef.current !== null) clockRef.current.textContent = clock(t);
    };

    /* Reduced motion gets the whole race at once: every track complete, every
     * hull parked on the line it crossed. */
    if (reduced || !inView) {
      draw(end);
      return;
    }

    let frameId = 0;
    let started = 0;
    let handoverAt = 0;
    const span = end - race.tMin;
    const ghost = ghostRef.current;
    const live = liveRef.current;

    const setGhost = (value: number, ms: number) => {
      if (ghost === null) return;
      ghost.style.transition = `opacity ${ms}ms var(--ease)`;
      ghost.style.opacity = value.toFixed(2);
    };
    /* The clock is the one thing that cannot cross-fade with the drawing: it
     * would have to read two times at once. It dips out while the ghost takes
     * over and comes back on the new lap's first frame. */
    const setClockLit = (lit: boolean) => {
      if (clockRef.current === null) return;
      clockRef.current.style.opacity = lit ? "1" : "0";
    };

    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick);
      if (started === 0) started = now;

      if (handoverAt > 0) {
        const since = now - handoverAt;
        if (since < HOLD_MS) return;
        /* Cover is up: the live layer can be wound back to nothing without
         * anybody seeing it happen. */
        if (live !== null) live.style.opacity = "1";
        draw(race.tMin);
        setClockLit(true);
        setGhost(0, GHOST_OUT_MS);
        handoverAt = 0;
        started = now;
        return;
      }

      const through = (now - started) / (LOOP_S * 1000);
      if (through >= 1) {
        draw(end);
        setGhost(1, GHOST_IN_MS);
        setClockLit(false);
        handoverAt = now;
        return;
      }
      draw(race.tMin + through * span);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [frame, race, end, reduced, inView]);

  /* The course runs up the page and the slate's slot runs across it, so the
   * whole drawing takes a quarter turn: the beat leaves to the right and the
   * run comes back, and the fitted box fills the width instead of sitting in
   * a letterbox down the middle. rotate(-90) sends (x, y) to (y, -x), so the
   * viewBox trades places with it. */
  const turned = useMemo(() => {
    const [x, y, w, h] = frame.viewBox.split(" ").map(Number);
    return `${y} ${-(x + w)} ${h} ${w}`;
  }, [frame]);

  return (
    <div ref={hostRef} className={styles.slateChart}>
      <svg className={styles.slateSvg} viewBox={turned} aria-hidden="true">
        <g transform="rotate(-90)">
        <CourseFurniture course={race.course} labelX={frame.maxX} named={false} />
        {/* Last lap, complete and faint, holding the picture through the
            handover while the live layer winds back to the gun. */}
        <g ref={ghostRef} className={styles.slateGhost}>
          {frame.tracks.map((track) => (
            <path
              key={track.boat.id}
              className={styles.slateTrack}
              style={{ color: track.boat.hue }}
              d={toPath(track.points)}
            />
          ))}
        </g>
        <g ref={liveRef}>
        {frame.tracks.map((track) => (
          <g key={track.boat.id} style={{ color: track.boat.hue }}>
            <path
              ref={(node) => {
                lines.current.set(track.boat.id, node);
              }}
              className={styles.slateTrack}
              d={toPath(track.points)}
            />
            <g
              ref={(node) => {
                hulls.current.set(track.boat.id, node);
              }}
            >
              <path className={styles.slateHull} d={HULL} />
            </g>
          </g>
        ))}
        </g>
        </g>
      </svg>
      <p ref={clockRef} className={styles.slateChartClock}>
        {clock(race.tMin)}
      </p>
    </div>
  );
}
