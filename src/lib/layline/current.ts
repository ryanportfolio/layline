import { seededUnit } from "./field-seed";
import { simulationCos, simulationHypot, simulationSin } from "./simulation-math";
import type { Course, Vec2 } from "./types";

export const CURRENT_FIELD_MAX_SPEED_MPS = 0.55;

export interface CurrentFieldSpec {
  kind: "layline-current-field-v1";
  version: 1;
  provenance: "seeded-field";
  seed: number;
  halfWidthMeters: number;
  lengthMeters: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  phase1Radians: number;
  phase2Radians: number;
  lineMeanFraction: number;
  lineOscillationFraction: number;
  linePeriodSeconds: number;
  transitionHalfWidthFraction: number;
  xBaseMps: number;
  xAcrossCoefficientMps: number;
  xTimeAmplitudeMps: number;
  xTimePeriodSeconds: number;
  xShearAmplitudeMps: number;
  yBaseMps: number;
  yAlongCoefficientMps: number;
  yAlongCenter: number;
  yTimeAmplitudeMps: number;
  yTimePeriodSeconds: number;
}

export interface CurrentFieldSample extends Vec2 {
  provenance: "seeded-field";
}

const TRUSTED_CURRENT_FIELD_SPECS = new WeakSet<object>();

function finalizeCurrentFieldSpec(spec: CurrentFieldSpec): CurrentFieldSpec {
  Object.freeze(spec);
  TRUSTED_CURRENT_FIELD_SPECS.add(spec);
  return spec;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

export function createCurrentFieldSpec(seed: number, course: Course): CurrentFieldSpec {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("current seed must be an unsigned 32-bit integer");
  }
  const canonicalSeed = seed === 0 ? 0 : seed;
  finite(course.startPin.x, "course.startPin.x");
  finite(course.startPin.y, "course.startPin.y");
  finite(course.startBoat.x, "course.startBoat.x");
  finite(course.startBoat.y, "course.startBoat.y");
  finite(course.windward.x, "course.windward.x");
  finite(course.windward.y, "course.windward.y");
  finite(course.zoneRadius, "course.zoneRadius");
  return finalizeCurrentFieldSpec({
    kind: "layline-current-field-v1",
    version: 1,
    provenance: "seeded-field",
    seed: canonicalSeed,
    halfWidthMeters: Math.max(Math.abs(course.startPin.x), Math.abs(course.startBoat.x), 1),
    lengthMeters: Math.max(course.windward.y, 1),
    uMin: -1.5,
    uMax: 1.5,
    vMin: -0.25,
    vMax: 1.25,
    phase1Radians: 2 * Math.PI * seededUnit(canonicalSeed, "current.phase-1"),
    phase2Radians: 2 * Math.PI * seededUnit(canonicalSeed, "current.phase-2"),
    lineMeanFraction: 0.45,
    lineOscillationFraction: 0.1,
    linePeriodSeconds: 64,
    transitionHalfWidthFraction: 0.08,
    xBaseMps: 0.26,
    xAcrossCoefficientMps: 0.07,
    xTimeAmplitudeMps: 0.05,
    xTimePeriodSeconds: 48,
    xShearAmplitudeMps: 0.08,
    yBaseMps: -0.1,
    yAlongCoefficientMps: 0.04,
    yAlongCenter: 0.5,
    yTimeAmplitudeMps: 0.035,
    yTimePeriodSeconds: 61,
  });
}

const SPEC_NUMERIC_FIELDS: readonly (keyof CurrentFieldSpec)[] = [
  "seed", "halfWidthMeters", "lengthMeters", "uMin", "uMax", "vMin", "vMax",
  "phase1Radians", "phase2Radians", "lineMeanFraction", "lineOscillationFraction",
  "linePeriodSeconds", "transitionHalfWidthFraction", "xBaseMps", "xAcrossCoefficientMps",
  "xTimeAmplitudeMps", "xTimePeriodSeconds", "xShearAmplitudeMps", "yBaseMps",
  "yAlongCoefficientMps", "yAlongCenter", "yTimeAmplitudeMps", "yTimePeriodSeconds",
];

