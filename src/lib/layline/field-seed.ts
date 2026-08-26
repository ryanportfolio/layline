/** Stable, stateless labeled field draw. Labels isolate unrelated field parameters. */
export const FIELD_SEED_ALGORITHM = "fnv1a32-mix-v1";

function hashLabel(label: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < label.length; index++) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededUnit(seed: number, label: string): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("field seed must be an unsigned 32-bit integer");
  }
  if (typeof label !== "string" || label.length === 0) {
    throw new RangeError("field seed label must be a non-empty string");
  }
  let value = (seed >>> 0) ^ hashLabel(label) ^ 0x9e3779b9;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  value = (value ^ (value >>> 15)) >>> 0;
  return value / 4294967296;
}
