# Sync Live Layline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the standalone `ryanportfolio/layline` app level with Layline at `ryanportfolio/fullbuild.ai@6fa9903`.

**Architecture:** Transplant the three Layline-only changes after the standalone repo's last sync point, `fullbuild.ai@4a5faef`. Keep the standalone root route and external fullbuild.ai link while adapting source imports from `@/app/prototype/layline/layline.module.css` to `@/app/layline.module.css`.

**Tech Stack:** Next.js 15, React 19, TypeScript, React Three Fiber, Zustand, Node test runner with `tsx`.

---

### Task 1: Course rail and intro

**Files:**

- Create: `src/app/scrollbar.css`
- Create: `src/components/layline/CourseRail.tsx`
- Create: `src/components/layline/CourseRail.module.css`
- Create: `src/components/layline/intro/IntroOverlay.tsx`
- Create: `src/components/layline/intro/intro.module.css`
- Modify: `src/app/page.tsx`
- Modify: `src/app/layline.module.css`
- Test: `tests/layline-page.test.mjs`

- [ ] **Step 1: Copy the source rail, intro, and scrollbar files**

Copy their complete contents from `fullbuild.ai@6fa9903`, preserving the standalone app's root page path and its `https://fullbuild.ai/prototype/layline` link.

- [ ] **Step 2: Adapt the source-scanning test**

Copy `tests/prototype-layline.test.mjs` to `tests/layline-page.test.mjs`. Replace `src/app/prototype/layline` with `src/app`, and remove prototype-gallery assertions that have no standalone equivalent.

- [ ] **Step 3: Run the page contract test**

Run: `npx tsx --test tests/layline-page.test.mjs`

Expected: all page, rail, palette, timing, and section-marker assertions pass.

### Task 2: Engine room and debrief replay

**Files:**

- Create: `src/components/layline/analyst/SlateReplay.tsx`
- Create: `src/components/layline/engine/EngineRoom.tsx`
- Create: `src/components/layline/engine/FeedTable.tsx`
- Create: `src/components/layline/engine/WindowStrip.tsx`
- Create: `src/components/layline/engine/benchData.ts`
- Create: `src/components/layline/engine/boardData.ts`
- Create: `src/components/layline/engine/cameras.tsx`
- Create: `src/components/layline/engine/clock.ts`
- Create: `src/components/layline/engine/engine.module.css`
- Modify: `src/components/layline/LaylineApp.tsx`
- Modify: `src/components/layline/NotesSection.tsx`
- Modify: `src/components/layline/analyst/AnalystSection.tsx`
- Modify: `src/components/layline/analyst/analyst.module.css`
- Modify: `src/components/layline/store.ts`
- Delete: `src/components/layline/svg/diagrams.tsx`
- Test: `tests/layline-engine-room.test.ts`

- [ ] **Step 1: Transplant complete source files**

Copy the listed files from `fullbuild.ai@6fa9903`. In copied component imports, replace `@/app/prototype/layline/layline.module.css` with `@/app/layline.module.css`.

- [ ] **Step 2: Add engine-room test coverage**

Copy `tests/layline-engine-room.test.ts` unchanged. Add it to the `test` script in `package.json`.

- [ ] **Step 3: Run all deterministic tests**

Run: `npm test`

Expected: engine, console, analyst, engine-room, and page contract tests all pass.

### Task 3: Course geometry fix and release verification

**Files:**

- Modify: `src/components/layline/scene/CourseGraphics.tsx`
- Modify: `src/components/layline/scene/course.ts`
- Modify: `package-lock.json`

- [ ] **Step 1: Copy the current course geometry files**

Copy both complete files from `fullbuild.ai@6fa9903`. This carries the fleet-aware layline geometry fix from upstream commit `6fa9903`.

- [ ] **Step 2: Refresh lockfile metadata**

Run: `npm install --package-lock-only --ignore-scripts`

Expected: lockfile reflects only the updated test script and existing dependency graph.

- [ ] **Step 3: Verify types and production build**

Run: `npm run typecheck`

Expected: TypeScript exits 0.

Run: `npm run build`

Expected: Next.js production build exits 0 and emits `/` plus `/api/layline/analyst`.

- [ ] **Step 4: Verify rendered page**

Start the production app on a free port. Check the root page at desktop and phone widths for the intro handoff, course rail visibility rule, replay console, Debrief, engine room, and absence of console errors.

- [ ] **Step 5: Commit and open a pull request**

Stage only the synchronized Layline files and this plan. Push `codex/sync-live-layline`, then open one pull request against `main` with the upstream source commits and verification commands recorded in the body.
