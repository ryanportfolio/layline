/**
 * Engine room bench data: the twelve seconds of USA 4 the "How the replay
 * works" section draws. Every figure and chip in that section prints one of
 * these values, so this file pins them against the seeded race itself. If the
 * sim changes, these numbers change with it and the section follows.
 *
 * Run: npx --yes tsx --test tests/layline-engine-room.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { VMG_STEP, maneuversOf } from "../src/lib/layline/analytics";
import {
  MAX_MESSAGE_CHARS,
  MAX_TURNS,
  SUGGESTED_QUESTIONS,
} from "../src/lib/layline/analyst/protocol";
import { ANALYST_TOOLS } from "../src/lib/layline/analyst/tools";
import { poseAt } from "../src/lib/layline/interpolate";
import { generateRace } from "../src/lib/layline/sim";
import { FIX_HZ, RACE_SEED } from "../src/lib/layline/types";
import { useReplay } from "../src/components/layline/store";
import { CONSOLE_BOAT, buildBoard, type BoardRow } from "../src/components/layline/engine/boardData";
import {
  BENCH_BOAT,
  benchWindow,
  chordDrift,
  chordPath,
  crossingInstant,
  divergenceAt,
  finishGap45,
  finishGaps,
  gapRange,
  newPose,
  northPair,
  parkTime,
  roundingTime,
  secondTack,
  totalFixes,
} from "../src/components/layline/engine/benchData";

const race = generateRace(RACE_SEED);
const window = benchWindow(race, BENCH_BOAT);
const pair = northPair(race, window);

test("the bench window is the beat's second tack, six seconds either side", () => {
  assert.equal(secondTack(race, BENCH_BOAT), 27.25);
  assert.deepEqual([window.from, window.to, window.span], [21, 33, 12]);
  assert.equal(window.fixes.length, 49);
  /* Every fix sits on the 1/FIX_HZ grid the sim wrote them on. */
  for (const fix of window.fixes) {
    assert.ok(Number.isInteger(Math.round((fix.t - window.from) * FIX_HZ)));
  }
  /* The tack sits inside the window. The rounding no longer does: the sim now
     takes a hull's mark time at its closest approach measured through the run
     leg as well as the arc, which moved USA 4's rounding from 32.85 to 33.70,
     seven tenths past the window's end. The transport draws its rounding
     marker only when the event is inside the window, so on this seed the
     marker stays undrawn and the scrub rail carries the tack tick alone. */
  assert.ok(window.tack > window.from && window.tack < window.to);
  const rounding = roundingTime(race, BENCH_BOAT);
  assert.equal(rounding, 33.7);
  assert.ok(rounding !== null && rounding > window.to);
});

test("dot spacing over the window is the range the chips print", () => {
  const gaps = gapRange(window.fixes);
  assert.equal(gaps.min.toFixed(2), "0.70");
  assert.equal(gaps.max.toFixed(2), "1.27");
});

test("the north pair is one second apart and straddles the top of the circle", () => {
  assert.equal(pair.b.t - pair.a.t, 1);
  assert.ok(pair.a.t >= window.from && pair.b.t <= window.to);
  assert.equal(pair.a.hdg.toFixed(1), "21.5");
  assert.equal(pair.b.hdg.toFixed(1), "353.5");
  assert.equal(pair.plain.toFixed(1), "332.0");
  assert.equal(Math.abs(pair.short).toFixed(1), "28.0");
  /* The plain-number reading is the wrong way round the circle by exactly the
   * complement: that difference is the whole of the compass figure. */
  assert.equal((pair.plain + Math.abs(pair.short)).toFixed(1), "360.0");
});

