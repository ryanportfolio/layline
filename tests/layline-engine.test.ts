/**
 * Layline pure core: sim determinism, the evaluator, the display edge.
 * Run: npx --yes tsx --test tests/layline-engine.test.ts
 * (tsx, not node: the repo's .mjs prototype tests cannot import TypeScript.)
 *
 * The golden numbers below are pinned from RACE_SEED 20280726. If the sim or
 * the evaluator changes on purpose, re-pin them in the same commit and say so;
 * if they move without a sim change, something upstream broke determinism.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { clock, deg, gap, knots, MISSING } from "../src/lib/layline/format";
import { boomAngle } from "../src/components/layline/scene/skiff";
import { clothCamber, clothSide } from "../src/components/layline/scene/trim";
import { maneuversOf } from "../src/lib/layline/analytics";
import { createPose, poseAt, standingsAt } from "../src/lib/layline/interpolate";
import { generateRace } from "../src/lib/layline/sim";
import { velocityFromComponents } from "../src/lib/layline/velocity";
import { FIX_HZ, RACE_SEED } from "../src/lib/layline/types";
import type { Pose } from "../src/lib/layline/types";

const race = generateRace(RACE_SEED);

function blankPose(): Pose {
  return createPose();
}

function arcDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

test("one seed, one race: a second run is byte-identical", () => {
  assert.equal(JSON.stringify(generateRace(RACE_SEED)), JSON.stringify(race));
});

test("golden seed summary holds", () => {
  assert.equal(race.tMin, -10);
  assert.equal(race.tMax, 64.75);
  assert.deepEqual(
    race.boats.map((b) => b.id),
    ["fra", "usa", "gbr", "nzl", "aus", "jpn"],
  );
  assert.deepEqual(
    race.results.map((r) => `${r.boatId}:${r.rank}:${r.elapsed}`),
    ["jpn:1:50.138", "fra:2:53.081", "nzl:3:54.593", "gbr:4:56.592", "usa:5:57.97", "aus:6:58.715"],
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(race.fixes).map(([id, f]) => [id, f.length])),
    { fra: 277, usa: 297, gbr: 291, nzl: 283, aus: 300, jpn: 265 },
  );
});

test("poseAt lands exactly on every fix it is asked for", () => {
  const out = blankPose();
  for (const [id, fixes] of Object.entries(race.fixes)) {
    for (let i = 0; i < fixes.length; i += 25) {
      const fix = fixes[i];
      poseAt(race, id, fix.t, "smooth", out);
      assert.ok(Math.abs(out.x - fix.x) < 1e-9, `${id} x at t=${fix.t}`);
      assert.ok(Math.abs(out.y - fix.y) < 1e-9, `${id} y at t=${fix.t}`);
      const velocity = velocityFromComponents(
        fix.waterX,
        fix.waterY,
        fix.currentX,
        fix.currentY,
        {},
      );
      assert.ok(Math.abs(out.sog - velocity.sog) < 1e-9, `${id} sog at t=${fix.t}`);
      assert.ok(Math.abs(out.hdg - fix.hdg) < 1e-9, `${id} hdg at t=${fix.t}`);
    }
  }
});

test("heading crosses the 359/0 seam the short way", () => {
  /* fra fixes 76 and 77 read 356.642 then 3.642: seven degrees apart across
   * north, 353 apart as plain numbers. The midpoint must sit inside the short
   * arc, nowhere near the 180 a naive lerp would sweep through. */
  const fixes = race.fixes.fra;
  const index = fixes.findIndex((fix, at) => at > 0 && Math.abs(fix.hdg - fixes[at - 1].hdg) > 300);
  assert.ok(index > 0, "the race lost its north-crossing witness");
  const a = fixes[index - 1];
  const b = fixes[index];
  const out = blankPose();
  poseAt(race, "fra", (a.t + b.t) / 2, "smooth", out);
  assert.ok(Math.abs(arcDeg(a.hdg, out.hdg)) <= 15, `mid hdg ${out.hdg} left the short arc`);
});

test("interpolated turn rate never beats a hull", () => {
  /* The engine caps angular tangents at 60 deg/s. Sample the whole race at
   * 60 Hz: an interpolation regression to plain differences would spike to
   * hundreds of deg/s at the wrap seam and every tack. */
  const out = blankPose();
  let worst = 0;
  for (const [id, fixes] of Object.entries(race.fixes)) {
    let prev: number | null = null;
    for (let t = fixes[0].t; t <= fixes[fixes.length - 1].t; t += 1 / 60) {
      poseAt(race, id, t, "smooth", out);
      if (prev !== null) {
        const rate = Math.abs(arcDeg(prev, out.hdg)) * 60;
        if (rate > worst) worst = rate;
      }
      prev = out.hdg;
    }
  }
  assert.ok(worst <= 60.5, `sampled ${worst.toFixed(1)} deg/s`);
});

test("the kite channel stays inside 0..1", () => {
  const out = blankPose();
  for (const [id, fixes] of Object.entries(race.fixes)) {
    for (let t = fixes[0].t; t <= fixes[fixes.length - 1].t; t += 0.05) {
      poseAt(race, id, t, "smooth", out);
      assert.ok(out.kite >= -1e-9 && out.kite <= 1 + 1e-9, `${id} kite ${out.kite} at t=${t}`);
    }
  }
});

test("raw mode holds the fix, never invents motion", () => {
  const fixes = race.fixes.nzl;
  const out = blankPose();
  const a = fixes[120];
  poseAt(race, "nzl", a.t + 0.5 / FIX_HZ, "raw", out);
  assert.equal(out.x, a.x);
  assert.equal(out.hdg, a.hdg);
});

