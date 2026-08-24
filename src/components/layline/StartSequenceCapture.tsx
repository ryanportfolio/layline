"use client";

import { useEffect } from "react";
import { useReplay } from "./store";
import styles from "./StartSequence.module.css";

const SECTION_ID = "race-library";

/** The board's loop, in milliseconds. Kept in step with StartSequence.module.css. */
const CYCLE_MS = 30000;
const GUN_MS = 10000;
/* Written as the stylesheet's own percentage rather than the 29600 it rounds
   to. 98.6667% of 30s is 29600.01ms, and at a phase of exactly 29600 the
   engine is still on the near side of that keyframe, so a rounded constant
   read the rearm one sample early and disagreed with the board on the boundary
   frame of every cycle. */
const REARM_MS = CYCLE_MS * 0.986667;
const RUNGS = 10;

/**
 * The five frames worth capturing, in a row's own local time.
 *
 * armed      the counting state paints, one ink clock against two dim ones
 * mid        the odometers and the fill bar agree at the halfway rung
 * lastSecond the poster frame, and the one that catches an off-by-one rung
 * gun        row 0 fired and row 1 freshly armed, so the handover is visible
 * settled    the row rule back to --rule with nothing stuck bright
 *
 * Each one avoids the 400ms rearm window and the 220ms flag drop on the other
 * two rows, so no beat catches a neighbour mid transition.
 */
const BEATS = {
  armed: 2000,
  mid: 5000,
  lastSecond: 9400,
  gun: 10400,
  settled: 12000,
} as const;

/**
 * The phase the base rules draw when nothing is animating: the row carrying
 * data-poster is at its last second and the other two have fired. Same frame as
 * the lastSecond beat, which is what makes the still board and the running
 * board the same picture. See the poster block in StartSequence.module.css.
 */
const POSTER_MS = BEATS.lastSecond;

export type StartSequenceBeat = keyof typeof BEATS | "static";

export interface StartSequenceRow {
  id: string;
  state: "armed" | "fired";
  clock: string;
  windKn: string;
}

export interface StartSequenceInfo {
  /** The named beat currently held, or null at any other phase. */
  beat: StartSequenceBeat | null;
  /** 0 to 29999 in cycle time, or -1 while the board is held static. */
  phaseMs: number;
  static: boolean;
  running: boolean;
  frozen: boolean;
  rows: StartSequenceRow[];
}

export interface StartSequenceCaptureApi {
  hold: (beat?: StartSequenceBeat | number) => void;
  release: () => void;
  info: () => StartSequenceInfo;
}

declare global {
  interface Window {
    __laylineCta?: StartSequenceCaptureApi;
  }
}

/** Animation.currentTime is CSSNumberish; every engine that ships this gives a number. */
function timeOf(animation: Animation): number {
  const raw = animation.currentTime;
  return typeof raw === "number" ? raw : 0;
}

