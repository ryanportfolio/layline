/**
 * System prompt for the analyst. Built from the RaceData itself, so every
 * number in the race card is computed from the same seeded simulation the
 * replay renders and the tools read. Nothing in here is typed in by hand.
 */
import { clock, deg, knots } from "@/lib/layline/format";
import type { RaceData } from "@/lib/layline/types";

/* Boat hues named as words for the card. Keyed by the hex the fleet actually
 * carries; an unrecognized hue is simply not mentioned rather than guessed. */
const HUE_WORDS: Record<string, string> = {
  "#3b74ff": "blue",
  "#e4353f": "red",
  "#e8eef4": "white",
  "#23282e": "black",
  "#2fae62": "green",
  "#ff5d8f": "pink",
};

function ordinal(rank: number): string {
  const words = ["first", "second", "third", "fourth", "fifth", "sixth"];
  return words[rank - 1] ?? `${rank}th`;
}

export function buildSystemPrompt(race: RaceData): string {
  const fleet = new Map(race.boats.map((boat) => [boat.id, boat]));

  const boatLines = race.boats
    .map((boat) => {
      const hue = HUE_WORDS[boat.hue.toLowerCase()];
      const color = hue === undefined ? "" : `, ${hue} accents`;
      return `- ${boat.sail}, ${boat.name}, id "${boat.id}"${color}`;
    })
    .join("\n");

  const resultLines = race.results
    .map((result) => {
      const boat = fleet.get(result.boatId);
      return `${result.rank}. ${boat?.sail ?? result.boatId}, ${boat?.name ?? ""}, elapsed ${clock(result.elapsed)}`;
    })
    .join("\n");

  const eventLines = race.events
    .map((event) => {
      const sail = event.boatId === undefined ? "" : fleet.get(event.boatId)?.sail ?? event.boatId;
      if (event.kind === "gun") return `- Starting gun at ${clock(event.t)}`;
      if (event.kind === "rounding") return `- ${sail} rounded the windward mark at ${clock(event.t)}`;
      return `- ${sail} finished ${ordinal(event.rank ?? 0)} at ${clock(event.t)}`;
    })
    .join("\n");

  const lineLength = Math.round(race.course.startBoat.x - race.course.startPin.x);
  const legLength = Math.round(race.course.windward.y);

  const tws = race.wind.map((sample) => sample.tws);
  const twd = race.wind.map((sample) => sample.twd);
  const meanTws = tws.reduce((sum, value) => sum + value, 0) / tws.length;
  const swing = Math.max(...twd.map((value) => Math.abs(value)));

  return [
    "You are the race analyst for Layline, a replay of a fictional fleet race sailed off Long Beach. Six boats, one beat and one run, recorded at four fixes a second; the replay and your tools read the identical seeded telemetry. You sit beside the replay and debrief it for a spectator: calm, precise, plain spoken. You never step out of that role, and you never name any company, product vendor, or model behind this page.",
    "",
    "The fleet",
    boatLines,
    "",
    "Finish order, gun to line",
    resultLines,
    "",
    "Key moments",
    eventLines,
    "",
    "The course",
    `- Windward-leeward: a ${lineLength} m start line, a windward mark ${legLength} m up the course with a zone reaching ${Math.round(race.course.zoneRadius)} m out from the mark, and a run back down to finish where the fleet started`,
    `- The race clock runs from ${clock(race.tMin)} in the prestart to ${clock(race.tMax)}`,
    "",
    "The wind",
    `- Averaged ${knots(meanTws)} knots, between ${knots(Math.min(...tws))} and ${knots(Math.max(...tws))}, blowing down the course within about ${deg(swing)} degrees of the course axis`,
    "",
    "Grounding rules",
    "- Every number you state comes from a tool result or from the card above. If you have not read a number, call the tool that has it. Never estimate, never invent, never round a story past what the data says.",
    "- Times you speak are the race clock, minutes:seconds against the gun.",
    "- A question outside this race gets one sentence steering back to the race, nothing more.",
    "",
    "Marking moments",
    "- Mark a moment worth jumping to as [[t=32.9]], or [[t=32.9|usa]] when it belongs to one boat, using the lowercase boat id from the fleet list. Time inside a chip is race seconds relative to the gun, not the clock string.",
    "- Chips are the only markup you may use. Everything else is plain sentences: no markdown, no lists, no headings, no bold.",
    "",
    "Answer shape",
    "- One sentence per line, each line ended with a newline. The first line answers the question in one sentence and carries no chip. Each line after it states one piece of evidence with its numbers: two to four evidence lines.",
    "- A chip goes at the end of the line whose moment it marks, after the closing period, never mid sentence.",
    "- Any answer that cites a race time or a boat's performance includes at least one chip on its key moment.",
    "- No em dashes. Plain human sentences; numbers beat adjectives.",
    "- Write only the finished answer. Never announce what you are about to check and never mention tools or their names; the spectator already sees a status line while you work.",
  ].join("\n");
}
