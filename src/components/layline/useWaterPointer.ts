"use client";

import { useEffect, type RefObject } from "react";
import { useReplay } from "./store";
import { requestSceneFrame, sceneGate } from "./scene/gate";
import {
  freeform,
  metresPerPixel,
  orbit,
  pan,
  pickBoatAt,
  pressOutcome,
  setPointerHover,
  zoom,
} from "./scene/interaction";

/* How far a press may travel and still be a click. The same eight pixels the
 * water has always used to tell a click from a drag, now also the line between
 * picking a boat and steering the camera. It applies to a finger exactly as it
 * applies to a mouse: a tap that wobbles by a pixel is still a tap. */
const SLOP = 8;

/* Fingers this surface will track at once. Two make every gesture it has; the
 * third seat is there so a stray palm has somewhere to land rather than
 * displacing a finger that is mid-pinch. */
const TOUCH_SEATS = 3;

interface Press {
  id: number;
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  gesture: boolean;
  panning: boolean;
  captured: boolean;
}

interface Seat {
  id: number;
  x: number;
  y: number;
}

/**
 * The water's one pointer owner.
 *
 * Everything a pointer can do to the replay is decided here: pick a boat,
 * steer the freeform camera, or reach playback. They are exclusive by
 * construction. A press that travelled is a camera move and can neither select
 * nor toggle; a press that landed on a boat selects and never reaches playback;
 * only a still press on open water reaches playback, which is the behaviour the
 * water has always had.
 *
 * Touch is tracked as a session rather than as a stream of pointers, because a
 * two finger gesture ends one finger at a time and in either order, and only
 * the session knows how far the whole thing travelled and whether more than one
 * finger took part.
 *
 * Nothing here writes React state. Hover and camera pose are module state read
 * by the frame loop, and the two store writes it does make, follow and setRig,
 * are things a hand asked for once.
 */
