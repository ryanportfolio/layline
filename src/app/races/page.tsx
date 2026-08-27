import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import RailLogo from "@/components/chrome/RailLogo";
import { TrackChart } from "@/components/layline/svg/TrackChart";
import { raceFor } from "@/lib/layline/analyst/data";
import { MISSING, clock } from "@/lib/layline/format";
import { montserrat } from "@/lib/layline/fonts";
import { DEFAULT_RACE_ID, RACES, isRaceId } from "@/lib/layline/races";
import { RaceWorkspace, ThemePicker, type LaylineTheme, type RaceRow } from "./RaceWorkspace";
import {
  WORKSPACE_COOKIE_KEY,
  parseWorkspacePreferences,
} from "./workspaceState";
import styles from "./races.module.css";
import layline from "../layline.module.css";
import "../scrollbar.css";

/* Parser blocking and first in the shell. A stored theme reaches the shell
 * before the browser has interface pixels to paint. The script changes only
 * its parent, so client navigation to the story cannot carry the theme with it.
 * Console remains the server and no-JavaScript result. */
const THEME_BOOT = `try {
  const shell = document.currentScript?.parentElement;
  const stored = localStorage.getItem("layline-races-theme-v1");
  if (shell && ["console", "sailcloth", "marine", "chart", "ice"].includes(stored)) {
    shell.dataset.laylineTheme = stored;
    document.cookie = "layline-races-theme-v1=" + encodeURIComponent(stored) + "; Path=/races; Max-Age=31536000; SameSite=Lax";
  }
} catch {}`;

function storedTheme(value: string | undefined): LaylineTheme {
  if (
    value === "sailcloth" ||
    value === "marine" ||
    value === "chart" ||
    value === "ice"
  ) {
    return value;
  }
  return "console";
}

export const metadata: Metadata = {
  title: "Layline · Race Library",
  description:
    "Three seeded fleet races in one replay workspace: pick a race in the rail, watch it in 2D or 3D, and ask the analyst about any moment in it.",
};

/**
 * The race library. One workspace, three panes: the races on the left, the
 * replay in the middle, the analyst on the right.
 *
 * The selected race lives in `?race=`, so a link opens on a stated race and
 * this component can render that race's chart and finish order into the
 * viewer's fallback. An id that never shipped falls back to the shipped race
 * rather than 404ing: the page still has something true to show.
 *
 * The rail's numbers are read off each race's own simulation here, the same
 * build the analyst answers from, so a row can only disagree with the replay
 * if the seed does.
 */
export default async function LaylineRacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, cookieStore] = await Promise.all([searchParams, cookies()]);
  const asked = params.race;
  const selectedId = typeof asked === "string" && isRaceId(asked) ? asked : DEFAULT_RACE_ID;
  const validIds = new Set(RACES.map((meta) => meta.id));
  const initialPreferences = parseWorkspacePreferences(
    cookieStore.get(WORKSPACE_COOKIE_KEY)?.value,
    validIds,
  );
  const initialTheme = storedTheme(cookieStore.get("layline-races-theme-v1")?.value);
  const race = raceFor(selectedId);
  if (race === null) throw new Error(`missing race ${selectedId}`);
  const initialRace = Object.freeze({ id: selectedId, seed: race.seed });
  const fleet = new Map(race.boats.map((boat) => [boat.id, boat]));

  const rows: RaceRow[] = RACES.map((meta) => {
    const built = raceFor(meta.id);
    if (built === null) throw new Error(`missing race ${meta.id}`);
    const winner = built.results.find((result) => result.rank === 1);
    return {
      id: meta.id,
      name: meta.name,
      venue: meta.venue,
      dateLabel: meta.dateLabel,
      boats: built.boats.length,
      elapsed: winner === undefined ? MISSING : clock(winner.elapsed),
    };
  });

  return (
    <div
      className={`${layline.shell} ${styles.page} ${montserrat.variable}`}
      data-layline-page
      data-layline-theme={initialTheme}
      suppressHydrationWarning
    >
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      {/* Pangram is declared font-display: block, and the boot cover names the
          race in it while the renderer starts. Without this the title card
          holds unpainted for the whole block period, which is the wait it
          exists to fill. */}
      <link
        rel="preload"
        href="/assets/fonts/pangram-display.woff2"
        as="font"
        type="font/woff2"
        crossOrigin="anonymous"
      />

      {/* Three panes, three ways in. Each link parks in the same corner and
          only the focused one is on screen, so the row costs no space. */}
      <a className={layline.skip} href="#race-list-toggle">
        Skip to the race picker
      </a>
      <a className={layline.skip} href="#replay-console">
        Skip to the replay console
      </a>
      <a className={layline.skip} href="#race-analyst-toggle">
        Skip to the debrief
      </a>

      <div className={layline.prototypeBar}>
        <strong>Layline race library</strong>
        <span>{RACES.length} races // seeded telemetry</span>
        <ThemePicker initialTheme={initialTheme} />
        <Link href="/">
          <strong>Race story</strong>
        </Link>
        {/* The mark rides the right end of the bar and links home, the same
            pairing the story page's bar carries. */}
        <span className={layline.barRight}>
          <Link className={layline.barHouseLink} href="https://fullbuild.ai" aria-label="fullbuild.ai home">
            <RailLogo className={layline.barHouseMark} />
          </Link>
          <Link href="https://github.com/ryanportfolio/layline">
            <strong>View source</strong>
          </Link>
        </span>
      </div>

      <RaceWorkspace
        initialRace={initialRace}
        rows={rows}
        initialPreferences={initialPreferences}
        analystOffline={
          !process.env.OPENROUTER_API_KEY && process.env.LAYLINE_ANALYST_MOCK !== "1"
        }
      >
        <div className={layline.fallback}>
          <figure className={layline.chartFigure}>
            <TrackChart race={race} />
            <figcaption className={layline.caption} data-analysis-layer-caption="tracks">
              Every track, sampled once a second through the same evaluator the replay reads
            </figcaption>
          </figure>

          <div className={layline.resultsPanel}>
            <h2 className={layline.panelHeading}>Finish order</h2>
            <table className={layline.results}>
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
                          className={layline.hueChip}
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
      </RaceWorkspace>
    </div>
  );
}
