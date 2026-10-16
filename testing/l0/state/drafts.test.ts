import { describe, expect, test } from "bun:test";
import type { BranchInfo, Project, Ticket } from "../../../shared/src/protocol";
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
  draftUsesWorktree,
  newSessionOptionsSummary,
  optionsNeedAttention,
  projectReviewSkips,
  ticketBranchChoice,
  ticketBranchHint,
  ticketSettingsRows,
} from "../../../shared/src/state/drafts";
import { makeTicket } from "../../builders/ticket";

type DraftProject = Parameters<typeof blankDraftTicket>[0];

const project = (over: Partial<DraftProject> = {}): DraftProject => ({
  id: "p1",
  path: "/Users/me/code",
  isGit: true,
  useWorktrees: true,
  defaultDriver: "claude-code",
  defaultModels: {},
  baseBranch: null,
  skipAgentReview: false,
  skipHumanReview: false,
  ...over,
});
const settings = { defaultDriver: "claude-code", defaultModels: {}, baseBranch: "main" };
const draft = (over: Partial<Ticket> = {}): Ticket => ({ ...blankDraftTicket(project(), settings, "TEST-5", 1000), ...over });
const info = (name: string, checkedOutAt: string | null = null): BranchInfo => ({ name, lastCommitAt: 0, checkedOutAt });

describe("projectReviewSkips / draftReviewSkipsPatch", () => {
  test("missing project means both off; flags are coerced to booleans", () => {
    expect(projectReviewSkips(null)).toEqual({ skipAgentReview: false, skipHumanReview: false });
    expect(projectReviewSkips({ skipAgentReview: true, skipHumanReview: undefined })).toEqual({ skipAgentReview: true, skipHumanReview: false });
  });

  test("a switch on its old project's default follows the new project's", () => {
    const patch = draftReviewSkipsPatch({ skipAgentReview: false, skipHumanReview: false }, { skipAgentReview: false, skipHumanReview: false }, { skipAgentReview: true, skipHumanReview: false });
    expect(patch).toEqual({ skipAgentReview: true });
  });

  test("a switch the user flipped stays flipped", () => {
    // user turned agent review skip on while the old project had it off; the new project has it off too
    const patch = draftReviewSkipsPatch({ skipAgentReview: true, skipHumanReview: false }, { skipAgentReview: false, skipHumanReview: false }, { skipAgentReview: true, skipHumanReview: true });
    expect(patch).toEqual({ skipHumanReview: true });
  });

  test("no change when the two projects agree", () => {
    const same = { skipAgentReview: true, skipHumanReview: false };
    expect(draftReviewSkipsPatch({ skipAgentReview: true, skipHumanReview: false }, same, same)).toEqual({});
  });

  test("a null project on either side counts as defaults off", () => {
    expect(draftReviewSkipsPatch({ skipAgentReview: false, skipHumanReview: false }, null, { skipAgentReview: true })).toEqual({ skipAgentReview: true });
    expect(draftReviewSkipsPatch({ skipAgentReview: true, skipHumanReview: false }, { skipAgentReview: true }, null)).toEqual({ skipAgentReview: false });
  });
});

describe("blankDraftTicket", () => {
  test("is a draft in planning inheriting the project, with its review switches and the given clock", () => {
    const t = blankDraftTicket(project({ skipHumanReview: true }), settings, "TEST-7", 42);
    expect(t).toMatchObject({ draft: true, status: "planning", key: "TEST-7", projectId: "p1", skipAgentReview: false, skipHumanReview: true, createdAt: 42, updatedAt: 42, model: null, useWorktree: null });
  });

  test("the driver comes from the project, else the settings, else empty", () => {
    expect(blankDraftTicket(project({ defaultDriver: "codex" }), settings, "T-1").driver).toBe("codex");
    expect(blankDraftTicket(project({ defaultDriver: null }), settings, "T-1").driver).toBe("claude-code");
    expect(blankDraftTicket(project({ defaultDriver: null }), null, "T-1").driver).toBe("");
  });
});

