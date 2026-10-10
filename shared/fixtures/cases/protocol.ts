// Hand-written wire samples for every type in shared/src/protocol.ts (plus FileMatch and
// CommandMatch), one export per type, typed with the TS types so tsc rejects a sample that drifts
// from the protocol. ios/HarnessKit's ProtocolRoundTripTests decodes every sample into the Swift
// port, re-encodes it, and checks the JSON comes back unchanged. It fails when an export here has
// no Swift mapping, so adding a type means adding it on both sides.
//
// Conventions: every optional field is populated in at least one sample and absent in another;
// `?: T | null` fields also appear as null. `forwardCompat` holds payloads from a newer service
// (unknown event kinds, enum values, content types) that the app must decode without failing.

import type * as P from "../../src/protocol";
import { ACTIVITY_KINDS, BROWSER_DESKTOP, BROWSER_MAX_SIDE, BROWSER_MIN_SIDE, BROWSER_MOBILE, CLASSIFIER_BACKENDS, COMPLETION_ACTIONS, LISTEN_MODES, PERMISSION_MODES, PROMPT_IDS, TICKET_STATUSES } from "../../src/protocol";
import type * as M from "../../src/mentions";
import type * as C from "../../src/commands";

const T0 = 1759190400000; // 2025-09-30T00:00:00Z

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const project: P.Project = {
  id: "prj_8f2c1a",
  key: "NYTIMES",
  name: "New York Times",
  path: "/Users/mark/Sites/nytimes",
  nextSeq: 42,
  defaultDriver: "claude-code",
  defaultModels: { "claude-code": "opus", "anthropic-api": "claude-sonnet-4-5" },
  useWorktrees: true,
  isGit: true,
  skipAgentReview: false,
  skipHumanReview: true,
  requireHumanReview: false,
  permissionMode: "ask",
  baseBranch: "develop",
  completionAction: "pr",
  completionActions: ["merge", "pr", "cleanup", "custom"],
  pullRequestHost: "github.com",
  color: "blue",
  createdAt: T0,
  updatedAt: T0 + 86_400_000,
};

export const Project: P.Project[] = [
  project,
  // An older service: none of the optional fields, nulls where the service always sends one.
  {
    id: "prj_00a1",
    key: "SCRATCH",
    name: "scratch",
    path: "/tmp/scratch",
    nextSeq: 1,
    defaultDriver: null,
    defaultModels: {},
    useWorktrees: false,
    requireHumanReview: false,
    permissionMode: null,
    color: null,
    createdAt: T0,
    updatedAt: T0,
  },
  // Outside git: null base branch and PR host, custom only.
  {
    ...project,
    id: "prj_notes",
    key: "NOTES",
    isGit: false,
    baseBranch: null,
    completionAction: "custom",
    completionActions: ["custom"],
    pullRequestHost: null,
    color: "#ff8800",
  },
];

const pendingApproval: P.PendingApproval = {
  id: "apr_1",
  runId: "run_7",
  toolName: "Bash",
  input: { command: "npm install left-pad", timeout: 120000, description: "Install deps" },
  requestedAt: T0 + 5_000,
  reason: "Installs a package from the network",
  source: "classifier",
  summary: "npm install left-pad",
  onceOnly: false,
};

export const PendingApproval: P.PendingApproval[] = [
  pendingApproval,
  { id: "apr_2", runId: "run_8", toolName: "mcp__harness__update_settings", input: { max_concurrent_runs: 4 }, requestedAt: T0, source: "policy", onceOnly: true },
  { id: "apr_3", runId: "run_9", toolName: "WebFetch", input: null, requestedAt: T0 },
];

const externalRef: P.ExternalRef = {
  source: "jira",
  key: "PLAYR-123",
  url: "https://happycog.atlassian.net/browse/PLAYR-123",
  raw: { id: "10423", fields: { summary: "Video player stalls on seek", labels: ["bug", "p1"], points: 3, flagged: false } },
};

export const ExternalRef: P.ExternalRef[] = [externalRef, { source: "manual", key: "FOO-9", url: null, raw: null }];

const ticket: P.Ticket = {
  id: "tkt_31",
  key: "NYTIMES-31",
  projectId: "prj_8f2c1a",
  kind: "conductor",
  title: "Port the wire protocol to Swift",
  spec: "Port shared/src/protocol.ts to Codable Swift types.\n\n- Patch<T>\n- OpenEnum\n\n![after](attachment:att_1)",
  specRevision: 4,
  specBaselineRevision: 2,
  status: "blocked",
  sessionId: "ses_31",
  driver: "claude-code",
  parentId: "tkt_30",
  childCount: 3,
  dependsOn: ["NYTIMES-29", "NYTIMES-30"],
  autoStart: true,
  agentReview: "approved",
  humanReview: "changes_requested",
  externalRef,
  workdir: "/Users/mark/.harness/worktrees/NYTIMES-31",
  branch: "harness/nytimes-31",
  requestedBranch: "feature/swift-protocol",
  baseBranch: "develop",
  useWorktree: true,
  skipAgentReview: true,
  skipHumanReview: true,
  completionAction: "pr",
  completionInstructions: "Squash before opening the PR",
  pullRequestUrl: "https://github.com/nytimes/app/pull/812",
  draft: false,
  blockedReason: "Should HarnessEvent decode unknown kinds or drop them?",
  busy: true,
  compacting: false,
  context: { input: 3, cacheRead: 61_000, cacheWrite: 21_000, output: 840, prefix: 47_003, at: T0 + 3_000_000, estimated: false, misses: 3, missTokens: 377_000 },
  pendingApproval,
  allowedTools: ["Bash", "WebFetch"],
  permissionMode: "read_only",
  model: "opus",
  position: 2.5,
  completedAt: T0 + 7_200_000,
  createdAt: T0,
  updatedAt: T0 + 3_600_000,
};

/** A planning ticket from an older service: no optional fields at all. */
const plainTicket: P.Ticket = {
  id: "tkt_2",
  key: "SCRATCH-2",
  projectId: "prj_00a1",
  kind: "task",
  title: "Fix the flaky test",
  spec: "",
  status: "planning",
  sessionId: "ses_2",
  driver: "anthropic-api",
  parentId: null,
  dependsOn: [],
  autoStart: false,
  agentReview: "pending",
  humanReview: "pending",
  externalRef: null,
  workdir: null,
  branch: null,
  blockedReason: null,
  busy: false,
  pendingApproval: null,
  allowedTools: [],
  permissionMode: null,
  model: null,
  position: 0,
  createdAt: T0,
  updatedAt: T0,
};

export const Ticket: P.Ticket[] = [
  ticket,
  plainTicket,
  // Every `?: T | null` field sent as an explicit null.
  {
    ...plainTicket,
    id: "tkt_3",
    key: "SCRATCH-3",
    status: "done",
    childCount: 0,
    requestedBranch: null,
    baseBranch: null,
    useWorktree: null,
    skipAgentReview: false,
    skipHumanReview: false,
    completionAction: null,
    completionInstructions: null,
    pullRequestUrl: null,
    draft: true,
    messageDraft: null,
    promptAttachments: [
      { id: "att_31", path: "/Users/mark/Desktop/login bug.png", name: "login bug.png", source: "file", kind: "image", mimeType: "image/png", size: 52_311 },
      {
        id: "att_32",
        path: "/Users/mark/.harness/uploads/upl_1/Pasted image.png",
        name: "Pasted image.png",
        source: "upload",
        kind: "image",
        mimeType: "image/png",
        width: 1170,
        height: 2532,
        annotation: { width: 1170, height: 2532, marks: [{ n: 1, x: 585, y: 1200, tailX: 300, tailY: 900, message: "This overlaps the tab bar" }] },
      },
    ],
    completedAt: null,
    agentReview: "skipped",
    humanReview: "approved",
  },
  { ...plainTicket, id: "tkt_4", key: "SCRATCH-4", status: "in_progress", useWorktree: false, completionAction: "merge" },
  { ...plainTicket, id: "tkt_5", key: "SCRATCH-5", status: "review", completionAction: "custom" },
  { ...plainTicket, id: "tkt_6", key: "SCRATCH-6", status: "done", completionAction: "cleanup" },
  // The context gauge: a compact run going, an empty gauge, and a driver's estimate.
  { ...plainTicket, id: "tkt_9", key: "SCRATCH-9", status: "in_progress", busy: true, compacting: true, context: { input: 400_000, cacheRead: 0, cacheWrite: 0, output: 0, prefix: 50_000, at: T0, estimated: false, misses: 0, missTokens: 0 } },
  { ...plainTicket, id: "tkt_10", key: "SCRATCH-10", compacting: false, context: null },
  { ...plainTicket, id: "tkt_11", key: "SCRATCH-11", context: { input: 82_000, cacheRead: 0, cacheWrite: 0, output: 0, prefix: 60_000, at: T0, estimated: true, misses: 0, missTokens: 0 } },
  { ...plainTicket, id: "tkt_7", key: "SCRATCH-7", agentNotes: "## Where\n- Swift types: `ios/HarnessKit/Sources/HarnessKit/Protocol`\n- Verify: `swift test`" },
  { ...plainTicket, id: "tkt_8", key: "SCRATCH-8", agentNotes: null },
  // A reply half written on another device (Ticket.messageDraft).
  {
    ...plainTicket,
    id: "tkt_7",
    key: "SCRATCH-7",
    status: "blocked",
    messageDraft: {
      text: "Decode them as .unknown so a newer service",
      attachments: [{ id: "att_33", path: "/Users/mark/.harness/uploads/upl_3/Pasted image.png", name: "Pasted image.png", source: "upload", kind: "image", mimeType: "image/png" }],
      origin: "9f3c2a1b7d4e6f80",
      updatedAt: T0 + 3_000_000,
    },
  },
];

