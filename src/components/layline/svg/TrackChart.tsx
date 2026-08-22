import { poseAt } from "@/lib/layline/interpolate";
import type { Pose, RaceData } from "@/lib/layline/types";
import styles from "@/app/layline.module.css";

/* The course frame puts +y up the beat, so the drawing negates y to get the
 * screen's downward axis. Everything else is metres, one to one. */
const SAMPLE_STEP = 1; // s between samples, the chart's own frame rate
const PAD = 34; // m of open water left around the fitted tracks

function newPose(): Pose {
  return { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
}

function sampleTrack(race: RaceData, boatId: string, pose: Pose): number[] {
  const fixes = race.fixes[boatId];
  const points: number[] = [];
  if (fixes === undefined || fixes.length === 0) return points;
  const last = fixes[fixes.length - 1].t;
  for (let t = fixes[0].t; t < last; t += SAMPLE_STEP) {
    poseAt(race, boatId, t, "smooth", pose);
    points.push(pose.x, -pose.y);
  }
  poseAt(race, boatId, last, "smooth", pose);
  points.push(pose.x, -pose.y);
  return points;
}

function toPath(points: number[]): string {
  let d = "";
  for (let i = 0; i < points.length; i += 2) {
    d += `${i === 0 ? "M" : "L"}${points[i].toFixed(1)} ${points[i + 1].toFixed(1)}`;
  }
  return d;
}

/**
 * The course seen from above, drawn from the same buffers the replay reads and
 * sampled once a second through the same evaluator. It is the whole page for a
 * visitor with no WebGL and the first thing on screen for everyone else, so it
 * carries the real tracks rather than a decorative squiggle.
 */
export function TrackChart({ race }: { race: RaceData }) {
  const pose = newPose();
  const tracks = race.boats.map((boat) => ({
    boat,
    points: sampleTrack(race, boat.id, pose),
  }));

  const { course } = race;
  let minX = Math.min(course.startPin.x, course.startBoat.x, course.windward.x - course.zoneRadius);
  let maxX = Math.max(course.startPin.x, course.startBoat.x, course.windward.x + course.zoneRadius);
  let minY = -course.windward.y - course.zoneRadius;
  let maxY = 0;
  for (const track of tracks) {
    for (let i = 0; i < track.points.length; i += 2) {
      const x = track.points[i];
      const y = track.points[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const viewBox = [
    (minX - PAD).toFixed(1),
    (minY - PAD).toFixed(1),
    (maxX - minX + PAD * 2).toFixed(1),
    (maxY - minY + PAD * 2).toFixed(1),
  ].join(" ");

  return (
    <svg
      className={styles.chart}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Course chart: ${race.boats.length} boat tracks from the prestart to the finish, with the start line and the windward mark`}
    >
      {tracks.map(({ boat, points }) => (
        <g key={boat.id}>
          {/* A near-black hull colour needs a light edge to survive a dark
              ground, the same outline its standings chip carries. */}
          {boat.dark ? (
            <path
              data-outline={boat.id}
              d={toPath(points)}
              className={styles.chartTrack}
              stroke="var(--ink-dim)"
              strokeWidth={3.2}
              opacity={0.55}
            />
          ) : null}
          <path
            data-track={boat.id}
            d={toPath(points)}
            className={styles.chartTrack}
            stroke={boat.hue}
          />
        </g>
      ))}

      <line
        x1={course.startPin.x}
        y1={-course.startPin.y}
        x2={course.startBoat.x}
        y2={-course.startBoat.y}
        className={styles.chartRule}
        strokeDasharray="7 6"
      />
      <circle cx={course.startPin.x} cy={-course.startPin.y} r={4} className={styles.chartMark} />
      <circle cx={course.startBoat.x} cy={-course.startBoat.y} r={4} className={styles.chartMark} />
      <circle
        cx={course.windward.x}
        cy={-course.windward.y}
        r={course.zoneRadius}
        className={styles.chartZone}
      />
      <circle cx={course.windward.x} cy={-course.windward.y} r={5} className={styles.chartMark} />

      {/* Labels sit out on the right edge of the fitted box: the middle of the
          drawing belongs to the tracks. */}
      <text
        x={maxX.toFixed(1)}
        y={-course.windward.y - 14}
        textAnchor="end"
        className={styles.chartLabel}
      >
        Windward mark
      </text>
      <text x={maxX.toFixed(1)} y={-12} textAnchor="end" className={styles.chartLabel}>
        Start and finish
      </text>
    </svg>
  );
}
