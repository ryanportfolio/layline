"use client";

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { Matrix4, Ray, Raycaster, Vector2, Vector3 } from "three";
import type { Mesh } from "three";
import type { RaceData } from "@/lib/layline/types";
import { setBoatPicker } from "./interaction";

/**
 * Which boat is under a point on the water.
 *
 * The pick is a ray against six boxes, run by hand. Not the renderer's own
 * event system, which would raycast every hull, every sail and every wire in
 * the scene on each pointer move, and not `Mesh.raycast` either: that returns a
 * fresh intersection record and a fresh vector per hit, and a pick runs at
 * pointer rate. The ray goes into each box's own frame and meets it as a slab
 * test, which allocates nothing and answers the same question.
 *
 * The pointer handlers stay on the DOM layer that already owns the press. This
 * component only lends them a camera and a ray, the same way the gate lends the
 * frozen canvas a door.
 *
 * Coordinates in are normalised device coordinates, so the caller measures the
 * canvas box and this never has to.
 */
export function BoatPicker({ race }: { race: RaceData }) {
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  const caster = useMemo(() => new Raycaster(), []);
  const point = useMemo(() => new Vector2(), []);
  const local = useMemo(() => new Ray(), []);
  const inverse = useMemo(() => new Matrix4(), []);
  const hit = useMemo(() => new Vector3(), []);
  const boxes = useMemo<(Mesh | null)[]>(() => race.boats.map(() => null), [race]);

  useEffect(() => {
    setBoatPicker((nx, ny) => {
      point.set(nx, ny);
      caster.setFromCamera(point, camera);
      let nearest: string | null = null;
      let range = Number.POSITIVE_INFINITY;
      for (let i = 0; i < race.boats.length; i++) {
        let box = boxes[i];
        /* A canvas that has remounted, or a race that has been swapped, leaves
         * every one of these pointing at an object no longer in the scene. */
        if (box === null || box.parent === null) {
          box = (scene.getObjectByName(`pick-${race.boats[i].id}`) as Mesh | undefined) ?? null;
          boxes[i] = box;
        }
        if (box === null) continue;
        /* Computed once for the shared geometry and reused by every boat. */
        if (box.geometry.boundingBox === null) box.geometry.computeBoundingBox();
        const bounds = box.geometry.boundingBox;
        if (bounds === null) continue;
        /* The fleet writes its matrices in the frame pass and the renderer
         * flushes them at draw time, so a pick taken between the two, or on a
         * paused page that has not drawn since the clock moved, would read the
         * previous frame's world. Six matrices is nothing; a boat picked one
         * frame behind is not. */
        box.updateWorldMatrix(true, false);
        inverse.copy(box.matrixWorld).invert();
        local.copy(caster.ray).applyMatrix4(inverse);
        if (local.intersectBox(bounds, hit) === null) continue;
        /* The boats carry rotation and translation and no scale, so a distance
         * measured in a boat's own frame is a distance in the world. */
        const reach = local.origin.distanceTo(hit);
        if (reach >= range) continue;
        range = reach;
        nearest = race.boats[i].id;
      }
      return nearest;
    });
    return () => setBoatPicker(null);
  }, [race, camera, scene, caster, point, local, inverse, hit, boxes]);

  return null;
}
