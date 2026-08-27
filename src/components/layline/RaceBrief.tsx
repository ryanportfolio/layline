"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { briefFacts, type BriefFacts } from "@/lib/layline/brief";
import type { RaceData } from "@/lib/layline/types";
import { BriefPanels, setText, signed } from "./BriefPanels";
import { BriefPerformance } from "./BriefPerformance";
import { RaceBriefDither } from "./RaceBriefDither";
import styles from "./bootSea.module.css";
import { AUTOPLAY_FROM, OPEN_AT, useReplay } from "./store";

/**
 * The race brief: what the boot cover shows while the renderer warms.
 *
 * The cover used to name the race and wait. It now spends the wait stating the
 * race, in two halves that meet at the gun. Panels is the start: the fleet at
 * the line, the breeze on a dial, and what the line is worth in it, all running
 * live off the prestart clock. Performance is the race after it: every steady
 * sample the fleet sailed, plotted against the polar the engine sails them
 * along, with the fleet's VMG and what each turn cost beside it.
 *
 * Every figure in either view comes out of the same RaceData the replay is
 * about to play, through the same evaluators the instrument dock reads, so
 * neither view can disagree with the race behind it or with the other. See
 * lib/layline/brief.ts and lib/layline/analytics.ts for where each one is read
 * from.
 *
 * This file is the shell the two views hang in: the header, the switch between
 * them, the prestart clock and the way through. The clock is
 * here rather than in a view because only one view is mounted at a time and
 * Performance does not move: a loop that lived in Panels would stop the
 * countdown, and the scene warming behind the cover with it, the moment a
 * reader looked at the other tab.
 *
 * The brief is a gate as well as a picture. Continue, or Enter, releases it, and
 * the replay's autoplay waits on that release rather than running the prestart
 * off behind a cover.
 */

/** The start, and the race after it. The start is the default. */
export type BriefView = "panels" | "performance";

/* One turn of the prestart, in wall-clock ms. The prestart itself is ten race
 * seconds; nine wall seconds is slow enough that the fleet reads as boats
 * rather than as a sweep. */
const PRESTART_LOOP_MS = 9000;

