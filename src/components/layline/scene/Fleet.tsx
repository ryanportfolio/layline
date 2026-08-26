"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { BoxGeometry, FrontSide, MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial } from "three";
import type { BufferGeometry, Mesh } from "three";
import { createPose, poseAt } from "@/lib/layline/interpolate";
import type { Pose, RaceData } from "@/lib/layline/types";
import { sampleLive } from "../hud/live";
import { useReplay } from "../store";
import {
  BoatRig,
  newBoatNodes,
  type BoatKit,
  type BoatNodes,
  type PickKit,
  type SailPair,
} from "./Boat";
import { applyDrape, drapeUniforms, type DrapeUniforms } from "./drape";
import { fleetFrame, sizeFleetFrame } from "./frame";
import {
  CLOTH,
  SKIFF,
  WIRE_GLSL,
  boomAngle,
  crewGeometry,
  hullGeometry,
  jibGeometry,
  kiteGeometry,
  kiteTexture,
  liveryOf,
  mainGeometry,
  matteGeometry,
  sailTexture,
} from "./skiff";
import { clothCamber, clothSide } from "./trim";
import { sampleWave, swellDirection, type WaveSample } from "./waves";

const DEG = Math.PI / 180;

/* One fix ahead. Trim answers to whether the boat is winding up or dropping
 * off, and asking the evaluator for the next quarter second is a question the
 * clock can answer at any rate and in either direction, where a difference
 * against last frame would change with the refresh rate and lie after a scrub. */
const LOOKAHEAD = 0.25;
const STERN = 2.45;
const CREW_FEET = 0.4;

/* Sky colour, because that is what is on the other side of a sail when the sun
 * is not. */
const SAIL_GLOW = "#b6cfe4";

