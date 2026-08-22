"use client";

import clsx from "clsx";
import styles from "@/app/layline.module.css";
import type { RigName } from "@/lib/layline/types";
import { useReplay, type PlayRate } from "../store";

const RATES: PlayRate[] = [1, 2, 4];
const RIGS: { name: RigName; label: string }[] = [
  { name: "chase", label: "Chase" },
  { name: "tv", label: "TV" },
  { name: "tactical", label: "Tactical" },
];

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
        aria-label="Step back one fix"
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
        aria-label="Step forward one fix"
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
        aria-label="Raw fixes at 4 Hz"
        aria-pressed={raw}
        data-control="snap"
        onClick={() => setMode(raw ? "smooth" : "raw")}
      >
        <span className={styles.snapLabel}>Raw fixes</span>
        <span className={styles.snapChip}>4 Hz</span>
      </button>

      <span className={styles.transportSpacer} />

      <div className={styles.segGroup} role="group" aria-label="Camera rig">
        {RIGS.map((entry) => (
          <button
            key={entry.name}
            type="button"
            className={clsx(styles.segButton, rig === entry.name && styles.segButtonOn)}
            aria-label={`Camera rig ${entry.label}`}
            aria-pressed={rig === entry.name}
            onClick={() => setRig(entry.name)}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}
