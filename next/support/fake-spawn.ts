// Stand-ins for the processes a WatcherRunner spawns (its `spawn: SpawnFn` seam). The process itself
// is the OS's; what the tests check is what the runner does with one: the argv it builds, how it
// batches stdout, what it reports from stderr and exit codes, when it restarts, and that it kills.

import type { Watcher } from "@harness/shared";
import type { SpawnFn, SpawnedProcess } from "../../service/src/orchestrator/watchers";

const enc = new TextEncoder();

/** A process driven by the test: write to its pipes, then exit it (or let the runner kill it). */
export class FakeProc implements SpawnedProcess {
  /** How many times the runner called kill() */
  kills = 0;
  private out!: ReadableStreamDefaultController<Uint8Array>;
  private err!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number) => void;
  private closed = false;
  readonly stdout = new ReadableStream<Uint8Array>({ start: (c) => void (this.out = c) });
  readonly stderr = new ReadableStream<Uint8Array>({ start: (c) => void (this.err = c) });
  readonly exited = new Promise<number>((r) => (this.resolveExit = r));
  readonly startedAt = Date.now();

  constructor(
    readonly cmd: string,
    readonly args: string[],
    readonly opts: { cwd?: string; env?: Record<string, string> },
  ) {}

  get killed() {
    return this.kills > 0;
  }
  get done() {
    return this.closed;
  }
  write(text: string) {
    if (!this.closed) this.out.enqueue(enc.encode(text));
  }
  line(obj: unknown) {
    this.write(JSON.stringify(obj) + "\n");
  }
  writeErr(text: string) {
    if (!this.closed) this.err.enqueue(enc.encode(text));
  }
  exit(code: number) {
    if (this.closed) return;
    this.closed = true;
    this.out.close();
    this.err.close();
    this.resolveExit(code);
  }
  kill() {
    this.kills++;
    this.exit(143);
  }
}

/**
 * A SpawnFn whose processes are FakeProcs, each handed to `script` (with its index) a microtask after
 * the spawn, the way a real process starts printing after spawn returns. A script that does nothing
 * leaves the process running until the test exits it or the runner kills it.
 */
export function fakeSpawn(script: (p: FakeProc, n: number) => void | Promise<void> = () => {}) {
  const procs: FakeProc[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const p = new FakeProc(cmd, args, opts);
    procs.push(p);
    queueMicrotask(() => void script(p, procs.length - 1));
    return p;
  };
  /** Processes the runner started and hasn't killed or seen exit */
  const live = () => procs.filter((p) => !p.done);
  return { spawn, procs, live };
}

/** A process that prints `stdout` (and `stderr`), then exits with `code`. */
export function printAndExit(stdout: string, code = 0, stderr = ""): (p: FakeProc) => void {
  return (p) => {
    if (stdout) p.write(stdout);
    if (stderr) p.writeErr(stderr);
    p.exit(code);
  };
}

/** A watcher row with test defaults: loop mode, enabled, a command line. */
export function watcher(patch: Partial<Watcher> = {}): Watcher {
  return {
    id: "w1",
    name: "test",
    command: "watch",
    args: [],
    prompt: "",
    cwd: null,
    env: {},
    mode: "loop",
    intervalSec: 60,
    enabled: true,
    driver: null,
    lastRunAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Watcher;
}
