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
import { createPose, poseAt } from "@/lib/layline/interpolate";
import {
  createReplayRawFixEvidenceModel,
  RAW_FIX_EVIDENCE_SLOTS_PER_BOAT,
  replayRawFixesVisible,
  sampleReplayRawFixEvidence,
} from "@/lib/layline/analysis-layers";
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
import { dockBand } from "./dock";
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
/* And the widest that half metre is ever allowed to draw. Half a metre of
 * ribbon under a boat twelve metres from a chase camera is forty pixels of
 * painted water, which reads as a carpet the boat is driving along rather than
 * as where it has been. */
const TRACK_MAX_PX = 3.5;
const TRACK_FADE = 0.9;
/* Time constant on the fade. At twenty seconds the tail is down to five percent
 * of the head, which is where a track stops being a line and starts being a
 * memory of one. */
const TRACK_TAU = 7;

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
      arrays.maxPx[v] = TRACK_MAX_PX;
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

/* Ribbons always sample the smooth evaluator. Raw replay hides the ribbon so a
 * held hull is not joined by a reconstructed trail. The independent raw-fixes
 * layer owns measured evidence. */
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
  return createPose();
}

/**
 * Where each boat has been, in its own hue. The tracks layer draws a fading
 * ribbon in smooth replay. The raw-fixes layer draws the measured fleet window,
 * while truth mode narrows that evidence to the selected boat's witness.
 */
export function BoatTracks({
  race,
  showTracks,
  showRawFixes,
}: {
  race: RaceData;
  showTracks: boolean;
  showRawFixes: boolean;
}) {
  const count = race.boats.length;
  const wind = useMemo(() => swellDirection(race), [race]);
  const pose = useMemo(newPose, []);
  const rawFixEvidence = useMemo(() => createReplayRawFixEvidenceModel(race), [race]);
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
    const slots = rawFixEvidence.slots.length;
    const dotData = new Float32Array(slots * 3);
    const dotColour = new Float32Array(slots * 3);
    /* A dot's hue never changes, so it is dealt once per slot and the loop only
     * ever writes where and when. */
    for (let i = 0; i < count; i++) {
      trackColour(race.boats[i], hue);
      for (let j = 0; j < RAW_FIX_EVIDENCE_SLOTS_PER_BOAT; j++) {
        const slot = i * RAW_FIX_EVIDENCE_SLOTS_PER_BOAT + j;
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
  }, [count, race, rawFixEvidence, wind]);

  useEffect(() => kit.dispose, [kit]);

  useFrame((state) => {
    const { t, mode, truthMode, followId } = useReplay.getState();
    const raw = mode === "raw";
    const rawFixesVisible = replayRawFixesVisible(showRawFixes, truthMode);
    const height = state.gl.domElement.height;
    kit.material.uniforms.uTime.value = t;
    kit.material.uniforms.uHeight.value = height;
    kit.material.uniforms.uDpr.value = height / Math.max(state.size.height, 1);
    kit.material.uniforms.uDock.value = dockBand.pixels;
    kit.dotMaterial.uniforms.uTime.value = t;
    kit.dotMaterial.uniforms.uHeight.value = height;
    kit.dotMaterial.uniforms.uDock.value = dockBand.pixels;

    for (let i = 0; i < count; i++) {
      const node = ribbonNodes[i];
      if (node !== null) node.visible = showTracks && !raw;
      if (raw || !showTracks) continue;
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
    dots.visible = rawFixesVisible;
    if (!dots.visible) return;

    /* The camera's own right and up, so a fix reads as a disc from the chase rig
     * four metres off the sea as well as from a hundred and sixty. */
    state.camera.updateMatrixWorld();
    const basis = state.camera.matrixWorld.elements;
    kit.dotMaterial.uniforms.uRight.value.set(basis[0], basis[1], basis[2]);
    kit.dotMaterial.uniforms.uUp.value.set(basis[4], basis[5], basis[6]);

    /* One shared sampler owns all-fleet layer evidence versus the selected
     * nine-fix truth witness. This renderer only copies its persistent slots. */
    sampleReplayRawFixEvidence(race, t, followId, showRawFixes, truthMode, rawFixEvidence);
    for (const entry of rawFixEvidence.slots) {
      const fix = entry.fix;
      const offset = entry.slot * 3;
      if (fix === null) {
        kit.dotData[offset + 2] = t - DOT_PARK;
        continue;
      }
      kit.dotData[offset] = fix.x;
      kit.dotData[offset + 1] = -fix.y;
      kit.dotData[offset + 2] = fix.t;
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
