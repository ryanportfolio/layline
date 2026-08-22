/**
 * The line work a viewer reads the race off, and the one material that draws
 * all of it. Start line, laylines, ladder rungs, zone ring and boat tracks are
 * the same thing geometrically: a strip of water with a colour on it.
 *
 * Two rules hold the whole layer together. Every vertex rides the same Gerstner
 * surface the hulls float on, solved for the world column it was authored over
 * rather than for the base point the swell has since carried away, so a line
 * undulates with the sea instead of cutting through it. And every line carries
 * an explicit lift above that surface, because a strip drawn at the waterline
 * z-fights the water it is drawn on and vanishes into the next crest.
 *
 * Colour discipline is the broadcast one: amber for everything the wind owns,
 * which is the laylines, the ladder and the mark zone alike; ink for the line
 * once the gun has turned it from an instruction into a piece of the course;
 * boat hues for tracks. A fourth colour would put more graphics on screen than
 * water. The ladder sits under the laylines by alpha rather than by hue, which
 * is the separation a viewer reads anyway.
 */
import { shaderMaterial } from "@react-three/drei";
import { BufferAttribute, BufferGeometry, Color, Vector2, Vector3 } from "three";
import { legAt, poseAt, windAt } from "@/lib/layline/interpolate";
import type { BoatMeta, Pose, RaceData, ReplayMode, WindSample } from "@/lib/layline/types";
import { WAVE_GLSL } from "./waves";

const DEG = Math.PI / 180;

/* Height above the water, one value per class of line. They are ordered the way
 * a viewer reads them: the ladder is the faintest thing on the sea and the
 * start line is the one graphic that has to survive a crest in front of it. */
export const RUNG_LIFT = 0.1;
export const ZONE_LIFT = 0.15;
export const LAYLINE_LIFT = 0.2;
export const START_LIFT = 0.26;
export const TRACK_LIFT = 0.32;

/* Half widths in metres, and the alpha each class is drawn at. */
export const RUNG_HALF = 0.16;
export const ZONE_HALF = 0.22;
export const LAYLINE_HALF = 0.26;
export const START_HALF = 0.4;

export const RUNG_FADE = 0.22;
export const ZONE_FADE = 0.36;
export const LAYLINE_FADE = 0.66;
export const START_FADE = 0.88;

/* Wake foam and whitecaps run the same value as the line work drawn over them,
 * so a dash crossing a boat's wake loses its edges and a rung breaks. The
 * casing is a wider quad of the water's own deep colour under the line: on open
 * water it lands on the value it already is and changes nothing, and on foam it
 * puts a dark rule either side of the line, which is what the line is read off.
 * It sits a hair lower so the pair never argue about depth. */
export const CASE_DROP = 0.03;
export const RUNG_CASE_HALF = 0.42;
export const START_CASE_HALF = 0.9;
export const RUNG_CASE_FADE = 0.3;
export const START_CASE_FADE = 0.46;

const lineVertex = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uHeight;
uniform float uMinPx;

attribute vec2 aPerp;
attribute float aSpan;
attribute vec3 aColor;
attribute float aFade;
attribute float aTime;
attribute float aLife;

varying vec3 vColor;
varying float vAlpha;

${WAVE_GLSL}

