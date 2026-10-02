import { describe, expect, test } from "bun:test";
import { landCommands, landMenu, pullRequestLabel } from "./approveMenu";

const gh = { isGit: true, pullRequestHost: "github.com" } as const;
const git = { isGit: true, pullRequestHost: null } as const;
const plain = { isGit: false, pullRequestHost: null } as const;
const fresh = { completionAction: null, pullRequestUrl: null };

describe("landMenu", () => {
  test("a gh project offers merge, PR, clean up and Approve and…, with merge preselected and run directly", () => {
    const m = landMenu(fresh, gh);
    expect(m.primary).toEqual({ kind: "run", action: "merge", label: "Approve and merge" });
    expect(m.items.map((i) => i.label)).toEqual(["Approve and merge", "Approve and open PR", "Approve and clean up", "Approve and…"]);
    expect(m.items[3]).toMatchObject({ kind: "sheet", action: "custom", required: true });
    expect(m.noAction).toEqual({ kind: "none", label: "Approve and take no action" });
  });

  test("plain git has no PR choice", () => {
    expect(landMenu(fresh, git).items.map((i) => i.kind !== "none" && i.action)).toEqual(["merge", "cleanup", "custom"]);
  });

  test("outside git the primary is a plain Approve that runs custom without asking", () => {
    const m = landMenu(fresh, plain);
    expect(m.primary).toEqual({ kind: "run", action: "custom", label: "Approve" });
    expect(m.items).toEqual([{ kind: "sheet", action: "custom", required: true, label: "Approve and…" }]);
  });

  test("a ticket that opened a PR preselects it", () => {
    expect(landMenu({ completionAction: null, pullRequestUrl: "https://github.com/a/b/pull/1" }, gh).primary).toMatchObject({ action: "pr", label: "Approve and open PR" });
  });

  test("the choice an earlier approval stored stays preselected (a completion that was stopped)", () => {
    expect(landMenu({ completionAction: "cleanup", pullRequestUrl: null }, gh).primary).toEqual({ kind: "run", action: "cleanup", label: "Approve and clean up" });
  });

  test("a ticket on its base branch (an existing PR head) drops merge and PR and preselects clean up", () => {
    const m = landMenu({ ...fresh, branch: "feature/pr-head" }, gh, null, "feature/pr-head");
    expect(m.primary).toEqual({ kind: "run", action: "cleanup", label: "Approve and clean up" });
    expect(m.items.map((i) => i.label)).toEqual(["Approve and clean up", "Approve and…"]);
    expect(landCommands(m).others).toEqual({ custom: { kind: "sheet", action: "custom", required: true, label: "Approve and…" } });
  });

  test("a child on its parent's branch only merges: the project's pr default and the other actions drop out", () => {
    const m = landMenu({ completionAction: "pr", pullRequestUrl: null }, gh, { branch: "harness/web-1" });
    expect(m.primary).toEqual({ kind: "run", action: "merge", label: "Approve and merge" });
    expect(m.items.map((i) => i.kind !== "none" && i.action)).toEqual(["merge"]);
  });
});

describe("landCommands (the palette's split-button commands)", () => {
  const actions = (o: ReturnType<typeof landCommands>["others"]) => Object.entries(o).map(([a, c]) => `${a}:${c!.label}`);

  test("the primary is named as the button reads, and the menu choice it repeats is dropped", () => {
    const c = landCommands(landMenu(fresh, gh));
    expect(c.primary).toBe("Approve and merge");
    expect(actions(c.others)).toEqual(["pr:Approve and open PR", "cleanup:Approve and clean up", "custom:Approve and…"]);
  });

  test("with the PR preselected, merge stays in the palette and the PR choice goes", () => {
    const c = landCommands(landMenu({ completionAction: "pr", pullRequestUrl: null }, gh));
    expect(c.primary).toBe("Approve and open PR");
    expect(actions(c.others)).toEqual(["merge:Approve and merge", "cleanup:Approve and clean up", "custom:Approve and…"]);
  });

  test("a plain Approve (outside git) keeps Approve and… as its own command", () => {
    const c = landCommands(landMenu(fresh, plain));
    expect(c.primary).toBe("Approve");
    expect(actions(c.others)).toEqual(["custom:Approve and…"]);
  });

  test("a child on its parent's branch has only the primary", () => {
    const c = landCommands(landMenu(fresh, gh, { branch: "harness/web-1" }));
    expect(c.primary).toBe("Approve and merge");
    expect(c.others).toEqual({});
  });
});

describe("pullRequestLabel", () => {
  test("numbers GitHub and GitLab links, and falls back to PR", () => {
    expect(pullRequestLabel("https://github.com/o/r/pull/42")).toBe("PR #42");
    expect(pullRequestLabel("https://gitlab.com/o/r/-/merge_requests/7")).toBe("PR #7");
    expect(pullRequestLabel("https://github.com/o/r/pull/42/files")).toBe("PR #42");
    expect(pullRequestLabel("https://github.com/o/r/pull/42abc")).toBe("PR");
    expect(pullRequestLabel("https://example.com/review")).toBe("PR");
  });
});
