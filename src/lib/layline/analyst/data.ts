/**
 * The server's copy of the race library, mirroring the client store's
 * raceData(). The analyst reads the identical seeded simulation the replay
 * renders, so a number can only disagree if the seed does. The sim never
 * imports three, so this is safe to run in a Node route.
 *
 * One RaceData per registry id, built on first use and kept for the life of the
 * process. Only ids in the registry reach generateRace: a seed off the wire
 * would be both unaudited and a compute hole.
 */
import { generateRace } from "@/lib/layline/sim";
import { DEFAULT_RACE_ID, raceMeta } from "@/lib/layline/races";
import type { RaceData } from "@/lib/layline/types";

const generated = new Map<string, RaceData>();

/** The race behind a registry id, or null when the id never shipped. */
export function raceFor(id: string): RaceData | null {
  const cached = generated.get(id);
  if (cached !== undefined) return cached;
  const meta = raceMeta(id);
  if (meta === undefined) return null;
  const race = generateRace(meta.seed);
  generated.set(id, race);
  return race;
}

/** The default race, for callers with no id to offer. */
export function raceData(): RaceData {
  const race = raceFor(DEFAULT_RACE_ID);
  if (race === null) throw new Error(`missing default race ${DEFAULT_RACE_ID}`);
  return race;
}
