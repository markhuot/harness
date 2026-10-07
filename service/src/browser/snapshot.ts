// browser_snapshot's text: a frame's accessibility tree (Accessibility.getFullAXTree), one line per
// node the agent can tell apart, each element with a ref the element tools take in place of a
// selector. Iframes nest their own frame's tree under them, however many processes deep.
//
//   - document "Checkout"
//     - heading "Pay" [ref=e2] level=1
//     - iframe "Secure card payment input frame" [ref=e3]
//       - document
//         - textbox "Card number" [ref=e5] value="4242 4242 4242 4242" (focused)
//     - button "Pay $10" [ref=e6] (disabled)

import type { CdpResult } from "./cdp.ts";

export const SNAPSHOT_DEFAULT_MAX_NODES = 1500;

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** What rendering needs from the tab: refs, and an iframe's own tree. */
export interface SnapshotHost {
  ref(backendNodeId: number): string;
  /** The lines of the frame an <iframe> node holds, already indented one level under it; a note when it has none. */
  child(backendNodeId: number, depth: number): Promise<string[]>;
}

/** Roles that only group or lay out: their children stand in for them (unless they have a name). */
const STRUCTURAL = new Set(["none", "generic", "presentation", "GenericContainer", "Section", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Div"]);
/** Nodes never shown: text boxes are their StaticText again, line breaks are layout. */
const HIDDEN = new Set(["InlineTextBox", "LineBreak"]);
const ROLE_NAMES: Record<string, string> = { RootWebArea: "document", WebArea: "document", Iframe: "iframe", IframePresentational: "iframe", StaticText: "text" };
/** States worth a word when they hold. */
const FLAGS = ["focused", "disabled", "required", "readonly", "multiselectable", "modal"];
const MAX_TEXT = 200;

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v === undefined || v === null ? "" : String(v));
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const quote = (s: string) => JSON.stringify(clip(s));

/** The node's states and level, as the line shows them: ["level=2"], ["checked", "disabled"]. */
function states(n: AxNode): { attrs: string[]; flags: string[] } {
  const attrs: string[] = [];
  const flags: string[] = [];
  for (const p of n.properties ?? []) {
    const v = p.value?.value;
    if (p.name === "level" && typeof v === "number") attrs.push(`level=${v}`);
    else if ((p.name === "checked" || p.name === "pressed") && (v === "true" || v === true)) flags.push(p.name);
    else if ((p.name === "checked" || p.name === "pressed") && v === "mixed") flags.push(`${p.name}=mixed`);
    else if ((p.name === "expanded" || p.name === "selected") && typeof v === "boolean") flags.push(v ? p.name : `not ${p.name}`);
    else if (p.name === "invalid" && v && v !== "false") flags.push("invalid");
    else if (FLAGS.includes(p.name) && v === true) flags.push(p.name);
  }
  return { attrs, flags };
}

/**
 * The tree as lines. `max` caps how many nodes it shows across every frame (the rest are counted
 * in a last line), so a huge page can't flood the agent.
 */
export async function renderAxTree(nodes: AxNode[], host: SnapshotHost, opts: { depth?: number; budget: { left: number; skipped: number } }): Promise<string[]> {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId)) ?? nodes[0];
  const lines: string[] = [];
  if (!root) return lines;

  const walk = async (n: AxNode, depth: number, parentText: string[]): Promise<void> => {
    const role = n.role?.value ?? "";
    if (HIDDEN.has(role)) return;
    const name = clean(n.name?.value);
    const children = async (d: number, texts: string[]) => {
      for (const id of n.childIds ?? []) {
        const c = byId.get(id);
        if (c) await walk(c, d, texts);
      }
    };
    if (n.ignored || (STRUCTURAL.has(role) && !name)) return children(depth, parentText);
    if (role === "StaticText") {
      // A heading's or a link's text is already its name, a field's its value.
      if (!name || parentText.includes(name)) return;
      if (opts.budget.left-- <= 0) return void opts.budget.skipped++;
      lines.push(`${"  ".repeat(depth)}- text: ${clip(name)}`);
      return;
    }
    if (opts.budget.left-- <= 0) {
      opts.budget.skipped++;
      return children(depth, parentText);
    }
    const shown = ROLE_NAMES[role] ?? role;
    const isDoc = shown === "document";
    const ref = !isDoc && n.backendDOMNodeId !== undefined ? ` [ref=${host.ref(n.backendDOMNodeId)}]` : "";
    const value = clean(n.value?.value);
    const { attrs, flags } = states(n);
    lines.push(
      `${"  ".repeat(depth)}- ${shown}${name ? ` ${quote(name)}` : ""}${ref}` +
        `${attrs.length ? ` ${attrs.join(" ")}` : ""}${value && value !== name ? ` value=${quote(value)}` : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`,
    );
    if (shown === "iframe" && n.backendDOMNodeId !== undefined) {
      lines.push(...(await host.child(n.backendDOMNodeId, depth + 1)));
      return;
    }
    await children(depth + 1, [name, value].filter(Boolean));
  };
  await walk(root, opts.depth ?? 0, []);
  return lines;
}

/** getFullAXTree's nodes, typed loosely. */
export const axNodes = (res: CdpResult): AxNode[] => (Array.isArray(res?.nodes) ? (res.nodes as AxNode[]) : []);
