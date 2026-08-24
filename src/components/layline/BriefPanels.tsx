"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  briefFacts,
  prestartTrace,
  windReading,
  windReadingAt,
  type BriefFacts,
  type WindReading,
} from "@/lib/layline/brief";
import type { RaceData } from "@/lib/layline/types";
import styles from "./bootSea.module.css";
import { useReplay } from "./store";

/**
 * The race brief: what the boot cover shows while the renderer warms.
 *
 * The cover used to name the race and wait. It now spends the wait stating the
 * race: the fleet and where each hull sat on the line at the gun, the breeze
 * running live off the seed, and what the line is worth in it. Every figure
 * comes out of the same RaceData the replay is about to play, through the same
 * evaluator the instrument dock reads, so nothing here can disagree with the
 * race behind it. See lib/layline/brief.ts for where each one is read from.
 *
 * The brief is a gate as well as a picture. Continue, or Enter, releases it,
 * and the replay's autoplay waits on that release rather than running the
 * prestart off behind a cover.
 *
 * It writes its live readings straight into the DOM off the shell's clock, the
 * way the instrument dock does: a countdown that re-rendered a fleet list sixty
 * times a second would cost more than it reports.
 */

/* Points in the wind trace under the dial. Six a second across the prestart,
 * which draws the curve between the 1 Hz samples rather than the samples. */
const TRACE_STEPS = 60;

/* The trace's own vertical window, m/s. The sim clamps tws to 6.2 to 8.7
 * (buildWind in lib/layline/sim.ts), so the whole series fits inside it and
 * the curve never leaves the box. */
const TRACE_LO = 6.2;
const TRACE_HI = 8.7;

/* m/s to knots. The one conversion, at the display edge, as format.ts has it. */
const KNOTS = 1.94384;

/* The diagram's half width in viewBox units. The line's two ends land on it
 * exactly, so a boat's place on the line is its own meters scaled once. */
const LINE_SPAN = 37;

function signed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return value >= 0 && !text.startsWith("-") ? `+${text}` : text;
}

function setText(node: { textContent: string | null } | null, text: string): void {
  if (node !== null && node.textContent !== text) node.textContent = text;
}

