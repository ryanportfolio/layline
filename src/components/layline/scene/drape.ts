import type { Material } from "three";
import { KITE_SPEC, KITE_TACK, MAIN_CHORD, MAIN_SPEC, SKIFF } from "./skiff";

/**
 * The gennaker, stopped on the mainsail.
 *
 * The two sails are authored apart and meet by accident. The kite's head is
 * pinned at the masthead, which is where the main's luff is, so above about
 * two thirds of the way up the kite its cloth lies inside the main's and comes
 * out the far side. Measured across ten wind angles and five sheet settings,
 * the shipped pair cross each other in all fifty.
 *
 * Real cloth touches all the time and passes through never; deep, a kite's
 * leech rests on the main hard enough that both sails carry chafe patches for
 * it. So the fix is contact, not separation: anything in the drape zone that
 * is not clear of the main on the kite's own side gets held out at CLEAR.
 *
 * This runs in the vertex shader rather than on the CPU for three reasons. The
 * kite geometry is one buffer shared by the whole fleet, so a CPU pass would
 * need a copy per boat. It carries a morph target for the shaken-flat shape,
 * so a CPU pass would have to write both shapes and the blend of two draped
 * shapes is not the drape of the blended shape. And the drape moves with the
 * boom, so nothing about it can be baked: at two degrees of bucketing the
 * cloth still steps 0.068 m between buckets, against 0.01 m for a whole degree
 * of continuous travel, which reads as a snap.
 *
 * Injected after morphtarget_vertex, so it acts on the shape actually drawn.
 */

/* Where the drape starts up the luff. Low, not up at the head: the kite's
 * leech crosses the main at 0.68 of the way up and its luff at 0.93, and a
 * drape that starts above the first crossing only bends the tip and folds. */
const FROM = 0.15;

/* How far off the main's cloth the kite is held. */
const CLEAR = 0.06;

/* How far past the main's own edges the hold fades out. */
const SOFT = 2.0;

/* Span it takes to reach full hold, smoothstepped. */
const RAMP = 0.05;

/* How hard a held vertex leans its normal onto the main's. A vertex shader
 * cannot recompute a normal from neighbours, so the cloth in the contact band
 * borrows the surface it is lying on instead. */
const LEAN = 2.0;

const f = (n: number) => n.toFixed(6);

/**
 * Declarations and the read of the mainsail, for the common block.
 *
 * Every number the mainsail is drawn from is written in here from MAIN_SPEC
 * rather than passed as a uniform, so the surface this tests against cannot
 * drift from the surface sailShell builds.
 */
export const DRAPE_COMMON = /* glsl */ `
uniform float uDrapeOn;
uniform float uBoom;
uniform float uSpread;
uniform float uLee;
uniform vec3 uKiteScale;

const float dMainTackY = ${f(MAIN_SPEC.tack[1])};
const float dMainTackZ = ${f(MAIN_SPEC.tack[2])};
const float dMainHeadY = ${f(MAIN_SPEC.head[1])};
const float dMainHeadZ = ${f(MAIN_SPEC.head[2])};
const float dMainTwist = ${f(MAIN_SPEC.twist)};
const float dMainTrim = ${f(MAIN_SPEC.trim)};
const float dMainDraft = ${f(MAIN_SPEC.draft)};
const float dMastZ = ${f(SKIFF.mastZ)};
const vec3 dKiteOrigin = vec3(${f(KITE_TACK[0])}, ${f(KITE_TACK[1])}, ${f(KITE_TACK[2])});
const vec3 dKiteTack = vec3(${f(KITE_SPEC.tack[0])}, ${f(KITE_SPEC.tack[1])}, ${f(KITE_SPEC.tack[2])});
const vec3 dKiteHead = vec3(${f(KITE_SPEC.head[0])}, ${f(KITE_SPEC.head[1])}, ${f(KITE_SPEC.head[2])});
const float dKiteLuffBow = ${f(KITE_SPEC.luffBow)};
const float dFrom = ${f(FROM)};
const float dClear = ${f(CLEAR)};
const float dSoft = ${f(SOFT)};
const float dRamp = ${f(RAMP)};
const float dLean = ${f(LEAN)};

float dMainChord(float s) {
  float t = clamp(s, 0.0, 1.0) * 8.0;
  int i = int(min(floor(t), 7.0));
  float w = 0.5 - 0.5 * cos(PI * (t - float(i)));
  float table[9] = float[9](${MAIN_CHORD.map((n) => f(n)).join(", ")});
  return table[i] + (table[i + 1] - table[i]) * w;
}

/* How far aft along the mainsail's chord a point falls, how far off its cloth,
 * and which way that cloth faces. Term for term the same read sailShell uses
 * to place the main in the first place, taken at the point's own height. */
bool dReadMain(vec3 p, float ci, float si, out float along, out float chord, out float gap, out vec2 face) {
  float vm = (p.y - dMainTackY) / (dMainHeadY - dMainTackY);
  if (vm < 0.0 || vm > 1.0) return false;
  float bx = p.x * ci + (p.z - dMastZ) * si;
  float bz = -p.x * si + (p.z - dMastZ) * ci;
  float th = radians(dMainTrim + dMainTwist * pow(max(vm, 0.0), 1.3));
  chord = dMainChord(vm);
  float lz = dMainTackZ + (dMainHeadZ - dMainTackZ) * vm;
  vec2 dir = vec2(uLee * uSpread * sin(th), cos(th));
  face = vec2(uLee * cos(th), -sin(th));
  float rz = bz - lz;
  along = bx * dir.x + rz * dir.y;
  float off = bx * face.x + rz * face.y;
  float w = clamp(along / chord, 0.0, 1.0);
  gap = off - uSpread * dMainDraft * chord * sin(PI * pow(max(w, 0.0), 0.82));
  return true;
}
`;

