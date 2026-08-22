import { RACE_SEED } from "@/lib/layline/types";
import type { RaceData } from "@/lib/layline/types";
import { finishGap45, finishGaps } from "./engine/benchData";
import { buildBoard } from "./engine/boardData";
import { EngineRoom, FinishStrip } from "./engine/EngineRoom";
import engine from "./engine/engine.module.css";
import styles from "@/app/layline.module.css";

/* The engine room builds its own copy of the race from the same seed on the
 * client, the way the console and the Debrief panel already do, rather than
 * putting ~260 KB of telemetry in the page payload for a section that reads
 * one boat's tack.
 *
 * The finish strip is the exception and the reason the race prop is read here:
 * a finish time is a sub-tick crossing at the far end of the sim, and Node and
 * the browser land up to fifteen milliseconds apart on it. Six numbers built
 * on the server travel down as props, so the page prints the times the test
 * pins instead of whichever engine drew them last.
 *
 * The build board reads the same server race. It is static markup with no
 * clock behind it, so it costs nothing on the client and cannot disagree with
 * the finish strip about which race this is. */
export function NotesSection({ race }: { race: RaceData }) {
  const order = finishGaps(race);
  const board = buildBoard(race);
  return (
    <section
      className={styles.notes}
      aria-labelledby="notes-heading"
      data-leg="How the replay works"
    >
      <EngineRoom />

      <div className={engine.stands}>
        <p className={engine.kicker}>Build status</p>
        <h2 className={engine.standsHeading}>Where this build stands</h2>
      </div>
      <div className={`${engine.panel} ${engine.boardPanel}`}>
        <div className={engine.boardHead}>
          <div>
            <p className={engine.railLabel}>Three lanes · one seeded race</p>
            <ul className={engine.boardKey}>
              <li className={engine.boardKeyItem}>
                <span className={engine.dot} aria-hidden="true" />
                Running on this page
              </li>
              <li className={engine.boardKeyItem}>
                <span className={`${engine.dot} ${engine.dotLanding}`} aria-hidden="true" />
                Still landing
              </li>
            </ul>
          </div>
          {/* The count is read off the rows below, so the headline figure and
              the dots beside it can only ever say the same thing. */}
          <div className={engine.ident}>
            <p className={engine.identLine}>Rows on this board</p>
            <p className={engine.tallyValue}>
              {board.running}
              <span className={engine.tallySlash}>/</span>
              {board.rows}
            </p>
            <p className={engine.tallySub}>Running</p>
          </div>
        </div>

        <div className={engine.board}>
          {board.lanes.map((lane) => (
            <div key={lane.name} className={engine.lane}>
              <h3 className={engine.laneName}>{lane.name}</h3>
              <ul className={engine.laneRows}>
                {lane.rows.map((row) => (
                  <li
                    key={row.label}
                    className={row.state === "landing" ? `${engine.row} ${engine.rowLanding}` : engine.row}
                  >
                    <span
                      className={row.state === "landing" ? `${engine.dot} ${engine.dotLanding}` : engine.dot}
                      aria-hidden="true"
                    />
                    <span className={engine.rowLabel}>
                      {row.label}
                      <span className={engine.srOnly}>
                        {row.state === "landing" ? " (still landing)" : " (running)"}
                      </span>
                    </span>
                    {row.value === undefined ? (
                      <span className={engine.rowBlank} aria-hidden="true" />
                    ) : (
                      <span className={engine.rowValue}>
                        {row.value}
                        {row.unit === undefined ? null : (
                          <span className={engine.rowUnit}>{row.unit}</span>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className={engine.boardFoot}>
          <p className={engine.boardNote}>
            Every figure on this board is counted out of the race the replay above is running, so
            the board follows the seed rather than describing it
          </p>
          <div className={engine.ident} aria-hidden="true">
            <p className={engine.identLine}>One seed · every number</p>
            <p className={engine.standsIdentValue}>{RACE_SEED}</p>
            <p className={engine.identSub}>Race seed</p>
          </div>
        </div>
      </div>

      <FinishStrip order={order} gap={finishGap45(order)} />
    </section>
  );
}
