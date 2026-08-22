/**
 * Analyst tools. Every tool is a pure function over one RaceData, so the
 * route binds them to the memoized race and the tests bind them to fresh
 * generateRace output and both read the same numbers. SI stays SI inside;
 * anything the HUD shows in display units crosses format.ts on the way out,
 * the same edge every on-screen number crosses.
 */
import { maneuversOf } from "@/lib/layline/analytics";
import { clock, deg, knots } from "@/lib/layline/format";
import type { BoatMeta, Fix, LegName, RaceData } from "@/lib/layline/types";
import { lookupTerms } from "./knowledge";

const DEG = Math.PI / 180;

/* The window analytics.ts measures a turn over, mirrored so the entry and exit
 * speeds this tool reports bracket the loss that detector computed. */
const LOSS_WINDOW = 4;

/* ------------------------------------------------------------------ */
/* Shared lookups                                                      */

function boatById(race: RaceData, id: string): BoatMeta | undefined {
  return race.boats.find((boat) => boat.id === id);
}

function clampT(race: RaceData, t: number): number {
  if (!Number.isFinite(t)) return race.tMin;
  if (t < race.tMin) return race.tMin;
  if (t > race.tMax) return race.tMax;
  return t;
}

/** Nearest fix to t. Fixes are sorted, 4 per second. */
function fixNear(fixes: Fix[], t: number): Fix {
  let lo = 0;
  let hi = fixes.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return t - fixes[lo].t <= fixes[hi].t - t ? fixes[lo] : fixes[hi];
}

/** Last progress sample at or before t, else the first. */
function progressAt(race: RaceData, boatId: string, t: number): RaceData["progress"][string][number] {
  const samples = race.progress[boatId];
  let found = samples[0];
  for (const sample of samples) {
    if (sample.t > t) break;
    found = sample;
  }
  return found;
}

/**
 * Speed made good toward the mark the boat is sailing for: along-course speed,
 * signed so positive always points at that mark. The same quantity the strip
 * beside the dock prints as "To mark".
 *
 * Only the beat and the run have a mark to make good toward. Before the gun a
 * boat is working the line, and after it finishes there is nothing left to
 * sail for, so the strip prints nothing on those legs and this returns null
 * rather than a number about a mark that is not there.
 */
function racingLeg(leg: LegName): boolean {
  return leg === "beat" || leg === "run";
}

function toMarkOf(fix: Fix, leg: LegName): number | null {
  if (!racingLeg(leg)) return null;
  const along = fix.sog * Math.cos(fix.cog * DEG);
  return leg === "run" ? -along : along;
}

/**
 * VMG the way the instrument dock means it: speed resolved onto the wind axis.
 * Positive climbing to windward, negative running away from the wind, which is
 * why it is a different number from the one above whenever the wind sits off
 * the course axis. The analyst gets both so it can quote either surface
 * without either of them being wrong.
 */
function vmgOf(fix: Fix): number {
  return fix.sog * Math.cos(fix.twa * DEG);
}

function mean(values: number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return values.length === 0 ? NaN : sum / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                                */

export interface StandingsRowOut {
  rank: number;
  boatId: string;
  sail: string;
  leg: LegName;
  dtfMeters: number;
  gapSeconds: number;
  finished: boolean;
}

export interface StandingsOut {
  raceClock: string;
  rows: StandingsRowOut[];
}

export function standingsAt(race: RaceData, tRaw: number): StandingsOut {
  const t = clampT(race, tRaw);
  const rows = race.boats.map((boat): StandingsRowOut => {
    const p = progressAt(race, boat.id, t);
    return {
      rank: p.rank,
      boatId: boat.id,
      sail: boat.sail,
      leg: p.leg,
      dtfMeters: Math.round(p.dtf),
      gapSeconds: p.rank <= 1 ? 0 : Math.round(p.gapSeconds),
      finished: p.leg === "finished",
    };
  });

  /* Progress samples land twice a second while a finish time is exact, so for
   * up to half a second after a boat crosses, its held sample still reads as
   * racing. The crossing itself is the authority, the same override the HUD
   * standings apply, so the analyst cannot say a boat is still on the run
   * while the screen shows it finished. */
  for (const row of rows) {
    const result = race.results.find((entry) => entry.boatId === row.boatId);
    if (result === undefined || result.elapsed > t) continue;
    row.finished = true;
    row.leg = "finished";
    row.rank = result.rank;
    /* The rest of the row follows the crossing too. A boat over the line is no
     * distance from it and no seconds behind anyone, which is what the next
     * progress sample holds anyway; without this the row would read finished
     * with meters still to run. */
    row.dtfMeters = 0;
    row.gapSeconds = 0;
  }

  rows.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.boatId < b.boatId ? -1 : a.boatId > b.boatId ? 1 : 0;
  });
  for (let i = 0; i < rows.length; i++) rows[i].rank = i + 1;
  return { raceClock: clock(t), rows };
}

