/**
 * One race per server process, mirroring the client store's raceData(). The
 * analyst reads the identical seeded simulation the replay renders, so a
 * number can only disagree if the seed does. The sim never imports three, so
 * this is safe to run in a Node route.
 */
import { generateRace } from "@/lib/layline/sim";
import { RACE_SEED } from "@/lib/layline/types";
import type { RaceData } from "@/lib/layline/types";

let generated: RaceData | null = null;

export function raceData(): RaceData {
  if (generated === null) generated = generateRace(RACE_SEED);
  return generated;
}
