// How a file (or the Spec tab) is shown: whether long lines wrap, and whether a markdown file shows its
// source or the rendered document. Wrap is remembered per file type; the menu rules say which items
// the "…" menu offers. The iPhone and iPad apps repeat the key rule in Swift (ViewOptions.swift) and
// both test it against viewOptions.fixtures.json.

/** What a file's wrap setting is stored under: its lowercased extension (".html"), or its lowercased name when it has none ("makefile", ".env"). */
export function wrapKey(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : name;
}

/** Files that have a rendered view (the Spec tab always does). */
export function hasRenderedView(path: string): boolean {
  const key = wrapKey(path);
  return key === ".md" || key === ".markdown";
}

/** The wrap key the Spec tab's source view uses: its text is markdown. */
export const SPEC_WRAP_KEY = ".md";

export type WrapPrefs = Record<string, boolean>;

/** Stored wrap settings; anything unreadable is "no settings". */
export function parseWrapPrefs(raw: string | null | undefined): WrapPrefs {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
  } catch {
    return {};
  }
}

export const serializeWrapPrefs = (prefs: WrapPrefs): string => JSON.stringify(prefs);

/** A wrapped file type is stored; an unwrapped one is dropped, so the store only holds what differs from the default. */
export function withWrap(prefs: WrapPrefs, key: string, wrap: boolean): WrapPrefs {
  const { [key]: _, ...rest } = prefs;
  return wrap ? { ...rest, [key]: true } : rest;
}

export interface ViewMenuInput {
  /** The Spec tab (else a file) */
  spec: boolean;
  /** The file's path (files only) */
  path?: string;
  /** Rendered is chosen */
  rendered: boolean;
  /** Spec only: Show changes is on */
  showChanges: boolean;
  /** Spec only: there is an earlier revision to compare with */
  canShowChanges: boolean;
}

export interface ViewMenu {
  /** The Source / Rendered items are offered */
  view: boolean;
  /** Source can be chosen (Show changes is a rendered view) */
  sourceEnabled: boolean;
  /** The Spec's Show changes item is offered */
  showChanges: boolean;
  /** The view on screen is rendered, whatever was chosen (Show changes forces it) */
  rendered: boolean;
  /** Wrap lines can be toggled: only the source wraps by choice (rendered text always wraps) */
  wrapEnabled: boolean;
}

export function viewMenu(input: ViewMenuInput): ViewMenu {
  const view = input.spec || (!!input.path && hasRenderedView(input.path));
  const changes = input.spec && input.showChanges && input.canShowChanges;
  const rendered = view && (input.rendered || changes);
  return { view, sourceEnabled: !changes, showChanges: input.spec && input.canShowChanges, rendered, wrapEnabled: !rendered };
}

/** A link in a rendered file, made relative to the file's own directory: `./b.md` in `docs/a.md` is `docs/b.md`. Links with a scheme, an anchor or a leading slash are left alone. */
export function resolveFileRelative(path: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//") || url.startsWith("/") || url.startsWith("#")) return url;
  const slash = path.lastIndexOf("/");
  return slash < 0 ? url : `${path.slice(0, slash + 1)}${url}`;
}
