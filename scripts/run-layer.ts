// Runs one layer command for `bun run verify` and `bun run nightly`: captures its output, gives it a
// time limit, and forwards SIGINT/SIGTERM to it. The command runs in its own process group so a kill
// reaches the children it started (the walkthrough, the snapshot runner) and they release the simulator
// lock instead of outliving whoever killed us.

export const DEFAULT_LAYER_TIMEOUT_MS = 45 * 60 * 1000;
// Longer than the test daemon's own 5 s exit-hook grace, so a check finishes its cleanup before the group is SIGKILLed.
const KILL_GRACE_MS = 10000;

/** The per-layer time limit: HARNESS_LAYER_TIMEOUT_MS when it is a positive number, else 45 minutes. */
export function layerTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.HARNESS_LAYER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LAYER_TIMEOUT_MS;
}

export interface RunResult {
  code: number;
  output: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Called with each chunk of output as it arrives. */
  onOutput?: (text: string) => void;
}

const active = new Set<number>();
let installed = false;
/** Set once SIGINT/SIGTERM arrived: the exit code to leave with as soon as the running layers are gone. */
let dying: number | null = null;

/** Signals the command's process group. Never a bare pid: once the leader is reaped, its pid may belong to someone else. */
function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

function installForwarding() {
  if (installed) return;
  installed = true;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(signal, () => {
      dying = code;
      if (!active.size) process.exit(code);
      for (const pid of active) killGroup(pid, signal);
      // Give the layers a moment to clean up (simulator locks, daemons), then leave. runCommand
      // exits as soon as the last layer is gone, so the rest of the run never starts.
      setTimeout(() => {
        for (const pid of active) killGroup(pid, "SIGKILL");
        process.exit(code);
      }, KILL_GRACE_MS).unref();
    });
  }
}

export async function runCommand(cmd: string[], opts: RunOptions): Promise<RunResult> {
  installForwarding();
  const timeoutMs = opts.timeoutMs ?? layerTimeoutMs();
  let output = "";
  let timedOut = false;
  let pid: number | undefined;
  try {
    const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
    pid = proc.pid;
    active.add(pid);
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(proc.pid, "SIGTERM");
      hardKill = setTimeout(() => killGroup(proc.pid, "SIGKILL"), KILL_GRACE_MS);
      hardKill.unref();
    }, timeoutMs);
    const pump = async (s: ReadableStream<Uint8Array>) => {
      for await (const chunk of s) {
        const text = Buffer.from(chunk).toString();
        output += text;
        opts.onOutput?.(text);
      }
    };
    try {
      // The pipes can stay open after the leader exits (a grandchild inherited them): once it has
      // exited, kill what is left in its group, then drain whatever output remains.
      const pumped = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
      const code = await proc.exited;
      killGroup(proc.pid, "SIGKILL");
      await pumped;
      if (timedOut) {
        output += `\n${cmd[0]} timed out after ${Math.round(timeoutMs / 1000)}s and was killed (HARNESS_LAYER_TIMEOUT_MS sets the limit)\n`;
        return { code: code || 124, output, timedOut };
      }
      return { code, output, timedOut };
    } finally {
      clearTimeout(timer);
      clearTimeout(hardKill);
      // Anything the command left running in its group goes with it.
      killGroup(proc.pid, "SIGKILL");
    }
  } catch (e) {
    return { code: 127, output: `${cmd[0]} could not run: ${(e as Error).message}`, timedOut: false };
  } finally {
    if (pid !== undefined) active.delete(pid);
    if (dying !== null && !active.size) process.exit(dying);
  }
}