describe("applyTicketPatch", () => {
  test("returns a new ticket and leaves the original alone", () => {
    const t = draft();
    const next = applyTicketPatch(t, { title: "x" });
    expect(next).not.toBe(t);
    expect(t.title).toBe("");
    expect(next.title).toBe("x");
  });

  test("a driver change clears the model unless one comes along", () => {
    const t = draft({ model: "opus" });
    expect(applyTicketPatch(t, { driver: "codex" })).toMatchObject({ driver: "codex", model: null });
    expect(applyTicketPatch(t, { driver: "codex", model: "gpt" })).toMatchObject({ driver: "codex", model: "gpt" });
  });

  test("the same driver keeps the model", () => {
    expect(applyTicketPatch(draft({ model: "opus" }), { driver: "claude-code" }).model).toBe("opus");
  });

  test("an empty model string becomes null", () => {
    expect(applyTicketPatch(draft({ model: "opus" }), { model: "" }).model).toBeNull();
  });

  test("a work phase choice sets the driver and model; clearing work resets the model", () => {
    const withWork = applyTicketPatch(draft(), { phaseModels: { work: { driver: "codex", model: "gpt" } } });
    expect(withWork).toMatchObject({ driver: "codex", model: "gpt", phaseModels: { work: { driver: "codex", model: "gpt" } } });
    const cleared = applyTicketPatch(withWork, { phaseModels: { work: null } });
    expect(cleared.model).toBeNull();
    expect(cleared.driver).toBe("codex"); // the driver stays: only the choice is cleared
    expect(cleared.phaseModels?.work).toBeUndefined();
  });

  test("a non-work phase choice merges without touching the driver, and clears the model", () => {
    const next = applyTicketPatch(draft({ model: "opus" }), { phaseModels: { review: { driver: "codex", model: null } } });
    expect(next.driver).toBe("claude-code");
    expect(next.model).toBeNull();
    expect(next.phaseModels).toEqual({ review: { driver: "codex", model: null } });
  });

  test("blank branch strings mean the default; names are trimmed", () => {
    expect(applyTicketPatch(draft({ requestedBranch: "x" }), { branch: "  " }).requestedBranch).toBeNull();
    expect(applyTicketPatch(draft(), { branch: " feat " }).requestedBranch).toBe("feat");
    expect(applyTicketPatch(draft({ baseBranch: "x" }), { baseBranch: "" }).baseBranch).toBeNull();
    expect(applyTicketPatch(draft(), { baseBranch: null }).baseBranch).toBeNull();
    expect(applyTicketPatch(draft({ requestedBranch: "x" }), { branch: null }).requestedBranch).toBeNull();
  });

  test("an omitted field is left alone and an explicit false/0 is applied", () => {
    const t = draft({ skipAgentReview: true, position: 5, useWorktree: true });
    expect(applyTicketPatch(t, { title: "t" })).toMatchObject({ skipAgentReview: true, position: 5, useWorktree: true });
    expect(applyTicketPatch(t, { skipAgentReview: false, position: 0, useWorktree: false })).toMatchObject({ skipAgentReview: false, position: 0, useWorktree: false });
  });

  test("dependsOn is copied, not aliased", () => {
    const deps = ["A-1"];
    const next = applyTicketPatch(draft(), { dependsOn: deps });
    deps.push("A-2");
    expect(next.dependsOn).toEqual(["A-1"]);
  });

  test("attachment inputs become attachments with defaults filled in", () => {
    const next = applyTicketPatch(draft(), { promptAttachments: [{ path: "/tmp/shot.png" }] });
    expect(next.promptAttachments).toHaveLength(1);
    expect(next.promptAttachments![0]).toMatchObject({ path: "/tmp/shot.png", name: "shot.png" });
  });
});

