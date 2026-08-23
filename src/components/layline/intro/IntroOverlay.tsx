"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { clock } from "@/lib/layline/format";
import { poseAt } from "@/lib/layline/interpolate";
import { FIX_HZ } from "@/lib/layline/types";
import type { Pose } from "@/lib/layline/types";
import { raceData, useReplay } from "../store";
import { chartFrame, lengthAt, toPath } from "../svg/chartFrame";
import type { ChartTrack } from "../svg/chartFrame";
import { CourseFurniture } from "../svg/CourseFurniture";
import styles from "./intro.module.css";

/**
 * Plot to water: the page-load intro.
 *
 * The renderer is a lazy island and it takes about a second to put its first
 * frame up, which used to be a second of empty console followed by a scene
 * popping in. This owns that second and makes it the opening: the seeded race
 * draws its own course in 2D across the whole viewport, then the plan tilts
 * away toward the camera the scene opens on and the live renderer is already
 * running underneath it.
 *
 * The cover is in the server markup, so there is nothing to flash between
 * paint and hydration. Everything after that is one rAF loop reading its own
 * callback timestamp: no wall clock anywhere in this tree.
 */

/* Beats, ms from the loop's first frame.
 *
 * The card's beat is measured from the moment the wordmark can paint, not from
 * the loop's first frame. Pangram Display is font-display: block, so on a cold
 * cache the card's own opening is held blank while the woff2 lands; a fixed
 * beat spends that hold and then fades a wordmark that was on screen for a
 * fraction of it. B0_HOLD is what the card gets once it is readable, and
 * FONT_CAP is how long that wait is allowed to push the whole sequence out. */
const B0_HOLD = 640;
const FONT_CAP = 600;
const CAP_MS = 8000; // no renderer by here and the overlay gets out of the way
const MORPH_MS = 700; // the plan lays down onto the water
const RELEASE_MS = 300; // and the last of the cover goes
const FADE_MS = 400; // the no-renderer exit, no morph to hang it on

/* The plan comes up under the card rather than after it: it starts rising
 * while the card is still leaving, and the first metres go down just after it
 * does. The two beats overlap, so nothing on screen is ever a straight swap of
 * one layer for another. */
const OVERLAP = 260;
const DRAW_LEAD = 120;

/* The draw runs a smoothstep to most of the race by the end of the beat, then
 * sails the last stretch slowly out to the cap so a machine that is still
 * booting its renderer watches boats finishing rather than a held frame. */
const DRAW_SPAN = 1500;
const B1_THROUGH = 0.88;
const SAIL_END = CAP_MS;

/* The plan is in motion for the whole of its beat, from the frame it starts
 * rising to the frame the morph takes over, so the tilt is a move already
 * running rather than one starting from rest. The stylesheet needs the number
 * and this is where it is held. */
const RISE_MS = DRAW_LEAD + DRAW_SPAN;

const GAP = 100000; // one dash gap that outruns the longest track

/* The plot is drawn in metres and the dash that reveals a track is an arc
 * length in metres, so nothing here can be held in screen units. Instead the
 * fitted scale is measured once, the stylesheet's own scale on the plot read
 * back off it rather than repeated here, and the two decorations that want a
 * fixed weight on screen are converted into metres through it. */
const TRACK_PX = 2.4;
const EDGE_PX = 4.8;
const HULL_PX = 21;
const HULL_SPAN = 8; // the hull path, bow to transom, in metres

const GUN = 0; // race time of the start, where the drawing begins

/* Same hull as the analyst slate, pointing up the course before its heading
 * turns it. */
const HULL = "M0 -4.6 L2.6 3.4 L0 1.9 L-2.6 3.4 Z";

type Beat = "b0" | "b1" | "morph" | "release" | "fade";

function through(ms: number, from: number, end: number): number {
  if (from === 0 || ms <= from) return 0;
  if (ms < end) {
    const u = (ms - from) / (end - from);
    return B1_THROUGH * u * u * (3 - 2 * u);
  }
  const u = (ms - end) / (SAIL_END - end);
  return u >= 1 ? 1 : B1_THROUGH + (1 - B1_THROUGH) * u;
}

