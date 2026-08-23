"use client";

import clsx from "clsx";
import styles from "@/app/layline.module.css";
import type { RigName } from "@/lib/layline/types";
import { requestSceneFrame } from "../scene/gate";
import {
  clamp,
  freeform,
  zoom,
  PITCH_MAX,
  PITCH_MIN,
  type FrameTarget,
} from "../scene/interaction";
import { useReplay, type PlayRate } from "../store";

const RATES: PlayRate[] = [1, 2, 4];
const RIGS: { name: RigName; label: string }[] = [
  { name: "chase", label: "Chase" },
  { name: "tv", label: "TV" },
  { name: "tactical", label: "Tactical" },
  { name: "freeform", label: "Freeform" },
];

/* The four things worth pointing a camera at on a windward leeward course, and
 * what each is called to a screen reader. Short on the button because the row
 * they sit in already wraps on a phone. */
const FRAMES: { target: FrameTarget; label: string; described: string }[] = [
  { target: "fleet", label: "Fleet", described: "Frame the whole fleet" },
  { target: "selected", label: "Boat", described: "Frame the followed boat" },
  { target: "start", label: "Start", described: "Frame the start line" },
  { target: "windward", label: "Mark", described: "Frame the windward mark" },
];

/* Degrees a key press turns the camera, and the share of the range one press
 * of the zoom keys spends. Big enough to get somewhere, small enough to aim. */
const KEY_YAW = 0.09;
const KEY_PITCH = 0.06;
const KEY_ZOOM = 90;

/* The keys the camera group answers to. Anything else, including tab and the
 * space that presses the button under the finger, is left to the browser. */
const CAMERA_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "+",
  "=",
  "-",
  "_",
]);

/* Every camera action a hand can ask for, in one place, so the pointer and the
 * keyboard cannot drift apart. Each of them takes the camera by hand, which is
 * what the freeform rig means. */
function frameOn(target: FrameTarget): void {
  const replay = useReplay.getState();
  freeform.pending = target;
  if (replay.rig !== "freeform") replay.setRig("freeform");
  requestSceneFrame();
}

/* Back to the rig the replay opens on. The freeform state is left where it is
 * on purpose: it is re-seeded from the shot on screen every time the camera is
 * taken by hand again, and clearing it here would make the hand-over leave from
 * a picture nobody was looking at. */
function resetView(): void {
  const replay = useReplay.getState();
  if (replay.rig !== "tv") replay.setRig("tv");
  requestSceneFrame();
}

function StepIcon({ forward }: { forward: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={styles.playIcon} aria-hidden="true">
      {forward ? (
        <g>
          <polygon points="3,3 10,8 3,13" />
          <rect x="11" y="3" width="2" height="10" />
        </g>
      ) : (
        <g>
          <rect x="3" y="3" width="2" height="10" />
          <polygon points="13,3 6,8 13,13" />
        </g>
      )}
    </svg>
  );
}

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={styles.playIcon} aria-hidden="true">
      {playing ? (
        <g>
          <rect x="4" y="3" width="3" height="10" />
          <rect x="9" y="3" width="3" height="10" />
        </g>
      ) : (
        <polygon points="4,3 13,8 4,13" />
      )}
    </svg>
  );
}

