import { describe, expect, test } from "bun:test";
import type { BranchInfo } from "../../../shared/src/protocol";
import {
  branchChoice,
  branchChoiceHint,
  branchRows,
  canChangeBranch,
  checkoutBranch,
  inheritedBaseLabel,
  newTicketBranchLabel,
  pickableIds,
  predictedTicketKey,
  rowId,
  samePath,
  ticketHasBranch,
} from "../../../shared/src/state/branches";

const info = (name: string, checkedOutAt: string | null = null): BranchInfo => ({ name, lastCommitAt: 0, checkedOutAt });

describe("predictedTicketKey", () => {
  test("is KEY-nextSeq when free, skips taken keys", () => {
    expect(predictedTicketKey({ key: "AB", nextSeq: 3 })).toBe("AB-3");
    const taken = new Set(["AB-3", "AB-4"]);
    expect(predictedTicketKey({ key: "AB", nextSeq: 3 }, (k) => taken.has(k))).toBe("AB-5");
  });
});

describe("labels", () => {
  test("new ticket branch label lower-cases the key", () => {
    expect(newTicketBranchLabel("AB-3")).toBe("New branch harness/ab-3");
  });

  test("inherited base label names each source", () => {
    expect(inheritedBaseLabel({ branch: "main", source: "settings" })).toBe("main (app default)");
    expect(inheritedBaseLabel({ branch: "dev", source: "project" })).toBe("dev (project default)");
    expect(inheritedBaseLabel({ branch: "p", source: "parent" })).toBe("p (parent ticket's branch)");
    expect(inheritedBaseLabel({ branch: "t", source: "ticket" })).toBe("t (ticket)");
  });
});

describe("branchRows", () => {
  const label = (n: string) => `Create ${n}`;

  test("no query: default first, then branches in order, no typed row", () => {
    const rows = branchRows([info("main"), info("dev")], "", "New branch harness/x-1", label);
    expect(rows.map((r) => r.kind)).toEqual(["default", "branch", "branch"]);
    expect(rows[1]).toMatchObject({ value: "main", label: "main" });
  });

  test("the default stays while every query word is in its label, case-insensitively", () => {
    const rows = branchRows([], "harness NEW", "New branch harness/x-1", label);
    expect(rows[0]!.kind).toBe("default");
  });

  test("the default hides when any query word is missing from its label", () => {
    const rows = branchRows([], "harness zzz", "New branch harness/x-1", label);
    expect(rows.some((r) => r.kind === "default")).toBe(false);
  });

  test("a typed name the list lacks gets a new row; an exact match does not", () => {
    expect(branchRows([info("main")], "feat", "d", label).at(-1)).toEqual({ kind: "new", value: "feat", label: "Create feat" });
    expect(branchRows([info("main")], "main", "d", label).some((r) => r.kind === "new")).toBe(false);
  });

  test("a partial match still adds a new row for the full typed name", () => {
    const rows = branchRows([info("main-old")], "main", "d", label);
    expect(rows.map((r) => r.kind)).toEqual(["branch", "new"]);
  });

  test("a name git refuses becomes an invalid, unpickable row with the reason", () => {
    const row = branchRows([], "a..b", "d", label).at(-1)!;
    expect(row.kind).toBe("invalid");
    expect(row.value).toBeNull();
    expect(row.label).toContain("can't contain ..");
  });

  test("query is trimmed before use", () => {
    expect(branchRows([], "  feat  ", "d", label).at(-1)).toMatchObject({ kind: "new", value: "feat" });
  });
});

describe("rowId / pickableIds", () => {
  test("default is the empty string, branches their name, invalid null", () => {
    expect(rowId({ kind: "default", value: null, label: "d" })).toBe("");
    expect(rowId({ kind: "new", value: "x", label: "l" })).toBe("x");
    expect(rowId({ kind: "invalid", value: null, label: "l" })).toBeNull();
  });

  test("pickable ids drop invalid rows and keep order", () => {
    const rows = branchRows([info("main")], "a b", "zz", (n) => n);
    // "a b" has a space, so the typed row is invalid; default hidden
    expect(pickableIds(rows)).toEqual(["main"]);
    expect(pickableIds(branchRows([info("main")], "", "d", (n) => n))).toEqual(["", "main"]);
  });
});

describe("samePath / checkoutBranch", () => {
  test("trailing slashes don't matter; blanks never match", () => {
    expect(samePath("/a/b/", "/a/b")).toBe(true);
    expect(samePath("/a/b", "/a/c")).toBe(false);
    expect(samePath(null, null)).toBe(false);
    expect(samePath("", "")).toBe(false);
    expect(samePath("/", "//")).toBe(true);
  });

  test("checkoutBranch finds the branch checked out at the project path", () => {
    const list = [info("a", "/other"), info("main", "/p/")];
    expect(checkoutBranch(list, "/p")?.name).toBe("main");
    expect(checkoutBranch(list, "/nope")).toBeNull();
    expect(checkoutBranch(list, null)).toBeNull();
  });
});

