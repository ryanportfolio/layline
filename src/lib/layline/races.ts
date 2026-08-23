/**
 * The race library: every race the replay and the analyst can load, fixed at
 * compile time.
 *
 * Both sides of the wire bind by `id` from this list and never by seed, so a
 * request can only ask for a race that shipped. `generateRace` is deterministic
 * and costs real CPU, so an arbitrary seed off the network would be a compute
 * hole as well as an unaudited race.
 *
 * Every seed here passed the same sanity audit before it was added: six of six
 * boats in the results with ranks 1 to 6, a winner inside 45 to 60 s, a finish
 * spread inside 2 to 35 s, no boat losing ground for more than 8 continuous
 * seconds on the distance the standings dock counts down, no fix-to-fix step
 * over 4 m, every telemetry number finite, every boat on the pre-start side
 * before the gun and across after it, and a median beat TWA inside 30 to 60
 * degrees, which is a 60 to 120 degree tacking angle.
 *
 * Every seed also had to read the same in both engines. The replay simulates
 * in the browser and the analyst and the finish table simulate on the server,
 * and Math.sin, exp, log and atan2 are implementation defined, so a seed can
 * amplify a last-bit difference into a different fourth place. Seed 20281016
 * sat here until `node scripts/layline-cross-engine-audit.mjs` caught it doing
 * exactly that, 0.95 s apart on FRA 12 with the finish clocks a second apart.
 * The three seeds below agree on the finish order, every finish clock, the
 * leader timeline and every standings gap to within 0.029 s.
 *
 * The three suggested questions on each race are the three the mock analyst
 * answers from the tools, in the order start, lead change, downwind. Each was
 * checked against that race's own telemetry: naming a boat in a question means
 * that boat did that thing in that race.
 */
import { RACE_SEED } from "@/lib/layline/types";

export interface RaceMeta {
  /** URL and wire identifier. Stable, lowercase, never a seed. */
  id: string;
  name: string;
  venue: string;
  dateLabel: string;
  seed: number;
  suggestedQuestions: readonly [string, string, string];
}

/* The shipped race is first and stays first: it is the default everywhere,
 * and the story page at /prototype/layline renders it and nothing else. */
export const RACES: readonly RaceMeta[] = [
  {
    /* Seed 20280726. USA 4 wins in 51.53 s over a 5.97 s spread, five lead
     * changes, decided on the beat when USA 4 goes through at t=28.0 and holds
     * to the gun. JPN 18 crosses first after the start at 0.15 s and is the
     * fastest boat downwind at 12.5 knots to the mark. */
    id: "long-beach",
    name: "Summer fleet race",
    venue: "Long Beach",
    dateLabel: "26 Jul 2028",
    seed: RACE_SEED,
    suggestedQuestions: [
      "Who won the start",
      "How did USA 4 take the lead",
      "Which boat was fastest downwind",
    ],
  },
  {
    /* Seed 20281113. The busiest race in the library: GBR 21 wins in 47.30 s
     * over an 8.21 s spread with seven lead changes, one of them a single
     * sample. GBR 21 is first off the line at 0.10 s, takes the lead for the
     * last time on the beat at t=18.0 and holds it 29 s to the gun, and is the
     * fastest boat downwind at 11.7 knots to the mark. */
    id: "kestrel-sound",
    name: "Winter series race 2",
    venue: "Kestrel Sound",
    dateLabel: "13 Nov 2028",
    seed: 20281113,
    suggestedQuestions: [
      "Who led off the line",
      "How did GBR 21 get clear",
      "Which boat was fastest downwind",
    ],
  },
  {
    /* Seed 20281024. The one race in the library decided downwind: AUS 33 leads
     * the beat back from t=30.0, FRA 12 goes through at t=36.5 with the fleet
     * on the run, and wins in 51.38 s over a 4.35 s spread, the tightest here,
     * by 0.50 s. AUS 33 crosses first after the start at 0.23 s and is the
     * fastest boat downwind at 14.0 knots to the mark. */
    id: "sable-reach",
    name: "Autumn invitational",
    venue: "Sable Reach",
    dateLabel: "24 Oct 2028",
    seed: 20281024,
    suggestedQuestions: [
      "Who won the start",
      "How did FRA 12 pass on the run",
      "Which boat was fastest downwind",
    ],
  },
];

/** The race every entry point falls back to when nothing asks for another. */
export const DEFAULT_RACE_ID = RACES[0].id;

/** Registry lookup. Undefined is the only answer for an id that never shipped. */
export function raceMeta(id: string): RaceMeta | undefined {
  return RACES.find((race) => race.id === id);
}

/** True only for an id in the list above. The gate on anything off the wire. */
export function isRaceId(value: unknown): value is string {
  return typeof value === "string" && raceMeta(value) !== undefined;
}
