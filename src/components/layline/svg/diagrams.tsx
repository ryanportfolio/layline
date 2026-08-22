import { deg } from "@/lib/layline/format";
import { poseAt } from "@/lib/layline/interpolate";
import type { Fix, Pose, RaceData } from "@/lib/layline/types";
import styles from "@/app/layline.module.css";

/* All three drawings are cut from one boat's real feed. NZL 7 tacks inside this
 * window on the way to the windward mark, which is where a fix rate shows: the
 * dots crowd as the boat loses speed through the turn and open out again as it
 * rebuilds. */
const BOAT = "nzl";
const SEG_FROM = 24;
const SEG_TO = 36;
const SCALE = 10; // px per metre
const PAD = 42; // px, enough clear for the tangent arrows to leave the track
const TANGENT_SECONDS = 0.5;
const CURVE_HZ = 20;

/* Two fixes a second apart that happen to straddle the top of the circle. */
const NORTH_A = 29.5;
const NORTH_B = 30.5;

const DEG = Math.PI / 180;

interface Frame {
  fixes: Fix[];
  width: number;
  height: number;
  px: (x: number, y: number) => [number, number];
}

function newPose(): Pose {
  return { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
}

/* The course axis runs across the page here rather than up it, so a beat
 * segment fits a landscape panel at true proportions. Nothing is stretched:
 * the whole picture is the top-down view turned a quarter turn. */
function segmentFrame(race: RaceData): Frame {
  const fixes = race.fixes[BOAT].filter((fix) => fix.t >= SEG_FROM && fix.t <= SEG_TO);
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  for (const fix of fixes) {
    if (fix.x < minAcross) minAcross = fix.x;
    if (fix.x > maxAcross) maxAcross = fix.x;
    if (fix.y < minAlong) minAlong = fix.y;
    if (fix.y > maxAlong) maxAlong = fix.y;
  }
  return {
    fixes,
    width: Math.round((maxAlong - minAlong) * SCALE + PAD * 2),
    height: Math.round((maxAcross - minAcross) * SCALE + PAD * 2),
    px: (x, y) => [(y - minAlong) * SCALE + PAD, (x - minAcross) * SCALE + PAD],
  };
}

function round(value: number): string {
  return value.toFixed(1);
}

function gapRange(fixes: Fix[]): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (let i = 1; i < fixes.length; i++) {
    const step = Math.hypot(fixes[i].x - fixes[i - 1].x, fixes[i].y - fixes[i - 1].y);
    if (step < min) min = step;
    if (step > max) max = step;
  }
  return { min, max };
}

function CourseArrow({ frame }: { frame: Frame }) {
  const y = frame.height - 14;
  return (
    <g>
      <line
        x1={PAD}
        y1={y}
        x2={frame.width - PAD}
        y2={y}
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.4}
      />
      <polygon
        points={`${frame.width - PAD},${y} ${frame.width - PAD - 9},${y - 4} ${frame.width - PAD - 9},${y + 4}`}
        fill="currentColor"
        opacity={0.4}
      />
      <text x={PAD} y={y - 8} className={styles.diagramLabel}>
        Toward the windward mark
      </text>
    </g>
  );
}

/** Diagram 1: the feed itself, one dot per fix over a twelve second segment. */
export function FixRateDiagram({ race }: { race: RaceData }) {
  const frame = segmentFrame(race);
  const gaps = gapRange(frame.fixes);
  return (
    <figure className={styles.diagramWrap}>
      <svg
        className={styles.diagram}
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        width={frame.width}
        height={frame.height}
        role="img"
        aria-label={`${frame.fixes.length} fixes from NZL 7 over ${SEG_TO - SEG_FROM} seconds of the beat, drawn as separate dots`}
      >
        <CourseArrow frame={frame} />
        {frame.fixes.map((fix) => {
          const [cx, cy] = frame.px(fix.x, fix.y);
          return <circle key={fix.t} cx={round(cx)} cy={round(cy)} r={3.2} fill="var(--raw)" />;
        })}
      </svg>
      <figcaption className={styles.diagramCaption}>
        {frame.fixes.length} fixes, {SEG_TO - SEG_FROM} seconds, nothing drawn between them. The
        dots crowd to {gaps.min.toFixed(1)} m apart where the boat slows through the tack and
        open to {gaps.max.toFixed(1)} m back at speed
      </figcaption>
    </figure>
  );
}

