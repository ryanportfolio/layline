"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./CourseRail.module.css";
import { useReplay } from "./store";

/**
 * THE COURSE RAIL - the page read the way this console reads a race.
 *
 * The right margin of a scrolling document answers one question: where am I,
 * and how much is left. A sailor answers it off a course diagram, so that is
 * what is drawn here. The axis is the course. Every mark is a real section of
 * this document at its real share of the scroll. The thumb is a hull in plan
 * view whose length is the viewport's true share of the page, bow pointing the
 * way the reader is travelling, foam astern in proportion to how fast. The two
 * amber hairlines that converge on the next mark are laylines, drawn under the
 * same rule the console draws them under: amber is the wind, and a layline is
 * a wind fact. Nothing here is a decorative segment.
 *
 * Motion obeys the four verbs the stylesheet declares. Scroll is TRACK, the
 * drag is SCRUB (evaluated at the new position, never eased into place), the
 * bow swing and the finish ink are SETTLE, and reduced motion turns SETTLE into
 * a cut while leaving every position exact.
 *
 * The platform bar is stood down by the data attribute this component stamps at
 * mount, never by a static rule, so a visitor with no JS and every viewport
 * below 901px keeps a real scrollbar. Same gate the stylesheet uses.
 */

/** Rail width, and the hull's beam inside it. Both in CSS px. */
const RAIL_W = 24;
const HULL_BEAM = 12;
/** Below this the hull stops reading as a hull and starts reading as a dash. */
const HULL_FLOOR = 32;
/** The approach in which a mark's laylines come up, in px on the track. Named
 *  for the engine's own mark zone: the range at which the mark starts to
 *  govern how you are sailing. */
const ZONE = 130;
/** How far up the track the laylines run before they meet at the mark. */
const LAYLINE_RUN = 56;
/** Travel in one direction before the bow answers. Without it every jittered
 *  wheel tick would swing the boat. */
const FLIP_DEADBAND = 22;
/** Wake at full extension, and the speed in px/s that gets it there.
 *  18px is not a taste call: a displacement wake opens at the Kelvin
 *  half-angle, and 18px of run spreads tan(19.47 deg) = 6.36px either side,
 *  which is exactly the water this 24px rail has outboard of the transom.
 *  Any longer and the true angle would have run off the rail, leaving a
 *  choice between a clipped wake and a wrong one. */
const WAKE_MAX = 18;
const WAKE_SPREAD = 0.3536;
const WAKE_SPEED = 900;
/** The transom's two corners in rail coordinates, which is where the foam
 *  actually leaves the boat. 0.16 is half the beam less the transom half-width
 *  hullPath() cuts (0.34), so the wake cannot drift off the hull if the beam is
 *  ever retuned. */
const QUARTER_PORT = (RAIL_W - HULL_BEAM) / 2 + HULL_BEAM * 0.16;
const QUARTER_STBD = RAIL_W - QUARTER_PORT;

interface Leg {
  key: string;
  /** Fraction of the document at which this leg begins. */
  at: number;
}

/**
 * Document-space top by the layout box, walking offsetParent rather than
 * reading a rect: the console's stage transforms its contents, and a
 * transformed rect would report a position the section does not occupy.
 */
