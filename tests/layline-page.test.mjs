import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const laylineSources = async () => {
  const roots = ['src/components/layline', 'src/lib/layline'];
  const files = [];
  for (const root of roots) {
    const entries = await readdir(new URL(`../${root}`, import.meta.url), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const dir = entry.parentPath.replaceAll('\\', '/');
      files.push(`${dir.slice(dir.indexOf(root))}/${entry.name}`);
    }
  }
  return [...files, 'src/app/page.tsx', 'src/app/layline.module.css', 'src/app/scrollbar.css'];
};

test('Layline page keeps its identity', async () => {
  const page = await read('src/app/page.tsx');
  assert.match(page, /title: "Layline · Race Replay"/);
  assert.match(page, /generateRace\(RACE_SEED\)/);
  assert.match(page, /Skip to the replay console/);
  assert.match(page, /Built by Ryan Allen/);
  assert.match(page, /href="https:\/\/github\.com\/ryanportfolio\/layline"/);
  assert.match(page, /href="https:\/\/fullbuild\.ai"/);
});

test('Layline engine identity holds: seed, fix rate, lens, version pin', async () => {
  const [types, pkg] = await Promise.all([read('src/lib/layline/types.ts'), read('package.json')]);

  /* The whole page is two readings of one number: the server chart and the
   * client replay both come from this seed at this fix rate. */
  assert.match(types, /export const RACE_SEED = 20280726;/);
  assert.match(types, /export const FIX_HZ = 4;/);
  assert.match(types, /export type ReplayMode = "smooth" \| "raw";/);

  /* three r181/182 broke slerp extrapolation and WebGPU cannot run the
   * ShaderMaterial water; 0.171 is a pin, not a lag. */
  assert.match(pkg, /"three": "\^0\.171\./);
});

test('Layline sources carry no wall-clock time, no unseeded randomness, no banned marks', async () => {
  const files = await laylineSources();
  assert.ok(files.length >= 30, `expected the full layline tree, saw ${files.length} files`);

  for (const path of files) {
    const source = await read(path);
    assert.doesNotMatch(source, /Math\.random|Date\.now|performance\.now|new Date\(/, path);
    assert.doesNotMatch(source, /[—–…‘’“”]/, path);
  }
});

test('Layline stylesheet keeps the house rules', async () => {
  const styles = await read('src/app/layline.module.css');

  assert.match(styles, /--house-cursor: var\(--house-cursor-frost\);/);
  assert.match(styles, /@media \(min-width: 901px\)/);
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /:focus-visible/);
  assert.doesNotMatch(styles, /cursor:\s*pointer/);
  assert.doesNotMatch(styles, /linear-gradient|radial-gradient|backdrop-filter/);
});

/*
  THE COURSE RAIL. The page draws its own scrollbar as a course diagram, and
  these read the values back out of the source rather than restating them, so a
  token rename or a retuned constant fails here instead of drifting.
*/

test('the course rail draws in the console palette and nothing else', async () => {
  const [rail, shell] = await Promise.all([
    read('src/components/layline/CourseRail.module.css'),
    read('src/app/layline.module.css'),
  ]);

  /* Every colour on the rail is a token the page already declares, with the
     meaning it already carries. A raw hex here would be a seventh ink. */
  const inks = [...rail.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]);
  const declared = new Set([
    ...[...shell.matchAll(/^\s{2}(--[a-z-]+):/gm)].map((m) => m[1]),
    "--house-cursor",
    "--house-cursor-frost",
    "--font-archivo",
    "--font-martian",
  ]);
  for (const ink of new Set(inks)) {
    assert.ok(declared.has(ink), `the rail uses ${ink}, which the page never declares`);
  }
  assert.doesNotMatch(
    rail.slice(rail.indexOf("*/")),
    /#[0-9a-f]{3,8}\b/i,
    "the rail paints a raw hex instead of an ink with a meaning",
  );

  /* Amber is the wind on this page. The laylines are the only thing on the rail
     entitled to it, because a layline is a wind fact. */
  const amber = [...rail.matchAll(/([^\s{}]+)\s*\{[^}]*var\(--wind\)/g)].map((m) => m[1]);
  assert.deepEqual(amber, ["line"], "something other than the laylines is spending the wind amber");

  /* The console's own ban list reaches the rail. */
  assert.doesNotMatch(rail, /linear-gradient|radial-gradient|backdrop-filter|box-shadow|filter:\s*blur/);
  assert.doesNotMatch(rail, /cursor:\s*pointer/);
  assert.match(rail, /cursor: var\(--house-cursor\)/);
  assert.match(rail, /@media \(max-width: 900px\)/);
  assert.match(rail, /@media \(prefers-reduced-motion: reduce\)/);

  /* The contract is written down, including what it costs. */
  const header = rail.slice(0, rail.indexOf("*/"));
  assert.match(header, /THE COST, stated/);
  assert.match(header, /macOS/);
});

