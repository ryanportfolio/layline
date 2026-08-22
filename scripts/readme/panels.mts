/**
 * Step 2: the SVG panels, drawn from the facts and nothing else.
 *
 * Constraint contract for this art, binding on every edit:
 * - Every mark on these panels is computed from generateRace(RACE_SEED) at
 *   build time. Dots are real fixes, tracks are real evaluator output, the
 *   layline angle is measured from the beat, the finish clocks are the sim's.
 *   Nothing is typed in; the verify step in build.mts counts it.
 * - Four variants per panel (light, dark, narrow-light, narrow-dark); narrow
 *   is a different composition, not a scale-down.
 * - It has to read at 390 px, on both themes, with no scripts, no hover and
 *   no external requests. Motion loops, and prefers-reduced-motion restores
 *   the drawn end state, not the blank start.
 * - Accent roles: amber is the wind's family (laylines, tangents), violet is
 *   the raw fix family, boat hues mean boat identity only. GBR's near-white
 *   hue cannot hold on the light theme and swaps to a slate stand-in there.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Facts, TrackPoint } from "./facts.mts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "assets");

const MONO =
  "ui-monospace,'SF Mono','Cascadia Mono',Menlo,Consolas,'Liberation Mono',monospace";
const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif";

interface Theme {
  ink: string;
  mute: string;
  rule: string;
  amber: string;
  violet: string;
  hue: (id: string, hex: string) => string;
}

const THEMES: Record<"light" | "dark", Theme> = {
  light: {
    ink: "#1f2328",
    mute: "#59636e",
    rule: "#d1d9e0",
    amber: "#bc4c00",
    violet: "#8250df",
    hue: (id, hex) => (id === "gbr" ? "#8ea3b3" : hex),
  },
  dark: {
    ink: "#f0f6fc",
    mute: "#9198a1",
    rule: "#3d444d",
    amber: "#f0a03c",
    violet: "#b48cff",
    hue: (_id, hex) => hex,
  },
};

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const px = (v: number) => v.toFixed(1);

function svgDoc(w: number, h: number, label: string, css: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
<style>${css}
@media (prefers-reduced-motion:reduce){*{animation:none!important}.track{stroke-dashoffset:0}}
</style>
${body}
</svg>`;
}

/* Course frame to panel frame. Wide panels turn the course a quarter turn so
 * the beat runs across the page; narrow keeps upwind up. */
interface Frame {
  toX: (p: TrackPoint) => number;
  toY: (p: TrackPoint) => number;
}

function frameFor(facts: Facts, region: { x: number; y: number; w: number; h: number }, rotated: boolean): Frame {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const eat = (p: TrackPoint) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };
  for (const boat of facts.order) for (const p of boat.track) eat(p);
  eat(facts.course.startPin);
  eat(facts.course.startBoat);
  eat(facts.course.windward);
  maxY += facts.course.zoneRadius;
  const spanAcross = maxX - minX;
  const spanAlong = maxY - minY;
  if (rotated) {
    const scale = Math.min(region.w / spanAlong, region.h / spanAcross);
    const padX = (region.w - spanAlong * scale) / 2;
    const padY = (region.h - spanAcross * scale) / 2;
    return {
      toX: (p) => region.x + padX + (p.y - minY) * scale,
      toY: (p) => region.y + padY + (p.x - minX) * scale,
    };
  }
  const scale = Math.min(region.w / spanAcross, region.h / spanAlong);
  const padX = (region.w - spanAcross * scale) / 2;
  const padY = (region.h - spanAlong * scale) / 2;
  return {
    toX: (p) => region.x + padX + (p.x - minX) * scale,
    toY: (p) => region.y + region.h - padY - (p.y - minY) * scale,
  };
}

