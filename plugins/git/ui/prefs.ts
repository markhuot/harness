// Changes tab view preferences kept in localStorage. Every ticket's plugin iframe is served from the
// same service origin, so these carry over from one ticket to the next. Storage can be missing or
// throw (sandboxed or private contexts); reads then fall back to "no preference" and writes are dropped.
export type DiffStyle = "unified" | "split";
type Store = Pick<Storage, "getItem" | "setItem">;

export const STYLE_KEY = "harness.git.diffStyle";
export const SIDEBAR_KEY = "harness.git.sidebarCollapsed";

const local = (): Store => localStorage;

function read(key: string, store: () => Store): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string, store: () => Store) {
  try {
    store().setItem(key, value);
  } catch {}
}

/** The diff style the user picked, or null when they haven't picked one (or it's unreadable). */
export function readStyle(store = local): DiffStyle | null {
  const v = read(STYLE_KEY, store);
  return v === "split" || v === "unified" ? v : null;
}

export const saveStyle = (s: DiffStyle, store = local) => write(STYLE_KEY, s, store);

/** Whether the docked file sidebar is collapsed. Anything but an explicit "1" means expanded. */
export function readSidebarCollapsed(store = local): boolean {
  return read(SIDEBAR_KEY, store) === "1";
}

export const saveSidebarCollapsed = (collapsed: boolean, store = local) => write(SIDEBAR_KEY, collapsed ? "1" : "0", store);
