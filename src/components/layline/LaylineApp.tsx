"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import styles from "@/app/layline.module.css";
import { BoatCursor } from "./BoatCursor";
import { CaptureBridge } from "./CaptureBridge";
import { Instruments } from "./hud/Instruments";
import { Standings } from "./hud/Standings";
import { StartLine } from "./hud/StartLine";
import { Timeline } from "./hud/Timeline";
import { TopBar } from "./hud/TopBar";
import { Transport } from "./hud/Transport";
import { VmgStrip } from "./hud/VmgStrip";
import { ChartView } from "./svg/ChartView";
import { AUTOPLAY_FROM, raceData, useReplay } from "./store";

/* WebGL cannot render on the server, and the loading state has nothing to add:
 * the server-rendered chart is already on screen in the layer above and stays
 * there until the renderer has a real frame to replace it with. */
const SceneIsland = dynamic(() => import("./scene/LaylineScene").then((m) => m.LaylineScene), {
  ssr: false,
  loading: () => null,
});

export function LaylineApp({ children }: { children: ReactNode }) {
  const race = useMemo(() => raceData(), []);
  const live = useReplay((state) => state.webglOk);
  const chart2d = useReplay((state) => state.chart2d);

  /* On desktop the chart lives 350ms past the renderer's first frame so it
   * can fade out instead of cutting; boot inside its own 1.2s reveal delay
   * and it unmounts while still hidden, so it never flashes. Mobile lays the
   * chart out in flow and keys layout off its presence, so there it unmounts
   * the moment the renderer is live. */
  const [chartGone, setChartGone] = useState(false);
  useEffect(() => {
    if (!live) {
      setChartGone(false);
      return;
    }
    const overlay = window.matchMedia("(min-width: 901px)").matches;
    if (!overlay) {
      setChartGone(true);
      return;
    }
    const timer = window.setTimeout(() => setChartGone(true), 420);
    return () => window.clearTimeout(timer);
  }, [live]);

  /* Read once at mount. A visitor who has asked for less motion gets the
   * replay paused at a mid-beat moment with everything reachable by hand,
   * never a still frame of an empty start line and never an autoplay.
   *
   * Everyone else gets the autoplay, but not yet: the intro is covering the
   * viewport and the prestart is five seconds long, so playing here would run
   * the gun off behind the cover. The intro says when it has let go. */
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const replay = useReplay.getState();
    replay.setReducedMotion(reduced);
    replay.setHudReady(true);
    if (reduced) {
      replay.setIntroDone(true);
      return;
    }
    const start = () => {
      const state = useReplay.getState();
      state.seek(AUTOPLAY_FROM);
      state.play();
    };
    if (replay.introDone) {
      start();
      return;
    }
    const stop = useReplay.subscribe((state) => {
      if (!state.introDone) return;
      stop();
      start();
    });
    return stop;
  }, []);

  /* The water is the biggest play/pause target on the page, video-player
   * style. A press only counts as a click if the pointer barely moved; a drag
   * or a touch scroll travels past the threshold (or ends in pointercancel)
   * and leaves playback alone. The docks and top bar sit above this layer, so
   * their controls never fall through to it. */
  const press = useRef<{ x: number; y: number; id: number } | null>(null);

  /* The water is also the one surface with no native pointer on it: the boat
   * cursor draws its own, and it needs the layer to hang the listeners off. */
  const waterRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className={styles.stage}>
      <div
        ref={waterRef}
        className={live ? `${styles.canvasLayer} ${styles.canvasLive}` : styles.canvasLayer}
        onPointerDown={(event) => {
          if (!live || event.button !== 0) return;
          press.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
        }}
        onPointerUp={(event) => {
          const start = press.current;
          press.current = null;
          if (!start || start.id !== event.pointerId) return;
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
          useReplay.getState().toggle();
        }}
        onPointerCancel={() => {
          press.current = null;
        }}
      >
        {/* 2D mode hides the renderer, it does not unmount it: the replay clock
            runs inside the render loop, and the boat plates the scene owns hang
            off the same element. Hidden, both stop being seen and neither stops
            working, so the mode switch is instant in both directions. */}
        <div className={chart2d ? styles.sceneHeld : styles.sceneShown}>
          <SceneIsland race={race} />
        </div>
        {live && chart2d ? <ChartView race={race} /> : null}
        <BoatCursor targetRef={waterRef} />
      </div>

      <TopBar race={race} />

      {/* Instruments describe a scene. Until there is one, the docks stay out
          of the way of the chart that is standing in for it. */}
      <div className={styles.dockLeft} data-dock="standings">
        {live ? <Standings race={race} /> : null}
      </div>
      <div className={styles.dockRight} data-dock="instruments">
        {live ? <Instruments race={race} /> : null}
      </div>
      <div className={styles.dockBottom} data-dock="transport">
        {live ? (
          <div className={styles.panel}>
            <Transport />
            <StartLine race={race} />
            <VmgStrip race={race} />
            <Timeline race={race} />
          </div>
        ) : null}
      </div>

      {chartGone ? null : (
        <div className={live ? `${styles.fallbackLayer} ${styles.fallbackOut}` : styles.fallbackLayer}>
          {children}
        </div>
      )}

      <CaptureBridge />
    </div>
  );
}
