"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { AnalystSection } from "@/components/layline/analyst/AnalystSection";
import {
  LaylineApp,
  type InitialRaceAuthority,
} from "@/components/layline/LaylineApp";
import { pointAtRace, raceData, useReplay } from "@/components/layline/store";
import { raceMeta } from "@/lib/layline/races";
import { createInspectionPlayingCadenceBudget } from "@/lib/layline/surfaces";
import { RaceSidebarStatus } from "./RaceSidebarStatus";
import styles from "./races.module.css";
import {
  ANALYST_MAX,
  ANALYST_MIN,
  RAIL_MAX,
  RAIL_MIN,
  WORKSPACE_COOKIE_KEY,
  WORKSPACE_STORAGE_KEY,
  clampPaneWidth,
  defaultPaneWidth,
  hydrateWorkspacePreferences,
  libraryOpenFromPreferences,
  raceMatchesSearch,
  sanitizeWorkspacePreferences,
  sortPinnedRows,
  toggleLibraryPreference,
  type PaneSide,
  type WorkspacePreferences,
} from "./workspaceState";

export type LaylineTheme = "console" | "sailcloth" | "marine" | "chart" | "ice";

const THEME_STORAGE_KEY = "layline-races-theme-v1";
const THEME_OPTIONS: readonly { id: LaylineTheme; label: string; ground: string }[] = [
  { id: "console", label: "Console", ground: "#070f16" },
  { id: "sailcloth", label: "Sailcloth", ground: "#dfdcd5" },
  { id: "marine", label: "Marine", ground: "#06422e" },
  { id: "chart", label: "Chart", ground: "#f5f1e4" },
  { id: "ice", label: "Ice", ground: "#edfffe" },
];

function isTheme(value: string | undefined | null): value is LaylineTheme {
  return THEME_OPTIONS.some((option) => option.id === value);
}

function ThemeIcon({ theme }: { theme: LaylineTheme }) {
  if (theme === "console") {
    return (
      <svg className={styles.themeIcon} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <rect className={styles.themeIconGround} x="2" y="2.5" width="14" height="13" rx="1" />
        <path className={styles.themeIconLine} d="M5 6.5 7 8.5 5 10.5M9.5 11h3.5" />
      </svg>
    );
  }
  if (theme === "sailcloth") {
    return (
      <svg className={styles.themeIcon} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path className={styles.themeIconGround} d="M2.5 14.5C4 7.1 6.2 3.5 9 3.5s5 3.6 6.5 11Z" />
        <path className={styles.themeIconLine} d="M5 13.5C5.8 8.7 7.1 6 9 4.4M13 13.5C12.2 8.7 10.9 6 9 4.4M9 4.4v10" />
      </svg>
    );
  }
  if (theme === "marine") {
    return (
      <svg className={styles.themeIcon} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path className={styles.themeIconGround} d="M2 10.5c2 0 2 1.5 4 1.5s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 2-1.5V16H2Z" />
        <path className={styles.themeIconLine} d="M9 3v7M6.5 6.5h5M7.2 6.5 8 3h2l.8 3.5M2 10.5c2 0 2 1.5 4 1.5s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 2-1.5" />
      </svg>
    );
  }
  if (theme === "chart") {
    return (
      <svg className={styles.themeIcon} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <rect className={styles.themeIconGround} x="2" y="2" width="14" height="14" />
        <path className={styles.themeIconGrid} d="M6.7 2v14M11.3 2v14M2 6.7h14M2 11.3h14" />
        <path className={styles.themeIconLine} d="M4.2 13.2 7 9.4l3 1.1 3.8-5.7" />
        <circle className={styles.themeIconNode} cx="4.2" cy="13.2" r="1" />
        <circle className={styles.themeIconNode} cx="13.8" cy="4.8" r="1" />
      </svg>
    );
  }
  return (
    <svg className={styles.themeIcon} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path className={styles.themeIconGround} d="m9 1.8 6.2 3.6v7.2L9 16.2l-6.2-3.6V5.4Z" />
      <path className={styles.themeIconLine} d="M9 3v12M3.8 6l10.4 6M14.2 6 3.8 12M6.8 4.3 9 6.5l2.2-2.2M6.8 13.7 9 11.5l2.2 2.2" />
    </svg>
  );
}

