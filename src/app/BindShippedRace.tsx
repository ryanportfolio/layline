"use client";

import { useEffect, useState } from "react";
import { pointAtRace, useReplay } from "@/components/layline/store";
import { DEFAULT_RACE_ID } from "@/lib/layline/races";

/**
 * This page is about the shipped race and nothing else, so it says so before
 * any of its own client components render.
 *
 * The loaded race is module state inside the store, and the client router
 * keeps that module across a navigation from the race library, where another
 * race may have been selected. Rendered first, this points it back: the
 * intro's drawing, the viewer and the analyst all read the race the page's
 * copy, its chart and its finish table are about, however the visitor arrived.
 *
 * In two steps, and in this order. The reads happen while the page renders,
 * so what raceData() hands back has to be right before the first of them, and
 * pointing the module does that without notifying the page being left, which
 * is still mounted. Then the store follows in the effect, back on the clock,
 * the camera and the boat this page opens on.
 *
 * Browser only, because the store module is one object per server process and
 * a render that wrote to it would hand a concurrent request for another race
 * the wrong one.
 *
 * Draws nothing, so it costs the page no markup and no tab stop.
 */
export function BindShippedRace() {
  useState(() => {
    if (typeof window !== "undefined") pointAtRace(DEFAULT_RACE_ID);
    return null;
  });

  useEffect(() => {
    useReplay.getState().selectRace(DEFAULT_RACE_ID);
  }, []);

  return null;
}
