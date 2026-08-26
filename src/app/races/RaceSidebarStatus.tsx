"use client";

import { useEffect, useRef, useState } from "react";
import { clock } from "@/lib/layline/format";
import { racePhaseLabel, standingsReading } from "@/lib/layline/standings-view";
import type { BoatMeta, RaceData } from "@/lib/layline/types";
import { useReplay } from "@/components/layline/store";
import {
  focusLiveBoat,
  onLive,
  sampleLive,
  setText,
} from "@/components/layline/hud/live";
import styles from "./races.module.css";

interface Placing {
  boatId: string;
  rank: number;
}

function placings(race: RaceData): Placing[] {
  return sampleLive(race).rows.map((row) => ({ boatId: row.boatId, rank: row.rank }));
}

function placingKey(places: readonly Placing[]): string {
  return places.map((place) => `${place.boatId}:${place.rank}`).join("|");
}

/** Compact live witness attached to the selected library row after release. */
export function RaceSidebarStatus({ race }: { race: RaceData }) {
  const followId = useReplay((state) => state.followId);
  const follow = useReplay((state) => state.follow);
  const [order, setOrder] = useState<Placing[]>(() => placings(race));
  const orderKey = useRef(placingKey(order));
  const clockRef = useRef<HTMLSpanElement>(null);
  const phaseRef = useRef<HTMLSpanElement>(null);
  const gaps = useRef(new Map<string, HTMLSpanElement | null>());
  const fleet = useRef(new Map<string, BoatMeta>(race.boats.map((boat) => [boat.id, boat])));
  const elapsed = useRef(
    new Map<string, number>(race.results.map((result) => [result.boatId, result.elapsed])),
  );

  useEffect(() => {
    return onLive(race, (live) => {
      setText(clockRef.current, clock(live.t));
      setText(phaseRef.current, racePhaseLabel(live.leg));

      const next = live.rows.map((row) => `${row.boatId}:${row.rank}`).join("|");
      for (const row of live.rows) {
        setText(gaps.current.get(row.boatId) ?? null, standingsReading(row, elapsed.current));
      }
      /* Text follows the shared clock through direct node writes. React only
         needs a new tree when a boat actually changes place. */
      if (next === orderKey.current) return;
      orderKey.current = next;
      setOrder(live.rows.map((row) => ({ boatId: row.boatId, rank: row.rank })));
    });
  }, [race]);

  const sample = sampleLive(race);

  return (
    <section className={styles.raceStatus} aria-label="Live race standings">
      <header className={styles.raceStatusHeader}>
        <h3 className={styles.raceStatusHeading}>Standings</h3>
        <span ref={clockRef} className={styles.raceStatusClock} data-live="sidebar-clock">
          {clock(sample.t)}
        </span>
        <span className={styles.raceStatusPhaseLabel}>Phase</span>
        <span ref={phaseRef} className={styles.raceStatusPhase} data-live="sidebar-phase">
          {racePhaseLabel(sample.leg)}
        </span>
      </header>
      <ol className={styles.raceStatusRows}>
        {order.map((place) => {
          const boat = fleet.current.get(place.boatId);
          if (boat === undefined) return null;
          const row = sample.rows.find((entry) => entry.boatId === boat.id);
          const followed = boat.id === followId;
          return (
            <li key={boat.id}>
              <button
                type="button"
                className={styles.raceStatusRow}
                aria-pressed={followed}
                data-boat={boat.id}
                data-followed={followed ? "true" : undefined}
                onClick={() => follow(boat.id)}
                onFocus={() => focusLiveBoat(boat.id)}
                onBlur={() => focusLiveBoat(null)}
                onPointerEnter={() => focusLiveBoat(boat.id)}
                onPointerLeave={() => focusLiveBoat(null)}
              >
                <span className={styles.raceStatusRank}>{place.rank}</span>
                <span
                  className={styles.raceStatusChip}
                  data-dark={boat.dark ? "true" : undefined}
                  style={{ backgroundColor: boat.hue }}
                  aria-hidden="true"
                />
                <span className={styles.raceStatusSail}>{boat.sail}</span>
                <span
                  className={styles.raceStatusReading}
                  data-live="sidebar-gap"
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
      </ol>
    </section>
  );
}
