import type { RaceData } from "@/lib/layline/types";
import styles from "@/app/layline.module.css";
import { chartFrame, toPath } from "./chartFrame";
import { CourseFurniture } from "./CourseFurniture";
import {
  CURRENT_FIELD_PROVENANCE,
  CURRENT_FIELD_SVG_MAX_GLYPHS,
  createCurrentFieldGrid,
  sampleCurrentFieldGrid,
} from "@/lib/layline/surfaces";

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
  const currentGrid = createCurrentFieldGrid(race, CURRENT_FIELD_SVG_MAX_GLYPHS);
  sampleCurrentFieldGrid(race, 0, currentGrid);

  return (
    <svg
      className={styles.chart}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      data-renderer="static"
      aria-label="Course chart with the start line, windward mark, and selected analysis layers"
    >
      <g data-analysis-layer="tracks">
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
      </g>

      <g
        data-analysis-layer="current"
        data-current-field="seeded"
        data-sampled-at="0"
        data-provenance={CURRENT_FIELD_PROVENANCE}
        aria-label={`${CURRENT_FIELD_PROVENANCE} at t=0`}
      >
        <title>{`${CURRENT_FIELD_PROVENANCE} at t=0`}</title>
        {currentGrid.glyphs.map((glyph, index) => {
          const angle = (Math.atan2(-glyph.currentY, glyph.currentX) * 180) / Math.PI;
          const length = Math.max(4, glyph.drift * 18);
          return (
            <g
              key={index}
              className={styles.chartCurrentGlyph}
              transform={`translate(${glyph.x.toFixed(2)} ${(-glyph.y).toFixed(2)}) rotate(${angle.toFixed(2)}) scale(${length.toFixed(2)} 1)`}
            >
              <line x1="0" y1="0" x2="1" y2="0" />
              <path d="M1 0 L0.68 -0.18 L0.68 0.18 Z" />
            </g>
          );
        })}
      </g>

      <CourseFurniture course={course} labelX={maxX} />
    </svg>
  );
}