/** Diagram 2: the same dots, plus the curve and the tangents that fill them. */
export function HermiteDiagram({ race }: { race: RaceData }) {
  const frame = segmentFrame(race);
  const pose = newPose();
  let curve = "";
  const steps = (SEG_TO - SEG_FROM) * CURVE_HZ;
  for (let i = 0; i <= steps; i++) {
    poseAt(race, BOAT, SEG_FROM + i / CURVE_HZ, "smooth", pose);
    const [x, y] = frame.px(pose.x, pose.y);
    curve += `${i === 0 ? "M" : "L"}${round(x)} ${round(y)}`;
  }

  const tangents = frame.fixes.filter((_, index) => index % 4 === 0);

  return (
    <figure className={styles.diagramWrap}>
      <svg
        className={styles.diagram}
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        width={frame.width}
        height={frame.height}
        role="img"
        aria-label="The same fixes with the interpolated curve through them and the reported velocity at each fix drawn as an arrow"
      >
        <CourseArrow frame={frame} />
        <path d={curve} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" />
        {tangents.map((fix) => {
          const [x0, y0] = frame.px(fix.x, fix.y);
          const reach = fix.sog * TANGENT_SECONDS;
          const [x1, y1] = frame.px(
            fix.x + reach * Math.sin(fix.cog * DEG),
            fix.y + reach * Math.cos(fix.cog * DEG),
          );
          const dx = x1 - x0;
          const dy = y1 - y0;
          const length = Math.hypot(dx, dy) || 1;
          const ux = dx / length;
          const uy = dy / length;
          const head = `${round(x1)},${round(y1)} ${round(x1 - 9 * ux + 4 * uy)},${round(y1 - 9 * uy - 4 * ux)} ${round(x1 - 9 * ux - 4 * uy)},${round(y1 - 9 * uy + 4 * ux)}`;
          return (
            <g key={fix.t}>
              <line
                x1={round(x0)}
                y1={round(y0)}
                x2={round(x1)}
                y2={round(y1)}
                stroke="var(--wind)"
                strokeWidth={1.6}
              />
              <polygon points={head} fill="var(--wind)" />
            </g>
          );
        })}
        {frame.fixes.map((fix) => {
          const [cx, cy] = frame.px(fix.x, fix.y);
          return <circle key={fix.t} cx={round(cx)} cy={round(cy)} r={3.2} fill="var(--raw)" />;
        })}
      </svg>
      <figcaption className={styles.diagramCaption}>
        The same dots with the cubic Hermite through them. Each amber arrow is half a second of
        the speed and course that fix reported: the tangents the curve leaves on. Neighbor
        differences would round the corner off the tack
      </figcaption>
    </figure>
  );
}

function onCircle(cx: number, cy: number, r: number, heading: number): [number, number] {
  return [cx + r * Math.sin(heading * DEG), cy - r * Math.cos(heading * DEG)];
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number, large: 0 | 1): string {
  const [x0, y0] = onCircle(cx, cy, r, from);
  const [x1, y1] = onCircle(cx, cy, r, to);
  return `M${round(x0)} ${round(y0)} A${r} ${r} 0 ${large} 1 ${round(x1)} ${round(y1)}`;
}

function nearestFix(fixes: Fix[], t: number): Fix {
  let best = fixes[0];
  for (const fix of fixes) {
    if (Math.abs(fix.t - t) < Math.abs(best.t - t)) best = fix;
  }
  return best;
}