export const TicketPage: P.TicketPage[] = [
  { tickets: [ticket, plainTicket], nextCursor: "eyJwb3MiOjIsImlkIjoidGt0XzIifQ", total: 57 },
  { tickets: [], nextCursor: null, total: 0 },
];

export const RelatedTicket: P.RelatedTicket[] = [
  { key: "NYTIMES-31", title: "Port the wire protocol to Swift", status: "in_progress", projectId: "prj_8f2c1a", externalKey: "PLAYR-123" },
  { key: "SCRATCH-7", title: "Spike: seek stall", status: "done", projectId: "prj_00a1", externalKey: "PLAYR-123" },
];

export const ExternalRefInput: P.ExternalRefInput[] = [
  { key: "PLAYR-123", url: "https://happycog.atlassian.net/browse/PLAYR-123" },
  { key: "FOO-1", url: null },
  { key: "FOO-2" },
];

export const PermissionDecisionLog: P.PermissionDecisionLog[] = [
  { tool: "Bash", summary: "rm -rf node_modules", decision: "deny", reason: "Deletes outside the workdir", source: "classifier", backend: "claude-cli", latencyMs: 412.5, mode: "auto" },
  { tool: "write_file", summary: "src/index.ts", decision: "allow", reason: "Edit inside the workdir", source: "policy", mode: "ask" },
  { tool: "Bash", summary: "git push", decision: "ask", reason: "Pushes to a remote", source: "policy", mode: "read_only" },
];

const session: P.Session = {
  id: "ses_31",
  key: "NYTIMES-31",
  kind: "ticket",
  ticketId: "tkt_31",
  driver: "claude-code",
  cwd: "/Users/mark/.harness/worktrees/NYTIMES-31",
  title: "",
  triageStatus: null,
  outcome: null,
  busy: true,
  createdAt: T0,
  updatedAt: T0 + 60_000,
};

export const Session: P.Session[] = [
  session,
  {
    id: "ses_t4",
    key: "TRIAGE-4",
    kind: "triage",
    ticketId: null,
    driver: "anthropic-api",
    cwd: "/Users/mark",
    title: "PLAYR-123: Video player stalls on seek",
    triageStatus: "dispatched",
    outcome: "Dispatched to NYTIMES-31",
    busy: false,
    createdAt: T0,
    updatedAt: T0,
  },
  { ...session, id: "ses_t5", key: "TRIAGE-5", kind: "triage", ticketId: null, triageStatus: "declined", outcome: "Not assigned to me", busy: false },
];

const run: P.Run = {
  id: "run_7",
  sessionId: "ses_31",
  kind: "work",
  status: "running",
  driver: "claude-code",
  prompt: "Start work on NYTIMES-31.",
  error: null,
  createdAt: T0,
  startedAt: T0 + 1_000,
  endedAt: null,
};

// Annotations (DESIGN.md "Annotations"): a human's numbered notes on an image attachment.
export const AnnotationMark: P.AnnotationMark[] = [
  { n: 1, x: 412, y: 188, tailX: 520, tailY: 96, message: "This button should be blue" },
  { n: 2, x: 64, y: 700, message: "Typo: \"Sumbit\"" },
];

export const AnnotationPage: P.AnnotationPage[] = [
  { url: "http://localhost:3000/login", title: "Log in", tabId: 3, viewport: { width: 1280, height: 800 }, scale: 2 },
  { url: "about:blank", title: "", tabId: 1, viewport: { width: 390, height: 844 }, scale: 1 },
];

export const AttachmentAnnotation: P.AttachmentAnnotation[] = [
  { width: 1280, height: 800, marks: AnnotationMark },
  {
    width: 2560,
    height: 1600,
    marks: [
      { n: 1, x: 1280, y: 800, tailX: 1400, tailY: 640, message: "Center this", path: "#login > form > button:nth-of-type(2)", text: "Sign in" },
      { n: 2, x: 40, y: 1500, message: "", path: "body > footer", text: "" },
    ],
    page: AnnotationPage[0]!,
  },
  { width: 640, height: 480, marks: [{ n: 1, x: 0, y: 479, message: "" }] },
];

export const BrowserScreenshot: P.BrowserScreenshot[] = [
  {
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    width: 2560,
    height: 1600,
    viewport: { width: 1280, height: 800 },
    scale: 2,
    tabId: 3,
    url: "http://localhost:3000/login",
    title: "Log in",
    scroll: { x: 0, y: 0 },
  },
  { data: "iVBORw0KGgo=", width: 1170, height: 2532, viewport: { width: 390, height: 844 }, scale: 3, tabId: 1, url: "about:blank", title: "", scroll: { x: 0, y: 1240.5 } },
];

export const BrowserElementQuery: P.BrowserElementQuery[] = [
  { tabId: 3, x: 640, y: 400, url: "http://localhost:3000/login", scroll: { x: 0, y: 0 }, viewport: { width: 1280, height: 800 } },
  { tabId: 1, x: 12.5, y: 300.25, url: "about:blank", scroll: { x: 0, y: 1240.5 }, viewport: { width: 390, height: 844 } },
];

export const BrowserElement: P.BrowserElement[] = [
  { path: "#login > form > button:nth-of-type(2)", text: "Sign in" },
  { path: "body > div:nth-of-type(3) > img", text: "" },
];

export const BrowserExtension: P.BrowserExtension[] = [
  {
    id: "fmkadmapgofadopljbjfkapdkoienihi",
    name: "React Developer Tools",
    version: "8.0.0",
    description: "Adds React debugging tools to the Chrome Developer Tools.",
    source: "webstore",
    enabled: true,
    status: "loaded",
    hasAction: true,
    addedAt: T0,
  },
  {
    id: "abcdefghijklmnopabcdefghijklmnop",
    name: "My extension",
    version: "0.1.0",
    source: "unpacked",
    path: "/Users/mark/code/my-extension",
    enabled: true,
    status: "blocked",
    error: "Your organization's Chrome policy doesn't allow unpacked extensions in this browser.",
    hasAction: false,
    optionsUrl: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html",
    addedAt: T0,
  },
  { id: "noondiphcddnnabmjcihcjfbhfklnnep", name: "Password Alert", version: "1.38.4", source: "chrome", byPolicy: true, enabled: true, status: "loaded", hasAction: false },
];

export const BrowserExtensionList: P.BrowserExtensionList[] = [
  { extensions: BrowserExtension, running: true },
  { extensions: [], running: false },
];

export const AddBrowserExtensionBody: P.AddBrowserExtensionBody[] = [
  { webstore: "https://chromewebstore.google.com/detail/react-developer-tools/fmkadmapgofadopljbjfkapdkoienihi" },
  { path: "~/code/my-extension" },
];

