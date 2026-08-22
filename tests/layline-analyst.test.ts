/**
 * Debrief analyst: tool determinism, chip grammar, knowledge retrieval, and
 * the route contract. Run with: npx --yes tsx --test tests/layline-analyst.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateRace } from "../src/lib/layline/sim";
import { RACE_SEED } from "../src/lib/layline/types";
import { lookupTerms } from "../src/lib/layline/analyst/knowledge";
import {
  parseChips,
  serializeChip,
  SUGGESTED_QUESTIONS,
} from "../src/lib/layline/analyst/protocol";
import { detectManeuvers, runTool, standingsAt } from "../src/lib/layline/analyst/tools";
import { standingsAt as hudStandings } from "../src/lib/layline/interpolate";
import { POST } from "../src/app/api/layline/analyst/route";

/* ------------------------------------------------------------------ */
/* Tools                                                               */

test("standings_at matches the results and events of a fresh race", () => {
  const race = generateRace(RACE_SEED);

  /* After the last finisher, the standings are the results. */
  const final = standingsAt(race, race.tMax);
  assert.equal(final.rows.length, race.results.length);
  for (const result of race.results) {
    const row = final.rows.find((entry) => entry.boatId === result.boatId);
    assert.ok(row, `no standings row for ${result.boatId}`);
    assert.equal(row.rank, result.rank);
    assert.equal(row.finished, true);
  }

  /* Just after the first rounding, that boat is on the run and leading. */
  const firstRounding = race.events.find((event) => event.kind === "rounding");
  assert.ok(firstRounding && firstRounding.boatId);
  const atRounding = standingsAt(race, firstRounding.t + 0.6);
  const rounder = atRounding.rows.find((entry) => entry.boatId === firstRounding.boatId);
  assert.ok(rounder);
  assert.equal(rounder.leg, "run");
  assert.equal(rounder.rank, 1);
});

test("standings_at agrees with the on screen standings at every sample", () => {
  const race = generateRace(RACE_SEED);
  for (let t = race.tMin; t <= race.tMax; t += 0.05) {
    const screen = hudStandings(race, t)
      .map((row) => `${row.boatId}:${row.rank}${row.finished ? "F" : ""}`)
      .join(",");
    const tool = standingsAt(race, t)
      .rows.map((row) => `${row.boatId}:${row.rank}${row.finished ? "F" : ""}`)
      .join(",");
    assert.equal(tool, screen, `standings disagree at t=${t.toFixed(2)}`);

    /* A finished row cannot still owe distance or seconds. */
    for (const row of standingsAt(race, t).rows) {
      if (!row.finished) continue;
      assert.equal(row.dtfMeters, 0, `${row.boatId} finished with ${row.dtfMeters} m left at t=${t.toFixed(2)}`);
      assert.equal(row.gapSeconds, 0, `${row.boatId} finished ${row.gapSeconds} s behind at t=${t.toFixed(2)}`);
    }
  }
});

test("standings_at is byte-identical across two fresh races", () => {
  const a = runTool(generateRace(RACE_SEED), "standings_at", { t: 30 });
  const b = runTool(generateRace(RACE_SEED), "standings_at", { t: 30 });
  assert.equal(a, b);
});

test("maneuver detection is identical across two runs", () => {
  const first = JSON.stringify(detectManeuvers(generateRace(RACE_SEED)));
  const second = JSON.stringify(detectManeuvers(generateRace(RACE_SEED)));
  assert.equal(first, second);
  assert.ok(JSON.parse(first).length > 0, "expected at least one tack or gybe in the race");
});

