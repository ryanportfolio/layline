/**
 * Direct interaction with the water: which boat the pointer is over, and where
 * the freeform camera is standing.
 *
 * Module scope rather than the store, for the same reason the render gate and
 * the fleet frame are: a pointermove that wrote zustand would re-render the
 * whole console and dirty the gate on every event, sixty times a drag. Nothing
 * here is React state and nothing here is read during a render.
 *
 * No three import. The camera is described in numbers and composed into a shot
 * by the rig that owns the camera, so this file runs under node and its whole
 * geometry can be tested without a WebGL context.
 */

/* How the eye stands off the centre it is orbiting:
 *
 *   eye = centre + (sin(yaw)cos(pitch), sin(pitch), cos(yaw)cos(pitch)) * dist
 *
 * Yaw is the compass bearing of the eye from the centre, in the renderer's
 * world frame, and pitch is how far above the centre it stands. */
export const PITCH_MIN = 0.06;
export const PITCH_MAX = 1.4;
export const DIST_MIN = 12;
export const DIST_MAX = 900;
/* The lens never goes under the sea state the water shader draws. */
export const EYE_FLOOR = 1.4;
/* Seconds a framing move takes. Long enough to read as travel, short enough
 * that a visitor asking to see the start line is looking at it before they
 * wonder whether the button worked. */
export const FRAME_SECONDS = 0.6;

export type FrameTarget = "fleet" | "selected" | "start" | "windward";

export interface FreeformCamera {
  /* The orbit centre. While `follow` is on it is the followed boat's position
   * plus the offset below, so the centre travels with the boat without
   * inheriting its heading. Otherwise it is the fixed world point in tx/ty/tz. */
  follow: boolean;
  ox: number;
  oy: number;
  oz: number;
  tx: number;
  ty: number;
  tz: number;
  yaw: number;
  pitch: number;
  dist: number;
  fov: number;
  /* A framing move in flight: where the centre and the range came from, and
   * how much of the move is left. Spent from frame delta rather than from the
   * replay clock, because framing is something a hand asked for and a held
   * clock would never pay for it. */
  fromX: number;
  fromY: number;
  fromZ: number;
  fromDist: number;
  left: number;
  span: number;
  /* A framing request the pointer or a button made, waiting for the frame that
   * can evaluate it: the fleet's box needs the poses the rig is about to read
   * anyway. */
  pending: FrameTarget | null;
  /* The boat under the centre has changed. The centre walks across to the new
   * one rather than teleporting, and it walks from the aim the last frame
   * composed, which is the only record of where the picture was. */
  retarget: boolean;
  /* A gesture is in flight, so the render gate keeps drawing a paused page. */
  busy: boolean;
}

export function newFreeformCamera(): FreeformCamera {
  return {
    follow: true,
    ox: 0,
    oy: 0,
    oz: 0,
    tx: 0,
    ty: 0,
    tz: 0,
    yaw: 0,
    pitch: 0.35,
    dist: 90,
    fov: 45,
    fromX: 0,
    fromY: 0,
    fromZ: 0,
    fromDist: 0,
    left: 0,
    span: FRAME_SECONDS,
    pending: null,
    retarget: false,
    busy: false,
  };
}

export const freeform = newFreeformCamera();

/* Refilled rather than replaced: the rig reads this object every frame and
 * holds it by reference, so a new one would leave the camera reading the old
 * race's state for as long as this module is loaded. */
export function resetFreeformCamera(): void {
  Object.assign(freeform, newFreeformCamera());
}

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/* The same cubic the rig handover uses, so a framing move and a rig change
 * carry the same shape. */
export function easeInOut(k: number): number {
  if (!(k > 0)) return 0;
  if (k >= 1) return 1;
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(2 - 2 * k, 3) * 0.5;
}