test('the rail is measured, not divided into pleasing parts', async () => {
  const source = await read('src/components/layline/CourseRail.tsx');

  /* Marks come from the document, at their real share of it. */
  assert.match(source, /querySelectorAll<HTMLElement>\("\[data-leg\]"\)/);
  assert.match(source, /docTop\(el\) \/ docH/);
  /* The thumb is the viewport's real share, and the track is the real range. */
  assert.match(source, /\(viewH \/ docH\) \* trackH/);
  assert.match(source, /const range = docH - viewH/);
  /* Any range at all, not the half-viewport floor the site log uses: the
     platform bar is already down by the time this decides. */
  assert.match(source, /const scrollable = range > 1/);

  /* Speed comes off the rAF stamp. The whole layline tree is barred from
     wall-clock time, and the sources test above enforces it; this states why
     the paint loop is allowed to know how fast the page is moving at all. */
  assert.match(source, /const paint = \(ts: number\)/);
  assert.match(source, /ts - last\.ts/);
});

test('the rail replaces the platform bar without ever leaving the page barless', async () => {
  const [source, bar, page] = await Promise.all([
    read('src/components/layline/CourseRail.tsx'),
    read('src/app/scrollbar.css'),
    read('src/app/page.tsx'),
  ]);

  /* Stamped at mount and removed on teardown, never written statically. */
  assert.match(source, /html\.dataset\.laylineRail = ""/);
  assert.match(source, /delete html\.dataset\.laylineRail/);

  /* Both halves of the gate: the attribute AND the width the rail draws at.
     Either one alone strands a visitor with no scrollbar of any kind. */
  const suppression = bar.match(/@media \(min-width: 901px\) \{([\s\S]*?)\n\}/);
  assert.ok(suppression, "the suppression is not width-gated");
  assert.match(
    suppression[1],
    /html\[data-layline-rail\]:has\(\[data-layline-page\]\) \{\s*scrollbar-width: none;/,
  );
  assert.match(
    suppression[1],
    /html\[data-layline-rail\]:has\(\[data-layline-page\]\)::-webkit-scrollbar \{/,
  );

  /* THE TIE. :has() contributes its most specific argument, so a bare
     html[data-layline-rail] and html:has([data-layline-page]) are both 0-1-1
     and source order alone decides. Written the other way round, the painted
     bar won every tie and a mounted rail got a native scrollbar beside it
     (measured: ::-webkit-scrollbar resolved to 10px at 1440px with the rail
     up). Two things keep that from coming back, and both are asserted: the
     suppression carries :has() itself, taking it to 0-2-1, and it is written
     last anyway. */
  assert.ok(
    bar.indexOf("@media (min-width: 901px)") > bar.lastIndexOf("@supports not selector"),
    "the suppression is written before the painted bar it has to beat",
  );

  /* Where the bar is left in place it is painted in the page's own values.
     The literals are unavoidable (html sits outside .shell) so they are pinned
     to the tokens here instead. */
  const shell = await read('src/app/layline.module.css');
  const token = (name) => shell.match(new RegExp(`${name}:\\s*([^;]+);`))[1].trim();
  assert.equal(token("--page-ground"), "#070f16");
  assert.equal(token("--ink-dim"), "#a4bccb");
  assert.equal(token("--rule"), "rgba(164, 188, 203, 0.28)");
  assert.match(bar, /html:has\(\[data-layline-page\]\)::-webkit-scrollbar-track \{\s*background: #070f16;/);
  assert.match(bar, /html:has\(\[data-layline-page\]\)::-webkit-scrollbar-thumb \{\s*background: #a4bccb;/);
  assert.match(bar, /border-left: 1px solid rgba\(164, 188, 203, 0\.28\)/);
  assert.match(page, /data-layline-page/);

  /* Blink honours scrollbar-color and drops the drawn geometry when it sees it,
     so the standard properties may only appear behind the @supports guard. */
  const guard = bar.indexOf("@supports not selector(::-webkit-scrollbar)");
  assert.ok(guard > 0, "no @supports fallback, so Firefox gets a default bar");
  assert.equal(
    bar.slice(0, guard).includes("scrollbar-color:"),
    false,
    "scrollbar-color outside the guard overrides the drawn bar in Chrome",
  );
  assert.match(bar.slice(guard), /scrollbar-color: #a4bccb #070f16/);
});

test('the rail keeps the bow and the frame budget honest', async () => {
  const source = await read('src/components/layline/CourseRail.tsx');

  /* A frame that moved nothing is not a direction change. This loop runs on
     idle frames while the wake decays, so clearing the run on dy === 0 wiped
     the accumulator between inputs and a reader crawling upward under the
     deadband never got the bow round. */
  assert.match(
    source,
    /if \(dy !== 0\) \{\s*last\.run = Math\.sign\(dy\) === Math\.sign\(last\.run\) \? last\.run \+ dy : dy;/,
  );
  assert.doesNotMatch(source, /dy === 0 \|\| Math\.sign/);

  /* One capture authority per page: the rail's own rAF loop answers to the
     same freeze the replay clock does, or a shot taken after freeze() catches
     the foam mid-decay and two runs of one capture disagree. */
  assert.match(source, /frozenRef\.current = useReplay\.getState\(\)\.frozen/);
  assert.match(source, /useReplay\.subscribe\(\(state\) => \{\s*frozenRef\.current = state\.frozen;/);
  assert.match(source, /const making = speed > 4 && !reducedRef\.current && !frozenRef\.current/);
  /* And it lets go of the store on teardown, like every other handle here. */
  assert.match(source, /unwatch\(\);/);
});

test('every page section the rail marks is a section the page actually renders', async () => {
  const [page, analyst, notes] = await Promise.all([
    read('src/app/page.tsx'),
    read('src/components/layline/analyst/AnalystSection.tsx'),
    read('src/components/layline/NotesSection.tsx'),
  ]);

  assert.match(page, /data-leg="Replay console"/);
  /* The Debrief marks the leg on the story page and nowhere else. The same
     component renders in the race library's rail, which has no course rail
     down its margin for a leg mark to be rounded on. */
  assert.match(analyst, /data-leg=\{rail \? undefined : "Debrief"\}/);
  assert.match(notes, /data-leg="Project notes"/);

  /* The mark's name comes from the section itself, not from the margin. */
  assert.match(analyst, /id="debrief-heading"[\s\S]{0,80}Debrief/);
  assert.match(notes, /<h2[^>]*>What I built<\/h2>/);

  /* The colophon carries no mark: it sits below the last viewport centre, so a
     mark there could never be rounded. The finish line at the foot of the rail
     is what says the document has ended. */
  assert.doesNotMatch(page, /colophon} data-leg/);
});

test('the 2D view replaces camera choices with one clear return to 3D', async () => {
  const [transport, styles] = await Promise.all([
    read('src/components/layline/hud/Transport.tsx'),
    read('src/app/layline.module.css'),
  ]);

  assert.match(
    transport,
    /\{chart2d \? \([\s\S]*?data-control="return-3d"[\s\S]*?Switch to 3D[\s\S]*?\) : \([\s\S]*?aria-label="Camera rig"/,
  );
  assert.match(transport, /data-control="return-3d"[\s\S]*?onClick=\{\(\) => setChart2d\(false\)\}/);
  assert.equal((transport.match(/styles\.viewGroup/g) ?? []).length, 2);

  const returnRule = styles.match(/\.return3dButton \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(returnRule, /min-width: 204px/);
  assert.match(returnRule, /background: var\(--ink\)/);
  assert.match(returnRule, /font-weight: 800/);

  const viewRule = styles.match(/\.viewGroup \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(viewRule, /background: color-mix\(in srgb, var\(--ink-dim\) 8%, transparent\)/);
  assert.match(viewRule, /border-color: var\(--ink-dim\)/);
});

test('the race library CTA counts a real prestart down to the gun', async () => {
  const [page, board, css, bridge] = await Promise.all([
    read('src/app/page.tsx'),
    read('src/components/layline/StartSequence.tsx'),
    read('src/components/layline/StartSequence.module.css'),
    read('src/components/layline/StartSequenceCapture.tsx'),
  ]);

  /* The section is the page's way into the library for a reader who scrolled,
     and it links at this repo's own route, not the fullbuild prefix. */
  assert.match(page, /<StartSequence \/>/);
  assert.match(board, /id="race-library"/);
  assert.match(board, /href="\/races"/);
  assert.match(board, /href=\{`\/races\?race=\$\{row\.id\}`\}/);
  assert.doesNotMatch(board, /prototype\/layline/);

  /* THE NUMBERS ARE THE RACE'S OWN. Every rung is read off the built race
     through the same helpers the console uses, so the odometer walks values
     the simulator produced rather than values written into the markup. */
  assert.match(board, /raceFor\(/);
  assert.match(board, /briefFacts\(/);
  assert.match(board, /windReadingAt\(/);

  /* The section owns its stylesheet so the page's own module stays gradient
     free, which the house-rules test above asserts. One gradient lives here
     instead: the fill bar's leading edge. */
  assert.equal((css.match(/linear-gradient/g) ?? []).length, 1);
  assert.doesNotMatch(css, /radial-gradient|backdrop-filter|box-shadow/);

  /* Comments come out first so these count declarations rather than prose: the
     stylesheet explains its own timing at length and quotes the properties it
     avoids to say why it avoids them. */
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(withoutComments, /border-radius/);
  assert.doesNotMatch(css, /cursor:\s*pointer/);
  assert.match(css, /cursor: var\(--house-cursor\)/);

  /* Two odometer columns, the clock and the wind, each stepping a fixed ten
     rungs. steps(var(--steps), end) would let a race with a different prestart
     walk its digits out of step with its own clock and say nothing about it. */
  assert.equal((withoutComments.match(/steps\(10, end\)/g) ?? []).length, 2);
  assert.doesNotMatch(css, /steps\(var\(/);

  /* Both stacks cut back to their first rung when the flag starts rising, not
     when the cycle wraps 400ms later, or the board paints a fired clock on a
     row that has already rearmed. */
  for (const name of ['cdClock', 'cdWind']) {
    const frames = withoutComments.match(new RegExp(`@keyframes ${name}\\s*\\{(?:[^}]*\\}){4}`));
    assert.ok(frames, `${name} keyframes not found`);
    assert.match(frames[0], /33\.3333% \{\s*animation-timing-function: steps\(1, end\);/);
    assert.match(frames[0], /98\.6667% \{\s*transform: translateY\(0\);/);
  }

  /* Reduced motion is stated here rather than left to the shell's global
     collapse, which is a safety net and not the mechanism. */
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);

  /* ONE CAPTURE AUTHORITY PER PAGE: this board is the third loop on the route
     and answers the same freeze the replay clock and the rail's wake do.

     The subscription is pinned WITH its guard. This store carries no
     subscribeWithSelector, so a plain subscribe fires on every set(), and
     LaylineScene advances the replay clock inside useFrame: unguarded, the
     listener ran once per rendered frame, each one forcing layout and walking
     the section's animations, with the board off screen and its gate shut. */
  assert.match(bridge, /useReplay\.getState\(\)\.frozen/);
  assert.match(
    bridge,
    /useReplay\.subscribe\(\(state\) => \{\s*if \(state\.frozen !== frozen\) applyFrozen\(state\.frozen\);/,
  );
  assert.match(bridge, /unwatch\(\);/);

  /* The gate exists because this page holds a live WebGL context, and closing
     it has to destroy the loop rather than orphan animations the Web Animations
     API has already paused. */
  assert.match(bridge, /new IntersectionObserver/);
  assert.match(bridge, /for \(const animation of animations\(\)\) animation\.cancel\(\);/);
});
