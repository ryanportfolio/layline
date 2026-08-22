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
/* Daylight between the foot of a stem and the top of whatever it stops above.
 * Under a couple of pixels the two read as one mark. */
const STEM_CLEAR = 3;
/* How close two plates have to stand side by side before one of them takes the
 * slot above the other. Two plates a pixel apart read as a single long bar, so
 * they are held to be sharing a column well before they touch. */
const COLUMN_NEAR = 8;
/* And where they stop answering to each other at all. The band between the two
 * is walked rather than switched: a crossing moves the gap between two plates
 * through zero a fraction of a pixel at a time, and a rule that answered to the
 * sign of it threw a plate a whole slot up the picture on noise. Walking it also
 * keeps the answer a function of this frame's numbers alone, so a still is the
 * same still however the clock arrived at it. */
const COLUMN_FAR = 20;
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
/* What a pixel of overlap with a box is worth in climb. The lift a box asks for
 * is the overlap it actually has with the plate's own band, priced at this rate
 * and stopped at the box's near edge, so a tall box grazing the plate cannot
 * spend the whole of its rim on a hairline: a hundred pixels of climb bought by
 * three pixels of graze is what a viewer reads as a dropped frame. */
const CROSS_RATE = 10.5;
/* And how much nearer a box has to be before the plate treats it as drawn in
 * front at all, read forward from level rather than from a hull length behind.
 * At a rounding the whole pack sits inside a few metres of each other's range,
 * and from a hundred and sixty metres up two hulls level with each other cross
 * at four centimetres a frame: a clearance set decided on that is a different
 * set every frame. A metre of range is a fact about the picture. */
const CROSS_DEPTH = 1;

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
/* How far one plate's boat has to reach above another's before their heights,
 * rather than their places in the race, decide which of them takes the upper
 * slot. Spread across the fleet rather than applied per pair: the whole rank
 * term is worth this much from the leader to the last boat, so a place in the
 * race settles a pair the rigs leave level and can never outrank a gap the
 * viewer can see. */
const SLOT_BAND = 8;
/* The band the pair's stand-off is walked over. Two plates far apart in that
 * order stand off by the lower plate and a stem; two arriving at the crossing
 * stand off by the lower plate alone, so they pass close instead of trading a
 * whole stem. Read off this frame's numbers, so the walk is a place on a ramp
 * rather than a state carried between frames: a still is the same still however
 * the clock arrived at it. */
const SLOT_WALK = 12;

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

/* What a stem occupies rather than where it is placed: a pixel of drawn line,
 * plus the slack either side of it that the write above leaves between a plate's
 * placed x and the x it reaches the document at. A test on the bare point called
 * a stem clear of its neighbour while the line it stands for was running down
 * that neighbour's border. */
const STEM_WIDE = 1 + MOVE_EPSILON * 2;

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
/* And how far a plate stands off one. Pushed hard against a panel's rule a
 * plate reads as one more row of the table it is touching. */
const DOCK_GAP = 7;
/* And over how many pixels of intrusion the step around a panel is walked. A
 * plate drifting sideways past a panel's edge crosses it on a fraction of a
 * pixel, and answering to that with the whole height of the panel threw two
 * plates sixteen pixels and back three times in a third of a second. Four
 * pixels: over what an eye reads as a graze, under what it reads as an
 * overlap. */
