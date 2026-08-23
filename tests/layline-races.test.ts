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
import { clock } from "../src/lib/layline/format";
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
import { OPEN_AT, pointAtRace, raceData, useReplay } from "../src/components/layline/store";

/* ------------------------------------------------------------------ */
/* Audit thresholds                                                    */

/* The winner's own elapsed, not race.tMax: tMax is the replay window and runs
 * past the last finisher, 63.25 s on the shipped seed against a 51.52 s win.
 * The registry lands at 47.30, 51.38 and 51.52. */
const WIN_MIN_S = 45;
const WIN_MAX_S = 60;
/* Registry observed 4.35 to 8.21 s. */
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
  "long-beach": ["USA 4 0:51", "JPN 18 0:52", "GBR 21 0:55", "NZL 7 0:56", "AUS 33 0:57", "FRA 12 0:57"],
  "kestrel-sound": ["GBR 21 0:47", "FRA 12 0:51", "USA 4 0:53", "AUS 33 0:53", "JPN 18 0:55", "NZL 7 0:55"],
  "sable-reach": ["FRA 12 0:51", "AUS 33 0:51", "USA 4 0:52", "NZL 7 0:53", "JPN 18 0:55", "GBR 21 0:55"],
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
  "long-beach": { changes: 5, sail: "USA 4", t: 28, leg: "beat" },
  "kestrel-sound": { changes: 7, sail: "GBR 21", t: 18, leg: "beat" },
  "sable-reach": { changes: 3, sail: "FRA 12", t: 36.5, leg: "run" },
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

test("kestrel sound keeps its single sample lead", () => {
  const segments = leaderSegments(generateRace(raceMeta("kestrel-sound")!.seed));
  const flicker = segments.find((segment) => segment.from === segment.to);
  assert.ok(flicker !== undefined, "expected a one sample segment");
  assert.equal(flicker.sail, "JPN 18");
  assert.equal(flicker.from, 9);
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
    messages: [{ role: "user", content: RACES[0].suggestedQuestions[1] }],
  });
  assert.equal(res.status, 200);
  const answer = await answerOf(res);
  assert.match(answer, /USA 4/);
  assert.ok(
    parseChips(answer).some((segment) => segment.kind === "chip" && segment.t === 28),
    `expected the shipped race's decisive pass at 0:28 in: ${answer}`,
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
  assert.ok(
    app.includes('if (autoplay === "immediate" || replay.introDone)'),
    "immediate autoplay no longer bypasses the intro latch",
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
  assert.ok(css.includes('.stage[data-boot="sea"] .canvasLayer'), "the scene fades instead of the cover");
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
  /* The cover names the race it is loading, in the display face, and the page
     preloads that face: it is declared font-display: block, so without the
     preload the title card holds unpainted through the wait it exists to fill. */
  assert.match(cover, /\.label \{/);
  /* One word to a line, sized against the pane rather than the window, so the
     longest word in a race name is what sets the size. */
  assert.ok(cover.includes("container-type: inline-size"), "the title stopped sizing to the pane");
  assert.ok(app.includes("86cqi"), "the title stopped filling the pane's width");
  assert.ok(app.includes("className={sea.word}"), "the title stopped breaking a word to a line");
  assert.ok(cover.includes("var(--font-pangram)"), "the title card left the display face");
  assert.ok(
    workspace.includes("bootLabel={meta?.name}"),
    "the cover stopped naming the race the rail names",
  );
  const racesPage = source("src/app/races/page.tsx");
  assert.ok(
    racesPage.includes('href="/assets/fonts/pangram-display.woff2"'),
    "the library stopped preloading the face its title card is set in",
  );

  assert.match(cover, /transition:\s*opacity 900ms/);
  assert.match(cover, /\.out \{\s*opacity: 0;/);
});
