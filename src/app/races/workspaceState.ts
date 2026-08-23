export const WORKSPACE_STORAGE_KEY = "layline-races-workspace-v1";
export const WORKSPACE_COOKIE_KEY = "layline-races-workspace-v1";

export const RAIL_MIN = 220;
export const RAIL_MAX = 400;
export const ANALYST_MIN = 320;
export const ANALYST_MAX = 520;
export const VIEWER_MIN = 560;
export const HANDLE_TOTAL = 24;

export type PaneSide = "left" | "right";

export interface WorkspacePreferences {
  pinned: string[];
  archived: string[];
  railWidth: number | null;
  analystWidth: number | null;
  railSide: PaneSide;
  railCollapsed: boolean;
}

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  pinned: [],
  archived: [],
  railWidth: null,
  analystWidth: null,
  railSide: "left",
  railCollapsed: false,
};

export function raceMatchesSearch(
  row: { name: string; venue: string; dateLabel: string },
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return `${row.name} ${row.venue} ${row.dateLabel}`.toLocaleLowerCase().includes(needle);
}

export function sortPinnedRows<T extends { id: string }>(
  rows: readonly T[],
  pinned: ReadonlySet<string>,
): T[] {
  return [
    ...rows.filter((row) => pinned.has(row.id)),
    ...rows.filter((row) => !pinned.has(row.id)),
  ];
}

function storedWidth(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(max, Math.max(min, value)));
}

function shippedIds(value: unknown, validIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function sanitizeWorkspacePreferences(
  value: unknown,
  validIds: ReadonlySet<string>,
): WorkspacePreferences {
  if (typeof value !== "object" || value === null) return DEFAULT_WORKSPACE_PREFERENCES;
  const stored = value as Record<string, unknown>;
  return {
    pinned: shippedIds(stored.pinned, validIds),
    archived: shippedIds(stored.archived, validIds),
    railWidth: storedWidth(stored.railWidth, RAIL_MIN, RAIL_MAX),
    analystWidth: storedWidth(stored.analystWidth, ANALYST_MIN, ANALYST_MAX),
    railSide: stored.railSide === "right" ? "right" : "left",
    railCollapsed: stored.railCollapsed === true,
  };
}

export function parseWorkspacePreferences(
  raw: string | undefined | null,
  validIds: ReadonlySet<string>,
): WorkspacePreferences {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_WORKSPACE_PREFERENCES;
  try {
    const decoded = raw.includes("%") ? decodeURIComponent(raw) : raw;
    return sanitizeWorkspacePreferences(JSON.parse(decoded), validIds);
  } catch {
    return DEFAULT_WORKSPACE_PREFERENCES;
  }
}

export function defaultPaneWidth(pane: "rail" | "analyst", viewportWidth: number): number {
  if (pane === "rail") return viewportWidth >= 1600 ? 280 : 220;
  return viewportWidth >= 1600 ? 380 : 340;
}

export function clampPaneWidth({
  pane,
  requested,
  workspaceWidth,
  otherWidth,
  otherCollapsed = false,
}: {
  pane: "rail" | "analyst";
  requested: number;
  workspaceWidth: number;
  otherWidth: number;
  otherCollapsed?: boolean;
}): number {
  const min = pane === "rail" ? RAIL_MIN : ANALYST_MIN;
  const max = pane === "rail" ? RAIL_MAX : ANALYST_MAX;
  const room = workspaceWidth - (otherCollapsed ? 0 : otherWidth) - VIEWER_MIN - HANDLE_TOTAL;
  return Math.round(Math.min(max, Math.max(min, Math.min(requested, room))));
}
