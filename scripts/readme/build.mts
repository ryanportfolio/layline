/**
 * README build: facts from the sim, panels from the facts, README from both,
 * then verification. Any mismatch exits non-zero; CI runs this and fails the
 * build if the committed README drifts from what the repo would generate.
 * Run: npm run readme
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeFacts } from "./facts.mts";
import { buildPanels } from "./panels.mts";
import { buildReadme, verifyReadme } from "./readme.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let bad = 0;
const fail = (msg: string) => {
  console.error(`FAIL ${msg}`);
  bad += 1;
};

console.error("-> facts (recomputed from the sim and the test files)");
const facts = computeFacts();

console.error("-> panels (light, dark and narrow variants, drawn from the facts)");
const panels = buildPanels(facts);

/* Every number a panel shows is recomputed here and matched against the SVG
 * text. A panel that outlives its data fails the build, not the reader. */
const NEED: Record<string, string[]> = {
  "course-light": [
    `SEED ${facts.seed}`,
    `${facts.fixesTotal} FIXES`,
    ...facts.order.map((b) => b.clock),
  ],
  "course-narrow-light": [`SEED ${facts.seed}`, `${facts.fixesTotal} FIXES`],
  "hermite-light": [`${facts.hermite.fixes.length} FIXES`, `${facts.hermite.to - facts.hermite.from} S`],
  "debrief-light": [
    facts.debrief.question,
    facts.debrief.status,
    `${facts.debrief.tool}()`,
    `${facts.debrief.tools.length} TOOLS`,
    ...facts.debrief.start.map((row) => row.sail),
    ...facts.debrief.start.map((row) => row.afterGunText),
    ...facts.debrief.start.map((row) => row.shortText),
  ],
  "debrief-narrow-light": [facts.debrief.question, facts.debrief.status],
};
for (const [file, needles] of Object.entries(NEED)) {
  const text = fs.readFileSync(path.join(ROOT, "assets", `${file}.svg`), "utf8");
  for (const needle of needles) {
    if (!text.includes(needle)) fail(`${file}.svg should carry "${needle}"`);
  }
}
const tracks = fs
  .readFileSync(path.join(ROOT, "assets", "course-light.svg"), "utf8")
  .match(/class="track"/g);
if ((tracks?.length ?? 0) !== facts.boats) {
  fail(`course-light.svg draws ${tracks?.length ?? 0} tracks for ${facts.boats} boats`);
}

/* The clip and its poster are recorded by hand, so the build cannot rebuild
 * them; it can refuse to ship a README that points at a missing one. */
for (const asset of ["assets/video/debrief.webm", "assets/img/debrief-loop.webp"]) {
  const full = path.join(ROOT, asset);
  if (!fs.existsSync(full)) fail(`${asset} is missing`);
  else if (fs.statSync(full).size < 20_000) fail(`${asset} is too small to be the real capture`);
}

console.error("-> README.md");
const md = buildReadme(facts);
for (const problem of verifyReadme(md, facts)) fail(problem);

/* The public gate: nothing about where this repo gets shown belongs inside
 * it. The words are stored reversed so this scanner never trips on itself. */
const BANNED = ["sorakav", "weivretni", "retiurcer", "gnirih", "da boj", "ffodnah"].map((w) =>
  w.split("").reverse().join(""),
);
const scan = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", ".next", ".tmp"].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(p);
    else if (/\.(ts|tsx|mts|css|md|json|mjs|svg)$/.test(entry.name)) {
      const text = fs.readFileSync(p, "utf8").toLowerCase();
      for (const word of BANNED) {
        if (text.includes(word)) fail(`banned word "${word}" in ${path.relative(ROOT, p)}`);
      }
    }
  }
};
scan(ROOT);
const mdLower = md.toLowerCase();
for (const word of BANNED) if (mdLower.includes(word)) fail(`banned word "${word}" in README`);

if (bad > 0) {
  console.error(`\n${bad} problem${bad === 1 ? "" : "s"}; README not written`);
  process.exit(1);
}
fs.writeFileSync(path.join(ROOT, "README.md"), md);
console.error(`ok: README.md and ${panels.length} panel variants written, all facts verified`);
