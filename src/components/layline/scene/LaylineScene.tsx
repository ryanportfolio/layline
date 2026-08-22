"use client";

import { useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { NeutralToneMapping } from "three";
import type { RaceData } from "@/lib/layline/types";
import { renderStats, useReplay } from "../store";
import { BoatLabels } from "./BoatLabels";
import { BoatTracks } from "./BoatTracks";
import { CameraRigs } from "./CameraRigs";
import { CourseGraphics } from "./CourseGraphics";
import { Fleet } from "./Fleet";
import { SKY_HORIZON } from "./sky";
import { Water } from "./Water";
import { SkyDome } from "./SkyDome";
import { WakeTrails } from "./WakeTrails";

/* The clock lives here and nowhere else. Nothing outside a drawn frame moves
 * time, so a frozen page holds the instant it was frozen at. */
function Clock() {
  useFrame((state, delta) => {
    const replay = useReplay.getState();
    if (replay.playing && !replay.frozen) {
      replay.advance(Math.min(delta, 0.25) * replay.rate);
    }
    const render = state.gl.info.render;
    renderStats.drawCalls = render.calls;
    renderStats.triangles = render.triangles;
    if (!replay.webglOk) replay.setWebglOk(true);
  }, -100);
  return null;
}

/* A phone gets the same water as a desktop GPU, so quality follows measured
 * frame time instead of a device guess: a sustained miss walks the pixel ratio
 * down one rung, waits out a settle window, and looks again. It never walks
 * back up, because resolution that oscillates reads worse than resolution that
 * settles low. A machine already rendering at ratio 1 has no rungs below it
 * and the governor stands down. */
const DPR_LADDER = [1.5, 1.25, 1];
const MISS_MS = 22; // sustained EMA above this, ~45 fps, is a shed
const EMA_GAIN = 0.05; // ~60-frame horizon
const SETTLE_FRAMES = 120; // shader warm-up at mount, resize churn after a shed

function QualityGovernor() {
  const setDpr = useThree((state) => state.setDpr);
  const gl = useThree((state) => state.gl);
  const rungs = useRef<number[] | null>(null);
  const tier = useRef<number | null>(null);
  const ema = useRef(1000 / 60);
  const settle = useRef(SETTLE_FRAMES);
  useFrame((state, delta) => {
    if (rungs.current === null) rungs.current = DPR_LADDER.filter((v) => v < gl.getPixelRatio());
    if (useReplay.getState().frozen) return;
    /* Any Canvas re-render (freeze and thaw toggle the frameloop prop) re-runs
     * the reconfigure pass, which reapplies the dpr prop and lifts the ratio
     * back to the device value. The governor holds its tier and reasserts it
     * instead of spending settle windows earning the shed a second time. A
     * capture taken while frozen still gets the full-resolution frame. */
    if (tier.current !== null && gl.getPixelRatio() > tier.current) {
      setDpr(tier.current);
      settle.current = SETTLE_FRAMES;
      return;
    }
    if (rungs.current.length === 0) return;
    const ms = delta * 1000;
    /* A background tab reports its whole absence as one delta; that is not a
     * slow frame, and the EMA restarts clean when the page comes back. */
    if (ms > 500) {
      settle.current = SETTLE_FRAMES;
      return;
    }
    if (settle.current > 0) {
      settle.current -= 1;
      return;
    }
    ema.current += (ms - ema.current) * EMA_GAIN;
    if (ema.current > MISS_MS) {
      tier.current = rungs.current.shift() as number;
      setDpr(tier.current);
      ema.current = 1000 / 60;
      settle.current = SETTLE_FRAMES;
    }
  }, -99);
  return null;
}

/* On-demand rendering needs someone to ask for the frame, and only a change
 * that moves the picture may ask. Playing, rate, the ready flags and the freeze
 * itself all travel through this store too, and a frame drawn for one of those
 * is a frame nobody wanted: while the loop is running it is one more draw per
 * store write, and while it is frozen it breaks the promise that a held page
 * renders nothing at all. */
function DemandBridge() {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(
    () =>
      useReplay.subscribe((state, previous) => {
        if (!state.frozen) return;
        if (
          state.t !== previous.t ||
          state.rig !== previous.rig ||
          state.mode !== previous.mode ||
          state.followId !== previous.followId
        ) {
          invalidate();
        }
      }),
    [invalidate],
  );
  return null;
}

export function LaylineScene({ race }: { race: RaceData }) {
  const frozen = useReplay((state) => state.frozen);

  /* The store is one per document and outlives every canvas mounted into it,
   * so leaving the flag set would let the next visit to this route pull the
   * chart down before its renderer had drawn anything, and leave a blank
   * console behind if the context never came back. The flag belongs to the
   * canvas that raised it and dies with it. */
  useEffect(() => () => useReplay.getState().setWebglOk(false), []);

  return (
    <Canvas
      dpr={[1, 2]}
      frameloop={frozen ? "demand" : "always"}
      camera={{ position: [44, 34, 76], fov: 40, near: 1, far: 12000 }}
      gl={{
        /* Multisampling is free here only because nothing post-processes the
         * frame: with no render target chain the default framebuffer can carry
         * MSAA. Adding an effect pass takes it away again. */
        antialias: true,
        powerPreference: "high-performance",
        /* Stated, never assumed. The default under this renderer is ACES
         * filmic, whose hue shift moves six team liveries that have to stay
         * recognisable; neutral rolls the sun highlight without touching them. */
        toneMapping: NeutralToneMapping,
        toneMappingExposure: 1.05,
      }}
      style={{ width: "100%", height: "100%" }}
    >
      <color attach="background" args={[SKY_HORIZON]} />
      <SkyDome />
      <Water race={race} />
      <CourseGraphics race={race} />
      <Fleet race={race} />
      <WakeTrails race={race} />
      <BoatTracks race={race} />
      <CameraRigs race={race} />
      <BoatLabels race={race} />
      <Clock />
      <QualityGovernor />
      <DemandBridge />
    </Canvas>
  );
}
