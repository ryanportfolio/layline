import styles from "@/app/layline.module.css";
import { CURRENT_FIELD_INK } from "@/lib/layline/surfaces";
import { FIX_HZ, type RaceData } from "@/lib/layline/types";
import key from "./SceneKey.module.css";

/**
 * What the water is drawn in, named. The console's own contract is one meaning
 * per value, and a reader who cannot see the mapping is looking at decoration:
 * the amber lines, the cyan darts and the coloured strips are each a measured
 * thing, and none of them says so on screen.
 *
 * Server rendered, off the same seeded race the console builds, so the chips
 * below are the fleet's own hues rather than a designer's guess at them, and
 * the key costs the console nothing at frame time.
 *
 * The swatches are drawn rather than described: each one is the same geometry
 * and the same value the scene uses, at the alpha the scene fades it to, so the
 * key cannot drift into claiming a picture the water does not paint.
 */

/* The fades the sea lines are drawn at, from scene/course.ts. Stated as a
 * colour mix rather than an opacity, because the composited value is what a
 * reader is being asked to match against the water. */
const LAYLINE_FADE = 66;
const RUNG_FADE = 34;
const ZONE_FADE = 36;
const START_FADE = 88;

/* MARK_SKIN from scene/marks.ts, restated rather than imported: that module
 * builds geometry and pulls three with it, and this one renders on the server.
 * The cyan next door travels as an export because its module is plain data. */
const MARK_SKIN = "#f4632a";

function mix(colour: string, percent: number): string {
  return `color-mix(in srgb, ${colour} ${percent}%, transparent)`;
}

function Track({ hue }: { hue: string }) {
  return (
    <svg className={key.swatch} viewBox="0 0 56 16" aria-hidden="true" focusable="false">
      {/* The trail behind a hull, which is a strip of water with the boat's own
          colour on it. */}
      <path d="M2 12.4 C 16 12.4, 26 7.6, 54 4.6" fill="none" stroke={hue} strokeWidth="3" />
    </svg>
  );
}

function Layline() {
  return (
    <svg className={key.swatch} viewBox="0 0 56 16" aria-hidden="true" focusable="false">
      <path d="M2 14 L54 3" fill="none" stroke={mix("var(--wind)", LAYLINE_FADE)} strokeWidth="2" />
      <path d="M2 3 L54 14" fill="none" stroke={mix("var(--wind)", LAYLINE_FADE)} strokeWidth="2" />
    </svg>
  );
}

function Rung() {
  return (
    <svg className={key.swatch} viewBox="0 0 56 16" aria-hidden="true" focusable="false">
      {[3.5, 8, 12.5].map((y) => (
        <path
          key={y}
          d={`M4 ${y} L52 ${y}`}
          fill="none"
          stroke={mix("var(--wind)", RUNG_FADE)}
          strokeWidth="1.6"
        />
      ))}
    </svg>
  );
}

function Zone() {
  return (
    <svg className={key.swatch} viewBox="0 0 56 16" aria-hidden="true" focusable="false">
      <circle
        cx="28"
        cy="8"
        r="7.2"
        fill="none"
        stroke={mix("var(--wind)", ZONE_FADE)}
        strokeWidth="1.8"
      />
      {/* The mark itself keeps its own orange, which is a buoy and not a
          reading. Stated here as the literal the mark geometry is built in. */}
      <circle cx="28" cy="8" r="2.6" fill={MARK_SKIN} />
    </svg>
  );
}

function StartLine() {
  return (
    <svg className={key.swatch} viewBox="0 0 56 16" aria-hidden="true" focusable="false">
      <path
        d="M2 8 L27 8"
        fill="none"
        stroke={mix("var(--wind)", START_FADE)}
        strokeWidth="2.6"
      />
      <path d="M29 8 L54 8" fill="none" stroke="var(--ink)" strokeWidth="2.6" />
    </svg>
  );
}