const DOCK_BAND = 4;

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
 * Placement answers to four things in order: the plate clears its own rig, it
 * clears anything drawn in front of it, it clears its neighbours, and it stays
 * out of the four docks. A plate that only ever cleared its own rig is a plate
 * for a boat two hundred metres away lying across the mainsail of the boat in
 * the foreground, which is why the pass needs every boat's box and not just the
 * one it is placing.
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
  /* The height each plate wants before any pass has moved it: where it sits clear
   * of its own boat's rig and nothing else. Every ramp below is measured against
   * it, so a pass cannot read its own output back as a deeper reason to go
   * further, and the slot order is decided on it, so a clearance answer cannot
   * re-sort the column. */
  const natural = useMemo(() => new Float64Array(race.boats.length), [race]);
  const visible = useMemo(() => new Uint8Array(race.boats.length), [race]);
  const covered = useMemo(() => new Uint8Array(race.boats.length), [race]);
  /* How much line a covered plate has under it before it would reach the plate
   * below, so a stub is never a hairline drawn across another boat's rank. */
  const room = useMemo(() => new Float64Array(race.boats.length), [race]);
  /* How far a panel or the rise ceiling pushed each plate back down this frame,
   * which is the whole budget the repair pass is allowed to spend. A plate
   * nothing moved asks its neighbours for nothing. */
  const drop = useMemo(() => new Float64Array(race.boats.length), [race]);
  /* And where each plate stood before either of them touched it. */
  const preDock = useMemo(() => new Float64Array(race.boats.length), [race]);
  /* One screen box per thing a plate can land on: the six rigs and the
   * committee boat, in that order, with the range that says which of them is in
   * front of which. */
  const boxes = useMemo(() => new Float64Array((race.boats.length + 1) * 5), [race]);
  const drawn = useMemo(() => new Uint8Array(race.boats.length + 1), [race]);
  /* The plates in the order they stack, rebuilt every frame into the same
   * array so the pass allocates nothing. */
  const stack = useMemo<number[]>(() => race.boats.map((boat, i) => i), [race]);
  /* Four numbers for the panel's box and a fifth for the radius it is drawn
   * with, because the corner square a bounding box forbids is daylight the
   * panel never paints in. */
  const docks = useMemo(() => new Float64Array(DOCK_CAP * 5), []);
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
     * leave the canvas entirely and stack under it, where they forbid nothing.
     * Reached by climbing to the stage rather than by stepping up one parent:
     * the renderer's own wrapper sits between the canvas and the page. */
    const stage = gl.domElement.closest(`.${styles.stage}`);
    const panels: Element[] =
      stage === null
        ? []
        : [...stage.querySelectorAll(`.${styles.dockTop}, [data-dock]`)].slice(0, DOCK_CAP);
    /* The radius the panel is drawn with rather than the one its own box
     * carries: an instrument dock is a bare rectangle whose ground comes from
     * the panel filling it, and the shape a plate has to miss is that panel's.
     * Only a child that covers its parent counts, or a wordmark sitting inside
     * a square bar would speak for the bar. */
    const groundRound = (panel: Element, rect: DOMRect): number => {
      const own = Number.parseFloat(getComputedStyle(panel).borderTopLeftRadius);
      if (own > 0) return own;
      const inner = panel.firstElementChild;
      if (inner === null) return 0;
      const box = inner.getBoundingClientRect();
      if (
        Math.abs(box.left - rect.left) > 0.5 ||
        Math.abs(box.top - rect.top) > 0.5 ||
        Math.abs(box.right - rect.right) > 0.5 ||
        Math.abs(box.bottom - rect.bottom) > 0.5
      ) {
        return 0;
      }
      const filled = Number.parseFloat(getComputedStyle(inner).borderTopLeftRadius);
      return filled > 0 ? filled : 0;
    };
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
        docks[held * 5] = left;
        docks[held * 5 + 1] = top;
        docks[held * 5 + 2] = right;
        docks[held * 5 + 3] = bottom;
        docks[held * 5 + 4] = groundRound(panel, rect);
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
    /* The whole rank term, spread from the leader to the last boat. */
    const SLOT_BIAS = SLOT_BAND / Math.max(1, count - 1);

    /* How far a box has reached into a panel, taking the panel as the shape it
     * is drawn as rather than as the rectangle it is measured by. Against the
     * four straight edges that is the depth past the nearest of them. Against a
     * rounded end it is the arc: a box that sits wholly inside one corner
     * quadrant is held to the distance from that corner's centre, so a plate
     * that visibly clears the drawn round is clear and one a pixel inside it is
     * not. Insetting both spans at once instead would have deleted the whole
     * corner square, quarter disc and all, and let a plate slide under the
     * panel. Negative when the two are apart, and measured from each edge rather
     * than as an overlap so that the degenerate box a point test hands in still
     * reads as inside. */
    const dockReach = (
      d: number,
      left: number,
      top: number,
      right: number,
      bottom: number,
    ): number => {
      const panelLeft = docks[d * 5];
      const panelTop = docks[d * 5 + 1];
      const panelRight = docks[d * 5 + 2];
      const panelBottom = docks[d * 5 + 3];
      const flat = Math.min(
        right - panelLeft,
        panelRight - left,
        bottom - panelTop,
        panelBottom - top,
      );
      const corner = Math.max(
        0,
        Math.min(docks[d * 5 + 4], (panelRight - panelLeft) / 2, (panelBottom - panelTop) / 2),
      );
      if (flat <= 0 || corner <= 0) return flat;
      const roundX =
        right <= panelLeft + corner
          ? panelLeft + corner
          : left >= panelRight - corner
            ? panelRight - corner
            : Number.NaN;
      const roundY =
        bottom <= panelTop + corner
          ? panelTop + corner
          : top >= panelBottom - corner
            ? panelBottom - corner
            : Number.NaN;
      if (Number.isNaN(roundX) || Number.isNaN(roundY)) return flat;
      const awayX = Math.max(roundX - right, left - roundX, 0);
      const awayY = Math.max(roundY - bottom, top - roundY, 0);
      return corner - Math.hypot(awayX, awayY);
    };

    /* Which panel a box has run into, or minus one. */
    const hitDock = (left: number, top: number, right: number, bottom: number): number => {
      for (let d = 0; d < dockCount.current; d++) {
        if (dockReach(d, left, top, right, bottom) > 0) return d;
      }
      return -1;
    };

    /* A plate with a panel in its way steps around it rather than being thrown
     * away: over the panel if the stem can still reach that far, under it
     * otherwise, and whichever is the shorter move when both are open. Only a
     * plate with nowhere left in its own column is given up on, which is a boat
     * the panels have covered rather than one they are merely beside. */
    const dodgeDocks = (i: number, maxRise: number): boolean => {
      const built = nodes.current;
      if (built === null) return false;
      const node = built[i];
      const half = (node.width * node.scale) / 2;
      const height = node.height * node.scale;
      for (let round = 0; round < DOCK_CAP; round++) {
        const d = hitDock(node.x - half, labelY[i] - height, node.x + half, labelY[i]);
        if (d < 0) return true;
        /* And the step is walked in the same way every other stand-off on this
         * page is: the share of it the panel has taken, nothing at the edge and
         * all of it a few pixels in. */
        const share = Math.min(
          1,
          dockReach(d, node.x - half, labelY[i] - height, node.x + half, labelY[i]) / DOCK_BAND,
        );
        const over = docks[d * 5 + 1] - DOCK_GAP;
        const under = docks[d * 5 + 3] + height + DOCK_GAP;
        const overOk = node.y - over <= maxRise && over - height >= 0;
        const underOk = under <= node.y - STEM;
        let target: number;
        if (overOk && (!underOk || labelY[i] - over < under - labelY[i])) target = over;
        else if (underOk) target = under;
        /* Nowhere left to go is a plate the panels have covered. Given up on
         * for the fraction of a pixel a graze is, it would blink instead. */
        else if (share >= 1) return false;
        else return true;
        labelY[i] = share >= 1 ? target : labelY[i] + (target - labelY[i]) * share;
        /* A part step is a graze deliberately left standing, and a second round
         * against the same panel would spend the rest of the move it held
         * back. */
        if (share < 1) return true;
      }
      return hitDock(node.x - half, labelY[i] - height, node.x + half, labelY[i]) < 0;
    };

    /* Clear of anything drawn in front. A plate is pushed above the box rather
     * than sideways out of it: sideways moves the plate off the boat it names,
     * and up is the direction the picture has room in.
     *
     * Every term below is read off the height the plate came into the pass with
     * and off this frame's boxes, so the lift each box asks for is an answer
     * about where the plate belongs rather than about where the pass has already
     * put it, and one pass over the boxes is the whole of it. Measured against
     * the height a previous round had lifted it to, a box read deeper each round
     * because the plate had climbed into it and the lift asked for was whatever
     * the last round had left: three rounds and two passes turned a half share
     * into ninety eight percent of the move, which is a walked stand-off
     * arriving on screen as the switch it was written to replace. */
    const clearFront = (i: number): void => {
      const built = nodes.current;
      if (built === null) return;
      const half = (built[i].width * built[i].scale) / 2;
      const plateLeft = built[i].x - half;
      const plateRight = built[i].x + half;
      const height = built[i].height * built[i].scale;
      const range = boxes[i * 5 + 4];
      const gauge = natural[i];
      let want = labelY[i];
      for (let o = 0; o <= count; o++) {
        if (o === i || drawn[o] === 0) continue;
        /* Depth decides, for the committee boat as much as for a rival: a plate
         * sitting over something further away than its own boat is what a
         * broadcast graphic does, and she is scenery the fleet sails past rather
         * than a thing every label has to keep off whichever side of her it is
         * on. Excusing her from the test is what let a plate climb a hundred
         * pixels to miss a hull its own boat was already in front of. The walk
         * runs forward from level, so a box that is only level asks for nothing
         * and a pack rounding within a few metres of each other cannot enter and
         * leave six clearance sets on the noise in a range. */
        const front = Math.min(1, Math.max(0, (range - boxes[o * 5 + 4]) / CROSS_DEPTH));
        if (front <= 0) continue;
        /* The box is stood off sideways as well as upward, and the sideways term
         * is walked rather than switched: a plate that only had to miss the drawn
         * cloth by nothing lands with its end on the leech, and the sail is a
         * curve, so the cloth between the envelope's points reaches further out
         * than the box says. The walk is spent over the stand-off itself, which
         * puts the whole of it in before the two are drawn in the same pixels. */
        const side =
          Math.min(boxes[o * 5 + 2] + CROSS_CLEAR, plateRight) -
          Math.max(boxes[o * 5] - CROSS_CLEAR, plateLeft);
        if (side <= 0) continue;
        /* And how much of the plate's own band the box is drawn across, which is
         * what the lift is bought with. Measured as the overlap of the two bands
         * rather than as the box's lower edge against the plate's top: the second
         * is a switch wearing a ramp's clothes, because it hands over the whole
         * of the rim inside eight pixels of box travel however tall the box is,
         * and a tall box a few pixels into the plate is one the plate is nearly
         * under already. */
        const over =
          Math.min(boxes[o * 5 + 3], gauge) - Math.max(boxes[o * 5 + 1], gauge - height);
        if (over <= 0) continue;
        /* What the lift has to reach is the box's near edge, in pixels, because
         * two things drawn in the same pixels is what a viewer sees and no share
         * of a distance in metres reads on screen. Reaching it is the ceiling on
         * the climb, never the price of admission. */
        const rim = gauge - boxes[o * 5 + 1];
        if (rim <= 0) continue;
        /* The sideways reach is priced exactly as the vertical one is, capping
         * the lift rather than scaling it: a rig sliding out of the plate's
         * column hands the lift back at the rate it actually leaves, instead of
         * spending the whole of a two hundred pixel climb over the last few
         * pixels of box. */
        const lifted =
          gauge - Math.min(rim + CROSS_CLEAR, over * CROSS_RATE, side * CROSS_RATE) * front;
        if (lifted < want) want = lifted;
      }
      labelY[i] = want;
    };

    /* The one number the column is ordered on. Its body is how high above the
     * water each boat's own rig reaches, which is the one height on this page
     * that no placement pass touches: a near boat's rig is worth ten times a far
     * one's in pixels, so two hulls level on the water can want their plates a
     * long way apart, and settling them in hull order would drag one of them
     * across the frame to make room it did not need. Ordering instead on the
     * height a plate has after its clearances let a clearance answer about one
     * plate re-sort the whole column.
     *
     * Its tail is the place in the race, worth SLOT_BAND from the leader to the
     * last boat and no more. Two boats level with each other differ by a
     * fraction of a pixel and the sign of that fraction is not a fact about
     * anything: ordering on it alone made the pair trade slots every few frames.
     * A place in the race only changes when the race changes, so a level pair
     * holds still and the leader takes the upper slot, while a gap the viewer
     * can actually see is wider than the whole rank term and settles the pair on
     * its own.
     *
     * One scalar rather than a pair of branches, because two branches are not a
     * total order: a band that answers to the race inside it and to the heights
     * outside it can rank three plates in a cycle, and an insertion sort
     * resolving that cycle moved a plate two slots on a crossing it was not part
     * of. */
    const slotOf = (i: number): number => natural[i] + SLOT_BIAS * ranks[i];
    /* Rebuilt every frame from this frame's numbers, because a stack carried
     * across frames would make a still depend on how the clock arrived at it. */
    const restack = (): void => {
      stack.length = 0;
      for (let i = 0; i < count; i++) {
        if (visible[i] === 0) continue;
        let at = stack.length;
        while (at > 0) {
          const other = stack[at - 1];
          const delta = slotOf(i) - slotOf(other);
          if (!(delta < 0 || (delta === 0 && ranks[i] < ranks[other]))) break;
          stack[at] = other;
          at--;
        }
        stack[at] = i;
      }
    };

    /* How close two plates stand to sharing a screen column, which is how much
     * of the stand-off between them is worth asking for. Two plates at opposite
     * ends of the frame do not overlap at any height. */
    const columnShare = (i: number, j: number): number => {
      const built = nodes.current;
      if (built === null) return 0;
      const half = (built[i].width * built[i].scale) / 2;
      const other = (built[j].width * built[j].scale) / 2;
      const apart = Math.abs(built[i].x - built[j].x) - half - other;
      if (apart >= COLUMN_FAR) return 0;
      return apart <= COLUMN_NEAR ? 1 : (COLUMN_FAR - apart) / (COLUMN_FAR - COLUMN_NEAR);
    };

    /* How far apart the pair is held, walked on the same scalar the order was
     * decided on. Far apart in that order the upper plate stands off by the
     * lower plate and a stem, which is what its own line needs to reach the
     * water. Arriving at the crossing it stands off by the lower plate alone,
     * so the two pass close and the trade costs a plate rather than a plate and
     * a stem.
     *
     * The room stops shrinking there and never goes under the lower plate: two
     * plates sharing a screen column cannot swap without one crossing the other,
     * and drawn in the same pixels they are one illegible bar. A plate apart is
     * the least a swap can cost. */
    const heldRoom = (i: number, j: number): number => {
      const built = nodes.current;
      if (built === null) return STEM + STEM_CLEAR;
      const tall = built[j].height * built[j].scale;
      const walk = Math.min(1, Math.max(0, (slotOf(j) - slotOf(i)) / SLOT_WALK));
      return tall + STEM_CLEAR + STEM * walk;
    };

    /* Plates are pushed up rather than down: down is where the boats are. Only
     * against the plates they actually share a column with, though. Two plates
     * at opposite ends of the frame do not overlap at any height, and treating
     * them as one stack is what used to walk a plate several hundred pixels up
     * the picture to make room nobody was standing in.
     *
     * The room asked for is the lower plate and a stem over it, not the plate
     * alone. A plate is fifteen or so pixels and the old eighteen left three of
     * them for the line the upper plate hangs under itself, so that line landed
     * inside its neighbour and crossed another boat's rank.
     *
     * What is applied is the share of the move the pair has earned sideways, and
     * how much room is asked for is the walk above. The two are different levers:
     * a share of the move is nothing at the moment a pair drifts into the same
     * column and grows from there, while the room is what a pair arriving at a
     * crossing gives up so the trade costs a plate instead of a plate and a
     * stem. */
    const settle = (): void => {
      for (let k = stack.length - 1; k >= 0; k--) {
        const i = stack[k];
        for (let m = k + 1; m < stack.length; m++) {
          const j = stack[m];
          const share = columnShare(i, j);
          if (share <= 0) continue;
          const lift = labelY[i] - (labelY[j] - heldRoom(i, j));
          if (lift > 0) labelY[i] -= lift * share;
        }
      }
    };

    /* How far down a plate may be walked before its own band is drawn inside a
     * boat that is genuinely nearer than its own. Both terms are ramps, so the
     * floor travels with the picture rather than switching when two ranges
     * cross, and a plate the passes below cannot be pushed onto a stranger's
     * mainsail to make room for a neighbour it is not even touching. */
    const clearFloor = (i: number): number => {
      const built = nodes.current;
      if (built === null) return Number.POSITIVE_INFINITY;
      const half = (built[i].width * built[i].scale) / 2;
      const plateLeft = built[i].x - half;
      const plateRight = built[i].x + half;
      const range = boxes[i * 5 + 4];
      let floor = built[i].y - STEM;
      for (let o = 0; o <= count; o++) {
        if (o === i || drawn[o] === 0) continue;
        const front = Math.min(1, Math.max(0, (range - boxes[o * 5 + 4]) / CROSS_DEPTH));
        if (front <= 0) continue;
        const side = Math.min(boxes[o * 5 + 2], plateRight) - Math.max(boxes[o * 5], plateLeft);
        if (side <= 0) continue;
        const top = boxes[o * 5 + 1];
        if (top >= floor) continue;
        const grip = front * Math.min(1, side / CROSS_CLEAR);
        const limit = top + (1 - grip) * (built[i].y - top);
        if (limit < floor) floor = limit;
      }
      return floor;
    };

    /* A plate a panel or the rise ceiling pushed back down was put where the
     * settle pass did not choose it, and under a dock deep enough it lands on
     * the plate below. That one is walked back toward its own boat, which is the
     * direction it was lifted from. Downward only, so the pass ends where it
     * started rather than trading pushes with the pass that put the plates up
     * there.
     *
     * Read as the column now stands rather than as the order wanted it, and
     * spent only against what a dock or the rise ceiling actually took. Asking
     * for the order back instead made a plate standing clear above its slot owe
     * a whole room to a neighbour it was nowhere near, which is how a panel step
     * dropped three plates the height of two plates each onto other boats' sails.
     *
     * Worked from the top of the column down, so a plate pushed onto its
     * neighbour hands the move on rather than stopping on it. Where the clearance
     * floor and a neighbour disagree the neighbour wins: two plates drawn in the
     * same pixels are one illegible bar, which is worse than a plate low over a
     * boat. */
    const repair = (): void => {
      const built = nodes.current;
      if (built === null) return;
      let held = 0;
      for (let k = 0; k < stack.length; k++) {
        const i = stack[k];
        if (visible[i] === 0) continue;
        let at = held;
        while (at > 0 && labelY[stack[at - 1]] > labelY[i]) {
          stack[at] = stack[at - 1];
          at--;
        }
        stack[at] = i;
        held++;
      }
      stack.length = held;
      for (let k = 1; k < held; k++) {
        const low = stack[k];
        const tall = built[low].height * built[low].scale;
        let want = labelY[low];
        let tight = labelY[low];
        for (let m = 0; m < k; m++) {
          const high = stack[m];
          const share = columnShare(high, low);
          if (share <= 0) continue;
          const crowd = heldRoom(high, low) - (labelY[low] - labelY[high]);
          if (crowd > 0) {
            const budget = Math.min(crowd, drop[high] + drop[low]);
            const target = labelY[low] + budget * share;
            if (target > want) want = target;
          }
          const deep = labelY[high] + tall + STEM_CLEAR - labelY[low];
          if (deep > 0) {
            const target = labelY[low] + deep * share;
            if (target > tight) tight = target;
          }
        }
        if (want < tight) want = tight;
        if (want <= labelY[low]) continue;
        const bare = built[low].y - STEM;
        let cap = Math.min(clearFloor(low), bare);
        if (cap < tight) cap = Math.min(tight, bare);
        const stood = labelY[low];
        const other = (built[low].width * built[low].scale) / 2;
        labelY[low] = Math.min(want, cap);
        if (hitDock(built[low].x - other, labelY[low] - tall, built[low].x + other, labelY[low]) >= 0) {
          labelY[low] = stood;
        }
      }
    };

    return { hitDock, dodgeDocks, clearFront, restack, settle, repair };
  }, [race, boxes, docks, drawn, drop, labelY, natural, ranks, stack, visible]);

  useFrame((state) => {
    const built = nodes.current;
    if (built === null) return;
    const { hitDock, dodgeDocks, clearFront, restack, settle, repair } = passes;
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
       * half out of frame still covers the boat behind it. It is dropped only
       * when it stops being the size of a boat, which is what a rig with a
       * corner out beside the camera projects to. */
      boxes[i * 5 + 4] = range;
      if (right - left < halfWidth * 6 && bottom - top < halfHeight * 6) {
        boxes[i * 5] = left;
        boxes[i * 5 + 1] = top;
        boxes[i * 5 + 2] = right;
        boxes[i * 5 + 3] = bottom;
        drawn[i] = 1;
      }
      if (px < 0 || px > halfWidth * 2 || py < 0 || py > halfHeight * 2) continue;
      visible[i] = 1;
      /* Twelve pixels stays the floor, for a boat far enough off that its
       * waterline and its masthead land on the same place. */
      labelY[i] = Math.min(top - RIG_CLEAR, py - STEM);
      natural[i] = labelY[i];
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
        /* All eight corners, and a box the size of a boat rather than the size
         * of a divide by nearly zero: a hull with one corner sitting on the
         * near plane projects to something the width of a county, and a plate
         * would spend the frame climbing out of it. */
        const sane =
          right - left < halfWidth * 6 && bottom - top < halfHeight * 6;
        if (seen === 8 && sane) {
          boxes[count * 5] = left;
          boxes[count * 5 + 1] = top;
          boxes[count * 5 + 2] = right;
          boxes[count * 5 + 3] = bottom;
          boxes[count * 5 + 4] = range;
          drawn[count] = 1;
        }
      }
    }

    /* One clearance round, then one settle. A second clearFront can only ever
     * repeat the first: it reads the same gauge and the same boxes, and settle
     * moves plates the way it moves them. What a second round did do was run
     * settle twice, and two settles are not one answer: the second spends the
     * share the first held back, so the pair of passes had two fixed points and
     * a plate could overshoot on one frame and walk back on the next with
     * nothing on screen having crossed. */
    for (let i = 0; i < count; i++) if (visible[i] === 1) clearFront(i);
    restack();
    settle();

    for (let i = 0; i < count; i++) {
      if (visible[i] === 0) continue;
      const node = built[i];
      preDock[i] = labelY[i];
      if (node.y - labelY[i] > maxRise) labelY[i] = node.y - maxRise;
      if (labelY[i] > node.y - STEM) labelY[i] = node.y - STEM;
      if (!dodgeDocks(i, maxRise)) visible[i] = 0;
    }
    for (let i = 0; i < count; i++) {
      drop[i] = visible[i] === 1 ? Math.max(0, labelY[i] - preDock[i]) : 0;
    }
    repair();

    for (let i = 0; i < count; i++) {
      if (visible[i] === 0) continue;
      const node = built[i];
      /* Whether the stem still has a waterline to point at. Run past a hull in
       * front of it, or down behind a panel, the line reaches a place the
       * picture does not show, so the plate keeps a short stem that says which
       * way its boat is and steps back to the dim ink instead of drawing a lie
       * across someone's mainsail or into a table. */
      if (hitDock(node.x, node.y, node.x, node.y) >= 0) covered[i] = 1;
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

    /* And whether the stem has a clear run down to the water it points at. Two
     * plates sharing a column are held a stem apart above, so what is left is a
     * plate further down that column: a boat whose own waterline is well below
     * someone else's label draws its line straight through that label and across
     * another boat's rank. It keeps the stub instead, which says which way its
     * boat is without claiming a place the picture is not showing, and the stub
     * is only ever as long as the daylight it has. What is tested against the
     * plate below is the line's drawn width, not the point it hangs from: a stem
     * sitting a fraction of a pixel outside a plate's edge still paints down the
     * inside of that edge, which is the same hairline over another boat's rank
     * at the one margin the point test could not see. Run after every plate has
     * taken its final height, or the test would read a neighbour the dock pass
     * had not moved yet. */
    for (let i = 0; i < count; i++) {
      room[i] = STEM;
      if (visible[i] === 0) continue;
      const node = built[i];
      for (let o = 0; o < count; o++) {
        if (o === i || visible[o] === 0) continue;
        const half = (built[o].width * built[o].scale) / 2 + STEM_WIDE;
        if (node.x < built[o].x - half || node.x > built[o].x + half) continue;
        const top = labelY[o] - built[o].height * built[o].scale;
        if (top <= labelY[i] || top >= node.y) continue;
        covered[i] = 1;
        const spare = top - labelY[i] - STEM_CLEAR;
        if (spare < room[i]) room[i] = spare < 0 ? 0 : spare;
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
      const stemLength = hidden ? Math.min(room[i], rise) : rise;
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
