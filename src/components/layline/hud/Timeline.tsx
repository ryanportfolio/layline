"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import styles from "@/app/layline.module.css";
import { type AnalysisTimelineLaneId } from "@/lib/layline/analysis-state";
import {
  analysisRangeEvidenceTarget,
  analysisTimelineLayout,
} from "@/lib/layline/analysis-workspace-ui";
import type { AnalysisRange, RangeComparison } from "@/lib/layline/comparison";
import { clock, signedMeters } from "@/lib/layline/format";
import {
  clampTimelineWindow,
  clipTimelineInterval,
  deriveEvidenceTimeline,
  packTimelinePoints,
  placeTimelinePoint,
  TIMELINE_POINT_OWNERSHIP_CLEARANCE,
  TIMELINE_POINT_ROW_LIMIT,
  type TimelineIntervalEvidence,
  type TimelinePointEvidence,
  type TimelineWindow,
} from "@/lib/layline/timeline";
import { FIX_HZ, type RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import { onLive, sampleLive, setText } from "./live";

const TACK_GLYPH = "M1.5 6.9 L5 2.7 L8.5 6.9";
const GYBE_GLYPH = "M1.5 3.1 L5 7.3 L8.5 3.1";

/* Raw fixes either side of the playhead. 4 Hz across ten seconds stays
 * legible while the whole-race view is open and becomes the axis at 10 s. */
const RAW_WINDOW = 10;
const FIX_STEP = 1 / FIX_HZ;
const RAW_TICKS = Math.round(RAW_WINDOW / FIX_STEP) + 1;

type TimelineStyle = CSSProperties & {
  "--point-position"?: string;
  "--point-row"?: number;
  "--point-rows"?: number;
  "--point-reserved-rows"?: number;
  "--timeline-height-budget"?: string;
};

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(4)}%`;
}

function intervalItems(items: readonly (TimelineIntervalEvidence | TimelinePointEvidence)[]) {
  return items.filter((item): item is TimelineIntervalEvidence => item.shape === "interval");
}

function pointItems(items: readonly (TimelineIntervalEvidence | TimelinePointEvidence)[]) {
  return items.filter((item): item is TimelinePointEvidence => item.shape === "point");
}

function timelineValueText(
  at: number,
  window: { from: number; to: number },
): string {
  const atText =
    at < 0
      ? `${Math.abs(at).toFixed(2)} seconds before the gun`
      : at === 0
        ? "At the gun"
        : `${at.toFixed(2)} seconds after the gun`;
  return `${atText}. Visible range ${clock(window.from)} to ${clock(window.to)}`;
}

function PackedPointRail<TItem extends TimelinePointEvidence>({
  ariaLabel,
  className,
  gridRow,
  items,
  ownershipClearance = TIMELINE_POINT_OWNERSHIP_CLEARANCE,
  reservedRows = TIMELINE_POINT_ROW_LIMIT,
  timelineWindow,
  renderPoint,
}: {
  ariaLabel: string;
  className: string;
  gridRow?: number;
  items: readonly TItem[];
  ownershipClearance?: number;
  reservedRows?: number;
  timelineWindow: TimelineWindow;
  renderPoint: (item: TItem, style: TimelineStyle) => ReactNode;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ laneWidth: 0, clearance: 0 });
  const packed = useMemo(
    () => packTimelinePoints(
      items,
      timelineWindow,
      geometry.laneWidth,
      geometry.clearance,
      ownershipClearance,
    ),
    [geometry, items, ownershipClearance, timelineWindow],
  );

  /* Target width and focus clearance change only at responsive breakpoints.
   * Each lane measures its own real content box. Stable row ownership is already
   * resolved by the pure helper; measurement only updates horizontal clearance. */
  useEffect(() => {
    const rail = railRef.current;
    if (rail === null) return;

    const measure = () => {
      const clearance = Number.parseFloat(
        getComputedStyle(rail).getPropertyValue("--point-clearance"),
      );
      const next = {
        laneWidth: Number.isFinite(clearance) && clearance > 0 ? rail.clientWidth : 0,
        clearance: Number.isFinite(clearance) && clearance > 0 ? clearance : 0,
      };
      setGeometry((current) =>
        current.laneWidth === next.laneWidth && current.clearance === next.clearance
          ? current
          : next,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={`${styles.pointRail} ${className}`}
      ref={railRef}
      role="group"
      aria-label={ariaLabel}
      style={{
        gridRow,
        "--point-rows": packed.rowCount,
        "--point-reserved-rows": reservedRows,
      } as TimelineStyle}
    >
      {packed.items.map(({ item, fraction, row }) =>
        renderPoint(item, {
          "--point-row": row,
          "--point-position": pct(fraction),
        }),
      )}
    </div>
  );
}

export function Timeline({
  race,
  comparison,
  selectedRange,
  visibleLaneIds,
}: {
  race: RaceData;
  comparison?: RangeComparison;
  selectedRange?: Readonly<AnalysisRange>;
  visibleLaneIds?: readonly AnalysisTimelineLaneId[];
}) {
  const followId = useReplay((state) => state.followId);
  const raw = useReplay((state) => state.mode === "raw");
  const analysis = useReplay((state) => state.analysis);
  const activeSelectedRange = selectedRange ?? analysis.selectedRange;

  const evidence = useMemo(() => deriveEvidenceTimeline(race, followId), [race, followId]);
  const phaseLane = evidence.lanes.find((lane) => lane.id === "phases");
  const eventLane = evidence.lanes.find((lane) => lane.id === "race-events");
  const maneuverLane = evidence.lanes.find((lane) => lane.id === "maneuvers");
  const phases = intervalItems(phaseLane?.items ?? []);
  const raceEvents = pointItems(eventLane?.items ?? []);
  const maneuvers = pointItems(maneuverLane?.items ?? []);
  const defaultLaneIds = useMemo<readonly AnalysisTimelineLaneId[]>(
    () => comparison === undefined
      ? ["event", "maneuver"]
      : ["event", "maneuver", "gain-loss"],
    [comparison],
  );
  /* The race-events lane opens on request and starts closed: the transport
   * belongs to the race, and a wall of packed event chips took almost half
   * the viewport away from it. Phases stopped being a lane at all; they are
   * the scrubber's own background now, so the one row that must always be up
   * carries them for free. */
  const [eventsOpen, setEventsOpen] = useState(false);
  const requestedLaneIds = visibleLaneIds ?? defaultLaneIds;
  const eventLaneRequested = requestedLaneIds.includes("event");
  const laneIds = useMemo(
    () => requestedLaneIds.filter(
      (id) => id !== "phase" && (eventsOpen || id !== "event"),
    ),
    [eventsOpen, requestedLaneIds],
  );
  const layout = useMemo(
    () => analysisTimelineLayout(laneIds, comparison !== undefined),
    [comparison, laneIds],
  );
  const laneRow = (laneId: Exclude<AnalysisTimelineLaneId, "raw-fix">) =>
    layout.rows.find((row) => row.id === laneId);
  /* One window, the whole race. The zoomed focus lenses are gone: every
   * evidence mark, phase band and the scrub itself always address the same
   * full tMin..tMax axis. */
  const timelineWindow = useMemo(
    () => clampTimelineWindow(race, 0, null),
    [race],
  );
  const startPlacement = useMemo(
    () => clipTimelineInterval(
      Math.max(race.tMin, -10),
      Math.min(race.tMax, 0),
      timelineWindow,
    ),
    [race.tMax, race.tMin, timelineWindow],
  );
  const selectedRangePlacement = useMemo(
    () => clipTimelineInterval(
      activeSelectedRange.from,
      activeSelectedRange.to,
      timelineWindow,
    ),
    [activeSelectedRange, timelineWindow],
  );
  const hues = useMemo(
    () => new Map(race.boats.map((boat) => [boat.id, boat.hue])),
    [race],
  );
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const rawWindowRef = useRef<HTMLDivElement>(null);
  const ticksRef = useRef<(HTMLDivElement | null)[]>([]);
  const dragging = useRef(false);
  const timelineHelpId = useId();
  const evidenceDetailPrefix = useId();

  /* React may render when the range or followed boat changes. Keep the latest
   * listener-owned clock here so that render cannot restore mount-time ARIA. */
  const seed = useRef(sampleLive(race).t);
  const liveTimeRef = useRef(seed.current);

  /* The shared replay clock is the only moving state. A focused view follows
   * only when playback leaves its bounds; scrubbing inside it never moves the
   * window underneath the pointer. */
  useEffect(() => {
    let stamp = "";
    return onLive(race, (live) => {
      liveTimeRef.current = live.t;
      const liveWindow = timelineWindow;

      const head = headRef.current;
      if (head !== null) {
        head.style.left = pct(placeTimelinePoint(live.t, liveWindow).fraction);
      }

      const reading = clock(live.t);
      const track = trackRef.current;
      if (track !== null) {
        track.setAttribute("aria-valuemin", liveWindow.from.toFixed(2));
        track.setAttribute("aria-valuemax", liveWindow.to.toFixed(2));
        track.setAttribute("aria-valuenow", live.t.toFixed(2));
        track.setAttribute("aria-valuetext", timelineValueText(live.t, liveWindow));
      }
      if (reading !== stamp) {
        stamp = reading;
        setText(elapsedRef.current, reading);
      }

      if (live.mode !== "raw" && !layout.showRawFixes) return;
      const visibleRaw = clipTimelineInterval(
        live.t - RAW_WINDOW / 2,
        live.t + RAW_WINDOW / 2,
        liveWindow,
      );
      const frame = rawWindowRef.current;
      if (frame !== null) {
        frame.style.display = visibleRaw === null ? "none" : "block";
        if (visibleRaw !== null) {
          frame.style.left = pct(visibleRaw.left);
          frame.style.width = pct(visibleRaw.width);
        }
      }

      const first = Math.ceil((live.t - RAW_WINDOW / 2 - race.tMin) / FIX_STEP);
      for (let i = 0; i < RAW_TICKS; i++) {
        const node = ticksRef.current[i];
        if (node === null || node === undefined) continue;
        const at = race.tMin + (first + i) * FIX_STEP;
        const placed = placeTimelinePoint(at, liveWindow);
        if (at < race.tMin || at > race.tMax || at > live.t + RAW_WINDOW / 2 || !placed.visible) {
          node.style.display = "none";
          continue;
        }
        node.style.display = "block";
        node.style.left = pct(placed.fraction);
      }
    });
  }, [layout.showRawFixes, race, raw, timelineWindow]);

  const seekFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (track === null || timelineWindow.span <= 0) return;
    const box = track.getBoundingClientRect();
    if (box.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    useReplay.getState().seek(timelineWindow.from + fraction * timelineWindow.span);
  };

  const seekEvidence = (at: number) => {
    const replay = useReplay.getState();
    replay.seek(at);
  };

  const seekSelectedRange = (edge: "in" | "out") => {
    const replay = useReplay.getState();
    const evidence = analysisRangeEvidenceTarget(activeSelectedRange, edge);
    replay.seek(evidence.seekTo);
  };

  const phaseWeight = (id: string): string => {
    if (id === "phase-prestart") return styles.bandQuiet;
    if (id === "phase-beat") return styles.bandStrong;
    return styles.bandMid;
  };

  /* A band label either fits whole or leaves: half a word inside a narrow band
   * (PRESTART clipped to PRESTA at 1280) reads as a defect, not a label. Band
   * widths are percentages of the track, so this settles at mount and moves
   * only with the row's own size: one ResizeObserver, reads batched before the
   * writes, nothing at frame cadence. */
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = rowRef.current;
    if (node === null) return;
    const fit = () => {
      const bands = node.querySelectorAll<HTMLElement>("[data-band]");
      const clipped: boolean[] = [];
      bands.forEach((band, index) => {
        const label = band.querySelector<HTMLElement>("[data-band-label]");
        clipped[index] = label !== null && label.scrollWidth > band.clientWidth - 2;
      });
      bands.forEach((band, index) => {
        if (clipped[index]) band.setAttribute("data-clipped", "");
        else band.removeAttribute("data-clipped");
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [race, layout]);

  return (
    <div
      ref={rowRef}
      className={`${styles.timelineRow} ${laneRow("gain-loss") === undefined ? styles.timelineRowBasic : ""}`}
      data-analysis-flow="timeline"
      style={{ "--timeline-height-budget": `${layout.heightBudgetPx}px` } as TimelineStyle}
    >
      {eventLaneRequested ? (
        <div className={styles.timelineHeader}>
          <button
            type="button"
            className={styles.eventsToggle}
            aria-expanded={eventsOpen}
            data-events={eventsOpen ? "open" : "closed"}
            onClick={() => setEventsOpen((open) => !open)}
          >
            <svg className={styles.eventsToggleGlyph} viewBox="0 0 10 10" aria-hidden="true">
              <path d={eventsOpen ? "M1.5 6.9 L5 2.7 L8.5 6.9" : "M1.5 3.1 L5 7.3 L8.5 3.1"} />
            </svg>
            <span>{`Race events ${raceEvents.length}`}</span>
          </button>
        </div>
      ) : null}

      {laneRow("start") === undefined ? null : (
        <>
          <span
            className={styles.evidenceLaneLabel}
            style={{ gridRow: laneRow("start")?.labelGridRow }}
          >
            Start window
          </span>
          <div
            className={styles.phaseRail}
            role="group"
            aria-label="Start evidence window"
            style={{ gridRow: laneRow("start")?.railGridRow }}
          >
            {startPlacement === null ? null : (
              <button
                type="button"
                className={`${styles.phaseBand} ${styles.bandQuiet}`}
                data-band=""
                style={{ left: pct(startPlacement.left), width: pct(startPlacement.width) }}
                aria-label={`Go to start window at ${clock(Math.max(race.tMin, -10))}`}
                onClick={() => seekEvidence(Math.max(race.tMin, -10))}
              >
                <span className={styles.bandLabel} data-band-label="">Last 10 seconds</span>
              </button>
            )}
          </div>
        </>
      )}

      {laneRow("event") === undefined ? null : (
        <>
          <span
            className={styles.evidenceLaneLabel}
            style={{ gridRow: laneRow("event")?.labelGridRow }}
          >
            {eventLane?.label ?? "Race events"}
          </span>
          <PackedPointRail
            className={styles.eventRail}
            gridRow={laneRow("event")?.railGridRow}
            ariaLabel="Race events"
            items={raceEvents}
            ownershipClearance={28}
            timelineWindow={timelineWindow}
            renderPoint={(item, pointStyle) => {
              const descriptionId = `${evidenceDetailPrefix}-${item.id}`;
              const detail = `${item.label} · ${clock(item.at)} · Source ${item.provenance.source}`;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`${styles.pointMark} ${styles.eventMark}`}
                  style={{
                    ...pointStyle,
                    color: item.boatId === undefined ? undefined : hues.get(item.boatId),
                  }}
                  data-event={item.eventKind}
                  aria-label={`Go to ${item.label} at ${clock(item.at)}`}
                  aria-describedby={descriptionId}
                  onClick={() => seekEvidence(item.at)}
                >
                  <span>{item.shortLabel}</span>
                  <span id={descriptionId} className={styles.srOnly}>{detail}</span>
                </button>
              );
            }}
          />
        </>
      )}

      {laneRow("maneuver") === undefined ? null : (
        <>
          <span
            className={styles.evidenceLaneLabel}
            style={{ gridRow: laneRow("maneuver")?.labelGridRow }}
          >
            {maneuverLane?.label ?? "Turns"}
          </span>
          <PackedPointRail
            className={styles.manRail}
            gridRow={laneRow("maneuver")?.railGridRow}
            ariaLabel={maneuverLane?.label ?? "Tacks and gybes"}
            items={maneuvers}
            ownershipClearance={46}
            reservedRows={1}
            timelineWindow={timelineWindow}
            renderPoint={(maneuver, pointStyle) => {
              const descriptionId = `${evidenceDetailPrefix}-${maneuver.id}`;
              const detail = `${maneuver.label} · ${clock(maneuver.at)} · ${maneuver.detail} · Source ${maneuver.provenance.source}`;
              return (
                <button
                  key={maneuver.id}
                  type="button"
                  className={`${styles.pointMark} ${styles.manMark}`}
                  style={pointStyle}
                  data-maneuver={maneuver.maneuverKind}
                  data-at={maneuver.at}
                  aria-label={`Go to the ${maneuver.label.toLowerCase()} at ${clock(maneuver.at)}`}
                  aria-describedby={descriptionId}
                  onClick={() => seekEvidence(maneuver.at)}
                >
                  <svg className={styles.manGlyph} viewBox="0 0 10 10" aria-hidden="true">
                    <path d={maneuver.maneuverKind === "tack" ? TACK_GLYPH : GYBE_GLYPH} />
                  </svg>
                  <span className={styles.manLabel}>
                    {maneuver.maneuverKind === "tack" ? "Tack" : "Gybe"}
                  </span>
                  <span id={descriptionId} className={styles.srOnly}>{detail}</span>
                </button>
              );
            }}
          />
        </>
      )}

      {comparison === undefined || laneRow("gain-loss") === undefined ? null : (
        <>
          <span
            className={styles.evidenceLaneLabel}
            style={{ gridRow: laneRow("gain-loss")?.labelGridRow }}
          >
            Ground gain
          </span>
          <div
            className={styles.comparisonRail}
            role="group"
            aria-label="Selected ground-reference comparison range"
            style={{ gridRow: laneRow("gain-loss")?.railGridRow }}
          >
            {selectedRangePlacement === null ? null : (
              <button
                type="button"
                className={styles.comparisonRangeBand}
                style={{
                  left: pct(selectedRangePlacement.left),
                  width: pct(selectedRangePlacement.width),
                }}
                data-gain={
                  comparison.progressGainedMeters === null
                    ? "unavailable"
                    : comparison.progressGainedMeters > 0
                      ? "gained"
                      : comparison.progressGainedMeters < 0
                        ? "lost"
                        : "even"
                }
                aria-label={`Seek selected comparison range start ${clock(activeSelectedRange.from)}. Ground-reference progress ${comparison.progressGainedMeters === null ? "unavailable" : `${signedMeters(comparison.progressGainedMeters)} metres`}.`}
                onClick={() => seekSelectedRange("in")}
              >
                {comparison.progressGainedMeters === null
                  ? "Unavailable"
                  : `${signedMeters(comparison.progressGainedMeters)} m`}
              </button>
            )}
          </div>
        </>
      )}

      <span
        className={styles.evidenceLaneLabel}
        style={{ gridRow: layout.replayLabelGridRow }}
      >
        Replay
      </span>
      <div
        className={styles.track}
        style={{ gridRow: layout.replayRailGridRow }}
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Race time"
        aria-describedby={timelineHelpId}
        aria-valuemin={timelineWindow.from}
        aria-valuemax={timelineWindow.to}
        aria-valuenow={liveTimeRef.current}
        aria-valuetext={timelineValueText(liveTimeRef.current, timelineWindow)}
        onPointerDown={(event) => {
          dragging.current = true;
          useReplay.getState().pause();
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!dragging.current) return;
          seekFromPointer(event);
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onKeyDown={(event) => {
          const store = useReplay.getState();
          if (event.key === "ArrowRight" || event.key === "ArrowUp") store.step(1);
          else if (event.key === "ArrowLeft" || event.key === "ArrowDown") store.step(-1);
          else if (event.key === "Home") store.seek(timelineWindow.from);
          else if (event.key === "End") store.seek(timelineWindow.to);
          else return;
          event.preventDefault();
        }}
      >
        {/* The phases live inside the scrubber as its background: the same
            clipTimelineInterval placement the old lane used, painted under the
            playhead. Decorative here; the sr-only summary below carries the
            spans for a reader, and clicking a band is just seeking. */}
        <div className={styles.trackPhases} aria-hidden="true">
          {phases.map((phase) => {
            const placed = clipTimelineInterval(phase.from, phase.to, timelineWindow);
            if (placed === null) return null;
            return (
              <span
                key={phase.id}
                className={`${styles.trackPhaseBand} ${phaseWeight(phase.id)}`}
                data-phase={phase.id}
                data-band=""
                style={{ left: pct(placed.left), width: pct(placed.width) }}
              >
                <span className={styles.trackPhaseLabel} data-band-label="">{phase.label}</span>
              </span>
            );
          })}
        </div>
        {comparison === undefined || laneRow("gain-loss") === undefined || selectedRangePlacement === null ? null : (
          <div
            className={styles.selectedRangeHighlight}
            style={{
              left: pct(selectedRangePlacement.left),
              width: pct(selectedRangePlacement.width),
            }}
            data-analysis-range={`${activeSelectedRange.fromMicros}:${activeSelectedRange.toMicros}`}
            aria-hidden="true"
          />
        )}
        {raw || layout.showRawFixes ? (
          <div className={styles.rawStrip} aria-hidden="true">
            <div className={styles.rawWindow} ref={rawWindowRef} />
            {Array.from({ length: RAW_TICKS }, (item, index) => (
              <div
                key={index}
                className={styles.rawTick}
                data-raw-tick=""
                ref={(node) => {
                  ticksRef.current[index] = node;
                }}
              />
            ))}
          </div>
        ) : null}

        <div
          className={styles.playhead}
          ref={headRef}
          data-live="playhead"
          style={{ left: pct(placeTimelinePoint(liveTimeRef.current, timelineWindow).fraction) }}
        >
          <span className={styles.playheadGrip} />
        </div>
      </div>

      <span id={timelineHelpId} className={styles.timelineHelp}>
        Arrow keys move one 0.25 second telemetry sample. Home and End move to the visible range
        limits.
      </span>
      <span className={styles.srOnly}>
        {`Race phases: ${phases
          .map((phase) => `${phase.label} ${clock(phase.from)} to ${clock(phase.to)}`)
          .join(", ")}`}
      </span>
      <span
        className={styles.timeClockNow}
        ref={elapsedRef}
        data-live="elapsed"
        style={{ gridRow: layout.clockGridRow }}
      >
        {clock(liveTimeRef.current)}
      </span>
      <span className={styles.timeClockTotal} style={{ gridRow: layout.clockGridRow }}>
        {clock(race.tMax)}
      </span>
    </div>
  );
}
