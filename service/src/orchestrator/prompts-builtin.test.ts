// Golden output of the built-in prompts across a matrix of inputs. The snapshots were recorded
// from prompts.ts before the prompts became templates (HARNESS-78), so a template edit that
// changes a single byte of a built-in prompt fails here. After an intended wording change,
// re-record with `bun test --update-snapshots src/orchestrator/prompts-builtin.test.ts` and read
// the snapshot diff.

import { describe, expect, test } from "bun:test";
import type { Project, RunKind, Session, Summary, Ticket, TicketStatus } from "@harness/shared";
import {
  type BranchContext,
  changesRequestedPrompt,
  completePrompt,
  conductorUpdatePrompt,
  reopenPrompt,
  reviewPrompt,
  systemPrompt,
  triagePrompt,
  workStartPrompt,
} from "./prompts";

const project: Project = {
  id: "p1",
  key: "NYT",
  name: "New York Times",
  path: "/Users/me/Sites/nyt",
  nextSeq: 4,
  defaultDriver: null,
  useWorktrees: true,
  skipAgentReview: false, skipHumanReview: false,
  defaultModels: {},
  permissionMode: null,
  color: null,
  createdAt: 0,
  updatedAt: 0,
};

function ticket(patch: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    key: "NYT-3",
    projectId: "p1",
    kind: "task",
    title: "Add  dark\nmode",
    description: "Add a dark theme toggle to the header.\n\n* keep `prefers-color-scheme`",
    status: "in_progress",
    sessionId: "s1",
    driver: "dummy",
    parentId: null,
    dependsOn: [],
    autoStart: false,
    agentReview: "pending",
    humanReview: "pending",
    externalRef: null,
    workdir: null,
    branch: null,
    blockedReason: null,
    permissionMode: null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    model: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const session: Session = {
  id: "s1",
  key: "NYT-3",
  kind: "ticket",
  ticketId: "t1",
  driver: "dummy",
  cwd: "/Users/me/Sites/nyt",
  title: "",
  triageStatus: null,
  outcome: null,
  busy: false,
  createdAt: 0,
  updatedAt: 0,
};

const WT = "/Users/me/.harness/worktrees/NYT-3";
const owned: BranchContext = { base: "main", baseSource: "settings", ownsWorktree: true, worktreesDir: "/Users/me/.harness/worktrees" };

/** Ticket shapes that change what the prompts say about git. */
const TICKETS: Record<string, { t: Partial<Ticket>; b?: BranchContext; p?: Partial<Project> | null }> = {
  "checkout (no worktree)": { t: { workdir: "/Users/me/Sites/nyt", useWorktree: false } },
  "not started, planned harness branch": { t: {} },
  "not started, requested branch": { t: { requestedBranch: "feature/x", baseBranch: "develop" } },
  "harness worktree": { t: { branch: "harness/nyt-3", workdir: WT }, b: owned },
  "harness worktree, default branch context": { t: { branch: "harness/nyt-3", workdir: WT } },
  "custom branch, project base": { t: { branch: "feature/x", workdir: WT }, b: { base: "develop", baseSource: "project", ownsWorktree: true } },
  "outside worktree with leftover harness worktree": {
    t: { branch: "medl-1", workdir: "/Users/me/elsewhere" },
    b: { base: "main", baseSource: "ticket", ownsWorktree: false, worktreesDir: "/w", leftover: { path: WT, branch: "harness/nyt-3" } },
  },
  "outside worktree with leftover on custom branch": {
    t: { branch: "medl-1", workdir: "/Users/me/elsewhere" },
    b: { base: "main", baseSource: "checkout", ownsWorktree: false, leftover: { path: WT, branch: "old" } },
  },
  "leftover without branch": {
    t: { branch: "harness/nyt-3", workdir: WT },
    b: { base: "main", baseSource: "odd-source", ownsWorktree: true, leftover: { path: "/x", branch: null } },
  },
  "branch is the base branch": { t: { branch: "main", workdir: WT }, b: { base: "main", baseSource: "settings", ownsWorktree: true } },
  "branch is the base, no workdir": { t: { branch: "main", workdir: null }, b: { base: "main", baseSource: "settings", ownsWorktree: false } },
  "harness branch, no workdir": { t: { branch: "harness/nyt-3", workdir: null }, b: owned },
  "not git": { t: { workdir: "/Users/me/Sites/nyt" }, p: { isGit: false } },
  "no project": { t: {}, p: null },
  "deps, external ref, parent": {
    t: { dependsOn: ["NYT-1", "NYT-2"], externalRef: { source: "jira", key: "WEB-9", url: "https://j/WEB-9" } as Ticket["externalRef"], branch: "harness/nyt-3", workdir: WT },
    b: owned,
  },
  "external ref without url": { t: { externalRef: { source: "jira", key: "WEB-9", url: null } as unknown as Ticket["externalRef"] } },
};

const GH = { host: "github.com", remote: "origin", repo: "github.com/nytimes/web" };
const GHE = { host: "ghe.acme.com", remote: "upstream", repo: "ghe.acme.com/web/site" };
const COMPLETION_VARIANTS: Record<string, Record<string, { t?: Partial<Ticket>; pullRequest?: BranchContext["pullRequest"]; instructions?: string }>> = {
  pr: {
    github: { pullRequest: GH },
    "enterprise, existing pull request": { pullRequest: GHE, t: { pullRequestUrl: "https://ghe.acme.com/web/site/pull/7" }, instructions: "Add the design label." },
  },
  cleanup: {
    "no instructions": {},
    instructions: { t: { completionInstructions: "Also prune the remote branch." }, instructions: "Also prune the remote branch." },
  },
  custom: {
    instructions: { t: { completionInstructions: "Cherry-pick onto release-2.4." }, instructions: "Cherry-pick onto release-2.4." },
    "no instructions": {},
  },
};
const COMPLETION_SHAPES = ["harness worktree", "branch is the base branch", "outside worktree with leftover harness worktree", "checkout (no worktree)", "not git"];

const CHILDREN: Ticket[] = [
  ticket({ id: "c1", key: "NYT-4", title: "Tokens", status: "review", agentReview: "approved", humanReview: "pending" }),
  ticket({ id: "c2", key: "NYT-5", title: "Toggle", status: "blocked", dependsOn: ["NYT-4"], blockedReason: "Which  icon?\nSun or moon" }),
  ticket({ id: "c3", key: "NYT-6", title: "Docs", status: "blocked", blockedReason: null }),
  ticket({ id: "c4", key: "NYT-7", title: "Done one", status: "done" }),
];

const TICKET_KINDS: RunKind[] = ["plan", "work", "review", "complete", "conductor", "chat"];

describe("built-in system prompts", () => {
  for (const kind of TICKET_KINDS) {
    // Plan and chat runs only differ by ticket shape in their Context section.
    const shapes = kind === "plan" || kind === "chat" ? Object.entries(TICKETS).slice(0, 4) : Object.entries(TICKETS);
    for (const [name, c] of shapes) {
      // builtinTools only changes the Files section, so the native-tools variant runs on two shapes.
      for (const builtinTools of name === "harness worktree" || name.startsWith("checkout") ? [true, false] : [true]) {
        test(`${kind} · ${name} · builtinTools ${builtinTools}`, () => {
          const t = ticket({ ...c.t, kind: kind === "conductor" ? "conductor" : "task" });
          const p = c.p === null ? null : { ...project, ...c.p };
          const parent = name.includes("parent") ? ticket({ id: "pp", key: "NYT-1", title: "Parent  goal" }) : null;
          expect(systemPrompt({ kind, project: p, ticket: t, session, parent, builtinTools, branches: c.b })).toMatchSnapshot();
        });
      }
    }
  }

  for (const kind of ["work", "conductor"] as RunKind[]) {
    for (const branch of [null, "harness/nyt-3"]) {
      test(`${kind} with children · branch ${branch}`, () => {
        const t = ticket({ kind: kind === "conductor" ? "conductor" : "task", branch, workdir: branch ? WT : null });
        expect(systemPrompt({ kind, project, ticket: t, session, children: CHILDREN, branches: branch ? owned : undefined })).toMatchSnapshot();
      });
    }
    test(`${kind} with an empty children list`, () => {
      expect(systemPrompt({ kind, project, ticket: ticket({ kind: kind === "conductor" ? "conductor" : "task" }), session, children: [] })).toMatchSnapshot();
    });
  }

  // Completion actions other than merge (DESIGN.md "Completion"), over the shapes that change them.
  for (const [action, variants] of Object.entries(COMPLETION_VARIANTS)) {
    for (const [variant, extra] of Object.entries(variants)) {
      for (const name of COMPLETION_SHAPES) {
        test(`complete · ${action} · ${variant} · ${name}`, () => {
          const c = TICKETS[name]!;
          const p = c.p === null ? null : { ...project, ...c.p };
          const b = c.b ? { ...c.b, pullRequest: extra.pullRequest } : undefined;
          const t = ticket({ ...c.t, completionAction: action as "pr" | "cleanup" | "custom", ...extra.t });
          expect(systemPrompt({ kind: "complete", project: p, ticket: t, session, branches: b })).toMatchSnapshot();
          expect(completePrompt(t, extra.instructions, b, p)).toMatchSnapshot();
        });
      }
    }
  }

  for (const status of ["planning", "in_progress", "blocked", "review", "done"] as TicketStatus[]) {
    test(`chat about a ${status} ticket`, () => {
      expect(systemPrompt({ kind: "chat", project, ticket: ticket({ status }), session })).toMatchSnapshot();
    });
    test(`plan · project name equals key · ${status}`, () => {
      expect(systemPrompt({ kind: "plan", project: { ...project, name: "NYT" }, ticket: ticket({ status }), session })).toMatchSnapshot();
    });
  }

  test("chat without a ticket", () => {
    expect(systemPrompt({ kind: "chat", project, ticket: null, session: { ...session, cwd: "/tmp/x" } })).toMatchSnapshot();
  });

  test("work without a ticket, project or cwd", () => {
    expect(systemPrompt({ kind: "work", project: null, ticket: null, session: { ...session, cwd: "" } })).toMatchSnapshot();
  });

  for (const title of ["", "Jira  WEB-9\nupdate"]) {
    for (const withProject of [true, false]) {
      test(`triage · title ${JSON.stringify(title)} · project ${withProject}`, () => {
        const s: Session = { ...session, kind: "triage", key: "TRIAGE-1", ticketId: null, title };
        expect(systemPrompt({ kind: "triage", project: withProject ? project : null, ticket: null, session: s })).toMatchSnapshot();
      });
    }
  }
});

const summaries: Summary[] = [
  { id: "s2", sessionId: "s1", ticketId: "t1", author: "human", body: "  Looks close.\nFix the icon.  ", createdAt: 2_000, attachments: [] } as unknown as Summary,
  {
    id: "s1",
    sessionId: "s1",
    ticketId: "t1",
    author: "agent",
    body: "Added the toggle.",
    createdAt: 1_000,
    attachments: [
      { id: "a1", name: "after.png", kind: "image", mime: "image/png", size: 1 },
      { id: "a2", name: "flow.mp4", kind: "video", mime: "video/mp4", size: 2 },
    ],
  } as unknown as Summary,
  { id: "s3", sessionId: "s1", ticketId: "t1", author: "system", body: "Moved", createdAt: 3_000 } as unknown as Summary,
];

describe("built-in run prompts", () => {
  for (const kind of ["task", "conductor"] as const) {
    for (const description of ["Do the thing.\n\n* one\n* two", "   "]) {
      test(`workStartPrompt · ${kind} · ${JSON.stringify(description)}`, () => {
        expect(workStartPrompt(ticket({ kind, description }))).toMatchSnapshot();
      });
    }
  }

  test("reviewPrompt · summaries with attachments", () => {
    expect(reviewPrompt(ticket(), summaries, (a) => `/att/${a.id}/${a.name}`)).toMatchSnapshot();
  });
  test("reviewPrompt · default attachment path", () => {
    expect(reviewPrompt(ticket(), summaries)).toMatchSnapshot();
  });
  test("reviewPrompt · no summaries, empty brief", () => {
    expect(reviewPrompt(ticket({ description: "" }), [])).toMatchSnapshot();
  });

  for (const [name, c] of Object.entries(TICKETS)) {
    for (const instructions of [undefined, "  ", "Merge into release/1.2 and push."]) {
      test(`completePrompt · ${name} · instructions ${JSON.stringify(instructions)}`, () => {
        const p = c.p === null ? null : { ...project, ...c.p };
        expect(completePrompt(ticket(c.t), instructions, c.b, p)).toMatchSnapshot();
      });
    }
  }
  test("completePrompt · no project argument", () => {
    expect(completePrompt(ticket({ branch: "harness/nyt-3", workdir: WT }))).toMatchSnapshot();
  });

  test("conductorUpdatePrompt · no changes", () => {
    expect(conductorUpdatePrompt([])).toMatchSnapshot();
  });
  test("conductorUpdatePrompt · changes with and without summaries", () => {
    expect(
      conductorUpdatePrompt([
        { key: "NYT-4", title: "Tokens  x", from: "in_progress", to: "review", summary: "Added tokens.\nTests pass." },
        { key: "NYT-5", title: "Toggle", from: "blocked", to: "in_progress" },
        { key: "NYT-6", title: "Docs", from: "review", to: "done", summary: "   " },
      ]),
    ).toMatchSnapshot();
  });

  for (const by of ["agent", "human", "conductor"] as const) {
    for (const notes of ["Fix the icon.\nAnd the test.", "  "]) {
      test(`changesRequestedPrompt · ${by} · ${JSON.stringify(notes)}`, () => {
        expect(changesRequestedPrompt(notes, by)).toMatchSnapshot();
      });
    }
  }

  for (const branch of [null, "harness/nyt-3", "feature/x"]) {
    for (const base of [undefined, "develop"]) {
      test(`reopenPrompt · branch ${branch} · base ${base}`, () => {
        expect(reopenPrompt(ticket({ branch, status: "done" }), "  Also handle print styles.\n", base)).toMatchSnapshot();
      });
    }
  }
  test("reopenPrompt · with a pull request", () => {
    const t = ticket({ branch: "harness/nyt-3", status: "done", pullRequestUrl: "https://github.com/nytimes/web/pull/12" });
    expect(reopenPrompt(t, "Address the review comments.", "main")).toMatchSnapshot();
  });

  const tickets = [ticket(), ticket({ id: "t2", key: "WEB-9", title: "Mirrored", status: "planning" })];
  for (const prompt of ["", "Only failures. Dispatch to NYT."]) {
    for (const existing of [true, false]) {
      for (const truncated of [true, false]) {
        test(`triagePrompt · prompt ${!!prompt} · existing ${existing} · truncated ${truncated}`, () => {
          expect(
            triagePrompt({
              source: "jira  poller",
              title: "WEB-9 updated",
              text: 'line one\n```\n{"key":"WEB-9"}\n````',
              truncated,
              prompt,
              projects: existing ? [project, { ...project, key: "WEB", name: "Web", path: "/w" }] : [],
              existingTickets: existing ? tickets : [],
            }),
          ).toMatchSnapshot();
        });
      }
    }
  }
});
