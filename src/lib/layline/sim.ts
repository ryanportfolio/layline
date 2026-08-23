/**
 * The race itself: one seeded windward-leeward lap for a six boat fleet, from
 * the prestart approach through the last finisher. Every buffer the page reads
 * is built here, so a number a viewer can count on screen has to be true in
 * this file first.
 *
 * Frame, units and angle conventions are the ones set out in types.ts. The
 * course is sailed at SIM_HZ and published at the lower rates: fixes carry the
 * instantaneous state at their own tick, never an average of the ticks around
 * them, because the evaluator's whole job is to rebuild what happened between
 * two honest samples.
 */
import { hashString, mulberry32 } from "../prng";
import { FIX_HZ, PROGRESS_HZ, SIM_HZ, WIND_HZ } from "./types";
import type {
  BoatMeta,
  Course,
  Fix,
  LegName,
  ProgressSample,
  RaceData,
  RaceEvent,
  RaceResult,
  WindSample,
} from "./types";

const DEG = Math.PI / 180;
const SIM_DT = 1 / SIM_HZ;
const FIX_EVERY = SIM_HZ / FIX_HZ;
const PROGRESS_EVERY = SIM_HZ / PROGRESS_HZ;

/* Sprint format. One lap of a 100 m leg in a fresh breeze, so every window in
 * this file is measured against a race that is over inside a minute: ten
 * seconds of prestart, a beat of about twenty five, a run of about eighteen.
 * The leg length and the breeze are the two duration levers, and they are the
 * ones that moved: the polar and the physics they feed are untouched. */
const T_PRESTART = -10;
const LEG_LENGTH = 100;
const LINE_HALF = 35;
const MARK_X = 0;
const ZONE_RADIUS = 8;
const RUN_OUT = 6;
const HORIZON = 90;

/* Relaxation coefficients for the fixed tick, not the time constants: these
 * are the same number 120,000 times over a race. */
const SPEED_BLEND = 1 - Math.exp(-SIM_DT / 3.5);
const COAST_BLEND = 1 - Math.exp(-SIM_DT / 4);
const HEEL_BLEND = 1 - Math.exp(-SIM_DT / 1.2);
const YAW_MAX = 28;
const SOG_CAP = 11.3;
const HEEL_MAX = 24;
const HEEL_K = 0.215;
const HIKING_KNEE = 11;
const HIKING_CAP = 14;
const LEEWAY_MAX = 4;
/* How far off the buoy the boat aims to pass. With the yaw limit doing the
 * work the bear away comes out at about a 9 m radius, which puts the mark
 * inside the turning circle and on the boat's port side throughout. */
const MARK_PASS = 5;
/* How far down the layline a boat that has to foot for the mark aims: far
 * enough out that it arrives with the angle to round and not on top of the
 * buoy. */
const FOOT_MARGIN = 18;
/* Distance off the buoy at which the pass point stops moving: from here in,
 * the boat is committed to the side it is going round. */
const MARK_FREEZE = 40;
/* How far short of the pass point the bear away starts. Two boat lengths is
 * what puts the exit of a nine metre arc alongside the buoy instead of ten
 * metres up the course from it. */
const TURN_LEAD = 10;

const AVOID_LOOKAHEAD = 10;
/* The gap a crew starts working on, and it is a racing gap, not a shipping
 * one: boats cross at a couple of boat lengths all day and only the last few
 * metres of that are worth steering for. */
const AVOID_TARGET = 18;
const AVOID_DEG = 8;
/* A duck is not a nudge. Bearing away 8 deg keeps a boat clear when there is
 * room to start early; crossing tacks at closing speed takes the full turn
 * down behind the other transom or there is no gap at all. */
const AVOID_HARD = 35;
/* What a boat keeping clear on the beat actually steers to get behind a
 * transom, and therefore what the boat with rights may count on it doing. */
const AVOID_DUCK = 32;
const LANE_ROOM = 12;
const LANE_MIN = 9;
const LANE_TIGHT = 5;
const LANE_HORIZON = 7;
const QUEUE_RANGE = 60;
const SHADOW_LENGTH = 35;
const SHADOW_WIDE = 18;
const SHADOW_LOSS = 0.09;

const FLEET: BoatMeta[] = [
  { id: "fra", nation: "FRA", sail: "FRA 12", name: "Mistral Racing", hue: "#3b74ff" },
  { id: "usa", nation: "USA", sail: "USA 4", name: "Harbor Light Racing", hue: "#e4353f" },
  { id: "gbr", nation: "GBR", sail: "GBR 21", name: "Meridian Racing", hue: "#e8eef4", dark: true },
  { id: "nzl", nation: "NZL", sail: "NZL 7", name: "Southern Cross Racing", hue: "#23282e", dark: true },
  { id: "aus", nation: "AUS", sail: "AUS 33", name: "Coral Coast Racing", hue: "#2fae62" },
  { id: "jpn", nation: "JPN", sail: "JPN 18", name: "Kuroshio Racing", hue: "#ff5d8f" },
];

const START_SLOTS = [-30, -18, -6, 6, 18, 30];

const POLAR_TWA = [30, 44, 60, 90, 110, 140, 165];
const POLAR_FRAC = [0.15, 0.8, 0.95, 1.1, 1.15, 1.15, 0.85];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrap360(a: number): number {
  const w = a % 360;
  return w < 0 ? w + 360 : w;
}

