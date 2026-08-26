import { maneuversOf } from "./analytics";
import { MISSING } from "./format";
import { FIX_HZ, type RaceData, type RaceEventKind } from "./types";

export type TimelineEvidenceSource = "race.events" | "race.fixes";

export interface TimelineProvenance {
  source: TimelineEvidenceSource;
  method: "event-boundary" | "recorded-event" | "twa-sign-flip";
  sampleRateHz?: number;
}

interface TimelineEvidenceBase {
  id: string;
  label: string;
  shortLabel: string;
  boatId?: string;
  provenance: TimelineProvenance;
}

export interface TimelineIntervalEvidence extends TimelineEvidenceBase {
  shape: "interval";
  from: number;
  to: number;
}

export interface TimelinePointEvidence extends TimelineEvidenceBase {
  shape: "point";
  at: number;
  eventKind?: RaceEventKind;
  maneuverKind?: "tack" | "gybe";
  detail?: string;
}

export type TimelineEvidence = TimelineIntervalEvidence | TimelinePointEvidence;

export interface TimelineLane<TItem extends TimelineEvidence = TimelineEvidence> {
  id: string;
  label: string;
  items: TItem[];
}

export interface EvidenceTimeline {
  selectedBoatId: string;
  lanes: TimelineLane[];
}

export interface TimelineWindow {
  from: number;
  to: number;
  span: number;
}

export interface TimelinePointPlacement {
  visible: boolean;
  fraction: number;
}

export interface TimelineIntervalPlacement {
  from: number;
  to: number;
  left: number;
  width: number;
}

export interface PackedTimelinePoint<TItem> {
  item: TItem;
  sourceFraction: number;
  fraction: number;
  row: number;
}

export interface PackedTimelinePoints<TItem> {
  items: PackedTimelinePoint<TItem>[];
  rowCount: number;
}

export interface RecenteredTimelineWindow {
  window: TimelineWindow;
  recentered: boolean;
}

/** Default reserved rail rows. Every additional packed row remains visible. */
export const TIMELINE_POINT_ROW_LIMIT = 2;

/**
 * Row ownership uses the narrowest shipped rail geometry, not a DOM measurement.
 * Measurement may relax horizontal clearance on wider rails, but it cannot move
 * a point to another row after first paint.
 */
export const TIMELINE_POINT_OWNERSHIP_WIDTH = 288;
export const TIMELINE_POINT_OWNERSHIP_CLEARANCE = 48;

const EVENT_PROVENANCE: TimelineProvenance = {
  source: "race.events",
  method: "recorded-event",
};

const PHASE_PROVENANCE: TimelineProvenance = {
  source: "race.events",
  method: "event-boundary",
};

const MANEUVER_PROVENANCE: TimelineProvenance = {
  source: "race.fixes",
  method: "twa-sign-flip",
  sampleRateHz: FIX_HZ,
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, from: number, to: number): number {
  return Math.min(to, Math.max(from, value));
}

function selectedBoatOf(race: RaceData, requestedId: string): string {
  if (race.boats.some((boat) => boat.id === requestedId)) return requestedId;
  return race.boats[0]?.id ?? requestedId;
}

function eventLabel(
  race: RaceData,
  kind: RaceEventKind,
  boatId: string | undefined,
  rank: number | undefined,
): { label: string; shortLabel: string } {
  if (kind === "gun") return { label: "Gun", shortLabel: "G" };
  const boat = race.boats.find((entry) => entry.id === boatId);
  const sail = boat?.sail ?? boatId ?? "Fleet";
  if (kind === "rounding") return { label: `${sail} mark`, shortLabel: "M" };
  return {
    label: rank === undefined ? `${sail} finish` : `${sail} finish P${rank}`,
    shortLabel: "F",
  };
}