function wrap(ms: number): number {
  return ((ms % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
}

/**
 * Three jobs, none of which draws anything.
 *
 * The visibility gate: the board carries twenty-seven infinite animations and it
 * sits on a page holding a live WebGL context whose frame-time governor steps
 * pixel ratio down through 1.5, 1.25 and 1 on sustained slow frames. Compositor
 * work for a board nobody can see would move that governor for the wrong
 * reason, so the stylesheet runs nothing without data-run and this writes it
 * only while the section is on screen. The same shape the engine room already
 * uses for its own loop on this page.
 *
 * The freeze gate: one capture authority per page. window.__layline.freeze()
 * holds the replay clock and the course rail's wake, and this is the third loop
 * on the route, so it parks on the same switch and a two-shot comparison of the
 * whole page stays valid.
 *
 * ONE OWNER FOR PAUSE AND RESUME, and it is the Web Animations API, here. Blink
 * sets an ignore-CSS-play-state flag on a CSS animation the moment the API
 * calls play() or pause() on it, so the animation-play-state rule this used to
 * lean on stopped working permanently after the first hold() and freeze() went
 * on writing data-frozen over a board that was still counting. The state is
 * computed from two inputs, the frozen flag and whether a beat is held, and
 * applied through the API to every animation in the subtree. data-frozen is
 * still written, as a record of the state for tests and for anyone reading the
 * DOM, but nothing depends on it to stop a frame. It is re-applied whenever the
 * animation set changes, because toggling data-run builds brand new Animation
 * objects and they default to running.
 *
 * The beat names: window.__laylineCta sits on top of the freeze, naming phases
 * rather than replacing the authority. Animation.currentTime is local time and
 * the engine folds each row's negative CSS delay in, so one assignment puts all
 * three rows at their correct staggered phase with no per-row arithmetic.
 *
 * It ships in production builds as well as development, like CaptureBridge: a
 * capture tool that only works against a dev server can only verify one.
 */
export function StartSequenceCapture() {
  useEffect(() => {
    const root = document.getElementById(SECTION_ID);
    if (root === null) return;

    let inView = false;
    let held = false;
    let frozen = useReplay.getState().frozen;

    /* getAnimations flushes pending style, but data-run was written in this
       same task and the animations only exist once that attribute has been
       resolved, so the read is forced rather than assumed. */
    const animations = () => {
      void root.offsetHeight;
      return root.getAnimations({ subtree: true });
    };

    /* The one decision. Two inputs, one answer, applied to every animation in
       the subtree: paused if the page is frozen or a beat is held, running
       otherwise. Nothing else in the codebase may pause these. */
    const applyState = () => {
      const paused = frozen || held;
      for (const animation of animations()) {
        if (paused) {
          if (animation.playState !== "paused") animation.pause();
        } else if (animation.playState !== "running") {
          animation.play();
        }
      }
    };

    /* Closing the gate has to destroy the loop, not orphan it. Dropping
       animation-name does not end a CSS animation the Web Animations API has
       already paused: Blink keeps that Animation object alive, so scrolling the
       section away while frozen left twenty-seven paused animations behind and
       scrolling back built a second twenty-seven alongside them. info() reads
       list[0].currentTime, so from the first such cycle it reported a stranded
       animation's phase, measured 10,400ms off, and the count grew without
       bound on every further pass over the section whose frame-time governor is
       the reason this gate exists at all. Cancel while the attribute is still
       there, then take it away. */
    const closeGate = () => {
      for (const animation of animations()) animation.cancel();
      root.removeAttribute("data-run");
    };

    /* A hold has to beat the visibility gate. Taken with the section off
       screen there would be no animations to pause and the capture would shoot
       whatever the base rules state. Writing the attribute changes the set of
       animations, so the state is re-applied on the way out. */
    const applyRun = () => {
      if (held || inView) root.setAttribute("data-run", "1");
      else closeGate();
      applyState();
    };

    /* The way back from a cancel. A cancelled animation stays cancelled, so the
       loop is rebuilt by taking the gate away, flushing, and letting the
       stylesheet name the animations again from scratch. */
    const rebuild = () => {
      closeGate();
      void root.offsetHeight;
      applyRun();
    };

    const observer = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting === true;
        applyRun();
      },
      { threshold: 0 },
    );
    observer.observe(root);

    /* data-frozen is a record of the state, not the mechanism: the pause lands
       through applyState. Read once now, then tracked, so a board that mounts
       into an already frozen page does not start counting. */
    const applyFrozen = (next: boolean) => {
      frozen = next;
      if (next) root.setAttribute("data-frozen", "1");
      else root.removeAttribute("data-frozen");
      applyState();
    };
    applyFrozen(frozen);
    /* The guard is the whole point of this line. This store is not wrapped in
       subscribeWithSelector, so a plain subscribe has no selector and the
       listener runs on every set(); LaylineScene advances the replay clock
       inside useFrame, so that is every rendered frame. Unguarded, applyFrozen
       ran 500 times over 500 frames, 100 a second on a 100Hz panel, each one
       forcing layout through offsetHeight and walking the subtree's animation
       set, and it kept doing it with the board off screen and the gate shut.
       That is the exact cost the gate exists to avoid. */
    const unwatch = useReplay.subscribe((state) => {
      if (state.frozen !== frozen) applyFrozen(state.frozen);
    });

    const readRows = (phaseMs: number, isBase: boolean): StartSequenceRow[] =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-race]")).map((el) => {
        const delay = Number.parseFloat(getComputedStyle(el).getPropertyValue("--row-delay"));
        const delayMs = Number.isFinite(delay) ? delay * 1000 : 0;
        /* With no animation running, the phase is not a clock reading, it is
           whatever the base rules draw: the poster row at its last second and
           the rest of the board fired. */
        const phase = isBase
          ? el.dataset.poster === "1"
            ? POSTER_MS
            : GUN_MS
          : wrap(phaseMs - delayMs);
        /* Three intervals, not two. The stylesheet cuts both odometers back to
           their first rung at 98.6667% of the cycle, which is REARM_MS, so the
           board paints a whole armed row through the 400ms rearm. Read without
           that branch this said 0:00 for 400ms per row per cycle while the
           screen said -0:10, and contradicted its own state field, which was
           already reporting "armed". */
        const rung =
          phase >= REARM_MS ? 0 : phase >= GUN_MS ? RUNGS : Math.floor(phase / 1000);
        const clocks = el.querySelectorAll(`.${styles.clockStack} > span`);
        const winds = el.querySelectorAll(`.${styles.windStack} > span`);
        return {
          id: el.dataset.race ?? "",
          /* The rearm window belongs to the next count, not to the one that
             finished: the flag is on its way back up and both odometers have
             already cut back to their first rung. */
          state: phase >= GUN_MS && phase < REARM_MS ? "fired" : "armed",
          clock: clocks[rung]?.textContent ?? "",
          windKn: winds[rung]?.textContent ?? "",
        };
      });

    const api: StartSequenceCaptureApi = {
      hold: (beat) => {
        const wanted = beat === undefined ? "gun" : beat;
        const wasStatic = root.hasAttribute("data-static");
        held = true;
        if (wanted === "static") {
          /* Cancelled, not paused. A paused animation keeps supplying its own
             computed value, so dropping animation-name left the board still
             painting a mid-count frame while info() reported the base picture.
             Cancelling is the only way to let the base rules through. */
          const live = animations();
          root.setAttribute("data-static", "1");
          applyRun();
          for (const animation of live) animation.cancel();
          for (const animation of animations()) animation.cancel();
          return;
        }
        root.removeAttribute("data-static");
        if (wasStatic) rebuild();
        else applyRun();
        const ms = typeof wanted === "number" ? wanted : BEATS[wanted];
        for (const animation of animations()) {
          animation.currentTime = ms;
          animation.pause();
        }
      },
      release: () => {
        const wasStatic = root.hasAttribute("data-static");
        root.removeAttribute("data-static");
        held = false;
        if (wasStatic) rebuild();
        else applyRun();
      },
      info: () => {
        const list = animations();
        const isStatic = root.hasAttribute("data-static");
        /* Every animation on the board starts in the frame data-run lands, so
           they share one currentTime and the stagger lives entirely in the
           per-row delay the engine folds into each effect. */
        const isBase = isStatic || list.length === 0;
        const phaseMs = isBase ? -1 : wrap(timeOf(list[0]));
        const beat =
          (Object.keys(BEATS) as (keyof typeof BEATS)[]).find((name) => BEATS[name] === phaseMs) ??
          null;
        return {
          beat: isStatic ? "static" : beat,
          phaseMs,
          static: isStatic,
          running:
            !isStatic &&
            root.getAttribute("data-run") === "1" &&
            list.some((animation) => animation.playState === "running"),
          frozen,
          rows: readRows(phaseMs, isBase),
        };
      },
    };

    window.__laylineCta = api;
    return () => {
      observer.disconnect();
      unwatch();
      if (window.__laylineCta === api) delete window.__laylineCta;
    };
  }, []);

  return null;
}
