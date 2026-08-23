"use client";

import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3, type PerspectiveCamera } from "three";
import styles from "@/app/layline.module.css";
import { poseAt } from "@/lib/layline/interpolate";
import { FIX_HZ } from "@/lib/layline/types";
import type { Pose, RaceData, ReplayMode, RigName } from "@/lib/layline/types";
import { useReplay } from "../store";
import { requestSceneFrame } from "./gate";
import { SKIFF } from "./skiff";

const DEG = Math.PI / 180;

/* The lens never reads the telemetry the instruments read. A four hertz feed
 * carries real heading wobble, real speed noise and a hull rolling in the
 * swell, and a camera that answers all three is a camera somebody is holding.
 *
 * So every rig is composed from a display pose: a raised-cosine average of the
 * evaluated track taken symmetrically around the instant, which has no lag to
 * catch up from and no stored velocity to inherit. The window is short on
 * position, where the frame has to stay on the boat, and long on heading, trim
 * and speed, where the noise lives. Being a pure function of the clock, a
 * scrubbed second and a played second compose the same shot. */
const SMOOTH = { hold: 1, ease: 2.6, step: 0.1 };

/* Eighteen metres astern, aimed a little below the eye so the horizon sits
 * above centre and the sails stand against sky. The stand-off is an arc rather
 * than a sideways step, so swinging round the boat costs the boat none of the
 * frame.
 *
 * Six boats race in the same water the station stands in, and the frame owes
 * every one of them a hull under its rig. What that costs is not a distance,
 * it is an angle: a waterline d metres out from an eye h metres up sits at
 * h / d below the level of the lens, so the water a station has to buy scales
 * with how high it stands. Climbing to find room therefore spends the room it
 * was climbing for, and the answer is the other way round: the station comes
 * down toward the water, where a hull passing close rides high in the frame
 * instead of sinking under the transport panel. The aim comes down with it, so
 * the horizon never moves while the station does.
 *
 * Height runs out where a hull's track crosses the station itself. Rounding a
 * mark the fleet lies astern on the same arc the stand-off stands on, and a
 * boat parked sixteen metres back has its bearing swept through by a lens that
 * turns with the boat it is following. No eye height reaches that, and neither
 * does the quarter: stepping sideways was measured against the same test and
 * only moved the crossing a second or two later, because the sweep carries on
 * across whatever side the station picks. What is left is the range. The
 * station gives ground along the boat's own axis until the traffic has water
 * around it, and the lens tightens by exactly what the stand-off grew, so the
 * boat being followed holds its place and its size in the frame while the water
 * around it opens. */
const CHASE = {
  back: 18,
  quarter: 24,
  eye: 3.6,
  lead: 11,
  /* How far under the eye the aim rides. */
  drop: 1.2,
  fov: 55,
  fovFast: 58,
  roll: 0.09,
  /* The lowest the station may come: clear of the crests this sea state
   * carries, and no lower. */
  wash: 1,
  /* The water the solve asks for around a hull it is not following. Nearer than
   * this a four point nine metre hull crossing the lens is wider than any
   * framing rule can carry, so the answer is not to compose it but to stand
   * where it does not happen. What the solve gets is whatever the reach below
   * can buy. */
  room: 8.6,
  /* Metres short of that water which count as one deck's worth of claim, so
   * crowding and a deck under the panel are the same number and the worse of
   * the two is the one that moves the station. */
  crowd: 2.5,
  /* How far the stand-off may give ground to find that water. Nine metres is
   * what the crossing at the windward mark costs: the fleet rounds in a queue
   * sixteen metres astern of the boat being followed, and the station has to
   * stand outside all of it. */
  reach: 9,
  /* Seconds either side the traffic is read over, and the same again for the
   * average, so the move starts before the boat arrives and is a lean rather
   * than a swerve. Reading has to reach at least as far as the average or an
   * outer tap could average away the metre the near tap asked for. */
  look: 2.5,
  settle: 2.5,
  step: 0.5,
};

/* A hull rides the swell, and a frame has to hold the trough as well as the
 * crest: the three Gerstner octaves sum to 0.484 m of sag and every hull is set
 * a further 0.03 m into the water. A deck tested at the flat waterline is a
 * deck that sinks under the panel every time the boat goes down a wave. */
const SWELL = 0.52;

/* A hull as the frame sees it: the four deck corners at their lowest, the mast
 * foot and the masthead. */
const DECK: readonly (readonly [number, number, number])[] = [
  [-SKIFF.rack, -SWELL, SKIFF.bow],
  [SKIFF.rack, -SWELL, SKIFF.bow],
  [-SKIFF.rack, -SWELL, SKIFF.transom],
  [SKIFF.rack, -SWELL, SKIFF.transom],
  [0, 0, 0],
  [0, SKIFF.mastTop, SKIFF.mastZ],
];
const DECK_POINTS = DECK.length;

/* Helicopter wide. The bearing is the replay clock and nothing else, save for a
 * bounded turn toward the fleet's beam: strung out down the run they would
 * otherwise be viewed end on, which is the one angle from which six boats fill
 * no width at all and the near one sits under the bottom edge.
 *
 * The aircraft holds the lowest station that still keeps every hull inside the
 * safe rect, and comes down its own sight line as the fleet stretches, because
 * height is what turns a fleet spread fore and aft into a fleet spread top to
 * bottom. */
const TV = {
  floor: 40,
  ceiling: 130,
  /* Height as a share of the radius. Loose enough that it is the frame, not
   * this ratio, that stops the climb. */
  lift: 0.3,
  lowest: 12,
  bearing: 30,
  drift: 0.6,
  swing: 22,
  /* Seconds either side of the instant the beam turn is averaged over. */
  settle: 4,
  step: 0.8,
  fov: 40,
  weight: 0.45,
  sit: 0.6,
  pitchMin: 4,
  /* A backstop only. What actually caps the pitch is the horizon rule below,
   * which at this field of view and this canvas comes out near fifteen and a
   * half degrees. */
  pitchMax: 18,
  passes: 18,
};

