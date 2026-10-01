// The service as a child of the app (the default; Settings → Service → Start at login hands it
// to launchd instead). The app is its supervisor, the way launchd's KeepAlive would be: it starts
// the daemon again when it exits (a restart onto new code, POST /service/restart, a crash) and
// stops it on quit. The daemon is told its supervisor's pid (HARNESS_SUPERVISOR_PID) so it can
// restart itself, and exits by itself if the app dies without stopping it.

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export interface ChildProcessHandle {
  pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
  /** Resolves with the exit code (null when a signal ended it). */
  exited: Promise<number | null>;
}

export type SpawnChild = (cmd: string[], env: NodeJS.ProcessEnv, logPath: string) => ChildProcessHandle;

/** Spawn with stdout and stderr appended to the service log, as launchd's StandardOutPath does. */
export const spawnChild: SpawnChild = (cmd, env, logPath) => {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  try {
    const child = nodeSpawn(cmd[0]!, cmd.slice(1), { env, stdio: ["ignore", fd, fd] });
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(-1));
    });
    return { pid: child.pid, kill: (s) => void child.kill(s), exited };
  } finally {
    closeSync(fd);
  }
};

export interface ChildServiceOptions {
  spawn?: SpawnChild;
  /** A run shorter than this counts as a crash on start. */
  minUptimeMs?: number;
  /** Crashes on start in a row before giving up. */
  maxQuickExits?: number;
  /** Wait between an exit and the next start. */
  respawnDelayMs?: number;
  /** SIGTERM, then SIGKILL after this long (the daemon needs up to ~25s to close Chrome). */
  stopTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class ChildService {
  private proc: ChildProcessHandle | null = null;
  private wanted = false;
  private quickExits = 0;
  private spec: { cmd: string[]; env: NodeJS.ProcessEnv; logPath: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Why it gave up starting the service again, until the next start(). */
  lastError: string | null = null;

  constructor(private o: ChildServiceOptions = {}) {}

  /** Started and not stopped (it may be between an exit and the next start). */
  get running() {
    return this.wanted;
  }

  get pid() {
    return this.proc?.pid;
  }

  start(cmd: string[], env: NodeJS.ProcessEnv, logPath: string) {
    this.spec = { cmd, env, logPath };
    this.wanted = true;
    this.quickExits = 0;
    this.lastError = null;
    if (!this.proc) this.launch();
  }

  private launch() {
    const spec = this.spec!;
    const started = Date.now();
    const proc = (this.o.spawn ?? spawnChild)(spec.cmd, spec.env, spec.logPath);
    this.proc = proc;
    void proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (!this.wanted) return;
      const quick = Date.now() - started < (this.o.minUptimeMs ?? 10_000);
      this.quickExits = quick ? this.quickExits + 1 : 0;
      if (this.quickExits >= (this.o.maxQuickExits ?? 5)) {
        this.wanted = false;
        this.lastError = `The service exited ${this.quickExits} times right after starting (last exit code ${code}).`;
        this.o.log?.(this.lastError);
        return;
      }
      this.o.log?.(`service exited (${code}); starting it again`);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.wanted && !this.proc) this.launch();
      }, this.o.respawnDelayMs ?? 1000);
    });
  }

  /** Stop it for good (quit, or handing the service to launchd). Resolves once it has exited. */
  async stop(): Promise<void> {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.terminate();
  }

  /** Stop it and start it again at once (Restart now, or a stuck service). */
  async restart(): Promise<void> {
    if (!this.spec) throw new Error("The service isn't running in the app.");
    await this.stop();
    this.start(this.spec.cmd, this.spec.env, this.spec.logPath);
  }

  private async terminate() {
    const proc = this.proc;
    if (!proc) return;
    proc.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forced = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), this.o.stopTimeoutMs ?? 30_000)));
    if ((await Promise.race([proc.exited, forced])) === "timeout") {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    clearTimeout(timer);
    if (this.proc === proc) this.proc = null;
  }
}
