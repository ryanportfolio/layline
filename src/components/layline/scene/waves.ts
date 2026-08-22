/**
 * The sea state, written once. The water shader and every hull floating on it
 * have to agree about where the surface is, so the GLSL below is generated from
 * the same table the CPU sampler reads and a retune cannot drift the two apart.
 *
 * Breeze on, the default race look. Significant wave height
 * Hs = 4 * sqrt(sum(A^2) / 2) lands at 0.85 m: WMO sea state 3, the band a 4.9 m
 * skiff races in. Waves any bigger swallow the fleet, which is the classic way a
 * sailing scene goes wrong. Wavelengths share no common factor so the pattern
 * never repeats across the course, and the three directions fan around the
 * breeze instead of running parallel, which would read as corduroy.
 *
 * Periods are not art-directed: deep water dispersion gives omega = sqrt(g * k),
 * so 61 m water runs at 6.25 s and 23 m water at 3.84 s whether anyone likes it
 * or not. Only the amplitudes and the spread are chosen.
 *
 * Steepness is normalised, Q_i = Q / (k_i * A_i * N), which makes
 * sum(Q_i * k_i * A_i) come out exactly Q. One clamp at Q <= 1 is therefore the
 * whole self-intersection constraint, and 0.7 sits inside it with room.
 */
import type { RaceData } from "@/lib/layline/types";

const GRAVITY = 9.81;
const DEG = Math.PI / 180;

export const WAVE_STEEPNESS = 0.7;

interface Octave {
  length: number; // m, crest to crest
  amplitude: number; // m, half the crest to trough height
  spread: number; // deg off the mean breeze
  /* Where this octave starts and finishes fading out. Nothing here is about
   * pixels: the normal is analytic per fragment, so a 23 m wave still reads
   * cleanly at 400 m. It is about vertices. A clipmap ring sampling a wave
   * fewer than about three and a half times turns it into a slow swim, so each
   * octave is gone before the ring carrying it gets that coarse. */
  near: number;
  far: number;
  /* The normal keeps going long after the displacement stops, because it is
   * analytic per fragment and answers to the pixel footprint rather than to the
   * vertex spacing. Dropping both together would leave a mirror flat band of
   * water between the last ring that carries relief and the distance the haze
   * finally takes over, and a mirror strobes. */
  nearNormal: number;
  farNormal: number;
  /* How much this octave counts toward the breaking test. Whitecaps are a wind
   * wave phenomenon: a 61 m swell at this height does not break, and letting it
   * into the mask paints continuous ribbons of foam along every crest line. */
  breaking: number;
}

const OCTAVES: Octave[] = [
  {
    length: 61,
    amplitude: 0.244,
    spread: 0,
    near: 460,
    far: 630,
    nearNormal: 2000,
    farNormal: 3400,
    breaking: 0.1,
  },
  {
    length: 37,
    amplitude: 0.148,
    spread: 17,
    near: 260,
    far: 420,
    nearNormal: 1200,
    farNormal: 2100,
    breaking: 0.8,
  },
  {
    length: 23,
    amplitude: 0.092,
    spread: -24,
    near: 140,
    far: 250,
    nearNormal: 700,
    farNormal: 1300,
    breaking: 1,
  },
];

interface Wave {
  k: number;
  amplitude: number;
  omega: number;
  cos: number;
  sin: number;
  /* Q_i * A_i, the horizontal displacement coefficient. The A cancels out of
   * the normalised steepness, which is why it is a constant per octave. */
  qa: number;
  near: number;
  far: number;
  nearNormal: number;
  farNormal: number;
  breaking: number;
}

const WAVES: Wave[] = OCTAVES.map((octave) => {
  const k = (2 * Math.PI) / octave.length;
  return {
    k,
    amplitude: octave.amplitude,
    omega: Math.sqrt(GRAVITY * k),
    cos: Math.cos(octave.spread * DEG),
    sin: Math.sin(octave.spread * DEG),
    qa: WAVE_STEEPNESS / (k * OCTAVES.length),
    near: octave.near,
    far: octave.far,
    nearNormal: octave.nearNormal,
    farNormal: octave.farNormal,
    breaking: octave.breaking,
  };
});

