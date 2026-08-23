"use client";

import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FIX_HZ } from "@/lib/layline/types";
import { raceData } from "../store";
import { useMounted } from "../analyst/useMounted";
import { buildBench, fmt2, type FinishGap } from "./benchData";
import { CameraOne, CameraThree, CameraTwo } from "./cameras";
import { ClockContext, useLabClock, type LabClock } from "./clock";
import { WindowStrip } from "./WindowStrip";
import styles from "./engine.module.css";

/* The engine room: three cameras and one feed, all pointed at the same twelve
 * seconds of the seeded race, all reading one clock in the transport bar. The
 * clock runs on a single rAF loop that exists only while the transport is on
 * screen, and never at all for a viewer who has asked for less motion. */

/* A held frame at the end of the loop, then a cut back to the start. The loop
 * never rewinds: SNAP is the verb, and a tween back through the tack would
 * show the turn happening twice. */
const HOLD_MS = 800;

/* Where a stop lands inside the quarter second it picks. On the fix instant
 * itself the engine's answer is the fix, so CAM 01 draws the raw hull exactly
 * under the smooth one and its LAG chip prints 0.00 m: the one instant in every
 * fifteen frames where the camera has nothing to show, and the instant every
 * scrubber stop, feed row and dot tap used to land on. Half a fix past the
 * chosen reading, the raw hull is still holding that reading and the smooth one
 * has moved off it, which is the whole picture the caption promises. The
 * reading itself does not change: the feed row, the slider value and the raw
 * hull all still read the fix that was picked. */
const HALF_FIX = 0.5 / FIX_HZ;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return reduced;
}

