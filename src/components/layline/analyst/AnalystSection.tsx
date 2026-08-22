"use client";

import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { clock } from "@/lib/layline/format";
import { FIX_HZ, type BoatMeta } from "@/lib/layline/types";
import {
  MAX_MESSAGE_CHARS,
  MAX_TURNS,
  SSE_DELTA,
  SSE_DONE,
  SSE_ERROR,
  SSE_STATUS,
  SUGGESTED_QUESTIONS,
  parseChips,
  type AnalystMessage,
} from "@/lib/layline/analyst/protocol";
import { raceData, useReplay } from "../store";
import { CourseBackdrop } from "./CourseBackdrop";
import { MomentStrip, type StripBuoy } from "./MomentStrip";
import { TrackGlyph } from "./TrackGlyph";
import styles from "./analyst.module.css";

/* The route caps a message at MAX_MESSAGE_CHARS and a request at MAX_TURNS,
 * so the client holds the same line: the input stops at the cap and only the
 * last MAX_TURNS turns travel. An analyst turn can run past the cap on
 * screen; the copy that goes back as history is clipped rather than bounced
 * by the route. Suggestion cards render SUGGESTED_QUESTIONS verbatim so the
 * mock route's prefix match always lands. */
const DROPPED_LINE = "The analyst dropped the connection. Ask again.";

interface Turn {
  role: "user" | "analyst";
  text: string;
}

interface SsePayload {
  label?: string;
  text?: string;
  message?: string;
  ok?: boolean;
}

/* One SSE frame: `event:` and `data:` lines up to a blank line. */
function parseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (data === "") return null;
  return { event, data };
}

/* Mid-stream, a chip can arrive half open ("[[t=3"), and half a chip printed
 * as text would flash markup at the reader. The tail past an unclosed "[[" is
 * held back until the close lands; the full text always renders once done. */
function trimOpenChip(text: string): string {
  const open = text.lastIndexOf("[[");
  if (open === -1) return text;
  if (text.indexOf("]]", open) !== -1) return text;
  return text.slice(0, open);
}

function ChipButton({
  t,
  boatId,
  fleet,
  onChip,
}: {
  t: number;
  boatId?: string;
  fleet: Map<string, BoatMeta>;
  onChip: (t: number, boatId?: string) => void;
}) {
  const boat =
    boatId === undefined ? undefined : (fleet.get(boatId) ?? fleet.get(boatId.toLowerCase()));
  const stamp = clock(t);
  return (
    <button
      type="button"
      className={styles.chip}
      style={{ "--chip-hue": boat === undefined ? "var(--wind)" : boat.hue } as CSSProperties}
      onClick={() => onChip(t, boat?.id)}
      aria-label={
        boat === undefined
          ? `Jump the replay to ${stamp}`
          : `Jump the replay to ${stamp} and follow ${boat.sail}`
      }
    >
      <span
        className={clsx(styles.chipSwatch, boat?.dark === true && styles.chipSwatchOutlined)}
        style={{ background: boat === undefined ? "var(--wind)" : boat.hue }}
        aria-hidden="true"
      />
      <span className={styles.chipTime}>{stamp}</span>
      {boat === undefined ? null : <span className={styles.chipSail}>{boat.sail}</span>}
    </button>
  );
}

/* Analyst prose with the chips swapped in as pills. Chips are the only markup
 * the protocol allows, so everything between them renders as plain text. */
