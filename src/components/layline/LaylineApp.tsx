"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import styles from "@/app/layline.module.css";
import { CaptureBridge } from "./CaptureBridge";
import { Instruments } from "./hud/Instruments";
import { Standings } from "./hud/Standings";
import { Timeline } from "./hud/Timeline";
import { TopBar } from "./hud/TopBar";
import { Transport } from "./hud/Transport";
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
   * never a still frame of an empty start line and never an autoplay. */
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const replay = useReplay.getState();
    replay.setReducedMotion(reduced);
    replay.setHudReady(true);
    if (reduced) return;
    replay.seek(AUTOPLAY_FROM);
    replay.play();
  }, []);

  return (
    <div className={styles.stage}>
      <div className={live ? `${styles.canvasLayer} ${styles.canvasLive}` : styles.canvasLayer}>
        <SceneIsland race={race} />
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
