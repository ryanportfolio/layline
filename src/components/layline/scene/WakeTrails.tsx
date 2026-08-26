"use client";

import { useEffect, useMemo, useRef } from "react";
import { shaderMaterial } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  Object3D,
  PlaneGeometry,
  Vector2,
  type InstancedMesh,
} from "three";
import { createPose, poseAt } from "@/lib/layline/interpolate";
import { hashString, mulberry32 } from "@/lib/prng";
import type { Pose, RaceData, ReplayMode } from "@/lib/layline/types";
import { useReplay } from "../store";
import { fleetFrame } from "./frame";
import { WHITECAP } from "./sky";
import { SKIFF, sprayTexture } from "./skiff";
import { WAVE_GLSL, swellDirection } from "./waves";

const DEG = Math.PI / 180;

/* Race time, not frame time. A ribbon built off the display refresh is a
 * different length on a 120 Hz laptop and a quarter as long at 4x, which is
 * exactly the defect this page exists to disprove. */
const WAKE_HZ = 30;
const WAKE_SPAN = 8; // s of history
const WAKE_CAP = 300;
/* Samples closer together than this carry no new shape, so they are dropped
 * rather than stored. The chain they are measured against restarts on a whole
 * second of race time, which is what keeps the ribbon a function of the clock:
 * scrub to a time twice and the same samples survive both trips. */
const DECIMATE = 0.5;

/* The cross section of a wake, sampled where its shape actually changes. Five
 * columns put the outer tip and the arm on the same vertex, and since the tip
 * has to fade to nothing for the edge to antialias, the arm faded with it and
 * the brightest part of a wake came out as a strip a hand's width across. Seven
 * columns separate them: a tip that fades, an arm that does not, the open lane
 * inboard of it, and the churn on the centreline. */
const COLUMNS = [-1, -0.86, -0.55, 0, 0.55, 0.86, 1];
const COLUMN_WEIGHT = [0.62, 1, 0.34, 0.9, 0.34, 1, 0.62];
const COLS = COLUMNS.length;

const SPRAY_SLOTS = 14;
/* One droplet every fourteenth of a cycle over three quarters of a second of
 * flight, so they are spread down the throw instead of arriving together and
 * reading as one blob on the deck. */
const SPRAY_RATE = 1.35;
const SPRAY_LIFE = 1 / SPRAY_RATE;
/* The throw, and what pulls it back down. Not gravity: a droplet this size is
 * mostly drag and the sheet is being torn off the chine rather than launched,
 * so the arc is flatter and slower than ballistics would draw it. The numbers
 * are chosen against the sea rather than against the boat, because a peak of a
 * fifth of a metre over a surface that itself moves four tenths never leaves
 * the water at all: these top out near a metre inside the droplet's life. */
const SPRAY_LIFT = 3.2;
const SPRAY_LIFT_SPREAD = 0.9;
const SPRAY_FALL = 3.4;

/* How high the near foam stands off the water. A ribbon laid flat is edge on
 * from a chase camera four metres up and disappears, however much alpha it
 * carries: the bow waves and the transom boil have to have height, and it has
 * to last. At a quarter of a metre against a 0.85 m sea, decaying inside a
 * second and a half, there was nothing left by the time the hull was clear of
 * it and five boats at speed sat on undisturbed water. */
const WAKE_CREST = 0.62;
const WAKE_BOIL = 0.46;
const WAKE_LIP = 0.19;

/* Half width at the stem, and the half width the arms open to and then hold.
 * The arms of a wake run parallel once they are clear of the hull; an age times
 * speed product with nothing on the end of it had the tail thirteen metres
 * across before it faded, which reads as a foam field rather than as a wake. */
const WAKE_STEM = 0.55;
const WAKE_SPREAD = 5.5;
const WAKE_OPEN = WAKE_SPREAD - WAKE_STEM;

const wakeVertex = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uSpan;

attribute vec2 aPerp;
attribute vec3 aWake;
attribute float aWeight;

varying float vAge;
varying float vSide;
varying float vWeight;
varying float vGain;
varying float vStand;
varying float vRun;
varying float vSog;
varying vec2 vGround;