export const BrowserExtensionActionResult: P.BrowserExtensionActionResult[] = [{ tab: 4 }, { tab: null }];

const annotatedSpecImage: P.Attachment = {
  id: "att_1",
  path: "/Users/mark/.harness/attachments/att_1.png",
  name: "after.png",
  source: "spec",
  kind: "image",
  mimeType: "image/png",
  size: 48213,
  width: 1280,
  height: 800,
  annotation: AttachmentAnnotation[0]!,
};
const annotatedPage: P.Attachment = { id: "att_40", path: "/Users/mark/.harness/uploads/cd34/localhost.png", name: "localhost.png", source: "upload", kind: "image", mimeType: "image/png", annotation: AttachmentAnnotation[1]! };

export const Run: P.Run[] = [
  run,
  { ...run, id: "run_6", kind: "plan", status: "failed", error: "Driver exited with code 1", endedAt: T0 + 9_000 },
  { ...run, id: "run_8", kind: "review", status: "queued", startedAt: null },
  { ...run, id: "run_9", kind: "chat", status: "cancelled", endedAt: T0 + 2_000 },
  { ...run, id: "run_10", kind: "complete", status: "succeeded", endedAt: T0 + 3_000 },
  { ...run, id: "run_11", kind: "chat", prompt: "", attachments: [{ id: "att_41", path: "/Users/mark/.harness/uploads/ab12/shot.png", name: "shot.png", source: "upload", kind: "image", mimeType: "image/png" }] },
  { ...run, id: "run_12", kind: "chat", prompt: "Fix the marked spots.", attachments: [annotatedSpecImage, annotatedPage] },
];

export const ToolResultContent: P.ToolResultContent[] = [
  { type: "text", text: "3 files changed, 120 insertions(+)" },
  { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", mimeType: "image/png" },
];

export const TranscriptContent: P.TranscriptContent[] = [
  { type: "text", text: "I'll start with the enums." },
  { type: "thinking", text: "The service always sends baseBranch, but older ones may not…" },
  { type: "tool_call", callId: "toolu_01", name: "Bash", input: { command: "swift build", timeout: 600000 } },
  { type: "tool_call", callId: "toolu_02", name: "Read", input: "plain string input" },
  { type: "tool_result", callId: "toolu_01", name: "Bash", output: [ToolResultContent[0]!, ToolResultContent[1]!], isError: false },
  { type: "tool_result", callId: "toolu_03", name: "Bash", output: [], isError: true },
  { type: "status", text: "Moved to review" },
  { type: "status", text: "Denied: rm -rf node_modules", permission: PermissionDecisionLog[0]! },
  { type: "error", text: "Rate limited; retrying in 30s" },
  {
    type: "text",
    text: "",
    attachments: [
      { id: "att_41", path: "/Users/mark/.harness/uploads/ab12/shot.png", name: "shot.png", source: "upload", kind: "image", mimeType: "image/png" },
      { id: "att_42", path: "/Users/mark/notes.pdf", name: "Notes", source: "file", kind: "file", mimeType: "application/pdf", size: 9_120 },
    ],
  },
  { type: "text", text: "Fix the marked spots.", attachments: [annotatedSpecImage, annotatedPage] },
];

export const TranscriptEntry: P.TranscriptEntry[] = [
  { id: "ent_1", sessionId: "ses_31", runId: "run_7", subagentId: null, seq: 1, role: "user", content: { type: "text", text: "Start work." }, createdAt: T0 },
  { id: "ent_2", sessionId: "ses_31", runId: "run_7", subagentId: "toolu_09", seq: 2, role: "assistant", content: TranscriptContent[2]!, createdAt: T0 + 10 },
  { id: "ent_3", sessionId: "ses_31", runId: null, seq: 3, role: "system", content: TranscriptContent[7]!, createdAt: T0 + 20 },
  { id: "ent_4", sessionId: "ses_31", runId: "run_7", seq: 4, role: "tool", content: TranscriptContent[4]!, createdAt: T0 + 30 },
  { id: "ent_5", sessionId: "ses_31", runId: "run_11", seq: 5, role: "user", content: TranscriptContent[9]!, createdAt: T0 + 40 },
];

export const Subagent: P.Subagent[] = [
  {
    id: "toolu_09",
    sessionId: "ses_31",
    runId: "run_7",
    parentId: null,
    description: "Find the auth middleware",
    agentType: "Explore",
    prompt: "Search service/src for the bearer-token check.",
    status: "running",
    result: null,
    startedAt: T0,
    endedAt: null,
    updatedAt: T0 + 100,
  },
  {
    id: "toolu_10",
    sessionId: "ses_31",
    runId: null,
    parentId: "toolu_09",
    description: "Read the router",
    agentType: null,
    model: "claude-haiku-4-5-20251001",
    prompt: "Read service/src/http/router.ts",
    status: "succeeded",
    result: "The check is in requireAuth().",
    startedAt: T0,
    endedAt: T0 + 5_000,
    updatedAt: T0 + 5_000,
    kind: "agent",
    command: null,
    hasOutput: false,
  },
  {
    id: "toolu_11",
    sessionId: "ses_31",
    runId: "run_7",
    parentId: null,
    description: "Run the tests",
    agentType: null,
    model: null,
    prompt: "",
    status: "running",
    result: null,
    startedAt: T0 + 6_000,
    endedAt: null,
    updatedAt: T0 + 6_000,
    kind: "bash",
    command: "bun test 2>&1 | tail -40",
    hasOutput: true,
  },
];

export const TaskOutput: P.TaskOutput[] = [
  { text: "✓ 12 pass\n", start: 0, end: 12, size: 12, done: false, available: true },
  { text: "", start: 40, end: 40, size: 0, done: true, available: false },
];

export const Attachment: P.Attachment[] = [
  { id: "att_1", path: "/Users/mark/.harness/attachments/att_1.png", name: "after.png", source: "spec", kind: "image", mimeType: "image/png", size: 48213, width: 1280, height: 800 },
  { id: "att_2", path: "/Users/mark/.harness/attachments/att_2.mp4", name: "flow.mp4", source: "spec", kind: "video", mimeType: "video/mp4", size: 2_400_118 },
  { id: "att_31", path: "/Users/mark/Desktop/shot.png", name: "shot.png", source: "file", kind: "image", mimeType: "image/png" },
  { id: "att_32", path: "/Users/mark/.harness/uploads/upl_1/Pasted image.png", name: "Pasted image.png", source: "upload", kind: "image", mimeType: "image/png", width: 1170, height: 2532 },
  { id: "att_42", path: "/Users/mark/notes.pdf", name: "Notes", source: "file", kind: "file", mimeType: "" },
];

export const AttachmentInput: P.AttachmentInput[] = [
  { path: "/Users/mark/Desktop/shot.png" },
  { path: "/Users/mark/notes.pdf", name: "Notes" },
  { id: "att_1" },
  { id: "att_1", name: "After", annotation: { width: 1280, height: 800, marks: [{ n: 1, x: 10, y: 20, message: "Here" }] } },
  { id: "att_32", path: "/Users/mark/.harness/uploads/upl_1/Pasted image.png", name: "Pasted image.png", source: "upload", kind: "image", mimeType: "image/png", width: 1170, height: 2532 },
];

export const ActivityMeta: P.ActivityMeta[] = [
  { question: "Should HarnessEvent decode unknown kinds or drop them?" },
  { round: 2, commit: "9f1c2ab", by: "agent" },
  { round: 1, commit: null, by: "conductor" },
  { note: "The human answered", specRevision: 4, by: "human" },
  { specRevision: 5, from: "in_progress", to: "review" },
  { round: 3, commit: "9f1c2ab", by: "agent", detail: "The enum test is tautological.\n\n- `Enums.swift:12`: assert a real decode" },
  {},
];

export const ActivityEntry: P.ActivityEntry[] = [
  { id: "act_1", sessionId: "ses_31", ticketId: "tkt_31", kind: "note", author: "agent", body: "Ported the enums; **tests pass**; next: entities.", meta: {}, createdAt: T0 },
  { id: "act_2", sessionId: "ses_t4", ticketId: null, kind: "system", author: "system", body: "Dispatched.", meta: {}, createdAt: T0 },
  { id: "act_3", sessionId: "ses_31", ticketId: "tkt_31", kind: "message", author: "human", body: "Looks good", meta: {}, createdAt: T0 },
  { id: "act_4", sessionId: "ses_31", ticketId: "tkt_31", kind: "blocked", author: "agent", body: "Should HarnessEvent decode unknown kinds or drop them?", meta: ActivityMeta[0]!, createdAt: T0 + 1 },
  { id: "act_5", sessionId: "ses_31", ticketId: "tkt_31", kind: "changes_requested", author: "agent", body: "The enum test is tautological", meta: ActivityMeta[1]!, createdAt: T0 + 2 },
  { id: "act_6", sessionId: "ses_31", ticketId: "tkt_31", kind: "submitted", author: "agent", body: "Ready", meta: { specRevision: 4 }, createdAt: T0 + 3 },
  { id: "act_7", sessionId: "ses_31", ticketId: "tkt_31", kind: "moved", author: "human", body: "", meta: { from: "review", to: "done" }, createdAt: T0 + 4 },
  { id: "act_8", sessionId: "ses_31", ticketId: "tkt_31", kind: "spec_revised", author: "human", body: "Edited by hand", meta: { specRevision: 6 }, createdAt: T0 + 5 },
];

export const SpecRevisionInfo: P.SpecRevisionInfo[] = [
  { rev: 1, author: "human", runId: null, runKind: null, note: "Created", approvedBaseline: false, createdAt: T0 },
  { rev: 2, author: "agent", runId: "run_7", runKind: "plan", note: "Plan", approvedBaseline: true, createdAt: T0 + 60_000 },
  { rev: 3, author: "system", runId: null, runKind: null, note: "Restored", approvedBaseline: false, createdAt: T0 + 120_000 },
];

export const SpecRevision: P.SpecRevision[] = [
  { ...SpecRevisionInfo[1]!, body: "## Goal\n\nPort the protocol." },
  { ...SpecRevisionInfo[0]!, body: "" },
];

export const SpecDiff: P.SpecDiff[] = [
  { from: 1, to: 2, diff: "--- a/spec.md\n+++ b/spec.md\n@@ -0,0 +1 @@\n+## Goal\n" },
  { from: 2, to: 2, diff: "" },
];

export const SpecConflict: P.SpecConflict[] = [{ currentRevision: 5, spec: "## Goal\n\nChanged by the agent." }];

export const WatcherLive: P.WatcherLive[] = [
  { state: "running", since: T0, nextRunAt: null, failures: 0 },
  { state: "waiting", since: T0, nextRunAt: T0 + 60_000, failures: 2 },
  { state: "stopped", since: T0, nextRunAt: null, failures: 0 },
];

export const Watcher: P.Watcher[] = [
  {
    id: "wat_1",
    name: "jira-sprint",
    command: "watch-jira --project=PLAYR --once | jq -c '.[]'",
    args: [],
    prompt: "If this is assigned to me, dispatch it to NYTIMES; otherwise decline it.",
    cwd: "~/Sites/nytimes",
    env: { JIRA_TOKEN: "redacted" },
    mode: "interval",
    intervalSec: 300,
    enabled: true,
    driver: "anthropic-api",
    models: { "anthropic-api": "claude-haiku-4-5" },
    lastRunAt: T0,
    lastError: "exit 1: 401 Unauthorized",
    createdAt: T0,
    updatedAt: T0,
    live: WatcherLive[1]!,
  },
  {
    id: "wat_2",
    name: "legacy",
    command: "/usr/local/bin/poll",
    args: ["--json", "--since=1h"],
    prompt: "",
    cwd: null,
    env: {},
    mode: "loop",
    intervalSec: 60,
    enabled: false,
    driver: null,
    lastRunAt: null,
    lastError: null,
    createdAt: T0,
    updatedAt: T0,
  },
];

export const DriverInfo: P.DriverInfo[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Runs the claude CLI",
    available: true,
    authenticated: true,
    detail: "mark@happycog.com · Happy Cog (team)",
    supportsLogin: true,
    sessionActions: { compact: true, newSession: true },
    reportsContextUsage: true,
  },
  { id: "github-copilot", name: "GitHub Copilot", description: "Runs the Copilot CLI", available: true, authenticated: true, detail: "markhuot", supportsLogin: true, sessionActions: { compact: false, newSession: true }, reportsContextUsage: false },
  { id: "anthropic-api", name: "Anthropic API", description: "Calls the Messages API", available: true, authenticated: false, detail: "", supportsLogin: false },
];