/**
 * Enter freeform from the shot on screen. Deriving yaw, pitch and range from
 * the eye and aim the automatic rig had just composed is what makes the switch
 * free of a jump: the first freeform frame stands exactly where the last rig
 * frame stood.
 *
 * The centre is kept as an offset from the boat being followed rather than as
 * a world point, so a camera taken over mid-chase keeps travelling with the
 * boat instead of watching it sail out of frame.
 */
export function seedFreeformFromShot(
  camera: FreeformCamera,
  ex: number,
  ey: number,
  ez: number,
  ax: number,
  ay: number,
  az: number,
  fov: number,
  boatX: number,
  boatY: number,
  boatZ: number,
): void {
  const dx = ex - ax;
  const dy = ey - ay;
  const dz = ez - az;
  const dist = clamp(Math.hypot(dx, dy, dz), DIST_MIN, DIST_MAX);
  camera.dist = dist;
  camera.pitch = clamp(Math.asin(clamp(dy / dist, -1, 1)), PITCH_MIN, PITCH_MAX);
  camera.yaw = Math.atan2(dx, dz);
  camera.fov = fov;
  camera.follow = true;
  camera.ox = ax - boatX;
  camera.oy = ay - boatY;
  camera.oz = az - boatZ;
  camera.tx = ax;
  camera.ty = ay;
  camera.tz = az;
  camera.left = 0;
  camera.pending = null;
}

export function orbit(camera: FreeformCamera, dx: number, dy: number): void {
  /* Radians per pixel. A drag across a 1200px canvas turns the eye most of the
   * way round the boat, which is the range a hand expects from one sweep. */
  camera.yaw -= dx * 0.005;
  camera.pitch = clamp(camera.pitch + dy * 0.005, PITCH_MIN, PITCH_MAX);
  camera.left = 0;
}

/**
 * Metres of water under one pixel at the orbit centre, which is what makes a
 * pan track the pointer instead of drifting: close in it moves the boat by a
 * boat length, a kilometre out it moves the course.
 */
export function metresPerPixel(camera: FreeformCamera, canvasHeight: number): number {
  if (!(canvasHeight > 0)) return 0;
  return (2 * camera.dist * Math.tan(((camera.fov * Math.PI) / 180) * 0.5)) / canvasHeight;
}

/**
 * Slide the centre across the water. The pan is in the ground plane rather
 * than in the screen plane: a camera that could pan its target under the sea
 * has nothing left to orbit around.
 */
export function pan(camera: FreeformCamera, dx: number, dy: number, scale: number): void {
  const rightX = Math.cos(camera.yaw);
  const rightZ = -Math.sin(camera.yaw);
  /* Up the screen is away from the eye, flattened onto the water. */
  const awayX = -Math.sin(camera.yaw);
  const awayZ = -Math.cos(camera.yaw);
  const mx = -(rightX * dx * scale) + awayX * dy * scale;
  const mz = -(rightZ * dx * scale) + awayZ * dy * scale;
  if (camera.follow) {
    camera.ox += mx;
    camera.oz += mz;
  } else {
    camera.tx += mx;
    camera.tz += mz;
  }
  camera.left = 0;
}

/* Exponential, so a wheel notch is the same fraction of the range at every
 * distance and the zoom cannot crawl far out and lurch close in. */
export function zoom(camera: FreeformCamera, notches: number): void {
  camera.dist = clamp(camera.dist * Math.exp(notches * 0.0015), DIST_MIN, DIST_MAX);
  camera.left = 0;
}

/* The range that fits a sphere of this radius in the shorter axis of the
 * frame, with a little air around it. */
export function distanceFor(radius: number, fov: number, aspect: number): number {
  const tall = Math.tan(((fov * Math.PI) / 180) * 0.5);
  const wide = tall * (aspect > 0 ? aspect : 1);
  const fit = Math.min(tall, wide);
  return clamp((radius * 1.25) / (fit > 0 ? fit : 1), DIST_MIN, DIST_MAX);
}

