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
import { RaceBrief } from "./RaceBrief";
import { AUTOPLAY_FROM, raceData, useReplay } from "./store";

/** WCAG relative luminance of a #rrggbb token. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return 1;
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

/* Above this the sky's bright band takes near-black type, below it near-white.
 * Placed where both branches clear 3:1 against the band by a margin rather
 * than at the crossover, so neither is ever marginal. */
const LIGHT_SKY = 0.35;
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
  bootBrief,
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
  /* The race the cover briefs while the renderer boots. Given, the sea carries
   * the brief and holds until a viewer releases it; withheld, it is the bare
   * sea it always was and leaves on its own. Every number the brief puts up is
   * read out of the RaceData below, not out of this: what comes through here
   * is only what the registry knows and a simulation cannot. */
  bootBrief?: { name: string; venue: string; dateLabel: string };
}) {
  const race = useMemo(() => raceData(), []);
  const live = useReplay((state) => state.webglOk);
  const chart2d = useReplay((state) => state.chart2d);
  const rig = useReplay((state) => state.rig);
  const briefDone = useReplay((state) => state.briefDone);
  const reducedMotion = useReplay((state) => state.reducedMotion);
  /* The capture hold, which stops the replay clock, has to stop this layer's
   * own entrance as well: two screenshots of the same stated race time taken a
   * tenth of a second apart would otherwise catch the plates at two points of
   * one 420ms fade and hash differently. */
  const frozen = useReplay((state) => state.frozen);
  const briefed = boot === "sea" && bootBrief !== undefined;

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
    /* A briefed cover is a gate, not a wait. It holds however long the renderer
     * takes and however long the reader takes, and the only thing that moves it
     * is the reader: Continue, or Enter. A slow machine keeps the brief, which
     * is the whole reason the wait now has numbers in it. */
    if (briefed) {
      if (!briefDone) {
        setCover("up");
        return;
      }
      setCover("out");
      const timer = window.setTimeout(() => setCover("gone"), 1100);
      return () => window.clearTimeout(timer);
    }
    if (live) {
      setCover("out");
      const timer = window.setTimeout(() => setCover("gone"), 1100);
      return () => window.clearTimeout(timer);
    }
    setCover("up");
    const timer = window.setTimeout(() => setCover("out"), 2600);
    return () => window.clearTimeout(timer);
  }, [live, boot, briefed, briefDone]);

  /* The header's ink branch. The sky the brief's title sits on is the
     sky-horizon token nearly neat, and the library ships a light one, so the
     stylesheet states the near-black branch and this corrects to near-white
     only when a build darkens the token. Reading the computed value rather
     than the literal keeps the two in step through a theme or an override. */
  const coverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = coverRef.current;
    if (node === null) return;
    const sky = getComputedStyle(node).getPropertyValue("--sky-horizon").trim();
    if (!/^#[0-9a-f]{6}$/i.test(sky) || luminance(sky) > LIGHT_SKY) return;
    node.style.setProperty("--brief-head-ink", `color-mix(in srgb, #ffffff 88%, ${sky})`);
    node.style.setProperty("--brief-head-line", "rgba(255, 255, 255, 0.3)");
  }, [cover]);

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
    /* Two covers, one rule: play when the thing covering the viewport has let
     * go. The story page waits on its intro overlay, the briefed library on
     * the brief its reader releases, and an unbriefed library has nothing to
     * wait for and starts on mount. */
    const gate: "intro" | "brief" | null =
      autoplay === "immediate" ? (briefed ? "brief" : null) : "intro";
    if (gate === null) {
      start();
      return;
    }
    if (gate === "intro" && replay.introDone) {
      start();
      return;
    }
    if (gate === "brief" && replay.briefDone) {
      start();
      return;
    }
    const stop = useReplay.subscribe((state) => {
      if (!(gate === "brief" ? state.briefDone : state.introDone)) return;
      stop();
      start();
    });
    return stop;
  }, [autoplay, briefed]);

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
    <div className={styles.stage} data-boot={boot} data-gate={briefed && !briefDone ? "brief" : undefined}>
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

      {/* The water the scene opens on, painted flat, with the race brief over
          it. Fades out under the first rendered frame, so what changes is the
          picture gaining depth rather than a layer being swapped for another.
          Bare, it is decorative and hidden from a screen reader; briefed, it
          carries the only control on the layer and must not be. */}
      {boot === "sea" && cover !== "gone" ? (
        <div
          ref={coverRef}
          className={[sea.cover, briefed ? sea.briefed : "", cover === "out" ? sea.out : ""]
            .filter((name) => name !== "")
            .join(" ")}
          data-brief-motion={briefed ? (reducedMotion ? "off" : "on") : undefined}
          data-brief-still={briefed && frozen ? "" : undefined}
          aria-hidden={briefed ? undefined : "true"}
          style={briefed ? undefined : { pointerEvents: "none" }}
        >
          {briefed && bootBrief !== undefined ? (
            <RaceBrief
              race={race}
              name={bootBrief.name}
              venue={bootBrief.venue}
              dateLabel={bootBrief.dateLabel}
              live={live}
              reduced={reducedMotion}
            />
          ) : null}
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
