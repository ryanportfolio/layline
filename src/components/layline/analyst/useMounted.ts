"use client";

import { useEffect, useState } from "react";

/* The course drawings run every sample through poseAt's float math, and Node
 * and the browser disagree in the last printed digit often enough to trip
 * React's hydration diff on path, viewBox and tick-position strings. All
 * three drawings are aria-hidden decoration, so the server ships their
 * containers empty and the client draws them after mount: the numbers are
 * never compared across engines. Containers keep their CSS-fixed boxes, so
 * nothing shifts when the drawing lands. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}
