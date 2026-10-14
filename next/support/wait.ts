// Wait for something the service does in the background (a watcher batch, a queued run). Polls on
// 1ms turns and fails with the caller's label, so a stuck test names what it was waiting for
// instead of hitting the test timeout.

export async function waitFor(cond: () => boolean | Promise<boolean>, opts: { label?: string; timeoutMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.label ?? "condition"}`);
    await Bun.sleep(1);
  }
}
