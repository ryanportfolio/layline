"use client";

import clsx from "clsx";
import { useEffect, useRef } from "react";
import type { Fix } from "@/lib/layline/types";
import { velocityFromComponents } from "@/lib/layline/velocity";
import { BENCH_BOAT, fixIndexAt, fmt1, fmt2 } from "./benchData";
import { useLabClock } from "./clock";
import styles from "./engine.module.css";

/* The feed the clock is reading, in the units the engine stores. The trailing
 * six rows step one row per quarter second of race time: a SNAP, never a
 * tween, because that is what a new reading is. The six rows are written once
 * and then rewritten in place, so the step costs six times seven text writes
 * and no React render at all: a table re-rendering four times a second beside
 * the console's own frame loop is work nobody can see. */
const ROWS = 6;

function cells(fix: Fix): string[] {
  const velocity = velocityFromComponents(fix.waterX, fix.waterY, fix.currentX, fix.currentY, {});
  return [
    fmt2(fix.t),
    fmt2(fix.x),
    fmt2(fix.y),
    fmt2(velocity.sog),
    velocity.cog === null ? "-" : fmt1(velocity.cog),
    fmt1(fix.hdg),
    fmt1(fix.twa),
  ];
}

/** The six fixes at or before t, oldest first, padded from the series start. */
function trailing(fixes: Fix[], index: number): Fix[] {
  const out: Fix[] = [];
  for (let i = Math.max(0, index - (ROWS - 1)); i <= index; i += 1) out.push(fixes[i]);
  return out;
}

export function FeedTable() {
  const clock = useLabClock();
  const { race, bench } = clock;
  const fixes = race.fixes[BENCH_BOAT];
  const opening = trailing(fixes, fixIndexAt(fixes, bench.window.from));
  const cellRefs = useRef<Array<Array<HTMLTableCellElement | null>>>([]);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const timesRef = useRef<number[]>(opening.map((fix) => fix.t));
  /* Which slot each display position holds, oldest first. A step recycles the
     oldest row to the bottom rather than rewriting all six, so one reading
     costs the table seven text writes and one move instead of forty-two. */
  const orderRef = useRef<number[]>(opening.map((_, row) => row));
  const readingRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    let shownIndex = -2;
    let shownReading = "";
    const write = (slot: number, fix: Fix) => {
      timesRef.current[slot] = fix.t;
      rowRefs.current[slot]?.setAttribute(
        "aria-label",
        `Seek the lab clock to T plus ${fmt2(fix.t)} seconds`,
      );
      const values = cells(fix);
      for (let c = 0; c < values.length; c += 1) {
        const cell = cellRefs.current[slot]?.[c];
        if (cell != null && cell.textContent !== values[c]) cell.textContent = values[c];
      }
    };
    return clock.subscribe((t) => {
      const index = fixIndexAt(fixes, t);
      if (index !== shownIndex) {
        const step = index - shownIndex;
        const live = orderRef.current[orderRef.current.length - 1];
        if (shownIndex >= 0 && step > 0 && step < ROWS) {
          for (let s = step; s > 0; s -= 1) {
            const slot = orderRef.current.shift();
            if (slot === undefined) break;
            orderRef.current.push(slot);
            write(slot, fixes[index - s + 1]);
            const node = rowRefs.current[slot];
            node?.parentNode?.appendChild(node);
          }
        } else {
          const rows = trailing(fixes, index);
          for (let r = 0; r < rows.length; r += 1) write(orderRef.current[r], rows[r]);
        }
        const next = orderRef.current[orderRef.current.length - 1];
        if (next !== live) {
          rowRefs.current[live]?.classList.remove(styles.feedRowLive);
          rowRefs.current[next]?.classList.add(styles.feedRowLive);
        }
        shownIndex = index;
      }
      const reading = `Reading T+${fmt2(t)}`;
      if (reading !== shownReading) {
        shownReading = reading;
        if (readingRef.current !== null) readingRef.current.textContent = reading;
      }
    });
  }, [clock, fixes]);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <p className={clsx(styles.railLabel, styles.railLabelLive)}>
          Telemetry feed · {bench.boat.sail}
        </p>
        <p ref={readingRef} className={styles.reading}>
          Reading T+{fmt2(bench.window.from)}
        </p>
      </div>
      {/* The caption sits outside the scroll box: a table caption takes the
          table's own width, and on a phone that puts half the sentence past
          the right edge of the panel. */}
      <figure className={styles.feedFigure}>
        <div className={styles.feedScroll}>
          <table className={styles.feedTable} aria-labelledby="feed-caption">
            <thead>
              <tr>
                <th scope="col">T s</th>
                <th scope="col">X m</th>
                <th scope="col">Y m</th>
                <th scope="col">SOG m/s</th>
                <th scope="col">COG deg</th>
                <th scope="col">HDG deg</th>
                <th scope="col">TWA deg</th>
              </tr>
            </thead>
            <tbody>
              {opening.map((fix, row) => (
                <tr
                  key={row}
                  ref={(node) => {
                    rowRefs.current[row] = node;
                  }}
                  className={clsx(styles.feedRow, row === opening.length - 1 && styles.feedRowLive)}
                  /* A row seeks the clock, so it takes focus, answers the keys
                     a button answers, and says which reading it jumps to.
                     Deliberately not role="button": these rows are the data
                     table the panel is about, and overriding the row role
                     would take the cells out of their row for a screen
                     reader to buy a word. */
                  tabIndex={0}
                  aria-label={`Seek the lab clock to T plus ${fmt2(fix.t)} seconds`}
                  onClick={() => clock.seek(timesRef.current[row])}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    clock.seek(timesRef.current[row]);
                  }}
                >
                  {cells(fix).map((value, column) => (
                    <td
                      key={column}
                      ref={(node) => {
                        if (cellRefs.current[row] === undefined) cellRefs.current[row] = [];
                        cellRefs.current[row][column] = node;
                      }}
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <figcaption id="feed-caption" className={styles.feedCaption}>
          The last six rows the clock has read, in the units the engine stores. Everything on this
          page reads from rows like these
        </figcaption>
      </figure>
    </div>
  );
}
