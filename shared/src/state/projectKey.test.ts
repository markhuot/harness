import { describe, expect, test } from "bun:test";
import type { Project, Ticket } from "../index";
import { formatRuns, previewProjectKey } from "./projectKey";

const project = (over: Partial<Project> = {}): Project =>
  ({
  id: "p1",
  key: "HELLOHARNESS",
  name: "hello-harness",
  path: "/x/hello-harness",
  nextSeq: 4,
  defaultDriver: null,
  useWorktrees: true,
  skipAgentReview: false, skipHumanReview: false,
  createdAt: 0,
  updatedAt: 0,
  ...over,
  }) as Project;

let n = 0;
const ticket = (key: string, projectId = "p1", external = false): Ticket =>
  ({ id: `t${++n}`, key, projectId, externalRef: external ? { source: "jira", key, url: null, raw: {} } : null }) as Ticket;

const seed = () => {
  const p = project();
  const other = project({ id: "p2", key: "OTHER", name: "Other" });
  const tickets = [ticket("HELLOHARNESS-1"), ticket("HELLOHARNESS-2"), ticket("HELLOHARNESS-3"), ticket("FOO-123", "p1", true)];
  return { p, projects: [p, other], tickets };
};

describe("previewProjectKey", () => {
  test("describes the rename of HELLOHARNESS-1…3 and the next numbers", () => {
    const { p, projects, tickets } = seed();
    const r = previewProjectKey(p, projects, tickets, " hel ");
    expect(r.key).toBe("HEL");
    expect(r.error).toBeNull();
    expect(r.changed).toBe(true);
    expect(r.renames.map((x) => `${x.from}>${x.to}`)).toEqual(["HELLOHARNESS-1>HEL-1", "HELLOHARNESS-2>HEL-2", "HELLOHARNESS-3>HEL-3"]);
    expect(r.kept).toEqual(["FOO-123"]);
    expect(r.message).toBe("Tickets will be numbered HEL-4, HEL-5…; existing HELLOHARNESS-1…3 become HEL-1…3. FOO-123 keeps its key");
  });

  test("a ticket linked to a remote ID renames with the project; only a legacy mirror keeps its key", () => {
    const p = project();
    const linked = { ...ticket("HELLOHARNESS-4"), externalRef: { source: "jira", key: "MH-62", url: null, raw: null } } as Ticket;
    const r = previewProjectKey(p, [p], [ticket("HELLOHARNESS-1"), linked, ticket("FOO-123", "p1", true)], "HEL");
    expect(r.renames.map((x) => `${x.from}>${x.to}`)).toEqual(["HELLOHARNESS-1>HEL-1", "HELLOHARNESS-4>HEL-4"]);
    expect(r.kept).toEqual(["FOO-123"]);
  });

  test("unchanged key just shows the numbering", () => {
    const { p, projects, tickets } = seed();
    const r = previewProjectKey(p, projects, tickets, "helloharness");
    expect(r.changed).toBe(false);
    expect(r.renames).toEqual([]);
    expect(r.message).toBe("New tickets are numbered HELLOHARNESS-4, HELLOHARNESS-5…");
  });

  test("invalid input reports the validation error and renames nothing", () => {
    const { p, projects, tickets } = seed();
    for (const [draft, err] of [["", "Enter a key"], ["2X", "Must start with a letter"], ["he-l", "Letters and digits only"]] as const) {
      const r = previewProjectKey(p, projects, tickets, draft);
      expect(r.error).toBe(err);
      expect(r.renames).toEqual([]);
      expect(r.next).toEqual([]);
    }
  });

  test("a key another project uses is refused", () => {
    const { p, projects, tickets } = seed();
    expect(previewProjectKey(p, projects, tickets, "other").error).toBe("Already used by Other");
  });

  test("renames that would land on an existing ticket are refused; the ticket being renamed doesn't count", () => {
    const { p, projects, tickets } = seed();
    expect(previewProjectKey(p, projects, [...tickets, ticket("HEL-2", "p2", true)], "HEL").error).toBe("HEL-2 already exists");
    // A ticket only "clashes" if it isn't one of the tickets being renamed.
    const x = project({ key: "X" });
    expect(previewProjectKey(x, [x], [ticket("X-1")], "Y").error).toBeNull();
  });

  test("next numbers skip keys that are already taken", () => {
    const { p, projects, tickets } = seed();
    const r = previewProjectKey(p, projects, [...tickets, ticket("HEL-4", "p2", true)], "HEL");
    expect(r.next).toEqual(["HEL-5", "HEL-6"]);
  });

  test("gaps in the native sequence are summarized as runs", () => {
    const p = project({ nextSeq: 9 });
    const r = previewProjectKey(p, [p], [ticket("HELLOHARNESS-1"), ticket("HELLOHARNESS-2"), ticket("HELLOHARNESS-5"), ticket("HELLOHARNESS-7")], "H");
    expect(r.message).toBe("Tickets will be numbered H-9, H-10…; existing HELLOHARNESS-1…2, 5, 7 become H-1…2, 5, 7");
    const one = previewProjectKey(p, [p], [ticket("HELLOHARNESS-3")], "H");
    expect(one.message).toContain("existing HELLOHARNESS-3 becomes H-3");
  });
});

test("formatRuns", () => {
  expect(formatRuns([])).toBe("");
  expect(formatRuns([4])).toBe("4");
  expect(formatRuns([1, 2, 3, 5, 7, 8])).toBe("1…3, 5, 7…8");
});