function pathOf(points: TrackPoint[], frame: Frame): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${px(frame.toX(p))} ${px(frame.toY(p))}`)
    .join("");
}

function courseFurniture(facts: Facts, frame: Frame, t: Theme): string {
  const { startPin, startBoat, windward, zoneRadius } = facts.course;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const ray = (sign: 1 | -1) => {
    const len = 70;
    const end = {
      x: windward.x - sign * Math.sin(rad(facts.tackDeg)) * len,
      y: windward.y - Math.cos(rad(facts.tackDeg)) * len,
    };
    return `<line x1="${px(frame.toX(windward))}" y1="${px(frame.toY(windward))}" x2="${px(frame.toX(end))}" y2="${px(frame.toY(end))}" stroke="${t.amber}" stroke-width="1.6" stroke-dasharray="6 5" opacity="0.85"/>`;
  };
  const zoneEdge = { x: windward.x + zoneRadius, y: windward.y };
  const zonePx = Math.abs(frame.toX(zoneEdge) - frame.toX(windward)) || Math.abs(frame.toY(zoneEdge) - frame.toY(windward));
  return [
    `<line x1="${px(frame.toX(startPin))}" y1="${px(frame.toY(startPin))}" x2="${px(frame.toX(startBoat))}" y2="${px(frame.toY(startBoat))}" stroke="${t.mute}" stroke-width="1.6" stroke-dasharray="2 4"/>`,
    `<circle cx="${px(frame.toX(startPin))}" cy="${px(frame.toY(startPin))}" r="3" fill="${t.mute}"/>`,
    `<rect x="${px(frame.toX(startBoat) - 3.5)}" y="${px(frame.toY(startBoat) - 3.5)}" width="7" height="7" fill="${t.mute}"/>`,
    `<circle cx="${px(frame.toX(windward))}" cy="${px(frame.toY(windward))}" r="${px(zonePx)}" fill="none" stroke="${t.rule}" stroke-width="1.2"/>`,
    ray(1),
    ray(-1),
    `<circle cx="${px(frame.toX(windward))}" cy="${px(frame.toY(windward))}" r="4.5" fill="${t.amber}"/>`,
  ].join("\n");
}

function tracks(facts: Facts, frame: Frame, t: Theme, animate: boolean): string {
  return facts.order
    .map((boat) => {
      const anim = animate ? ` class="track" pathLength="1000"` : "";
      return `<path d="${pathOf(boat.track, frame)}" fill="none" stroke="${t.hue(boat.id, boat.hue)}" stroke-width="2"${anim}/>`;
    })
    .join("\n");
}

const TRACK_CSS = `
.track{stroke-dasharray:1000;animation:sail 12s linear infinite}
@keyframes sail{0%{stroke-dashoffset:1000}72%{stroke-dashoffset:0}100%{stroke-dashoffset:0}}`;

function statsLine(facts: Facts): string {
  return `SEED ${facts.seed} · ${facts.boats} BOATS · ${facts.fixHz} HZ · ${facts.fixesTotal} FIXES · ${facts.feedSeconds} S`;
}

function courseWide(facts: Facts, t: Theme): string {
  const W = 880;
  const H = 430;
  const frame = frameFor(facts, { x: 260, y: 36, w: 596, h: 310 }, true);
  const finish = facts.order
    .map((boat) => {
      return `<tspan fill="${t.hue(boat.id, boat.hue)}">●</tspan><tspan fill="${t.mute}"> ${boat.rank} ${esc(boat.sail)} </tspan><tspan fill="${t.ink}">${boat.clock}</tspan><tspan fill="${t.mute}">   </tspan>`;
    })
    .join("");
  const body = `
<text x="24" y="86" font-family="${SANS}" font-size="46" font-weight="700" letter-spacing="10" fill="${t.ink}">LAYLINE</text>
<text x="26" y="116" font-family="${SANS}" font-size="15" fill="${t.mute}">A race replay engine, drawn here</text>
<text x="26" y="136" font-family="${SANS}" font-size="15" fill="${t.mute}">from its own telemetry.</text>
<text x="26" y="188" font-family="${MONO}" font-size="12" fill="${t.mute}">4 Hz fixes in,</text>
<text x="26" y="206" font-family="${MONO}" font-size="12" fill="${t.mute}">60 fps motion out.</text>
${courseFurniture(facts, frame, t)}
${tracks(facts, frame, t, true)}
<text x="24" y="384" font-family="${MONO}" font-size="13" fill="${t.mute}">${esc(statsLine(facts))}</text>
<text x="24" y="410" font-family="${MONO}" font-size="13">${finish}</text>`;
  return svgDoc(
    W,
    H,
    `The Layline racecourse drawn from its own seed: six boat tracks beat to the windward mark inside its laylines and run back to the finish, with the finish order ${facts.order.map((b) => `${b.rank} ${b.sail} ${b.clock}`).join(", ")}.`,
    TRACK_CSS,
    body,
  );
}

function courseNarrow(facts: Facts, t: Theme): string {
  const W = 500;
  const H = 620;
  const frame = frameFor(facts, { x: 40, y: 150, w: 420, h: 400 }, false);
  const body = `