/** Hs for this amplitude set, the number the sea state is graded on. */
export function significantWaveHeight(): number {
  let variance = 0;
  for (const octave of OCTAVES) variance += octave.amplitude * octave.amplitude;
  return 4 * Math.sqrt(variance / 2);
}

export interface WaveSample {
  height: number;
  /* Determinant of the horizontal displacement Jacobian, taken over the wind
   * wave octaves only. It falls toward zero where the surface piles up into a
   * crest, which is where foam belongs. */
  jacobian: number;
}

function fadeAt(near: number, far: number, dist: number): number {
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  const u = (dist - near) / (far - near);
  return 1 - u * u * (3 - 2 * u);
}

/* A Gerstner surface point does not stay over the column it was authored on:
 * the horizontal term carries it up to four metres toward the crest. Anything
 * placed by world position has to undo that first, or it answers the height of
 * a different piece of water. The map is a contraction while the normalised
 * steepness stays under one, so the fixed point comes back in four passes and
 * the wake shader runs the same four. */
const SOLVE_STEPS = 4;

const DRIFT: [number, number] = [0, 0];

function driftAt(
  bx: number,
  bz: number,
  time: number,
  dirX: number,
  dirZ: number,
  camX: number,
  camZ: number,
  out: [number, number],
): void {
  const dist = Math.hypot(bx - camX, bz - camZ);
  let ox = 0;
  let oz = 0;
  for (const wave of WAVES) {
    const dx = dirX * wave.cos - dirZ * wave.sin;
    const dz = dirX * wave.sin + dirZ * wave.cos;
    const fade = fadeAt(wave.near, wave.far, dist);
    const cs = Math.cos(wave.k * (dx * bx + dz * bz) + wave.omega * time);
    ox += wave.qa * fade * dx * cs;
    oz += wave.qa * fade * dz * cs;
  }
  out[0] = ox;
  out[1] = oz;
}

/**
 * How high the surface is over one world column, which is the only question a
 * hull or a length of foam ever asks. The camera position is an argument
 * because the octaves fade with distance on the GPU, and a hull that ignored
 * that fade would float over water the renderer had already flattened.
 */
export function sampleWave(
  x: number,
  z: number,
  time: number,
  dirX: number,
  dirZ: number,
  camX: number,
  camZ: number,
  out: WaveSample,
): WaveSample {
  let bx = x;
  let bz = z;
  for (let step = 0; step < SOLVE_STEPS; step++) {
    driftAt(bx, bz, time, dirX, dirZ, camX, camZ, DRIFT);
    bx = x - DRIFT[0];
    bz = z - DRIFT[1];
  }
  const dist = Math.hypot(bx - camX, bz - camZ);
  let height = 0;
  let dxx = 0;
  let dzz = 0;
  let dxz = 0;
  for (const wave of WAVES) {
    const dx = dirX * wave.cos - dirZ * wave.sin;
    const dz = dirX * wave.sin + dirZ * wave.cos;
    const fade = fadeAt(wave.near, wave.far, dist);
    const phase = wave.k * (dx * bx + dz * bz) + wave.omega * time;
    const sn = Math.sin(phase);
    const qwa = wave.qa * fade * wave.k * wave.breaking;
    height += wave.amplitude * fade * sn;
    dxx -= qwa * dx * dx * sn;
    dzz -= qwa * dz * dz * sn;
    dxz -= qwa * dx * dz * sn;
  }
  out.height = height;
  out.jacobian = (1 + dxx) * (1 + dzz) - dxz * dxz;
  return out;
}

/**
 * The direction the swell travels, as a unit vector in world xz. It follows the
 * mean breeze rather than the live one: a wave field that swung with every 35 s
 * oscillation would read as a bug, and the wind cue only has to agree with the
 * dial to within the band the dial itself shows.
 */