export function Transport() {
  const playing = useReplay((state) => state.playing);
  const rate = useReplay((state) => state.rate);
  const mode = useReplay((state) => state.mode);
  const rig = useReplay((state) => state.rig);
  const chart2d = useReplay((state) => state.chart2d);
  const setChart2d = useReplay((state) => state.setChart2d);
  const toggle = useReplay((state) => state.toggle);
  const step = useReplay((state) => state.step);
  const setRate = useReplay((state) => state.setRate);
  const setMode = useReplay((state) => state.setMode);
  const setRig = useReplay((state) => state.setRig);
  const raw = mode === "raw";

  return (
    <div className={styles.transportRow}>
      {/* One fix either way: the smallest unit of truth in the feed, and the
          step the raw lens is built to inspect. */}
      <button
        type="button"
        className={styles.playButton}
        aria-label="Step back 1 sample"
        data-control="step-back"
        onClick={() => step(-1)}
      >
        <StepIcon forward={false} />
      </button>

      <button
        type="button"
        className={styles.playButton}
        aria-label={playing ? "Pause" : "Play"}
        aria-pressed={playing}
        onClick={() => toggle()}
      >
        <PlayIcon playing={playing} />
      </button>

      <button
        type="button"
        className={styles.playButton}
        aria-label="Step forward 1 sample"
        data-control="step-forward"
        onClick={() => step(1)}
      >
        <StepIcon forward />
      </button>

      <div className={styles.segGroup} role="group" aria-label="Playback rate">
        {RATES.map((value) => (
          <button
            key={value}
            type="button"
            className={clsx(styles.segButton, rate === value && styles.segButtonOn)}
            aria-label={`Playback rate ${value}x`}
            aria-pressed={rate === value}
            onClick={() => setRate(value)}
          >
            {value}x
          </button>
        ))}
      </div>

      {/* The lens, and the one control on the page allowed to be loud: it swaps
          interpolated motion for the fixes underneath it. */}
      <button
        type="button"
        className={clsx(styles.snapButton, raw && styles.snapButtonOn)}
        aria-label="Raw samples at 4 Hz"
        aria-pressed={raw}
        data-control="snap"
        onClick={() => setMode(raw ? "smooth" : "raw")}
      >
        <span className={styles.snapLabel}>Raw samples</span>
        <span className={styles.snapChip}>4 Hz</span>
      </button>

      <span className={styles.transportSpacer} />

      {/* The chart was only ever the no-WebGL stand-in. It is a way of looking
          at the race in its own right, so it gets a control beside the rigs and
          keeps the clock the scene was running on. */}
      <div className={clsx(styles.segGroup, styles.viewGroup)}>
        <button
          type="button"
          className={clsx(styles.segButton, styles.viewButton, chart2d && styles.segButtonOn)}
          aria-label="Top down chart view"
          aria-pressed={chart2d}
          data-control="chart2d"
          onClick={() => setChart2d(!chart2d)}
        >
          2D
        </button>
      </div>

      {chart2d ? (
        <button
          type="button"
          className={styles.return3dButton}
          aria-label="Return to 3D camera views"
          data-control="return-3d"
          onClick={() => setChart2d(false)}
        >
          Switch to 3D
        </button>
      ) : (
        <>
          <div className={clsx(styles.segGroup, styles.viewGroup)} role="group" aria-label="Camera rig">
            {RIGS.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className={clsx(styles.segButton, styles.viewButton, rig === entry.name && styles.segButtonOn)}
                aria-label={`Camera rig ${entry.label}`}
                aria-pressed={rig === entry.name}
                onClick={() => setRig(entry.name)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {/* The camera's keyboard, and the only one it has. The canvas holds no
              focus and offers no key of its own, so everything a drag can do to
              the camera is reachable from here: the arrows orbit, the plus and
              minus keys work the range, and each button below frames something
              the course is actually made of. */}
          <div
            className={clsx(styles.segGroup, styles.cameraGroup)}
            role="group"
            aria-label="Camera"
            data-control="camera"
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              if (!CAMERA_KEYS.has(event.key)) return;
              event.preventDefault();
              /* The first press takes the camera, and the frame after it seeds
                 the rig from the shot on screen. Turning as well would be a
                 turn away from a picture the seed is about to overwrite, so the
                 press that enters the mode only enters it. */
              if (rig !== "freeform") {
                setRig("freeform");
                requestSceneFrame();
                return;
              }
              let handled = true;
              if (event.key === "ArrowLeft") freeform.yaw += KEY_YAW;
              else if (event.key === "ArrowRight") freeform.yaw -= KEY_YAW;
              else if (event.key === "ArrowUp")
                freeform.pitch = clamp(freeform.pitch + KEY_PITCH, PITCH_MIN, PITCH_MAX);
              else if (event.key === "ArrowDown")
                freeform.pitch = clamp(freeform.pitch - KEY_PITCH, PITCH_MIN, PITCH_MAX);
              else if (event.key === "+" || event.key === "=") zoom(freeform, -KEY_ZOOM);
              else if (event.key === "-" || event.key === "_") zoom(freeform, KEY_ZOOM);
              else handled = false;
              if (!handled) return;
              freeform.left = 0;
              requestSceneFrame();
            }}
          >
            <button
              type="button"
              className={clsx(styles.segButton, styles.viewButton)}
              aria-label="Reset view"
              data-control="reset-view"
              onClick={resetView}
            >
              Reset view
            </button>
            {FRAMES.map((entry) => (
              <button
                key={entry.target}
                type="button"
                className={clsx(styles.segButton, styles.viewButton)}
                aria-label={entry.described}
                data-control={`frame-${entry.target}`}
                onClick={() => frameOn(entry.target)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