export interface BoatStateOut {
  boatId: string;
  sail: string;
  raceClock: string;
  leg: LegName;
  xMeters: number;
  yMeters: number;
  sogKnots: string;
  cogDeg: string;
  hdgDeg: string;
  heelDeg: string;
  twaDeg: string;
  kite: number;
  /* Both readings the page shows, under the names the page shows them by:
   * "To mark" on the strip, "VMG" on the dock. To mark is null off the racing
   * legs, the same place the strip prints nothing. */
  toMarkKnots: string | null;
  vmgKnots: string;
}

export function boatState(race: RaceData, boatId: string, tRaw: number): BoatStateOut | { error: string } {
  const boat = boatById(race, boatId);
  if (boat === undefined) return { error: unknownBoat(race, boatId) };
  const t = clampT(race, tRaw);
  const fix = fixNear(race.fixes[boat.id], t);
  const leg = progressAt(race, boat.id, fix.t).leg;
  const toMark = toMarkOf(fix, leg);
  return {
    boatId: boat.id,
    sail: boat.sail,
    raceClock: clock(fix.t),
    leg,
    xMeters: round1(fix.x),
    yMeters: round1(fix.y),
    sogKnots: knots(fix.sog),
    cogDeg: deg(fix.cog),
    hdgDeg: deg(fix.hdg),
    heelDeg: deg(fix.heel),
    twaDeg: deg(fix.twa),
    kite: round2(fix.kite),
    toMarkKnots: toMark === null ? null : knots(toMark),
    vmgKnots: knots(vmgOf(fix)),
  };
}

export interface CompareSideOut {
  boatId: string;
  sail: string;
  avgSogKnots: string;
  avgToMarkKnots: string | null;
  avgVmgKnots: string;
  distanceSailedMeters: number;
}

export interface CompareOut {
  fromClock: string;
  toClock: string;
  a: CompareSideOut;
  b: CompareSideOut;
  aAheadByMetersAtStart: number;
  aAheadByMetersAtEnd: number;
}

function compareSide(race: RaceData, boat: BoatMeta, t0: number, t1: number): CompareSideOut {
  const fixes = race.fixes[boat.id].filter((fix) => fix.t >= t0 && fix.t <= t1);
  /* Only the fixes with a mark to make good toward feed this average; a
   * window that is all prestart or all post-finish has nothing to report. */
  const toMarks = fixes
    .map((fix) => toMarkOf(fix, progressAt(race, boat.id, fix.t).leg))
    .filter((value): value is number => value !== null);
  let distance = 0;
  for (let i = 1; i < fixes.length; i++) {
    distance += Math.hypot(fixes[i].x - fixes[i - 1].x, fixes[i].y - fixes[i - 1].y);
  }
  return {
    boatId: boat.id,
    sail: boat.sail,
    avgSogKnots: knots(mean(fixes.map((fix) => fix.sog))),
    avgToMarkKnots: toMarks.length === 0 ? null : knots(mean(toMarks)),
    avgVmgKnots: knots(mean(fixes.map(vmgOf))),
    distanceSailedMeters: Math.round(distance),
  };
}

