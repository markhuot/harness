import { describe, expect, test } from "bun:test";
import { landCommands, landMenu, pullRequestLabel } from "../../../app/src/renderer/state/approveMenu";
import { makeTicket } from "../../builders/ticket";

const git = { isGit: true, completionAction: "merge", completionActions: undefined, pullRequestHost: null } as never;
const withPr = { isGit: true, completionAction: "merge", completionActions: undefined, pullRequestHost: "github" } as never;
const noGit = { isGit: false, completionAction: "merge", completionActions: undefined, pullRequestHost: null } as never;
const review = (o = {}) => makeTicket({ status: "review", branch: "harness/x", ...o });

describe("landMenu", () => {
  test("git project: merge is primary; custom opens the instructions sheet", () => {
    const m = landMenu(review(), git);
    expect(m.primary).toEqual({ kind: "run", action: "merge", label: "Approve and merge" });
    expect(m.items.map((i) => i.kind + ":" + i.label)).toEqual(["run:Approve and merge", "run:Approve and clean up", "sheet:Approve and…"]);
    expect(m.items[2]).toMatchObject({ required: true });
    expect(m.noAction).toEqual({ kind: "none", label: "Approve and take no action" });
  });
  test("a pull-request host adds the PR choice", () => {
    expect(landMenu(review(), withPr).items.map((i) => (i as { action: string }).action)).toEqual(["merge", "pr", "cleanup", "custom"]);
  });
  test("outside git the primary reads a plain Approve and runs custom without a sheet", () => {
    const m = landMenu(review({ branch: null }), noGit);
    expect(m.primary).toEqual({ kind: "run", action: "custom", label: "Approve" });
  });
  test("a ticket on its base branch loses merge and pr", () => {
    const m = landMenu(review({ branch: "main" }), withPr, undefined, "main");
    expect(m.items.map((i) => (i as { action: string }).action)).toEqual(["cleanup", "custom"]);
    expect(m.primary.label).toBe("Approve and clean up");
  });
  test("a child of a branched parent only merges", () => {
    const m = landMenu(review(), withPr, { branch: "harness/parent", status: "in_progress" });
    expect(m.items).toHaveLength(1);
    expect(m.opts.parentBranch).toBe("harness/parent");
  });
});

describe("landCommands", () => {
  test("leaves out the choice the primary already names", () => {
    const c = landCommands(landMenu(review(), withPr));
    expect(c.primary).toBe("Approve and merge");
    expect(Object.keys(c.others).sort()).toEqual(["cleanup", "custom", "pr"]);
  });
  test("a plain Approve (custom primary) still lists custom, labeled 'Approve and…'", () => {
    const c = landCommands(landMenu(review({ branch: null }), noGit));
    expect(c.primary).toBe("Approve");
    expect(c.others.custom?.label).toBe("Approve and…");
  });
});

describe("pullRequestLabel", () => {
  test("GitHub pull and GitLab merge_requests urls", () => {
    expect(pullRequestLabel("https://github.com/a/b/pull/42")).toBe("PR #42");
    expect(pullRequestLabel("https://gitlab.com/a/b/-/merge_requests/7?x=1")).toBe("PR #7");
    expect(pullRequestLabel("https://x.test/a/b/pulls/9#c")).toBe("PR #9");
  });
  test("no number is a bare PR", () => {
    expect(pullRequestLabel("https://github.com/a/b/pull/abc")).toBe("PR");
    expect(pullRequestLabel("https://github.com/a/b/pull/42x")).toBe("PR");
    expect(pullRequestLabel("not a url")).toBe("PR");
  });
});
