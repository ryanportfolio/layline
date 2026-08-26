"use client";

import clsx from "clsx";
import { useEffect, useRef } from "react";
import styles from "@/app/layline.module.css";
import { MISSING, deg, fixStamp, heading, knots } from "@/lib/layline/format";
import { createPose, telemetryTruthAt } from "@/lib/layline/interpolate";
import type { LaylineInspectionSurface } from "@/lib/layline/surfaces";
import type { Pose, RaceData, TelemetryTruth } from "@/lib/layline/types";
import { useReplay } from "../store";
import { onLive, sampleLive, setText } from "./live";
import { VectorTriangle } from "./VectorTriangle";

function pose(): Pose {
  return createPose();
}

function truthBuffer(): TelemetryTruth {
  return {
    t: 0,
    beforeIndex: -1,
    afterIndex: -1,
    before: null,
    after: null,
    u: 0,
    raw: pose(),
    reconstructed: pose(),
  };
}

function sampleId(index: number): string {
  return index < 0 ? "NO FIX" : `FIX ${String(index + 1).padStart(4, "0")}`;
}

function meters(value: number): string {
  return value.toFixed(2);
}

function posePosition(value: Pose | null): string {
  return value === null ? "X / Y" : `${meters(value.x)} / ${meters(value.y)} m`;
}

function poseHeading(value: Pose | null): string {
  return value === null ? "NO SAMPLE" : heading(value.hdg);
}

function phaseLabel(truth: TelemetryTruth): string {
  if (truth.before === null || truth.after === null) return "NO SAMPLE";
  return truth.beforeIndex === truth.afterIndex
    ? "AT MEASURED FIX"
    : `${(truth.u * 100).toFixed(1)}% BETWEEN FIXES`;
}

function currentCaption(value: Pose | null): string {
  if (value === null) return "Current components unavailable";
  return value.telemetryProvenance === "recorded-fix"
    ? "Recorded current sample"
    : "Reconstructed current from recorded fixes";
}

/* The three velocities as a scannable table rather than the joined mono wall
 * the panel used to carry: one row per frame of reference, speed and bearing
 * as the readings. The x/y component pairs stayed in the sampled pose but left
 * the display; the vector triangle already draws that geometry. */
function velocitySpeed(value: Pose | null, key: "stw" | "currentDrift" | "sog"): string {
  return value === null ? MISSING : knots(value[key]);
}

function velocityToward(value: Pose | null, key: "ctw" | "currentSet" | "cog"): string {
  if (value === null) return MISSING;
  const bearing = value[key];
  return bearing === null ? MISSING : `${deg(bearing)}°`;
}

