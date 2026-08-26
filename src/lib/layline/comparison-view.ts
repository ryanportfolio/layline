import {
  type BoundaryFactsStatus,
  type RangeComparison,
} from "./comparison";
import { MISSING, fixStamp, knots, signedMeters, signedMetersPerSecond } from "./format";
import type { RaceData } from "./types";

export interface ComparisonMetricView {
  id: "start" | "end" | "gain" | "vmg" | "distance" | "maneuvers";
  label: string;
  value: string;
  unit: string;
}

export interface ComparisonEquationTerm {
  id: "straight" | "maneuver" | "residual";
  label: string;
  value: string;
}

/** The ground-progress equation as its terms, so the panel can rule them into
 *  rows instead of setting one mono sentence that wraps mid-value. */
export interface ComparisonEquationView {
  totalLabel: string;
  total: string;
  terms: ComparisonEquationTerm[];
}

export interface ComparisonViewModel {
  primaryLabel: string;
  referenceLabel: string;
  referenceMembershipLabel: string;
  signConvention: string;
  rangeLabel: string;
  status: RangeComparison["status"];
  witness: string;
  metrics: ComparisonMetricView[];
  equation: ComparisonEquationView | null;
  componentEquation: string;
  componentProvenance: string;
  maneuverObservations: string[];
  maneuverCostWitness: string;
}

function boatLabel(race: RaceData, boatId: string): string {
  const boat = race.boats.find((entry) => entry.id === boatId);
  return boat === undefined ? boatId : `${boat.sail} (${boat.id})`;
}

function cohortLabel(race: RaceData, boatIds: readonly string[]): string {
  return boatIds.length === 0
    ? "none"
    : boatIds.map((boatId) => boatLabel(race, boatId)).join(", ");
}

function decimalCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MISSING;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function finiteNumber(value: number | null): value is number {
  return Number.isFinite(value);
}

function unavailableBoundaryText(reason: BoundaryFactsStatus): string {
  if (reason === "missing-bracket") return "exact boundary progress telemetry is missing";
  if (reason === "invalid-sample") return "exact boundary progress telemetry is invalid";
  if (reason === "missing-and-invalid") {
    return "exact boundary progress telemetry is missing for one or more required boats and invalid for another";
  }
  if (reason === "invalid-arithmetic") return "derived boundary arithmetic is invalid";
  return "exact boundary progress telemetry did not produce complete boundary facts";
}

function coverageWitness(result: RangeComparison): string {
  if (result.status === "invalid-request") {
    return `Comparison unavailable: ${result.invalidReason ?? "invalid request"}.`;
  }
  if (result.status === "missing-boundary-data") {
    return `Comparison unavailable: ${unavailableBoundaryText(result.boundaryFactsStatus)}.`;
  }
  if (result.status === "insufficient-fleet-coverage") {
    return `Comparison unavailable: ${result.invalidReason ?? "fewer than two fleet boats have complete component coverage"}.`;
  }
  if (result.status === "zero-duration") {
    const boundaryFactsAvailable =
      result.boundaryFactsStatus === "available" &&
      finiteNumber(result.startAdvantageMeters) &&
      finiteNumber(result.endAdvantageMeters) &&
      finiteNumber(result.progressGainedMeters);
    return boundaryFactsAvailable
      ? "Zero-duration range. Boundary advantage and zero gain are shown; ground-track rates and attribution are unavailable."
      : `Zero-duration range. Boundary facts are unavailable because ${unavailableBoundaryText(result.boundaryFactsStatus)}; ground-track rates and attribution are unavailable.`;
  }
  if (result.status === "invalid-arithmetic") {
    return `Comparison unavailable: ground-track arithmetic is invalid. ${result.coverage.coverageSeconds.toFixed(2)} s of shared ground-referenced racing telemetry remains identified; invalid facts are not shown.`;
  }

  const excluded = result.coverage.excludedByReasonSeconds;
  const excludedText = [
    excluded.prestartOrFinished > 0
      ? `${excluded.prestartOrFinished.toFixed(2)} s prestart or finished`
      : null,
    excluded.missingBracket > 0
      ? `${excluded.missingBracket.toFixed(2)} s missing telemetry bracket`
      : null,
    excluded.invalidSample > 0
      ? `${excluded.invalidSample.toFixed(2)} s invalid telemetry`
      : null,
    excluded.invalidArithmetic > 0
      ? `${excluded.invalidArithmetic.toFixed(2)} s invalid telemetry-derived arithmetic`
      : null,
  ].filter((part): part is string => part !== null);

  if (result.status === "no-racing-coverage") {
    return `No shared ground-referenced racing coverage${excludedText.length > 0 ? `: ${excludedText.join(", ")}` : ""}.`;
  }
  return `${result.coverage.coverageSeconds.toFixed(2)} s shared ground-referenced racing coverage${excludedText.length > 0 ? `; excluded ${excludedText.join(", ")}` : ""}.`;
}

/* Null rather than an apology sentence when a term is missing: the panel draws
 * the block or it draws nothing. Terms rather than prose because the sentence
 * this replaced ran past the panel's column and broke mid-value, leaving a
 * bare "m" on a line of its own. */
