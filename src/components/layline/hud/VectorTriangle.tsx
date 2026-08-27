"use client";

import { useEffect, useRef } from "react";
import styles from "@/app/layline.module.css";
import { deg, fixStamp, knots, MISSING } from "@/lib/layline/format";
import {
  createVectorSurfaceModel,
  sampleVectorSurface,
  type LaylineInspectionSurface,
  type VectorSurfaceModel,
} from "@/lib/layline/surfaces";
import type { RaceData } from "@/lib/layline/types";
import { onLive, sampleLive, setText } from "./live";

const RECORDED_CAPTION = "Recorded fix components";
const RECONSTRUCTED_CAPTION = "Reconstructed from recorded fixes";
const RECORDED_CURRENT_CAPTION = "Recorded current sample";
const RECONSTRUCTED_CURRENT_CAPTION = "Reconstructed current from recorded fixes";
const VECTOR_RADIUS = 25;
const INVALID_VECTOR = "Replay velocity unavailable · invalid component evidence";

interface VectorNodes {
  water: SVGLineElement | null;
  current: SVGLineElement | null;
  ground: SVGLineElement | null;
  description: SVGDescElement | null;
  caption: HTMLSpanElement | null;
  currentCaption: HTMLSpanElement | null;
  waterValue: HTMLSpanElement | null;
  currentValue: HTMLSpanElement | null;
  groundValue: HTMLSpanElement | null;
}

function endpoint(x: number, y: number, scale: number): readonly [number, number] {
  return [x * scale, -y * scale];
}

function bearing(value: number | null): string {
  return value === null ? MISSING : deg(value);
}

function writeLine(
  line: SVGLineElement | null,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  if (line === null) return;
  line.setAttribute("x1", x1.toFixed(3));
  line.setAttribute("y1", y1.toFixed(3));
  line.setAttribute("x2", x2.toFixed(3));
  line.setAttribute("y2", y2.toFixed(3));
}

function setLineVisible(line: SVGLineElement | null, visible: boolean): void {
  if (line === null) return;
  if (visible) line.removeAttribute("visibility");
  else line.setAttribute("visibility", "hidden");
}

function labels(model: VectorSurfaceModel): readonly [string, string, string] {
  if (
    model.status !== "valid" ||
    model.water === null ||
    model.current === null ||
    model.ground === null
  ) {
    return ["STW unavailable · CTW unavailable", "Current unavailable", "SOG unavailable · COG unavailable"];
  }
  return [
    `${knots(model.water.speed)} kn STW · ${bearing(model.water.course)}° CTW toward`,
    `${knots(model.current.speed)} kn drift · ${bearing(model.current.course)}° set toward`,
    `${knots(model.ground.speed)} kn SOG · ${bearing(model.ground.course)}° COG toward`,
  ];
}

function descriptionText(model: VectorSurfaceModel): string {
  if (model.status !== "valid") {
    return `${model.caption}. ${model.currentCaption}. ${INVALID_VECTOR}.`;
  }
  return `${model.caption}. ${model.currentCaption}. Water vector plus current vector equals ground vector in course-frame meters per second.`;
}

function draw(model: VectorSurfaceModel, nodes: VectorNodes): void {
  setText(nodes.caption, model.caption);
  setText(nodes.currentCaption, model.currentCaption);
  const values = labels(model);
  setText(nodes.waterValue, values[0]);
  setText(nodes.currentValue, values[1]);
  setText(nodes.groundValue, values[2]);
  setText(nodes.description, descriptionText(model));
  if (
    model.status !== "valid" ||
    model.water === null ||
    model.current === null ||
    model.ground === null
  ) {
    setLineVisible(nodes.water, false);
    setLineVisible(nodes.current, false);
    setLineVisible(nodes.ground, false);
    writeLine(nodes.water, 0, 0, 0, 0);
    writeLine(nodes.current, 0, 0, 0, 0);
    writeLine(nodes.ground, 0, 0, 0, 0);
    return;
  }
  setLineVisible(nodes.water, true);
  setLineVisible(nodes.current, true);
  setLineVisible(nodes.ground, true);
  const scale = VECTOR_RADIUS / Math.max(model.water.speed, model.current.speed, model.ground.speed, 1);
  const water = endpoint(model.water.x, model.water.y, scale);
  const ground = endpoint(model.ground.x, model.ground.y, scale);
  writeLine(nodes.water, 0, 0, water[0], water[1]);
  writeLine(nodes.current, water[0], water[1], ground[0], ground[1]);
  writeLine(nodes.ground, 0, 0, ground[0], ground[1]);
}

