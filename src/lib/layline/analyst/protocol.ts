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
 * gun, USA 4 took the lead on the beat at 0:28 and won, and the run has a
 * clear fastest boat by speed made good to the mark. */
export const SUGGESTED_QUESTIONS = [
  "Who won the start",
  "How did USA 4 take the lead",
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
