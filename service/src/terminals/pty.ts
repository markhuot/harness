// The PTY, behind one function so tests can fake it. The default runs the shell with Bun's
// built-in `Bun.spawn({ terminal })` (Bun 1.3.5+), which works under `bun run` and in the compiled
// `harness-service` binary, so no native addon is needed.

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnPtyOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  onData(data: Uint8Array): void;
  onExit(exit: { exitCode: number | null; signal: string | null }): void;
}

export type SpawnPty = (file: string, args: string[], opts: SpawnPtyOptions) => PtyProcess;

export const spawnBunPty: SpawnPty = (file, args, opts) => {
  const proc = Bun.spawn([file, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      data(_terminal: unknown, data: Uint8Array) {
        opts.onData(data);
      },
    },
  } as never) as unknown as {
    pid: number;
    exited: Promise<number>;
    signalCode: string | null;
    kill(signal?: NodeJS.Signals): void;
    terminal?: { write(data: string): void; resize(cols: number, rows: number): void; close?(): void };
  };
  if (!proc.terminal) throw new Error("Terminals need Bun 1.3.5 or newer (Bun.spawn's terminal option)");
  const terminal = proc.terminal;
  // The master side stays open until closed, even after the shell is gone (and a background child
  // holding the slave keeps it producing output), so close it as soon as the shell exits.
  const closeTerminal = () => {
    try {
      terminal.close?.();
    } catch {}
  };
  proc.exited.then(
    (code) => {
      closeTerminal();
      opts.onExit({ exitCode: proc.signalCode ? null : code, signal: proc.signalCode });
    },
    () => {
      closeTerminal();
      opts.onExit({ exitCode: null, signal: null });
    },
  );
  return {
    pid: proc.pid,
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: (signal) => proc.kill(signal),
  };
};
