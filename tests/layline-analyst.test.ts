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
  normalizeAnswerShape,
  parseChips,
  serializeChip,
  stripPlanTalk,
  SUGGESTED_QUESTIONS,
} from "../src/lib/layline/analyst/protocol";
import { boatState, detectManeuvers, runTool, standingsAt } from "../src/lib/layline/analyst/tools";
import { maneuversOf } from "../src/lib/layline/analytics";
import { knots } from "../src/lib/layline/format";
import { vmgOf as dockVmg } from "../src/components/layline/hud/live";
import { createPose, poseAt, windAt } from "../src/lib/layline/interpolate";
import type { Pose } from "../src/lib/layline/types";
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

test("the analyst and the timeline markers report one set of maneuvers", () => {
  const race = generateRace(RACE_SEED);
  let counted = 0;
  for (const boat of race.boats) {
    const markers = maneuversOf(race, boat.id);
    const tool = detectManeuvers(race, boat.id);
    assert.equal(tool.length, markers.length, `${boat.sail} marker and tool counts differ`);
    for (let i = 0; i < markers.length; i++) {
      assert.equal(tool[i].t, markers[i].t);
      assert.equal(tool[i].kind, markers[i].kind);
      assert.equal(
        tool[i].speedLossKnots,
        markers[i].lossKnots,
        `${boat.sail} ${markers[i].kind} at ${markers[i].t}: tool says ${tool[i].speedLossKnots}, marker says ${markers[i].lossKnots}`,
      );
      counted += 1;
    }
  }
  assert.ok(counted >= 12, `expected the fleet's turns, counted ${counted}`);
});