export function RaceBrief({
  race,
  name,
  venue,
  dateLabel,
  reduced,
}: {
  race: RaceData;
  name: string;
  venue: string;
  dateLabel: string;
  reduced: boolean;
}) {
  const facts: BriefFacts = useMemo(() => briefFacts(race), [race]);

  /* Held here rather than in the store, and deliberately. The store re-arms
     briefDone per race so a second race gets its own gate; a reader who has
     said which drawing they want should not have to say it again, and this
     shell outlives the race the rail swaps under it. The server has no
     preference to read, so it renders the start and so does the first client
     paint. */
  const [view, setView] = useState<BriefView>("panels");

  const root = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const gunIn = useRef<HTMLSpanElement>(null);

  /* The race name is capped at two lines: measured, then stepped down a pixel
   * at a time until it fits. Container units alone cannot do it, because what
   * overflows is the number of words, not the width of one. */
  const fitTitle = useCallback(() => {
    const node = title.current;
    if (node === null) return;
    node.style.fontSize = "";
    let size = Number.parseFloat(getComputedStyle(node).fontSize);
    if (!Number.isFinite(size)) return;
    node.style.fontSize = `${size}px`;
    let guard = 80;
    const fits = (): boolean => node.scrollHeight <= Math.ceil(2 * size * 1.02) + 2;
    while (!fits() && size > 9 && guard > 0) {
      size -= 1;
      guard -= 1;
      node.style.fontSize = `${size}px`;
    }
  }, []);

  useLayoutEffect(() => {
    fitTitle();
    const node = root.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitTitle());
    observer.observe(node);
    return () => observer.disconnect();
  }, [fitTitle]);

  /* The Continue button takes focus when the cover mounts: it is the way
   * through the layer, and a viewer arriving by keyboard should not have to
   * find it. preventScroll keeps the workspace's own scroll position.
   *
   * Switching views does not take focus back. The reader pressed the switch and
   * is looking at what it did; moving the caret out from under them to announce
   * a button they have already read would be the rudest thing on the layer. */
  useEffect(() => {
    button.current?.focus({ preventScroll: true });
  }, []);

  /* The countdown on the header rule, written straight onto the element off
   * the replay clock, the same way the views write their readings and the
   * button writes its band. It moved up here from the fleet plate's foot, so
   * the shell owns it now: it must keep counting while the reader is on the
   * Performance tab and the fleet plate is unmounted. Reduced motion holds the
   * top of the prestart, matching the readings the views hold. */
  useEffect(() => {
    const write = (t: number): void =>
      setText(gunIn.current, `gun in ${Math.max(0, -t).toFixed(1)} s`);
    if (reduced) {
      write(race.tMin);
      return;
    }
    write(useReplay.getState().t);
    return useReplay.subscribe((state) => {
      if (!state.briefDone) write(state.t);
    });
  }, [race, reduced]);

  /**
   * The prestart, run on the replay's own clock.
   *
   * The loop seeks the store rather than keeping a clock of its own, so the
   * panels and the scene warming underneath them are reading the same instant
   * and the brief's wind is the replay's wind by construction rather than by
   * two formulas agreeing. Each view subscribes to that clock to paint; none of
   * them drives it. It stops seeking while the capture hold is on, which is
   * what lets a screenshot state its own time.
   *
   * Reduced motion never runs it at all. The brief holds the first fix in the
   * feed, and the store's clock stays where it opened, at the mid-beat moment
   * the store picks for a viewer who asked for less motion. That is also why
   * the opening seek sits inside this effect rather than above it: under
   * reduced motion there must be no seek to undo.
   */
  useEffect(() => {
    if (reduced) return;
    const store = useReplay;
    const span = 0 - race.tMin;
    let frame = 0;
    let origin = 0;
    const step = (stamp: number): void => {
      const state = store.getState();
      /* Released. The replay owns the clock from here, and the cover has a fade
       * left to live through: another second of this loop seeking behind it
       * would fight the autoplay for the same clock. */
      if (state.briefDone) return;
      frame = requestAnimationFrame(step);
      if (state.frozen) return;
      if (origin === 0) origin = stamp;
      const phase = ((stamp - origin) % PRESTART_LOOP_MS) / PRESTART_LOOP_MS;
      state.seek(race.tMin + phase * span);
    };
    /* Open the replay on the prestart before the first painted frame, so the
     * scene coming up behind the brief is at the moment the brief describes.
     * Only if it is not already there: a held capture would otherwise leave
     * its stated time the instant this effect re-ran. */
    const opened = store.getState();
    if (!opened.frozen && !(opened.t >= race.tMin && opened.t < 0)) opened.seek(race.tMin);
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [race, reduced]);

  /**
   * The way through, moving on the race's own clock.
   *
   * The console allows exactly one continuous motion verb and it is TRACK,
   * which is clock-driven; SETTLE is the UI verb and the contract says it never
   * loops. So a decorative pulse to say "press me" does not ship here. What
   * moves instead is the countdown the button is offering: the band across its
   * foot runs with the ten seconds to the gun and starts over with the loop,
   * and the arrow rides it. The button is alive because the race is.
   *
   * Written as a number on the element rather than through React, the way the
   * rest of this layer writes a reading. Because it is a function of the replay
   * clock and not of wall time, the capture hold freezes it with everything
   * else and two screenshots of a stated time draw the same button.
   */
  useEffect(() => {
    const node = button.current;
    if (node === null) return;
    const span = 0 - race.tMin;
    const write = (t: number): void => {
      const run = span > 0 ? Math.min(1, Math.max(0, (t - race.tMin) / span)) : 0;
      node.style.setProperty("--go-run", run.toFixed(4));
    };
    write(useReplay.getState().t);
    return useReplay.subscribe((state) => {
      if (!state.briefDone) write(state.t);
    });
  }, [race]);

  const release = useCallback(() => {
    const state = useReplay.getState();
    if (state.briefDone) return;
    /* Hand the clock back where the replay wants it: inside the prestart for
     * an autoplay, so the gun is something the viewer watches happen; at the
     * mid-beat moment for a viewer who asked for less motion, who gets no
     * autoplay and should not be left on an empty start line. The reduced
     * branch also undoes the one prestart seek the loop can land before the
     * media query has been read into the store. */
    state.seek(state.reducedMotion ? OPEN_AT : AUTOPLAY_FROM);
    state.releaseBrief();
  }, []);

  /* Enter releases the brief from anywhere on the page, except while a viewer
   * is typing, because the analyst's composer is one Tab away, and except on a
   * control that already answers Enter itself.
   *
   * That last one is not hypothetical. A button takes Enter as its own
   * activation and the keydown reaches the document undefaulted, so with the
   * view switch focused one press both changed the drawing and released the
   * brief: the reader asked to see the other view and got the race instead.
   * Continue loses nothing by the exclusion, since it is a button and its own
   * activation is what releases the brief when focus is on it. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" || event.defaultPrevented) return;
      const active = document.activeElement;
      const tag = active === null ? "" : active.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "A") return;
      if (active instanceof HTMLElement && active.isContentEditable) return;
      release();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [release]);

  return (
    <section
      className={styles.brief}
      ref={root}
      data-brief-view={view}
      aria-label={`Race brief, ${name}`}
    >
      <RaceBriefDither reduced={reduced} />

      <header className={styles.briefHead}>
        <div className={styles.raceName} ref={title}>
          {name}
        </div>
        <div className={styles.headRow}>
          <div className={styles.raceMeta}>
            {venue} · {dateLabel} · {facts.boats.length} boats · one windward-leeward lap
          </div>
          {/* The same gesture the console's transport already carries, one layer
              up: a segmented pair that swaps which half of the race is on
              screen and changes nothing else. Both views read the same
              RaceData, so this switches what is being described and never
              whether the two descriptions agree. */}
          <div className={styles.viewSwitch} role="group" aria-label="Which half of the race to read">
            <button
              type="button"
              className={view === "panels" ? `${styles.viewBtn} ${styles.viewBtnOn}` : styles.viewBtn}
              aria-pressed={view === "panels"}
              data-brief-switch="panels"
              onClick={() => setView("panels")}
            >
              Panels
            </button>
            <button
              type="button"
              className={
                view === "performance" ? `${styles.viewBtn} ${styles.viewBtnOn}` : styles.viewBtn
              }
              aria-pressed={view === "performance"}
              data-brief-switch="performance"
              onClick={() => setView("performance")}
            >
              Performance
            </button>
          </div>
          {/* The start facts, stated once for both views on the rule that
              already carries the race's own meta line. The countdown span is
              written by the shell's clock subscription above. */}
          <p className={styles.headFacts}>
            <span ref={gunIn}>{`gun in ${Math.max(0, -race.tMin).toFixed(1)} s`}</span>
            <span>
              {facts.first === null
                ? "no boat crossed"
                : `${facts.first.sail} ${signed(facts.first.t, 2)} s first cross`}
            </span>
            <span>{`line ${Math.round(facts.lineLength)} m`}</span>
          </p>
        </div>
      </header>

      {view === "panels" ? (
        <BriefPanels race={race} reduced={reduced} />
      ) : (
        <BriefPerformance race={race} />
      )}

      <div className={styles.briefFoot}>
        {/* Named the way the console names its own controls, because the layer
            carries three buttons now and "the button on the cover" stopped
            being a way to find this one. */}
        <button
          className={styles.goBtn}
          type="button"
          data-control="brief-go"
          onClick={release}
          ref={button}
        >
          Start the race
          <span className={styles.goArrow} aria-hidden="true">
            →
          </span>
        </button>
      </div>
    </section>
  );
}
