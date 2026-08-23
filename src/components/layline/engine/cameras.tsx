"use client";

import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { poseAt } from "@/lib/layline/interpolate";
import { FIX_HZ, SIM_HZ } from "@/lib/layline/types";
import type { Fix, Pose } from "@/lib/layline/types";
import {
  BENCH_BOAT,
  TANGENT_SECONDS,
  fmt1,
  fmt2,
  newPose,
  shortArc,
  type Bench,
} from "./benchData";
import { useLabClock } from "./clock";
import styles from "./engine.module.css";

/* Three cameras on one tack. Every static layer prints through fmt1 or fmt2 so
 * the server and the browser agree on the markup; every moving marker waits
 * for the mount flag and then rides the lab clock by direct transform writes.
 */

const DEG = Math.PI / 180;

/* The figure column at 1440 is about 620px wide, so the drawing is built at
 * that width and the scale falls out of the window's own extent. Fixing the
 * scale instead would leave this window drawn at two thirds of the column and
 * then blown up by the browser, doubling every label with it. */
const FIGURE_WIDTH = 620;
const PAD = 32;
const DOT_R = 3.2;

/* A hull pointing along +x, so a plain rotate() by the heading aims it: the
 * projection below puts up-course along +x and across-course down +y. Fourteen
 * units long, and the figure draws 620 units across 626 CSS px, so it lands at
 * about 14px on screen (measured 14.2 by 12.6, up to 18.9 across the diagonal
 * when the heading turns it): the two markers have to be findable in a field
 * of 49 dots, and the metre of lag between them is a shorter distance than the
 * glyph itself, which is what the LAG chip is there to print. */
const HULL = "8.4,0 -5.6,-6.2 -5.6,6.2";

/* Sixty frames a second over four fixes a second: fifteen frames per reading. */
const HELD_MAX = Math.round(60 / FIX_HZ);

interface Frame {
  fixes: Fix[];
  width: number;
  height: number;
  scale: number;
  px(x: number, y: number): [number, number];
}

/* The course axis runs across the page here rather than up it, so a beat
 * segment fits a landscape panel at true proportions. Nothing is stretched:
 * the whole picture is the top-down view turned a quarter turn. */
function segmentFrame(fixes: Fix[]): Frame {
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  const see = (x: number, y: number) => {
    if (x < minAcross) minAcross = x;
    if (x > maxAcross) maxAcross = x;
    if (y < minAlong) minAlong = y;
    if (y > maxAlong) maxAlong = y;
  };
  for (const fix of fixes) {
    see(fix.x, fix.y);
    /* The tangent arrows leave the track at the ends of the window, so the
     * box has to hold where they point as well as where the boat is. */
    const reach = fix.sog * TANGENT_SECONDS;
    see(fix.x + reach * Math.sin(fix.cog * DEG), fix.y + reach * Math.cos(fix.cog * DEG));
  }
  const along = maxAlong - minAlong;
  const scale = along > 0 ? (FIGURE_WIDTH - PAD * 2) / along : 10;
  return {
    fixes,
    width: FIGURE_WIDTH,
    height: Math.round((maxAcross - minAcross) * scale + PAD * 2),
    scale,
    px: (x, y) => [(y - minAlong) * scale + PAD, (x - minAcross) * scale + PAD],
  };
}

/* Every write here checks what the node already says first. A held clock hands
 * the same pose back sixty times a second, and the browser treats a repeated
 * setAttribute as a real mutation: measured at 140 mutation records over 19
 * frames with the clock stopped and nothing on screen changing. Comparing a
 * short string costs nothing next to that. */