/* How much of the frame the fleet may use, measured out from the centre.
 * Tightening to the smallest radius that still satisfies this rect is what makes
 * the boats the subject: the fleet fills the frame until something would leave
 * it. Below is the tighter of the three because the transport panel takes the
 * last thirteen hundredths of the canvas; above is what keeps the horizon inside
 * the top edge, and it gives up whatever the top dock covers.
 *
 * Across is the one that opens, and it opens with distance. A fleet strung line
 * abreast fills the width and almost none of the height, so the width is the
 * only axis left to buy hull scale from, and it is the cheapest to spend: the
 * side docks sit high, the fleet sails low, and nothing on this page occludes
 * the left and right edges the way the transport panel occludes the bottom. So
 * the further out the aircraft has had to go, the nearer those edges the
 * outermost hulls may sit. Close in, where the boats already read, it spends
 * nothing. */
const SAFE = { across: 0.32, wide: 0.46, near: 52, far: 64, below: 0.36, above: 0.4 };

/* The top dock is opaque, so the canvas rows it covers are not frame: a horizon
 * behind it is a horizon nobody sees. Measured off the layout rather than off
 * the stylesheet's numbers, because at the narrow width the dock leaves the
 * canvas and stacks above it, where it covers nothing.
 *
 * The band the horizon keeps below that dock is what a far silhouette needs:
 * the tallest gantry crane on the shore is allowed four percent of frame
 * height, which is thirty-two pixels here, and the rest is sky. */
const SKY_BAND = 48;
/* top: rows the top dock covers. sky: the band the horizon keeps below it.
 * foot: where the transport panel's upper edge crosses the canvas, which is the
 * line a hull is not allowed to sink under. One when the panel covers no
 * canvas, which is what the narrow layout does. */
const head = { top: 0, sky: 0, foot: 1 };

function watchHead(canvas: HTMLCanvasElement): () => void {
  /* Climbing to the stage rather than stepping up one parent: the renderer's
   * own wrapper sits between the canvas and the page. */
  const stage = canvas.closest(`.${styles.stage}`);
  const bar = stage === null ? null : stage.querySelector(`.${styles.dockTop}`);
  const panel = stage === null ? null : stage.querySelector(`.${styles.dockBottom}`);
  const measure = (): void => {
    const frame = canvas.getBoundingClientRect();
    if (frame.height < 1) {
      head.top = 0;
      head.sky = 0;
      head.foot = 1;
      return;
    }
    head.sky = Math.min(SKY_BAND / frame.height, 0.3);
    const covered = bar === null ? 0 : bar.getBoundingClientRect().bottom - frame.top;
    head.top = covered > 0 ? Math.min(covered / frame.height, 0.3) : 0;
    const floor = panel === null ? frame.bottom : panel.getBoundingClientRect().top;
    head.foot = clamp((floor - frame.top) / frame.height, 0.5, 1);
  };
  measure();
  /* Same as the dock band: the framing the rigs aim at moves when a panel
   * does, and nothing in the store says so. */
  const watch = new ResizeObserver(() => {
    measure();
    requestSceneFrame();
  });
  watch.observe(canvas);
  if (bar !== null) watch.observe(bar);
  if (panel !== null) watch.observe(panel);
  return () => {
    watch.disconnect();
    head.top = 0;
    head.sky = 0;
    head.foot = 1;
  };
}

/* Where a world point lands on the canvas, as fractions of the frame, for a
 * lens standing where a candidate shot would stand. Both rigs test their
 * framing through this rather than through metres. */
interface Lens {
  ex: number;
  ey: number;
  ez: number;
  fx: number;
  fy: number;
  fz: number;
  ux: number;
  uy: number;
  uz: number;
  rx: number;
  rz: number;
  tall: number;
  wide: number;
}

function newLens(): Lens {
  return {
    ex: 0,
    ey: 0,
    ez: 0,
    fx: 0,
    fy: 0,
    fz: 1,
    ux: 0,
    uy: 1,
    uz: 0,
    rx: 1,
    rz: 0,
    tall: 1,
    wide: 1,
  };
}

/* The basis three's own lookAt builds: right off the world up, up off the pair,
 * so a shot the camera will take and a shot the solve tested are the same
 * shot. */
function setLens(
  out: Lens,
  ex: number,
  ey: number,
  ez: number,
  fx: number,
  fy: number,
  fz: number,
  fov: number,
  aspect: number,
): void {
  const span = Math.hypot(fx, fy, fz) || 1;
  out.ex = ex;
  out.ey = ey;
  out.ez = ez;
  out.fx = fx / span;
  out.fy = fy / span;
  out.fz = fz / span;
  const flat = Math.hypot(out.fz, out.fx) || 1;
  out.rx = -out.fz / flat;
  out.rz = out.fx / flat;
  out.ux = -out.rz * out.fy;
  out.uy = out.rz * out.fx - out.rx * out.fz;
  out.uz = out.rx * out.fy;
  out.tall = Math.tan(fov * 0.5 * DEG);
  out.wide = out.tall * aspect;
}

const spot = { x: 0, y: 0, depth: 0 };

function screenOf(lens: Lens, x: number, y: number, z: number): void {
  const dx = x - lens.ex;
  const dy = y - lens.ey;
  const dz = z - lens.ez;
  const depth = dx * lens.fx + dy * lens.fy + dz * lens.fz;
  spot.depth = depth;
  if (depth <= 0.2) return;
  spot.x = 0.5 + ((dx * lens.rx + dz * lens.rz) / (depth * lens.wide)) * 0.5;
  spot.y = 0.5 - ((dx * lens.ux + dy * lens.uy + dz * lens.uz) / (depth * lens.tall)) * 0.5;
}

/* Zero below, one above, and flat at both ends: a hull leaving the frame stops
 * asking for room over a span rather than at an instant. */
function ease01(value: number, low: number, high: number): number {
  const k = clamp((value - low) / (high - low), 0, 1);
  return k * k * (3 - 2 * k);
}

/* The six points of one hull, written into a flat buffer at `at`. Heel is
 * carried because a masthead leaning twenty degrees is a different point in the
 * frame from an upright one. */
function hullPoints(
  x: number,
  y: number,
  hdg: number,
  heel: number,
  into: Float64Array,
  at: number,
): void {
  const lean = Math.cos(-heel * DEG);
  const tip = Math.sin(-heel * DEG);
  const turn = -hdg * DEG;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  for (let p = 0; p < DECK_POINTS; p++) {
    const local = DECK[p];
    const sideways = local[0] * lean - local[1] * tip;
    const upright = local[0] * tip + local[1] * lean;
    into[at + p * 3] = x + sideways * cos + local[2] * sin;
    into[at + p * 3 + 1] = upright;
    into[at + p * 3 + 2] = -y - sideways * sin + local[2] * cos;
  }
}

