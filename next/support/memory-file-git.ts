import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { DiffBase, FileGit } from "../../service/src/orchestrator/file-git";

/** What the file model needs from memory git's commit graph. */
export interface FileModelHost {
  /** The checkout holding `path` (its root and HEAD commit), or null outside every repository. */
  checkoutOf(path: string): { root: string; head: string | null } | null;
  /** A commit's first parent, or null. */
  parentOf(commit: string): string | null;
}

type Tree = Map<string, Uint8Array>;

/**
 * The files half of memory git: each commit's tree and each checkout's index live in memory, the
 * working tree is the real directory (tests write files with node:fs, as an agent would). Ignore
 * rules come from the .gitignore files on disk. It answers FileGit the way the git binary does for
 * the cases next/support/git-contract.ts pins (listings, porcelain codes, HEAD blobs, patches with
 * git's headers and hunks), not every corner of git.
 */
export function createMemoryFileGit(host: FileModelHost) {
  const trees = new Map<string, Tree>();
  const indexes = new Map<string, Tree>();

  /** A commit's tree: the one recorded for it, else its first parent's (commits made without files keep their parent's). */
  function treeOf(commit: string | null): Tree {
    for (let c = commit; c; c = host.parentOf(c)) {
      const t = trees.get(c);
      if (t) return t;
    }
    return new Map();
  }
  const indexOf = (co: { root: string; head: string | null }) => indexes.get(co.root) ?? treeOf(co.head);
  /** `path` (absolute or relative to `root`) as a "/"-separated path from the checkout root. */
  const repoPath = (co: { root: string }, abs: string) => relative(co.root, abs).split(sep).join("/");

  function readDisk(abs: string): Uint8Array | null {
    try {
      return statSync(abs).isFile() ? new Uint8Array(readFileSync(abs)) : null;
    } catch {
      return null;
    }
  }

  // --- .gitignore -------------------------------------------------------------------------------

  interface Rule {
    neg: boolean;
    dirOnly: boolean;
    anchored: boolean;
    re: RegExp;
  }
  function glob(p: string): string {
    let out = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i]!;
      if (c === "*" && p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else if (c === "*") out += "[^/]*";
      else if (c === "?") out += "[^/]";
      else if (c === "[") {
        const end = p.indexOf("]", i + 1);
        if (end === -1) out += "\\[";
        else {
          out += `[${p.slice(i + 1, end).replace(/^!/, "^")}]`;
          i = end;
        }
      } else if (c === "\\" && i + 1 < p.length) out += `\\${p[++i]}`;
      else out += c.replace(/[.+^${}()|\]\\]/g, "\\$&");
    }
    return out;
  }
  function rulesIn(dirAbs: string): Rule[] {
    let text: string;
    try {
      text = readFileSync(join(dirAbs, ".gitignore"), "utf8");
    } catch {
      return [];
    }
    const rules: Rule[] = [];
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/(?<!\\)\s+$/, "");
      if (!line || line.startsWith("#")) continue;
      const neg = line.startsWith("!");
      if (neg) line = line.slice(1);
      const dirOnly = line.endsWith("/");
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.includes("/");
      if (line.startsWith("/")) line = line.slice(1);
      rules.push({ neg, dirOnly, anchored, re: new RegExp(`^${glob(line)}$`) });
    }
    return rules;
  }
  /** Whether `path` (from the checkout root) is ignored by itself, not counting its folders. */
  function ignoredSelf(root: string, path: string, isDir: boolean): boolean {
    const segs = path.split("/");
    let verdict = false;
    for (let depth = 0; depth < segs.length; depth++) {
      const base = segs.slice(0, depth).join("/");
      const rel = segs.slice(depth).join("/");
      for (const r of rulesIn(join(root, base))) {
        if (r.dirOnly && !isDir) continue;
        if (r.re.test(r.anchored ? rel : segs[segs.length - 1]!)) verdict = !r.neg;
      }
    }
    return verdict;
  }
  /** Whether `path` is ignored, by itself or because a folder it's in is (git doesn't look inside an ignored folder). */
  function ignored(root: string, path: string, isDir: boolean): boolean {
    const segs = path.split("/");
    for (let i = 1; i < segs.length; i++) if (ignoredSelf(root, segs.slice(0, i).join("/"), true)) return true;
    return ignoredSelf(root, path, isDir);
  }

  // --- the working tree -------------------------------------------------------------------------

  /**
   * Walk the folder `dir` (from the checkout root, "" for the root): the untracked files that aren't
   * ignored into `plain`, the ignored ones into `ign` (an ignored folder once, as "dir/"). A folder
   * holding nothing but ignored entries is listed too, as git's `ls-files --directory` does.
   */
  function walk(root: string, dir: string, index: Tree, plain: string[], ign: string[]): { plain: boolean; ignored: boolean; tracked: boolean } {
    const seen = { plain: false, ignored: false, tracked: false };
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return seen;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ignoredSelf(root, path, true)) {
          ign.push(`${path}/`);
          seen.ignored = true;
          continue;
        }
        const at = ign.length;
        const sub = walk(root, path, index, plain, ign);
        if (sub.ignored && !sub.plain && !sub.tracked) ign.splice(at, 0, `${path}/`);
        seen.plain ||= sub.plain;
        seen.ignored ||= sub.ignored;
        seen.tracked ||= sub.tracked;
      } else if (index.has(path)) seen.tracked = true;
      else if (ignoredSelf(root, path, false)) {
        ign.push(path);
        seen.ignored = true;
      } else {
        plain.push(path);
        seen.plain = true;
      }
    }
    return seen;
  }

  // --- patches ----------------------------------------------------------------------------------

  const hex = (bytes: Uint8Array) => {
    const h = new Bun.CryptoHasher("sha1");
    h.update(`blob ${bytes.length}\0`);
    h.update(bytes);
    return h.digest("hex").slice(0, 7);
  };
  const lines = (bytes: Uint8Array) => new TextDecoder().decode(bytes).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const isBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);

  /** The edit script from `a` to `b` (longest common subsequence; a change's removals before its additions, as git prints them). */
  function edits(a: string[], b: string[]): { op: " " | "-" | "+"; line: string }[] {
    const n = a.length;
    const m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    const out: { op: " " | "-" | "+"; line: string }[] = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        out.push({ op: " ", line: a[i++]! });
        j++;
      } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ op: "-", line: a[i++]! });
      else out.push({ op: "+", line: b[j++]! });
    }
    return out;
  }
  function hunks(a: string[], b: string[], context = 3): string {
    const ops = edits(a, b);
    const changed = ops.map((o, k) => (o.op === " " ? -1 : k)).filter((k) => k >= 0);
    let text = "";
    let k = 0;
    while (k < changed.length) {
      let end = k;
      while (end + 1 < changed.length && changed[end + 1]! - changed[end]! - 1 <= context * 2) end++;
      const from = Math.max(0, changed[k]! - context);
      const to = Math.min(ops.length, changed[end]! + context + 1);
      let oldStart = 1;
      let newStart = 1;
      for (let x = 0; x < from; x++) {
        if (ops[x]!.op !== "+") oldStart++;
        if (ops[x]!.op !== "-") newStart++;
      }
      const slice = ops.slice(from, to);
      const oldCount = slice.filter((o) => o.op !== "+").length;
      const newCount = slice.filter((o) => o.op !== "-").length;
      const range = (start: number, count: number) => (count === 1 ? `${start}` : `${count ? start : start - 1},${count}`);
      // Like git's default funcname: the nearest line above the hunk that starts with a letter, _ or $.
      const above = a.slice(0, oldStart - 1).reverse().find((l) => /^[A-Za-z_$]/.test(l));
      const fn = above ? ` ${above.replace(/\s+$/, "").slice(0, 80)}` : "";
      text += `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@${fn}\n`;
      for (const o of slice) text += o.line.endsWith("\n") ? `${o.op}${o.line}` : `${o.op}${o.line}\n\\ No newline at end of file\n`;
      k = end + 1;
    }
    return text;
  }
  function patch(name: string, old: Uint8Array | null, now: Uint8Array | null, mode: string): string {
    if (old && now && Buffer.from(old).equals(Buffer.from(now))) return "";
    const tab = name.includes(" ") ? "\t" : "";
    let head = `diff --git a/${name} b/${name}\n`;
    if (!old) head += `new file mode ${mode}\nindex 0000000..${hex(now!)}\n`;
    else if (!now) head += `deleted file mode ${mode}\nindex ${hex(old)}..0000000\n`;
    else head += `index ${hex(old)}..${hex(now)} ${mode}\n`;
    const from = old ? `a/${name}` : "/dev/null";
    const to = now ? `b/${name}` : "/dev/null";
    if ((old && isBinary(old)) || (now && isBinary(now))) return `${head}Binary files ${from} and ${to} differ\n`;
    return `${head}--- ${from}${old ? tab : ""}\n+++ ${to}${now ? tab : ""}\n${hunks(old ? lines(old) : [], now ? lines(now) : [])}`;
  }
  function modeOf(abs: string): string {
    try {
      return statSync(abs).mode & 0o111 ? "100755" : "100644";
    } catch {
      return "100644";
    }
  }

  // --- the port ---------------------------------------------------------------------------------

  const port: FileGit = {
    async isRepo(path) {
      try {
        statSync(path);
      } catch {
        return false;
      }
      return !!host.checkoutOf(path);
    },
    async listFiles(root) {
      const co = host.checkoutOf(root);
      if (!co) return null;
      const prefix = repoPath(co, resolve(root));
      const under = (p: string) => !prefix || p.startsWith(`${prefix}/`);
      const strip = (p: string) => (prefix ? p.slice(prefix.length + 1) : p);
      const index = indexOf(co);
      const plain: string[] = [];
      const ign: string[] = [];
      walk(co.root, prefix, index, plain, ign);
      const files = [...new Set([...[...index.keys()].filter(under), ...plain])].map(strip).sort();
      return { files, ignored: ign.map(strip) };
    },
    async status(root, rel) {
      const co = host.checkoutOf(root);
      if (!co) return [];
      const abs = resolve(root, rel);
      const p = repoPath(co, abs);
      const inHead = treeOf(co.head).get(p);
      const inIndex = indexOf(co).get(p);
      const disk = readDisk(abs);
      if (!inHead && !inIndex) return disk ? [ignored(co.root, p, false) ? "!!" : "??"] : [];
      const same = (x: Uint8Array, y: Uint8Array) => Buffer.from(x).equals(Buffer.from(y));
      const x = inHead && !inIndex ? "D" : !inHead && inIndex ? "A" : inHead && inIndex && !same(inHead, inIndex) ? "M" : " ";
      const y = inIndex ? (!disk ? "D" : !same(inIndex, disk) ? "M" : " ") : " ";
      const codes = x + y === "  " ? [] : [x + y];
      if (!inIndex && disk) codes.push("??");
      return codes;
    },
    async hasHead(root) {
      return !!host.checkoutOf(root)?.head;
    },
    async headFile(root, rel, maxBytes) {
      const co = host.checkoutOf(root);
      if (!co?.head) return null;
      const blob = treeOf(co.head).get(repoPath(co, resolve(root, rel)));
      return blob && blob.length <= maxBytes ? blob : null;
    },
    async diff(root, rel, base: DiffBase, maxBytes) {
      const co = host.checkoutOf(root);
      if (!co) throw new Error("git diff failed: not a git repository");
      const abs = resolve(root, rel);
      const now = readDisk(abs);
      if (base === "untracked" && !now) throw new Error(`git diff failed: Could not access '${rel}'`);
      const old = base === "head" ? treeOf(co.head).get(repoPath(co, abs)) ?? null : null;
      const bytes = new TextEncoder().encode(old || now ? patch(rel, old, now, modeOf(abs)) : "");
      return bytes.length > maxBytes ? { patch: new Uint8Array(0), tooLarge: true } : { patch: bytes, tooLarge: false };
    },
  };

  return {
    port,
    /** `git add` of `paths` (relative to `dir`; every file under `dir` that isn't ignored when none): the index takes what's on disk, a missing file leaves it. */
    stage(dir: string, paths: string[]) {
      const co = host.checkoutOf(dir);
      if (!co) throw new Error(`fatal: not a git repository: ${dir}`);
      const index = new Map(indexOf(co));
      const prefix = repoPath(co, resolve(dir));
      let targets = paths.map((p) => repoPath(co, resolve(dir, p)));
      if (!targets.length) {
        const plain: string[] = [];
        walk(co.root, prefix, index, plain, []);
        const tracked = [...index.keys()].filter((p) => !prefix || p.startsWith(`${prefix}/`));
        targets = [...tracked, ...plain];
      }
      for (const p of targets) {
        const bytes = readDisk(join(co.root, p));
        if (bytes) index.set(p, bytes);
        else index.delete(p);
      }
      indexes.set(co.root, index);
    },
    /** Record the checkout's index as `commit`'s tree (the commit memory git just made for it). */
    commitIndex(checkoutRoot: string, previousHead: string | null, commit: string) {
      trees.set(commit, indexes.get(checkoutRoot) ?? treeOf(previousHead));
      indexes.delete(checkoutRoot);
    },
  };
}