describe("draftUsesWorktree", () => {
  test("needs a git project; the ticket's pick beats the project's setting", () => {
    expect(draftUsesWorktree({ useWorktree: null }, null)).toBe(false);
    expect(draftUsesWorktree({ useWorktree: null }, { isGit: false, useWorktrees: true })).toBe(false);
    expect(draftUsesWorktree({ useWorktree: null }, { isGit: true, useWorktrees: true })).toBe(true);
    expect(draftUsesWorktree({ useWorktree: null }, { isGit: true, useWorktrees: false })).toBe(false);
    expect(draftUsesWorktree({ useWorktree: false }, { isGit: true, useWorktrees: true })).toBe(false);
    expect(draftUsesWorktree({ useWorktree: true }, { isGit: true, useWorktrees: false })).toBe(true);
    expect(draftUsesWorktree({ useWorktree: true }, { isGit: false, useWorktrees: false })).toBe(false);
  });
});

describe("draftIsEmpty", () => {
  const p = project();
  test("a blank draft is empty", () => {
    expect(draftIsEmpty(draft(), p, settings)).toBe(true);
  });

  test("any single meaningful setting makes it non-empty", () => {
    const changes: Partial<Ticket>[] = [
      { spec: "do it" },
      { promptAttachments: [{ id: "a", path: "/x", name: "x", source: "file", kind: "file", mimeType: "" }] },
      { kind: "bug" as Ticket["kind"] },
      { driver: "codex" },
      { model: "opus" },
      { phaseModels: { work: { driver: "claude-code", model: null } } },
      { permissionMode: "ask" },
      { useWorktree: false },
      { requestedBranch: "feat" },
      { baseBranch: "dev" },
      { skipAgentReview: true },
      { dependsOn: ["A-1"] },
    ];
    for (const c of changes) expect(draftIsEmpty(draft(c), p, settings)).toBe(false);
  });

  test("whitespace-only spec, empty phase models and empty attachments still count as empty", () => {
    expect(draftIsEmpty(draft({ spec: "  \n ", phaseModels: {}, promptAttachments: [] }), p, settings)).toBe(true);
  });

  test("review switches equal to the project's defaults stay empty; differing ones do not", () => {
    const skipping = project({ skipAgentReview: true });
    expect(draftIsEmpty(draft({ skipAgentReview: true }), skipping, settings)).toBe(true);
    expect(draftIsEmpty(draft({ skipAgentReview: false }), skipping, settings)).toBe(false);
  });

  test("a null project: the ticket's own driver differs from the settings driver", () => {
    expect(draftIsEmpty(draft({ driver: "codex" }), null, settings)).toBe(false);
  });
});

describe("draftCreateBody", () => {
  test("a plain draft: draft true, start false, branches from the worktree, both skip flags present", () => {
    const body = draftCreateBody(draft({ spec: "s" }), project());
    expect(body).toMatchObject({ projectId: "p1", spec: "s", draft: true, start: false, skipAgentReview: false, skipHumanReview: false, branch: null, baseBranch: null, useWorktree: null });
    expect("dependsOn" in body).toBe(false);
    expect("promptAttachments" in body).toBe(false);
    expect("phaseModels" in body).toBe(false);
  });

  test("branch and base only go with a worktree", () => {
    const d = draft({ requestedBranch: "feat", baseBranch: "dev", useWorktree: false });
    const noTree = draftCreateBody(d, project());
    expect("branch" in noTree).toBe(false);
    expect("baseBranch" in noTree).toBe(false);
    expect(draftCreateBody({ ...d, useWorktree: null }, project())).toMatchObject({ branch: "feat", baseBranch: "dev" });
  });

  test("a non-git project never sends useWorktree and never sends branches", () => {
    const body = draftCreateBody(draft({ useWorktree: true, requestedBranch: "x" }), project({ isGit: false }));
    expect(body.useWorktree).toBeNull();
    expect("branch" in body).toBe(false);
  });

  test("an empty driver is left out; dependencies, phases and attachments go along when present", () => {
    const body = draftCreateBody(
      draft({ driver: "", dependsOn: ["A-1"], phaseModels: { plan: { driver: "codex", model: null } }, promptAttachments: [{ id: "a", path: "/x/a.png", name: "a.png", source: "file", kind: "image", mimeType: "image/png" }] }),
      project(),
    );
    expect(body.driver).toBeUndefined();
    expect(body.dependsOn).toEqual(["A-1"]);
    expect(body.phaseModels).toEqual({ plan: { driver: "codex", model: null } });
    expect(body.promptAttachments).toHaveLength(1);
  });

  test("phaseModels is copied, not shared", () => {
    const pm = { work: { driver: "codex", model: null } };
    const body = draftCreateBody(draft({ phaseModels: pm }), project());
    expect(body.phaseModels).not.toBe(pm);
  });
});

