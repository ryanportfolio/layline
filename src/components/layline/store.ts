"use client";

import { create } from "zustand";
import { generateRace } from "@/lib/layline/sim";
import {
  createAnalysisState,
  reconcileAnalysisWorkspaceSession,
  sanitizeAnalysisWorkspaceSession,
  transitionAnalysisWorkspacePatch,
  transitionAnalysisWorkspacePrimaryPatch,
  type AnalysisAction,
  type AnalysisWorkspaceId,
  type AnalysisWorkspaceSession,
  type LayerId,
  type LayerOverride,
} from "@/lib/layline/analysis-state";
import { DEFAULT_RACE_ID, raceMeta } from "@/lib/layline/races";
import {
  OPEN_AT,
  RACE_REPLAY_DEFAULTS,
  transitionReplay,
  transitionReplayClock,
} from "@/lib/layline/replay-transitions";
import type { LaylineInspectionSurface } from "@/lib/layline/surfaces";
import type { RaceData, ReplayMode, RigName } from "@/lib/layline/types";
import { resetFreeformCamera } from "./scene/interaction";

/* One race in front of the viewer at a time, held here rather than in the store
 * so the twenty-odd raceData() call sites stay zero-argument reads. Each
 * registry race is built once and kept: selecting back to a race already
 * watched is a Map hit, not a second simulation.
 *
 * The server builds its own copy from the same registry for the chart and the
 * results, so the two can differ only if the registry does. */
const generated = new Map<string, RaceData>();
let currentRaceId = DEFAULT_RACE_ID;

/* Point raceData() at a race without touching the store. Both pages run this
 * while rendering, before their first raceData() read, because the module
 * outlives a client-side navigation between them and the race left loaded is
 * otherwise the one that renders.
 *
 * Separate from selectRace for that reason: a store write during a render
 * notifies the page being navigated away from, which is still mounted, and
 * React reports that as an update during render. This notifies nobody. The
 * store catches up in the effect that follows the render. */
export function pointAtRace(id: string): void {
  if (raceMeta(id) === undefined) return;
  currentRaceId = id;
}

export function raceData(): RaceData {
  const cached = generated.get(currentRaceId);
  if (cached !== undefined) return cached;
  const meta = raceMeta(currentRaceId);
  if (meta === undefined) throw new Error(`no race ${currentRaceId} in the registry`);
  const race = generateRace(meta.seed);
  generated.set(currentRaceId, race);
  return race;
}

/* Written by the render loop, read by the capture hook. Kept out of the store
 * because a per-frame counter that re-rendered the HUD would cost more than it
 * reports. Frames counts drawn frames rather than loop passes: the loop runs
 * whenever the platform offers it, and the renderer only answers when the
 * picture can be seen and can have changed. */
export const renderStats = { drawCalls: 0, triangles: 0, frames: 0, drawnAt: 0 };

/* Module scope outlives any one canvas, so a canvas mounting into a document
 * that has already had one resets the counters it is about to claim as its
 * own. */
export function resetRenderStats(): void {
  renderStats.drawCalls = 0;
  renderStats.triangles = 0;
  renderStats.frames = 0;
  renderStats.drawnAt = 0;
}

/* A mid-beat moment with the fleet split and the standings meaningful. Reduced
 * motion opens here rather than on an empty prestart line. */
export { OPEN_AT };

/* Live playback starts inside the prestart so the gun is something you watch
 * happen rather than something you scrub back to. Five seconds is the whole
 * of it in a sprint: the hook has to land while the fleet is still winding up
 * to the line. */
export const AUTOPLAY_FROM = -5;

export type PlayRate = 1 | 2 | 4;

