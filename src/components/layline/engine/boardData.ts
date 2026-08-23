/**
 * The build board: what runs on this page now, lane by lane, as rows rather
 * than a paragraph.
 *
 * Same rule as benchData.ts. Nothing here is typed in by hand except the
 * words: every numeral is a length, a count or a limit read out of the seeded
 * race or out of an exported constant the shipped code already obeys, so a
 * change to the seed or to a limit redraws the board by itself.
 *
 * Kept out of benchData.ts on purpose. This module reaches into the analyst
 * protocol and the analyst tools, and benchData is imported by the engine room
 * client island; the board is built on the server in NotesSection and nothing
 * here needs to reach the browser.
 */
import { VMG_STEP, maneuversOf } from "@/lib/layline/analytics";
import { MAX_MESSAGE_CHARS, MAX_TURNS, SUGGESTED_QUESTIONS } from "@/lib/layline/analyst/protocol";
import { ANALYST_TOOLS } from "@/lib/layline/analyst/tools";
import type { RaceData } from "@/lib/layline/types";
import { fmt2, totalFixes } from "./benchData";

/**
 * The boat the console is following when the page opens, so the turns row
 * counts the markers actually under the scrub track on arrival rather than
 * some other boat's. This mirrors the opening followId in store.ts, and
 * tests/layline-engine-room.test.ts asserts the two still agree.
 */
export const CONSOLE_BOAT = "nzl";

/** Running is an ink dot. Landing is amber: honest construction, no bar. */
export type BoardState = "running" | "landing";

export interface BoardRow {
  label: string;
  /** Mono numeral, already formatted. Absent where there is no honest one. */
  value?: string;
  /** Uppercase unit beside the numeral. */
  unit?: string;
  state: BoardState;
}

export interface BoardLane {
  name: string;
  rows: BoardRow[];
}

export interface Board {
  lanes: BoardLane[];
  rows: number;
  running: number;
}

export function buildBoard(race: RaceData): Board {
  const lanes: BoardLane[] = [
    {
      name: "Replay engine",
      rows: [
        {
          label: "Boats in the seeded fleet",
          value: String(race.boats.length),
          state: "running",
        },
        {
          label: "Samples generated",
          value: String(totalFixes(race)),
          state: "running",
        },
        {
          label: "Wind readings under the laylines",
          value: String(race.wind.length),
          state: "running",
        },
        {
          label: "Gun, roundings and finishes",
          value: String(race.events.length),
          state: "running",
        },
        { label: "Hulls, wake, spray, water and sky", state: "running" },
        { label: "Chart stand-in without WebGL", state: "running" },
      ],
    },
    {
      name: "Console",
      rows: [
        {
          label: "Race clock the transport scrubs",
          value: fmt2(race.tMax - race.tMin),
          unit: "s",
          state: "running",
        },
        {
          label: "Start line counts down from",
          value: fmt2(-race.tMin),
          unit: "s",
          state: "running",
        },
        {
          label: "Turns marked under the scrub track",
          value: String(maneuversOf(race, CONSOLE_BOAT).length),
          state: "running",
        },
        {
          label: "Speed made good, 1 sample every",
          value: fmt2(VMG_STEP),
          unit: "s",
          state: "running",
        },
        { label: "Chart mode on the same clock", state: "running" },
        { label: "Heel and trim on the instrument dock", state: "landing" },
      ],
    },
    {
      name: "Debrief",
      rows: [
        {
          label: "Tools the analyst can call",
          value: String(ANALYST_TOOLS.length),
          state: "running",
        },
        {
          label: "Questions on the opening cards",
          value: String(SUGGESTED_QUESTIONS.length),
          state: "running",
        },
        {
          label: "Turns allowed per thread",
          value: String(MAX_TURNS),
          state: "running",
        },
        {
          label: "Characters a question can carry",
          value: String(MAX_MESSAGE_CHARS),
          state: "running",
        },
        { label: "Moment chips put the replay on the answer", state: "running" },
      ],
    },
  ];

  let rows = 0;
  let running = 0;
  for (const lane of lanes) {
    rows += lane.rows.length;
    for (const row of lane.rows) if (row.state === "running") running += 1;
  }
  return { lanes, rows, running };
}