describe("draftPatch", () => {
  test("null when nothing changed", () => {
    expect(draftPatch(draft(), draft())).toBeNull();
  });

  test("only the changed fields appear; title is never sent", () => {
    expect(draftPatch(draft(), draft({ spec: "new", title: "Different" }))).toEqual({ spec: "new" });
    expect(draftPatch(draft(), draft({ projectId: "p2", kind: "bug" as Ticket["kind"], permissionMode: "ask" }))).toEqual({ projectId: "p2", kind: "bug", permissionMode: "ask" });
  });

  test("null and undefined count as the same for optional fields", () => {
    expect(draftPatch(draft({ useWorktree: null, requestedBranch: null }), draft({ useWorktree: undefined, requestedBranch: undefined }))).toBeNull();
    expect(draftPatch(draft(), draft({ useWorktree: false }))).toEqual({ useWorktree: false });
    expect(draftPatch(draft({ requestedBranch: "x" }), draft({ requestedBranch: null }))).toEqual({ branch: null });
    expect(draftPatch(draft({ baseBranch: null }), draft({ baseBranch: "dev" }))).toEqual({ baseBranch: "dev" });
  });

  test("review switches compare as booleans", () => {
    expect(draftPatch(draft({ skipAgentReview: undefined }), draft({ skipAgentReview: false }))).toBeNull();
    expect(draftPatch(draft(), draft({ skipHumanReview: true }))).toEqual({ skipHumanReview: true });
  });

  test("a driver change sends the model only when the new ticket has one", () => {
    expect(draftPatch(draft(), draft({ driver: "codex" }))).toEqual({ driver: "codex" });
    expect(draftPatch(draft(), draft({ driver: "codex", model: "gpt" }))).toEqual({ driver: "codex", model: "gpt" });
  });

  test("a model change alone sends the model, including clearing it", () => {
    expect(draftPatch(draft(), draft({ model: "opus" }))).toEqual({ model: "opus" });
    expect(draftPatch(draft({ model: "opus" }), draft({ model: null }))).toEqual({ model: null });
  });

  test("phase model changes ride as a per-phase patch, drop the legacy driver, and null a cleared phase", () => {
    const patch = draftPatch(draft({ phaseModels: { review: { driver: "codex", model: null } } }), draft({ driver: "codex", model: "gpt", phaseModels: { work: { driver: "codex", model: "gpt" } } }));
    expect(patch).toEqual({ phaseModels: { work: { driver: "codex", model: "gpt" }, review: null } });
  });

  test("an unchanged phase choice (null model vs missing model) isn't re-sent", () => {
    const a = draft({ phaseModels: { work: { driver: "codex", model: null } } });
    const b = draft({ phaseModels: { work: { driver: "codex", model: "" as unknown as null } } });
    expect(draftPatch(a, b)).toBeNull();
  });

  test("dependsOn compares by content and order", () => {
    expect(draftPatch(draft({ dependsOn: ["A", "B"] }), draft({ dependsOn: ["A", "B"] }))).toBeNull();
    expect(draftPatch(draft({ dependsOn: ["A", "B"] }), draft({ dependsOn: ["B", "A"] }))).toEqual({ dependsOn: ["B", "A"] });
    expect(draftPatch(draft({ dependsOn: ["A"] }), draft({ dependsOn: [] }))).toEqual({ dependsOn: [] });
  });

  test("attachments: a renamed one is a change, an identical list is not", () => {
    const a = { id: "1", path: "/x/a.png", name: "a.png", source: "file" as const, kind: "image" as const, mimeType: "image/png" };
    expect(draftPatch(draft({ promptAttachments: [a] }), draft({ promptAttachments: [{ ...a }] }))).toBeNull();
    const patch = draftPatch(draft({ promptAttachments: [a] }), draft({ promptAttachments: [{ ...a, name: "b.png" }] }));
    expect(patch?.promptAttachments?.[0]).toMatchObject({ name: "b.png" });
    expect(draftPatch(draft({ promptAttachments: [a] }), draft({ promptAttachments: undefined }))).toEqual({ promptAttachments: [] });
  });
});

