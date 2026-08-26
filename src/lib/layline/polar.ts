export interface PolarModel {
  kind: string;
  version: number;
  provenance: string;
  twaDegrees: readonly number[];
  speedFractions: readonly number[];
  lowTailAngleDegrees: number;
  lowTailFraction: number;
  highTailAngleDegrees: number;
  highTailFraction: number;
  highTailDropFraction: number;
}

export const FICTIONAL_ONE_DESIGN_POLAR: Readonly<PolarModel> = Object.freeze({
  kind: "fictional-one-design-polar-v1",
  version: 1,
  provenance: "seeded-model",
  twaDegrees: Object.freeze([30, 44, 60, 90, 110, 140, 165]),
  speedFractions: Object.freeze([0.15, 0.8, 0.95, 1.1, 1.15, 1.15, 0.85]),
  lowTailAngleDegrees: 0,
  lowTailFraction: 0,
  highTailAngleDegrees: 180,
  highTailFraction: 0.75,
  highTailDropFraction: 0.1,
});

/* A layline trace asks about the same model object six figures of times per
 * surface build, and the structural walk below spreads both tables into a
 * fresh array per call. The verdict is a property of the object, so it is
 * computed once per object and remembered; a model mutated after its first
 * validation keeps its first verdict, which no runtime path does (the shipped
 * model and every trace snapshot are frozen). */
const MODEL_VERDICTS = new WeakMap<object, boolean>();

function validModel(model: PolarModel): boolean {
  const cacheable = typeof model === "object" && model !== null;
  if (cacheable) {
    const known = MODEL_VERDICTS.get(model);
    if (known !== undefined) return known;
  }
  const verdict = modelVerdict(model);
  if (cacheable) MODEL_VERDICTS.set(model, verdict);
  return verdict;
}

function modelVerdict(model: PolarModel): boolean {
  if (!model || !Number.isSafeInteger(model.version) || typeof model.kind !== "string" || typeof model.provenance !== "string") return false;
  if (!Array.isArray(model.twaDegrees) || !Array.isArray(model.speedFractions) || model.twaDegrees.length !== model.speedFractions.length || model.twaDegrees.length < 2) return false;
  const values = [...model.twaDegrees, ...model.speedFractions, model.lowTailAngleDegrees, model.lowTailFraction, model.highTailAngleDegrees, model.highTailFraction, model.highTailDropFraction];
  if (!values.every(Number.isFinite)) return false;
  if (!(model.lowTailAngleDegrees < model.twaDegrees[0] && model.twaDegrees.at(-1)! < model.highTailAngleDegrees)) return false;
  for (let index = 1; index < model.twaDegrees.length; index++) if (!(model.twaDegrees[index - 1] < model.twaDegrees[index])) return false;
  return true;
}

function finiteFraction(value: number): number | null {
  return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
}

export function polarFraction(model: PolarModel, twaAbs: number): number | null {
  if (!validModel(model) || !Number.isFinite(twaAbs)) return null;
  const angles = model.twaDegrees;
  const fractions = model.speedFractions;
  const a = Math.max(model.lowTailAngleDegrees, Math.min(model.highTailAngleDegrees, twaAbs));
  if (a <= angles[0]) {
    if (model.lowTailAngleDegrees === 0 && model.lowTailFraction === 0) {
      return finiteFraction((a / angles[0]) * fractions[0]);
    }
    const amount = (a - model.lowTailAngleDegrees) / (angles[0] - model.lowTailAngleDegrees);
    return finiteFraction(model.lowTailFraction + amount * (fractions[0] - model.lowTailFraction));
  }
  const last = angles.length - 1;
  if (a >= angles[last]) {
    const amount = (a - angles[last]) / (model.highTailAngleDegrees - angles[last]);
    return finiteFraction(fractions[last] - amount * model.highTailDropFraction);
  }
  let index = 0;
  while (index < last - 1 && a > angles[index + 1]) index++;
  const x0 = angles[index];
  const x1 = angles[index + 1];
  const y0 = fractions[index];
  const y1 = fractions[index + 1];
  const xm = index > 0 ? angles[index - 1] : x0 - (x1 - x0);
  const ym = index > 0 ? fractions[index - 1] : y0 - (y1 - y0);
  const xp = index + 2 <= last ? angles[index + 2] : x1 + (x1 - x0);
  const yp = index + 2 <= last ? fractions[index + 2] : y1 + (y1 - y0);
  const h = x1 - x0;
  const m0 = ((y1 - ym) / (x1 - xm)) * h;
  const m1 = ((yp - y0) / (xp - x0)) * h;
  const s = (a - x0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const value =
    (2 * s3 - 3 * s2 + 1) * y0 +
    (s3 - 2 * s2 + s) * m0 +
    (-2 * s3 + 3 * s2) * y1 +
    (s3 - s2) * m1;
  return finiteFraction(value);
}

export function targetBoatSpeed(model: PolarModel, tws: number, twaAbs: number): number | null {
  if (!Number.isFinite(tws) || tws < 0) return null;
  const fraction = polarFraction(model, twaAbs);
  if (fraction === null) return null;
  const target = fraction * tws;
  return Number.isFinite(target) ? (target === 0 ? 0 : target) : null;
}

export function isBeatTwaAbs(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 90;
}

export function isRunTwaAbs(value: number): boolean {
  return Number.isFinite(value) && value > 90 && value <= 180;
}

export function normalizeDeclaredTwaAbs(leg: "beat" | "run", value: number): number | null {
  const valid = leg === "beat" ? isBeatTwaAbs(value) : isRunTwaAbs(value);
  return valid ? (value === 0 ? 0 : value) : null;
}

function exactNumber(value: number): string {
  return Object.is(value, -0) ? "-0" : value.toString();
}

export function polarModelFingerprint(model: PolarModel): string {
  if (!validModel(model)) return "invalid-polar-model";
  return [
    model.kind, exactNumber(model.version), model.provenance,
    model.twaDegrees.map(exactNumber).join(","), model.speedFractions.map(exactNumber).join(","),
    exactNumber(model.lowTailAngleDegrees), exactNumber(model.lowTailFraction),
    exactNumber(model.highTailAngleDegrees), exactNumber(model.highTailFraction),
    exactNumber(model.highTailDropFraction),
  ].join("|");
}