interface ReplayStore {
  /* The registry id of the loaded race. Bumping it remounts the viewer, so a
   * clock, a camera or a half-drawn chart from the previous race cannot survive
   * the swap. */
  raceId: string;
  t: number;
  playing: boolean;
  rate: PlayRate;
  mode: ReplayMode;
  rig: RigName;
  followId: string;
  analysis: AnalysisWorkspaceSession;
  /* The top-down chart in place of the rendered scene, on the same clock. A
   * mode, not a fallback: the renderer stays up behind it, because the clock
   * runs inside its frame loop and a chart with no clock is a picture. */
  chart2d: boolean;
  /* Audit overlay only. It never changes the evaluator mode: smooth and raw
   * playback keep their existing meanings while this exposes both answers. */
  truthMode: boolean;
  /* The layline inspection surface, carried with the race it was built from.
   * It travels through the store rather than through LaylineScene's props
   * because the scene element must stay referentially stable: any re-render
   * of the element that owns the Canvas re-runs the renderer's reconfigure
   * pass, which re-applies the dpr prop, and after the quality governor has
   * shed a tier that turns every refresh into two drawing-buffer resizes.
   * CourseGraphics reads it from under the Canvas and guards race and boat
   * itself. */
  inspectionHeld: { race: RaceData; surface: LaylineInspectionSurface } | null;
  reducedMotion: boolean;
  /* True once the renderer has put a frame on screen, not merely once the
   * canvas element exists: the fallback chart stays up until there is an
   * actual image to replace it with. */
  webglOk: boolean;
  hudReady: boolean;
  /* True once the page-load intro has let go of the viewport. Autoplay waits
   * on it: the prestart is five seconds long and spending it behind a cover
   * would mean the gun goes off where nobody can see it. */
  introDone: boolean;
  /* True once the race brief on the boot cover has been released, by its
   * Continue button or by Enter. The library's autoplay waits on this the way
   * the story page's waits on introDone: the prestart is ten seconds long and
   * running it behind a brief nobody has finished reading would spend the gun
   * where it cannot be seen. */
  briefDone: boolean;
  /* Capture hold. The frame loop stops advancing the clock and the canvas
   * drops to on-demand rendering, so a screenshot is taken of a stated time
   * rather than of whenever the shutter happened to fall. */
  frozen: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  step: (direction: 1 | -1) => void;
  advance: (seconds: number) => void;
  setRate: (rate: PlayRate) => void;
  setMode: (mode: ReplayMode) => void;
  setRig: (rig: RigName) => void;
  setChart2d: (on: boolean) => void;
  setTruthMode: (on: boolean) => void;
  setInspectionHeld: (held: { race: RaceData; surface: LaylineInspectionSurface } | null) => void;
  follow: (boatId: string) => void;
  setAnalysis: (action: AnalysisAction) => void;
  selectAnalysisWorkspace: (workspaceId: AnalysisWorkspaceId) => void;
  setAnalysisLayer: (layerId: LayerId, override: LayerOverride | "default") => void;
  resetAnalysisWorkspace: () => void;
  releaseAnalysisCameraIntent: () => void;
  setReducedMotion: (reduced: boolean) => void;
  setWebglOk: (ok: boolean) => void;
  setHudReady: (ready: boolean) => void;
  setIntroDone: (done: boolean) => void;
  releaseBrief: () => void;
  freeze: () => void;
  thaw: () => void;
  selectRace: (id: string) => void;
}

