"use client";

import { useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { NeutralToneMapping } from "three";
import type { RaceData } from "@/lib/layline/types";
import { renderStats, resetRenderStats, useReplay } from "../store";
import {
  requestSceneFrame,
  resetSceneGate,
  sceneGate,
  setFrozenFrameRequest,
} from "./gate";
import { BoatLabels } from "./BoatLabels";
import { BoatPicker } from "./BoatPicker";
import { BoatTracks } from "./BoatTracks";
import { CameraRigs } from "./CameraRigs";
import { CourseGraphics } from "./CourseGraphics";
import { Fleet } from "./Fleet";
import { SKY_HORIZON } from "./sky";
import { Water } from "./Water";
import { SkyDome } from "./SkyDome";
import { WakeTrails } from "./WakeTrails";

/* The clock lives here and nowhere else. Nothing outside a drawn frame moves
 * time, so a frozen page holds the instant it was frozen at.
 *
 * It also settles, first thing in the frame, whether this frame is going to be
 * drawn. The governor below and the render at the bottom both answer to that
 * one verdict rather than deciding for themselves, so a frame cannot be half
 * skipped: the governor must not resize a buffer nobody is about to fill. */
function Clock() {
  useFrame((state, delta) => {
    const replay = useReplay.getState();
    if (replay.playing && !replay.frozen) {
      replay.advance(Math.min(delta, 0.25) * replay.rate);
    }

    /* A resized drawing buffer is a cleared drawing buffer, and the governor
     * resizes it from inside this same loop, so the comparison is made before
     * the verdict rather than after it. */
    const canvas = state.gl.domElement;
    if (canvas.width !== sceneGate.bufferWidth || canvas.height !== sceneGate.bufferHeight) {
      sceneGate.dirty = true;
    }

    /* Frozen is a capture, and a capture is always drawn: the hold only ever
     * asks for a frame when something wants one. An unready page draws too,
     * whatever else is true, because the chart, the docks and the intro are all
     * waiting on the first frame and 2D mode would otherwise be a state the
     * page could never leave after a lost context. */
    sceneGate.willRender =
      !sceneGate.contextLost &&
      (replay.frozen ||
        !replay.webglOk ||
        (sceneGate.onScreen &&
          sceneGate.pageVisible &&
          !replay.chart2d &&
          (replay.playing || sceneGate.dirty || sceneGate.chase > 0)));
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
    /* Only frames that are actually drawn are evidence about how long a frame
     * takes, and only a drawn frame can afford a resize: setDpr clears the
     * buffer, and clearing one the gate is about to leave alone would blank a
     * canvas that is on screen. The settle window is reset on the way past, so
     * the reading that resumes playback is never the one that sheds. */
    if (!sceneGate.willRender) {
      settle.current = SETTLE_FRAMES;
      return;
    }
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

/* A held canvas draws only when it is told to, and only a change that moves
 * the picture may tell it. Playing, rate, the ready flags and the freeze itself
 * all travel through this store too, and a frame drawn for one of those is a
 * frame nobody wanted.
 *
 * The hold runs the loop at "never" rather than "demand": there is no request
 * queue to race, so a stray store write cannot slip a frame past the freeze,
 * and each drawn frame carries a stated delta instead of however long the
 * shutter took. The timestamp restarts at every freeze because the renderer
 * zeroes its own clock on the way in. */
const FROZEN_STEP = 1 / 60;

function DemandBridge() {
  const advance = useThree((state) => state.advance);
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  const frozen = useReplay((state) => state.frozen);
  const stamp = useRef(0);
  const holding = useRef(false);

  /* Entering the hold draws its first frame on the spot: nothing else is
   * going to, and the renderer zeroes its own clock on the way in, so the stamp
   * starts again with it and only with it. */
  useEffect(() => {
    if (!frozen) {
      holding.current = false;
      return;
    }
    if (!holding.current) stamp.current = 0;
    holding.current = true;
    stamp.current += FROZEN_STEP;
    advance(stamp.current);
  }, [frozen, advance]);

  /* A resized canvas is the one thing that moves the picture without going
   * through the store: it rewrites the camera aspect and the dock measurements
   * the rigs frame against, and the loop at "never" ignores the renderer's own
   * invalidation. It goes through the same door as the observers watching the
   * same layout change, so the one frame it costs is drawn after all of them
   * have measured. The first pass only records the box it opened at. */
  const box = useRef<string | null>(null);
  useEffect(() => {
    const seen = `${width}x${height}`;
    if (box.current === seen) return;
    const first = box.current === null;
    box.current = seen;
    if (first) return;
    requestSceneFrame();
  }, [frozen, width, height]);

  /* The only way into a renderer that is holding still, handed to the gate so
   * a font landing, a dock resize, a restored tab or a recovered context can
   * still reach the screen while the clock is held. R3F ignores invalidate()
   * at "never", so a flag on its own would never be read. */
  useEffect(() => {
    if (!frozen) {
      setFrozenFrameRequest(null);
      return;
    }
    setFrozenFrameRequest(() => {
      stamp.current += FROZEN_STEP;
      advance(stamp.current);
    });
    return () => setFrozenFrameRequest(null);
  }, [frozen, advance]);

  useEffect(
    () =>
      useReplay.subscribe((state, previous) => {
        if (!state.frozen) return;
        if (
          state.raceId !== previous.raceId ||
          state.t !== previous.t ||
          state.rig !== previous.rig ||
          state.mode !== previous.mode ||
          state.followId !== previous.followId
        ) {
          stamp.current += FROZEN_STEP;
          advance(stamp.current);
        }
      }),
    [advance],
  );
  return null;
}

/* Wakes the canvas before it reaches the viewport rather than as it arrives:
 * an observer reports after the compositor has already been handed a frame, so
 * a fast scroll would otherwise show one stale picture. */
const PREWARM = "200px";

/**
 * The render, taken out of the loop's hands.
 *
 * A positive priority switches R3F's own rendering off for this canvas and
 * makes this the last subscriber to run, so every pass above has posed the
 * scene by the time the verdict taken at the top of the frame is spent here.
 * Only the drawing is skipped: the clock, the poses and the plates all keep
 * running, so a held frame is one nobody could see rather than one nobody
 * built.
 */
function RenderGate() {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    const canvas = gl.domElement;
    const observer = new IntersectionObserver(
      (entries) => {
        const seen = entries[0]?.isIntersecting === true;
        if (seen && !sceneGate.onScreen) requestSceneFrame();
        sceneGate.onScreen = seen;
      },
      { rootMargin: PREWARM },
    );
    observer.observe(canvas);
    /* The same question without the margin, for the one caller that has to know
     * whether the replay is really on screen rather than nearly on it. */
    const inView = new IntersectionObserver((entries) => {
      sceneGate.inView = entries[0]?.isIntersecting === true;
    });
    inView.observe(canvas);
    return () => {
      observer.disconnect();
      inView.disconnect();
      sceneGate.onScreen = true;
      sceneGate.inView = true;
    };
  }, [gl]);

  /* Everything that moves the picture without going through the store or the
   * canvas box. A restored tab can come back to a discarded buffer and a
   * recovered context comes back to nothing at all; three.js owns the recovery
   * itself, so the page only has to stop drawing into a dead context and ask
   * for one frame once it is alive again. */
  useEffect(() => {
    const canvas = gl.domElement;
    const onVisibility = () => {
      sceneGate.pageVisible = !document.hidden;
      if (sceneGate.pageVisible) requestSceneFrame();
    };
    const onShow = () => requestSceneFrame();
    const onLost = () => {
      sceneGate.contextLost = true;
      useReplay.getState().setWebglOk(false);
    };
    const onRestored = () => {
      sceneGate.contextLost = false;
      requestSceneFrame();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onShow);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    /* Plate metrics move when the display face lands. */
    void document.fonts?.ready.then(requestSceneFrame).catch(() => {});
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onShow);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, [gl]);

  /* Only the fields that move the picture. The ready flags travel through this
   * store too, and one of them is written by the render below: dirtying the
   * frame that has just been drawn would cost a second frame for nothing. */
  useEffect(
    () =>
      useReplay.subscribe((state, previous) => {
        if (
          /* The race the picture is of. The viewer is not remounted when it
           * changes, so nothing else here would say the boats had all moved. */
          state.raceId !== previous.raceId ||
          state.t !== previous.t ||
          state.rig !== previous.rig ||
          state.mode !== previous.mode ||
          state.followId !== previous.followId ||
          state.chart2d !== previous.chart2d ||
          state.playing !== previous.playing ||
          state.frozen !== previous.frozen ||
          state.reducedMotion !== previous.reducedMotion
        ) {
          sceneGate.dirty = true;
        }
      }),
    [],
  );

  useFrame((state) => {
    if (!sceneGate.willRender) return;
    /* three.js returns from render() without drawing while the context is
     * lost, so the picture would be marked laid down when it was not. */
    const context = state.gl.getContext();
    if (context !== null && context.isContextLost()) return;

    state.gl.render(state.scene, state.camera);

    const canvas = state.gl.domElement;
    sceneGate.bufferWidth = canvas.width;
    sceneGate.bufferHeight = canvas.height;

    /* A change owes one more frame, because the passes above are a frame
     * behind the camera and the picture that stays on screen has to be the one
     * playback would have settled on. The capture hold is exempt: it draws
     * exactly the frame it asked for, which is the contract every reference
     * shot on this page was taken under. */
    const replay = useReplay.getState();
    if (sceneGate.dirty) {
      sceneGate.dirty = false;
      sceneGate.chase = replay.frozen ? 0 : 1;
    } else if (sceneGate.chase > 0) {
      sceneGate.chase -= 1;
    }

    /* Stamped with the instant this frame was drawn at, because the clock
     * runs whether or not the picture does: reading a live t next to the cost
     * of a frame drawn seconds ago would describe a picture nobody has seen. */
    const drawn = state.gl.info.render;
    renderStats.drawCalls = drawn.calls;
    renderStats.triangles = drawn.triangles;
    renderStats.frames += 1;
    renderStats.drawnAt = replay.t;

    /* Raised here and nowhere else: the flag says a frame is on screen, and
     * this is the only line that knows one is. The intro drops its cover on
     * it. */
    if (!replay.webglOk) replay.setWebglOk(true);
  }, 1);

  return null;
}

export function LaylineScene({ race }: { race: RaceData }) {
  const frozen = useReplay((state) => state.frozen);

  /* The gate is one per document and outlives every canvas mounted into it,
   * same as the ready flag below. A lost context or a scrolled-away observer
   * left behind by the last visit would keep this one dark, so the record goes
   * back to its opening state before the first frame is asked for. */
  const opened = useRef(false);
  if (!opened.current) {
    opened.current = true;
    resetSceneGate();
    resetRenderStats();
  }

  /* The store is one per document and outlives every canvas mounted into it,
   * so leaving the flag set would let the next visit to this route pull the
   * chart down before its renderer had drawn anything, and leave a blank
   * console behind if the context never came back. The flag belongs to the
   * canvas that raised it and dies with it. */
  useEffect(
    () => () => {
      useReplay.getState().setWebglOk(false);
      resetSceneGate();
      resetRenderStats();
    },
    [],
  );

  return (
    <Canvas
      dpr={[1, 2]}
      frameloop={frozen ? "never" : "always"}
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
      <BoatPicker race={race} />
      <Clock />
      <QualityGovernor />
      <DemandBridge />
      <RenderGate />
    </Canvas>
  );
}
