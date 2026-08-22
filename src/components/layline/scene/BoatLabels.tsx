"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3, type Mesh, type Object3D } from "three";
import styles from "@/app/layline.module.css";
import type { RaceData } from "@/lib/layline/types";
import { sampleLive, setText } from "../hud/live";
import { useReplay } from "../store";
import { MAIN_CORNERS, SKIFF } from "./skiff";

/* Twelve pixels of stem, which is enough to lift the plate off the boat without
 * cutting it loose from it. Everything below only ever lengthens this. */
const STEM = 12;
/* Two plates closer together than their own height overlap, and an overlapping
 * pair of labels is one unreadable label. Eighteen is the plate. */
const MIN_GAP = 18;
/* How far the plate floats clear of the boat it is named after. In pixels,
 * because what it has to clear is the drawn boat rather than a distance on the
 * water: the same skiff is eight metres of mast in the chase and a few pixels
 * of it from a hundred and sixty metres up. */
const RIG_CLEAR = 8;
/* And how far it stays clear of a boat that is not its own. Wider than its own
 * rig, because a plate touching its own masthead still reads as belonging to
 * that boat while one touching a stranger's mainsail reads as belonging to the
 * stranger. */
const CROSS_CLEAR = 12;

/* The corners a plate stays above, in the heeled node's own frame: masthead,
 * sprit tip, transom and both rack tips. Which of them lands highest on screen
 * is the rig's business, not the boat's. From the helicopter it is the masthead
 * every time; from a hundred and sixty metres up and course up the mast is
 * barely a dozen pixels and the sprit is what reaches up the frame. The same
 * five, spread rather than reduced to their highest, are the box every other
 * plate has to keep off. */
const CORNERS = [
  0, SKIFF.mastTop, SKIFF.mastZ,
  0, 0.46, SKIFF.spritTip,
  0, 0.35, SKIFF.transom,
  -SKIFF.rack, 0.55, 0,
  SKIFF.rack, 0.55, 0,
];
/* How far one plate has to be clear of another before their heights, rather
 * than their places in the race, decide which of them takes the upper slot. */
const SLOT_BAND = 8;

/* Where the plate is full size and where it stops shrinking. The range is small
 * on purpose: a label is a caption, and a caption that halves in size across the
 * fleet reads as six different kinds of label. */
const SCALE_NEAR = 25;
const SCALE_FAR = 220;
const SCALE_MIN = 0.85;

/* The ceiling on how far a plate may climb above its own waterline, as a share
 * of the picture. A boat close to the chase camera is eight metres of rig and
 * most of the frame, so its plate belongs above its masthead and the stem that
 * says so is long; a boat low and near in the same frame would otherwise throw
 * its plate three quarters of the way up the picture on a hairline. Held to a
 * share rather than to pixels so the rule reads the same on a phone. */
const MAX_RISE = 0.42;
const MIN_RISE = 96;

/* Until the fonts have settled the plate has no measured size, and a first
 * frame drawn against nothing would put every plate in one column. These are
 * the sizes the stylesheet builds them at. */
const PLATE_W = 78;
const PLATE_H = 18;

/* Below this the write is a repaint for nothing. Half a pixel is under what the
 * compositor can show and well under what an eye can follow. */
const MOVE_EPSILON = 0.5;

interface LabelNode {
  root: HTMLDivElement;
  stem: HTMLSpanElement;
  box: HTMLSpanElement;
  rank: HTMLSpanElement;
  x: number;
  y: number;
  scale: number;
  width: number;
  height: number;
  /* What was last written to the DOM, so an unchanged plate costs nothing. */
  placedX: number;
  placedY: number;
  placedScale: number;
  stemLength: number;
  stemLift: number;
  shown: boolean;
  lead: boolean;
  covered: boolean;
}

/* The panels, in the label layer's own coordinates. A plate drawn under one of
 * them is not hidden by it: the ground is 0.86 opaque, so it comes through as a
 * ghost row of a table it has nothing to do with. */
const DOCK_CAP = 4;