export const useReplay = create<ReplayStore>((set, get) => ({
  raceId: DEFAULT_RACE_ID,
  t: RACE_REPLAY_DEFAULTS.t,
  playing: RACE_REPLAY_DEFAULTS.playing,
  rate: 1,
  mode: "smooth",
  rig: RACE_REPLAY_DEFAULTS.rig,
  followId: RACE_REPLAY_DEFAULTS.followId,
  analysis: sanitizeAnalysisWorkspaceSession(
    createAnalysisState(raceData(), RACE_REPLAY_DEFAULTS.t),
    raceData(),
    RACE_REPLAY_DEFAULTS.t,
    { primaryBoatId: RACE_REPLAY_DEFAULTS.followId },
  ),
  chart2d: RACE_REPLAY_DEFAULTS.chart2d,
  truthMode: false,
  inspectionHeld: null,
  reducedMotion: false,
  webglOk: false,
  hudReady: false,
  introDone: false,
  briefDone: false,
  frozen: false,

  /* Play from the end means play it again: the replay never loops on its own,
   * and the one control that restarts it is the one a viewer just pressed. */
  play: () =>
    set(
      get().t >= raceData().tMax - 1e-6 ? { t: AUTOPLAY_FROM, playing: true } : { playing: true },
    ),
  pause: () => set({ playing: false }),
  toggle: () => {
    if (get().playing) get().pause();
    else get().play();
  },
  seek: (t) =>
    set((state) => transitionReplayClock(raceData(), state, { type: "seek", t })),

  /* One fix either way, landed on the 1/FIX_HZ grid the sim wrote the fixes
   * on, so the raw lens steps reading to reading at 250 ms. Stepping while
   * playing pauses first: a clock that jumps and runs at once shows neither. */
  step: (direction) =>
    set((state) => transitionReplayClock(raceData(), state, { type: "step", direction })),

  /* The only thing that moves the clock on its own, and it is called from
   * inside the render loop so a frozen or backgrounded page cannot drift.
   * The clock runs to the end of the feed: the last boat crosses, the fleet
   * luffs out its way and comes to rest. The results stand either way; they
   * come from race.results, not from where the clock stops. */
  advance: (seconds) =>
    set((state) => transitionReplayClock(raceData(), state, { type: "advance", seconds })),

  setRate: (rate) => set({ rate }),
  setMode: (mode) => set((state) => transitionReplay(state, { type: "set-mode", mode })),
  setRig: (rig) => {
    set({ rig });
    set((state) =>
      transitionAnalysisWorkspacePatch(raceData(), state, {
        type: "acquire-manual-camera",
      }),
    );
  },
  setChart2d: (on) =>
    set((state) => transitionReplay(state, { type: "set-chart-2d", on })),
  setTruthMode: (on) => set((state) => transitionReplay(state, { type: "set-truth", on })),
  setInspectionHeld: (held) => {
    if (get().inspectionHeld !== held) set({ inspectionHeld: held });
  },
  follow: (boatId) =>
    set((state) => transitionAnalysisWorkspacePrimaryPatch(raceData(), state, boatId)),
  setAnalysis: (action) =>
    set((state) => transitionAnalysisWorkspacePatch(raceData(), state, action)),
  selectAnalysisWorkspace: (workspaceId) =>
    set((state) =>
      transitionAnalysisWorkspacePatch(raceData(), state, {
        type: "select-workspace",
        workspaceId,
      }),
    ),
  setAnalysisLayer: (layerId, override) =>
    set((state) =>
      transitionAnalysisWorkspacePatch(
        raceData(),
        state,
        override === "default"
          ? { type: "clear-layer-override", layerId }
          : { type: "set-layer-override", layerId, override },
      ),
    ),
  resetAnalysisWorkspace: () =>
    set((state) =>
      transitionAnalysisWorkspacePatch(raceData(), state, { type: "reset-workspace" }),
    ),
  releaseAnalysisCameraIntent: () =>
    set((state) =>
      transitionAnalysisWorkspacePatch(raceData(), state, {
        type: "release-camera-to-preset",
      }),
    ),
  setReducedMotion: (reduced) => set({ reducedMotion: reduced }),
  setWebglOk: (ok) => set({ webglOk: ok }),
  setHudReady: (ready) => set({ hudReady: ready }),
  setIntroDone: (done) => set({ introDone: done }),

  /* One way only. The brief is a gate a viewer walks through, not a mode they
   * can be put back into, and the second press of a button already fading out
   * must not restart the autoplay it triggered. */
  releaseBrief: () => {
    if (get().briefDone) return;
    set({ briefDone: true });
  },
  freeze: () => set({ frozen: true, playing: false }),
  thaw: () => set({ frozen: false }),

  /* Load another race from the registry. The module-level id moves first so
   * that every raceData() read inside this tick, including the clock clamps,
   * already sees the new race. An id that is not in the registry is ignored:
   * the alternative is a store pointing at a race nobody can build.
   *
   * Selecting the race already loaded does nothing, which is why both tests
   * are here: the store can name a race the module is not on, if a render that
   * pointed the module was thrown away before it committed, and that is the
   * one case where reloading the race the store already names is real work. */
  selectRace: (id) => {
    if (id === get().raceId && currentRaceId === id) return;
    if (raceMeta(id) === undefined) return;
    pointAtRace(id);
    /* The camera a hand left pointing at the last race's windward mark is not
     * a view of this one. It goes back to its opening state with the rig. */
    resetFreeformCamera();
    set((state) => {
      const next = transitionReplay(state, { type: "select-race", raceId: id });
      return {
        ...next,
        analysis: reconcileAnalysisWorkspaceSession(
          raceData(),
          state.analysis,
          next.t,
          { primaryBoatId: next.followId },
        ),
        /* Re-armed with the race, unlike introDone. The brief states this
         * race's wind, line and fleet, so a rail selection gets a new brief. */
        briefDone: false,
      };
    });
  },
}));
