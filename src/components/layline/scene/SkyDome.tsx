"use client";

import { useEffect, useMemo } from "react";
import { shaderMaterial } from "@react-three/drei";
import { extend, type ThreeElement } from "@react-three/fiber";
import { BackSide, BufferGeometry, Color, DoubleSide, Float32BufferAttribute } from "three";
import { hashString, mulberry32 } from "@/lib/prng";
import {
  SHORE,
  SKY_GLSL,
  SKY_HORIZON,
  SKY_ZENITH,
  SUN_DISC,
  SUN_TINT,
  WATER_DEEP,
  sunDirection,
} from "./sky";

/* Far enough out that the shoreline and every ring of the water sit inside it,
 * close enough in that the far plane does not have to grow to hold it. */
const DOME_RADIUS = 7000;

/* Long Beach at 1.8 km, which is the distance that makes it a coast rather than
 * a row of shapes. San Pedro Bay is a breakwater harbour under bluffs, so the
 * coast wraps everything but the window the course points up, and it dissolves
 * into the haze at both ends rather than stopping at an edge. */
const SHORE_RADIUS = 1800;
/* Sixty degrees of open water either side of the course axis, which is the
 * window the wide looks up and the window the windward mark sits in. */
const SHORE_FROM = 30; // deg, course frame
const SHORE_TO = 330;
const SHORE_STEP = 0.75;
const SHORE_TAPER = 20; // deg
const SHORE_BASE = -3;

/* Aerial perspective over land, and it is thinner than the figure the water is
 * tuned with. At the water's density 1.8 km of air hands back 37 percent of the
 * shore's own colour, which is not enough contrast to read as land: the strip
 * sits inside the haze band and looks like a seam in the render. */
const SHORE_HAZE = 0.0003;

/* The bluff behind the terminals, and its height is what decides whether the
 * coast reads as land at all. At this radius a 7 m bank stands five pixels in
 * the wide and under four in the chase, which is a rule on the horizon rather
 * than a shore, and anything on top of it looks like an arcade floating on
 * nothing. Eighteen and a half puts thirteen and nine there, and still leaves
 * the tallest crane inside the 4 percent of frame height a background
 * silhouette is allowed. */
const SHORE_BLUFF = 18.5;

/* Cranes stand in terminals with working water between them, so they are spread
 * along the arc rather than dropped wherever the seed lands. */
const SHORE_TERMINALS = 5;

const DEG = Math.PI / 180;

const skyVertex = /* glsl */ `
varying vec3 vWorld;

void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const SkyMaterial = shaderMaterial(
  {
    uSunDir: sunDirection(),
    uSkyZenith: new Color(SKY_ZENITH),
    uSkyHorizon: new Color(SKY_HORIZON),
    uSunTint: new Color(SUN_TINT),
    uSunDisc: new Color(SUN_DISC),
  },
  skyVertex,
  /* glsl */ `
varying vec3 vWorld;

${SKY_GLSL}

