/**
 * The Debrief analyst. POST a short conversation, get an SSE stream back:
 * status lines while tools run, text deltas as the answer arrives, one done
 * or error frame to close. Grounding is the whole point: the model can only
 * quote numbers it read through tools that run against the same seeded race
 * the replay renders.
 *
 * Mock mode (LAYLINE_ANALYST_MOCK=1) streams a deterministic answer computed
 * from the real tools and never touches the network, so dev and tests run
 * without a key. Live mode without a key degrades honestly to a 503.
 *
 * Live mode talks to OpenRouter's chat completions API over raw fetch: one
 * prepaid key is the hard spend ceiling, and the model is an env knob
 * (OPENROUTER_MODEL) swappable from the dashboard without a deploy.
 */
import { clock } from "@/lib/layline/format";
import type { LegName, RaceData } from "@/lib/layline/types";
import { DEFAULT_RACE_ID, raceMeta } from "@/lib/layline/races";
import type { RaceMeta } from "@/lib/layline/races";
import { raceFor } from "@/lib/layline/analyst/data";
import { buildSystemPrompt } from "@/lib/layline/analyst/prompt";
import {
  MAX_MESSAGE_CHARS,
  MAX_TURNS,
  SSE_DELTA,
  SSE_DONE,
  SSE_ERROR,
  SSE_STATUS,
  normalizeAnswerShape,
  serializeChip,
  stripPlanTalk,
} from "@/lib/layline/analyst/protocol";
import type { AnalystMessage } from "@/lib/layline/analyst/protocol";
import {
  ANALYST_TOOLS,
  compareBoats,
  runTool,
  standingsAt,
  startReport,
  toolStatusLabel,
} from "@/lib/layline/analyst/tools";
import type { CompareOut, StandingsOut } from "@/lib/layline/analyst/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TOOL_ROUNDS = 6;

/* Rounds are capped by a clock as well as a count, because the count alone
 * cannot see how slow the rounds are. Measured live against the shipped model,
 * a round takes 3.3 to 6.4 seconds. The check runs after a round lands, so the
 * ceiling is this budget plus one overrunning round plus the answer round plus
 * the typed replay, and maxDuration above is what it has to stay under. */
const TOOL_BUDGET_MS = 30_000;

/* What the model is asked once its rounds are spent. It points back at the
 * answer format in the system prompt rather than restating one: told only to
 * answer, it writes an eleven-line dump with no chips in it. */
const ANSWER_NOW =
  "There are no tools left to call for this question. Write the finished answer now, " +
  "in the shape the rules above give it: one sentence that answers it, then two to four " +
  "evidence lines with their numbers and chips. Use only what the results below already say, " +
  "and if something is missing, say what you could not check.";

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash-vision-exp";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const encoder = new TextEncoder();

function frame(event: string, data: object): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */

function sameOriginRefused(req: Request): boolean {
  const ownHost = new URL(req.url).host;
  for (const header of ["origin", "referer"]) {
    const value = req.headers.get(header);
    if (value === null || value === "") continue;
    try {
      return new URL(value).host !== ownHost;
    } catch {
      return true;
    }
  }
  return false;
}

function validate(payload: unknown): AnalystMessage[] | { status: number; error: string } {
  if (typeof payload !== "object" || payload === null) {
    return { status: 422, error: "expected a JSON object with messages" };
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { status: 422, error: "messages must be a non-empty array" };
  }
  if (messages.length > MAX_TURNS) {
    return { status: 422, error: `at most ${MAX_TURNS} messages per request` };
  }
  const clean: AnalystMessage[] = [];
  for (const entry of messages) {
    if (typeof entry !== "object" || entry === null) {
      return { status: 422, error: "each message needs a role and content" };
    }
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      return { status: 422, error: "message role must be user or assistant" };
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return { status: 422, error: "message content must be a non-empty string" };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { status: 422, error: `messages are capped at ${MAX_MESSAGE_CHARS} characters` };
    }
    clean.push({ role, content });
  }
  if (clean[clean.length - 1].role !== "user") {
    return { status: 422, error: "the last message must be from the user" };
  }
  return clean;
}

