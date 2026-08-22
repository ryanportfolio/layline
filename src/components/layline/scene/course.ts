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
import type { BoatMeta, Pose, RaceData, WindSample } from "@/lib/layline/types";
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

/* Half widths in metres, and the alpha each class is drawn at. The rung is the
 * quietest thing on the sea and the first to fall under the floor: at a hundred
 * and sixty metres the old sixteen centimetres drew two pixels of a colour the
 * water had already taken most of, which is a rung a viewer cannot find and so
 * cannot lay two boats against. */
export const RUNG_HALF = 0.2;
export const ZONE_HALF = 0.22;
export const LAYLINE_HALF = 0.26;
export const START_HALF = 0.4;

export const RUNG_FADE = 0.34;
export const ZONE_FADE = 0.36;
export const LAYLINE_FADE = 0.66;
export const START_FADE = 0.88;

/* And the widest each class is ever drawn on screen, in pixels of the picture.
 * A line authored in metres has no ceiling of its own: half a metre of layline
 * is four pixels from the tactical rig and thirty five from a chase camera
 * twelve metres off it, at which point the graphic has stopped being a line and
 * become paint on the water. The floor below keeps a far line whole; these keep
 * a near one a line. Every class of casing carries the same multiple of its
 * line's ceiling that it does of its width, so the pair stay a rule around a
 * line at any range. */
export const RUNG_MAX_PX = 2.5;
export const ZONE_MAX_PX = 2.5;
export const LAYLINE_MAX_PX = 3.5;
export const START_MAX_PX = 5;

/* Wake foam and whitecaps run the same value as the line work drawn over them,
 * so a dash crossing a boat's wake loses its edges and a rung breaks. The
 * casing is a wider quad of the water's own deep colour under the line: on open
 * water it lands on the value it already is and changes nothing, and on foam it
 * puts a dark rule either side of the line, which is what the line is read off.
 * It sits a hair lower so the pair never argue about depth. */
export const CASE_DROP = 0.03;
export const RUNG_CASE_HALF = 0.52;
/* The start line is the one graphic that has to survive being drawn over the
 * fleet's own wake at the gun, where the foam carries the same value the ink
 * does. Wide enough and dark enough to put a rule either side of the line
 * rather than a hint of one. */
export const START_CASE_HALF = 1.4;
export const RUNG_CASE_FADE = 0.42;
export const START_CASE_FADE = 0.7;
export const RUNG_CASE_MAX_PX = 6.5;
export const START_CASE_MAX_PX = 16;

const lineVertex = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uHeight;
uniform float uMinPx;
uniform float uDpr;

attribute vec2 aPerp;
attribute float aSpan;
attribute float aMaxPx;
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
     further away it got. The ceiling is the same argument the other way up: a
     near line is narrowed back to the weight its class is allowed, and the
     compensation is held at one so narrowing never turns it solid. The ceiling
     is stated in pixels of the picture rather than of the buffer, so it reads
     the same weight on a display that draws two samples for each of them. */
  float held = max(aMaxPx * uDpr, uMinPx) * 0.5 * perPixel;
  float wide = clamp(abs(aSpan), uMinPx * 0.5 * perPixel, held);
  vec2 column = position.xz + aPerp * (wide * sign(aSpan));
  vec2 base = laylineColumn(column, uTime, uWind, cameraPosition.xz);
  vec3 disp;
  float jac;
  vec3 nrm;
  laylineWaves(base, uTime, uWind, length(base - cameraPosition.xz), disp, jac, nrm);
  vec3 world = vec3(column.x, disp.y + position.y, column.y);
  float age = max(uTime - aTime, 0.0);
  vColor = aColor;
  vAlpha = aFade * exp(-age * aLife) * min(1.0, abs(aSpan) / wide);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

/* The console ground is 0.86 opaque, so a graphic run under the bottom panel
 * does not disappear behind it: fourteen percent of a hue track comes through as
 * a coloured band across the leg labels, the rounding ticks and the playhead.
 * The line work stops above the panel instead, faded out over a band rather than
 * cut, so nothing on the water ever reaches the console whatever the camera is
 * doing. The band is zero at the narrow width, where the panels leave the canvas
 * and stack under it. */
