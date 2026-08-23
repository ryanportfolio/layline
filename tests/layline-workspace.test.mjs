import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the race library declares five complete route-scoped themes", async () => {
  const [styles, page, workspace, story] = await Promise.all([
    read("src/app/layline.module.css"),
    read("src/app/races/page.tsx"),
    read("src/app/races/RaceWorkspace.tsx"),
    read("src/app/page.tsx"),
  ]);
  const grounds = {
    console: "#070f16",
    sailcloth: "#dfdcd5",
    marine: "#0c8c5e",
    chart: "#f5f1e4",
    ice: "#edfffe",
  };
  const required = [
    "--page-ground",
    "--hud-ground",
    "--ink",
    "--ink-dim",
    "--rule",
    "--focus-ring",
    "--house-cursor",
  ];

  for (const [theme, ground] of Object.entries(grounds)) {
    const block = styles.match(
      new RegExp(`\\.shell\\[data-layline-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    assert.ok(block, `${theme} has no route-scoped token set`);
    assert.match(block, new RegExp(`--page-ground:\\s*${ground.replace("#", "\\#")};`));
    for (const token of required) {
      assert.match(block, new RegExp(`${token}:`), `${theme} does not declare ${token}`);
    }
  }

  assert.match(
    styles.match(/\.shell\[data-layline-theme="console"\] \{([\s\S]*?)\n\}/)?.[1] ?? "",
    /--house-cursor: var\(--house-cursor-frost\);/,
  );
  for (const theme of ["sailcloth", "marine", "chart", "ice"]) {
    const block = styles.match(
      new RegExp(`\\.shell\\[data-layline-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`),
    )?.[1] ?? "";
    assert.match(block, /--house-cursor: var\(--house-cursor-graphite\);/);
  }

  assert.match(page, /suppressHydrationWarning/);
  assert.match(page, /document\.currentScript\?\.parentElement/);
  assert.match(page, /localStorage\.getItem\("layline-races-theme-v1"\)/);
  assert.match(page, /\["console", "sailcloth", "marine", "chart", "ice"\]\.includes/);
  assert.doesNotMatch(story, /data-layline-theme|ThemePicker|layline-races-theme-v1/);

  assert.match(workspace, /aria-label="Interface theme"/);
  assert.match(workspace, />Theme<\/span>/);
  assert.match(workspace, /Current theme \$\{current\.label\}\. Switch to \$\{next\.label\}/);
  assert.match(workspace, /\(currentIndex \+ 1\) % THEME_OPTIONS\.length/);
  const themePicker = workspace.match(/export function ThemePicker[\s\S]*?\/\*\* One row/)?.[0] ?? "";
  assert.doesNotMatch(themePicker, /aria-pressed/);
  for (const theme of Object.keys(grounds)) {
    assert.match(workspace, new RegExp(`id: "${theme}"`));
  }
  assert.ok((workspace.match(/<svg/g) ?? []).length >= 5);
  assert.match(workspace, /function PanelToggleIcon/);
  assert.match(workspace, /action: "collapse" \| "restore"/);
});

test("the race rail and panes keep their interaction contracts", async () => {
  const [workspace, page, state, styles, analyst] = await Promise.all([
    read("src/app/races/RaceWorkspace.tsx"),
    read("src/app/races/page.tsx"),
    read("src/app/races/workspaceState.ts"),
    read("src/app/races/races.module.css"),
    read("src/components/layline/analyst/AnalystSection.tsx"),
  ]);

  assert.match(workspace, /aria-label="Search races"|htmlFor="race-search"/);
  assert.match(workspace, /if \(event\.key !== "Escape"\) return;/);
  assert.match(workspace, />\s*Clear\s*<\/button>/);
  assert.match(workspace, /Search hides \$\{hiddenBySearch\} races/);
  assert.doesNotMatch(workspace, /stays loaded\. Search hides its row/);
  assert.match(workspace, /router\.replace\(`\$\{pathname\}\?race=\$\{id\}`/);

  assert.match(workspace, /aria-label=\{`\$\{pinned \? "Unpin" : "Pin"\}/);
  assert.match(workspace, /aria-label=\{`\$\{archived \? "Restore" : "Archive"\}/);
  assert.match(workspace, /<details[\s\S]*?<summary/);
  assert.match(workspace, /if \(movingToArchive\) setArchiveOpen\(true\)/);
  assert.match(workspace, /stays loaded and moved to Archive/);

  assert.match(workspace, /localStorage\.getItem\(WORKSPACE_STORAGE_KEY\)/);
  assert.match(workspace, /document\.cookie = `\$\{WORKSPACE_COOKIE_KEY\}/);
  assert.match(page, /cookies\(\)/);
  assert.match(page, /parseWorkspacePreferences/);
  assert.match(state, /validIds\.has\(id\)/);

  assert.match(workspace, /role="separator"/);
  assert.match(workspace, /aria-valuemin=/);
  assert.match(workspace, /aria-valuemax=/);
  assert.match(workspace, /aria-valuenow=/);
  assert.match(workspace, /event\.key === "PageUp"/);
  assert.match(workspace, /event\.key === "PageDown"/);
  assert.match(workspace, /onDoubleClick=\{\(\) => commitWidth\(pane, null\)\}/);
  assert.match(workspace, /drag\.handle\.style\.transform = `translateX/);
  assert.match(workspace, /finishResize[\s\S]*?commitWidth\(drag\.pane, drag\.nextWidth\)/);

  assert.match(workspace, /data-pane-drag-handle/);
  assert.match(workspace, /Move \$\{pane === "rail" \? "race list" : "analyst"\} to the/);
  assert.match(workspace, /aria-live="polite"/);
  assert.match(analyst, /railHeaderProps/);
  assert.match(analyst, /railHeaderControls/);
  assert.match(workspace, /aria-label=\{preferences\.railCollapsed \? "Restore race list" : "Collapse race list"\}/);
  assert.ok(
    workspace.indexOf("className={styles.panelToggle}") < workspace.indexOf("ref={libraryRef}"),
    "collapse control stays at the rail top-left instead of inside a separator",
  );
  assert.match(styles, /@media \(max-width: 1199px\)/);
  assert.match(styles, /\.separator \{[\s\S]*?display: none;/);
  assert.match(styles, /@media \(min-width: 1200px\)[\s\S]*?\.separator \{\s*display: block;/);
});