const SPEC_FIELDS: readonly (keyof CurrentFieldSpec)[] = [
  "kind", "version", "provenance", ...SPEC_NUMERIC_FIELDS,
];

const SPEC_FIELD_SET = new Set<PropertyKey>(SPEC_FIELDS);

/**
 * Capture the exact serialized v1 data shape without invoking candidate
 * properties. Accepted snapshots contain primitives only and are therefore
 * deeply inert once frozen.
 */
function snapshotCurrentFieldSpec(candidate: unknown): Readonly<CurrentFieldSpec> | null {
  try {
    if (candidate === null || typeof candidate !== "object") return null;
    if (Object.getPrototypeOf(candidate) !== Object.prototype) return null;

    const keys = Reflect.ownKeys(candidate);
    if (
      keys.length !== SPEC_FIELDS.length ||
      new Set(keys).size !== SPEC_FIELDS.length ||
      keys.some((key) => !SPEC_FIELD_SET.has(key))
    ) return null;

    const snapshot: Partial<Record<keyof CurrentFieldSpec, unknown>> = Object.create(null);
    for (const field of SPEC_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, field);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) return null;
      const value = descriptor.value;
      if (
        (field === "kind" || field === "provenance")
          ? typeof value !== "string"
          : typeof value !== "number"
      ) return null;
      snapshot[field] = value;
    }
    const serializedClone = structuredClone(candidate);
    if (
      serializedClone === null ||
      typeof serializedClone !== "object" ||
      Object.getPrototypeOf(serializedClone) !== Object.prototype
    ) return null;
    return Object.freeze(snapshot) as Readonly<CurrentFieldSpec>;
  } catch {
    return null;
  }
}

export type CurrentFieldSpecValidity =
  | { status: "valid"; analyticMaxSpeedMps: number }
  | { status: "invalid"; reason: string };

function analyticMaxSpeed(spec: CurrentFieldSpec): number {
  const xAtMin = spec.xBaseMps + spec.xAcrossCoefficientMps * spec.uMin;
  const xAtMax = spec.xBaseMps + spec.xAcrossCoefficientMps * spec.uMax;
  const xMagnitude =
    Math.max(Math.abs(xAtMin), Math.abs(xAtMax)) +
    Math.abs(spec.xTimeAmplitudeMps) +
    Math.abs(spec.xShearAmplitudeMps);
  const yAtMin = spec.yBaseMps + spec.yAlongCoefficientMps * (spec.vMin - spec.yAlongCenter);
  const yAtMax = spec.yBaseMps + spec.yAlongCoefficientMps * (spec.vMax - spec.yAlongCenter);
  const yMagnitude =
    Math.max(Math.abs(yAtMin), Math.abs(yAtMax)) + Math.abs(spec.yTimeAmplitudeMps);
  return simulationHypot(xMagnitude, yMagnitude);
}

/**
 * Validate the complete serialized field against the only canonical spec for
 * this race seed and course. This boundary never samples a convenient point:
 * every stored field and the analytic whole-domain speed ceiling must agree.
 */
export function currentFieldSpecValidity(
  candidate: unknown,
  seed: number,
  course: Course,
): CurrentFieldSpecValidity {
  try {
    const spec = snapshotCurrentFieldSpec(candidate);
    if (spec === null) {
      return { status: "invalid", reason: "serialized current field must be an object" };
    }
    const expected = createCurrentFieldSpec(seed, course);
    validateSpec(spec);
    for (const field of SPEC_FIELDS) {
      if (!Object.is(spec[field], expected[field])) {
        return { status: "invalid", reason: `serialized current field ${field} is not canonical` };
      }
    }
    const analyticMaxSpeedMps = analyticMaxSpeed(spec);
    if (
      !Number.isFinite(analyticMaxSpeedMps) ||
      analyticMaxSpeedMps > CURRENT_FIELD_MAX_SPEED_MPS
    ) {
      return { status: "invalid", reason: "serialized current field exceeds its analytic speed bound" };
    }
    return { status: "valid", analyticMaxSpeedMps };
  } catch {
    return { status: "invalid", reason: "serialized current field could not be validated" };
  }
}

