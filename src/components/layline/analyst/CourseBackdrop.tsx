"use client";

import clsx from "clsx";
import { memo, useMemo } from "react";
import { poseAt } from "@/lib/layline/interpolate";
import type { Pose } from "@/lib/layline/types";
import { raceData } from "../store";
import { useMounted } from "./useMounted";
import styles from "./analyst.module.css";

/* The panel ground is the course itself: the amber start line, the mark zone,
 * and every boat's actual track sampled straight out of the seeded fixes.
 * Projection swaps the axes (screen x = course y, screen y = course x) so the
 * race reads left to right the way the conversation does. Two stacked svgs
 * share one viewBox: the base layer always shows the prestart water; the race
 * layer holds the after-the-gun tracks and is revealed by a clip-path wipe
 * once the first question is asked. Entirely decorative: hidden from the
 * tree, never focusable, never hit-testable. */

interface BuiltTrack {
  id: string;
  hue: string;
  preD: string;
  raceD: string;
  gunX: number;
  gunY: number;
  dotOutlined: boolean;
  underlay: boolean;
}

function scratchPose(): Pose {
  return { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
}

/* Memoized: the tracks are multi kilobyte path strings that never change
 * after the first build, and the panel around this re-renders on every word of
 * a streaming answer. The hot set holds its identity through a stream, so the
 * backdrop reconciles when an answer finishes and not before. */
export const CourseBackdrop = memo(function CourseBackdrop({
  hot,
}: {
  hot: ReadonlySet<string>;
}) {
  /* Client-only drawing: poseAt's floats print differently in Node and the
   * browser, so SSR ships the container empty (see useMounted). */
  const mounted = useMounted();
  const built = useMemo(() => {
    if (!mounted) return null;
    const race = raceData();
    const pose = scratchPose();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const grow = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    const sample = (boatId: string, t: number): string => {
      poseAt(race, boatId, t, "smooth", pose);
      const x = pose.y;
      const y = pose.x;
      grow(x, y);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    };
    const toPath = (points: string[]): string =>
      points.map((point, index) => `${index === 0 ? "M" : "L"} ${point}`).join(" ");

    const tracks: BuiltTrack[] = race.boats.map((boat) => {
      const pre: string[] = [];
      for (let t = Math.ceil(race.tMin); t <= 0; t += 1) pre.push(sample(boat.id, t));
      const after: string[] = [];
      for (let t = 0; t < race.tMax; t += 1) after.push(sample(boat.id, t));
      after.push(sample(boat.id, race.tMax));
      poseAt(race, boat.id, 0, "smooth", pose);
      return {
        id: boat.id,
        hue: boat.hue,
        preD: toPath(pre),
        raceD: toPath(after),
        gunX: pose.y,
        gunY: pose.x,
        dotOutlined: boat.dark === true,
        underlay: boat.id === "nzl",
      };
    });

    const { course } = race;
    grow(0, course.startPin.x);
    grow(0, course.startBoat.x);
    grow(course.windward.y - course.zoneRadius, course.windward.x - course.zoneRadius);
    grow(course.windward.y + course.zoneRadius, course.windward.x + course.zoneRadius);
    const viewBox = `${(minX - 12).toFixed(2)} ${(minY - 12).toFixed(2)} ${(
      maxX - minX + 24
    ).toFixed(2)} ${(maxY - minY + 24).toFixed(2)}`;
    return { tracks, viewBox, course };
  }, [mounted]);

  if (built === null) return <div className={styles.backdrop} aria-hidden="true" />;

  const { tracks, viewBox, course } = built;
  return (
    <div className={styles.backdrop} aria-hidden="true">
      <svg
        className={styles.baseSvg}
        width="100%"
        height="100%"
        viewBox={viewBox}
        preserveAspectRatio="xMinYMid slice"
        aria-hidden="true"
        focusable="false"
      >
        <line
          x1={0}
          y1={course.startPin.x}
          x2={0}
          y2={course.startBoat.x}
          className={styles.startLine}
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={course.windward.y}
          cy={course.windward.x}
          r={course.zoneRadius}
          className={styles.zoneRing}
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={course.windward.y} cy={course.windward.x} r={0.7} className={styles.markDot} />
        {tracks.map((track) => (
          <g key={track.id} style={{ color: track.hue }}>
            {track.underlay ? (
              <path d={track.preD} className={styles.trackUnderlay} vectorEffect="non-scaling-stroke" />
            ) : null}
            <path d={track.preD} className={styles.preTrack} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {tracks.map((track) => (
          <circle
            key={track.id}
            cx={track.gunX}
            cy={track.gunY}
            r={0.6}
            fill={track.hue}
            className={track.dotOutlined ? styles.dotOutlined : undefined}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <svg
        className={styles.raceSvg}
        width="100%"
        height="100%"
        viewBox={viewBox}
        preserveAspectRatio="xMinYMid slice"
        aria-hidden="true"
        focusable="false"
      >
        {tracks.map((track) => (
          <g
            key={track.id}
            className={clsx(
              hot.size > 0 && (hot.has(track.id) ? styles.trackHot : styles.trackDim),
            )}
            style={{ color: track.hue }}
          >
            {track.underlay ? (
              <path d={track.raceD} className={styles.trackUnderlay} vectorEffect="non-scaling-stroke" />
            ) : null}
            <path d={track.raceD} className={styles.raceTrack} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>
    </div>
  );
});
