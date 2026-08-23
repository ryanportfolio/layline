/* ============================================================================
   THE ENTRANCE GATE. The homepage's opening motion waits for the intro.

   The page has an opening act of its own: the wordmark plots under a pen, the
   pipeline letters itself, the rail mark draws, the carriage works the cover.
   All four hang off one signal, `ws:plot-settled`, and that signal used to fire
   about a second and a half into the load, roughly four seconds before the
   intro overlay finished and lifted. The whole entrance therefore ran, start to
   finish, behind an opaque curtain, and the reader arrived at a page that was
   already over.

   So the entrance holds. The pre-paint script in layout.tsx latches
   `window.__introHold` in the same breath it raises the cover, every consumer
   below asks this module when to start its clock, and the overlay lifts the
   hold a beat BEFORE it goes, mid settle-crossfade, so the reveal shows a page
   already in motion rather than a page that starts once the veil is gone.

   WHY A WINDOW LATCH AND AN EVENT rather than a React context or a prop: the
   holders live in three separate chunks that mount in an order nobody controls,
   and the hold has to exist before any of them do. It is the same shape the set
   already uses for `__plotSettled`, `__coverDrawn` and `__plotGuard`, and it
   costs the entrance chunk nothing but this file.

   FAILING OPEN IS THE WHOLE CONTRACT. Every path that can decide the intro is
   not going to run calls `releaseIntroHold`, and the pre-paint script's own 4s
   guard calls it too. Reduced motion never sets the latch in the first place,
   and a no-JS reader never runs any of this. There is no state in which the
   page's opening is waiting on a signal that cannot arrive.
   ========================================================================= */

/* One name, spelled once. The pre-paint script carries a literal copy of it
   because it runs before any module does; the test suite pins the pair. */
export const INTRO_HOLD_EVENT = 'ws:intro-entrance';

type HoldWindow = Window & {
  __introHold?: boolean;
};

/** Is the page's opening currently held behind the intro overlay? */
export function introHoldActive(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window as HoldWindow).__introHold;
}

/**
 * Run `fn` when the intro lets the page go, or right now, synchronously, when
 * nothing is holding it. Returns an unsubscribe for the caller's teardown.
 *
 * Synchronous when unheld is deliberate: it means a consumer can route its
 * normal path through this function without gaining a frame of latency on the
 * pages and preferences where no intro exists.
 */
export function afterIntroHold(fn: () => void): () => void {
  if (!introHoldActive()) {
    fn();
    return () => {};
  }
  let live = true;
  const go = () => {
    if (!live) return;
    live = false;
    window.removeEventListener(INTRO_HOLD_EVENT, go);
    fn();
  };
  window.addEventListener(INTRO_HOLD_EVENT, go);
  return () => {
    live = false;
    window.removeEventListener(INTRO_HOLD_EVENT, go);
  };
}

/**
 * Let the page go. Idempotent, and safe to call from anywhere that has decided
 * the intro is not going to run: an unheld page is already released.
 */
export function releaseIntroHold(): void {
  if (typeof window === 'undefined') return;
  const w = window as HoldWindow;
  if (!w.__introHold) return;
  w.__introHold = false;
  window.dispatchEvent(new Event(INTRO_HOLD_EVENT));
}