/**
 * The steepest the aircraft may look down. A pitch puts the horizon at
 * 0.5 - tan(pitch) / (2 tan(fov/2)) of the frame, so this is the angle that
 * leaves the stated band of sky between the dock's underside and the horizon.
 * Everything above it is water to the top edge, which is the aquarium floor.
 */
function pitchCeiling(tall: number): number {
  const band = 0.5 - head.top - head.sky;
  if (band <= 0) return TV.pitchMin * DEG;
  /* Floored at the minimum as well as capped at the maximum. A short layout
   * leaves the band positive but small, and a ceiling under the floor inverts
   * every bound written against it: the clamp below would then hand back the
   * near-zero ceiling and drop the aircraft to the water. */
  return clamp(Math.atan(2 * tall * band), TV.pitchMin * DEG, TV.pitchMax * DEG);
}

/* A hundred and sixty metres up, pitched seventy-two degrees rather than
 * straight down. The horizontal stand-off is what makes the pitch. */
const TACTICAL = { height: 160, pitch: 72, fov: 45 };

/* The opening pull-in: wide enough to establish the course, closed to the
 * working station while the fleet is still winding up to the line. */
const INTRO = { radius: 160, seconds: 1.6 };

/* SETTLE. One rig hands over to the next and stops; nothing here loops. */
const BLEND_SECONDS = 1.2;

/** What a rig composes from: the boat as the lens sees it, not as it is. */
interface Display {
  x: number;
  y: number;
  /* The same place on the long window. A wide shot frames a fleet, not a boat,
   * so it may lag a metre and gains a station that stops hunting. */
  wx: number;
  wy: number;
  hdg: number;
  /* Signed windward weight, sine of the true wind angle: which side the sails
   * are not on, and how strongly. */
  lean: number;
  heel: number;
  sog: number;
}

interface Shot {
  ex: number;
  ey: number;
  ez: number;
  ax: number;
  ay: number;
  az: number;
  fov: number;
  roll: number;
}

interface Station {
  yaw: number;
  pitch: number;
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  reach: number;
}

interface Plan {
  from: RigName;
  to: RigName;
  /* Land on the target this frame: a cut, a freeze or a scrub. */
  cut: boolean;
  lastT: number;
  /* Race time the hand-over and the opening pull-in were stamped at. Negative
   * infinity is a move already finished; NaN on the pull-in is one that has not
   * been offered a first frame yet. Both eases are read off the clock from
   * these, so a scrubbed second composes what a played second composed. */
  blendT: number;
  introT: number;
  /* True while the hand-over leaves from a snapshot rather than from a rig: a
   * second rig change inside the window has to start where the picture is, and
   * the picture is a mix of two shots that no single rig composes. */
  held: boolean;
}

function newPose(): Pose {
  return { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
}

function newDisplay(): Display {
  return { x: 0, y: 0, wx: 0, wy: 0, hdg: 0, lean: 0, heel: 0, sog: 0 };
}

function newShot(): Shot {
  return { ex: 0, ey: 0, ez: 0, ax: 0, ay: 0, az: 0, fov: TV.fov, roll: 0 };
}

function newStation(): Station {
  return { yaw: 0, pitch: 0, eyeX: 0, eyeY: 0, eyeZ: 0, reach: 1 };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function shortArc(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/* The hand-over curve: cubic in and out, flat at both ends, which is the same
 * shape the page's other eases carry. Fed a fraction of race time rather than
 * of wall time, so nothing between the clock and the lens can advance while the
 * clock is held. */
function easeInOut(k: number): number {
  if (!(k > 0)) return 0;
  if (k >= 1) return 1;
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(2 - 2 * k, 3) * 0.5;
}

/* Raised cosine: zero at both ends and flat there, so a tap entering or leaving
 * the window adds nothing and the average has no step in it. */
function hann(offset: number, half: number): number {
  if (offset <= -half || offset >= half) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * offset) / half));
}

const tap = newPose();

function displayPose(race: RaceData, boatId: string, t: number, out: Display): void {
  poseAt(race, boatId, t, "smooth", tap);
  const anchor = tap.hdg;
  const steps = Math.round(SMOOTH.ease / SMOOTH.step);
  let holdSum = 0;
  let easeSum = 0;
  let x = 0;
  let y = 0;
  let wx = 0;
  let wy = 0;
  let hdg = 0;
  let lean = 0;
  let heel = 0;
  let sog = 0;
  for (let k = -steps; k <= steps; k++) {
    const offset = k * SMOOTH.step;
    poseAt(race, boatId, t + offset, "smooth", tap);
    const hold = hann(offset, SMOOTH.hold);
    const ease = hann(offset, SMOOTH.ease);
    x += tap.x * hold;
    y += tap.y * hold;
    holdSum += hold;
    wx += tap.x * ease;
    wy += tap.y * ease;
    /* Angles average about the middle tap so a series crossing north takes the
     * short way round. */
    hdg += shortArc(tap.hdg - anchor) * ease;
    lean += Math.sin(tap.twa * DEG) * ease;
    heel += tap.heel * ease;
    sog += tap.sog * ease;
    easeSum += ease;
  }
  out.x = x / holdSum;
  out.y = y / holdSum;
  out.wx = wx / easeSum;
  out.wy = wy / easeSum;
  out.hdg = anchor + hdg / easeSum;
  out.lean = lean / easeSum;
  out.heel = heel / easeSum;
  out.sog = sog / easeSum;
}

/* How long a fix is held for, which is how stale the drawn hull can be. */
const HELD_FIX = 1 / FIX_HZ;

const traffic = newPose();
const LOOK_TAPS = Math.round(CHASE.look / CHASE.step);
const SETTLE_TAPS = Math.round(CHASE.settle / CHASE.step);
const SPAN_TAPS = LOOK_TAPS + SETTLE_TAPS;
const CHASE_TAPS = SPAN_TAPS * 2 + 1;

