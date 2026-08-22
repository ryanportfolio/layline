/**
 * How much of the bottom of the canvas the console covers, in the pixels the
 * rasteriser counts in.
 *
 * The panel ground is 0.86 opaque, so a graphic run under the transport is not
 * hidden by it: the fourteen percent that transmits is enough for a hue track or
 * a layline to paint a coloured band across the leg labels, the rounding ticks
 * and the playhead. The line work fades out above the panel instead, and the
 * shaders need to know where above is.
 *
 * Measured off the layout rather than off the stylesheet's numbers, because at
 * the narrow width the panels leave the canvas and stack under it, where they
 * cover nothing and the water is free all the way down.
 */
export const dockBand = { pixels: 0 };

export function watchDockBand(canvas: HTMLCanvasElement): () => void {
  const panel = document.querySelector('[data-dock="transport"]');
  const measure = (): void => {
    if (panel === null) {
      dockBand.pixels = 0;
      return;
    }
    const frame = canvas.getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    if (frame.height < 1 || rect.height < 1) {
      dockBand.pixels = 0;
      return;
    }
    const covered = Math.min(frame.bottom - rect.top, frame.height);
    dockBand.pixels = Math.max(0, covered) * (canvas.height / frame.height);
  };
  measure();
  const watch = new ResizeObserver(measure);
  watch.observe(canvas);
  if (panel !== null) watch.observe(panel);
  return () => {
    watch.disconnect();
    dockBand.pixels = 0;
  };
}
