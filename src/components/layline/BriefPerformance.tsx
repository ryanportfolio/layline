"use client";

import { useCallback, useMemo, useRef } from "react";
import {
  STEADY_WINDOW,
  VMG_STEP,
  polarReview,
  targetSpeed,
  vmgSeries,
  type BoatPerformance,
  type PolarReview,
  type VmgSeries,
} from "@/lib/layline/analytics";
import { MISSING, knots } from "@/lib/layline/format";
import type { BoatMeta, RaceData } from "@/lib/layline/types";
import styles from "./bootSea.module.css";

/**
 * The performance view of the race brief: how the fleet sailed against its own
 * polar, once the gun has gone.
 *
 * One of the two views RaceBrief switches between. Panels is the start, drawn
 * live off the prestart clock. This is the race after it, and it does not move:
 * there is nothing to animate, because every sample it plots has already
 * happened. The shell owns the clock, the header, the footer and the gate.
 *
 * The plot is a polar. Angle off vertical is the true wind angle, port tack to
 * the left and starboard to the right; distance from the middle is boat speed.
 * The pale curve is the speed the engine's own polar says a boat should be
 * making at that angle, so a dot inside the curve is a boat sailing under its
 * target and a dot outside it is a boat sailing over. Nothing here is a second
 * opinion about the race: `analytics.polarReview` reads the same fixes the
 * replay interpolates and the same polar the simulation sailed the fleet
 * along, so this cannot flatter or fault a boat the engine did not.
 *
 * The polar throws time away, which is most of what it is for: a cloud says how
 * a boat sailed without saying when. The strip beside it says when, and it is
 * the dock's own VMG series rather than a second reading of the same fixes. The
 * two answer different questions about one race, so a reader with the table
 * between them can ask both: the polar for how close to target, the strip for
 * where in the race it happened, and the row for what it came to.
 *
 * Pointing at a row raises that boat in both drawings at once. That is the
 * whole of the interaction, and it adds no figure a reader who never points at
 * anything cannot already read off the row itself.
 *
 * What the drawing leaves out is stated under it. Every sample within
 * STEADY_WINDOW of a tack or a gybe is dropped, because a boat swinging
 * through head to wind has a target speed of nearly nothing and its ratio to
 * that target runs away: without the window the fleet's mean beat performance
 * on the shipped race reads between 257 and 864 per cent. Those seconds are
 * not lost, they are the turn-cost column instead.
 */

/* m/s to knots. The same ratio format.ts converts by, so the radial scale and
 * the numerals beside it cannot disagree at the last decimal. */
const KNOTS = 3600 / 1852;

/* The radial ceiling in knots and its radius in user units. Eighteen knots
 * clears both the fastest normalized sample any shipped race holds, 15.4, and
 * the polar's own peak at the mean breeze, 16.4, so no dot and no part of the
 * curve is ever drawn outside the frame.
 *
 * The box is 112 wide against a radius of 44 because the angle labels sit
 * outside the rim: at 90 degrees the label starts at 47 and runs about seven
 * units, which a box of 104 clipped to "90". */
const RMAX_KN = 18;
const R = 44;
const RIM = R + 3;

const RINGS = [4, 8, 12, 16];
const SPOKES = [30, 60, 90, 120, 150];

/* Degrees between points on the target curve. Two is finer than the plot can
 * resolve at this size and costs 181 points, which is nothing beside the
 * hundreds of samples drawn over it. */
const ENVELOPE_STEP = 2;

/* Dot radius in user units, and the heel that earns the largest one. The
 * fleet's steady heel reaches 17.4 degrees across the shipped seeds, so
 * eighteen is the top of the scale rather than a clip. */
const DOT_MIN = 0.7;
const DOT_SPAN = 0.9;
const HEEL_FULL = 18;

/* How far the other five boats drop when one is under the pointer. Not to
 * zero: a comparison needs the fleet still visible to compare against. */
const DIMMED = "0.08";