export const ModelInfo: P.ModelInfo[] = [
  { id: "opus", name: "Opus", description: "Most capable", default: true },
  { id: "sonnet", name: "Sonnet", default: false },
  { id: "haiku", name: "Haiku" },
];

export const DriverModels: P.DriverModels[] = [
  { driverId: "claude-code", models: ModelInfo, error: null, fetchedAt: T0 },
  { driverId: "anthropic-api", models: [], error: "No API key", fetchedAt: T0 },
];

export const PlanUsageReport: P.PlanUsageReport[] = [
  {
    drivers: [
      {
        driver: "claude-code",
        name: "Claude Code",
        windows: [
          { id: "five_hour", label: "5-hour", usedPercent: 8, resetsAt: T0 + 3_600_000, windowSeconds: 18_000 },
          { id: "seven_day", label: "Weekly", usedPercent: 63.5, resetsAt: T0 + 5 * 86_400_000, windowSeconds: 604_800 },
          { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 100, resetsAt: T0 + 5 * 86_400_000, windowSeconds: 604_800 },
        ],
        status: "ok",
        error: null,
        fetchedAt: T0,
      },
      { driver: "github-copilot", name: "GitHub Copilot", windows: [{ id: "monthly", label: "Premium requests", usedPercent: 17.5, resetsAt: T0 + 20 * 86_400_000, windowSeconds: 2_678_400 }], status: "ok", error: null, fetchedAt: T0 },
    ],
  },
  // Unreadable: why, and what the CLI's own rate-limit report still says.
  { drivers: [{ driver: "claude-code", name: "Claude Code", windows: [], status: "near_limit", error: "Sign in to Claude Code to see plan usage", fetchedAt: T0 }] },
  { drivers: [] },
];

export const SessionActionBody: P.SessionActionBody[] = [{ action: "compact" }, { action: "new" }];

export const ListenSetting: P.ListenSetting[] = [{ mode: "localhost" }, { mode: "custom", host: "mac.local" }, { mode: "tailscale" }, { mode: "any" }];

const settings: P.Settings = {
  defaultDriver: "claude-code",
  maxConcurrentRuns: 4,
  contextGaugeLimit: 250_000,
  permissionMode: "auto",
  classifier: "claude-cli",
  defaultModels: { "claude-code": "opus", "anthropic-api": null },
  reviewModels: { "claude-code": null },
  watcherDriver: "anthropic-api",
  watcherModels: { "anthropic-api": "claude-haiku-4-5", "claude-code": null },
  anthropicApiKey: "sk-ant-api03-redacted",
  claudeOauthToken: "sk-ant-oat01-redacted",
  copilotGithubToken: "github_pat_redacted",
  baseBranch: "main",
  listen: { mode: "tailscale" },
  browserIdleTabMinutes: 5,
  prompts: { "system.intro": "You are {{agentName}}.", "run.review": null },
  notifications: {
    enabled: true,
    categories: { status: true, review: true, notes: false, spec: true, other: false },
    apnsKeyDir: "/Users/mark/.appstoreconnect/private_keys",
    apnsTeamId: "47P4ZSALX4",
  },
};

export const Settings: P.Settings[] = [
  settings,
  { defaultDriver: "claude-code", maxConcurrentRuns: 2, permissionMode: "read_only", classifier: "off", defaultModels: {}, reviewModels: {}, anthropicApiKey: null },
  { ...settings, watcherDriver: null, classifier: "anthropic-api", browserIdleTabMinutes: 0, notifications: { enabled: false, categories: { status: true, review: true, notes: true, spec: true, other: true }, apnsKeyDir: null, apnsTeamId: "47P4ZSALX4" } },
];

const { anthropicApiKey: _key, claudeOauthToken: _token, copilotGithubToken: _ghToken, ...settingsWithoutKey } = settings;
const publicSettings: P.PublicSettings = { ...settingsWithoutKey, anthropicApiKeySet: true, claudeOauthTokenSet: true, copilotGithubTokenSet: true };