void main() {
  gl_FragColor = vec4(laylineSky(normalize(vWorld - cameraPosition), 1.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,
);

const ShoreMaterial = shaderMaterial(
  {
    uSunDir: sunDirection(),
    uSkyZenith: new Color(SKY_ZENITH),
    uSkyHorizon: new Color(SKY_HORIZON),
    uSunTint: new Color(SUN_TINT),
    uSunDisc: new Color(SUN_DISC),
    uShore: new Color(SHORE),
    uHaze: SHORE_HAZE,
  },
  /* glsl */ `
/* How much of its own colour this corner of the coast keeps. Stepping the
 * height down toward the ends of the arc leaves the last few segments as
 * rectangles lying on the horizon; dissolving them into the haze instead ends
 * the coast where the air ends it, which is how a real one ends. */
attribute float aFade;

varying vec3 vWorld;
varying float vFade;

void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vFade = aFade;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`,
  /* glsl */ `
varying vec3 vWorld;
varying float vFade;
uniform vec3 uShore;
uniform float uHaze;

${SKY_GLSL}

void main() {
  vec3 toEye = vWorld - cameraPosition;
  vec3 haze = laylineSky(normalize(toEye), 0.0);
  gl_FragColor = vec4(mix(haze, uShore, exp(-length(toEye) * uHaze) * vFade), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,
);

extend({ LaylineSkyMaterial: SkyMaterial, LaylineShoreMaterial: ShoreMaterial });

declare module "@react-three/fiber" {
  interface ThreeElements {
    laylineSkyMaterial: ThreeElement<typeof SkyMaterial>;
    laylineShoreMaterial: ThreeElement<typeof ShoreMaterial>;
  }
}

/* One point on the coast, as an angle around the arc, a height in metres, and
 * how much of the shore colour it keeps. */
type Corner = [deg: number, metres: number, fade: number];

function ease(u: number): number {
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return c * c * (3 - 2 * c);
}

/* Bluffs, container terminals and the gantry cranes working them, as flat
 * silhouette quads. It is a scale reference, not scenery: on open water the eye
 * cannot read boat speed without something fixed to measure it against. The
 * chase and the wide both cut it against the sky; the tactical rig is pitched 72
 * degrees down and frames no horizon at all, so none of this reaches it. The
 * seed is fixed so the skyline is the same in every capture. */
function shorelineGeometry(): BufferGeometry {
  const count = Math.round((SHORE_TO - SHORE_FROM) / SHORE_STEP);
  const random = mulberry32(hashString("layline shoreline"));
  const span = SHORE_TO - SHORE_FROM;

  /* A terminal is dredged flat and the bluff steps down to meet it, which is
   * both how a working port sits in a coastline and what stops the cranes
   * reading as an arcade: each one stands on an apron with higher land either
   * side of it, so there is land under every leg and behind every gap. */
  const terminals = [];
  for (let index = 0; index < SHORE_TERMINALS; index++) {
    terminals.push({
      centre: SHORE_FROM + ((index + 0.5) / SHORE_TERMINALS + (random() - 0.5) * 0.05) * span,
      half: 2.2 + random() * 0.9,
      apron: 7 + random() * 2,
    });
  }

  /* The land, and the lowest it ever gets is a terminal apron: even there it
   * stands seven metres clear of the water. A bank that reaches the waterline
   * anywhere cuts the coast into islands, which is the one thing a horizon
   * silhouette must not do. */
  const bluffPhase = random() * Math.PI * 2;
  const ridgePhase = random() * Math.PI * 2;
  const grainPhase = random() * Math.PI * 2;
  const bank: number[] = [];
  for (let i = 0; i <= count; i++) {
    const u = i / count;
    const deg = SHORE_FROM + i * SHORE_STEP;
    /* Three scales, and the shortest one carries the read: the long undulation
     * turns over once every 255 degrees of arc, three chase frames wide, so on
     * its own the ridge line comes out dead flat across any frame that holds
     * it. The 42 degree term is the one that puts headlands in the picture. */
    let land =
      SHORE_BLUFF +
      4 * Math.sin(bluffPhase + u * 7.4) +
      2.4 * Math.sin(ridgePhase + u * 19.3) +
      2.2 * Math.sin(grainPhase + u * 44.5) +
      random() * 1.5;
    for (const terminal of terminals) {
      const cut = 1 - ease((Math.abs(deg - terminal.centre) - terminal.half) / 1.3);
      land += (terminal.apron - land) * cut;
    }
    bank.push(land);
  }
  const bankAt = (deg: number): number => bank[Math.round((deg - SHORE_FROM) / SHORE_STEP)];

  const fade: number[] = [];
  for (let i = 0; i <= count; i++) {
    const deg = SHORE_FROM + i * SHORE_STEP;
    fade.push(ease(Math.min(deg - SHORE_FROM, SHORE_TO - deg) / SHORE_TAPER));
  }
  const fadeAt = (deg: number): number => fade[Math.round((deg - SHORE_FROM) / SHORE_STEP)];

  const positions: number[] = [];
  const fades: number[] = [];
  const corner = (point: Corner): void => {
    const a = point[0] * DEG;
    positions.push(Math.sin(a) * SHORE_RADIUS, point[1], -Math.cos(a) * SHORE_RADIUS);
    fades.push(point[2]);
  };
  const face = (p0: Corner, p1: Corner, p2: Corner, p3: Corner): void => {
    corner(p0);
    corner(p1);
    corner(p2);
    corner(p0);
    corner(p2);
    corner(p3);
  };
  /* A member of the frame: a bar of a stated thickness in metres running
   * between two points. The thickness is taken across the bar rather than
   * across the arc, because a boom laid out along the arc and thickened
   * sideways ends up a fifth of a metre deep and renders as a dotted line. */
  const member = (
    fromDeg: number,
    fromY: number,
    toDeg: number,
    toY: number,
    thick: number,
    at: number,
  ): void => {
    const metresPerDeg = SHORE_RADIUS * DEG;
    const runX = (toDeg - fromDeg) * metresPerDeg;
    const runY = toY - fromY;
    const length = Math.hypot(runX, runY) || 1;
    const acrossY = ((runX / length) * thick) / 2;
    const acrossDeg = ((-runY / length) * thick) / 2 / metresPerDeg;
    face(
      [fromDeg - acrossDeg, fromY - acrossY, at],
      [fromDeg + acrossDeg, fromY + acrossY, at],
      [toDeg + acrossDeg, toY + acrossY, at],
      [toDeg - acrossDeg, toY - acrossY, at],
    );
  };

  /* Neighbouring tops are joined instead of each segment carrying a flat lid of
   * its own, so the skyline is a ridge line rather than a staircase. */
  for (let i = 0; i < count; i++) {
    const from = SHORE_FROM + i * SHORE_STEP;
    const to = from + SHORE_STEP;
    face(
      [from, SHORE_BASE, fade[i]],
      [to, SHORE_BASE, fade[i + 1]],
      [to, bank[i + 1], fade[i + 1]],
      [from, bank[i], fade[i]],
    );
  }

  /* A container gantry is an A frame on a portal with a boom cantilevered out
   * over the berth, not the rectangular arch a pair of legs and a lintel draws.
   * Every one of these gets its own height, gauge, boom length and boom side
   * from the same stream, because six of the same shape in a row along the
   * horizon is an arcade and an arcade is architecture, not a port. */
  for (const terminal of terminals) {
    const cranes = 2 + Math.floor(random() * 2);
    const pitch = 1.3 + random() * 0.5;
    /* One berth, one direction: cranes on the same wharf all reach out over the
     * same water. Only the reach and the height change down the row. */
    const side = random() < 0.5 ? -1 : 1;
    for (let index = 0; index < cranes; index++) {
      const centre = terminal.centre + (index - (cranes - 1) / 2) * pitch;
      if (centre <= SHORE_FROM || centre >= SHORE_TO) continue;
      const at = fadeAt(centre);
      const sill = bankAt(centre);
      /* Two height bands that cannot overlap, taken in turn down the row. Drawn
       * from one range instead, neighbours land within a few centimetres of
       * each other often enough that a pair of them shares a top, and a shared
       * top at this distance is the arcade coming back. */
      const apex = index % 2 === 0 ? 31 + random() * 5 : 38.5 + random() * 5.2;
      const gauge = 0.78 + random() * 0.38;
      const portal = apex * (0.4 + random() * 0.08);
      const boom = (0.95 + random() * 0.8) * side;
      const back = boom * -(0.3 + random() * 0.16);
      const hinge = apex * (0.54 + random() * 0.06);
      const boomTip = apex * (0.6 + random() * 0.2);
      const backTip = apex * (0.66 + random() * 0.1);
      /* Legs raking in to a machinery deck, an A frame above it, and the boom
       * hung off the deck with a stay running back up to the apex. The stay is
       * the member that makes the shape a crane: without it the boom is a bar
       * balanced on a point and the whole thing reads as a pylon. */
      member(centre - gauge / 2, sill, centre - gauge * 0.29, portal, 3.2, at);
      member(centre + gauge / 2, sill, centre + gauge * 0.29, portal, 3.2, at);
      face(
        [centre - gauge * 0.34, portal, at],
        [centre + gauge * 0.34, portal, at],
        [centre + gauge * 0.34, portal + 3.6, at],
        [centre - gauge * 0.34, portal + 3.6, at],
      );
      member(centre - gauge * 0.3, portal + 3.6, centre, apex, 2.6, at);
      member(centre + gauge * 0.3, portal + 3.6, centre, apex, 2.6, at);
      member(centre, hinge, centre + boom, boomTip, 3.6, at);
      member(centre, hinge, centre + back, backTip, 2.8, at);
      member(centre, apex, centre + boom * 0.9, hinge + (boomTip - hinge) * 0.9, 2.4, at);
      member(centre, apex, centre + back * 0.9, hinge + (backTip - hinge) * 0.9, 2.4, at);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aFade", new Float32BufferAttribute(fades, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Sun, sky and the far shore. The dome writes no depth and draws first, so it
 * is a background rather than an object: nothing has to be sorted against it
 * and the water can run out past it without punching a hole.
 */
export function SkyDome() {
  const sun = useMemo(sunDirection, []);
  const shore = useMemo(shorelineGeometry, []);
  useEffect(() => () => shore.dispose(), [shore]);

  return (
    <>
      <mesh renderOrder={-1000} frustumCulled={false}>
        <sphereGeometry args={[DOME_RADIUS, 48, 24]} />
        <laylineSkyMaterial side={BackSide} depthWrite={false} />
      </mesh>

      <mesh geometry={shore} frustumCulled={false}>
        <laylineShoreMaterial side={DoubleSide} />
      </mesh>

      {/* One sun. Everything that catches a highlight catches it from here, so
          the glint on the water and the lit side of a hull cannot disagree. The
          level is set high enough that a white topside lands on the shoulder of
          the tone curve and desaturates back toward white: a warm sun on a
          mid-grey exposure turns every pale livery tan. */}
      <directionalLight
        position={[sun.x * 600, sun.y * 600, sun.z * 600]}
        intensity={4.6}
        color={SUN_TINT}
      />
      {/* Sky fill, not a second sun: it lifts the shaded side of a sail off
          black without casting a highlight of its own. */}
      <hemisphereLight args={[SKY_HORIZON, WATER_DEEP, 0.5]} />
    </>
  );
}
