"use client";

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import styles from "@/app/layline.module.css";
import { standingsReading } from "@/lib/layline/standings-view";
import type { BoatMeta, RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { focusLiveBoat, onLive, sampleLive, setText } from "./live";

interface Placing {
  boatId: string;
  rank: number;
}

function placings(race: RaceData): Placing[] {
  return sampleLive(race).rows.map((row) => ({ boatId: row.boatId, rank: row.rank }));
}

export function Standings({ race }: { race: RaceData }) {
  const followId = useReplay((state) => state.followId);
  const follow = useReplay((state) => state.follow);
  const [order, setOrder] = useState<Placing[]>(() => placings(race));
  const gaps = useRef(new Map<string, HTMLSpanElement | null>());
  const fleet = useRef(new Map<string, BoatMeta>(race.boats.map((boat) => [boat.id, boat])));
  const elapsed = useRef(
    new Map<string, number>(race.results.map((result) => [result.boatId, result.elapsed])),
  );

  useEffect(() => {
    let key = "";
    return onLive(race, (live) => {
      let next = "";
      for (const row of live.rows) {
        setText(gaps.current.get(row.boatId) ?? null, standingsReading(row, elapsed.current));
        next += `${row.boatId}${row.rank}`;
      }
      /* Rows only get re-rendered when the fleet actually changes places; the
         gap beside each one is written straight into the node above. */
      if (next === key) return;
      key = next;
      setOrder(live.rows.map((row) => ({ boatId: row.boatId, rank: row.rank })));
    });
  }, [race]);

  const sample = sampleLive(race);

  return (
    <section className={styles.panel} aria-label="Standings">
      <h2 className={styles.dockLabel}>Standings</h2>
      <ul className={styles.standingList}>
        {order.map((place) => {
          const boat = fleet.current.get(place.boatId);
          if (boat === undefined) return null;
          const followed = boat.id === followId;
          const row = sample.rows.find((entry) => entry.boatId === boat.id);
          return (
            <li key={boat.id}>
              <button
                type="button"
                className={clsx(styles.standingRow, followed && styles.standingRowFollowed)}
                aria-pressed={followed}
                data-boat={boat.id}
                onClick={() => follow(boat.id)}
                /* The keyboard's version of hovering a boat on the water: the
                   plate over that hull answers a focused row the same way it
                   answers a pointer, so which boat a row names is readable
                   without a mouse. */
                onFocus={() => focusLiveBoat(boat.id)}
                onBlur={() => focusLiveBoat(null)}
                onPointerEnter={() => focusLiveBoat(boat.id)}
                onPointerLeave={() => focusLiveBoat(null)}
              >
                <span className={styles.standingRank}>{place.rank}</span>
                <span
                  className={clsx(styles.standingChip, boat.dark === true && styles.chipOutlined)}
                  style={{ background: boat.hue }}
                  aria-hidden="true"
                />
                <span className={styles.standingSail}>{boat.sail}</span>
                <span
                  className={styles.standingGap}
                  data-live="gap"
                  ref={(node) => {
                    gaps.current.set(boat.id, node);
                  }}
                >
                  {row === undefined ? "-" : standingsReading(row, elapsed.current)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