/* ------------------------------------------------------------------ */
/* Mock mode: deterministic answers computed from the real tools       */

interface MockStep {
  kind: "status" | "text";
  value: string;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[?!.]+$/, "").trim();
}

function matches(question: string, suggestion: string): boolean {
  return normalize(question).startsWith(normalize(suggestion));
}

function endWord(end: "pin" | "boat"): string {
  return end === "pin" ? "pin" : "committee boat";
}

function ordinal(rank: number): string {
  const words = ["first", "second", "third", "fourth", "fifth", "sixth"];
  return words[rank - 1] ?? `${rank}th`;
}

function asCompare(result: CompareOut | { error: string }): CompareOut {
  if ("error" in result) throw new Error(result.error);
  return result;
}

function statusStep(race: RaceData, tool: string, input: object): MockStep {
  return { kind: "status", value: toolStatusLabel(race, tool, input) };
}

function rowFor(standings: StandingsOut, boatId: string) {
  return standings.rows.find((row) => row.boatId === boatId);
}

function mockStart(race: RaceData): MockStep[] {
  const steps: MockStep[] = [statusStep(race, "start_report", {})];
  const report = startReport(race);
  const [first, second] = report.rows;
  const firstChip = serializeChip(first.crossedAfterGunSeconds ?? 0, first.boatId);
  const secondChip = serializeChip(second.crossedAfterGunSeconds ?? 0, second.boatId);
  steps.push({
    kind: "text",
    value:
      `${first.sail} won the start.\n` +
      `At the gun it sat ${first.distanceToLineMeters} meters short of the line with ${first.sogAtGunKnots} knots on, off the ${endWord(first.nearerEnd)} end.\n` +
      `It crossed ${first.crossedAfterGunSeconds} seconds after the gun, first in the fleet. ${firstChip}\n` +
      `${second.sail} was next across at ${second.crossedAfterGunSeconds} seconds, from the ${endWord(second.nearerEnd)} end. ${secondChip}`,
  });
  return steps;
}

function gapWords(gapSeconds: number): string {
  if (gapSeconds <= 0) return "less than a second";
  return gapSeconds === 1 ? "1 second" : `${gapSeconds} seconds`;
}

interface LeaderSegment {
  boatId: string;
  /* When this boat took the lead, and the last sample it still held it. */
  from: number;
  to: number;
  /* The leg the race was on at `from`, which is the leg the pass happened on. */
  leg: LegName;
}

/**
 * Who led, collapsed into segments. Rank 1 in the progress feed is the smallest
 * distance to finish at every sample of every race in the registry, so this is
 * the same lead the standings dock shows.
 *
 * t = 0 is excluded: that sample still carries entry order rather than a race
 * position, so counting it manufactures a pass at t = 0.5 in every race. Pre-
 * start samples are excluded for the same reason.
 */
