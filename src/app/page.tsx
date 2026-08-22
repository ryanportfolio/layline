import type { Metadata } from "next";
import { clock } from "@/lib/layline/format";
import { generateRace } from "@/lib/layline/sim";
import { RACE_SEED } from "@/lib/layline/types";
import { LaylineApp } from "@/components/layline/LaylineApp";
import { NotesSection } from "@/components/layline/NotesSection";
import { TrackChart } from "@/components/layline/svg/TrackChart";
import styles from "./layline.module.css";

export const metadata: Metadata = {
  title: "Layline · Race Replay",
  description:
    "Browser race replay engine for a fictional Long Beach fleet race: continuous 3D motion rebuilt from four fixes a second of boat telemetry.",
};

export default function LaylinePage() {
  /* The server builds the race from the seed for the chart, the finish order
   * and the notes; the client builds its own copy from the same seed. Two
   * readings of one number, never two numbers. */
  const race = generateRace(RACE_SEED);
  const fleet = new Map(race.boats.map((boat) => [boat.id, boat]));

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#replay-console">
        Skip to the replay console
      </a>

      <div className={styles.prototypeBar}>
        <strong>Race replay prototype</strong>
        <span>Fictional event // seeded telemetry // build in progress</span>
        <a href="https://fullbuild.ai/prototype/layline">live at fullbuild.ai ↗</a>
      </div>

      <div className={styles.statusBanner} role="status">
        <strong>Build in progress · replay running, analysis next</strong>
        <span>still landing: start line, maneuver and fleet analytics</span>
      </div>

      <main className={styles.main}>
        <section
          id="replay-console"
          className={styles.console}
          aria-label="Race replay console"
          tabIndex={-1}
        >
          <LaylineApp>
            <div className={styles.fallback}>
              <figure className={styles.chartFigure}>
                <TrackChart race={race} />
                <figcaption className={styles.caption}>
                  Every track, sampled once a second through the same evaluator the replay reads
                </figcaption>
              </figure>

              <div className={styles.resultsPanel}>
                <h2 className={styles.panelHeading}>Finish order</h2>
                <table className={styles.results}>
                  <caption>
                    Elapsed from the gun to the line, {race.boats.length} boats, one lap
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Pos</th>
                      <th scope="col">Sail</th>
                      <th scope="col">Team</th>
                      <th scope="col">Elapsed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {race.results.map((result) => {
                      const boat = fleet.get(result.boatId);
                      return (
                        <tr key={result.boatId}>
                          <td>{result.rank}</td>
                          <td>
                            <span
                              className={styles.hueChip}
                              style={{ background: boat?.hue }}
                              aria-hidden="true"
                            />
                            {boat?.sail}
                          </td>
                          <td>{boat?.name}</td>
                          <td>{clock(result.elapsed)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </LaylineApp>
        </section>

        <NotesSection race={race} />
      </main>

      <footer className={styles.colophon}>Spec work by Ryan Allen | all demo concepts</footer>
    </div>
  );
}