describe("ticketSettingsRows", () => {
  const proj = { isGit: true, useWorktrees: true };

  test("a draft on a git project always shows the Branch row, offering the checkout", () => {
    const rows = ticketSettingsRows(draft({ useWorktree: false }), proj);
    expect(rows.branch).toEqual({ show: true, editable: true, offerCheckout: true });
    expect(rows.worktree).toBe(false);
    expect(rows.base.show).toBe(false);
  });

  test("a draft on a non-git or missing project has no Branch row", () => {
    expect(ticketSettingsRows(draft(), { isGit: false, useWorktrees: true }).branch.show).toBe(false);
    expect(ticketSettingsRows(draft(), null).branch.show).toBe(false);
  });

  test("a draft with a worktree shows base; a done ticket is not editable", () => {
    const rows = ticketSettingsRows(draft(), proj);
    expect(rows.base).toEqual({ show: true, editable: true });
    const done = ticketSettingsRows(draft({ status: "done" }), proj);
    expect(done.editable).toBe(false);
    expect(done.base.editable).toBe(false);
  });

  test("a real ticket: branch shows with a worktree and can change only before the worktree exists", () => {
    const real = makeTicket({ status: "planning" });
    expect(ticketSettingsRows(real, proj).branch).toEqual({ show: true, editable: true, offerCheckout: false });
    expect(ticketSettingsRows({ ...real, workdir: "/w" }, proj).branch).toEqual({ show: true, editable: false, offerCheckout: false });
    expect(ticketSettingsRows(real, { isGit: false, useWorktrees: true }).branch.show).toBe(false);
    expect(ticketSettingsRows(real, { isGit: false, useWorktrees: true }).base.show).toBe(false);
  });
});