function leaderSegments(race: RaceData): LeaderSegment[] {
  const leading: { t: number; boatId: string; leg: LegName }[] = [];
  for (const boat of race.boats) {
    for (const sample of race.progress[boat.id] ?? []) {
      if (sample.t <= 0 || sample.rank !== 1 || sample.leg === "prestart") continue;
      leading.push({ t: sample.t, boatId: boat.id, leg: sample.leg });
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
    segments.push({ boatId: entry.boatId, from: entry.t, to: entry.t, leg: entry.leg });
  }
  return segments;
}

function sailOf(race: RaceData, boatId: string): string {
  return race.boats.find((boat) => boat.id === boatId)?.sail ?? boatId;
}

/* The pass that decided the race is the start of the last leader segment, not
 * the first change: a race can trade the lead half a dozen times, and one of
 * those trades can last a single sample. */
function mockLeadChange(race: RaceData): MockStep[] {
  const segments = leaderSegments(race);
  if (segments.length === 0) return mockStandings(race);

  const decisive = segments[segments.length - 1];
  const passT = decisive.from;
  const passSail = sailOf(race, decisive.boatId);
  const steps: MockStep[] = [];

  /* The tail both branches end on: this leader either kept it to the line or
   * lost it after the last pass anyone made. */
  const winner = race.results.find((result) => result.rank === 1);
  const runnerUp = race.results.find((result) => result.rank === 2);
  const margin =
    winner === undefined || runnerUp === undefined
      ? 0
      : Math.round(runnerUp.elapsed - winner.elapsed);
  const heldTail =
    winner !== undefined && winner.boatId === decisive.boatId
      ? `and it led the rest of the way, winning by ${gapWords(margin)}`
      : `and it held the lead to ${clock(decisive.to)}`;

  /* Wire to wire. Nothing was passed, and saying a pass happened would be the
   * one number in this answer that came from the template rather than the race. */
  if (segments.length === 1) {
    steps.push(statusStep(race, "standings_at", { t: passT }));
    const opening = standingsAt(race, passT);
    const second = opening.rows[1];
    steps.push({
      kind: "text",
      value:
        `Nobody took the lead in this race.\n` +
        `${passSail} led from ${opening.raceClock} on the ${decisive.leg}, with ${second.sail} ` +
        `${gapWords(second.gapSeconds)} back, ${heldTail}. ${serializeChip(passT, decisive.boatId)}`,
    });
    return steps;
  }

  const passed = segments[segments.length - 2];
  const passedSail = sailOf(race, passed.boatId);
  /* Mid-stretch of the previous leader's run at the front, where its lead is a
   * lead rather than the moment it just took or just lost one. Progress lands
   * twice a second, so the midpoint is put back on that grid. */
  const earlyT = Math.round((passed.from + passed.to)) / 2;

  steps.push(statusStep(race, "standings_at", { t: earlyT }));
  const early = standingsAt(race, earlyT);
  steps.push(statusStep(race, "standings_at", { t: passT }));
  const later = standingsAt(race, passT);
  steps.push(statusStep(race, "compare_boats", { a: decisive.boatId, b: passed.boatId }));
  const cmp = asCompare(compareBoats(race, decisive.boatId, passed.boatId, passed.from, passT));
  const wasBehindBy = rowFor(early, decisive.boatId)?.gapSeconds ?? 0;

  /* A pass is not always a speed pass. Sable Reach's winner goes through with
   * the slower average over the ground, so the clause that reads as the reason
   * has to say so rather than let the two numbers imply the opposite. */
  const speedClause =
    Number(cmp.a.avgSogKnots) >= Number(cmp.b.avgSogKnots)
      ? `after averaging ${cmp.a.avgSogKnots} knots over the ground to ${cmp.b.avgSogKnots} for ${passedSail} through that stretch`
      : `having averaged ${cmp.a.avgSogKnots} knots over the ground to ${cmp.b.avgSogKnots} for ${passedSail} through that stretch, so the gain was not in straight-line speed`;

  /* Where the pass settled. A pass on the beat is judged at the windward mark,
   * which is the first sample the new leader spends on the run. A pass already
   * made on the run has no mark left to judge it at. */
  let settledLine: string;
  if (decisive.leg === "run") {
    settledLine =
      `The pass came downwind rather than on the beat: ${passSail} went through with the leader ` +
      `already on the run, ${heldTail}. ${serializeChip(passT, decisive.boatId)}`;
  } else {
    const onRun = (race.progress[decisive.boatId] ?? []).find(
      (sample) => sample.t >= passT && sample.leg === "run",
    );
    if (onRun === undefined) {
      settledLine = `${passSail} went clear at ${later.raceClock}, ${heldTail}. ${serializeChip(passT, decisive.boatId)}`;
    } else {
      steps.push(statusStep(race, "standings_at", { t: onRun.t }));
      const afterMark = standingsAt(race, onRun.t);
      const markLeader = afterMark.rows[0];
      const markGap = rowFor(afterMark, passed.boatId)?.gapSeconds ?? 0;
      settledLine =
        markLeader.boatId === decisive.boatId
          ? `The pass stuck at the windward mark: ${passSail} reached it first, settled onto the run ` +
            `${gapWords(markGap)} clear of ${passedSail}, ${heldTail}. ${serializeChip(onRun.t, decisive.boatId)}`
          : `At ${afterMark.raceClock} the lead read ${markLeader.sail}. ${serializeChip(onRun.t, markLeader.boatId)}`;
    }
  }

  steps.push({
    kind: "text",
    value:
      `${passSail} took the lead from ${passedSail} on the ${decisive.leg}.\n` +
      `At ${early.raceClock} ${passedSail} led the ${passed.leg} with ${passSail} ${gapWords(wasBehindBy)} back. ${serializeChip(earlyT, passed.boatId)}\n` +
      `By ${later.raceClock} ${passSail} had its bow in front, ${speedClause}. ${serializeChip(passT, decisive.boatId)}\n` +
      settledLine,
  });
  return steps;
}

function mockDownwind(race: RaceData): MockStep[] {
  const steps: MockStep[] = [];

  /* The window where every boat is on the run: from the last rounding boat's
   * first run sample to just before the first finisher. */
  let runFrom = -Infinity;
  for (const boat of race.boats) {
    const first = race.progress[boat.id].find((sample) => sample.leg === "run");
    if (first !== undefined && first.t > runFrom) runFrom = first.t;
  }
  let firstFinish = Infinity;
  for (const result of race.results) if (result.elapsed < firstFinish) firstFinish = result.elapsed;
  const from = Math.ceil(runFrom);
  const to = Math.floor(firstFinish);

  /* The window is the run, so every boat has a mark to make good toward and
   * the tool returns a figure for all of them. A side with none is dropped
   * rather than sorted as a NaN. */
  const entries: { boatId: string; sail: string; toMarkKnots: string }[] = [];
  const takeSide = (side: CompareOut["a"]): void => {
    if (side.avgToMarkKnots === null) return;
    entries.push({ boatId: side.boatId, sail: side.sail, toMarkKnots: side.avgToMarkKnots });
  };
  for (let i = 0; i + 1 < race.boats.length; i += 2) {
    const a = race.boats[i];
    const b = race.boats[i + 1];
    steps.push(statusStep(race, "compare_boats", { a: a.id, b: b.id }));
    const cmp = asCompare(compareBoats(race, a.id, b.id, from, to));
    takeSide(cmp.a);
    takeSide(cmp.b);
  }
  entries.sort(
    (a, b) =>
      Number(b.toMarkKnots) - Number(a.toMarkKnots) || (a.boatId < b.boatId ? -1 : 1),
  );
  const [top, next] = entries;

  steps.push(statusStep(race, "standings_at", { t: 60 }));
  const final = standingsAt(race, 60);
  const topRank = rowFor(final, top.boatId)?.rank ?? 0;
  const mid = Math.round((from + to) / 2);
  const finish =
    topRank === 1
      ? `It carried that pace all the way to the win.`
      : `The pace was not enough for the win: ${top.sail} finished ${ordinal(topRank)}.`;
  steps.push({
    kind: "text",
    value:
      `${top.sail} was the fastest boat downwind.\n` +
      `It averaged ${top.toMarkKnots} knots toward the mark between ${clock(from)} and ${clock(to)}, when the whole fleet was on the run. ${serializeChip(mid, top.boatId)}\n` +
      `${next.sail} was next at ${next.toMarkKnots}.\n` +
      finish,
  });
  return steps;
}

/* Anything the scripted answers do not cover. Saying so is the whole point:
 * without a model this route cannot read a new question, and answering it with
 * the standings as though it had would be the one dishonest thing in the
 * build. The standings still come from the tools, so the reader gets real
 * numbers and a straight account of why they are these ones. */
function mockStandings(race: RaceData): MockStep[] {
  const steps: MockStep[] = [statusStep(race, "standings_at", { t: 45 })];
  const mid = standingsAt(race, 45);
  steps.push(statusStep(race, "standings_at", { t: 60 }));
  const final = standingsAt(race, 60);
  const [lead, second, third] = mid.rows;
  const [w1, w2, w3] = final.rows;
  steps.push({
    kind: "text",
    value:
      `No model is answering right now, so this reply is a stand-in.\n` +
      `The three suggested questions are scripted and everything else gets the standings.\n` +
      `Set OPENROUTER_API_KEY to have a model read your question and call the tools itself.\n` +
      `At ${mid.raceClock} ${lead.sail} led on the ${lead.leg}, with ${second.sail} ${gapWords(second.gapSeconds)} back ` +
      `and ${third.sail} third at ${gapWords(third.gapSeconds)}. ${serializeChip(45, lead.boatId)}\n` +
      `By ${final.raceClock} the race was done: ${w1.sail} first, ${w2.sail} second, ${w3.sail} third. ${serializeChip(60)}`,
  });
  return steps;
}

/* The three scripted answers are matched against the selected race's own
 * suggested questions, in the order start, lead change, downwind. A question
 * written for another race falls through to the stand-in, which is the honest
 * answer: this route cannot read a question it was not given. */
function mockSteps(race: RaceData, meta: RaceMeta, question: string): MockStep[] {
  const [start, leadChange, downwind] = meta.suggestedQuestions;
  if (matches(question, start)) return mockStart(race);
  if (matches(question, leadChange)) return mockLeadChange(race);
  if (matches(question, downwind)) return mockDownwind(race);
  return mockStandings(race);
}

function mockResponse(race: RaceData, meta: RaceMeta, question: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const step of mockSteps(race, meta, question)) {
          if (step.kind === "status") {
            controller.enqueue(frame(SSE_STATUS, { label: step.value }));
            await delay(15);
            continue;
          }
          const chunks = step.value.match(/\S+\s*/g) ?? [step.value];
          for (const chunk of chunks) {
            controller.enqueue(frame(SSE_DELTA, { text: chunk }));
            await delay(12);
          }
        }
        controller.enqueue(frame(SSE_DONE, { ok: true }));
        controller.close();
      } catch {
        try {
          controller.close();
        } catch {
          /* stream already gone */
        }
      }
    },
  });
  return sseResponse(stream);
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Live mode                                                           */

