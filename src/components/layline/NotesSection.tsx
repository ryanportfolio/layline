import { FIX_HZ } from "@/lib/layline/types";
import type { RaceData } from "@/lib/layline/types";
import { FixRateDiagram, HermiteDiagram, ShortArcDiagram } from "./svg/diagrams";
import styles from "@/app/layline.module.css";

/* The excerpt is the feed in the units it is stored in, so the numbers can be
 * checked against the drawings above without a conversion in the way. */
const EXCERPT_BOAT = "nzl";
const EXCERPT_FROM = 18;
const EXCERPT_ROWS = 6;

export function NotesSection({ race }: { race: RaceData }) {
  const fixes = race.fixes[EXCERPT_BOAT];
  const start = fixes.findIndex((fix) => fix.t >= EXCERPT_FROM);
  const excerpt = fixes.slice(start, start + EXCERPT_ROWS);
  const boat = race.boats.find((entry) => entry.id === EXCERPT_BOAT);
  const sail = boat === undefined ? EXCERPT_BOAT.toUpperCase() : boat.sail;

  return (
    <section className={styles.notes} aria-labelledby="notes-heading">
      <h2 id="notes-heading" className={styles.notesHeading}>
        How the replay works
      </h2>
      <div className={styles.note}>
        <div>
          <h3 className={styles.noteHeading}>Four fixes a second</h3>
          <p className={styles.noteBody}>
            Each boat reports {FIX_HZ} times a second: position, speed over the ground, heading,
            heel, wind angle. One reading every {(1000 / FIX_HZ).toFixed(0)} milliseconds.
          </p>
          <p className={styles.noteBody}>
            A screen refreshes sixty times a second. Draw only the fixes and each one holds for
            fifteen frames, then jumps. The boat reaches the mark in the right place at the right
            time and looks wrong the whole way there.
          </p>
        </div>
        <FixRateDiagram race={race} />
      </div>

      <div className={styles.note}>
        <div>
          <h3 className={styles.noteHeading}>Between the fixes</h3>
          <p className={styles.noteBody}>
            A cubic curve fills each gap, one segment per pair of fixes. What matters is where the
            curve gets its direction. A tangent guessed from the fixes either side cuts the corner
            off every tack.
          </p>
          <p className={styles.noteBody}>
            Each fix already carries a speed and a course, measured at that instant. Use those as
            the tangents and the curve leaves every fix on the heading that fix reported, and
            arrives at the next one the same way. The turn keeps its shape. The speed through it
            stays honest.
          </p>
        </div>
        <HermiteDiagram race={race} />
      </div>

      <div className={styles.note}>
        <div>
          <h3 className={styles.noteHeading}>Heading is a circle</h3>
          <p className={styles.noteBody}>
            Position, speed and heel are plain numbers and interpolate like plain numbers. Heading
            is not. It lives on a circle where 359 sits next to 0, so a boat crossing the top of
            the circle produces two readings that look far apart and are not.
          </p>
          <p className={styles.noteBody}>
            Every angle in the engine interpolates the short way round: heading, course over
            ground, wind direction, wind angle. Turn rate is capped at a figure no hull can beat,
            so one bad reading bends the curve and never spins the boat.
          </p>
        </div>
        <ShortArcDiagram race={race} />
      </div>

      <div className={styles.excerpt}>
        <table className={styles.excerptTable}>
          <caption>
            {EXCERPT_ROWS} consecutive fixes from {sail}, a second and a quarter of the feed, in
            the units the engine stores. Everything on this page reads from rows like these
          </caption>
          <thead>
            <tr>
              <th scope="col">T s</th>
              <th scope="col">X m</th>
              <th scope="col">Y m</th>
              <th scope="col">SOG m/s</th>
              <th scope="col">HDG deg</th>
            </tr>
          </thead>
          <tbody>
            {excerpt.map((fix) => (
              <tr key={fix.t}>
                <td>{fix.t.toFixed(2)}</td>
                <td>{fix.x.toFixed(2)}</td>
                <td>{fix.y.toFixed(2)}</td>
                <td>{fix.sog.toFixed(2)}</td>
                <td>{fix.hdg.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className={styles.notesHeading}>Where this build stands</h2>
      <p className={styles.notesLead}>
        The replay half of the build is on the page. Running now: the replay engine, a seeded six
        boat race at four fixes a second, the boat models with wake and spray, three broadcast
        camera rigs, the raw fixes lens, the instrument and standings docks, water, sky, and the
        chart the page falls back to without WebGL. The laylines and marks draw on a damped
        display wind, so one gusty reading cannot swing them. The replay steps fix by fix, one
        reading at a time. Still in work: the analysis layer. Start line timing, maneuver
        detection, boat against fleet comparison.
      </p>
    </section>
  );
}
