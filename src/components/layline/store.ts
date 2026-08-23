"use client";

import { create } from "zustand";
import { generateRace } from "@/lib/layline/sim";
import { DEFAULT_RACE_ID, raceMeta } from "@/lib/layline/races";
import { FIX_HZ } from "@/lib/layline/types";
import type { RaceData, ReplayMode, RigName } from "@/lib/layline/types";

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
 * reports. */
export const renderStats = { drawCalls: 0, triangles: 0 };

/* A mid-beat moment with the fleet split and the standings meaningful. Reduced
 * motion opens here rather than on an empty prestart line. */
export const OPEN_AT = 18;

/* Live playback starts inside the prestart so the gun is something you watch
 * happen rather than something you scrub back to. Five seconds is the whole
 * of it in a sprint: the hook has to land while the fleet is still winding up
 * to the line. */
export const AUTOPLAY_FROM = -5;

export type PlayRate = 1 | 2 | 4;

/* Everything that belongs to the race in front of the viewer rather than to the
 * viewer. Selecting another race resets these and leaves the rest alone: a
 * reduced-motion preference or a WebGL verdict is about the machine, not about
 * which race is loaded. */
const RACE_DEFAULTS = {
  t: OPEN_AT,
  playing: false,
  followId: "nzl",
  rig: "tv" as RigName,
  chart2d: false,
};

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
  /* The top-down chart in place of the rendered scene, on the same clock. A
   * mode, not a fallback: the renderer stays up behind it, because the clock
   * runs inside its frame loop and a chart with no clock is a picture. */
  chart2d: boolean;
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
  follow: (boatId: string) => void;
  setReducedMotion: (reduced: boolean) => void;
  setWebglOk: (ok: boolean) => void;
  setHudReady: (ready: boolean) => void;
  setIntroDone: (done: boolean) => void;
  freeze: () => void;
  thaw: () => void;
  selectRace: (id: string) => void;
}

function clampTime(t: number): number {
  const race = raceData();
  if (!Number.isFinite(t)) return race.tMin;
  if (t < race.tMin) return race.tMin;
  if (t > race.tMax) return race.tMax;
  return t;
}

export const useReplay = create<ReplayStore>((set, get) => ({
  raceId: DEFAULT_RACE_ID,
  t: RACE_DEFAULTS.t,
  playing: RACE_DEFAULTS.playing,
  rate: 1,
  mode: "smooth",
  rig: RACE_DEFAULTS.rig,
  followId: RACE_DEFAULTS.followId,
  chart2d: RACE_DEFAULTS.chart2d,
  reducedMotion: false,
  webglOk: false,
  hudReady: false,
  introDone: false,
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
  seek: (t) => set({ t: clampTime(t) }),

  /* One fix either way, landed on the 1/FIX_HZ grid the sim wrote the fixes
   * on, so the raw lens steps reading to reading at 250 ms. Stepping while
   * playing pauses first: a clock that jumps and runs at once shows neither. */
  step: (direction) => {
    const race = raceData();
    const u = (get().t - race.tMin) * FIX_HZ;
    const n = direction > 0 ? Math.floor(u + 1e-6) + 1 : Math.ceil(u - 1e-6) - 1;
    set({ playing: false, t: clampTime(race.tMin + n / FIX_HZ) });
  },

  /* The only thing that moves the clock on its own, and it is called from
   * inside the render loop so a frozen or backgrounded page cannot drift.
   * The clock runs to the end of the feed: the last boat crosses, the fleet
   * luffs out its way and comes to rest. The results stand either way; they
   * come from race.results, not from where the clock stops. */
  advance: (seconds) => {
    const state = get();
    const race = raceData();
    const next = state.t + seconds;
    if (next >= race.tMax) {
      set({ t: race.tMax, playing: false });
      return;
    }
    set({ t: next < race.tMin ? race.tMin : next });
  },

  setRate: (rate) => set({ rate }),
  setMode: (mode) => set({ mode }),
  setRig: (rig) => set({ rig }),
  setChart2d: (on) => set({ chart2d: on }),
  follow: (boatId) => set({ followId: boatId }),
  setReducedMotion: (reduced) => set({ reducedMotion: reduced }),
  setWebglOk: (ok) => set({ webglOk: ok }),
  setHudReady: (ready) => set({ hudReady: ready }),
  setIntroDone: (done) => set({ introDone: done }),
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
    set({ raceId: id, ...RACE_DEFAULTS });
  },
}));