function write(node: Element | null, name: string, value: string): void {
  if (node !== null && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function print(node: HTMLElement | null, value: string): void {
  if (node !== null && node.textContent !== value) node.textContent = value;
}

function place(node: SVGGElement | null, frame: Frame, pose: Pose): void {
  if (node === null) return;
  const [x, y] = frame.px(pose.x, pose.y);
  write(node, "transform", `translate(${fmt1(x)} ${fmt1(y)}) rotate(${fmt1(pose.hdg)})`);
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
        vectorEffect="non-scaling-stroke"
      />
      <polygon
        points={`${frame.width - PAD},${y} ${frame.width - PAD - 9},${y - 4} ${frame.width - PAD - 9},${y + 4}`}
        fill="currentColor"
        opacity={0.4}
      />
      <text x={PAD} y={y - 8} className={styles.figureLabel}>
        Toward the windward mark
      </text>
    </g>
  );
}

function Chip({
  label,
  value,
  unit,
  labelRef,
  valueRef,
}: {
  label: string;
  value: string;
  unit?: string;
  labelRef?: RefObject<HTMLSpanElement | null>;
  valueRef?: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className={styles.chip}>
      <span className={styles.chipLabel} ref={labelRef}>
        {label}
      </span>
      <span className={styles.chipValue} ref={valueRef}>
        {value}
      </span>
      {unit === undefined ? null : <span className={styles.chipUnit}>{unit}</span>}
    </div>
  );
}

function PanelHead({ tag, bench }: { tag: string; bench: Bench }) {
  return (
    <div className={styles.panelHead}>
      <p className={clsx(styles.railLabel, styles.railLabelLive)}>{tag}</p>
      <p className={styles.identityChip}>
        <span className={styles.identitySwatch} aria-hidden="true" />
        {bench.boat.sail} · {bench.boat.name}
      </p>
    </div>
  );
}

function Panel({ tag, bench, children }: { tag: string; bench: Bench; children: ReactNode }) {
  return (
    <div className={styles.panel}>
      <PanelHead tag={tag} bench={bench} />
      <div className={styles.panelBody}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CAM 01: the raw feed                                                */

export function CameraOne() {
  const clock = useLabClock();
  const { race, bench, mounted, reduced } = clock;
  const frame = useMemo(() => segmentFrame(bench.window.fixes), [bench]);
  const dots = useRef<Array<SVGCircleElement | null>>([]);
  const rawRef = useRef<SVGGElement | null>(null);
  const smoothRef = useRef<SVGGElement | null>(null);
  const heldRef = useRef<HTMLSpanElement | null>(null);
  const lagValueRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const rawPose = newPose();
    const smoothPose = newPose();
    const windowFixes = bench.window.fixes;
    let shownIndex = -2;
    let heldFrames = 0;
    const paint = (i: number, past: boolean) => {
      const dot = dots.current[i];
      if (dot !== null && dot !== undefined) dot.style.opacity = past ? "1" : "0.35";
    };
    return clock.subscribe((t) => {
      let index = 0;
      while (index + 1 < windowFixes.length && windowFixes[index + 1].t <= t) index += 1;
      const stepped = index !== shownIndex;
      if (!stepped) {
        if (heldFrames < HELD_MAX) heldFrames += 1;
      } else {
        /* Only the dots between the old reading and the new one change side,
           so a step costs one style write rather than forty-nine. The full
           pass runs on the first frame and after a seek that jumps back. */
        if (shownIndex < -1) {
          for (let i = 0; i < dots.current.length; i += 1) paint(i, i <= index);
        } else if (index > shownIndex) {
          for (let i = shownIndex + 1; i <= index; i += 1) paint(i, true);
        } else {
          for (let i = shownIndex; i > index; i -= 1) paint(i, false);
        }
        shownIndex = index;
        heldFrames = 0;
      }
      poseAt(race, BENCH_BOAT, t, "raw", rawPose);
      poseAt(race, BENCH_BOAT, t, "smooth", smoothPose);
      place(rawRef.current, frame, rawPose);
      place(smoothRef.current, frame, smoothPose);
      /* Held counts frames and lag measures the distance the hold opens up, so
         both are readings of what happens between two fixes and both are
         recomputed on every one of those frames. Neither reaches the node
         unless the printed string moved: held stops at fifteen and lag stops
         with the clock. */
      print(heldRef.current, `${heldFrames}/${HELD_MAX}`);
      print(
        lagValueRef.current,
        fmt2(Math.hypot(rawPose.x - smoothPose.x, rawPose.y - smoothPose.y)),
      );
    });
  }, [clock, race, bench, frame]);

  return (
    <Panel tag={`Cam 01 · the raw feed`} bench={bench}>
      <div>
        <h3 className={styles.camHeading}>Four fixes a second</h3>
        <p className={styles.camBody}>
          Raw fixes arrive every {(1000 / FIX_HZ).toFixed(0)} ms; violet holds each reading while
          the race model fills the frames between them
        </p>
        <div className={clsx(styles.chipGrid, styles.chipGridReserved)}>
          <Chip label="Fixes" value={`${bench.window.fixes.length}`} />
          <Chip label="Max gap" value={fmt2(bench.gaps.max)} unit="m" />
          {/* A frame counter has nothing to count when the clock is parked, so
              it waits for the mount and never reaches the server markup: a
              reduced-motion viewer sees the grid it keeps. */}
          {mounted && !reduced ? (
            <Chip label="Held" value={`0/${HELD_MAX}`} valueRef={heldRef} />
          ) : null}
          <Chip label="Lag" value={fmt2(0)} unit="m" valueRef={lagValueRef} />
        </div>
      </div>

      <figure className={styles.figure}>
        <svg
          className={styles.figureSvg}
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          width={frame.width}
          height={frame.height}
          role="img"
          aria-label={`${frame.fixes.length} fixes from ${bench.boat.sail} over ${bench.window.span} seconds of the beat, drawn as separate dots with the held boat and the interpolated boat on top`}
        >
          <CourseArrow frame={frame} />
          {frame.fixes.map((fix, index) => {
            const [cx, cy] = frame.px(fix.x, fix.y);
            return (
              <circle
                key={fix.t}
                ref={(node) => {
                  dots.current[index] = node;
                }}
                className={styles.fixDot}
                cx={fmt1(cx)}
                cy={fmt1(cy)}
                r={DOT_R}
                opacity={index === 0 ? 1 : 0.35}
              />
            );
          })}
          {mounted ? (
            <>
              <g ref={rawRef}>
                <polygon className={styles.hullRaw} points={HULL} />
              </g>
              <g ref={smoothRef}>
                <polygon className={styles.hullSmooth} points={HULL} />
              </g>
            </>
          ) : null}
        </svg>
        <figcaption className={styles.caption}>
          Raw feed and interpolated pose on one clock
        </figcaption>
      </figure>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* CAM 02: the curve                                                   */

const TIP_WIDTH = 208;
const TIP_HEIGHT = 22;

export function CameraTwo() {
  const clock = useLabClock();
  const { race, bench, mounted } = clock;
  const frame = useMemo(() => segmentFrame(bench.window.fixes), [bench]);
  const opening = useMemo(
    () => poseAt(race, BENCH_BOAT, bench.window.from, "smooth", newPose()),
    [race, bench],
  );
  const [hover, setHover] = useState<number | null>(null);
  const trackerRef = useRef<SVGGElement | null>(null);
  const arrowRef = useRef<SVGPathElement | null>(null);
  const cogRef = useRef<HTMLSpanElement | null>(null);

  const curve = useMemo(() => {
    const pose = newPose();
    const steps = Math.round(bench.window.span * SIM_HZ);
    let d = "";
    for (let i = 0; i <= steps; i += 1) {
      poseAt(race, BENCH_BOAT, bench.window.from + i / SIM_HZ, "smooth", pose);
      const [x, y] = frame.px(pose.x, pose.y);
      d += `${i === 0 ? "M" : "L"}${fmt1(x)} ${fmt1(y)}`;
    }
    return d;
  }, [race, bench, frame]);

  useEffect(() => {
    const pose = newPose();
    let shownFix = Number.NaN;
    return clock.subscribe((t) => {
      poseAt(race, BENCH_BOAT, t, "smooth", pose);
      place(trackerRef.current, frame, pose);
      /* The arrow points where the tracker points, because it rides the same
         transform. Its length is half a second of reported speed, and speed is
         reported four times a second, so the length steps with the chips that
         print it rather than every frame. */
      const fix = Math.round(t * FIX_HZ);
      if (fix === shownFix) return;
      shownFix = fix;
      /* Shaft and head in one path, so the arrow costs one node instead of
         two. */
      const reach = pose.sog * TANGENT_SECONDS * frame.scale;
      if (arrowRef.current !== null) {
        arrowRef.current.setAttribute(
          "d",
          `M0 0H${fmt1(reach)}M${fmt1(reach)} 0L${fmt1(reach - 9)} -4L${fmt1(reach - 9)} 4Z`,
        );
      }
      if (cogRef.current !== null) cogRef.current.textContent = fmt1(pose.cog);
    });
  }, [clock, race, bench, frame]);

  const tangentOf = useCallback(
    (fix: Fix) => {
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
      return {
        x0,
        y0,
        x1,
        y1,
        head: `${fmt1(x1)},${fmt1(y1)} ${fmt1(x1 - 9 * ux + 4 * uy)},${fmt1(y1 - 9 * uy - 4 * ux)} ${fmt1(x1 - 9 * ux - 4 * uy)},${fmt1(y1 - 9 * uy + 4 * ux)}`,
      };
    },
    [frame],
  );

  const hovered = hover === null ? null : frame.fixes[hover];

  return (
    <Panel tag="Cam 02 · the curve" bench={bench}>
      <div>
        <h3 className={styles.camHeading}>Between the fixes</h3>
        <p className={styles.camBody}>
          Speed and course set each curve tangent, keeping the path and turn honest between fixes
        </p>
        <div className={styles.chipGrid}>
          <Chip label="Segments" value={`${frame.fixes.length - 1}`} />
          <Chip label="Curve" value={`${SIM_HZ}`} unit="hz" />
          <Chip label="Chord" value={fmt2(bench.drift)} unit="m" />
          <Chip label="COG" value={fmt1(opening.cog)} unit="deg" valueRef={cogRef} />
        </div>
      </div>

      <figure className={styles.figure}>
        <svg
          className={styles.figureSvg}
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          width={frame.width}
          height={frame.height}
          role="img"
          aria-label="The same fixes with the interpolated curve through them and the reported velocity at each fix drawn as an arrow"
        >
          <CourseArrow frame={frame} />
          <path className={styles.curve} d={curve} vectorEffect="non-scaling-stroke" />
          {frame.fixes
            .filter((_, index) => index % 4 === 0)
            .map((fix) => {
              const t = tangentOf(fix);
              return (
                <g key={fix.t} className={styles.tangent}>
                  <line
                    x1={fmt1(t.x0)}
                    y1={fmt1(t.y0)}
                    x2={fmt1(t.x1)}
                    y2={fmt1(t.y1)}
                    vectorEffect="non-scaling-stroke"
                  />
                  <polygon points={t.head} stroke="none" />
                </g>
              );
            })}
          {hovered === null ? null : (
            <g className={clsx(styles.tangent, styles.tangentLive)}>
              <line
                x1={fmt1(tangentOf(hovered).x0)}
                y1={fmt1(tangentOf(hovered).y0)}
                x2={fmt1(tangentOf(hovered).x1)}
                y2={fmt1(tangentOf(hovered).y1)}
                vectorEffect="non-scaling-stroke"
              />
              <polygon points={tangentOf(hovered).head} stroke="none" />
            </g>
          )}
          {frame.fixes.map((fix) => {
            const [cx, cy] = frame.px(fix.x, fix.y);
            return <circle key={fix.t} className={styles.fixDot} cx={fmt1(cx)} cy={fmt1(cy)} r={DOT_R} />;
          })}
          {mounted ? (
            <g ref={trackerRef}>
              <path
                ref={arrowRef}
                className={styles.trackerArrow}
                d="M0 0"
                vectorEffect="non-scaling-stroke"
              />
              <polygon className={styles.hullSmooth} points={HULL} />
            </g>
          ) : null}
          {hovered === null ? null : (
            <TipPlate frame={frame} fix={hovered} />
          )}
          {frame.fixes.map((fix, index) => {
            const [cx, cy] = frame.px(fix.x, fix.y);
            return (
              <circle
                key={fix.t}
                className={styles.hitDot}
                cx={fmt1(cx)}
                cy={fmt1(cy)}
                r={10}
                onPointerEnter={() => setHover(index)}
                onPointerLeave={() => setHover(null)}
                onClick={() => {
                  setHover(index);
                  clock.seek(fix.t);
                }}
              />
            );
          })}
        </svg>
        <figcaption className={styles.caption}>
          Amber arrows show the reported velocity at each fix
        </figcaption>
      </figure>
    </Panel>
  );
}

function TipPlate({ frame, fix }: { frame: Frame; fix: Fix }) {
  const [cx, cy] = frame.px(fix.x, fix.y);
  const x = Math.min(Math.max(4, cx - TIP_WIDTH / 2), frame.width - TIP_WIDTH - 4);
  const y = cy - 16 - TIP_HEIGHT < 4 ? cy + 16 : cy - 16 - TIP_HEIGHT;
  return (
    <g>
      <rect className={styles.tipPlate} x={fmt1(x)} y={fmt1(y)} width={TIP_WIDTH} height={TIP_HEIGHT} />
      <text className={styles.tipText} x={fmt1(x + 8)} y={fmt1(y + 15)}>
        T+{fmt2(fix.t)} · SOG {fmt2(fix.sog)} · COG {fmt1(fix.cog)}
      </text>
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* CAM 03: the compass                                                 */

const COMPASS = 300;
const COMPASS_C = COMPASS / 2;
const COMPASS_R = 104;
const HOME_MS = 300;

/* The two arcs are the argument this figure makes, so they are drawn for as
 * long as the figure is on screen rather than for the one second in twelve the
 * clock spends inside the pair. The short one rides just inside the ring, the
 * long one sits well in: concentric with the dial they read as a second ring,
 * and at these radii they read as two different measurements of one turn. */
const ARC_SHORT_R = COMPASS_R * 0.92;
const ARC_LONG_R = COMPASS_R * 0.55;

function onCircle(r: number, heading: number): [number, number] {
  return [COMPASS_C + r * Math.sin(heading * DEG), COMPASS_C - r * Math.cos(heading * DEG)];
}

/** An arc of `delta` degrees from `from`, signed the way the boat turned. */
function arcSweep(r: number, from: number, delta: number): string {
  const [x0, y0] = onCircle(r, from);
  const [x1, y1] = onCircle(r, from + delta);
  const large = Math.abs(delta) > 180 ? 1 : 0;
  const sweep = delta >= 0 ? 1 : 0;
  return `M${fmt1(x0)} ${fmt1(y0)} A${fmt1(r)} ${fmt1(r)} 0 ${large} ${sweep} ${fmt1(x1)} ${fmt1(y1)}`;
}

export function CameraThree() {
  const clock = useLabClock();
  const { race, bench, mounted, reduced } = clock;
  const { a, b, plain, short } = bench.pair;
  /* The wrong way round: the plain-number lerp takes the complement of the
   * short arc, which is the whole of the argument this figure makes. */
  const longDelta = short > 0 ? short - 360 : short + 360;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const needleRef = useRef<SVGGElement | null>(null);
  const ghostRef = useRef<SVGGElement | null>(null);
  const payoffRef = useRef<SVGGElement | null>(null);
  const hdgRef = useRef<HTMLSpanElement | null>(null);
  const hdgLabelRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const homeRef = useRef<{ from: number; start: number } | null>(null);
  const clockHdgRef = useRef(a.hdg);

  const writeNeedle = useCallback((heading: number) => {
    write(needleRef.current, "transform", `rotate(${fmt1(heading)} ${COMPASS_C} ${COMPASS_C})`);
  }, []);

  /* The chip beside the dial names whichever hand is on the needle. Left alone
   * it prints the clock's heading; picked up it prints where the hand has the
   * needle and relabels itself, so the number and the needle never disagree.
   * Neither write lands unless the string moved. */
  const writeReading = useCallback((label: string, heading: number) => {
    print(hdgLabelRef.current, label);
    /* The return home runs the short way and can take the needle past 360 or
       under 0 on its way. The dial does not mind; a heading of -25 printed in
       a chip would. */
    print(hdgRef.current, fmt1(((heading % 360) + 360) % 360));
  }, []);

  useEffect(() => {
    const pose = newPose();
    let shownPayoff = "";
    return clock.subscribe((t) => {
      poseAt(race, BENCH_BOAT, t, "smooth", pose);
      clockHdgRef.current = pose.hdg;

      const drag = dragRef.current;
      let heading = pose.hdg;
      if (drag !== null) {
        heading = drag;
      } else if (homeRef.current !== null) {
        const u = Math.min(1, (clock.frameNow() - homeRef.current.start) / HOME_MS);
        /* A smoothstep standing in for var(--ease): the release always comes
         * home the short way, which is wrapSigned felt in the hand. */
        const eased = u * u * (3 - 2 * u);
        heading = homeRef.current.from + shortArc(homeRef.current.from, pose.hdg) * eased;
        if (u >= 1) homeRef.current = null;
      }
      writeNeedle(heading);

      /* The chip names the needle, so it is written on the same frames the
         needle is: a chip stepping on the fix grid beside a needle tracking
         every frame would print a heading up to ten degrees off the hand
         through the tack. */
      writeReading(drag !== null ? "Drag" : "HDG", heading);

      const u = (t - a.t) / (b.t - a.t);
      const inside = u >= 0 && u <= 1;
      const state = inside ? "1" : "0";
      if (state !== shownPayoff) {
        shownPayoff = state;
        if (payoffRef.current !== null) payoffRef.current.style.opacity = state;
      }
      if (inside) {
        write(
          ghostRef.current,
          "transform",
          `rotate(${fmt1(a.hdg + (b.hdg - a.hdg) * u)} ${COMPASS_C} ${COMPASS_C})`,
        );
      }
    });
  }, [clock, race, a, b, writeNeedle, writeReading]);

  const angleFrom = useCallback((event: ReactPointerEvent<SVGElement>) => {
    const node = svgRef.current;
    if (node === null) return 0;
    const box = node.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    return (Math.atan2(dx, -dy) / DEG + 360) % 360;
  }, []);

  const [crossX, crossY] = onCircle(ARC_LONG_R, a.hdg + longDelta / 2);
  /* Each value sits off the arc it names: on the arc itself the amber label
     printed over its own 4px stroke. */
  const [shortLabelX, shortLabelY] = onCircle(ARC_SHORT_R - 26, a.hdg + short / 2);
  const [longLabelX, longLabelY] = onCircle(ARC_LONG_R + 26, a.hdg + longDelta / 2);

  return (
    <Panel tag="Cam 03 · the compass" bench={bench}>
      <div>
        <h3 className={styles.camHeading}>Heading is a circle</h3>
        <p className={styles.camBody}>
          Angles take the shortest path across north, with a turn-rate cap to reject impossible
          spins
        </p>
        <div className={styles.chipGrid}>
          <Chip label="Fix A" value={fmt1(a.hdg)} unit="deg" />
          <Chip label="Fix B" value={fmt1(b.hdg)} unit="deg" />
          <Chip label="Plain" value={fmt1(plain)} unit="deg" />
          <Chip label="Short" value={fmt1(Math.abs(short))} unit="deg" />
        </div>
      </div>

      <figure className={styles.figure}>
        <svg
          ref={svgRef}
          className={clsx(styles.figureSvg, styles.figureCompass)}
          viewBox={`0 0 ${COMPASS} ${COMPASS}`}
          width={COMPASS}
          height={COMPASS}
          role="img"
          aria-label={`A compass circle with two headings, ${fmt1(a.hdg)} and ${fmt1(b.hdg)} degrees: the short way between them crosses zero, the long way round is crossed out`}
        >
          <circle
            className={styles.compassRing}
            cx={COMPASS_C}
            cy={COMPASS_C}
            r={COMPASS_R}
            vectorEffect="non-scaling-stroke"
          />
          {[0, 90, 180, 270].map((tick) => {
            const [x0, y0] = onCircle(COMPASS_R, tick);
            const [x1, y1] = onCircle(COMPASS_R - 9, tick);
            return (
              <line
                key={tick}
                x1={fmt1(x0)}
                y1={fmt1(y0)}
                x2={fmt1(x1)}
                y2={fmt1(y1)}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.5}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          <text x={COMPASS_C} y={22} textAnchor="middle" className={styles.figureLabel}>
            000
          </text>

          {/* Both arcs are static layers: the lesson is on the dial whatever
              the clock is doing, and only the ghost needle that animates the
              wrong-way spin waits for its second. */}
          <path
            className={styles.arcLong}
            d={arcSweep(ARC_LONG_R, a.hdg, longDelta)}
            vectorEffect="non-scaling-stroke"
          />
          <line
            className={styles.stamp}
            x1={fmt1(crossX - 11)}
            y1={fmt1(crossY - 11)}
            x2={fmt1(crossX + 11)}
            y2={fmt1(crossY + 11)}
            vectorEffect="non-scaling-stroke"
          />
          <line
            className={styles.stamp}
            x1={fmt1(crossX - 11)}
            y1={fmt1(crossY + 11)}
            x2={fmt1(crossX + 11)}
            y2={fmt1(crossY - 11)}
            vectorEffect="non-scaling-stroke"
          />
          <path
            className={styles.arcShort}
            d={arcSweep(ARC_SHORT_R, a.hdg, short)}
            vectorEffect="non-scaling-stroke"
          />

          {mounted ? (
            <g ref={payoffRef} className={styles.payoff}>
              <g ref={ghostRef}>
                <line
                  className={styles.needleGhost}
                  x1={COMPASS_C}
                  y1={fmt1(COMPASS_C - COMPASS_R * 0.3)}
                  x2={COMPASS_C}
                  y2={fmt1(COMPASS_C - COMPASS_R)}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            </g>
          ) : null}

          {mounted ? (
            <g ref={needleRef}>
              <line
                className={styles.needle}
                x1={COMPASS_C}
                y1={COMPASS_C}
                x2={COMPASS_C}
                y2={COMPASS_C - COMPASS_R}
                vectorEffect="non-scaling-stroke"
              />
              <circle className={styles.needleHub} cx={COMPASS_C} cy={COMPASS_C} r={4} />
              <line
                className={styles.needleGrip}
                x1={COMPASS_C}
                y1={COMPASS_C}
                x2={COMPASS_C}
                y2={COMPASS_C - COMPASS_R}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  clock.setRunning(false);
                  homeRef.current = null;
                  dragRef.current = angleFrom(event);
                  /* Reduced motion runs no loop, so the hand writes the needle
                     and its reading itself and the release is a cut. */
                  if (reduced) {
                    writeNeedle(dragRef.current);
                    writeReading("Drag", dragRef.current);
                  }
                }}
                onPointerMove={(event) => {
                  if (dragRef.current === null) return;
                  dragRef.current = angleFrom(event);
                  if (reduced) {
                    writeNeedle(dragRef.current);
                    writeReading("Drag", dragRef.current);
                  }
                }}
                onPointerUp={(event) => {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  if (dragRef.current === null) return;
                  if (reduced) {
                    writeNeedle(clockHdgRef.current);
                    writeReading("HDG", clockHdgRef.current);
                  } else {
                    homeRef.current = { from: dragRef.current, start: clock.frameNow() };
                  }
                  dragRef.current = null;
                }}
              />
            </g>
          ) : null}

          <text
            className={styles.figureValue}
            x={fmt1(onCircle(COMPASS_R + 14, a.hdg)[0])}
            y={fmt1(onCircle(COMPASS_R + 14, a.hdg)[1] + 5)}
            textAnchor={Math.sin(a.hdg * DEG) >= 0 ? "start" : "end"}
          >
            {fmt1(a.hdg)}
          </text>
          <text
            className={styles.figureValue}
            x={fmt1(onCircle(COMPASS_R + 14, b.hdg)[0])}
            y={fmt1(onCircle(COMPASS_R + 14, b.hdg)[1] + 5)}
            textAnchor={Math.sin(b.hdg * DEG) >= 0 ? "start" : "end"}
          >
            {fmt1(b.hdg)}
          </text>
          <text
            className={clsx(styles.figureValue, styles.figureValueWind)}
            x={fmt1(shortLabelX)}
            y={fmt1(shortLabelY + 5)}
            textAnchor="middle"
          >
            {fmt1(Math.abs(short))} deg
          </text>
          <text
            className={clsx(styles.figureValue, styles.figureValueDim)}
            x={fmt1(longLabelX)}
            y={fmt1(longLabelY + 5)}
            textAnchor="middle"
          >
            {fmt1(plain)} deg
          </text>
        </svg>
        <p className={styles.hint}>Drag the needle</p>
        <figcaption className={styles.caption}>
          {fmt1(a.hdg)}° to {fmt1(b.hdg)}° is {fmt1(Math.abs(short))}° across north, not {fmt1(plain)}°
          around the compass
        </figcaption>
      </figure>
    </Panel>
  );
}
