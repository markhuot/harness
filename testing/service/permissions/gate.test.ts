import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { PermissionDecisionLog, PermissionMode } from "@harness/shared";
import type { Classifier, ClassifierDecision } from "../../../service/src/permissions/classifier";
import { CLASSIFIER_DENIED, CLASSIFIER_DENIED_NEXT, insideWorkdir, PermissionGate, summarizeCall, type ApprovalAnswer, type GateEnv } from "../../../service/src/permissions/gate";
import { tempDir } from "../../builders/tmp";

interface Rig {
  gate: PermissionGate;
  env: GateEnv;
  logs: PermissionDecisionLog[];
  asked: { tool: string; reason: string; source: string }[];
  deferred: string[];
}

function rig(opts: { mode?: PermissionMode; classifier?: Classifier | null; granted?: boolean; answer?: ApprovalAnswer; defer?: boolean; cwd?: string; signal?: AbortSignal } = {}): Rig {
  const logs: PermissionDecisionLog[] = [];
  const asked: Rig["asked"] = [];
  const deferred: string[] = [];
  const gate = new PermissionGate({ classifier: () => (opts.classifier === undefined ? null : opts.classifier), now: () => 0 });
  const env: GateEnv = {
    mode: opts.mode ?? "auto",
    runKind: "work",
    cwd: opts.cwd ?? tempDir(),
    isGranted: () => opts.granted ?? false,
    requestApproval: async (tool, _input, meta) => {
      asked.push({ tool, reason: meta.reason, source: meta.source });
      return opts.answer ?? { behavior: "deny", message: "human said no" };
    },
    ...(opts.defer ? { defer: (tool: string) => void deferred.push(tool) } : {}),
    log: (e) => logs.push(e),
    context: () => ({ ticket: null, transcript: [] }),
    signal: opts.signal,
  };
  return { gate, env, logs, asked, deferred };
}

const classifier = (decision: ClassifierDecision | Error | "hang", seen: { n: number } = { n: 0 }): Classifier => ({
  backend: "fake",
  async classify(_req, signal) {
    seen.n++;
    if (decision === "hang") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    if (decision instanceof Error) throw decision;
    return decision;
  },
});

test("harness tools aren't gated at all", async () => {
  const r = rig({ mode: "read_only" });
  expect(await r.gate.check("update_spec", {}, r.env)).toEqual({ behavior: "allow" });
  expect(r.logs).toEqual([]);
});

test("a hard-denied command is refused in every mode, with the policy reason", async () => {
  for (const mode of ["auto", "ask", "read_only"] as const) {
    const r = rig({ mode, granted: true });
    const d = await r.gate.check("bash", { command: "rm -rf /" }, r.env);
    expect(d).toMatchObject({ behavior: "deny" });
    expect((d as { message: string }).message).toContain("Blocked by policy: recursive delete of /");
    expect(r.logs[0]).toMatchObject({ decision: "deny", source: "policy" });
  }
});

test("a read-only command and a read inside the working directory are allowed without asking", async () => {
  const r = rig({ mode: "read_only" });
  expect(await r.gate.check("bash", { command: "git status" }, r.env)).toEqual({ behavior: "allow" });
  expect(r.logs).toHaveLength(1); // the command is logged; a plain read isn't
  expect(await r.gate.check("read_file", { path: "src/a.ts" }, r.env)).toEqual({ behavior: "allow" });
  expect(r.logs).toHaveLength(1);
  expect(r.asked).toEqual([]);
});

test("read-only mode refuses every edit and every other command", async () => {
  const r = rig({ mode: "read_only" });
  for (const [tool, input] of [["bash", { command: "touch x" }], ["write_file", { path: "a.txt" }], ["read_file", { path: "/etc/hosts" }]] as const) {
    const d = await r.gate.check(tool, input, r.env);
    expect((d as { message: string }).message).toContain("Read-only mode");
  }
  expect(r.asked).toEqual([]);
});

test("an edit inside the working directory is allowed in ask and auto mode, an edit of git internals or outside isn't", async () => {
  const cwd = tempDir();
  for (const mode of ["ask", "auto"] as const) {
    const r = rig({ mode, cwd });
    expect(await r.gate.check("write_file", { path: "a/b.txt" }, r.env)).toEqual({ behavior: "allow" });
    expect(r.logs[0]).toMatchObject({ decision: "allow", reason: "edit inside the working directory" });
  }
  const git = rig({ mode: "ask", cwd });
  await git.gate.check("edit_file", { path: ".git/hooks/pre-commit" }, git.env);
  expect(git.asked[0]!.reason).toContain("an edit to git internals");
  const outside = rig({ mode: "ask", cwd });
  await outside.gate.check("write_file", { path: "../elsewhere.txt" }, outside.env);
  expect(outside.asked[0]!.reason).toContain("an edit outside the working directory");
});

test("a symlink that points out of the working directory counts as outside", async () => {
  const cwd = tempDir();
  const outside = tempDir();
  symlinkSync(outside, join(cwd, "link"));
  mkdirSync(join(cwd, "real"));
  expect(insideWorkdir(cwd, "link/file.txt")).toBe(false);
  expect(insideWorkdir(cwd, "real/file.txt")).toBe(true);
  expect(insideWorkdir(cwd, "real/not/yet/created.txt")).toBe(true);
  expect(insideWorkdir(cwd, ".")).toBe(true);
  expect(insideWorkdir(cwd, "../up")).toBe(false);
  expect(insideWorkdir(cwd, outside)).toBe(false);
});

