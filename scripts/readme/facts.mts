/**
 * Step 1 of the README build: recompute every number the page shows from the
 * repo itself. Nothing here is typed in; the sim is the source, the tests are
 * counted from their files, and a value with no source fails the build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { poseAt, windAt } from "../../src/lib/layline/interpolate";
import { KNOWLEDGE } from "../../src/lib/layline/analyst/knowledge";
import {
  MAX_MESSAGE_CHARS,
  MAX_TURNS,
  SUGGESTED_QUESTIONS,
} from "../../src/lib/layline/analyst/protocol";
import {
  ANALYST_TOOLS,
  detectManeuvers,
  startReport,
  toolStatusLabel,
} from "../../src/lib/layline/analyst/tools";
import { generateRace } from "../../src/lib/layline/sim";
import { FIX_HZ, RACE_SEED, SIM_HZ } from "../../src/lib/layline/types";
import type { Pose, RaceData, WindSample } from "../../src/lib/layline/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface TrackPoint {
  x: number;
  y: number;
}

export interface BoatFact {
  id: string;
  sail: string;
  hue: string;
  rank: number;
  elapsed: number;
  clock: string;
  fixCount: number;
  track: TrackPoint[]; // evaluator samples, 1 Hz, whole feed
}

export interface StartRowFact {
  sail: string;
  shortMeters: number;
  sogKnots: string;
  afterGun: number | null;
  /* Column text: the tool rounds, so 1 and 0.3 come back beside 0.6 and 0.52
   * and a mono column reads ragged. These pad the decimals, nothing else. */
  shortText: string;
  afterGunText: string;
  end: string;
}

export interface DebriefFacts {
  question: string;
  tool: string;
  status: string;
  tools: string[];
  glossaryTerms: number;
  maxTurns: number;
  maxChars: number;
  tacks: number;
  gybes: number;
  lineLengthMeters: number;
  start: StartRowFact[];
}

export interface Facts {
  seed: number;
  fixHz: number;
  simHz: number;
  boats: number;
  fixesTotal: number;
  feedSeconds: number;
  tMin: number;
  tMax: number;
  tackDeg: number; // mean upwind angle off the wind, from the beat fixes
  testCount: number;
  debrief: DebriefFacts;
  course: RaceData["course"];
  order: BoatFact[]; // finish order
  hermite: {
    from: number;
    to: number;
    fixes: { t: number; x: number; y: number; sog: number; cog: number }[];
    curve: TrackPoint[]; // 20 Hz through the same window
  };
}

function raceClock(t: number): string {
  const whole = Math.floor(t);
  const m = Math.floor(whole / 60);
  const s = whole - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function wrapSigned(a: number): number {
  const r = ((a % 360) + 540) % 360;
  return r - 180;
}

export function computeFacts(): Facts {
  const race = generateRace(RACE_SEED);
  const pose: Pose = { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
  const wind: WindSample = { t: 0, twd: 0, tws: 0 };

  const order: BoatFact[] = race.results.map((result) => {
    const meta = race.boats.find((boat) => boat.id === result.boatId);
    if (meta === undefined) throw new Error(`no meta for ${result.boatId}`);
    /* Gun to the line: the racing, not the prestart milling or the luff-out
     * afterwards, which draw as knots on a course this size. */
    const track: TrackPoint[] = [];
    for (let t = 0; t <= result.elapsed + 0.5; t += 1) {
      poseAt(race, result.boatId, t, "smooth", pose);
      track.push({ x: pose.x, y: pose.y });
    }
    return {
      id: result.boatId,
      sail: meta.sail,
      hue: meta.hue,
      rank: result.rank,
      elapsed: result.elapsed,
      clock: raceClock(result.elapsed),
      fixCount: race.fixes[result.boatId].length,
      track,
    };
  });

  /* Mean upwind angle off the wind across every beat-leg fix in the fleet;
   * the hero draws its laylines at this angle, not at an assumed 45. */
  let sum = 0;
  let n = 0;
  for (const boat of race.boats) {
    const legs = race.progress[boat.id];
    for (const fix of race.fixes[boat.id]) {
      const sample = legs.filter((p) => p.t <= fix.t).at(-1);
      if (sample === undefined || sample.leg !== "beat") continue;
      windAt(race, fix.t, wind);
      sum += Math.abs(wrapSigned(fix.cog - wind.twd));
      n += 1;
    }
  }
  if (n === 0) throw new Error("no beat fixes found for the layline angle");
  const tackDeg = sum / n;

  /* NZL's tack on the way to the mark, tight enough that individual fixes
   * read as separate dots at panel scale. */
  const from = 27;
  const to = 33;
  const windowFixes = race.fixes.nzl
    .filter((fix) => fix.t >= from && fix.t <= to)
    .map((fix) => ({ t: fix.t, x: fix.x, y: fix.y, sog: fix.sog, cog: fix.cog }));
  const curve: TrackPoint[] = [];
  for (let i = 0; i <= (to - from) * 20; i++) {
    poseAt(race, "nzl", from + i / 20, "smooth", pose);
    curve.push({ x: pose.x, y: pose.y });
  }

  let testCount = 0;
  for (const file of fs.readdirSync(path.join(ROOT, "tests"))) {
    const text = fs.readFileSync(path.join(ROOT, "tests", file), "utf8");
    testCount += (text.match(/^test\(/gm) ?? []).length;
  }
  if (testCount === 0) throw new Error("no tests counted; the suite moved");

  /* The Debrief panel draws one real tool call: the same start_report the
   * analyst runs, the same status line the stream prints while it runs. */
  const start = startReport(race);
  const moves = detectManeuvers(race);
  const debrief = {
    question: SUGGESTED_QUESTIONS[0],
    tool: "start_report",
    status: toolStatusLabel(race, "start_report", {}),
    tools: ANALYST_TOOLS.map((tool) => tool.name),
    glossaryTerms: KNOWLEDGE.length,
    maxTurns: MAX_TURNS,
    maxChars: MAX_MESSAGE_CHARS,
    tacks: moves.filter((move) => move.kind === "tack").length,
    gybes: moves.filter((move) => move.kind === "gybe").length,
    lineLengthMeters: start.lineLengthMeters,
    start: start.rows.map((row) => ({
      sail: row.sail,
      shortMeters: row.distanceToLineMeters,
      sogKnots: row.sogAtGunKnots,
      afterGun: row.crossedAfterGunSeconds,
      shortText: row.distanceToLineMeters.toFixed(1),
      afterGunText: row.crossedAfterGunSeconds === null ? "-" : row.crossedAfterGunSeconds.toFixed(2),
      end: row.nearerEnd === "pin" ? "PIN" : "BOAT",
    })),
  };

  return {
    seed: race.seed,
    fixHz: FIX_HZ,
    simHz: SIM_HZ,
    boats: race.boats.length,
    fixesTotal: order.reduce((total, boat) => total + boat.fixCount, 0),
    feedSeconds: Math.round(race.tMax - race.tMin),
    tMin: race.tMin,
    tMax: race.tMax,
    tackDeg,
    testCount,
    debrief,
    course: race.course,
    order,
    hermite: { from, to, fixes: windowFixes, curve },
  };
}
