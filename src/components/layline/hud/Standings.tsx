"use client";

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import styles from "@/app/layline.module.css";
import { MISSING, clock, gap } from "@/lib/layline/format";
import type { BoatMeta, RaceData, StandingsRow } from "@/lib/layline/types";
import { requestSceneFrame } from "../scene/gate";
import { setFocusHover } from "../scene/interaction";
import { useReplay } from "../store";
import { onLive, sampleLive, setText } from "./live";

/* Module state, and one frame asked for. Hover is read by the plate pass and
 * by nothing that renders, so putting it in React would re-render six rows to
 * move one border.
 *
 * The dock writes the focus half of it. The water writes the pointer half, and
 * neither can clear the other's answer. */
function markBoat(boatId: string | null): void {
  if (setFocusHover(boatId)) requestSceneFrame();
}

interface Placing {
  boatId: string;
  rank: number;
}

function placings(race: RaceData): Placing[] {
  return sampleLive(race).rows.map((row) => ({ boatId: row.boatId, rank: row.rank }));
}

/* A boat across the line is level with the leader by construction, so the gap
 * it carried all race stops saying anything and the time it took to get there
 * takes the column over. */
function reading(row: StandingsRow, elapsed: Map<string, number>): string {
  if (!row.finished) return gap(row);
  const time = elapsed.get(row.boatId);
  return time === undefined ? MISSING : clock(time);
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
        setText(gaps.current.get(row.boatId) ?? null, reading(row, elapsed.current));
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
                onFocus={() => markBoat(boat.id)}
                onBlur={() => markBoat(null)}
                onPointerEnter={() => markBoat(boat.id)}
                onPointerLeave={() => markBoat(null)}
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
                  {row === undefined ? MISSING : reading(row, elapsed.current)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
