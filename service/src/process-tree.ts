/**
 * Every process below `pid`, children first in walk order. Claude Code starts each background
 * shell in its own process group, so killing the CLI's group doesn't reach them; walking the
 * parent links does. Read it before killing anything: an orphan is reparented to launchd and
 * can't be traced back once its parent is gone.
 */
export function descendantPids(pid: number): number[] {
  let out: string;
  try {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    out = ps.stdout.toString();
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  }
  const found: number[] = [];
  const queue = [pid];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (child === pid || found.includes(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Signal each pid, ignoring ones already gone. */
export function signalAll(pids: number[], sig: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}
