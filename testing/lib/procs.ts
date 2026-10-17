// Every process the walkthrough starts is written to a per-run file, so a run that was killed
// outright (SIGKILL, a crash of the runner) leaves a record the next run can reap, and a run that
// ends normally, on SIGINT or on SIGTERM kills exactly what it started.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deferred, withDeadline } from "./wait";

export interface Tracked {
  pid: number;
  /** The process's own start time as `ps` prints it; guards against killing an unrelated process that reused the pid. */
  start: string;
  name: string;
}

export function processStart(pid: number): string | null {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? out : null;
}

/** Parse a run file: one JSON record per line; a torn last line (killed mid-write) is skipped. */
export function parseRecords(text: string): Tracked[] {
  const out: Tracked[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Tracked;
      if (Number.isInteger(r.pid) && typeof r.start === "string" && typeof r.name === "string") out.push(r);
    } catch {}
  }
  return out;
}

/** Of the records, those whose pid is alive and still the same process (same start time). */
export function stillRunning(records: Tracked[], startOf: (pid: number) => string | null = processStart): Tracked[] {
  return records.filter((r) => startOf(r.pid) === r.start);
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

/** SIGTERM, then SIGKILL for what is still running when `graceMs` is over. Waits on the processes exiting, not on a timer. */
export async function killRecords(records: Tracked[], graceMs = 3000, startOf: (pid: number) => string | null = processStart): Promise<void> {
  const live = stillRunning(records, startOf);
  for (const r of live) signal(r.pid, "SIGTERM");
  await Promise.all(
    live.map(async (r) => {
      // `exited` is an event for children of this process; for a record left by a dead run it's a liveness check.
      const gone = deferred<void>();
      const check = setInterval(() => {
        if (startOf(r.pid) !== r.start) gone.resolve();
      }, 50);
      try {
        await withDeadline(`${r.name} (pid ${r.pid}) to exit`, graceMs, gone.promise);
      } catch {
        if (startOf(r.pid) === r.start) signal(r.pid, "SIGKILL");
      } finally {
        clearInterval(check);
      }
    }),
  );
  // Members of a group outlive a leader that exited first (the group id is the leader's pid). A pid
  // that now belongs to another process (different start time) is left alone.
  for (const r of records) {
    if (startOf(r.pid) !== null) continue;
    try {
      process.kill(-r.pid, "SIGKILL");
    } catch {}
  }
}

export interface Owner {
  pid: number;
  start: string;
}

/** The first line of a run file names the process that owns it: its pid and start time. */
export function parseOwner(text: string): Owner | null {
  try {
    const o = (JSON.parse(text.split("\n")[0] ?? "") as { owner?: Owner }).owner;
    return o && Number.isInteger(o.pid) && typeof o.start === "string" ? o : null;
  } catch {
    return null;
  }
}

export class RunFile {
  constructor(readonly path: string, private owner: Owner = { pid: process.pid, start: processStart(process.pid) ?? "" }) {
    mkdirSync(join(path, ".."), { recursive: true });
  }

  add(record: Tracked): void {
    if (!existsSync(this.path)) appendFileSync(this.path, JSON.stringify({ owner: this.owner }) + "\n");
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }

  records(): Tracked[] {
    return existsSync(this.path) ? parseRecords(readFileSync(this.path, "utf8")) : [];
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}

/**
 * Kill what every earlier run file under `dir` still has running (a run that was killed outright), and
 * delete the files. A file whose owner is still running belongs to a live run and is left alone.
 */
export async function reapRuns(dir: string, except?: string, startOf: (pid: number) => string | null = processStart): Promise<Tracked[]> {
  if (!existsSync(dir)) return [];
  const reaped: Tracked[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (path === except || !name.endsWith(".pids")) continue;
    const owner = parseOwner(readFileSync(path, "utf8"));
    if (owner && startOf(owner.pid) === owner.start) continue;
    const file = new RunFile(path);
    const records = file.records();
    const live = stillRunning(records, startOf);
    await killRecords(records, 3000, startOf);
    reaped.push(...live);
    file.remove();
  }
  return reaped;
}

export interface Spawned {
  proc: ReturnType<typeof Bun.spawn>;
  /** Every line the process wrote to stdout or stderr so far. */
  lines: string[];
  /** Resolves with the first line (already written, or the next) the regexp matches; rejects at the deadline naming `what`. */
  line(match: RegExp, what: string, ms: number): Promise<RegExpMatchArray>;
}

/**
 * Start `cmd` in its own process group (so its children die with it), record it in `file`, and
 * collect its output as lines. Output is the event we wait on for readiness ("listening on …").
 */
export function spawnTracked(file: RunFile, name: string, cmd: string[], opts: { env?: Record<string, string | undefined>; cwd?: string } = {}): Spawned {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    // Bun has no setsid option: `detached` puts the child in a new process group.
    detached: true,
  } as never);
  const start = processStart(proc.pid) ?? "";
  file.add({ pid: proc.pid, start, name });
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      rest += decoder.decode(chunk, { stream: true });
      const parts = rest.split("\n");
      rest = parts.pop() ?? "";
      lines.push(...parts);
      for (const w of waiters.splice(0)) w();
    }
    if (rest) lines.push(rest);
    for (const w of waiters.splice(0)) w();
  };
  pump(proc.stdout as unknown as ReadableStream<Uint8Array>);
  pump(proc.stderr as unknown as ReadableStream<Uint8Array>);
  let exited = false;
  proc.exited.then(() => {
    exited = true;
    for (const w of waiters.splice(0)) w();
  });
  return {
    proc,
    lines,
    line(match, what, ms) {
      let cursor = 0;
      const found = (async () => {
        for (;;) {
          while (cursor < lines.length) {
            const m = lines[cursor++]!.match(match);
            if (m) return m;
          }
          if (exited) throw new Error(`${name} exited before ${what}; its output:\n${lines.slice(-20).join("\n")}`);
          await new Promise<void>((r) => waiters.push(r));
        }
      })();
      return withDeadline(what, ms, found, () => lines.slice(-5).join(" | "));
    },
  };
}