void main() {
  float dist = distance(position, cameraPosition);
  /* Metres per drawn pixel at this depth. The second row of the projection is
     1 / tan(fov / 2), so this holds through the chase rig's speed-scaled field
     of view without anyone having to hand the field of view over. */
  float perPixel = dist * 2.0 / (projectionMatrix[1][1] * uHeight);
  /* Under about a pixel and a half a line stops being thin and starts being
     intermittent, so a far line is widened to keep it whole. What the widening
     buys in pixels it gives back in alpha, or a line would read heavier the
     further away it got. */
  float wide = max(abs(aSpan), uMinPx * 0.5 * perPixel);
  vec2 column = position.xz + aPerp * (wide * sign(aSpan));
  vec2 base = laylineColumn(column, uTime, uWind, cameraPosition.xz);
  vec3 disp;
  float jac;
  vec3 nrm;
  laylineWaves(base, uTime, uWind, length(base - cameraPosition.xz), disp, jac, nrm);
  vec3 world = vec3(column.x, disp.y + position.y, column.y);
  float age = max(uTime - aTime, 0.0);
  vColor = aColor;
  vAlpha = aFade * exp(-age * aLife) * (abs(aSpan) / wide);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const lineFragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main() {
  if (vAlpha < 0.005) discard;
  gl_FragColor = vec4(vColor, clamp(vAlpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const CourseLineMaterial = shaderMaterial(
  { uTime: 0, uWind: new Vector2(0, 1), uHeight: 900, uMinPx: 1.7 },
  lineVertex,
  lineFragment,
);

/* The raw lens draws fixes rather than a curve, so a dot is a billboard on the
 * water at the position one measurement reported. Same surface solve as the
 * lines above; the quad is turned to face the camera afterwards so a dot stays
 * a dot from the chase rig four metres off the sea. */
const dotVertex = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uRadius;
uniform float uLift;
uniform float uLife;
uniform float uHeight;
uniform float uMinPx;

attribute vec3 aDot;
attribute vec3 aColor;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vUv;

${WAVE_GLSL}

void main() {
  vec2 column = aDot.xy;
  vec2 base = laylineColumn(column, uTime, uWind, cameraPosition.xz);
  vec3 disp;
  float jac;
  vec3 nrm;
  laylineWaves(base, uTime, uWind, length(base - cameraPosition.xz), disp, jac, nrm);
  vec3 centre = vec3(column.x, disp.y + uLift, column.y);
  float dist = distance(centre, cameraPosition);
  float perPixel = dist * 2.0 / (projectionMatrix[1][1] * uHeight);
  float radius = max(uRadius, uMinPx * 0.5 * perPixel);
  vec3 world = centre + uRight * (position.x * radius) + uUp * (position.y * radius);
  vColor = aColor;
  vAlpha = exp(-max(uTime - aDot.z, 0.0) * uLife);
  vUv = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const dotFragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying vec2 vUv;

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  /* A rim rather than a soft edge. Softened all the way out the dots blur into
     one another at four a second and stop reading as separate measurements. */
  float alpha = vAlpha * (1.0 - smoothstep(0.78, 1.0, r));
  if (alpha < 0.005) discard;
  gl_FragColor = vec4(vColor * mix(1.0, 0.45, smoothstep(0.6, 0.92, r)), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const TrackDotMaterial = shaderMaterial(
  {
    uTime: 0,
    uWind: new Vector2(0, 1),
    uRight: new Vector3(1, 0, 0),
    uUp: new Vector3(0, 1, 0),
    uRadius: 0.4,
    uLift: TRACK_LIFT,
    uLife: 0.14,
    uHeight: 900,
    uMinPx: 2.4,
  },
  dotVertex,
  dotFragment,
);

export interface LineArrays {
  position: Float32Array;
  perp: Float32Array;
  span: Float32Array;
  color: Float32Array;
  fade: Float32Array;
  time: Float32Array;
  life: Float32Array;
}

export function lineArrays(verts: number): LineArrays {
  return {
    position: new Float32Array(verts * 3),
    perp: new Float32Array(verts * 2),
    span: new Float32Array(verts),
    color: new Float32Array(verts * 3),
    fade: new Float32Array(verts),
    time: new Float32Array(verts),
    life: new Float32Array(verts),
  };
}

/* BufferAttribute rather than the typed variants, which copy what they are
 * handed: a copy is a buffer the frame loop can never write to again. */
export function attachLineArrays(geometry: BufferGeometry, arrays: LineArrays): void {
  geometry.setAttribute("position", new BufferAttribute(arrays.position, 3));
  geometry.setAttribute("aPerp", new BufferAttribute(arrays.perp, 2));
  geometry.setAttribute("aSpan", new BufferAttribute(arrays.span, 1));
  geometry.setAttribute("aColor", new BufferAttribute(arrays.color, 3));
  geometry.setAttribute("aFade", new BufferAttribute(arrays.fade, 1));
  geometry.setAttribute("aTime", new BufferAttribute(arrays.time, 1));
  geometry.setAttribute("aLife", new BufferAttribute(arrays.life, 1));
}

export function markLineArrays(geometry: BufferGeometry): void {
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.aPerp.needsUpdate = true;
  geometry.attributes.aSpan.needsUpdate = true;
  geometry.attributes.aColor.needsUpdate = true;
  geometry.attributes.aFade.needsUpdate = true;
}

export interface LineBuffer {
  geometry: BufferGeometry;
  arrays: LineArrays;
  quads: number;
  cap: number;
}

/**
 * A pool of independent quads. The course lines are rewritten from scratch every
 * frame because the wind moves them every frame, so the geometry is sized once
 * for the worst case and the draw range does the talking.
 */
export function newLineBuffer(cap: number): LineBuffer {
  const arrays = lineArrays(cap * 4);
  const index: number[] = [];
  for (let q = 0; q < cap; q++) {
    const v = q * 4;
    index.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  const geometry = new BufferGeometry();
  attachLineArrays(geometry, arrays);
  geometry.setIndex(index);
  geometry.setDrawRange(0, 0);
  /* Course furniture spans the whole racecourse and the camera sits inside it,
   * so a bounding sphere would only ever say yes. */
  geometry.boundingSphere = null;
  return { geometry, arrays, quads: 0, cap };
}

export function resetLines(buffer: LineBuffer): void {
  buffer.quads = 0;
}

/** One straight span of line, world xz, with the strip laid across its heading. */
export function pushSegment(
  buffer: LineBuffer,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  lift: number,
  half: number,
  color: Color,
  fade: number,
): void {
  if (buffer.quads >= buffer.cap) return;
  const dx = bx - ax;
  const dz = bz - az;
  const run = Math.hypot(dx, dz);
  if (run < 1e-6) return;
  const px = -dz / run;
  const pz = dx / run;
  const arrays = buffer.arrays;
  const base = buffer.quads * 4;
  /* Corners run start-left, start-right, end-right, end-left, which is the
   * order the shared index buffer was wound for. */
  for (let corner = 0; corner < 4; corner++) {
    const far = corner >= 2;
    const v = base + corner;
    arrays.position[v * 3] = far ? bx : ax;
    arrays.position[v * 3 + 1] = lift;
    arrays.position[v * 3 + 2] = far ? bz : az;
    arrays.perp[v * 2] = px;
    arrays.perp[v * 2 + 1] = pz;
    arrays.span[v] = corner === 1 || corner === 2 ? half : -half;
    arrays.color[v * 3] = color.r;
    arrays.color[v * 3 + 1] = color.g;
    arrays.color[v * 3 + 2] = color.b;
    arrays.fade[v] = fade;
  }
  buffer.quads++;
}

/* A long line has to be broken up or its chord cuts under the swell it is
 * supposed to ride. The step is a wave length argument, not a pixel one: the
 * shortest octave in the sea state is 23 m, and a chord of a few metres across
 * it sags by a couple of centimetres, well inside the lift above. */
export function pushRun(
  buffer: LineBuffer,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  lift: number,
  half: number,
  color: Color,
  fade: number,
  step: number,
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const spans = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step));
  for (let i = 0; i < spans; i++) {
    const u0 = i / spans;
    const u1 = (i + 1) / spans;
    pushSegment(
      buffer,
      ax + dx * u0,
      az + dz * u0,
      ax + dx * u1,
      az + dz * u1,
      lift,
      half,
      color,
      fade,
    );
  }
}

/* Casing first, then the line, because the pool is drawn in the order it is
 * written and the casing is the thing that has to be underneath. Both passes
 * run whole so a joint between two spans never puts one span's casing over the
 * previous span's line. */
export function pushCasedRun(
  buffer: LineBuffer,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  lift: number,
  half: number,
  color: Color,
  fade: number,
  step: number,
  casing: Color,
  caseHalf: number,
  caseFade: number,
): void {
  pushRun(buffer, ax, az, bx, bz, lift - CASE_DROP, caseHalf, casing, caseFade, step);
  pushRun(buffer, ax, az, bx, bz, lift, half, color, fade, step);
}

export function pushCasedSegment(
  buffer: LineBuffer,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  lift: number,
  half: number,
  color: Color,
  fade: number,
  casing: Color,
  caseHalf: number,
  caseFade: number,
): void {
  pushSegment(buffer, ax, az, bx, bz, lift - CASE_DROP, caseHalf, casing, caseFade);
  pushSegment(buffer, ax, az, bx, bz, lift, half, color, fade);
}

export function pushRing(
  buffer: LineBuffer,
  cx: number,
  cz: number,
  radius: number,
  lift: number,
  half: number,
  color: Color,
  fade: number,
  segments: number,
): void {
  let px = cx + radius;
  let pz = cz;
  for (let i = 1; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const nx = cx + Math.cos(angle) * radius;
    const nz = cz + Math.sin(angle) * radius;
    pushSegment(buffer, px, pz, nx, nz, lift, half, color, fade);
    px = nx;
    pz = nz;
  }
}

export function commitLines(buffer: LineBuffer): void {
  markLineArrays(buffer.geometry);
  buffer.geometry.setDrawRange(0, buffer.quads * 6);
}

/* Beating angles outside this band belong to a boat mid-manoeuvre rather than to
 * one sailing its optimum, and a layline drawn off one of those swings across
 * the course. The fallback is the polar's own optimum, which is what the fleet
 * converges on anyway. */
const BEAT_MIN = 34;
const BEAT_MAX = 56;
const BEAT_OPTIMUM = 44;

/**
 * The angle the fleet is actually beating at, averaged over the boats on the
 * beat right now. A pure function of the clock, so scrubbing to a time twice
 * draws the laylines in the same place twice.
 */
export function tackingAngle(race: RaceData, t: number, mode: ReplayMode, spare: Pose): number {
  let sum = 0;
  let count = 0;
  for (const boat of race.boats) {
    if (legAt(race, boat.id, t) !== "beat") continue;
    const twa = Math.abs(poseAt(race, boat.id, t, mode, spare).twa);
    if (twa < BEAT_MIN || twa > BEAT_MAX) continue;
    sum += twa;
    count++;
  }
  return count === 0 ? BEAT_OPTIMUM : sum / count;
}

/* The wind the instruments show is the wind at the instant they were asked,
 * which is the honest reading for a number and the wrong one for a line a
 * hundred and thirty metres long. Drawn off the raw value the laylines change
 * direction sixteen times across this replay while the fleet only sails three
 * shifts: the other thirteen are the noise on the feed, and a hundred metres
 * out they are metres of swing.
 *
 * So the drawn wind is a centred exponential average of the same buffer. Centred
 * because a trailing one would hand the laylines a wind the boats stopped
 * sailing seven seconds ago, and the window is measured rather than picked: at
 * tau 4 s the reversals drop to the three real shifts and the drawn wind still
 * swings 16 of the 20 degrees the measured one does, where a tau of 15 keeps
 * only 8 of them and leaves every layline arguing with the boat on it.
 *
 * It reads the clock and nothing else, so scrubbing back to an instant draws
 * the same lines it drew the first time. */
const TWD_TAU = 4;
const TWD_STEP = 0.25;
const TWD_STEPS = Math.round((TWD_TAU * 4) / TWD_STEP);

const twdProbe: WindSample = { t: 0, twd: 0, tws: 0 };
let twdRace: RaceData | null = null;
let twdAt = Number.NaN;
let twdValue = 0;

function shortArc(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** The wind every drawn graphic is built on. Degrees, not wrapped to a range. */
export function displayTwd(race: RaceData, t: number): number {
  if (race === twdRace && t === twdAt) return twdValue;
  const anchor = windAt(race, t, twdProbe).twd;
  let sum = 0;
  let weight = 0;
  for (let k = -TWD_STEPS; k <= TWD_STEPS; k++) {
    const offset = k * TWD_STEP;
    const w = Math.exp(-Math.abs(offset) / TWD_TAU);
    sum += shortArc(windAt(race, t + offset, twdProbe).twd - anchor) * w;
    weight += w;
  }
  twdRace = race;
  twdAt = t;
  twdValue = anchor + sum / weight;
  return twdValue;
}

/** Course bearing to a unit vector in world xz: +y up the course maps onto -z. */
export function bearingVector(deg: number, out: [number, number]): [number, number] {
  const rad = deg * DEG;
  out[0] = Math.sin(rad);
  out[1] = -Math.cos(rad);
  return out;
}

/* A hue is a track colour once it can be seen against deep water. Only the near
 * black boat fails that, and it is lifted toward ink rather than toward its own
 * trim, which is the red another boat in this fleet already owns. */
const TRACK_FLOOR = 0.055;
const INK = new Color("#ecf5f9");

export function trackColour(boat: BoatMeta, out: Color): Color {
  out.set(boat.hue);
  const luminance = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
  if (luminance < TRACK_FLOOR) out.lerp(INK, 0.55);
  return out;
}
