"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  ConeGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from "three";
import {
  CURRENT_FIELD_3D_MAX_GLYPHS,
  CURRENT_FIELD_PROVENANCE,
  createCurrentFieldGrid,
  sampleCurrentFieldGrid,
} from "@/lib/layline/surfaces";
import type { RaceData } from "@/lib/layline/types";
import { useReplay } from "../store";

const FIELD_LIFT = 0.42;
const FIELD_LENGTH_PER_MPS = 15;
const FIELD_MIN_LENGTH = 1.4;

interface CurrentFieldKit {
  geometry: ConeGeometry;
  material: MeshBasicMaterial;
  grid: ReturnType<typeof createCurrentFieldGrid>;
  transform: Object3D;
  up: Vector3;
  direction: Vector3;
}

function buildCurrentField(race: RaceData): CurrentFieldKit {
  return {
    geometry: new ConeGeometry(0.34, 1, 4, 1, false),
    material: new MeshBasicMaterial({ color: "#7dd9e8", transparent: true, opacity: 0.58 }),
    grid: createCurrentFieldGrid(race, CURRENT_FIELD_3D_MAX_GLYPHS),
    transform: new Object3D(),
    up: new Vector3(0, 1, 0),
    direction: new Vector3(0, 0, -1),
  };
}

/** One instanced draw. Replay time is sampled exactly; there is no decorative easing. */
export function CurrentField({ race, visible }: { race: RaceData; visible: boolean }) {
  const kit = useMemo(() => buildCurrentField(race), [race]);
  const meshRef = useRef<InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (mesh !== null) mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    return () => {
      kit.geometry.dispose();
      kit.material.dispose();
    };
  }, [kit]);

  useFrame(() => {
    if (!visible) return;
    const replay = useReplay.getState();
    if (kit.grid.sampledAt === replay.t) return;
    sampleCurrentFieldGrid(race, replay.t, kit.grid);
    const mesh = meshRef.current;
    if (mesh === null) return;
    for (let index = 0; index < kit.grid.glyphs.length; index++) {
      const glyph = kit.grid.glyphs[index];
      kit.direction.set(glyph.currentX, 0, -glyph.currentY);
      if (glyph.drift > 1e-12) kit.direction.multiplyScalar(1 / glyph.drift);
      else kit.direction.set(0, 0, -1);
      kit.transform.position.set(glyph.x, FIELD_LIFT, -glyph.y);
      kit.transform.quaternion.setFromUnitVectors(kit.up, kit.direction);
      kit.transform.scale.set(1, Math.max(FIELD_MIN_LENGTH, glyph.drift * FIELD_LENGTH_PER_MPS), 1);
      kit.transform.updateMatrix();
      mesh.setMatrixAt(index, kit.transform.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, -57);

  return (
    <instancedMesh
      ref={meshRef}
      visible={visible}
      args={[kit.geometry, kit.material, CURRENT_FIELD_3D_MAX_GLYPHS]}
      count={CURRENT_FIELD_3D_MAX_GLYPHS}
      frustumCulled={false}
      renderOrder={3}
      name={CURRENT_FIELD_PROVENANCE}
      userData={{ provenance: CURRENT_FIELD_PROVENANCE, drawFamily: "one-instanced-field" }}
    />
  );
}