function wrapSigned(a: number): number {
  return wrap360(a + 180) - 180;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/* Three decimals is a millimetre and a thousandth of a degree: past that the
 * buffers only carry float noise, and the JSON doubles in size for it. */
function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function gauss(rand: () => number): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* Boat speed as a fraction of TWS. Catmull-Rom through the measured knots,
 * with the tangents taken over the neighbour spacing so the uneven twa steps
 * do not kink the curve. Below the first knot the boat is pinching into the
 * no-go zone; above the last it is dead downwind with the main blanketing the
 * kite. */
export function polarFrac(twaAbs: number): number {
  const a = clamp(twaAbs, 0, 180);
  if (a <= POLAR_TWA[0]) return (a / POLAR_TWA[0]) * POLAR_FRAC[0];
  const last = POLAR_TWA.length - 1;
  if (a >= POLAR_TWA[last]) {
    return POLAR_FRAC[last] - ((a - POLAR_TWA[last]) / 15) * 0.1;
  }
  let i = 0;
  while (i < last - 1 && a > POLAR_TWA[i + 1]) i++;
  const x0 = POLAR_TWA[i];
  const x1 = POLAR_TWA[i + 1];
  const y0 = POLAR_FRAC[i];
  const y1 = POLAR_FRAC[i + 1];
  const xm = i > 0 ? POLAR_TWA[i - 1] : x0 - (x1 - x0);
  const ym = i > 0 ? POLAR_FRAC[i - 1] : y0 - (y1 - y0);
  const xp = i + 2 <= last ? POLAR_TWA[i + 2] : x1 + (x1 - x0);
  const yp = i + 2 <= last ? POLAR_FRAC[i + 2] : y1 + (y1 - y0);
  const h = x1 - x0;
  const m0 = ((y1 - ym) / (x1 - xm)) * h;
  const m1 = ((yp - y0) / (xp - x0)) * h;
  const s = (a - x0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * y0 +
    (s3 - 2 * s2 + s) * m0 +
    (-2 * s3 + 3 * s2) * y1 +
    (s3 - s2) * m1
  );
}

/* Heel comes from apparent wind, not true: a skiff sailing away from the
 * breeze feels a fraction of it, which is why the same 12 kn lays the boat
 * over upwind and lets it sail flat under the kite. */
function heelTarget(sog: number, tws: number, twa: number): number {
  const a = Math.abs(twa);
  const c = Math.cos(a * DEG);
  const aws = Math.sqrt(sog * sog + tws * tws + 2 * sog * tws * c);
  if (aws < 1e-6) return 0;
  const awa = Math.acos(clamp((sog + tws * c) / aws, -1, 1));
  let mag = clamp(HEEL_K * aws * aws * Math.sin(awa), 0, HEEL_MAX);
  /* Upwind the crew are on the wire and take the extra heeling moment out of
   * a puff, up to what two people weigh: past that the boat lies over. */
  if (a < 70 && mag > HIKING_KNEE) {
    mag = HIKING_KNEE + (HIKING_CAP - HIKING_KNEE) * (1 - Math.exp((HIKING_KNEE - mag) / 3));
  }
  return -clamp(twa / 8, -1, 1) * mag;
}

function leeway(twa: number): number {
  const a = Math.abs(twa);
  return LEEWAY_MAX * clamp(twa / 12, -1, 1) * clamp((70 - a) / 50, 0, 1);
}

interface Personality {
  pace: number;
  twaBeat: number;
  twaRun: number;
  shiftSense: number;
  shiftHold: number;
  memory: number;
  laylineMargin: number;
  /* Height up the beat at which this boat means to be on port and heading
   * for the right of the course. A plan, not a rule: the layline can force
   * the tack earlier and nothing lets it happen later. */
  crossY: number;
  sideLeft: number;
  sideRight: number;
  runLeft: number;
  runRight: number;
  corner: number;
  finishInset: number;
  slot: number;
  gunY: number;
  turnT: number;
}

interface Sim {
  meta: BoatMeta;
  p: Personality;
  entry: number;
  x: number;
  y: number;
  hdg: number;
  cog: number;
  sog: number;
  heel: number;
  twa: number;
  kite: number;
  tack: number;
  phase: number;
  man: number;
  manFloor: number;
  tManEnd: number;
  headerT: number;
  wantT: number;
  wantLay: boolean;
  dirtyT: number;
  refTwd: number;
  noise: number;
  dirty: number;
  avoid: number;
  avoidUrg: number;
  brake: number;
  wide: number;
  desired: number;
  dtf: number;
  rounded: boolean;
  toGo: number;
  tacks: number;
  gybes: number;
  tArc: number;
  markMin: number;
  tRound: number;
  tFinish: number;
  finishTwa: number;
  place: number;
  aimX: number;
  aimDir: number;
  laying: boolean;
  locked: boolean;
  active: boolean;
  fixes: Fix[];
  prog: ProgressSample[];
}

const PHASE_BEAT = 0;
const PHASE_APPROACH = 1;
const PHASE_ARC = 2;
const PHASE_RUN = 3;
const PHASE_DONE = 4;

const MAN_TACK = 1;
const MAN_GYBE = 2;

function makePersonality(meta: BoatMeta, seed: number): Personality {
  const rand = mulberry32((hashString(meta.id) ^ Math.imul(seed, 0x9e3779b1)) >>> 0);
  const corner = rand() * 2 - 1;
  const sense = 3 + 3 * rand();
  /* How far across the course this boat will run before it tacks back. Wide
   * enough to be playing a side, narrow enough that the fleet keeps crossing
   * instead of splitting into two private races. */
  const half = 26 + 16 * (0.5 + 0.5 * corner);
  return {
    pace: 0.98 + 0.04 * rand(),
    /* Sailed off the polar, not off the round number: through these knots the
     * best made-good angles come out a couple of degrees wider upwind and
     * most of a sail's worth deeper on the run than the headline figures. */
    twaBeat: 45 + 2 * rand(),
    twaRun: 142 + 8 * rand(),
    shiftSense: sense,
    shiftHold: 3 + 1.4 * rand(),
    memory: 1 - Math.exp(-SIM_DT / (14 + 10 * rand())),
    laylineMargin: 3 + 7 * rand(),
    crossY: 31 + 10 * rand(),
    sideLeft: 68 - half,
    sideRight: half,
    runLeft: 0.62 * (68 - half),
    runRight: 0.62 * half,
    corner,
    finishInset: 6 + 20 * rand(),
    slot: 0,
    gunY: -0.4 - 1.6 * rand(),
    turnT: -7.4 + 0.6 * (rand() - 0.5),
  };
}

interface Wind {
  twd: Float64Array;
  tws: Float64Array;
}

/* The mean of 7.2 m/s is a duration figure before it is a weather one. This
 * polar makes good 0.589 of the breeze upwind and 0.914 of it downwind, so the
 * two legs cost 279/TWS seconds of sailing whatever else happens: at 14 knots
 * that is 38.8 s, and the manoeuvres fit inside the finish band on top of it.
 * The clamp keeps the fleet in full power the whole way, which is where these
 * boats heel and the kites load. */
function buildWind(seed: number, count: number): Wind {
  const rand = mulberry32((hashString("wind") ^ Math.imul(seed, 0x85ebca6b)) >>> 0);
  const p1 = rand() * 2 * Math.PI;
  const p2 = rand() * 2 * Math.PI;
  const twd = new Float64Array(count);
  const tws = new Float64Array(count);
  const dt = 1 / WIND_HZ;
  const a1 = Math.exp(-dt / 12);
  const a2 = Math.exp(-dt / 15);
  const s1 = 1.2 * Math.sqrt(1 - a1 * a1);
  const s2 = 0.26 * Math.sqrt(1 - a2 * a2);
  let ou1 = 0;
  let ou2 = 0;
  for (let i = 0; i < count; i++) {
    const t = T_PRESTART + i * dt;
    ou1 = ou1 * a1 + s1 * gauss(rand);
    ou2 = ou2 * a2 + s2 * gauss(rand);
    twd[i] = 6 * Math.sin((2 * Math.PI * t) / 35) + 2.5 * Math.sin((2 * Math.PI * t) / 90 + p1) + ou1;
    tws[i] = clamp(7.2 + 0.9 * Math.sin((2 * Math.PI * t) / 70 + p2) + ou2, 6.2, 8.7);
  }
  return { twd, tws };
}

/* The published 1 Hz wind is the only wind there is: the sim reads it through
 * the same linear interpolation the evaluator uses, so a fix's twa and the
 * dial on screen can never disagree about what the breeze was doing. */
function windTwdAt(w: Wind, t: number): number {
  const s = (t - T_PRESTART) / (1 / WIND_HZ);
  const i = clamp(Math.floor(s), 0, w.twd.length - 2);
  const f = clamp(s - i, 0, 1);
  return w.twd[i] + wrapSigned(w.twd[i + 1] - w.twd[i]) * f;
}

function windTwsAt(w: Wind, t: number): number {
  const s = (t - T_PRESTART) / (1 / WIND_HZ);
  const i = clamp(Math.floor(s), 0, w.tws.length - 2);
  const f = clamp(s - i, 0, 1);
  return w.tws[i] + (w.tws[i + 1] - w.tws[i]) * f;
}

function pushFix(b: Sim, t: number): void {
  b.fixes.push({
    t: q(t),
    x: q(b.x),
    y: q(b.y),
    sog: q(b.sog),
    cog: q(wrap360(b.cog)),
    hdg: q(wrap360(b.hdg)),
    heel: q(b.heel),
    twa: q(b.twa),
    kite: q(b.kite),
  });
}

/* What the corner is worth in course length. A hull still swinging round the
 * buoy has some of the course left that a hull already pointing down the run
 * does not, and the axis cannot see the difference. Eight metres is the mark
 * zone, and it is also the ceiling: charge the corner more than that and a boat
 * carving the tightest rounding in the fleet counts down faster than it sails,
 * which is the leaderboard outrunning the picture the other way. */
const TURN_ARC = ZONE_RADIUS;
const COURSE_ARC = 2 * LEG_LENGTH + TURN_ARC;

/* Distance still to sail, as one arc length along the course polyline: up the
 * axis to the mark, round the corner, down the axis to the line. Measured on y
 * alone the corner is invisible, and it is where the fleet spends its closest
 * seconds: boats round wide, so a hull crosses the mark's latitude on the way
 * in and again on the way out and hangs above it in between, sailing hard for
 * no y at all. Above that latitude the angle swept round the buoy is what
 * counts down instead, zero where a boat crosses going up and half a turn where
 * it crosses coming back, so the arc meets the axis exactly at both crossings
 * and a rounding hands nobody a step in either direction. A boat that has
 * crossed the line has none of it left. */
function distanceToFinish(x: number, y: number, rounded: boolean, done: boolean): number {
  if (done) return 0;
  const above = y - LEG_LENGTH;
  if (above > 0) return LEG_LENGTH + TURN_ARC * (1 - Math.atan2(above, x - MARK_X) / Math.PI);
  if (rounded) return Math.max(y, 0);
  return COURSE_ARC - y;
}

/* The fallback a give-way role falls to when neither the tack rule nor a live
 * manoeuvre settles it: of two boats, the one with more course still in front
 * of it keeps clear. It is measured on the same axis as the published distance
 * and deliberately without its clamp, because a pair that both read the same
 * number would hand the role back and forth every time the encounter is
 * re-examined, and a role that changes hands mid-crossing is how two hulls end
 * up in the same water. */
function courseToGo(y: number, run: boolean, done: boolean): number {
  if (done) return 0;
  if (run) return y;
  return Math.max(2 * LEG_LENGTH - y, y);
}

function legOf(b: Sim, t: number): LegName {
  if (t < 0) return "prestart";
  if (b.phase === PHASE_DONE) return "finished";
  if (b.phase === PHASE_RUN) return "run";
  return "beat";
}

/* Backward pass. The gun state is the fixed point of the whole prestart: pick
 * where each boat has to be at t=0, then walk the approach backwards from it
 * so the fleet arrives spread along the line, at speed, on time, without a
 * controller that could miss by a boat length. */
function buildPrestart(b: Sim, w: Wind, ticks: number): void {
  const hdg = new Float64Array(ticks);
  const cog = new Float64Array(ticks);
  const sog = new Float64Array(ticks);
  const twa = new Float64Array(ticks);
  const px = new Float64Array(ticks);
  const py = new Float64Array(ticks);
  const gunTws = windTwsAt(w, 0);
  const gunSpeed = polarFrac(b.p.twaBeat) * gunTws * b.p.pace * 0.97;
  for (let k = 0; k < ticks; k++) {
    const t = T_PRESTART + k * SIM_DT;
    const twd = windTwdAt(w, t);
    const up = smoothstep(b.p.turnT - 1.2, b.p.turnT + 1.2, t);
    const angle = 100 + (b.p.twaBeat - 100) * up;
    hdg[k] = twd - angle;
    twa[k] = wrapSigned(twd - hdg[k]);
    cog[k] = hdg[k] - leeway(twa[k]);
    /* Ten seconds is one approach and no more: the fleet is already reaching
     * along the line when the window opens, loses a little coming up to
     * close hauled, and spends what is left of it accelerating. */
    const luff = smoothstep(b.p.turnT - 0.6, b.p.turnT + 1.4, t);
    const accel = smoothstep(b.p.turnT + 1.4, -1.2, t);
    /* The approach is sailed at a fraction of what the breeze would give,
     * because the crew are burning time, not making distance. The fractions
     * are of the wind at the gun, so a fresher day moves the whole approach
     * with it instead of leaving the fleet reaching in at yesterday's speed. */
    const reach = 0.72 * gunTws;
    const slow = 0.56 * gunTws;
    sog[k] = reach - (reach - slow) * luff + (gunSpeed - slow) * accel;
  }
  px[ticks - 1] = b.p.slot;
  py[ticks - 1] = b.p.gunY;
  for (let k = ticks - 2; k >= 0; k--) {
    const d = sog[k + 1] * SIM_DT;
    px[k] = px[k + 1] - d * Math.sin(cog[k + 1] * DEG);
    py[k] = py[k + 1] - d * Math.cos(cog[k + 1] * DEG);
  }
  let heel = heelTarget(sog[0], windTwsAt(w, T_PRESTART), twa[0]);
  for (let k = 0; k < ticks; k++) {
    const t = T_PRESTART + k * SIM_DT;
    const tws = windTwsAt(w, t);
    heel += (heelTarget(sog[k], tws, twa[k]) - heel) * HEEL_BLEND;
    if (k % FIX_EVERY === 0) {
      b.x = px[k];
      b.y = py[k];
      b.sog = sog[k];
      b.cog = cog[k];
      b.hdg = hdg[k];
      b.twa = twa[k];
      b.heel = heel;
      pushFix(b, t);
    }
    if (k % PROGRESS_EVERY === 0) {
      b.prog.push({
        t: q(t),
        leg: "prestart",
        dtf: q(distanceToFinish(px[k], py[k], false, false)),
        rank: b.entry + 1,
        gapMeters: 0,
        gapSeconds: 0,
      });
    }
    b.refTwd += (windTwdAt(w, t) - b.refTwd) * b.p.memory;
  }
  b.x = px[ticks - 1];
  b.y = py[ticks - 1];
  b.hdg = hdg[ticks - 1];
  b.cog = cog[ticks - 1];
  b.sog = sog[ticks - 1];
  b.twa = twa[ticks - 1];
  b.heel = heel;
}

function startManeuver(b: Sim, kind: number): void {
  b.tack = -b.tack;
  b.man = kind;
  b.manFloor = b.sog * (kind === MAN_TACK ? 0.55 : 0.85);
  b.headerT = 0;
  b.wantT = 0;
  b.dirtyT = 0;
  if (kind === MAN_TACK) b.tacks++;
  else b.gybes++;
}

/* Signed metres to the right of the starboard layline: negative while a boat
 * on port still has to sail out to it, positive once it has overstood. */
function laylineOffset(b: Sim, twd: number, markX: number, markY: number): number {
  const h = (twd - b.p.twaBeat - leeway(b.p.twaBeat)) * DEG;
  const ux = Math.sin(h);
  const uy = Math.cos(h);
  const rx = b.x - markX;
  const ry = b.y - markY;
  return -(ux * ry - uy * rx);
}

/* How near two boats come if neither of them changes anything, looking no
 * further ahead than a helmsman would. */
function closest(
  rx: number,
  ry: number,
  rvx: number,
  rvy: number,
  horizon = AVOID_LOOKAHEAD,
  from = 0,
): number {
  const rv2 = rvx * rvx + rvy * rvy;
  const tc = rv2 < 1e-6 ? from : clamp(-(rx * rvx + ry * rvy) / rv2, from, horizon);
  return Math.hypot(rx + rvx * tc, ry + rvy * tc);
}

/* Where a boat is going, not where it is pointing this instant: a hull halfway
 * through a tack is slow and already aimed at the heading it will leave on,
 * and anyone judging a crossing off its present track will get it wrong. */
function turning(o: Sim): boolean {
  return o.man !== 0 || o.phase === PHASE_ARC;
}

function predVx(o: Sim): number {
  const t = turning(o);
  return o.sog * (t ? 0.8 : 1) * Math.sin((t ? o.desired : o.cog) * DEG);
}

function predVy(o: Sim): number {
  const t = turning(o);
  return o.sog * (t ? 0.8 : 1) * Math.cos((t ? o.desired : o.cog) * DEG);
}

/* Boats that will go about with this one. A line of hulls that all want the
 * other board goes about together and keeps the spacing it already has, which
 * is the only way the boat at the front of it ever gets to tack: waiting for
 * the queue to clear means sailing past the layline with the whole line. What
 * this predicate answers, `tackTogether` then makes true. */
function queued(b: Sim, o: Sim, dx: number, dy: number): boolean {
  return (
    o.man === 0 &&
    o.tack === b.tack &&
    o.phase === b.phase &&
    o.wantLay &&
    b.wantLay &&
    dx * dx + dy * dy < QUEUE_RANGE * QUEUE_RANGE
  );
}

function tackTogether(b: Sim, boats: Sim[]): void {
  for (const o of boats) {
    if (o === b || !o.active) continue;
    if (queued(b, o, o.x - b.x, o.y - b.y)) startManeuver(o, MAN_TACK);
  }
}

/* Closest approach if this boat came out on the other tack now, with the speed
 * it would carry through the turn: a tack costs most of it, a gybe almost
 * none, and guessing that wrong is how a manoeuvre ends up on top of somebody. */
function laneAfterTack(b: Sim, boats: Sim[], twd: number, angle: number, keep: number): number {
  const h = (twd + b.tack * angle) * DEG;
  const vx = b.sog * keep * Math.sin(h);
  const vy = b.sog * keep * Math.cos(h);
  let worst = 1e9;
  for (const o of boats) {
    if (o === b || !o.active) continue;
    const dx = o.x - b.x;
    const dy = o.y - b.y;
    if (dx * dx + dy * dy > 14400) continue;
    let ovx: number;
    let ovy: number;
    if (queued(b, o, dx, dy)) {
      const oh = (twd + o.tack * angle) * DEG;
      ovx = o.sog * keep * Math.sin(oh);
      ovy = o.sog * keep * Math.cos(oh);
    } else if (o.man === 0 && o.tack === b.tack && o.phase === b.phase && b.tack < 0) {
      /* Once this tack is complete that boat is on port and owes the water,
       * and what it owes it pays by bearing away behind the transom, so it is
       * judged on the duck and not on the course it is steering now. Waiting
       * instead for a gap that stays clear with nobody altering would mean
       * never tacking on the layline in front of a line of port tackers,
       * which is exactly where the tack belongs. The question left is whether
       * the duck is still there to be made. */
      const duck = (o.cog - o.tack * AVOID_DUCK) * DEG;
      ovx = o.sog * Math.sin(duck);
      ovy = o.sog * Math.cos(duck);
    } else {
      ovx = predVx(o);
      ovy = predVy(o);
    }
    const m = closest(dx, dy, ovx - vx, ovy - vy, LANE_HORIZON);
    if (m < worst) worst = m;
  }
  return worst;
}

/* A boat cannot be steered above its own close-hauled angle to get out of the
 * way, and it will not sail itself into a gybe by the lee to do it either: an
 * avoidance that asks for either comes back as the nearest angle it can hold. */
function clampSail(b: Sim, twd: number, hdg: number): number {
  const twa = wrapSigned(twd - hdg);
  const a = Math.abs(twa);
  /* Signed off the tack the boat is actually on, never off the requested
   * angle: a steering target that lands near head to wind would otherwise
   * flip sides every tick and park the boat in irons. */
  const s = b.tack;
  if (b.phase <= PHASE_APPROACH) {
    /* Nobody beats to windward by reaching. A duck is worth a few boat
     * lengths of extra distance, not a leg of it, so while the boat is
     * working the beat the widest angle the steering may ask for is a broad
     * close reach, and only a crossing that has to be gone behind buys the
     * angles past it. Coming into the mark the bound goes altogether: a boat
     * that has sailed above the buoy gets down to it by bearing away. */
    const wide = b.phase === PHASE_BEAT ? 65 + clamp(b.avoidUrg - AVOID_DEG, 0, 20) : 120;
    const held = clamp(a, b.p.twaBeat - (b.laying ? 5 : 1), wide);
    if (twa * s < 0 || held !== a) {
      const same = twd - s * held;
      const other = twd + s * held;
      return Math.abs(wrapSigned(same - hdg)) <= Math.abs(wrapSigned(other - hdg)) ? same : other;
    }
  } else if (b.phase === PHASE_RUN) {
    let want = hdg;
    /* The finish is 70 m of open water between two marks and a boat has to
     * cross inside it, so on the last stretch the steering is bounded by where
     * the current heading would put the bow on the line. */
    if (b.y > 3 && b.y < 60) {
      const edge = b.avoidUrg > 0 ? 32 : 29;
      const xc = crossingX(b.x, b.y, hdg);
      if (Math.abs(xc) > edge) {
        want = Math.atan2(-(b.x - clamp(xc, -edge, edge)) / b.y, -1) / DEG;
        /* Fetching the line is a bound, not an override: an alteration that
         * still lands the bow inside the marks survives it. */
        const dodge = want + wrapSigned(hdg - b.desired);
        if (Math.abs(crossingX(b.x, b.y, dodge)) <= 32) want = dodge;
      }
    }
    /* Short of dead downwind by a margin at one end and short of a beam reach
     * at the other: an unplanned gybe is a boom across the boat, not a
     * steering option. */
    const wt = wrapSigned(twd - want);
    const held = clamp(Math.abs(wt), 60, 168);
    /* Held on the gybe the boat is on: crossing dead downwind is a gybe, and
     * gybes are decided by the tactics, not by a steering correction. */
    if (wt * s < 0 || held !== Math.abs(wt)) return twd - s * held;
    return want;
  }
  return hdg;
}

/* The point the boat steers at to leave the buoy to port: the mark offset by
 * a boat length or two to the right of the line of sight, so the hull passes
 * on the correct side whatever angle it comes in at. Inside the last few
 * metres the offset would swing faster than the boat can turn, so the bearing
 * it was last taken on is the one that gets sailed. */
function markAim(b: Sim, markX: number, markY: number, pass: number, out: number[]): void {
  const dist = Math.hypot(markX - b.x, markY - b.y);
  if (dist > MARK_FREEZE) {
    b.aimDir = Math.atan2(markX - b.x, markY - b.y) / DEG + 90;
  }
  out[0] = markX + pass * Math.sin(b.aimDir * DEG);
  out[1] = markY + pass * Math.cos(b.aimDir * DEG);
}

function crossingX(x: number, y: number, hdgDeg: number): number {
  const sx = Math.sin(hdgDeg * DEG);
  const sy = Math.cos(hdgDeg * DEG);
  if (sy > -0.05) return x + sx * 400;
  return x - (sx * y) / sy;
}

/* Written into, never returned: decide runs six times a tick for the whole
 * race and this is the one place it would otherwise allocate. */
const aimOut = [0, 0];

function decide(
  b: Sim,
  boats: Sim[],
  t: number,
  twd: number,
  markX: number,
  markY: number,
): void {
  /* Nobody tacks off the line: the first few seconds belong to getting the
   * boat up to speed and out of the row of transoms either side. */
  const free = b.man === 0 && t > 3 && t - b.tManEnd > 3;
  b.wantLay = false;
  if (b.phase === PHASE_BEAT) {
    const dLay = laylineOffset(b, twd, markX, markY);
    const dist = Math.hypot(b.x - markX, b.y - markY);
    /* On starboard and within what the boat can pinch back is the whole of it.
     * A hull that comes out of its tack fetching the mark from eighty metres
     * is fetching it, and holding the close hauled angle from there instead of
     * steering at the buoy walks off the layline with the next shift. The
     * tolerance is the five degrees of extra height the steering allows a
     * laying boat, which is worth more metres the further out it is. */
    if (b.tack > 0 && dLay >= -clamp(0.07 * dist, 0, 6)) b.laying = true;
    /* A header can put a boat below the line it was fetching on. Holding the
     * angle from there only sails it past the mark to leeward, so it goes back
     * to working the beat and comes at the mark again. */
    /* Inside thirty metres the boat is committed whatever the breeze does:
     * there is no room left to go and get the layline back, so it holds its
     * lane and takes the last few metres out of the sails. */
    if (b.laying && dist > 30 && b.tacks < 3 && dLay < -clamp(0.22 * dist, 3, 10)) {
      b.laying = false;
    }
    /* Nothing upwind of the windward mark is worth sailing to. */
    if (b.y > markY + 6) {
      b.laying = true;
      b.phase = PHASE_APPROACH;
      b.tArc = t;
    }
    if (free && !b.laying) {
      const header = -b.tack * wrapSigned(twd - b.refTwd);
      if (header > b.p.shiftSense) b.headerT += SIM_DT;
      else b.headerT = 0;
      /* Two tacks is the least this course can be sailed in: out to the
       * starboard layline and back onto it. The discretionary ones are held
       * to what is left of a four tack budget. */
      const shifty = b.tacks < 1 && t - b.tManEnd > 5;
      /* A boat inside one tack of the layline has run out of course to play
       * with and sails what is left of it, whatever side it fancied. Tacking
       * short of the line there is what leaves a hull on starboard that cannot
       * fetch the buoy and has nowhere left to go and get it back. */
      const swing = (0.75 * b.sog * b.p.twaBeat) / YAW_MAX;
      const room = dLay < b.p.laylineMargin - 2.5 * swing;
      let want = false;
      if (shifty && b.headerT > b.p.shiftHold) want = true;
      if (shifty && b.dirtyT > 5) want = true;
      if (b.tacks === 0 && b.tack > 0 && b.y > b.p.crossY) want = true;
      if (room && b.tacks < 2 && b.tack > 0 && b.x < -b.p.sideLeft) want = true;
      if (room && b.tacks < 2 && b.tack < 0 && b.x > b.p.sideRight) want = true;
      /* The mark is rounded to port, so it has to be fetched on starboard, and
       * every metre spent left of the starboard layline has to be won back
       * across the course. Crossing costs about 0.72 m of height per metre of
       * that deficit, so this is the last point at which the height left is
       * still enough to do it. */
      let owed = false;
      if (b.tack > 0 && dLay < 0 && -dLay * 0.82 >= markY - 10 - b.y) owed = true;
      /* The turn is called before the layline, not on it. A tack is most of a
       * hundred degrees and the boat keeps making ground to windward of the
       * line for half of it, so the call goes in that much early and the hull
       * comes out of it on the layline with the margin still in hand. The
       * margin is sailed for, not saved: the breeze swings six degrees either
       * way and a boat that lands exactly on the line is below it on the next
       * header with nothing left to do about it. */
      if (b.tack < 0 && dLay >= b.p.laylineMargin - swing) owed = true;
      if (owed) want = true;
      /* Sailing on past the mark's own latitude on port ends with the boat
       * coming back down at the buoy from above, which is not a rounding. This
       * tack takes the narrowest lane there is. */
      const late = b.tack < 0 && b.y > markY - 5;
      if (want || late) b.wantT += SIM_DT;
      else b.wantT = 0;
      /* Only the tack onto the layline goes in a queue: it is the one the
       * whole line has to make in the same few seconds, and the boat at the
       * front of it can only go if the ones it is crossing go with it. */
      b.wantLay = (owed || late) && b.wantT > 0.5;
      /* Wait for a lane, but only for so long: a boat that cannot find a clear
       * one takes the narrower one rather than sail on to nowhere. A tack the
       * course itself is asking for gets the same treatment as a late one,
       * because the alternative is not fetching the mark at all: it goes on
       * the first gap it can duck out of and pays for it with the turn. */
      if (b.wantT > 0) {
        /* Coming out onto starboard the boat needs room to finish the turn and
         * no more, because the fleet it is tacking in front of is on port and
         * owes it the water once it is round. Going the other way it is the one
         * that will be keeping clear, so it waits for a lane it can hold. */
        const floor = b.tack < 0 ? LANE_TIGHT : LANE_MIN;
        const need = late || owed
          ? Math.max(12 - 4 * b.wantT, floor)
          : Math.max(LANE_ROOM - 2.5 * b.wantT, LANE_MIN);
        if (laneAfterTack(b, boats, twd, b.p.twaBeat, 0.6) > need) {
          tackTogether(b, boats);
          startManeuver(b, MAN_TACK);
        }
        /* Still no lane: ease and let the queue slide by rather than tack into
         * the middle of it. */
        else if (b.wantT > 2.5) b.brake = Math.min(b.brake, 0.85);
      }
    }
    b.desired = twd - b.tack * b.p.twaBeat;
    /* Short of the line to the buoy with the height running out, and the way
     * back onto it is to crack off rather than to pinch: this polar makes a
     * metre and a half across the course for every metre of height at the
     * beating angle and two for one cracked off, so the boat that sails a
     * little lower and faster is the one that still gets round the mark. */
    if (b.tack < 0 && b.man === 0 && dLay < 0 && -dLay * 0.68 > markY - 12 - b.y) {
      const h = (twd - b.p.twaBeat - leeway(b.p.twaBeat)) * DEG;
      const ax = markX - FOOT_MARGIN * Math.sin(h);
      const ay = markY - FOOT_MARGIN * Math.cos(h);
      const toAim = Math.atan2(ax - b.x, ay - b.y) / DEG;
      if (wrapSigned(toAim - b.desired) * b.tack < 0) b.desired = toAim;
    }
    if (b.laying && b.man === 0) {
      markAim(b, markX, markY, MARK_PASS + b.wide, aimOut);
      const toAim = Math.atan2(aimOut[0] - b.x, aimOut[1] - b.y) / DEG;
      /* An overstood boat cracks off and sails fast at the mark rather than
       * holding an angle it no longer needs, and inside the last few boat
       * lengths every boat steers at the pass point whatever the breeze has
       * done to the layline since it tacked. */
      if (dLay > 2 || dist < 45) b.desired = toAim;
      if (dist < 22) b.phase = PHASE_APPROACH;
    }
  } else if (b.phase === PHASE_APPROACH) {
    markAim(b, markX, markY, MARK_PASS + b.wide, aimOut);
    const ax = aimOut[0];
    const ay = aimOut[1];
    b.desired = Math.atan2(ax - b.x, ay - b.y) / DEG;
    const hx = Math.sin(b.hdg * DEG);
    const hy = Math.cos(b.hdg * DEG);
    const near = Math.hypot(b.x - markX, b.y - markY);
    /* The turn is carved around the buoy, not begun level with it: the boat
     * comes in wide and leaves close, which is the whole of a good rounding.
     * Any earlier than TURN_LEAD and the turn starts short of the mark, which
     * rounds it on the wrong side. */
    const past = (b.x - ax) * hx + (b.y - ay) * hy >= -TURN_LEAD && near < 18;
    if (past || near < MARK_PASS + 2) {
      b.phase = PHASE_ARC;
      b.tArc = t;
    }
  } else if (b.phase === PHASE_ARC) {
    b.desired = twd - b.p.twaRun;
    /* Past 112 the boat is committed to the leg with the kite going up, and
     * holding out for the last few degrees would leave a run reading as a beat
     * whenever a boat alongside pushes the turn wide. */
    if (Math.abs(b.twa) > 112 || t - b.tArc > 6) {
      b.phase = PHASE_RUN;
      b.tManEnd = t;
      b.wide = 0;
      /* The favoured end is the one further downwind, unless this boat has a
       * side it believes in. */
      const side = b.refTwd > 0 ? -1 : 1;
      const own = b.p.corner > 0.55 ? 1 : b.p.corner < -0.55 ? -1 : side;
      b.aimX = own * (LINE_HALF - b.p.finishInset);
      b.p.runLeft = Math.max(b.p.runLeft, Math.abs(b.aimX) + 10);
      b.p.runRight = Math.max(b.p.runRight, Math.abs(b.aimX) + 10);
    }
  } else if (b.phase === PHASE_RUN) {
    let twaRun = b.p.twaRun;
    const xc = crossingX(b.x, b.y, twd - b.tack * twaRun);
    if (b.y < 55) {
      /* Soaking low or heating up is how the last stretch of a run is steered.
       * Both cost speed off the polar, so the swing stays inside the angles a
       * kite actually pulls at. */
      twaRun = clamp(twaRun + clamp(0.06 * (b.aimX - xc) * b.tack, -12, 12), 132, 152);
    }
    if (free) {
      const lift = b.tack * wrapSigned(twd - b.refTwd);
      if (lift > b.p.shiftSense) b.headerT += SIM_DT;
      else b.headerT = 0;
      /* One gybe is forced by the geometry: bearing away at the mark sends the
       * boat out past the pin end of the line. The rest are appetite, and on
       * one leg of this length there is room for two. */
      const shifty = b.gybes < 1 && t - b.tManEnd > 5;
      let want = false;
      if (!b.locked) {
        if (shifty && b.headerT > b.p.shiftHold) want = true;
        if (b.gybes < 2 && b.tack > 0 && b.x < -b.p.runLeft) want = true;
        if (b.gybes < 2 && b.tack < 0 && b.x > b.p.runRight) want = true;
      }
      let must = false;
      /* Where this gybe and the other one would each put the boat on the line
       * is decided from the top of the run, not from halfway down it: the
       * gybe that lands on the favoured end is a point on the water, and a
       * boat that sails past it has to come back up to the line. */
      if (b.y > 3 && b.y < LEG_LENGTH - 8) {
        const oxc = crossingX(b.x, b.y, twd + b.tack * b.p.twaRun);
        const here = Math.abs(xc - b.aimX);
        const other = Math.abs(oxc - b.aimX);
        if (!b.locked && b.gybes < 2 && here > 10 && other < here - 8) want = true;
        /* The heading that puts the bow on the line: if the boat cannot hold
         * it on this gybe then it has to gybe, whatever its appetite for
         * gybing was, because finishing outside the marks is not finishing. */
        const ft = wrapSigned(twd - Math.atan2(-(b.x - clamp(xc, -29, 29)) / b.y, -1) / DEG);
        if (ft * b.tack < 0 || Math.abs(ft) > 166) must = true;
      }
      if (want || must) b.wantT += SIM_DT;
      else b.wantT = 0;
      if (b.wantT > 0) {
        /* A gybe the boat has to make to fetch the line takes a narrower lane
         * than one it merely wants. */
        const need = Math.max((must ? 11 : LANE_ROOM) - 2.5 * b.wantT, must ? 6 : LANE_MIN);
        if (laneAfterTack(b, boats, twd, b.p.twaRun, 0.9) > need) startManeuver(b, MAN_GYBE);
      }
    }
    if (b.y < 25) b.locked = true;
    b.desired = twd - b.tack * twaRun;
  } else {
    /* Over the line the sheets go and the boat comes up to a reach, but it
     * takes a few seconds to do it, and the boat coasting away from the line
     * still owes room to whoever is finishing behind it. */
    const k = clamp((t - b.tFinish) / 6, 0, 1);
    b.desired = twd - b.tack * (b.finishTwa + (90 - b.finishTwa) * k);
  }
}

function stepBoat(b: Sim, t: number, twd: number, tws: number): void {
  const err = wrapSigned(clampSail(b, twd, b.desired + b.avoid) - b.hdg);
  /* Steering is rudder work and slows down with the boat, but a tack or a
   * gybe is the crew rolling the hull through the turn, and that comes round
   * at the full rate however little way is left on. */
  const maxYaw = YAW_MAX * (b.man !== 0 ? 1 : clamp(b.sog / 5, 0.55, 1)) * SIM_DT;
  b.hdg = wrap360(b.hdg + clamp(err, -maxYaw, maxYaw));
  b.twa = wrapSigned(twd - b.hdg);
  /* The boom decides this one: a boat running deep gets held short of dead
   * downwind unless it is actually gybing. */
  if (b.phase === PHASE_RUN && b.man !== MAN_GYBE && b.twa * b.tack < 0) {
    b.hdg = wrap360(twd - b.tack * 172);
    b.twa = wrapSigned(twd - b.hdg);
  }
  const a = Math.abs(b.twa);
  /* Bad air and a crew easing to let someone cross are the same loss twice
   * over, so the boat pays the worse of them and not the product. */
  const loss = Math.max(b.dirty, 1 - b.brake);
  let target = polarFrac(a) * tws * b.p.pace * (1 + b.noise) * (1 - loss);
  /* Without the kite drawing there is no downwind power to speak of, which is
   * what makes the hoist out of the mark worth watching. */
  if (a > 100) target *= 0.86 + 0.14 * b.kite;
  if (b.phase === PHASE_DONE) target *= 0.3;
  target = Math.min(target, SOG_CAP);
  b.sog += (target - b.sog) * (b.phase === PHASE_DONE ? COAST_BLEND : SPEED_BLEND);
  if (b.man !== 0 && b.sog < b.manFloor) b.sog = b.manFloor;
  if (b.man !== 0 && Math.abs(wrapSigned(b.desired - b.hdg)) < 6) {
    b.man = 0;
    b.tManEnd = t;
  }
  if (b.phase === PHASE_RUN && a > 100) b.kite = Math.min(1, b.kite + SIM_DT / 4);
  else b.kite = Math.max(0, b.kite - SIM_DT / 3);
  b.heel += (heelTarget(b.sog, tws, b.twa) - b.heel) * HEEL_BLEND;
  b.cog = wrap360(b.hdg - leeway(b.twa));
  b.x += b.sog * Math.sin(b.cog * DEG) * SIM_DT;
  b.y += b.sog * Math.cos(b.cog * DEG) * SIM_DT;
}

export function generateRace(seed: number): RaceData {
  const course: Course = {
    startPin: { x: -LINE_HALF, y: 0 },
    startBoat: { x: LINE_HALF, y: 0 },
    windward: { x: MARK_X, y: LEG_LENGTH },
    zoneRadius: ZONE_RADIUS,
  };
  const windCount = Math.ceil((HORIZON - T_PRESTART) * WIND_HZ) + 1;
  const wind = buildWind(seed, windCount);
  const markX = course.windward.x;
  const markY = course.windward.y;

  const boats: Sim[] = FLEET.map((meta, i) => ({
    meta,
    p: makePersonality(meta, seed),
    entry: i,
    x: 0,
    y: 0,
    hdg: 0,
    cog: 0,
    sog: 0,
    heel: 0,
    twa: 0,
    kite: 0,
    tack: 1,
    phase: PHASE_BEAT,
    man: 0,
    manFloor: 0,
    tManEnd: -1e3,
    headerT: 0,
    wantT: 0,
    wantLay: false,
    dirtyT: 0,
    refTwd: windTwdAt(wind, T_PRESTART),
    noise: 0,
    dirty: 0,
    avoid: 0,
    avoidUrg: 0,
    brake: 1,
    wide: 0,
    desired: 0,
    dtf: 0,
    rounded: false,
    toGo: 0,
    tacks: 0,
    gybes: 0,
    tArc: 0,
    markMin: 1e6,
    tRound: 0,
    tFinish: 0,
    finishTwa: 140,
    place: 0,
    aimX: 0,
    aimDir: 0,
    laying: false,
    locked: false,
    active: true,
    fixes: [],
    prog: [],
  }));

  /* Where a boat starts follows the side it wants. The line is long against
   * this beat, so the pin end sits far from the starboard layline and a boat
   * down there runs out of course early and has to cross to the right almost
   * at once; only the starboard end has the height to spare to work the left.
   * Boats that want the right start at the pin, and the fleet splits. */
  const order = boats.map((b, i) => i).sort((i, j) => boats[j].p.corner - boats[i].p.corner);
  for (let s = 0; s < order.length; s++) {
    const b = boats[order[s]];
    const jitter = mulberry32((hashString(b.meta.id + "slot") ^ seed) >>> 0)() * 2.4 - 1.2;
    b.p.slot = START_SLOTS[s] + jitter;
    b.p.turnT += (s / (order.length - 1)) * 1.8;
    b.p.sideLeft = Math.max(b.p.sideLeft, Math.abs(b.p.slot) + 22);
    b.p.sideRight = Math.max(b.p.sideRight, Math.abs(b.p.slot) + 12);
  }

  const preTicks = Math.round(-T_PRESTART * SIM_HZ) + 1;
  for (const b of boats) buildPrestart(b, wind, preTicks);

  const noiseRand = boats.map((b) =>
    mulberry32((hashString(b.meta.id + "pace") ^ Math.imul(seed, 0xc2b2ae35)) >>> 0),
  );
  const noiseA = Math.exp(-SIM_DT / 8);
  const noiseS = 0.03 * Math.sqrt(1 - noiseA * noiseA);

  const events: RaceEvent[] = [{ kind: "gun", t: 0 }];
  const results: RaceResult[] = [];
  const maxK = Math.round((HORIZON - T_PRESTART) * SIM_HZ);
  const order2 = boats.map((_, i) => i);
  /* Which boat of a pair is keeping clear holds for the length of the
   * encounter: a role that swapped every tick would leave both of them
   * waiting for the other to move. */
  const roleWho = new Int8Array(boats.length * boats.length);
  const roleAt = new Float64Array(boats.length * boats.length);
  let finished = 0;
  let lastFixT = 0;
  /* Held between the crossing and the scoring of it, because places are not
   * settled until every hull that crossed inside the tick has been seen. */
  const crossed: Sim[] = [];
  /* The pace the gaps are measured against freezes when the leader stops
   * racing, so a boat still on the water is not scored against a hull that is
   * coasting down with its sails eased. */
  let paceSpeed = 4;

  for (let k = preTicks; k <= maxK; k++) {
    const t = T_PRESTART + k * SIM_DT;
    const twd = windTwdAt(wind, t);
    const tws = windTwsAt(wind, t);

    for (let i = 0; i < boats.length; i++) {
      const b = boats[i];
      if (!b.active) continue;
      /* Bounded at a bit over two sigma: a 3 percent process is meant to make
       * boats breathe, not to hand one of them a gust nobody else got. */
      b.noise = clamp(b.noise * noiseA + noiseS * gauss(noiseRand[i]), -0.06, 0.06);
      b.refTwd += (twd - b.refTwd) * b.p.memory;
      b.dirty = 0;
      b.avoid = 0;
      b.avoidUrg = 0;
      b.brake = 1;
      b.toGo = courseToGo(b.y, b.phase >= PHASE_RUN, b.phase === PHASE_DONE);
      decide(b, boats, t, twd, markX, markY);
    }

    const wx = Math.sin(twd * DEG);
    const wy = Math.cos(twd * DEG);
    for (let i = 0; i < boats.length; i++) {
      const bi = boats[i];
      if (!bi.active) continue;
      for (let j = i + 1; j < boats.length; j++) {
        const bj = boats[j];
        if (!bj.active) continue;
        const rx = bj.x - bi.x;
        const ry = bj.y - bi.y;
        const d2 = rx * rx + ry * ry;
        if (d2 > 6400) continue;
        const d = Math.sqrt(d2);

        const along = rx * wx + ry * wy;
        const across = Math.abs(rx * wy - ry * wx);
        const lead = Math.abs(along);
        if (lead < SHADOW_LENGTH) {
          const halfWidth = 7 + 0.1 * lead;
          if (across < halfWidth) {
            const shade =
              (1 - lead / SHADOW_LENGTH) * (1 - across / halfWidth) * (lead > 4 ? 1 : lead / 4);
            const lee = along > 0 ? bi : bj;
            lee.dirty = Math.max(lee.dirty, SHADOW_LOSS * shade);
            if (shade > 0.3 && d < SHADOW_WIDE) lee.dirtyT += SIM_DT;
          }
        }

        const miss = closest(rx, ry, predVx(bj) - predVx(bi), predVy(bj) - predVy(bi));
        /* A boat that has finished is coasting with its sheets eased and turns
         * like it: it needs to see the other hull coming from further away,
         * and it has no leg left to lose by giving up the room. */
        const done = bi.phase === PHASE_DONE || bj.phase === PHASE_DONE;
        if (miss < (done ? AVOID_TARGET + 12 : AVOID_TARGET)) {
          /* A boat that has just put itself there is the one that gets out of
           * it: coming out of a tack it owes room to anyone already sailing.
           * Otherwise the boat with further to sail keeps clear. */
          const key = i * boats.length + j;
          let who = roleWho[key];
          const iTurn = bi.man !== 0 || t - bi.tManEnd < 3;
          const jTurn = bj.man !== 0 || t - bj.tManEnd < 3;
          /* A boat that has crossed the line is out of the race and keeps clear
           * of everything still in it, whatever the rules of the road would
           * have said a moment earlier. */
          if (bi.phase === PHASE_DONE && bj.phase !== PHASE_DONE) who = 1;
          else if (bj.phase === PHASE_DONE && bi.phase !== PHASE_DONE) who = 2;
          else if (iTurn && !jTurn) who = 1;
          else if (jTurn && !iTurn) who = 2;
          /* Opposite tacks: the boat with the wind on its port side keeps
           * clear. It is the first rule of the sport and it is what lets a
           * boat put in a tack on the layline instead of waiting out the
           * queue coming the other way. */
          else if (
            bi.phase !== PHASE_DONE &&
            bj.phase !== PHASE_DONE &&
            bi.tack !== bj.tack
          ) {
            who = bi.tack < 0 ? 1 : 2;
            roleAt[key] = t;
          } else if (who === 0 || t - roleAt[key] > 6) {
            who = bi.toGo > bj.toGo || (bi.toGo === bj.toGo && i > j) ? 1 : 2;
            roleAt[key] = t;
          }
          roleWho[key] = who;
          const give = who === 1 ? bi : bj;
          const urgency = clamp((AVOID_TARGET - miss) / 16, 0, 1);
          const hard = clamp((14 - miss) / 8, 0, 1);
          const mag = AVOID_DEG * urgency + (AVOID_HARD - AVOID_DEG) * hard;
          give.avoidUrg = Math.max(give.avoidUrg, done ? Math.max(mag, AVOID_DEG) : mag);
          /* Under ten metres of forecast gap the right of way stops deciding
           * who moves: both crews do. A hull halfway through a tack cannot get
           * out of anybody's way whoever owes what, so there the boat with
           * rights does the whole of the avoiding. */
          const stuck = give.man !== 0;
          if (miss < 10 || stuck) {
            const stand = give === bi ? bj : bi;
            stand.avoidUrg = Math.max(stand.avoidUrg, mag * (stuck ? 1 : 0.45));
          }
          if (
            Math.hypot(bi.x - markX, bi.y - markY) < 25 &&
            Math.hypot(bj.x - markX, bj.y - markY) < 25 &&
            give.phase <= PHASE_ARC
          ) {
            /* No room at the mark: the boat astern takes the wide arc rather
             * than the one that ends in a protest flag. */
            give.wide = Math.max(give.wide, 4);
          }
        }
      }
    }

    /* One alteration, scored against every boat in the neighbourhood: ducking
     * one transom into another hull is not keeping clear. */
    for (let i = 0; i < boats.length; i++) {
      const g = boats[i];
      if (!g.active || g.avoidUrg === 0) continue;
      /* Committed to a rounding, a boat holds its arc and gives room with the
       * width of it instead of a swerve that would take it the wrong side of
       * the buoy. */
      const rounding =
        g.phase >= PHASE_APPROACH &&
        g.phase <= PHASE_ARC &&
        Math.hypot(g.x - markX, g.y - markY) < 16;
      const mag = rounding ? Math.min(g.avoidUrg, AVOID_DEG) : g.avoidUrg;
      /* On the layline with the mark in sight there is no room to give away
       * to leeward: whatever this boat does about the one alongside, it does
       * it by coming up, because the metres it puts under the bow now are the
       * ones it needs to fetch the buoy. */
      const holdLane =
        g.laying &&
        g.phase <= PHASE_APPROACH &&
        Math.hypot(g.x - markX, g.y - markY) < 40;
      let best = clampSail(g, twd, g.desired);
      let bestScore = -1;
      for (let c = 0; c < 3; c++) {
        const delta = c === 0 ? 0 : c === 1 ? mag : -mag;
        if (holdLane && delta * g.tack < 0) continue;
        const cand = clampSail(g, twd, g.desired + delta);
        const cvx = g.sog * Math.sin(cand * DEG);
        const cvy = g.sog * Math.cos(cand * DEG);
        let score = 1e9;
        for (let j = 0; j < boats.length; j++) {
          if (j === i) continue;
          const o = boats[j];
          if (!o.active) continue;
          const dx = o.x - g.x;
          const dy = o.y - g.y;
          if (dx * dx + dy * dy > 6400) continue;
          /* Scored from a little way out: what matters is whether this
           * alteration is opening the gap, and every option looks the same if
           * the hull alongside right now is counted in. */
          const m = closest(dx, dy, predVx(o) - cvx, predVy(o) - cvy, 14, 0.6);
          if (m < score) score = m;
        }
        if (score > bestScore + 0.5) {
          bestScore = score;
          best = cand;
        }
      }
      g.avoid = wrapSigned(best - g.desired);
      /* Steering alone cannot always open the gap, and a boat that eases to
       * let another cross is doing what a crew would do. Downwind the boat has
       * forty degrees of angle to play with instead and keeps its kite full. */
      if (bestScore < 5) {
        const floor = g.phase <= PHASE_ARC ? 0.95 : 0.96;
        g.brake = Math.min(g.brake, clamp(floor + bestScore / 60, floor, 1));
      }
    }

    /* Close quarters are not a prediction problem any more. Inside 15 m both
     * boats turn off each other in proportion to what is left of the gap,
     * which is what crews do when the forecast has already been wrong. */
    for (let i = 0; i < boats.length; i++) {
      const g = boats[i];
      if (!g.active) continue;
      let push = 0;
      for (let j = 0; j < boats.length; j++) {
        if (j === i) continue;
        const o = boats[j];
        if (!o.active) continue;
        const dx = o.x - g.x;
        const dy = o.y - g.y;
        const d = Math.hypot(dx, dy);
        if (d > 13) continue;
        const rel = wrapSigned(Math.atan2(dx, dy) / DEG - g.hdg);
        if (Math.abs(rel) > 145) continue;
        const side = Math.abs(rel) < 10 ? -g.tack : -Math.sign(rel);
        /* Both crews are watching the gap, but the one that owes room is the
         * one doing most of the steering: a boat holding its rights gives up
         * a little and no more. */
        const key = i < j ? i * boats.length + j : j * boats.length + i;
        const owes = roleWho[key] === (i < j ? 1 : 2);
        push += side * (13 - d) * 4 * (owes ? 1 : 0.6);
      }
      /* The buoy gets the same treatment: an inflatable mark is a thing to
       * round, not to sail over. */
      const dm = Math.hypot(markX - g.x, markY - g.y);
      if (dm < 9 && g.phase <= PHASE_RUN) {
        const rel = wrapSigned(Math.atan2(markX - g.x, markY - g.y) / DEG - g.hdg);
        if (Math.abs(rel) < 110) push += -Math.sign(rel) * (9 - dm) * 3;
      }
      if (push !== 0) g.avoid = clamp(g.avoid + push, -AVOID_HARD - 5, AVOID_HARD + 5);
    }

    for (const b of boats) {
      if (!b.active) continue;
      const prevY = b.y;
      stepBoat(b, t, twd, tws);

      /* The arc is measured to the closest hull, not to the first tick that
       * reads as a run: a boat is still rounding while it is still closing on
       * the buoy, whatever the kite is doing. Carried through the run leg so
       * the minimum is taken after the boat has left the mark behind. */
      if (b.phase >= PHASE_APPROACH && b.phase <= PHASE_RUN) {
        const d = Math.hypot(b.x - markX, b.y - markY);
        if (d < b.markMin) {
          b.markMin = d;
          b.tRound = t;
        }
      }
      /* Which side of the corner the published arc measures from. A rounding to
       * port comes in on the buoy's right and leaves on its left, so the hull
       * crossing the mark's own meridian above it is the moment the beat behind
       * it stops counting and the run in front of it starts. A boat that carves
       * the turn tight enough to bear away below the mark's own latitude before
       * it gets across that meridian has rounded just the same, and the leg it
       * is sailing says so: read off the quadrant alone it would count the beat
       * all the way down the run. */
      if (!b.rounded && b.phase >= PHASE_APPROACH) {
        if (b.phase === PHASE_RUN || (b.y > markY && b.x < markX)) b.rounded = true;
      }
      if (b.phase === PHASE_RUN && prevY > 0 && b.y <= 0) {
        const f = prevY / (prevY - b.y);
        b.tFinish = t - SIM_DT + f * SIM_DT;
        b.finishTwa = Math.abs(b.twa);
        b.phase = PHASE_DONE;
        b.locked = true;
        crossed.push(b);
      }
      if (b.phase === PHASE_DONE && t > b.tFinish + RUN_OUT) b.active = false;
    }

    /* Two hulls can cross inside one tick and the fleet array is not the order
     * they crossed in. Places go on the interpolated crossing time, which is
     * the only thing the line itself measured. */
    if (crossed.length > 0) {
      if (crossed.length > 1) {
        crossed.sort((a, b) => a.tFinish - b.tFinish || a.meta.id.localeCompare(b.meta.id));
      }
      for (const b of crossed) {
        finished++;
        b.place = finished;
        events.push({ kind: "rounding", t: q(b.tRound), boatId: b.meta.id });
        events.push({ kind: "finish", t: q(b.tFinish), boatId: b.meta.id, rank: finished });
        results.push({ boatId: b.meta.id, rank: finished, elapsed: q(b.tFinish) });
      }
      crossed.length = 0;
    }

    if (k % FIX_EVERY === 0) {
      for (const b of boats) {
        if (!b.active) continue;
        pushFix(b, t);
        lastFixT = t;
      }
    }

    if (k % PROGRESS_EVERY === 0) {
      for (const b of boats) {
        if (b.active) b.dtf = distanceToFinish(b.x, b.y, b.rounded, b.phase === PHASE_DONE);
      }
      order2.sort((i, j) => boats[i].dtf - boats[j].dtf || boats[i].place - boats[j].place);
      const lead = boats[order2[0]];
      if (lead.phase !== PHASE_DONE) {
        paceSpeed = Math.max(Math.abs(lead.sog * Math.cos(lead.cog * DEG)), 1.5);
      }
      for (let r = 0; r < order2.length; r++) {
        const b = boats[order2[r]];
        const gapMeters = b.dtf - lead.dtf;
        b.prog.push({
          t: q(t),
          leg: legOf(b, t),
          dtf: q(b.dtf),
          rank: r + 1,
          gapMeters: q(gapMeters),
          gapSeconds: q(gapMeters / paceSpeed),
        });
      }
    }

    if (finished === boats.length) {
      let done = true;
      for (const b of boats) if (b.active) done = false;
      if (done) break;
    }
  }

  const fixes: Record<string, Fix[]> = {};
  const progress: Record<string, ProgressSample[]> = {};
  for (const b of boats) {
    fixes[b.meta.id] = b.fixes;
    progress[b.meta.id] = b.prog;
  }

  const tMax = lastFixT;
  const windOut: WindSample[] = [];
  const windEnd = Math.ceil(tMax);
  for (let s = T_PRESTART; s <= windEnd; s += 1 / WIND_HZ) {
    windOut.push({ t: q(s), twd: q(wrapSigned(windTwdAt(wind, s))), tws: q(windTwsAt(wind, s)) });
  }

  const kindOrder: Record<string, number> = { gun: 0, rounding: 1, finish: 2 };
  events.sort(
    (a, b) =>
      a.t - b.t ||
      kindOrder[a.kind] - kindOrder[b.kind] ||
      (a.boatId ?? "").localeCompare(b.boatId ?? ""),
  );
  results.sort((a, b) => a.rank - b.rank);

  return {
    seed,
    tMin: T_PRESTART,
    tMax: q(tMax),
    course,
    wind: windOut,
    boats: FLEET.map((m) => ({ ...m })),
    fixes,
    progress,
    events,
    results,
  };
}