export function EngineRoom({ embedded = false }: { embedded?: boolean }) {
  const mounted = useMounted();
  const reduced = useReducedMotion();
  /* Boat metadata and fixes come from the client's own seeded build, the same
   * one the replay reads, so RaceData never crosses the server boundary. */
  const race = useMemo(() => raceData(), []);
  const bench = useMemo(() => buildBench(race), [race]);

  const timeRef = useRef(bench.window.from);
  const runRef = useRef(false);
  const holdRef = useRef(0);
  const heldByHandRef = useRef(false);
  const frameNowRef = useRef(0);
  const listeners = useRef(new Set<(t: number) => void>());
  const figuresRef = useRef<HTMLDivElement | null>(null);
  const [running, setRunningState] = useState(false);
  const [inView, setInView] = useState(false);

  const emit = useCallback(() => {
    const t = timeRef.current;
    for (const listener of listeners.current) listener(t);
  }, []);

  const subscribe = useCallback((listener: (t: number) => void) => {
    listeners.current.add(listener);
    listener(timeRef.current);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const setRunning = useCallback((run: boolean) => {
    heldByHandRef.current = !run;
    runRef.current = run;
    holdRef.current = 0;
    setRunningState(run);
  }, []);

  const seek = useCallback(
    (t: number) => {
      const { from, to, fixes } = bench.window;
      /* Floor rather than round, so the fix a stop picks is the reading that
         was live at t: the same rule fixIndexAt applies to the feed table, and
         the only one that leaves the arrow keys somewhere to go now that a stop
         sits half a fix past the grid. Rounding would tie there and step
         nowhere. The epsilon absorbs the float that 0.25 s of race time turns
         into after twelve seconds of addition. */
      const index = Math.min(
        Math.max(Math.floor((t - from) * FIX_HZ + 1e-6), 0),
        fixes.length - 1,
      );
      /* The last fix in the window is the window's own end: it has no hold
         inside the bench, so End and a drag to the right edge land on it and
         the two hulls coincide there. Everywhere else a stop shows the lag. */
      const landed = from + index / FIX_HZ + HALF_FIX;
      timeRef.current = landed < from ? from : landed > to ? to : landed;
      holdRef.current = 0;
      runRef.current = false;
      heldByHandRef.current = true;
      setRunningState(false);
      emit();
    },
    [bench, emit],
  );

  /* Reduced motion parks the clock where every camera still has something to
   * show: the needles mid-divergence, the raw boat a metre off the smooth one. */
  useEffect(() => {
    if (!reduced) return;
    runRef.current = false;
    holdRef.current = 0;
    setRunningState(false);
    timeRef.current = bench.park;
    emit();
  }, [reduced, bench, emit]);

  /* The figures decide whether the clock runs, not the transport bar. The bar
     rides with them and can be on screen when none of them is, so watching it
     left the loop writing to nodes nobody could see. Measured at 390: with the
     figures 212px past the top of the viewport the loop now writes nothing
     across 97 frames. */
  useEffect(() => {
    const node = figuresRef.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting === true),
      { threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /* One rAF loop for the whole section, and only while it is on screen. */
  useEffect(() => {
    if (reduced || !inView) return;
    const { from, to } = bench.window;
    let frame = 0;
    let previous = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      frameNowRef.current = now;
      const dt = previous === 0 ? 0 : Math.min(0.1, (now - previous) / 1000);
      previous = now;
      if (runRef.current) {
        if (holdRef.current > 0) {
          holdRef.current -= dt * 1000;
          if (holdRef.current <= 0) {
            holdRef.current = 0;
            timeRef.current = from;
          }
        } else {
          const next = timeRef.current + dt;
          if (next >= to) {
            timeRef.current = to;
            holdRef.current = HOLD_MS;
          } else {
            timeRef.current = next;
          }
        }
      }
      emit();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced, inView, bench, emit]);

  /* Autoplay when the transport arrives, unless a viewer has pressed hold. */
  useEffect(() => {
    if (reduced || !inView || heldByHandRef.current) return;
    runRef.current = true;
    setRunningState(true);
  }, [reduced, inView]);

  const clock = useMemo<LabClock>(
    () => ({
      race,
      bench,
      reduced,
      mounted,
      running,
      time: () => timeRef.current,
      frameNow: () => frameNowRef.current,
      subscribe,
      seek,
      setRunning,
    }),
    [race, bench, reduced, mounted, running, subscribe, seek, setRunning],
  );

  return (
    <ClockContext.Provider value={clock}>
      <div className={styles.root} style={{ "--bench-hue": bench.boat.hue } as CSSProperties}>
        {embedded ? null : <EngineHeader />}
        <div className={styles.locator}>
          <p className={styles.railLabel}>Full race · {bench.boat.sail} window marked</p>
          <WindowStrip />
        </div>
        <Transport />
        {/* One box around the run of figures, carrying no style of its own, so
            the observer above has a rectangle to watch that starts at CAM 01
            and ends at the last row of the feed. */}
        <div ref={figuresRef}>
          <CameraOne />
          <CameraTwo />
          <CameraThree />
        </div>
      </div>
    </ClockContext.Provider>
  );
}

function EngineHeader() {
  const { race, bench } = useLabClock();
  return (
    <div className={styles.head}>
      <div className={styles.headText}>
        <p className={styles.kicker}>Replay engine</p>
        <h2 id="notes-heading" className={styles.heading}>
          How the replay works
        </h2>
        <p className={styles.explainer}>
          12 seconds of {bench.boat.sail} through 1 tack, on 1 shared clock
        </p>
      </div>
      {/* The broadcast ident: what the feed is, how much of this section reads
          from it, and the fleet in entry order. The Debrief ident above prints
          the fleet total, so this one counts the window instead: two idents
          inside one screenful have to say two things. Repetition of what the
          console already says, so it is hidden from the tree. */}
      <div className={styles.ident} aria-hidden="true">
        <p className={styles.identLine}>Telemetry · {FIX_HZ} Hz per boat</p>
        <p className={styles.identValue}>{bench.window.fixes.length}</p>
        <p className={styles.identSub}>Samples on the bench</p>
        <div className={styles.fleetBar}>
          {race.boats.map((boat) => (
            <span
              key={boat.id}
              className={clsx(styles.fleetBlock, boat.dark === true && styles.fleetBlockOutlined)}
              style={{ background: boat.hue }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Transport() {
  const clock = useLabClock();
  const { bench, reduced, mounted, running } = clock;
  const { from, to, span, tack, fixes } = bench.window;
  const railRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLSpanElement | null>(null);
  const readoutRef = useRef<HTMLParagraphElement | null>(null);
  const sliderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let shown = "";
    let shownFix = -1;
    return clock.subscribe((t) => {
      const percent = ((t - from) / span) * 100;
      if (headRef.current !== null) headRef.current.style.left = `${percent.toFixed(3)}%`;
      const text = `T+${fmt2(t)}`;
      if (text === shown) return;
      shown = text;
      if (readoutRef.current !== null) readoutRef.current.textContent = text;
      /* The slider announces itself on the fix grid it steps on, not sixty
         times a second: nothing reads a value that fast, and every write is a
         node the frame has to pay for. Floor, not round, so the announced value
         is the reading the feed row is highlighting rather than whichever fix
         the clock happens to be nearest. */
      const fix = Math.floor(t * FIX_HZ + 1e-6);
      if (fix === shownFix) return;
      shownFix = fix;
      if (sliderRef.current !== null) {
        sliderRef.current.setAttribute("aria-valuenow", fmt2(fix / FIX_HZ));
        sliderRef.current.setAttribute("aria-valuetext", `T+${fmt2(fix / FIX_HZ)}`);
      }
    });
  }, [clock, from, span]);

  const seekFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const node = railRef.current;
      if (node === null) return;
      const box = node.getBoundingClientRect();
      if (box.width === 0) return;
      clock.seek(from + ((event.clientX - box.left) / box.width) * span);
    },
    [clock, from, span],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = 1 / FIX_HZ;
      const now = clock.time();
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") clock.seek(now - step);
      else if (event.key === "ArrowRight" || event.key === "ArrowUp") clock.seek(now + step);
      else if (event.key === "PageDown") clock.seek(now - 1);
      else if (event.key === "PageUp") clock.seek(now + 1);
      else if (event.key === "Home") clock.seek(from);
      else if (event.key === "End") clock.seek(to);
      else return;
      event.preventDefault();
    },
    [clock, from, to],
  );

  return (
    <div className={styles.transport}>
      <p className={styles.transportLabel}>
        Slow motion · {bench.boat.sail} · T+{from} to T+{to}
      </p>

      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label={`Lab clock, T plus ${from} to T plus ${to} seconds`}
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={from}
        aria-valuetext={`T+${fmt2(from)}`}
        onKeyDown={onKeyDown}
      >
        <div
          ref={railRef}
          className={styles.track}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            seekFromPointer(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event);
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        >
          {fixes.map((fix) => (
            <span
              key={fix.t}
              className={clsx(styles.fixTick, Number.isInteger(fix.t) && styles.secondTick)}
              style={{ left: `${(((fix.t - from) / span) * 100).toFixed(3)}%` }}
            />
          ))}
          <span
            className={styles.tackTick}
            style={{ left: `${(((tack - from) / span) * 100).toFixed(3)}%` }}
          />
          {bench.rounding !== null && bench.rounding >= from && bench.rounding <= to ? (
            <span
              className={styles.markTick}
              style={{ left: `${(((bench.rounding - from) / span) * 100).toFixed(3)}%` }}
            />
          ) : null}
          {mounted ? (
            <span ref={headRef} className={styles.playhead} style={{ left: "0%" }}>
              <span className={styles.playDot} />
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.transportRight}>
        <p ref={readoutRef} className={styles.clock}>
          T+{fmt2(from)}
        </p>
        {/* The control waits for the mount rather than shipping in the server
            markup: reduce is unknown until the client reads the query, and a
            button that renders and then leaves is worse than one that never
            arrives. */}
        {mounted && !reduced ? (
          <button
            type="button"
            className={styles.runButton}
            onClick={() => clock.setRunning(!running)}
          >
            {running ? "Hold" : "Run"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The section's full stop: finishing order in the six boat hues, with the run
 * from the gun to the line drawn per boat.
 *
 * Both the times and the bar lengths arrive as props from the server render.
 * A finish time is a sub-tick crossing ratio at the far end of the sim and V8
 * disagrees with itself about it across engines by up to fifteen
 * milliseconds, which is enough to move a printed centisecond; taking the
 * numbers from one engine is what lets the test pin exactly what the page
 * prints. See the note over finishGaps.
 */
export function FinishStrip({ order, gap }: { order: FinishGap[]; gap: number }) {
  const slowest = order.reduce((most, entry) => (entry.elapsed > most ? entry.elapsed : most), 0);
  return (
    <div className={styles.finish}>
      <p className={styles.railLabel}>Finish order · gun to line</p>
      <div className={styles.finishRow}>
        {order.map((entry) => (
          <span key={entry.boatId} className={styles.finishEntry}>
            <span
              className={clsx(styles.finishSwatch, entry.dark && styles.finishSwatchOutlined)}
              style={{ background: entry.hue }}
              aria-hidden="true"
            />
            <span className={styles.finishSail}>{entry.sail}</span>
            <span className={styles.finishBar} aria-hidden="true">
              <span
                className={clsx(styles.finishBarFill, entry.dark && styles.finishBarOutlined)}
                style={{
                  width: `${slowest === 0 ? 0 : ((entry.elapsed / slowest) * 100).toFixed(3)}%`,
                  background: entry.hue,
                }}
              />
            </span>
            <span className={clsx(styles.finishGap, entry.rank === 1 && styles.finishElapsed)}>
              {entry.rank === 1 ? `${fmt2(entry.elapsed)} s` : `+${fmt2(entry.delta)}`}
            </span>
          </span>
        ))}
      </div>
      <p className={styles.finishCaption}>
        Elapsed from the gun, each bar drawn against the last boat home. Fourth and fifth finish{" "}
        {fmt2(gap)} seconds apart
      </p>
    </div>
  );
}