/* Best-effort spend guard for the paid path. Serverless instances each keep
 * their own book, and a cold start empties it, so this bounds casual abuse
 * per warm instance rather than promising a durable quota; the provider
 * spend cap is the real ceiling. Mock mode never reaches it. */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const rateBook = new Map<string, { count: number; windowStart: number }>();

/* Who to bill a request to. A caller can send any x-forwarded-for it likes and
 * rotate it every request, which would hand each one a fresh bucket, so the
 * platform's own header wins and the fallback takes the LAST hop in the chain,
 * the one the trusted proxy appended, not the first one the client wrote. */
function callerKey(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real !== undefined && real !== "") return real;
  const chain = req.headers.get("x-forwarded-for");
  if (chain === null) return "local";
  const hops = chain.split(",").map((hop) => hop.trim()).filter((hop) => hop !== "");
  return hops.length === 0 ? "local" : hops[hops.length - 1];
}

function rateLimited(req: Request, now: number): boolean {
  const ip = callerKey(req);
  const entry = rateBook.get(ip);
  if (entry === undefined || now - entry.windowStart >= RATE_WINDOW_MS) {
    if (rateBook.size > 500) {
      for (const [key, value] of rateBook) {
        if (now - value.windowStart >= RATE_WINDOW_MS) rateBook.delete(key);
      }
    }
    rateBook.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

/* OpenRouter wire shapes, chat completions format. Only the fields this
 * route reads are typed; everything else in a chunk is ignored. */
interface ToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallWire[];
  tool_call_id?: string;
}

interface StreamChunk {
  error?: { message?: string; code?: number | string };
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
}

class UpstreamError extends Error {
  constructor(readonly status: number) {
    super(`upstream ${status}`);
  }
}

function liveResponse(
  race: RaceData,
  meta: RaceMeta,
  history: AnalystMessage[],
  clientSignal: AbortSignal,
): Response {
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const tools = ANALYST_TOOLS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      strict: tool.strict,
      parameters: tool.input_schema,
    },
  }));
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(race, meta.venue) },
    ...history.map((turn): ChatMessage => ({ role: turn.role, content: turn.content })),
  ];

  /* One aborter covers both ways a viewer leaves: the request signal firing
   * and the response stream being cancelled. Without it the upstream keeps
   * generating, and billing, until the completion finishes. */
  const aborter = new AbortController();
  if (clientSignal.aborted) aborter.abort();
  else clientSignal.addEventListener("abort", () => aborter.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: object): void => {
        controller.enqueue(frame(event, data));
      };

      /* One completion round: collect the round's content and assemble any
       * tool-call fragments by index. Content is NOT streamed through here:
       * models narrate their plan inside tool rounds ("I'll check the start
       * report."), and that talk is not the answer. The caller drops a tool
       * round's text and streams a final round's text itself. */
      const runRound = async (
        wire: ChatMessage[],
        useTools: boolean,
      ): Promise<{ finish: string; calls: ToolCallWire[]; text: string }> => {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          signal: aborter.signal,
          headers: {
            authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "content-type": "application/json",
            "http-referer": "https://fullbuild.ai",
            "x-title": "Layline Debrief",
          },
          body: JSON.stringify({
            model,
            max_tokens: 700,
            temperature: 0.2,
            stream: true,
            /* Reasoning models burn the token budget on hidden thinking and
             * can stream an empty answer; the analyst wants the words. Models
             * without a reasoning mode ignore this. */
            reasoning: { enabled: false },
            messages: wire,
            ...(useTools ? { tools } : {}),
          }),
        });
        if (!res.ok || res.body === null) throw new UpstreamError(res.status);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finish = "";
        let text = "";
        const parts: { id: string; name: string; args: string }[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "" || data === "[DONE]") continue;
            let chunk: StreamChunk;
            try {
              chunk = JSON.parse(data) as StreamChunk;
            } catch {
              continue;
            }
            /* A failure after the 200 header arrives as an error chunk inside
             * the stream; swallowing it would end an empty answer with done. */
            if (chunk.error !== undefined) {
              const code = Number(chunk.error.code);
              throw new UpstreamError(Number.isFinite(code) ? code : 502);
            }
            const choice = chunk.choices?.[0];
            if (choice === undefined) continue;
            if (choice.finish_reason === "error") throw new UpstreamError(502);
            if (typeof choice.delta?.content === "string" && choice.delta.content !== "") {
              text += choice.delta.content;
            }
            for (const fragment of choice.delta?.tool_calls ?? []) {
              const slot = (parts[fragment.index] ??= { id: "", name: "", args: "" });
              if (fragment.id !== undefined) slot.id = fragment.id;
              if (fragment.function?.name !== undefined) slot.name = fragment.function.name;
              if (fragment.function?.arguments !== undefined) slot.args += fragment.function.arguments;
            }
            if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
          }
        }
        const calls = parts
          .filter((part) => part.name !== "")
          .map((part, index) => ({
            id: part.id === "" ? `call_${index}` : part.id,
            type: "function" as const,
            function: { name: part.name, arguments: part.args === "" ? "{}" : part.args },
          }));
        return { finish, calls, text };
      };

      try {
        const startedAt = Date.now();
        /* What every tool returned, kept flat. The last round is asked from a
         * clean thread rather than this one, and this is the evidence it
         * carries across. */
        const toolLog: string[] = [];
        let toolRounds = 0;
        let forced = false;
        let wire = messages;
        for (;;) {
          const { finish, calls, text } = await runRound(wire, !forced);

          if (forced || finish !== "tool_calls" || calls.length === 0) {
            const answer = normalizeAnswerShape(stripPlanTalk(text).trim());
            if (answer === "") {
              /* A model that stops without words gave no answer; done would
               * make the UI accept the silence as one. */
              send(SSE_ERROR, { message: "The analyst dropped the connection. Ask again." });
              controller.close();
              return;
            }
            /* The finished answer, re-chunked word by word so the reader
             * still watches it type; a tool round's text never gets here. */
            const words = answer.split(/(?<=\s)/);
            for (let index = 0; index < words.length; index += 2) {
              send(SSE_DELTA, { text: words.slice(index, index + 2).join("") });
              await delay(12);
            }
            send(SSE_DONE, { ok: true });
            controller.close();
            return;
          }
          toolRounds += 1;

          messages.push({ role: "assistant", content: null, tool_calls: calls });
          for (const call of calls) {
            let input: object;
            try {
              input = JSON.parse(call.function.arguments) as object;
            } catch {
              input = {};
            }
            send(SSE_STATUS, { label: toolStatusLabel(race, call.function.name, input) });
            const result = runTool(race, call.function.name, input);
            toolLog.push(`${call.function.name}(${call.function.arguments})\n${result}`);
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }

          /* Out of rounds or out of clock. The results just gathered are enough
           * to answer with, so ask for the answer instead of sending an error
           * and dropping every round the viewer already waited through.
           *
           * The ask goes on a fresh thread carrying the same system prompt,
           * the same conversation and the tool results as plain text, because
           * a thread full of tool calls is a format the model copies: asked on
           * the working thread with the tools taken away, it types its own
           * call markup out as prose instead of answering. */
          if (toolRounds >= MAX_TOOL_ROUNDS || Date.now() - startedAt >= TOOL_BUDGET_MS) {
            forced = true;
            wire = [
              ...messages.slice(0, 1 + history.length),
              { role: "user", content: `${ANSWER_NOW}\n\n${toolLog.join("\n\n")}` },
            ];
          }
        }
      } catch (error) {
        if (aborter.signal.aborted) {
          /* The viewer left; nobody is reading. Close without an error frame. */
          try {
            controller.close();
          } catch {
            /* stream already gone */
          }
          return;
        }
        const message =
          error instanceof UpstreamError && error.status === 429
            ? "The analyst is busy. Give it a minute."
            : error instanceof UpstreamError && [401, 402, 403].includes(error.status)
              ? "The analyst is offline right now."
              : "The analyst dropped the connection. Ask again.";
        try {
          controller.enqueue(frame(SSE_ERROR, { message }));
          controller.close();
        } catch {
          /* client already went away */
        }
      }
    },
    cancel() {
      aborter.abort();
    },
  });
  return sseResponse(stream);
}

