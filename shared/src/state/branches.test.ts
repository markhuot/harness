import { describe, expect, test } from "bun:test";
import type { BranchInfo } from "../protocol";
import { branchChoice, branchChoiceHint, branchRows, canChangeBranch, inheritedBaseLabel, newTicketBranchLabel, pickableIds, predictedTicketKey, ticketHasBranch } from "./branches";

const b = (name: string, checkedOutAt: string | null = null): BranchInfo => ({ name, lastCommitAt: 1, checkedOutAt });
const newLabel = (n: string) => `Create ${n}`;
const summary = (rows: ReturnType<typeof branchRows>) => rows.map((r) => `${r.kind}:${r.label}`);

describe("branchRows", () => {
  test("no query: the default, then every branch, no new row", () => {
    expect(summary(branchRows([b("main"), b("develop")], "", "New branch harness/web-4", newLabel))).toEqual(["default:New branch harness/web-4", "branch:main", "branch:develop"]);
  });

  test("a query hides the default unless every word is in its label, and offers the typed name last", () => {
    expect(summary(branchRows([b("medl-1223-ai-app")], "medl", "New branch harness/web-4", newLabel))).toEqual(["branch:medl-1223-ai-app", "new:Create medl"]);
    expect(summary(branchRows([], "harness", "New branch harness/web-4", newLabel))).toEqual(["default:New branch harness/web-4", "new:Create harness"]);
    expect(summary(branchRows([], "new web", "New branch harness/web-4", newLabel))[0]).toBe("default:New branch harness/web-4");
    expect(branchRows([], "new zzz", "New branch harness/web-4", newLabel).map((r) => r.kind)).toEqual(["invalid"]);
  });

  test("an exact match isn't offered again as a new branch", () => {
    expect(summary(branchRows([b("develop"), b("develop-2")], " develop ", "x", newLabel))).toEqual(["branch:develop", "branch:develop-2"]);
  });

  test("a name git would refuse becomes an unpickable row saying why", () => {
    const rows = branchRows([], "feat..x", "x", newLabel);
    expect(rows.map((r) => r.kind)).toEqual(["invalid"]);
    expect(rows[0]!.label).toBe("Not a valid branch name: a branch name can't contain ..");
    expect(pickableIds(rows)).toEqual([]);
  });

  test("pickable ids: the default is \"\", branches and new names their name", () => {
    expect(pickableIds(branchRows([b("main")], "", "Default", newLabel))).toEqual(["", "main"]);
    expect(pickableIds(branchRows([b("main")], "ma", "Default", newLabel))).toEqual(["main", "ma"]);
  });
});

test("predicted key skips keys already taken, like the service", () => {
  expect(predictedTicketKey({ key: "WEB", nextSeq: 4 })).toBe("WEB-4");
  const taken = new Set(["WEB-4", "WEB-5", "WEB-7"]);
  expect(predictedTicketKey({ key: "WEB", nextSeq: 4 }, (k) => taken.has(k))).toBe("WEB-6");
  expect(newTicketBranchLabel("WEB-4")).toBe("New branch harness/web-4");
});

test("inherited base label names where the value comes from", () => {
  expect(inheritedBaseLabel({ branch: "main", source: "settings" })).toBe("main (app default)");
  expect(inheritedBaseLabel({ branch: "develop", source: "project" })).toBe("develop (project default)");
  expect(inheritedBaseLabel({ branch: "release", source: "ticket" })).toBe("release (ticket)");
});

test("branch choice: blank is the default, a listed name is existing, else new or invalid", () => {
  const known = [b("main", "/Users/me/app"), b("feature/x")];
  expect(branchChoice(null, "harness/web-4", known)).toEqual({ kind: "default", name: "harness/web-4" });
  expect(branchChoice("  ", "harness/web-4", known)).toEqual({ kind: "default", name: "harness/web-4" });
  expect(branchChoice("feature/x", "harness/web-4", known)).toEqual({ kind: "existing", name: "feature/x", checkedOutAt: null });
  expect(branchChoice("main", "harness/web-4", known)).toEqual({ kind: "existing", name: "main", checkedOutAt: "/Users/me/app" });
  expect(branchChoice(" feature/y ", "harness/web-4", known)).toEqual({ kind: "new", name: "feature/y" });
  expect(branchChoice("bad name", "harness/web-4", known).kind).toBe("invalid");
  // A stale harness/<key> branch left by a deleted ticket is checked out as is, not recreated.
  expect(branchChoice(null, "harness/web-4", [b("harness/web-4")]).kind).toBe("existing");
});

test("branch hints say what happens; checked out elsewhere warns and names the path", () => {
  expect(branchChoiceHint({ kind: "default", name: "harness/web-4" }, "develop")).toEqual({ text: "A new branch, created from develop when work starts.", tone: "plain" });
  expect(branchChoiceHint({ kind: "new", name: "feature/y" }, "main").text).toBe("feature/y doesn't exist yet. It will be created from main when work starts.");
  const busy = branchChoiceHint({ kind: "existing", name: "x", checkedOutAt: "/Users/me/wt/x" }, "main");
  expect(busy.tone).toBe("warn");
  expect(busy.text).toContain("Checked out in ~/wt/x");
  expect(branchChoiceHint({ kind: "existing", name: "x", checkedOutAt: null }, "main")).toEqual({ text: "An existing branch: the ticket's worktree checks it out as is.", tone: "plain" });
  expect(branchChoiceHint({ kind: "invalid", name: "a b", error: "no spaces" }, "main")).toEqual({ text: "Not a valid branch name: no spaces.", tone: "error" });
});

test("branch is editable only before the worktree exists, for worktree tickets", () => {
  const git = { isGit: true, useWorktrees: true };
  const fresh = { branch: null, useWorktree: null, workdir: null, status: "planning" as const };
  expect(canChangeBranch(fresh, git)).toBe(true);
  expect(canChangeBranch({ ...fresh, workdir: "/wt/WEB-4", branch: "harness/web-4", status: "in_progress" }, git)).toBe(false);
  expect(canChangeBranch({ ...fresh, status: "done" }, git)).toBe(false);
  expect(canChangeBranch({ ...fresh, useWorktree: false }, git)).toBe(false);
  expect(canChangeBranch(fresh, { isGit: false, useWorktrees: true })).toBe(false);
  expect(canChangeBranch(fresh, { isGit: true, useWorktrees: false })).toBe(false);
  expect(canChangeBranch({ ...fresh, useWorktree: true }, { isGit: true, useWorktrees: false })).toBe(true);
  // Once it has a branch it keeps showing it, even if the project stopped using worktrees.
  expect(ticketHasBranch({ branch: "x", useWorktree: null }, { isGit: true, useWorktrees: false })).toBe(true);
  expect(ticketHasBranch({ branch: null, useWorktree: null }, null)).toBe(false);
});