/** Diagram 3: why heading has to be interpolated on the circle. */
export function ShortArcDiagram({ race }: { race: RaceData }) {
  const fixes = race.fixes[BOAT];
  const a = nearestFix(fixes, NORTH_A);
  const b = nearestFix(fixes, NORTH_B);
  const short = ((b.hdg - a.hdg + 540) % 360) - 180;
  const long = 360 - Math.abs(short);

  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const r = 104;
  const [ax, ay] = onCircle(cx, cy, r, a.hdg);
  const [bx, by] = onCircle(cx, cy, r, b.hdg);
  const [ax0, ay0] = onCircle(cx, cy, r * 0.3, a.hdg);
  const [bx0, by0] = onCircle(cx, cy, r * 0.3, b.hdg);
  const [crossX, crossY] = onCircle(cx, cy, r * 0.84, a.hdg + short / 2 + 180);

  return (
    <figure className={styles.diagramWrap}>
      <svg
        className={`${styles.diagram} ${styles.diagramCompass}`}
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={`A compass circle with two headings, ${deg(a.hdg)} and ${deg(b.hdg)} degrees: the short way between them crosses zero, the long way round is crossed out`}
      >
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeWidth={1} opacity={0.5} />
        {[0, 90, 180, 270].map((tick) => {
          const [x0, y0] = onCircle(cx, cy, r, tick);
          const [x1, y1] = onCircle(cx, cy, r - 9, tick);
          return (
            <line
              key={tick}
              x1={round(x0)}
              y1={round(y0)}
              x2={round(x1)}
              y2={round(y1)}
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.5}
            />
          );
        })}
        <text x={cx} y={22} textAnchor="middle" className={styles.diagramLabel}>
          000
        </text>

        <path
          d={arcPath(cx, cy, r * 0.84, b.hdg, a.hdg, 1)}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeDasharray="6 6"
          opacity={0.6}
        />
        <line
          x1={round(crossX - 11)}
          y1={round(crossY - 11)}
          x2={round(crossX + 11)}
          y2={round(crossY + 11)}
          stroke="var(--ink-dim)"
          strokeWidth={2.4}
        />
        <line
          x1={round(crossX - 11)}
          y1={round(crossY + 11)}
          x2={round(crossX + 11)}
          y2={round(crossY - 11)}
          stroke="var(--ink-dim)"
          strokeWidth={2.4}
        />

        <path
          d={arcPath(cx, cy, r * 0.62, a.hdg, b.hdg, 0)}
          fill="none"
          stroke="var(--wind)"
          strokeWidth={3}
        />
        <line
          x1={round(ax0)}
          y1={round(ay0)}
          x2={round(ax)}
          y2={round(ay)}
          stroke="var(--ink)"
          strokeWidth={1.6}
        />
        <line
          x1={round(bx0)}
          y1={round(by0)}
          x2={round(bx)}
          y2={round(by)}
          stroke="var(--ink)"
          strokeWidth={1.6}
        />

        <text x={round(ax)} y={round(ay - 8)} textAnchor="end" className={styles.diagramValue}>
          {deg(a.hdg)}
        </text>
        <text x={round(bx + 6)} y={round(by - 8)} className={styles.diagramValue}>
          {deg(b.hdg)}
        </text>
        <text x={cx + 12} y={round(cy - r * 0.62 - 10)} className={styles.diagramValue}>
          {deg(Math.abs(short))} deg
        </text>
        <text
          x={cx - 30}
          y={round(cy + r * 0.84 + 5)}
          textAnchor="end"
          className={styles.diagramValue}
        >
          {deg(long)} deg
        </text>
      </svg>
      <figcaption className={styles.diagramCaption}>
        One second of NZL 7 through the top of the circle: {deg(a.hdg)} degrees, then{" "}
        {deg(b.hdg)}. As plain numbers those are {deg(long)} degrees apart and the boat spins the
        wrong way through south. Round the circle they are {deg(Math.abs(short))}, the turn that
        happened
      </figcaption>
    </figure>
  );
}