${WAVE_GLSL}

void main() {
  float age = max(uTime - aWake.x, 0.0);
  float side = aWake.y;
  float sog = aWake.z;
  float edge = abs(side);
  /* Full by four metres a second, which is what these hulls carry round a mark
     and a long way under what they carry on the run. A gate that only opened at
     six left every boat in the rounding window sitting on undisturbed water. */
  float gain = smoothstep(1.0, 4.0, sog);
  /* Not the 19.47 degree Kelvin V. That half angle holds below Froude 0.5 and
     the fastest hull in this replay runs near 1.2, where the wake narrows like
     a Mach cone because the boat cannot excite a wave longer than itself.
     Eight degrees under full power, opening back toward the displacement angle
     as the boat drops off through a tack. */
  float arm = mix(0.34, 0.14, clamp((sog - 4.0) / 4.5, 0.0, 1.0));
  /* Same opening angle off the stem, run through a saturating curve so the arms
     stop widening once they are clear of the hull. */
  float open = ${WAKE_OPEN.toFixed(3)};
  float run = age * sog;
  float spread = ${WAKE_STEM.toFixed(3)} + open * (1.0 - exp(-tan(arm) * run / open));
  /* Where the boat still is. A column laid down at the stem spends the next
     four and a half metres under the hull, so the middle of the ribbon waits
     for the transom to pass. The arms do not wait: half a metre outboard they
     are already clear of the topsides, and that is the bow wave, the one piece
     of foam that has to be touching the hull or the boat reads as sitting on
     the water rather than going through it. Flat, and under the sheer, so the
     hull occludes whatever of it is on the far side. */
  float clear = max(smoothstep(2.8, 5.2, run), smoothstep(0.62, 1.10, spread * edge));
  /* Standing water needs more room than flat foam does. A crest half a metre
     tall is taller than this boat's freeboard, so it may only rise where it is
     genuinely outside the hull: astern of the transom, which sits four and a
     half metres behind the stem the ribbon is laid from, or wider than the
     racks. Inside that the sheet stays flat and the depth test hides it. */
  float proud = max(smoothstep(4.6, 7.4, run), smoothstep(1.75, 2.5, spread * edge));
  /* The stem wave is not on the speed gate at all. A hull moving at all throws
     water off its bow and churns it under its transom, so the first nine metres
     astern run on their own threshold and it is the length of the tail behind
     them that scales with speed. Measured astern rather than in seconds, so a
     slow boat cannot have it expire before the hull is off it. */
  float stem = smoothstep(1.4, 2.6, sog) * (1.0 - smoothstep(3.0, 9.0, run));
  float power = max(gain, stem);
  float drive = power * clear;
  vec2 column = position.xz + aPerp * side * spread;
  /* The diverging bow waves stand up along the arms and the transom boil fills
     between them a beat later, which is the order they happen in: the stem
     throws first and the hull has to pass before the churn exists. Both hold
     for the two and a half to three seconds it takes a chase camera eighteen
     metres astern to sail through them. */
  float crest = smoothstep(0.0, 0.3, age) * exp(-age * 0.34) * edge * edge;
  float boil = (age / 1.15) * exp(1.0 - age / 1.15) * (1.0 - smoothstep(0.0, 0.72, edge));
  float stand = (${WAKE_CREST.toFixed(3)} * crest + ${WAKE_BOIL.toFixed(3)} * boil) * power * proud;
  /* The lip alongside the bow, kept small on purpose. It is the one piece of
     relief allowed inside the boat's own beam, so it has to stay under the
     freeboard: at this height it is water standing against the topside, and
     any taller it would be water standing on the side deck. */
  stand += ${WAKE_LIP.toFixed(3)}
    * smoothstep(0.55, 1.05, spread * edge)
    * (1.0 - smoothstep(2.0, 9.0, run))
    * smoothstep(1.2, 2.6, sog);
  stand *= 1.0 - smoothstep(0.45, 1.0, age / uSpan);
  vec2 base = laylineColumn(column, uTime, uWind, cameraPosition.xz);
  vec3 disp;
  float jac;
  vec3 nrm;
  laylineWaves(base, uTime, uWind, length(base - cameraPosition.xz), disp, jac, nrm);
  /* Same surface the hull is floated on: the height of the water over this
     world column, not the height at a base point the swell has since carried
     four metres away. The fixed lift is what keeps the sheet clear of a
     surface the clipmap only draws in chords. */
  vec3 world = vec3(column.x, disp.y + 0.09 + stand, column.y);
  vAge = age;
  vSide = side;
  vWeight = aWeight;
  vGain = drive;
  vStand = stand;
  vRun = run;
  vSog = sog;
  vGround = base;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const wakeFragment = /* glsl */ `
uniform float uTime;
uniform float uSpan;
uniform vec3 uFoam;

varying float vAge;
varying float vSide;
varying float vWeight;
varying float vGain;
varying float vStand;
varying float vRun;
varying float vSog;
varying vec2 vGround;

float wakeHash(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float wakeNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(wakeHash(i), wakeHash(i + vec2(1.0, 0.0)), u.x),
    mix(wakeHash(i + vec2(0.0, 1.0)), wakeHash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

void main() {
  float edge = abs(vSide);
  float life = clamp(vAge / uSpan, 0.0, 1.0);
  /* Solid while the hull is still on top of it, then the churn behind the
     transom goes first and the arms outlive it, which is why a broadcast wake
     reads as a long thin V with a bright stub in it. */
  float decay = exp(-max(vAge - 2.2, 0.0) / mix(3.4, 5.2, edge));
  /* The lane down the middle. The churn behind the transom fills it for the
     first couple of seconds and then drains away, which is what leaves a wake
     reading as two diverging arms with open water between them instead of as
     one broad pale field. Nothing else in the ribbon says which way the boat
     went. */
  float core = 1.0 - smoothstep(0.0, 0.5, edge);
  float lane = mix(1.0, 0.34, smoothstep(2.2, 4.6, vAge));
  float blotch = wakeNoise(vGround * 1.5);
  float torn = mix(0.45, 1.25, wakeNoise(vGround * 3.6 + vec2(11.3, 7.1)));
  /* Foam tears itself apart as it ages: a sheet behind the transom, lace by
     the time it is three boat lengths back. The tearing runs on the same clock
     as the fade, so the ribbon thins as it breaks up instead of leaving
     blotches floating in open water with no boat to explain them. Water that
     has only just left the hull is not lace yet, whatever the noise says. */
  float bite = 0.85 * life * life;
  float lace = mix(1.0, smoothstep(bite, bite + 0.3, blotch), smoothstep(0.35, 1.4, vAge));
  float alpha = decay * vWeight * torn * lace * vGain;
  alpha *= mix(1.0, lane, core);
  alpha *= (1.0 + 2.4 * vStand) * (1.0 - smoothstep(0.86, 1.0, edge));
  /* Nothing survives the span the ribbon is built to hold, whatever the
     exponential still has left in it. */
  alpha *= 1.0 - smoothstep(0.55, 1.0, life);
  /* The band the hull has just torn open, measured astern rather than in
     seconds and taken through none of the ribbon's own gates. Those gates exist
     to keep bright foam off the boat and to break the tail up as it ages, and
     both of them were eating the one piece a chase camera can actually see:
     the water directly behind the transom, which is what ties a hull moving at
     six knots to the sea it is moving through. */
  float wash = smoothstep(1.5, 2.9, vSog)
    * smoothstep(4.5, 5.8, vRun)
    * (1.0 - smoothstep(8.5, 14.0, vRun))
    * (1.0 - smoothstep(0.55, 1.0, edge));
  alpha = max(alpha, wash * torn * 0.94);
  /* And the same for the arms alongside the bow. This is the white line a hull
     carries at its own waterline, the piece that says the boat is going through
     the water rather than resting on it, and it is inside every gate the rest
     of the ribbon answers to. */
  float bow = smoothstep(1.3, 2.6, vSog)
    * (1.0 - smoothstep(3.0, 8.0, vRun))
    * smoothstep(0.46, 0.86, edge)
    * (1.0 - smoothstep(0.86, 1.0, edge));
  alpha = max(alpha, bow * torn * 0.95);
  if (alpha < 0.006) discard;
  /* Relief with no light on it is still a flat sheet. The crests take the value
     the sun would give a face turned up at it and the flanks stay under, which
     is what reads as water standing up rather than as paint on the water. */
  vec3 foam = uFoam * (0.95 + 0.5 * clamp(vStand * 2.4, 0.0, 1.0));
  gl_FragColor = vec4(foam, clamp(alpha, 0.0, 0.96));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const WakeMaterial = shaderMaterial(
  { uTime: 0, uSpan: WAKE_SPAN, uWind: new Vector2(0, 1), uFoam: new Color(WHITECAP) },
  wakeVertex,
  wakeFragment,
);

/* The droplets carry their own fade rather than their own colour: additive
 * white over a deck that is already pale blows out to a hard dot, and an
 * instance colour dimmed toward black under normal blending leaves a grey one
 * behind. One float per instance, straight into alpha. */
const sprayVertex = /* glsl */ `
attribute float aFade;

varying float vFade;
varying vec2 vUv;

void main() {
  vUv = uv;
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const sprayFragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uFoam;

varying float vFade;
varying vec2 vUv;

void main() {
  float alpha = texture2D(uMap, vUv).a * vFade;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uFoam, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SprayMaterial = shaderMaterial(
  { uMap: null, uFoam: new Color(WHITECAP) },
  sprayVertex,
  sprayFragment,
);

interface Ribbon {
  geometry: BufferGeometry;
  position: Float32Array;
  perp: Float32Array;
  wake: Float32Array;
  count: number;
  anchorK: number;
  headK: number;
  lastX: number;
  lastZ: number;
  dirty: boolean;
}

function newRibbon(): Ribbon {
  const position = new Float32Array(WAKE_CAP * COLS * 3);
  const perp = new Float32Array(WAKE_CAP * COLS * 2);
  const wake = new Float32Array(WAKE_CAP * COLS * 3);
  const weight = new Float32Array(WAKE_CAP * COLS);
  for (let row = 0; row < WAKE_CAP; row++) {
    for (let c = 0; c < COLS; c++) {
      const v = row * COLS + c;
      wake[v * 3 + 1] = COLUMNS[c];
      weight[v] = COLUMN_WEIGHT[c];
    }
  }
  const index: number[] = [];
  for (let row = 0; row + 1 < WAKE_CAP; row++) {
    for (let c = 0; c + 1 < COLS; c++) {
      const a = row * COLS + c;
      const b = a + COLS;
      index.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  /* BufferAttribute rather than Float32BufferAttribute: the typed variant
   * copies the array it is handed, and a copy is a buffer this loop can never
   * write to again. */
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("aPerp", new BufferAttribute(perp, 2));
  geometry.setAttribute("aWake", new BufferAttribute(wake, 3));
  geometry.setAttribute("aWeight", new BufferAttribute(weight, 1));
  geometry.setIndex(index);
  geometry.setDrawRange(0, 0);
  return {
    geometry,
    position,
    perp,
    wake,
    count: 0,
    anchorK: Number.NaN,
    headK: Number.NaN,
    lastX: 0,
    lastZ: 0,
    dirty: false,
  };
}

function emit(
  rib: Ribbon,
  race: RaceData,
  boatId: string,
  mode: ReplayMode,
  k: number,
  pose: Pose,
): void {
  rib.headK = k;
  if (rib.count >= WAKE_CAP) return;
  poseAt(race, boatId, k / WAKE_HZ, mode, pose);
  const rad = pose.hdg * DEG;
  const forwardX = Math.sin(rad);
  const forwardZ = -Math.cos(rad);
  const x = pose.x + forwardX * SKIFF.bowOffset;
  const z = -pose.y + forwardZ * SKIFF.bowOffset;
  if (rib.count > 0) {
    const dx = x - rib.lastX;
    const dz = z - rib.lastZ;
    if (dx * dx + dz * dz < DECIMATE * DECIMATE) return;
  }
  const row = rib.count;
  for (let c = 0; c < COLS; c++) {
    const v = row * COLS + c;
    rib.position[v * 3] = x;
    rib.position[v * 3 + 2] = z;
    rib.perp[v * 2] = -forwardZ;
    rib.perp[v * 2 + 1] = forwardX;
    rib.wake[v * 3] = k / WAKE_HZ;
    rib.wake[v * 3 + 2] = pose.sog;
  }
  rib.count = row + 1;
  rib.lastX = x;
  rib.lastZ = z;
  rib.dirty = true;
}

function advance(
  rib: Ribbon,
  race: RaceData,
  boatId: string,
  mode: ReplayMode,
  t: number,
  pose: Pose,
): void {
  const k = Math.floor(t * WAKE_HZ);
  const anchorK = Math.ceil(t - WAKE_SPAN) * WAKE_HZ;
  if (anchorK !== rib.anchorK || !(k >= rib.headK)) {
    rib.anchorK = anchorK;
    rib.count = 0;
    rib.dirty = true;
    for (let kk = anchorK; kk <= k; kk++) emit(rib, race, boatId, mode, kk, pose);
    return;
  }
  for (let kk = rib.headK + 1; kk <= k; kk++) emit(rib, race, boatId, mode, kk, pose);
}

function newPose(): Pose {
  return createPose();
}

/**
 * The foam that ties every hull to the water. A ribbon laid down from the stem
 * on race time, and above about seven metres a second the bow starts throwing
 * spray as well.
 */
export function WakeTrails({ race }: { race: RaceData }) {
  const count = race.boats.length;
  const wind = useMemo(() => swellDirection(race), [race]);
  const pose = useMemo(newPose, []);

  const kit = useMemo(() => {
    const ribbons: Ribbon[] = [];
    for (let i = 0; i < count; i++) ribbons.push(newRibbon());
    const material = new WakeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = DoubleSide;
    /* A gentle offset, and no more. The ribbon is nearly edge on from a chase
     * camera, so its depth slope is enormous and a factor of -4 pulled the
     * sheet metres toward the eye: the foam came out drawn over the racks and
     * turned every boat pale. The nine centimetre lift in the vertex stage is
     * what keeps it off the water; this is only for the far chords. */
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
    material.uniforms.uWind.value.set(wind[0], wind[1]);

    const sprite = new PlaneGeometry(1, 1);
    const fade = new Float32Array(count * SPRAY_SLOTS);
    sprite.setAttribute("aFade", new InstancedBufferAttribute(fade, 1));
    const texture = sprayTexture();
    const spray = new SprayMaterial();
    spray.transparent = true;
    spray.depthWrite = false;
    spray.uniforms.uMap.value = texture;

    /* One phase and one throw per droplet, drawn once from the boat's own seed.
     * Nothing in the scene is allowed a fresh random number: the same instant
     * has to produce the same frame on every load. The phases are dealt one per
     * slot rather than drawn free, because eight free draws leave gaps and
     * clumps and a clump is what reads as a single blown out dot. */
    const phase = new Float32Array(count * SPRAY_SLOTS);
    const lateral = new Float32Array(count * SPRAY_SLOTS);
    const shoulder = new Float32Array(count * SPRAY_SLOTS);
    const lift = new Float32Array(count * SPRAY_SLOTS);
    for (let i = 0; i < count; i++) {
      const random = mulberry32(hashString(`layline-spray-${race.boats[i].id}`));
      for (let j = 0; j < SPRAY_SLOTS; j++) {
        const slot = i * SPRAY_SLOTS + j;
        const side = j % 2 === 0 ? 1 : -1;
        phase[slot] = (j + 0.7 * random()) / SPRAY_SLOTS;
        lateral[slot] = side * (0.4 + 0.6 * random());
        /* Off the chine, not off the stem point. Water leaves a planing hull
         * where the bottom panel meets the topside, roughly half a metre either
         * side of the centreline at this station, and a sheet thrown from the
         * middle of the bow reads as a fountain instead. */
        shoulder[slot] = side * (0.5 + 0.28 * random());
        lift[slot] = SPRAY_LIFT + SPRAY_LIFT_SPREAD * random();
      }
    }

    return {
      ribbons,
      material,
      sprite,
      texture,
      spray,
      fade,
      phase,
      lateral,
      shoulder,
      lift,
      dispose: () => {
        for (const ribbon of ribbons) ribbon.geometry.dispose();
        material.dispose();
        sprite.dispose();
        texture.dispose();
        spray.dispose();
      },
    };
  }, [count, race, wind]);

  const dummy = useMemo(() => new Object3D(), []);
  const sprayRef = useRef<InstancedMesh>(null);

  useEffect(() => kit.dispose, [kit]);

  useFrame((state) => {
    const { t, mode } = useReplay.getState();
    kit.material.uniforms.uTime.value = t;

    for (let i = 0; i < count; i++) {
      const rib = kit.ribbons[i];
      advance(rib, race, race.boats[i].id, mode, t, pose);
      if (rib.dirty) {
        rib.geometry.attributes.position.needsUpdate = true;
        rib.geometry.attributes.aPerp.needsUpdate = true;
        rib.geometry.attributes.aWake.needsUpdate = true;
        rib.geometry.setDrawRange(0, Math.max(0, rib.count - 1) * (COLS - 1) * 6);
        rib.dirty = false;
      }
    }

    const mesh = sprayRef.current;
    if (mesh === null) return;
    const camera = state.camera;
    for (let i = 0; i < count; i++) {
      const slot = fleetFrame[i];
      /* Nothing until the boat is up and planing at about seven metres a
       * second, full by seven and a half: on the beat these hulls push water,
       * on the run they throw it. */
      const gain =
        slot === undefined ? 0 : Math.min(Math.max((slot.sog - 6.2) / 1.4, 0), 1);
      /* Starboard, from the heading the hulls already worked out this frame. */
      const rightX = slot === undefined ? 1 : -slot.headZ;
      const rightZ = slot === undefined ? 0 : slot.headX;
      for (let j = 0; j < SPRAY_SLOTS; j++) {
        const index = i * SPRAY_SLOTS + j;
        const cycle = t * SPRAY_RATE + kit.phase[index];
        const life = cycle - Math.floor(cycle);
        let alpha = 0;
        if (gain > 0.01 && slot !== undefined) {
          /* Thrown from the stem, not from the ribbon: the ribbon is a track
           * the boat has already left and its centre column is inboard of the
           * hull the moment the swell carries it. The boat sails out from under
           * its own spray, which is why the droplet travels aft as it ages. */
          const age = life * SPRAY_LIFE;
          const out = kit.shoulder[index] + kit.lateral[index] * (0.35 + 2.0 * age);
          const drift = slot.sog * age * 0.72;
          const px = slot.bowX + rightX * out - slot.headX * drift;
          const pz = slot.bowZ + rightZ * out - slot.headZ * drift;
          const py = Math.max(
            slot.surface + 0.12 + kit.lift[index] * age - SPRAY_FALL * age * age,
            slot.surface + 0.02,
          );
          /* A droplet cloud is the size it is; how hard the boat is working
           * decides whether it is there at all, not how big it looks. */
          dummy.position.set(px, py, pz);
          dummy.quaternion.copy(camera.quaternion);
          dummy.scale.setScalar(0.3 + 0.92 * life);
          /* Held through the climb and dropped on the way down. Fading from the
           * moment of release put the faintest droplet at the top of the arc,
           * which is the only part of the throw that is over the sea rather
           * than in it. */
          const spent = Math.min(Math.max((life - 0.5) * 2, 0), 1);
          alpha = (1 - spent * spent) * gain * 0.92;
        } else {
          dummy.position.set(0, -40, 0);
          dummy.quaternion.identity();
          dummy.scale.setScalar(0);
        }
        kit.fade[index] = alpha;
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    kit.sprite.attributes.aFade.needsUpdate = true;
  }, -70);

  return (
    <>
      {race.boats.map((boat, index) => (
        <mesh
          key={boat.id}
          geometry={kit.ribbons[index].geometry}
          material={kit.material}
          frustumCulled={false}
          renderOrder={2}
        />
      ))}
      <instancedMesh
        ref={sprayRef}
        args={[kit.sprite, kit.spray, count * SPRAY_SLOTS]}
        frustumCulled={false}
        renderOrder={3}
      />
    </>
  );
}
