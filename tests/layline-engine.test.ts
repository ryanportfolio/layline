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
import { poseAt, standingsAt } from "../src/lib/layline/interpolate";
import { generateRace } from "../src/lib/layline/sim";
import { FIX_HZ, RACE_SEED } from "../src/lib/layline/types";
import type { Pose } from "../src/lib/layline/types";

const race = generateRace(RACE_SEED);

function blankPose(): Pose {
  return { x: 0, y: 0, sog: 0, cog: 0, hdg: 0, heel: 0, twa: 0, kite: 0 };
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
  assert.equal(race.tMax, 63.25);
  assert.deepEqual(
    race.boats.map((b) => b.id),
    ["fra", "usa", "gbr", "nzl", "aus", "jpn"],
  );
  assert.deepEqual(
    race.results.map((r) => `${r.boatId}:${r.rank}:${r.elapsed}`),
    ["usa:1:51.525", "jpn:2:52.942", "gbr:3:55.156", "nzl:4:56.965", "aus:5:57.002", "fra:6:57.491"],
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(race.fixes).map(([id, f]) => [id, f.length])),
    { fra: 294, usa: 271, gbr: 285, nzl: 292, aus: 293, jpn: 276 },
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
      assert.ok(Math.abs(out.sog - fix.sog) < 1e-9, `${id} sog at t=${fix.t}`);
      assert.ok(Math.abs(out.hdg - fix.hdg) < 1e-9, `${id} hdg at t=${fix.t}`);
    }
  }
});

test("heading crosses the 359/0 seam the short way", () => {
  /* fra fixes 76 and 77 read 356.642 then 3.642: seven degrees apart across
   * north, 353 apart as plain numbers. The midpoint must sit inside the short
   * arc, nowhere near the 180 a naive lerp would sweep through. */
  const fixes = race.fixes.fra;
  const a = fixes[76];
  const b = fixes[77];
  assert.ok(Math.abs(b.hdg - a.hdg) > 300, "the seam pair moved; re-pin the index");
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
  assert.equal(gap({ rank: 3, leg: "run", gapSeconds: 2.6 }), "+3 s");
});