export const PublicSettings: P.PublicSettings[] = [
  publicSettings,
  { defaultDriver: "anthropic-api", maxConcurrentRuns: 1, permissionMode: "ask", classifier: "off", defaultModels: {}, reviewModels: {}, anthropicApiKeySet: false },
  { ...publicSettings, watcherDriver: null, claudeOauthTokenSet: false, copilotGithubTokenSet: false },
];

/** PATCH /settings bodies (`SettingsPatch`). */
export const SettingsPatch: P.SettingsPatch[] = [
  { anthropicApiKey: null },
  { anthropicApiKey: "sk-ant-new" },
  { claudeOauthToken: null },
  { claudeOauthToken: "sk-ant-oat01-new" },
  { copilotGithubToken: null },
  { copilotGithubToken: "github_pat_new" },
  { prompts: { "system.intro": null, "run.work_start": "Begin {{ticketKey}}." } },
  { defaultModels: { "claude-code": null }, reviewModels: { "anthropic-api": "claude-opus-4-1" }, watcherModels: { "claude-code": null } },
  { watcherDriver: null, maxConcurrentRuns: 8, permissionMode: "ask", classifier: "anthropic-api", browserIdleTabMinutes: 30 },
  { watcherDriver: "claude-code", defaultDriver: "anthropic-api", baseBranch: "trunk", listen: { mode: "custom", host: "100.64.0.1" } },
  // The service merges a partial notifications block (and its categories) over the stored one.
  { notifications: { categories: { notes: false } } },
  { notifications: { enabled: false, apnsKeyDir: null } },
  {},
];

export const PromptVariable: P.PromptVariable[] = [{ name: "ticketKey", description: "The ticket's key, e.g. NYTIMES-3" }];

export const PromptEntry: P.PromptEntry[] = [
  {
    id: "run.work_start",
    group: "run",
    label: "Work run instructions",
    description: "The first message of a work run",
    variables: [{ name: "ticketKey", description: "The ticket's key" }, { name: "plan", description: "The approved plan" }],
    builtin: "Start work on {{ticketKey}}.{{#if plan}}\n\n{{plan}}{{/if}}",
    override: "Begin {{ticketKey}}.",
    overrideError: null,
  },
  {
    id: "system.intro",
    group: "system",
    label: "Introduction",
    description: "Opens every system prompt",
    variables: [],
    builtin: "You are an agent working in Harness.",
    override: "Hi {{oldVariable}}",
    overrideError: "Unknown variable oldVariable",
  },
  { id: "system.browser", group: "system", label: "Browser", description: "Browser tools", variables: [], builtin: "…", override: null, overrideError: null },
];

export const BoundAddress: P.BoundAddress[] = [
  { address: "127.0.0.1", url: "http://127.0.0.1:7717" },
  { address: "fd7a:115c:a1e0::1", url: "http://[fd7a:115c:a1e0::1]:7717" },
];

export const NetworkStatus: P.NetworkStatus[] = [
  {
    mode: "tailscale",
    host: null,
    port: 7717,
    bound: BoundAddress,
    active: "tailscale",
    tailscale: { ip: "100.107.188.66", dnsName: "marks-mbp.tail1234.ts.net" },
    error: null,
    override: null,
  },
  {
    mode: "custom",
    host: "10.0.0.5",
    port: 7717,
    bound: [BoundAddress[0]!],
    active: "localhost",
    tailscale: { ip: "100.107.188.66", dnsName: null },
    error: "10.0.0.5 is not a local address; listening on localhost",
    override: "0.0.0.0",
  },
  { mode: "localhost", host: null, port: 7717, bound: [BoundAddress[0]!], active: "localhost", tailscale: null, error: null, override: null },
];

export const PairingInfo: P.PairingInfo[] = [
  { url: "http://100.107.188.66:7717", token: "a&b=c d", pairUrl: "harness://pair?url=http%3A%2F%2F100.107.188.66%3A7717&token=a%26b%3Dc%20d" },
];

export const ServiceStatus: P.ServiceStatus[] = [
  { build: "bebc4d8", stale: true },
  { build: null, stale: false },
];

export const Health: P.Health[] = [
  { ok: true, version: "0.9.0", pid: 4242, build: "bebc4d8", stale: false },
  { ok: true, version: "0.8.1", pid: 311 },
  { ok: true, version: "0.9.0", pid: 4242, build: null, stale: true },
  { ok: true, version: "0.1.0", pid: 77, release: "app-20261003.1524", build: "bebc4d8", stale: false },
  { ok: true, version: "0.1.0", pid: 77, release: null, build: null, stale: false },
];

export const BrowserState: P.BrowserState[] = [
  { sessionId: "ses_31", url: "http://localhost:3000/login", title: "Log in", loading: false },
  { sessionId: "ses_31", url: "about:blank", title: "", loading: true },
  {
    sessionId: "ses_31",
    tabId: 3,
    url: "http://localhost:3000/docs",
    title: "Docs",
    loading: false,
    tabs: [
      { id: 1, url: "http://localhost:3000/login", title: "Log in", loading: false },
      { id: 3, url: "http://localhost:3000/docs", title: "Docs", loading: false },
      { id: 4, url: "about:blank", title: "", loading: true },
    ],
  },
  // A suspended tab (its page closed, reloads when opened), and a viewer on one that's reopening.
  {
    sessionId: "ses_31",
    tabId: 2,
    url: "http://localhost:3000/settings",
    title: "Settings",
    loading: false,
    suspended: true,
    tabs: [
      { id: 1, url: "http://localhost:3000/login", title: "Log in", loading: false, suspended: false },
      { id: 2, url: "http://localhost:3000/settings", title: "Settings", loading: false, suspended: true },
    ],
  },
  // Per-tab sizes: this viewer drives tab 1 (Responsive, touch), tab 5 is a tablet-sized touch tab.
  {
    sessionId: "ses_31",
    tabId: 1,
    url: "http://localhost:3000/login",
    title: "Log in",
    loading: false,
    size: { device: "mobile", width: 734, height: 612, responsive: true },
    sizeOwner: true,
    tabs: [
      { id: 1, url: "http://localhost:3000/login", title: "Log in", loading: false, size: { device: "mobile", width: 734, height: 612, responsive: true } },
      { id: 5, url: "http://localhost:3000/", title: "Home", loading: false, size: { device: "mobile", width: 1280, height: 800, responsive: false } },
      { id: 6, url: "about:blank", title: "", loading: false, suspended: true, size: { device: "desktop", width: 1280, height: 800, responsive: false } },
    ],
  },
  { sessionId: "ses_31", tabId: 6, url: "about:blank", title: "", loading: false, size: { device: "desktop", width: 1280, height: 800, responsive: false }, sizeOwner: false },
];

/** The size presets and limits both apps read (BrowserSize). */
export const BrowserSizeConstants = { BROWSER_DESKTOP, BROWSER_MOBILE, BROWSER_MIN_SIDE, BROWSER_MAX_SIDE };

export const BranchInfo: P.BranchInfo[] = [
  { name: "main", lastCommitAt: T0, checkedOutAt: "/Users/mark/Sites/nytimes" },
  { name: "harness/web-3", lastCommitAt: T0 - 86_400_000, checkedOutAt: null },
];

export const FileGitState: P.FileGitState[] = [
  { repo: true, tracked: true, dirty: true, untracked: false, ignored: false },
  { repo: false, tracked: false, dirty: false, untracked: false, ignored: false },
];

export const FileView: P.FileView[] = [
  { path: "src/index.ts", root: "/Users/mark/.harness/worktrees/NYTIMES-31", size: 120, contents: "export const x = 1;\n", binary: false, truncated: false, tooLarge: false, git: FileGitState[0]! },
  { path: "assets/logo.png", root: "/Users/mark/Sites/nytimes", size: 3_000_000, contents: null, binary: true, truncated: false, tooLarge: true, git: { repo: true, tracked: false, dirty: false, untracked: false, ignored: true } },
];

export const FileDiff: P.FileDiff[] = [
  { path: "src/index.ts", patch: "@@ -1 +1 @@\n-export const x = 0;\n+export const x = 1;\n", oldContents: "export const x = 0;\n", newContents: "export const x = 1;\n", tooLarge: false },
  { path: "new.txt", patch: "", oldContents: null, newContents: null, tooLarge: true },
];