export function swellDirection(race: RaceData): [number, number] {
  let sx = 0;
  let cy = 0;
  for (const sample of race.wind) {
    sx += Math.sin(sample.twd * DEG);
    cy += Math.cos(sample.twd * DEG);
  }
  const mean = Math.atan2(sx, cy);
  /* Course bearings run clockwise from +y, and the renderer maps +y onto -z.
   * The wind blows FROM twd, so the swell runs the other way. */
  return [-Math.sin(mean), Math.cos(mean)];
}

function glslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : value.toPrecision(9);
}

function octaveGlsl(wave: Wave): string {
  return `
  d = laylineFan(wind, ${glslFloat(wave.cos)}, ${glslFloat(wave.sin)});
  fade = 1.0 - smoothstep(${glslFloat(wave.near)}, ${glslFloat(wave.far)}, dist);
  fadeN = 1.0 - smoothstep(${glslFloat(wave.nearNormal)}, ${glslFloat(wave.farNormal)}, dist);
  amp = ${glslFloat(wave.amplitude)} * fade;
  phase = ${glslFloat(wave.k)} * dot(d, base) + ${glslFloat(wave.omega)} * time;
  sn = sin(phase);
  cs = cos(phase);
  qa = ${glslFloat(wave.qa)} * fade;
  qwa = ${glslFloat(wave.qa)} * ${glslFloat(wave.k)} * fadeN;
  wa = ${glslFloat(wave.k)} * ${glslFloat(wave.amplitude)} * fadeN;
  disp.y += amp * sn;
  disp.xz += qa * d * cs;
  nrm.x -= d.x * wa * cs;
  nrm.z -= d.y * wa * cs;
  nrm.y -= qwa * sn;
  brk = qa * ${glslFloat(wave.k)} * ${glslFloat(wave.breaking)} * sn;
  dxx -= brk * d.x * d.x;
  dzz -= brk * d.y * d.y;
  dxz -= brk * d.x * d.y;`;
}

function driftGlsl(wave: Wave): string {
  return `
  d = laylineFan(wind, ${glslFloat(wave.cos)}, ${glslFloat(wave.sin)});
  fade = 1.0 - smoothstep(${glslFloat(wave.near)}, ${glslFloat(wave.far)}, dist);
  phase = ${glslFloat(wave.k)} * dot(d, base) + ${glslFloat(wave.omega)} * time;
  off += ${glslFloat(wave.qa)} * fade * d * cos(phase);`;
}

/* Displacement, normal and the breaking determinant in one pass, because all
 * three share the same three sines and cosines. The vertex stage wants the
 * displacement and the determinant, the fragment stage recomputes the normal at
 * full rate: 16 m vertices would facet every crest, and three octaves are cheap
 * enough to pay for per pixel.
 *
 * laylineColumn is the same solve sampleWave runs above, so foam placed by
 * world position and a hull placed by world position land on one surface. */
export const WAVE_GLSL = /* glsl */ `
vec2 laylineFan(vec2 wind, float c, float s) {
  return vec2(wind.x * c - wind.y * s, wind.x * s + wind.y * c);
}

vec2 laylineDrift(vec2 base, float time, vec2 wind, float dist) {
  vec2 off = vec2(0.0);
  vec2 d;
  float fade;
  float phase;
${WAVES.map(driftGlsl).join("\n")}
  return off;
}

vec2 laylineColumn(vec2 world, float time, vec2 wind, vec2 eye) {
  vec2 base = world;
  for (int i = 0; i < ${SOLVE_STEPS}; i++) {
    base = world - laylineDrift(base, time, wind, length(base - eye));
  }
  return base;
}

void laylineWaves(vec2 base, float time, vec2 wind, float dist,
                  out vec3 disp, out float jac, out vec3 nrm) {
  disp = vec3(0.0);
  nrm = vec3(0.0, 1.0, 0.0);
  float dxx = 0.0;
  float dzz = 0.0;
  float dxz = 0.0;
  vec2 d;
  float fade;
  float fadeN;
  float amp;
  float phase;
  float sn;
  float cs;
  float qa;
  float qwa;
  float wa;
  float brk;
${WAVES.map(octaveGlsl).join("\n")}
  jac = (1.0 + dxx) * (1.0 + dzz) - dxz * dxz;
  nrm = normalize(nrm);
}
`;
