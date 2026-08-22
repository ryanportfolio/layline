"use client";

import { useEffect, useMemo, useRef } from "react";
import styles from "@/app/layline.module.css";
import { poseAt } from "@/lib/layline/interpolate";
import { FIX_HZ, type Pose, type RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { onLive, sampleLive } from "../hud/live";
import { chartFrame, lengthAt, toPath, type ChartTrack } from "./chartFrame";
import { CourseFurniture } from "./CourseFurniture";

/* The hull, six metres of it, pointing up the course before it is rotated onto
 * its heading. Metres, like everything else in this drawing. */
const HULL = "M0 -5.4 L3 4 L0 2.2 L-3 4 Z";

/* A dash pattern only has to outrun the longest track once, so the gap is
 * stated rather than measured every frame. */
const GAP = 100000;

interface Node {
  track: ChartTrack;
  line: SVGPathElement;
  outline: SVGPathElement | null;
  hull: SVGGElement;
  drawn: number;
  x: number;
  y: number;
  hdg: number;
}

/**
 * 2D mode. The same fitted frame as the still chart, on the replay clock: each
 * track draws itself as its boat sails it and a hull marker sits at the head of
 * it, both written straight into the DOM off the same evaluator the scene and
 * the docks read.
 *
 * Reveal is a dash length measured along the polyline the path was built from,
 * so the drawn stretch is the water the boat has actually covered rather than a
 * share of the clock.
 */
export function ChartView({ race }: { race: RaceData }) {
  const followId = useReplay((state) => state.followId);
  const frame = useMemo(() => chartFrame(race), [race]);
  const lines = useRef(new Map<string, SVGPathElement | null>());
  const outlines = useRef(new Map<string, SVGPathElement | null>());
  const hulls = useRef(new Map<string, SVGGElement | null>());
  /* One pose for the whole pass: every boat is evaluated into it in turn and
   * nothing survives the frame. */
  const pose = useRef<Pose>({ x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 });

  /* The drawing is seeded off the clock this render sees rather than left at
   * nothing for the listener to fill in, so the mode opens on the race as it
   * stands and a re-render for another boat cannot wind every track back to
   * the start of the feed. One pose object per render, never per frame. */
  const now = sampleLive(race);
  const seedPose: Pose = { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
  const seedT = now.mode === "raw" ? Math.floor(now.t * FIX_HZ) / FIX_HZ : now.t;
  const seedDash = (track: ChartTrack) => `${lengthAt(track, seedT).toFixed(1)} ${GAP}`;
  const seedHull = (boatId: string) => {
    poseAt(race, boatId, now.t, now.mode, seedPose);
    return `translate(${seedPose.x.toFixed(1)} ${(-seedPose.y).toFixed(1)}) rotate(${seedPose.hdg.toFixed(1)})`;
  };

  useEffect(() => {
    const nodes: Node[] = [];
    for (const track of frame.tracks) {
      const line = lines.current.get(track.boat.id) ?? null;
      const hull = hulls.current.get(track.boat.id) ?? null;
      if (line === null || hull === null) continue;
      nodes.push({
        track,
        line,
        outline: outlines.current.get(track.boat.id) ?? null,
        hull,
        drawn: Number.NaN,
        x: Number.NaN,
        y: Number.NaN,
        hdg: Number.NaN,
      });
    }

    return onLive(race, (live) => {
      /* The raw lens holds every hull at its latest fix, so the trail head has
       * to hold there too or it slides ahead of the boat between fixes. */
      const tDraw = live.mode === "raw" ? Math.floor(live.t * FIX_HZ) / FIX_HZ : live.t;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const drawn = lengthAt(node.track, tDraw);
        /* Half a metre is a tenth of a hull length and well under a pixel at
         * every size this drawing is shown at. */
        if (!(Math.abs(drawn - node.drawn) < 0.5)) {
          node.drawn = drawn;
          const dash = `${drawn.toFixed(1)} ${GAP}`;
          node.line.setAttribute("stroke-dasharray", dash);
          if (node.outline !== null) node.outline.setAttribute("stroke-dasharray", dash);
        }
        poseAt(race, node.track.boat.id, live.t, live.mode, pose.current);
        const x = pose.current.x;
        const y = -pose.current.y;
        const hdg = pose.current.hdg;
        if (
          !(Math.abs(x - node.x) < 0.05 && Math.abs(y - node.y) < 0.05 && Math.abs(hdg - node.hdg) < 0.2)
        ) {
          node.x = x;
          node.y = y;
          node.hdg = hdg;
          node.hull.setAttribute(
            "transform",
            `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${hdg.toFixed(1)})`,
          );
        }
      }
    });
  }, [race, frame]);

  return (
    <div className={styles.chartLayer}>
      <svg
        className={styles.chartView}
        viewBox={frame.viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Course chart on the replay clock: ${race.boats.length} boat tracks drawing from the prestart, with the start line and the windward mark`}
        data-view="chart2d"
      >
        {/* The whole route at a whisper, so a boat is read against where it is
            going as well as where it has been. */}
        {frame.tracks.map(({ boat, points }) => (
          <path
            key={`ghost-${boat.id}`}
            d={toPath(points)}
            className={styles.chart2dGhost}
            stroke={boat.dark === true ? "var(--ink-dim)" : boat.hue}
          />
        ))}

        {frame.tracks.map((track) => (
          <g key={track.boat.id} opacity={track.boat.id === followId ? 1 : 0.62}>
            {track.boat.dark === true ? (
              <path
                ref={(node) => {
                  outlines.current.set(track.boat.id, node);
                }}
                d={toPath(track.points)}
                className={styles.chartTrack}
                stroke="var(--ink-dim)"
                strokeWidth={3.2}
                opacity={0.55}
                strokeDasharray={seedDash(track)}
              />
            ) : null}
            <path
              data-track={track.boat.id}
              ref={(node) => {
                lines.current.set(track.boat.id, node);
              }}
              d={toPath(track.points)}
              className={styles.chartTrack}
              stroke={track.boat.hue}
              strokeDasharray={seedDash(track)}
            />
          </g>
        ))}

        <CourseFurniture course={race.course} labelX={frame.maxX} named={false} />

        {frame.tracks.map(({ boat }) => (
          <g
            key={`hull-${boat.id}`}
            data-hull={boat.id}
            transform={seedHull(boat.id)}
            ref={(node) => {
              hulls.current.set(boat.id, node);
            }}
          >
            <path
              d={HULL}
              fill={boat.hue}
              stroke={boat.id === followId ? "var(--ink)" : "var(--ink-dim)"}
              strokeWidth={boat.id === followId ? 1.4 : 0.8}
              strokeLinejoin="round"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