export function useWaterPointer(
  target: RefObject<HTMLDivElement | null>,
  live: boolean,
  zoomable = true,
): void {
  useEffect(() => {
    const node = target.current;
    if (node === null || !live) return;

    let press: Press | null = null;

    /* The touch session. Seats are reused rather than allocated: a pinch
     * delivers moves at pointer rate and every record it built would be one the
     * collector has to take back while the visitor is still moving. */
    const seats: Seat[] = [];
    for (let i = 0; i < TOUCH_SEATS; i++) seats.push({ id: -1, x: 0, y: 0 });
    const touch = {
      count: 0,
      /* The finger the session is measured from. It changes hands when that
       * finger lifts while another is still down. */
      primary: -1,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      /* The furthest the session has been from where it started, and whether
       * that is past the slop. */
      travel: 0,
      moved: false,
      /* More than one finger took part at any point. A session like that is a
       * camera gesture whatever it looks like at the end, and never a tap. */
      multi: false,
      spread: 0,
      captured: false,
    };

    const seatOf = (id: number): Seat | null => {
      for (const seat of seats) if (seat.id === id) return seat;
      return null;
    };

    const endTouchSession = () => {
      for (const seat of seats) seat.id = -1;
      touch.count = 0;
      touch.primary = -1;
      touch.travel = 0;
      touch.moved = false;
      touch.multi = false;
      touch.spread = 0;
      touch.captured = false;
      freeform.busy = false;
    };

    /* Reused scratch, for the same reason the seats are. */
    const device = { x: 0, y: 0 };
    let hoverX = 0;
    let hoverY = 0;
    let hoverWaiting = false;
    let frame = 0;

    const box = () => node.getBoundingClientRect();

    /* Capture keeps a drag alive when the pointer leaves the canvas, and it is
     * an improvement rather than a requirement: a pointer the platform has
     * already let go of throws here, and the gesture has to carry on either
     * way. Whether it took is recorded, because a gesture that never captured
     * can be walked off the element without a pointerup ever arriving. */
    const capture = (id: number): boolean => {
      try {
        node.setPointerCapture(id);
        return true;
      } catch {
        return false;
      }
    };

    const release = (id: number) => {
      try {
        if (node.hasPointerCapture(id)) node.releasePointerCapture(id);
      } catch {
        /* Already gone, which is the state this was asking for. */
      }
    };

    const toDevice = (x: number, y: number): boolean => {
      const rect = box();
      if (rect.width < 1 || rect.height < 1) return false;
      device.x = ((x - rect.left) / rect.width) * 2 - 1;
      device.y = -(((y - rect.top) / rect.height) * 2 - 1);
      return device.x >= -1 && device.x <= 1 && device.y >= -1 && device.y <= 1;
    };

    const pickAt = (x: number, y: number): string | null => {
      if (!toDevice(x, y)) return null;
      return pickBoatAt(device.x, device.y);
    };

    /* One pick a frame at most. A 240Hz mouse would otherwise raycast four
     * times for every picture anybody sees. */
    const flushHover = () => {
      frame = 0;
      if (!hoverWaiting) return;
      hoverWaiting = false;
      if (setPointerHover(pickAt(hoverX, hoverY))) requestSceneFrame();
    };

    const enterFreeform = () => {
      const replay = useReplay.getState();
      if (replay.rig !== "freeform") replay.setRig("freeform");
    };

    const resolve = (gesture: boolean, x: number, y: number, button: number) => {
      const replay = useReplay.getState();
      const hit = gesture ? null : pickAt(x, y);
      const outcome = pressOutcome({
        gesture,
        hitId: hit,
        live: true,
        chart2d: replay.chart2d,
        button,
      });
      if (outcome === "select" && hit !== null) replay.follow(hit);
      else if (outcome === "toggle") replay.toggle();
    };

    const onTouchDown = (event: PointerEvent) => {
      const seat = seatOf(-1);
      if (seat === null) return;
      seat.id = event.pointerId;
      seat.x = event.clientX;
      seat.y = event.clientY;
      touch.count += 1;
      if (touch.count === 1) {
        touch.primary = event.pointerId;
        touch.startX = event.clientX;
        touch.startY = event.clientY;
        touch.lastX = event.clientX;
        touch.lastY = event.clientY;
        touch.travel = 0;
        touch.moved = false;
        touch.multi = false;
      } else {
        touch.multi = true;
        touch.spread = 0;
      }
      /* Captured only inside the camera the visitor asked for. Everywhere else
       * a finger on the water is the page's scroll and nothing takes it. */
      if (useReplay.getState().rig === "freeform" && !touch.captured) {
        touch.captured = capture(event.pointerId);
      }
    };

    const onTouchMove = (event: PointerEvent) => {
      const seat = seatOf(event.pointerId);
      if (seat === null) return;
      seat.x = event.clientX;
      seat.y = event.clientY;
      /* Travel is measured whatever the rig is. A finger scrolling the page
       * past this canvas has moved, and the release must know that even though
       * nothing here was steering a camera. */
      if (event.pointerId === touch.primary) {
        const reach = Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY);
        if (reach > touch.travel) touch.travel = reach;
      }
      const replay = useReplay.getState();
      if (replay.rig !== "freeform" || replay.chart2d) return;

      if (touch.count === 1) {
        if (event.pointerId !== touch.primary) return;
        /* Below the slop this is still a tap, and a tap must be able to select
         * a boat. Nothing moves until the finger has said it is a drag. */
        if (!touch.moved) {
          if (touch.travel <= SLOP) return;
          touch.moved = true;
          freeform.busy = true;
          touch.lastX = event.clientX;
          touch.lastY = event.clientY;
          return;
        }
        orbit(freeform, event.clientX - touch.lastX, event.clientY - touch.lastY);
        touch.lastX = event.clientX;
        touch.lastY = event.clientY;
        requestSceneFrame();
        return;
      }

      let a: Seat | null = null;
      let b: Seat | null = null;
      for (const other of seats) {
        if (other.id === -1) continue;
        if (a === null) a = other;
        else if (b === null) b = other;
      }
      if (a === null || b === null) return;
      const reach = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) * 0.5;
      const midY = (a.y + b.y) * 0.5;
      if (touch.spread > 0) {
        /* Pinching out is the fleet coming closer, so the range shrinks by the
         * same ratio the fingers grew by. */
        if (zoomable) zoom(freeform, (touch.spread - reach) * 1.4);
        pan(freeform, midX - touch.lastX, midY - touch.lastY, metresPerPixel(freeform, box().height));
        touch.moved = true;
        freeform.busy = true;
        requestSceneFrame();
      }
      touch.spread = reach;
      touch.lastX = midX;
      touch.lastY = midY;
    };

    const onTouchUp = (event: PointerEvent, cancelled: boolean) => {
      const seat = seatOf(event.pointerId);
      if (seat === null) return;
      seat.id = -1;
      touch.count -= 1;
      release(event.pointerId);
      if (touch.count > 0) {
        touch.spread = 0;
        /* The session carries on in whichever hand is left. It was being
         * measured from a midpoint or from the finger that has just gone, so
         * the survivor takes over from where it actually is. */
        if (event.pointerId === touch.primary) {
          const rest = seats.find((other) => other.id !== -1);
          if (rest !== undefined) {
            touch.primary = rest.id;
            touch.lastX = rest.x;
            touch.lastY = rest.y;
          }
        }
        return;
      }
      /* Where the last finger ended up counts too: a move that was never
       * delivered still travelled. */
      const end = Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY);
      const gesture =
        cancelled || touch.multi || touch.moved || touch.travel > SLOP || end > SLOP;
      endTouchSession();
      if (cancelled) return;
      resolve(gesture, event.clientX, event.clientY, 0);
    };

    const onDown = (event: PointerEvent) => {
      const replay = useReplay.getState();
      if (replay.chart2d) return;
      if (event.pointerType === "touch") {
        onTouchDown(event);
        return;
      }
      if (event.button !== 0 && event.button !== 1) return;
      /* Stops the press turning into a text selection or a native drag on the
       * way to becoming an orbit. */
      event.preventDefault();
      press = {
        id: event.pointerId,
        button: event.button,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        gesture: false,
        panning: event.button === 1 || event.shiftKey,
        captured: false,
      };
    };

    const onMove = (event: PointerEvent) => {
      const replay = useReplay.getState();
      if (event.pointerType === "touch") {
        onTouchMove(event);
        return;
      }

      if (press === null) {
        if (replay.chart2d) return;
        hoverX = event.clientX;
        hoverY = event.clientY;
        hoverWaiting = true;
        if (frame === 0) frame = window.requestAnimationFrame(flushHover);
        return;
      }
      if (event.pointerId !== press.id || replay.chart2d) return;

      if (!press.gesture) {
        const travel = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
        if (travel <= SLOP) return;
        press.gesture = true;
        freeform.busy = true;
        press.captured = capture(press.id);
        /* Taking the camera by hand is what enters the mode, and the frame
         * that follows seeds it from the shot on screen. The first move after
         * the threshold is spent arriving there, so the drag continues from
         * here rather than jumping by the eight pixels already travelled. */
        enterFreeform();
        press.lastX = event.clientX;
        press.lastY = event.clientY;
        return;
      }

      const dx = event.clientX - press.lastX;
      const dy = event.clientY - press.lastY;
      press.lastX = event.clientX;
      press.lastY = event.clientY;
      if (press.panning) {
        pan(freeform, dx, dy, metresPerPixel(freeform, box().height));
      } else {
        orbit(freeform, dx, dy);
      }
      requestSceneFrame();
    };

    const endPress = (event: PointerEvent, cancelled: boolean) => {
      const started = press;
      if (started === null || started.id !== event.pointerId) {
        release(event.pointerId);
        return;
      }
      press = null;
      release(event.pointerId);
      freeform.busy = false;
      if (cancelled) return;
      const travelled =
        started.gesture ||
        Math.hypot(event.clientX - started.startX, event.clientY - started.startY) > SLOP;
      resolve(travelled, event.clientX, event.clientY, started.button);
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerType === "touch") onTouchUp(event, false);
      else endPress(event, false);
    };

    const onCancel = (event: PointerEvent) => {
      if (event.pointerType === "touch") onTouchUp(event, true);
      else endPress(event, true);
    };

    /* The platform taking a capture away mid-drag. Without this the gesture
     * would keep the picture marked dirty with nothing left to move it. */
    const onLostCapture = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        if (touch.count > 0) endTouchSession();
        return;
      }
      if (press !== null && press.id === event.pointerId) {
        press = null;
        freeform.busy = false;
      }
    };

    /* The pointer leaving the water with no capture to follow it: no pointerup
     * is coming, so the press ends here or it never ends. */
    const onLeave = (event: PointerEvent) => {
      if (setPointerHover(null)) requestSceneFrame();
      if (event.pointerType === "touch") return;
      if (press !== null && press.id === event.pointerId && !press.captured) {
        press = null;
        freeform.busy = false;
      }
    };

    /* Framing the boat under the pointer, which is the one camera action worth
     * a shortcut on the water itself. A double click on open water is two
     * ordinary misses and does nothing the first one did not. */
    const onDouble = (event: MouseEvent) => {
      const replay = useReplay.getState();
      if (replay.chart2d) return;
      const hit = pickAt(event.clientX, event.clientY);
      if (hit === null) return;
      replay.follow(hit);
      freeform.pending = "selected";
      if (replay.rig !== "freeform") replay.setRig("freeform");
      requestSceneFrame();
    };

    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onCancel);
    node.addEventListener("lostpointercapture", onLostCapture);
    node.addEventListener("pointerleave", onLeave);
    node.addEventListener("dblclick", onDouble);

    return () => {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onCancel);
      node.removeEventListener("lostpointercapture", onLostCapture);
      node.removeEventListener("pointerleave", onLeave);
      node.removeEventListener("dblclick", onDouble);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      press = null;
      endTouchSession();
      setPointerHover(null);
    };
  }, [target, live, zoomable]);
}