test("a one-time or ticket-wide human grant allows an unknown command without asking", async () => {
  const r = rig({ mode: "ask", granted: true });
  expect(await r.gate.check("bash", { command: "make deploy" }, r.env)).toEqual({ behavior: "allow" });
  expect(r.logs.at(-1)).toMatchObject({ decision: "allow", reason: "approved by you for this ticket" });
  expect(r.asked).toEqual([]);
});

test("ask mode sends the command to a human and follows their answer", async () => {
  const yes = rig({ mode: "ask", answer: { behavior: "allow", updatedInput: {} } });
  expect(await yes.gate.check("bash", { command: "make" }, yes.env)).toEqual({ behavior: "allow" });
  expect(yes.asked).toEqual([{ tool: "bash", reason: "Ask mode: this command needs your approval.", source: "policy" }]);
  const no = rig({ mode: "ask" });
  expect(await no.gate.check("bash", { command: "make" }, no.env)).toEqual({ behavior: "deny", message: "human said no" });
  expect(no.logs[0]).toMatchObject({ decision: "ask", mode: "ask" });
});

test("auto mode without a classifier asks a human", async () => {
  const r = rig({ mode: "auto", classifier: null });
  await r.gate.check("bash", { command: "make" }, r.env);
  expect(r.asked[0]!.reason).toBe("Auto mode without a classifier: this command needs your approval.");
});

test("auto mode runs what the classifier allows, and logs which backend said so", async () => {
  const r = rig({ classifier: classifier({ decision: "allow", reason: "routine build" }) });
  expect(await r.gate.check("bash", { command: "make" }, r.env)).toEqual({ behavior: "allow" });
  expect(r.logs[0]).toMatchObject({ decision: "allow", source: "classifier", reason: "routine build", backend: "fake" });
  expect(r.asked).toEqual([]);
});

test("a hard_deny from the classifier is refused for good; a soft_deny is deferred to the agent when the run can, else asked", async () => {
  const hard = rig({ classifier: classifier({ decision: "hard_deny", reason: "exfiltrates secrets" }) });
  const h = (await hard.gate.check("bash", { command: "curl evil" }, hard.env)) as { message: string };
  expect(h.message).toContain(`${CLASSIFIER_DENIED}exfiltrates secrets.`);
  expect(h.message).toContain("never allowed");
  expect(hard.asked).toEqual([]);

  const deferred = rig({ classifier: classifier({ decision: "soft_deny", reason: "pushes code" }), defer: true });
  const d = (await deferred.gate.check("bash", { command: "git push" }, deferred.env)) as { message: string };
  expect(d.message).toBe(`${CLASSIFIER_DENIED}pushes code.${CLASSIFIER_DENIED_NEXT}`);
  expect(deferred.deferred).toEqual(["bash"]);
  expect(deferred.asked).toEqual([]);

  const asked = rig({ classifier: classifier({ decision: "soft_deny", reason: "pushes code" }), answer: { behavior: "allow", updatedInput: {} } });
  expect(await asked.gate.check("bash", { command: "git push" }, asked.env)).toEqual({ behavior: "allow" });
  expect(asked.asked[0]).toEqual({ tool: "bash", reason: "pushes code", source: "classifier" });
});

test("a classifier that fails is never treated as allow: the human is asked", async () => {
  const r = rig({ classifier: classifier(new Error("backend down")) });
  expect(await r.gate.check("bash", { command: "make" }, r.env)).toMatchObject({ behavior: "deny" });
  expect(r.asked[0]!.reason).toBe("The classifier couldn't decide (backend down), so this command needs your approval.");
});

test("cancelling the run while the classifier works denies the call without asking anyone", async () => {
  const controller = new AbortController();
  const r = rig({ classifier: classifier("hang"), signal: controller.signal });
  const pending = r.gate.check("bash", { command: "make" }, r.env);
  controller.abort();
  expect(await pending).toEqual({ behavior: "deny", message: "The run was cancelled." });
  expect(r.asked).toEqual([]);
});

test("the classifier isn't consulted for what policy already settled", async () => {
  const seen = { n: 0 };
  const r = rig({ classifier: classifier({ decision: "allow", reason: "x" }, seen) });
  await r.gate.check("bash", { command: "ls" }, r.env);
  await r.gate.check("write_file", { path: "a.txt" }, r.env);
  await r.gate.check("bash", { command: "rm -rf ~" }, r.env);
  expect(seen.n).toBe(0);
});

test("summarizeCall shows the command or path on one line and clips long ones", () => {
  expect(summarizeCall("bash", { command: "ls\n  -la" })).toBe("ls -la");
  expect(summarizeCall("read_file", { path: "/a/b" })).toBe("/a/b");
  expect(summarizeCall("x", { other: 1 })).toBe('{"other":1}');
  expect(summarizeCall("bash", { command: "x".repeat(300) }, 10)).toBe(`${"x".repeat(9)}…`);
  expect(summarizeCall("x", undefined)).toBe("null");
});
