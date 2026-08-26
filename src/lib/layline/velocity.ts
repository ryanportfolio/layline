import type { Vec2 } from "./types";

const DEG = Math.PI / 180;
const ZERO_VECTOR_MPS = 1e-12;
const LEEWAY_MAX_DEGREES = 4;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function positiveZero(value: number): number {
  return value === 0 ? 0 : value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/* The hot paths through this module (a layline trace runs tens of thousands
 * of angle evaluations per surface build, and poseAt derives a velocity every
 * frame for every boat) allocate nothing: the unit vector below is written
 * into one module scratch that every caller reads before the next call can
 * overwrite it, and velocityFromComponents assigns fields directly instead of
 * building a literal. Same operations, same order, no garbage. */
const UNIT_SCRATCH: Vec2 = { x: 0, y: 0 };

function unitVectorFromCourse(course: number): Vec2 {
  const wrapped = wrap360(course);
  const out = UNIT_SCRATCH;
  if (wrapped === 0) {
    out.x = 0;
    out.y = 1;
  } else if (wrapped === 90) {
    out.x = 1;
    out.y = 0;
  } else if (wrapped === 180) {
    out.x = 0;
    out.y = -1;
  } else if (wrapped === 270) {
    out.x = -1;
    out.y = 0;
  } else {
    const radians = wrapped * DEG;
    out.x = positiveZero(Math.sin(radians));
    out.y = positiveZero(Math.cos(radians));
  }
  return out;
}

export function wrap360(angle: number): number {
  finite(angle, "angle");
  const wrapped = angle % 360;
  return positiveZero(wrapped < 0 ? wrapped + 360 : wrapped);
}

export function wrapSigned(angle: number): number {
  return positiveZero(wrap360(angle + 180) - 180);
}

export function courseFromVector(x: number, y: number): number | null {
  finite(x, "vector x");
  finite(y, "vector y");
  const speed = Math.hypot(x, y);
  if (!Number.isFinite(speed)) throw new RangeError("vector magnitude overflowed");
  return speed <= ZERO_VECTOR_MPS ? null : wrap360(Math.atan2(x, y) / DEG);
}

export function vectorFromSpeedCourse<T extends Partial<Vec2>>(
  speed: number,
  course: number,
  out: T,
): T & Vec2 {
  finite(speed, "speed");
  finite(course, "course");
  if (speed < 0) throw new RangeError("speed must be non-negative");
  /* The raw unit vector: courseUnitVector would only re-apply positiveZero to
   * components that already carry it, at the price of a throwaway object. */
  const unit = unitVectorFromCourse(course);
  const x = speed * unit.x;
  const y = speed * unit.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError("component conversion overflowed");
  (out as T & Vec2).x = positiveZero(x);
  (out as T & Vec2).y = positiveZero(y);
  return out as T & Vec2;
}

export function courseUnitVector<T extends Partial<Vec2>>(
  course: number,
  out: T,
): T & Vec2 {
  finite(course, "course");
  const unit = unitVectorFromCourse(course);
  (out as T & Vec2).x = positiveZero(unit.x);
  (out as T & Vec2).y = positiveZero(unit.y);
  return out as T & Vec2;
}

export interface VelocityProjection {
  water: number;
  current: number;
  ground: number;
}

/** Signed component of a course-frame velocity vector along a bearing. */
export function projectVelocityOntoBearing(x: number, y: number, bearing: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(bearing)) return null;
  const unit = unitVectorFromCourse(bearing);
  const projection = x * unit.x + y * unit.y;
  return Number.isFinite(projection) ? positiveZero(projection) : null;
}

/**
 * Water, current, and ground projections with one exact additive boundary.
 * Ground derives from the two projected component legs rather than a second
 * dot product, so every valid result closes exactly.
 */
export function projectVelocityComponentsOntoBearing(
  waterX: number,
  waterY: number,
  currentX: number,
  currentY: number,
  bearing: number,
): VelocityProjection | null {
  const water = projectVelocityOntoBearing(waterX, waterY, bearing);
  const current = projectVelocityOntoBearing(currentX, currentY, bearing);
  if (water === null || current === null) return null;
  const ground = water + current;
  if (!Number.isFinite(ground)) return null;
  return {
    water: positiveZero(water),
    current: positiveZero(current),
    ground: positiveZero(ground),
  };
}

export function windAxisVmgFromComponents(
  waterX: number,
  waterY: number,
  currentX: number,
  currentY: number,
  twd: number,
): VelocityProjection | null {
  return projectVelocityComponentsOntoBearing(waterX, waterY, currentX, currentY, twd);
}

export function leewayDegrees(twa: number): number {
  finite(twa, "true wind angle");
  const absolute = Math.abs(twa);
  const value =
    LEEWAY_MAX_DEGREES *
    clamp(twa / 12, -1, 1) *
    clamp((70 - absolute) / 50, 0, 1);
  return positiveZero(value);
}

export interface WaterCourse {
  twa: number;
  leeway: number;
  ctw: number;
}

export function waterCourseFromHeading(twd: number, heading: number): WaterCourse {
  const twa = wrapSigned(finite(twd, "true wind direction") - finite(heading, "heading"));
  const leeway = leewayDegrees(twa);
  return { twa, leeway, ctw: wrap360(heading - leeway) };
}

export interface DerivedVelocity {
  waterX: number;
  waterY: number;
  currentX: number;
  currentY: number;
  stw: number;
  ctw: number | null;
  currentDrift: number;
  currentSet: number | null;
  groundX: number;
  groundY: number;
  sog: number;
  cog: number | null;
}

export function velocityFromComponents<T extends Partial<DerivedVelocity>>(
  waterX: number,
  waterY: number,
  currentX: number,
  currentY: number,
  out: T,
): T & DerivedVelocity {
  finite(waterX, "water x");
  finite(waterY, "water y");
  finite(currentX, "current x");
  finite(currentY, "current y");
  const groundX = waterX + currentX;
  const groundY = waterY + currentY;
  const stw = Math.hypot(waterX, waterY);
  const currentDrift = Math.hypot(currentX, currentY);
  const sog = Math.hypot(groundX, groundY);
  if (
    !Number.isFinite(groundX) || !Number.isFinite(groundY) || !Number.isFinite(stw) ||
    !Number.isFinite(currentDrift) || !Number.isFinite(sog)
  ) {
    throw new RangeError("velocity derivation overflowed");
  }
  const rawCtw = courseFromVector(waterX, waterY);
  const rawCurrentSet = courseFromVector(currentX, currentY);
  const rawCog = courseFromVector(groundX, groundY);
  const derived = out as T & DerivedVelocity;
  derived.waterX = positiveZero(waterX);
  derived.waterY = positiveZero(waterY);
  derived.currentX = positiveZero(currentX);
  derived.currentY = positiveZero(currentY);
  derived.stw = positiveZero(stw);
  derived.ctw = rawCtw;
  derived.currentDrift = positiveZero(currentDrift);
  derived.currentSet = rawCurrentSet;
  derived.groundX = positiveZero(groundX);
  derived.groundY = positiveZero(groundY);
  derived.sog = positiveZero(sog);
  derived.cog = rawCog;
  return derived;
}