describe("branchChoice", () => {
  test("blank or null name means the default; unknown default is a default choice", () => {
    expect(branchChoice(null, "harness/x-1", [])).toEqual({ kind: "default", name: "harness/x-1" });
    expect(branchChoice("   ", "harness/x-1", [])).toEqual({ kind: "default", name: "harness/x-1" });
  });

  test("a default that already exists is an existing branch", () => {
    expect(branchChoice(null, "harness/x-1", [info("harness/x-1")])).toEqual({ kind: "existing", name: "harness/x-1", checkedOutAt: null });
  });

  test("an existing branch reports where it is checked out", () => {
    expect(branchChoice("main", "d", [info("main", "/repo")])).toEqual({ kind: "existing", name: "main", checkedOutAt: "/repo" });
  });

  test("an unknown valid name is new; an invalid one carries the error", () => {
    expect(branchChoice("feat", "d", [])).toEqual({ kind: "new", name: "feat" });
    const bad = branchChoice("-x", "d", []);
    expect(bad.kind).toBe("invalid");
    expect((bad as { error: string }).error).toContain("start with -");
  });

  test("the project dir's own branch is a checkout only when a checkout path is passed (drafts)", () => {
    const known = [info("main", "/p")];
    expect(branchChoice("main", "d", known, "/p/")).toEqual({ kind: "checkout", name: "main", path: "/p" });
    expect(branchChoice("main", "d", known, "/elsewhere")).toMatchObject({ kind: "existing" });
    expect(branchChoice("main", "d", known)).toMatchObject({ kind: "existing" });
    expect(branchChoice("main", "d", known, null)).toMatchObject({ kind: "existing" });
  });
});

describe("branchChoiceHint", () => {
  test("each kind has its tone", () => {
    expect(branchChoiceHint({ kind: "default", name: "n" }, "main")).toMatchObject({ tone: "plain", text: expect.stringContaining("from main") });
    expect(branchChoiceHint({ kind: "new", name: "feat" }, "dev")).toMatchObject({ tone: "plain", text: expect.stringContaining("feat doesn't exist yet") });
    expect(branchChoiceHint({ kind: "invalid", name: "x", error: "bad thing" }, "m")).toEqual({ text: "Not a valid branch name: bad thing.", tone: "error" });
  });

  test("checked-out elsewhere warns, free existing is plain", () => {
    expect(branchChoiceHint({ kind: "existing", name: "m", checkedOutAt: "/Users/me/wt" }, "m")).toMatchObject({ tone: "warn", text: expect.stringContaining("~/wt") });
    expect(branchChoiceHint({ kind: "existing", name: "m", checkedOutAt: null }, "m").tone).toBe("plain");
  });

  test("checkout shows a tildified path and no worktree", () => {
    const hint = branchChoiceHint({ kind: "checkout", name: "main", path: "/Users/me/code" }, "m");
    expect(hint.text).toBe("Works directly in ~/code on main, with no worktree.");
  });
});

describe("ticketHasBranch / canChangeBranch", () => {
  const proj = { isGit: true, useWorktrees: true };

  test("an existing branch always counts, even without a project", () => {
    expect(ticketHasBranch({ branch: "b" }, null)).toBe(true);
  });

  test("without a branch it follows the project: git and worktrees", () => {
    expect(ticketHasBranch({ branch: null }, null)).toBe(false);
    expect(ticketHasBranch({ branch: null }, proj)).toBe(true);
    expect(ticketHasBranch({ branch: null }, { isGit: false, useWorktrees: true })).toBe(false);
    expect(ticketHasBranch({ branch: null }, { isGit: true, useWorktrees: false })).toBe(false);
  });

  test("isGit undefined is treated as git", () => {
    expect(ticketHasBranch({ branch: null }, { useWorktrees: true } as never)).toBe(true);
  });

  test("a ticket-level useWorktree overrides the project, including false", () => {
    expect(ticketHasBranch({ branch: null, useWorktree: false }, proj)).toBe(false);
    expect(ticketHasBranch({ branch: null, useWorktree: true }, { isGit: true, useWorktrees: false })).toBe(true);
  });

  test("can change only before a worktree exists and while not done", () => {
    const t = { branch: null, workdir: null, status: "planning" as const };
    expect(canChangeBranch(t, proj)).toBe(true);
    expect(canChangeBranch({ ...t, workdir: "/w" }, proj)).toBe(false);
    expect(canChangeBranch({ ...t, status: "done" }, proj)).toBe(false);
    expect(canChangeBranch(t, null)).toBe(false);
  });
});