/** Everything one clearance solve needs, held so no frame allocates. */
interface Clear {
  taps: Display[];
  /* Every other hull's six points, per tap. Two rows a hull, so the stride is
   * fixed and the second row is filled only when the drawn picture needs it. */
  hulls: Float64Array;
  count: number;
  /* Rows actually written this frame. */
  seats: number;
  lens: Lens;
  probe: Shot;
  dip: Float64Array;
  give: Float64Array;
  rise: number;
  back: number;
}

function newClear(count: number): Clear {
  const taps: Display[] = [];
  for (let j = 0; j < CHASE_TAPS; j++) taps.push(newDisplay());
  return {
    taps,
    hulls: new Float64Array(CHASE_TAPS * count * DECK_POINTS * 3),
    count,
    seats: count,
    lens: newLens(),
    probe: newShot(),
    dip: new Float64Array(CHASE_TAPS),
    give: new Float64Array(CHASE_TAPS),
    rise: CHASE.eye,
    back: CHASE.back,
  };
}

/** Where the station stands on the water for one quarter, stand-off and height. */
function chaseStand(
  display: Display,
  swing: number,
  back: number,
  rise: number,
  out: Shot,
): void {
  const rad = display.hdg * DEG;
  const fwdX = Math.sin(rad);
  const fwdZ = -Math.cos(rad);
  /* Course (x, y) onto world (x, -z), so a heading of 0 runs into the screen
   * and this pair points off the boat's port side. */
  const portX = fwdZ;
  const portZ = -fwdX;
  const swept = swing * DEG;
  const arcBack = -Math.cos(swept) * back;
  const arcSide = Math.sin(swept) * back;
  out.ex = display.x + fwdX * arcBack + portX * arcSide;
  out.ey = rise;
  out.ez = -display.y + fwdZ * arcBack + portZ * arcSide;

  /* Lead space grows with the boat: the faster it is running, the more water
   * the frame owes it in front of the bow. */
  const lead = CHASE.lead + display.sog * 0.55;
  out.ax = display.x + fwdX * lead;
  /* The aim rides a fixed distance under the eye, so the station can come down
   * for a passing hull without the horizon moving with it. */
  out.ay = rise - CHASE.drop;
  out.az = -display.y + fwdZ * lead;

  /* A little wider as the boat lights up, which is the one thing a chase camera
   * can do to report speed the numbers are already reporting. Three degrees is
   * all of it: a lens that breathes further than that reads as a zoom nobody
   * asked for and moves every hull in frame while it does it.
   *
   * The stand-off is the exception, and it is not a breath: a station that has
   * given ground carries the lens that holds the followed mast at the share of
   * frame height it had at eighteen metres, which is the whole reason the boats
   * are allowed to be the subject of the frame. Tied to the stand-off it only
   * moves while the station is moving, and the boat being followed does not
   * change size while it does. */
  const wide = CHASE.fov + (CHASE.fovFast - CHASE.fov) * clamp((display.sog - 4) / 6, 0, 1);
  out.fov =
    back <= CHASE.back
      ? wide
      : (2 * Math.atan(Math.tan(wide * 0.5 * DEG) * (CHASE.back / back))) / DEG;
  /* Enough lean to say which tack the boat is on, taken off the smoothed heel
   * so the swell never reaches the horizon line. */
  out.roll = -display.heel * DEG * CHASE.roll;
}

/* The home quarter: the eye stands to windward, the side the sails are not on,
 * because held to one side it lines up with the boom on one tack and the boat
 * comes out a bare pole against empty sky. The sine carries the sign and blends
 * it through head to wind and dead downwind, so a tack or a gybe swings the
 * camera through rather than cutting it. */
function homeQuarter(display: Display): number {
  return -CHASE.quarter * display.lean;
}

function aimProbe(work: Clear, aspect: number): void {
  setLens(
    work.lens,
    work.probe.ex,
    work.probe.ey,
    work.probe.ez,
    work.probe.ax - work.probe.ex,
    work.probe.ay - work.probe.ey,
    work.probe.az - work.probe.ez,
    work.probe.fov,
    aspect,
  );
}

/**
 * How far past its bound the worst hull in frame sits, measured as the viewer
 * sees it: a deck box gone under the transport panel. Zero is a clean frame. A
 * hull leaving the frame or passing the lens gives up its claim over a span
 * rather than at an instant, so the answer is continuous in the clock.
 */
function pastFrame(work: Clear, tap: number): number {
  const hulls = work.hulls;
  const stride = DECK_POINTS * 3;
  let past = 0;
  for (let i = 0; i < work.seats; i++) {
    const at = (tap * work.count + i) * stride;
    screenOf(work.lens, hulls[at + 12], hulls[at + 13], hulls[at + 14]);
    const ahead = ease01(spot.depth, 1, 7);
    if (ahead <= 0) continue;
    let left = 9;
    let right = -9;
    let under = -9;
    for (let p = 0; p < 4; p++) {
      screenOf(work.lens, hulls[at + p * 3], hulls[at + p * 3 + 1], hulls[at + p * 3 + 2]);
      if (spot.depth <= 0.5) continue;
      if (spot.x < left) left = spot.x;
      if (spot.x > right) right = spot.x;
      if (spot.y > under) under = spot.y;
    }
    if (right <= left) continue;
    const inside = Math.min(right, 1.2) - Math.max(left, -0.2);
    const shown = ease01(inside / (right - left), 0, 0.35) * ahead;
    if (shown <= 0) continue;
    const sunk = ((under - head.foot) / 0.12) * shown;
    if (sunk > past) past = sunk;
  }
  return past;
}

/** The station one tap asks for, as a fraction of the way down to the wash. */
function dipAt(work: Clear, tap: number, swing: number, back: number, aspect: number): number {
  const display = work.taps[tap];
  chaseStand(display, swing, back, CHASE.eye, work.probe);
  aimProbe(work, aspect);
  if (pastFrame(work, tap) <= 0) return 0;
  let high = 0;
  let low = 1;
  for (let pass = 0; pass < 8; pass++) {
    const mid = (high + low) * 0.5;
    chaseStand(display, swing, back, CHASE.eye - (CHASE.eye - CHASE.wash) * mid, work.probe);
    aimProbe(work, aspect);
    if (pastFrame(work, tap) > 0) high = mid;
    else low = mid;
  }
  chaseStand(display, swing, back, CHASE.eye - (CHASE.eye - CHASE.wash) * low, work.probe);
  aimProbe(work, aspect);
  return low;
}

