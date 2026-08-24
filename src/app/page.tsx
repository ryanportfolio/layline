import type { Metadata } from "next";
import Link from "next/link";
import { clock } from "@/lib/layline/format";
import { RACES } from "@/lib/layline/races";
import { generateRace } from "@/lib/layline/sim";
import { RACE_SEED } from "@/lib/layline/types";
import { AnalystSection } from "@/components/layline/analyst/AnalystSection";
import { CourseRail } from "@/components/layline/CourseRail";
import { IntroOverlay } from "@/components/layline/intro/IntroOverlay";
import { LaylineApp } from "@/components/layline/LaylineApp";
import { NotesSection } from "@/components/layline/NotesSection";
import { PageGround } from "@/components/layline/PageGround";
import { StartSequence } from "@/components/layline/StartSequence";
import { TrackChart } from "@/components/layline/svg/TrackChart";
import RailLogo from "@/components/chrome/RailLogo";
import { BindShippedRace } from "./BindShippedRace";
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
  /* The bar's left slot names where it goes and how much is there. The count is
   * the registry's own length, so a fourth race is announced here by shipping
   * it rather than by remembering to edit a number. */
  const libraryLabel = `Race library // ${RACES.length} races`;

  return (
    <div className={styles.shell} data-layline-page>
      {/* Pangram Display is declared font-display: block and this is the only
          route that sets anything in it, so the file is asked for here rather
          than in the root layout, where every other page would carry 21 kB it
          never draws with. React hoists this into the head, so the fetch
          starts with the document instead of waiting for the stylesheet to
          parse and the wordmark to be laid out. */}
      <link
        rel="preload"
        href="/assets/fonts/pangram-display.woff2"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
      />

      {/* Draws nothing. Ahead of every client component so that all of them
          read the shipped race, including a visit that arrived from the
          library on another one. The page ground below reads the race while it
          renders, so it has to come second. */}
      <BindShippedRace />

      {/* Under everything the shell paints and over nothing: the race drawn
          across the whole document, with two falls of light behind it. */}
      <PageGround />

      <a className={styles.skip} href="#replay-console">
        Skip to the replay console
      </a>

      {/* Inside the shell so it reads the page's tokens, over everything the
          shell paints so the wait belongs to one picture. Rendered after the
          skip link, which stays the first thing a keyboard reaches. */}
      <IntroOverlay />

      <div className={styles.prototypeBar}>
        {/* aria-label pins the name, so the sheen's duplicate of the words is
            never read out as a second label. */}
        <Link
          className={styles.libraryCta}
          href="/races"
          aria-label={libraryLabel}
        >
          {/* Staff and flag, so the way through carries the same signal the
              sequence board strikes at the foot of the page. The board draws a
              rectangle flush with the head of its staff, so this does too: a
              pennant here and a rectangle there would read as two different
              flags. Decoration only, the anchor's aria-label already names
              where this goes. */}
          <svg
            className={styles.ctaFlag}
            viewBox="0 0 10 12"
            width="10"
            height="12"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M1.5 0.5v11" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="2.5" y="0.5" width="7" height="5" fill="currentColor" />
          </svg>
          <strong className={styles.ctaLabel} data-label={libraryLabel}>
            {libraryLabel}
          </strong>
          <svg className={styles.ctaArrow} viewBox="0 0 12 8" aria-hidden="true" focusable="false">
            <path
              d="M0.5 4h10M7.5 1l3 3-3 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </Link>
        <span>2D / 3D playback // seeded telemetry</span>
        {/* The mark rides the right end of the bar and links home, the same
            job it does in the colophon. The source link beside it keeps its
            own destination. */}
        <span className={styles.barRight}>
          <Link className={styles.barHouseLink} href="https://fullbuild.ai" aria-label="fullbuild.ai home">
            <RailLogo className={styles.barHouseMark} />
          </Link>
          <Link href="https://github.com/ryanportfolio/layline">
            <strong>View source</strong>
          </Link>
        </span>
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

        <StartSequence />
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
