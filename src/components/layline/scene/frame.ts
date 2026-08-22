/**
 * What the hulls worked out this frame, for whatever draws after them. The
 * wakes need the boat's speed and the height of the water under it, and both
 * were already computed at priority -80; recomputing them at -70 would be a
 * second answer to the same question and the two would drift apart the first
 * time either side was retuned.
 */
export interface BoatFrame {
  /* World xz of the stem, which is where the wake is laid down. */
  bowX: number;
  bowZ: number;
  /* Unit heading in world xz, and the same vector turned to starboard. */
  headX: number;
  headZ: number;
  sog: number;
  surface: number;
}

export const fleetFrame: BoatFrame[] = [];

export function sizeFleetFrame(count: number): void {
  while (fleetFrame.length < count) {
    fleetFrame.push({ bowX: 0, bowZ: 0, headX: 0, headZ: -1, sog: 0, surface: 0 });
  }
  fleetFrame.length = count;
}
