import type { DerivedVelocity } from "./velocity";
import type { Vec2 } from "./types";

const SOURCE_SCALE = 1_000_000_000_000;
const DEG = Math.PI / 180;
const ZERO_VECTOR_MPS = 1e-12;

function positiveZero(value: number): number {
  return value === 0 ? 0 : value;
}

/* Only results from implementation-dependent Math functions cross this
 * boundary. Ordinary IEEE arithmetic and simulator recurrence stay raw. */
function canonicalSource(value: number): number {
  if (!Number.isFinite(value)) return value;
  const canonical = Math.round(value * SOURCE_SCALE) / SOURCE_SCALE;
  return positiveZero(canonical);
}

export function simulationExp(value: number): number {
  return canonicalSource(Math.exp(value));
}

export function simulationLog(value: number): number {
  return canonicalSource(Math.log(value));
}

export function simulationSqrt(value: number): number {
  return canonicalSource(Math.sqrt(value));
}

export function simulationAcos(value: number): number {
  return canonicalSource(Math.acos(value));
}

export function simulationAtan2(y: number, x: number): number {
  return canonicalSource(Math.atan2(y, x));
}

export function simulationHypot(...values: number[]): number {
  return canonicalSource(Math.hypot(...values));
}

/* Quadrant reduction keeps the established course-vector polynomial inside
 * [-pi/4, pi/4]. It also gives the current field deterministic sine/cosine
 * sources without relying on an engine's native transcendental library. */
function simulationSinCos(radians: number): { sin: number; cos: number } {
  if (!Number.isFinite(radians)) return { sin: NaN, cos: NaN };
  const quarterTurns = Math.round(radians / (Math.PI / 2));
  const quadrant = ((quarterTurns % 4) + 4) % 4;
  const x = radians - quarterTurns * (Math.PI / 2);
  const x2 = x * x;
  const sine = x * (
    1 + x2 * (
      -1 / 6 + x2 * (
        1 / 120 + x2 * (
          -1 / 5040 + x2 * (
            1 / 362880 + x2 * (
              -1 / 39916800 + x2 * (1 / 6227020800 - x2 / 1307674368000)
            )
          )
        )
      )
    )
  );
  const cosine = 1 + x2 * (
    -1 / 2 + x2 * (
      1 / 24 + x2 * (
        -1 / 720 + x2 * (
          1 / 40320 + x2 * (
            -1 / 3628800 + x2 * (1 / 479001600 - x2 / 87178291200)
          )
        )
      )
    )
  );
  if (quadrant === 0) return { sin: positiveZero(sine), cos: positiveZero(cosine) };
  if (quadrant === 1) return { sin: positiveZero(cosine), cos: positiveZero(-sine) };
  if (quadrant === 2) return { sin: positiveZero(-sine), cos: positiveZero(-cosine) };
  return { sin: positiveZero(-cosine), cos: positiveZero(sine) };
}

export function simulationSin(radians: number): number {
  return simulationSinCos(radians).sin;
}

export function simulationCos(radians: number): number {
  return simulationSinCos(radians).cos;
}

function wrap360(angle: number): number {
  const wrapped = angle % 360;
  return positiveZero(wrapped < 0 ? wrapped + 360 : wrapped);
}

export function simulationCourseUnitVector<T extends Partial<Vec2>>(course: number, out: T): T & Vec2 {
  if (!Number.isFinite(course)) throw new RangeError("course must be finite");
  const wrapped = wrap360(course);
  const unit = simulationSinCos(wrapped * DEG);
  (out as T & Vec2).x = unit.sin;
  (out as T & Vec2).y = unit.cos;
  return out as T & Vec2;
}

export function simulationVectorFromSpeedCourse<T extends Partial<Vec2>>(
  speed: number,
  course: number,
  out: T,
): T & Vec2 {
  if (!Number.isFinite(speed) || !Number.isFinite(course)) {
    throw new RangeError("speed and course must be finite");
  }
  if (speed < 0) throw new RangeError("speed must be non-negative");
  const unit = simulationCourseUnitVector(course, { x: 0, y: 0 });
  const x = speed * unit.x;
  const y = speed * unit.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError("component conversion overflowed");
  }
  (out as T & Vec2).x = positiveZero(x);
  (out as T & Vec2).y = positiveZero(y);
  return out as T & Vec2;
}

function simulationCourseFromVector(x: number, y: number): number | null {
  const speed = simulationHypot(x, y);
  if (!Number.isFinite(speed)) throw new RangeError("vector magnitude overflowed");
  return speed <= ZERO_VECTOR_MPS ? null : wrap360(simulationAtan2(x, y) / DEG);
}

export function simulationVelocityFromComponents<T extends Partial<DerivedVelocity>>(
  waterX: number,
  waterY: number,
  currentX: number,
  currentY: number,
  out: T,
): T & DerivedVelocity {
  if (![waterX, waterY, currentX, currentY].every(Number.isFinite)) {
    throw new RangeError("velocity components must be finite");
  }
  const groundX = positiveZero(waterX + currentX);
  const groundY = positiveZero(waterY + currentY);
  const stw = simulationHypot(waterX, waterY);
  const currentDrift = simulationHypot(currentX, currentY);
  const sog = simulationHypot(groundX, groundY);
  if (![groundX, groundY, stw, currentDrift, sog].every(Number.isFinite)) {
    throw new RangeError("velocity derivation overflowed");
  }
  Object.assign(out, {
    waterX: positiveZero(waterX),
    waterY: positiveZero(waterY),
    currentX: positiveZero(currentX),
    currentY: positiveZero(currentY),
    stw: positiveZero(stw),
    ctw: simulationCourseFromVector(waterX, waterY),
    currentDrift: positiveZero(currentDrift),
    currentSet: simulationCourseFromVector(currentX, currentY),
    groundX,
    groundY,
    sog: positiveZero(sog),
    cog: simulationCourseFromVector(groundX, groundY),
  });
  return out as T & DerivedVelocity;
}
