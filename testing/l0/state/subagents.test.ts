import { describe, expect, test } from "bun:test";
import type { Subagent } from "../../../shared/src/index";
import { initialState, transcriptKey, type State } from "../../../shared/src/state/reducer";
import {
  filterSubagents,
  isTask,
  sortSubagents,
  subagentById,
  subagentCounts,
  subagentDuration,
  subagentModelLabel,
  subagentOpenLabel,
  subagentPath,
  subagentTitle,
  subagentTypeLabel,
  subagentsOf,
  subagentTranscript,
  taskOutputOf,
} from "../../../shared/src/state/subagents";

function agent(over: Partial<Subagent> & { id: string }): Subagent {
  return {
    sessionId: "s",
    runId: null,
    parentId: null,
    description: "",
    agentType: null,
    prompt: "",
    status: "running",
    result: null,
    startedAt: 0,
    endedAt: null,
    updatedAt: 0,
    ...over,
  };
}

const stateWith = (patch: Partial<State>): State => ({ ...initialState, ...patch });

describe("selectors", () => {
  test("subagentsOf is null for an unknown session, [] for a known empty one", () => {
    expect(subagentsOf(stateWith({}), "s")).toBeNull();
    expect(subagentsOf(stateWith({ subagents: { s: [] } }), "s")).toEqual([]);
  });

  test("subagentById finds within the right session only", () => {
    const a = agent({ id: "a" });
    const st = stateWith({ subagents: { s: [a] } });
    expect(subagentById(st, "s", "a")).toBe(a);
    expect(subagentById(st, "s", "missing")).toBeNull();
    expect(subagentById(st, "other", "a")).toBeNull();
  });

  test("transcript and task output are keyed by session and sub-agent id", () => {
    const t = { entries: [], loaded: true };
    const st = stateWith({ transcripts: { [transcriptKey("s", "a")]: t } });
    expect(subagentTranscript(st, "s", "a")).toBe(t);
    expect(subagentTranscript(st, "s", "b")).toBeUndefined();
    expect(subagentTranscript(st, "s2", "a")).toBeUndefined();
    expect(taskOutputOf(st, "s", "a")).toBeUndefined();
  });
});

describe("isTask / titles / labels", () => {
  test("bash and monitor are tasks; agent and absent kind are not", () => {
    expect(isTask({ kind: "bash" })).toBe(true);
    expect(isTask({ kind: "monitor" })).toBe(true);
    expect(isTask({ kind: "agent" })).toBe(false);
    expect(isTask({})).toBe(false);
  });

  test("an agent's title: description, else agent type, else a default", () => {
    expect(subagentTitle({ description: "  Find it ", agentType: "Explore" })).toBe("Find it");
    expect(subagentTitle({ description: "  ", agentType: "Explore" })).toBe("Explore");
    expect(subagentTitle({ description: "", agentType: null })).toBe("Sub-agent");
  });

  test("a task's title: description, else command, else a default; the command is trimmed", () => {
    expect(subagentTitle({ kind: "bash", description: "Build", agentType: null, command: "make" })).toBe("Build");
    expect(subagentTitle({ kind: "bash", description: "", agentType: null, command: "  make  " })).toBe("make");
    expect(subagentTitle({ kind: "monitor", description: "", agentType: null, command: "  " })).toBe("Background task");
    expect(subagentTitle({ kind: "monitor", description: "", agentType: "Explore", command: null })).toBe("Background task");
  });

  test("the type chip: task kind label; agent type only when the title isn't already it; else null", () => {
    expect(subagentTypeLabel({ kind: "bash", description: "", agentType: null })).toBe("Bash");
    expect(subagentTypeLabel({ kind: "monitor", description: "", agentType: null })).toBe("Monitor");
    expect(subagentTypeLabel({ description: "Find it", agentType: "Explore" })).toBe("Explore");
    expect(subagentTypeLabel({ description: " ", agentType: "Explore" })).toBeNull();
    expect(subagentTypeLabel({ description: "Find it", agentType: null })).toBeNull();
  });

  test("open label depends on task vs agent", () => {
    expect(subagentOpenLabel({ kind: "bash" })).toBe("Open output");
    expect(subagentOpenLabel({ kind: "agent" })).toBe("Open transcript");
  });
});

