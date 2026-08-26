/**
 * Debrief protocol: the contract between the analyst route and the client.
 *
 * This file is imported on both sides of the wire, so it stays free of
 * dependencies: no SDK types, no React, no sim. Types, limits, SSE event
 * names, and the chip grammar live here so neither side can drift from the
 * other.
 */

export type AnalystRole = "user" | "assistant";

export interface AnalystMessage {
  role: AnalystRole;
  content: string;
}

/* Request limits, enforced by the route and respected by the client. */
export const MAX_TURNS = 8;
export const MAX_MESSAGE_CHARS = 400;

/* SSE event names. The stream is content-type text/event-stream and every
 * frame is one of these four, each carrying a single JSON object. */
export const SSE_STATUS = "status";
export const SSE_DELTA = "delta";
export const SSE_DONE = "done";
export const SSE_ERROR = "error";

export interface StatusEventData {
  label: string;
}

export interface DeltaEventData {
  text: string;
}

export interface DoneEventData {
  ok: boolean;
}

export interface ErrorEventData {
  message: string;
}

/* The three suggestion cards. The client renders these verbatim; the mock
 * route matches an incoming question against them by prefix. Each is checked
 * against the seeded race before shipping: JPN 18 crossed first after the
 * gun, took the lead on the beat at 0:20 and won, and the run has a
 * clear fastest boat by speed made good to the mark. */
export const SUGGESTED_QUESTIONS = [
  "Who won the start",
  "How did JPN 18 take the lead",
  "Which boat was fastest downwind",
] as const;

/**
 * Chip grammar, the only markup in an analyst answer. `[[t=32.9]]` is a bare
 * moment; `[[t=32.9|nzl]]` ties the moment to a boat by its lowercase id.
 * Everything outside a chip is plain text.
 */
export type AnalystSegment =
  | { kind: "text"; text: string }
  | { kind: "chip"; t: number; boatId?: string };

const CHIP_RE = /\[\[t=(-?\d+(?:\.\d+)?)(?:\|([a-z][a-z0-9]*))?\]\]/g;

/** Split answer text into plain-text and chip segments, in order. */
export function parseChips(text: string): AnalystSegment[] {
  const segments: AnalystSegment[] = [];
  let cursor = 0;
  CHIP_RE.lastIndex = 0;
  for (let match = CHIP_RE.exec(text); match !== null; match = CHIP_RE.exec(text)) {
    if (match.index > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    const chip: AnalystSegment = { kind: "chip", t: Number(match[1]) };
    if (match[2] !== undefined) chip.boatId = match[2];
    segments.push(chip);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

/** Render a chip back to its wire form. Time keeps one decimal at most. */
export function serializeChip(t: number, boatId?: string): string {
  const stamp = String(Math.round(t * 10) / 10);
  return boatId === undefined ? `[[t=${stamp}]]` : `[[t=${stamp}|${boatId}]]`;
}

const MAX_ANSWER_LINES = 5;
const CHIP_ONLY_RE = /^(?:\[\[t=-?\d+(?:\.\d+)?(?:\|[a-z][a-z0-9]*)?\]\]\s*)+$/;

/**
 * Keep a live model's finished answer in the same lead plus evidence shape as
 * the deterministic analyst. The model usually follows the newline rule, but
 * a longer synthesis can arrive as one paragraph. Sentence segmentation runs
 * only when the shape is missing or too long, and a chip emitted after its
 * sentence stays attached to that sentence.
 */
export function normalizeAnswerShape(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length >= 2 && lines.length <= MAX_ANSWER_LINES) return lines.join("\n");

  const sentences: string[] = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const blocks = lines.join(" ").replace(/(\]\])\s+(?=\S)/g, "$1\n").split("\n");
  for (const block of blocks) {
    for (const { segment } of segmenter.segment(block)) {
      const sentence = segment.trim();
      if (sentence === "") continue;
      if (CHIP_ONLY_RE.test(sentence) && sentences.length > 0) {
        sentences[sentences.length - 1] += ` ${sentence}`;
      } else {
        sentences.push(sentence);
      }
    }
  }
  if (sentences.length <= 1) return lines.join("\n");
  if (sentences.length <= MAX_ANSWER_LINES) return sentences.join("\n");

  const answerLines = [sentences[0]];
  const evidence = sentences.slice(1);
  const perLine = Math.ceil(evidence.length / (MAX_ANSWER_LINES - 1));
  for (let index = 0; index < evidence.length; index += perLine) {
    answerLines.push(evidence.slice(index, index + perLine).join(" "));
  }
  return answerLines.join("\n");
}
