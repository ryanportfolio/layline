"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { raceData } from "./store";
import { chartFrame, lengthAt, toPath } from "./svg/chartFrame";
import type { ChartTrack } from "./svg/chartFrame";
import styles from "./pageGround.module.css";

/**
 * The page ground: the race, plotted under the whole document.
 *
 * Everything on this page below the console used to sit on one flat fill, which
 * is four thousand pixels of nothing behind the sections that explain how the
 * race was built. This draws the same seeded race the console replays, at a
 * scale nobody reads it at, and lets the scroll sail it: the top of the
 * document is the gun and the bottom is the last finisher, so reading down the
 * page runs the race behind it.
 *
 * It moves at half the scroll rate. Half, not none and not one: locked to the
 * viewport it would read as a texture stuck to the glass, and locked to the
 * document it would be one more thing scrolling past at the same speed as the
 * type.
 *
 * The light under it is two radial falls, one behind the console and one down
 * at the notes. They are the reason the page ground is now a gradient surface
 * at all; see the amendment in layline.module.css.
 */

/* Half the scroll rate, applied to the whole layer. */
const PARALLAX = 0.5;

/* The plot's box, and where its top edge sits in document pixels. Both are
 * document measurements, so they hold whatever the viewport is. */
const PLOT_PX = 2250;
const PLOT_TOP_PX = 1100;

/* Weights that have to stay put on screen while the drawing is in metres, the
 * same conversion the intro's plot does. */
const TRACK_PX = 2;
const MARK_PX = 5;
const HEAD_PX = 4;
const DASH_PX = 9;

const GAP = 100000; // one dash gap that outruns the longest track

/* Where the reveal is measured from. The drawing is ahead of the reader by a
 * little over half a viewport, so the fleet is always sailing into the section
 * being read rather than out of it. */
const LEAD = 0.55;
const TAIL = 0.45;

/**
 * The drawn end of a track, on the same polyline the dash length is measured
 * along, so the head and the end of the line are one point.
 *
 * Read off the sampled arrays rather than out of the DOM. The obvious version
 * of this is getPointAtLength on the path, and the obvious version puts six
 * geometry queries in a loop that already runs on every scroll frame behind a
 * live renderer.
 */
