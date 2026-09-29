import { expect, test } from "bun:test";
import type { Watcher } from "@harness/shared";
import { draftDriver, toDraft, watcherBody } from "./watcherDraft";

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
  const d = toDraft(legacy);
  expect(d.command).toBe(`node '/Users/me/My Scripts/watch.js' --since 'it'\\''s'`);
  const body = watcherBody(d, settings);
  expect(body.args).toEqual([]);
  expect(body.command).toBe(d.command);
});

test("a shell watcher's command line round-trips untouched, and the prompt is trimmed", () => {
  const line = "while true; do curl -s https://example.com/events | jq -c '.[]'; sleep 60; done";
  const d = toDraft(watcher({ command: line, prompt: "Dispatch anything assigned to me." }));
  expect(d.command).toBe(line);
  expect(d.prompt).toBe("Dispatch anything assigned to me.");
  const body = watcherBody({ ...d, command: `  ${line}\n`, prompt: "\n  Only my tickets.  \n" }, settings);
  expect(body.command).toBe(line);
  expect(body.prompt).toBe("Only my tickets.");
});

test("blank optional fields fall back: cwd → null, driver → default, junk interval → 60s", () => {
  const body = watcherBody({ ...toDraft(), name: " w ", command: "echo hi", cwd: "  ", intervalSec: "abc" }, settings);
  expect(body.name).toBe("w");
  expect(body.cwd).toBeNull();
  expect(body.driver).toBeNull();
  expect(body.intervalSec).toBe(60);
  expect(body.prompt).toBe("");
});

test("the effective driver is the draft's own, else settings.watcherDriver, else the default driver", () => {
  expect(draftDriver({ driver: "codex" }, { defaultDriver: "claude-code", watcherDriver: "dummy" })).toBe("codex");
  expect(draftDriver({ driver: "" }, { defaultDriver: "claude-code", watcherDriver: "dummy" })).toBe("dummy");
  expect(draftDriver({ driver: "" }, { defaultDriver: "claude-code", watcherDriver: null })).toBe("claude-code");
});

test("the save body carries the model for the effective driver only, and null when reset to default", () => {
  const d = { ...toDraft(watcher({ driver: "codex", models: { codex: "gpt-5", "claude-code": "opus" } })) };
  expect(watcherBody(d, settings).models).toEqual({ codex: "gpt-5" });
  // Switching the driver back to Default resolves to claude-code, whose earlier pick survives in the draft.
  expect(watcherBody({ ...d, driver: "" }, settings)).toMatchObject({ driver: null, models: { "claude-code": "opus" } });
  // Resetting the model to Default clears only that driver's entry.
  expect(watcherBody({ ...d, models: { ...d.models, codex: "" } }, settings).models).toEqual({ codex: null });
});

test("a new watcher defaults to the default driver and model, saved against the app-wide triage driver", () => {
  const body = watcherBody({ ...toDraft(), name: "w", command: "echo" }, { defaultDriver: "claude-code", watcherDriver: "dummy" });
  expect(body.driver).toBeNull();
  expect(body.models).toEqual({ dummy: null });
});