export const FileSearchOptions: P.FileSearchOptions[] = [{ limit: 20, ignored: true, kind: "dir" }, { kind: "file" }, {}];

export const FileMatch: M.FileMatch[] = [
  { path: "src/index.ts", kind: "file" },
  { path: "node_modules", kind: "dir", ignored: true },
];

export const CommandMatch: C.CommandMatch[] = [
  { name: "code-review", description: "Review the current diff", argumentHint: "[pr number]" },
  { name: "vercel:deploy", description: "Deploy to Vercel" },
];

export const TicketDetail: P.TicketDetail[] = [
  {
    resolvedFrom: "OLDKEY-31",
    ticket,
    session,
    activity: ActivityEntry,
    runs: Run,
    dependents: ["NYTIMES-32"],
    children: [plainTicket],
    parent: { ...plainTicket, id: "tkt_30", key: "NYTIMES-30", kind: "conductor", childCount: 1, specRevision: 1, specBaselineRevision: null },
    subagents: Subagent,
    relatedTickets: RelatedTicket,
  },
  { ticket: plainTicket, session, activity: [], runs: [], dependents: [], children: [], parent: null, subagents: [], relatedTickets: [] },
  { ticket: plainTicket, session, activity: [], runs: [], dependents: [], children: [] },
];

export const RemoteKeyMatches: P.RemoteKeyMatches[] = [{ requested: "PLAYR-123", relatedTickets: RelatedTicket }];

export const ApiError: P.ApiError[] = [{ error: "Ticket NYTIMES-99 not found" }];

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export const PluginTab: P.PluginTab[] = [
  { pluginId: "git-diff", id: "diff", title: "Diff", icon: "git-branch", when: "worktree" },
  { pluginId: "notes", id: "notes", title: "Notes", icon: null, when: "always" },
  { pluginId: "notes", id: "repo", title: "Repo", icon: null, when: "workdir" },
];

export const PluginInfo: P.PluginInfo[] = [
  { id: "git-diff", name: "Git diff", version: "1.2.0", description: "Shows the worktree diff", source: "builtin", hasServer: true, hasUi: true, tabs: [PluginTab[0]!], error: null },
  { id: "broken", name: "Broken", version: "0.0.1", description: "", source: "user", hasServer: false, hasUi: false, tabs: [], error: "manifest.json: missing name" },
];

const themeFields: P.PluginThemeFields = {
  appearance: "dark",
  themeId: "catppuccin-mocha",
  themeName: "Catppuccin Mocha",
  syntaxTheme: "catppuccin-mocha",
  tokens: { bg: "#1e1e2e", text: "#cdd6f4", accent: "#89b4fa" },
};

export const PluginThemeFields: P.PluginThemeFields[] = [themeFields, { appearance: "light", syntaxTheme: null }, {}];

export const PluginHostMessage: P.PluginHostMessage[] = [
  { type: "harness:init", baseUrl: "http://127.0.0.1:7717", token: "tok", ticketKey: "NYTIMES-31", tabId: "diff", theme: "dark", ...themeFields },
  { type: "harness:init", baseUrl: "http://127.0.0.1:7717", token: "tok", ticketKey: "NYTIMES-31", tabId: "diff", theme: "light" },
  { type: "harness:theme", theme: "light", appearance: "light", themeId: "github-light", syntaxTheme: null },
  { type: "harness:theme", theme: "dark" },
  { type: "harness:ticket", ticket },
];

export const PluginFrameMessage: P.PluginFrameMessage[] = [
  { type: "harness:ready" },
  { type: "harness:openExternal", url: "https://github.com/nytimes/app/pull/812" },
  { type: "harness:navigate", ticketKey: "NYTIMES-30" },
];

// ---------------------------------------------------------------------------
// Events and WebSocket messages
// ---------------------------------------------------------------------------

