// Native file/shell tools, for drivers without their own (dummy, anthropic-api).
// Paths resolve relative to the run's cwd.

import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { ToolContext, ToolResult } from "./types";
import { defineTool, errorResult, schema, truncateMiddle } from "./util";

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
export const BASH_MAX_OUTPUT_CHARS = 30_000;
export const READ_DEFAULT_LIMIT = 2000;
export const READ_MAX_LINE_CHARS = 2000;
export const LIST_MAX_RESULTS = 1000;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Resolve a tool-supplied path against the run cwd (supports ~ and absolute paths). */
export function resolvePath(ctx: Pick<ToolContext, "cwd">, p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(ctx.cwd, p);
}

/**
 * Ask the PermissionGate (via ops.checkPermission) whether this call may run under the
 * ticket's permission mode. Returns an error result to hand back to the model when denied.
 */
async function gated(ctx: ToolContext, tool: string, input: unknown): Promise<ToolResult | null> {
  const decision = await ctx.ops.checkPermission(ctx, tool, input);
  return decision.behavior === "allow" ? null : errorResult(decision.message);
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

async function readStream(stream: ReadableStream<Uint8Array> | null | undefined, sink: { text: string; limit: number }) {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Keep memory bounded for runaway output: retain at most 4x the output cap.
      sink.text += decoder.decode(value, { stream: true });
      if (sink.text.length > sink.limit * 4) {
        sink.text = sink.text.slice(0, sink.limit * 2) + sink.text.slice(sink.text.length - sink.limit * 2);
      }
    }
  } catch {
    // stream torn down after kill
  } finally {
    reader.releaseLock();
  }
}