function equationOf(result: RangeComparison): ComparisonEquationView | null {
  if (
    !finiteNumber(result.progressGainedMeters) ||
    !finiteNumber(result.straightDeltaMeters) ||
    !finiteNumber(result.maneuverWindowDeltaMeters) ||
    !finiteNumber(result.residualMeters)
  ) {
    return null;
  }
  return {
    totalLabel: "Gained",
    total: `${signedMeters(result.progressGainedMeters)} m`,
    terms: [
      {
        id: "straight",
        label: "Straight sailing",
        value: `${signedMeters(result.straightDeltaMeters)} m`,
      },
      {
        id: "maneuver",
        label: "Detected maneuver windows",
        value: `${signedMeters(result.maneuverWindowDeltaMeters)} m`,
      },
      {
        id: "residual",
        label: "Residual",
        value: `${signedMeters(result.residualMeters)} m`,
      },
    ],
  };
}

function componentEquationOf(result: RangeComparison): string {
  if (
    !finiteNumber(result.progressGainedMeters) ||
    !finiteNumber(result.waterDeltaMeters) ||
    !finiteNumber(result.currentDeltaMeters) ||
    !finiteNumber(result.componentResidualMeters)
  ) return "Water/current equation unavailable for this range.";
  return `${signedMeters(result.progressGainedMeters)} m gained = ${signedMeters(result.waterDeltaMeters)} m water made good + ${signedMeters(result.currentDeltaMeters)} m current made good + ${signedMeters(result.componentResidualMeters)} m residual.`;
}

/** Deterministic display adapter. All comparison arithmetic stays in compareRange. */
export function comparisonViewModel(
  race: RaceData,
  result: RangeComparison,
): ComparisonViewModel {
  const primaryLabel = boatLabel(race, result.primaryBoatId);
  const referenceLabel =
    result.reference.kind === "boat" && result.reference.boatId !== null
      ? `Named rival: ${boatLabel(race, result.reference.boatId)}.`
      : `Reference: fixed fleet median (${result.reference.eligibleCohortIds.includes(result.primaryBoatId) ? "selected boat included" : "selected boat excluded"}).`;
  const referenceMembershipLabel =
    result.reference.kind === "boat"
      ? `Eligible rival: ${cohortLabel(race, result.reference.eligibleCohortIds)}.`
      : `Requested cohort: ${cohortLabel(race, result.reference.requestedCohortIds)}. Eligible cohort: ${cohortLabel(race, result.reference.eligibleCohortIds)}.${result.reference.ineligibleCohortIds.length > 0 ? ` Ineligible: ${cohortLabel(race, result.reference.ineligibleCohortIds)}.` : ""}`;
  const primaryManeuvers = result.primary?.maneuverCount ?? null;
  const referenceManeuvers = result.referenceFacts?.maneuverCount ?? null;
  const counted = result.primary?.maneuvers.filter((maneuver) => maneuver.countedInRange) ?? [];

  return {
    primaryLabel,
    referenceLabel,
    referenceMembershipLabel,
    signConvention:
      "Positive advantage means the selected boat is ahead. Positive gain means the selected boat improved over this range.",
    rangeLabel: `${fixStamp(result.range.from)} to ${fixStamp(result.range.to)}`,
    status: result.status,
    witness: coverageWitness(result),
    metrics: [
      {
        id: "start",
        label: "Ground-reference start advantage",
        value: finiteNumber(result.startAdvantageMeters) ? signedMeters(result.startAdvantageMeters) : MISSING,
        unit: "m",
      },
      {
        id: "end",
        label: "Ground-reference end advantage",
        value: finiteNumber(result.endAdvantageMeters) ? signedMeters(result.endAdvantageMeters) : MISSING,
        unit: "m",
      },
      {
        id: "gain",
        label: "Ground-reference progress gained/lost",
        value: finiteNumber(result.progressGainedMeters) ? signedMeters(result.progressGainedMeters) : MISSING,
        unit: "m",
      },
      {
        id: "vmg",
        label: "Ground-reference mean VMG difference",
        value: finiteNumber(result.groundVmgDeltaMps) ? signedMetersPerSecond(result.groundVmgDeltaMps) : MISSING,
        unit: "m/s",
      },
      {
        id: "distance",
        label: "Ground-track sailed-distance difference",
        value: finiteNumber(result.sailedDistanceDeltaMeters) ? signedMeters(result.sailedDistanceDeltaMeters) : MISSING,
        unit: "m",
      },
      {
        id: "maneuvers",
        label: "Detected maneuvers, primary/reference",
        value: `${decimalCount(primaryManeuvers)} / ${decimalCount(referenceManeuvers)}`,
        unit: "count",
      },
    ],
    equation: equationOf(result),
    componentEquation: componentEquationOf(result),
    componentProvenance:
      "Water and current use reconstructed fix components. Ground is derived from their exact component sum. Current contribution is descriptive, not a tactical cause.",
    maneuverObservations: counted.map(
      (maneuver) =>
        `${fixStamp(maneuver.t)} ${maneuver.kind}: ${finiteNumber(maneuver.lossMps) ? knots(maneuver.lossMps) : MISSING} kn observed speed drop versus the fastest reading in the prior 4 s.`,
    ),
    maneuverCostWitness:
      "Maneuver cost unavailable. Recorded telemetry has no counterfactual path.",
  };
}