export function compareBoats(
  race: RaceData,
  aId: string,
  bId: string,
  t0Raw: number,
  t1Raw: number,
): CompareOut | { error: string } {
  const a = boatById(race, aId);
  const b = boatById(race, bId);
  if (a === undefined) return { error: unknownBoat(race, aId) };
  if (b === undefined) return { error: unknownBoat(race, bId) };
  let t0 = clampT(race, t0Raw);
  let t1 = clampT(race, t1Raw);
  if (t0 > t1) [t0, t1] = [t1, t0];
  const pa0 = progressAt(race, a.id, t0);
  const pb0 = progressAt(race, b.id, t0);
  const pa1 = progressAt(race, a.id, t1);
  const pb1 = progressAt(race, b.id, t1);
  return {
    fromClock: clock(t0),
    toClock: clock(t1),
    a: compareSide(race, a, t0, t1),
    b: compareSide(race, b, t0, t1),
    aAheadByMetersAtStart: Math.round(pb0.dtf - pa0.dtf),
    aAheadByMetersAtEnd: Math.round(pb1.dtf - pa1.dtf),
  };
}

export interface ManeuverOut {
  boatId: string;
  sail: string;
  kind: "tack" | "gybe";
  t: number;
  raceClock: string;
  entrySogKnots: string;
  exitSogKnots: string;
  speedLossKnots: string;
}

/**
 * Tacks and gybes, read from the same detector the timeline markers use
 * ([`analytics.maneuversOf`]). The two used to be separate loops kept in step
 * by hand, and they drifted the moment either side improved: the markers
 * measured the drawdown off the speed carried into the turn while the tool
 * still took the slowest reading against the first fix of its window, so on
 * this fleet every gybe read 0.0 to a viewer and 0.5 to 1.0 on the tooltip
 * beside it. One detector, one number, no way to disagree.
 *
 * Entry is the reading the loss is measured from, the fastest in the four
 * seconds up to the flip; exit is the last reading four seconds past it.
 */
export function detectManeuvers(race: RaceData, boatId?: string): ManeuverOut[] {
  const boats =
    boatId === undefined ? race.boats : race.boats.filter((boat) => boat.id === boatId);
  const out: ManeuverOut[] = [];
  for (const boat of boats) {
    const fixes = race.fixes[boat.id];
    for (const move of maneuversOf(race, boat.id)) {
      let entry = -Infinity;
      let exit = fixes[0];
      for (const fix of fixes) {
        if (fix.t < move.t - LOSS_WINDOW) continue;
        if (fix.t > move.t + LOSS_WINDOW) break;
        if (fix.t <= move.t && fix.sog > entry) entry = fix.sog;
        exit = fix;
      }
      out.push({
        boatId: boat.id,
        sail: boat.sail,
        kind: move.kind,
        t: move.t,
        raceClock: clock(move.t),
        entrySogKnots: knots(entry),
        exitSogKnots: knots(exit.sog),
        speedLossKnots: move.lossKnots,
      });
    }
  }
  out.sort((a, b) => a.t - b.t || (a.boatId < b.boatId ? -1 : 1));
  return out;
}

export interface StartRowOut {
  boatId: string;
  sail: string;
  distanceToLineMeters: number;
  sogAtGunKnots: string;
  crossedAfterGunSeconds: number | null;
  nearerEnd: "pin" | "boat";
}

export interface StartReportOut {
  lineLengthMeters: number;
  rows: StartRowOut[];
}