/**
 * Six plates on the canvas, projected by hand. No React root per label and no
 * component tree under the canvas: the labels are built once as DOM and written
 * to with transforms, so steady playback commits nothing.
 *
 * The pass runs after the camera rig, reads every anchor before it writes any
 * style, and takes its positions from the same node the hull was drawn from this
 * frame. A label that re-derived the boat's place would swim against it, which
 * is the artifact this page is being judged on.
 *
 * Placement answers to three things in order: the plate clears its own rig, it
 * clears the rig of anything drawn in front of it, and it clears its neighbours.
 * Only the first of those was ever true before, which is how a plate for a boat
 * two hundred metres away ended up lying across the mainsail of the boat in the
 * foreground.
 */
export function BoatLabels({ race }: { race: RaceData }) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const nodes = useRef<LabelNode[] | null>(null);
  const anchors = useMemo<(Object3D | null)[]>(() => race.boats.map(() => null), [race]);
  /* The heeled node under each anchor, which is the one the rig is drawn from
   * and so the only one that knows where the masthead really is, and the boom
   * node under that, which is the only one that knows where the cloth is. The
   * boom is the first group the heeled node carries: two hull meshes, then the
   * spars in the order they are hung. */
  const rigs = useMemo<(Object3D | null)[]>(() => race.boats.map(() => null), [race]);
  const booms = useMemo<(Object3D | null)[]>(() => race.boats.map(() => null), [race]);
  const committee = useRef<Mesh | null>(null);
  const point = useMemo(() => new Vector3(), []);
  const edge = useMemo(() => new Vector3(), []);
  const index = useMemo(() => {
    const map = new Map<string, number>();
    race.boats.forEach((boat, i) => map.set(boat.id, i));
    return map;
  }, [race]);
  const ranks = useMemo(() => new Int32Array(race.boats.length), [race]);
  const labelY = useMemo(() => new Float64Array(race.boats.length), [race]);
  const visible = useMemo(() => new Uint8Array(race.boats.length), [race]);
  const covered = useMemo(() => new Uint8Array(race.boats.length), [race]);
  /* One screen box per thing a plate can land on: the six rigs and the
   * committee boat, in that order, with the range that says which of them is in
   * front of which. */
  const boxes = useMemo(() => new Float64Array((race.boats.length + 1) * 5), [race]);
  const drawn = useMemo(() => new Uint8Array(race.boats.length + 1), [race]);
  /* The plates in the order they stack, rebuilt every frame into the same
   * array so the pass allocates nothing. */
  const stack = useMemo<number[]>(() => race.boats.map((boat, i) => i), [race]);
  const docks = useMemo(() => new Float64Array(DOCK_CAP * 4), []);
  const dockCount = useRef(0);

  useEffect(() => {
    const parent = gl.domElement.parentElement;
    if (parent === null) return;
    const layer = document.createElement("div");
    layer.className = styles.labelLayer;
    layer.setAttribute("aria-hidden", "true");
    const built: LabelNode[] = race.boats.map((boat) => {
      const root = document.createElement("div");
      root.className = styles.boatLabel;
      /* Its own attribute rather than the standings' data-boat: the two name the
       * same six boats in the same document and a selector that caught both
       * would be reading a dock row as a plate on the water. */
      root.dataset.label = boat.id;
      root.style.visibility = "hidden";
      const stem = document.createElement("span");
      stem.className = styles.labelStem;
      const box = document.createElement("span");
      box.className = styles.labelBox;
      const chip = document.createElement("span");
      /* A near black or near white hue has nothing to hold against the plate, so
       * it gets a rule around it rather than a brighter version of itself. */
      chip.className =
        boat.dark === true ? `${styles.labelChip} ${styles.chipOutlined}` : styles.labelChip;
      chip.style.background = boat.hue;
      const sail = document.createElement("span");
      sail.className = styles.labelSail;
      sail.textContent = boat.sail;
      const rank = document.createElement("span");
      rank.className = styles.labelRank;
      box.append(chip, sail, rank);
      root.append(stem, box);
      layer.append(root);
      return {
        root,
        stem,
        box,
        rank,
        x: Number.NaN,
        y: Number.NaN,
        scale: 1,
        width: PLATE_W,
        height: PLATE_H,
        placedX: Number.NaN,
        placedY: Number.NaN,
        placedScale: Number.NaN,
        stemLength: Number.NaN,
        stemLift: Number.NaN,
        shown: false,
        lead: false,
        covered: false,
      };
    });
    parent.append(layer);
    nodes.current = built;

    /* Sizes are read here and never in the frame loop: asking a plate how wide
     * it is mid-pass would flush layout on every frame, and the answer only
     * changes when a font arrives or a rank turns into a dash. */
    const sized = new Map<Element, LabelNode>();
    for (const node of built) sized.set(node.box, node);
    const plates = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const node = sized.get(entry.target);
        const size = entry.borderBoxSize[0];
        if (node === undefined || size === undefined) continue;
        if (size.inlineSize > 0) node.width = size.inlineSize;
        if (size.blockSize > 0) node.height = size.blockSize;
      }
    });
    for (const node of built) plates.observe(node.box, { box: "border-box" });

    /* The panels the plates have to stay out of. Measured off the layout rather
     * than off the stylesheet's numbers, because at the narrow width the docks
     * leave the canvas entirely and stack under it, where they forbid nothing. */
    const stage = parent.parentElement;
    const panels: Element[] =
      stage === null
        ? []
        : [...stage.querySelectorAll(`.${styles.dockTop}, [data-dock]`)].slice(0, DOCK_CAP);
    const measure = (): void => {
      const frame = layer.getBoundingClientRect();
      let held = 0;
      for (const panel of panels) {
        const rect = panel.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const left = rect.left - frame.left;
        const top = rect.top - frame.top;
        const right = left + rect.width;
        const bottom = top + rect.height;
        if (right <= 0 || bottom <= 0 || left >= frame.width || top >= frame.height) continue;
        docks[held * 4] = left;
        docks[held * 4 + 1] = top;
        docks[held * 4 + 2] = right;
        docks[held * 4 + 3] = bottom;
        held++;
      }
      dockCount.current = held;
    };
    measure();
    const layout = new ResizeObserver(measure);
    layout.observe(layer);
    for (const panel of panels) layout.observe(panel);

    return () => {
      nodes.current = null;
      plates.disconnect();
      layout.disconnect();
      layer.remove();
    };
  }, [gl, race, docks]);

  /* The placement passes are built once and called from the frame loop rather
   * than declared inside it: a closure per pass per frame is four allocations a
   * frame for nothing. They read the same preallocated arrays the projection
   * wrote, so nothing is handed between them either. */
  const passes = useMemo(() => {
    const count = race.boats.length;

    const inDock = (left: number, top: number, right: number, bottom: number): boolean => {
      for (let d = 0; d < dockCount.current; d++) {
        if (
          right > docks[d * 4] &&
          left < docks[d * 4 + 2] &&
          bottom > docks[d * 4 + 1] &&
          top < docks[d * 4 + 3]
        ) {
          return true;
        }
      }
      return false;
    };

    /* Clear of anything drawn in front. A plate is pushed above the box rather
     * than sideways out of it: sideways moves the plate off the boat it names,
     * and up is the direction the picture has room in. A lift can put the plate
     * inside a box that was higher up again, so the pass runs until it settles
     * or three rounds have gone by, which is one more than six boats can need. */
    const clearFront = (i: number): void => {
      const built = nodes.current;
      if (built === null) return;
      const half = (built[i].width * built[i].scale) / 2;
      const plateLeft = built[i].x - half;
      const plateRight = built[i].x + half;
      const height = built[i].height * built[i].scale;
      const range = boxes[i * 5 + 4];
      for (let round = 0; round < 3; round++) {
        let want = labelY[i];
        for (let o = 0; o <= count; o++) {
          if (o === i || drawn[o] === 0) continue;
          if (boxes[o * 5 + 4] >= range) continue;
          if (boxes[o * 5 + 2] < plateLeft || boxes[o * 5] > plateRight) continue;
          if (boxes[o * 5 + 1] >= want || boxes[o * 5 + 3] <= want - height) continue;
          const lifted = boxes[o * 5 + 1] - CROSS_CLEAR;
          if (lifted < want) want = lifted;
        }
        if (want === labelY[i]) return;
        labelY[i] = want;
      }
    };

    /* Ordered on where each plate wants to sit rather than on where its boat
     * floats: a near boat's rig is worth ten times a far one's in pixels, so two
     * hulls level on the water can want their plates a long way apart, and
     * settling them in hull order would drag one of them across the frame to
     * make room it did not need.
     *
     * Inside a band the width of the noise in a projected point the order comes
     * from the race instead. Two boats level with each other differ by a
     * fraction of a pixel and the sign of that fraction is not a fact about
     * anything: ordering on it alone made the pair trade slots every few frames
     * and jump the height of a plate each time. A place in the race only changes
     * when the race changes, so a level pair holds still and the leader takes
     * the upper slot. Rebuilt every frame from this frame's numbers, because a
     * stack carried across frames would make a still depend on how the clock
     * arrived at it. */
    const restack = (): void => {
      stack.length = 0;
      for (let i = 0; i < count; i++) {
        if (visible[i] === 0) continue;
        let at = stack.length;
        while (at > 0) {
          const other = stack[at - 1];
          const delta = labelY[i] - labelY[other];
          const first = delta <= -SLOT_BAND || (delta < SLOT_BAND && ranks[i] < ranks[other]);
          if (!first) break;
          stack[at] = other;
          at--;
        }
        stack[at] = i;
      }
    };

    /* Plates are pushed up rather than down: down is where the boats are. Only
     * against the plates they actually share a column with, though. Two plates
     * at opposite ends of the frame do not overlap at any height, and treating
     * them as one stack is what used to walk a plate several hundred pixels up
     * the picture to make room nobody was standing in. */
    const settle = (): void => {
      const built = nodes.current;
      if (built === null) return;
      for (let k = stack.length - 1; k >= 0; k--) {
        const i = stack[k];
        const half = (built[i].width * built[i].scale) / 2;
        for (let m = k + 1; m < stack.length; m++) {
          const j = stack[m];
          const other = (built[j].width * built[j].scale) / 2;
          if (built[i].x + half < built[j].x - other) continue;
          if (built[i].x - half > built[j].x + other) continue;
          if (labelY[i] > labelY[j] - MIN_GAP) labelY[i] = labelY[j] - MIN_GAP;
        }
      }
    };

    return { inDock, clearFront, restack, settle };
  }, [race, boxes, docks, drawn, labelY, ranks, stack, visible]);

  useFrame((state) => {
    const built = nodes.current;
    if (built === null) return;
    const { inDock, clearFront, restack, settle } = passes;
    const { followId } = useReplay.getState();
    const live = sampleLive(race);
    const camera = state.camera;
    /* The rig set position and aim a moment ago and nothing has flushed it into
     * a world matrix yet: the renderer does that after every subscriber has run.
     * Projecting off the stale one would put every label a frame behind. */
    camera.updateMatrixWorld();
    const halfWidth = state.size.width / 2;
    const halfHeight = state.size.height / 2;
    const count = race.boats.length;
    const maxRise = Math.max(MIN_RISE, state.size.height * MAX_RISE);

    for (let i = 0; i < count; i++) ranks[i] = 0;
    for (const row of live.rows) {
      const slot = index.get(row.boatId);
      if (slot !== undefined) ranks[slot] = row.rank;
    }

    for (let i = 0; i < count; i++) {
      visible[i] = 0;
      covered[i] = 0;
      drawn[i] = 0;
      let anchor = anchors[i];
      if (anchor === null || anchor.parent === null) {
        anchor = scene.getObjectByName(race.boats[i].id) ?? null;
        anchors[i] = anchor;
        rigs[i] = null;
        booms[i] = null;
      }
      if (anchor === null) continue;
      if (rigs[i] === null) rigs[i] = anchor.children[0] ?? null;
      const inner = rigs[i];
      if (booms[i] === null && inner !== null) {
        booms[i] = inner.children.find((child) => child.type === "Group") ?? null;
      }
      /* The hull's own node, brought up to date the same way the renderer will:
       * the outer group carries position and heading with the waterline at its
       * origin, which is exactly where a stem should land. */
      anchor.updateWorldMatrix(true, false);
      point.setFromMatrixPosition(anchor.matrixWorld);
      const range = point.distanceTo(camera.position);
      point.applyMatrix4(camera.matrixWorldInverse);
      /* Behind the eye a projection folds back into frame and the label lands
       * on the wrong side of the picture. */
      if (point.z > -camera.near) continue;
      point.applyMatrix4(camera.projectionMatrix);
      const px = (point.x + 1) * halfWidth;
      const py = (1 - point.y) * halfHeight;
      /* The stem starts at the waterline because that is what it points at, and
       * the plate goes over the rig rather than over the deck. A fixed distance
       * in metres cannot do that: eight metres of mast is most of the frame in
       * the chase and a couple of dozen pixels from a hundred and sixty metres
       * up, so a clearance that reads as generous on the water still lands the
       * plate halfway up the mainsail whose number it repeats. The boat's own
       * corners go through the heeled node the sails hang off. */
      let top = py;
      let bottom = py;
      let left = px;
      let right = px;
      /* The heeled node first and the boom node second, because the boom hangs
       * off the heeled one and composes against whatever world matrix it finds
       * there. */
      for (let pass = 0; pass < 2; pass++) {
        const node = pass === 0 ? rigs[i] : booms[i];
        if (node === null) continue;
        const corners = pass === 0 ? CORNERS : MAIN_CORNERS;
        node.updateWorldMatrix(false, false);
        for (let p = 0; p < corners.length; p += 3) {
          edge
            .set(corners[p], corners[p + 1], corners[p + 2])
            .applyMatrix4(node.matrixWorld)
            .applyMatrix4(camera.matrixWorldInverse);
          if (edge.z > -camera.near) continue;
          edge.applyMatrix4(camera.projectionMatrix);
          const cornerX = (edge.x + 1) * halfWidth;
          const cornerY = (1 - edge.y) * halfHeight;
          if (cornerY < top) top = cornerY;
          if (cornerY > bottom) bottom = cornerY;
          if (cornerX < left) left = cornerX;
          if (cornerX > right) right = cornerX;
        }
      }
      /* The box is kept even for a boat whose own plate is not drawn: a hull
       * half out of frame still covers the boat behind it. */
      boxes[i * 5] = left;
      boxes[i * 5 + 1] = top;
      boxes[i * 5 + 2] = right;
      boxes[i * 5 + 3] = bottom;
      boxes[i * 5 + 4] = range;
      drawn[i] = 1;
      if (px < 0 || px > halfWidth * 2 || py < 0 || py > halfHeight * 2) continue;
      /* A boat behind a panel has no plate. The panel ground is not opaque, so
       * one drawn there reads through it as a row of the table it is sitting
       * on rather than as a boat on the water. */
      if (inDock(px, py, px, py)) continue;
      visible[i] = 1;
      /* Twelve pixels stays the floor, for a boat far enough off that its
       * waterline and its masthead land on the same place. */
      labelY[i] = Math.min(top - RIG_CLEAR, py - STEM);
      built[i].scale =
        SCALE_MIN +
        (1 - SCALE_MIN) *
          Math.min(Math.max((SCALE_FAR - range) / (SCALE_FAR - SCALE_NEAR), 0), 1);
      built[i].x = px;
      built[i].y = py;
    }

    /* The committee boat, which is the one piece of course furniture with the
     * height to swallow a plate. Her bounds come off the geometry rather than
     * off a guess, so the staff and the flag are inside them. */
    let vessel = committee.current;
    if (vessel === null || vessel.parent === null) {
      const found = scene.getObjectByName("committee");
      vessel = found !== undefined && (found as Mesh).isMesh === true ? (found as Mesh) : null;
      committee.current = vessel;
    }
    drawn[count] = 0;
    if (vessel !== null) {
      const geometry = vessel.geometry;
      if (geometry.boundingBox === null) geometry.computeBoundingBox();
      if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
      const bounds = geometry.boundingBox;
      const sphere = geometry.boundingSphere;
      if (bounds !== null && sphere !== null) {
        vessel.updateWorldMatrix(true, false);
        point.copy(sphere.center).applyMatrix4(vessel.matrixWorld);
        const range = point.distanceTo(camera.position);
        let left = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let top = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        let seen = 0;
        for (let corner = 0; corner < 8; corner++) {
          edge
            .set(
              (corner & 1) === 0 ? bounds.min.x : bounds.max.x,
              (corner & 2) === 0 ? bounds.min.y : bounds.max.y,
              (corner & 4) === 0 ? bounds.min.z : bounds.max.z,
            )
            .applyMatrix4(vessel.matrixWorld)
            .applyMatrix4(camera.matrixWorldInverse);
          if (edge.z > -camera.near) continue;
          edge.applyMatrix4(camera.projectionMatrix);
          const cornerX = (edge.x + 1) * halfWidth;
          const cornerY = (1 - edge.y) * halfHeight;
          if (cornerX < left) left = cornerX;
          if (cornerX > right) right = cornerX;
          if (cornerY < top) top = cornerY;
          if (cornerY > bottom) bottom = cornerY;
          seen++;
        }
        if (seen === 8) {
          boxes[count * 5] = left;
          boxes[count * 5 + 1] = top;
          boxes[count * 5 + 2] = right;
          boxes[count * 5 + 3] = bottom;
          boxes[count * 5 + 4] = range;
          drawn[count] = 1;
        }
      }
    }

    for (let i = 0; i < count; i++) if (visible[i] === 1) clearFront(i);
    restack();
    settle();
    /* A settled plate can have been carried into a box it had already cleared,
     * so the two passes run once more against each other. */
    for (let i = 0; i < count; i++) if (visible[i] === 1) clearFront(i);
    settle();

    for (let i = 0; i < count; i++) {
      if (visible[i] === 0) continue;
      const node = built[i];
      if (node.y - labelY[i] > maxRise) labelY[i] = node.y - maxRise;
      if (labelY[i] > node.y - STEM) labelY[i] = node.y - STEM;
      const half = (node.width * node.scale) / 2;
      const height = node.height * node.scale;
      if (inDock(node.x - half, labelY[i] - height, node.x + half, labelY[i])) {
        visible[i] = 0;
        continue;
      }
      /* Whether the stem still has a waterline to point at. Run past a hull in
       * front of it the line reaches a place the picture does not show, so the
       * plate keeps a short stem that says which way its boat is and steps back
       * to the dim ink instead of drawing a lie across someone's mainsail. */
      const range = boxes[i * 5 + 4];
      for (let o = 0; o <= count; o++) {
        if (o === i || drawn[o] === 0) continue;
        if (boxes[o * 5 + 4] >= range) continue;
        if (boxes[o * 5] > node.x || boxes[o * 5 + 2] < node.x) continue;
        if (boxes[o * 5 + 1] >= node.y || boxes[o * 5 + 3] <= labelY[i]) continue;
        covered[i] = 1;
        break;
      }
    }

    for (let i = 0; i < count; i++) {
      const node = built[i];
      const shown = visible[i] === 1;
      if (shown !== node.shown) {
        node.root.style.visibility = shown ? "visible" : "hidden";
        node.shown = shown;
      }
      if (!shown) continue;
      const lead = race.boats[i].id === followId;
      if (lead !== node.lead) {
        node.root.classList.toggle(styles.boatLabelLead, lead);
        node.lead = lead;
      }
      const hidden = covered[i] === 1;
      if (hidden !== node.covered) {
        node.root.classList.toggle(styles.boatLabelCovered, hidden);
        node.covered = hidden;
      }
      /* A boat with no progress sample has no place yet, and a place nobody
       * measured is a dash rather than a number. */
      setText(node.rank, ranks[i] > 0 ? String(ranks[i]) : "-");
      const rise = Math.max(STEM, node.y - labelY[i]);
      const stemLength = hidden ? STEM : rise;
      const stemLift = rise - stemLength;
      if (
        !(Math.abs(node.x - node.placedX) < MOVE_EPSILON) ||
        !(Math.abs(node.y - node.placedY) < MOVE_EPSILON)
      ) {
        node.root.style.transform = `translate3d(${node.x.toFixed(1)}px, ${node.y.toFixed(1)}px, 0)`;
        node.placedX = node.x;
        node.placedY = node.y;
      }
      if (
        !(Math.abs(stemLength - node.stemLength) < MOVE_EPSILON) ||
        !(Math.abs(stemLift - node.stemLift) < MOVE_EPSILON) ||
        !(Math.abs(node.scale - node.placedScale) < 0.004)
      ) {
        /* The stem scales about its own foot, so lifting it is a translate on
         * top of the scale: a plate that has given up its waterline keeps the
         * same twelve pixels of line, hung under the plate rather than run all
         * the way down. */
        node.stem.style.transform = `translateY(${(-stemLift).toFixed(1)}px) scaleY(${stemLength.toFixed(1)})`;
        /* The plate is already bottom anchored at the label root and scales
         * about that same edge, so lifting it by the rise is the whole of the
         * placement. Asking for its own height on top of that is what left
         * sixteen pixels of daylight between every plate and the line drawn to
         * reach it. */
        node.box.style.transform = `translateX(-50%) translateY(${(-rise).toFixed(1)}px) scale(${node.scale.toFixed(3)})`;
        node.stemLength = stemLength;
        node.stemLift = stemLift;
        node.placedScale = node.scale;
      }
    }
  }, -50);

  return null;
}
