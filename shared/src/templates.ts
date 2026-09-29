// Prompt templates (DESIGN.md "Prompt overrides"): the small language the built-in prompts and
// the user's overrides are written in. Dependency-free and shared, so the service validates on
// save and clients can show the same error while the user types.
//
//   {{name}}                               the variable's value
//   {{#if name}} … {{else if other}} … {{else}} … {{/if}}
//                                          truthy: a non-empty string, true, a non-zero number
//
// Text outside tags is copied exactly, whitespace and newlines included: no trimming around
// tags. Variable names are letters, digits and underscores, starting with a letter or "_".

export type TemplateValue = string | boolean | number;
export type TemplateVars = Record<string, TemplateValue>;

export type TemplateNode =
  | { type: "text"; text: string }
  | { type: "var"; name: string }
  | { type: "if"; name: string; then: TemplateNode[]; else: TemplateNode[] };

export class TemplateError extends Error {}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

interface Frame {
  node: Extract<TemplateNode, { type: "if" }>;
  inElse: boolean;
  /** Opened by `{{else if}}`: closed by the same `{{/if}}` as the frame below it */
  chained: boolean;
  line: number;
}

/** Parse a template. Throws TemplateError (with the line) for anything malformed. */
export function parseTemplate(src: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const stack: Frame[] = [];
  const out = (): TemplateNode[] => {
    const top = stack[stack.length - 1];
    return top ? (top.inElse ? top.node.else : top.node.then) : root;
  };
  let pos = 0;
  while (pos < src.length) {
    const open = src.indexOf("{{", pos);
    if (open === -1) {
      out().push({ type: "text", text: src.slice(pos) });
      break;
    }
    if (open > pos) out().push({ type: "text", text: src.slice(pos, open) });
    const close = src.indexOf("}}", open + 2);
    const line = lineOf(src, open);
    if (close === -1) throw new TemplateError(`Line ${line}: "{{" is never closed with "}}"`);
    const raw = src.slice(open, close + 2);
    const tag = src.slice(open + 2, close).trim();
    pos = close + 2;

    const ifMatch = /^#if\s+(\S+)$/.exec(tag);
    const elseIfMatch = /^else\s+if\s+(\S+)$/.exec(tag);
    if (ifMatch || elseIfMatch) {
      const name = (ifMatch ?? elseIfMatch)![1]!;
      if (!NAME.test(name)) throw new TemplateError(`Line ${line}: "${name}" in ${raw} isn't a variable name`);
      const node: Frame["node"] = { type: "if", name, then: [], else: [] };
      if (elseIfMatch) {
        const top = stack[stack.length - 1];
        if (!top) throw new TemplateError(`Line ${line}: ${raw} without an open {{#if}}`);
        if (top.inElse) throw new TemplateError(`Line ${line}: ${raw} after {{else}}`);
        top.inElse = true;
        top.node.else.push(node);
      } else {
        out().push(node);
      }
      stack.push({ node, inElse: false, chained: !!elseIfMatch, line });
    } else if (tag === "else") {
      const top = stack[stack.length - 1];
      if (!top) throw new TemplateError(`Line ${line}: {{else}} without an open {{#if}}`);
      if (top.inElse) throw new TemplateError(`Line ${line}: a second {{else}} in the same {{#if}}`);
      top.inElse = true;
    } else if (tag === "/if") {
      if (!stack.length) throw new TemplateError(`Line ${line}: {{/if}} without an open {{#if}}`);
      while (stack.pop()!.chained);
    } else if (NAME.test(tag)) {
      out().push({ type: "var", name: tag });
    } else {
      throw new TemplateError(`Line ${line}: ${raw} isn't a template tag (use {{name}}, {{#if name}}, {{else}}, {{else if name}} or {{/if}})`);
    }
  }
  const unclosed = stack.find((f) => !f.chained);
  if (unclosed) throw new TemplateError(`Line ${unclosed.line}: {{#if ${unclosed.node.name}}} is never closed with {{/if}}`);
  return root;
}

/** Every variable a parsed template reads, in first-use order. */
export function templateVariables(nodes: TemplateNode[]): string[] {
  const seen = new Set<string>();
  const walk = (list: TemplateNode[]) => {
    for (const n of list) {
      if (n.type === "var") seen.add(n.name);
      else if (n.type === "if") {
        seen.add(n.name);
        walk(n.then);
        walk(n.else);
      }
    }
  };
  walk(nodes);
  return [...seen];
}

/**
 * Why `src` can't be used as a template that may read only `allowed`, or null when it can.
 * Covers malformed tags and blocks and variables the prompt doesn't provide.
 */
export function templateError(src: string, allowed: readonly string[]): string | null {
  let nodes: TemplateNode[];
  try {
    nodes = parseTemplate(src);
  } catch (err) {
    return (err as Error).message;
  }
  const unknown = templateVariables(nodes).filter((v) => !allowed.includes(v));
  if (!unknown.length) return null;
  const list = unknown.map((v) => `{{${v}}}`).join(", ");
  const known = allowed.length ? `the variables are ${allowed.map((v) => `{{${v}}}`).join(", ")}` : "it has no variables";
  return `Unknown variable${unknown.length > 1 ? "s" : ""} ${list}: ${known}`;
}

function truthy(v: TemplateValue): boolean {
  return typeof v === "string" ? v !== "" : !!v;
}

/** Render a template. A variable the template reads that `vars` lacks is an error, not "". */
export function renderTemplate(template: string | TemplateNode[], vars: TemplateVars): string {
  const nodes = typeof template === "string" ? parseTemplate(template) : template;
  const value = (name: string): TemplateValue => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new TemplateError(`Missing template variable {{${name}}}`);
    return vars[name]!;
  };
  let s = "";
  const walk = (list: TemplateNode[]) => {
    for (const n of list) {
      if (n.type === "text") s += n.text;
      else if (n.type === "var") s += String(value(n.name));
      else walk(truthy(value(n.name)) ? n.then : n.else);
    }
  };
  walk(nodes);
  return s;
}