test("the park frame holds the raw and smooth boats visibly apart", () => {
  const crossing = crossingInstant(race, BENCH_BOAT, pair);
  assert.ok(crossing > pair.a.t && crossing < pair.b.t, "crossing outside the pair");
  assert.equal(crossing.toFixed(2), "27.02");
  const park = parkTime(race, BENCH_BOAT, pair);
  assert.ok(park >= pair.a.t && park <= pair.b.t, "park outside the pair");
  assert.equal(park.toFixed(2), "26.48");
  /* Three pixels at ten pixels per metre is the floor for a parked frame that
   * still shows two boats. The crossing itself misses it on this seed, so the
   * widest-divergence fallback is the rule that fired here. */
  assert.ok(divergenceAt(race, BENCH_BOAT, crossing) < 0.3);
  assert.ok(divergenceAt(race, BENCH_BOAT, park) >= 0.3);
  assert.equal(divergenceAt(race, BENCH_BOAT, park).toFixed(2), "1.03");
});

test("the straight-line track is the number CAM 02 prints, and it is not drawable", () => {
  const points = chordPath(race.fixes[BENCH_BOAT], window.from, window.to);
  assert.equal(points.length, 241);
  assert.equal(points[0].t, 21);
  assert.equal(points[points.length - 1].t, 33);
  const drift = chordDrift(race, BENCH_BOAT, window);
  assert.equal(drift.toFixed(2), "0.02");
  /* Every sample lands off the curve, so the number is a real separation and
   * not a sampling artefact. */
  const pose = newPose();
  let differs = 0;
  for (const point of points) {
    poseAt(race, BENCH_BOAT, point.t, "smooth", pose);
    if (Math.hypot(point.x - pose.x, point.y - pose.y) > 0) differs += 1;
  }
  assert.ok(differs > points.length / 2);
  /* The figure draws at about 17.9 units per metre, so this separation is a
   * third of a pixel: under the 2px stroke that would draw it. No rejected
   * construction is drawn in CAM 02 for exactly this reason, and the copy has
   * to keep saying what the number says. A seed that pushed this past three
   * pixels would be worth drawing again, and would fail here first. */
  const figureScale = 17.884;
  assert.ok(drift * figureScale < 3, "a visible cut belongs on the drawing, not only in a chip");
});

test("the finish strip prints the results the race already holds", () => {
  const order = finishGaps(race);
  assert.deepEqual(
    order.map((entry) => entry.boatId),
    ["usa", "jpn", "gbr", "nzl", "aus", "fra"],
  );
  /* These are the strings the strip prints, because the strip prints the
   * server's numbers: NotesSection builds them in Node from the race page.tsx
   * already generated and hands them down as props. Left to the browser they
   * come out up to fifteen milliseconds different, which moved +3.63 to +3.64
   * and 0.04 to 0.05 on screen while this file stayed green. */
  assert.equal(order[0].elapsed.toFixed(2), "51.52");
  assert.deepEqual(
    order.map((entry) => entry.delta.toFixed(2)),
    ["0.00", "1.42", "3.63", "5.44", "5.48", "5.97"],
  );
  assert.equal(finishGap45(order).toFixed(2), "0.04");
  /* The bar per boat is elapsed over the last boat home. */
  assert.deepEqual(
    order.map((entry) => ((entry.elapsed / order[5].elapsed) * 100).toFixed(1)),
    ["89.6", "92.1", "95.9", "99.1", "99.1", "100.0"],
  );
  /* GBR's near-white and NZL's near-black are the two that need an outline. */
  assert.deepEqual(
    order.filter((entry) => entry.dark).map((entry) => entry.boatId),
    ["gbr", "nzl"],
  );
});

/* The engine ident counts the bench window, not the fleet. The fleet total is
   back on the page in the build board's "Fixes the sim wrote" row, and the
   Debrief panel above prints it too. */
test("the seed writes 1711 fixes across the fleet", () => {
  assert.equal(totalFixes(race), 1711);
});

/* ------------------------------------------------------------------ */
/* The build board                                                     */

/**
 * The closing panel is a factual claim per row, so the rows are pinned
 * verbatim: label, numeral, unit and state, lane by lane, exactly as they
 * render. A row that starts claiming something this build does not do has to
 * fail here first.
 */
const boardKey = (row: BoardRow) =>
  [row.label, row.value ?? "", row.unit ?? "", row.state].join("|");