/* The VMG strip's own drawing box. Wide and shallow because it is a time axis
 * and drawn without an aspect ratio, so it takes whatever width the column
 * leaves; every stroke on it is non-scaling to survive the stretch. */
const STRIP_W = 1000;
const STRIP_H = 120;

function radiusOf(kn: number): number {
  return (kn / RMAX_KN) * R;
}

function polarX(twaDeg: number, radius: number): number {
  return radius * Math.sin((twaDeg * Math.PI) / 180);
}

function polarY(twaDeg: number, radius: number): number {
  return -radius * Math.cos((twaDeg * Math.PI) / 180);
}

/** Per cent of target to one decimal, or MISSING where a boat had no samples. */
function percent(fraction: number): string {
  return Number.isFinite(fraction) ? (fraction * 100).toFixed(1) : MISSING;
}

/**
 * One boat's VMG trace, cut into runs at the samples it was not racing.
 *
 * A run of NaN is the prestart at one end and the finish at the other, and a
 * line drawn across it would claim the boat was making good toward a mark it
 * had not started for or had already reached. The dock's own strip breaks the
 * line for the same reason and at the same samples.
 */
function traceRuns(values: Float32Array, frame: StripFrame): string[] {
  const span = frame.hi - frame.lo;
  const runs: string[] = [];
  let run: string[] = [];
  for (let i = frame.first; i <= frame.last; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) {
      if (run.length > 1) runs.push(run.join(" "));
      run = [];
      continue;
    }
    const x = frame.last > frame.first ? ((i - frame.first) / (frame.last - frame.first)) * STRIP_W : 0;
    const y = span > 0 ? STRIP_H - ((value - frame.lo) / span) * STRIP_H : STRIP_H;
    run.push(`${x.toFixed(1)},${y.toFixed(2)}`);
  }
  if (run.length > 1) runs.push(run.join(" "));
  return runs;
}

interface StripFrame {
  /** VMG floor and ceiling the strip's height is spent on. */
  lo: number;
  hi: number;
  /** First and last sample any boat was racing at, so the axis is the racing. */
  first: number;
  last: number;
}

/**
 * The window the strip is drawn in.
 *
 * The series runs the whole feed, and the feed opens ten seconds before the gun
 * and closes a beat after the last finisher: on the shipped race that is 22 per
 * cent of the width with nothing on it, because VMG is undefined at both ends.
 * The axis is cut to the samples somebody was actually racing at instead, which
 * is what the plate's label already claims it shows.
 *
 * The height is the fleet's own floor and ceiling rather than zero to peak. A
 * scale starting at zero would spend a third of itself on water no boat sailed.
 */
function stripFrame(series: VmgSeries): StripFrame {
  let first = -1;
  let last = -1;
  for (let i = 0; i < series.count; i += 1) {
    if (!Number.isFinite(series.best[i])) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) {
    first = 0;
    last = Math.max(0, series.count - 1);
  }
  const lo = Math.min(0, series.floor);
  return { lo, hi: series.peak > lo ? series.peak : lo + 1, first, last };
}