/** How close the nearest hull the frame does not follow comes to the probe. */
function nearHull(work: Clear, tap: number): number {
  const hulls = work.hulls;
  const stride = DECK_POINTS * 3;
  let near = Infinity;
  for (let i = 0; i < work.seats; i++) {
    const at = (tap * work.count + i) * stride + 12;
    const span = Math.hypot(
      hulls[at] - work.probe.ex,
      hulls[at + 1] - work.probe.ey,
      hulls[at + 2] - work.probe.ez,
    );
    if (span < near) near = span;
  }
  return near;
}

/**
 * What one candidate stand-off still owes the frame, tested at the wash because
 * that is where the height authority ends. Two claims, whichever is worse: a
 * deck gone under the transport panel, and a hull closer than the lens can
 * carry. The second is what the first cannot see coming, since a hull passing
 * through the station is off both edges before it is under the panel.
 */
function pastStand(work: Clear, tap: number, back: number, aspect: number): number {
  const display = work.taps[tap];
  chaseStand(display, homeQuarter(display), back, CHASE.wash, work.probe);
  aimProbe(work, aspect);
  const crowd = (CHASE.room - nearHull(work, tap)) / CHASE.crowd;
  const sunk = pastFrame(work, tap);
  return sunk > crowd ? sunk : crowd;
}

/* The two spans the demand below is read over, both of them in claims. One
 * claim is a deck a hundred and twenty thousandths of the frame under the
 * transport panel, or a hull two and a half metres inside the water it is owed,
 * which is the same number by construction. Two claims of relief is ground worth
 * all nine metres; a frame two claims past its bound is asking for all nine. */
const GIVE = { relief: 2, whole: 2 };

/**
 * How far back one tap asks the station to stand, as a fraction of the reach.
 * Zero wherever the frame is already clean at the wash, so the stand-off holds
 * its eighteen metres for all but the seconds it is asked for.
 *
 * Two readings multiplied: what the frame is asking for, and how much of that
 * the ground can buy. The first is linear in the claim, because a hull a metre
 * inside its water wants a metre and not nine. The second is the relief between
 * the two ends of the reach, weighed across zero rather than gated at it:
 * ground given against a fleet closing in from every side, which is what a
 * start line is, buys nothing, and the station has to stop asking for it over a
 * span rather than at an instant.
 *
 * Both spans are there because of how the answer is used. It is read every half
 * second and averaged over five, so a demand that switches is not smoothed by
 * the average, it is replayed by it: one cut of the whole reach arrives once per
 * tap for as long as the window is wide, which is nine of them, and the eye
 * teleports a metre and change between two frames every time. A bisection has
 * the same fault in a different place, at the stand-off where the reach only
 * just clears the traffic, which is why the answer is read off the ends rather
 * than searched for between them.
 */
function giveAt(work: Clear, tap: number, aspect: number): number {
  const held = pastStand(work, tap, CHASE.back, aspect);
  if (held <= 0) return 0;
  const fall = held - pastStand(work, tap, CHASE.back + CHASE.reach, aspect);
  return clamp(held / GIVE.whole, 0, 1) * ease01(fall, -GIVE.relief, GIVE.relief);
}

/**
 * Hold the worst reading over the look window, then ease the held series over
 * the settle window. The average window never reaches past the read window, so
 * the worst instant is inside every tap that is averaged and the clearance
 * survives the averaging.
 */
function holdEase(series: Float64Array): number {
  let sum = 0;
  let weight = 0;
  for (let j = -SETTLE_TAPS; j <= SETTLE_TAPS; j++) {
    let up = 0;
    for (let m = j - LOOK_TAPS; m <= j + LOOK_TAPS; m++) {
      const value = series[m + SPAN_TAPS];
      if (value > up) up = value;
    }
    /* Half a tap of slack on the window so the outermost pair carry a weight
     * rather than falling exactly on the zero. */
    const w = hann(j * CHASE.step, CHASE.settle + CHASE.step * 0.5);
    sum += up * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}

/**
 * How far back and how far down the station has come, read off the frame rather
 * than off a distance. Traffic is read from the evaluated track the meshes are
 * drawn on, so what this answers for is what a viewer could measure in the
 * picture. The stand-off is settled first and the whole window shares it: the
 * height is the fine correction and it is solved for the station the shot will
 * actually stand on.
 *
 * SNAP draws held fixes, so the hull a viewer sees there stands anywhere on the
 * quarter second of track behind the smoothed one, and a solve run on the
 * smoothed position alone reports water that picture does not have. In that mode
 * every hull goes in twice, at both ends of the quarter second it can be held
 * over. What does not happen is reading the held pose itself: it steps at four
 * hertz, a station solved off a step steps with it, and the stutter in SNAP
 * belongs to the hull in frame and never to the frame.
 */
function chaseClear(
  race: RaceData,
  boatId: string,
  t: number,
  mode: ReplayMode,
  aspect: number,
  work: Clear,
): void {
  const boats = race.boats;
  const stride = DECK_POINTS * 3;
  const rows = mode === "raw" ? 2 : 1;
  work.seats = (boats.length - 1) * rows;
  for (let j = -SPAN_TAPS; j <= SPAN_TAPS; j++) {
    const tap = j + SPAN_TAPS;
    const at = t + j * CHASE.step;
    displayPose(race, boatId, at, work.taps[tap]);
    let seat = 0;
    for (let i = 0; i < boats.length; i++) {
      if (boats[i].id === boatId) continue;
      for (let held = 0; held < rows; held++) {
        poseAt(race, boats[i].id, at - held * HELD_FIX, "smooth", traffic);
        hullPoints(
          traffic.x,
          traffic.y,
          traffic.hdg,
          traffic.heel,
          work.hulls,
          (tap * work.count + seat) * stride,
        );
        seat++;
      }
    }
  }

  for (let tap = 0; tap < CHASE_TAPS; tap++) work.give[tap] = giveAt(work, tap, aspect);
  work.back = CHASE.back + CHASE.reach * holdEase(work.give);
  for (let tap = 0; tap < CHASE_TAPS; tap++) {
    work.dip[tap] = dipAt(work, tap, homeQuarter(work.taps[tap]), work.back, aspect);
  }
  work.rise = CHASE.eye - (CHASE.eye - CHASE.wash) * holdEase(work.dip);
}

const beam = newPose();

/** The beam turn wanted at one instant, before it is averaged over the window. */
function beamAt(race: RaceData, t: number, sight: number): number {
  const boats = race.boats;
  const count = boats.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < count; i++) {
    poseAt(race, boats[i].id, t, "smooth", beam);
    sx += beam.x;
    sy += beam.y;
    sxx += beam.x * beam.x;
    syy += beam.y * beam.y;
    sxy += beam.x * beam.y;
  }
  const cxx = sxx / count - (sx / count) * (sx / count);
  const cyy = syy / count - (sy / count) * (sy / count);
  const cxy = sxy / count - (sx / count) * (sy / count);
  const spread = cxx + cyy;
  if (spread < 1e-6) return 0;
  const split = Math.hypot(cxx - cyy, 2 * cxy);
  const axis = (Math.atan2(2 * cxy, cxx - cyy) * 0.5) / DEG;
  /* The sight line as a line, folded into the quarter turn either side of the
   * fleet's long axis. */
  let delta = shortArc(sight - axis);
  if (delta > 90) delta -= 180;
  if (delta < -90) delta += 180;
  const want = delta >= 0 ? 90 - delta : -90 - delta;
  /* The weight dies at both ends of the fold, which is what keeps the turn
   * continuous where the nearer beam changes hands. */
  return want * Math.abs(Math.sin(2 * delta * DEG)) * (split / spread);
}

