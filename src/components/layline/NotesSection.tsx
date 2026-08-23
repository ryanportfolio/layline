import type { RaceData } from "@/lib/layline/types";
import styles from "@/app/layline.module.css";
import notes from "./NotesSection.module.css";
import { EngineRoom } from "./engine/EngineRoom";
import { TelemetryPipeline } from "./TelemetryPipeline";

export function NotesSection({ race }: { race: RaceData }) {
  const fixCount = race.boats.reduce((total, boat) => total + race.fixes[boat.id].length, 0);
  const duration = Math.round(race.tMax - race.tMin);

  return (
    <section
      className={styles.notes}
      aria-label="Project notes"
      data-leg="Project notes"
    >
      <div className={notes.sectionBlock}>
        <p className={notes.kicker}>Project</p>
        <h2 className={notes.heading}>What I built</h2>
        <p className={notes.lead}>
          A browser race player that turns four telemetry fixes per second into smooth,
          scrubbable fleet motion
        </p>
        <div className={notes.gridThree}>
          <article className={notes.card}>
            <h3>Replay</h3>
            <p>
              Six boats share one clock across 2D and 3D views, camera changes, raw fixes,
              smooth playback, and frame-by-frame scrubbing
            </p>
          </article>
          <article className={notes.card}>
            <h3>Race model</h3>
            <p>
              Wind, marks, laylines, rankings, maneuvers, VMG, speed, heading, and heel come
              from one typed model
            </p>
          </article>
          <article className={notes.card}>
            <h3>Post-race review</h3>
            <p>
              The debrief answers questions from race data and opens the replay at the cited
              moment
            </p>
          </article>
        </div>
        <TelemetryPipeline />
      </div>

      <div className={notes.sectionBlock}>
        <p className={notes.kicker}>Under the hood</p>
        <h2 className={notes.heading}>Performance</h2>
        <p className={notes.lead}>
          Current demo scope is {race.boats.length} boats, {fixCount.toLocaleString("en-US")} fixes,
          and {duration} seconds. Tens of boats and multi-hour recordings are the next benchmark
        </p>
        <div className={notes.gridTwo}>
          <article className={notes.card}>
            <h3>Frame loop</h3>
            <p>
              The replay reuses pose objects instead of creating new ones every frame. Each
              telemetry series remembers its last position during playback and uses binary
              search after a scrub.
            </p>
          </article>
          <article className={notes.card}>
            <h3>GPU work</h3>
            <p>
              Hull colours live in the geometry, so the fleet shares two hull materials. Spray
              and raw fix dots use instancing, sending each type to the GPU in one batch.
            </p>
          </article>
          <article className={notes.card}>
            <h3>Water</h3>
            <p>
              A 27,009-vertex clipmap keeps detail near the camera. A uniform grid over the same
              area would use 1,640,961 vertices.
            </p>
          </article>
          <article className={notes.card}>
            <h3>Laptop and phone</h3>
            <p>
              A frame-time governor watches sustained slow frames and lowers pixel ratio through
              three steps: 1.5, 1.25, and 1. Instrument values touch the DOM only when the shown
              number changes.
            </p>
          </article>
        </div>
        <div className={notes.engineProof}>
          <p className={notes.kicker}>Interactive proof</p>
          <h3 className={notes.labHeading}>Interpolation lab</h3>
          <p className={notes.labLead}>
            One 12-second telemetry window, slowed down across three synchronized views
          </p>
          <EngineRoom embedded />
        </div>
      </div>

      <div className={`${notes.sectionBlock} ${notes.production}`}>
        <p className={notes.kicker}>Next</p>
        <h2 className={notes.heading}>Production path</h2>
        <p className={notes.productionCopy}>
          The prototype uses seeded data so every replay is repeatable. Next: map actual telemetry
          into the race model, test larger fleets and multi-hour recordings, profile target laptops
          and phones, then connect live and stored races to production services.
        </p>
      </div>
    </section>
  );
}
