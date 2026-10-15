import { describe, expect, test } from "bun:test";
import { TerminalFeed, dropBytes, type TerminalMessage, type TerminalSink } from "./session";

function setup() {
  const log: string[] = [];
  const sink: TerminalSink = {
    reset: (c, r) => log.push(`reset ${c}x${r}`),
    write: (d) => log.push(`write ${JSON.stringify(d)}`),
    resize: (c, r) => log.push(`resize ${c}x${r}`),
    exited: (code) => log.push(`exit ${code}`),
    truncated: () => log.push("truncated"),
  };
  let resyncs = 0;
  const feed = new TerminalFeed("t1", sink, () => resyncs++);
  const snapshot = (data: string, offset: number, extra: Partial<Extract<TerminalMessage, { type: "terminal.snapshot" }>> = {}): TerminalMessage => ({
    type: "terminal.snapshot",
    id: "t1",
    data,
    offset,
    cols: 80,
    rows: 24,
    truncated: false,
    ...extra,
  });
  const output = (data: string, offset: number): TerminalMessage => ({ type: "terminal.output", id: "t1", data, offset });
  return { feed, log, snapshot, output, resyncs: () => resyncs };
}

describe("TerminalFeed", () => {
  test("a snapshot resets and draws; output continues from its offset", () => {
    const { feed, log, snapshot, output } = setup();
    feed.handle(snapshot("hello", 5));
    feed.handle(output(" world", 11));
    expect(log).toEqual(["reset 80x24", 'write "hello"', 'write " world"']);
    expect(feed.offset).toBe(11);
  });

  test("output before the snapshot is dropped (the snapshot already covers it)", () => {
    const { feed, log, snapshot, output } = setup();
    feed.handle(output("early", 5));
    feed.handle(snapshot("early", 5));
    expect(log).toEqual(["reset 80x24", 'write "early"']);
  });

  test("a chunk the snapshot already holds is skipped and one that straddles it is trimmed", () => {
    const { feed, log, snapshot, output } = setup();
    feed.handle(snapshot("abcdef", 6));
    feed.handle(output("def", 6)); // fully inside
    feed.handle(output("defgh", 8)); // starts at 3, seen is 6: only "gh" is new
    expect(log).toEqual(["reset 80x24", 'write "abcdef"', 'write "gh"']);
  });

  test("offsets are UTF-8 bytes: a multi-byte chunk straddling the offset trims by bytes", () => {
    const { feed, log, snapshot, output } = setup();
    feed.handle(snapshot("é", 2));
    feed.handle(output("é€", 5)); // é is 2 bytes, € is 3: start 0, seen 2
    expect(log.at(-1)).toBe('write "€"');
    expect(dropBytes("a€b", 1)).toBe("€b");
  });

  test("a gap asks for one resync, drops output until the next snapshot, and then carries on", () => {
    const { feed, log, snapshot, output, resyncs } = setup();
    feed.handle(snapshot("a", 1));
    feed.handle(output("zz", 10)); // bytes 1..8 are missing
    feed.handle(output("yy", 12));
    expect(resyncs()).toBe(1);
    expect(log).toEqual(["reset 80x24", 'write "a"']);
    feed.handle(snapshot("fresh", 12));
    feed.handle(output("!", 13));
    expect(log.slice(2)).toEqual(["reset 80x24", 'write "fresh"', 'write "!"']);
  });

  test("after a reconnect nothing is drawn until the new snapshot", () => {
    const { feed, log, snapshot, output } = setup();
    feed.handle(snapshot("a", 1));
    feed.reconnecting();
    feed.handle(output("b", 2));
    expect(log).toEqual(["reset 80x24", 'write "a"']);
    feed.handle(snapshot("ab", 2));
    expect(feed.isSynced).toBe(true);
  });

  test("size, exit, truncation and messages for another terminal", () => {
    const { feed, log, snapshot } = setup();
    feed.handle(snapshot("", 0, { truncated: true, cols: 40, rows: 10 }));
    feed.handle({ type: "terminal.size", id: "t1", cols: 62, rows: 18 });
    feed.handle({ type: "terminal.exit", id: "t1", exitCode: 2 });
    feed.handle({ type: "terminal.size", id: "other", cols: 1, rows: 1 });
    expect(log).toEqual(["reset 40x10", "truncated", "resize 62x18", "exit 2"]);
  });
});
