let pending: (() => unknown)[] = [];

/** Run `fn` after the current test, newest first (the preload's afterEach calls runTeardowns). */
export function afterTest(fn: () => unknown): void {
  pending.push(fn);
}

export async function runTeardowns(): Promise<void> {
  const fns = pending.reverse();
  pending = [];
  for (const fn of fns) await fn();
}
