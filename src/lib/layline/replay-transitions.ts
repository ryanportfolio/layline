import { FIX_HZ, type RaceData, type ReplayMode, type RigName } from "./types";

export const OPEN_AT = 18;

export type ReplayTransitionState = {
  raceId: string;
  t: number;
  playing: boolean;
  rate: 1 | 2 | 4;
  mode: ReplayMode;
  rig: RigName;
  followId: string;
  chart2d: boolean;
  truthMode: boolean;
  reducedMotion: boolean;
  frozen: boolean;
};

export type ReplayTransition =
  | { type: "select-race"; raceId: string }
  | { type: "set-mode"; mode: ReplayMode }
  | { type: "set-chart-2d"; on: boolean }
  | { type: "set-truth"; on: boolean };

export type ReplayClockState = Pick<ReplayTransitionState, "t" | "playing">;
export type ReplayClockTransition =
  | { type: "seek"; t: number }
  | { type: "step"; direction: 1 | -1 }
  | { type: "advance"; seconds: number };
export type ReplayClockPatch = Readonly<{ t: number; playing?: false }>;

export const RACE_REPLAY_DEFAULTS = {
  t: OPEN_AT,
  playing: false,
  followId: "nzl",
  rig: "tv" as RigName,
  chart2d: false,
};

/**
 * Apply replay-view transitions without React or Zustand. The store calls this
 * reducer directly, so race reset and independent view-layer rules have one
 * executable definition.
 */
export function transitionReplay(
  state: ReplayTransitionState,
  transition: ReplayTransition,
): ReplayTransitionState {
  if (transition.type === "select-race") {
    return { ...state, raceId: transition.raceId, ...RACE_REPLAY_DEFAULTS };
  }
  if (transition.type === "set-mode") return { ...state, mode: transition.mode };
  if (transition.type === "set-chart-2d") return { ...state, chart2d: transition.on };
  return { ...state, truthMode: transition.on };
}

function clampReplayTime(race: Pick<RaceData, "tMin" | "tMax">, value: number): number {
  if (!Number.isFinite(value)) return race.tMin;
  if (value <= race.tMin) return race.tMin === 0 ? 0 : race.tMin;
  if (value >= race.tMax) return race.tMax === 0 ? 0 : race.tMax;
  return value === 0 ? 0 : value;
}

/** Pure transition used by the existing Zustand seek/step/advance actions. */
export function transitionReplayClock(
  race: Pick<RaceData, "tMin" | "tMax">,
  state: ReplayClockState,
  transition: ReplayClockTransition,
): ReplayClockPatch {
  if (transition.type === "seek") {
    return Object.freeze({ t: clampReplayTime(race, transition.t) });
  }
  if (transition.type === "step") {
    const u = (state.t - race.tMin) * FIX_HZ;
    const n = transition.direction > 0
      ? Math.floor(u + 1e-6) + 1
      : Math.ceil(u - 1e-6) - 1;
    return Object.freeze({
      playing: false,
      t: clampReplayTime(race, race.tMin + n / FIX_HZ),
    });
  }
  const next = state.t + transition.seconds;
  if (next >= race.tMax) {
    return Object.freeze({ t: clampReplayTime(race, race.tMax), playing: false });
  }
  return Object.freeze({ t: clampReplayTime(race, next) });
}