function phaseItems(race: RaceData, boatId: string): TimelineIntervalEvidence[] {
  const gun = race.events.find((event) => event.kind === "gun");
  if (gun === undefined) return [];

  const rounding = race.events.find(
    (event) => event.kind === "rounding" && event.boatId === boatId,
  );
  const finish = race.events.find(
    (event) => event.kind === "finish" && event.boatId === boatId,
  );
  const out: TimelineIntervalEvidence[] = [];

  const add = (id: string, label: string, from: number, to: number) => {
    const safeFrom = clamp(from, race.tMin, race.tMax);
    const safeTo = clamp(to, race.tMin, race.tMax);
    if (safeTo <= safeFrom) return;
    out.push({
      id: `phase-${id}`,
      shape: "interval",
      label,
      shortLabel: label,
      boatId,
      from: safeFrom,
      to: safeTo,
      provenance: PHASE_PROVENANCE,
    });
  };

  add("prestart", "Prestart", race.tMin, gun.t);
  add("beat", "Beat", gun.t, rounding?.t ?? finish?.t ?? race.tMax);
  if (rounding !== undefined) add("run", "Run", rounding.t, finish?.t ?? race.tMax);
  if (finish !== undefined) add("finished", "Finished", finish.t, race.tMax);
  return out;
}

/**
 * Build the timeline's evidence without reading replay state or the DOM.
 * Event times stay on the exact event records. Maneuvers stay on the existing
 * fix-derived detector used by Debrief.
 */
export function deriveEvidenceTimeline(race: RaceData, requestedBoatId: string): EvidenceTimeline {
  const selectedBoatId = selectedBoatOf(race, requestedBoatId);
  const boat = race.boats.find((entry) => entry.id === selectedBoatId);

  const raceEvents: TimelinePointEvidence[] = race.events.map((event, index) => {
    const labels = eventLabel(race, event.kind, event.boatId, event.rank);
    return {
      id: `event-${event.kind}-${event.boatId ?? "fleet"}-${event.t}-${index}`,
      shape: "point",
      label: labels.label,
      shortLabel: labels.shortLabel,
      boatId: event.boatId,
      at: event.t,
      eventKind: event.kind,
      provenance: EVENT_PROVENANCE,
    };
  });

  const maneuvers: TimelinePointEvidence[] = maneuversOf(race, selectedBoatId).map(
    (maneuver, index) => ({
      id: `maneuver-${maneuver.kind}-${maneuver.t}-${index}`,
      shape: "point",
      label: maneuver.kind === "tack" ? "Tack" : "Gybe",
      shortLabel: maneuver.kind === "tack" ? "T" : "G",
      boatId: selectedBoatId,
      at: maneuver.t,
      maneuverKind: maneuver.kind,
      detail: `${maneuver.lossKnots ?? MISSING} kn below the fastest reading in the 4 s before the turn`,
      provenance: MANEUVER_PROVENANCE,
    }),
  );

  return {
    selectedBoatId,
    lanes: [
      {
        id: "phases",
        label: boat === undefined ? "Phases" : `Phases ${boat.sail}`,
        items: phaseItems(race, selectedBoatId),
      },
      { id: "race-events", label: "Race events", items: raceEvents },
      {
        id: "maneuvers",
        label: boat === undefined ? "Turns" : `Turns ${boat.sail}`,
        items: maneuvers,
      },
    ],
  };
}

/** Center a fixed-duration view, shifting it intact at the race ends. */
export function clampTimelineWindow(
  race: Pick<RaceData, "tMin" | "tMax">,
  center: number,
  requestedSpan: number | null,
): TimelineWindow {
  const fullSpan = Math.max(0, race.tMax - race.tMin);
  if (requestedSpan === null || !Number.isFinite(requestedSpan) || requestedSpan >= fullSpan) {
    return { from: race.tMin, to: race.tMax, span: fullSpan };
  }
  if (fullSpan === 0) return { from: race.tMin, to: race.tMax, span: 0 };

  const span = Math.min(fullSpan, Math.max(1 / FIX_HZ, requestedSpan));
  const safeCenter = clamp(finiteOr(center, race.tMin), race.tMin, race.tMax);
  const from = clamp(safeCenter - span / 2, race.tMin, race.tMax - span);
  return { from, to: from + span, span };
}

/**
 * Keep a valid focused window still while the clock remains inside it. External
 * seeks and changed race bounds recenter through the same clamping rule used
 * when a range is first selected.
 */
export function recenterTimelineWindow(
  race: Pick<RaceData, "tMin" | "tMax">,
  current: TimelineWindow,
  at: number,
  requestedSpan: number | null,
): RecenteredTimelineWindow {
  const safeAt = clamp(finiteOr(at, race.tMin), race.tMin, race.tMax);
  const centered = clampTimelineWindow(race, safeAt, requestedSpan);
  const epsilon = 1e-9;
  const currentIsValid =
    current.from >= race.tMin - epsilon &&
    current.to <= race.tMax + epsilon &&
    Math.abs(current.to - current.from - current.span) <= epsilon &&
    Math.abs(current.span - centered.span) <= epsilon;

  if (currentIsValid && safeAt >= current.from && safeAt <= current.to) {
    return { window: current, recentered: false };
  }
  return { window: centered, recentered: true };
}