describe("draft branch picks", () => {
  const main = info("main", "/Users/me/code");

  test("draftBranchPick: null is default, the checkout's name is checkout, anything else a branch", () => {
    expect(draftBranchPick(null, main)).toEqual({ kind: "default" });
    expect(draftBranchPick("main", main)).toEqual({ kind: "checkout" });
    expect(draftBranchPick("main", null)).toEqual({ kind: "branch", name: "main" });
    expect(draftBranchPick("feat", main)).toEqual({ kind: "branch", name: "feat" });
  });

  test("draftBranchPatch keeps useWorktree null when the pick is what the project does anyway", () => {
    expect(draftBranchPatch({ kind: "default" }, { useWorktrees: true })).toEqual({ branch: null, useWorktree: null });
    expect(draftBranchPatch({ kind: "checkout" }, { useWorktrees: true })).toEqual({ branch: null, useWorktree: false });
    expect(draftBranchPatch({ kind: "checkout" }, { useWorktrees: false })).toEqual({ branch: null, useWorktree: null });
    expect(draftBranchPatch({ kind: "branch", name: "f" }, { useWorktrees: true })).toEqual({ branch: "f", useWorktree: null });
    expect(draftBranchPatch({ kind: "branch", name: "f" }, { useWorktrees: false })).toEqual({ branch: "f", useWorktree: true });
  });

  test("draftBranchValue: checkout branch when it opted out of the project's worktrees, else the requested branch", () => {
    expect(draftBranchValue({ useWorktree: false, requestedBranch: null }, { useWorktrees: true }, main)).toBe("main");
    expect(draftBranchValue({ useWorktree: false, requestedBranch: null }, { useWorktrees: true }, null)).toBeNull();
    expect(draftBranchValue({ useWorktree: false, requestedBranch: null }, { useWorktrees: false }, main)).toBeNull();
    expect(draftBranchValue({ useWorktree: null, requestedBranch: "feat" }, { useWorktrees: true }, main)).toBe("feat");
    expect(draftBranchValue({ useWorktree: null }, { useWorktrees: true }, main)).toBeNull();
  });

  test("a pick round-trips: checkout pick applied then read back shows the checkout branch", () => {
    const pick = draftBranchPick("main", main);
    const t = applyTicketPatch(draft(), draftBranchPatch(pick, { useWorktrees: true }));
    expect(draftBranchValue(t, { useWorktrees: true }, main)).toBe("main");
  });

  test("default label: new branch with worktrees; otherwise the project directory, named when known", () => {
    expect(draftDefaultBranchLabel("AB-1", { useWorktrees: true }, main)).toBe("New branch harness/ab-1");
    expect(draftDefaultBranchLabel("AB-1", { useWorktrees: false }, main)).toBe("main · project directory");
    expect(draftDefaultBranchLabel("AB-1", { useWorktrees: false }, null)).toBe("Project directory");
  });
});

describe("ticketBranchChoice / ticketBranchHint / optionsNeedAttention", () => {
  const proj = { path: "/Users/me/code", isGit: true, useWorktrees: true, baseBranch: null };

  test("a draft without a worktree works in the project directory, falling back when the branch is unknown", () => {
    const t = draft({ useWorktree: false });
    expect(ticketBranchChoice(t, proj, [], info("main", "/Users/me/code"))).toEqual({ kind: "checkout", name: "main", path: "/Users/me/code" });
    expect(ticketBranchChoice(t, proj, [], null)).toEqual({ kind: "checkout", name: "its current branch", path: "/Users/me/code" });
  });

  test("a draft with a worktree defaults to harness/<key>, a typed name is new, the project's branch is checkout", () => {
    expect(ticketBranchChoice(draft(), proj, [], null)).toEqual({ kind: "default", name: "harness/test-5" });
    expect(ticketBranchChoice(draft({ requestedBranch: "feat" }), proj, [], null)).toEqual({ kind: "new", name: "feat" });
    expect(ticketBranchChoice(draft({ requestedBranch: "main" }), proj, [info("main", "/Users/me/code")], null)).toMatchObject({ kind: "checkout" });
  });

  test("a non-draft pointing at a branch checked out in the project dir blocks as existing, not checkout", () => {
    const t = makeTicket({ status: "planning", key: "T-1", requestedBranch: "main" } as Partial<Ticket> & { status: "planning" });
    expect(ticketBranchChoice(t, proj, [info("main", "/Users/me/code")], null)).toMatchObject({ kind: "existing", checkedOutAt: "/Users/me/code" });
  });

  test("the hint names the resolved base: ticket, project, then settings", () => {
    const hint = (t: Ticket, p = proj) => ticketBranchHint(t, p, { baseBranch: "main" }, [], null).text;
    expect(hint(draft())).toContain("from main");
    expect(hint(draft(), { ...proj, baseBranch: "develop" })).toContain("from develop");
    expect(hint(draft({ baseBranch: "release" }), { ...proj, baseBranch: "develop" })).toContain("from release");
  });

  test("a blocking or invalid pick needs attention; plain does not", () => {
    expect(optionsNeedAttention({ tone: "plain" })).toBe(false);
    expect(optionsNeedAttention({ tone: "warn" })).toBe(true);
    expect(optionsNeedAttention({ tone: "error" })).toBe(true);
  });
});