const lineFragment = /* glsl */ `
uniform float uHeight;
uniform float uDock;

varying vec3 vColor;
varying float vAlpha;

void main() {
  if (vAlpha < 0.005) discard;
  float clear = uDock > 0.0 ? smoothstep(uDock, uDock + uHeight * 0.06, gl_FragCoord.y) : 1.0;
  float alpha = vAlpha * clear;
  if (alpha < 0.005) discard;
  gl_FragColor = vec4(vColor, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const CourseLineMaterial = shaderMaterial(
  { uTime: 0, uWind: new Vector2(0, 1), uHeight: 900, uMinPx: 1.7, uDpr: 1, uDock: 0 },
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
uniform float uHeight;
uniform float uDock;

varying vec3 vColor;
varying float vAlpha;
varying vec2 vUv;

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  /* A rim rather than a soft edge. Softened all the way out the dots blur into
     one another at four a second and stop reading as separate measurements. */
  float clear = uDock > 0.0 ? smoothstep(uDock, uDock + uHeight * 0.06, gl_FragCoord.y) : 1.0;
  float alpha = vAlpha * (1.0 - smoothstep(0.78, 1.0, r)) * clear;
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
    uDock: 0,
  },
  dotVertex,
  dotFragment,
);

export interface LineArrays {
  position: Float32Array;
  perp: Float32Array;
  span: Float32Array;
  maxPx: Float32Array;
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
    maxPx: new Float32Array(verts),
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
  geometry.setAttribute("aMaxPx", new BufferAttribute(arrays.maxPx, 1));
  geometry.setAttribute("aColor", new BufferAttribute(arrays.color, 3));
  geometry.setAttribute("aFade", new BufferAttribute(arrays.fade, 1));
  geometry.setAttribute("aTime", new BufferAttribute(arrays.time, 1));
  geometry.setAttribute("aLife", new BufferAttribute(arrays.life, 1));
}

export function markLineArrays(geometry: BufferGeometry): void {
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.aPerp.needsUpdate = true;
  geometry.attributes.aSpan.needsUpdate = true;
  geometry.attributes.aMaxPx.needsUpdate = true;
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
  maxPx: number,
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
    arrays.maxPx[v] = maxPx;
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
  maxPx: number,
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
      maxPx,
      color,
      fade,
    );
  }
}

export function pushRing(
  buffer: LineBuffer,
  cx: number,
  cz: number,
  radius: number,
  lift: number,
  half: number,
  maxPx: number,
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
    pushSegment(buffer, px, pz, nx, nz, lift, half, maxPx, color, fade);
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

const beatProbe: Pose = { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };

/* The fleet's beating angle at one instant, averaged over the boats on the beat
 * that are inside the band. Membership is a step quantity twice over: leg comes
 * off the 2 Hz progress series, which holds rather than interpolates, and the
 * band is a hard in-or-out test on a twa that moves every frame. So a boat joins
 * or leaves the average between one frame and the next, the mean jumps, and the
 * last boat to leave hands the line the fallback in a single step. */
function measuredBeatAngle(race: RaceData, t: number): number {
  let sum = 0;
  let count = 0;
  for (const boat of race.boats) {
    if (legAt(race, boat.id, t) !== "beat") continue;
    /* Read off the interpolated pose in both lenses. At a fix time it is the
     * fix itself, and between two of them a thirty second average of six boats
     * cannot tell a held value from a curved one. */
    const twa = Math.abs(poseAt(race, boat.id, t, "smooth", beatProbe).twa);
    if (twa < BEAT_MIN || twa > BEAT_MAX) continue;
    sum += twa;
    count++;
  }
  return count === 0 ? BEAT_OPTIMUM : sum / count;
}

/* Which is the drawn wind's problem twice over, and a layline is aimed at the
 * sum of the two. Sampled across the replay at 0.025 s, the damped wind moves at
 * most 0.026 deg between frames while this measured angle steps 11.8 deg, and
 * 522 of the layline's steps are over 0.1 deg. At the far end of a 132 m line
 * the worst of them throws the line 27 m sideways in one frame, which is the
 * jag.
 *
 * So the drawn angle gets the treatment the drawn wind gets in the note below,
 * over the same 4 s window and centred for the same reason. That leaves the
 * worst step at 0.011 deg, 25 mm at the far end. What it drops is boats tacking:
 * every one of them swings through head to wind and out of the band on every
 * tack, which is why the measured angle covers 21.6 deg across the beat while
 * the angle the fleet sustains between manoeuvres moves 45.4 to 46.7. The line
 * still follows the wind, swinging 13.5 deg across the replay against the 18.2
 * the measured wind does.
 *
 * A 33 s window is 129 evaluations of the fleet, which is not a per-frame cost,
 * so the series is solved once per race on a quarter second grid and read back
 * by interpolation: a frame costs one array lookup rather than six pose
 * evaluations, and the value stays a pure function of the clock, so a scrub
 * back to an instant draws the laylines where playback drew them. */
const BEAT_TAU = 4;
const BEAT_STEP = 0.25;
const BEAT_REACH = Math.round((BEAT_TAU * 4) / BEAT_STEP);

const beatKernel = new Float32Array(BEAT_REACH + 1);
for (let k = 0; k <= BEAT_REACH; k++) beatKernel[k] = Math.exp((-k * BEAT_STEP) / BEAT_TAU);

interface BeatSeries {
  t0: number;
  values: Float32Array;
}

const beatSeries = new WeakMap<RaceData, BeatSeries>();

/* Over the replay clock, which is the range the transport clamps a seek into,
 * rather than over whatever span the wind feed happens to carry. The ends extend
 * rather than taper, the way the series lookups clamp at their own ends, so the
 * average never dilutes toward zero at the edge of the race. */
function buildBeatSeries(race: RaceData): BeatSeries {
  const t0 = race.tMin;
  const count = Math.max(1, Math.round((race.tMax - t0) / BEAT_STEP) + 1);
  const measured = new Float32Array(count);
  for (let i = 0; i < count; i++) measured[i] = measuredBeatAngle(race, t0 + i * BEAT_STEP);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    let weight = 0;
    for (let k = -BEAT_REACH; k <= BEAT_REACH; k++) {
      const j = Math.min(count - 1, Math.max(0, i + k));
      const w = beatKernel[k < 0 ? -k : k];
      sum += measured[j] * w;
      weight += w;
    }
    values[i] = sum / weight;
  }
  return { t0, values };
}

/**
 * The angle the laylines are drawn at, which is the fleet's own beating angle
 * damped over four seconds. Degrees off the wind, one side's worth.
 */
export function tackingAngle(race: RaceData, t: number): number {
  let series = beatSeries.get(race);
  if (series === undefined) {
    series = buildBeatSeries(race);
    beatSeries.set(race, series);
  }
  const values = series.values;
  const last = values.length - 1;
  const u = (t - series.t0) / BEAT_STEP;
  if (!(u > 0)) return values[0];
  if (u >= last) return values[last];
  const i = Math.floor(u);
  return values[i] + (values[i + 1] - values[i]) * (u - i);
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