describe("subagentModelLabel", () => {
  test("null for empty or whitespace and missing", () => {
    expect(subagentModelLabel(null)).toBeNull();
    expect(subagentModelLabel(undefined)).toBeNull();
    expect(subagentModelLabel("   ")).toBeNull();
  });

  test("new-style ids with and without a minor version and date", () => {
    expect(subagentModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(subagentModelLabel("claude-opus-4-1")).toBe("Opus 4.1");
    expect(subagentModelLabel("claude-sonnet-4")).toBe("Sonnet 4");
    expect(subagentModelLabel("claude-sonnet-4-20250514")).toBe("Sonnet 4");
  });

  test("old-style ids put the version first", () => {
    expect(subagentModelLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(subagentModelLabel("claude-3-opus-20240229")).toBe("Opus 3");
  });

  test("an alias is capitalised and a [1m] suffix adds 1M, in any case", () => {
    expect(subagentModelLabel("haiku")).toBe("Haiku");
    expect(subagentModelLabel("sonnet[1m]")).toBe("Sonnet 1M");
    expect(subagentModelLabel("claude-opus-4-1[1M]")).toBe("Opus 4.1 1M");
  });

  test("an unrecognised id shows as given (trimmed)", () => {
    expect(subagentModelLabel(" gpt-5 ")).toBe("gpt-5");
  });
});

describe("subagentDuration", () => {
  test("an ended agent uses its end time, ignoring now", () => {
    expect(subagentDuration({ startedAt: 1000, endedAt: 43000 }, 999999)).toBe("42s");
  });

  test("a running agent counts to now", () => {
    expect(subagentDuration({ startedAt: 0, endedAt: null }, 185000)).toBe("3m 5s");
  });

  test("an endedAt of 0 is a real end, not 'still running'", () => {
    expect(subagentDuration({ startedAt: 0, endedAt: 0 }, 99000)).toBe("0s");
  });
});

describe("sortSubagents / filter / counts", () => {
  test("latest updated first, ties broken by latest start, input untouched", () => {
    const a = agent({ id: "a", updatedAt: 5, startedAt: 1 });
    const b = agent({ id: "b", updatedAt: 9, startedAt: 0 });
    const c = agent({ id: "c", updatedAt: 5, startedAt: 3 });
    const input = [a, b, c];
    expect(sortSubagents(input).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(input.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  const list = [agent({ id: "a" }), agent({ id: "t", kind: "bash" }), agent({ id: "b", kind: "agent" })];

  test("one toggle shows only that kind; both or neither shows everything", () => {
    expect(filterSubagents(list, { agents: true, tasks: false }).map((s) => s.id)).toEqual(["a", "b"]);
    expect(filterSubagents(list, { agents: false, tasks: true }).map((s) => s.id)).toEqual(["t"]);
    expect(filterSubagents(list, { agents: true, tasks: true })).toBe(list);
    expect(filterSubagents(list, { agents: false, tasks: false })).toBe(list);
  });

  test("counts split tasks from agents", () => {
    expect(subagentCounts(list)).toEqual({ agents: 2, tasks: 1 });
    expect(subagentCounts([])).toEqual({ agents: 0, tasks: 0 });
  });
});

describe("subagentPath", () => {
  test("lists ancestors top-down ending at the agent", () => {
    const st = stateWith({ subagents: { s: [agent({ id: "c", parentId: "b" }), agent({ id: "b", parentId: "a" }), agent({ id: "a" })] } });
    expect(subagentPath(st, "s", "c").map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  test("an unknown id gives an empty path; a missing parent ends the chain", () => {
    const st = stateWith({ subagents: { s: [agent({ id: "b", parentId: "gone" })] } });
    expect(subagentPath(st, "s", "nope")).toEqual([]);
    expect(subagentPath(st, "s", "b").map((s) => s.id)).toEqual(["b"]);
  });

  test("a parent cycle terminates", () => {
    const st = stateWith({ subagents: { s: [agent({ id: "a", parentId: "b" }), agent({ id: "b", parentId: "a" })] } });
    expect(subagentPath(st, "s", "a").map((s) => s.id).sort()).toEqual(["a", "b"]);
  });
});