test("a maneuver never reports negative speed loss", () => {
  for (const move of detectManeuvers(generateRace(RACE_SEED))) {
    assert.ok(
      Number(move.speedLossKnots) >= 0,
      `${move.sail} ${move.kind} at ${move.raceClock} lost ${move.speedLossKnots} knots`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Chip grammar                                                        */

test("chip parser round-trips both chip forms", () => {
  assert.equal(serializeChip(32.9, "nzl"), "[[t=32.9|nzl]]");
  assert.equal(serializeChip(60), "[[t=60]]");

  const boatChip = parseChips(serializeChip(32.9, "nzl"));
  assert.deepEqual(boatChip, [{ kind: "chip", t: 32.9, boatId: "nzl" }]);

  const bareChip = parseChips(serializeChip(45.5));
  assert.deepEqual(bareChip, [{ kind: "chip", t: 45.5 }]);

  const mixed = parseChips("USA 4 rounded first [[t=32.9|usa]] and the gun [[t=0]] set it up.");
  assert.deepEqual(mixed, [
    { kind: "text", text: "USA 4 rounded first " },
    { kind: "chip", t: 32.9, boatId: "usa" },
    { kind: "text", text: " and the gun " },
    { kind: "chip", t: 0 },
    { kind: "text", text: " set it up." },
  ]);
});

/* ------------------------------------------------------------------ */
/* Knowledge                                                           */

test("knowledge lookup returns the layline chunk for layline", () => {
  const hits = lookupTerms("layline");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, "layline");
  assert.ok(hits.length <= 2, "lookup returns at most two chunks");
});

/* ------------------------------------------------------------------ */
/* Route contract                                                      */

function post(body: unknown): Promise<Response> {
  /* No content-type header on purpose: Request.json() parses the body either
   * way, and the wire client sends JSON text just the same. */
  return POST(
    new Request("http://localhost/api/layline/analyst", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

test("route rejects nine messages with 422", async () => {
  const messages = Array.from({ length: 9 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: "hello",
  }));
  const res = await post({ messages });
  assert.equal(res.status, 422);
});

test("route rejects a 500 character message with 422", async () => {
  const res = await post({ messages: [{ role: "user", content: "x".repeat(500) }] });
  assert.equal(res.status, 422);
});

test("route rejects an assistant-last conversation with 422", async () => {
  const res = await post({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  });
  assert.equal(res.status, 422);
});

test("route rejects empty messages and garbage bodies without a 5xx", async () => {
  const empty = await post({ messages: [] });
  assert.equal(empty.status, 422);
  const garbage = await post("not json at all");
  assert.equal(garbage.status, 400);
});

test("mock mode says so when a question is outside its script", async () => {
  process.env.LAYLINE_ANALYST_MOCK = "1";
  const res = await post({ messages: [{ role: "user", content: "When did NZL 7 tack?" }] });
  assert.equal(res.status, 200);
  const answer = (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.includes('"text"'))
    .map((line) => (JSON.parse(line.slice(6)) as { text: string }).text)
    .join("");
  assert.match(answer, /stand-in/, `expected the stand-in disclosure in: ${answer}`);
  assert.match(answer, /OPENROUTER_API_KEY/);
});

test("mock mode streams status and deltas and ends with done", async () => {
  process.env.LAYLINE_ANALYST_MOCK = "1";
  const res = await post({ messages: [{ role: "user", content: SUGGESTED_QUESTIONS[0] }] });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.startsWith("text/event-stream"));

  const text = await res.text();
  const frames = text
    .split("\n\n")
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      assert.ok(eventLine && dataLine, `malformed SSE frame: ${JSON.stringify(chunk)}`);
      return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
    });

  assert.ok(frames.some((entry) => entry.event === "status"), "expected a status frame");
  assert.ok(frames.some((entry) => entry.event === "delta"), "expected delta frames");
  const last = frames[frames.length - 1];
  assert.equal(last.event, "done");
  assert.deepEqual(last.data, { ok: true });

  /* The streamed answer carries at least one seekable chip. */
  const answer = frames
    .filter((entry) => entry.event === "delta")
    .map((entry) => (entry.data as { text: string }).text)
    .join("");
  const chips = parseChips(answer).filter((segment) => segment.kind === "chip");
  assert.ok(chips.length >= 1, `expected a chip in: ${answer}`);
});