function docTop(el: HTMLElement): number {
  let y = 0;
  let node: HTMLElement | null = el;
  while (node !== null) {
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return y;
}

/** The bow taper and the aft taper, in px, both FIXED. A hull's entry and run
 *  are set by how water has to get around it, not by how long the boat is, so
 *  scaling them with the thumb would have drawn a needle on a long document and
 *  a leaf on a short one. Held to half the hull when the hull is shorter than
 *  they are. */
const ENTRY = 26;
const RUN = 15;

/**
 * A hull in plan view, bow at the bottom, drawn into a box `length` tall and
 * `beam` wide: fine entry, parallel midbody at full beam, transom cut square.
 * That is the shape a keelboat takes on a course card, and the reason the
 * midbody is the part that stretches is that the midbody is the part a longer
 * boat actually has more of.
 */
function hullPath(length: number, beam: number): string {
  const cx = beam / 2;
  const entry = Math.min(ENTRY, length * 0.55);
  const run = Math.min(RUN, length * 0.3);
  const shoulder = length - entry;
  const transom = beam * 0.34;
  const n = (v: number) => v.toFixed(2);
  return [
    `M ${cx} ${n(length)}`,
    `C ${beam} ${n(length - entry * 0.48)} ${beam} ${n(length - entry * 0.86)} ${beam} ${n(shoulder)}`,
    `L ${beam} ${n(run)}`,
    `C ${beam} ${n(run * 0.34)} ${n(cx + transom)} ${n(run * 0.2)} ${n(cx + transom)} 0`,
    `L ${n(cx - transom)} 0`,
    `C ${n(cx - transom)} ${n(run * 0.2)} 0 ${n(run * 0.34)} 0 ${n(run)}`,
    `L 0 ${n(shoulder)}`,
    `C 0 ${n(length - entry * 0.86)} 0 ${n(length - entry * 0.48)} ${cx} ${n(length)}`,
    "Z",
  ].join(" ");
}

export function CourseRail() {
  const railRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const boatRef = useRef<SVGGElement>(null);
  const hullRef = useRef<SVGPathElement>(null);
  const wakeRef = useRef<SVGPathElement>(null);
  const laylineRef = useRef<SVGGElement>(null);
  const calloutRef = useRef<HTMLDivElement>(null);
  const calloutNameRef = useRef<HTMLSpanElement>(null);
  const calloutRunRef = useRef<HTMLSpanElement>(null);

  const [legs, setLegs] = useState<Leg[]>([]);
  const [track, setTrack] = useState(0);
  const [hullL, setHullL] = useState(HULL_FLOOR);

  /* Read by the paint loop without re-rendering. */
  const geo = useRef({ range: 0, travel: 0, docH: 1, viewH: 1, trackH: 0, hullL: HULL_FLOOR });
  const legsRef = useRef<Leg[]>([]);
  const sigRef = useRef("");
  /** Index of the last mark rounded; -1 = still on the line, -2 = unpainted. */
  const heldRef = useRef(-2);
  /** Last painted position and frame stamp, for speed over the ground. */
  const lastRef = useRef({ y: 0, ts: 0, speed: 0, run: 0, bowUp: false });
  const openRef = useRef(false);
  const reducedRef = useRef(false);
  const finishedRef = useRef(false);
  const runTextRef = useRef("");
  /** The page's capture authority, mirrored for the paint loop. */
  const frozenRef = useRef(false);
  /** Callout height, measured when it opens: it is the one layout read this
   *  component makes outside a measure pass, and it must not happen per frame. */
  const calloutHRef = useRef(0);

  useEffect(() => {
    const rail = railRef.current;
    const svg = svgRef.current;
    const boat = boatRef.current;
    if (rail === null || svg === null || boat === null) return;

    const html = document.documentElement;
    /* Stamped here, at mount, so the suppression cannot outlive the thing
     * replacing it. */
    html.dataset.laylineRail = "";

    /* ONE CAPTURE AUTHORITY PER PAGE. window.__layline.freeze() holds the
     * replay clock, and this rail carries the only other rAF loop on the
     * route, so it answers to the same switch. Position, marks and laylines
     * are pure functions of scroll and stay exact while frozen; the wake is
     * the one reading here derived from time, so freezing strikes it and
     * stops the loop. Before this, a shot taken after freeze() still caught
     * the foam mid-decay and two runs of the same capture disagreed.
     *
     * Read once now, then tracked, so a rail that mounts into an already
     * frozen page does not start painting foam. */
    frozenRef.current = useReplay.getState().frozen;
    const unwatch = useReplay.subscribe((state) => {
      frozenRef.current = state.frozen;
    });

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = motion.matches;
    const onMotion = () => {
      reducedRef.current = motion.matches;
    };
    motion.addEventListener("change", onMotion);

    let raf = 0;

    const paint = (ts: number) => {
      raf = 0;
      const { range, travel, docH, viewH, trackH, hullL: hullLength } = geo.current;
      if (range <= 0) return;

      const y = Math.min(range, Math.max(0, window.scrollY));
      const top = (y / range) * travel;
      const last = lastRef.current;

      /* Speed over the ground, in px of document per second, smoothed so one
       * wheel notch does not read as a gust. The frame stamp comes from the rAF
       * callback: this tree carries no clock of its own. */
      const dt = last.ts === 0 ? 0 : Math.min(120, ts - last.ts);
      const dy = y - last.y;
      const raw = dt > 0 ? (Math.abs(dy) / dt) * 1000 : 0;
      const speed = dt > 0 ? last.speed + (raw - last.speed) * 0.3 : raw;

      /* The bow answers sustained travel, not the last frame's sign, so the run
       * accumulates and only a real reversal clears it.
       *
       * A frame that moved nothing is NOT a reversal, and reading it as one was
       * a bug worth the extra line: this loop runs on idle frames too, while
       * the wake decays, so a reader crawling upward in deltas under the
       * deadband had the accumulator wiped between every input. Six hundred
       * pixels of unbroken travel up the page, ten pixels at a time, and the
       * hull still pointed down the whole way. */
      if (dy !== 0) {
        last.run = Math.sign(dy) === Math.sign(last.run) ? last.run + dy : dy;
      }
      const bowUp =
        last.run < -FLIP_DEADBAND ? true : last.run > FLIP_DEADBAND ? false : last.bowUp;

      last.y = y;
      last.ts = ts;
      last.speed = speed;

      boat.setAttribute("transform", `translate(0 ${top.toFixed(2)})`);

      if (bowUp !== last.bowUp) {
        last.bowUp = bowUp;
        const hull = hullRef.current;
        if (hull !== null) hull.dataset.bow = bowUp ? "up" : "down";
      }

      /* Below this the page has effectively stopped, the wake is struck, and
       * the loop lets go of the frame budget. */
      const making = speed > 4 && !reducedRef.current && !frozenRef.current;

      const wake = wakeRef.current;
      if (wake !== null) {
        /* Foam leaves the transom, so which end it streams from flips with the
         * bow. Struck rather than merely shortened when the boat is stopped and
         * under reduced motion: a round-capped dashed line of zero length still
         * paints a dot, so length alone left a speck of foam on a boat that was
         * not moving. A wake is a motion effect, and every position it hangs off
         * is already exact without it. */
        const length = making ? Math.min(WAKE_MAX, (speed / WAKE_SPEED) * WAKE_MAX) : 0;
        const stern = bowUp ? hullLength : 0;
        const aft = (bowUp ? stern + length : stern - length).toFixed(2);
        const spread = length * WAKE_SPREAD;
        const port = (QUARTER_PORT - spread).toFixed(2);
        const stbd = (QUARTER_STBD + spread).toFixed(2);
        const from = stern.toFixed(2);
        wake.setAttribute(
          "d",
          `M ${QUARTER_PORT} ${from} L ${port} ${aft} M ${QUARTER_STBD} ${from} L ${stbd} ${aft}`,
        );
        wake.setAttribute(
          "opacity",
          making ? (Math.min(1, speed / WAKE_SPEED) * 0.7).toFixed(3) : "0",
        );
      }

      /* Which leg the reader is on, and which mark is next. Sampled at the
       * viewport's centre line, so a mark reads as rounded when it passes the
       * middle of the screen rather than the moment it appears. */
      const at = (y + viewH * 0.5) / docH;
      const list = legsRef.current;
      let held = -1;
      for (let i = 0; i < list.length; i += 1) {
        if (at >= list[i].at) held = i;
      }

      const next = list[held + 1];
      const laylines = laylineRef.current;
      if (laylines !== null) {
        /* Range to the next mark, in px on the track. The laylines come up
         * across the zone the way they come up on the water: further out than
         * that they are not the thing governing how you are sailing. */
        const off = next === undefined ? ZONE * 2 : (next.at - at) * trackH;
        const close = off <= 0 || off > ZONE ? 0 : 1 - off / ZONE;
        laylines.setAttribute("opacity", (close * close * 0.8).toFixed(3));
        if (close > 0 && next !== undefined) {
          laylines.setAttribute("transform", `translate(0 ${(next.at * trackH).toFixed(2)})`);
        }
      }

      if (held !== heldRef.current) {
        heldRef.current = held;
        const drawn = svg.querySelectorAll<SVGGElement>("[data-mark]");
        drawn.forEach((el, i) => {
          if (i <= held) el.dataset.rounded = "true";
          else delete el.dataset.rounded;
        });
        if (calloutNameRef.current !== null) {
          calloutNameRef.current.textContent = held >= 0 ? list[held].key : "Start line";
        }
      }

      /* Crossing the line is a one-shot, not a loop: the finish inks and stays
       * inked for as long as the reader is standing on it. */
      const finished = range - y < 2;
      if (finished !== finishedRef.current) {
        finishedRef.current = finished;
        if (finished) rail.dataset.finished = "true";
        else delete rail.dataset.finished;
      }

      /* Distance to finish, in the only unit this page can measure it in
       * honestly: screens of its own document. Written only while the callout
       * is open, and only when the figure it carries actually changes. */
      if (openRef.current) {
        const text = finished ? "Finish" : `DTF ${((range - y) / viewH).toFixed(1)} screens`;
        if (text !== runTextRef.current) {
          runTextRef.current = text;
          if (calloutRunRef.current !== null) calloutRunRef.current.textContent = text;
        }
        const callout = calloutRef.current;
        if (callout !== null) {
          /* Centred on the hull, and clamped to the track so the panel cannot
           * run off the bottom of the window when the boat finishes. The height
           * is measured once, when the callout opens, rather than read inside
           * this loop. */
          const half = calloutHRef.current / 2;
          const y = Math.min(trackH - half * 2, Math.max(0, top + hullLength / 2 - half));
          callout.style.transform = `translateY(${y.toFixed(2)}px)`;
        }
      }

      /* The wake has to fade after the page stops moving, and nothing else is
       * going to wake this loop to do it. Runs on for the handful of frames the
       * decay takes, then leaves the frame budget to the renderer. */
      if (making && raf === 0) raf = requestAnimationFrame(paint);
    };

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(paint);
    };

    const measure = () => {
      const docH = html.scrollHeight;
      const viewH = window.innerHeight;
      const range = docH - viewH;
      /* Any range at all. The attribute on <html> has already stood the
       * platform's bar down, so a page with 200px of overhang would otherwise
       * be left with no bar of any kind. */
      const scrollable = range > 1;
      rail.dataset.scrollable = scrollable ? "true" : "false";
      if (!scrollable) {
        geo.current = { range: 0, travel: 0, docH: 1, viewH: 1, trackH: 0, hullL: HULL_FLOOR };
        legsRef.current = [];
        if (sigRef.current !== "") {
          sigRef.current = "";
          setLegs([]);
          setTrack(0);
        }
        return;
      }

      const trackH = rail.clientHeight;
      const length = Math.max(HULL_FLOOR, (viewH / docH) * trackH);
      geo.current = { range, travel: trackH - length, docH, viewH, trackH, hullL: length };

      const found = Array.from(html.querySelectorAll<HTMLElement>("[data-leg]")).map((el) => ({
        key: el.dataset.leg ?? "",
        at: docTop(el) / docH,
      }));
      legsRef.current = found;

      const marks = found.map((leg) => `${leg.key}@${leg.at.toFixed(5)}`).join("|");
      const sig = `${trackH}:${length.toFixed(2)}:${marks}`;
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        setLegs(found);
        setTrack(trackH);
        setHullL(length);
      }
      /* A re-measure can move the reader onto a different leg without the
       * scroll position changing at all, so force the next paint to re-letter,
       * and drop the frame stamp so the gap does not read as speed. */
      heldRef.current = -2;
      lastRef.current.ts = 0;
      schedule();
    };

    // --- driving the page ---------------------------------------------------
    /* No Lenis on this route: the app-router prototypes own their whole canvas
     * and mount no site chrome, so the native call is the right one. */
    const scrollTo = (to: number, immediate: boolean) => {
      window.scrollTo({
        top: to,
        behavior: immediate || reducedRef.current ? "auto" : "smooth",
      });
    };

    let dragFrom = 0;
    let dragTop = 0;

    const onBoatDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const { range, travel } = geo.current;
      if (travel <= 0) return;
      dragFrom = e.clientY;
      dragTop = (Math.min(range, Math.max(0, window.scrollY)) / range) * travel;
      rail.dataset.drag = "true";
      openRef.current = true;
      boat.setPointerCapture(e.pointerId);
    };

    const onBoatMove = (e: PointerEvent) => {
      if (rail.dataset.drag !== "true") return;
      const { range, travel } = geo.current;
      if (travel <= 0) return;
      const to = Math.min(travel, Math.max(0, dragTop + (e.clientY - dragFrom)));
      /* SCRUB: read at the new position, never eased into it. */
      scrollTo((to / travel) * range, true);
    };

    const onBoatUp = (e: PointerEvent) => {
      if (rail.dataset.drag !== "true") return;
      delete rail.dataset.drag;
      openRef.current = rail.matches(":hover");
      if (boat.hasPointerCapture(e.pointerId)) boat.releasePointerCapture(e.pointerId);
    };

    /* A press on the rail is a course change, so it travels rather than
     * teleporting the reader. Under reduced motion it cuts. */
    const onRailDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (rail.dataset.drag === "true") return;
      const { range, travel, hullL: length } = geo.current;
      if (travel <= 0) return;
      const box = rail.getBoundingClientRect();
      const to = Math.min(travel, Math.max(0, e.clientY - box.top - length / 2));
      scrollTo((to / travel) * range, false);
    };

    const onEnter = () => {
      openRef.current = true;
      runTextRef.current = "";
      if (calloutRef.current !== null) calloutHRef.current = calloutRef.current.offsetHeight;
      schedule();
    };
    const onLeave = () => {
      if (rail.dataset.drag !== "true") openRef.current = false;
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", measure);
    /* On the BOAT, not on the plot. Bound to the plot, every press anywhere
     * on the rail was read as a grab, so the press-to-travel gesture below
     * never fired once: the whole track answered like a thumb. Everything else
     * drawn in the plot is pointer-events: none, so the hull is the only thing
     * in there a press can land on. */
    boat.addEventListener("pointerdown", onBoatDown);
    boat.addEventListener("pointermove", onBoatMove);
    boat.addEventListener("pointerup", onBoatUp);
    boat.addEventListener("pointercancel", onBoatUp);
    rail.addEventListener("pointerdown", onRailDown);
    rail.addEventListener("pointerenter", onEnter);
    rail.addEventListener("pointerleave", onLeave);

    /* The document grows under this thing: the console swaps its fallback for a
     * canvas, the analyst writes an answer, fonts land. Re-measure off the body
     * box rather than reading scrollHeight inside the scroll loop, which would
     * force a layout flush in the one callback that must not stall. */
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    measure();

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      unwatch();
      observer.disconnect();
      motion.removeEventListener("change", onMotion);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", measure);
      boat.removeEventListener("pointerdown", onBoatDown);
      boat.removeEventListener("pointermove", onBoatMove);
      boat.removeEventListener("pointerup", onBoatUp);
      boat.removeEventListener("pointercancel", onBoatUp);
      rail.removeEventListener("pointerdown", onRailDown);
      rail.removeEventListener("pointerenter", onEnter);
      rail.removeEventListener("pointerleave", onLeave);
      delete html.dataset.laylineRail;
    };
  }, []);

  const cx = RAIL_W / 2;
  const inset = (RAIL_W - HULL_BEAM) / 2;

  return (
    /* Hidden from assistive tech, and nothing is lost by it: the document
     * scrolls by keyboard exactly as it did before this mounted, and a
     * role="scrollbar" here would promise a focusable widget contract the
     * platform's own bar never offered either. */
    <div ref={railRef} className={styles.rail} data-scrollable="false" aria-hidden="true">
      <svg
        ref={svgRef}
        className={styles.plot}
        viewBox={`0 0 ${RAIL_W} ${track}`}
        width={RAIL_W}
        height={track}
        preserveAspectRatio="none"
      >
        {/* The course: the axis every mark sits on and the hull runs down. */}
        <line className={styles.axis} x1={cx} y1={0} x2={cx} y2={track} />

        {/* The line, at both ends of the document. A start and a finish are the
            same drawing in a course diagram: a mark, a committee boat, and the
            water between them. */}
        <g className={styles.gate} data-end="start">
          <line x1={2} y1={1.5} x2={RAIL_W - 2} y2={1.5} />
          <circle cx={2.5} cy={1.5} r={1.5} />
          <circle cx={RAIL_W - 2.5} cy={1.5} r={1.5} />
        </g>
        <g className={styles.gate} data-end="finish">
          <line x1={2} y1={track - 1.5} x2={RAIL_W - 2} y2={track - 1.5} />
          <circle cx={2.5} cy={track - 1.5} r={1.5} />
          <circle cx={RAIL_W - 2.5} cy={track - 1.5} r={1.5} />
        </g>

        {/* The boat. Its length is the viewport's share of the document, which
            is the one thing a scrollbar thumb has always meant. */}
        <g ref={boatRef} className={styles.boat} data-boat transform="translate(0 0)">
          {/* Two lines, not one. A wake down the middle sat exactly on the
              course axis and read as nothing; a boat leaves a V off its
              transom quarters, and that is a shape 24px is wide enough to
              show. */}
          <path ref={wakeRef} className={styles.wake} d="" opacity={0} />
          <path
            ref={hullRef}
            className={styles.hull}
            data-bow="down"
            transform={`translate(${inset} 0)`}
            d={hullPath(hullL, HULL_BEAM)}
          />
        </g>

        {/* Every mark is a section of this document at its real share of it.

            Drawn AFTER the boat, which is the correction this rail needed most:
            under it, the one moment a mark matters, the moment you are
            alongside it, was the one moment the hull covered it completely. A
            mark is an object in the water. The boat goes past it, not over it.

            The two ticks stop short of the hull's beam rather than ruling
            straight across, so a mark reads against the rail's edges instead of
            scoring a line down the deck of the boat passing it. */}
        {legs.map((leg, index) => (
          <g
            key={`${leg.key}-${index}`}
            className={styles.mark}
            data-mark
            transform={`translate(0 ${(leg.at * track).toFixed(2)})`}
          >
            <line className={styles.markRule} x1={1} y1={0} x2={inset - 1} y2={0} />
            <line
              className={styles.markRule}
              x1={RAIL_W - inset + 1}
              y1={0}
              x2={RAIL_W - 1}
              y2={0}
            />
            <circle className={styles.markRing} cx={cx} cy={0} r={3.2} />
          </g>
        ))}

        {/* The laylines, converging on whichever mark is next, and drawn LAST.
            Under the boat they were the one thing the hull covered, which on a
            long document is most of the approach: the hull is the viewport's
            share of the page and the approach is 130px of track. On a chart the
            layline is on the chart and the boat is on the layline. */}
        <g ref={laylineRef} className={styles.laylines} data-laylines opacity={0}>
          <line x1={0.75} y1={-LAYLINE_RUN} x2={cx} y2={0} />
          <line x1={RAIL_W - 0.75} y1={-LAYLINE_RUN} x2={cx} y2={0} />
        </g>
      </svg>

      <div ref={calloutRef} className={styles.callout}>
        <span ref={calloutNameRef} className={styles.calloutName}>
          Start line
        </span>
        <span ref={calloutRunRef} className={styles.calloutRun} />
      </div>
    </div>
  );
}
