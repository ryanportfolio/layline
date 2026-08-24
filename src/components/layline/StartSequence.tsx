import type { CSSProperties } from "react";
import Link from "next/link";
import { raceFor } from "@/lib/layline/analyst/data";
import { briefFacts, windReading, windReadingAt } from "@/lib/layline/brief";
import { clock, knots, seconds, MISSING } from "@/lib/layline/format";
import { RACES } from "@/lib/layline/races";
import { StartSequenceCapture } from "./StartSequenceCapture";
import styles from "./StartSequence.module.css";

/**
 * One 30s loop carries three 10s prestarts, so exactly one row is counting at
 * any instant and the other two hold the picture their gun left. A row's own
 * clock is the cycle shifted by its delay, and the delays are negative because
 * a row whose gun has already gone is a row that started before the cycle did.
 * Index 0 fires at cycle 10s, index 1 at 20s, index 2 at 30s.
 *
 * A fourth race would need a 40s loop, which is a slow wait for a first gun.
 * At four the board should run two rows counting at once on a 20s cycle.
 */
const ROW_DELAYS = ["0s", "-20s", "-10s"];

interface BoardRow {
  id: string;
  name: string;
  venue: string;
  dateLabel: string;
  /** One string per rung, oldest first, rendered top to bottom in the window. */
  clocks: string[];
  winds: string[];
  sail: string;
  /** Null when no hull crossed, which hides the cell's second line. */
  margin: string | null;
  hue: string | undefined;
  delay: string;
  label: string;
  /**
   * True on the one row the base rules draw as the poster frame: armed at
   * -0:01 with its flag still up. Server rendered, so the first paint before
   * hydration, the reduced-motion board and hold("static") all show a clock
   * that is about to count rather than three identical zeros.
   */
  poster: boolean;
}

/**
 * The board is built once per render off the same memoised races the library
 * page and the analyst read, so a figure here can only disagree with a figure
 * there if the seed does.
 */
function buildBoard(): BoardRow[] {
  /* One prestart window for the whole board, read off the lead race rather
     than assumed, and shared by every row. Every shipped race opens at -10 and
     tests/layline-races.test.ts pins that on the built race, so a fourth race
     opening somewhere else fails there rather than walking one row's digits
     out of step with its own clock here. */
  const lead = raceFor(RACES[0].id);
  if (lead === null) throw new Error(`missing race ${RACES[0].id}`);
  const steps = Math.round(0 - lead.tMin);

  const rows = RACES.map((meta, index): BoardRow => {
    const race = raceFor(meta.id);
    if (race === null) throw new Error(`missing race ${meta.id}`);
    const facts = briefFacts(race);
    const out = windReading();
    const clocks: string[] = [];
    const winds: string[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = race.tMin + i;
      clocks.push(clock(t));
      winds.push(knots(windReadingAt(race, facts, t, out).tws));
    }
    const first = facts.first;
    const boat = first === null ? undefined : race.boats.find((b) => b.sail === first.sail);
    const crossing =
      first === null
        ? ""
        : `, first across the line ${first.sail} at plus ${seconds(first.t)} seconds`;
    return {
      id: meta.id,
      name: meta.name,
      venue: meta.venue,
      dateLabel: meta.dateLabel,
      clocks,
      winds,
      sail: first === null ? MISSING : first.sail,
      margin: first === null ? null : seconds(first.t),
      hue: boat?.hue,
      delay: ROW_DELAYS[index] ?? "0s",
      label: `${meta.name}, ${meta.venue}, ${meta.dateLabel}${crossing}, open in the race library`,
      /* Row 0 takes the poster frame because row 0 is the row the running loop
         has counting at the lastSecond beat, so the still board and the moving
         board are the same picture. */
      poster: index === 0,
    };
  });
  return rows;
}

