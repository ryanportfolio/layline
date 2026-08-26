"use client";

import { useMemo } from "react";
import { createPose, poseAt } from "@/lib/layline/interpolate";
import type { Pose } from "@/lib/layline/types";
import { raceData } from "../store";
import { useMounted } from "./useMounted";
import styles from "./analyst.module.css";

/* A suggestion card's picture: the exact stretch of the seeded race the
 * question is about, drawn from the same fixes the replay plays. boatId null
 * is the start-line lineup at the gun; otherwise one boat's leg between two
 * event times. Decorative, so the svg is hidden from the tree and never
 * focusable. */

function scratchPose(): Pose {
  return createPose();
}

export function TrackGlyph({
  boatId,
  from,
  to,
  hue,
  strokeWidth,
}: {
  boatId: string | null;
  from: number;
  to: number;
  hue: string;
  strokeWidth?: number;
}) {
  /* Client-only drawing: sampled poses and the fitted viewBox print
   * differently in Node and the browser, so SSR ships an empty svg that CSS
   * already sizes (see useMounted). */
  const mounted = useMounted();
  const built = useMemo(() => {
    if (!mounted) return null;
    const race = raceData();
    const pose = scratchPose();

    if (boatId === null) {
      /* Start glyph, swapped projection: gx = course x, gy = -course y so the
       * line runs horizontal and up-course is up. */
      const dots = race.boats.map((boat) => {
        poseAt(race, boat.id, 0, "smooth", pose);
        return {
          id: boat.id,
          x: pose.x,
          y: -pose.y,
          hue: boat.hue,
          outlined: boat.dark === true,
        };
      });
      return { kind: "start" as const, dots, race };
    }

    /* Leg glyph, backdrop projection: gx = course y, gy = course x. */
    const points: { x: number; y: number }[] = [];
    const push = (t: number) => {
      poseAt(race, boatId, t, "smooth", pose);
      points.push({ x: pose.y, y: pose.x });
    };
    const last = Math.floor(to);
    for (let t = Math.ceil(from); t <= last; t += 1) push(t);
    if (to > last) push(to);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    const d = points
      .map((point, index) =>
        `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)},${point.y.toFixed(2)}`,
      )
      .join(" ");
    const viewBox = `${(minX - 6).toFixed(2)} ${(minY - 6).toFixed(2)} ${(
      maxX - minX + 12
    ).toFixed(2)} ${(maxY - minY + 12).toFixed(2)}`;
    return { kind: "leg" as const, d, viewBox };
  }, [mounted, boatId, from, to]);

  if (built === null) return <svg aria-hidden="true" focusable="false" />;

  if (built.kind === "start") {
    const { course } = built.race;
    return (
      <svg viewBox="-39 -12 78 24" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
        <line
          x1={course.startPin.x}
          y1={0}
          x2={course.startBoat.x}
          y2={0}
          className={styles.glyphStart}
          vectorEffect="non-scaling-stroke"
        />
        {built.dots.map((dot) => (
          <circle
            key={dot.id}
            cx={dot.x}
            cy={dot.y}
            r={4}
            fill={dot.hue}
            className={dot.outlined ? styles.dotOutlined : undefined}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    );
  }

  return (
    <svg viewBox={built.viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      <path
        d={built.d}
        fill="none"
        stroke={hue}
        strokeWidth={strokeWidth ?? 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
