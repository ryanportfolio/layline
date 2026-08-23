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
import { SlateReplay } from "./SlateReplay";
import { TrackGlyph } from "./TrackGlyph";
import { useMounted } from "./useMounted";
import styles from "./analyst.module.css";

/* The route caps a message at MAX_MESSAGE_CHARS and a request at MAX_TURNS,
 * so the client holds the same line: the input stops at the cap and only the
 * last MAX_TURNS turns travel. An analyst turn can run past the cap on
 * screen; the copy that goes back as history is clipped rather than bounced
 * by the route. Suggestion cards render SUGGESTED_QUESTIONS verbatim so the
 * mock route's prefix match always lands. */
const DROPPED_LINE = "The analyst dropped the connection. Ask again.";

/* ---- the composer's two states ------------------------------------------
 *
 * A text field on a dark panel with a rule-coloured border reads as a caption,
 * not a control, so the box carries a visible edge at rest and the empty field
 * types one of the suggested questions into itself: the same three strings the
 * cards beside it use, already checked against the seeded race.
 *
 * Idle, the fleet leaves the line across the field every few seconds. Focused,
 * the six hues run the perimeter, one lap every 4.4 seconds. The lap is drawn
 * from the field's measured pixel size rather than a stretched viewBox, so the
 * dashes hold their length and speed on every edge and through every corner.
 * Neither runs for a viewer who asked for less motion. */
const TYPE_MS = 46; // per character, about 22 a second
const HOLD_MS = 2600; // the finished question sits long enough to read twice
const FADE_MS = 420; // matches the CSS transition below
const NEXT_MS = 260; // dark between one question and the next

/**
 * The suggested questions typing themselves into the empty field.
 *
 * Two things keep it smooth. The line fades out and the next one types in
 * rather than backspacing: a 30 character rewind at any speed reads as a
 * glitch, and the fade is the same 420ms the rest of the panel eases with.
 * And the state lives here rather than in the section, so a character costs
 * one paragraph re-render instead of re-rendering the whole Debrief panel,
 * the course backdrop and the slate's drawing sixty times a question.
 */
function TypedHint({ active }: { active: boolean }) {
  const [line, setLine] = useState<{ text: string; out: boolean }>({ text: "", out: false });
  const at = useRef({ question: 0, char: 0 });

  useEffect(() => {
    if (!active) {
      setLine({ text: "", out: false });
      at.current = { question: 0, char: 0 };
      return;
    }
    let timer = 0;
    const type = () => {
      const state = at.current;
      const target = SUGGESTED_QUESTIONS[state.question];
      state.char += 1;
      setLine({ text: target.slice(0, state.char), out: false });
      if (state.char < target.length) {
        timer = window.setTimeout(type, TYPE_MS);
        return;
      }
      timer = window.setTimeout(() => {
        setLine((current) => ({ ...current, out: true }));
        timer = window.setTimeout(() => {
          state.question = (state.question + 1) % SUGGESTED_QUESTIONS.length;
          state.char = 0;
          setLine({ text: "", out: false });
          timer = window.setTimeout(type, NEXT_MS);
        }, FADE_MS);
      }, HOLD_MS);
    };
    timer = window.setTimeout(type, 700);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (line.text === "") return null;
  return (
    <p className={styles.typedLine} data-out={line.out ? "true" : "false"} aria-hidden="true">
      {line.text}
      <span className={styles.typedCaret} />
    </p>
  );
}

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
  const [composerFocused, setComposerFocused] = useState(false);
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

  /* The composer's two idle layers. Both are client-only: the typed line and
   * the measured lap would not survive a hydration diff, and neither has
   * anything to say to a viewer who asked for less motion. */
  const mounted = useMounted();
  const reducedMotion = useReplay((state) => state.reducedMotion);
  const idleComposer = mounted && !reducedMotion && !composerFocused && input === "";
  /* The relay reads the fleet's own liveries, so a livery change moves the
     baton with it. Six stops, entry order, straight into the conic gradient
     the stylesheet spins. */
  const relayHues = useMemo(
    () =>
      Object.fromEntries(
        raceData().boats.map((boat, index) => [`--relay-${index + 1}`, boat.hue]),
      ) as CSSProperties,
    [],
  );
  /* Five lanes, the front of the fleet in finish order, so the sweep is the
     boats that led crossing the field rather than a decorative gradient. */
  const lanes = useMemo(() => {
    const race = raceData();
    const byRank = [...race.results].sort((a, b) => a.rank - b.rank).slice(0, 5);
    return byRank
      .map((result) => race.boats.find((boat) => boat.id === result.boatId))
      .filter((boat): boat is BoatMeta => boat !== undefined);
  }, []);

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
    <section className={styles.debrief} aria-labelledby="debrief-heading" data-leg="Debrief">
      <div className={styles.head}>
        <div className={styles.headText}>
          <p className={styles.kicker}>Race analyst</p>
          <h2 id="debrief-heading" className={styles.heading}>
            Debrief
          </h2>
          <p className={styles.explainer}>
            Ask about any boat or race phase
            <br />
            Answers cite the same telemetry and link back to the exact moment in the replay
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
                {/* The race sailing itself, from above, beside the readings it
                    is drawn from. The course is about as tall as it is wide, so
                    the drawing takes the square half and the numbers stack in
                    the column next to it. */}
                <div className={styles.slateBoard} aria-hidden="true">
                  {mounted ? (
                    <SlateReplay reduced={reducedMotion} />
                  ) : (
                    <div className={styles.slateChart} />
                  )}
                  <div className={styles.slateReadings}>
                    <p className={styles.slateEyebrow}>Race loaded</p>
                    <div className={styles.slateStats}>
                      <div className={styles.slateStat}>
                        <span className={styles.slateStatLabel}>Boats</span>
                        <span className={styles.slateStatValue}>{slate.boats}</span>
                      </div>
                      <div className={styles.slateStat}>
                        <span className={styles.slateStatLabel}>Samples / sec</span>
                        <span className={styles.slateStatValue}>{FIX_HZ}</span>
                      </div>
                      <div className={styles.slateStat}>
                        <span className={styles.slateStatLabel}>Samples</span>
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
              <div
                className={styles.field}
                data-focused={composerFocused ? "true" : "false"}
                data-idle={idleComposer ? "true" : "false"}
                data-hint={idleComposer && !streaming ? "true" : "false"}
                style={relayHues}
              >
                {/* Under the text, not across it: the field's ground moved out
                    to the box so the lanes can pass behind the words the way
                    water passes behind a hull. */}
                {idleComposer ? (
                  <div className={styles.wakeLanes} aria-hidden="true">
                    {lanes.map((boat, index) => (
                      <span
                        key={boat.id}
                        className={styles.wakeLane}
                        style={
                          {
                            top: `calc(100% - ${13 - index * 3}px)`,
                            background: `linear-gradient(90deg, transparent, ${boat.hue})`,
                            animationDelay: `${index * 190}ms`,
                          } as CSSProperties
                        }
                      />
                    ))}
                  </div>
                ) : null}
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
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                />
                {/* The question typing itself into the empty field. Decoration
                    over a real placeholder that stays in the markup, so the
                    hint survives with JavaScript off and in the tree. */}
                <TypedHint active={idleComposer && !streaming} />
                {/* The fleet sailing a lap of your question, focused. */}
              </div>
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