export function IntroOverlay() {
  const race = useMemo(() => raceData(), []);
  const frame = useMemo(() => chartFrame(race), [race]);

  const [beat, setBeat] = useState<Beat>("b0");
  const [rise, setRise] = useState(false);
  const [live, setLive] = useState(false);
  const [gone, setGone] = useState(false);
  /* Read after hydration, so the first client render still matches the server
   * one. Nothing in the plot is visible before B1 either way. */
  const [portrait, setPortrait] = useState(false);

  const beatRef = useRef<Beat>("b0");
  const skipRef = useRef(false);
  /* True once the wordmark's face can paint. A flag rather than the time it
   * happened: nothing in this tree is allowed to read a wall clock, so the
   * loop stamps it with its own callback timestamp on the next frame, which
   * is the frame the card could first have been seen in anyway. */
  const faceReady = useRef(false);
  const lines = useRef(new Map<string, SVGPathElement | null>());
  const edges = useRef(new Map<string, SVGPathElement | null>());
  const hulls = useRef(new Map<string, SVGGElement | null>());
  const clockRef = useRef<HTMLParagraphElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<SVGSVGElement | null>(null);
  const pose = useRef<Pose>({ x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 });

  /* The feed runs on past the last finisher while boats coast, so the drawing
   * ends on the line rather than on the last fix. */
  const end = useMemo(() => {
    let last = race.tMin;
    for (const result of race.results) if (result.elapsed > last) last = result.elapsed;
    return last;
  }, [race]);

  /* Two ways out before the first beat: a visitor who asked for less motion,
   * and the capture harnesses, which need the console on screen at a stated
   * time and cannot spend three seconds behind a cover. Both hand the page
   * straight to the console and release playback on the way. */
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const off = new URLSearchParams(window.location.search).get("intro") === "off";
    /* An intro is a page load, not a route event: a client-side return to this
     * route keeps the document and the store, introDone is still true, and
     * playing the cover again over a replay that is already running would
     * burn the prestart where nobody can see it. */
    const replayed = useReplay.getState().introDone;
    /* Hydration can also land after the no-JS expiry has already hidden the
     * cover. Bringing it back over a page someone has started reading is
     * worse than never having played, and the computed style is the one
     * witness of whether the expiry fired. */
    const expired =
      rootRef.current !== null && getComputedStyle(rootRef.current).visibility === "hidden";
    if (reduced || off || replayed || expired) {
      useReplay.getState().setIntroDone(true);
      setGone(true);
      return;
    }
    setPortrait(window.innerHeight > window.innerWidth);
    setLive(true);
  }, []);

  /* When the wordmark's own face lands. Asked for by name rather than through
   * document.fonts.ready, which also waits on the three faces the console
   * below is loading and would hold the card open behind type nobody is
   * looking at. A face that never arrives never resolves this and the loop's
   * own cap takes over. */
  useEffect(() => {
    if (document.fonts === undefined) return;
    let held = false;
    document.fonts
      .load('400 1em "Pangram Display"')
      .catch(() => undefined)
      .then(() => {
        if (!held) faceReady.current = true;
      });
    return () => {
      held = true;
    };
  }, []);

  /* The page renders this component for the life of the document, so letting
   * go is a render of nothing rather than an unmount: gone is a dependency
   * here so that letting go still runs the cleanup and takes the loop and the
   * key listener off the page with it. */
  useEffect(() => {
    if (!live || gone) return;

    /* Metres per pixel at the size the box actually landed at. The svg is laid
     * out over the whole viewport and fits its box with meet, so this is the
     * fit the browser used, times whatever the stylesheet then scales the plot
     * by at this breakpoint. */
    const plot = plotRef.current;
    const box = (plot?.getAttribute("viewBox") ?? "0 0 1 1").split(" ").map(Number);
    const raw = plot === null ? "none" : getComputedStyle(plot).transform;
    const scale = raw.startsWith("matrix") ? Math.abs(new DOMMatrixReadOnly(raw).a) : 1;
    const fit =
      plot === null ? 1 : Math.min(plot.clientWidth / box[2], plot.clientHeight / box[3]) * scale;
    const meters = fit > 0 ? 1 / fit : 1;
    const hullScale = (HULL_PX / HULL_SPAN) * meters;

    const nodes: Array<{
      line: SVGPathElement;
      edge: SVGPathElement | null;
      hull: SVGGElement;
      track: ChartTrack;
    }> = [];
    for (const track of frame.tracks) {
      const line = lines.current.get(track.boat.id);
      const hull = hulls.current.get(track.boat.id);
      if (line == null || hull == null) continue;
      const edge = edges.current.get(track.boat.id) ?? null;
      line.style.strokeWidth = (TRACK_PX * meters).toFixed(3);
      line.style.strokeDasharray = `0 ${GAP}`;
      if (edge !== null) {
        edge.style.strokeWidth = (EDGE_PX * meters).toFixed(3);
        edge.style.strokeDasharray = `0 ${GAP}`;
      }
      nodes.push({ line, edge, hull, track });
    }

    const draw = (t: number) => {
      for (const node of nodes) {
        const drawn = lengthAt(node.track, t);
        const dash = `${drawn.toFixed(1)} ${GAP}`;
        node.line.style.strokeDasharray = dash;
        if (node.edge !== null) node.edge.style.strokeDasharray = dash;
        poseAt(race, node.track.boat.id, t, "smooth", pose.current);
        node.hull.setAttribute(
          "transform",
          `translate(${pose.current.x.toFixed(1)} ${(-pose.current.y).toFixed(1)}) rotate(${pose.current.hdg.toFixed(1)}) scale(${hullScale.toFixed(3)})`,
        );
      }
      if (clockRef.current !== null) clockRef.current.textContent = clock(t);
    };

    const to = (next: Beat) => {
      beatRef.current = next;
      setBeat(next);
    };

    let frameId = 0;
    let started = 0;
    let last = 0; // the previous frame's timestamp, for the freeze hold
    let leftAt = 0; // when the morph or the plain fade began
    /* Settled on the first frame that knows whether the wordmark's face has
     * landed. Zero until then, which is the whole of the card's opening and
     * none of the drawing. */
    let b0End = 0;
    /* The frame the plan actually started coming up on, and the two boundaries
     * measured off it. Booting the renderer blocks the main thread for around
     * half a second on this page, and a beat that is only a number of
     * milliseconds gets crossed and left behind inside one of those frames:
     * the overlap collapses and the handover is the straight swap it was
     * built to stop being. So the beats after this one are measured from when
     * the previous one was painted, not from when it was due. */
    let roseAt = 0;
    let drawFrom = 0;
    let b1End = 0;
    /* Gun to finish. The feed opens ten seconds before the gun and those ten
     * seconds are boats milling behind a line, which is the whole of the
     * beat's opening spent on nothing moving. */
    const span = end - GUN;

    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick);
      if (started === 0) started = now;
      if (last === 0) last = now;
      const step = now - last;
      last = now;
      /* The capture hold freezes the replay's clock, and this loop is a clock
       * too: a screenshot taken during the intro has to be of a stated frame.
       * The start slides forward by exactly the held time, so the sequence
       * resumes where it froze rather than having quietly run on. */
      if (useReplay.getState().frozen) {
        started += step;
        return;
      }
      const ms = now - started;
      const skip = skipRef.current;

      if (b0End === 0) {
        /* The face was in the cache and landed before this loop had a frame,
         * so ms is 0 here and the card simply gets its hold from the first
         * frame. Capped either way: a face that is still coming is not allowed
         * to push the whole sequence out behind it. */
        const known = faceReady.current;
        if (known || ms >= FONT_CAP || skip) {
          b0End = Math.min(known ? ms : FONT_CAP, FONT_CAP) + B0_HOLD;
        }
      }

      draw(GUN + through(ms, drawFrom, b1End) * span);

      if (roseAt === 0 && (skip || (b0End !== 0 && ms >= b0End - OVERLAP))) {
        roseAt = ms;
        drawFrom = ms + DRAW_LEAD;
        b1End = drawFrom + DRAW_SPAN;
        setRise(true);
      }
      /* One transition a frame, so a state the CSS has to transition out of is
       * always a state it has been in for at least one paint. */
      switch (beatRef.current) {
        case "b0":
          /* Never in the same frame the plan came up in: the card leaves into
           * a plan that is already on screen, or it does not leave yet. */
          if ((roseAt !== 0 && ms >= b0End && ms >= roseAt + OVERLAP) || skip) to("b1");
          return;
        case "b1": {
          const replay = useReplay.getState();
          const ready = replay.webglOk;
          if (ready && (ms >= b1End || skip)) {
            leftAt = ms;
            /* Released at the top of the morph, not the bottom of it. The
             * scene under the plan has been sitting on the opening frame all
             * this time, and letting go only once the plan is gone would show
             * that frame and then snap it back to the prestart. Under a cover
             * that is still opaque, the jump is nobody's business. */
            replay.setIntroDone(true);
            to("morph");
          } else if (ms >= CAP_MS || (skip && !ready)) {
            leftAt = ms;
            to("fade");
          }
          return;
        }
        case "morph":
          if (ms - leftAt >= MORPH_MS) {
            leftAt = ms;
            to("release");
          }
          return;
        case "release":
          if (ms - leftAt >= RELEASE_MS) {
            cancelAnimationFrame(frameId);
            setGone(true);
          }
          return;
        case "fade":
          if (ms - leftAt >= FADE_MS) {
            cancelAnimationFrame(frameId);
            useReplay.getState().setIntroDone(true);
            setGone(true);
          }
          return;
      }
    };
    frameId = requestAnimationFrame(tick);

    /* Escape, Enter and Space are the keys a viewer already reaches for to get
     * past a title card. The overlay itself takes a press anywhere, the way
     * the water below it does. */
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Enter" && event.key !== " ") return;
      /* Space would otherwise scroll the page under the cover and hand back a
       * console the viewer has to scroll up to. Escape and Enter keep their
       * defaults: the skip link may hold focus, and it is a link. */
      if (event.key === " ") event.preventDefault();
      skipRef.current = true;
    };
    window.addEventListener("keydown", onKey);

    /* A fixed overlay does not stop the document scrolling under it: a wheel
     * during the intro would leave the viewport halfway down the notes when
     * the cover lifts, with the replay opening unseen. The document holds
     * still while the cover is up, and the scroll gesture itself is read as
     * what it is, a viewer reaching for the content, so it skips. */
    const doc = document.documentElement;
    const heldOverflow = doc.style.overflow;
    doc.style.overflow = "hidden";
    const onReach = () => {
      skipRef.current = true;
    };
    window.addEventListener("wheel", onReach, { passive: true });
    window.addEventListener("touchmove", onReach, { passive: true });

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onReach);
      window.removeEventListener("touchmove", onReach);
      doc.style.overflow = heldOverflow;
    };
  }, [live, gone, frame, race, end]);

  /* rotate(-90) sends (x, y) to (y, -x), so the viewBox trades places with it:
   * the beat leaves to the right and the run comes back, and the fitted box
   * fills a landscape viewport instead of sitting in a letterbox down the
   * middle. A phone held upright already is the shape of the course. */
  const turned = useMemo(() => {
    const [x, y, w, h] = frame.viewBox.split(" ").map(Number);
    return `${y} ${-(x + w)} ${h} ${w}`;
  }, [frame]);

  if (gone) return null;

  return (
    <div
      ref={rootRef}
      className={styles.overlay}
      data-state={beat}
      data-live={live ? "true" : undefined}
      data-rise={rise ? "true" : undefined}
      style={{ "--rise": `${RISE_MS}ms` } as CSSProperties}
      aria-hidden="true"
      onPointerUp={() => {
        skipRef.current = true;
      }}
    >
      <div className={styles.ground} />

      {/* Client-only, though the cover around it is server markup: the track
          paths are float arithmetic formatted to one decimal, and Node and the
          browser disagree by an ulp somewhere in six long strings, which is a
          hydration mismatch on every load. Nothing in the plot is visible
          before B1, half a second after mount, so nobody sees the difference. */}
      {live ? (
      <div className={styles.plane}>
        <svg
          ref={plotRef}
          className={styles.plot}
          viewBox={portrait ? frame.viewBox : turned}
          preserveAspectRatio="xMidYMid meet"
        >
          <g transform={portrait ? undefined : "rotate(-90)"}>
            <g className={styles.furniture}>
              <CourseFurniture course={race.course} labelX={frame.maxX} named={false} />
            </g>
            {frame.tracks.map((track) => (
              <g key={track.boat.id} style={{ color: track.boat.hue }}>
                {/* A near-black hull colour needs a light edge to survive a
                    dark ground, the same outline its standings chip carries.
                    It is drawn by the same dash, so it reveals with its
                    track rather than running ahead of it. */}
                {track.boat.dark === true ? (
                  <path
                    ref={(node) => {
                      edges.current.set(track.boat.id, node);
                    }}
                    className={styles.trackEdge}
                    d={toPath(track.points)}
                  />
                ) : null}
                <path
                  ref={(node) => {
                    lines.current.set(track.boat.id, node);
                  }}
                  className={styles.track}
                  d={toPath(track.points)}
                />
                <g
                  ref={(node) => {
                    hulls.current.set(track.boat.id, node);
                  }}
                >
                  <path className={styles.hull} d={HULL} />
                </g>
              </g>
            ))}
          </g>
        </svg>
      </div>
      ) : null}

      <div className={styles.card}>
        <p className={styles.wordmark}>Layline</p>
        <span className={styles.rule} />
        <p className={styles.ident}>
          {race.boats.length} boats at {FIX_HZ} GPS points a second
        </p>
      </div>

      <div className={styles.readout}>
        <span className={styles.readoutLabel}>race clock</span>
        <p ref={clockRef} className={styles.readoutValue}>
          {clock(GUN)}
        </p>
      </div>
    </div>
  );
}
