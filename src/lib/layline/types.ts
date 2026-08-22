/**
 * Layline: shared contracts for the race replay engine.
 *
 * Course frame: x = meters across the course (positive toward the right-hand
 * side looking upwind), y = meters along the course axis (0 at the start line,
 * positive toward the windward mark). The renderer maps course (x, y) onto
 * world (x, -z); the engine never imports three.
 *
 * Angles are degrees in the course frame: 0 points up the course toward +y and
 * values grow clockwise looking down, so 90 points toward +x. `twd` is the
 * direction the wind blows FROM: a steady breeze straight down the course is
 * twd 0. `twa` is signed: positive means wind over the starboard side. `heel`
 * is signed: positive leans the mast toward the boat's own starboard side.
 *
 * SI internally: meters, seconds, m/s. Knots and clock strings live in
 * format.ts at the display edge only, so every number on screen traces back
 * through exactly one conversion.
 */

export const FIX_HZ = 4;
export const SIM_HZ = 20;
export const WIND_HZ = 1;
export const PROGRESS_HZ = 2;

/* One fixed seed: every load replays the identical race, so captures,
 * the server-rendered chart and the live scene can never disagree. */
export const RACE_SEED = 20280726;

export interface Vec2 {
  x: number;
  y: number;
}

export interface WindSample {
  t: number;
  twd: number; // deg, course frame, direction the wind comes FROM
  tws: number; // m/s
}

export interface Fix {
  t: number; // s relative to the gun (negative during the prestart)
  x: number;
  y: number;
  sog: number; // m/s over ground
  cog: number; // deg, course frame
  hdg: number; // deg, course frame
  heel: number; // deg, signed
  twa: number; // deg, signed
  kite: number; // gennaker hoist state 0..1
}

export type LegName = "prestart" | "beat" | "run" | "finished";

export interface ProgressSample {
  t: number;
  leg: LegName;
  dtf: number; // meters to the finish, as arc length along the course polyline
  rank: number; // 1-based; during the prestart this is entry order
  gapMeters: number; // to the leader along that same arc, 0 for the leader
  gapSeconds: number; // gapMeters over the leader's along-course speed, clamped
}

export interface BoatMeta {
  id: string; // "nzl"
  nation: string; // "NZL"
  sail: string; // "NZL 7"
  name: string; // team name shown in the instrument dock
  hue: string; // hex; chips, trails, gennaker
  dark?: boolean; // hue needs an outlined chip to hold against the panel ground
}

export interface Course {
  startPin: Vec2; // port end of the line, looking upwind
  startBoat: Vec2; // committee boat, starboard end
  windward: Vec2;
  zoneRadius: number; // mark zone radius, m
}

export type RaceEventKind = "gun" | "rounding" | "finish";

export interface RaceEvent {
  kind: RaceEventKind;
  t: number;
  boatId?: string;
  rank?: number; // finish events carry the place taken
}

export interface RaceResult {
  boatId: string;
  rank: number;
  elapsed: number; // s from gun to line
}

export interface RaceData {
  seed: number;
  tMin: number; // first fix time (start of the prestart window)
  tMax: number; // last fix time (a beat after the final finisher)
  course: Course;
  wind: WindSample[]; // WIND_HZ
  boats: BoatMeta[];
  fixes: Record<string, Fix[]>; // per boat id, FIX_HZ
  progress: Record<string, ProgressSample[]>; // per boat id, PROGRESS_HZ
  events: RaceEvent[];
  results: RaceResult[];
}

/* poseAt writes into a caller-owned Pose so the render loop never allocates. */
export interface Pose {
  x: number;
  y: number;
  hdg: number;
  heel: number;
  twa: number;
  sog: number;
  cog: number;
  kite: number;
}

export type ReplayMode = "smooth" | "raw";

export type RigName = "chase" | "tv" | "tactical";

export interface StandingsRow {
  boatId: string;
  rank: number;
  leg: LegName;
  gapMeters: number;
  gapSeconds: number;
  finished: boolean;
}
