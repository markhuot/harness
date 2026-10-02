import { describe, expect, test } from "bun:test";
import type { BranchInfo, Project, Ticket } from "../protocol";
import { branchChoice, branchChoiceHint, checkoutBranch, samePath } from "./branches";
import {
  applyTicketPatch,
  blankDraftTicket,
  draftBranchPatch,
  draftBranchPick,
  draftBranchValue,
  draftCreateBody,
  draftDefaultBranchLabel,
  draftIsEmpty,
  draftPatch,
  draftReviewSkipsPatch,
  newSessionOptionsSummary,
  optionsNeedAttention,
  projectReviewSkips,
  ticketBranchHint,
  ticketSettingsRows,
} from "./drafts";

const project = (over: Partial<Project> = {}): Project =>
  ({ id: "p1", key: "WEB", name: "web", path: "/Users/me/web", nextSeq: 4, isGit: true, useWorktrees: true, defaultDriver: null, defaultModels: {}, baseBranch: null, skipAgentReview: false, skipHumanReview: false, createdAt: 0, updatedAt: 0, ...over }) as Project;
const settings = { defaultDriver: "claude-code", defaultModels: {}, baseBranch: "main" };
const blank = (p = project()) => blankDraftTicket(p, settings, "WEB-4", 1);
const b = (name: string, checkedOutAt: string | null = null): BranchInfo => ({ name, lastCommitAt: 1, checkedOutAt });
const main = b("main", "/Users/me/web/");
const launched = (over: Partial<Ticket> = {}): Ticket => ({ ...blank(), key: "WEB-4", draft: false, ...over });

describe("blank drafts", () => {
  test("start on the project's driver with every setting inherited, and count as empty", () => {
    const t = blank();
    expect(t.driver).toBe("claude-code");
    expect(t.draft).toBe(true);
    expect(draftIsEmpty(t, project(), settings)).toBe(true);
  });

  test("any prompt text, kind or override makes a draft worth keeping", () => {
    const p = project();
    expect(draftIsEmpty({ ...blank(), description: "  " }, p, settings)).toBe(true);
    expect(draftIsEmpty({ ...blank(), description: "Fix it" }, p, settings)).toBe(false);
    expect(draftIsEmpty({ ...blank(), kind: "conductor" }, p, settings)).toBe(false);
    expect(draftIsEmpty({ ...blank(), driver: "codex" }, p, settings)).toBe(false);
    expect(draftIsEmpty({ ...blank(), model: "sonnet" }, p, settings)).toBe(false);
    expect(draftIsEmpty({ ...blank(), useWorktree: false }, p, settings)).toBe(false);
    expect(draftIsEmpty({ ...blank(), dependsOn: ["WEB-1"] }, p, settings)).toBe(false);
  });
});

describe("applyTicketPatch", () => {
  test("a driver change clears the model unless one comes with it", () => {
    const t = { ...blank(), model: "opus" };
    expect(applyTicketPatch(t, { driver: "codex" }).model).toBeNull();
    expect(applyTicketPatch(t, { driver: "codex", model: "luna" }).model).toBe("luna");
    expect(applyTicketPatch(t, { driver: "claude-code" }).model).toBe("opus");
  });

  test("blank branch names mean the default, and draft-only fields apply", () => {
    const t = applyTicketPatch(blank(), { branch: " ", baseBranch: "", kind: "conductor", useWorktree: false, projectId: "p2" });
    expect([t.requestedBranch, t.baseBranch, t.kind, t.useWorktree, t.projectId]).toEqual([null, null, "conductor", false, "p2"]);
  });
});

describe("draftCreateBody", () => {
  test("a worktree draft sends its branch and base", () => {
    const body = draftCreateBody({ ...blank(), description: "Go", requestedBranch: "feat", baseBranch: "develop" }, project());
    expect(body).toMatchObject({ draft: true, start: false, prompt: "Go", branch: "feat", baseBranch: "develop", useWorktree: null });
  });

  test("no worktree drops branch and base (the service refuses a branch without one)", () => {
    const body = draftCreateBody({ ...blank(), requestedBranch: "feat", baseBranch: "develop", useWorktree: false }, project());
    expect(body.useWorktree).toBe(false);
    expect("branch" in body || "baseBranch" in body).toBe(false);
  });

  test("a non-git project sends no worktree choice", () => {
    expect(draftCreateBody({ ...blank(), useWorktree: true }, project({ isGit: false })).useWorktree).toBeNull();
  });

  test("both review switches always go (the service would fill in the project's otherwise); dependencies only when set", () => {
    expect(draftCreateBody(blank(), project())).toMatchObject({ skipAgentReview: false, skipHumanReview: false });
    expect("dependsOn" in draftCreateBody(blank(), project())).toBe(false);
    expect(draftCreateBody({ ...blank(), skipAgentReview: true, dependsOn: ["WEB-1"] }, project())).toMatchObject({ skipAgentReview: true, dependsOn: ["WEB-1"] });
    // Turned back on in a project that skips it by default: the false has to reach the service.
    const skipping = project({ skipHumanReview: true });
    expect(draftCreateBody({ ...blank(skipping), skipHumanReview: false }, skipping)).toMatchObject({ skipHumanReview: false });
  });

  test("skipping the human review alone makes a draft worth saving", () => {
    expect(draftIsEmpty({ ...blank(), skipHumanReview: true }, project(), settings)).toBe(false);
    expect(draftPatch(blank(), { ...blank(), skipHumanReview: true })).toEqual({ skipHumanReview: true });
  });
});