/** Place a point on a window axis. Off-window points clamp for safe CSS but stay hidden. */
export function placeTimelinePoint(at: number, window: TimelineWindow): TimelinePointPlacement {
  if (window.span <= 0) return { visible: at === window.from, fraction: 0 };
  const fraction = (at - window.from) / window.span;
  return {
    visible: at >= window.from && at <= window.to,
    fraction: clamp(fraction, 0, 1),
  };
}

/**
 * Color equal-width point intervals into the earliest reusable row. A row is
 * reusable only after the prior target plus its focus clearance ends. Target
 * centers clamp by half that clearance at the rail edges, so pointer and focus
 * bounds stay inside the lane. The greedy result is deterministic and uses the
 * minimum rows for these sorted, equal-width intervals. Row ownership is fixed
 * by the shipped narrow-phone geometry, so an unmeasured first paint and every
 * measured repaint keep the same point IDs on the same rows. Real geometry is
 * used only for horizontal edge clearance.
 */
export function packTimelinePoints<TItem extends { at: number; id?: string }>(
  items: readonly TItem[],
  window: TimelineWindow,
  laneWidth: number,
  clearance: number,
  ownershipClearance = TIMELINE_POINT_OWNERSHIP_CLEARANCE,
): PackedTimelinePoints<TItem> {
  const visible = items
    .map((item, index) => ({ item, index, placed: placeTimelinePoint(item.at, window) }))
    .filter((entry) => entry.placed.visible)
    .sort((a, b) => {
      if (a.placed.fraction !== b.placed.fraction) {
        return a.placed.fraction - b.placed.fraction;
      }
      const aId = typeof a.item.id === "string" ? a.item.id : "";
      const bId = typeof b.item.id === "string" ? b.item.id : "";
      return aId < bId ? -1 : aId > bId ? 1 : a.index - b.index;
    });
  const safeWidth = Number.isFinite(laneWidth) && laneWidth > 0 ? laneWidth : 0;
  const safeClearance = Number.isFinite(clearance) && clearance > 0 ? clearance : 0;
  const minimumFraction = safeWidth > 0 ? safeClearance / safeWidth : Number.POSITIVE_INFINITY;
  const edgeInset = safeWidth > 0 ? Math.min(0.5, minimumFraction / 2) : 0;
  const safeOwnershipClearance =
    Number.isFinite(ownershipClearance) && ownershipClearance > 0
      ? ownershipClearance
      : TIMELINE_POINT_OWNERSHIP_CLEARANCE;
  const ownershipFraction = safeOwnershipClearance / TIMELINE_POINT_OWNERSHIP_WIDTH;
  const ownershipInset = ownershipFraction / 2;
  const rowEnds: number[] = [];
  const packed = visible.map((entry) => {
    const fraction = clamp(entry.placed.fraction, edgeInset, 1 - edgeInset);
    const ownedFraction = clamp(
      entry.placed.fraction,
      ownershipInset,
      1 - ownershipInset,
    );
    let row = rowEnds.findIndex(
      (lastFraction) => ownedFraction - lastFraction >= ownershipFraction,
    );
    if (row < 0) {
      row = rowEnds.length;
      rowEnds.push(ownedFraction);
    } else {
      rowEnds[row] = ownedFraction;
    }
    return {
      item: entry.item,
      sourceFraction: entry.placed.fraction,
      fraction,
      row,
    };
  });

  return { items: packed, rowCount: Math.max(1, rowEnds.length) };
}

/** Clip an interval to the visible window. A boundary touch has no drawable width. */
export function clipTimelineInterval(
  from: number,
  to: number,
  window: TimelineWindow,
): TimelineIntervalPlacement | null {
  if (window.span <= 0) return null;
  const clippedFrom = Math.max(window.from, Math.min(from, to));
  const clippedTo = Math.min(window.to, Math.max(from, to));
  if (clippedTo <= clippedFrom) return null;
  return {
    from: clippedFrom,
    to: clippedTo,
    left: (clippedFrom - window.from) / window.span,
    width: (clippedTo - clippedFrom) / window.span,
  };
}