/**
 * The drape itself, for after morphtarget_vertex.
 *
 * uv.y is the sail's own span parameter: sailShell writes it there when it
 * lays the sheet on, so the zone needs no attribute of its own.
 *
 * Which side of the main belongs to the kite is read once, off the kite's luff
 * at FROM, in closed form. It cannot be read per vertex, because a vertex that
 * has already passed through the main would vote for the side it wrongly ended
 * up on, and a shader has no neighbours to walk out from instead.
 */
export const DRAPE_GLSL = /* glsl */ `
if (uDrapeOn > 0.5 && uv.y >= dFrom) {
  float dU = clamp((uv.y - dFrom) / max(dRamp, 1e-6), 0.0, 1.0);
  float dZone = dU * dU * (3.0 - 2.0 * dU);
  float dCi = cos(uBoom);
  float dSi = sin(uBoom);
  vec3 dBoat = dKiteOrigin + uKiteScale * transformed;

  vec3 dLuff = dKiteOrigin + mix(dKiteTack, dKiteHead, dFrom)
    + vec3(uLee * uSpread * dKiteLuffBow * pow(sin(PI * dFrom), 0.8), 0.0, 0.0);
  float dLa, dLc, dLg;
  vec2 dLf;
  float dSide = 1.0;
  if (dReadMain(dLuff, dCi, dSi, dLa, dLc, dLg, dLf)) dSide = dLg >= 0.0 ? 1.0 : -1.0;

  float dAlong, dChord, dGap;
  vec2 dFace;
  if (dZone > 0.0 && dReadMain(dBoat, dCi, dSi, dAlong, dChord, dGap, dFace)) {
    float dEdge = dAlong < 0.0 ? -dAlong : max(0.0, dAlong - dChord);
    float dFoot = dSoft <= 0.0 ? (dEdge > 0.0 ? 0.0 : 1.0) : 1.0 - clamp(dEdge / dSoft, 0.0, 1.0);
    if (dFoot > 0.0 && dSide * dGap < dClear) {
      float dPush = (dSide * dClear - dGap) * dZone * dFoot;
      vec2 dW = dFace * dPush;
      dBoat.x += dW.x * dCi - dW.y * dSi;
      dBoat.z += dW.x * dSi + dW.y * dCi;
      transformed = (dBoat - dKiteOrigin) / uKiteScale;
      vec3 dOn = normalize(vec3(dFace.x * dCi - dFace.y * dSi, 0.0, dFace.x * dSi + dFace.y * dCi));
      vec3 dN = normalize(objectNormal / uKiteScale);
      dN = normalize(mix(dN, dSide * dOn, clamp(abs(dPush) * dLean, 0.0, 1.0)));
      objectNormal = normalize(dN * uKiteScale);
    }
  }
}
`;

export interface DrapeUniforms {
  uDrapeOn: { value: number };
  uBoom: { value: number };
  uSpread: { value: number };
  uLee: { value: number };
  uKiteScale: { value: [number, number, number] };
}

export function drapeUniforms(): DrapeUniforms {
  return {
    uDrapeOn: { value: 0 },
    uBoom: { value: 0 },
    uSpread: { value: 1 },
    uLee: { value: 1 },
    uKiteScale: { value: [1, 1, 1] },
  };
}

/**
 * Patch a kite material to carry the drape.
 *
 * The normal chain is moved to run after the drape rather than before it,
 * which is where three.js puts it: objectNormal is settled in the block above
 * begin_vertex, and the drape has to bend it after it has decided how far the
 * cloth moved.
 */
export function applyDrape(material: Material, uniforms: DrapeUniforms): void {
  material.customProgramCacheKey = () => "layline-kite-drape";
  material.onBeforeCompile = (program) => {
    for (const [name, holder] of Object.entries(uniforms)) program.uniforms[name] = holder;
    program.vertexShader = program.vertexShader
      .replace("#include <common>", `#include <common>\n${DRAPE_COMMON}`)
      .replace("#include <defaultnormal_vertex>", "")
      .replace("#include <normal_vertex>", "")
      .replace(
        "#include <morphtarget_vertex>",
        `#include <morphtarget_vertex>
${DRAPE_GLSL}
#include <defaultnormal_vertex>
#include <normal_vertex>`,
      );
  };
}