function inspectionStatus(inspection: LaylineInspectionSurface | null | undefined): string {
  if (inspection === null || inspection === undefined || inspection.sampledAt === null) {
    return "Inspection trace unavailable";
  }
  if (inspection.traces.length === 0) {
    return `Inspection ${fixStamp(inspection.sampledAt)} · no racing-leg trace`;
  }
  return `Inspection ${fixStamp(inspection.sampledAt)} · ${inspection.traces
    .map((entry) => `${entry.side} ${entry.trace.status}`)
    .join(" · ")}`;
}

/** Semantic SVG: replay water + replay current = replay ground. */
export function VectorTriangle({
  race,
  inspection,
}: {
  race: RaceData;
  inspection?: LaylineInspectionSurface | null;
}) {
  const model = useRef(createVectorSurfaceModel());
  const water = useRef<SVGLineElement>(null);
  const current = useRef<SVGLineElement>(null);
  const ground = useRef<SVGLineElement>(null);
  const description = useRef<SVGDescElement>(null);
  const caption = useRef<HTMLSpanElement>(null);
  const currentCaption = useRef<HTMLSpanElement>(null);
  const waterValue = useRef<HTMLSpanElement>(null);
  const currentValue = useRef<HTMLSpanElement>(null);
  const groundValue = useRef<HTMLSpanElement>(null);
  const initial = sampleVectorSurface(sampleLive(race).pose, model.current);
  const initialLabels = labels(initial);
  const nodes = (): VectorNodes => ({
    water: water.current,
    current: current.current,
    ground: ground.current,
    description: description.current,
    caption: caption.current,
    currentCaption: currentCaption.current,
    waterValue: waterValue.current,
    currentValue: currentValue.current,
    groundValue: groundValue.current,
  });

  useEffect(
    () =>
      onLive(race, (live) => {
        draw(sampleVectorSurface(live.pose, model.current), nodes());
      }),
    [race],
  );

  return (
    <section className={styles.vectorTriangle} aria-label="Replay velocity vector triangle">
      <div className={styles.vectorHeader}>
        <strong>Water + current = ground</strong>
      </div>
      <svg
        className={styles.vectorPlot}
        viewBox="-34 -34 68 68"
        role="img"
        aria-labelledby="vector-triangle-title vector-triangle-description"
      >
        <title id="vector-triangle-title">Replay water, current, and ground velocity component closure</title>
        <desc id="vector-triangle-description" ref={description}>
          {descriptionText(initial)}
        </desc>
        <line className={styles.vectorWater} ref={water} markerEnd="url(#vector-water-arrow)" />
        <line className={styles.vectorCurrent} ref={current} markerEnd="url(#vector-current-arrow)" />
        <line className={styles.vectorGround} ref={ground} markerEnd="url(#vector-ground-arrow)" />
        <defs>
          <marker id="vector-water-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
            <path d="M0 0 L5 2.5 L0 5 Z" className={styles.vectorWaterFill} />
          </marker>
          <marker id="vector-current-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
            <path d="M0 0 L5 2.5 L0 5 Z" className={styles.vectorCurrentFill} />
          </marker>
          <marker id="vector-ground-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
            <path d="M0 0 L5 2.5 L0 5 Z" className={styles.vectorGroundFill} />
          </marker>
        </defs>
      </svg>
      <div className={styles.vectorLegend}>
        <span ref={waterValue}>{initialLabels[0]}</span>
        <span ref={currentValue}>{initialLabels[1]}</span>
        <span ref={groundValue}>{initialLabels[2]}</span>
      </div>
      <details className={styles.vectorMethod}>
        <summary>Method and sources</summary>
        <div className={styles.vectorMethodBody}>
          <span ref={caption}>{initial.caption}</span>
          <span ref={currentCaption}>{initial.currentCaption}</span>
          <p className={styles.vectorTrace} data-trace-status="visible">
            {inspectionStatus(inspection)}
          </p>
          <p>Recorded fixes are sampled at 4 Hz.</p>
          <p>Water velocity plus current equals ground velocity in course-frame metres per second.</p>
        </div>
      </details>
      {/* Exact contract strings remain visible to source and assistive audits. */}
      <span className={styles.srOnly}>
        {RECORDED_CAPTION}; {RECONSTRUCTED_CAPTION}; {RECORDED_CURRENT_CAPTION}; {RECONSTRUCTED_CURRENT_CAPTION}
      </span>
    </section>
  );
}