export function startReport(race: RaceData): StartReportOut {
  const rows = race.boats.map((boat): StartRowOut => {
    const fixes = race.fixes[boat.id];
    const atGun = fixNear(fixes, 0);
    let crossed: number | null = null;
    for (let i = 1; i < fixes.length; i++) {
      const before = fixes[i - 1];
      const after = fixes[i];
      if (after.t <= 0) continue;
      if (before.y < 0 && after.y >= 0) {
        crossed = round2(before.t + ((0 - before.y) / (after.y - before.y)) * (after.t - before.t));
        break;
      }
    }
    const toPin = Math.hypot(atGun.x - race.course.startPin.x, atGun.y - race.course.startPin.y);
    const toBoat = Math.hypot(atGun.x - race.course.startBoat.x, atGun.y - race.course.startBoat.y);
    return {
      boatId: boat.id,
      sail: boat.sail,
      distanceToLineMeters: round1(Math.abs(atGun.y)),
      sogAtGunKnots: knots(atGun.sog),
      crossedAfterGunSeconds: crossed,
      nearerEnd: toPin < toBoat ? "pin" : "boat",
    };
  });
  rows.sort((a, b) => {
    const ca = a.crossedAfterGunSeconds ?? Infinity;
    const cb = b.crossedAfterGunSeconds ?? Infinity;
    return ca - cb || (a.boatId < b.boatId ? -1 : 1);
  });
  return {
    lineLengthMeters: Math.round(race.course.startBoat.x - race.course.startPin.x),
    rows,
  };
}

export interface WindOut {
  raceClock: string;
  twdDeg: string;
  twsKnots: string;
}

export function windAt(race: RaceData, tRaw: number): WindOut {
  const t = clampT(race, tRaw);
  let nearest = race.wind[0];
  for (const sample of race.wind) {
    if (Math.abs(sample.t - t) < Math.abs(nearest.t - t)) nearest = sample;
  }
  return { raceClock: clock(t), twdDeg: deg(nearest.twd), twsKnots: knots(nearest.tws) };
}

export interface LookupOut {
  matches: { title: string; text: string }[];
}

export function lookupTerm(query: string): LookupOut {
  return { matches: lookupTerms(query).map(({ title, text }) => ({ title, text })) };
}

function unknownBoat(race: RaceData, id: string): string {
  return `unknown boat id "${id}"; use one of ${race.boats.map((boat) => boat.id).join(", ")}`;
}

/* ------------------------------------------------------------------ */
/* Tool schemas, provider-neutral JSON Schema                          */

