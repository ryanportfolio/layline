'use client';

import { useLayoutEffect, useRef } from 'react';
import { afterIntroHold } from '@/lib/introHold';

/* ============================================================================
   RAIL LOGO — the mark. A long shed half-drawn, half-poured: the left bay is
   still pencil linework under its dimension string; the right bay is poured
   solid. Idea → shipped in one glyph, living in the rail's upper reach.

   Draws itself on load, but only after the masthead wordmark settles (one
   instrument, one hand — same gate the cover uses). Reduced motion, JS-off,
   and SSR all get the finished mark — the same floor rule as every sheet.
   Values tuned in the logo lab (2026-07-21): 96px, 2.7px stroke, 2400ms
   draw, 60ms stagger, no tilt.
   ========================================================================= */

const STROKE_W = 2.7; // px, non-scaling
const DRAW_DUR = 2400; // ms per stroke
const DRAW_STAGGER = 60; // ms between stroke starts

// [path, stroke-width multiplier] — authored draw order
const STROKES: Array<[string, number]> = [
  ['M4 82 H96', 0.9], // ground
  ['M16 82 V46 L34 30 L52 46 V82', 1], // drawn bay: gable outline
  ['M52 46 H84 V82', 1], // poured bay: walls
  ['M52 46 L70 30 L84 44', 1], // poured bay: roof
  ['M22 78 l14 -14 M22 68 l12 -12 M22 58 l8 -8', 0.5], // pencil hatch, still drawing
  ['M16 24 V88 M8 40 H60', 0.4], // dimension string over the drawn half
];
const POUR = 'M52 46 H84 V82 H52 Z'; // the poured solid, fades in last

export default function RailLogo({ className }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return; // finished mark stands, no motion

    const strokes = Array.from(svg.querySelectorAll<SVGPathElement>('path[data-stroke]'));
    const pour = svg.querySelector<SVGPathElement>('path[data-pour]');
    if (!strokes.length || !pour) return;

    // The mark ships drawn (no-JS floor), so the pre-paint CSS hold in
    // globals.css covers it until this effect owns the hidden state; arming the
    // svg in the same frame releases the hold with no flash of the finished mark.
    // visibility carries the wait, NOT the dash alone: Firefox mis-renders a
    // dasharray against pathLength=1 on multi-subpath paths at any offset (the
    // hatch and the dimension string both are), leaking stray fragments while
    // the mark waited for the wordmark to settle.
    strokes.forEach((p) => {
      p.style.transition = 'none';
      p.style.visibility = 'hidden';
      p.style.strokeDasharray = '1';
      p.style.strokeDashoffset = '1';
    });
    pour.style.transition = 'none';
    pour.style.opacity = '0';
    svg.setAttribute('data-ws-armed', '');

    let timer = 0;
    let settleTimer = 0;
    let begun = false;
    const begin = () => {
      if (begun) return;
      begun = true;
      window.removeEventListener('ws:plot-settled', begin);
      window.clearTimeout(timer);
      svg.getBoundingClientRect(); // flush the hidden state
      strokes.forEach((p, i) => {
        // visibility is discretely transitionable, so each stroke's nib comes
        // down exactly on its own stagger beat — never visible-but-undrawn.
        p.style.transition = `stroke-dashoffset ${DRAW_DUR}ms cubic-bezier(0.22,0.61,0.36,1) ${i * DRAW_STAGGER}ms, visibility 0s ${i * DRAW_STAGGER}ms`;
        p.style.visibility = 'visible';
        p.style.strokeDashoffset = '0';
      });
      pour.style.transition = `opacity ${DRAW_DUR}ms ease ${strokes.length * DRAW_STAGGER}ms`;
      pour.style.opacity = '1';
      // A FINISHED STROKE CARRIES NO DASH. Firefox mis-renders a lingering
      // dasharray against pathLength=1 on multi-subpath paths even at
      // dashoffset 0 (the hatch and the dimension string here both are), so
      // once the last transition lands the rig comes off and the finished
      // mark stands as plain paths — the same state teardown leaves behind.
      settleTimer = window.setTimeout(
        () => {
          strokes.forEach((p) => {
            p.style.transition = 'none';
            p.style.visibility = '';
            p.style.strokeDasharray = '';
            p.style.strokeDashoffset = '';
          });
        },
        DRAW_DUR + (strokes.length - 1) * DRAW_STAGGER + 100,
      );
    };

    // One hand: wait for the wordmark plot (latched flag covers late mount);
    // fallback keeps the mark drawing even if the plot never signals. The
    // fallback's clock starts when the intro overlay lets the page go rather
    // than at mount: the plot is held behind the intro on purpose, and a
    // fallback measured from mount would mistake that hold for a failure and
    // draw the mark behind the curtain. Unheld, this is synchronous and the
    // timer is armed exactly as before.
    let unhold: (() => void) | null = null;
    if ((window as unknown as { __plotSettled?: boolean }).__plotSettled) begin();
    else {
      window.addEventListener('ws:plot-settled', begin);
      unhold = afterIntroHold(() => {
        unhold = null;
        if (begun) return;
        timer = window.setTimeout(begin, 2600);
      });
    }

    return () => {
      unhold?.();
      window.removeEventListener('ws:plot-settled', begin);
      window.clearTimeout(timer);
      window.clearTimeout(settleTimer);
      // teardown mid-draw → leave the finished mark
      strokes.forEach((p) => {
        p.style.transition = 'none';
        p.style.visibility = '';
        p.style.strokeDasharray = '';
        p.style.strokeDashoffset = '';
      });
      pour.style.transition = 'none';
      pour.style.opacity = '';
    };
  }, []);

  return (
    <svg ref={ref} className={className} viewBox="0 0 100 100" aria-hidden="true" data-draw-hold>
      {STROKES.map(([d, wm], i) => (
        <path
          key={i}
          d={d}
          data-stroke=""
          pathLength={1}
          fill="none"
          stroke="currentColor"
          strokeWidth={(STROKE_W * wm).toFixed(2)}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path d={POUR} data-pour="" fill="currentColor" stroke="none" />
    </svg>
  );
}
