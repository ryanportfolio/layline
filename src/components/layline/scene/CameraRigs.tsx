"use client";

import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3, type PerspectiveCamera } from "three";
import { poseAt } from "@/lib/layline/interpolate";
import type { Pose, RaceData } from "@/lib/layline/types";
import { sampleLive } from "../hud/live";
import { useReplay } from "../store";

const DEG = Math.PI / 180;

/* Seventeen metres astern and six off the windward quarter, eye at 4.6 m. The
 * aim point sits ahead of the bow for lead space and a shade above the eye,
 * which puts the horizon just above centre and gives the water the lower
 * half. */
const CHASE = { back: 17, side: 6, eye: 4.6, lead: 12, aim: 5.4, fov: 55, fovFast: 62 };

/* Helicopter wide, 88 m out and 34 m up on the fleet's down-course quarter. The
 * aim point is well above the water because a camera this high pointed at the
 * boats would push the horizon straight out of the top of the frame, and no rig
 * but the tactical one is allowed to frame void. */
const TV = { radius: 88, height: 34, bearing: 30, aim: 16, fov: 40, weight: 0.45 };

/* A hundred and sixty metres up, pitched 72 degrees rather than straight down,
 * course up. The horizontal stand off is what makes the pitch. */
const TACTICAL = { height: 160, pitch: 72, fov: 45 };

function newPose(): Pose {
  return { x: 0, y: 0, hdg: 0, heel: 0, twa: 0, sog: 0, cog: 0, kite: 0 };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Three vantages, evaluated straight from the replay clock. They cut rather
 * than blend for now, which is what makes a still frame from any of them
 * comparable to the same frame taken yesterday.
 */
export function CameraRigs({ race }: { race: RaceData }) {
  const spare = useMemo<Pose[]>(() => race.boats.map(newPose), [race]);
  const eye = useMemo(() => new Vector3(), []);
  const aim = useMemo(() => new Vector3(), []);

  useFrame((state) => {
    const { rig, t, mode } = useReplay.getState();
    const camera = state.camera as PerspectiveCamera;
    const live = sampleLive(race);
    const pose = live.pose;

    /* Course (x, y) onto world (x, -z), so a heading of 0 runs into the
     * screen and a bearing turns clockwise about the world's y axis. */
    const heading = pose.hdg * DEG;
    const forwardX = Math.sin(heading);
    const forwardZ = -Math.cos(heading);
    const boatX = pose.x;
    const boatZ = -pose.y;
    let fov = TV.fov;

    if (rig === "chase") {
      /* The offset goes to windward, which is the side the sails are not on.
       * Held to one side it lines up with the boom on one tack and the boat
       * comes out a bare pole with an empty sky behind the mast. The sine of
       * the true wind angle carries the sign and blends it across the fifteen
       * degrees either side of head to wind and dead downwind, so a tack or a
       * gybe swings the camera through rather than cutting it. */
      const windward = clamp(Math.sin(pose.twa * DEG) / Math.sin(15 * DEG), -1, 1);
      const side = -CHASE.side * windward;
      eye.set(
        boatX - forwardX * CHASE.back + forwardZ * side,
        CHASE.eye,
        boatZ - forwardZ * CHASE.back - forwardX * side,
      );
      aim.set(boatX + forwardX * CHASE.lead, CHASE.aim, boatZ + forwardZ * CHASE.lead);
      /* Wider as the boat lights up, which is the one thing a chase camera can
       * do to report speed the numbers are already reporting. */
      const gain = Math.min(Math.max((pose.sog - 4) / 6, 0), 1);
      fov = CHASE.fov + (CHASE.fovFast - CHASE.fov) * gain;
    } else if (rig === "tactical") {
      const stand = TACTICAL.height / Math.tan(TACTICAL.pitch * DEG);
      eye.set(boatX, TACTICAL.height, boatZ + stand);
      aim.set(boatX, 0, boatZ);
      fov = TACTICAL.fov;
    } else {
      let centreX = 0;
      let centreZ = 0;
      for (let i = 0; i < race.boats.length; i++) {
        const id = race.boats[i].id;
        const other = id === live.followId ? pose : poseAt(race, id, t, mode, spare[i]);
        centreX += other.x;
        centreZ += -other.y;
      }
      centreX /= race.boats.length;
      centreZ /= race.boats.length;
      /* Pulled toward the boat the console is reading, so the wide and the
       * instrument dock are describing the same part of the race. */
      centreX += (boatX - centreX) * TV.weight;
      centreZ += (boatZ - centreZ) * TV.weight;
      const bearing = TV.bearing * DEG;
      eye.set(
        centreX + Math.sin(bearing) * TV.radius,
        TV.height,
        centreZ + Math.cos(bearing) * TV.radius,
      );
      aim.set(centreX, TV.aim, centreZ);
    }

    camera.position.copy(eye);
    camera.lookAt(aim);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }, -60);

  return null;
}
