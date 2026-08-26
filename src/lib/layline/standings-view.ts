import { MISSING, clock, gap } from "./format";
import type { LegName, StandingsRow } from "./types";

/** One standings reading shared by the full dock and compact race rail. */
export function standingsReading(
  row: StandingsRow,
  elapsed: ReadonlyMap<string, number>,
): string {
  if (!row.finished) return gap(row);
  const time = elapsed.get(row.boatId);
  return time === undefined ? MISSING : clock(time);
}

/** Display label for the followed boat's canonical replay leg. */
export function racePhaseLabel(leg: LegName): string {
  switch (leg) {
    case "prestart":
      return "Prestart";
    case "beat":
      return "Beat";
    case "run":
      return "Run";
    case "finished":
      return "Finished";
  }
}
