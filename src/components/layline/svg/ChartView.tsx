"use client";

import { useEffect, useMemo, useRef } from "react";
import styles from "@/app/layline.module.css";
import type { LayerVisibility } from "@/lib/layline/analysis-state";
import {
  createReplayRawFixEvidenceModel,
  replayRawFixesVisible,
  sampleReplayRawFixEvidence,
  type ReplayRawFixEvidenceKind,
} from "@/lib/layline/analysis-layers";
import { createPose, poseAt } from "@/lib/layline/interpolate";
import { FIX_HZ, type Pose, type RaceData, type ReplayMode } from "@/lib/layline/types";
import {
  CURRENT_FIELD_PROVENANCE,
  CURRENT_FIELD_SVG_MAX_GLYPHS,
  chartTruthMarkerCacheKey,
  createCurrentFieldGrid,
  laylineInspectionSvgPaths,
  sampleCurrentFieldGrid,
  type LaylineInspectionSurface,
} from "@/lib/layline/surfaces";
import { useReplay } from "../store";
import { onLive, sampleLive } from "../hud/live";
import { chartFrame, lengthAt, toPath, type ChartTrack } from "./chartFrame";
import { CourseFurniture } from "./CourseFurniture";

/* The hull, six metres of it, pointing up the course before it is rotated onto
 * its heading. Metres, like everything else in this drawing. */
const HULL = "M0 -5.4 L3 4 L0 2.2 L-3 4 Z";

/* A dash pattern only has to outrun the longest track once, so the gap is
 * stated rather than measured every frame. */
const GAP = 100000;

interface Node {
  track: ChartTrack;
  line: SVGPathElement;
  outline: SVGPathElement | null;
  hull: SVGGElement;
  drawn: number;
  x: number;
  y: number;
  hdg: number;
}

interface RawFixMarkerState {
  race: RaceData | null;
  boatId: string | null;
  fixIndex: number;
  mode: ReplayMode | null;
  kind: ReplayRawFixEvidenceKind;
}

/**
 * 2D mode. The same fitted frame as the still chart, on the replay clock: each
 * track draws itself as its boat sails it and a hull marker sits at the head of
 * it, both written straight into the DOM off the same evaluator the scene and
 * the docks read.
 *
 * Reveal is a dash length measured along the polyline the path was built from,
 * so the drawn stretch is the water the boat has actually covered rather than a
 * share of the clock.
 */
