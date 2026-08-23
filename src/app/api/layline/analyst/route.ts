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
import type { RaceData } from "@/lib/layline/types";
import { raceData } from "@/lib/layline/analyst/data";
import { buildSystemPrompt } from "@/lib/layline/analyst/prompt";
import {
  MAX_MESSAGE_CHARS,
  MAX_TURNS,
  SSE_DELTA,
  SSE_DONE,
  SSE_ERROR,
  SSE_STATUS,
  SUGGESTED_QUESTIONS,
  serializeChip,
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

const MAX_TOOL_ROUNDS = 4;
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
      `${first.sail} won the start ${firstChip}. At the gun it sat ${first.distanceToLineMeters} meters short of the line with ` +
      `${first.sogAtGunKnots} knots on, off the ${endWord(first.nearerEnd)} end, and it crossed ${first.crossedAfterGunSeconds} seconds ` +
      `after the gun, first in the fleet. ${second.sail} was next across at ${second.crossedAfterGunSeconds} seconds, ` +
      `from the ${endWord(second.nearerEnd)} end ${secondChip}.`,
  });
  return steps;
}

function gapWords(gapSeconds: number): string {
  if (gapSeconds <= 0) return "less than a second";
  return gapSeconds === 1 ? "1 second" : `${gapSeconds} seconds`;
}

function mockLeadChange(race: RaceData): MockStep[] {
  const steps: MockStep[] = [];
  steps.push(statusStep(race, "standings_at", { t: 20 }));
  const early = standingsAt(race, 20);
  steps.push(statusStep(race, "standings_at", { t: 30 }));
  const later = standingsAt(race, 30);
  const earlyLeader = early.rows[0];
  const laterLeader = later.rows[0];
  steps.push(statusStep(race, "compare_boats", { a: laterLeader.boatId, b: earlyLeader.boatId }));
  const cmp = asCompare(compareBoats(race, laterLeader.boatId, earlyLeader.boatId, 20, 30));
  steps.push(statusStep(race, "standings_at", { t: 35 }));
  const afterMark = standingsAt(race, 35);
  const wasBehindBy = rowFor(early, laterLeader.boatId)?.gapSeconds ?? 0;
  const markLeader = afterMark.rows[0];
  const markGap = rowFor(afterMark, earlyLeader.boatId)?.gapSeconds ?? 0;
  const markLine =
    markLeader.boatId === laterLeader.boatId && markLeader.leg !== "beat"
      ? `The pass stuck at the windward mark: ${laterLeader.sail} reached it first and settled onto the run ` +
        `${gapWords(markGap)} clear of ${earlyLeader.sail} ${serializeChip(35, laterLeader.boatId)}, and it led the rest of the way.`
      : `At 0:35 the lead read ${markLeader.sail} ${serializeChip(35, markLeader.boatId)}.`;
  steps.push({
    kind: "text",
    value:
      `At ${early.raceClock} ${earlyLeader.sail} led the beat with ${laterLeader.sail} ${gapWords(wasBehindBy)} back ` +
      `${serializeChip(20, earlyLeader.boatId)}. By ${later.raceClock} ${laterLeader.sail} had its bow in front ` +
      `${serializeChip(30, laterLeader.boatId)}, after averaging ${cmp.a.avgSogKnots} knots over the ground to ` +
      `${cmp.b.avgSogKnots} for ${earlyLeader.sail} through that stretch. ${markLine}`,
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
      `${top.sail} was the fastest boat downwind, averaging ${top.toMarkKnots} knots toward the mark between ${clock(from)} and ${clock(to)}, ` +
      `when the whole fleet was on the run ${serializeChip(mid, top.boatId)}. ${next.sail} was next at ${next.toMarkKnots}. ${finish}`,
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
      `No model is answering right now, so this reply is a stand-in: the three suggested questions are scripted and ` +
      `everything else gets the standings. Set OPENROUTER_API_KEY to have a model read your question and call the tools itself. ` +
      `Meanwhile, at ${mid.raceClock} ${lead.sail} led on the ${lead.leg} ${serializeChip(45, lead.boatId)}, ` +
      `with ${second.sail} ${gapWords(second.gapSeconds)} back and ${third.sail} third at ${gapWords(third.gapSeconds)}. ` +
      `By ${final.raceClock} the race was done: ${w1.sail} first, ${w2.sail} second, ${w3.sail} third ${serializeChip(60)}.`,
  });
  return steps;
}

function mockSteps(race: RaceData, question: string): MockStep[] {
  if (matches(question, SUGGESTED_QUESTIONS[0])) return mockStart(race);
  if (matches(question, SUGGESTED_QUESTIONS[1])) return mockLeadChange(race);
  if (matches(question, SUGGESTED_QUESTIONS[2])) return mockDownwind(race);
  return mockStandings(race);
}

function mockResponse(race: RaceData, question: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const step of mockSteps(race, question)) {
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

/* Small models open their final answer with plan talk ("Let me check the
 * downwind legs.") despite the prompt. Leading paragraphs that read as
 * planning are dropped, but only while a real paragraph remains after them,
 * so an answer can never strip to nothing. */
const PLAN_TALK = /^(let me|i'll|i will|i am going to|i'm going to|first,? let me|now let me|okay,? let|i need to)/i;

function stripPlanTalk(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  while (paragraphs.length > 1 && PLAN_TALK.test(paragraphs[0].trim())) {
    paragraphs.shift();
  }
  return paragraphs.join("\n\n");
}

function liveResponse(
  race: RaceData,
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
    { role: "system", content: buildSystemPrompt(race) },
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
      const runRound = async (): Promise<{ finish: string; calls: ToolCallWire[]; text: string }> => {
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
            messages,
            tools,
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
        let toolRounds = 0;
        for (;;) {
          const { finish, calls, text } = await runRound();

          if (finish !== "tool_calls" || calls.length === 0) {
            const answer = stripPlanTalk(text).trim();
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
          if (toolRounds >= MAX_TOOL_ROUNDS) {
            send(SSE_ERROR, { message: "The analyst ran long. Ask a narrower question." });
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
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: runTool(race, call.function.name, input),
            });
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

  const race = raceData();

  if (process.env.LAYLINE_ANALYST_MOCK === "1") {
    return mockResponse(race, validated[validated.length - 1].content);
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return jsonError(503, "analyst offline");
  }

  if (rateLimited(req, Date.now())) {
    return jsonError(429, "too many requests, give it a minute");
  }

  return liveResponse(race, validated, req.signal);
}
