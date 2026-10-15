// Where each shell is and what runs in the foreground, for shells that don't say (OSC 7 gives the
// cwd directly). One `ps` and one `lsof` for all the terminals asked about, never one per terminal.

import { basename } from "node:path";

export interface PollTarget {
  id: string;
  /** The shell's pid. */
  pid: number;
}

export interface PollResult {
  cwd: string | null;
  process: string | null;
}

export interface PollRunners {
  /** `ps -axo pid=,pgid=,tpgid=,comm=` output. */
  ps(): Promise<string>;
  /** `lsof -a -d cwd -Fpn -p <pids>` output. */
  lsof(pids: number[]): Promise<string>;
}

/** Output of `cmd`, or "" when it fails or runs past `timeoutMs` (a hung lsof on a dead mount). */
export async function run(cmd: string[], timeoutMs = 3000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export const systemRunners: PollRunners = {
  ps: () => run(["ps", "-axo", "pid=,pgid=,tpgid=,comm="]),
  lsof: (pids) => run(["lsof", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]),
};

interface Row {
  pid: number;
  pgid: number;
  tpgid: number;
  comm: string;
}

export function parsePs(out: string): Map<number, Row> {
  const rows = new Map<number, Row>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), pgid: Number(m[2]), tpgid: Number(m[3]), comm: m[4]! });
  }
  return rows;
}

/** pid → cwd from `lsof -Fpn` (lines `p<pid>` then `n<path>`). */
export function parseLsof(out: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** A command name for display: `-zsh` (a login shell) → `zsh`, `/usr/bin/vim` → `vim`. */
export function processName(comm: string): string {
  return basename(comm).replace(/^-/, "");
}

export async function pollTerminals(targets: PollTarget[], runners: PollRunners = systemRunners): Promise<Map<string, PollResult>> {
  const out = new Map<string, PollResult>();
  if (targets.length === 0) return out;
  const [ps, lsof] = await Promise.all([runners.ps(), runners.lsof(targets.map((t) => t.pid))]);
  const rows = parsePs(ps);
  const cwds = parseLsof(lsof);
  for (const t of targets) {
    const shell = rows.get(t.pid);
    let proc: string | null = null;
    if (shell) {
      // The terminal's foreground process group: its leader is the group id, else the shell itself.
      const fg = shell.tpgid > 0 && shell.tpgid !== shell.pgid ? (rows.get(shell.tpgid) ?? [...rows.values()].find((r) => r.pgid === shell.tpgid)) : undefined;
      proc = processName((fg ?? shell).comm);
    }
    out.set(t.id, { cwd: cwds.get(t.pid) ?? null, process: proc });
  }
  return out;
}