/**
 * The wheel, which only belongs to the camera once the visitor has asked for
 * the camera. Both Layline pages put the replay inside a scrolling document,
 * so a wheel handler that were always live would take the page's scroll away
 * from every visitor who never touched the camera at all. Registered only
 * while the freeform rig is up, and removed with it.
 */
export function useWheelZoom(target: RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const node = target.current;
    if (node === null || !active) return;
    const onWheel = (event: WheelEvent) => {
      if (useReplay.getState().chart2d) return;
      event.preventDefault();
      /* Lines and pages are reported by some mice and every trackpad reports
       * pixels; the two are brought to the same scale before the zoom sees
       * them. A pinch on a trackpad arrives here as a wheel with ctrl held,
       * which is the gesture people already zoom with. */
      const step =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * 400
            : event.deltaY;
      zoom(freeform, step);
      requestSceneFrame();
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [target, active]);
}

/* What owns the space bar itself. A button is activated by it, a field types
 * with it, a slider pages with it, and a disclosure opens with it; none of them
 * are asking the replay for anything. Matched as an ancestor rather than as a
 * tag, because the press usually lands on a span inside the control. */
const OWNS_SPACE =
  "input, textarea, select, button, a[href], summary, details, [role=slider], [role=button], [role=switch], [role=tab], [contenteditable=true]";

/**
 * Space is play and pause, wherever the visitor is looking at the replay.
 *
 * The canvas cannot hold focus and should not: it has no keyboard interface of
 * its own, and every camera action has a real button in the transport. So the
 * key is read at the window and gated on the one honest question, whether the
 * replay is actually in the viewport. That is the observer with no margin, not
 * the one the renderer prewarms with: a replay two hundred pixels below the
 * fold is worth a frame in hand and is not worth the visitor's scroll.
 */
export function useSpaceToggle(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!sceneGate.inView) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && typeof target.closest === "function") {
        if (target.isContentEditable) return;
        if (target.closest(OWNS_SPACE) !== null) return;
      }
      event.preventDefault();
      useReplay.getState().toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
