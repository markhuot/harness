import { describe, expect, test } from "bun:test";
import { createService } from "../support/service";
import { realGit, type GitPort } from "../../service/src/orchestrator/git-port";

describe("clock and id seams", () => {
  test("two services stamp the same times and ids for the same steps", async () => {
    const run = async () => {
      const s = createService();
      const project = await s.request("POST", "/projects", { path: s.projectDir("acme"), key: "acme" });
      s.tick(5000);
      const created = await s.request("POST", "/tickets", { projectId: project.data.id, spec: "x" });
      const t = s.store.tickets.get(created.data.id)!;
      return { projectId: project.data.id, ticketId: t.id, createdAt: t.createdAt };
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.createdAt).toBe(1_700_000_005_000);
  });

  test("the run's MCP token comes from the injected source", async () => {
    const s = createService();
    const project = await s.request("POST", "/projects", { path: s.projectDir("acme"), key: "acme" });
    let url = "";
    s.driver.script = async function* (req) {
      url = req.mcp.url;
      yield { type: "text", text: "ok" } as never;
    };
    await s.request("POST", "/tickets", { projectId: project.data.id, spec: "x", start: true });
    await s.orch.idle();
    expect(url).toMatch(/\/mcp\/0+\d+$/);
  });
});

describe("the git port", () => {
  test("every git question the orchestrator asks goes through the injected port", async () => {
    const asked: string[] = [];
    const spy = new Proxy(realGit, { get: (t, k: string) => (...args: unknown[]) => (asked.push(k), (t as any)[k](...args)) }) as GitPort;
    const s = createService({ git: spy });
    const project = await s.request("POST", "/projects", { path: s.projectDir("acme"), key: "acme" });
    await s.request("POST", "/tickets", { projectId: project.data.id, spec: "x", start: true });
    await s.orch.idle();
    expect(asked).toContain("isRepo");
  });
});
