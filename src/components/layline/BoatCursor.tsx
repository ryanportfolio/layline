"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { BoatMark } from "./BoatMark";
import styles from "./BoatCursor.module.css";

/* The pointer over the water is the house boat, twice the size it is as a
 * bullet in the notes. A cursor image cannot animate, so this is a real
 * element chasing the pointer with the native one turned off underneath it:
 * the wake keeps running the way it does in the lists.
 *
 * Mouse only. A touch has no hover state to draw a pointer for, and a pen
 * already has a tip on the glass; both leave the native cursor alone. */

/* The glyph box, and the point in it the pointer actually reports: the bow, so
 * the boat sails at what it is picking out rather than sitting on top of it. */
const WIDTH = 84;
const HEIGHT = 48;
const BOW_X = 78;
const BOW_Y = 30;

export function BoatCursor({ targetRef }: { targetRef: RefObject<HTMLDivElement | null> }) {
  const boatRef = useRef<HTMLDivElement | null>(null);
  /* The listener reads this rather than `shown`: the effect runs once, so the
   * state value it closed over would still be false on every later move. */
  const shownRef = useRef(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (target === null) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    let frame = 0;
    let pending: { x: number; y: number } | null = null;

    /* One write per frame. A pointermove burst on a 240Hz mouse would
     * otherwise lay down a transform per event, all but the last of them
     * thrown away before the compositor ever sees it. */
    const flush = () => {
      frame = 0;
      const next = pending;
      const boat = boatRef.current;
      if (next === null || boat === null) return;
      boat.style.transform = `translate3d(${next.x - BOW_X}px, ${next.y - BOW_Y}px, 0)`;
    };

    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const box = target.getBoundingClientRect();
      pending = { x: event.clientX - box.left, y: event.clientY - box.top };
      /* First position before the first paint, so the boat never shows up at
       * the origin on its way to the pointer. */
      if (!shownRef.current) {
        flush();
        shownRef.current = true;
        setShown(true);
        target.dataset.boatCursor = "on";
        return;
      }
      if (frame === 0) frame = window.requestAnimationFrame(flush);
    };

    const leave = () => {
      pending = null;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      shownRef.current = false;
      setShown(false);
      delete target.dataset.boatCursor;
    };

    target.addEventListener("pointermove", move);
    target.addEventListener("pointerleave", leave);
    /* A drag that ends off the layer, and a tab switch mid-hover, both leave
     * the boat parked on the water with no pointer under it. */
    window.addEventListener("blur", leave);

    return () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      delete target.dataset.boatCursor;
    };
  }, [targetRef]);

  return (
    <div className={styles.layer} aria-hidden="true">
      <div
        ref={boatRef}
        className={shown ? `${styles.boat} ${styles.boatShown}` : styles.boat}
        style={{ width: WIDTH, height: HEIGHT }}
      >
        <BoatMark className={styles.mark} outlined />
      </div>
    </div>
  );
}
