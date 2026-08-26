/**
 * Display edge. Every numeral on screen crosses exactly one of these, so SI
 * stays SI everywhere upstream and a number can only be wrong in one place.
 *
 * These return bare figures because the unit belongs to the dock label beside
 * them. The one exception is a gap, where the unit is part of the reading: a
 * bare "+12" in a standings column reads as metres just as easily as seconds.
 *
 * A value that is not a number renders MISSING. Never a zero, never a guess.
 */
import type { LegName } from "./types";

export const MISSING = "-";

const MPS_TO_KNOTS = 3600 / 1852;

function finiteScaled(value: number, scale: number): boolean {
  return Number.isFinite(value) && Number.isFinite(value * scale);
}

/** m/s in, knots to one decimal out. */
export function knots(mps: number): string {
  if (!finiteScaled(mps, MPS_TO_KNOTS)) return MISSING;
  const converted = mps * MPS_TO_KNOTS;
  if (!finiteScaled(converted, 10)) return MISSING;
  const s = converted.toFixed(1);
  return s === "-0.0" ? "0.0" : s;
}

/**
 * Metres to one decimal. A boat sits a couple of hull lengths off the line in
 * the last seconds of a prestart, so whole metres would round the reading that
 * decides the start away.
 */
export function meters(m: number): string {
  if (!finiteScaled(m, 10)) return MISSING;
  const s = m.toFixed(1);
  return s === "-0.0" ? "0.0" : s;
}

/**
 * A short elapsed, two decimals. Margins at a start line live in hundredths:
 * the three shipped races put their first hull across 0.11 s, 0.16 s and
 * 0.24 s after the gun, and clock() rounds all three to 0:00.
 */
export function seconds(s: number): string {
  if (!Number.isFinite(s)) return MISSING;
  const v = s.toFixed(2);
  return v === "-0.00" ? "0.00" : v;
}

/** Signed metres to one decimal. Display-rounded zero is always positive. */
export function signedMeters(m: number): string {
  if (!finiteScaled(m, 10)) return MISSING;
  const scaled = m * 10;
  const rounded = Math.round(scaled) / 10;
  if (!Number.isFinite(rounded)) return MISSING;
  const magnitude = Math.abs(rounded).toFixed(1);
  return `${rounded < 0 ? "-" : "+"}${magnitude}`;
}

/** Signed m/s to two decimals. Display-rounded zero is always positive. */
export function signedMetersPerSecond(mps: number): string {
  if (!finiteScaled(mps, 100)) return MISSING;
  const scaled = mps * 100;
  const rounded = Math.round(scaled) / 100;
  if (!Number.isFinite(rounded)) return MISSING;
  const magnitude = Math.abs(rounded).toFixed(2);
  return `${rounded < 0 ? "-" : "+"}${magnitude}`;
}

/** Degrees to the nearest whole degree, signed for twa, unsigned for bearings. */
export function deg(a: number): string {
  if (!Number.isFinite(a)) return MISSING;
  const r = Math.round(a);
  if (r === 0) return "0";
  /* Bearings live in [0, 360), so one that rounds up to a full circle reads as
   * the north the data actually holds. */
  if (r === 360 && a < 360) return "0";
  return String(r);
}

/** Evidence clock to hundredths, with carries resolved before decomposition. */
export function fixStamp(t: number): string {
  if (!finiteScaled(t, 100)) return MISSING;
  const signedHundredths = Math.round(t * 100);
  if (!Number.isFinite(signedHundredths)) return MISSING;
  const sign = signedHundredths < 0 ? "-" : "+";
  const hundredths = Math.abs(signedHundredths);
  const minutes = Math.floor(hundredths / 6000);
  const minuteHundredths = minutes * 6000;
  if (!Number.isFinite(minutes) || !Number.isFinite(minuteHundredths)) return MISSING;
  const seconds = (hundredths - minuteHundredths) / 100;
  if (!Number.isFinite(seconds)) return MISSING;
  return `T${sign}${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
}

/** Unsigned heading to one decimal, wrapped after display-precision rounding. */
export function heading(value: number): string {
  if (!finiteScaled(value, 10)) return MISSING;
  const roundedTenths = Math.round(value * 10);
  const wrappedTenths = ((roundedTenths % 3600) + 3600) % 3600;
  return `${(wrappedTenths / 10).toFixed(1)}°`;
}

/**
 * Race clock, m:ss against the gun at zero. The prestart counts down, so a
 * part second still reads as the second remaining: -0:00 would claim the gun
 * had already fired.
 */
export function clock(t: number): string {
  if (!Number.isFinite(t)) return MISSING;
  const before = t < 0;
  const whole = before ? Math.ceil(-t) : Math.floor(t);
  const m = Math.floor(whole / 60);
  const minuteSeconds = m * 60;
  if (!Number.isFinite(whole) || !Number.isFinite(m) || !Number.isFinite(minuteSeconds)) {
    return MISSING;
  }
  const s = whole - minuteSeconds;
  if (!Number.isFinite(s)) return MISSING;
  return `${before ? "-" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
}

/**
 * Standings gap. Nobody trails anybody before the gun, so the prestart reads
 * MISSING rather than a gap measured against a line no one has crossed.
 *
 * Under ten seconds the tenth is the reading. This fleet spends the beat
 * inside half a second of itself, and whole seconds put five of the six rows
 * on the same "+0 s" while the lead was actually changing hands. Ten seconds
 * up, the tenth is noise against the number beside it and the column reads
 * whole.
 */
export function gap(row: { rank: number; leg: LegName; gapSeconds: number }): string {
  if (row.leg === "prestart") return MISSING;
  if (!Number.isFinite(row.rank) || !finiteScaled(row.gapSeconds, 10)) return MISSING;
  if (row.rank <= 1) return "LDR";
  const tenths = Math.round(row.gapSeconds * 10) / 10;
  if (tenths >= 10) return `+${Math.round(row.gapSeconds)} s`;
  const reading = tenths.toFixed(1);
  return `+${reading === "-0.0" ? "0.0" : reading} s`;
}
