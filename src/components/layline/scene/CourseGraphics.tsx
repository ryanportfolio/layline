"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Color, DoubleSide, MeshStandardMaterial, type Group, type Mesh } from "three";
import { hashString, mulberry32 } from "@/lib/prng";
import type { RaceData } from "@/lib/layline/types";
import { sampleLive } from "../hud/live";
import { useReplay } from "../store";
import {
  CASE_DROP,
  CourseLineMaterial,
  LAYLINE_FADE,
  LAYLINE_HALF,
  LAYLINE_LIFT,
  LAYLINE_MAX_PX,
  RUNG_CASE_FADE,
  RUNG_CASE_HALF,
  RUNG_CASE_MAX_PX,
  RUNG_FADE,
  RUNG_HALF,
  RUNG_LIFT,
  RUNG_MAX_PX,
  START_CASE_FADE,
  START_CASE_HALF,
  START_CASE_MAX_PX,
  START_FADE,
  START_HALF,
  START_LIFT,
  START_MAX_PX,
  ZONE_FADE,
  ZONE_HALF,
  ZONE_LIFT,
  ZONE_MAX_PX,
  bearingVector,
  commitLines,
  displayTwd,
  newLineBuffer,
  pushRing,
  pushRun,
  pushSegment,
  resetLines,
  tackingAngle,
} from "./course";
import { dockBand, watchDockBand } from "./dock";
import { COMMITTEE_STAFF_Z, committeeGeometry, markGeometry } from "./marks";
import { sampleWave, swellDirection, type WaveSample } from "./waves";

const DEG = Math.PI / 180;

/* The line is dashed so it reads as a line between two objects rather than as a
 * wall. One dash every 3.6 m puts twenty of them across seventy metres of line,
 * which is enough for the run to be unmistakable at helicopter distance and
 * still separate at the low chase. */
const DASH_PERIOD = 3.6;
const DASH_LENGTH = 2.2;

/* How far the laylines run back from the mark. Far enough that they cross the
 * start line even at the widest tacking angle in the band, because the crossing
 * is the thing that makes them legible. */
const LAYLINE_RUN = 132;
const LAYLINE_STEP = 4;

/* Fifty metres of ladder, perpendicular to the true wind rather than to the
 * course axis: two boats on one rung have the same water left to sail, and that
 * only holds against the wind. Five rungs run from one spacing above the mark
 * to fifty metres past the start line, which is every rung the tactical frustum
 * can hold: from a hundred and sixty metres up at a 45 degree field it sees
 * about a hundred and fifty metres of course, so a sixth rung would be drawn
 * behind the camera or over the horizon either way. */
const RUNG_SPACING = 50;
const RUNG_FIRST = 1;
const RUNG_LAST = 3;
const RUNG_HALF_SPAN = 88;
const RUNG_STEP = 6;

const ZONE_SEGMENTS = 48;

/* The tactical frame is the heavy one: 150 rung spans and their casings, 66
 * layline spans, 48 ring spans and 19 dashes with theirs. One draw either way,
 * so the pool is sized for that frame with room over it. */
const LINE_CAP = 640;

/* Sky colour, the same value the sails take their through-the-cloth light from. */
const SKY_FILL = "#b6cfe4";

/* How closely a floating object follows the surface normal. A mark on a mooring
 * and a vessel on an anchor both lag the water they are sitting on. */
const TILT_GAIN = 0.78;
const MARK_TILT_ARM = 1.1;
/* Where the committee boat is sampled for trim, which is her own ends. */
const COMMITTEE_BOW = 5.2;
const COMMITTEE_STERN = 4.5;
const COMMITTEE_BEAM = 1.5;

interface CourseKit {
  lines: ReturnType<typeof newLineBuffer>;
  lineMaterial: InstanceType<typeof CourseLineMaterial>;
  mark: ReturnType<typeof markGeometry>;
  committee: ReturnType<typeof committeeGeometry>;
  furniture: MeshStandardMaterial;
  amber: Color;
  ink: Color;
  casing: Color;
  yawSeed: number;
  dispose: () => void;
}