function CurrentDart() {
  return (
    <svg className={key.swatch} viewBox="0 0 56 16" aria-hidden="true" focusable="false">
      {/* The glyph the field actually draws: a four-sided cone lying flat, so a
          wedge with its tail upstream and its point where the water is going.
          No arrowhead, because the scene has none to match. */}
      <path d="M3 4.2 L3 11.8 L53 8 Z" fill={CURRENT_FIELD_INK} opacity="0.58" />
    </svg>
  );
}

function RawFixes() {
  return (
    <svg className={key.swatch} viewBox="0 0 56 16" aria-hidden="true" focusable="false">
      {[5, 17, 29, 41, 53].map((x, index) => (
        <circle key={x} cx={x} cy={12 - index * 1.6} r="2.1" fill="var(--raw)" />
      ))}
    </svg>
  );
}

export function SceneKey({ race }: { race: RaceData }) {
  const lead = race.boats[0];
  const zone = Math.round(race.course.zoneRadius);

  return (
    <section
      id="scene-key"
      className={styles.notes}
      aria-label="Key to the replay"
      data-leg="Key"
      tabIndex={-1}
    >
      <div className={key.block}>
        <p className={key.kicker}>Key</p>
        <h2 className={key.heading}>Reading the water</h2>
        <p className={key.lead}>
          Amber belongs to the wind, cyan to the water moving under the fleet, violet to raw
          telemetry, and every remaining colour on the sea belongs to a boat
        </p>

        <dl className={key.grid}>
          <div className={key.entry}>
            <dt className={key.term}>
              <span className={key.chips}>
                {race.boats.map((boat) => (
                  <span
                    key={boat.id}
                    className={key.chip}
                    style={{ background: boat.hue }}
                    aria-hidden="true"
                  />
                ))}
              </span>
              <span>Boat colour</span>
            </dt>
            <dd className={key.meaning}>
              One colour a boat, the same on its chip, its label, its trail, its gennaker and its
              hull
            </dd>
          </div>

          <div className={key.entry}>
            <dt className={key.term}>
              <Track hue={lead.hue} />
              <span>Track</span>
            </dt>
            <dd className={key.meaning}>Where a boat has already been, drawn in its own colour</dd>
          </div>

          <div className={key.entry}>
            <dt className={key.term}>
              <Layline />
              <span>Laylines</span>
            </dt>
            <dd className={key.meaning}>
              The two courses that fetch the next mark on the wind blowing right now, so they swing
              when it shifts
            </dd>
          </div>

          <div className={key.entry}>
            <dt className={key.term}>
              <Rung />
              <span>Ladder rungs</span>
            </dt>
            <dd className={key.meaning}>
              Lines of equal gain toward the mark, so a boat crossing one has made distance on the
              boat that has not
            </dd>
          </div>

          <div className={key.entry}>
            <dt className={key.term}>
              <Zone />
              <span>Marks and zone</span>
            </dt>
            <dd className={key.meaning}>
              The orange buoy is the mark, and the ring around it is the{" "}
              <span className={key.figure}>{zone} m</span> zone where the rounding rules start to
              bite
            </dd>
          </div>

          <div className={key.entry}>
            <dt className={key.term}>
              <StartLine />
              <span>Start line</span>
            </dt>
            <dd className={key.meaning}>
              Amber while it is still an instruction, ink from the gun, when it becomes a piece of
              the course
            </dd>
          </div>

          <div className={key.entry}>
            <dt className={key.term}>
              <CurrentDart />
              <span>Current</span>
            </dt>
            <dd className={key.meaning}>
              Each dart points where the water is setting, and the longer it is the harder the
              drift
            </dd>
          </div>

          <div className={key.entry}>
            <dt className={key.term}>
              <RawFixes />
              <span>Raw fixes</span>
            </dt>
            <dd className={key.meaning}>
              The <span className={key.figure}>{FIX_HZ} Hz</span> measured samples everything else
              is rebuilt from, drawn when the raw lens is on
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