/** The bar's chevron, drawn the same way in both places it points from here. */
function Chevron({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 12 8"
      width="12"
      height="8"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M0.5 4h10M7.5 1l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/**
 * The committee boat's flag: up through the countdown, struck at the gun. Half
 * the section's metaphor, so it is drawn at a size that reads as a flag at 1:1
 * rather than as a stray highlight: a 40x28 rectangle on a 2px staff, in a 48px
 * column. One user unit is one CSS pixel at every width.
 *
 * The viewBox is the full 128 unit staff at every width and a shorter row
 * slices the bottom off with preserveAspectRatio rather than swapping in a
 * second drawing, so one element carries one animation on every viewport and
 * --flag-drop is always the same units as --staff-h.
 */
function Flag() {
  return (
    <svg
      className={styles.flagSvg}
      viewBox="0 0 48 128"
      preserveAspectRatio="xMinYMin slice"
      aria-hidden="true"
      focusable="false"
    >
      <rect className={styles.staff} x="2" y="0" width="2" height="128" />
      <g className={styles.flag}>
        <rect x="6" y="0" width="40" height="28" />
      </g>
    </svg>
  );
}

export function StartSequence() {
  const rows = buildBoard();

  return (
    /* No data-leg. The course rail marks legs by document position and letters
       whichever one the reader is inside, so a mark here, nested in the notes
       section, would take the interpolation lab and the production path with it
       and letter them the race library. The section still names itself for a
       screen reader. */
    <section id="race-library" className={styles.section} aria-label="Race library">
      {/* The way in sits under the heading rather than under the board. A
          reader who has understood the section from its first two lines should
          not have to scroll past three races to act on it, and the rows are
          each their own link into the same library anyway. */}
      <div className={styles.head}>
        <p className={styles.kicker}>Race library</p>
        <h2 className={styles.heading}>Layline Races</h2>
        <Link
          className={styles.cta}
          href="/races"
          aria-label="Interact with the seeded races in the library"
        >
          <span>Interact</span>
          <Chevron className={styles.arrow} />
        </Link>
      </div>

      <div className={styles.board}>
        <div className={styles.headRow} aria-hidden="true">
          <span />
          <span>COUNTDOWN</span>
          <span>RACE</span>
          <span>WIND</span>
          <span>FIRST ACROSS</span>
          <span />
        </div>

        {rows.map((row) => (
          <Link
            key={row.id}
            className={styles.row}
            href={`/races?race=${row.id}`}
            aria-label={row.label}
            data-race={row.id}
            data-poster={row.poster ? "1" : undefined}
            style={{ "--row-delay": row.delay } as CSSProperties}
          >
            <span className={styles.flagCell} aria-hidden="true">
              <Flag />
            </span>

            {/* Eleven strings from clock(), stacked and stepped one rung a
                second. Rendering all of them server side gets the exact digits
                with no client work and nothing to reflow when they change. */}
            <span className={styles.clockWindow} aria-hidden="true">
              <span className={styles.clockStack}>
                {row.clocks.map((reading, i) => (
                  <span key={`${row.id}-c-${i}`}>{reading}</span>
                ))}
              </span>
            </span>

            <span className={styles.raceCell}>
              <span className={styles.name}>{row.name}</span>
              <span className={styles.where}>
                <span className={styles.venue}>{row.venue}</span>
                <span className={styles.date}>{row.dateLabel}</span>
              </span>
            </span>

            <span className={styles.windCell}>
              <span className={styles.windWindow} aria-hidden="true">
                <span className={styles.windStack}>
                  {row.winds.map((reading, i) => (
                    <span key={`${row.id}-w-${i}`}>{reading}</span>
                  ))}
                </span>
              </span>
              <span className={styles.windUnit}>KN</span>
            </span>

            {/* Held at opacity 0 rather than removed, so a screen reader gets
                the whole row at once instead of waiting on a loop it cannot
                perceive. The cell itself stays at opacity 1 and carries the
                reserved line as ::before, which is the only thing standing in
                the FIRST ACROSS column while the row counts. */}
            <span className={styles.result}>
              <span className={styles.resultBody}>
                <span className={styles.resultSail}>
                  <span className={styles.chip} style={{ background: row.hue }} aria-hidden="true" />
                  {row.sail}
                </span>
                {row.margin === null ? null : (
                  <span className={styles.resultMargin}>
                    <span className={styles.marginValue}>+{row.margin}</span>
                    <span className={styles.marginUnit}>S</span>
                  </span>
                )}
              </span>
            </span>

            <span className={styles.arrowCell} aria-hidden="true">
              <Chevron className={styles.arrow} />
            </span>

            <span className={styles.fill} aria-hidden="true" />
          </Link>
        ))}
      </div>

      <StartSequenceCapture />
    </section>
  );
}