export function ChartView({
  race,
  inspection,
  layers,
}: {
  race: RaceData;
  inspection: LaylineInspectionSurface | null;
  layers: LayerVisibility;
}) {
  const followId = useReplay((state) => state.followId);
  const truthMode = useReplay((state) => state.truthMode);
  const showRawFixes = replayRawFixesVisible(layers, truthMode);
  const frame = useMemo(() => chartFrame(race), [race]);
  const laylinePaths = useMemo(() => laylineInspectionSvgPaths(inspection), [inspection]);
  const lines = useRef(new Map<string, SVGPathElement | null>());
  const outlines = useRef(new Map<string, SVGPathElement | null>());
  const hulls = useRef(new Map<string, SVGGElement | null>());
  const rawFixMarkers = useRef<(SVGCircleElement | null)[]>([]);
  const currentGlyphs = useRef<(SVGGElement | null)[]>([]);
  /* One pose for the whole pass: every boat is evaluated into it in turn and
   * nothing survives the frame. */
  const pose = useRef<Pose>(createPose());
  const rawFixEvidence = useMemo(() => createReplayRawFixEvidenceModel(race), [race]);
  const rawFixMarkerState = useMemo<RawFixMarkerState[]>(
    () => rawFixEvidence.slots.map(() => ({
      race: null,
      boatId: null,
      fixIndex: -1,
      mode: null,
      kind: "none",
    })),
    [rawFixEvidence],
  );
  const currentGrid = useMemo(
    () => createCurrentFieldGrid(race, CURRENT_FIELD_SVG_MAX_GLYPHS),
    [race],
  );

  /* The drawing is seeded off the clock this render sees rather than left at
   * nothing for the listener to fill in, so the mode opens on the race as it
   * stands and a re-render for another boat cannot wind every track back to
   * the start of the feed. One pose object per render, never per frame. */
  const now = sampleLive(race);
  const seedPose: Pose = createPose();
  const seedT = now.mode === "raw" ? Math.floor(now.t * FIX_HZ) / FIX_HZ : now.t;
  const seedDash = (track: ChartTrack) => `${lengthAt(track, seedT).toFixed(1)} ${GAP}`;
  const seedHull = (boatId: string) => {
    poseAt(race, boatId, now.t, now.mode, seedPose);
    return `translate(${seedPose.x.toFixed(1)} ${(-seedPose.y).toFixed(1)}) rotate(${seedPose.hdg.toFixed(1)})`;
  };
  sampleReplayRawFixEvidence(race, now.t, followId, layers, truthMode, rawFixEvidence);
  sampleCurrentFieldGrid(race, now.t, currentGrid);
  const currentTransform = (index: number): string => {
    const glyph = currentGrid.glyphs[index];
    const angle = (Math.atan2(-glyph.currentY, glyph.currentX) * 180) / Math.PI;
    const length = Math.max(4, glyph.drift * 18);
    return `translate(${glyph.x.toFixed(2)} ${(-glyph.y).toFixed(2)}) rotate(${angle.toFixed(2)}) scale(${length.toFixed(2)} 1)`;
  };
  let rawFixAria = "";
  if (showRawFixes) {
    rawFixAria = rawFixEvidence.kind === "fleet-window"
      ? `, plus measured 4 Hz fixes for all ${rawFixEvidence.boatCount} boats`
      : `, plus measured 4 Hz fixes around ${followId}`;
  }

  useEffect(() => {
    const nodes: Node[] = [];
    for (const track of frame.tracks) {
      const line = lines.current.get(track.boat.id) ?? null;
      const hull = hulls.current.get(track.boat.id) ?? null;
      if (line === null || hull === null) continue;
      nodes.push({
        track,
        line,
        outline: outlines.current.get(track.boat.id) ?? null,
        hull,
        drawn: Number.NaN,
        x: Number.NaN,
        y: Number.NaN,
        hdg: Number.NaN,
      });
    }

    return onLive(race, (live) => {
      if (layers.current) {
        sampleCurrentFieldGrid(race, live.t, currentGrid);
        for (let index = 0; index < currentGrid.glyphs.length; index++) {
          const glyph = currentGrid.glyphs[index];
          const node = currentGlyphs.current[index];
          if (node === null || node === undefined) continue;
          const angle = (Math.atan2(-glyph.currentY, glyph.currentX) * 180) / Math.PI;
          const length = Math.max(4, glyph.drift * 18);
          node.setAttribute(
            "transform",
            `translate(${glyph.x.toFixed(2)} ${(-glyph.y).toFixed(2)}) rotate(${angle.toFixed(2)}) scale(${length.toFixed(2)} 1)`,
          );
        }
      }
      /* The raw lens holds every hull at its latest fix, so the trail head has
       * to hold there too or it slides ahead of the boat between fixes. */
      const tDraw = live.mode === "raw" ? Math.floor(live.t * FIX_HZ) / FIX_HZ : live.t;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const drawn = lengthAt(node.track, tDraw);
        /* Half a metre is a tenth of a hull length and well under a pixel at
         * every size this drawing is shown at. */
        if (!(Math.abs(drawn - node.drawn) < 0.5)) {
          node.drawn = drawn;
          const dash = `${drawn.toFixed(1)} ${GAP}`;
          node.line.setAttribute("stroke-dasharray", dash);
          if (node.outline !== null) node.outline.setAttribute("stroke-dasharray", dash);
        }
        poseAt(race, node.track.boat.id, live.t, live.mode, pose.current);
        const x = pose.current.x;
        const y = -pose.current.y;
        const hdg = pose.current.hdg;
        if (
          !(Math.abs(x - node.x) < 0.05 && Math.abs(y - node.y) < 0.05 && Math.abs(hdg - node.hdg) < 0.2)
        ) {
          node.x = x;
          node.y = y;
          node.hdg = hdg;
          node.hull.setAttribute(
            "transform",
            `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${hdg.toFixed(1)})`,
          );
        }
      }

      if (showRawFixes) {
        sampleReplayRawFixEvidence(
          race,
          live.t,
          live.followId,
          layers,
          truthMode,
          rawFixEvidence,
        );
        for (const entry of rawFixEvidence.slots) {
          const marker = rawFixMarkers.current[entry.slot];
          if (marker === null || marker === undefined) continue;
          if (entry.fix === null || entry.boatId === null) {
            marker.style.display = "none";
            continue;
          }
          marker.style.display = "";
          const state = rawFixMarkerState[entry.slot];
          if (
            state.race !== race
            || state.boatId !== entry.boatId
            || state.fixIndex !== entry.fixIndex
            || state.mode !== live.mode
            || state.kind !== rawFixEvidence.kind
          ) {
            const markerKey = chartTruthMarkerCacheKey(
              race,
              entry.boatId,
              live.mode,
              true,
              entry.fixIndex,
              entry.fixIndex + 1,
            );
            state.race = race;
            state.boatId = entry.boatId;
            state.fixIndex = entry.fixIndex;
            state.mode = live.mode;
            state.kind = rawFixEvidence.kind;
            marker.dataset.cacheKey = markerKey;
            marker.dataset.boatId = entry.boatId;
            marker.dataset.fixIndex = String(entry.fixIndex);
            marker.dataset.evidenceKind = rawFixEvidence.kind;
            marker.setAttribute("cx", entry.fix.x.toFixed(2));
            marker.setAttribute("cy", (-entry.fix.y).toFixed(2));
          }
          const bracket = entry.bracket ? "true" : "false";
          if (marker.dataset.bracket !== bracket) marker.dataset.bracket = bracket;
        }
      }
    });
  }, [race, frame, showRawFixes, truthMode, layers, currentGrid, rawFixEvidence, rawFixMarkerState]);

  return (
    <div className={styles.chartLayer}>
      <svg
        className={styles.chartView}
        viewBox={frame.viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Course chart on the replay clock with the start line and the windward mark${layers.tracks ? `, ${race.boats.length} boat tracks drawing from the prestart` : ""}${rawFixAria}`}
        data-view="chart2d"
      >
        {/* The whole route at a whisper, so a boat is read against where it is
            going as well as where it has been. */}
        <g data-analysis-layer="tracks" style={layers.tracks ? undefined : { display: "none" }}>
          {frame.tracks.map(({ boat, points }) => (
            <path
              key={`ghost-${boat.id}`}
              d={toPath(points)}
              className={styles.chart2dGhost}
              stroke={boat.dark === true ? "var(--ink-dim)" : boat.hue}
            />
          ))}

          {frame.tracks.map((track) => (
            <g key={track.boat.id} opacity={track.boat.id === followId ? 1 : 0.62}>
            {track.boat.dark === true ? (
              <path
                ref={(node) => {
                  outlines.current.set(track.boat.id, node);
                }}
                d={toPath(track.points)}
                className={styles.chartTrack}
                stroke="var(--ink-dim)"
                strokeWidth={3.2}
                opacity={0.55}
                strokeDasharray={seedDash(track)}
              />
            ) : null}
            <path
              data-track={track.boat.id}
              ref={(node) => {
                lines.current.set(track.boat.id, node);
              }}
              d={toPath(track.points)}
              className={styles.chartTrack}
              stroke={track.boat.hue}
              strokeDasharray={seedDash(track)}
            />
            </g>
          ))}
        </g>

        <CourseFurniture course={race.course} labelX={frame.maxX} named={false} />

        <g
          data-analysis-layer="laylines"
          data-provenance={inspection?.provenance}
          data-sampled-at={inspection?.sampledAt ?? undefined}
          aria-label={laylinePaths.length > 0 ? inspection?.provenance : "Layline inspection unavailable"}
          style={layers.laylines ? undefined : { display: "none" }}
        >
          {laylinePaths.map((path, index) => (
            <path
              key={`${path.side}-${index}`}
              d={path.d}
              className={styles.chartLayline}
              data-trace-side={path.side}
              data-provenance={path.provenance}
              data-sampled-at={path.sampledAt}
            />
          ))}
        </g>

        <g
          data-analysis-layer="current"
          data-current-field="seeded"
          data-provenance={CURRENT_FIELD_PROVENANCE}
          aria-label={CURRENT_FIELD_PROVENANCE}
          style={layers.current ? undefined : { display: "none" }}
        >
          <title>{CURRENT_FIELD_PROVENANCE}</title>
          {currentGrid.glyphs.map((_, index) => (
            <g
              key={index}
              ref={(node) => {
                currentGlyphs.current[index] = node;
              }}
              transform={currentTransform(index)}
              className={styles.chartCurrentGlyph}
            >
              <line x1="0" y1="0" x2="1" y2="0" />
              <path d="M1 0 L0.68 -0.18 L0.68 0.18 Z" />
            </g>
          ))}
        </g>

        {frame.tracks.map(({ boat }) => (
          <g
            key={`hull-${boat.id}`}
            data-hull={boat.id}
            transform={seedHull(boat.id)}
            ref={(node) => {
              hulls.current.set(boat.id, node);
            }}
          >
            <path
              d={HULL}
              fill={boat.hue}
              stroke={boat.id === followId ? "var(--ink)" : "var(--ink-dim)"}
              strokeWidth={boat.id === followId ? 1.4 : 0.8}
              strokeLinejoin="round"
            />
          </g>
        ))}

        {showRawFixes ? (
          <g
            data-analysis-layer="raw-fixes"
            data-evidence-kind={rawFixEvidence.kind}
            data-truth-fixes={rawFixEvidence.kind === "truth-witness" ? followId : undefined}
            data-raw-fix-boats={
              rawFixEvidence.kind === "fleet-window" ? rawFixEvidence.boatCount : undefined
            }
            data-provenance="measured"
            aria-hidden="true"
          >
            {rawFixEvidence.slots.map((entry) => {
              const fix = entry.fix;
              const markerKey = fix !== null && entry.boatId !== null
                ? chartTruthMarkerCacheKey(
                    race,
                    entry.boatId,
                    now.mode,
                    true,
                    entry.fixIndex,
                    entry.fixIndex + 1,
                  )
                : undefined;
              return (
                <circle
                  key={entry.slot}
                  ref={(node) => {
                    rawFixMarkers.current[entry.slot] = node;
                  }}
                  className={styles.chartTruthFix}
                  cx={fix?.x ?? 0}
                  cy={fix === null ? 0 : -fix.y}
                  r={1.8}
                  data-boat-id={entry.boatId ?? undefined}
                  data-fix-index={fix === null ? undefined : entry.fixIndex}
                  data-cache-key={markerKey}
                  data-evidence-kind={fix === null ? undefined : rawFixEvidence.kind}
                  data-bracket={entry.bracket ? "true" : "false"}
                  style={fix === null ? { display: "none" } : undefined}
                />
              );
            })}
          </g>
        ) : null}
      </svg>
    </div>
  );
}
