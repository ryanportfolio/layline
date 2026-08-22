"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type Mesh,
} from "three";
import { poseAt } from "@/lib/layline/interpolate";
import type { Pose, RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";
import {
  CourseLineMaterial,
  TRACK_LIFT,
  TrackDotMaterial,
  attachLineArrays,
  lineArrays,
  markLineArrays,
  trackColour,
  type LineArrays,
} from "./course";
import { swellDirection } from "./waves";

const DEG = Math.PI / 180;

/* Race time, not frame time. A track sampled on the display refresh is a
 * different length on a 120 Hz laptop and a quarter as long at 4x, which is the
 * one defect this page exists to disprove. */
const TRACK_HZ = 20;
const TRACK_SPAN = 20; // s of history
const TRACK_CAP = 288;
/* Samples closer together than this carry no new shape. The chain restarts on a
 * whole second of race time, so scrubbing to a time twice keeps the same samples
 * both trips. */
const DECIMATE = 0.8;
const TRACK_HALF = 0.26;
const TRACK_FADE = 0.9;
/* Time constant on the fade. At twenty seconds the tail is down to five percent
 * of the head, which is where a track stops being a line and starts being a
 * memory of one. */
const TRACK_TAU = 7;

/* Four a second is what the instrument sent, so four a second is what the raw
 * lens draws, plus the pair either side of the window edge. */
const FIX_PER_BOAT = TRACK_SPAN * 4 + 2;
const DOT_RADIUS = 0.42;
const DOT_LIFT = TRACK_LIFT + 0.02;
/* Parked slots are sent back far enough that their own fade underflows to zero
 * rather than being clipped to it. */
const DOT_PARK = 1000;

interface Ribbon {
  geometry: BufferGeometry;
  arrays: LineArrays;
  count: number;
  anchorK: number;
  headK: number;
  lastX: number;
  lastZ: number;
  dirty: boolean;
}

function newRibbon(colour: Color): Ribbon {
  const arrays = lineArrays(TRACK_CAP * 2);
  for (let row = 0; row < TRACK_CAP; row++) {
    for (let side = 0; side < 2; side++) {
      const v = row * 2 + side;
      arrays.position[v * 3 + 1] = TRACK_LIFT;
      arrays.span[v] = side === 0 ? -TRACK_HALF : TRACK_HALF;
      arrays.color[v * 3] = colour.r;
      arrays.color[v * 3 + 1] = colour.g;
      arrays.color[v * 3 + 2] = colour.b;
      arrays.fade[v] = TRACK_FADE;
      arrays.life[v] = 1 / TRACK_TAU;
    }
  }
  const index: number[] = [];
  for (let row = 0; row + 1 < TRACK_CAP; row++) {
    const a = row * 2;
    index.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const geometry = new BufferGeometry();
  attachLineArrays(geometry, arrays);
  geometry.setIndex(index);
  geometry.setDrawRange(0, 0);
  /* The track follows the boat across the whole course and the camera sits
   * inside it, so a bounding sphere would only ever say yes. */
  geometry.boundingSphere = null;
  return {
    geometry,
    arrays,
    count: 0,
    anchorK: Number.NaN,
    headK: Number.NaN,
    lastX: 0,
    lastZ: 0,
    dirty: false,
  };
}

/* Always the interpolated pose, whichever lens the page is showing. The raw lens
 * swaps the ribbon out for the fixes it was built from rather than making the
 * ribbon itself steppy: a stepped ribbon under a stepped hull would be the same
 * claim made twice. */
function emit(rib: Ribbon, race: RaceData, boatId: string, k: number, pose: Pose): void {
  rib.headK = k;
  if (rib.count >= TRACK_CAP) return;
  poseAt(race, boatId, k / TRACK_HZ, "smooth", pose);
  const x = pose.x;
  const z = -pose.y;
  if (rib.count > 0) {
    const dx = x - rib.lastX;
    const dz = z - rib.lastZ;
    if (dx * dx + dz * dz < DECIMATE * DECIMATE) return;
  }
  const rad = pose.hdg * DEG;
  const forwardX = Math.sin(rad);
  const forwardZ = -Math.cos(rad);
  const row = rib.count;
  for (let side = 0; side < 2; side++) {
    const v = row * 2 + side;
    rib.arrays.position[v * 3] = x;
    rib.arrays.position[v * 3 + 2] = z;
    rib.arrays.perp[v * 2] = -forwardZ;
    rib.arrays.perp[v * 2 + 1] = forwardX;
    rib.arrays.time[v] = k / TRACK_HZ;
  }
  rib.count = row + 1;
  rib.lastX = x;
  rib.lastZ = z;
  rib.dirty = true;
}

function advance(rib: Ribbon, race: RaceData, boatId: string, t: number, pose: Pose): void {
  const k = Math.floor(t * TRACK_HZ);
  const anchorK = Math.ceil(t - TRACK_SPAN) * TRACK_HZ;
  if (anchorK !== rib.anchorK || !(k >= rib.headK)) {
    rib.anchorK = anchorK;
    rib.count = 0;
    rib.dirty = true;
    for (let step = anchorK; step <= k; step++) emit(rib, race, boatId, step, pose);
    return;
  }
  for (let step = rib.headK + 1; step <= k; step++) emit(rib, race, boatId, step, pose);
}

function newPose(): Pose {
  return { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
}

/**
 * Where each boat has been, in its own hue. Twenty seconds of it, and the lens
 * decides what that history looks like: a fading ribbon off the evaluator in
 * smooth mode, the fixes themselves in raw. Neither is violet, because violet
 * belongs to the chip in the console rather than to a boat.
 */
export function BoatTracks({ race }: { race: RaceData }) {
  const count = race.boats.length;
  const wind = useMemo(() => swellDirection(race), [race]);
  const pose = useMemo(newPose, []);
  const ribbonNodes = useMemo<(Mesh | null)[]>(() => race.boats.map(() => null), [race]);
  const dotNode = useRef<Mesh>(null);

  const kit = useMemo(() => {
    const hue = new Color();
    const ribbons: Ribbon[] = [];
    for (const boat of race.boats) ribbons.push(newRibbon(trackColour(boat, hue)));

    const material = new CourseLineMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = DoubleSide;
    material.uniforms.uWind.value.set(wind[0], wind[1]);

    /* One quad, drawn once per fix on screen. Instanced attributes rather than
     * matrices: a dot is a place and a time, and sixteen floats to say that is
     * fifteen more than it needs. */
    const dots = new InstancedBufferGeometry();
    dots.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    dots.setIndex([0, 1, 2, 0, 2, 3]);
    const slots = count * FIX_PER_BOAT;
    const dotData = new Float32Array(slots * 3);
    const dotColour = new Float32Array(slots * 3);
    /* A dot's hue never changes, so it is dealt once per slot and the loop only
     * ever writes where and when. */
    for (let i = 0; i < count; i++) {
      trackColour(race.boats[i], hue);
      for (let j = 0; j < FIX_PER_BOAT; j++) {
        const slot = i * FIX_PER_BOAT + j;
        dotColour[slot * 3] = hue.r;
        dotColour[slot * 3 + 1] = hue.g;
        dotColour[slot * 3 + 2] = hue.b;
      }
    }
    dots.setAttribute("aDot", new InstancedBufferAttribute(dotData, 3));
    dots.setAttribute("aColor", new InstancedBufferAttribute(dotColour, 3));
    dots.instanceCount = slots;
    dots.boundingSphere = null;

    const dotMaterial = new TrackDotMaterial();
    dotMaterial.transparent = true;
    dotMaterial.depthWrite = false;
    dotMaterial.uniforms.uWind.value.set(wind[0], wind[1]);
    dotMaterial.uniforms.uRadius.value = DOT_RADIUS;
    dotMaterial.uniforms.uLift.value = DOT_LIFT;
    dotMaterial.uniforms.uLife.value = 1 / TRACK_TAU;

    return {
      ribbons,
      material,
      dots,
      dotData,
      dotMaterial,
      dispose: () => {
        for (const ribbon of ribbons) ribbon.geometry.dispose();
        material.dispose();
        dots.dispose();
        dotMaterial.dispose();
      },
    };
  }, [count, race, wind]);

  useEffect(() => kit.dispose, [kit]);

  useFrame((state) => {
    const { t, mode } = useReplay.getState();
    const raw = mode === "raw";
    const height = state.gl.domElement.height;
    kit.material.uniforms.uTime.value = t;
    kit.material.uniforms.uHeight.value = height;
    kit.dotMaterial.uniforms.uTime.value = t;
    kit.dotMaterial.uniforms.uHeight.value = height;

    for (let i = 0; i < count; i++) {
      const node = ribbonNodes[i];
      if (node !== null) node.visible = !raw;
      if (raw) continue;
      const rib = kit.ribbons[i];
      advance(rib, race, race.boats[i].id, t, pose);
      if (rib.dirty) {
        markLineArrays(rib.geometry);
        rib.geometry.attributes.aTime.needsUpdate = true;
        rib.geometry.setDrawRange(0, Math.max(0, rib.count - 1) * 6);
        rib.dirty = false;
      }
    }

    const dots = dotNode.current;
    if (dots === null) return;
    dots.visible = raw;
    if (!raw) return;

    /* The camera's own right and up, so a fix reads as a disc from the chase rig
     * four metres off the sea as well as from a hundred and sixty. */
    state.camera.updateMatrixWorld();
    const basis = state.camera.matrixWorld.elements;
    kit.dotMaterial.uniforms.uRight.value.set(basis[0], basis[1], basis[2]);
    kit.dotMaterial.uniforms.uUp.value.set(basis[4], basis[5], basis[6]);

    for (let i = 0; i < count; i++) {
      const fixes = race.fixes[race.boats[i].id];
      const base = i * FIX_PER_BOAT;
      let written = 0;
      if (fixes !== undefined) {
        for (let f = 0; f < fixes.length && written < FIX_PER_BOAT; f++) {
          const fix = fixes[f];
          if (fix.t > t) break;
          if (fix.t < t - TRACK_SPAN) continue;
          const at = base + written;
          kit.dotData[at * 3] = fix.x;
          kit.dotData[at * 3 + 1] = -fix.y;
          kit.dotData[at * 3 + 2] = fix.t;
          written++;
        }
      }
      /* Instanced attributes are read in order, so a gap in the middle of the
       * run would redraw whatever the slot held last. Anything a boat did not
       * fill is stamped with a time far enough back that its own fade is zero. */
      for (let j = written; j < FIX_PER_BOAT; j++) {
        const at = base + j;
        kit.dotData[at * 3 + 2] = t - DOT_PARK;
      }
    }
    kit.dots.attributes.aDot.needsUpdate = true;
  }, -55);

  return (
    <>
      {race.boats.map((boat, index) => (
        <mesh
          key={boat.id}
          ref={(node) => {
            ribbonNodes[index] = node;
          }}
          geometry={kit.ribbons[index].geometry}
          material={kit.material}
          frustumCulled={false}
          renderOrder={5}
        />
      ))}
      <mesh
        ref={dotNode}
        geometry={kit.dots}
        material={kit.dotMaterial}
        visible={false}
        frustumCulled={false}
        renderOrder={5}
      />
    </>
  );
}
