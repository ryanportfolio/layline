"use client";

import dynamic from "next/dynamic";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import styles from "@/app/layline.module.css";
import {
  type AnalysisWorkspaceId,
  type LayerId,
  type LayerOverride,
  analysisReplayCadenceKey,
  resolveAnalysisWorkspace,
} from "@/lib/layline/analysis-state";
import {
  LEGACY_REPLAY_LAYER_VISIBILITY,
  STAGE7_ANALYSIS_LAYER_CAPABILITIES,
  rendererLayerVisibility,
} from "@/lib/layline/analysis-layers";
import {
  analysisWorkspacePanelDock,
  analysisWorkspaceSelectedRange,
} from "@/lib/layline/analysis-workspace-ui";
import { compareRange } from "@/lib/layline/comparison";
import { generateRace } from "@/lib/layline/sim";
import {
  buildLaylineInspectionSurface,
  createInspectionCadence,
  createInspectionPlayingCadenceBudget,
  inspectionCadenceStep,
  type InspectionCadenceState,
  type InspectionPlayingCadenceBudget,
  type LaylineInspectionSurface,
} from "@/lib/layline/surfaces";
import type { RaceData, ReplayMode } from "@/lib/layline/types";
import sea from "./bootSea.module.css";
import { BoatCursor } from "./BoatCursor";
import { requestInspectionSurface } from "./inspectionSurfaceClient";
import { CaptureBridge } from "./CaptureBridge";
import { Instruments } from "./hud/Instruments";
import { AnalysisWorkspacePanel } from "./hud/AnalysisWorkspacePanel";
import { AnalysisWorkspaceTabs } from "./hud/AnalysisWorkspaceTabs";
import { ComparisonPanel } from "./hud/ComparisonPanel";
import { Standings } from "./hud/Standings";
import { StartLine } from "./hud/StartLine";
import { Timeline } from "./hud/Timeline";
import { TopBar } from "./hud/TopBar";
import { Transport } from "./hud/Transport";
import { TruthInspector } from "./hud/TruthInspector";
import { VectorTriangle } from "./hud/VectorTriangle";
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
/* memo, because the app re-renders at the analysis cadence while the race
 * plays and the Canvas must not: see the stableSceneLayers note below. */
const SceneIsland = memo(
  dynamic(() => import("./scene/LaylineScene").then((m) => m.LaylineScene), {
    ssr: false,
    loading: () => null,
  }),
);

/** Compact route-owned input for a deterministic first render. */
export interface InitialRaceAuthority {
  readonly id: string;
  readonly seed: number;
}

/* Prove the capability before R3F mounts. Canvas otherwise retries a failed
 * renderer on every parent update, turning the real SVG fallback into a stream
 * of fatal page errors on machines where WebGL is unavailable. The temporary
 * probe context is released immediately and never becomes render state. */
function browserSupportsWebgl(): boolean {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (context === null) return false;
  context.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}

/* One replay clock serves every renderer. Keeping it above the optional scene
 * means explicit 2D and true no-WebGL playback advance through the same store
 * transition as 3D, while idle and frozen pages own no animation frame. */