test("the build board renders these rows, in this order, in these states", () => {
  const board = buildBoard(race);
  assert.deepEqual(
    board.lanes.map((lane) => lane.name),
    ["Replay engine", "Console", "Debrief"],
  );
  assert.deepEqual(
    board.lanes.map((lane) => lane.rows.map(boardKey)),
    [
      [
        "Boats in the seeded fleet|6||running",
        "Fixes the sim wrote|1711||running",
        "Wind readings under the laylines|75||running",
        "Gun, roundings and finishes|13||running",
        "Hulls, wake, spray, water and sky|||running",
        "Chart stand-in without WebGL|||running",
      ],
      [
        "Race clock the transport scrubs|73.25|s|running",
        "Start line counts down from|10.00|s|running",
        "Turns marked under the scrub track|3||running",
        "Speed made good, one reading every|0.50|s|running",
        "Chart mode on the same clock|||running",
        "Heel and trim on the instrument dock|||landing",
      ],
      [
        "Tools the analyst can call|7||running",
        "Questions on the opening cards|3||running",
        "Turns one thread runs to|8||running",
        "Characters a question can carry|400||running",
        "Moment chips put the replay on the answer|||running",
      ],
    ],
  );
});

test("the tally in the ident slot is counted off the rows it sits over", () => {
  const board = buildBoard(race);
  const rows = board.lanes.flatMap((lane) => lane.rows);
  assert.equal(board.rows, rows.length);
  assert.equal(board.rows, 17);
  assert.equal(board.running, rows.filter((row) => row.state === "running").length);
  assert.equal(board.running, 16);
  /* One amber row, and it is the one the page's own status banner names. */
  const landing = rows.filter((row) => row.state === "landing");
  assert.deepEqual(
    landing.map((row) => row.label),
    ["Heel and trim on the instrument dock"],
  );
  /* No row invents a numeral: a value carries a unit or it carries none, and
     a row with no honest number prints a label and a dot alone. */
  for (const row of rows) {
    if (row.value === undefined) assert.equal(row.unit, undefined, row.label);
    else assert.match(row.value, /^\d+(\.\d\d)?$/, row.label);
  }
});

test("every board numeral is its source's own count", () => {
  const board = buildBoard(race);
  const rows = new Map(board.lanes.flatMap((lane) => lane.rows).map((row) => [row.label, row]));
  const value = (label: string) => {
    const row = rows.get(label);
    assert.ok(row !== undefined, `no board row labelled ${label}`);
    return row.value;
  };

  assert.equal(value("Boats in the seeded fleet"), String(race.boats.length));
  assert.equal(value("Fixes the sim wrote"), String(totalFixes(race)));
  assert.equal(value("Wind readings under the laylines"), String(race.wind.length));
  assert.equal(value("Gun, roundings and finishes"), String(race.events.length));
  /* Gun, six roundings, six finishes: the whole event list, nothing else. */
  assert.deepEqual(
    race.events.reduce<Record<string, number>>((counts, event) => {
      counts[event.kind] = (counts[event.kind] ?? 0) + 1;
      return counts;
    }, {}),
    { gun: 1, rounding: 6, finish: 6 },
  );

  assert.equal(value("Race clock the transport scrubs"), (race.tMax - race.tMin).toFixed(2));
  assert.equal(value("Start line counts down from"), (-race.tMin).toFixed(2));
  assert.equal(value("Turns marked under the scrub track"), String(maneuversOf(race, CONSOLE_BOAT).length));
  assert.equal(value("Speed made good, one reading every"), VMG_STEP.toFixed(2));
  /* The turns row counts the boat the console is already following when the
     page opens. If the store's opening pick moves, the row is about a
     different boat and the label stops being true. */
  assert.equal(useReplay.getState().followId, CONSOLE_BOAT);

  assert.equal(value("Tools the analyst can call"), String(ANALYST_TOOLS.length));
  assert.equal(value("Questions on the opening cards"), String(SUGGESTED_QUESTIONS.length));
  assert.equal(value("Turns one thread runs to"), String(MAX_TURNS));
  assert.equal(value("Characters a question can carry"), String(MAX_MESSAGE_CHARS));
});
