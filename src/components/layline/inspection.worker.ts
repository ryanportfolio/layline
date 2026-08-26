/// <reference lib="webworker" />

/**
 * Off-thread layline inspection builds.
 *
 * A playing replay refreshes the inspection surface once a race-second, and
 * the trace behind it integrates tens of thousands of candidate evaluations.
 * Run on the main thread that build lands as one long task in the middle of
 * the frame loop; here it costs the render loop nothing. The worker runs the
 * same `buildLaylineInspectionSurface` over a structured clone of the same
 * RaceData (pure data by construction), so the surface it returns is
 * byte-for-byte the surface the synchronous path would have produced. Frozen
 * and paused replays keep the synchronous path: capture determinism needs the
 * surface present the instant the clock settles.
 */

import { buildLaylineInspectionSurface } from "@/lib/layline/surfaces";
import type { RaceData } from "@/lib/layline/types";

interface RaceMessage {
  type: "race";
  key: number;
  race: RaceData;
}

interface BuildMessage {
  type: "build";
  requestId: number;
  key: number;
  boatId: string;
  t: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RaceMessage | BuildMessage>) => void) | null;
  postMessage: (value: unknown) => void;
};

let raceKey = -1;
let race: RaceData | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "race") {
    raceKey = message.key;
    race = message.race;
    return;
  }
  /* A reply for a race the app has already left is a stale answer; the null
   * tells the client to fall back rather than trust it. */
  const surface = message.key === raceKey && race !== null
    ? buildLaylineInspectionSurface(race, message.boatId, message.t)
    : null;
  scope.postMessage({ requestId: message.requestId, surface });
};