function useReplayClock(playing: boolean, frozen: boolean) {
  useEffect(() => {
    if (!playing || frozen) return;
    let previous: number | null = null;
    let frame = 0;
    const tick = (now: number) => {
      const replay = useReplay.getState();
      if (!replay.playing || replay.frozen) return;
      if (previous !== null) {
        replay.advance(Math.min((now - previous) / 1000, 0.25) * replay.rate);
      }
      previous = now;
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [frozen, playing]);
}

function useLaylineInspection(
  race: RaceData,
  budget: InspectionPlayingCadenceBudget,
  boatId: string,
  mode: ReplayMode,
): LaylineInspectionSurface | null {
  const [entry, setEntry] = useState<{
    race: RaceData;
    boatId: string;
    mode: ReplayMode;
    surface: LaylineInspectionSurface;
  } | null>(null);
  const cadence = useRef<InspectionCadenceState | null>(null);
  if (cadence.current === null || cadence.current.budget !== budget) {
    cadence.current = createInspectionCadence(budget);
  }
  useEffect(() => {
    let timer: number | null = null;
    let disposed = false;
    let refreshTicket = 0;
    const evaluate = (settleClock = 0) => {
      if (disposed) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      const replay = useReplay.getState();
      const previous = cadence.current;
      if (previous === null) return;
      const result = inspectionCadenceStep(
        previous,
        {
          race,
          boatId: replay.followId,
          mode: replay.mode,
          t: replay.t,
          playing: replay.playing,
          frozen: replay.frozen,
        },
        settleClock,
      );
      cadence.current = result.state;
      if (result.action === "refresh") {
        const refreshBoatId = replay.followId;
        const refreshMode = replay.mode;
        const refreshAt = replay.t;
        const hold = (surface: LaylineInspectionSurface) => {
          /* The scene reads the surface from the store, not from props: a prop
           * would re-render the element owning the Canvas once a second, and
           * with a shed dpr tier every such render costs two buffer resizes. */
          useReplay.getState().setInspectionHeld({ race, surface });
          setEntry({
            race,
            boatId: refreshBoatId,
            mode: refreshMode,
            surface,
          });
        };
        /* A playing replay hands the build to the worker: the trace behind a
         * surface runs tens of thousands of candidate evaluations, and on the
         * main thread that lands as one long task inside the frame loop. The
         * worker returns the identical surface (same function over a clone of
         * the same race data) a few frames later, which the once-a-race-second
         * cadence never notices. Frozen and paused replays build in place: a
         * settled clock, and the capture rig behind it, must see the surface
         * the moment it settles. A stale ticket is a newer refresh already in
         * flight; its reply would overwrite fresher evidence, so it is
         * dropped. */
        const ticket = ++refreshTicket;
        const offloaded = replay.playing && !replay.frozen
          ? requestInspectionSurface(race, refreshBoatId, refreshAt)
          : null;
        if (offloaded === null) {
          hold(buildLaylineInspectionSurface(race, refreshBoatId, refreshAt));
        } else {
          void offloaded.then((surface) => {
            if (disposed || ticket !== refreshTicket) return;
            hold(surface ?? buildLaylineInspectionSurface(race, refreshBoatId, refreshAt));
          });
        }
      } else {
        setEntry((current) =>
          current !== null &&
          current.race === race &&
          current.boatId === replay.followId &&
          current.mode === replay.mode
            ? current
            : null,
        );
      }
      if (result.dueAtMs !== null && !replay.playing && !replay.frozen) {
        timer = window.setTimeout(
          () => evaluate(result.dueAtMs as number),
          Math.max(0, result.dueAtMs - settleClock),
        );
      }
    };
    evaluate();
    const unsubscribe = useReplay.subscribe(() => evaluate());
    return () => {
      disposed = true;
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [budget, race]);
  return entry?.race === race && entry.boatId === boatId && entry.mode === mode
    ? entry.surface
    : null;
}

export function LaylineApp({
  children,
  initialRace,
  useInitialRace = false,
  venue,
  autoplay = "intro",
  boot = "intro",
  bootBrief,
  comparison = false,
  analysisWorkspaces = false,
  inspectionCadenceBudget,
}: {
  children: ReactNode;
  initialRace?: InitialRaceAuthority;
  useInitialRace?: boolean;
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
  /* Enables the replay-workspace comparison surface without changing the
   * story console that shares this viewer shell. */
  comparison?: boolean;
  /* Race-library task composition. State remains in the replay store. */
  analysisWorkspaces?: boolean;
  inspectionCadenceBudget?: InspectionPlayingCadenceBudget;
}) {
  const [localBudget] = useState(() => createInspectionPlayingCadenceBudget());
  const activeInspectionCadenceBudget =
    inspectionCadenceBudget ?? localBudget;
  /* The route identity is the only race authority during SSR and the matching
   * first client render. It builds a request-local value and never points the
   * module-global browser store during SSR. Once RaceWorkspace's mount effect
   * has selected the same race, the existing store becomes sole owner again. */
  const initialRaceData = useMemo(
    () =>
      useInitialRace && initialRace !== undefined
        ? generateRace(initialRace.seed)
        : null,
    [initialRace, useInitialRace],
  );
  const race = useMemo(() => initialRaceData ?? raceData(), [initialRaceData]);
  const [webglCapable, setWebglCapable] = useState(false);
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
  const playing = useReplay((state) => state.playing);
  const briefed = boot === "sea" && bootBrief !== undefined;
  const truthMode = useReplay((state) => state.truthMode);
  const followId = useReplay((state) => state.followId);
  const replayMode = useReplay((state) => state.mode);
  const analysis = useReplay((state) => state.analysis);
  useEffect(() => {
    setWebglCapable(browserSupportsWebgl());
  }, []);
  useReplayClock(playing, frozen);
  const analysisReplayCadence = useReplay((state) =>
    analysisWorkspaces && !state.analysis.rangePinned
      ? analysisReplayCadenceKey(state.t)
      : 0,
  );
  const analysisWorkspace = useMemo(() => {
    // This token advances at the bounded analysis cadence even though the
    // current replay time is intentionally read once at resolution below.
    void analysisReplayCadence;
    return !analysisWorkspaces
        ? null
        : resolveAnalysisWorkspace(
            analysis,
            race,
            useReplay.getState().t,
            {
              primaryBoatId: followId,
              performanceAvailable:
                STAGE7_ANALYSIS_LAYER_CAPABILITIES.performance.available,
            },
          );
  }, [analysis, analysisReplayCadence, analysisWorkspaces, followId, race]);
  const layerIntent = analysisWorkspace?.layers ?? LEGACY_REPLAY_LAYER_VISIBILITY;
  const sceneLayersFresh = useMemo(
    () => rendererLayerVisibility(layerIntent, "3d"),
    [layerIntent],
  );
  const chartLayers = useMemo(
    () => rendererLayerVisibility(layerIntent, "2d"),
    [layerIntent],
  );
  const noWebglLayers = useMemo(
    () => rendererLayerVisibility(layerIntent, "no-webgl"),
    [layerIntent],
  );

  /* The scene's props must hold their references between renders:
   * resolveAnalysisWorkspace hands back a fresh layers object at the analysis
   * cadence, and a scene re-rendered with it would re-render the Canvas at
   * that cadence. Every Canvas re-render re-runs the renderer's reconfigure
   * pass, which re-applies the dpr prop; once the quality governor has shed a
   * tier, that is two full drawing-buffer resizes per re-render, a stutter no
   * frame budget survives. SceneIsland is memoized at its declaration, so with
   * the layers object swapped only when its VALUES change, app re-renders
   * never reach the Canvas. */
  const sceneLayersRef = useRef(sceneLayersFresh);
  if (JSON.stringify(sceneLayersRef.current) !== JSON.stringify(sceneLayersFresh)) {
    sceneLayersRef.current = sceneLayersFresh;
  }
  const sceneLayers = sceneLayersRef.current;
  const selectedAnalysisRange = useMemo(
    () => analysisWorkspaceSelectedRange(analysisWorkspace, analysis.selectedRange),
    [analysis.selectedRange, analysisWorkspace],
  );
  const timelineSelectedRange =
    analysisWorkspace === null ? undefined : selectedAnalysisRange;
  const rangeComparison = useMemo(
    () =>
      compareRange(race, {
        primaryBoatId: followId,
        reference: analysis.reference,
        range: selectedAnalysisRange,
      }),
    [analysis.reference, followId, race, selectedAnalysisRange],
  );
  const inspection = useLaylineInspection(
    race,
    activeInspectionCadenceBudget,
    followId,
    replayMode,
  );
  const visibleInspection = inspection?.boatId === followId ? inspection : null;

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

  const analysisWorkspaceReady = !briefed || briefDone;
  const truthFallbackUp =
    !live && analysisWorkspaceReady && (analysisWorkspace !== null || truthMode);
  const analysisPanelDock = analysisWorkspace === null
    ? null
    : analysisWorkspacePanelDock(analysisWorkspace.panel);
  /* The velocity triangle leaves the busy right column and takes the open
   * water beside the transport, everywhere that corner is actually open:
   * Compare owns the bottom-left with its own panel, so there the triangle
   * stays inline with the inspector it belongs to. */
  const vectorDocked =
    analysisWorkspaceReady &&
    analysisWorkspace !== null &&
    analysisWorkspace.workspaceId !== "compare" &&
    (analysisPanelDock === "right" || truthMode || live);
  const selectWorkspace = (workspaceId: AnalysisWorkspaceId) => {
    useReplay.getState().selectAnalysisWorkspace(workspaceId);
  };
  const setLayer = (layerId: LayerId, override: LayerOverride | "default") => {
    useReplay.getState().setAnalysisLayer(layerId, override);
  };
  const analysisTabs = analysisWorkspace === null ? null : (
    <AnalysisWorkspaceTabs
      active={analysisWorkspace.workspaceId}
      onSelect={selectWorkspace}
    />
  );
  const analysisPanel = analysisWorkspace === null ? null : (
    <AnalysisWorkspacePanel
      race={race}
      workspace={analysisWorkspace}
      session={analysis}
      comparison={rangeComparison}
      inspection={visibleInspection}
      vector={!vectorDocked}
      onLayerChange={setLayer}
      onReset={() => useReplay.getState().resetAnalysisWorkspace()}
    />
  );

  const stage = (
    <div
      className={styles.stage}
      data-boot={boot}
      data-gate={briefed && !briefDone ? "brief" : undefined}
      data-analysis-ready={analysisWorkspace !== null && analysisWorkspaceReady ? "true" : undefined}
      data-analysis-workspace={analysisWorkspaceReady ? analysisWorkspace?.workspaceId : undefined}
      data-analysis-panel-dock={analysisWorkspaceReady ? analysisPanelDock ?? undefined : undefined}
      data-vector-dock={vectorDocked ? "true" : undefined}
      data-analysis-flow="viewer"
    >
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
        {webglCapable ? (
          <div className={chart2d ? styles.sceneHeld : styles.sceneShown}>
            <SceneIsland race={race} layers={sceneLayers} />
          </div>
        ) : null}
        {live && chart2d ? (
          <ChartView race={race} inspection={visibleInspection} layers={chartLayers} />
        ) : null}
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
              reduced={reducedMotion}
            />
          ) : null}
        </div>
      ) : null}

      <TopBar
        race={race}
        venue={venue}
        analysisNavigation={analysisWorkspaceReady ? analysisTabs : undefined}
      />

      {/* Instruments describe a scene. Until there is one, the docks stay out
          of the way of the chart that is standing in for it. */}
      <div className={styles.dockLeft} data-dock="standings">
        {live && analysisWorkspace === null ? <Standings race={race} /> : null}
        {analysisWorkspaceReady && analysisPanelDock === "left" ? analysisPanel : null}
      </div>
      {/* The truth branch outranks Compare's otherwise-empty dock: the TopBar
          toggle advertises aria-controls="truth-inspector" in every workspace,
          so the inspector must be able to exist in every workspace. Only the
          Evidence panel, which contains the same inspector, still supersedes
          it. */}
      <div className={styles.dockRight} data-dock="instruments">
        {analysisWorkspaceReady && analysisPanelDock === "right" ? (
          analysisPanel
        ) : truthMode && analysisWorkspace?.panel !== "truth-provenance" ? (
          <TruthInspector race={race} inspection={visibleInspection} vector={!vectorDocked} />
        ) : analysisWorkspace?.panel === "comparison" ? null : live ? (
          <Instruments race={race} inspection={visibleInspection} vector={!vectorDocked} />
        ) : null}
      </div>
      {/* The velocity triangle on its own plate in the open bottom-left water,
          whenever the right column would otherwise carry it. Same surface,
          same inspection, one mounted instance either way. */}
      <div className={styles.dockVector} data-dock="vector">
        {vectorDocked ? (
          <section className={styles.panel} aria-label="Water current and ground vectors">
            <VectorTriangle race={race} inspection={visibleInspection} />
          </section>
        ) : null}
      </div>
      <div className={styles.dockBottom} data-dock="transport">
        {(analysisWorkspace === null || analysisWorkspaceReady) && (live || comparison) ? (
          <div className={styles.panel}>
            {(live || comparison) ? <Transport /> : null}
            {live && analysisWorkspace === null ? <StartLine race={race} /> : null}
            {live && analysisWorkspace === null ? <VmgStrip race={race} /> : null}
            {comparison && analysisWorkspace === null ? (
              <ComparisonPanel race={race} comparison={rangeComparison} />
            ) : null}
            <Timeline
              race={race}
              comparison={comparison ? rangeComparison : undefined}
              selectedRange={timelineSelectedRange}
              visibleLaneIds={analysisWorkspace?.timelineLaneIds}
            />
          </div>
        ) : null}
      </div>

      {/* Once client task controls exist, no-WebGL uses the same replay-aware
          SVG, selected boat, inspection and layer visibility as explicit 2D.
          The server chart remains the honest first paint and no-JS still.
          While this layer is up the static chart below unmounts: chartGone
          only ever latches off a live renderer, so without WebGL the two
          fallbacks would otherwise stay mounted together, duplicating the
          content and sizing the stage twice on mobile. */}
      {chartGone || truthFallbackUp ? null : (
        <div className={live ? `${styles.fallbackLayer} ${styles.fallbackOut}` : styles.fallbackLayer}>
          {children}
        </div>
      )}

      {truthFallbackUp ? (
        <div className={styles.truthFallbackLayer}>
          <ChartView race={race} inspection={visibleInspection} layers={noWebglLayers} />
        </div>
      ) : null}

      <CaptureBridge />
    </div>
  );

  return stage;
}
