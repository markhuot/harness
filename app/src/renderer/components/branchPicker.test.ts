import { describe, expect, test } from "bun:test";
import type { BranchInfo } from "@harness/shared";
import { branchRows, inheritedBaseLabel, newTicketBranchLabel, pickableIds, predictedTicketKey, ticketBranchHint } from "./branchPicker";

const b = (name: string, checkedOutAt: string | null = null): BranchInfo => ({ name, lastCommitAt: 1, checkedOutAt });
const newLabel = (n: string) => `Create ${n}`;
const summary = (rows: ReturnType<typeof branchRows>) => rows.map((r) => `${r.kind}:${r.label}`);

describe("branchRows", () => {
  test("no query: the default, then every branch, no new row", () => {
    expect(summary(branchRows([b("main"), b("develop")], "", "New branch harness/web-4", newLabel))).toEqual([
      "default:New branch harness/web-4",
      "branch:main",
      "branch:develop",
    ]);
  });

  test("a query hides the default unless it's in its label, and offers the typed name", () => {
    expect(summary(branchRows([b("medl-1223-ai-app")], "medl", "New branch harness/web-4", newLabel))).toEqual(["branch:medl-1223-ai-app", "new:Create medl"]);
    // "harness" is in the default's label
    expect(summary(branchRows([], "harness", "New branch harness/web-4", newLabel))[0]).toBe("default:New branch harness/web-4");
  });

  test("an exact match isn't offered again as a new branch", () => {
    expect(summary(branchRows([b("develop"), b("develop-2")], " develop ", "x", newLabel))).toEqual(["branch:develop", "branch:develop-2"]);
  });

  test("a name git would refuse becomes an unpickable row saying why", () => {
    const rows = branchRows([], "feat..x", "x", newLabel);
    expect(rows.map((r) => r.kind)).toEqual(["invalid"]);
    expect(rows[0]!.label).toContain("..");
    expect(pickableIds(rows)).toEqual([]);
  });

  test("pickable ids: the default is \"\", branches and new names their name", () => {
    expect(pickableIds(branchRows([b("main")], "", "Default", newLabel))).toEqual(["", "main"]);
    expect(pickableIds(branchRows([b("main")], "ma", "Default", newLabel))).toEqual(["main", "ma"]);
  });
});

describe("predictedTicketKey", () => {
  test("KEY-nextSeq, skipping keys already taken", () => {
    expect(predictedTicketKey({ key: "WEB", nextSeq: 4 })).toBe("WEB-4");
    const taken = new Set(["WEB-4", "WEB-5"]);
    expect(predictedTicketKey({ key: "WEB", nextSeq: 4 }, (k) => taken.has(k))).toBe("WEB-6");
  });

  test("the default option names the harness branch, lower-cased", () => {
    expect(newTicketBranchLabel("WEB-4")).toBe("New branch harness/web-4");
  });
});

describe("inheritedBaseLabel", () => {
  test("names where the inherited value comes from", () => {
    expect(inheritedBaseLabel({ branch: "main", source: "settings" })).toBe("main (app default)");
    expect(inheritedBaseLabel({ branch: "develop", source: "project" })).toBe("develop (project default)");
  });
});

describe("ticketBranchHint", () => {
  test("default and a typed new name start from the base", () => {
    expect(ticketBranchHint(null, undefined, "develop").text).toContain("develop");
    const fresh = ticketBranchHint("feature/x", undefined, "develop");
    expect(fresh).toEqual({ text: "A new branch, created from develop when work starts.", warn: false });
  });

  test("a branch checked out in another worktree warns and names the path", () => {
    const h = ticketBranchHint("medl-1", b("medl-1", "/Users/me/wt/medl"), "main", (p) => p.replace("/Users/me", "~"));
    expect(h.warn).toBe(true);
    expect(h.text).toContain("~/wt/medl");
  });

  test("an existing free branch is checked out as is", () => {
    expect(ticketBranchHint("develop", b("develop"), "main")).toEqual({ text: "An existing branch: the ticket's worktree checks it out as is.", warn: false });
  });
});