function validateSpec(spec: CurrentFieldSpec): void {
  if (spec.kind !== "layline-current-field-v1" || spec.version !== 1 || spec.provenance !== "seeded-field") {
    throw new RangeError("unsupported current field spec");
  }
  for (const field of SPEC_NUMERIC_FIELDS) finite(spec[field] as number, `current spec ${field}`);
  if (!Number.isInteger(spec.seed) || Object.is(spec.seed, -0) || spec.seed < 0 || spec.seed > 0xffff_ffff) {
    throw new RangeError("current field seed must be an unsigned 32-bit integer");
  }
  if (!(spec.halfWidthMeters > 0 && spec.lengthMeters > 0)) throw new RangeError("current field scales must be positive");
  if (!(spec.uMin < spec.uMax && spec.vMin < spec.vMax)) throw new RangeError("current field domain is invalid");
  if (!(spec.linePeriodSeconds > 0 && spec.xTimePeriodSeconds > 0 && spec.yTimePeriodSeconds > 0 && spec.transitionHalfWidthFraction > 0)) {
    throw new RangeError("current field periods and transition width must be positive");
  }
}

export function sampleSeededCurrentField<T extends Vec2>(
  spec: CurrentFieldSpec,
  x: number,
  y: number,
  t: number,
  out: T,
): T & CurrentFieldSample {
  const inertSpec =
    spec !== null && typeof spec === "object" && TRUSTED_CURRENT_FIELD_SPECS.has(spec)
      ? spec
      : snapshotCurrentFieldSpec(spec);
  if (inertSpec === null) throw new RangeError("unsupported current field spec");
  validateSpec(inertSpec);
  finite(x, "current sample x");
  finite(y, "current sample y");
  finite(t, "current sample t");
  const u = clamp(x / inertSpec.halfWidthMeters, inertSpec.uMin, inertSpec.uMax);
  const v = clamp(y / inertSpec.lengthMeters, inertSpec.vMin, inertSpec.vMax);
  const yLine =
    inertSpec.lineMeanFraction * inertSpec.lengthMeters +
    inertSpec.lineOscillationFraction * inertSpec.lengthMeters *
      simulationSin((2 * Math.PI * t) / inertSpec.linePeriodSeconds + inertSpec.phase1Radians);
  const transition = smoothstep(
    -inertSpec.transitionHalfWidthFraction * inertSpec.lengthMeters,
    inertSpec.transitionHalfWidthFraction * inertSpec.lengthMeters,
    y - yLine,
  );
  const currentX =
    inertSpec.xBaseMps +
    inertSpec.xAcrossCoefficientMps * u +
    inertSpec.xTimeAmplitudeMps * simulationSin((2 * Math.PI * t) / inertSpec.xTimePeriodSeconds + inertSpec.phase1Radians) +
    inertSpec.xShearAmplitudeMps * (2 * transition - 1);
  const currentY =
    inertSpec.yBaseMps +
    inertSpec.yAlongCoefficientMps * (v - inertSpec.yAlongCenter) +
    inertSpec.yTimeAmplitudeMps * simulationCos((2 * Math.PI * t) / inertSpec.yTimePeriodSeconds + inertSpec.phase2Radians);
  if (!Number.isFinite(currentX) || !Number.isFinite(currentY) || simulationHypot(currentX, currentY) > CURRENT_FIELD_MAX_SPEED_MPS) {
    throw new RangeError("current field spec produced an out-of-contract vector");
  }
  out.x = currentX === 0 ? 0 : currentX;
  out.y = currentY === 0 ? 0 : currentY;
  (out as T & CurrentFieldSample).provenance = "seeded-field";
  return out as T & CurrentFieldSample;
}
