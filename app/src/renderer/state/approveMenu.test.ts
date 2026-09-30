import { describe, expect, test } from "bun:test";
import { landCommands, landMenu, pullRequestLabel } from "./approveMenu";

const gh = { isGit: true, pullRequestHost: "github.com" } as const;
const git = { isGit: true, pullRequestHost: null } as const;
const plain = { isGit: false, pullRequestHost: null } as const;
const fresh = { completionAction: null, pullRequestUrl: null };

describe("landMenu (approve)", () => {
  test("a gh project offers merge, PR and Approve and…, with merge preselected and run directly", () => {
    const m = landMenu("approve", fresh, gh);
    expect(m.primary).toEqual({ kind: "run", action: "merge", label: "Approve and merge" });
    expect(m.items.map((i) => i.label)).toEqual(["Approve and merge", "Approve and open PR", "Approve and…"]);
    expect(m.items[2]).toMatchObject({ kind: "sheet", action: "custom", required: true });
    expect(m.noAction).toEqual({ kind: "none", label: "Approve and take no action" });
  });

  test("plain git has no PR choice", () => {
    expect(landMenu("approve", fresh, git).items.map((i) => i.kind !== "none" && i.action)).toEqual(["merge", "custom"]);
  });

  test("outside git the primary is a plain Approve that runs custom without asking", () => {
    const m = landMenu("approve", fresh, plain);
    expect(m.primary).toEqual({ kind: "run", action: "custom", label: "Approve" });
    expect(m.items).toEqual([{ kind: "sheet", action: "custom", required: true, label: "Approve and…" }]);
  });

  test("a ticket that opened a PR preselects it", () => {
    expect(landMenu("approve", { completionAction: null, pullRequestUrl: "https://github.com/a/b/pull/1" }, gh).primary).toMatchObject({ action: "pr", label: "Approve and open PR" });
  });

  test("a child on its parent's branch only merges into it: no menu actions, just take no action", () => {
    const m = landMenu("approve", fresh, gh, { branch: "harness/web-1" });
    expect(m.primary).toEqual({ kind: "run", action: "merge", label: "Approve and merge into harness/web-1" });
    expect(m.items).toEqual([]);
    expect(m.noAction.kind).toBe("none");
  });
});

describe("landMenu (complete)", () => {
  test("the primary opens the sheet with optional instructions for the preselected action", () => {
    const m = landMenu("complete", { completionAction: "pr", pullRequestUrl: null }, gh);
    expect(m.primary).toEqual({ kind: "sheet", action: "pr", required: false, label: "Complete and open PR" });
    expect(m.items.map((i) => i.label)).toEqual(["Complete and merge", "Complete and open PR", "Complete and…"]);
    expect(m.noAction.label).toBe("Complete and take no action");
  });

  test("outside git the primary reads Complete; on a parent branch it names the branch", () => {
    expect(landMenu("complete", fresh, plain).primary.label).toBe("Complete");
    expect(landMenu("complete", fresh, git, { branch: "harness/x" }).primary.label).toBe("Complete and merge into harness/x");
  });
});

describe("landCommands (the palette's split-button commands)", () => {
  const actions = (o: ReturnType<typeof landCommands>["others"]) => Object.entries(o).map(([a, c]) => `${a}:${c!.label}`);

  test("approving: the primary is named as the button reads, and the menu choice it repeats is dropped", () => {
    const c = landCommands(landMenu("approve", fresh, gh), "approve");
    expect(c.primary).toBe("Approve and merge");
    expect(actions(c.others)).toEqual(["pr:Approve and open PR", "custom:Approve and…"]);
  });

  test("with the PR preselected, merge stays in the palette and the PR choice goes", () => {
    const c = landCommands(landMenu("approve", { completionAction: "pr", pullRequestUrl: null }, gh), "approve");
    expect(c.primary).toBe("Approve and open PR");
    expect(actions(c.others)).toEqual(["merge:Approve and merge", "custom:Approve and…"]);
  });

  test("a plain Approve (outside git) keeps Approve and… as its own command", () => {
    const c = landCommands(landMenu("approve", fresh, plain), "approve");
    expect(c.primary).toBe("Approve");
    expect(actions(c.others)).toEqual(["custom:Approve and…"]);
  });

  test("completing: the primary opens the sheet, so it reads with an ellipsis; the rest run directly", () => {
    const c = landCommands(landMenu("complete", fresh, gh), "complete");
    expect(c.primary).toBe("Complete and merge…");
    expect(actions(c.others)).toEqual(["pr:Complete and open PR", "custom:Complete and…"]);
    expect(c.others.pr).toMatchObject({ kind: "run", action: "pr" });
  });

  test("a child on its parent's branch has only the primary", () => {
    const c = landCommands(landMenu("approve", fresh, gh, { branch: "harness/web-1" }), "approve");
    expect(c.primary).toBe("Approve and merge into harness/web-1");
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