/* The pane control uses one drawing with two stated states. Collapse adds the
 * left chevron to the split panel. Restore leaves the split panel plain. */
export function PanelToggleIcon({ action }: { action: "collapse" | "restore" }) {
  return (
    <svg
      className={styles.panelToggleIcon}
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="2.5" width="15" height="13" rx="1" />
      <path d="M6 2.5v13" />
      {action === "collapse" ? <path d="M12 6 9 9l3 3" /> : null}
    </svg>
  );
}

export function ThemePicker({ initialTheme = "console" }: { initialTheme?: LaylineTheme }) {
  const root = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<LaylineTheme>(initialTheme);

  useEffect(() => {
    const page = root.current?.closest<HTMLElement>("[data-layline-page]");
    let stored = page?.dataset.laylineTheme;
    if (!isTheme(stored)) {
      try {
        stored = window.localStorage.getItem(THEME_STORAGE_KEY) ?? undefined;
      } catch {
        stored = undefined;
      }
    }
    if (!isTheme(stored)) return;
    page?.setAttribute("data-layline-theme", stored);
    setTheme(stored);
  }, []);

  const choose = (next: LaylineTheme) => {
    root.current?.closest<HTMLElement>("[data-layline-page]")?.setAttribute(
      "data-layline-theme",
      next,
    );
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* Storage can be blocked. The chosen theme still lasts for this page. */
    }
    document.cookie = `${THEME_STORAGE_KEY}=${encodeURIComponent(next)}; Path=/races; Max-Age=31536000; SameSite=Lax`;
  };

  const currentIndex = THEME_OPTIONS.findIndex((option) => option.id === theme);
  const current = THEME_OPTIONS[currentIndex] ?? THEME_OPTIONS[0];
  const next = THEME_OPTIONS[(currentIndex + 1) % THEME_OPTIONS.length] ?? THEME_OPTIONS[0];

  return (
    <div ref={root} className={styles.themePicker} role="group" aria-label="Interface theme">
      <span className={styles.themeLabel}>Theme</span>
      <button
        type="button"
        className={styles.themeButton}
        aria-label={`Current theme ${current.label}. Switch to ${next.label}`}
        onClick={() => choose(next.id)}
      >
        <span className={styles.themeIconStack} aria-hidden="true">
        {THEME_OPTIONS.map((option) => (
          <span
            key={option.id}
            className={styles.themeIconSlot}
            data-theme-icon={option.id}
            style={{ "--theme-icon-ground": option.ground } as CSSProperties}
          >
            <ThemeIcon theme={option.id} />
          </span>
        ))}
        </span>
      </button>
      <span className={styles.srOnly} aria-live="polite">
        {`Current theme ${current.label}`}
      </span>
    </div>
  );
}

/** One row of the rail, measured on the server from that race's own build. */
export interface RaceRow {
  id: string;
  name: string;
  venue: string;
  dateLabel: string;
  boats: number;
  /** Winning elapsed, already formatted on the clock the finish table uses. */
  elapsed: string;
}

function RaceListRow({
  row,
  current,
  pinned,
  archived,
  status,
  onSelect,
  onPin,
  onArchive,
}: {
  row: RaceRow;
  current: boolean;
  pinned: boolean;
  archived: boolean;
  status?: ReactNode;
  onSelect: () => void;
  onPin: () => void;
  onArchive: () => void;
}) {
  return (
    <li className={styles.rowShell} data-current={current ? "true" : undefined}>
      <button
        type="button"
        className={styles.row}
        aria-current={current ? "true" : undefined}
        onClick={onSelect}
      >
        <span className={styles.rowName}>{row.name}</span>
        <span className={styles.rowMeta}>{`${row.venue} · ${row.dateLabel}`}</span>
        <span className={styles.rowStats}>
          <span>{`${row.boats} boats`}</span>
          <span>
            Winner <strong>{row.elapsed}</strong>
          </span>
        </span>
      </button>
      <span className={styles.rowActions}>
        <button
          type="button"
          className={styles.rowAction}
          aria-label={`${pinned ? "Unpin" : "Pin"} ${row.name}`}
          aria-pressed={pinned}
          onClick={onPin}
        >
          {pinned ? "Pinned" : "Pin"}
        </button>
        <button
          type="button"
          className={styles.rowAction}
          aria-label={`${archived ? "Restore" : "Archive"} ${row.name}`}
          onClick={onArchive}
        >
          {archived ? "Restore" : "Archive"}
        </button>
      </span>
      {status}
    </li>
  );
}