export function TruthInspector({
  race,
  inspection,
  vector = true,
}: {
  race: RaceData;
  inspection?: LaylineInspectionSurface | null;
  /* False when the app docks the velocity triangle on its own plate. */
  vector?: boolean;
}) {
  const followId = useReplay((state) => state.followId);
  const chart2d = useReplay((state) => state.chart2d);
  const sceneUp = useReplay((state) => state.webglOk);
  const rawMode = useReplay((state) => state.mode === "raw");
  const boat = race.boats.find((entry) => entry.id === followId) ?? race.boats[0];
  const buffer = useRef(truthBuffer());
  const initial = telemetryTruthAt(race, boat.id, sampleLive(race).t, buffer.current);
  const initialVelocityPose = rawMode ? initial.raw : initial.reconstructed;

  const replayTime = useRef<HTMLSpanElement>(null);
  const beforeId = useRef<HTMLSpanElement>(null);
  const beforeTime = useRef<HTMLSpanElement>(null);
  const beforePosition = useRef<HTMLSpanElement>(null);
  const afterId = useRef<HTMLSpanElement>(null);
  const afterTime = useRef<HTMLSpanElement>(null);
  const afterPosition = useRef<HTMLSpanElement>(null);
  const phase = useRef<HTMLSpanElement>(null);
  const rawPosition = useRef<HTMLSpanElement>(null);
  const rawHeading = useRef<HTMLSpanElement>(null);
  const reconstructedPosition = useRef<HTMLSpanElement>(null);
  const reconstructedHeading = useRef<HTMLSpanElement>(null);
  const velocityBlock = useRef<HTMLDivElement>(null);
  const velocityCaption = useRef<HTMLElement>(null);
  const waterSpeed = useRef<HTMLSpanElement>(null);
  const waterToward = useRef<HTMLSpanElement>(null);
  const currentSpeed = useRef<HTMLSpanElement>(null);
  const currentToward = useRef<HTMLSpanElement>(null);
  const groundSpeed = useRef<HTMLSpanElement>(null);
  const groundToward = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    return onLive(race, (live) => {
      const truth = telemetryTruthAt(race, live.followId, live.t, buffer.current);
      setText(replayTime.current, fixStamp(truth.t));
      setText(beforeId.current, sampleId(truth.beforeIndex));
      setText(beforeTime.current, truth.before === null ? "NO SAMPLE" : fixStamp(truth.before.t));
      setText(
        beforePosition.current,
        truth.before === null ? "X / Y" : `${meters(truth.before.x)} / ${meters(truth.before.y)} m`,
      );
      setText(afterId.current, sampleId(truth.afterIndex));
      setText(afterTime.current, truth.after === null ? "NO SAMPLE" : fixStamp(truth.after.t));
      setText(
        afterPosition.current,
        truth.after === null ? "X / Y" : `${meters(truth.after.x)} / ${meters(truth.after.y)} m`,
      );
      setText(phase.current, phaseLabel(truth));
      setText(rawPosition.current, posePosition(truth.raw));
      setText(rawHeading.current, poseHeading(truth.raw));
      setText(reconstructedPosition.current, posePosition(truth.reconstructed));
      setText(reconstructedHeading.current, poseHeading(truth.reconstructed));
      /* One velocity block, following the active lens. The recorded and the
       * reconstructed readouts repeated the same three component lines, so the
       * pair collapsed into the pose the viewer is actually watching, with its
       * provenance stated on the block. */
      const velocityPose = live.mode === "raw" ? truth.raw : truth.reconstructed;
      setText(velocityCaption.current, currentCaption(velocityPose));
      setText(waterSpeed.current, velocitySpeed(velocityPose, "stw"));
      setText(waterToward.current, velocityToward(velocityPose, "ctw"));
      setText(currentSpeed.current, velocitySpeed(velocityPose, "currentDrift"));
      setText(currentToward.current, velocityToward(velocityPose, "currentSet"));
      setText(groundSpeed.current, velocitySpeed(velocityPose, "sog"));
      setText(groundToward.current, velocityToward(velocityPose, "cog"));
      /* Compared first: the value flips at fix cadence, not frame cadence, and
       * [data-provenance] is a styled attribute, so a repeated setAttribute is
       * a real style invalidation sixty times a second. */
      const provenance =
        velocityPose?.telemetryProvenance === "recorded-fix" ? "measured" : "reconstructed";
      const block = velocityBlock.current;
      if (block !== null && block.getAttribute("data-provenance") !== provenance) {
        block.setAttribute("data-provenance", provenance);
      }
    });
  }, [race]);

  const view = sceneUp ? (chart2d ? "2D TRACK" : "3D SCENE") : "2D TRACK · RENDERER UNAVAILABLE";

  return (
    <section
      id="truth-inspector"
      className={clsx(styles.panel, styles.truthInspector)}
      aria-label="Telemetry truth inspector"
    >
      <h2 className={styles.dockLabel}>Telemetry truth</h2>

      <div className={styles.truthHeader}>
        <span
          className={clsx(styles.standingChip, boat.dark === true && styles.chipOutlined)}
          style={{ background: boat.hue }}
          aria-hidden="true"
        />
        <strong>{boat.sail}</strong>
        <span className={styles.truthBoatName}>{boat.name}</span>
        <span className={styles.truthView}>{view}</span>
      </div>

      <div className={styles.truthClock}>
        <span className={styles.truthSource}>SHARED REPLAY TIME</span>
        <span ref={replayTime}>{fixStamp(initial.t)}</span>
      </div>

      <div className={styles.truthFixes}>
        <div className={styles.truthFix} data-provenance="measured">
          <span className={styles.truthSource}>MEASURED · BEFORE / CURRENT</span>
          <strong ref={beforeId}>{sampleId(initial.beforeIndex)}</strong>
          <span ref={beforeTime}>{initial.before === null ? "NO SAMPLE" : fixStamp(initial.before.t)}</span>
          <span ref={beforePosition}>
            {initial.before === null ? "X / Y" : `${meters(initial.before.x)} / ${meters(initial.before.y)} m`}
          </span>
        </div>
        <div className={styles.truthFix} data-provenance="measured">
          <span className={styles.truthSource}>MEASURED · AFTER / CURRENT</span>
          <strong ref={afterId}>{sampleId(initial.afterIndex)}</strong>
          <span ref={afterTime}>{initial.after === null ? "NO SAMPLE" : fixStamp(initial.after.t)}</span>
          <span ref={afterPosition}>
            {initial.after === null ? "X / Y" : `${meters(initial.after.x)} / ${meters(initial.after.y)} m`}
          </span>
        </div>
      </div>

      <div className={styles.truthPhase} data-provenance="derived">
        <span className={styles.truthSource}>DERIVED · CLOCK POSITION</span>
        <strong ref={phase}>{phaseLabel(initial)}</strong>
      </div>

      {/* Two cards rather than a three-column table: at the dock's width every
          label and value wrapped mid-word, and the fix cards above already set
          the label-then-reading pattern this panel scans by. */}
      <div className={styles.truthCompare} role="table" aria-label="Raw and reconstructed selected boat state">
        {/* The visual head row left with the column layout, but the cells are
            still a semantic table: without headers a screen reader announces
            the position and heading as bare numbers. Codex review finding. */}
        <div className={styles.srOnly} role="row">
          <span role="columnheader">State and source</span>
          <span role="columnheader">X / Y position</span>
          <span role="columnheader">Heading</span>
        </div>
        <div className={styles.truthCompareRow} role="row" data-provenance="measured">
          <span role="cell" className={styles.truthSource}>RAW HOLD · MEASURED</span>
          <span role="cell" ref={rawPosition}>{posePosition(initial.raw)}</span>
          <span role="cell" ref={rawHeading}>{poseHeading(initial.raw)}</span>
        </div>
        <div className={styles.truthCompareRow} role="row" data-provenance="reconstructed">
          <span role="cell" className={styles.truthSource}>SMOOTH · RECONSTRUCTED</span>
          <span role="cell" ref={reconstructedPosition}>{posePosition(initial.reconstructed)}</span>
          <span role="cell" ref={reconstructedHeading}>{poseHeading(initial.reconstructed)}</span>
        </div>
      </div>

      <div className={styles.truthVectors} aria-label="Velocity components with provenance">
        <div
          ref={velocityBlock}
          data-provenance={
            initialVelocityPose?.telemetryProvenance === "recorded-fix"
              ? "measured"
              : "reconstructed"
          }
        >
          <strong ref={velocityCaption}>{currentCaption(initialVelocityPose)}</strong>
          <div
            className={styles.truthVelocityTable}
            role="table"
            aria-label="Velocity by frame of reference"
          >
            <div className={styles.truthVelocityHead} role="row">
              <span role="columnheader">FRAME</span>
              <span role="columnheader">KN</span>
              <span role="columnheader">TOWARD</span>
            </div>
            <div className={styles.truthVelocityRow} role="row">
              <span role="cell">WATER · STW</span>
              <span role="cell" ref={waterSpeed}>{velocitySpeed(initialVelocityPose, "stw")}</span>
              <span role="cell" ref={waterToward}>{velocityToward(initialVelocityPose, "ctw")}</span>
            </div>
            <div className={styles.truthVelocityRow} role="row">
              <span role="cell">CURRENT · DRIFT</span>
              <span role="cell" ref={currentSpeed}>
                {velocitySpeed(initialVelocityPose, "currentDrift")}
              </span>
              <span role="cell" ref={currentToward}>
                {velocityToward(initialVelocityPose, "currentSet")}
              </span>
            </div>
            <div className={styles.truthVelocityRow} role="row">
              <span role="cell">GROUND · SOG</span>
              <span role="cell" ref={groundSpeed}>{velocitySpeed(initialVelocityPose, "sog")}</span>
              <span role="cell" ref={groundToward}>{velocityToward(initialVelocityPose, "cog")}</span>
            </div>
          </div>
        </div>
      </div>

      {vector ? <VectorTriangle race={race} inspection={inspection} /> : null}
    </section>
  );
}
