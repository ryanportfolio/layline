"use client";

import { create } from "zustand";
import { generateRace } from "@/lib/layline/sim";
import { FIX_HZ, RACE_SEED } from "@/lib/layline/types";
import type { RaceData, ReplayMode, RigName } from "@/lib/layline/types";

/* One race per document. The server builds its own copy from the same seed for
 * the chart and the results, so the two can differ only if the seed does. */
let generated: RaceData | null = null;

export function raceData(): RaceData {
  if (generated === null) generated = generateRace(RACE_SEED);
  return generated;
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

interface ReplayStore {
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
}

function clampTime(t: number): number {
  const race = raceData();
  if (!Number.isFinite(t)) return race.tMin;
  if (t < race.tMin) return race.tMin;
  if (t > race.tMax) return race.tMax;
  return t;
}

export const useReplay = create<ReplayStore>((set, get) => ({
  t: OPEN_AT,
  playing: false,
  rate: 1,
  mode: "smooth",
  rig: "tv",
  followId: "nzl",
  chart2d: false,
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
}));