function setAttr(node: Element | null, name: string, value: string): void {
  if (node !== null && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function endLabel(favored: WindReading["favored"]): string {
  return favored === "pin" ? "pin" : favored === "boat" ? "committee boat" : "square";
}

function traceY(tws: number): number {
  const u = (tws - TRACE_LO) / (TRACE_HI - TRACE_LO);
  return 22 - (u < 0 ? 0 : u > 1 ? 1 : u) * 20;
}

function boatX(gunX: number, half: number): number {
  const u = half > 0 ? gunX / half : 0;
  const x = 50 + (u < -1 ? -1 : u > 1 ? 1 : u) * LINE_SPAN;
  return x < 15 ? 15 : x > 85 ? 85 : x;
}

/* The dial is the console's own, from hud/WindDial.tsx, at the same viewBox and
 * the same numbers: radius 16 on a 40 box, four cardinal ticks and no others,
 * the plus or minus 8 degree survey band the course was laid out for, and an
 * amber needle from the hub with no tail.
 *
 * The first draft of this layer drew a different instrument: twelve ticks, a
 * white needle, a counterweight below the hub. Twelve ticks and a two-ended
 * hand is a clock, and the reader read it as one. This is the same dial the
 * instrument dock puts up thirty seconds later, so the brief and the console
 * agree about what a wind dial looks like as well as about what the wind is. */
const DIAL_R = 16;
const DIAL_C = 20;
const SURVEY_DEG = 8;

function rim(angle: number, radius: number): string {
  const a = (angle * Math.PI) / 180;
  return `${(DIAL_C + radius * Math.sin(a)).toFixed(3)} ${(DIAL_C - radius * Math.cos(a)).toFixed(3)}`;
}

const BAND = `M ${DIAL_C} ${DIAL_C} L ${rim(-SURVEY_DEG, DIAL_R)} A ${DIAL_R} ${DIAL_R} 0 0 1 ${rim(SURVEY_DEG, DIAL_R)} Z`;

/**
 * The panel view of the race brief: the fleet at the line, the breeze on a
 * dial with its trace, and what the line is worth in it, read as three
 * separate plates side by side.
 *
 * One of the two views RaceBrief switches between, and the one the cover opens
 * on. It owns its own drawing and its own paint; the shell owns the prestart
 * clock, the header, the footer, the gate and the switch itself.
 */
export function BriefPanels({
  race,
  reduced,
}: {
  race: RaceData;
  reduced: boolean;
}) {
  const facts: BriefFacts = useMemo(() => briefFacts(race), [race]);
  const trace = useMemo(() => prestartTrace(race, TRACE_STEPS), [race]);
  const reading = useRef<WindReading>(windReading());

  /* The instant the server renders, and the instant a viewer who asked for
   * less motion keeps: the first fix in the feed, the top of the prestart. */
  const seed = useMemo(
    () => windReadingAt(race, facts, race.tMin, windReading()),
    [race, facts],
  );

  const root = useRef<HTMLDivElement>(null);
  const gunIn = useRef<HTMLSpanElement>(null);
  const needle = useRef<SVGGElement>(null);
  const twsBig = useRef<HTMLSpanElement>(null);
  const traceDot = useRef<SVGCircleElement>(null);
  const biasDeg = useRef<HTMLDivElement>(null);
  const biasSec = useRef<HTMLDivElement>(null);
  const favEnd = useRef<HTMLElement>(null);
  const favBy = useRef<HTMLSpanElement>(null);
  const favSec = useRef<HTMLSpanElement>(null);
  const favPin = useRef<SVGPolygonElement>(null);
  const favBoat = useRef<SVGPolygonElement>(null);
  const windArrow = useRef<SVGGElement>(null);
  const windTag = useRef<SVGTextElement>(null);
  const twdTag = useRef<HTMLSpanElement>(null);

  const paint = useCallback(
    (t: number) => {
      const read = windReadingAt(race, facts, t, reading.current);
      setAttr(needle.current, "transform", `rotate(${read.twd.toFixed(2)} 20 20)`);
      setText(twsBig.current, (read.tws * KNOTS).toFixed(1));
      const u = (t - facts.tMin) / (0 - facts.tMin);
      setAttr(traceDot.current, "cx", ((u < 0 ? 0 : u > 1 ? 1 : u) * 100).toFixed(1));
      setAttr(traceDot.current, "cy", traceY(read.tws).toFixed(1));
      setText(biasDeg.current, `${signed(read.twd, 1)}°`);
      setText(biasSec.current, `${read.biasSeconds.toFixed(1)} s`);
      setText(favEnd.current, endLabel(read.favored));
      setText(favSec.current, `${read.biasSeconds.toFixed(1)} s`);
      if (favBy.current !== null) {
        const by = read.favored === "square" ? "none" : "";
        if (favBy.current.style.display !== by) favBy.current.style.display = by;
      }
      if (favPin.current !== null) favPin.current.style.opacity = read.favored === "pin" ? "1" : "0";
      if (favBoat.current !== null) {
        favBoat.current.style.opacity = read.favored === "boat" ? "1" : "0";
      }
      setAttr(windArrow.current, "transform", `rotate(${read.twd.toFixed(1)} 50 12)`);
      setText(windTag.current, `TWD ${signed(read.twd, 0)}°`);
      setText(twdTag.current, `${signed(read.twd, 0)}°`);
      setText(gunIn.current, `gun in ${Math.max(0, -t).toFixed(1)} s`);
    },
    [race, facts],
  );

  /**
   * The prestart, read off the replay's own clock.
   *
   * This view paints; it never drives. RaceBrief runs the loop that seeks the
   * store, so the dial and the scene warming underneath it are reading the same
   * instant and the brief's wind is the replay's wind by construction rather
   * than by two formulas agreeing. The loop used to live here, and the moment
   * the cover grew a second view it had to move: only one view is mounted at a
   * time, so a reader who opened the other tab stopped the countdown and the
   * scene behind it with the same press.
   *
   * A subscription rather than a frame loop, because there is nothing to paint
   * between seeks. That also covers the capture hold: freezing and then seeking
   * to a stated time is a store change like any other, and this repaints on it.
   *
   * Painting stops at the release, not at the unmount. The cover has a 900ms
   * fade left and the replay is already running the gun off behind it, so a
   * brief that kept reading the clock would spend its last second swinging its
   * needle through the start of the race. What dissolves is the brief the
   * reader was reading.
   *
   * Reduced motion holds the first fix in the feed and never subscribes: with
   * no loop running there is nothing for a subscription to hear.
   */
  useEffect(() => {
    if (reduced) {
      paint(race.tMin);
      return;
    }
    const store = useReplay;
    const stop = store.subscribe((state) => {
      if (state.briefDone) return;
      paint(state.t);
    });
    paint(store.getState().t);
    return stop;
  }, [race, paint, reduced]);
  const tracePoints = trace
    .map((point, index) => `${((index / TRACE_STEPS) * 100).toFixed(1)},${traceY(point.tws).toFixed(1)}`)
    .join(" ");

  const lineMeters = Math.round(facts.lineLength);

  return (
    <div className={styles.panelMain} ref={root}>
      <div className={styles.panel}>
        <div className={styles.panelLabel}>
          <span>Fleet at the line</span>
          <span className={styles.panelCount}>{facts.boats.length}</span>
        </div>
        {facts.boats.map((boat) => (
          <div className={styles.fleetRow} key={boat.id}>
            <span
              className={boat.dark ? `${styles.chip} ${styles.chipDark}` : styles.chip}
              style={{ background: boat.hue }}
              aria-hidden="true"
            />
            <span className={styles.sail}>{boat.sail}</span>
            <span className={styles.boatName}>{boat.name}</span>
            <span className={styles.slot}>{signed(boat.gunX, 0)} m</span>
          </div>
        ))}
        <div className={styles.fleetFoot}>
          <span ref={gunIn}>{`gun in ${Math.max(0, -race.tMin).toFixed(1)} s`}</span>
          <span>
            {facts.first === null
              ? "no boat crossed"
              : `${facts.first.sail} ${signed(facts.first.t, 2)} s first cross`}
          </span>
          <span>{`line ${lineMeters} m`}</span>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelLabel}>
          <span>Wind, live off the seed</span>
        </div>
        <div className={styles.dialWrap}>
          <svg
            className={styles.dial}
            viewBox="0 0 40 40"
            role="img"
            aria-label="Wind dial: the needle points where the breeze is coming from, against the course axis"
          >
            <path className={styles.dialBand} d={BAND} />
            <circle className={styles.dialFace} cx={DIAL_C} cy={DIAL_C} r={DIAL_R} />
            <g className={styles.dialTicks}>
              <line x1={DIAL_C} y1={DIAL_C - DIAL_R} x2={DIAL_C} y2={DIAL_C - DIAL_R + 4} />
              <line x1={DIAL_C + DIAL_R} y1={DIAL_C} x2={DIAL_C + DIAL_R - 3} y2={DIAL_C} />
              <line x1={DIAL_C} y1={DIAL_C + DIAL_R} x2={DIAL_C} y2={DIAL_C + DIAL_R - 3} />
              <line x1={DIAL_C - DIAL_R} y1={DIAL_C} x2={DIAL_C - DIAL_R + 3} y2={DIAL_C} />
            </g>
            <g ref={needle} transform={`rotate(${seed.twd.toFixed(2)} ${DIAL_C} ${DIAL_C})`}>
              <line
                className={styles.dialNeedle}
                x1={DIAL_C}
                y1={DIAL_C}
                x2={DIAL_C}
                y2={DIAL_C - DIAL_R + 5}
              />
              <polygon
                className={styles.dialHead}
                points={`${DIAL_C} ${DIAL_C - DIAL_R + 1}, ${DIAL_C - 2.6} ${DIAL_C - DIAL_R + 6}, ${DIAL_C + 2.6} ${DIAL_C - DIAL_R + 6}`}
              />
            </g>
            <circle className={styles.dialHub} cx={DIAL_C} cy={DIAL_C} r="1.6" />
          </svg>
        </div>
        <div className={styles.twsRow}>
          <span className={styles.twsBig} ref={twsBig}>
            {(seed.tws * KNOTS).toFixed(1)}
          </span>
          <span className={styles.twsUnit}>kn TWS</span>
        </div>
        <svg
          className={styles.trace}
          viewBox="0 0 100 24"
          preserveAspectRatio="none"
          role="img"
          aria-label="True wind speed through the prestart"
        >
          <line x1="0" y1="22" x2="100" y2="22" stroke="rgba(255,255,255,.25)" strokeWidth=".5" />
          <polyline points={tracePoints} fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="1" />
          <circle ref={traceDot} r="1.8" fill="#fff" cx="0" cy={traceY(seed.tws).toFixed(1)} />
        </svg>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelLabel}>
          <span>Start line</span>
          <span className={styles.panelCount} ref={twdTag}>
            {`${signed(seed.twd, 0)}°`}
          </span>
        </div>
        <svg
          className={styles.lineDiagram}
          viewBox="0 0 100 76"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="The start line looking upwind: the pin at the left, the committee boat at the right, the fleet where each hull sat at the gun"
        >
          <g ref={windArrow} transform={`rotate(${seed.twd.toFixed(1)} 50 12)`}>
            <line className={styles.windStroke} x1="50" y1="3" x2="50" y2="17" strokeWidth="1.1" />
            <polygon className={styles.windFill} points="50,21 47.6,15.8 52.4,15.8" />
            <text className={`${styles.diagramTag} ${styles.windFill}`} ref={windTag} x="54" y="10">
              {`TWD ${signed(seed.twd, 0)}°`}
            </text>
          </g>
          <line
            x1="50"
            y1="26"
            x2="50"
            y2="62"
            stroke="rgba(255,255,255,.35)"
            strokeWidth=".5"
            strokeDasharray="2 2"
          />
          <text className={styles.diagramNote} x="54" y="44">
            square transit
          </text>
          {/* The line itself, in the wind's colour: the console's contract
              names "the start line before the gun" as one of the things amber
              means, and everything on this layer is before the gun. The two
              ends stay in ink, because a pin and a committee boat are marks
              on the water rather than weather. */}
          <line className={styles.windStroke} x1="13" y1="66" x2="87" y2="66" strokeWidth="1.4" />
          <circle cx="13" cy="66" r="1.7" fill="none" stroke="#fff" strokeWidth=".8" />
          <path d="M87 64.2 L91.5 64.2 L90.5 67.6 L88 67.6 Z" fill="#fff" />
          {facts.boats.map((boat) => {
            const x = boatX(boat.gunX, facts.lineHalf);
            return (
              <rect
                key={boat.id}
                x={(x - 2.1).toFixed(1)}
                y="64.8"
                width="4.2"
                height="2.4"
                fill={boat.hue}
                stroke={boat.dark ? "rgba(255,255,255,.55)" : undefined}
                strokeWidth={boat.dark ? ".25" : undefined}
              />
            );
          })}
          <polygon
            ref={favPin}
            className={styles.favMark}
            points="13,61.4 11.4,58.2 14.6,58.2"
            style={{ opacity: seed.favored === "pin" ? 1 : 0 }}
          />
          <polygon
            ref={favBoat}
            className={styles.favMark}
            points="87,61.4 85.4,58.2 88.6,58.2"
            style={{ opacity: seed.favored === "boat" ? 1 : 0 }}
          />
          <text className={styles.diagramEnd} x="13" y="72.5" textAnchor="middle">
            pin
          </text>
          <text className={styles.diagramEnd} x="87" y="72.5" textAnchor="end">
            committee boat
          </text>
        </svg>
        <div className={styles.biasReads}>
          <div>
            <div className={styles.biasNum} ref={biasDeg}>
              {`${signed(seed.twd, 1)}°`}
            </div>
            <div className={styles.biasCap}>line bias</div>
          </div>
          <div>
            <div className={styles.biasNum} ref={biasSec}>
              {`${seed.biasSeconds.toFixed(1)} s`}
            </div>
            <div className={styles.biasCap}>to the favored end</div>
          </div>
        </div>
        {/* A square line is favored by nobody, so the "by" goes with the
            seconds rather than dangling off the end of the sentence. Not a
            theoretical state: the breeze crosses the course axis inside the
            prestart on two of the three shipped seeds, 42 of 4001 samples on
            the shipped race and 19 on Kestrel Sound. */}
        <p className={styles.favored}>
          Favored: <b ref={favEnd}>{endLabel(seed.favored)}</b>
          <span
            className={styles.favBy}
            ref={favBy}
            style={{ display: seed.favored === "square" ? "none" : undefined }}
          >
            {" by "}
            <span className={styles.favSec} ref={favSec}>
              {`${seed.biasSeconds.toFixed(1)} s`}
            </span>
          </span>
        </p>
      </div>
    </div>
  );
}