function headAt(track: ChartTrack, t: number, out: { x: number; y: number }): void {
  const times = track.times;
  const n = times.length;
  if (n === 0) return;
  if (t <= times[0]) {
    out.x = track.points[0];
    out.y = track.points[1];
    return;
  }
  if (t >= times[n - 1]) {
    out.x = track.points[n * 2 - 2];
    out.y = track.points[n * 2 - 1];
    return;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const u = span > 0 ? (t - times[lo]) / span : 0;
  out.x = track.points[lo * 2] + (track.points[hi * 2] - track.points[lo * 2]) * u;
  out.y = track.points[lo * 2 + 1] + (track.points[hi * 2 + 1] - track.points[lo * 2 + 1]) * u;
}

export function PageGround() {
  const race = useMemo(() => raceData(), []);
  const frame = useMemo(() => chartFrame(race), [race]);

  /* Client-only, the same reason the intro's plot is: the track paths are
   * float arithmetic formatted to one decimal, and Node and the browser
   * disagree by an ulp somewhere in six long strings. */
  const [live, setLive] = useState(false);
  const [still, setStill] = useState(false);

  const driftRef = useRef<HTMLDivElement | null>(null);
  const lines = useRef(new Map<string, SVGPathElement | null>());
  const edges = useRef(new Map<string, SVGPathElement | null>());
  const heads = useRef(new Map<string, SVGCircleElement | null>());

  /* rotate(-90) sends (x, y) to (y, -x) and the viewBox trades places with it,
   * the same turn the intro makes: the beat runs across the plot rather than
   * up it, which is the shape of a page. */
  const turned = useMemo(() => {
    const [x, y, w, h] = frame.viewBox.split(" ").map(Number);
    return { box: `${y} ${-(x + w)} ${h} ${w}`, w: h, h: w };
  }, [frame]);

  /* Metres per pixel at the size the plot is drawn, worked back from the box
   * the browser will fit. Every fixed-weight decoration goes through it. */
  const metre = useMemo(() => {
    const fit = PLOT_PX / Math.max(turned.w, turned.h);
    return fit > 0 ? 1 / fit : 1;
  }, [turned]);

  /* The feed runs on past the last finisher while boats coast, so the reveal
   * ends on the line rather than on the last fix. */
  const end = useMemo(() => {
    let last = race.tMin;
    for (const result of race.results) if (result.elapsed > last) last = result.elapsed;
    return last;
  }, [race]);

  useEffect(() => {
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    setLive(true);
  }, []);

  useEffect(() => {
    if (!live) return;

    const nodes: Array<{
      line: SVGPathElement;
      edge: SVGPathElement | null;
      head: SVGCircleElement | null;
      track: (typeof frame.tracks)[number];
    }> = [];
    for (const track of frame.tracks) {
      const line = lines.current.get(track.boat.id);
      if (line == null) continue;
      nodes.push({
        line,
        edge: edges.current.get(track.boat.id) ?? null,
        head: heads.current.get(track.boat.id) ?? null,
        track,
      });
    }

    /* How tall the document is and how much of it is on screen. Both are
     * layout reads, so they are taken when the page changes shape and never
     * inside the scroll path: asking for scrollHeight on every scroll frame
     * flushes layout on a document this size, every frame, for a number that
     * changes about twice a session. */
    let doc = 0;
    let view = 0;
    const head = { x: 0, y: 0 };

    const paint = () => {
      const offset = still ? 0 : window.scrollY * PARALLAX;
      const drift = driftRef.current;
      if (drift !== null && !still) {
        drift.style.transform = `translate3d(0, ${-offset.toFixed(1)}px, 0)`;
      }
      const span = Math.max(1, doc - view * TAIL);
      const through = still ? 1 : Math.min(1, Math.max(0, (offset + view * LEAD) / span));
      const t = race.tMin + through * (end - race.tMin);
      for (const node of nodes) {
        const drawn = lengthAt(node.track, t);
        const dash = `${drawn.toFixed(1)} ${GAP}`;
        node.line.style.strokeDasharray = dash;
        if (node.edge !== null) node.edge.style.strokeDasharray = dash;
        if (node.head === null) continue;
        headAt(node.track, t, head);
        node.head.setAttribute("cx", head.x.toFixed(1));
        node.head.setAttribute("cy", head.y.toFixed(1));
        node.head.style.opacity = through >= 1 ? "0" : "1";
      }
    };

    const measure = () => {
      view = window.innerHeight;
      const next = document.documentElement.scrollHeight;
      if (next !== doc) {
        doc = next;
        const drift = driftRef.current;
        if (drift !== null) drift.style.height = `${doc}px`;
      }
      paint();
    };

    measure();
    if (still) return;

    /* The document grows twice on this page after the first paint, once when
     * the renderer lands and once when the docks appear, and either can move
     * where the finish falls. */
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);

    let frameId = 0;
    const onScroll = () => {
      if (frameId !== 0) return;
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        paint();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure, { passive: true });
    return () => {
      observer.disconnect();
      if (frameId !== 0) cancelAnimationFrame(frameId);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
    };
  }, [live, still, frame, race, end]);

  return (
    <div className={styles.ground} data-still={still ? "true" : undefined} aria-hidden="true">
      <div ref={driftRef} className={styles.drift}>
        <div className={styles.light} />
        {live ? (
          <svg
            className={styles.plot}
            width={PLOT_PX}
            height={PLOT_PX}
            viewBox={turned.box}
            preserveAspectRatio="xMidYMid meet"
            style={{ top: `${PLOT_TOP_PX}px` }}
          >
            <g transform="rotate(-90)">
              <line
                className={styles.startLine}
                x1={race.course.startPin.x}
                y1={-race.course.startPin.y}
                x2={race.course.startBoat.x}
                y2={-race.course.startBoat.y}
                strokeWidth={(TRACK_PX * metre).toFixed(3)}
                strokeDasharray={`${(DASH_PX * metre).toFixed(2)} ${(DASH_PX * metre).toFixed(2)}`}
              />
              <circle
                className={styles.zone}
                cx={race.course.windward.x}
                cy={-race.course.windward.y}
                r={race.course.zoneRadius}
                strokeWidth={(TRACK_PX * metre).toFixed(3)}
              />
              {[race.course.startPin, race.course.startBoat, race.course.windward].map((mark) => (
                <circle
                  key={`${mark.x},${mark.y}`}
                  className={styles.mark}
                  cx={mark.x}
                  cy={-mark.y}
                  r={(MARK_PX * metre).toFixed(3)}
                />
              ))}

              {frame.tracks.map((track) => (
                <g key={track.boat.id} style={{ color: track.boat.hue }}>
                  {/* A near-black hull needs a light edge to survive a dark
                      ground, the same outline it gets on the chart and on its
                      standings chip. Without it the fleet is five boats. */}
                  {track.boat.dark === true ? (
                    <path
                      ref={(node) => {
                        edges.current.set(track.boat.id, node);
                      }}
                      className={styles.edge}
                      d={toPath(track.points)}
                      strokeWidth={(TRACK_PX * 2 * metre).toFixed(3)}
                      strokeDasharray={`0 ${GAP}`}
                    />
                  ) : null}
                  <path
                    ref={(node) => {
                      lines.current.set(track.boat.id, node);
                    }}
                    className={styles.track}
                    d={toPath(track.points)}
                    strokeWidth={(TRACK_PX * metre).toFixed(3)}
                    strokeDasharray={`0 ${GAP}`}
                  />
                  <circle
                    ref={(node) => {
                      heads.current.set(track.boat.id, node);
                    }}
                    className={styles.head}
                    r={(HEAD_PX * metre).toFixed(3)}
                    cx="0"
                    cy="0"
                  />
                </g>
              ))}
            </g>
          </svg>
        ) : null}
      </div>
    </div>
  );
}
