/**
 * The wake the render gate hands to a held canvas.
 *
 * The gate stops the drawing rather than the loop, so a paused, 2D or
 * scrolled-away page reads a changed measurement on the frame that was coming
 * anyway. A capture hold has no such frame: R3F ignores invalidate() at
 * frameloop "never", and the only way in is to advance the renderer through the
 * door the hold installs. Both failures that reaches are one animation frame
 * wide, which no browser probe can time, so the module is driven directly here.
 *
 * Run: npx --yes tsx --test tests/layline-gate.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  requestSceneFrame,
  resetSceneGate,
  sceneGate,
  setFrozenFrameRequest,
} from "../src/components/layline/scene/gate";

/* The module reads requestAnimationFrame when it is called rather than when it
 * is loaded, so a plain import is enough and the stubs below are in place long
 * before the first test asks for a frame. */
const queued = new Map<number, FrameRequestCallback>();
let next = 1;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
  const id = next++;
  queued.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id: number): void => {
  queued.delete(id);
};

/** Runs whatever the gate is waiting on, the way a frame would. */
function frame(): void {
  const run = [...queued.values()];
  queued.clear();
  for (const callback of run) callback(0);
}

beforeEach(() => {
  queued.clear();
  setFrozenFrameRequest(null);
  resetSceneGate();
});

test("one layout change is one wake, however many observers measure it", () => {
  let drawn = 0;
  setFrozenFrameRequest(() => {
    drawn++;
  });
  /* The canvas box, the dock band and the rig framing are three observers
   * reading one resize. Drawing on each would put the first frame up against
   * measurements the other two had not taken yet. */
  requestSceneFrame();
  requestSceneFrame();
  requestSceneFrame();
  frame();
  assert.equal(drawn, 1);

  frame();
  assert.equal(drawn, 1, "nothing may be left queued behind the wake");
});

test("a wake belongs to the hold that asked for it", () => {
  let stale = 0;
  let live = 0;
  setFrozenFrameRequest(() => {
    stale++;
  });
  requestSceneFrame();
  /* Thawing and freezing again, or leaving the route and coming back, installs
   * a different door. A frame still waiting on the old one would land in the
   * new hold as a frame nobody asked for, and a capture counting frames per
   * action would read it as its own. */
  setFrozenFrameRequest(null);
  setFrozenFrameRequest(() => {
    live++;
  });
  frame();
  assert.equal(stale, 0);
  assert.equal(live, 0);

  requestSceneFrame();
  frame();
  assert.equal(live, 1, "the new hold still gets the wakes it asks for");
});

test("a page that is drawing is marked dirty and asks for nothing", () => {
  sceneGate.dirty = false;
  requestSceneFrame();
  assert.equal(sceneGate.dirty, true);
  assert.equal(queued.size, 0, "no hold, no frame to ask for");
});

test("the gate opens ready to draw", () => {
  sceneGate.dirty = false;
  sceneGate.contextLost = true;
  sceneGate.onScreen = false;
  sceneGate.chase = 4;
  sceneGate.bufferWidth = 1234;
  resetSceneGate();
  assert.equal(sceneGate.dirty, true, "there is no first frame yet");
  assert.equal(sceneGate.contextLost, false);
  assert.equal(sceneGate.onScreen, true, "before the observer has said anything");
  assert.equal(sceneGate.chase, 0);
  assert.equal(sceneGate.bufferWidth, 0);
});
