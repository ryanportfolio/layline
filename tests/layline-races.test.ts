/**
 * The race library: the sanity audit every shipped seed has to pass, the
 * registry contract, the analyst route's race binding, and the store swap.
 * Run: npx --yes tsx --test tests/layline-races.test.ts
 *
 * The audit below is the merged version of the three seed hunts that picked
 * these seeds, run here over every race in the registry including the shipped
 * one. `generateRace` is deterministic, so every number is safe to pin: if one
 * of these moves without a change to sim.ts, something upstream broke.
 *
 * Gates 1 to 8 fail the test. Measure 9 is recorded and never fails: a tack
 * away from an offset windward mark raises straight-line range to that mark
 * honestly, and the worst run in the hunt belongs to the shipped race.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateRace } from "../src/lib/layline/sim";
import { briefFacts, windReading, windReadingAt } from "../src/lib/layline/brief";
import {
  STEADY_WINDOW,
  maneuversOf,
  polarReview,
  startLineOf,
  startReadingAt,
  targetSpeed,
} from "../src/lib/layline/analytics";
import { createPose, legAt, poseAt, windAt } from "../src/lib/layline/interpolate";
import { FICTIONAL_ONE_DESIGN_POLAR, polarFraction } from "../src/lib/layline/polar";
import { startReport } from "../src/lib/layline/analyst/tools";
import { MISSING, clock, knots, seconds } from "../src/lib/layline/format";
import { DEFAULT_RACE_ID, RACES, isRaceId, raceMeta } from "../src/lib/layline/races";
import { SUGGESTED_QUESTIONS, parseChips } from "../src/lib/layline/analyst/protocol";
import { FIX_HZ, PROGRESS_HZ, RACE_SEED } from "../src/lib/layline/types";
import type { Fix, LegName, ProgressSample, RaceData } from "../src/lib/layline/types";
import { POST } from "../src/app/api/layline/analyst/route";
import {
  ANALYST_MAX,
  RAIL_MIN,
  clampPaneWidth,
  parseWorkspacePreferences,
  raceMatchesSearch,
  sortPinnedRows,
} from "../src/app/races/workspaceState";
import {
  AUTOPLAY_FROM,
  OPEN_AT,
  pointAtRace,
  raceData,
  useReplay,
} from "../src/components/layline/store";

/* ------------------------------------------------------------------ */
/* Audit thresholds                                                    */

/* The winner's own elapsed, not race.tMax: tMax is the replay window and runs
 * past the last finisher, 64.50 s on the shipped seed against a 50.16 s win.
 * The registry lands at 47.65, 50.16 and 50.87. */
const WIN_MIN_S = 45;
const WIN_MAX_S = 60;
/* Registry observed 5.35 to 8.49 s. */
const SPREAD_MIN_S = 2;
const SPREAD_MAX_S = 35;
/* Worst continuous loss of ground observed anywhere in the hunt is 1.0 s. */
const BACKWARDS_MAX_S = 8;
/* The sim caps sog at 11.3 m/s, so 1/FIX_HZ can never cover more than 2.83 m.
 * Worst observed is 2.34 m. */
const FIX_STEP_MAX_M = 4;
/* Median absolute TWA on the beat, which doubled is the tacking angle. */
const BEAT_TWA_MIN_DEG = 30;
const BEAT_TWA_MAX_DEG = 60;

/* ------------------------------------------------------------------ */
/* Audit helpers                                                       */

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Longest continuous stretch, in seconds, over which a sampled value only
 * rises. `keep` drops samples that should not be judged at all, and dropping
 * one breaks the run rather than joining what sits either side of it.
 */
function longestRise(values: number[], keep: (index: number) => boolean, hz: number): number {
  let best = 0;
  let run = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (!keep(i) || !keep(i - 1)) {
      run = 0;
      continue;
    }
    if (values[i] > values[i - 1] + 1e-9) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best / hz;
}

interface LeaderSegment {
  boatId: string;
  sail: string;
  from: number;
  to: number;
  leg: LegName;
}

/**
 * The leader timeline, collapsed into segments. Rank 1 in the progress feed is
 * the smallest distance to finish at every sample where anyone is still racing,
 * which the audit asserts below, so this is the lead the standings dock shows.
 *
 * t = 0 is excluded: that sample still carries entry order per the
 * ProgressSample doc comment, so counting it manufactures a change at t = 0.5
 * in every seed. Prestart samples are excluded for the same reason.
 */
function leaderSegments(race: RaceData): LeaderSegment[] {
  const leading: { t: number; boatId: string; sail: string; leg: LegName }[] = [];
  for (const boat of race.boats) {
    for (const sample of race.progress[boat.id] ?? []) {
      if (sample.t <= 0 || sample.rank !== 1 || sample.leg === "prestart") continue;
      leading.push({ t: sample.t, boatId: boat.id, sail: boat.sail, leg: sample.leg });
    }
  }
  leading.sort((a, b) => a.t - b.t);

  const segments: LeaderSegment[] = [];
  for (const entry of leading) {
    const open = segments[segments.length - 1];
    if (open !== undefined && open.boatId === entry.boatId) {
      open.to = entry.t;
      continue;
    }
    segments.push({ boatId: entry.boatId, sail: entry.sail, from: entry.t, to: entry.t, leg: entry.leg });
  }
  return segments;
}

function sailOf(race: RaceData, boatId: string): string {
  return race.boats.find((boat) => boat.id === boatId)?.sail ?? boatId;
}

/* ------------------------------------------------------------------ */
/* Gates 1 to 8, plus the recorded measures                            */