/** One sample per HarnessEvent kind (18). */
export const HarnessEvent: P.HarnessEvent[] = [
  { kind: "project.upserted", project },
  { kind: "project.deleted", id: "prj_00a1" },
  { kind: "ticket.upserted", ticket },
  { kind: "ticket.deleted", id: "tkt_2" },
  { kind: "session.upserted", session },
  { kind: "session.deleted", id: "ses_t5" },
  { kind: "run.upserted", run },
  { kind: "transcript.appended", entry: TranscriptEntry[1]! },
  { kind: "subagent.upserted", subagent: Subagent[0]! },
  { kind: "transcript.delta", sessionId: "ses_31", runId: "run_7", text: "Compiling Proto" },
  { kind: "activity.added", entry: ActivityEntry[0]! },
  { kind: "spec.revised", ticketId: "tkt_31", rev: 4, author: "agent", note: "Status", runId: "run_7", runKind: "work", createdAt: T0 + 180_000 },
  { kind: "spec.revised", ticketId: "tkt_31", rev: 5, author: "human", note: "Edited by hand", runId: null, runKind: null },
  // From a service before runId / runKind / createdAt.
  { kind: "spec.revised", ticketId: "tkt_31", rev: 6, author: "agent", note: "Plan" },
  { kind: "watcher.upserted", watcher: Watcher[0]! },
  { kind: "watcher.deleted", id: "wat_2" },
  { kind: "settings.updated", settings: publicSettings },
  { kind: "devices.changed" },
  { kind: "browser.frame", sessionId: "ses_31", data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD", width: 1280, height: 800 },
  { kind: "browser.frame", sessionId: "ses_31", tabId: 3, data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD", width: 1024, height: 768 },
  { kind: "browser.state", sessionId: "ses_31", state: BrowserState[0]! },
  { kind: "browser.state", sessionId: "ses_31", state: BrowserState[2]! },
  { kind: "browser.frame", sessionId: "ses_31", tabId: 2, data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD", width: 1024, height: 768, viewerId: "v:spec-2" },
  { kind: "browser.state", sessionId: "ses_31", state: BrowserState[0]!, viewerId: "v:spec-2" },
  { kind: "service.status", status: ServiceStatus[0]! },
  { kind: "usage.updated", usage: PlanUsageReport[0]! },
];

export const BrowserInput: P.BrowserInput[] = [
  { type: "mouse", action: "down", x: 120.5, y: 48, button: "left", clickCount: 2 },
  { type: "mouse", action: "wheel", x: 10, y: 10, deltaX: 0, deltaY: -120.25 },
  { type: "mouse", action: "move", x: 0, y: 0 },
  { type: "mouse", action: "up", x: 1, y: 1, button: "right" },
  { type: "key", action: "down", key: "Enter", code: "Enter", text: "\r", modifiers: 8 },
  { type: "key", action: "up", key: "a", code: "KeyA" },
  { type: "text", text: "hello, wörld" },
  { type: "navigate", url: "http://localhost:3000/" },
  { type: "back" },
  { type: "forward" },
  { type: "reload" },
  { type: "resize", width: 1024, height: 768 },
  { type: "device", device: "mobile" },
  { type: "device", device: "desktop" },
  { type: "size", width: 1280, height: 800 },
  { type: "responsive", on: true, width: 734, height: 612 },
  { type: "responsive", on: false },
  { type: "newTab", url: "http://localhost:3000/docs" },
  { type: "newTab" },
  { type: "closeTab" },
];

export const ClientMessage: P.ClientMessage[] = [
  { type: "hello", client: "ios/1.0" },
  { type: "browser.subscribe", sessionId: "ses_31" },
  { type: "browser.subscribe", sessionId: "ses_31", tabId: 3 },
  { type: "browser.unsubscribe", sessionId: "ses_31" },
  { type: "browser.input", sessionId: "ses_31", input: BrowserInput[0]! },
  { type: "browser.input", sessionId: "ses_31", tabId: 3, input: { type: "closeTab" } },
  { type: "browser.subscribe", sessionId: "ses_31", tabId: 2, viewerId: "v:spec-2" },
  { type: "browser.unsubscribe", sessionId: "ses_31", viewerId: "v:spec-2" },
  { type: "browser.input", sessionId: "ses_31", input: { type: "back" }, viewerId: "v:spec-2" },
  { type: "presence", deviceId: "8C0F4E2A-3B1D-4C6E-9F7A-2D5B8E1C4A90", platform: "ios", visible: true, tickets: ["NYTIMES-12", "NYTIMES-31"] },
  { type: "presence", deviceId: "8C0F4E2A-3B1D-4C6E-9F7A-2D5B8E1C4A90", platform: "mac", visible: false, tickets: [] },
  { type: "ping" },
];

export const ServerMessage: P.ServerMessage[] = [
  { type: "welcome", version: "0.9.0" },
  { type: "event", event: HarnessEvent[2]! },
  { type: "pong" },
  { type: "error", message: "Unknown message type" },
];

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const CreateProjectBody: P.CreateProjectBody[] = [
  { path: "/Users/mark/Sites/nytimes" },
  {
    path: "/Users/mark/Sites/nytimes",
    name: "New York Times",
    key: "NYT",
    defaultDriver: "claude-code",
    useWorktrees: true,
    skipAgentReview: true,
    skipHumanReview: false,
    color: "#336699",
    permissionMode: "auto",
    defaultModels: { "claude-code": "opus", "anthropic-api": null },
    baseBranch: "develop",
    completionAction: "merge",
  },
  { path: "/tmp/x", defaultDriver: null, color: null, permissionMode: null, baseBranch: null },
  // An older app: the inverse of skipHumanReview.
  { path: "/tmp/y", requireHumanReview: false },
];

/** PATCH /projects/:id (`Partial<CreateProjectBody>`). */
export const UpdateProjectBody: Partial<P.CreateProjectBody>[] = [
  { name: "NYT", color: null, baseBranch: null },
  { defaultModels: { "claude-code": null }, permissionMode: null, defaultDriver: null },
  { path: "/Users/mark/Sites/nyt", key: "NYT2", completionAction: "pr", permissionMode: "ask", defaultDriver: "anthropic-api", useWorktrees: false, skipHumanReview: true, baseBranch: "main", color: "teal" },
  { skipAgentReview: false, skipHumanReview: false },
  {},
];

export const CreateTicketBody: P.CreateTicketBody[] = [
  { projectId: "prj_8f2c1a", spec: "Fix the flaky login test" },
  {
    projectId: "prj_8f2c1a",
    spec: "Port the protocol",
    title: "Swift protocol",
    kind: "conductor",
    driver: "claude-code",
    model: "opus",
    permissionMode: "ask",
    start: true,
    useWorktree: true,
    branch: "feature/swift",
    baseBranch: "develop",
    skipAgentReview: true,
    skipHumanReview: true,
    dependsOn: ["NYTIMES-30"],
    autoStart: false,
    parentId: "tkt_30",
    key: "IMPORT-1",
    externalRef,
    draft: false,
    promptAttachments: [{ path: "/Users/mark/Desktop/shot.png", name: "shot.png", annotation: { width: 640, height: 480, marks: [{ n: 1, x: 10, y: 20, message: "Here" }] } }, { id: "att_32" }],
  },
  { projectId: "prj_8f2c1a", spec: "", draft: true, model: null, permissionMode: null, useWorktree: null, branch: null, baseBranch: null, parentId: null, externalRef: null },
  { projectId: "prj_8f2c1a", spec: "In the checkout", useWorktree: false },
];

export const UpdateTicketBody: P.UpdateTicketBody[] = [
  { title: "Renamed", spec: "New brief", baseRevision: 3, specNote: "Tightened the goal", status: "in_progress", driver: "anthropic-api", dependsOn: [], position: 3, skipAgentReview: false, skipHumanReview: true, kind: "task", projectId: "prj_00a1" },
  { model: null, permissionMode: null, baseBranch: null, branch: null, externalRef: null, useWorktree: null },
  { model: "sonnet", permissionMode: "auto", baseBranch: "main", branch: "feature/x", externalRef: { key: "FOO-1", url: null }, useWorktree: true },
  { status: "done" },
  { spec: "Draft brief" },
  { promptAttachments: [{ path: "/Users/mark/Desktop/shot.png", name: "shot.png" }] },
  { promptAttachments: [] },
  { promptAttachments: [{ id: "att_32", annotation: { width: 1170, height: 2532, marks: [{ n: 1, x: 10, y: 20, tailX: 200, tailY: 120, message: "Here" }] } }] },
  {},
];

export const SubmitTicketBody: P.SubmitTicketBody[] = [{ start: true }, { start: false }];

export const HumanReviewBody: P.HumanReviewBody[] = [
  { decision: "approve", notes: "Ship it", action: "pr", instructions: "Target develop" },
  { decision: "request_changes", notes: "Add tests" },
  { decision: "approve" },
];

export const MessageBody: P.MessageBody[] = [
  { text: "Use Double for timestamps" },
  { text: "", attachments: [{ path: "/Users/mark/Desktop/shot.png" }, { path: "/Users/mark/notes.pdf", name: "Notes" }] },
  { text: "See attached", attachments: [{ path: "/Users/mark/.harness/uploads/ab12/shot.png", name: "shot.png" }] },
  {
    text: "Fix the marked spots.",
    attachments: [{ id: "att_1", annotation: AttachmentAnnotation[0]! }, annotatedPage, { path: "/Users/mark/Desktop/shot.png" }],
  },
];

export const MessageDraft: P.MessageDraft[] = [
  { text: "Half written", attachments: [], origin: "9f3c2a1b7d4e6f80", updatedAt: T0 },
  { text: "", attachments: [{ id: "att_1", path: "/Users/mark/Desktop/shot.png", name: "shot.png", source: "file", kind: "image", mimeType: "image/png", annotation: AttachmentAnnotation[0]! }], origin: null, updatedAt: T0 + 1 },
];

export const MessageDraftBody: P.MessageDraftBody[] = [
  { text: "Half written", origin: "9f3c2a1b7d4e6f80" },
  { text: "", attachments: [{ id: "att_1", annotation: AttachmentAnnotation[0]! }], origin: "9f3c2a1b7d4e6f80" },
  { text: "" },
];

export const ReopenBody: P.ReopenBody[] = [{ notes: "The enum test is tautological" }];

export const ApprovalBody: P.ApprovalBody[] = [{ decision: "allow_once" }, { decision: "allow_tool" }, { decision: "deny", message: "Use bun instead" }];

export const CompleteBody: P.CompleteBody[] = [{}, { action: "custom", instructions: "Merge into release/1.2", skipAgent: false }, { skipAgent: true }];

export const WatcherBody: P.WatcherBody[] = [
  { name: "jira", command: "watch-jira --once", prompt: "Dispatch to NYTIMES", mode: "interval", intervalSec: 120, enabled: true, cwd: "~/Sites", env: { A: "1" }, driver: "claude-code", models: { "claude-code": "haiku", "anthropic-api": null } },
  { cwd: null, driver: null, models: { "claude-code": null } },
  { enabled: false },
  { args: [], lastRunAt: null, lastError: null, live: WatcherLive[0]! },
  // A whole Watcher sent back as a body (the app's edit form round-trips one).
  { id: "wat_1", name: "jira", command: "watch-jira", createdAt: T0, updatedAt: T0, lastRunAt: T0, lastError: "exit 1" },
];

export const InjectOutputBody: { source: string; text: unknown; prompt?: string }[] = [
  { source: "jira", text: "PLAYR-123 assigned to you", prompt: "Dispatch to NYTIMES" },
  { source: "github", text: { pr: 812, state: "open" } },
];

export const NavigateBody: { url: string; tabId?: number }[] = [{ url: "https://example.com" }, { url: "https://example.com/docs", tabId: 3 }];

export const OkResponse: { ok: true }[] = [{ ok: true }];

export const DriverLoginResponse: { url: string | null; message: string }[] = [
  { url: "https://claude.ai/oauth/authorize?code=abc", message: "Open the link to sign in" },
  { url: null, message: "Already signed in" },
];

export const RotateTokenResponse: { token: string }[] = [{ token: "new-token-123" }];

// ---------------------------------------------------------------------------
// String unions: every value, in protocol.ts order. `all` makes tsc insist on every member, so a
// value added in TS fails here first, and the Swift test fails until the enum has it too.
// ---------------------------------------------------------------------------

function all<V extends string>(members: Record<V, true>): V[] {
  return Object.keys(members) as V[];
}

export const enums: Record<string, readonly string[]> = {
  PermissionMode: PERMISSION_MODES satisfies readonly P.PermissionMode[],
  ClassifierBackend: CLASSIFIER_BACKENDS satisfies readonly P.ClassifierBackend[],
  PermissionDecision: all<P.PermissionDecisionLog["decision"]>({ allow: true, ask: true, deny: true }),
  PermissionSource: all<P.PermissionDecisionLog["source"]>({ classifier: true, policy: true }),
  TicketStatus: TICKET_STATUSES satisfies readonly P.TicketStatus[],
  ReviewState: all<P.ReviewState>({ pending: true, approved: true, changes_requested: true, skipped: true }),
  TicketKind: all<P.TicketKind>({ task: true, conductor: true }),
  CompletionAction: COMPLETION_ACTIONS satisfies readonly P.CompletionAction[],
  SessionKind: all<P.SessionKind>({ ticket: true, triage: true }),
  TriageStatus: all<P.TriageStatus>({ triaging: true, dispatched: true, declined: true, failed: true }),
  RunKind: all<P.RunKind>({ plan: true, work: true, review: true, complete: true, conductor: true, triage: true, chat: true, compact: true }),
  RunStatus: all<P.RunStatus>({ queued: true, running: true, succeeded: true, failed: true, cancelled: true }),
  TranscriptRole: all<P.TranscriptRole>({ user: true, assistant: true, tool: true, system: true }),
  SubagentStatus: all<P.SubagentStatus>({ running: true, succeeded: true, failed: true, stopped: true }),
  SubagentKind: all<P.SubagentKind>({ agent: true, bash: true, monitor: true }),
  ActivityAuthor: all<P.ActivityAuthor>({ agent: true, human: true, system: true }),
  ActivityKind: ACTIVITY_KINDS satisfies readonly P.ActivityKind[],
  SpecRevisionAuthor: all<P.SpecRevisionAuthor>({ agent: true, human: true, system: true }),
  AttachmentKind: all<P.AttachmentKind>({ image: true, video: true, file: true }),
  AttachmentSource: all<P.AttachmentSource>({ spec: true, file: true, upload: true }),
  WatcherMode: all<P.Watcher["mode"]>({ loop: true, interval: true }),
  WatcherLiveState: all<P.WatcherLive["state"]>({ running: true, waiting: true, stopped: true }),
  PromptId: PROMPT_IDS satisfies readonly P.PromptId[],
  PromptGroup: all<P.PromptGroup>({ system: true, run: true }),
  ListenMode: LISTEN_MODES satisfies readonly P.ListenMode[],
  FileKind: all<M.FileMatch["kind"]>({ file: true, dir: true }),
  HumanReviewDecision: all<P.HumanReviewBody["decision"]>({ approve: true, request_changes: true }),
  ApprovalDecision: all<P.ApprovalBody["decision"]>({ allow_once: true, allow_tool: true, deny: true }),
  TicketTabWhen: all<P.TicketTabWhen>({ always: true, workdir: true, worktree: true }),
  PluginSource: all<P.PluginInfo["source"]>({ builtin: true, user: true }),
  Appearance: all<NonNullable<P.PluginThemeFields["appearance"]>>({ light: true, dark: true }),
  MouseAction: all<Extract<P.BrowserInput, { type: "mouse" }>["action"]>({ move: true, down: true, up: true, wheel: true }),
  MouseButton: all<NonNullable<Extract<P.BrowserInput, { type: "mouse" }>["button"]>>({ left: true, right: true, middle: true }),
  KeyAction: all<Extract<P.BrowserInput, { type: "key" }>["action"]>({ down: true, up: true }),
  BrowserDevice: all<P.BrowserDevice>({ desktop: true, mobile: true }),
  BrowserExtensionSource: all<P.BrowserExtensionSource>({ webstore: true, unpacked: true, chrome: true }),
  BrowserExtensionStatus: all<P.BrowserExtension["status"]>({ loaded: true, pending: true, off: true, blocked: true, error: true }),
};

/** The discriminators of each union, in protocol.ts order (checked against the Swift enums). */
export const discriminators: Record<string, string[]> = {
  HarnessEvent: all<P.HarnessEvent["kind"]>({
    "project.upserted": true,
    "project.deleted": true,
    "ticket.upserted": true,
    "ticket.deleted": true,
    "session.upserted": true,
    "session.deleted": true,
    "run.upserted": true,
    "transcript.appended": true,
    "subagent.upserted": true,
    "transcript.delta": true,
    "activity.added": true,
    "spec.revised": true,
    "watcher.upserted": true,
    "watcher.deleted": true,
    "settings.updated": true,
    "devices.changed": true,
    "browser.frame": true,
    "browser.state": true,
    "service.status": true,
    "usage.updated": true,
  }),
  TranscriptContent: all<P.TranscriptContent["type"]>({ text: true, thinking: true, tool_call: true, tool_result: true, status: true, error: true }),
  ToolResultContent: all<P.ToolResultContent["type"]>({ text: true, image: true }),
  ClientMessage: all<P.ClientMessage["type"]>({ hello: true, "browser.subscribe": true, "browser.unsubscribe": true, "browser.input": true, presence: true, ping: true }),
  ServerMessage: all<P.ServerMessage["type"]>({ welcome: true, event: true, pong: true, error: true }),
  BrowserInput: all<P.BrowserInput["type"]>({ mouse: true, key: true, text: true, navigate: true, back: true, forward: true, reload: true, resize: true, device: true, size: true, responsive: true, newTab: true, closeTab: true }),
  PluginHostMessage: all<P.PluginHostMessage["type"]>({ "harness:init": true, "harness:theme": true, "harness:ticket": true }),
  PluginFrameMessage: all<P.PluginFrameMessage["type"]>({ "harness:ready": true, "harness:openExternal": true, "harness:navigate": true }),
};

// ---------------------------------------------------------------------------
// Forward compatibility: what a newer service might send. Each entry names the Swift type to
// decode the samples as; they must decode, keep the unknown value, and re-encode unchanged.
// ---------------------------------------------------------------------------

export const forwardCompat: { type: string; samples: unknown[] }[] = [
  { type: "HarnessEvent", samples: [{ kind: "ticket.archived", id: "tkt_31", archivedAt: T0, by: { kind: "human", name: "Mark" } }] },
  { type: "ServerMessage", samples: [{ type: "shutdown", reason: "update", inSeconds: 5 }, { type: "event", event: { kind: "inbox.added", item: { id: "inb_1" } } }] },
  { type: "ClientMessage", samples: [{ type: "browser.zoom", sessionId: "ses_31", factor: 1.5 }] },
  {
    type: "TranscriptContent",
    samples: [
      { type: "citation", text: "See DESIGN.md", source: { path: "DESIGN.md", line: 12 } },
      { type: "tool_result", callId: "toolu_01", name: "Read", output: [{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }], isError: false },
    ],
  },
  { type: "ToolResultContent", samples: [{ type: "resource", uri: "file:///tmp/x.txt" }] },
  { type: "BrowserInput", samples: [{ type: "touch", points: [{ x: 1, y: 2 }] }] },
  { type: "BrowserExtension", samples: [{ ...BrowserExtension[0], source: "enterprise", status: "updating" }] },
  { type: "PluginHostMessage", samples: [{ type: "harness:locale", locale: "de-DE" }] },
  { type: "PluginFrameMessage", samples: [{ type: "harness:resize", height: 400 }] },
  {
    type: "Ticket",
    samples: [{ ...plainTicket, status: "archived", kind: "epic", agentReview: "escalated", humanReview: "waived", permissionMode: "yolo", completionAction: "deploy" }],
  },
  { type: "Run", samples: [{ ...run, kind: "deploy", status: "paused" }] },
  { type: "ActivityEntry", samples: [{ id: "act_9", sessionId: "ses_31", ticketId: "tkt_31", kind: "deployed", author: "bot", body: "Shipped", meta: {}, createdAt: T0 }] },
  { type: "TranscriptEntry", samples: [{ id: "ent_9", sessionId: "ses_31", runId: null, seq: 9, role: "developer", content: { type: "text", text: "hi" }, createdAt: T0 }] },
  { type: "PublicSettings", samples: [{ ...publicSettings, permissionMode: "paranoid", classifier: "local-llm", listen: { mode: "lan" } }] },
];
