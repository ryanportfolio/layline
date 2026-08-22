"use client";

import { useEffect, useMemo, useRef } from "react";
import { shaderMaterial } from "@react-three/drei";
import { extend, useFrame, type ThreeElement } from "@react-three/fiber";
import { BufferGeometry, Color, Float32BufferAttribute, Vector2, type Mesh } from "three";
import type { RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import {
  GLINT,
  HAZE_RHO,
  SKY_GLSL,
  SKY_HORIZON,
  SKY_ZENITH,
  SUN_DISC,
  SUN_TINT,
  WATER_DEEP,
  WATER_MID,
  WATER_SCATTER,
  WHITECAP,
  sunDirection,
} from "./sky";
import { WAVE_GLSL, swellDirection } from "./waves";

/* Camera centred rings: a 1280 m detail square for 26k vertices, where a
 * uniform 1 m grid over the same square would cost 1.6M. Each ring covers twice the
 * ground of the one inside it at half the density, and its hole is exactly that
 * ring's square. The five detail rings span 1280 m, so their edge sits 640 m
 * out, where the surface still holds seven tenths of its own colour; the
 * sixth carries no detail at all and pushes the water to 5.1 km, where the
 * haze has taken it to 6 percent and there is no edge left to see. */
const RINGS = [
  { cells: 80, spacing: 1, hole: 0 },
  { cells: 80, spacing: 2, hole: 40 },
  { cells: 80, spacing: 4, hole: 40 },
  { cells: 80, spacing: 8, hole: 40 },
  { cells: 80, spacing: 16, hole: 40 },
  { cells: 16, spacing: 640, hole: 2 },
];

/* The coarsest spacing that carries displacement. Snapping the whole clipmap to
 * it keeps every vertex on a fixed world lattice, so the surface never slides
 * underneath the swell as the camera moves. */
const SNAP = 16;

const waterVertex = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;

/* The two coarse vertices this one lies between, in plane coordinates. Equal to
 * each other except on the ring edge vertices that have no partner across the
 * join, which is the only place the question comes up. */
attribute vec4 aStitch;

varying vec3 vWorld;
varying vec2 vBase;

${WAVE_GLSL}

/* Where the surface ends up for one point on the plane, world space. The
 * breaking determinant comes back too and is discarded here: interpolated
 * across a one metre triangle it turns the foam edge into a straight line with
 * a corner on every vertex, so the fragment stage works it out for itself. */
vec3 laylineSurface(vec2 plane) {
  vec3 base = (modelMatrix * vec4(plane.x, 0.0, plane.y, 1.0)).xyz;
  vec3 disp;
  float jac;
  vec3 nrm;
  laylineWaves(base.xz, uTime, uWind, length(base.xz - cameraPosition.xz), disp, jac, nrm);
  return base + disp;
}

void main() {
  vec3 surface = laylineSurface(position.xz);
  /* A ring's outer edge carries a vertex every spacing, the hole edge it meets
     carries one every coarse spacing, so most of those edge vertices have
     nothing to match across the join. Displaced on its own such a vertex leaves
     the coarse chord and opens a lit crack the length of the ring. They arrive
     carrying the two coarse ends they lie between and are placed on the line
     between them, which is the line the coarse triangle already draws. */
  vec2 span = aStitch.zw - aStitch.xy;
  float extent = dot(span, span);
  if (extent > 0.0) {
    float along = clamp(dot(position.xz - aStitch.xy, span) / extent, 0.0, 1.0);
    surface = mix(laylineSurface(aStitch.xy), laylineSurface(aStitch.zw), along);
  }
  vBase = (modelMatrix * vec4(position, 1.0)).xz;
  vWorld = surface;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const waterFragment = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uSss;
uniform vec3 uGlint;
uniform vec3 uWhitecap;
uniform float uSunPower;
uniform float uFoamBias;
uniform float uHaze;

varying vec3 vWorld;
varying vec2 vBase;

${SKY_GLSL}
${WAVE_GLSL}

const float LAYLINE_PI = 3.141592653589793;

float laylineHash(vec2 p) {
  vec2 q = 50.0 * fract(p * 0.3183099 + vec2(0.71, 0.113));
  return -1.0 + 2.0 * fract(q.x * q.y * (q.x + q.y));
}

/* Value noise carrying its own gradient, so a detail layer costs one lookup
 * instead of four taps of finite differences. */
vec3 laylineNoise(vec2 x) {
  vec2 p = floor(x);
  vec2 w = fract(x);
  vec2 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  float a = laylineHash(p);
  float b = laylineHash(p + vec2(1.0, 0.0));
  float c = laylineHash(p + vec2(0.0, 1.0));
  float d = laylineHash(p + vec2(1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
              du.x * (k1 + k3 * u.y),
              du.y * (k2 + k3 * u.x));
}

/* One scrolling detail layer, returning the slope it adds. A layer whose tile
   falls under about two pixels is dropped outright rather than sampled into
   noise the frame cannot resolve. */
vec2 laylineChop(vec2 base, vec2 dir, float time, float tile, float speed, float slope, float px) {
  float keep = 1.0 - smoothstep(tile * 0.22, tile * 0.45, px);
  if (keep <= 0.0) return vec2(0.0);
  return laylineNoise((base - dir * (speed * time)) / tile).yz * (slope * keep);
}

/* One breaking layer, in a frame of its own. Two value noises sharing an axis
   and a whole number frequency ratio break on the same lattice lines, the
   threshold contour snaps to those lines, and the foam comes out of the shader
   wearing the grid it was built on; each layer therefore gets its own axis a
   few degrees off the wind. Stretched about three to one along that axis, so
   foam tears into streaks running downwind rather than the round blobs an
   isotropic noise leaves. */
float laylineBreak(vec2 base, vec2 axis, float along, float across, float drift, float time) {
  vec2 frame = vec2(dot(base, axis), dot(base, vec2(-axis.y, axis.x)));
  return laylineNoise(vec2(frame.x * along - time * drift, frame.y * across)).x * 0.5 + 0.5;
}

float laylineLobe(float NoH, float NoV, float NoL, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  float ndf = a2 / (LAYLINE_PI * d * d);
  float vis = 0.5 / max(mix(2.0 * NoL * NoV, NoL + NoV, a), 1e-4);
  return ndf * vis * NoL;
}

void main() {
  vec3 toEye = cameraPosition - vWorld;
  float eyeDist = length(toEye);
  vec3 V = toEye / eyeDist;
  float dist = length(vBase - cameraPosition.xz);

  vec3 disp;
  float jac;
  vec3 N;
  laylineWaves(vBase, uTime, uWind, dist, disp, jac, N);

  /* Four detail layers, each 2.58 times finer than the last so no two ever come
     back into phase, tiled in world space so the chop stays put on the water
     while the clipmap slides underneath it. They die off twice over: the slopes
     fade with distance and the roughness rises to take that lost variance back.
     Flattening alone leaves far water mirror smooth, and a mirror strobes
     against the sun with no post pass to catch it. The two fades run on
     different ranges on purpose (roughness up over 120..700 m, chop out over
     420..1800 m) with a per-pixel footprint gate inside laylineChop: one shared
     band either strobed the mid water or flattened the near chop, and the
     footprint gate is what holds the highlight together at high dpr. */
  float grade = smoothstep(120.0, 700.0, dist);
  float px = max(fwidth(vBase.x), fwidth(vBase.y));
  vec2 chop = laylineChop(vBase, uWind, uTime, 8.0, 0.06, 0.048, px)
    + laylineChop(vBase, laylineFan(uWind, 0.8192, 0.5736), uTime, 3.1, 0.11, 0.058, px)
    + laylineChop(vBase, laylineFan(uWind, 0.8829, -0.4695), uTime, 1.2, 0.17, 0.055, px)
    + laylineChop(vBase, laylineFan(uWind, 0.4695, 0.8829), uTime, 0.465, 0.25, 0.040, px);
  chop *= 1.0 - smoothstep(420.0, 1800.0, dist);
  N.x -= chop.x;
  N.z -= chop.y;
  N = normalize(N);

  float NoV = max(dot(N, V), 1e-3);
  float NoL = max(dot(N, uSunDir), 0.0);
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(N, H), 0.0);

  /* Water is F0 0.02, not the 0.04 dielectric default. That one number is the
     difference between water and wet plastic: it keeps the near surface dark
     and transmissive while the grazing distance goes bright. */
  float fres = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);

  vec3 sky = laylineSky(reflect(-V, N), 0.0);
  /* Troughs sit in the deep colour and crests lift toward the mid one, which is
     what gives the surface form where the specular has none to give. */
  float lift = clamp(vWorld.y / 0.45, -1.0, 1.0);
  vec3 body = mix(uDeep, uMid, clamp(0.30 + 0.55 * lift + 0.32 * pow(1.0 - NoV, 2.0), 0.0, 1.0));
  /* Light coming through the back of a crest. One dot product, and it is the
     cue that sells how big the water is. */
  body += uSss * clamp(vWorld.y / 0.34, 0.0, 1.0) * pow(max(dot(V, -uSunDir), 0.0), 3.0);

  /* Two lobes off the one sun: a narrow one for the disc and a wide one for the
     sheen the sky spreads around it. The narrow one is clamped at roughly the
     angular size of the solar disc, because a true point light makes a highlight
     one pixel across and that aliases into fireflies. */
  float rough = mix(0.045, 0.25, grade);
  float glitter = 1.0 + 1.1
    * smoothstep(0.30, 0.85, laylineNoise(vBase * 2.3 - uWind * (uTime * 0.4)).x)
    * (1.0 - smoothstep(40.0, 150.0, dist));
  vec3 spec = uGlint * (uSunPower * glitter) * laylineLobe(NoH, NoV, NoL, max(rough, 0.03))
            + uSunTint * (uSunPower * 0.22) * laylineLobe(NoH, NoV, NoL, 0.3);

  vec3 col = body * (1.0 - fres) + sky * fres + spec * fres;

  /* The determinant bottoms out at 0.58 at this sea state, so the textbook
     self-intersection test for foam finds nothing at all. The bias is set where
     the surface actually starts piling up, which takes a seventh of the water,
     and the gates below cut that back to the two to five percent a real sea
     state 3 whitecaps at. The determinant is the one this fragment worked out
     for itself: interpolated off the vertices instead, the foam edge picks up a
     straight run and a corner from every triangle it crosses. */
  float foam = 1.0 - smoothstep(uFoamBias - 0.10, uFoamBias, jac);
  /* Every layer is read off a bent copy of the plane. Turning the layers apart
     stops their lattices agreeing with each other; only a warp stops any one of
     them drawing its own cell edges, and the gradient the noise already hands
     back is the warp, so it costs one more lookup and no derivatives. */
  vec3 swirl = laylineNoise(vBase * 0.17 - uWind * (uTime * 0.05));
  vec2 bend = vec2(swirl.y, swirl.z);
  /* A crest does not break along its whole length. The coarse gate decides
     which stretches of it are breaking at all, then the finer layers tear each
     one into the lace a whitecap actually is. That gate's cell is three and a
     half metres downwind by one and three quarters across, the size of a
     breaking crest in twelve to fourteen knots; a cell any longer rafts the
     foam up until it is wider than the boats sailing past it. */
  float breaks = laylineBreak(vBase + bend * 0.62, uWind, 0.28, 0.58, 0.1273, uTime);
  float tear = laylineBreak(vBase + bend * 0.34, laylineFan(uWind, 0.96593, 0.25882), 0.29, 0.77, 0.18, uTime);
  float lace = laylineBreak(vBase + bend * 0.15, laylineFan(uWind, 0.93969, -0.34202), 0.73, 2.21, 0.26, uTime);
  float fleck = laylineBreak(vBase + bend * 0.07, laylineFan(uWind, 0.79864, 0.60182), 1.67, 4.9, 0.55, uTime);
  /* The finest layer goes once its cell falls under about three pixels, the
     same rule the chop uses, and it goes by blending back toward the coarser
     one rather than toward nothing, so the amount of foam does not move with
     the distance. */
  float grain = mix(lace, lace * 0.62 + fleck * 0.38, 1.0 - smoothstep(0.09, 0.24, px));
  foam *= smoothstep(0.40, 0.62, breaks) * smoothstep(0.30, 0.72, tear * 0.62 + grain * 0.38);
  /* Gone once the tear itself is under a pixel, and gone with distance, so far
     water never fizzes. */
  foam *= (1.0 - smoothstep(0.40, 0.95, px)) * (1.0 - smoothstep(320.0, 700.0, dist));
  col = mix(col, uWhitecap * (0.18 + 0.42 * max(NoL, 0.25)), clamp(foam, 0.0, 1.0) * 0.8);

  /* Extinction is exponential and the colour it fades into is the sky along
     this exact view ray, which is why the horizon has no seam across it. */
  col = mix(laylineSky(-V, 0.0), col, exp(-eyeDist * uHaze));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const WaterMaterial = shaderMaterial(
  {
    uTime: 0,
    uWind: new Vector2(0, 1),
    uSunDir: sunDirection(),
    uSkyZenith: new Color(SKY_ZENITH),
    uSkyHorizon: new Color(SKY_HORIZON),
    uSunTint: new Color(SUN_TINT),
    uSunDisc: new Color(SUN_DISC),
    uDeep: new Color(WATER_DEEP),
    uMid: new Color(WATER_MID),
    uSss: new Color(WATER_SCATTER),
    uGlint: new Color(GLINT),
    uWhitecap: new Color(WHITECAP),
    uSunPower: 3.4,
    uFoamBias: 0.80,
    uHaze: HAZE_RHO,
  },
  waterVertex,
  waterFragment,
);

extend({ LaylineWaterMaterial: WaterMaterial });

declare module "@react-three/fiber" {
  interface ThreeElements {
    laylineWaterMaterial: ThreeElement<typeof WaterMaterial>;
  }
}

function clipmapGeometry(): BufferGeometry {
  const positions: number[] = [];
  const stitch: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < RINGS.length; index++) {
    const ring = RINGS[index];
    const half = (ring.cells * ring.spacing) / 2;
    const holeHalf = (ring.hole * ring.spacing) / 2;
    /* The ring outside this one owns the far half of every boundary edge, and
     * its spacing is what a vertex on that edge has to line up with. The
     * outermost ring borders nothing, so it stitches to nothing. */
    const coarse = index + 1 < RINGS.length ? RINGS[index + 1].spacing : 0;
    const stride = ring.cells + 1;
    const slots = new Int32Array(stride * stride).fill(-1);
    const vertex = (i: number, j: number): number => {
      const slot = j * stride + i;
      if (slots[slot] < 0) {
        slots[slot] = positions.length / 3;
        const x = i * ring.spacing - half;
        const z = j * ring.spacing - half;
        positions.push(x, 0, z);
        /* Every half is a whole number of coarse steps, so a vertex is shared
         * with the neighbouring ring exactly when its distance along the edge
         * divides by that step. The ones that do not get their two neighbours;
         * everything else points at itself and takes the plain path. */
        const alongX = i * ring.spacing;
        const alongZ = j * ring.spacing;
        if (coarse > 0 && (i === 0 || i === ring.cells) && alongZ % coarse !== 0) {
          const low = Math.floor(alongZ / coarse) * coarse - half;
          stitch.push(x, low, x, low + coarse);
        } else if (coarse > 0 && (j === 0 || j === ring.cells) && alongX % coarse !== 0) {
          const low = Math.floor(alongX / coarse) * coarse - half;
          stitch.push(low, z, low + coarse, z);
        } else {
          stitch.push(x, z, x, z);
        }
      }
      return slots[slot];
    };
    for (let j = 0; j < ring.cells; j++) {
      for (let i = 0; i < ring.cells; i++) {
        const cx = Math.abs((i + 0.5) * ring.spacing - half);
        const cz = Math.abs((j + 0.5) * ring.spacing - half);
        if (cx < holeHalf && cz < holeHalf) continue;
        const a = vertex(i, j);
        const b = vertex(i + 1, j);
        const c = vertex(i + 1, j + 1);
        const d = vertex(i, j + 1);
        indices.push(a, d, b, b, d, c);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aStitch", new Float32BufferAttribute(stitch, 4));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The water, and it is most of every frame. Displacement, foam and specular all
 * run off the replay clock rather than the render clock, so a frozen page holds
 * a still sea and a stepped one moves it by exactly the milliseconds asked for.
 */
export function Water({ race }: { race: RaceData }) {
  const geometry = useMemo(clipmapGeometry, []);
  const wind = useMemo(() => swellDirection(race), [race]);
  const mesh = useRef<Mesh>(null);
  const material = useRef<InstanceType<typeof WaterMaterial>>(null);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useEffect(() => {
    const target = material.current;
    if (target !== null) target.uniforms.uWind.value.set(wind[0], wind[1]);
  }, [wind]);

  useFrame((state) => {
    const surface = mesh.current;
    const target = material.current;
    if (surface === null || target === null) return;
    target.uniforms.uTime.value = useReplay.getState().t;
    const camera = state.camera.position;
    surface.position.set(
      Math.round(camera.x / SNAP) * SNAP,
      0,
      Math.round(camera.z / SNAP) * SNAP,
    );
    surface.updateMatrix();
  }, -90);

  return (
    <mesh ref={mesh} geometry={geometry} matrixAutoUpdate={false} frustumCulled={false}>
      <laylineWaterMaterial ref={material} />
    </mesh>
  );
}
