// Fenced code in agent messages: which Shiki language a fence's info string names, whether a block
// is a unified diff, and a patch cleaned up enough for @pierre/diffs to parse. Agents write diffs by
// hand, so hunk headers are often missing, bare (`@@ @@`) or miscounted; normalizePatch recounts them.

/** Fence names agents use that Shiki spells differently. Anything else passes through lowercased. */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellsession",
  terminal: "shellsession",
  yml: "yaml",
  py: "python",
  python3: "python",
  rb: "ruby",
  rs: "rust",
  golang: "go",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  objc: "objective-c",
  md: "markdown",
  mdx: "mdx",
  htm: "html",
  svg: "xml",
  plist: "xml",
  ps1: "powershell",
  pwsh: "powershell",
  dockerfile: "docker",
  containerfile: "docker",
  jsonl: "json",
  json5: "json5",
  tf: "hcl",
  hcl: "hcl",
  proto: "protobuf",
  vue: "vue",
  blade: "blade",
  env: "dotenv",
  ini: "ini",
  conf: "ini",
  toml: "toml",
  gql: "graphql",
  patch: "diff",
  udiff: "diff",
  text: "text",
  txt: "text",
  plain: "text",
  plaintext: "text",
  output: "text",
  log: "text",
};

/** The Shiki language for a fence's info string (`ts`, `YAML`, ``) — "text" when it names none. */
export function codeLanguage(fence: string): string {
  const name = fence.trim().toLowerCase();
  if (!name) return "text";
  return ALIASES[name] ?? name;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const LOOSE_HUNK = /^@@(?:\s+-?(\d+)?(?:,\d+)?)?(?:\s+\+?(\d+)?(?:,\d+)?)?\s*@@(.*)$/;

/** Whether `lines[i]` starts a file header: `diff --git`, or `--- x` directly followed by `+++ y`. */
function fileHeaderAt(lines: string[], i: number): boolean {
  const l = lines[i]!;
  return l.startsWith("diff --git ") || (l.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ "));
}

/** Whether an untagged block reads as a unified diff: a real `@@ -a,b +c,d @@` hunk or a file header. */
export function looksLikeDiff(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.some((l, i) => HUNK.test(l) || fileHeaderAt(lines, i));
}

/** How to show a fenced block: as a diff (tagged `diff`/`patch`, or untagged and diff-shaped) or as code. */
export function codeKind(fence: string, text: string): "diff" | "code" {
  const lang = codeLanguage(fence);
  if (lang === "diff") return "diff";
  return fence.trim() === "" && looksLikeDiff(text) ? "diff" : "code";
}

/** A `---` / `+++` path without its a/ b/ prefix or trailing timestamp; null for /dev/null. */
function headerPath(line: string): string | null {
  const p = line.slice(4).split("\t")[0]!.trim();
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/**
 * A diff block as a patch @pierre/diffs parses: file headers added when missing, a `diff --git`
 * line before each `---` / `+++` pair that lacks one (so files are named without a/ b/), a hunk
 * header added when there's none, and every hunk header rewritten with the counts of the lines
 * under it. Context lines missing their leading space get one.
 */
export function normalizePatch(text: string, name = "snippet"): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const out: string[] = [];
  let i = 0;
  // With a file header, anything before it (a commit message) is kept as is. Without one we add a
  // header, and lines before the first hunk header (or all of them) become a hunk of their own.
  if (!lines.some((_, k) => fileHeaderAt(lines, k))) {
    if (!LOOSE_HUNK.test(lines[0]!)) lines.unshift("@@ @@");
    lines.unshift(`--- a/${name}`, `+++ b/${name}`);
  }
  let nextOld = 1;
  let nextNew = 1;
  let git = false; // inside a `diff --git` header
  while (i < lines.length) {
    const line = lines[i]!;
    const m = LOOSE_HUNK.exec(line);
    if (!m) {
      // File headers and metadata between hunks.
      if (line.startsWith("diff --git ")) git = true;
      if (fileHeaderAt(lines, i)) {
        nextOld = nextNew = 1;
        if (!git && line.startsWith("--- ")) {
          const path = headerPath(line) ?? headerPath(lines[i + 1]!) ?? name;
          out.push(`diff --git a/${path} b/${path}`);
        }
      }
      out.push(line);
      i++;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !LOOSE_HUNK.test(lines[end]!) && !fileHeaderAt(lines, end)) end++;
    const oldStart = m[1] ? Number(m[1]) : nextOld;
    const newStart = m[2] ? Number(m[2]) : nextNew;
    const body = hunk(lines.slice(i + 1, end), oldStart, newStart, m[3] ?? "");
    out.push(...body);
    git = false;
    const counts = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(body[0]!)!;
    nextOld = oldStart + Number(counts[1]);
    nextNew = newStart + Number(counts[2]);
    i = end;
  }
  return out.join("\n") + "\n";
}

/** One hunk: its header with recounted lines, then its body with context lines made explicit. */
function hunk(body: string[], oldStart: number, newStart: number, context: string): string[] {
  let del = 0;
  let add = 0;
  const lines = body.map((l) => {
    const c = l[0];
    if (c === "-") del++;
    else if (c === "+") add++;
    else if (c === "\\") return l;
    else {
      del++;
      add++;
      return c === " " ? l : " " + l;
    }
    return l;
  });
  return [`@@ -${oldStart},${del} +${newStart},${add} @@${context}`, ...lines];
}
