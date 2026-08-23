import type { Metadata } from "next";
import Link from "next/link";
import { clock } from "@/lib/layline/format";
import { generateRace } from "@/lib/layline/sim";
import { RACE_SEED } from "@/lib/layline/types";
import { AnalystSection } from "@/components/layline/analyst/AnalystSection";
import { CourseRail } from "@/components/layline/CourseRail";
import { IntroOverlay } from "@/components/layline/intro/IntroOverlay";
import { LaylineApp } from "@/components/layline/LaylineApp";
import { NotesSection } from "@/components/layline/NotesSection";
import { TrackChart } from "@/components/layline/svg/TrackChart";
import RailLogo from "@/components/chrome/RailLogo";
import styles from "./layline.module.css";
import "./scrollbar.css";

export const metadata: Metadata = {
  title: "Layline · Race Replay",
  description:
    "Browser race replay engine for a fictional Long Beach fleet race: continuous 3D motion rebuilt from 4 GPS points a second.",
};

export default function LaylinePage() {
  /* The server builds the race from the seed for the chart, the finish order
   * and the notes; the client builds its own copy from the same seed. Two
   * readings of one number, never two numbers. */
  const race = generateRace(RACE_SEED);
  const fleet = new Map(race.boats.map((boat) => [boat.id, boat]));

  return (
    <div className={styles.shell} data-layline-page>
      <a className={styles.skip} href="#replay-console">
        Skip to the replay console
      </a>

      {/* Inside the shell so it reads the page's tokens, over everything the
          shell paints so the wait belongs to one picture. Rendered after the
          skip link, which stays the first thing a keyboard reaches. */}
      <IntroOverlay />

      <div className={styles.prototypeBar}>
        <strong>Layline race replay</strong>
        <span>2D / 3D playback // seeded telemetry</span>
        <Link href="https://github.com/ryanportfolio/layline">
          <strong>View source</strong>
        </Link>
      </div>

      <div className={styles.statusBanner}>
        <strong>Telemetry in, race replay out</strong>
        <span>Playback, analytics, and post-race review in 1 browser experience</span>
      </div>

      <main className={styles.main}>
        <section
          id="replay-console"
          className={styles.console}
          aria-label="Race replay console"
          tabIndex={-1}
          data-leg="Replay console"
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
                    Elapsed from the gun to the line, {race.boats.length} boats, 1 lap
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

        {process.env.OPENROUTER_API_KEY || process.env.LAYLINE_ANALYST_MOCK === "1" ? (
          <AnalystSection />
        ) : null}

        <NotesSection race={race} />
      </main>

      <footer className={styles.colophon}>
        <span>Built by Ryan Allen</span>
        <span aria-hidden="true">·</span>
        <Link href="https://github.com/ryanportfolio/layline">
          <strong>View source</strong>
        </Link>
        <span aria-hidden="true">·</span>
        <Link className={styles.homeLink} href="https://fullbuild.ai">
          <RailLogo className={styles.footerHouseMark} />
          <span>fullbuild.ai</span>
        </Link>
      </footer>

      {/* The right margin, drawn as the course. Inside the shell so it inherits
          the console's palette, and last so nothing is stacked over it. It
          stands the platform bar down itself, at mount, and only at the widths
          where it actually draws. */}
      <CourseRail />
    </div>
  );
}
