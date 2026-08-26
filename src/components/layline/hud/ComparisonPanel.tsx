"use client";

import clsx from "clsx";
import styles from "@/app/layline.module.css";
import { comparisonRangeEvidence } from "@/lib/layline/analysis-workspace-ui";
import type { RangeComparison } from "@/lib/layline/comparison";
import { comparisonViewModel } from "@/lib/layline/comparison-view";
import { MISSING } from "@/lib/layline/format";
import type { RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";

export function ComparisonPanel({
  race,
  comparison,
}: {
  race: RaceData;
  comparison: RangeComparison;
}) {
  const analysis = useReplay((state) => state.analysis);
  const view = comparisonViewModel(race, comparison);
  const rangeEvidence = comparisonRangeEvidence(comparison);
  const primary = race.boats.find((boat) => boat.id === comparison.primaryBoatId);
  const referenceValue =
    analysis.reference.kind === "boat" ? analysis.reference.boatId : "fleet-median";

  const seekRangeEdge = (edge: "in" | "out") => {
    const replay = useReplay.getState();
    replay.seek(rangeEvidence[edge].seekTo);
  };

  /* One number leads: ground progress gained over the exact range. The rest
   * of the facts read as support, and a metric with no value leaves the panel
   * instead of holding a dash cell. MISSING is the bare "-", so the test is
   * against whole value segments, never substring: "-0.1" is a reading. */
  const metricUnavailable = (value: string) =>
    value.split(" / ").some((part) => part.trim() === MISSING);
  const leadMetric = view.metrics.find((metric) => metric.id === "gain");
  const leadAvailable = leadMetric !== undefined && !metricUnavailable(leadMetric.value);
  const supportMetrics = view.metrics.filter(
    (metric) => metric.id !== "gain" && !metricUnavailable(metric.value),
  );

  return (
    <section
      className={styles.comparisonPanel}
      aria-labelledby="range-comparison-heading"
      data-comparison-status={view.status}
    >
      <div className={styles.comparisonHeader}>
        <div>
          <h2 id="range-comparison-heading" className={styles.comparisonTitle}>
            Ground-reference comparison
          </h2>
          {/* Whose numbers these are, read as a boat rather than as a sentence:
              the standings chip in the boat's own hue, then the sail. The line
              that told the reader they could pick another primary is gone; the
              standings and the water are where that happens and both already
              say so. */}
          <p className={styles.comparisonPrimary}>
            <span className={styles.comparisonPrimaryLabel}>Primary</span>
            {primary === undefined ? null : (
              <span
                className={clsx(styles.standingChip, primary.dark === true && styles.chipOutlined)}
                style={{ background: primary.hue }}
                aria-hidden="true"
              />
            )}
            <strong>{primary?.sail ?? comparison.primaryBoatId}</strong>
          </p>
        </div>
        <label className={styles.referenceField}>
          <span>Rival / ground reference</span>
          <select
            value={referenceValue}
            onChange={(event) => {
              const value = event.currentTarget.value;
              useReplay.getState().setAnalysis({
                type: "set-reference",
                reference:
                  value === "fleet-median"
                    ? { kind: "fleet-median", boatIds: race.boats.map((boat) => boat.id) }
                    : { kind: "boat", boatId: value },
              });
            }}
          >
            <option value="fleet-median">Fleet median, fixed full fleet</option>
            {race.boats
              .filter((boat) => boat.id !== comparison.primaryBoatId)
              .map((boat) => (
                <option key={boat.id} value={boat.id}>
                  {boat.sail}
                </option>
              ))}
          </select>
        </label>
      </div>

      {leadAvailable ? (
        <div className={styles.comparisonLead} data-metric="gain">
          <span className={styles.comparisonLeadLabel}>{leadMetric.label}</span>
          <strong className={styles.comparisonLeadValue}>
            {leadMetric.value} <span>{leadMetric.unit}</span>
          </strong>
        </div>
      ) : null}

      {/* One range control: mark the edges off the playhead, reset to the
          whole race, and seek either recorded edge. */}
      <div className={styles.comparisonRangeRow} role="group" aria-label="Exact replay range">
        <span className={styles.comparisonRangeLabel}>Exact replay range</span>
        <output className={styles.comparisonRangeValue}>{rangeEvidence.rangeLabel}</output>
        <div className={styles.comparisonRangeControl}>
          <button
            type="button"
            className={styles.rangeButton}
            onClick={() =>
              useReplay.getState().setAnalysis({
                type: "set-range-in",
                at: useReplay.getState().t,
              })
            }
          >
            Set IN
          </button>
          <button
            type="button"
            className={styles.rangeButton}
            onClick={() =>
              useReplay.getState().setAnalysis({
                type: "set-range-out",
                at: useReplay.getState().t,
              })
            }
          >
            Set OUT
          </button>
          <button
            type="button"
            className={styles.rangeButton}
            onClick={() => useReplay.getState().setAnalysis({ type: "reset-range" })}
          >
            Whole race
          </button>
          <span className={styles.comparisonRangeDivider} aria-hidden="true" />
          <button type="button" className={styles.rangeButton} onClick={() => seekRangeEdge("in")}>
            {rangeEvidence.in.label}
          </button>
          <button type="button" className={styles.rangeButton} onClick={() => seekRangeEdge("out")}>
            {rangeEvidence.out.label}
          </button>
        </div>
      </div>

      {supportMetrics.length === 0 ? null : (
        <dl className={styles.comparisonMetrics}>
          {supportMetrics.map((metric) => (
            <div key={metric.id} className={styles.comparisonMetric} data-metric={metric.id}>
              <dt>{metric.label}</dt>
              <dd>
                {metric.value} <span>{metric.unit}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className={styles.comparisonProof}>
        <p className={styles.comparisonWitness} role="status">
          {view.witness}
        </p>
        {view.equation === null ? null : (
          <dl className={styles.comparisonEquation} aria-label="Ground-progress attribution">
            {view.equation.terms.map((term) => (
              <div key={term.id} className={styles.comparisonTerm} data-term={term.id}>
                <dt>{term.label}</dt>
                <dd>{term.value}</dd>
              </div>
            ))}
            <div className={styles.comparisonTermSum} data-term="gained">
              <dt>{view.equation.totalLabel}</dt>
              <dd>{view.equation.total}</dd>
            </div>
          </dl>
        )}
        <details className={styles.comparisonObservations}>
          <summary>Method and reference cohort</summary>
          <p>{view.referenceLabel}</p>
          <p>{view.referenceMembershipLabel}</p>
          <p>{view.signConvention}</p>
          <p>{view.componentProvenance}</p>
        </details>
        {view.maneuverObservations.length === 0 ? (
          <p className={styles.comparisonObservation}>No selected-boat maneuver observed in this exact range.</p>
        ) : (
          <details className={styles.comparisonObservations}>
            <summary>{view.maneuverObservations.length} telemetry-supported maneuver observations</summary>
            <ul>
              {view.maneuverObservations.map((observation) => (
                <li key={observation}>{observation}</li>
              ))}
            </ul>
            <p className={styles.comparisonCost}>{view.maneuverCostWitness}</p>
          </details>
        )}
      </div>
    </section>
  );
}