/**
 * How far round the orbit the aircraft has to go to put the fleet on its beam,
 * averaged over four seconds either side. A fleet reforming through a rounding
 * then turns the aircraft over several seconds rather than over one, which is
 * the difference between an aircraft repositioning and an aircraft whipping.
 * Zero when the six of them make a round bunch with no long axis to be
 * broadside to.
 */
function broadsideTurn(race: RaceData, t: number, base: number): number {
  if (race.boats.length < 2) return 0;
  const steps = Math.round(TV.settle / TV.step);
  let sum = 0;
  let weight = 0;
  for (let k = -steps; k <= steps; k++) {
    const offset = k * TV.step;
    const w = hann(offset, TV.settle);
    if (w <= 0) continue;
    sum += beamAt(race, t + offset, base + TV.drift * offset - 90) * w;
    weight += w;
  }
  if (weight <= 0) return 0;
  return clamp(sum / weight, -TV.swing, TV.swing);
}

/**
 * Where the aircraft stands and where it points for one candidate radius, and
 * how far the worst hull is past the safe rect there. One is a clean fit.
 *
 * The rect bounds the box a hull covers, not the point it floats on. A
 * waterline anchor sitting a hundredth inside the floor still puts four metres
 * of deck and two crew under the transport panel, which is the frame the rect
 * was written to prevent.
 */
function surveyWide(
  hulls: Float64Array,
  count: number,
  centreX: number,
  centreZ: number,
  bearing: number,
  radius: number,
  aspect: number,
  lens: Lens,
  out: Station,
): number {
  const swingX = Math.sin(bearing * DEG);
  const swingZ = Math.cos(bearing * DEG);
  const eyeX = centreX + swingX * radius;
  const eyeZ = centreZ + swingZ * radius;
  const tall = Math.tan(TV.fov * 0.5 * DEG);
  /* The rect is the visible canvas, not the whole canvas: its floor stays where
   * the transport panel put it and its ceiling comes down by the top dock. */
  const above = Math.max(0.08, SAFE.above - head.top);
  /* Reading the width allowance off the candidate rather than off the answer
   * keeps the fit one bisection: a looser rect at a longer radius only makes the
   * miss fall away faster, so it is still one crossing to find. */
  const stood = clamp((radius - SAFE.near) / (SAFE.far - SAFE.near), 0, 1);
  const across = SAFE.across + (SAFE.wide - SAFE.across) * stood * stood * (3 - 2 * stood);
  const room = Math.atan(2 * tall * SAFE.below);
  const roof = Math.atan(2 * tall * above);
  const sit = Math.atan((TV.sit - 0.5) * 2 * tall);
  const steepest = pitchCeiling(tall);
  const nominal = -bearing * DEG;
  const stride = DECK_POINTS * 3;

  let azLo = Infinity;
  let azHi = -Infinity;
  let reachLo = Infinity;
  let reachHi = 1;
  for (let i = 0; i < count; i++) {
    const at = i * stride + 12;
    const dx = hulls[at] - eyeX;
    const dz = hulls[at + 2] - eyeZ;
    const reach = Math.max(Math.hypot(dx, dz), 1);
    /* Unwrapped about the nominal look, so a fleet astride the branch cut still
     * has a midpoint. */
    const az = nominal + shortArc((Math.atan2(dx, -dz) - nominal) / DEG) * DEG;
    if (az < azLo) azLo = az;
    if (az > azHi) azHi = az;
    if (reach < reachLo) reachLo = reach;
    if (reach > reachHi) reachHi = reach;
  }
  const yaw = (azLo + azHi) * 0.5;
  /* The aircraft climbs with its own sight line and stops where the near hull's
   * bow, not its anchor, would look down steeper than the frame's bottom edge
   * reaches. Height is what turns a fleet spread fore and aft into a fleet
   * spread top to bottom, so it is spent to that limit and no further. */
  const bows = Math.max(reachLo - SKIFF.transom, 1);
  const eyeY = Math.max(TV.lowest, Math.min(TV.lift * radius, Math.tan(steepest + room) * bows));

  const dropHi = Math.atan2(eyeY, bows);
  const dropLo = Math.atan2(eyeY, reachHi);
  let pitch = (dropLo + dropHi) * 0.5 - sit;
  if (dropHi - pitch > room) pitch = dropHi - room;
  if (pitch - dropLo > roof) pitch = dropLo + roof;
  pitch = clamp(pitch, TV.pitchMin * DEG, steepest);

  out.yaw = yaw;
  out.pitch = pitch;
  out.eyeX = eyeX;
  out.eyeY = eyeY;
  out.eyeZ = eyeZ;
  out.reach = (reachLo + reachHi) * 0.5;

  const lean = Math.cos(pitch);
  setLens(
    lens,
    eyeX,
    eyeY,
    eyeZ,
    Math.sin(yaw) * lean,
    -Math.sin(pitch),
    -Math.cos(yaw) * lean,
    TV.fov,
    aspect,
  );

  /* Each bound holds the part of the hull it was written for. The floor is what
   * the transport panel takes, so the deck corners answer for it. The ceiling is
   * what keeps the horizon inside the top edge, so the waterline answers for it
   * and a masthead is allowed to stand above the fleet. The sides take the whole
   * box, rig included. */
  let past = 0;
  for (let i = 0; i < count; i++) {
    const at = i * stride;
    for (let p = 0; p < DECK_POINTS; p++) {
      screenOf(lens, hulls[at + p * 3], hulls[at + p * 3 + 1], hulls[at + p * 3 + 2]);
      if (spot.depth < 1) return Number.POSITIVE_INFINITY;
      const wander = Math.abs(spot.x - 0.5) / across;
      if (wander > past) past = wander;
      if (p < 4) {
        const sunk = (spot.y - 0.5) / SAFE.below;
        if (sunk > past) past = sunk;
      } else if (p === 4) {
        const risen = (0.5 + head.top - spot.y) / above;
        if (risen > past) past = risen;
      }
    }
  }
  return past;
}