test("boat_state reports the dock's VMG and the strip's speed to the mark", () => {
  const race = generateRace(RACE_SEED);
  const pose: Pose = createPose();
  const wind = { t: 0, twd: 0, tws: 0 };
  let sawRun = false;
  for (let t = race.tMin; t <= race.tMax; t += 0.25) {
    const state = boatState(race, "usa", t);
    assert.ok(!("error" in state));

    /* The tile's number, computed by the dock's own function on the same fix. */
    const fix = race.fixes.usa.reduce((nearest, candidate) =>
      Math.abs(candidate.t - t) < Math.abs(nearest.t - t) ? candidate : nearest,
    );
    poseAt(race, "usa", fix.t, "smooth", pose);
    windAt(race, fix.t, wind);
    const dock = dockVmg(pose, wind.twd);
    assert.ok(dock !== null);
    assert.equal(state.vmgKnots, knots(dock), `VMG disagrees with the dock at t=${t}`);

    if (state.leg === "beat" || state.leg === "run") {
      assert.notEqual(state.toMarkKnots, null, `no speed to the mark on the ${state.leg} at t=${t}`);
    } else {
      /* Off the racing legs there is no mark to make good toward, and the
       * strip prints nothing; the tool must not invent a number either. */
      assert.equal(state.toMarkKnots, null, `${state.leg} at t=${t} reported ${state.toMarkKnots}`);
    }

    if (state.leg === "run") {
      sawRun = true;
      assert.ok(Number(state.vmgKnots) < 0, "running away from the wind reads negative on the dock");
      assert.ok(Number(state.toMarkKnots) > 0, "gaining on the mark reads positive on the strip");
    }
  }
  assert.ok(sawRun, "expected part of the run in the sampled window");
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

test("a paragraph answer becomes a lead plus evidence lines without breaking decimals", () => {
  const paragraph =
    "USA 4 took the lead at the windward mark. " +
    "At 0:30 it trailed by one meter. [[t=30|usa]] " +
    "At 0:33 it rounded first at 13.1 knots. " +
    "It held the lead to the finish. [[t=33|usa]]";

  assert.deepEqual(normalizeAnswerShape(paragraph).split("\n"), [
    "USA 4 took the lead at the windward mark.",
    "At 0:30 it trailed by one meter. [[t=30|usa]]",
    "At 0:33 it rounded first at 13.1 knots.",
    "It held the lead to the finish. [[t=33|usa]]",
  ]);
});

test("an already shaped answer stays unchanged", () => {
  const shaped =
    "USA 4 won the start.\n" +
    "It crossed first at the gun. [[t=0|usa]]\n" +
    "It started on the line.";
  assert.equal(normalizeAnswerShape(shaped), shaped);
});

test("a long paragraph keeps every sentence within five scannable lines", () => {
  const paragraph = Array.from({ length: 9 }, (_, index) => `Sentence ${index + 1}.`).join(" ");
  const normalized = normalizeAnswerShape(paragraph);
  const lines = normalized.split("\n");

  assert.equal(lines.length, 5);
  for (let index = 1; index <= 9; index += 1) {
    assert.match(normalized, new RegExp(`Sentence ${index}\\.`));
  }
});

test("plan-talk sentences are stripped wherever they sit, evidence survives", () => {
  /* The shape of the live regression: a flooded model narrating its analysis
   * as the answer, plan talk leading and mid-paragraph, no chips. */
  const wall =
    "Looking at the downwind leg data, I need to compare each boat's downwind performance. " +
    "The key metric for downwind speed is the ground speed over the run. " +
    "Let me look at the average SOG and toMark values from the compare results. " +
    "GBR has the highest average SOG at 14.4 knots. " +
    "Let me look at the individual boat states to compare speeds at similar points. " +
    "At t=45, GBR shows SOG 14.3 knots and toMark 13.9 knots.";
  const stripped = stripPlanTalk(wall);
  assert.doesNotMatch(stripped, /Let me|I need to/);
  assert.match(stripped, /14\.4 knots/);
  assert.match(stripped, /At t=45, GBR shows SOG 14\.3/);

  const leading = "Let me check the downwind legs.\nGBR 30 was fastest downwind. [[t=45|gbr]]";
  assert.equal(stripPlanTalk(leading), "GBR 30 was fastest downwind. [[t=45|gbr]]");

  /* "Looking at" opens real answers too; only a declared plan strips it. */
  const lead = "Looking at the run, GBR 30 was the fastest boat.";
  assert.equal(stripPlanTalk(lead), lead);

  /* An answer that is all plan talk keeps its words rather than vanishing. */
  const allPlan = "Let me check the start report.";
  assert.equal(stripPlanTalk(allPlan), allPlan);
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

test("live mode normalizes a paragraph before it reaches the SSE stream", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalMock = process.env.LAYLINE_ANALYST_MOCK;
  const paragraph =
    "USA 4 took the lead at the windward mark. " +
    "At 0:30 it trailed by one meter. " +
    "At 0:33 it rounded first at 13.1 knots. " +
    "It held the lead to the finish. [[t=33|usa]]";

  delete process.env.LAYLINE_ANALYST_MOCK;
  process.env.OPENROUTER_API_KEY = "test-key";
  globalThis.fetch = async () =>
    new Response(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: paragraph }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
    );

  try {
    const res = await post({ messages: [{ role: "user", content: "How did JPN 18 take the lead" }] });
    assert.equal(res.status, 200);
    const answer = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line.includes('"text"'))
      .map((line) => (JSON.parse(line.slice(6)) as { text: string }).text)
      .join("");
    assert.deepEqual(answer.split("\n"), normalizeAnswerShape(paragraph).split("\n"));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalMock === undefined) delete process.env.LAYLINE_ANALYST_MOCK;
    else process.env.LAYLINE_ANALYST_MOCK = originalMock;
  }
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
  /* One sentence per line holds in the fallback too: the key instruction
   * opens its own line rather than trailing the scripted-questions sentence. */
  assert.ok(
    answer.split("\n").some((line) => line.startsWith("Set OPENROUTER_API_KEY")),
    `expected the key instruction on its own line in: ${answer}`,
  );
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

/* ------------------------------------------------------------------ */
/* Answer shape: a lead line, then evidence lines with chips at line ends */

async function mockDeltas(question: string): Promise<string[]> {
  process.env.LAYLINE_ANALYST_MOCK = "1";
  const res = await post({ messages: [{ role: "user", content: question }] });
  assert.equal(res.status, 200);
  return (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.includes('"text"'))
    .map((line) => (JSON.parse(line.slice(6)) as { text: string }).text);
}

test("every scripted answer is a lead line plus evidence lines, chips at line ends", async () => {
  /* The stand-in reply for an unscripted question follows the same shape. */
  for (const question of [...SUGGESTED_QUESTIONS, "When did NZL 7 tack?"]) {
    const answer = (await mockDeltas(question)).join("");
    const lines = answer.split("\n").filter((line) => line.trim() !== "");
    assert.ok(lines.length >= 3, `expected a lead and evidence lines in: ${answer}`);

    /* The lead answers in one plain sentence and carries no chip. */
    const leadParts = parseChips(lines[0]);
    assert.equal(leadParts.length, 1, `expected a chipless lead line in: ${lines[0]}`);
    assert.equal(leadParts[0].kind, "text");

    /* A chip only ever ends its line; the wall-of-text shape had them
     * mid-sentence, wrapping into orphaned punctuation. */
    let chips = 0;
    for (const line of lines) {
      const parts = parseChips(line.trim());
      parts.forEach((part, index) => {
        if (part.kind !== "chip") return;
        chips += 1;
        assert.equal(index, parts.length - 1, `chip sits mid line in: ${line}`);
      });
    }
    assert.ok(chips >= 1, `expected a chip in: ${answer}`);
  }
});

test("a half-streamed answer never shows markup and never rewrites a finished line", async () => {
  const deltas = await mockDeltas(SUGGESTED_QUESTIONS[2]);
  assert.ok(deltas.length > 4, "expected the answer to arrive in many deltas");

  /* The client's hold-back: the tail past an unclosed "[[" stays hidden. */
  const trimOpenChip = (text: string): string => {
    const open = text.lastIndexOf("[[");
    if (open === -1) return text;
    if (text.indexOf("]]", open) !== -1) return text;
    return text.slice(0, open);
  };

  let streamed = "";
  let previous: string[] = [];
  for (const delta of deltas) {
    streamed += delta;
    const display = trimOpenChip(streamed);
    for (const part of parseChips(display)) {
      if (part.kind === "text") {
        assert.ok(!part.text.includes("[["), `markup visible mid-stream: ${part.text}`);
      }
    }
    /* Once a later line starts, every earlier line is finished and frozen;
     * anything else would rewrap text the reader already read. */
    const lines = display.split("\n").filter((line) => line.trim() !== "");
    for (let index = 0; index + 1 < previous.length; index += 1) {
      assert.equal(lines[index], previous[index], `finished line ${index} changed mid-stream`);
    }
    previous = lines;
  }
});
