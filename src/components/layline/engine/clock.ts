"use client";

import { createContext, useContext } from "react";
import type { RaceData } from "@/lib/layline/types";
import type { Bench } from "./benchData";

/* The lab clock every figure in the engine room reads. Time is a ref behind a
 * per-frame subscription rather than React state: sixty renders a second of
 * three SVGs and a table would cost more than the drawings do, so the figures
 * mutate their own transforms and text and nothing above them re-renders.
 * The context itself changes only when the mode does. */
export interface LabClock {
  race: RaceData;
  bench: Bench;
  /** True only once the client has read the media query, never during SSR. */
  reduced: boolean;
  mounted: boolean;
  running: boolean;
  time(): number;
  /** The engine's one wall-adjacent reading: the last animation-frame
   *  timestamp the loop saw. Interaction eases (the compass needle coming
   *  home) measure against this instead of asking the platform clock, so the
   *  lab keeps a single source of frame time. */
  frameNow(): number;
  subscribe(listener: (t: number) => void): () => void;
  /** SNAP onto the fix grid and hold, the way useReplay.step does. */
  seek(t: number): void;
  setRunning(run: boolean): void;
}

export const ClockContext = createContext<LabClock | null>(null);

export function useLabClock(): LabClock {
  const clock = useContext(ClockContext);
  if (clock === null) throw new Error("useLabClock called outside the engine room");
  return clock;
}
