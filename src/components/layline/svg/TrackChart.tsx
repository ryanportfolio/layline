import type { RaceData } from "@/lib/layline/types";
import styles from "@/app/layline.module.css";
import { chartFrame, toPath } from "./chartFrame";
import { CourseFurniture } from "./CourseFurniture";

/**
 * The course seen from above, drawn from the same buffers the replay reads and
 * sampled once a second through the same evaluator. It is the whole page for a
 * visitor with no WebGL and the first thing on screen for everyone else, so it
 * carries the real tracks rather than a decorative squiggle.
 *
 * This is the still of it. The 2D mode beside it draws the same frame on the
 * replay clock.
 */
export function TrackChart({ race }: { race: RaceData }) {
  const { viewBox, maxX, tracks } = chartFrame(race);
  const { course } = race;

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

      <CourseFurniture course={course} labelX={maxX} />
    </svg>
  );
}