function standToShot(station: Station, out: Shot): void {
  const lean = Math.cos(station.pitch);
  out.ex = station.eyeX;
  out.ey = station.eyeY;
  out.ez = station.eyeZ;
  out.ax = station.eyeX + Math.sin(station.yaw) * lean * station.reach;
  out.ay = station.eyeY - Math.sin(station.pitch) * station.reach;
  out.az = station.eyeZ - Math.cos(station.yaw) * lean * station.reach;
  out.fov = TV.fov;
  out.roll = 0;
}

function shootTactical(display: Display, out: Shot): void {
  const stand = TACTICAL.height / Math.tan(TACTICAL.pitch * DEG);
  out.ex = display.x;
  out.ey = TACTICAL.height;
  out.ez = -display.y + stand;
  out.ax = display.x;
  out.ay = 0;
  out.az = -display.y;
  out.fov = TACTICAL.fov;
  out.roll = 0;
}

function copyShot(from: Shot, out: Shot): void {
  out.ex = from.ex;
  out.ey = from.ey;
  out.ez = from.ez;
  out.ax = from.ax;
  out.ay = from.ay;
  out.az = from.az;
  out.fov = from.fov;
  out.roll = from.roll;
}

function mixShot(a: Shot, b: Shot, k: number, out: Shot): void {
  out.ex = a.ex + (b.ex - a.ex) * k;
  out.ey = a.ey + (b.ey - a.ey) * k;
  out.ez = a.ez + (b.ez - a.ez) * k;
  out.ax = a.ax + (b.ax - a.ax) * k;
  out.ay = a.ay + (b.ay - a.ay) * k;
  out.az = a.az + (b.az - a.az) * k;
  out.fov = a.fov + (b.fov - a.fov) * k;
  out.roll = a.roll + (b.roll - a.roll) * k;
}

/**
 * Three bespoke rigs on one camera, every one of them a pure function of the
 * replay clock. The pair either side of a rig change are evaluated together and
 * mixed over 1.2 s; nothing else between the clock and the lens carries state,
 * so two captures of the same second are the same picture and a scrub lands
 * where playback would have.
 */
