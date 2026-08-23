"use client";

import { useEffect } from "react";
import { renderStats, useReplay } from "./store";
import type { ReplayMode, RigName } from "@/lib/layline/types";

export interface CaptureInfo {
  t: number;
  /* The replay time the last drawn frame was drawn at. Equal to t whenever the
   * page is drawing, which the capture hold guarantees; behind it while the
   * gate is holding, where the clock still runs and the picture does not. The
   * counts below describe that frame, not t. */
  drawnAt: number;
  drawCalls: number;
  triangles: number;
  /* Frames the renderer has actually drawn since this canvas came up. Held
   * either side of an action, it says whether anything was drawn for that
   * action, which a screenshot of a settled page cannot. */
  frames: number;
}

export interface LaylineCapture {
  /* False until the renderer has actually put a frame up. A capture that
   * starts before this is a screenshot of a loading state. */
  ready: boolean;
  freeze: () => void;
  thaw: () => void;
  step: (ms: number) => void;
  seek: (seconds: number) => void;
  rig: (name: RigName) => void;
  follow: (boatId: string) => void;
  mode: (mode: ReplayMode) => void;
  info: () => CaptureInfo;
}

declare global {
  interface Window {
    __layline?: LaylineCapture;
  }
}

/**
 * The determinism contract for every frame anyone captures off this page.
 * Freeze holds the clock and drops the canvas to on-demand rendering, step
 * moves the clock by an exact number of milliseconds and draws exactly one
 * frame, and info reports the time that frame was drawn at alongside what it
 * cost. Two runs asking for the same time get the same picture.
 *
 * It ships in production builds as well as development. A capture tool that
 * only works against a dev server can only ever verify a dev server.
 */
export function CaptureBridge() {
  useEffect(() => {
    const store = useReplay;
    const api: LaylineCapture = {
      ready: store.getState().webglOk,
      freeze: () => store.getState().freeze(),
      thaw: () => store.getState().thaw(),
      step: (ms) => {
        const state = store.getState();
        state.seek(state.t + ms / 1000);
      },
      seek: (seconds) => store.getState().seek(seconds),
      rig: (name) => store.getState().setRig(name),
      follow: (boatId) => store.getState().follow(boatId),
      mode: (mode) => store.getState().setMode(mode),
      info: () => ({
        t: store.getState().t,
        drawnAt: renderStats.drawnAt,
        drawCalls: renderStats.drawCalls,
        triangles: renderStats.triangles,
        frames: renderStats.frames,
      }),
    };
    window.__layline = api;
    const unsubscribe = store.subscribe((state) => {
      api.ready = state.webglOk;
    });
    return () => {
      unsubscribe();
      if (window.__layline === api) delete window.__layline;
    };
  }, []);

  return null;
}
