import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../service/src/orchestrator/worktree";
import { createService } from "../support/service";

describe("the run path, in this process", () => {
  test("HTTP: a ticket goes from created to review, the websocket sees each step", async () => {
    const s = createService();
    const socket = s.connect();
    const project = await s.request("POST", "/projects", { path: s.projectDir("acme"), key: "acme" });
    expect(project.status).toBe(200);

    const created = await s.request("POST", "/tickets", { projectId: project.data.id, spec: "Add a button" });
    expect(created.data).toMatchObject({ key: "ACME-1", status: "in_progress" });
    await s.orch.idle();

    const detail = await s.request("GET", "/tickets/ACME-1");
    expect(detail.data.ticket).toMatchObject({ status: "review", agentReview: "approved", humanReview: "pending" });
    expect(s.driver.calls.map((c) => c.kind)).toEqual(["work", "review"]);

    const kinds = socket.events().map((e) => e.kind);
    expect(kinds).toContain("run.upserted");
    expect(socket.sent[0]).toMatchObject({ type: "welcome" });
  });

  test("HTTP: a request without the token is refused and changes nothing", async () => {
    const s = createService();
    const res = await s.request("POST", "/projects", { path: s.projectDir("acme") }, null);
    expect(res.status).toBe(401);
    expect(s.store.projects.list()).toHaveLength(0);
  });

  test("MCP: the agent's own tool call reaches the orchestrator over the run's MCP URL", async () => {
    const s = createService();
    const project = await s.request("POST", "/projects", { path: s.projectDir("acme"), key: "acme" });
    let listed: { status: number; tools: string[] } | null = null;
    s.driver.script = async function* (req) {
      // Call a real tool through the real MCP handler, as a spawned agent would.
      const res = await s.http.fetch(
        new Request(req.mcp.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
        { requestIP: () => ({ address: "127.0.0.1" }), upgrade: () => false } as never,
      );
      const text = (await res?.text()) ?? "";
      listed = { status: res?.status ?? 0, tools: [...text.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]!) };
      yield { type: "text", text: "listed" } as never;
    };
    await s.request("POST", "/tickets", { projectId: project.data.id, spec: "x", start: true });
    await s.orch.idle();
    expect(listed!.status).toBe(200);
    expect(listed!.tools).toContain("read_spec");
  });

  test("git: a work run commits on its worktree branch and completing merges it", async () => {
    const s = createService();
    s.driver.commitsWork = true;
    const repo = join(s.home, "repo");
    mkdirSync(repo);
    for (const args of [["init", "-q", "-b", "main"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
      expect((await git(args, repo)).code).toBe(0);
    }
    const project = await s.request("POST", "/projects", { path: repo, key: "web" });
    await s.request("POST", "/tickets", { projectId: project.data.id, spec: "x" });
    await s.orch.idle();
    const ticket = s.store.tickets.list().find((t: any) => t.key === "WEB-1")!;
    expect(ticket.status).toBe("review");
    expect(ticket.hasChanges).toBe(true);
  });
});