export function CameraRigs({ race }: { race: RaceData }) {
  const display = useMemo<Display[]>(() => race.boats.map(newDisplay), [race]);
  const leaving = useMemo(newShot, []);
  const arriving = useMemo(newShot, []);
  const shot = useMemo(newShot, []);
  const station = useMemo(newStation, []);
  const wide = useMemo(newLens, []);
  const fleet = useMemo(
    () => new Float64Array(race.boats.length * DECK_POINTS * 3),
    [race],
  );
  /* Two seats a hull: where it is, and where a held fix can leave it. */
  const clear = useMemo(() => newClear(Math.max(1, (race.boats.length - 1) * 2)), [race]);
  const aim = useMemo(() => new Vector3(), []);
  /* The shot the picture was on when a hand-over was interrupted. */
  const parting = useMemo(newShot, []);
  const move = useMemo<Plan>(
    () => ({
      from: "tv",
      to: "tv",
      cut: true,
      lastT: Number.NaN,
      blendT: Number.NEGATIVE_INFINITY,
      introT: Number.NaN,
      held: false,
    }),
    [],
  );
  const gl = useThree((state) => state.gl);

  /* Where the visible canvas starts, for the rig that has to keep a horizon
   * inside it. */
  useEffect(() => watchHead(gl.domElement), [gl]);

  /* The opening move is the only camera motion this page makes on its own, so
   * it is also the only one a reduced-motion visitor never sees: they open on
   * the working station with the replay held. Which of the two they are is not
   * known here, because the flag is read at the page's own mount and this one
   * runs first, so the stamp waits for the first frame to say whether the
   * replay is running at all. */
  useEffect(() => {
    const replay = useReplay.getState();
    move.from = replay.rig;
    move.to = replay.rig;
    move.cut = true;
    move.held = false;
    move.blendT = Number.NEGATIVE_INFINITY;
    move.introT = Number.NaN;
  }, [move]);

  useEffect(
    () =>
      useReplay.subscribe((state, previous) => {
        /* A freeze ends every move in flight. Both eases are spent out of the
         * replay clock, and a held page has none of it to spend. */
        if (state.frozen && !previous.frozen) {
          move.blendT = Number.NEGATIVE_INFINITY;
          move.introT = Number.NEGATIVE_INFINITY;
          move.held = false;
          move.from = move.to;
          move.cut = true;
          return;
        }
        if (state.followId !== previous.followId) move.cut = true;
        if (state.rig === previous.rig) return;
        /* A hand-over still in flight leaves from the shot on screen. Restarting
         * from the rig it was flying toward is a jump of everything the mix had
         * not travelled yet, and no rig composes that mix, so it is kept. */
        move.held = easeInOut((state.t - move.blendT) / BLEND_SECONDS) < 1;
        if (move.held) copyShot(shot, parting);
        move.from = move.to;
        move.to = state.rig;
        /* Reduced motion cuts, a held page cuts, and so does a replay that is
         * not running: the hand-over is 1.2 s of race time and a stopped clock
         * never spends them, so the rig asked for is the rig shown. */
        if (state.reducedMotion || state.frozen || !state.playing) {
          move.blendT = Number.NEGATIVE_INFINITY;
          move.held = false;
          move.cut = true;
          return;
        }
        move.blendT = state.t;
      }),
    [move, parting, shot],
  );

  useFrame((state) => {
    const replay = useReplay.getState();
    const camera = state.camera as PerspectiveCamera;
    const t = replay.t;
    const count = race.boats.length;

    /* A jump this large is a scrub, not a frame: the hand-over in flight ends
     * on the shot it was travelling toward rather than flying there. Anything
     * shorter stays on the clock and lands where playback would have. */
    if (!Number.isFinite(move.lastT) || Math.abs(t - move.lastT) > 1.5) move.cut = true;
    move.lastT = t;
    let mix = easeInOut((t - move.blendT) / BLEND_SECONDS);
    if ((replay.frozen || move.cut) && mix < 1) {
      move.blendT = Number.NEGATIVE_INFINITY;
      move.held = false;
      move.from = move.to;
      mix = 1;
    }
    move.cut = false;

    /* The pull-in is stamped on the frame that first sees the clock, not on
     * mount: the page seeks to the prestart after this component is up. */
    if (Number.isNaN(move.introT)) {
      move.introT = replay.playing ? t : Number.NEGATIVE_INFINITY;
    }
    const opening = easeInOut((t - move.introT) / INTRO.seconds);
    /* Finished is finished: scrubbing back over the opening second does not put
     * the aircraft back out at a hundred and sixty metres. */
    if (opening >= 1) move.introT = Number.NEGATIVE_INFINITY;

    let followIndex = 0;
    for (let i = 0; i < count; i++) if (race.boats[i].id === replay.followId) followIndex = i;

    const aspect = camera.aspect;
    const handing = mix < 1 && !move.held;
    const wideWanted = move.to === "tv" || (handing && move.from === "tv");
    const chaseWanted = move.to === "chase" || (handing && move.from === "chase");

    /* The lens is an operator, not an instrument. The SNAP lens steps the
     * telemetry at four hertz and the boats step with it; the camera keeps
     * reading the interpolated track, so the stutter belongs to the hull in
     * frame and never to the frame itself. Only the wide shot needs the other
     * five: a boat nobody is framing costs fifty evaluations to place. */
    if (wideWanted) {
      for (let i = 0; i < count; i++) displayPose(race, race.boats[i].id, t, display[i]);
    } else {
      displayPose(race, race.boats[followIndex].id, t, display[followIndex]);
    }
    let held = TV.floor;
    let centreX = 0;
    let centreZ = 0;
    let bearing = 0;
    if (wideWanted) {
      for (let i = 0; i < count; i++) {
        centreX += display[i].wx;
        centreZ += -display[i].wy;
      }
      centreX /= count;
      centreZ /= count;
      /* Pulled toward the boat the console is reading, so the wide shot and the
       * instrument dock are describing the same part of the race. */
      centreX += (display[followIndex].wx - centreX) * TV.weight;
      centreZ += (-display[followIndex].wy - centreZ) * TV.weight;
      const base = TV.bearing + TV.drift * t;
      bearing = base + broadsideTurn(race, t, base);
      /* The box every hull covers, read once and fitted many times: the survey
       * below runs twenty candidate radii over the same six hulls. */
      for (let i = 0; i < count; i++) {
        hullPoints(
          display[i].wx,
          display[i].wy,
          display[i].hdg,
          display[i].heel,
          fleet,
          i * DECK_POINTS * 3,
        );
      }

      /* The smallest station whose whole fleet still sits inside the safe rect.
       * The fit only loosens as the aircraft pulls back, so a bisection from a
       * fixed pair of bounds finds the edge and finds it the same way whichever
       * second the page arrived from. */
      let low = TV.floor;
      let high = TV.ceiling;
      if (surveyWide(fleet, count, centreX, centreZ, bearing, low, aspect, wide, station) > 1) {
        for (let pass = 0; pass < TV.passes; pass++) {
          const mid = (low + high) * 0.5;
          if (
            surveyWide(fleet, count, centreX, centreZ, bearing, mid, aspect, wide, station) > 1
          ) {
            low = mid;
          } else {
            high = mid;
          }
        }
        held = high;
      }
      held = INTRO.radius + (held - INTRO.radius) * opening;
      surveyWide(fleet, count, centreX, centreZ, bearing, held, aspect, wide, station);
    }

    /* One traffic read per frame, shared by both sides of a hand-over: the
     * station it answers is the same one either shot would have stood on. */
    if (chaseWanted) {
      chaseClear(race, replay.followId, t, replay.mode, aspect, clear);
    } else {
      clear.rise = CHASE.eye;
      clear.back = CHASE.back;
    }
    const quarter = homeQuarter(display[followIndex]);

    if (move.to === "chase")
      chaseStand(display[followIndex], quarter, clear.back, clear.rise, arriving);
    else if (move.to === "tactical") shootTactical(display[followIndex], arriving);
    else standToShot(station, arriving);

    if (mix >= 1 || (move.from === move.to && !move.held)) {
      copyShot(arriving, shot);
    } else {
      if (move.held) copyShot(parting, leaving);
      else if (move.from === "chase")
        chaseStand(display[followIndex], quarter, clear.back, clear.rise, leaving);
      else if (move.from === "tactical") shootTactical(display[followIndex], leaving);
      else standToShot(station, leaving);
      mixShot(leaving, arriving, mix, shot);
    }

    camera.position.set(shot.ex, shot.ey, shot.ez);
    aim.set(shot.ax, shot.ay, shot.az);
    camera.lookAt(aim);
    if (shot.roll !== 0) camera.rotateZ(shot.roll);
    if (camera.fov !== shot.fov) {
      camera.fov = shot.fov;
      camera.updateProjectionMatrix();
    }
    /* Everything drawn after this reads the eye off the matrix, so it is
     * written here rather than left to the renderer's own pass. */
    camera.updateMatrixWorld();
  }, -60);

  return null;
}
