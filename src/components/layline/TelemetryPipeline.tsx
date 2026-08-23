import styles from "./TelemetryPipeline.module.css";

const BOAT_HUES = ["#3b74ff", "#e4353f", "#e8eef4", "#23282e", "#2fae62", "#ff5d8f"];

export function TelemetryPipeline() {
  return (
    <figure className={styles.figure}>
      <figcaption className={styles.caption}>
        <span className={styles.kicker}>Data flow</span>
        <strong>From samples to frames</strong>
        <span>1 race clock drives playback, overlays, standings, and debrief</span>
      </figcaption>

      <div className={styles.canvas} aria-hidden="true">
        <svg className={styles.diagram} viewBox="0 0 1040 300" role="presentation">
          <path className={styles.mainRail} d="M112 114 H916" />
          <path className={styles.branchRail} d="M640 150 C640 216 720 236 824 236" />

          {BOAT_HUES.map((hue, index) => (
            <circle
              key={hue}
              className={styles.packet}
              cx="112"
              cy={104 + index * 4}
              r="3"
              fill={hue}
              style={{ animationDelay: `${index * 180}ms` }}
            />
          ))}

          <g className={styles.station} transform="translate(32 58)">
            <rect width="160" height="112" />
            <text className={styles.stationIndex} x="16" y="24">01 / 4 HZ</text>
            <text className={styles.stationName} x="16" y="92">TELEMETRY</text>
            <g className={styles.rawFixes}>
              <circle cx="28" cy="49" r="4" />
              <circle cx="56" cy="41" r="4" />
              <circle cx="84" cy="53" r="4" />
              <circle cx="112" cy="38" r="4" />
              <circle cx="140" cy="46" r="4" />
            </g>
          </g>

          <g className={styles.station} transform="translate(280 58)">
            <rect width="160" height="112" />
            <text className={styles.stationIndex} x="16" y="24">02 / SMOOTH</text>
            <text className={styles.stationName} x="16" y="92">INTERPOLATE</text>
            <path className={styles.smoothLine} d="M18 56 C48 26 75 74 103 46 S136 36 142 40" />
          </g>

          <g className={styles.station} transform="translate(560 58)">
            <rect width="160" height="112" />
            <text className={styles.stationIndex} x="16" y="24">03 / 1 CLOCK</text>
            <text className={styles.stationName} x="16" y="92">RACE MODEL</text>
            <circle className={styles.clockRing} cx="80" cy="52" r="22" />
            <path className={styles.clockHand} d="M80 52 V36 M80 52 L92 58" />
          </g>

          <g className={styles.station} transform="translate(832 58)">
            <rect width="176" height="112" />
            <text className={styles.stationIndex} x="16" y="24">04 / EVERY FRAME</text>
            <text className={styles.stationName} x="16" y="92">2D / 3D REPLAY</text>
            <path className={styles.hull} d="M35 56 H136 L118 69 H56 Z" />
            <path className={styles.mast} d="M86 56 V29 L116 56" />
          </g>

          <g className={styles.output} transform="translate(824 210)">
            <rect width="184" height="52" />
            <text x="16" y="21">SAME SOURCE</text>
            <text className={styles.outputName} x="16" y="40">ANALYTICS / DEBRIEF</text>
          </g>
        </svg>
      </div>

      <ol className={styles.mobileFlow} aria-label="Telemetry pipeline">
        <li>
          <span>01 / 4 HZ</span>
          <strong>Telemetry</strong>
          <small>Raw GPS points from every boat</small>
        </li>
        <li>
          <span>02 / SMOOTH</span>
          <strong>Interpolate</strong>
          <small>A stable pose for every frame</small>
        </li>
        <li>
          <span>03 / 1 CLOCK</span>
          <strong>Race model</strong>
          <small>1 source for fleet state</small>
        </li>
        <li>
          <span>04 / EVERY FRAME</span>
          <strong>2D / 3D replay</strong>
          <small>Playback, analytics, and debrief</small>
        </li>
      </ol>
    </figure>
  );
}