test("standings at the end of the feed match the finish order", () => {
  const rows = standingsAt(race, race.tMax);
  assert.deepEqual(
    rows.map((row) => `${row.boatId}:${row.rank}:${row.finished}`),
    race.results.map((r) => `${r.boatId}:${r.rank}:true`),
  );
});

test("display edge: knots never prints -0.0 and bearings never print 360", () => {
  assert.equal(knots(-1e-12), "0.0");
  assert.equal(knots(Number.NaN), MISSING);
  assert.equal(deg(359.6), "0");
  assert.equal(deg(-0.2), "0");
});

test("display edge: the prestart clock counts down, the gap column stays honest", () => {
  assert.equal(clock(-0.4), "-0:01");
  assert.equal(clock(0), "0:00");
  assert.equal(clock(65.9), "1:05");
  assert.equal(gap({ rank: 3, leg: "prestart", gapSeconds: 4 }), MISSING);
  assert.equal(gap({ rank: 1, leg: "beat", gapSeconds: 0 }), "LDR");
  /* Tenths under ten seconds: a fleet inside half a second of itself has to
   * read as six different boats, not six copies of "+0 s". */
  assert.equal(gap({ rank: 3, leg: "run", gapSeconds: 2.6 }), "+2.6 s");
  assert.equal(gap({ rank: 2, leg: "beat", gapSeconds: 0.061 }), "+0.1 s");
  assert.equal(gap({ rank: 4, leg: "beat", gapSeconds: 0.469 }), "+0.5 s");
  assert.equal(gap({ rank: 5, leg: "run", gapSeconds: -1e-12 }), "+0.0 s");
  /* Ten up reads whole, and the rounding decides the branch, so 9.97 cannot
   * print itself as a ten with a tenth on it. */
  assert.equal(gap({ rank: 6, leg: "run", gapSeconds: 9.94 }), "+9.9 s");
  assert.equal(gap({ rank: 6, leg: "run", gapSeconds: 9.97 }), "+10 s");
  assert.equal(gap({ rank: 6, leg: "run", gapSeconds: 42.4 }), "+42 s");
});

/* The rig. Which side the cloth is on is a decision the scene makes, not a
 * channel in the feed, and it is the one place a continuous replay used to
 * teleport: the leeward side is the sign of the wind angle and a sign changes
 * on one frame. */

function leeSign(twa: number): number {
  return twa >= 0 ? -1 : 1;
}

test("the cloth changes sides once per manoeuvre and nowhere else", () => {
  let swings = 0;
  for (const id of Object.keys(race.fixes)) {
    let prev = Math.sign(clothSide(race, id, race.tMin));
    for (let t = race.tMin; t <= race.tMax; t += 0.025) {
      const here = Math.sign(clothSide(race, id, t));
      if (here !== 0 && here !== prev) swings++;
      if (here !== 0) prev = here;
    }
  }
  /* Twelve tacks on the beat and eight gybes on the run, which is every sign
   * change in the current seeded fleet's wind angle and no others. */
  const maneuvers = race.boats.reduce(
    (count, boat) => count + maneuversOf(race, boat.id).length,
    0,
  );
  assert.equal(maneuvers, 22);
  assert.equal(swings, 22);
  assert.equal(swings, maneuvers);
});

test("the rig swings across a manoeuvre instead of teleporting", () => {
  /* Sheeted on the centreline the boom sits 5 deg off, squared off on a run it
   * sits at 85, so the old sign flip moved it 170 deg between two frames. */
  const out = blankPose();
  let worst = 0;
  for (const id of Object.keys(race.fixes)) {
    let prev: number | null = null;
    for (let t = race.tMin; t <= race.tMax; t += 0.025) {
      poseAt(race, id, t, "smooth", out);
      const boom = clothSide(race, id, t) * boomAngle(out.twa);
      if (prev !== null) worst = Math.max(worst, Math.abs(boom - prev));
      prev = boom;
    }
  }
  assert.ok(worst < 10, `boom moved ${worst.toFixed(2)} deg between two frames`);
});

test("outside a manoeuvre the rig is exactly where the sign test put it", () => {
  /* The swing is the only thing that changed, so every frame that is not
   * inside one has to draw what it drew before: the cloth hard on one side
   * with all of its draft in it. */
  const out = blankPose();
  let checked = 0;
  for (const id of Object.keys(race.fixes)) {
    for (let t = race.tMin; t <= race.tMax; t += 0.05) {
      const side = clothSide(race, id, t);
      if (Math.abs(side) !== 1) continue;
      poseAt(race, id, t, "smooth", out);
      assert.equal(side, leeSign(out.twa), `${id} at t=${t.toFixed(2)}`);
      assert.equal(clothCamber(side), 1);
      checked++;
    }
  }
  assert.ok(checked > 7000, `only ${checked} frames sat outside a manoeuvre`);
});

test("the two cut sides of a sail meet with no draft in either", () => {
  /* The mirrored shape is a second geometry, and the swap between them is only
   * free where both are flat. Camber has to reach zero at the crossing and the
   * side has to pass through it, or the pop comes back at half the size. */
  assert.equal(clothCamber(0), 0);
  assert.equal(clothCamber(1), 1);
  assert.equal(clothCamber(-1), 1);
  let crossings = 0;
  for (const id of Object.keys(race.fixes)) {
    let prev = clothSide(race, id, race.tMin);
    for (let t = race.tMin; t <= race.tMax; t += 0.001) {
      const side = clothSide(race, id, t);
      if (prev < 0 !== side < 0) {
        assert.ok(Math.abs(side) < 0.02, `${id} jumped to ${side} at t=${t.toFixed(3)}`);
        crossings++;
      }
      prev = side;
    }
  }
  assert.equal(crossings, 22);
});
