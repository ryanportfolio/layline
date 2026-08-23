/**
 * Whether the next frame is worth drawing, and how to ask for one.
 *
 * The replay clock runs inside the render loop, so the loop cannot stop; what
 * can stop is the drawing. A frame is worth its cost only when it can be seen
 * and can differ from the one already on screen, which rules out three states
 * the console spends real time in: the 2D chart, where the canvas is held at
 * zero opacity; the canvas scrolled out of the viewport, which is where a
 * visitor reads the debrief; and a paused replay with nothing touched since it
 * was drawn, which is also where a reduced-motion visitor opens.
 *
 * Module scope, like dockBand and fleetFrame, because the render loop reads it
 * every frame and a store read per frame would cost more than it saves. It
 * outlives any one canvas, so a mounting canvas resets it: a stale lost-context
 * flag left behind by a previous visit would keep the next one dark.
 */
export const sceneGate = {
  /* The canvas intersects the viewport. Starts true so the first frames are
   * drawn before the observer has said anything. Read with a margin, because a
   * canvas about to be scrolled into view needs a frame ready before it
   * arrives. */
  onScreen: true,
  /* The canvas is actually in the viewport, measured with no margin at all.
   * The margin above is right for deciding whether to draw and wrong for
   * deciding who owns a key: the space bar belongs to the replay only while the
   * replay is genuinely being looked at, and belongs to the page's own scroll
   * the moment it is not. */
  inView: true,
  /* The document is visible. A hidden tab is not given frames by the platform
   * at all; this is what makes the state explicit and gives the return path
   * something to test. */
  pageVisible: true,
  contextLost: false,
  /* Something that moves the picture has happened since the last drawn frame.
   * Starts true because there is no first frame yet. */
  dirty: true,
  /* This frame's verdict, decided once at the top of the loop and read by the
   * quality governor and the render at the bottom of it. */
  willRender: true,
  /* Frames still owed after the picture changed.
   *
   * The water, the hulls and the spray are posed before the camera rig runs,
   * so every frame is drawn against the camera the frame before it settled on.
   * Playback hides that: the next frame lands ten milliseconds later and
   * carries the corrected picture. A page that stops drawing has no next frame,
   * so it would keep whichever half-corrected picture it stopped on. One more
   * frame is what continuous rendering would have drawn, and it is enough: the
   * frame after that is identical to it. */
  chase: 0,
  /* The drawing buffer as it was when the last frame was drawn. A change means
   * the buffer was resized, which clears it, so the picture has to be laid
   * down again. */
  bufferWidth: 0,
  bufferHeight: 0,
};

/* Set by the canvas: how to get a frame out of a renderer that is holding
 * still. R3F ignores invalidate() while the loop is at "never", so a frozen
 * page can only be moved by advancing it with a stated timestamp, which is the
 * same door the capture hold uses. */
let requestFrozenFrame: (() => void) | null = null;
/* The animation frame a wake is waiting on, or zero. */
let waking = 0;

export function setFrozenFrameRequest(request: (() => void) | null): void {
  /* A wake belongs to the hold that asked for it. Thawing and freezing again,
   * or leaving and coming back, installs a different door, and a frame still
   * waiting on the old one would land in the new hold as a frame nobody asked
   * for. Dropping it here also leaves the queue clear, so the first request the
   * new hold makes is not mistaken for one already in flight. */
  if (waking !== 0) {
    cancelAnimationFrame(waking);
    waking = 0;
  }
  requestFrozenFrame = request;
}

/**
 * Ask for a frame. Marks the picture dirty, and wakes a frozen canvas, which a
 * flag alone cannot do: a font landing, a dock resize, a restored tab or a
 * recovered context all have to reach the screen even when the clock is held.
 *
 * One layout change is several observers, each measuring a different part of
 * it, and a frozen advance draws on the spot. Asking one per observer would
 * draw the first of them against measurements the rest had not taken yet, so
 * the wake is held to the next animation frame, by which time every observer in
 * the delivery has had its turn. A page that is drawing needs none of this: the
 * flag alone is read by the frame already coming.
 */
export function requestSceneFrame(): void {
  sceneGate.dirty = true;
  if (requestFrozenFrame === null || waking !== 0) return;
  waking = requestAnimationFrame(() => {
    waking = 0;
    if (requestFrozenFrame !== null) requestFrozenFrame();
  });
}

export function resetSceneGate(): void {
  sceneGate.onScreen = true;
  sceneGate.inView = true;
  sceneGate.pageVisible = typeof document === "undefined" || !document.hidden;
  sceneGate.contextLost = false;
  sceneGate.dirty = true;
  sceneGate.willRender = true;
  sceneGate.chase = 0;
  sceneGate.bufferWidth = 0;
  sceneGate.bufferHeight = 0;
}