export interface AnalystTool {
  name: string;
  description: string;
  strict: true;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

/* Two speeds made good, and the page prints both under these names. Saying
 * which is which in every description that returns them is what keeps an
 * answer from calling the strip's number by the dock's name. */
const SPEED_NOTE =
  "Two made-good readings come back and they are different numbers. toMark is speed along the course axis, sog times the cosine of cog, signed toward whichever mark the boat is sailing for, so it is positive whenever the boat is gaining; the strip beside the instrument dock prints it as \"To mark\". vmg is speed along the wind axis, sog times the cosine of the true wind angle, positive climbing to windward and negative running away from the wind; that is the number the dock's VMG tile shows. They differ whenever the wind sits off the course axis, and they differ in sign on the run. toMark is null before the gun and after a boat finishes, when there is no mark to make good toward and the strip prints nothing; the strip also floors its display at zero, so a small negative reading here shows on screen as 0.0.";

const T_NOTE = "Race time in seconds relative to the gun; negative is the prestart.";

export const ANALYST_TOOLS: AnalystTool[] = [
  {
    name: "standings_at",
    description:
      "Fleet standings at a race time: rank, current leg, distance to finish in meters, gap to the leader in seconds, and whether each boat has finished. During the prestart, rank is entry order and gaps are not meaningful.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { t: { type: "number", description: T_NOTE } },
      required: ["t"],
      additionalProperties: false,
    },
  },
  {
    name: "boat_state",
    description:
      `One boat's telemetry at a race time: position in course meters, speed over ground in knots, course over ground, heading, heel and wind angle in degrees, gennaker hoist state 0 to 1, and both made-good speeds in knots. ${SPEED_NOTE}`,
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        boatId: { type: "string", description: "Lowercase boat id, for example nzl" },
        t: { type: "number", description: T_NOTE },
      },
      required: ["boatId", "t"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_boats",
    description:
      `Compare two boats over a time window: average sog, average speed to the mark and average VMG in knots, distance sailed in meters, and the along-course gap between them at the start and end of the window, positive when boat a is ahead. ${SPEED_NOTE}`,
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        a: { type: "string", description: "Lowercase id of the first boat" },
        b: { type: "string", description: "Lowercase id of the second boat" },
        t0: { type: "number", description: `Window start. ${T_NOTE}` },
        t1: { type: "number", description: `Window end. ${T_NOTE}` },
      },
      required: ["a", "b", "t0", "t1"],
      additionalProperties: false,
    },
  },
  {
    name: "maneuvers",
    description:
      "Every tack and gybe, for one boat or the whole fleet: when it happened, entry and exit speed in knots, and speed lost through the turn. A tack is a wind-angle sign flip under 90 degrees off the wind, a gybe at 90 or wider. Speed lost is the drawdown off the speed carried in: the fastest reading in the four seconds up to the turn minus the slowest between that peak and four seconds past it, the same figure the timeline marker shows.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        boatId: {
          type: ["string", "null"],
          description: "Lowercase boat id, or null for the whole fleet",
        },
      },
      required: ["boatId"],
      additionalProperties: false,
    },
  },
  {
    name: "start_report",
    description:
      "The start, boat by boat: distance short of the line at the gun in meters, speed at the gun in knots, seconds to cross the line after the gun, and which end each boat started nearer, the pin or the committee boat. Rows are ordered by crossing time.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "wind_at",
    description:
      "True wind at a race time: direction in degrees in the course frame, where 0 blows straight down the course, and speed in knots.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { t: { type: "number", description: T_NOTE } },
      required: ["t"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_sailing_term",
    description:
      "Look up a sailing term in the glossary: layline, VMG, tack, gybe, gennaker, start bias, OCS, and the rest. Returns the two best matching entries.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "The term or phrase to look up" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Run one tool by name against one race. Returns the tool_result JSON. */
export function runTool(race: RaceData, name: string, input: unknown): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  switch (name) {
    case "standings_at":
      return JSON.stringify(standingsAt(race, num(args.t)));
    case "boat_state":
      return JSON.stringify(boatState(race, str(args.boatId), num(args.t)));
    case "compare_boats":
      return JSON.stringify(
        compareBoats(race, str(args.a), str(args.b), num(args.t0), num(args.t1)),
      );
    case "maneuvers": {
      const boatId = typeof args.boatId === "string" && args.boatId.length > 0 ? args.boatId : undefined;
      if (boatId !== undefined && boatById(race, boatId) === undefined) {
        return JSON.stringify({ error: unknownBoat(race, boatId) });
      }
      const moves = detectManeuvers(race, boatId);
      return JSON.stringify({
        tacks: moves.filter((move) => move.kind === "tack").length,
        gybes: moves.filter((move) => move.kind === "gybe").length,
        moves,
      });
    }
    case "start_report":
      return JSON.stringify(startReport(race));
    case "wind_at":
      return JSON.stringify(windAt(race, num(args.t)));
    case "lookup_sailing_term":
      return JSON.stringify(lookupTerm(str(args.query)));
    default:
      return JSON.stringify({ error: `unknown tool "${name}"` });
  }
}

/** Human status line for the stream while a tool runs. Display text: no periods. */
export function toolStatusLabel(race: RaceData, name: string, input: unknown): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const sail = (id: unknown): string => {
    const boat = typeof id === "string" ? boatById(race, id) : undefined;
    return boat === undefined ? "the fleet" : boat.sail;
  };
  switch (name) {
    case "standings_at":
      return `checking standings at ${clock(clampT(race, num(args.t)))}`;
    case "boat_state":
      return `reading ${sail(args.boatId)} at ${clock(clampT(race, num(args.t)))}`;
    case "compare_boats":
      return `comparing ${sail(args.a)} and ${sail(args.b)}`;
    case "maneuvers":
      return typeof args.boatId === "string" && args.boatId.length > 0
        ? `counting ${sail(args.boatId)} tacks and gybes`
        : "counting tacks and gybes";
    case "start_report":
      return "reviewing the start";
    case "wind_at":
      return `checking the wind at ${clock(clampT(race, num(args.t)))}`;
    case "lookup_sailing_term":
      return `looking up ${str(args.query).slice(0, 40) || "a term"}`;
    default:
      return "reading the race data";
  }
}