/**
 * The three panes and the one race they share.
 *
 * Binding order is the whole of this component. The client store holds one
 * race at a time behind a zero-argument raceData(), and the viewer reads it
 * while it renders, so the URL's race has to be loaded before the viewer's
 * first render rather than in an effect after it. The initializer below does
 * that half, moving the module pointer alone: a store write during a render
 * would notify the page being navigated away from, which is still mounted.
 * The effect brings the store itself to the same race straight after. Both in
 * the browser only, because the store module is one object per server process
 * and a render that wrote to it would hand a concurrent request for another
 * race the wrong one.
 *
 * Which leaves the server rendering the shipped race's id while the browser
 * renders the URL's. Everything the markup spends the id on reads `initial`
 * until mount for exactly that reason, and the analyst, whose whole tree is
 * built from the loaded race, waits for mount rather than hydrating against
 * the wrong one.
 */
export function RaceWorkspace({
  initialRace,
  rows,
  initialPreferences,
  analystOffline = false,
  children,
}: {
  initialRace: InitialRaceAuthority;
  rows: readonly RaceRow[];
  initialPreferences: WorkspacePreferences;
  /* The server knows whether a key or the mock is configured; the client
   * cannot. Offline, the rail says so instead of mounting a composer whose
   * every question would come back a dropped connection. */
  analystOffline?: boolean;
  children: ReactNode;
}) {
  const initialRaceId = initialRace.id;
  useState(() => {
    if (typeof window !== "undefined") pointAtRace(initialRace.id);
    return null;
  });

  /* Query-driven race changes preserve this workspace while key={raceId}
   * intentionally remounts the race viewer. The shared budget carries only
   * an integer replay second across those child remounts, never RaceData.
   * A full workspace remount gets a new budget and may perform its first trace. */
  const [inspectionCadenceBudget] = useState(
    () => createInspectionPlayingCadenceBudget(),
  );

  const router = useRouter();
  const pathname = usePathname();
  const storeRaceId = useReplay((state) => state.raceId);
  const briefDone = useReplay((state) => state.briefDone);
  const [mounted, setMounted] = useState(false);
  const [pendingRaceId, setPendingRaceId] = useState<string | null>(null);
  const validIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const initialPreferencesRef = useRef(initialPreferences);
  const [preferences, setPreferences] = useState(() =>
    sanitizeWorkspacePreferences(initialPreferences, validIds),
  );
  const libraryOpen = libraryOpenFromPreferences(preferences);
  const [storageReady, setStorageReady] = useState(false);
  const loadedPreferences = useRef(false);
  const [query, setQuery] = useState("");
  const [announcedHidden, setAnnouncedHidden] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(() =>
    initialPreferences.archived.includes(initialRaceId),
  );
  const workspaceRef = useRef<HTMLElement>(null);
  const libraryRef = useRef<HTMLElement>(null);
  const analystRef = useRef<HTMLElement>(null);
  const analystToggleRef = useRef<HTMLButtonElement>(null);
  const draggedPane = useRef<"rail" | "analyst" | null>(null);
  const [measuredWidths, setMeasuredWidths] = useState({
    rail: initialPreferences.railWidth ?? defaultPaneWidth("rail", 1600),
    analyst: initialPreferences.analystWidth ?? defaultPaneWidth("analyst", 1600),
  });
  const resizeDrag = useRef<{
    pointerId: number;
    pane: "rail" | "analyst";
    side: PaneSide;
    startX: number;
    startWidth: number;
    nextWidth: number;
    handle: HTMLDivElement;
  } | null>(null);

  /* Local storage owns viewer preferences. A route-scoped cookie mirrors the
   * same validated object so the server can paint the stored order and widths
   * on the first frame. The registry remains immutable, and stale ids fall out
   * at both reads. If storage is blocked, the server value remains usable. */
  useEffect(() => {
    if (loadedPreferences.current) return;
    loadedPreferences.current = true;
    let localRaw: string | null | undefined;
    try {
      localRaw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    } catch {
      localRaw = undefined;
    }
    const next = hydrateWorkspacePreferences(
      initialPreferencesRef.current,
      localRaw,
      validIds,
    );
    setPreferences(next);
    setStorageReady(true);
  }, [validIds]);

  useEffect(() => {
    if (!storageReady) return;
    const value = JSON.stringify(preferences);
    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, value);
    } catch {
      /* The cookie still gives this browser a server-first fallback. */
    }
    document.cookie = `${WORKSPACE_COOKIE_KEY}=${encodeURIComponent(value)}; Path=/races; Max-Age=31536000; SameSite=Lax`;
  }, [preferences, storageReady]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    const library = libraryRef.current;
    const analyst = analystRef.current;
    if (workspace === null || analyst === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      setMeasuredWidths({
        rail:
          preferences.railCollapsed || library === null
            ? 0
            : Math.round(library.getBoundingClientRect().width),
        analyst: Math.round(analyst.getBoundingClientRect().width),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    observer.observe(analyst);
    if (library !== null) observer.observe(library);
    return () => observer.disconnect();
  }, [preferences.railCollapsed]);

  const [analystOpen, setAnalystOpen] = useState(false);
  /* Mount the analyst on first use, then keep it alive while its drawer is
   * closed. A question thread and an in-flight answer belong to the selected
   * race, not to whether its panel is taking width this moment. */
  const [analystReady, setAnalystReady] = useState(false);

  useEffect(() => {
    if (analystOpen || !analystReady) return;
    analystToggleRef.current?.focus({ preventScroll: true });
  }, [analystOpen, analystReady]);

  /* Also the back button: a navigation changes the prop, and the store follows
   * it. Selecting a race the store already holds is a no-op, so the mount pass
   * costs nothing. */
  useEffect(() => {
    useReplay.getState().selectRace(initialRaceId);
    setPendingRaceId(null);
    setMounted(true);
  }, [initialRaceId]);

  const raceId = mounted ? storeRaceId : initialRaceId;
  const meta = raceMeta(raceId);
  const venue = meta?.venue;
  const archived = useMemo(() => new Set(preferences.archived), [preferences.archived]);
  const pinned = useMemo(() => new Set(preferences.pinned), [preferences.pinned]);
  const matchingRows = useMemo(
    () => rows.filter((row) => raceMatchesSearch(row, query)),
    [query, rows],
  );
  const hiddenBySearch = rows.length - matchingRows.length;
  const mainMatching = sortPinnedRows(
    matchingRows.filter((row) => !archived.has(row.id)),
    pinned,
  );
  const pinnedRows = mainMatching.filter((row) => pinned.has(row.id));
  const regularRows = mainMatching.filter((row) => !pinned.has(row.id));
  const archivedRows = matchingRows.filter((row) => archived.has(row.id));
  const loadedRow = rows.find((row) => row.id === raceId);

  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncedHidden(hiddenBySearch), 450);
    return () => window.clearTimeout(timer);
  }, [hiddenBySearch]);

  useEffect(() => {
    if (archived.has(raceId)) setArchiveOpen(true);
  }, [archived, raceId]);

  /* The URL moves and the store follows it through the effect above, when the
   * navigation hands back the new prop with the new server children. One
   * committer means the fallback chart, the finish table and the viewer can
   * never describe two races at once, whatever the navigation does; a store
   * that jumped ahead here would strand a WebGL-less visitor on a fallback
   * from one race under a rail naming another. Replace rather than push:
   * picking a race is changing what you are looking at, not a place to come
   * back to, and the history would fill with one entry per glance. */
  const select = (id: string) => {
    if (id === raceId) return;
    setPendingRaceId(id);
    router.replace(`${pathname}?race=${id}`, { scroll: false });
  };

  const togglePin = (id: string) => {
    setPreferences((current) => ({
      ...current,
      pinned: current.pinned.includes(id)
        ? current.pinned.filter((race) => race !== id)
        : [...current.pinned, id],
    }));
  };

  const toggleArchive = (id: string) => {
    const movingToArchive = !archived.has(id);
    setPreferences((current) => ({
      ...current,
      archived: movingToArchive
        ? [...current.archived, id]
        : current.archived.filter((race) => race !== id),
    }));
    if (movingToArchive) setArchiveOpen(true);
    if (id === raceId) {
      setAnnouncement(
        movingToArchive
          ? `${loadedRow?.name ?? "Loaded race"} stays loaded and moved to Archive`
          : `${loadedRow?.name ?? "Loaded race"} restored to the race list`,
      );
    }
  };

  const clearSearch = () => setQuery("");

  const toggleAnalyst = () => {
    if (analystOpen) {
      setAnalystOpen(false);
      return;
    }
    setAnalystReady(true);
    setAnalystOpen(true);
  };

  const sideFor = (pane: "rail" | "analyst"): PaneSide =>
    pane === "rail"
      ? preferences.railSide
      : preferences.railSide === "left"
        ? "right"
        : "left";

  const paneFor = (side: PaneSide): "rail" | "analyst" =>
    preferences.railSide === side ? "rail" : "analyst";

  const movePaneTo = (pane: "rail" | "analyst", side: PaneSide) => {
    if (sideFor(pane) === side) return;
    const railSide = pane === "rail" ? side : side === "left" ? "right" : "left";
    setPreferences((current) => ({ ...current, railSide }));
    setAnnouncement(`${pane === "rail" ? "Race list" : "Analyst"} moved to the ${side}`);
  };

  const movePaneWithKeyboard = (pane: "rail" | "analyst") => {
    movePaneTo(pane, sideFor(pane) === "left" ? "right" : "left");
  };

  const startPaneDrag = (pane: "rail" | "analyst", event: ReactDragEvent<HTMLElement>) => {
    if (!window.matchMedia("(min-width: 1200px)").matches) {
      event.preventDefault();
      return;
    }
    if ((event.target as Element).closest("button") !== null) {
      event.preventDefault();
      return;
    }
    draggedPane.current = pane;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", pane);
  };

  const dropPane = (side: PaneSide, event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    const pane = draggedPane.current;
    draggedPane.current = null;
    if (pane !== null) movePaneTo(pane, side);
  };

  const workspaceContentWidth = (): number => {
    const workspace = workspaceRef.current;
    if (workspace === null) return window.innerWidth;
    const computed = window.getComputedStyle(workspace);
    return (
      workspace.clientWidth -
      Number.parseFloat(computed.paddingLeft) -
      Number.parseFloat(computed.paddingRight)
    );
  };

  const currentWidth = (pane: "rail" | "analyst"): number => {
    const measured = measuredWidths[pane];
    if (measured > 0) return measured;
    const stored = pane === "rail" ? preferences.railWidth : preferences.analystWidth;
    return stored ?? defaultPaneWidth(pane, window.innerWidth);
  };

  const clampedWidth = (pane: "rail" | "analyst", requested: number): number => {
    const other = pane === "rail" ? "analyst" : "rail";
    return clampPaneWidth({
      pane,
      requested,
      workspaceWidth: workspaceContentWidth(),
      otherWidth: currentWidth(other),
      otherCollapsed: other === "rail" && preferences.railCollapsed,
    });
  };

  const commitWidth = (pane: "rail" | "analyst", width: number | null) => {
    setPreferences((current) => ({
      ...current,
      [pane === "rail" ? "railWidth" : "analystWidth"]: width,
    }));
  };

  const startResize = (side: PaneSide, event: ReactPointerEvent<HTMLDivElement>) => {
    const pane = paneFor(side);
    if (pane === "rail" && preferences.railCollapsed) return;
    if ((event.target as Element).closest("button") !== null) return;
    const width = currentWidth(pane);
    resizeDrag.current = {
      pointerId: event.pointerId,
      pane,
      side,
      startX: event.clientX,
      startWidth: width,
      nextWidth: width,
      handle: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    workspaceRef.current?.setAttribute("data-resizing", pane);
    event.preventDefault();
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const physicalDelta = event.clientX - drag.startX;
    const requested = drag.startWidth + (drag.side === "left" ? physicalDelta : -physicalDelta);
    const nextWidth = clampedWidth(drag.pane, requested);
    drag.nextWidth = nextWidth;
    const handleDelta = drag.side === "left"
      ? nextWidth - drag.startWidth
      : drag.startWidth - nextWidth;
    drag.handle.style.transform = `translateX(${handleDelta}px)`;
    drag.handle.setAttribute("aria-valuenow", String(nextWidth));
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    drag.handle.style.transform = "";
    if (drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId);
    workspaceRef.current?.removeAttribute("data-resizing");
    resizeDrag.current = null;
    commitWidth(drag.pane, drag.nextWidth);
  };

  const resizeWithKeyboard = (
    side: PaneSide,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const pane = paneFor(side);
    if (pane === "rail" && preferences.railCollapsed) return;
    const current = currentWidth(pane);
    let requested: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      requested = current + (side === "left" ? -8 : 8);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      requested = current + (side === "left" ? 8 : -8);
    } else if (event.key === "PageUp") {
      requested = current + 32;
    } else if (event.key === "PageDown") {
      requested = current - 32;
    } else if (event.key === "Home") {
      requested = pane === "rail" ? RAIL_MIN : ANALYST_MIN;
    } else if (event.key === "End") {
      requested = pane === "rail" ? RAIL_MAX : ANALYST_MAX;
    }
    if (requested === null) return;
    event.preventDefault();
    commitWidth(pane, clampedWidth(pane, requested));
  };

  const toggleRail = () => {
    const next = toggleLibraryPreference(preferences);
    setPreferences(next);
    const railCollapsed = next.railCollapsed;
    setAnnouncement(`Race list ${railCollapsed ? "collapsed" : "restored"}`);
  };

  const paneMoveButton = (pane: "rail" | "analyst") => {
    const target = sideFor(pane) === "left" ? "right" : "left";
    return (
      <button
        type="button"
        className={styles.movePaneButton}
        onClick={() => movePaneWithKeyboard(pane)}
        aria-label={`Move ${pane === "rail" ? "race list" : "analyst"} to the ${target}`}
      >
        {`Move ${target}`}
      </button>
    );
  };

  const separator = (side: PaneSide) => {
    const pane = paneFor(side);
    const collapsed = pane === "rail" && preferences.railCollapsed;
    const value = collapsed ? 0 : measuredWidths[pane];
    return (
      <div
        key={side}
        className={styles.separator}
        data-boundary={side}
        data-pane={pane}
        role="separator"
        aria-label={`Resize ${pane === "rail" ? "race list" : "analyst"} pane`}
        aria-orientation="vertical"
        aria-valuemin={collapsed ? 0 : pane === "rail" ? RAIL_MIN : ANALYST_MIN}
        aria-valuemax={pane === "rail" ? RAIL_MAX : ANALYST_MAX}
        aria-valuenow={value}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={(event) => startResize(side, event)}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onDoubleClick={() => commitWidth(pane, null)}
        onKeyDown={(event) => resizeWithKeyboard(side, event)}
      >
        <span className={styles.separatorLine} aria-hidden="true" />
      </div>
    );
  };

  const workspaceStyle = {
    ...(preferences.railWidth === null
      ? {}
      : { "--rail-width": `${preferences.railWidth}px` }),
    ...(preferences.analystWidth === null
      ? {}
      : { "--analyst-width": `${preferences.analystWidth}px` }),
  } as CSSProperties;

  const selectedNotice = archived.has(raceId)
    ? `${loadedRow?.name ?? "The loaded race"} stays loaded in Archive`
    : null;

  let emptyMainCopy = "No active races";
  if (query !== "") {
    emptyMainCopy = pinnedRows.length === 0 ? "No races match this search" : "Every match is pinned";
  } else if (pinnedRows.length > 0) {
    emptyMainCopy = "Every active race is pinned";
  }

  const renderRow = (row: RaceRow, inArchive = false) => {
    const current = row.id === raceId;
    return (
      <RaceListRow
      key={row.id}
      row={row}
      current={current}
      pinned={pinned.has(row.id)}
      archived={inArchive}
      onSelect={() => select(row.id)}
      onPin={() => togglePin(row.id)}
      onArchive={() => toggleArchive(row.id)}
      status={
        current &&
        libraryOpen &&
        briefDone &&
        pendingRaceId === null &&
        storeRaceId === initialRaceId
          ? <RaceSidebarStatus race={raceData()} />
          : null
      }
    />
    );
  };

  return (
    <main
      ref={workspaceRef}
      className={styles.workspace}
      style={workspaceStyle}
      data-rail-side={preferences.railSide}
      data-rail-collapsed={preferences.railCollapsed ? "true" : "false"}
      data-library-open={libraryOpen}
      data-analyst-open={analystOpen}
    >
      <span className={styles.srOnly} aria-live="polite">
        {announcement}
      </span>
      <button
        id="race-list-toggle"
        type="button"
        className={styles.panelToggle}
        aria-controls="race-library-panel"
        aria-expanded={libraryOpen}
        aria-label={preferences.railCollapsed ? "Restore race list" : "Collapse race list"}
        onClick={toggleRail}
      >
        <PanelToggleIcon action={preferences.railCollapsed ? "restore" : "collapse"} />
      </button>
      <aside
        ref={libraryRef}
        id="race-list"
        className={styles.libraryPane}
        aria-label="Race library"
        tabIndex={-1}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => dropPane(sideFor("rail"), event)}
      >
        <section
          id="race-library-panel"
          className={`${styles.drawerBody} ${styles.library}`}
          aria-labelledby="race-list-heading"
          hidden={!libraryOpen}
        >
        <div
          className={`${styles.paneHeader} ${styles.railHeader}`}
          draggable
          data-pane-drag-handle
          onDragStart={(event) => startPaneDrag("rail", event)}
          onDragEnd={() => {
            draggedPane.current = null;
          }}
        >
          <h2 id="race-list-heading" className={styles.libraryHeading}>Races</h2>
          {paneMoveButton("rail")}
        </div>

        <div className={styles.searchBox}>
          <label className={styles.searchLabel} htmlFor="race-search">Search</label>
          <span className={styles.searchFieldWrap}>
            <input
              id="race-search"
              className={styles.searchField}
              type="search"
              value={query}
              placeholder="Name, venue or date"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                clearSearch();
              }}
            />
            {query === "" ? null : (
              <button type="button" className={styles.searchClear} onClick={clearSearch}>
                Clear
              </button>
            )}
          </span>
          {query === "" ? null : (
            <p className={styles.searchCount}>
              {hiddenBySearch === 1
                ? "Search hides 1 race"
                : `Search hides ${hiddenBySearch} races`}
            </p>
          )}
          <span className={styles.srOnly} aria-live="polite">
            {query === ""
              ? "Search cleared"
              : announcedHidden === 1
                ? "Search hides 1 race"
                : `Search hides ${announcedHidden} races`}
          </span>
        </div>

        {selectedNotice === null ? null : (
          <p className={styles.loadedNotice} role="status">{selectedNotice}</p>
        )}

        <div className={styles.rowScroller}>
          {pinnedRows.length === 0 ? null : (
            <div className={styles.rowGroup}>
              {/* Named for a screen reader, not drawn. A pinned row already
                  says so on its own button, and the shelf below it is the
                  library whether or not a heading repeats the panel's title. */}
              <ul className={styles.rows} aria-label={`Pinned, ${pinnedRows.length}`}>
                {pinnedRows.map((row) => renderRow(row))}
              </ul>
            </div>
          )}
          <div className={styles.rowGroup}>
            {regularRows.length === 0 ? (
              <p className={styles.emptyRows}>{emptyMainCopy}</p>
            ) : (
              <ul className={styles.rows} aria-label="Race library">
                {regularRows.map((row) => renderRow(row))}
              </ul>
            )}
          </div>
        </div>

        <details
          className={styles.archive}
          open={archiveOpen}
          onToggle={(event) => setArchiveOpen(event.currentTarget.open)}
        >
          <summary className={styles.archiveSummary}>{`Archive ${preferences.archived.length}`}</summary>
          {preferences.archived.length === 0 ? (
            <p className={styles.archiveEmpty}>No archived races</p>
          ) : archivedRows.length === 0 ? (
            <p className={styles.archiveEmpty}>Search hides every archived race</p>
          ) : (
            <ul className={`${styles.rows} ${styles.archiveRows}`}>
              {archivedRows.map((row) => renderRow(row, true))}
            </ul>
          )}
        </details>
      </section>
      </aside>

      {separator("left")}

      {/* The id the analyst's moment chips scroll to, same as on the story
          page, so a chip drives the viewer from either layout. */}
      <section
        id="replay-console"
        className={styles.console}
        aria-label="Race replay console"
        tabIndex={-1}
      >
        <LaylineApp
          key={raceId}
          initialRace={initialRace}
          useInitialRace={!mounted}
          venue={venue}
          autoplay="immediate"
          boot="sea"
          inspectionCadenceBudget={inspectionCadenceBudget}
          bootBrief={
            meta === undefined
              ? undefined
              : { name: meta.name, venue: meta.venue, dateLabel: meta.dateLabel }
          }
          comparison
          analysisWorkspaces
          showStandingsDock={!libraryOpen}
        >
          {children}
        </LaylineApp>
      </section>

      {separator("right")}

      {/* Remounted with the race. The thread belongs to the race it was asked
          about, and the unmount aborts an answer still streaming for the race
          nobody is watching any more. */}
      <aside
        ref={analystRef}
        id="race-analyst"
        className={styles.analystPane}
        aria-label="Race debrief"
        tabIndex={-1}
        draggable
        data-pane-drag-handle
        onDragStart={(event) => startPaneDrag("analyst", event)}
        onDragEnd={() => {
          draggedPane.current = null;
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => dropPane(sideFor("analyst"), event)}
      >
        <div className={styles.paneBar}>
          <button
            ref={analystToggleRef}
            id="race-analyst-toggle"
            type="button"
            className={styles.paneToggle}
            aria-controls="race-debrief-panel"
            aria-expanded={analystOpen}
            aria-label={analystOpen ? "Close debrief" : "Open debrief"}
            onClick={toggleAnalyst}
          >
            <span className={styles.paneLabel}>Debrief</span>
            <span className={styles.paneArrow} aria-hidden="true">
              {analystOpen ? "›" : "‹"}
            </span>
          </button>
          {paneMoveButton("analyst")}
        </div>
        <div
          id="race-debrief-panel"
          className={`${styles.drawerBody} ${styles.analyst}`}
          hidden={!analystOpen}
        >
        {analystOffline ? (
          <div className={styles.analystOffline}>
            <div
              className={styles.paneHeader}
              draggable
              data-pane-drag-handle
              onDragStart={(event) => startPaneDrag("analyst", event)}
              onDragEnd={() => {
                draggedPane.current = null;
              }}
            >
              <h2 className={styles.offlineHeading}>Debrief</h2>
              {paneMoveButton("analyst")}
            </div>
            <p className={styles.offlineLine}>Analyst offline in this build</p>
            <p className={styles.offlineLine}>
              It answers when a model key or the mock mode is configured
            </p>
          </div>
        ) : mounted && analystReady ? (
          <AnalystSection key={raceId} variant="rail" />
        ) : (
          <div className={styles.analystHold} aria-hidden="true" />
        )}
      </div>
      </aside>
    </main>
  );
}
