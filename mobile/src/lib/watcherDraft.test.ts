import { expect, test } from "bun:test";
import type { Watcher } from "@harness/shared";
import { toDraft, watcherBody } from "./watcherDraft";

const watcher = (over: Partial<Watcher>): Watcher => ({
  id: "w1",
  name: "jira",
  command: "watch-jira",
  args: [],
  prompt: "",
  cwd: null,
  env: {},
  mode: "loop",
  intervalSec: 300,
  enabled: true,
  driver: null,
  ...over,
} as Watcher);

test("a legacy direct-exec watcher saves back as a shell watcher with its args quoted into the command", () => {
  const legacy = watcher({ command: "node", args: ["/Users/me/My Scripts/watch.js", "--since", "it's"] });
  const d = toDraft(legacy);
  expect(d.command).toBe(`node '/Users/me/My Scripts/watch.js' --since 'it'\\''s'`);
  const body = watcherBody(d);
  expect(body.args).toEqual([]);
  expect(body.command).toBe(d.command);
});

test("a shell watcher's command line round-trips untouched, and the prompt is trimmed", () => {
  const line = "while true; do curl -s https://example.com/events | jq -c '.[]'; sleep 60; done";
  const d = toDraft(watcher({ command: line, prompt: "Dispatch anything assigned to me." }));
  expect(d.command).toBe(line);
  expect(d.prompt).toBe("Dispatch anything assigned to me.");
  const body = watcherBody({ ...d, command: `  ${line}\n`, prompt: "\n  Only my tickets.  \n" });
  expect(body.command).toBe(line);
  expect(body.prompt).toBe("Only my tickets.");
});

test("blank optional fields fall back: cwd → null, driver → default, junk interval → 60s", () => {
  const body = watcherBody({ ...toDraft(), name: " w ", command: "echo hi", cwd: "  ", intervalSec: "abc" });
  expect(body.name).toBe("w");
  expect(body.cwd).toBeNull();
  expect(body.driver).toBeNull();
  expect(body.intervalSec).toBe(60);
  expect(body.prompt).toBe("");
});