function auditRace(race: RaceData): {
  record: string[];
  worstGeomRiseSeconds: number;
  worstGeomRiseBoat: string;
} {
  const record: string[] = [];

  /* 1. Fleet completeness. */
  const byRank = [...race.results].sort((a, b) => a.rank - b.rank);
  assert.equal(race.results.length, race.boats.length, "one result per boat");
  assert.deepEqual(
    byRank.map((result) => result.rank),
    race.boats.map((_, index) => index + 1),
    "ranks run 1 to the fleet size with no gap and no tie",
  );
  for (const boat of race.boats) {
    assert.ok(
      race.results.some((result) => result.boatId === boat.id),
      `no result for ${boat.sail}`,
    );
    assert.equal(
      race.events.filter((event) => event.kind === "rounding" && event.boatId === boat.id).length,
      1,
      `${boat.sail} does not have exactly one rounding event`,
    );
    assert.equal(
      race.events.filter((event) => event.kind === "finish" && event.boatId === boat.id).length,
      1,
      `${boat.sail} does not have exactly one finish event`,
    );
  }

  /* 2 and 3. Winning elapsed and finish spread. */
  const winner = byRank[0];
  const last = byRank[byRank.length - 1];
  const spread = last.elapsed - winner.elapsed;
  assert.ok(
    winner.elapsed >= WIN_MIN_S && winner.elapsed <= WIN_MAX_S,
    `winning elapsed ${winner.elapsed.toFixed(2)}s outside ${WIN_MIN_S} to ${WIN_MAX_S}`,
  );
  assert.ok(
    spread >= SPREAD_MIN_S && spread <= SPREAD_MAX_S,
    `finish spread ${spread.toFixed(2)}s outside ${SPREAD_MIN_S} to ${SPREAD_MAX_S}`,
  );

  const roundingTimes = new Map<string, number>();
  for (const event of race.events) {
    if (event.kind === "rounding" && event.boatId !== undefined) {
      roundingTimes.set(event.boatId, event.t);
    }
  }

  const mark = race.course.windward;
  const gateX = (race.course.startPin.x + race.course.startBoat.x) / 2;
  const gateY = (race.course.startPin.y + race.course.startBoat.y) / 2;

  let worstBackSeconds = 0;
  let worstBackBoat = "";
  let worstStepMeters = 0;
  let worstStepBoat = "";
  let worstGeomRiseSeconds = 0;
  let worstGeomRiseBoat = "";
  const beatTwa: number[] = [];
  const perBoatBeatTwa: string[] = [];

  for (const boat of race.boats) {
    const fixes: Fix[] = race.fixes[boat.id] ?? [];
    const progress: ProgressSample[] = race.progress[boat.id] ?? [];
    assert.ok(fixes.length > 0, `${boat.sail} has no fixes`);
    assert.ok(progress.length > 0, `${boat.sail} has no progress samples`);

    const finishAt = race.results.find((result) => result.boatId === boat.id)!.elapsed;
    const roundAt = roundingTimes.get(boat.id) ?? Infinity;

    /* 4. Backwards, published measure. dtf is the number the standings dock
     * counts down, so a sustained rise is a boat losing ground on screen. The
     * last second before a boat's own finish is skipped: dtf pins to zero
     * there. */
    const back = longestRise(
      progress.map((sample) => sample.dtf),
      (index) => {
        const sample = progress[index];
        return sample.t >= 0 && sample.leg !== "prestart" && sample.t < finishAt - 1;
      },
      PROGRESS_HZ,
    );
    if (back > worstBackSeconds) {
      worstBackSeconds = back;
      worstBackBoat = boat.sail;
    }

    /* 5, 6 and 7 over the fix stream. */
    let sawPrestartSide = false;
    let sawCourseSide = false;
    for (let i = 0; i < fixes.length; i += 1) {
      const fix = fixes[i];
      for (const [field, value] of Object.entries(fix)) {
        assert.ok(
          Number.isFinite(value),
          `${boat.sail} fix at index ${i} has a non finite ${field}`,
        );
      }
      if (fix.t < 0 && fix.y < 0) sawPrestartSide = true;
      if (fix.t >= 0 && fix.y > 0) sawCourseSide = true;
      if (i === 0) continue;
      const previous = fixes[i - 1];
      const step = Math.hypot(fix.x - previous.x, fix.y - previous.y);
      if (step > worstStepMeters) {
        worstStepMeters = step;
        worstStepBoat = boat.sail;
      }
    }
    assert.ok(sawPrestartSide, `${boat.sail} never sits on the prestart side before the gun`);
    assert.ok(sawCourseSide, `${boat.sail} never crosses onto the course side after the gun`);

    for (const sample of progress) {
      assert.ok(Number.isFinite(sample.t), `${boat.sail} progress has a non finite t`);
      assert.ok(Number.isFinite(sample.dtf), `${boat.sail} progress has a non finite dtf`);
      assert.ok(Number.isFinite(sample.rank), `${boat.sail} progress has a non finite rank`);
    }

    /* 8. Layline believability. Median absolute TWA over the beat, taken from
     * the whole fleet's beat fixes: the median of one boat's beat can sit wide
     * while the fleet's tacking angle reads normal. The first 2 s and the last
     * 3 s before the boat's own rounding are dropped, where a boat is still
     * accelerating off the line or already easing into the mark. */
    const ownBeat = fixes
      .filter((fix) => fix.t > 2 && fix.t < roundAt - 3)
      .map((fix) => Math.abs(fix.twa));
    if (ownBeat.length > 0) {
      beatTwa.push(...ownBeat);
      perBoatBeatTwa.push(`${boat.sail} ${median(ownBeat).toFixed(1)}`);
    }

    /* 9. Backwards, geometric measure. Recorded, never failed. */
    const range = progress.map((sample) => {
      const fix = fixes.reduce((best, current) =>
        Math.abs(current.t - sample.t) < Math.abs(best.t - sample.t) ? current : best,
      );
      const onBeat = sample.leg === "beat";
      return Math.hypot(fix.x - (onBeat ? mark.x : gateX), fix.y - (onBeat ? mark.y : gateY));
    });
    const geom = longestRise(
      range,
      (index) => {
        const sample = progress[index];
        if (sample.t < 1) return false;
        if (sample.leg === "prestart" || sample.leg === "finished") return false;
        if (Math.abs(sample.t - roundAt) <= 3) return false;
        return sample.t <= finishAt - 0.5;
      },
      PROGRESS_HZ,
    );
    if (geom > worstGeomRiseSeconds) {
      worstGeomRiseSeconds = geom;
      worstGeomRiseBoat = boat.sail;
    }
  }

  assert.ok(
    worstBackSeconds <= BACKWARDS_MAX_S,
    `${worstBackBoat} loses ground for ${worstBackSeconds.toFixed(2)}s straight`,
  );
  assert.ok(
    worstStepMeters < FIX_STEP_MAX_M,
    `${worstStepBoat} moves ${worstStepMeters.toFixed(2)}m between fixes at ${FIX_HZ} Hz`,
  );

  const medianBeatTwa = median(beatTwa);
  assert.ok(
    medianBeatTwa >= BEAT_TWA_MIN_DEG && medianBeatTwa <= BEAT_TWA_MAX_DEG,
    `median beat TWA ${medianBeatTwa.toFixed(1)} deg is a ${(medianBeatTwa * 2).toFixed(1)} deg tacking angle`,
  );

  /* 6, the rest of the sweep. */
  for (const sample of race.wind) {
    assert.ok(
      Number.isFinite(sample.t) && Number.isFinite(sample.twd) && Number.isFinite(sample.tws),
      `non finite wind sample at t=${sample.t}`,
    );
  }
  for (const result of race.results) {
    assert.ok(Number.isFinite(result.elapsed), `${result.boatId} has a non finite elapsed`);
  }
  for (const event of race.events) {
    assert.ok(Number.isFinite(event.t), `${event.kind} event has a non finite t`);
  }
  assert.ok(Number.isFinite(race.tMin) && Number.isFinite(race.tMax), "tMin and tMax are finite");
  assert.ok(race.tMax > race.tMin, "tMax runs after tMin");

  /* Rank 1 is the smallest distance to finish at every sample where anyone is
   * still racing, which is what lets the leader timeline read off rank alone.
   * Boats that have finished all sit at dtf 0 and tie there, so they are out. */
  const samplesByTime = new Map<number, { boatId: string; rank: number; dtf: number; leg: LegName }[]>();
  for (const boat of race.boats) {
    for (const sample of race.progress[boat.id] ?? []) {
      if (sample.t <= 0 || sample.leg === "prestart" || sample.leg === "finished") continue;
      const row = samplesByTime.get(sample.t) ?? [];
      row.push({ boatId: boat.id, rank: sample.rank, dtf: sample.dtf, leg: sample.leg });
      samplesByTime.set(sample.t, row);
    }
  }
  for (const [t, rows] of samplesByTime) {
    const leader = rows.find((row) => row.rank === 1);
    if (leader === undefined) continue;
    const closest = rows.reduce((best, row) => (row.dtf < best.dtf ? row : best));
    assert.equal(
      leader.boatId,
      closest.boatId,
      `at t=${t} rank 1 is ${leader.boatId} but ${closest.boatId} is closer to the finish`,
    );
  }

  /* Recorded for the record, gated on nothing. */
  const roundings = race.events.filter((event) => event.kind === "rounding").map((event) => event.t);
  const gaps = byRank.slice(1).map((result, index) => (result.elapsed - byRank[index].elapsed).toFixed(2));
  record.push(
    `order ${byRank.map((r) => `${r.rank}.${sailOf(race, r.boatId)} ${r.elapsed.toFixed(2)}`).join(" | ")}`,
    `margin ${(byRank[1].elapsed - winner.elapsed).toFixed(2)}s  gaps ${gaps.join(" ")}  spread ${spread.toFixed(2)}s  tMax ${race.tMax}`,
    `roundingSpread ${(Math.max(...roundings) - Math.min(...roundings)).toFixed(2)}s  tws ${Math.min(...race.wind.map((w) => w.tws)).toFixed(2)} to ${Math.max(...race.wind.map((w) => w.tws)).toFixed(2)} m/s  twd ${Math.min(...race.wind.map((w) => w.twd)).toFixed(2)} to ${Math.max(...race.wind.map((w) => w.twd)).toFixed(2)} deg`,
    `worstBackwards ${worstBackSeconds.toFixed(2)}s ${worstBackBoat}  maxFixStep ${worstStepMeters.toFixed(2)}m ${worstStepBoat}`,
    `beatTwa median ${medianBeatTwa.toFixed(1)} deg, tacking angle ${(medianBeatTwa * 2).toFixed(1)} deg, per boat ${perBoatBeatTwa.join(", ")}`,
    `geometricRise ${worstGeomRiseSeconds.toFixed(2)}s ${worstGeomRiseBoat} (recorded, never gated)`,
    `leaders ${leaderSegments(race).map((s) => `${s.sail} ${s.from} to ${s.to} on the ${s.leg}`).join(" > ")}`,
  );

  return { record, worstGeomRiseSeconds, worstGeomRiseBoat };
}

/* ------------------------------------------------------------------ */
/* The audit, over every seed in the registry                          */

for (const meta of RACES) {
  test(`race ${meta.id} passes the sanity audit`, () => {
    const race = generateRace(meta.seed);
    assert.equal(race.seed, meta.seed);
    const { record, worstGeomRiseSeconds, worstGeomRiseBoat } = auditRace(race);
    console.log(`\n${meta.id} seed ${meta.seed}\n  ${record.join("\n  ")}`);
    /* Recorded, not gated: a tack away from an offset windward mark raises
     * straight-line range honestly, and the shipped race owns the worst run in
     * the hunt at 6.50 s. Printed so a regression is visible in the log. */
    if (worstGeomRiseSeconds > BACKWARDS_MAX_S) {
      console.log(
        `  warning: ${worstGeomRiseBoat} range to the mark rose for ${worstGeomRiseSeconds.toFixed(2)}s`,
      );
    }
  });
}