function newPose(): Pose {
  return createPose();
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Puts a sail on the side it is cut for and blends its draft in or out. The
 * mirrored shape is a second geometry rather than a second influence, because
 * the sail number has to keep reading forwards; the swap happens at zero draft,
 * where the two are the same shape, so it is a change of vertices and not a
 * change of picture.
 */
function setSail(mesh: Mesh | null, geometry: BufferGeometry, luff: number): void {
  if (mesh === null) return;
  if (mesh.geometry !== geometry) mesh.geometry = geometry;
  /* The renderer builds the influence list when a mesh is constructed with its
   * geometry, and this one is handed its geometry afterwards. */
  if (mesh.morphTargetInfluences === undefined) mesh.updateMorphTargets();
  const influences = mesh.morphTargetInfluences;
  if (influences !== undefined) influences[0] = luff;
}

/* Radius in drawn pixels the standing rigging is never allowed to fall under.
 * Under about three quarters of a pixel a wire stops being thin and starts
 * being intermittent, which is the beading the geometry alone cannot fix. */
const WIRE_PIXELS = 0.85;

interface FleetKit {
  kits: BoatKit[];
  pick: PickKit;
  drapes: DrapeUniforms[];
  wireHeight: { value: number };
  dispose: () => void;
}

/* The pick box, in metres of hull. Beam and length come off the drawn skiff;
 * the height carries the whole rig, because at a hundred metres the mast is
 * most of what a pointer can actually land on. The slack is a third of a beam
 * either side, which is about a fingertip at the ranges the chase rig works
 * at and still leaves two boats overlapping only when their hulls do. */
const PICK_SLACK = 0.45;
const PICK_WIDTH = (SKIFF.rack + PICK_SLACK) * 2;
const PICK_LENGTH = SKIFF.transom - SKIFF.bow + PICK_SLACK * 2;
const PICK_HEIGHT = SKIFF.mastTop + 1;

function buildFleet(race: RaceData): FleetKit {
  const mains: SailPair = { starboard: mainGeometry(-1), port: mainGeometry(1) };
  const jibs: SailPair = { starboard: jibGeometry(-1), port: jibGeometry(1) };
  const kites: SailPair = { starboard: kiteGeometry(-1), port: kiteGeometry(1) };

  /* Livery arrives on the vertices, so topsides, transom, rack frames, spars
   * and rigging on every boat in the fleet share one material. Everything that
   * faces the sky is on the matte one below.
   *
   * Rough, and that is what makes the liveries readable. A 4.6 sun on a 0.42
   * surface puts a warm specular across every horizontal panel on the boat: a
   * near black trampoline came back at #968a79 and six different hulls all read
   * as the same pale raft. Non skid and matte paint are not gloss. */
  const shell = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    metalness: 0,
  });
  /* The drawn height of the frame, read once a frame and handed to the wire
   * widening below. Only geometry carrying aWire may be drawn with this
   * material, and every hull does. */
  const wireHeight = { value: 900 };
  /* A patched program is not the program the renderer thinks it is. The default
   * cache key is built from the material's own parameters, so another standard
   * material that happened to share them could be handed this one's compiled
   * shader. */
  shell.customProgramCacheKey = () => "layline-hull-wire";
  shell.onBeforeCompile = (program) => {
    program.uniforms.uWireHeight = wireHeight;
    program.uniforms.uWirePixels = { value: WIRE_PIXELS };
    program.vertexShader = program.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 aWire;
uniform float uWireHeight;
uniform float uWirePixels;`,
      )
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${WIRE_GLSL}`);
  };
  /* The netting and the footwell are the two surfaces roughness could not save.
   * Their albedo is near zero, so the 0.04 dielectric lobe every standard
   * material carries is several times their own diffuse whatever the roughness,
   * and both plates hand back the sun's warm hue instead of their own cool one:
   * at 0.42 the trampoline was #968a79, at 0.7 it was #332a1a, and a white
   * hulled boat and a green hulled boat both returned it. Lambert has no
   * specular term to fight. */
  const matteShell = new MeshLambertMaterial({ vertexColors: true });
  /* Cloth is thin and the sun is behind it as often as not, so some of the
   * light on any sail arrived through the other side. Without that term a sail
   * lit by a low warm sun comes out the colour of old canvas and none of the
   * six boats reads as carrying a white main. */
  const jibCloth = new MeshStandardMaterial({
    color: CLOTH,
    emissive: SAIL_GLOW,
    emissiveIntensity: 0.34,
    roughness: 0.84,
    metalness: 0,
    side: FrontSide,
  });

  const kits: BoatKit[] = [];
  const drapes: DrapeUniforms[] = [];
  for (const boat of race.boats) {
    const livery = liveryOf(boat);
    const texture = sailTexture(boat, livery);
    const kiteCloth = kiteTexture(livery);
    const kiteMaterial = new MeshStandardMaterial({
      map: kiteCloth,
      emissive: SAIL_GLOW,
      emissiveMap: kiteCloth,
      emissiveIntensity: 0.16,
      roughness: 0.78,
      metalness: 0,
      side: FrontSide,
      transparent: true,
      opacity: 0,
    });
    /* The kite is stopped on the mainsail in the vertex shader; see drape.ts
     * for why it cannot be baked and why it cannot run on the CPU. */
    const drape = drapeUniforms();
    applyDrape(kiteMaterial, drape);
    drapes.push(drape);
    kits.push({
      hull: hullGeometry(livery),
      matte: matteGeometry(livery),
      crew: crewGeometry(livery),
      shell,
      matteShell,
      /* The through-the-cloth light rides the sheet rather than sitting flat on
       * top of it. Added flat it lifts every hue toward the sky, which turned a
       * red head panel pale pink and a near black one mid slate, and three
       * nations ended up carrying the same identifier. */
      main: new MeshStandardMaterial({
        map: texture,
        emissive: SAIL_GLOW,
        emissiveMap: texture,
        emissiveIntensity: 0.32,
        roughness: 0.82,
        metalness: 0,
        side: FrontSide,
      }),
      jib: jibCloth,
      /* A gennaker is lighter cloth again and the light coming through it is
       * the sail's own colour, which is what makes a kite glow on a run. Well
       * under the diffuse, or the lit side and the shaded side of a sail with
       * twenty percent draft in it converge on one value and the camber stops
       * reading. */
      kite: kiteMaterial,
      mains,
      jibs,
      kites,
    });
  }

  /* One box and one material for the whole fleet: six meshes that are never
   * drawn have no reason to own six of either. The box is built about the
   * waterline the hull is authored on and raised so it covers deck to
   * masthead. */
  const box = new BoxGeometry(PICK_WIDTH, PICK_HEIGHT, PICK_LENGTH);
  box.translate(0, PICK_HEIGHT * 0.5 - 0.6, 0);
  /* visible: false on the material, not on the object. The renderer drops a
   * mesh whose material is invisible before it reaches a draw call, and the
   * raycaster reads the object either way, which is exactly the pair of
   * answers a pick volume wants. */
  const blank = new MeshBasicMaterial({ visible: false });

  return {
    kits,
    pick: { box, blank },
    drapes,
    wireHeight,
    dispose: () => {
      box.dispose();
      blank.dispose();
      for (const pair of [mains, jibs, kites]) {
        pair.starboard.dispose();
        pair.port.dispose();
      }
      shell.dispose();
      matteShell.dispose();
      jibCloth.dispose();
      for (const kit of kits) {
        kit.hull.dispose();
        kit.matte.dispose();
        kit.crew.dispose();
        kit.main.map?.dispose();
        kit.main.dispose();
        kit.kite.map?.dispose();
        kit.kite.dispose();
      }
    },
  };
}

