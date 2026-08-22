/**
 * The shared drawing frame for both chart views: the static fallback and the
 * live 2D mode. One sampler, one fitted box, so the two drawings are the same
 * course at the same scale and the mode switch is a change of what moves, not
 * a change of what is being looked at.
 *
 * The course frame puts +y up the beat, so the drawing negates y to get the
 * screen's downward axis. Everything else is metres, one to one.
 */
import { poseAt } from "@/lib/layline/interpolate";
import type { BoatMeta, Pose, RaceData } from "@/lib/layline/types";

export const SAMPLE_STEP = 1; // s between samples, the chart's own frame rate
export const PAD = 34; // m of open water left around the fitted tracks

export interface ChartTrack {
  boat: BoatMeta;
  /** x, -y pairs in metres. */
  points: number[];
  /** Race time of each point, same order. */
  times: number[];
  /** Arc length in metres from the first point to each one. */
  lengths: Float64Array;
}

export interface ChartFrame {
  viewBox: string;
  minX: number;
  maxX: number;
  tracks: ChartTrack[];
}

function newPose(): Pose {
  return { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
}

function sampleTrack(race: RaceData, boatId: string, pose: Pose): ChartTrack {
  const points: number[] = [];
  const times: number[] = [];
  const fixes = race.fixes[boatId];
  const boat = race.boats.find((entry) => entry.id === boatId) as BoatMeta;
  if (fixes === undefined || fixes.length === 0) {
    return { boat, points, times, lengths: new Float64Array(0) };
  }
  const last = fixes[fixes.length - 1].t;
  for (let t = fixes[0].t; t < last; t += SAMPLE_STEP) {
    poseAt(race, boatId, t, "smooth", pose);
    points.push(pose.x, -pose.y);
    times.push(t);
  }
  poseAt(race, boatId, last, "smooth", pose);
  points.push(pose.x, -pose.y);
  times.push(last);

  /* Measured along the same polyline the path is drawn from, so a dash length
   * taken from here reveals exactly the stretch the boat has sailed. */
  const lengths = new Float64Array(times.length);
  for (let i = 1; i < times.length; i++) {
    const dx = points[i * 2] - points[i * 2 - 2];
    const dy = points[i * 2 + 1] - points[i * 2 - 1];
    lengths[i] = lengths[i - 1] + Math.hypot(dx, dy);
  }
  return { boat, points, times, lengths };
}

export function toPath(points: number[]): string {
  let d = "";
  for (let i = 0; i < points.length; i += 2) {
    d += `${i === 0 ? "M" : "L"}${points[i].toFixed(1)} ${points[i + 1].toFixed(1)}`;
  }
  return d;
}

/** Every track sampled once a second, fitted into one box with the course. */
export function chartFrame(race: RaceData): ChartFrame {
  const pose = newPose();
  const tracks = race.boats.map((boat) => sampleTrack(race, boat.id, pose));

  const { course } = race;
  let minX = Math.min(course.startPin.x, course.startBoat.x, course.windward.x - course.zoneRadius);
  let maxX = Math.max(course.startPin.x, course.startBoat.x, course.windward.x + course.zoneRadius);
  let minY = -course.windward.y - course.zoneRadius;
  let maxY = 0;
  for (const track of tracks) {
    for (let i = 0; i < track.points.length; i += 2) {
      const x = track.points[i];
      const y = track.points[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const viewBox = [
    (minX - PAD).toFixed(1),
    (minY - PAD).toFixed(1),
    (maxX - minX + PAD * 2).toFixed(1),
    (maxY - minY + PAD * 2).toFixed(1),
  ].join(" ");

  return { viewBox, minX, maxX, tracks };
}

/**
 * The arc length a boat has sailed by t, interpolated between the samples the
 * track was drawn from. Clamped at both ends: before the feed starts nothing
 * is drawn, after it ends the whole track is.
 */
export function lengthAt(track: ChartTrack, t: number): number {
  const times = track.times;
  const n = times.length;
  if (n === 0) return 0;
  if (t <= times[0]) return 0;
  const total = track.lengths[n - 1];
  if (t >= times[n - 1]) return total;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const u = span > 0 ? (t - times[lo]) / span : 0;
  return track.lengths[lo] + (track.lengths[hi] - track.lengths[lo]) * u;
}