describe("the project's review defaults", () => {
  const skipping = project({ skipAgentReview: true, skipHumanReview: true });

  test("a blank draft starts on them and is still empty there; flipping one back makes it worth saving", () => {
    const t = blank(skipping);
    expect([t.skipAgentReview, t.skipHumanReview]).toEqual([true, true]);
    expect(draftIsEmpty(t, skipping, settings)).toBe(true);
    expect(draftIsEmpty({ ...t, skipAgentReview: false }, skipping, settings)).toBe(false);
    // An older service sends no defaults: nothing skipped.
    expect(projectReviewSkips({})).toEqual({ skipAgentReview: false, skipHumanReview: false });
  });

  test("the summary names a switch only where it differs from the project's", () => {
    expect(newSessionOptionsSummary(blank(skipping), skipping, settings)).toEqual([]);
    expect(newSessionOptionsSummary({ ...blank(skipping), skipAgentReview: false, skipHumanReview: false }, skipping, settings)).toEqual(["With agent review", "With human review"]);
  });

  test("moving projects, a switch on the old project's default follows the new one; a flipped one stays", () => {
    const plain = project({ id: "p2" });
    expect(draftReviewSkipsPatch(blank(skipping), skipping, plain)).toEqual({ skipAgentReview: false, skipHumanReview: false });
    expect(draftReviewSkipsPatch(blank(plain), plain, skipping)).toEqual({ skipAgentReview: true, skipHumanReview: true });
    // Flipped away from the old default: kept.
    expect(draftReviewSkipsPatch({ ...blank(plain), skipHumanReview: true }, plain, skipping)).toEqual({ skipAgentReview: true });
    expect(draftReviewSkipsPatch({ ...blank(skipping), skipAgentReview: false }, skipping, plain)).toEqual({ skipHumanReview: false });
    // Same defaults on both: nothing to send.
    expect(draftReviewSkipsPatch(blank(plain), plain, project({ id: "p3" }))).toEqual({});
  });
});

describe("draftPatch", () => {
  test("nothing changed: null", () => {
    expect(draftPatch(blank(), { ...blank() })).toBeNull();
  });

  test("only the changed fields, with branch names mapped to the PATCH's", () => {
    const prev = { ...blank(), description: "a" };
    expect(draftPatch(prev, { ...prev, description: "ab", requestedBranch: "feat" })).toEqual({ description: "ab", branch: "feat" });
    expect(draftPatch(prev, { ...prev, dependsOn: ["WEB-1"] })).toEqual({ dependsOn: ["WEB-1"] });
    expect(draftPatch({ ...prev, dependsOn: ["WEB-1"] }, { ...prev, dependsOn: ["WEB-1"] })).toBeNull();
  });

  test("a driver change sends the model along, so the service doesn't clear it", () => {
    const prev = { ...blank(), model: "luna" };
    expect(draftPatch(prev, { ...prev, driver: "codex" })).toEqual({ driver: "codex", model: "luna" });
  });
});

describe("ticketSettingsRows", () => {
  test("a draft on a git project always shows Branch (the checkout is how it drops the worktree), Base only with a worktree", () => {
    const rows = ticketSettingsRows({ ...blank(), useWorktree: false }, project());
    expect(rows.branch).toEqual({ show: true, editable: true, offerCheckout: true });
    expect(rows.base.show).toBe(false);
    expect(ticketSettingsRows(blank(), project()).base.show).toBe(true);
  });

  test("no Branch or Base row outside git", () => {
    const rows = ticketSettingsRows(blank(), project({ isGit: false }));
    expect([rows.branch.show, rows.base.show]).toEqual([false, false]);
  });

  test("a launched ticket's branch is editable only until its worktree exists, and never offers the checkout", () => {
    expect(ticketSettingsRows(launched(), project()).branch).toEqual({ show: true, editable: true, offerCheckout: false });
    expect(ticketSettingsRows(launched({ status: "in_progress", workdir: "/w", branch: "harness/web-4" }), project()).branch.editable).toBe(false);
  });

  test("done: nothing editable; busy: the driver is locked", () => {
    const done = ticketSettingsRows(launched({ status: "done" }), project());
    expect([done.editable, done.branch.editable]).toEqual([false, false]);
    expect(ticketSettingsRows(launched({ busy: true, driver: "codex" }), project()).onlyDriver).toBe("codex");
    expect(ticketSettingsRows(launched(), project()).onlyDriver).toBeUndefined();
  });
});