function AnalystBody({
  text,
  live,
  fleet,
  onChip,
}: {
  text: string;
  live: boolean;
  fleet: Map<string, BoatMeta>;
  onChip: (t: number, boatId?: string) => void;
}) {
  const display = live ? trimOpenChip(text) : text;
  return (
    <p className={styles.turnText}>
      {parseChips(display).map((part, index) =>
        part.kind === "chip" ? (
          <ChipButton key={index} t={part.t} boatId={part.boatId} fleet={fleet} onChip={onChip} />
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

export function AnalystSection() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  /* Latches on the first ask and never resets: the backdrop's after-the-gun
   * tracks wipe in once and stay, whatever later answers hold. */
  const [raced, setRaced] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useRef<HTMLOListElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const retryRef = useRef<Turn[] | null>(null);
  /* Boat metadata comes from the client's own seeded race build, same as the
   * replay itself; shipping RaceData over the server-component boundary would
   * put ~260 KB of telemetry in the page payload for six boats' names. */
  const fleet = useMemo(
    () => new Map<string, BoatMeta>(raceData().boats.map((boat) => [boat.id, boat])),
    [],
  );

  /* The event times the card glyphs draw between: USA 4's beat runs from the
   * gun to its rounding, JPN 18's run from its rounding to its finish. Read
   * from the seeded events so a data change redraws the cards by itself. */
  const eventMarks = useMemo(() => {
    const events = raceData().events;
    return {
      usaRounding: events.find((event) => event.kind === "rounding" && event.boatId === "usa"),
      jpnRounding: events.find((event) => event.kind === "rounding" && event.boatId === "jpn"),
      jpnFinish: events.find((event) => event.kind === "finish" && event.boatId === "jpn"),
    };
  }, []);

  /* The slate's instrument readings, all from the loaded race itself. The
   * clock stops when the last boat crosses, matching the replay's own end,
   * even though the fixes run on a few seconds past the line. */
  const slate = useMemo(() => {
    const race = raceData();
    let end = race.tMin;
    for (const result of race.results) if (result.elapsed > end) end = result.elapsed;
    return {
      end,
      boats: race.boats.length,
      fixes: Object.values(race.fixes).reduce((n, series) => n + series.length, 0),
      finishOrder: [...race.results]
        .sort((a, b) => a.rank - b.rank)
        .map((result) => fleet.get(result.boatId))
        .filter((boat): boat is BoatMeta => boat !== undefined),
    };
  }, [fleet]);

  /* What the latest finished answer cites: hot boats brighten their backdrop
   * tracks, every chip drops a lit buoy on the moment strip. Runs only when
   * the stream is idle, so a half-open chip can never feed it. */
  const { hot, buoys } = useMemo(() => {
    const result = { hot: new Set<string>(), buoys: [] as StripBuoy[] };
    if (streaming) return result;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn.role !== "analyst") continue;
      for (const part of parseChips(turn.text)) {
        if (part.kind !== "chip") continue;
        const boat =
          part.boatId === undefined
            ? undefined
            : (fleet.get(part.boatId) ?? fleet.get(part.boatId.toLowerCase()));
        if (boat !== undefined) result.hot.add(boat.id);
        result.buoys.push({
          t: part.t,
          hue: boat === undefined ? "var(--wind)" : boat.hue,
          dark: boat?.dark === true,
        });
      }
      break;
    }
    return result;
  }, [turns, streaming, fleet]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /* The newest words stay on screen. Instant, never smooth: this runs on every
   * delta, and a smooth scroll re-triggered forty times a second judders. */
  useEffect(() => {
    const node = threadRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [turns, status, errorLine]);

  const stream = useCallback(async (base: Turn[]) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    retryRef.current = base;
    setTurns(base);
    setErrorLine(null);
    setStatus(null);
    setStreaming(true);

    const messages: AnalystMessage[] = base.slice(-MAX_TURNS).map((turn) => ({
      role: turn.role === "analyst" ? "assistant" : "user",
      content: turn.text.slice(0, MAX_MESSAGE_CHARS),
    }));
    /* The Messages API requires a user-first history. With alternating turns,
     * an even-length window can open on an analyst turn; drop it so the wire
     * always carries user, assistant, ..., user. */
    if (messages[0]?.role === "assistant") messages.shift();

    /* A failed answer leaves the thread as it stood before the attempt: the
     * question, one plain line, a retry. A half-streamed turn resent as
     * history would also break the route's last-must-be-user rule. */
    const fail = (line: string) => {
      setTurns(base);
      setStatus(null);
      setStreaming(false);
      setErrorLine(line);
    };

    let answer = "";
    let finished = false;
    try {
      /* No content-type header on purpose. The route parses the body itself
       * without sniffing the header, and the standard MIME type for JSON
       * opens with a word the spec bans from every file. */
      const res = await fetch("/api/layline/analyst", {
        method: "POST",
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) {
        fail(DROPPED_LINE);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        for (;;) {
          const cut = buffer.indexOf("\n\n");
          if (cut === -1) break;
          const frame = parseFrame(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          if (frame === null) continue;
          let payload: SsePayload;
          try {
            payload = JSON.parse(frame.data) as SsePayload;
          } catch {
            continue;
          }
          if (frame.event === SSE_STATUS && typeof payload.label === "string") {
            setStatus(payload.label);
          } else if (frame.event === SSE_DELTA && typeof payload.text === "string") {
            answer += payload.text;
            setStatus(null);
            setTurns([...base, { role: "analyst", text: answer }]);
          } else if (frame.event === SSE_DONE) {
            finished = true;
          } else if (frame.event === SSE_ERROR) {
            fail(
              typeof payload.message === "string" && payload.message !== ""
                ? payload.message
                : DROPPED_LINE,
            );
            return;
          }
        }
      }
      if (!finished) {
        fail(DROPPED_LINE);
        return;
      }
      setStatus(null);
      setStreaming(false);
      setTurns(answer === "" ? base : [...base, { role: "analyst", text: answer }]);
    } catch {
      if (controller.signal.aborted) return;
      fail(DROPPED_LINE);
    }
  }, []);

  const ask = useCallback(
    (raw: string) => {
      const text = raw.trim().slice(0, MAX_MESSAGE_CHARS);
      if (text === "" || streaming) return;
      setInput("");
      inputRef.current?.focus();
      setRaced(true);
      void stream([...turns, { role: "user", text }]);
    },
    [streaming, stream, turns],
  );

  const retry = useCallback(() => {
    const base = retryRef.current;
    if (base === null || streaming) return;
    inputRef.current?.focus();
    void stream(base);
  }, [streaming, stream]);

  /* Chip click: put the replay on that moment. Seek, follow when the chip
   * names a boat, bring the console back into view. Play state, rate and rig
   * are the viewer's; a chip never touches them. */
  const jumpTo = useCallback((t: number, boatId?: string) => {
    const replay = useReplay.getState();
    replay.seek(t);
    if (boatId !== undefined) replay.follow(boatId);
    const target = document.getElementById("replay-console");
    if (target === null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  }, []);

  return (
    <section className={styles.debrief} aria-labelledby="debrief-heading">
      <div className={styles.head}>
        <div className={styles.headText}>
          <p className={styles.kicker}>Race analyst</p>
          <h2 id="debrief-heading" className={styles.heading}>
            Debrief
          </h2>
          <p className={styles.explainer}>
            Ask about the start, a shift, a rounding, any boat. Every number in an answer comes
            from the same race data the replay plays.
          </p>
        </div>
        {/* The broadcast ident: event line, full race clock, fleet in entry
            order. Pure repetition of what the console already says, so it is
            hidden from the tree. */}
        <div className={styles.raceIdent} aria-hidden="true">
          <p className={styles.identLine}>Fleet race · Long Beach</p>
          <div className={styles.identRow}>
            <p className={styles.identClock}>{clock(raceData().tMax)}</p>
            <div className={styles.fleetBar}>
              {raceData().boats.map((boat) => (
                <span
                  key={boat.id}
                  className={clsx(
                    styles.fleetBlock,
                    boat.dark === true && styles.fleetBlockOutlined,
                  )}
                  style={{ background: boat.hue }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div
        className={styles.panel}
        data-state={turns.length === 0 ? "empty" : streaming ? "streaming" : "answered"}
        data-raced={raced ? "true" : undefined}
      >
        <CourseBackdrop hot={hot} />
        <div className={styles.panelGrid}>
          <div className={styles.rail}>
            <h3 className={styles.railLabel}>Suggested questions</h3>
            <ul className={styles.suggestionList}>
              {SUGGESTED_QUESTIONS.map((question, index) => (
                <li key={question}>
                  <button
                    type="button"
                    className={styles.suggestion}
                    onClick={() => ask(question)}
                  >
                    <span className={styles.cardGlyph} aria-hidden="true">
                      {index === 0 ? (
                        <TrackGlyph boatId={null} from={0} to={0} hue="var(--wind)" />
                      ) : index === 1 ? (
                        <TrackGlyph
                          boatId="usa"
                          from={0}
                          to={eventMarks.usaRounding?.t ?? 0}
                          hue={fleet.get("usa")?.hue ?? "var(--wind)"}
                        />
                      ) : (
                        <TrackGlyph
                          boatId="jpn"
                          from={eventMarks.jpnRounding?.t ?? 0}
                          to={eventMarks.jpnFinish?.t ?? 0}
                          hue={fleet.get("jpn")?.hue ?? "var(--wind)"}
                          strokeWidth={2.5}
                        />
                      )}
                    </span>
                    <span className={styles.cardBody}>
                      <span className={styles.cardEyebrow} aria-hidden="true">
                        {index === 0
                          ? `Prestart · Gun ${clock(0)}`
                          : index === 1
                            ? `${fleet.get("usa")?.sail ?? ""} · The beat`
                            : `${fleet.get("jpn")?.sail ?? ""} · The run`}
                      </span>
                      <span className={styles.cardQuestion}>{question}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className={styles.railNote}>
              The analyst reads the same seeded telemetry as the replay and answers only from it.
            </p>
          </div>

          <div className={styles.conversation}>
            {turns.length === 0 ? (
              <div className={styles.slate}>
                {/* The loaded-race slate. Numbers repeat what the console and
                    the notes already publish, so the board is decorative; the
                    one sentence that instructs stays in the tree. */}
                <div className={styles.slateBoard} aria-hidden="true">
                  <p className={styles.slateEyebrow}>Race loaded</p>
                  <p className={styles.slateClock}>{clock(slate.end)}</p>
                  <div className={styles.slateStats}>
                    <div className={styles.slateStat}>
                      <span className={styles.slateStatLabel}>Boats</span>
                      <span className={styles.slateStatValue}>{slate.boats}</span>
                    </div>
                    <div className={styles.slateStat}>
                      <span className={styles.slateStatLabel}>Fix rate Hz</span>
                      <span className={styles.slateStatValue}>{FIX_HZ}</span>
                    </div>
                    <div className={styles.slateStat}>
                      <span className={styles.slateStatLabel}>Fixes</span>
                      <span className={styles.slateStatValue}>{slate.fixes}</span>
                    </div>
                  </div>
                  <div className={styles.fleetBar}>
                    {slate.finishOrder.map((boat) => (
                      <span
                        key={boat.id}
                        className={clsx(
                          styles.fleetBlock,
                          boat.dark === true && styles.fleetBlockOutlined,
                        )}
                        style={{ background: boat.hue }}
                      />
                    ))}
                  </div>
                </div>
                <p className={styles.emptyLine}>
                  The whole race is loaded. Tap a question or ask your own.
                </p>
              </div>
            ) : (
              <ol className={styles.thread} ref={threadRef} aria-label="Conversation">
                {turns.map((turn, index) => {
                  const live = streaming && turn.role === "analyst" && index === turns.length - 1;
                  return (
                    <li
                      key={index}
                      className={turn.role === "user" ? styles.userTurn : styles.analystTurn}
                      aria-live={live ? "polite" : undefined}
                    >
                      <span className={styles.turnLabel}>
                        {turn.role === "user" ? "You" : "Analyst"}
                      </span>
                      {turn.role === "user" ? (
                        <p className={styles.turnText}>{turn.text}</p>
                      ) : (
                        <AnalystBody text={turn.text} live={live} fleet={fleet} onChip={jumpTo} />
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            {status !== null ? (
              <p className={styles.statusLine} role="status">
                <span className={styles.statusDot} aria-hidden="true" />
                {status}
              </p>
            ) : null}

            {errorLine !== null ? (
              <div className={styles.errorRow}>
                <p className={styles.errorText}>{errorLine}</p>
                <button type="button" className={styles.retryButton} onClick={retry}>
                  Retry
                </button>
              </div>
            ) : null}

            <MomentStrip buoys={buoys} />

            <form
              className={styles.inputRow}
              onSubmit={(event) => {
                event.preventDefault();
                ask(input);
              }}
            >
              <input
                ref={inputRef}
                className={styles.input}
                type="text"
                value={input}
                maxLength={MAX_MESSAGE_CHARS}
                placeholder="Ask about any moment"
                aria-label="Ask the analyst"
                autoComplete="off"
                onChange={(event) => setInput(event.target.value.slice(0, MAX_MESSAGE_CHARS))}
              />
              {/* Never `disabled`: a disabled button drops out of the tab order,
                  and keyboard position on this page is never ambiguous. Empty or
                  mid-stream sends are no-ops in ask() instead. */}
              <button type="submit" className={styles.sendButton}>
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}