<text x="250" y="64" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="700" letter-spacing="9" fill="${t.ink}">LAYLINE</text>
<text x="250" y="94" text-anchor="middle" font-family="${SANS}" font-size="14" fill="${t.mute}">A race replay engine, drawn here from its own telemetry</text>
${courseFurniture(facts, frame, t)}
${tracks(facts, frame, t, true)}
<text x="250" y="584" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${t.mute}">SEED ${facts.seed} · ${facts.boats} BOATS · ${facts.fixHz} HZ</text>
<text x="250" y="604" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${t.mute}">${facts.fixesTotal} FIXES · ${facts.feedSeconds} S</text>`;
  return svgDoc(
    W,
    H,
    `The Layline racecourse drawn from its own seed: six boat tracks beat to the windward mark inside its laylines and run back to the finish.`,
    TRACK_CSS,
    body,
  );
}

function hermitePanel(facts: Facts, t: Theme, narrow: boolean): string {
  const W = narrow ? 500 : 880;
  const H = narrow ? 330 : 320;
  const from = narrow ? 28 : facts.hermite.from;
  const to = narrow ? 32 : facts.hermite.to;
  const fixes = facts.hermite.fixes.filter((f) => f.t >= from && f.t <= to);
  const curve = facts.hermite.curve.filter(
    (_, i) => facts.hermite.from + i / 20 >= from && facts.hermite.from + i / 20 <= to,
  );
  const region = narrow ? { x: 30, y: 64, w: 440, h: 200 } : { x: 40, y: 58, w: 800, h: 200 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of curve) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const scale = Math.min(region.w / (maxY - minY), region.h / (maxX - minX));
  const padX = (region.w - (maxY - minY) * scale) / 2;
  const padY = (region.h - (maxX - minX) * scale) / 2;
  const toX = (p: TrackPoint) => region.x + padX + (p.y - minY) * scale;
  const toY = (p: TrackPoint) => region.y + padY + (p.x - minX) * scale;

  const curvePath = curve
    .map((p, i) => `${i === 0 ? "M" : "L"}${px(toX(p))} ${px(toY(p))}`)
    .join("");
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const every = narrow ? 3 : 2;
  const arrows = fixes
    .filter((_, i) => i % every === 0)
    .map((f) => {
      const reach = f.sog * 0.6;
      const tip = { x: f.x + reach * Math.sin(rad(f.cog)), y: f.y + reach * Math.cos(rad(f.cog)) };
      const x0 = toX(f);
      const y0 = toY(f);
      const x1 = toX(tip);
      const y1 = toY(tip);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const head = `${px(x1)},${px(y1)} ${px(x1 - 8 * ux + 3.5 * uy)},${px(y1 - 8 * uy - 3.5 * ux)} ${px(x1 - 8 * ux - 3.5 * uy)},${px(y1 - 8 * uy + 3.5 * ux)}`;
      return `<line x1="${px(x0)}" y1="${px(y0)}" x2="${px(x1)}" y2="${px(y1)}" stroke="${t.amber}" stroke-width="1.6"/><polygon points="${head}" fill="${t.amber}"/>`;
    })
    .join("\n");
  const dots = fixes
    .map((f) => `<circle cx="${px(toX(f))}" cy="${px(toY(f))}" r="3.2" fill="${t.violet}"/>`)
    .join("\n");
  const caption = `${fixes.length} FIXES · ${to - from} S · TANGENTS = REPORTED SOG/COG`;
  const body = `
<text x="${narrow ? 30 : 40}" y="34" font-family="${MONO}" font-size="13" letter-spacing="3" fill="${t.mute}">BETWEEN THE FIXES</text>
<path d="${curvePath}" fill="none" stroke="${t.ink}" stroke-width="2" class="track" pathLength="1000"/>
${dots}
${arrows}
<text x="${narrow ? 30 : 40}" y="${H - 18}" font-family="${MONO}" font-size="13" fill="${t.mute}">${esc(caption)}</text>`;
  return svgDoc(
    W,
    H,
    `A real tack from the feed: ${fixes.length} raw fixes over ${to - from} seconds as dots, with the cubic Hermite the replay draws through them. Each amber arrow is half a second of the speed and course that fix reported, the tangents the curve leaves on.`,
    TRACK_CSS,
    body,
  );
}

export function buildPanels(facts: Facts): void {
  fs.mkdirSync(OUT, { recursive: true });
  for (const themeName of ["light", "dark"] as const) {
    const t = THEMES[themeName];
    fs.writeFileSync(path.join(OUT, `course-${themeName}.svg`), courseWide(facts, t));
    fs.writeFileSync(path.join(OUT, `course-narrow-${themeName}.svg`), courseNarrow(facts, t));
    fs.writeFileSync(path.join(OUT, `hermite-${themeName}.svg`), hermitePanel(facts, t, false));
    fs.writeFileSync(path.join(OUT, `hermite-narrow-${themeName}.svg`), hermitePanel(facts, t, true));
  }
}
