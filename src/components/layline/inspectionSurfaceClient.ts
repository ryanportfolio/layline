"use client";

/**
 * Main-thread client for the inspection worker. `requestInspectionSurface`
 * returns null when workers are unavailable (server render, an old browser, a
 * worker that failed to boot); the caller then builds synchronously, so the
 * worker is an offload and never a dependency. Each race is cloned to the
 * worker once, keyed by identity; requests carry the key so an answer for a
 * race the app has left resolves null instead of leaking across races.
 */

import type { LaylineInspectionSurface } from "@/lib/layline/surfaces";
import type { RaceData } from "@/lib/layline/types";

let worker: Worker | null | undefined;
let nextRequestId = 1;
let nextRaceKey = 1;
const sentRaces = new WeakMap<RaceData, number>();
const pending = new Map<number, (surface: LaylineInspectionSurface | null) => void>();

function settleAll(surface: null): void {
  for (const resolve of pending.values()) resolve(surface);
  pending.clear();
}

function inspectionWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined" || typeof window === "undefined") {
    worker = null;
    return null;
  }
  try {
    const created = new Worker(new URL("./inspection.worker.ts", import.meta.url));
    created.onmessage = (event: MessageEvent<{ requestId: number; surface: LaylineInspectionSurface | null }>) => {
      const resolve = pending.get(event.data.requestId);
      if (resolve === undefined) return;
      pending.delete(event.data.requestId);
      resolve(event.data.surface);
    };
    created.onerror = () => {
      /* A worker that errors once is retired for the session; every waiter
       * and every later caller takes the synchronous path instead. */
      settleAll(null);
      created.terminate();
      worker = null;
    };
    worker = created;
  } catch {
    worker = null;
  }
  return worker;
}

export function requestInspectionSurface(
  race: RaceData,
  boatId: string,
  t: number,
): Promise<LaylineInspectionSurface | null> | null {
  const target = inspectionWorker();
  if (target === null) return null;
  let key = sentRaces.get(race);
  if (key === undefined) {
    key = nextRaceKey++;
    sentRaces.set(race, key);
    target.postMessage({ type: "race", key, race });
  }
  return new Promise((resolve) => {
    const requestId = nextRequestId++;
    pending.set(requestId, resolve);
    target.postMessage({ type: "build", requestId, key, boatId, t });
  });
}