function buildCourse(windX: number, windZ: number): CourseKit {
  const lines = newLineBuffer(LINE_CAP);
  const lineMaterial = new CourseLineMaterial();
  lineMaterial.transparent = true;
  lineMaterial.depthWrite = false;
  lineMaterial.side = DoubleSide;
  lineMaterial.uniforms.uWind.value.set(windX, windZ);

  const mark = markGeometry();
  const committee = committeeGeometry();
  /* One material for every piece of furniture on the course, with the paint on
   * the vertices. Double sided because the hull is built as separate panels and
   * a panel wound the wrong way would otherwise be a hole in the boat rather
   * than a face lit from the other side. */
  const furniture = new MeshStandardMaterial({
    vertexColors: true,
    /* Rough, for the same reason the hulls are. A 4.6 sun on a smoother surface
     * lays a warm specular across every horizontal panel, and a deck that hands
     * back the sun's hue instead of its own stops being white. */
    roughness: 0.74,
    metalness: 0,
    /* The sky, which is what is over a deck when the sun is not. This one sun is
     * warm and it is aimed at a mid exposure, so a white deck under it alone
     * comes back tan and a committee boat made of tan boxes is the exact thing
     * this scene cannot be. */
    emissive: SKY_FILL,
    emissiveIntensity: 0.14,
    side: DoubleSide,
  });

  return {
    lines,
    lineMaterial,
    mark,
    committee,
    furniture,
    amber: new Color("#ffb648"),
    ink: new Color("#ecf5f9"),
    casing: new Color("#0a2a44"),
    /* One draw, at build time, so the marks lie the same way on every load. */
    yawSeed: mulberry32(hashString("layline-marks"))() * Math.PI * 2,
    dispose: () => {
      lines.geometry.dispose();
      lineMaterial.dispose();
      mark.dispose();
      committee.dispose();
      furniture.dispose();
    },
  };
}

function gunTime(race: RaceData): number {
  for (const event of race.events) if (event.kind === "gun") return event.t;
  return 0;
}

/* What the swell is doing this frame, in one object owned by the component and
 * rewritten in place. The water height under the furniture is asked for about
 * fifteen times a frame, and a closure over the frame's locals would be an
 * allocation every one of those frames. */
interface Swell {
  t: number;
  dirX: number;
  dirZ: number;
  eyeX: number;
  eyeZ: number;
  probe: WaveSample;
}

function newSwell(): Swell {
  return { t: 0, dirX: 0, dirZ: 0, eyeX: 0, eyeZ: 0, probe: { height: 0, jacobian: 1 } };
}

function surfaceAt(swell: Swell, x: number, z: number): number {
  return sampleWave(x, z, swell.t, swell.dirX, swell.dirZ, swell.eyeX, swell.eyeZ, swell.probe)
    .height;
}

/**
 * Course graphics, drawn on the water. The wind owns the amber, so the laylines,
 * the ladder and the zone ring all take it and separate on alpha instead; ink is
 * the line once the gun has fired, and nothing else on the sea gets an accent.
 * Every one of them is built on the damped display wind, never on the raw value
 * the instruments read, and the laylines take the fleet's beating angle damped
 * over the same window, because both halves of a layline's aim swing it.
 */
