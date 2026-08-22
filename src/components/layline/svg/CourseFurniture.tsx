import styles from "@/app/layline.module.css";
import type { Course } from "@/lib/layline/types";

/**
 * The line, the mark and its zone, drawn once and used by both chart views so
 * the still and the 2D mode cannot draw the same course two ways. Metres, with
 * y negated for the screen's downward axis.
 */
export function CourseFurniture({
  course,
  labelX,
  named = true,
}: {
  course: Course;
  labelX: number;
  /* The names are set in pixels and the drawing is scaled in metres, so they
   * hold their size only where the box is the one they were fitted to. The 2D
   * mode is given the whole console and reads them off instead. */
  named?: boolean;
}) {
  return (
    <>
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
      {named ? (
        <>
          <text
            x={labelX.toFixed(1)}
            y={-course.windward.y - 14}
            textAnchor="end"
            className={styles.chartLabel}
          >
            Windward mark
          </text>
          <text x={labelX.toFixed(1)} y={-12} textAnchor="end" className={styles.chartLabel}>
            Start and finish
          </text>
        </>
      ) : null}
    </>
  );
}