describe("the draft branch pick", () => {
  test("the project directory's branch is the checkout (trailing slashes don't matter)", () => {
    expect(samePath("/Users/me/web/", "/Users/me/web")).toBe(true);
    expect(samePath("/Users/me/web2", "/Users/me/web")).toBe(false);
    expect(checkoutBranch([b("dev", "/tmp/wt"), main], "/Users/me/web")).toBe(main);
    expect(draftBranchPick("main", main)).toEqual({ kind: "checkout" });
    expect(draftBranchPick("dev", main)).toEqual({ kind: "branch", name: "dev" });
    expect(draftBranchPick(null, main)).toEqual({ kind: "default" });
  });

  test("its PATCH keeps following the project when the pick is what the project does anyway", () => {
    const wt = project();
    const direct = project({ useWorktrees: false });
    expect(draftBranchPatch({ kind: "checkout" }, wt)).toEqual({ branch: null, useWorktree: false });
    expect(draftBranchPatch({ kind: "checkout" }, direct)).toEqual({ branch: null, useWorktree: null });
    expect(draftBranchPatch({ kind: "branch", name: "dev" }, wt)).toEqual({ branch: "dev", useWorktree: null });
    expect(draftBranchPatch({ kind: "branch", name: "dev" }, direct)).toEqual({ branch: "dev", useWorktree: true });
  });

  test("the row shows the checkout when the draft picked it over the project's worktrees", () => {
    expect(draftBranchValue({ useWorktree: false, requestedBranch: null }, project(), main)).toBe("main");
    expect(draftBranchValue({ useWorktree: null, requestedBranch: null }, project({ useWorktrees: false }), main)).toBeNull();
    expect(draftBranchValue({ useWorktree: null, requestedBranch: "dev" }, project(), main)).toBe("dev");
    expect(draftDefaultBranchLabel("WEB-4", project({ useWorktrees: false }), main)).toBe("main · project directory");
    expect(draftDefaultBranchLabel("WEB-4", project(), main)).toBe("New branch harness/web-4");
  });

  test("hints: the checkout works in place; launched tickets still warn it would block", () => {
    const hint = ticketBranchHint({ ...blank(), useWorktree: false }, project(), settings, [main], main);
    expect(hint).toEqual({ text: "Works directly in ~/web/ on main, with no worktree.", tone: "plain" });
    expect(ticketBranchHint({ ...blank(), requestedBranch: "main" }, project(), settings, [main], main).tone).toBe("plain");
    expect(ticketBranchHint(launched({ requestedBranch: "main" }), project(), settings, [main], main).tone).toBe("warn");
    expect(branchChoiceHint(branchChoice("main", "harness/web-4", [main]), "main").tone).toBe("warn");
  });

  test("a warning or a bad name opens Options", () => {
    expect(optionsNeedAttention({ tone: "plain" })).toBe(false);
    expect(optionsNeedAttention({ tone: "warn" })).toBe(true);
    expect(optionsNeedAttention({ tone: "error" })).toBe(true);
  });
});

describe("newSessionOptionsSummary", () => {
  const labels = { model: (_d: string, m: string | null) => (m === "sonnet" ? "Sonnet 5" : null), checkoutName: "main" };

  test("defaults: nothing to show", () => {
    expect(newSessionOptionsSummary(blank(), project(), settings, labels)).toEqual([]);
  });

  test("each override, in row order", () => {
    const t = { ...blank(), model: "sonnet", permissionMode: "read_only" as const, requestedBranch: "feat", baseBranch: "develop", skipAgentReview: true, skipHumanReview: true, dependsOn: ["WEB-1"] };
    expect(newSessionOptionsSummary(t, project(), settings, labels)).toEqual(["Sonnet 5", "Read only", "feat", "into develop", "Skip agent review", "Skip human review", "After WEB-1"]);
  });

  test("the checkout pick reads as no worktree, and hides the base", () => {
    expect(newSessionOptionsSummary({ ...blank(), useWorktree: false, baseBranch: "develop" }, project(), settings, labels)).toEqual(["main · no worktree"]);
  });

  test("a worktree on a project that doesn't use them shows the branch it will get", () => {
    expect(newSessionOptionsSummary({ ...blank(), useWorktree: true }, project({ useWorktrees: false }), settings, labels)).toEqual(["harness/web-4"]);
  });
});