describe("newSessionOptionsSummary", () => {
  const p = project();
  const summary = (over: Partial<Ticket>, proj: DraftProject = p, labels = {}) => newSessionOptionsSummary(draft(over), proj, settings, labels);

  test("nothing differs from the project: empty", () => {
    expect(summary({})).toEqual([]);
  });

  test("a model pick shows its display name, falling back to model id, then driver name, then driver id", () => {
    expect(summary({ model: "opus" }, p, { model: () => "Opus 5" })).toEqual(["Opus 5"]);
    expect(summary({ model: "opus" })).toEqual(["opus"]);
    expect(summary({ driver: "codex" }, p, { driver: () => "Codex" })).toEqual(["Codex"]);
    expect(summary({ driver: "codex" })).toEqual(["codex"]);
  });

  test("phase picks: Work unlabelled first, others prefixed; a phase equal to Work is folded", () => {
    const out = summary({
      phaseModels: {
        review: { driver: "claude-code", model: "opus" },
        work: { driver: "claude-code", model: "sonnet" },
        plan: { driver: "claude-code", model: "sonnet" },
        adviser: { driver: "claude-code", model: "haiku" },
      },
    });
    expect(out).toEqual(["sonnet", "Review: opus", "Adviser: haiku"]);
    expect(out.some((s) => s.startsWith("Planning"))).toBe(false);
  });

  test("phase picks without a Work choice list every phase with its label", () => {
    expect(summary({ phaseModels: { plan: { driver: "claude-code", model: "opus" } } })).toEqual(["Planning: opus"]);
  });

  test("permission mode uses its label", () => {
    expect(summary({ permissionMode: "read_only" })).toEqual(["Read only"]);
  });

  test("no worktree: names the checkout branch, or the project directory", () => {
    expect(summary({ useWorktree: false }, p, { checkoutName: "main" })).toEqual(["main · no worktree"]);
    expect(summary({ useWorktree: false })).toEqual(["Project directory · no worktree"]);
  });

  test("worktree picks: requested branch, else harness/<key> when forced on, plus the base", () => {
    expect(summary({ requestedBranch: "feat", baseBranch: "dev" })).toEqual(["feat", "into dev"]);
    expect(summary({ useWorktree: true }, project({ useWorktrees: false }))).toEqual(["harness/test-5"]);
    expect(summary({ useWorktree: true, requestedBranch: "feat" }, project({ useWorktrees: false }))).toEqual(["feat"]);
  });

  test("the project's own non-worktree default says nothing", () => {
    expect(summary({}, project({ useWorktrees: false }))).toEqual([]);
  });

  test("git-only rows are skipped for a non-git project", () => {
    expect(summary({ useWorktree: false, requestedBranch: "x", baseBranch: "y" }, project({ isGit: false }))).toEqual([]);
  });

  test("a base branch needs a worktree to be mentioned", () => {
    expect(summary({ baseBranch: "dev", useWorktree: false })).toEqual(["Project directory · no worktree"]);
  });

  test("review switches say what they do relative to the project default", () => {
    expect(summary({ skipAgentReview: true })).toEqual(["Skip agent review"]);
    expect(summary({ skipHumanReview: true })).toEqual(["Skip human review"]);
    expect(summary({ skipAgentReview: false }, project({ skipAgentReview: true }))).toEqual(["With agent review"]);
    expect(summary({ skipHumanReview: false }, project({ skipHumanReview: true }))).toEqual(["With human review"]);
  });

  test("dependencies list the keys", () => {
    expect(summary({ dependsOn: ["A-1", "A-2"] })).toEqual(["After A-1, A-2"]);
  });

  test("rows come in the order models, permission, branch, review, dependencies", () => {
    const out = summary({ model: "opus", permissionMode: "ask", requestedBranch: "f", skipAgentReview: true, dependsOn: ["A-1"] });
    expect(out).toEqual(["opus", "Ask", "f", "Skip agent review", "After A-1"]);
  });
});
