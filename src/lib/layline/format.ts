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

/** m/s in, knots to one decimal out. */
export function knots(mps: number): string {
  if (!Number.isFinite(mps)) return MISSING;
  const s = (mps * MPS_TO_KNOTS).toFixed(1);
  return s === "-0.0" ? "0.0" : s;
}

/**
 * Metres to one decimal. A boat sits a couple of hull lengths off the line in
 * the last seconds of a prestart, so whole metres would round the reading that
 * decides the start away.
 */
export function meters(m: number): string {
  if (!Number.isFinite(m)) return MISSING;
  const s = m.toFixed(1);
  return s === "-0.0" ? "0.0" : s;
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
  const s = whole - m * 60;
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
  if (!Number.isFinite(row.gapSeconds)) return MISSING;
  if (row.rank <= 1) return "LDR";
  const tenths = Math.round(row.gapSeconds * 10) / 10;
  if (tenths >= 10) return `+${Math.round(row.gapSeconds)} s`;
  const reading = tenths.toFixed(1);
  return `+${reading === "-0.0" ? "0.0" : reading} s`;
}