function killTree(proc: { pid: number; kill(sig?: number | NodeJS.Signals): void }, sig: NodeJS.Signals) {
  try {
    // detached → the child leads its own process group; kill the whole group
    process.kill(-proc.pid, sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

export const bash = defineTool<{ command: string; timeout_ms?: number }>({
  name: "bash",
  group: "native",
  description: `Run a shell command with bash in the ticket's working directory and return its combined stdout/stderr and exit code. Each call is a fresh shell (cd and exported variables don't persist between calls). Default timeout ${BASH_DEFAULT_TIMEOUT_MS / 1000}s, max ${BASH_MAX_TIMEOUT_MS / 1000}s. Output longer than ${BASH_MAX_OUTPUT_CHARS} characters is truncated in the middle. Don't start long-running servers in the foreground; background them with nohup/& and redirect output to a file.`,
  inputSchema: schema(
    {
      command: { type: "string", minLength: 1, description: "The command to run, e.g. \"bun test\" or \"git status\"." },
      timeout_ms: { type: "integer", minimum: 1, maximum: BASH_MAX_TIMEOUT_MS, description: `Timeout in milliseconds (default ${BASH_DEFAULT_TIMEOUT_MS}).` },
    },
    ["command"],
  ),
  async run({ command, timeout_ms }, ctx) {
    if (ctx.signal.aborted) return errorResult("Run was cancelled before the command started.");
    const denied = await gated(ctx, "bash", timeout_ms === undefined ? { command } : { command, timeout_ms });
    if (denied) return denied;
    if (ctx.signal.aborted) return errorResult("Run was cancelled before the command started.");
    const timeout = Math.min(timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS);
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: ctx.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" },
      detached: true,
    });
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      killTree(proc, "SIGTERM");
      setTimeout(() => killTree(proc, "SIGKILL"), 1000).unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    // Interleave stdout and stderr in arrival order into one buffer.
    const out = { text: "", limit: BASH_MAX_OUTPUT_CHARS };
    const reading = Promise.all([readStream(proc.stdout, out), readStream(proc.stderr, out)]);
    const exitCode = await proc.exited;
    // Background grandchildren may hold the pipes open; don't wait for them forever.
    await Promise.race([reading, Bun.sleep(timedOut || aborted ? 200 : 2000)]);
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);

    let output = truncateMiddle(out.text.replace(/\s+$/, ""), BASH_MAX_OUTPUT_CHARS);
    if (output === "") output = "(no output)";
    if (timedOut) return errorResult(`${output}\n\nCommand timed out after ${timeout}ms and was killed.`);
    if (aborted) return errorResult(`${output}\n\nCommand was cancelled.`);
    if (exitCode !== 0) return errorResult(`${output}\n\nExit code: ${exitCode}`);
    return `${output}\n\nExit code: 0`;
  },
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export const readFile = defineTool<{ path: string; offset?: number; limit?: number }>({
  name: "read_file",
  group: "native",
  description: `Read a file. Returns lines prefixed with their 1-based line number and a tab (like cat -n). Reads up to ${READ_DEFAULT_LIMIT} lines by default; use offset (1-based first line) and limit to page through large files. Lines longer than ${READ_MAX_LINE_CHARS} characters are cut. Image files (png, jpg, gif, webp) are returned as images.`,
  inputSchema: schema(
    {
      path: { type: "string", minLength: 1, description: "File path, absolute or relative to the working directory." },
      offset: { type: "integer", minimum: 1, description: "1-based line number to start at (default 1)." },
      limit: { type: "integer", minimum: 1, description: `Maximum number of lines to return (default ${READ_DEFAULT_LIMIT}).` },
    },
    ["path"],
  ),
  async run({ path, offset, limit }, ctx) {
    const denied = await gated(ctx, "read_file", { path });
    if (denied) return denied;
    const abs = resolvePath(ctx, path);
    const file = Bun.file(abs);
    let info;
    try {
      info = await stat(abs);
    } catch {
      return errorResult(`File not found: ${abs}`);
    }
    if (info.isDirectory()) return errorResult(`${abs} is a directory. Use list_files to see its contents.`);

    const mime = IMAGE_TYPES[extname(abs).toLowerCase()];
    if (mime) {
      const data = Buffer.from(await file.arrayBuffer()).toString("base64");
      return { content: [{ type: "image", data, mimeType: mime }] };
    }

    const text = await file.text();
    if (text.length === 0) return `(${abs} is empty)`;
    if (text.includes("\u0000")) return errorResult(`${abs} looks like a binary file (${info.size} bytes); not shown.`);

    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const start = (offset ?? 1) - 1;
    const count = limit ?? READ_DEFAULT_LIMIT;
    if (start >= lines.length) return errorResult(`offset ${offset} is past the end of ${abs} (${lines.length} lines).`);
    const slice = lines.slice(start, start + count);
    const width = String(start + slice.length).length;
    const body = slice
      .map((line, i) => {
        const cut = line.length > READ_MAX_LINE_CHARS ? `${line.slice(0, READ_MAX_LINE_CHARS)}… [line truncated]` : line;
        return `${String(start + i + 1).padStart(Math.max(width, 6))}\t${cut}`;
      })
      .join("\n");
    const end = start + slice.length;
    const more = end < lines.length ? `\n\n[showing lines ${start + 1}-${end} of ${lines.length}; use offset=${end + 1} to read more]` : "";
    return body + more;
  },
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export const writeFile = defineTool<{ path: string; content: string }>({
  name: "write_file",
  group: "native",
  description: "Create or overwrite a file with the given content. Parent directories are created as needed. Prefer edit_file for changing part of an existing file.",
  inputSchema: schema(
    {
      path: { type: "string", minLength: 1, description: "File path, absolute or relative to the working directory." },
      content: { type: "string", description: "The complete new file content." },
    },
    ["path", "content"],
  ),
  async run({ path, content }, ctx) {
    const denied = await gated(ctx, "write_file", { path, content });
    if (denied) return denied;
    const abs = resolvePath(ctx, path);
    try {
      if ((await stat(abs)).isDirectory()) return errorResult(`${abs} is a directory.`);
    } catch {
      /* does not exist yet */
    }
    await mkdir(dirname(abs), { recursive: true });
    const bytes = await Bun.write(abs, content);
    return `Wrote ${bytes} bytes to ${abs}.`;
  },
});

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const editFile = defineTool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }>({
  name: "edit_file",
  group: "native",
  description:
    "Replace an exact string in a file. old_string must match the file exactly (including whitespace and indentation) and must occur exactly once, unless replace_all is true, in which case every occurrence is replaced. If it occurs more than once, include more surrounding lines to make it unique. Read the file first.",
  inputSchema: schema(
    {
      path: { type: "string", minLength: 1, description: "File path, absolute or relative to the working directory." },
      old_string: { type: "string", description: "Exact text to find. Must be non-empty." },
      new_string: { type: "string", description: "Replacement text (must differ from old_string)." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
    },
    ["path", "old_string", "new_string"],
  ),
  async run({ path, old_string, new_string, replace_all }, ctx) {
    const denied = await gated(ctx, "edit_file", replace_all === undefined ? { path, old_string, new_string } : { path, old_string, new_string, replace_all });
    if (denied) return denied;
    const abs = resolvePath(ctx, path);
    if (old_string === "") return errorResult("old_string must not be empty. Use write_file to create a file.");
    if (old_string === new_string) return errorResult("old_string and new_string are identical; nothing to change.");
    const file = Bun.file(abs);
    if (!(await file.exists())) return errorResult(`File not found: ${abs}`);
    const text = await file.text();
    const count = countOccurrences(text, old_string);
    if (count === 0) return errorResult(`old_string was not found in ${abs}. It must match exactly, including whitespace; read the file again.`);
    if (count > 1 && !replace_all) {
      return errorResult(`old_string occurs ${count} times in ${abs}. Add surrounding context to make it unique, or set replace_all to true.`);
    }
    // split/join avoids String.replace's special $-patterns in new_string
    const updated = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
    await Bun.write(abs, updated);
    return replace_all ? `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${abs}.` : `Edited ${abs}.`;
  },
});

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set(["node_modules", ".git"]);

function isIgnored(rel: string): boolean {
  return rel.split("/").some((seg) => IGNORED_DIRS.has(seg));
}

export const listFiles = defineTool<{ path?: string; pattern?: string }>({
  name: "list_files",
  group: "native",
  description: `List files under a directory, optionally filtered by a glob pattern (e.g. "**/*.ts", "src/**/test*.js"). Without a pattern, lists the directory's immediate entries (directories end with "/"). Paths are relative to the listed directory. node_modules and .git are skipped. Returns at most ${LIST_MAX_RESULTS} results.`,
  inputSchema: schema({
    path: { type: "string", description: "Directory to list, absolute or relative to the working directory (default: the working directory)." },
    pattern: { type: "string", description: "Glob pattern relative to path, e.g. \"**/*.ts\"." },
  }),
  async run({ path, pattern }, ctx) {
    const denied = await gated(ctx, "list_files", { path: path ?? "." });
    if (denied) return denied;
    const dir = resolvePath(ctx, path ?? ".");
    try {
      if (!(await stat(dir)).isDirectory()) return errorResult(`${dir} is not a directory.`);
    } catch {
      return errorResult(`Directory not found: ${dir}`);
    }

    let entries: string[];
    if (!pattern) {
      const dirents = await readdir(dir, { withFileTypes: true });
      entries = dirents.filter((d) => !IGNORED_DIRS.has(d.name)).map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
    } else {
      entries = [];
      const glob = new Bun.Glob(pattern);
      for await (const file of glob.scan({ cwd: dir, onlyFiles: true, dot: true, followSymlinks: false })) {
        if (isIgnored(file)) continue;
        entries.push(file);
        if (entries.length > LIST_MAX_RESULTS * 5) break;
      }
    }
    entries.sort();
    if (entries.length === 0) return pattern ? `No files match ${pattern} in ${dir}.` : `${dir} is empty.`;
    const shown = entries.slice(0, LIST_MAX_RESULTS);
    const rel = relative(ctx.cwd, dir);
    const header = `${rel === "" ? "." : rel.startsWith("..") ? dir : rel}:`;
    const more = entries.length > LIST_MAX_RESULTS ? `\n[${entries.length - LIST_MAX_RESULTS}+ more not shown; narrow the pattern]` : "";
    return `${header}\n${shown.join("\n")}${more}`;
  },
});

export const nativeTools = [bash, readFile, writeFile, editFile, listFiles];
export const readOnlyNativeTools = [readFile, listFiles, bash];
