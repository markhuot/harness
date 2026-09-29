import { expect, test } from "bun:test";
import type { Watcher } from "@harness/shared";
import { toDraft, watcherBody } from "./watcherDraft";

const settings = { defaultDriver: "claude-code", watcherDriver: null };

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
  const d = toDraft(legacy, settings);
  expect(d.command).toBe(`node '/Users/me/My Scripts/watch.js' --since 'it'\\''s'`);
  const body = watcherBody(d);
  expect(body.args).toEqual([]);
  expect(body.command).toBe(d.command);
});

test("a shell watcher's command line round-trips untouched, and the prompt is trimmed", () => {
  const line = "while true; do curl -s https://example.com/events | jq -c '.[]'; sleep 60; done";
  const d = toDraft(watcher({ command: line, prompt: "Dispatch anything assigned to me." }), settings);
  expect(d.command).toBe(line);
  expect(d.prompt).toBe("Dispatch anything assigned to me.");
  const body = watcherBody({ ...d, command: `  ${line}\n`, prompt: "\n  Only my tickets.  \n" });
  expect(body.command).toBe(line);
  expect(body.prompt).toBe("Only my tickets.");
});

test("blank optional fields fall back: cwd → null, driver → default, junk interval → 60s", () => {
  const body = watcherBody({ ...toDraft(undefined, settings), name: " w ", command: "echo hi", cwd: "  ", intervalSec: "abc" });
  expect(body.name).toBe("w");
  expect(body.cwd).toBeNull();
  expect(body.driver).toBeNull();
  expect(body.intervalSec).toBe(60);
  expect(body.prompt).toBe("");
});

test("picking Opus under Claude Code pins that driver with exactly that model, clearing other drivers' models", () => {
  const w = watcher({ driver: "codex", models: { codex: "gpt-5" } });
  const d = toDraft(w, settings);
  expect(d.choice).toEqual({ driver: "codex", model: "gpt-5" });
  const body = watcherBody({ ...d, choice: { driver: "claude-code", model: "opus" } }, w);
  expect(body.driver).toBe("claude-code");
  expect(body.models).toEqual({ codex: null, "claude-code": "opus" });
});

test("Default clears the driver and every stored model", () => {
  const w = watcher({ driver: "claude-code", models: { "claude-code": "opus", codex: "gpt-5" } });
  const body = watcherBody({ ...toDraft(w, settings), choice: { driver: null, model: null } }, w);
  expect(body.driver).toBeNull();
  expect(body.models).toEqual({ "claude-code": null, codex: null });
});

test("a watcher without a driver but with a model for the default watcher driver opens with that pick", () => {
  const d = toDraft(watcher({ driver: null, models: { dummy: "fast" } }), { defaultDriver: "claude-code", watcherDriver: "dummy" });
  expect(d.choice).toEqual({ driver: "dummy", model: "fast" });
  // …but a model for some other driver doesn't count: it opens on Default.
  expect(toDraft(watcher({ driver: null, models: { codex: "gpt-5" } }), settings).choice).toEqual({ driver: null, model: null });
});

test("a new watcher starts on Default and saves no driver or models", () => {
  const body = watcherBody({ ...toDraft(undefined, settings), name: "w", command: "echo" });
  expect(body.driver).toBeNull();
  expect(body.models).toEqual({});
});
