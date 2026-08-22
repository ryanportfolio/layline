/**
 * Replay console behavior: the clock's ends and the fix-step grid.
 * Run: npx --yes tsx --test tests/layline-console.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { raceData, useReplay } from "../src/components/layline/store";
import { standingsAt } from "../src/lib/layline/interpolate";
import { FIX_HZ } from "../src/lib/layline/types";

const race = raceData();
const lastElapsed = Math.max(...race.results.map((r) => r.elapsed));

test("standings read finished the instant a boat's finish time passes", () => {
  /* tFinish lands between held progress samples; the standings must not wait
   * for the next one. At the last crossing every boat has finished. */
  const rows = standingsAt(race, lastElapsed);
  assert.deepEqual(
    rows.map((row) => `${row.boatId}:${row.rank}:${row.finished}`),
    race.results.map((r) => `${r.boatId}:${r.rank}:true`),
  );
  /* And one tick earlier the last boat is still racing: the override reads
   * the results, it does not rewrite history. */
  const before = standingsAt(race, lastElapsed - 0.01);
  const lastBoat = race.results[race.results.length - 1].boatId;
  const row = before.find((entry) => entry.boatId === lastBoat);
  assert.equal(row?.finished, false);
});

test("a fresh finisher never shares a place with a boat still racing", () => {
  /* nzl crosses at 56.965 with result rank 4 while the 56.5 progress sample
   * still holds aus at rank 4; the rows must resolve to unique places with the
   * finisher ahead of the held rival, not two fours sorted by boat id. */
  const rows = standingsAt(race, 56.965);
  assert.deepEqual(
    rows.map((row) => `${row.boatId}:${row.rank}${row.finished ? "F" : ""}`),
    ["usa:1F", "jpn:2F", "gbr:3F", "nzl:4F", "aus:5", "fra:6"],
  );
});

test("the clock runs out the whole feed and stops at tMax", () => {
  const store = useReplay.getState();
  store.seek(race.tMax - 0.1);
  useReplay.setState({ playing: true });
  store.advance(0.5);
  assert.equal(useReplay.getState().t, race.tMax);
  assert.equal(useReplay.getState().playing, false);
});

test("play from the end plays it again", () => {
  useReplay.getState().seek(race.tMax);
  useReplay.getState().play();
  assert.ok(useReplay.getState().t < 0, "expected a restart into the prestart");
  assert.equal(useReplay.getState().playing, true);
  useReplay.getState().pause();
});

test("step lands on the fix grid, one fix at a time, and pauses", () => {
  const store = useReplay.getState();
  const grid = 1 / FIX_HZ;
  store.seek(20.1);
  useReplay.setState({ playing: true });
  store.step(1);
  assert.equal(useReplay.getState().t, 20.25);
  assert.equal(useReplay.getState().playing, false);
  useReplay.getState().step(1);
  assert.equal(useReplay.getState().t, 20.5);
  useReplay.getState().step(-1);
  assert.equal(useReplay.getState().t, 20.25);
  /* From a grid point, back means the previous fix, not the same one. */
  useReplay.getState().step(-1);
  assert.equal(useReplay.getState().t, 20);
  /* Clamped at both ends of the feed. */
  useReplay.getState().seek(race.tMin);
  useReplay.getState().step(-1);
  assert.equal(useReplay.getState().t, race.tMin);
  useReplay.getState().seek(race.tMax);
  useReplay.getState().step(1);
  assert.equal(useReplay.getState().t, race.tMax);
  assert.ok(Number.isInteger((20.25 - race.tMin) / grid));
});
