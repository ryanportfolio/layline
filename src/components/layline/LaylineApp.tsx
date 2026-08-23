"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import styles from "@/app/layline.module.css";
import sea from "./bootSea.module.css";
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
import { useSpaceToggle, useWaterPointer, useWheelZoom } from "./useWaterPointer";

/* WebGL cannot render on the server, and the loading state has nothing to add:
 * the server-rendered chart is already on screen in the layer above and stays
 * there until the renderer has a real frame to replace it with. */
const SceneIsland = dynamic(() => import("./scene/LaylineScene").then((m) => m.LaylineScene), {
  ssr: false,
  loading: () => null,
});

export function LaylineApp({
  children,
  venue,
  autoplay = "intro",
  boot = "intro",
  bootLabel,
}: {
  children: ReactNode;
  venue?: string;
  /* When the replay starts itself, and what it waits for.
   *
   * "intro" is the story page: the intro overlay covers the viewport for its
   * first second or so, and playing under it would run the gun off behind the
   * cover, so playback waits for the overlay to let go.
   *
   * "immediate" is the race library, which has no overlay to wait for. It
   * cannot reuse the "intro" path: introDone is one latch on a store that
   * survives navigation, so a library entered after the story would start and
   * a library entered directly would not, and playback would depend on which
   * page the visitor saw first. Starting on its own mount is the same
   * behaviour every time, including on each race the rail selects. */
  autoplay?: "intro" | "immediate" | false;
  /* What covers the wait while the renderer boots. "intro" is the story page,
   * whose overlay is over the viewport anyway, so the server chart holds
   * hidden behind it and never flashes on a machine that boots inside the
   * grace window.
   *
   * "sea" is the library, which has no overlay. It covers the wait with the
   * sky and water the scene itself opens on, so the renderer resolves out of
   * a picture it already agrees with rather than cutting in over a dark hole.
   * The chart underneath it stays the honest answer for a machine that never
   * gets a renderer, and reveals on its own if none arrives. */
  boot?: "intro" | "sea";
  /* Named on the cover while the renderer boots, so the wait is a title card
   * for the race being loaded rather than an empty sea. */
  bootLabel?: string;
}) {
  const race = useMemo(() => raceData(), []);
  const live = useReplay((state) => state.webglOk);
  const chart2d = useReplay((state) => state.chart2d);
  const rig = useReplay((state) => state.rig);

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

  /* The sea cover's three states. It is up while the renderer boots, over the
   * chart as well as the canvas so nothing paints through it; it leaves the
   * moment the renderer puts up a frame, taking 900ms about it so the scene
   * gains depth under it rather than replacing it; and it leaves anyway at
   * 2.6s if no frame ever comes, which is what hands a machine with no WebGL
   * the chart it is entitled to. Gone unmounts it, one fade later. */
  const [cover, setCover] = useState<"up" | "out" | "gone">("up");
  useEffect(() => {
    if (boot !== "sea") return;
    if (live) {
      setCover("out");
      const timer = window.setTimeout(() => setCover("gone"), 1100);
      return () => window.clearTimeout(timer);
    }
    setCover("up");
    const timer = window.setTimeout(() => setCover("out"), 2600);
    return () => window.clearTimeout(timer);
  }, [live, boot]);

  /* Read once at mount. A visitor who has asked for less motion gets the
   * replay paused at a mid-beat moment with everything reachable by hand,
   * never a still frame of an empty start line and never an autoplay.
   *
   * Everyone else gets the autoplay from the prestart, so the gun is something
   * you watch happen. On the story page it waits: the intro is covering the
   * viewport and the prestart is five seconds long, so playing here would run
   * the gun off behind the cover, and the intro says when it has let go. In
   * the library there is no cover, so it starts on mount. */
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const replay = useReplay.getState();
    replay.setReducedMotion(reduced);
    replay.setHudReady(true);
    if (reduced) {
      replay.setIntroDone(true);
      return;
    }
    if (autoplay === false) return;
    const start = () => {
      const state = useReplay.getState();
      state.seek(AUTOPLAY_FROM);
      state.play();
    };
    if (autoplay === "immediate" || replay.introDone) {
      start();
      return;
    }
    const stop = useReplay.subscribe((state) => {
      if (!state.introDone) return;
      stop();
      start();
    });
    return stop;
  }, [autoplay]);

  /* One word to a line, sized so the longest of them fills the viewer. 0.6em is
   * this face's rough average advance, which is close enough to pick a size
   * that never runs past the pane; the cap stops a two word name filling the
   * whole picture. */
  const bootWords = useMemo(
    () => (bootLabel === undefined ? [] : bootLabel.split(/\s+/).filter((word) => word !== "")),
    [bootLabel],
  );
  const bootSize = useMemo(() => {
    const longest = bootWords.reduce((most, word) => Math.max(most, word.length), 0);
    if (longest === 0) return undefined;
    return `min(168px, calc(86cqi / ${(longest * 0.6).toFixed(2)}))`;
  }, [bootWords]);

  /* The water is also the one surface with no native pointer on it: the boat
   * cursor draws its own, and it needs the layer to hang the listeners off.
   * Every pointer rule the water carries hangs off the same element: picking a
   * boat, steering the freeform camera, and the click on open water that has
   * always been this page's play/pause. */
  const waterRef = useRef<HTMLDivElement | null>(null);
  useWaterPointer(waterRef, live);
  useWheelZoom(waterRef, live && rig === "freeform" && !chart2d);
  useSpaceToggle();

  return (
    <div className={styles.stage} data-boot={boot}>
      <div
        ref={waterRef}
        className={live ? `${styles.canvasLayer} ${styles.canvasLive}` : styles.canvasLayer}
        /* Touch belongs to the page until the visitor asks for the camera.
           Only while the freeform rig is up does a finger on the water stop
           being a scroll, and the attribute goes away with the mode, so a
           phone can never be left unable to scroll past the replay. */
        /* Gated on a live renderer as well as on the mode. The store outlives
           a canvas, so a revisit or a lost context can leave the rig set to
           freeform with no frame on screen, no pointer handlers attached and
           no transport to change it with: the attribute alone would then hold
           the page's scroll hostage over a picture nobody can steer. */
        data-camera={live && rig === "freeform" && !chart2d ? "freeform" : undefined}
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

      {/* The water the scene opens on, painted flat. Fades out under the first
          rendered frame, so what changes is the picture gaining depth rather
          than a layer being swapped for another. */}
      {boot === "sea" && cover !== "gone" ? (
        <div
          className={cover === "out" ? `${sea.cover} ${sea.out}` : sea.cover}
          aria-hidden="true"
        >
          {bootWords.length === 0 ? null : (
            <span className={sea.label} style={{ fontSize: bootSize }}>
              {bootWords.map((word, index) => (
                <span key={`${word}-${index}`} className={sea.word}>
                  {word}
                </span>
              ))}
            </span>
          )}
        </div>
      ) : null}

      <TopBar race={race} venue={venue} />

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