export function BriefPerformance({ race }: { race: RaceData }) {
  const review: PolarReview = useMemo(() => polarReview(race), [race]);
  const meta = useMemo(() => {
    const byId = new Map<string, BoatMeta>();
    for (const boat of race.boats) byId.set(boat.id, boat);
    return byId;
  }, [race]);

  /* The target curve, drawn once at the breeze every sample was scaled to.
   * It pinches to nothing at the top because a boat cannot sail at zero
   * degrees off the wind, and that pinch is the no-go zone the drawing
   * labels there. */
  const envelope = useMemo(() => {
    const parts: string[] = [];
    for (let step = 0; step <= 360; step += ENVELOPE_STEP) {
      const twa = step <= 180 ? step : step - 360;
      const radius = radiusOf(targetSpeed(Math.abs(twa), review.meanTws) * KNOTS);
      const head = parts.length === 0 ? "M" : "L";
      parts.push(`${head} ${polarX(twa, radius).toFixed(2)} ${polarY(twa, radius).toFixed(2)}`);
    }
    return `${parts.join(" ")} Z`;
  }, [review]);

  /* The dock's own VMG series, built once per race and cached against it, so
   * the strip here and the strip thirty seconds later in the console are the
   * same numbers rather than two passes over the same fixes. The window is the
   * fleet's own floor and ceiling: a scale that started at zero would spend
   * half its height on water no boat sailed. */
  const vmg: VmgSeries = useMemo(() => vmgSeries(race), [race]);
  const frame = useMemo(() => stripFrame(vmg), [vmg]);
  const zeroY = STRIP_H - ((0 - frame.lo) / (frame.hi - frame.lo)) * STRIP_H;

  const clouds = useRef<(SVGGElement | null)[]>([]);
  const traces = useRef<(SVGGElement | null)[]>([]);

  /* Raising one boat out of the fleet is a dozen style writes, not a
   * re-render: the polar holds eight hundred odd circles and rebuilding them
   * to change an opacity would cost more than the whole view did to mount.
   *
   * Both drawings at once, because they are two views of one boat and lighting
   * one of them would make the reader find the other by eye.
   *
   * Emphasis only. Every figure the highlight points at is already printed in
   * the row the pointer is on, so a reader who never hovers, or who cannot,
   * loses nothing but the pleasure of it. */
  const raise = useCallback(
    (id: string | null) => {
      review.boats.forEach((boat, index) => {
        const value = id === null ? "" : boat.boatId === id ? "1" : DIMMED;
        for (const list of [clouds, traces]) {
          const node = list.current[index];
          if (node !== null && node !== undefined) node.style.opacity = value;
        }
      });
    },
    [review],
  );

  const meanKn = review.meanTws * KNOTS;
  const lo = (review.twsMin * KNOTS).toFixed(1);
  const hi = (review.twsMax * KNOTS).toFixed(1);

  /* Real table semantics on the divs the grid needs.
   *
   * Without them the five figures in a row reach a screen reader as a bare run
   * of numbers: read back off the accessibility tree, the first row announced
   * "FRA 12, 87.5, 98.1, 5.4, 12.3, 3.4" with nothing anywhere saying which
   * column any of them belongs to, because the head row was hidden and a span
   * carries no column of its own. The roles put the heads back in the tree and
   * tie each figure to one. */
  const numbers = (
    perf: Pick<
      BoatPerformance,
      "beatFraction" | "runFraction" | "beatVmg" | "runVmg" | "lossPerTurn"
    >,
  ) => (
    <>
      <span className={styles.perfNum} role="cell">
        {percent(perf.beatFraction)}
      </span>
      <span className={styles.perfNum} role="cell">
        {percent(perf.runFraction)}
      </span>
      <span className={styles.perfNum} role="cell">
        {knots(perf.beatVmg)}
      </span>
      <span className={styles.perfNum} role="cell">
        {knots(perf.runVmg)}
      </span>
      <span className={styles.perfNum} role="cell">
        {knots(perf.lossPerTurn)}
      </span>
    </>
  );

  return (
    <div className={styles.perfMain}>
      <div className={`${styles.panel} ${styles.polarPlate}`}>
        <div className={styles.panelLabel}>
          <span>Speed against the polar</span>
          <span className={styles.panelCount}>{review.fleet.steady}</span>
        </div>
        <div className={styles.polarBox}>
          <svg
            className={styles.polar}
            viewBox="-56 -56 112 112"
            role="img"
            aria-label={`Every steady sample the fleet sailed, plotted by true wind angle against boat speed, with the polar the engine sails them along drawn over it; the fleet held ${percent(review.fleet.beatFraction)} per cent of target on the beat and ${percent(review.fleet.runFraction)} on the run`}
          >
            <g className={styles.polarGrid}>
              {RINGS.map((kn) => (
                <circle key={kn} cx="0" cy="0" r={radiusOf(kn).toFixed(2)} />
              ))}
              <line x1="0" y1={-R} x2="0" y2={R} />
              {SPOKES.map((twa) => (
                <g key={twa}>
                  <line
                    x1="0"
                    y1="0"
                    x2={polarX(twa, R).toFixed(2)}
                    y2={polarY(twa, R).toFixed(2)}
                  />
                  <line
                    x1="0"
                    y1="0"
                    x2={polarX(-twa, R).toFixed(2)}
                    y2={polarY(-twa, R).toFixed(2)}
                  />
                </g>
              ))}
            </g>

            {/* The ring scale runs up the one axis no boat can sail on, so a
                numeral can never land in the fleet. */}
            <g className={styles.polarTick}>
              {RINGS.map((kn) => (
                <text key={kn} x="1.6" y={(-radiusOf(kn) + 1.4).toFixed(2)}>
                  {kn}
                </text>
              ))}
            </g>

            {/* Angles down the starboard side only. The drawing is a mirror,
                and a second set of the same five numerals would say so twice. */}
            <g className={styles.polarAngle}>
              <text x="0" y={-R - 3.4} textAnchor="middle">
                no-go
              </text>
              {SPOKES.map((twa) => (
                <text
                  key={twa}
                  x={polarX(twa, RIM).toFixed(2)}
                  y={polarY(twa, RIM).toFixed(2)}
                  textAnchor="start"
                  dominantBaseline="middle"
                >
                  {`${twa}°`}
                </text>
              ))}
              <text x="0" y={R + 7} textAnchor="middle">
                180°
              </text>
            </g>

            <path className={styles.polarTarget} d={envelope} />

            {review.boats.map((boat, index) => {
              const chip = meta.get(boat.boatId);
              return (
                <g
                  key={boat.boatId}
                  data-boat={boat.boatId}
                  className={styles.polarCloud}
                  ref={(node) => {
                    clouds.current[index] = node;
                  }}
                  fill={chip === undefined ? "#ffffff" : chip.hue}
                >
                  {boat.samples.map((sample) => {
                    const radius = radiusOf(sample.speed * KNOTS);
                    const heel = Math.min(1, Math.abs(sample.heel) / HEEL_FULL);
                    return (
                      <circle
                        key={sample.t}
                        cx={polarX(sample.twa, radius).toFixed(2)}
                        cy={polarY(sample.twa, radius).toFixed(2)}
                        r={(DOT_MIN + heel * DOT_SPAN).toFixed(2)}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
        </div>
        <p className={styles.polarCap}>
          {`Speed scaled to the ${meanKn.toFixed(1)} kn race mean, so a puff cannot read as pace. Port tack left, starboard right; dot size is heel. Turns and the ${STEADY_WINDOW} s either side are left out and counted as turn cost instead.`}
        </p>
      </div>

      <div className={`${styles.panel} ${styles.perfTable}`}>
        <div className={styles.panelLabel}>
          <span>Steady sailing, boat by boat</span>
          <span className={styles.panelCount}>{race.boats.length}</span>
        </div>
        <div role="table" aria-label="Steady sailing, boat by boat">
          <div className={`${styles.perfRow} ${styles.perfHead}`} role="row">
            <span role="columnheader">boat</span>
            <span className={styles.perfNum} role="columnheader">
              beat %
            </span>
            <span className={styles.perfNum} role="columnheader">
              run %
            </span>
            <span className={styles.perfNum} role="columnheader">
              beat vmg
            </span>
            <span className={styles.perfNum} role="columnheader">
              run vmg
            </span>
            <span className={styles.perfNum} role="columnheader">
              turn kn
            </span>
          </div>
          {review.boats.map((boat) => {
            const chip = meta.get(boat.boatId);
            return (
              <div
                className={styles.perfRow}
                key={boat.boatId}
                role="row"
                onPointerEnter={() => raise(boat.boatId)}
                onPointerLeave={() => raise(null)}
              >
                {/* The chip rides inside the name rather than in a column of
                    its own. A colour is not a figure, and an empty cell over
                    every row is one more thing a screen reader reads past. */}
                <span className={styles.sail} role="rowheader">
                  <span
                    className={
                      chip !== undefined && chip.dark
                        ? `${styles.chip} ${styles.chipDark}`
                        : styles.chip
                    }
                    style={{ background: chip === undefined ? "#ffffff" : chip.hue }}
                    aria-hidden="true"
                  />
                  {chip === undefined ? boat.boatId : chip.sail}
                </span>
                {numbers(boat)}
              </div>
            );
          })}
          <div className={`${styles.perfRow} ${styles.perfMedian}`} role="row">
            <span className={styles.sail} role="rowheader">
              <span className={styles.chipBlank} aria-hidden="true" />
              fleet
            </span>
            {numbers(review.fleet)}
          </div>
        </div>
        <div className={styles.fleetFoot}>
          <span>median of the six</span>
          <span>VMG toward the mark, turn cost in knots</span>
        </div>
      </div>

      {/* The same six boats against the clock. The polar says how well, this
          says when, and the row between them says what it came to. */}
      <div className={`${styles.panel} ${styles.vmgPlate}`}>
        <div className={styles.panelLabel}>
          <span>VMG to the mark, gun to finish</span>
          <span className={styles.panelCount}>{`${knots(vmg.peak)} kn peak`}</span>
        </div>
        <svg
          className={styles.vmgStrip}
          viewBox={`0 0 ${STRIP_W} ${STRIP_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Every boat's speed made good toward its mark, from the gun to the last finisher; the fleet's median was ${knots(review.fleet.beatVmg)} knots on the beat and ${knots(review.fleet.runVmg)} on the run`}
        >
          <line
            className={styles.vmgRule}
            x1="0"
            y1={zeroY.toFixed(2)}
            x2={STRIP_W}
            y2={zeroY.toFixed(2)}
          />
          {review.boats.map((boat, index) => {
            const chip = meta.get(boat.boatId);
            const values = vmg.byBoat[boat.boatId];
            return (
              <g
                key={boat.boatId}
                data-boat={boat.boatId}
                className={styles.vmgTrace}
                ref={(node) => {
                  traces.current[index] = node;
                }}
                stroke={chip === undefined ? "#ffffff" : chip.hue}
              >
                {values === undefined
                  ? null
                  : traceRuns(values, frame).map((points, run) => (
                      <polyline key={run} points={points} />
                    ))}
              </g>
            );
          })}
        </svg>
        <div className={styles.fleetFoot}>
          <span>{`a sample every ${VMG_STEP} s`}</span>
          <span>broken off the legs</span>
        </div>
      </div>

      <div className={`${styles.panel} ${styles.reads}`}>
        <div className={styles.readCell}>
          <div className={styles.readLabel}>Beat %</div>
          <div className={styles.readValue} data-read="beat">
            {percent(review.fleet.beatFraction)}
          </div>
        </div>
        <div className={styles.readCell}>
          <div className={styles.readLabel}>Run %</div>
          <div className={styles.readValue} data-read="run">
            {percent(review.fleet.runFraction)}
          </div>
        </div>
        <div className={styles.readCell}>
          <div className={styles.readLabel}>TWS kn</div>
          <div className={styles.readValue} data-read="tws">
            {meanKn.toFixed(1)}
          </div>
        </div>
        <div className={styles.readCell}>
          <div className={styles.readLabel}>Turns</div>
          <div className={styles.readValue} data-read="turns">
            {review.fleet.turns}
          </div>
        </div>
      </div>

      <p className={styles.perfNote}>
        {`Breeze ran ${lo} to ${hi} kn across the race. ${review.fleet.steady} samples at 4 Hz behind the figures.`}
      </p>
    </div>
  );
}
