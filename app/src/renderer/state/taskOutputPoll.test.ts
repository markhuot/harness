import { describe, expect, test } from "bun:test";
import type { TaskOutput } from "@harness/shared";
import { pollTaskOutput } from "./taskOutputPoll";

const out = (start: number, text: string, done = false): TaskOutput => ({ text, start, end: start + text.length, size: start + text.length, done, available: true });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fake service: each read resolves when the test says so, and records its offset. */
function fakeRead() {
  const calls: (number | undefined)[] = [];
  let open = 0;
  let maxOpen = 0;
  const pending: ((o: TaskOutput) => void)[] = [];
  const read = (offset?: number) => {
    calls.push(offset);
    open++;
    maxOpen = Math.max(maxOpen, open);
    return new Promise<TaskOutput>((resolve) =>
      pending.push((o) => {
        open--;
        resolve(o);
      }),
    );
  };
  return {
    read,
    calls,
    maxOpen: () => maxOpen,
    answer: async (o: TaskOutput) => {
      pending.shift()!(o);
      await tick();
    },
    waiting: () => pending.length,
  };
}

describe("pollTaskOutput", () => {
  test("a finished task gets one read of the tail, then nothing more", async () => {
    const f = fakeRead();
    const seen: TaskOutput[] = [];
    pollTaskOutput({ read: f.read, running: () => false, onOutput: (o) => seen.push(o), intervalMs: 1 });
    await f.answer(out(0, "all of it\n", true));
    await tick(10);
    expect(f.calls).toEqual([undefined]);
    expect(seen).toHaveLength(1);
  });

  test("a running task reads on from where the last slice ended", async () => {
    const f = fakeRead();
    pollTaskOutput({ read: f.read, running: () => true, onOutput: () => {}, intervalMs: 1 });
    await f.answer(out(100, "tail\n"));
    await tick(5);
    await f.answer(out(105, "more\n"));
    await tick(5);
    expect(f.calls).toEqual([undefined, 105, 110]);
  });

  test("no offset until there's output to read", async () => {
    const f = fakeRead();
    pollTaskOutput({ read: f.read, running: () => true, onOutput: () => {}, intervalMs: 1 });
    await f.answer({ text: "", start: 0, end: 0, size: 0, done: false, available: false });
    await tick(5);
    expect(f.calls).toEqual([undefined, undefined]);
  });

  test("when the task finishes, one final read, then it stops", async () => {
    const f = fakeRead();
    let running = true;
    const poll = pollTaskOutput({ read: f.read, running: () => running, onOutput: () => {}, intervalMs: 10_000 });
    await f.answer(out(0, "line 1\n"));
    // Waiting out the long interval; the finish wakes it.
    running = false;
    poll.wake();
    expect(f.calls).toEqual([undefined, 7]);
    await f.answer(out(7, "line 2\n", true));
    await tick(5);
    expect(f.calls).toEqual([undefined, 7]);
  });

  test("a finish during a read is picked up right after it, without overlapping it", async () => {
    const f = fakeRead();
    let running = true;
    const poll = pollTaskOutput({ read: f.read, running: () => running, onOutput: () => {}, intervalMs: 10_000 });
    running = false;
    poll.wake();
    poll.wake();
    expect(f.waiting()).toBe(1);
    await f.answer(out(0, "line 1\n"));
    await tick(5);
    expect(f.calls).toEqual([undefined, 7]);
    await f.answer(out(7, ""));
    await tick(5);
    expect(f.calls).toHaveLength(2);
    expect(f.maxOpen()).toBe(1);
  });

  test("output marked done stops the polling even before the status flips", async () => {
    const f = fakeRead();
    pollTaskOutput({ read: f.read, running: () => true, onOutput: () => {}, intervalMs: 1 });
    await f.answer(out(0, "x\n", true));
    await tick(10);
    expect(f.calls).toHaveLength(1);
  });

  test("a failed read is reported and retried while the task runs", async () => {
    const errors: string[] = [];
    let n = 0;
    pollTaskOutput({
      read: async () => {
        if (n++ === 0) throw new Error("offline");
        return out(0, "ok\n", true);
      },
      running: () => true,
      onOutput: () => {},
      onError: (e) => errors.push(e.message),
      intervalMs: 1,
    });
    await tick(10);
    expect(errors).toEqual(["offline"]);
    expect(n).toBe(2);
  });

  test("after stop, a pending answer is dropped and no more reads go out", async () => {
    const f = fakeRead();
    const seen: TaskOutput[] = [];
    const poll = pollTaskOutput({ read: f.read, running: () => true, onOutput: (o) => seen.push(o), intervalMs: 1 });
    poll.stop();
    await f.answer(out(0, "late\n"));
    await tick(10);
    expect(seen).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
  });
});
