import { describe, expect, test } from "bun:test";
import { createService } from "../support/service";
import type { GitPort } from "../../service/src/orchestrator/git-port";
import { newId, now } from "../../service/src/store/util";
import { createMemoryGit } from "../support/memory-git";

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
    const memory = createMemoryGit();
    const spy = new Proxy(memory.port, { get: (t, k: string) => (...args: unknown[]) => (asked.push(k), (t as any)[k](...args)) }) as GitPort;
    const s = createService({ git: spy, memoryGit: memory });
    const project = await s.request("POST", "/projects", { path: s.projectDir("acme"), key: "acme" });
    await s.request("POST", "/tickets", { projectId: project.data.id, spec: "x", start: true });
    await s.orch.idle();
    expect(asked).toContain("isRepo");
  });
});

describe("per-test teardown", () => {
  test("a service's fixed clock and ids are installed while its test runs", () => {
    const s = createService();
    expect(now()).toBe(1_700_000_000_000);
    expect(newId()).toBe("id-1");
    s.tick(10);
    expect(now()).toBe(1_700_000_000_010);
  });

  test("the next test in the same file starts on the real clock and ids", () => {
    expect(now()).toBeGreaterThan(1_790_000_000_000);
    expect(newId()).not.toMatch(/^id-/);
    const s = createService();
    expect(newId()).toBe("id-1");
    expect(s.tick).toBeDefined();
  });

  test("a second service in a test body gets its own counters, and the first is stopped afterwards", async () => {
    const a = createService();
    const idA = newId();
    const b = createService();
    expect(newId()).toBe("id-1");
    expect(idA).toBe("id-1");
    expect(a.orch).not.toBe(b.orch);
  });
});
