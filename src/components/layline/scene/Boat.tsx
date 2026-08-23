"use client";

import type {
  BufferGeometry,
  Group,
  Material,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
} from "three";
import { JIB_TACK, KITE_TACK, SKIFF } from "./skiff";

/* One geometry per tack for every sail. Camber has to bulge to leeward, and a
 * mirrored copy of the same mesh would carry the sail number mirrored with it,
 * so the two shapes are built once and swapped rather than scaled. */
export interface SailPair {
  port: BufferGeometry;
  starboard: BufferGeometry;
}

/* The volume the pointer picks a boat out of. One box a boat, never drawn, and
 * deliberately not the hull: a raycast against a skiff is a walk over every
 * triangle in it, six times, on every pointer move. The box is the hull's own
 * envelope with a hand's worth of slack around it, so a click that looks like
 * it landed on the boat lands on the boat. */
export interface PickKit {
  box: BufferGeometry;
  blank: Material;
}

export interface BoatKit {
  hull: BufferGeometry;
  matte: BufferGeometry;
  crew: BufferGeometry;
  shell: MeshStandardMaterial;
  matteShell: MeshLambertMaterial;
  main: MeshStandardMaterial;
  jib: MeshStandardMaterial;
  kite: MeshStandardMaterial;
  mains: SailPair;
  jibs: SailPair;
  kites: SailPair;
}

/* Written by the fleet's frame pass. Held as one object per boat so the loop
 * touches fields rather than looking meshes up by name. */
export interface BoatNodes {
  outer: Group | null;
  inner: Group | null;
  boom: Group | null;
  jib: Group | null;
  kite: Group | null;
  crew: Group | null;
  mainMesh: Mesh | null;
  jibMesh: Mesh | null;
  kiteMesh: Mesh | null;
}

export function newBoatNodes(): BoatNodes {
  return {
    outer: null,
    inner: null,
    boom: null,
    jib: null,
    kite: null,
    crew: null,
    mainMesh: null,
    jibMesh: null,
    kiteMesh: null,
  };
}

/**
 * Two nodes, and the split matters. The outer one carries the interpolated
 * position and heading, so anything hung off it (the wake's origin, a label
 * anchor) travels with the boat without inheriting the lean. The inner one
 * carries heel and pitch, and because the hull is authored with its waterline
 * at y = 0 that rotation happens about the waterline rather than about a point
 * somewhere inside the hull.
 */
export function BoatRig({
  boatId,
  kit,
  pick,
  nodes,
}: {
  boatId: string;
  kit: BoatKit;
  pick: PickKit;
  nodes: BoatNodes;
}) {
  return (
    <group
      name={boatId}
      matrixAutoUpdate={false}
      ref={(node) => {
        nodes.outer = node;
      }}
    >
      <group
        matrixAutoUpdate={false}
        ref={(node) => {
          nodes.inner = node;
        }}
      >
        <mesh geometry={kit.hull} material={kit.shell} />
        <mesh geometry={kit.matte} material={kit.matteShell} />

        <group
          matrixAutoUpdate={false}
          ref={(node) => {
            nodes.boom = node;
          }}
          position={[0, 0, SKIFF.mastZ]}
        >
          <mesh
            ref={(node) => {
              nodes.mainMesh = node;
            }}
            geometry={kit.mains.starboard}
            material={kit.main}
          />
        </group>

        <group
          matrixAutoUpdate={false}
          ref={(node) => {
            nodes.jib = node;
          }}
          position={JIB_TACK}
        >
          <mesh
            ref={(node) => {
              nodes.jibMesh = node;
            }}
            geometry={kit.jibs.starboard}
            material={kit.jib}
          />
        </group>

        <group
          matrixAutoUpdate={false}
          ref={(node) => {
            nodes.kite = node;
          }}
          position={KITE_TACK}
          visible={false}
        >
          <mesh
            ref={(node) => {
              nodes.kiteMesh = node;
            }}
            geometry={kit.kites.starboard}
            material={kit.kite}
          />
        </group>

        {/* The crew go on the matte material with the netting and the footwell.
            A buoyancy aid is closed cell foam under a nylon cover and a wetsuit
            is neoprene; neither has a specular lobe, and the one the standard
            material gave them washed the aid warm enough to read as a bare
            torso between two black limbs. */}
        <group
          matrixAutoUpdate={false}
          ref={(node) => {
            nodes.crew = node;
          }}
        >
          <mesh geometry={kit.crew} material={kit.matteShell} />
        </group>
      </group>

      {/* The pick volume, hung off the upright node and after everything else.
          Both matter. Off the upright node, because a target that heeled twenty
          degrees away from the pointer would be a boat that is harder to click
          the harder it is sailing. After everything else, because the plate
          pass finds the heeled node as this group's first child and the boom as
          the first group under that: a box inserted ahead of either would move
          every label on the water.

          Drawn by nothing. The renderer skips a mesh whose material is not
          visible, while the raycaster still reads the object, so this costs a
          matrix and no draw call. */}
      <mesh name={`pick-${boatId}`} geometry={pick.box} material={pick.blank} />
    </group>
  );
}
