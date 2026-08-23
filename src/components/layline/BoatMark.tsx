import styles from "./BoatMark.module.css";

/* The house boat glyph: hull, mast, sail, and a wake that runs on a dash
 * offset. One drawing, two jobs. It is the bullet in the notes lists at 42x24,
 * and the pointer over the water at twice that, so the art lives here and the
 * caller only ever sets the box it is drawn into.
 *
 * Sail and mast take currentColor; the hull takes --ink. `outlined` adds a
 * water-deep edge to the hull, which the pointer needs and the bullet does
 * not: over the sun path the hull is near-white on near-white. */
export function BoatMark({
  className,
  outlined = false,
}: {
  className?: string;
  outlined?: boolean;
}) {
  const classes = [styles.mark, outlined ? styles.outlined : null, className]
    .filter(Boolean)
    .join(" ");

  return (
    <svg className={classes} viewBox="0 0 42 24" aria-hidden="true" focusable="false">
      <path className={styles.wake} d="M1 17h13M5 21h8" />
      <path className={styles.hull} d="M12 15h27l-5 6H18z" />
      <path className={styles.mast} d="M24 15V2" />
      <path className={styles.sail} d="M22 4v10H13zM26 3v11h10z" />
    </svg>
  );
}