export function CourseGraphics({ race }: { race: RaceData }) {
  const gl = useThree((state) => state.gl);
  const wind = useMemo(() => swellDirection(race), [race]);
  const kit = useMemo(() => buildCourse(wind[0], wind[1]), [wind]);
  const swell = useMemo(newSwell, []);
  const heading = useMemo<[number, number]>(() => [0, -1], []);
  const bearing = useMemo<[number, number]>(() => [0, -1], []);
  const gun = useMemo(() => gunTime(race), [race]);

  const windwardRef = useRef<Mesh>(null);
  const pinRef = useRef<Mesh>(null);
  const committeeRef = useRef<Group>(null);
  const committeeHullRef = useRef<Mesh>(null);

  useEffect(() => kit.dispose, [kit]);
  /* Where the console starts, for every shader that draws on the water. One
   * watcher for the layer, read by the tracks as well as by the furniture. */
  useEffect(() => watchDockBand(gl.domElement), [gl]);

  useFrame((state) => {
    const { t, rig } = useReplay.getState();
    const live = sampleLive(race);
    const camera = state.camera.position;
    const twd = displayTwd(race, t);
    const course = race.course;
    const markX = course.windward.x;
    const markZ = -course.windward.y;

    kit.lineMaterial.uniforms.uTime.value = t;
    /* The drawing buffer, not the CSS box: the pixel a line is held against is
     * the sample the rasteriser writes. The ratio between the two carries the
     * screen ceilings, which are stated in pixels of the picture. */
    const buffer = state.gl.domElement.height;
    kit.lineMaterial.uniforms.uHeight.value = buffer;
    kit.lineMaterial.uniforms.uDpr.value = buffer / Math.max(state.size.height, 1);
    kit.lineMaterial.uniforms.uDock.value = dockBand.pixels;

    const lines = kit.lines;
    resetLines(lines);

    /* Upwind, and across it. Everything the wind owns is built off these two. */
    const up = bearingVector(twd, heading);
    const upX = up[0];
    const upZ = up[1];
    const acrossX = -upZ;
    const acrossZ = upX;

    /* Casing first and whole, then the line whole, because the pool is drawn in
     * the order it is written: run the two together span by span and a joint
     * puts one span's casing over the previous span's line. The rung leans on
     * that casing harder than anything else on the water does, because it is the
     * one graphic held deliberately under the laylines and a quiet amber over
     * open sea is a grey line. */
    if (rig === "tactical") {
      for (let step = -RUNG_FIRST; step <= RUNG_LAST; step++) {
        const offset = -step * RUNG_SPACING;
        const cx = markX + upX * offset;
        const cz = markZ + upZ * offset;
        const fromX = cx - acrossX * RUNG_HALF_SPAN;
        const fromZ = cz - acrossZ * RUNG_HALF_SPAN;
        const toX = cx + acrossX * RUNG_HALF_SPAN;
        const toZ = cz + acrossZ * RUNG_HALF_SPAN;
        pushRun(
          lines,
          fromX,
          fromZ,
          toX,
          toZ,
          RUNG_LIFT - CASE_DROP,
          RUNG_CASE_HALF,
          RUNG_CASE_MAX_PX,
          kit.casing,
          RUNG_CASE_FADE,
          RUNG_STEP,
        );
        pushRun(
          lines,
          fromX,
          fromZ,
          toX,
          toZ,
          RUNG_LIFT,
          RUNG_HALF,
          RUNG_MAX_PX,
          kit.amber,
          RUNG_FADE,
          RUNG_STEP,
        );
      }
    }

    pushRing(
      lines,
      markX,
      markZ,
      course.zoneRadius,
      ZONE_LIFT,
      ZONE_HALF,
      ZONE_MAX_PX,
      kit.amber,
      ZONE_FADE,
      ZONE_SEGMENTS,
    );

    /* Laylines belong to the beat. Tactical carries them the whole way round
     * because that is the rig you switch to in order to read the ladder; the
     * other two only draw them while the boat the console is following still
     * has a windward mark to fetch. */
    if (rig === "tactical" || live.leg === "beat") {
      const angle = tackingAngle(race, t);
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? 1 : -1;
        const approach = bearingVector(twd - angle * side, bearing);
        pushRun(
          lines,
          markX,
          markZ,
          markX - approach[0] * LAYLINE_RUN,
          markZ - approach[1] * LAYLINE_RUN,
          LAYLINE_LIFT,
          LAYLINE_HALF,
          LAYLINE_MAX_PX,
          kit.amber,
          LAYLINE_FADE,
          LAYLINE_STEP,
        );
      }
    }

    /* Amber while the line is an instruction, ink once it is a piece of the
     * course. The same seventy metres becomes the finish on the way home. */
    const lineColour = t >= gun ? kit.ink : kit.amber;
    const pinX = course.startPin.x;
    const pinZ = -course.startPin.y;
    const boatX = course.startBoat.x;
    const boatZ = -course.startBoat.y;
    const runX = boatX - pinX;
    const runZ = boatZ - pinZ;
    const runLength = Math.hypot(runX, runZ);
    const dashes = Math.max(1, Math.round(runLength / DASH_PERIOD));
    for (let i = 0; i < dashes; i++) {
      const from = (i * runLength) / dashes;
      const to = from + DASH_LENGTH;
      const fromX = pinX + (runX * from) / runLength;
      const fromZ = pinZ + (runZ * from) / runLength;
      const toX = pinX + (runX * to) / runLength;
      const toZ = pinZ + (runZ * to) / runLength;
      pushSegment(
        lines,
        fromX,
        fromZ,
        toX,
        toZ,
        START_LIFT - CASE_DROP,
        START_CASE_HALF,
        START_CASE_MAX_PX,
        kit.casing,
        START_CASE_FADE,
      );
      pushSegment(
        lines,
        fromX,
        fromZ,
        toX,
        toZ,
        START_LIFT,
        START_HALF,
        START_MAX_PX,
        lineColour,
        START_FADE,
      );
    }

    commitLines(lines);

    swell.t = t;
    swell.dirX = wind[0];
    swell.dirZ = wind[1];
    swell.eyeX = camera.x;
    swell.eyeZ = camera.z;

    const windward = windwardRef.current;
    if (windward !== null) {
      const height = surfaceAt(swell, markX, markZ);
      const slopeX =
        (surfaceAt(swell, markX + MARK_TILT_ARM, markZ) -
          surfaceAt(swell, markX - MARK_TILT_ARM, markZ)) /
        (2 * MARK_TILT_ARM);
      const slopeZ =
        (surfaceAt(swell, markX, markZ + MARK_TILT_ARM) -
          surfaceAt(swell, markX, markZ - MARK_TILT_ARM)) /
        (2 * MARK_TILT_ARM);
      windward.position.set(markX, height, markZ);
      windward.rotation.set(
        -Math.atan(slopeZ) * TILT_GAIN,
        Math.sin(t * 0.21 + kit.yawSeed) * 0.28,
        Math.atan(slopeX) * TILT_GAIN,
      );
      windward.updateMatrix();
    }

    const pin = pinRef.current;
    if (pin !== null) {
      const height = surfaceAt(swell, pinX, pinZ);
      const slopeX =
        (surfaceAt(swell, pinX + MARK_TILT_ARM, pinZ) -
          surfaceAt(swell, pinX - MARK_TILT_ARM, pinZ)) /
        (2 * MARK_TILT_ARM);
      const slopeZ =
        (surfaceAt(swell, pinX, pinZ + MARK_TILT_ARM) -
          surfaceAt(swell, pinX, pinZ - MARK_TILT_ARM)) /
        (2 * MARK_TILT_ARM);
      pin.position.set(pinX, height, pinZ);
      pin.rotation.set(
        -Math.atan(slopeZ) * TILT_GAIN,
        Math.sin(t * 0.26 + kit.yawSeed * 1.7) * 0.3,
        Math.atan(slopeX) * TILT_GAIN,
      );
      pin.updateMatrix();
    }

    const vessel = committeeRef.current;
    const hull = committeeHullRef.current;
    if (vessel !== null && hull !== null) {
      /* Head to wind on her anchor, which is how a committee boat lies, and set
       * so the staff over her quarter is on the end of the line rather than near
       * it: the line is defined by that staff. */
      const bow = bearingVector(twd, bearing);
      const originX = boatX + bow[0] * COMMITTEE_STAFF_Z;
      const originZ = boatZ + bow[1] * COMMITTEE_STAFF_Z;
      const bowX = originX - bow[0] * COMMITTEE_BOW;
      const bowZ = originZ - bow[1] * COMMITTEE_BOW;
      const sternX = originX + bow[0] * COMMITTEE_STERN;
      const sternZ = originZ + bow[1] * COMMITTEE_STERN;
      const rightX = -bow[1];
      const rightZ = bow[0];
      const bowY = surfaceAt(swell, bowX, bowZ);
      const sternY = surfaceAt(swell, sternX, sternZ);
      const portY = surfaceAt(
        swell,
        originX - rightX * COMMITTEE_BEAM,
        originZ - rightZ * COMMITTEE_BEAM,
      );
      const starboardY = surfaceAt(
        swell,
        originX + rightX * COMMITTEE_BEAM,
        originZ + rightZ * COMMITTEE_BEAM,
      );
      vessel.position.set(originX, (bowY + sternY) * 0.5, originZ);
      vessel.rotation.y = -twd * DEG;
      vessel.updateMatrix();
      hull.rotation.set(
        Math.atan2(bowY - sternY, COMMITTEE_BOW + COMMITTEE_STERN) * TILT_GAIN,
        0,
        Math.atan2(starboardY - portY, COMMITTEE_BEAM * 2) * TILT_GAIN,
      );
      hull.updateMatrix();
    }
    /* After the camera rig at -60, because the swell these marks are floated on
     * is sampled against the eye: the octaves fade with range from the camera,
     * so a camera the rig had not written yet would hang the furniture off the
     * last frame's viewpoint, which on a rig cut is a hundred metres away and
     * enough to lift a buoy off the water for that frame. */
  }, -58);

  return (
    <>
      <mesh
        geometry={kit.lines.geometry}
        material={kit.lineMaterial}
        frustumCulled={false}
        matrixAutoUpdate={false}
        renderOrder={4}
      />
      <mesh ref={windwardRef} geometry={kit.mark} material={kit.furniture} matrixAutoUpdate={false} />
      <mesh
        ref={pinRef}
        geometry={kit.mark}
        material={kit.furniture}
        matrixAutoUpdate={false}
        scale={0.66}
      />
      <group ref={committeeRef} matrixAutoUpdate={false}>
        {/* Named because she is the one piece of furniture tall enough to have a
            boat label land on her, and the label pass clears what it can find. */}
        <mesh
          ref={committeeHullRef}
          name="committee"
          geometry={kit.committee}
          material={kit.furniture}
          matrixAutoUpdate={false}
        />
      </group>
    </>
  );
}