test("two runs of the same registry seed are byte-identical", () => {
  for (const meta of RACES) {
    assert.equal(
      JSON.stringify(generateRace(meta.seed)),
      JSON.stringify(generateRace(meta.seed)),
      `${meta.id} is not deterministic`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Registry contract                                                   */

test("the registry ships three races with the shipped race first", () => {
  assert.equal(RACES.length, 3);
  assert.equal(RACES[0].seed, RACE_SEED);
  assert.equal(DEFAULT_RACE_ID, RACES[0].id);
  const ids = RACES.map((meta) => meta.id);
  assert.equal(new Set(ids).size, ids.length, "race ids are unique");
  const seeds = RACES.map((meta) => meta.seed);
  assert.equal(new Set(seeds).size, seeds.length, "race seeds are unique");
  for (const id of ids) {
    assert.equal(isRaceId(id), true);
    assert.equal(raceMeta(id)?.id, id);
  }
  assert.equal(isRaceId("no-such-race"), false);
  assert.equal(isRaceId(String(RACE_SEED)), false, "a raw seed is not a race id");
  assert.equal(raceMeta("no-such-race"), undefined);
});

test("every shipped race opens its prestart ten seconds before the gun", async () => {
  /* The sequence board on the story page is a 30s loop carrying three 10s
     prestarts, its odometers are eleven rungs tall, and its
     animation-timing-function is a hardcoded steps(10, end). None of that is
     read off the race at run time, so a fourth race opening anywhere but -10
     has to fail here rather than walk its own digits out of step with its own
     clock on a page nobody is watching that closely. */
  const { raceFor } = await import("../src/lib/layline/analyst/data");
  for (const meta of RACES) {
    const race = raceFor(meta.id);
    assert.ok(race !== null, `${meta.id} is not in the registry`);
    assert.equal(race.tMin, -10, `${meta.id} does not open ten seconds out`);
  }
});

test("a start line margin reads in hundredths, not as another 0:00", () => {
  /* clock() rounds all three first crossings to 0:00, so the best number on
     the board had no formatter to cross and the doctrine says every numeral
     crosses exactly one. seconds() is that formatter. It returns a bare figure
     like the rest of them: the + is a sign the cell prints, the way gap() does. */
  const margins = RACES.map((meta) => {
    const first = briefFacts(generateRace(meta.seed)).first;
    assert.ok(first !== null, `${meta.id} has no first crossing`);
    assert.equal(clock(first.t), "0:00", `${meta.id} no longer needs the second decimal`);
    return seconds(first.t);
  });
  assert.deepEqual(margins, ["0.16", "0.11", "0.24"]);
  /* Negative zero is normalised and a non-finite value is MISSING, the two
     rules every other formatter in that file keeps. */
  assert.equal(seconds(-0.001), "0.00");
  assert.equal(seconds(Number.NaN), MISSING);
  assert.equal(seconds(Number.POSITIVE_INFINITY), MISSING);
});

test("a board row's spoken label is a sentence and never ends in a period", async () => {
  /* The .mjs suite can only see the token `aria-label={row.label}`, so it can
     never see the string a screen reader is handed. This builds the same string
     the component builds, from the same registry and the same formatter, and
     pins the template it was built from so the two cannot drift apart in
     silence. */
  const source = readFileSync("src/components/layline/StartSequence.tsx", "utf8");
  const template =
    "label: `${meta.name}, ${meta.venue}, ${meta.dateLabel}${crossing}, open in the race library`,";
  assert.ok(
    source.includes(template),
    "StartSequence.tsx no longer builds the row label the way this test does",
  );
  assert.ok(
    source.includes(
      ": `, first across the line ${first.sail} at plus ${seconds(first.t)} seconds`;",
    ),
    "StartSequence.tsx no longer builds the crossing clause the way this test does",
  );

  const { raceFor } = await import("../src/lib/layline/analyst/data");
  const labels = RACES.map((meta) => {
    const race = raceFor(meta.id);
    assert.ok(race !== null, `${meta.id} is not in the registry`);
    const first = briefFacts(race).first;
    const crossing =
      first === null
        ? ""
        : `, first across the line ${first.sail} at plus ${seconds(first.t)} seconds`;
    return `${meta.name}, ${meta.venue}, ${meta.dateLabel}${crossing}, open in the race library`;
  });

  assert.equal(labels.length, RACES.length);
  for (const label of labels) {
    /* Display text on this route carries no terminal period, and the label is
       display text a screen reader speaks rather than a sentence in prose. */
    assert.doesNotMatch(label, /\.\s*$/, `${label} ends in a period`);
    assert.match(label, /open in the race library$/);
    assert.doesNotMatch(label, /undefined|NaN|\[object/);
  }
  assert.equal(
    labels[0],
    "Summer fleet race, Long Beach, 26 Jul 2028, first across the line JPN 18 at plus 0.16 seconds, open in the race library",
  );
});

test("race workspace preferences filter stale ids and clamp stored widths", () => {
  const validIds = new Set(RACES.map((race) => race.id));
  const preferences = parseWorkspacePreferences(
    JSON.stringify({
      pinned: ["sable-reach", "retired-race", "sable-reach"],
      archived: ["kestrel-sound", "retired-race"],
      railWidth: 20,
      analystWidth: 900,
      railSide: "right",
      railCollapsed: true,
    }),
    validIds,
  );

  assert.deepEqual(preferences.pinned, ["sable-reach"]);
  assert.deepEqual(preferences.archived, ["kestrel-sound"]);
  assert.equal(preferences.railWidth, RAIL_MIN);
  assert.equal(preferences.analystWidth, ANALYST_MAX);
  assert.equal(preferences.railSide, "right");
  assert.equal(preferences.railCollapsed, true);
});

test("search is only a view and pinned rows sort ahead of registry order", () => {
  const selectedId = "long-beach";
  const rows = RACES.map(({ id, name, venue, dateLabel }) => ({ id, name, venue, dateLabel }));
  const visible = rows.filter((row) => raceMatchesSearch(row, "13 nov"));
  assert.deepEqual(visible.map((row) => row.id), ["kestrel-sound"]);
  assert.equal(selectedId, "long-beach", "filtering changed the loaded race");

  const sorted = sortPinnedRows(rows, new Set(["sable-reach"]));
  assert.deepEqual(sorted.map((row) => row.id), ["sable-reach", "long-beach", "kestrel-sound"]);
});

test("a resized boundary clamps to pane and viewer limits", () => {
  assert.equal(
    clampPaneWidth({
      pane: "rail",
      requested: 999,
      workspaceWidth: 1176,
      otherWidth: 340,
    }),
    252,
  );
  assert.equal(
    clampPaneWidth({
      pane: "analyst",
      requested: 10,
      workspaceWidth: 1568,
      otherWidth: 280,
    }),
    320,
  );
});

test("every race carries three suggested questions written for its own fleet", () => {
  for (const meta of RACES) {
    const race = generateRace(meta.seed);
    assert.equal(meta.suggestedQuestions.length, 3, `${meta.id} does not offer three questions`);
    for (const question of meta.suggestedQuestions) {
      assert.ok(question.trim().length > 0, `${meta.id} has an empty question`);
      assert.doesNotMatch(question, /[.—–]/, `${meta.id} question breaks the copy rules: ${question}`);
      /* Any sail number in a question has to belong to this race's fleet. */
      for (const sail of question.match(/[A-Z]{3} \d+/g) ?? []) {
        assert.ok(
          race.boats.some((boat) => boat.sail === sail),
          `${meta.id} asks about ${sail}, which is not in its fleet`,
        );
      }
    }
    assert.equal(
      new Set(meta.suggestedQuestions).size,
      3,
      `${meta.id} repeats a suggested question`,
    );

    /* The second question is the one the mock answers from the lead change, so
     * the boat it names has to be the boat that actually went through last. */
    const named = meta.suggestedQuestions[1].match(/[A-Z]{3} \d+/g) ?? [];
    if (named.length > 0) {
      const segments = leaderSegments(race);
      assert.equal(
        named[0],
        segments[segments.length - 1].sail,
        `${meta.id} credits the lead to a boat that did not take it last`,
      );
    }
  }
});

test("the story page's three questions are the shipped race's three", () => {
  assert.deepEqual([...RACES[0].suggestedQuestions], [...SUGGESTED_QUESTIONS]);
});

/* ------------------------------------------------------------------ */
/* The reading both engines have to agree on                           */

/* The replay simulates in the browser while the analyst and the finish table
 * simulate on the server, and Math.sin, exp, log and atan2 are implementation
 * defined, so the same seed can put a different boat fourth in Node and in
 * Chromium. Seed 20281016 did: 0.95 s apart on FRA 12, with the two finish
 * clocks a second apart on one page.
 *
 * `node scripts/layline-cross-engine-audit.mjs` is the gate a seed passes
 * before it joins the registry, and it needs a browser, so it does not run
 * here. What runs here is the reading it agreed on, pinned so that changing a
 * seed fails this test and sends whoever changed it back through the audit. */
const FINISH_CLOCKS: Record<string, string[]> = {
  "long-beach": ["JPN 18 0:50", "FRA 12 0:53", "NZL 7 0:54", "GBR 21 0:56", "USA 4 0:57", "AUS 33 0:58"],
  "kestrel-sound": ["GBR 21 0:47", "FRA 12 0:51", "NZL 7 0:53", "AUS 33 0:54", "JPN 18 0:56", "USA 4 0:56"],
  "sable-reach": ["NZL 7 0:50", "GBR 21 0:53", "FRA 12 0:53", "AUS 33 0:54", "USA 4 0:55", "JPN 18 0:56"],
};

test("every race finishes in the order the cross engine audit cleared", () => {
  for (const meta of RACES) {
    const race = generateRace(meta.seed);
    const byRank = [...race.results].sort((a, b) => a.rank - b.rank);
    assert.deepEqual(
      byRank.map((result) => `${sailOf(race, result.boatId)} ${clock(result.elapsed)}`),
      FINISH_CLOCKS[meta.id],
      `${meta.id} finish order or clock moved, so rerun scripts/layline-cross-engine-audit.mjs`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Lead changes, the input mockLeadChange has to agree with            */

const LEAD_CHANGES: Record<string, { changes: number; sail: string; t: number; leg: LegName }> = {
  "long-beach": { changes: 4, sail: "JPN 18", t: 20, leg: "beat" },
  "kestrel-sound": { changes: 4, sail: "GBR 21", t: 9, leg: "beat" },
  "sable-reach": { changes: 6, sail: "NZL 7", t: 34.5, leg: "run" },
};

test("each race's leader timeline holds its pinned changes and decisive pass", () => {
  for (const meta of RACES) {
    const expected = LEAD_CHANGES[meta.id];
    assert.ok(expected !== undefined, `no pinned leader timeline for ${meta.id}`);
    const segments = leaderSegments(generateRace(meta.seed));
    assert.equal(segments.length - 1, expected.changes, `${meta.id} lead change count moved`);
    const decisive = segments[segments.length - 1];
    assert.equal(decisive.sail, expected.sail, `${meta.id} decisive leader moved`);
    assert.equal(decisive.from, expected.t, `${meta.id} decisive pass time moved`);
    assert.equal(decisive.leg, expected.leg, `${meta.id} decisive pass leg moved`);
    /* The initial leader is not a change, and a segment can be one sample: the
     * count includes sub second flickers on purpose, which is why the decisive
     * pass is read off the last segment rather than the first change. */
    assert.ok(segments.length >= 1);
  }
});

test("kestrel sound keeps its decisive beat pass", () => {
  const segments = leaderSegments(generateRace(raceMeta("kestrel-sound")!.seed));
  const decisive = segments[segments.length - 1];
  assert.equal(decisive.sail, "GBR 21");
  assert.equal(decisive.from, 9);
  assert.equal(decisive.leg, "beat");
});

/* ------------------------------------------------------------------ */
/* The analyst route's race binding                                    */

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/layline/analyst", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

async function answerOf(res: Response): Promise<string> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.includes('"text"'))
    .map((line) => (JSON.parse(line.slice(6)) as { text: string }).text)
    .join("");
}

test("the route refuses a raceId outside the registry", async () => {
  process.env.LAYLINE_ANALYST_MOCK = "1";
  for (const bad of ["no-such-race", "", String(RACE_SEED), "long-beach "]) {
    const res = await post({ messages: [{ role: "user", content: "Who won the start" }], raceId: bad });
    assert.equal(res.status, 400, `raceId ${JSON.stringify(bad)} was not refused`);
    assert.equal((await res.json()).error, "no such race");
  }
});

test("the route refuses a raceId that is not a string", async () => {
  process.env.LAYLINE_ANALYST_MOCK = "1";
  for (const bad of [RACE_SEED, null, { id: "long-beach" }, ["long-beach"]]) {
    const res = await post({ messages: [{ role: "user", content: "Who won the start" }], raceId: bad });
    assert.equal(res.status, 400, `raceId ${JSON.stringify(bad)} was not refused`);
    assert.equal((await res.json()).error, "raceId must be a string");
  }
});

test("a request with no raceId still answers about the shipped race", async () => {
  process.env.LAYLINE_ANALYST_MOCK = "1";
  const res = await post({
    messages: [{ role: "user", content: `${RACES[0].suggestedQuestions[1]} with the decisive evidence` }],
  });
  assert.equal(res.status, 200);
  const answer = await answerOf(res);
  assert.match(answer, /JPN 18/);
  assert.ok(
    parseChips(answer).some((segment) => segment.kind === "chip" && segment.t === 20),
    `expected the shipped race's decisive pass at 0:20 in: ${answer}`,
  );
});

test("the route accepts every registry id and answers about that race", async () => {
  process.env.LAYLINE_ANALYST_MOCK = "1";
  for (const meta of RACES) {
    const expected = LEAD_CHANGES[meta.id];
    const res = await post({
      messages: [{ role: "user", content: meta.suggestedQuestions[1] }],
      raceId: meta.id,
    });
    assert.equal(res.status, 200, `${meta.id} was refused`);
    assert.ok(res.headers.get("content-type")?.startsWith("text/event-stream"));

    const answer = await answerOf(res);
    /* The generalized mockLeadChange has to land on the same pass the audit
     * found, at the same second, rather than the shipped race's t=20 and t=30. */
    assert.match(answer, new RegExp(expected.sail), `${meta.id} answer never names ${expected.sail}: ${answer}`);
    assert.ok(
      parseChips(answer).some(
        (segment) => segment.kind === "chip" && segment.t === expected.t,
      ),
      `${meta.id} answer has no chip at the decisive pass ${expected.t}: ${answer}`,
    );
    /* Sable Reach is the one race decided downwind, and the answer has to say
     * so rather than narrate a pass on the beat. */
    if (expected.leg === "run") {
      assert.match(answer, /downwind/, `${meta.id} narrates a beat pass for a run pass: ${answer}`);
    }
  }
});

test("the start question reads each race's own first crossing", async () => {
  process.env.LAYLINE_ANALYST_MOCK = "1";
  for (const meta of RACES) {
    const res = await post({
      messages: [{ role: "user", content: meta.suggestedQuestions[0] }],
      raceId: meta.id,
    });
    assert.equal(res.status, 200);
    const answer = await answerOf(res);
    const race = generateRace(meta.seed);
    assert.ok(
      race.boats.some((boat) => answer.includes(boat.sail)),
      `${meta.id} start answer names no boat in its fleet: ${answer}`,
    );
    assert.ok(
      parseChips(answer).some((segment) => segment.kind === "chip"),
      `${meta.id} start answer carries no seekable moment: ${answer}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The client store's race swap                                        */

test("selectRace swaps the race and resets everything that belongs to it", () => {
  const store = useReplay.getState();
  assert.equal(store.raceId, DEFAULT_RACE_ID);
  assert.equal(raceData().seed, RACE_SEED);

  /* Leave the console mid-race, following another boat, on another camera, in
   * chart mode, playing. */
  store.seek(40);
  store.follow("usa");
  store.setRig("chase");
  store.setChart2d(true);
  useReplay.setState({ playing: true });

  useReplay.getState().selectRace("kestrel-sound");
  const after = useReplay.getState();
  assert.equal(after.raceId, "kestrel-sound");
  assert.equal(raceData().seed, 20281113, "raceData still returns the old race");
  assert.equal(after.t, OPEN_AT, "the clock did not go back to the opening moment");
  assert.equal(after.playing, false, "playback carried over the swap");
  assert.equal(after.followId, "nzl", "the followed boat carried over the swap");
  assert.equal(after.rig, "tv", "the camera rig carried over the swap");
  assert.equal(after.chart2d, false, "chart mode carried over the swap");

  /* The viewer remounts on raceId, so the clock clamps read the new race. */
  useReplay.getState().seek(1e9);
  assert.equal(useReplay.getState().t, raceData().tMax);

  useReplay.getState().selectRace(DEFAULT_RACE_ID);
  assert.equal(raceData().seed, RACE_SEED);
  assert.equal(useReplay.getState().raceId, DEFAULT_RACE_ID);
});

test("selectRace ignores an id that never shipped", () => {
  useReplay.getState().selectRace(DEFAULT_RACE_ID);
  useReplay.getState().seek(30);
  useReplay.getState().selectRace("no-such-race");
  assert.equal(useReplay.getState().raceId, DEFAULT_RACE_ID);
  assert.equal(useReplay.getState().t, 30, "a refused race still reset the clock");
  assert.equal(raceData().seed, RACE_SEED);
});

test("selecting the loaded race again changes nothing", () => {
  useReplay.getState().selectRace(DEFAULT_RACE_ID);
  useReplay.getState().seek(12);
  useReplay.getState().selectRace(DEFAULT_RACE_ID);
  assert.equal(useReplay.getState().t, 12);
});

test("each registry race is built once and handed back on every later read", () => {
  for (const meta of RACES) {
    useReplay.getState().selectRace(meta.id);
    const first = raceData();
    assert.equal(first.seed, meta.seed);
    assert.equal(raceData(), first, `${meta.id} is rebuilt on every read`);
  }
  useReplay.getState().selectRace(DEFAULT_RACE_ID);
});

test("the server and the client build the same race for an id", async () => {
  const { raceFor } = await import("../src/lib/layline/analyst/data");
  for (const meta of RACES) {
    useReplay.getState().selectRace(meta.id);
    assert.equal(JSON.stringify(raceFor(meta.id)), JSON.stringify(raceData()), `${meta.id} differs`);
  }
  assert.equal(raceFor("no-such-race"), null);
  useReplay.getState().selectRace(DEFAULT_RACE_ID);
});

/* ------------------------------------------------------------------ */
/* The story page stays on the shipped race                            */

/* The loaded race is module state, and the client router keeps a module across
 * a navigation between the two pages. A visitor who selects a race in the
 * library and then follows the "Race story" link would land on a page whose
 * copy, chart and finish table are the shipped race's, running somebody
 * else's telemetry, unless the story page points the store back itself. */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("the story page's binding puts the shipped race back after a library visit", () => {
  useReplay.getState().selectRace("kestrel-sound");
  useReplay.getState().seek(40);
  assert.equal(raceData().seed, 20281113);

  /* Step one, in the story page's first render: every read while that render
   * runs, the intro's drawing and the viewer's among them, is already the
   * shipped race. */
  pointAtRace(DEFAULT_RACE_ID);
  assert.equal(raceData().seed, RACE_SEED, "the story page rendered the library's race");

  /* Step two, in the effect after it. */
  useReplay.getState().selectRace(DEFAULT_RACE_ID);
  assert.equal(useReplay.getState().raceId, DEFAULT_RACE_ID);
  assert.equal(raceData().seed, RACE_SEED);
  assert.equal(useReplay.getState().t, OPEN_AT, "the library's clock carried over");
});

test("pointing at a race that never shipped leaves the loaded one alone", () => {
  useReplay.getState().selectRace("sable-reach");
  pointAtRace("no-such-race");
  assert.equal(raceData().seed, 20281024);
  useReplay.getState().selectRace(DEFAULT_RACE_ID);
});

test("the story page runs that binding before anything that reads the race", () => {
  const binder = source("src/app/BindShippedRace.tsx");
  assert.ok(
    binder.includes("pointAtRace(DEFAULT_RACE_ID)"),
    "the binder does not point the module at the shipped race",
  );
  assert.ok(
    binder.includes("selectRace(DEFAULT_RACE_ID)"),
    "the binder does not bring the store to the shipped race",
  );

  /* Render order is the whole of it: every reader below memoises the race on
   * its first render, so a binding placed after one of them is too late. */
  const page = source("src/app/page.tsx");
  const bound = page.indexOf("<BindShippedRace />");
  assert.ok(bound > 0, "the story page does not render the binding");
  for (const reader of ["<PageGround", "<IntroOverlay", "<LaylineApp", "<AnalystSection"]) {
    assert.ok(page.indexOf(reader) > bound, `${reader} renders before the race is bound`);
  }
});

test("the story page's analyst asks about the shipped race, not the store's", () => {
  const section = source("src/components/layline/analyst/AnalystSection.tsx");
  assert.ok(
    section.includes("rail ? useReplay.getState().raceId : DEFAULT_RACE_ID"),
    "the story variant posts whichever race the store holds",
  );
});

test("the library starts playback on its own mount, never on the story's intro latch", () => {
  const workspace = source("src/app/races/RaceWorkspace.tsx");
  assert.ok(
    workspace.includes('autoplay="immediate"'),
    "the library viewer waits on something other than its own mount",
  );

  const app = source("src/components/layline/LaylineApp.tsx");
  /* Immediate autoplay never waits on introDone, the latch that survives a
     navigation: it waits on the brief in front of it, or on nothing. */
  assert.ok(
    app.includes('autoplay === "immediate" ? (briefed ? "brief" : null) : "intro"'),
    "immediate autoplay no longer picks its own gate",
  );
  assert.ok(
    app.includes('if (gate === "brief" && replay.briefDone)'),
    "the briefed library no longer starts on the brief's release",
  );
  assert.ok(
    app.includes("if (autoplay === false) return;"),
    "the viewer lost its way to opt out of autoplay entirely",
  );
  /* Reduced motion outranks all three modes: it returns before any of them can
     seek to the prestart and play. */
  const reduced = app.indexOf("if (reduced) {");
  const starts = app.indexOf("if (autoplay === false) return;");
  assert.ok(reduced > 0 && starts > reduced, "an autoplay mode is read before reduced motion is");
});


/* ------------------------------------------------------------------ */
/* The boot cover's race brief                                         */

test("the library covers the renderer's boot with the sea, the story page with its intro", () => {
  const workspace = source("src/app/races/RaceWorkspace.tsx");
  assert.ok(
    workspace.includes('boot="sea"'),
    "the library stopped covering the renderer's boot",
  );

  const app = source("src/components/layline/LaylineApp.tsx");
  assert.ok(app.includes('boot = "intro"'), "the story page lost its default boot cover");
  assert.ok(app.includes("data-boot={boot}"), "the stage no longer states which cover to draw");
  /* The cover has to outlive the first rendered frame, else the two fades leave
     a gap with neither picture in it. */
  assert.ok(
    app.includes('setCover("gone"), 1100'),
    "the sea cover unmounts before its own fade has finished",
  );

  const css = source("src/app/layline.module.css");
  assert.ok(
    css.includes('.stage[data-boot="sea"] .canvasLayer'),
    "the scene fades instead of the cover",
  );
  assert.ok(css.includes('.stage[data-boot="sea"] .dockLeft'), "the docks still pop in");
  /* The chart is the no-WebGL answer, so it must still arrive on its own when
     no renderer ever does. */
  assert.match(
    css,
    /\.stage\[data-boot="sea"\] \.fallbackLayer \{\s*visibility: hidden;\s*animation: fallbackReveal 0s linear 2\.4s forwards;/,
  );

  /* The cover is a picture of the sea, in its own module so it is free to be
     tuned without arguing with the console's stylesheet. What matters to the
     dissolve is that it paints a sky and a water, and that only its own
     opacity moves. */
  const cover = source("src/components/layline/bootSea.module.css");
  assert.match(cover, /linear-gradient/);
  assert.ok(cover.includes("container-type: inline-size"), "the brief stopped sizing to the pane");
  assert.match(cover, /transition:\s*opacity 900ms/);
  assert.match(cover, /\.out \{\s*opacity: 0;/);
});

test("the sea cover briefs the race it is loading", () => {
  const workspace = source("src/app/races/RaceWorkspace.tsx");
  /* What the registry knows and a simulation cannot: the name, the venue and
     the date. Everything else on the brief is read off the RaceData. */
  assert.ok(
    workspace.includes("{ name: meta.name, venue: meta.venue, dateLabel: meta.dateLabel }"),
    "the cover stopped briefing the race the rail names",
  );

  /* The shell and its two views. Which of the three a rule lands in is a
     question of who owns the drawing; the house rules apply to the layer. */
  const shell = source("src/components/layline/RaceBrief.tsx");
  const panels = source("src/components/layline/BriefPanels.tsx");
  const performance = source("src/components/layline/BriefPerformance.tsx");
  const brief = shell + panels + performance;
  const cover = source("src/components/layline/bootSea.module.css");

  /* The title card face. Montserrat at 700 for the race name, sliced out of
     the rule rather than matched loose against the whole file: every weight
     and family in this stylesheet appears somewhere else too, so a bare
     includes() would pass on another rule's copy of the same declaration. */
  const rule = (selector: string): string => {
    const open = cover.indexOf(selector);
    assert.ok(open >= 0, `${selector} left the cover`);
    return cover.slice(open, cover.indexOf("}", open));
  };
  const raceName = rule(".raceName {");
  assert.ok(raceName.includes("var(--brief-title)"), "the race name left the title face");
  assert.ok(raceName.includes("font-weight: 700"), "the race name left the title face's bold");
  assert.ok(raceName.includes("letter-spacing: -0.025em"), "the race name lost its tracking");
  /* Pangram stands behind Montserrat rather than under it: the page still
     preloads that face, which is font-display: block, and a capture harness
     rendering the cover outside the layline shells has to land on a display
     face rather than the browser's default sans. */
  assert.ok(
    cover.includes("--brief-title: var(--font-montserrat), var(--font-pangram), sans-serif;"),
    "the title face lost its fallback to the other display face",
  );
  /* The three section heads over the panels, the layer's other Montserrat.
     They keep the 10px label size and take the weight and tracking the face is
     set at where this borrowed it from. */
  const panelHead = rule(".panelLabelHead {");
  assert.ok(panelHead.includes("var(--brief-display)"), "the panel heads left the borrowed face");
  assert.ok(panelHead.includes("font-weight: 400"), "the panel heads went back to the dock weight");
  assert.ok(panelHead.includes("letter-spacing: 0.15em"), "the panel heads lost their tracking");
  for (const label of ["Fleet at the line", "Wind, live off the seed", "Start line"]) {
    assert.ok(panels.includes(label), `the start view stopped heading a panel "${label}"`);
  }
  assert.ok(
    (panels.match(/styles\.panelLabelHead/g) ?? []).length === 3,
    "the start view's section heads are no longer exactly three",
  );
  /* The performance view heads a table of mono numbers and has to carry weight
     against it, so its labels stay on the Archivo rule. */
  assert.ok(
    !performance.includes("panelLabelHead"),
    "the performance view's labels took the start view's face",
  );
  /* The console divides its three faces by job, and says why: "a number set in
     Archivo is a number nobody measured, and a button set in mono is a lie
     about where the data is". So Martian is quarantined to measured values,
     Archivo carries the labels and the button, and every numeral is tabular so
     a countdown never reflows the row it sits in. */
  assert.ok(cover.includes("var(--font-martian), monospace"), "the brief left the console's mono");
  assert.ok(cover.includes("var(--font-archivo), sans-serif"), "the brief left the console's sans");
  const goBtn = cover.slice(cover.indexOf(".goBtn {"), cover.indexOf(".goArrow {"));
  assert.ok(goBtn.includes("var(--brief-sans)"), "the way through went back to mono");
  assert.ok(!goBtn.includes("var(--brief-mono)"), "the way through went back to mono");
  for (const measured of [
    ".readValue {",
    ".fleetRow {",
    ".panelCount {",
    ".favored {",
    ".polarTick {",
    ".perfMethodBody {",
  ]) {
    const block = cover.slice(cover.indexOf(measured));
    assert.ok(
      block.slice(0, block.indexOf("}")).includes("var(--brief-mono)"),
      `${measured} stopped setting its figures in the measured face`,
    );
  }
  assert.ok(
    cover.includes("font-variant-numeric: tabular-nums"),
    "the brief's numerals stopped being tabular",
  );
  /* The console's standing bans. A 1px dim rule does what a shadow would. */
  assert.ok(!cover.includes("box-shadow"), "a drop shadow arrived on the cover");
  /* Exactly one accent, stated once and reaching exactly three things, all of
     them the favored end: the mark over it, the seconds it is worth, and the
     fill on the status hairline. Anything else on this layer taking it makes
     the mark stop meaning anything. The focus ring is not one of them: the
     console rings its own focusable things and this layer does not offer a
     second opinion. */
  assert.ok(
    cover.includes("--brief-accent: var(--wind);"),
    "the accent left the console's own wind token for a hex of this layer's own",
  );
  assert.equal((cover.match(/#ffd166/g) ?? []).length, 0, "the invented accent hex came back");
  /* Seven users, and every one of them is the wind or what the wind decides:
     the arrow lying across the start-line diagram and its head; the mark over
     the end the line favors and the seconds that end is worth; and the dial's
     needle, its head and the survey band behind it. The status hairline is a
     wait, not weather, and does not take it. Neither does a boat, a rule, a
     label or the view switch.

     All seven are on the start. Nothing on the performance view is weather: a
     boat's speed against its polar and its VMG toward a mark are the boat, so
     the target curve, the six clouds, the six traces and every rule under them
     are drawn in ink and hue instead. */
  const accentUsers = [
    ".windStroke",
    ".windFill",
    ".favMark",
    ".favSec",
    ".dialBand",
    ".dialNeedle",
    ".dialHead",
  ];
  assert.equal(
    (cover.match(/var\(--brief-accent\)/g) ?? []).length,
    accentUsers.length,
    "something that is not the wind took the wind's colour",
  );
  for (const rule of accentUsers) {
    assert.ok(cover.includes(rule), `${rule} left the cover, so the accent's users moved`);
  }
  const statusFill = cover.slice(cover.indexOf(".statusFill {"));
  assert.ok(
    !statusFill.slice(0, statusFill.indexOf("}")).includes("--brief-accent"),
    "the status hairline went back to borrowing the wind's colour",
  );

  /* Nothing on this layer is rounded. The console's registration box states
     border-radius: 0 on whatever it rings (layline.module.css), so a rounded
     control here was a control that changed shape the moment it took focus,
     which is the class of pop the boot cover exists to prevent. */
  const coverRules = cover.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!coverRules.includes("border-radius"), "a rounded corner came back to the cover");
  assert.ok(!brief.includes('rx="'), "a rounded corner came back to the brief's drawings");

  /* The race name owns its own line. Sharing the header row with the meta line
     left its width budget swinging with the viewport, so no stated size fit
     every case and the measured fit had to correct the server's guess after
     hydration, in full view. */
  /* Matched line by line rather than across the break: this repo checks out
     CRLF, so a pattern pinning a bare newline against source text fails on a
     fresh clone while passing here. */
  const head = cover.slice(cover.indexOf(".briefHead {"), cover.indexOf(".raceName {"));
  assert.ok(head.includes("flex-direction: column;"), "the race name shares its row again");
  assert.ok(head.includes("align-items: flex-start;"), "the header stopped ranging its two lines left");
  assert.ok(!head.includes("align-items: baseline;"), "the header went back to a baseline row");

  /* The title card no longer names the race in Pangram, but the page still
     preloads it: the Debrief's heading is set in it, the face is
     font-display: block, and a pane that opens on a blocked face holds
     unpainted in front of the reader. Montserrat needs no line here, next/font
     preloads what it self-hosts. */
  const racesPage = source("src/app/races/page.tsx");
  assert.ok(
    racesPage.includes('href="/assets/fonts/pangram-display.woff2"'),
    "the library stopped preloading the blocking face its Debrief is set in",
  );
  assert.ok(
    racesPage.includes("montserrat.variable"),
    "the library stopped putting the brief's face on its shell",
  );

  /* The name is capped at two line boxes by measurement, because what overflows
     is the number of words and container units cannot see that. */
  assert.ok(
    brief.includes("node.scrollHeight <= Math.ceil(2 * size * 1.02) + 2"),
    "the two-line cap left",
  );
  assert.ok(brief.includes("size > 9"), "the fit lost its floor");

  /* The motion switch a test can drive, and the state the cover publishes. */
  assert.ok(brief.includes("if (reduced) {"), "the brief lost its static path");
  const app = source("src/components/layline/LaylineApp.tsx");
  assert.ok(
    app.includes('data-brief-motion={briefed ? (reducedMotion ? "off" : "on") : undefined}'),
    "the cover stopped stating whether the brief is moving",
  );
  /* The capture hold stops this layer's entrance as well as the replay clock.
     Two screenshots of the same stated race time a tenth of a second apart
     otherwise catch the plates at two points of one 420ms fade, which is what
     check 1 of .tmp/verify.mjs measures. */
  assert.ok(
    app.includes('data-brief-still={briefed && frozen ? "" : undefined}'),
    "the cover stopped publishing the capture hold",
  );
  assert.match(cover, /\[data-brief-still\] \.panel,\s*\[data-brief-still\] \.briefFoot \{\s*animation: none;/);
  /* The renderer status line left the footer at the owner's direction. It was
     the one part of this layer driven by wall time rather than by the replay
     clock, so its whole apparatus (sentence, crossfade, hairline) must stay
     gone rather than come back as a new capture-hold hazard. */
  assert.ok(
    !cover.includes(".statusFill") && !cover.includes(".statusBar") && !cover.includes(".statusStack"),
    "the wall-time status apparatus came back to the footer",
  );

  /* Hairlines stay hairlines through the stretch, which is what
     non-scaling-stroke is for and what the console's own VMG strip already
     states on every stroke it draws.

     The layer could not always use it. While the cover drew the fleet's
     approach tracks, a dash was the reveal: how far a boat had sailed was one
     prefix of its own path, cut out of stroke-dasharray. Chrome reads that
     dasharray in device pixels the moment the stroke is non-scaling, so the
     reveal repeated down the track instead of drawing a prefix of it, and the
     drawing scaled its widths by a measured metres-per-pixel instead. Nothing
     on the cover reveals a path with a dash now, so the workaround left with
     the drawing that needed it. */
  assert.ok(
    !cover.includes("--plot-px"),
    "the metres-per-pixel scale factor came back without a drawing that needs it",
  );
  for (const stretched of [".polarGrid", ".polarTarget", ".vmgRule", ".vmgTrace"]) {
    const block = cover.slice(cover.indexOf(stretched + " {"));
    assert.ok(
      block.slice(0, block.indexOf("}")).includes("vector-effect: non-scaling-stroke"),
      `${stretched} thickens with the plate it is drawn on`,
    );
  }

  /* Briefed, the cover carries the only control on the layer, so it cannot be
     hidden from a screen reader the way the bare sea was. */
  assert.ok(
    app.includes('aria-hidden={briefed ? undefined : "true"}'),
    "the briefed cover is hidden from a screen reader",
  );
});

test("the brief reads its fleet, its line and its first crossing off the race", () => {
  for (const meta of RACES) {
    const race = generateRace(meta.seed);
    const facts = briefFacts(race);

    /* The line comes from the course endpoints, never from a literal. */
    assert.equal(
      facts.lineLength,
      Math.hypot(
        race.course.startBoat.x - race.course.startPin.x,
        race.course.startBoat.y - race.course.startPin.y,
      ),
      `${meta.id} line length stopped coming off the course`,
    );
    assert.equal(facts.lineHalf, facts.lineLength / 2);
    assert.equal(facts.tMin, race.tMin);

    /* One row per boat, in the order the rail and the docks use, and each
       hull's place on the line is its own fix nearest the gun. */
    assert.deepEqual(
      facts.boats.map((boat) => boat.id),
      race.boats.map((boat) => boat.id),
      `${meta.id} fleet order left race.boats order`,
    );
    for (const boat of facts.boats) {
      const fixes = race.fixes[boat.id];
      const nearest = fixes.reduce((best, fix) => (Math.abs(fix.t) < Math.abs(best.t) ? fix : best));
      assert.equal(boat.gunX, nearest.x, `${meta.id} ${boat.sail} is not at its own gun fix`);
      assert.ok(
        Math.abs(boat.gunX) <= facts.lineHalf + 6,
        `${meta.id} ${boat.sail} sits off the end of its own line`,
      );
    }

    /* The fleet's tacking half-angle, measured off the beat rather than
       repeated from sim.ts. */
    assert.ok(
      facts.beatTwa >= BEAT_TWA_MIN_DEG && facts.beatTwa <= BEAT_TWA_MAX_DEG,
      `${meta.id} beat angle ${facts.beatTwa.toFixed(1)} outside the audited band`,
    );

    /* The first hull to the line after the gun, and the same one the analyst's
       start report names: two surfaces, one crossing. */
    const report = startReport(race);
    const leader = report.rows[0];
    const first = facts.first;
    assert.ok(first !== null, `${meta.id} has no first crossing`);
    assert.equal(first.sail, leader.sail, `${meta.id} brief and analyst name different hulls`);
    assert.ok(
      Math.abs(first.t - (leader.crossedAfterGunSeconds ?? Number.NaN)) < 0.005,
      `${meta.id} brief and analyst disagree on when ${leader.sail} crossed`,
    );
    assert.ok(first.t > 0, `${meta.id} first crossing is not after the gun`);
  }
});

test("the brief's wind is the replay's wind, and the favored end is the one nearer the breeze", () => {
  const race = generateRace(RACE_SEED);
  const facts = briefFacts(race);
  const read = windReading();
  const sample = { t: 0, twd: 0, tws: 0 };

  let sawPin = false;
  let sawBoat = false;

  for (let step = 0; step <= 40; step += 1) {
    const t = race.tMin + (step / 40) * (0 - race.tMin);
    windReadingAt(race, facts, t, read);
    windAt(race, t, sample);

    /* Same series, same interpolation: the dial can only differ from the
       instrument dock by being asked about a different instant. */
    const signedTwd = ((((sample.twd % 360) + 360) % 360) + 180) % 360 - 180;
    assert.ok(
      Math.abs(read.twd - signedTwd) < 1e-9,
      `the brief's twd left windAt at t=${t.toFixed(2)}`,
    );
    assert.equal(read.tws, sample.tws, `the brief's tws left windAt at t=${t.toFixed(2)}`);

    /* Bias in seconds: the line's length across the wind over the speed the
       fleet makes at its own beat angle, off the sim's own polar. */
    const beatSpeed = (polarFraction(FICTIONAL_ONE_DESIGN_POLAR, facts.beatTwa) ?? 0) * read.tws;
    const expected = (facts.lineLength * Math.sin(Math.abs(read.twd) * (Math.PI / 180))) / beatSpeed;
    assert.ok(
      Math.abs(read.biasSeconds - expected) < 1e-9,
      `the bias formula moved at t=${t.toFixed(2)}`,
    );
    assert.ok(read.biasSeconds >= 0, "a favored end can never be worth negative time");

    /* Favored is the end sitting closer to the wind, which is the shorter road
       up the beat (knowledge.ts, start-bias). Course angles grow clockwise
       from +y, so upwind is (sin twd, cos twd) and the projection settles it.
       The pin is the port end at -x, the committee boat the starboard end. */
    const upwindX = Math.sin(read.twd * (Math.PI / 180));
    const pinGain = race.course.startPin.x * upwindX;
    const boatGain = race.course.startBoat.x * upwindX;
    if (read.favored === "pin") {
      sawPin = true;
      assert.ok(pinGain > boatGain, `pin called favored while it sits downwind at t=${t.toFixed(2)}`);
      assert.ok(read.twd < 0, "the pin is favored by a wind off the port side of the course");
    } else if (read.favored === "boat") {
      sawBoat = true;
      assert.ok(
        boatGain > pinGain,
        `committee boat called favored while it sits downwind at t=${t.toFixed(2)}`,
      );
      assert.ok(read.twd > 0, "the committee boat is favored by a wind off the starboard side");
    } else {
      assert.ok(Math.abs(read.twd) <= 0.05, "a square line has to actually be square");
    }
  }

  /* The shipped prestart swings through the axis, so both ends come up: a
     brief that only ever named one end would pass the checks above while
     saying nothing. */
  assert.ok(sawPin && sawBoat, "the shipped prestart no longer shows both ends favored");

  /* It also passes through square, which is why the sentence has to be able to
     stop at the end rather than trailing a "by" with nothing after it. Two of
     the three seeds reach it; sable-reach never does. */
  let squares = 0;
  for (let step = 0; step <= 4000; step += 1) {
    const t = race.tMin + (step / 4000) * (0 - race.tMin);
    windReadingAt(race, facts, t, read);
    if (read.favored === "square") squares += 1;
  }
  assert.ok(squares > 0, "the shipped prestart no longer passes through a square line");
  /* The start carries the sentence, so it has to be able to close it. */
  const start = source("src/components/layline/BriefPanels.tsx");
  assert.ok(
    start.includes('display: seed.favored === "square" ? "none" : undefined'),
    "the start leaves the favored sentence open on a dangling by",
  );
  assert.ok(
    start.includes('const by = read.favored === "square" ? "none" : "";'),
    "the start's live paint stopped closing the favored sentence on a square line",
  );
});

test("the brief's performance view measures the fleet against the engine's own polar", () => {
  for (const meta of RACES) {
    const race = generateRace(meta.seed);
    const review = polarReview(race);
    const sample = { t: 0, twd: 0, tws: 0 };
    const pose = createPose();

    /* One row per boat, in race.boats order, so the table and the drawing
       beside it are the same six things in the same order. */
    assert.deepEqual(
      review.boats.map((boat) => boat.boatId),
      race.boats.map((boat) => boat.id),
      `${meta.id} lost a boat off the review`,
    );

    /* The breeze the plot is normalized to is the feed's own mean, and the
       range it ran is the feed's own range. A drawing that picked its own
       reference could put a boat past its target on a lull. */
    let sum = 0;
    for (const wind of race.wind) sum += wind.tws;
    assert.ok(
      Math.abs(review.meanTws - sum / race.wind.length) < 1e-9,
      `${meta.id} left the feed's own mean breeze`,
    );
    assert.ok(review.twsMin <= review.meanTws && review.meanTws <= review.twsMax);
    assert.ok(review.twsMax - review.twsMin > 0.5, `${meta.id} stopped shifting gears`);

    let turns = 0;
    for (const boat of review.boats) {
      /* Racing turns only, and the filter is half the assertion: `maneuversOf`
         reports every wind-angle flip in the feed, which is right for a
         timeline marker and wrong for this row. A count taken straight off it
         reads a boat that gybed after finishing as having made one more racing
         turn than it did. */
      const moves = maneuversOf(race, boat.boatId).filter((move) => {
        const leg = legAt(race, boat.boatId, move.t);
        return leg === "beat" || leg === "run";
      });
      turns += moves.length;
      assert.equal(boat.tacks + boat.gybes, moves.length, `${meta.id} miscounted racing turns`);
      assert.ok(boat.tacks > 0 && boat.gybes > 0, `${meta.id} ${boat.boatId} never turned`);

      /* The per-turn cost is the mean of the detector's own drawdowns, taken
         in m/s rather than off the formatted knots: averaging the strings
         would round every turn to a tenth of a knot and then average the
         rounding. */
      let loss = 0;
      for (const move of moves) {
        if (move.loss === null) assert.fail("normal seeded maneuver loss became unavailable");
        loss += move.loss;
        assert.equal(move.lossKnots, knots(move.loss), "the two loss readings parted");
      }
      assert.ok(Math.abs(boat.lossPerTurn - loss / moves.length) < 1e-9);

      /* Every sample the plot draws is a fix the feed published, on a leg,
         clear of a turn, with the fraction it plots being its own speed over
         the polar's at its own wind. */
      assert.ok(boat.samples.length > 60, `${meta.id} ${boat.boatId} has nothing to plot`);
      assert.equal(boat.steady, boat.samples.length);
      let beatSum = 0;
      let beatN = 0;
      let runSum = 0;
      let runN = 0;
      for (const point of boat.samples) {
        const leg = legAt(race, boat.boatId, point.t);
        assert.equal(leg, point.leg, `${meta.id} plotted a sample off its own leg`);
        for (const move of moves) {
          assert.ok(
            Math.abs(point.t - move.t) > STEADY_WINDOW,
            `${meta.id} plotted a boat mid-turn at t=${point.t}`,
          );
        }
        poseAt(race, boat.boatId, point.t, "raw", pose);
        windAt(race, point.t, sample);
        assert.ok(Math.abs(point.twa - pose.twa) < 1e-6, "the plot left the published wind angle");
        assert.ok(Math.abs(point.heel - pose.heel) < 1e-6, "the plot left the published heel");
        const target = targetSpeed(Math.abs(point.twa), sample.tws);
        assert.ok(Math.abs(point.fraction - pose.stw / target) < 1e-9);
        /* Normalizing to the mean breeze must leave the ratio alone: the dot's
           distance past the curve drawn at that breeze is the fraction, which
           is the only reason one curve can stand for a shifting wind. */
        assert.ok(
          Math.abs(point.speed / targetSpeed(Math.abs(point.twa), review.meanTws) - point.fraction) <
            1e-9,
          "the normalized speed stopped agreeing with the fraction",
        );
        if (point.leg === "beat") {
          beatSum += point.fraction;
          beatN += 1;
        } else {
          runSum += point.fraction;
          runN += 1;
        }
      }
      assert.ok(Math.abs(boat.beatFraction - beatSum / beatN) < 1e-9);
      assert.ok(Math.abs(boat.runFraction - runSum / runN) < 1e-9);

      /* The window is what makes the figure readable at all. Without it a boat
         swinging through head to wind divides by a target of nearly nothing:
         on the shipped race the fleet's mean beat performance came out between
         257 and 864 per cent. Held to steady sailing it lands where a fleet
         race actually lands. */
      for (const held of [boat.beatFraction, boat.runFraction]) {
        assert.ok(held > 0.8 && held < 1.05, `${meta.id} ${boat.boatId} read ${held} of target`);
      }
    }
    assert.equal(review.fleet.turns, turns, `${meta.id} lost a turn out of the total`);
    assert.equal(
      review.fleet.steady,
      review.boats.reduce((count, boat) => count + boat.steady, 0),
    );

    /* The fleet row is a median, so it is one of the six or the midpoint of the
       middle two, and never outside them. */
    for (const [held, column] of [
      [review.fleet.beatFraction, review.boats.map((boat) => boat.beatFraction)],
      [review.fleet.runFraction, review.boats.map((boat) => boat.runFraction)],
      [review.fleet.beatVmg, review.boats.map((boat) => boat.beatVmg)],
      [review.fleet.runVmg, review.boats.map((boat) => boat.runVmg)],
      [review.fleet.lossPerTurn, review.boats.map((boat) => boat.lossPerTurn)],
    ] as const) {
      assert.ok(held >= Math.min(...column) && held <= Math.max(...column));
    }

    /* Built once and handed back, the way every other series here is. */
    assert.equal(polarReview(race), review, `${meta.id} rebuilt the review`);
  }
});

test("finished boats never contribute a post-finish turn", () => {
  const expectedTurns: Record<string, number> = {
    "long-beach": 22,
    "kestrel-sound": 18,
    "sable-reach": 20,
  };

  for (const meta of RACES) {
    const race = generateRace(meta.seed);
    const review = polarReview(race);
    let racingCount = 0;
    for (const boat of race.boats) {
      const finish = race.results.find((result) => result.boatId === boat.id);
      assert.ok(finish !== undefined, `${meta.id} ${boat.id} has no finish`);
      const moves = maneuversOf(race, boat.id);
      for (const move of moves) {
        const leg = legAt(race, boat.id, move.t);
        assert.ok(leg === "beat" || leg === "run", `${meta.id} ${boat.id} emitted a ${leg} turn`);
        assert.ok(move.t <= finish.elapsed, `${meta.id} ${boat.id} turned at ${move.t} after ${finish.elapsed}`);
      }
      racingCount += moves.length;
      const row = review.boats.find((entry) => entry.boatId === boat.id);
      assert.ok(row !== undefined);
      assert.equal(row.tacks, moves.filter((move) => move.kind === "tack").length);
      assert.equal(row.gybes, moves.filter((move) => move.kind === "gybe").length);
    }
    assert.equal(racingCount, expectedTurns[meta.id], `${meta.id} turn golden moved`);
    assert.equal(review.fleet.turns, racingCount, `${meta.id} review included a non-racing turn`);
  }
});

test("the polar the review measures against is the polar the engine sails", () => {
  const race = generateRace(RACE_SEED);
  const review = polarReview(race);
  for (const twa of [0, 30, 45, 60, 90, 120, 135, 150, 180]) {
    assert.equal(
      targetSpeed(twa, review.meanTws),
      (polarFraction(FICTIONAL_ONE_DESIGN_POLAR, twa) ?? 0) * review.meanTws,
    );
  }
  /* Nothing to sail at head to wind, which is the pinch the drawing labels
     "no-go" and the reason the target curve closes through the middle. */
  assert.equal(targetSpeed(0, review.meanTws), 0);

  /* The drawing's radial ceiling has to clear both the polar's own peak at the
     mean breeze and the fastest normalized sample any shipped race holds, or a
     dot lands outside the frame with nothing saying so. */
  const view = source("src/components/layline/BriefPerformance.tsx");
  const ceiling = Number(/const RMAX_KN = (\d+);/.exec(view)?.[1]);
  assert.ok(Number.isFinite(ceiling), "the polar lost its radial ceiling");
  for (const meta of RACES) {
    const held = polarReview(generateRace(meta.seed));
    let peak = 0;
    for (let twa = 0; twa <= 180; twa += 1) {
      peak = Math.max(peak, targetSpeed(twa, held.meanTws));
    }
    for (const boat of held.boats) {
      for (const point of boat.samples) peak = Math.max(peak, point.speed);
    }
    assert.ok(
      peak * (3600 / 1852) < ceiling,
      `${meta.id} draws ${(peak * (3600 / 1852)).toFixed(1)} kn past a ${ceiling} kn frame`,
    );
  }
});

test("the performance view states what it left out, and takes no accent for it", () => {
  const view = source("src/components/layline/BriefPerformance.tsx");
  const cover = source("src/components/layline/bootSea.module.css");

  /* A performance figure whose exclusions are not on screen is a figure a
     reader cannot check. Both the window and the normalization are printed
     under the drawing they apply to, and the window is the one the code
     actually uses rather than a number retyped into prose. */
  assert.ok(
    view.includes("${STEADY_WINDOW} s either side are left out and counted as turn cost"),
    "the plot stopped saying which seconds it dropped",
  );
  assert.ok(
    view.includes("Speed scaled to the ${meanKn.toFixed(1)} kn race mean"),
    "the plot stopped naming the breeze it normalized to",
  );
  assert.ok(view.includes("Port tack left, starboard right"), "the plot stopped saying which side is which");
  assert.ok(view.includes("dot size is heel"), "the plot stopped naming its third channel");

  /* Amber is the wind and nothing else. Nothing on this view is weather, so
     nothing on it may borrow the accent: not the target curve, not a trace,
     not a rule. */
  const section = cover.slice(
    cover.indexOf("/* ---- the performance view ----"),
    cover.indexOf("/* ---- footer ---- */"),
  );
  assert.ok(section.length > 800, "the performance view lost its stylesheet");
  assert.ok(
    !section.includes("--brief-accent"),
    "the performance view took the wind's colour for something that is not wind",
  );

  /* The strip is the dock's own series rather than a second pass over the same
     fixes, and it is cut to the racing: on the shipped race the feed's own ends
     are 22 per cent of the width with nothing on them. */
  assert.ok(view.includes("vmgSeries(race)"), "the strip stopped reading the dock's series");
  assert.ok(view.includes("stripFrame(vmg)"), "the strip stopped cutting itself to the racing");
});

test("the brief's ledger reads each hull's distance off the line the console's own way", () => {
  for (const meta of RACES) {
    const race = generateRace(meta.seed);
    const facts = briefFacts(race);
    const line = startLineOf(race.course);
    const pose = createPose();
    const out = { distance: 0, closing: 0, toLine: 0, early: false };
    for (const boat of facts.boats) {
      poseAt(race, boat.id, 0, "smooth", pose);
      startReadingAt(line, pose, 0, out);
      assert.equal(
        boat.offLine,
        out.distance,
        `${meta.id} ${boat.sail} off-the-line reading left startReadingAt`,
      );
      /* Nobody is over at the gun on these seeds, and nobody is a boat length
         from a line they spent ten seconds lining up on. */
      assert.ok(
        boat.offLine > 0 && boat.offLine < 8,
        `${meta.id} ${boat.sail} is ${boat.offLine.toFixed(1)} m off its own line`,
      );
    }
  }
});

test("the brief gates the replay, and re-arms with the race", () => {
  pointAtRace(DEFAULT_RACE_ID);
  const store = useReplay;
  store.setState({ raceId: DEFAULT_RACE_ID, briefDone: false, playing: false, t: OPEN_AT });

  assert.equal(store.getState().briefDone, false, "the brief opens already released");
  store.getState().releaseBrief();
  assert.equal(store.getState().briefDone, true, "releasing the brief did not latch");

  /* One way only: a second press of a button already fading out must not
     restart what the first one triggered. */
  store.setState({ playing: true });
  store.getState().releaseBrief();
  assert.equal(store.getState().playing, true, "a second release reset the replay");

  /* A rail selection is a new race, so it is a new brief. */
  store.getState().selectRace(RACES[1].id);
  assert.equal(store.getState().briefDone, false, "the brief did not re-arm with the race");
  assert.equal(store.getState().t, OPEN_AT, "selecting a race left the clock where it was");

  pointAtRace(DEFAULT_RACE_ID);
  store.setState({ raceId: DEFAULT_RACE_ID, briefDone: false, playing: false, t: OPEN_AT });

  /* The brief hands the clock back inside the prestart, which is where the
     library's autoplay expects to find it, and back to the mid-beat moment for
     a viewer who asked for less motion and gets no autoplay at all. */
  const brief = source("src/components/layline/RaceBrief.tsx");
  assert.ok(
    brief.includes("state.seek(state.reducedMotion ? OPEN_AT : AUTOPLAY_FROM)"),
    "the brief stopped handing the clock back where the replay wants it",
  );
  assert.ok(AUTOPLAY_FROM < 0, "the autoplay no longer starts inside the prestart");
  assert.ok(OPEN_AT > 0, "the reduced-motion open moved out of the race");

  /* Enter releases it from the background, except while a viewer is typing or
     when a native control or disclosure owns the key. */
  assert.ok(brief.includes('event.key !== "Enter"'), "Enter stopped releasing the brief");
  assert.ok(
    brief.includes('target.closest("a, button, input, select, summary, textarea")'),
    "Enter now escapes a native control or disclosure and releases the brief",
  );
  assert.ok(brief.includes("isContentEditable"), "Enter fires from a rich text field");
  assert.ok(
    brief.includes("button.current?.focus({ preventScroll: true })"),
    "the brief stopped taking focus when it mounts",
  );
  /* The label is the whole promise of the button. */
  assert.ok(brief.includes("Start the race"), "the way through changed its words");
});

test("a gated console is one screen tall with the Debrief composer in panel flow", () => {
  const app = source("src/components/layline/LaylineApp.tsx");
  /* The gate is the stage's business as well as the cover's: stacked, the
     console is a column of docks about 1300px tall, and a brief held to one
     screen left 500-odd px of empty water under the button. The attribute goes
     up while the brief is unread and comes off the moment it is released, so
     the column is back to full height under a cover that has not faded yet. */
  assert.ok(
    app.includes('data-gate={briefed && !briefDone ? "brief" : undefined}'),
    "the stage stopped saying when it is gated",
  );

  const css = source("src/app/layline.module.css");
  const stacked = css.slice(css.indexOf("@media (max-width: 900px) {"));
  assert.ok(stacked.includes('.stage[data-gate="brief"] {'), "the gated console stopped being capped");
  assert.ok(
    stacked.includes("max-height: 100svh;"),
    "the cap stopped agreeing with the height the brief is held to",
  );
  /* Nothing under the cover may resize while it is up: the canvas states its
     own 48vh here and the docks are pinned to their natural height, so the cap
     clips rather than squeezes and releasing it costs no reflow. */
  assert.ok(stacked.includes('.stage[data-gate="brief"] > * {'), "the docks went back to shrinking under the cap");

  const cover = source("src/components/layline/bootSea.module.css");
  assert.doesNotMatch(cover, /--composer-bar|--brief-foot-gap/);
  assert.ok(cover.includes("max-height: 100svh;"), "the brief stopped using the full small viewport");
  assert.ok(cover.includes("padding: 3cqw 3.2cqw 2.2cqw;"), "the brief lost its desktop padding");
  assert.ok(cover.includes("padding: 16px;"), "the stacked brief lost its padding");
});

test("the brief reads the race in two halves, on one switch", () => {
  const shell = source("src/components/layline/RaceBrief.tsx");
  const panels = source("src/components/layline/BriefPanels.tsx");
  const performance = source("src/components/layline/BriefPerformance.tsx");

  /* The console's transport already carries this gesture: a control that swaps
     what is on screen and changes nothing else. Here it is one layer up, and
     what it swaps is which half of the race is being described. */
  assert.ok(shell.includes('data-brief-switch="panels"'), "the switch stopped offering the start");
  assert.ok(
    shell.includes('data-brief-switch="performance"'),
    "the switch stopped offering the race after it",
  );
  assert.ok(
    shell.includes('aria-pressed={view === "panels"}'),
    "the switch stopped saying which view is up",
  );
  assert.ok(shell.includes("<BriefPanels race={race} reduced={reduced} />"), "the panels left the shell");
  assert.ok(shell.includes("<BriefPerformance race={race} />"), "the performance view left the shell");

  /* Held in the shell rather than the store, because the store re-arms the gate
     per race and a reader who has said which half they want should not have to
     say it again when the rail swaps the race under them. */
  assert.ok(shell.includes('useState<BriefView>("panels")'), "the view stopped opening on the start");

  /* Native controls and disclosures answer Enter themselves. Without this the
     switch or Method disclosure can both act and release the brief on one
     press, handing the reader the race when they asked to change the brief. */
  assert.ok(
    shell.includes('target.closest("a, button, input, select, summary, textarea")'),
    "Enter on an interactive brief element releases the brief again",
  );

  /* The prestart clock belongs to the shell, and it has to: only one view is
     mounted at a time and the performance view does not move, so a loop living
     in the panels stopped the countdown, and the scene warming behind the
     cover with it, the moment a reader looked at the other tab. */
  assert.ok(
    shell.includes("state.seek(race.tMin + phase * span)"),
    "the shell stopped driving the prestart",
  );
  assert.ok(
    shell.includes("if (!opened.frozen && !(opened.t >= race.tMin && opened.t < 0)) opened.seek(race.tMin);"),
    "the shell stopped guarding the opening seek, so a swap resets the clock again",
  );
  for (const [name, view] of [["BriefPanels", panels], ["BriefPerformance", performance]] as const) {
    assert.ok(!view.includes("requestAnimationFrame"), `${name} started keeping a clock of its own`);
    assert.ok(!view.includes("releaseBrief"), `${name} took the gate off the shell`);
    assert.ok(!view.includes("AUTOPLAY_FROM"), `${name} started deciding where the replay opens`);
  }

  /* Both views read the same race through the evaluators the console already
     reads, so a figure cannot mean one thing in one half and another in the
     other. The start is read through brief.ts, the race after it through the
     analytics module the instrument dock and the analyst lane share. */
  assert.ok(panels.includes("windReadingAt(race, facts"), "the start stopped reading the replay's wind");
  assert.ok(
    performance.includes('from "@/lib/layline/analytics"'),
    "the performance view stopped reading the console's own analytics",
  );
  assert.ok(
    !performance.includes('from "@/lib/layline/sim"'),
    "the performance view reached past analytics into the engine",
  );
});

test("the way through is the widest thing on the footer, and it moves on the race's clock", () => {
  const shell = source("src/components/layline/RaceBrief.tsx");
  const cover = source("src/components/layline/bootSea.module.css");
  const goBtn = cover.slice(cover.indexOf(".goBtn {"), cover.indexOf(".goBtn::before"));

  /* It takes the footer's whole width: the status sentence that used to sit
     beside it left at the owner's direction, and the way through owns the row. */
  assert.ok(goBtn.includes("flex: 1;"), "the way through stopped taking the footer's spare width");
  assert.ok(!cover.includes(".status {"), "the status line came back to the footer");

  /* At the reading size, not the label size, so the layer still holds to three:
     22 for a reading, 10 for a label, 9 inside the drawing. */
  assert.ok(goBtn.includes("font-size: 22px;"), "the way through went back to the label size");

  /* Clock-driven, which is the console's one continuous verb. Its contract:
     "SETTLE is a UI or camera transition, 1.2s at the outside, power2.inOut,
     never looping", so a decorative pulse to say "press me" cannot ship. What
     moves is the countdown the button is offering. */
  assert.ok(
    shell.includes('node.style.setProperty("--go-run", run.toFixed(4));'),
    "the button stopped running on the replay clock",
  );
  assert.ok(
    shell.includes("const run = span > 0 ? Math.min(1, Math.max(0, (t - race.tMin) / span)) : 0;"),
    "the button's run stopped being the ten seconds to the gun",
  );
  assert.ok(
    cover.includes("transform: scaleX(var(--go-run, 0));"),
    "the countdown band stopped being drawn from the clock",
  );
  /* currentColor, so it inverts with the button on hover rather than naming a
     second fill this layer would then have to defend. */
  const band = cover.slice(cover.indexOf(".goBtn::before"), cover.indexOf(".goArrow {"));
  assert.ok(band.includes("background: currentColor;"), "the band picked up a fill of its own");
  /* Nothing on the button loops on wall time. That is the banned verb, and it
     would also take the button off the stated time a held capture draws. */
  assert.ok(!goBtn.includes("animation:"), "the way through went back to a looping decoration");
  assert.ok(!band.includes("animation:"), "the countdown band went back to a looping decoration");
});