/**
 * Where the eye stands this frame, given the centre the caller resolved. The
 * framing ease is applied here rather than to the stored state, so the target
 * keeps tracking a moving boat while the move is still travelling toward it.
 */
export interface Stand {
  ex: number;
  ey: number;
  ez: number;
  ax: number;
  ay: number;
  az: number;
  dist: number;
}

export function standOf(
  camera: FreeformCamera,
  centreX: number,
  centreY: number,
  centreZ: number,
  out: Stand,
): void {
  let ax = centreX;
  let ay = centreY;
  let az = centreZ;
  let dist = camera.dist;
  if (camera.left > 0) {
    const k = easeInOut(1 - camera.left / camera.span);
    ax = camera.fromX + (ax - camera.fromX) * k;
    ay = camera.fromY + (ay - camera.fromY) * k;
    az = camera.fromZ + (az - camera.fromZ) * k;
    dist = camera.fromDist + (dist - camera.fromDist) * k;
  }
  const lean = Math.cos(camera.pitch);
  out.ax = ax;
  out.ay = ay;
  out.az = az;
  out.dist = dist;
  out.ex = ax + Math.sin(camera.yaw) * lean * dist;
  out.ey = Math.max(ay + Math.sin(camera.pitch) * dist, EYE_FLOOR);
  out.ez = az + Math.cos(camera.yaw) * lean * dist;
}

export function newStand(): Stand {
  return { ex: 0, ey: 0, ez: 0, ax: 0, ay: 0, az: 0, dist: 0 };
}

/* ---- pointer ownership ---- */

/**
 * What a press on the water resolves to. Kept as one pure decision rather than
 * a chain of early returns inside the handler, because this is the rule the
 * whole surface is judged on: a boat under the pointer is a selection, a
 * gesture is a camera move and nothing else, and only a still press on open
 * water is allowed to reach playback.
 */
export interface Press {
  /* The pointer travelled past the slop threshold, or a camera gesture ran. */
  gesture: boolean;
  /* The boat the pick found under the release point, if any. */
  hitId: string | null;
  /* The renderer has a frame up. Before that there is nothing to pick. */
  live: boolean;
  /* The chart has the stage. The scene is held behind it and picks nothing. */
  chart2d: boolean;
  button: number;
}

export type PressOutcome = "select" | "toggle" | "none";

export function pressOutcome(press: Press): PressOutcome {
  if (!press.live || press.chart2d || press.button !== 0) return "none";
  if (press.gesture) return "none";
  if (press.hitId !== null) return "select";
  return "toggle";
}

/* ---- picking ---- */

/* Set by the scene: normalised device coordinates in, boat id out. Held here
 * so the pointer handlers can live on the DOM layer that already owns the
 * press, the same way the gate hands out its frozen-frame door. */
let picker: ((nx: number, ny: number) => string | null) | null = null;

export function setBoatPicker(fn: ((nx: number, ny: number) => string | null) | null): void {
  picker = fn;
}

export function pickBoatAt(nx: number, ny: number): string | null {
  if (picker === null) return null;
  return picker(nx, ny);
}

/* Which boat is being pointed out, from the two places that can say so. They
 * are held apart because they end at different times: a pointer leaving the
 * water says nothing about a standings row that still has focus, and clearing
 * one shared field would take the focus ring's answer away with it.
 *
 * The pointer wins while it has one, because it is the more recent act. */
export const hover = {
  pointerId: null as string | null,
  focusId: null as string | null,
};

export function hoverId(): string | null {
  return hover.pointerId ?? hover.focusId;
}

export function setPointerHover(boatId: string | null): boolean {
  if (hover.pointerId === boatId) return false;
  const before = hoverId();
  hover.pointerId = boatId;
  return hoverId() !== before;
}

export function setFocusHover(boatId: string | null): boolean {
  if (hover.focusId === boatId) return false;
  const before = hoverId();
  hover.focusId = boatId;
  return hoverId() !== before;
}