/* ------------------------------------------------------------------ */

export async function POST(req: Request): Promise<Response> {
  if (sameOriginRefused(req)) {
    return jsonError(403, "cross-origin request refused");
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonError(400, "unreadable request body");
  }

  const validated = validate(payload);
  if (!Array.isArray(validated)) {
    return jsonError(validated.status, validated.error);
  }

  /* Which race the question is about. A missing id is the shipped race, which
   * keeps the story page's request shape working unchanged. Anything else has
   * to name a race in the registry: a raw seed would be an unaudited race and a
   * generateRace per request. */
  const asked = (payload as { raceId?: unknown }).raceId;
  const raceId = asked === undefined ? DEFAULT_RACE_ID : asked;
  if (typeof raceId !== "string") {
    return jsonError(400, "raceId must be a string");
  }
  const meta = raceMeta(raceId);
  const race = meta === undefined ? null : raceFor(raceId);
  if (meta === undefined || race === null) {
    return jsonError(400, "no such race");
  }

  if (process.env.LAYLINE_ANALYST_MOCK === "1") {
    return mockResponse(race, meta, validated[validated.length - 1].content);
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return jsonError(503, "analyst offline");
  }

  if (rateLimited(req, Date.now())) {
    return jsonError(429, "too many requests, give it a minute");
  }

  return liveResponse(race, meta, validated, req.signal);
}