/**
 * Six skiffs, posed straight off the replay clock. The followed boat reads the
 * same sample the instrument dock is reading, so a heel angle in frame and a
 * TWA in the panel cannot describe two different moments.
 */
export function Fleet({ race }: { race: RaceData }) {
  const fleet = useMemo(() => buildFleet(race), [race]);
  const nodes = useMemo<BoatNodes[]>(() => race.boats.map(newBoatNodes), [race]);
  const poses = useMemo(() => race.boats.map(newPose), [race]);
  const spares = useMemo(() => race.boats.map(newPose), [race]);
  const wind = useMemo(() => swellDirection(race), [race]);
  const probe = useMemo<WaveSample>(() => ({ height: 0, jacobian: 1 }), []);

  useEffect(() => {
    sizeFleetFrame(race.boats.length);
  }, [race]);
  useEffect(() => fleet.dispose, [fleet]);

  useFrame((state) => {
    const { t, mode, followId } = useReplay.getState();
    const live = sampleLive(race);
    const camera = state.camera.position;
    /* The drawing buffer, not the CSS box: aliasing happens at the sample the
     * rasteriser writes, so that is the pixel the wires are held against. */
    fleet.wireHeight.value = state.gl.domElement.height;

    for (let i = 0; i < race.boats.length; i++) {
      const node = nodes[i];
      const outer = node.outer;
      const inner = node.inner;
      if (outer === null || inner === null) continue;
      const kit = fleet.kits[i];
      const id = race.boats[i].id;
      const pose = id === followId ? live.pose : poseAt(race, id, t, mode, poses[i]);
      const ahead = poseAt(race, id, t + LOOKAHEAD, mode, spares[i]);

      const rad = pose.hdg * DEG;
      const forwardX = Math.sin(rad);
      const forwardY = Math.cos(rad);
      const bowX = pose.x + forwardX * SKIFF.bowOffset;
      const bowZ = -(pose.y + forwardY * SKIFF.bowOffset);
      const sternX = pose.x - forwardX * STERN;
      const sternZ = -(pose.y - forwardY * STERN);

      /* The hull rides the surface the shader draws, sampled on the CPU at three
       * points along its own length: the middle sets how deep it floats and the
       * ends set how it lies on the swell. One sample would leave the boat flat
       * on a moving sea, which is the tell that a hull is pasted on. */
      const midY = sampleWave(pose.x, -pose.y, t, wind[0], wind[1], camera.x, camera.z, probe)
        .height;
      const bowY = sampleWave(bowX, bowZ, t, wind[0], wind[1], camera.x, camera.z, probe).height;
      const sternY = sampleWave(sternX, sternZ, t, wind[0], wind[1], camera.x, camera.z, probe)
        .height;
      const surface = (bowY + 2 * midY + sternY) * 0.25;

      /* Bow up when the swell lifts it, when the boat is winding up out of a
       * manoeuvre, and again once the kite is pulling: three separate reasons a
       * skiff trims by the stern, added and then held inside eight degrees. */
      const accel = (ahead.sog - pose.sog) / LOOKAHEAD;
      const pitch = clamp(
        Math.atan2(bowY - sternY, SKIFF.bowOffset + STERN) +
          clamp(accel * 0.028, -0.06, 0.075) +
          pose.kite * 0.038,
        -0.14,
        0.14,
      );

      outer.position.set(pose.x, surface - 0.03, -pose.y);
      outer.rotation.y = -rad;
      outer.updateMatrix();
      inner.rotation.set(pitch, 0, -pose.heel * DEG);
      inner.updateMatrix();

      /* Leeward is where the cloth goes: to port with the wind over starboard,
       * and the whole rig follows that one number. It is a number rather than a
       * sign because a boom takes about a second to cross and the sails go soft
       * on the way; at zero the rig is on the centreline halfway through a
       * manoeuvre, which is also where the two cut sides of a sail meet. */
      const side = clothSide(race, id, t);
      const luff = 1 - clothCamber(side);
      const boom = boomAngle(pose.twa) * DEG;
      const boomNode = node.boom;
      if (boomNode !== null) {
        boomNode.rotation.y = side * boom;
        boomNode.updateMatrix();
      }
      setSail(node.mainMesh, side < 0 ? kit.mains.starboard : kit.mains.port, luff);
      const jibNode = node.jib;
      if (jibNode !== null) {
        /* A jib sheets a lot closer than a main and comes off the same lead all
         * the way round the course, so it tracks the boom rather than matching
         * it. */
        jibNode.rotation.y = side * boom * 0.42;
        jibNode.updateMatrix();
      }
      setSail(node.jibMesh, side < 0 ? kit.jibs.starboard : kit.jibs.port, luff);

      const kiteNode = node.kite;
      const hoist = pose.kite;
      const grow = 0.38 + 0.62 * hoist;
      const stretch = 0.18 + 0.82 * hoist;
      if (kiteNode !== null) {
        kiteNode.scale.set(grow, stretch, grow);
        kiteNode.updateMatrix();
        kiteNode.visible = hoist > 0.02;
        kit.kite.opacity = Math.min(1, hoist * 1.8);
      }
      /* What the drape has to know: where the boom is, how much draft is in the
       * cloth, which side it was cut for, and the hoist scale, which is applied
       * to the kite node after the shader has run and so has to be undone
       * inside it. The cut side is a sign because that is what picks the
       * geometry; the camber beside it is the number that goes soft. */
      const drape = fleet.drapes[i];
      drape.uDrapeOn.value = hoist > 0.02 ? 1 : 0;
      drape.uBoom.value = boom;
      drape.uSpread.value = 1 - luff;
      drape.uLee.value = side < 0 ? -1 : 1;
      drape.uKiteScale.value[0] = grow;
      drape.uKiteScale.value[1] = stretch;
      drape.uKiteScale.value[2] = grow;
      setSail(node.kiteMesh, side < 0 ? kit.kites.starboard : kit.kites.port, luff);

      const crewNode = node.crew;
      if (crewNode !== null) {
        /* Which rack they are on is the heel, read as a number rather than as a
         * sign: through a tack the heel passes zero and the pair slide across
         * the boat instead of teleporting. How far out they go is the beat, and
         * they come inboard and aft once the kite is up. */
        const side = clamp(-pose.heel / 4, -1, 1);
        const hike =
          clamp((100 - Math.abs(pose.twa)) / 45, 0.1, 1) *
          clamp(Math.abs(pose.heel) / 8, 0.4, 1);
        crewNode.position.set(side * (0.28 + 0.86 * hike), CREW_FEET, 0.12 + 0.55 * pose.kite);
        crewNode.rotation.z = -side * hike * 0.6;
        crewNode.updateMatrix();
      }

      const slot = fleetFrame[i];
      if (slot !== undefined) {
        slot.bowX = bowX;
        slot.bowZ = bowZ;
        slot.headX = forwardX;
        slot.headZ = -forwardY;
        slot.sog = pose.sog;
        slot.surface = surface;
      }
    }
  }, -80);

  return (
    <>
      {race.boats.map((boat, index) => (
        <BoatRig
          key={boat.id}
          boatId={boat.id}
          kit={fleet.kits[index]}
          pick={fleet.pick}
          nodes={nodes[index]}
        />
      ))}
    </>
  );
}
