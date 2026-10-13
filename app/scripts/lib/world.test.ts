import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import type { Ticket, TicketDetail } from "@harness/shared";
import { bootWorld, defaultUsage, type World } from "./world";

// Booting the world takes a few seconds: it seeds a database and starts a daemon.
setDefaultTimeout(60000);
let world: World;
beforeAll(async () => {
  world = await bootWorld();
});
afterAll(async () => {
  await world?.stop();
});

const ticket = async (key: string) => (await world.api<TicketDetail>("GET", `/tickets/${key}`)).ticket;

describe("the seeded world", () => {
  test("a conductor with seven children across every column", async () => {
    const d = await world.api<TicketDetail>("GET", "/tickets/HARNESS-1");
    expect(d.ticket.kind).toBe("conductor");
    expect(d.children.map((c) => c.key).sort()).toEqual(["HARNESS-10", "HARNESS-2", "HARNESS-3", "HARNESS-5", "HARNESS-6", "HARNESS-7", "HARNESS-8"]);
    expect(new Set(d.children.map((c) => c.status))).toEqual(new Set(["planning", "in_progress", "blocked", "review", "done"]));
  });

  test("a ticket's driver and model are its Work choice, though the world's default driver is the dummy", async () => {
    const t = await ticket("NYTIMES-1");
    expect([t.driver, t.model]).toEqual(["claude-code", "sonnet"]);
    expect((await ticket("NYTIMES-5")).driver).toBe("dummy");
    expect((await world.api<{ defaultDriver: string }>("GET", "/settings")).defaultDriver).toBe("dummy");
  });

  test("runs going are real: busy tickets are busy and the compact run makes HARNESS-903 compacting", async () => {
    expect((await ticket("NYTIMES-1")).busy).toBe(true);
    expect((await ticket("HARNESS-906")).busy).toBe(true);
    const compacting = await ticket("HARNESS-903");
    expect([compacting.busy, compacting.compacting]).toEqual([true, true]);
    expect((await ticket("HARNESS-901")).busy).toBe(false);
  });

  test("context gauges, approvals and the usage limit are stored the way a run leaves them", async () => {
    expect((await ticket("HARNESS-902")).context?.misses).toBe(3);
    expect((await ticket("HARNESS-905")).context ?? null).toBeNull();
    const approval = (await ticket("HARNESS-9")).pendingApproval;
    expect([approval?.toolName, approval?.source]).toEqual(["Bash", "classifier"]);
    const limited = await ticket("HARNESS-21");
    expect(limited.status).toBe("blocked");
    expect(limited.resumeAt).toBeGreaterThan(Date.now());
  });

  test("SITE's Done column pages newest first and old WWW keys still resolve", async () => {
    const page = await world.api<{ total: number; tickets: Ticket[] }>("GET", "/tickets/page?status=done&limit=50");
    expect(page.total).toBeGreaterThanOrEqual(120);
    expect(page.tickets[0]!.key).toBe("SITE-130");
    expect(page.tickets[49]!.key).toBe("SITE-81");
    expect((await world.api<TicketDetail>("GET", "/tickets/WWW-7")).ticket.key).toBe("SITE-7");
  });

  test("projects offer the completion choices their checkouts allow", async () => {
    const projects = await world.api<{ key: string; isGit: boolean; completionActions: string[] }[]>("GET", "/projects");
    const by = Object.fromEntries(projects.map((p) => [p.key, p]));
    expect(by.NYTIMES!.completionActions).toEqual(["merge", "pr", "cleanup", "custom"]);
    expect(by.HARNESS!.completionActions).toEqual(["merge", "cleanup", "custom"]);
    expect([by.SITE!.isGit, by.SITE!.completionActions]).toEqual([false, ["custom"]]);
  });

  test("the claude-code driver is signed in with the models the app shows, anthropic-api is not", async () => {
    const drivers = await world.api<{ id: string; authenticated: boolean }[]>("GET", "/drivers");
    expect(Object.fromEntries(drivers.map((d) => [d.id, d.authenticated]))).toMatchObject({ "claude-code": true, "anthropic-api": false, dummy: true });
    const models = await world.api<{ models: { name: string }[] }>("GET", "/drivers/claude-code/models");
    expect(models.models.map((m) => m.name)).toEqual(["Opus 5.5", "Fable 5.1", "Sonnet 5", "Haiku 4.5"]);
  });

  test("watchers run harmless stand-ins in the states the Inbox shows", async () => {
    const watchers = await world.api<{ name: string; live: { state: string }; lastError: string | null }[]>("GET", "/watchers");
    const by = Object.fromEntries(watchers.map((w) => [w.name, w]));
    // The supervisor has started them and the failing one has failed once; poll for that rather than guess a delay.
    let fresh = by;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && !fresh["status-page"]?.lastError; await Bun.sleep(100)) {
      fresh = Object.fromEntries((await world.api<typeof watchers>("GET", "/watchers")).map((w) => [w.name, w]));
    }
    expect([fresh.jira!.live.state, fresh["sentry-alerts"]!.live.state, by.jira!.name]).toEqual(["running", "stopped", "jira"]);
    expect(fresh["status-page"]!.lastError).toContain("Could not resolve host");
  }, 30_000);

  test("a spec's media are real files the service serves, one of them missing like a deleted attachment", async () => {
    const d = await world.api<TicketDetail>("GET", "/tickets/HARNESS-2");
    const ids = [...d.ticket.spec.matchAll(/attachment:([0-9a-f-]+)/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(4);
    const statuses = await Promise.all(ids.map(async (id) => (await fetch(`${world.base}/attachments/${id}?token=${world.token}`)).status));
    expect(statuses.sort()).toEqual([200, 200, 200, 404]);
  });

  test("plan usage is the fixed report, replaced and pushed to open sockets by setUsage", async () => {
    expect((await world.api<{ drivers: { driver: string }[] }>("GET", "/usage")).drivers.map((d) => d.driver)).toEqual(["claude-code", "github-copilot"]);
    const events: unknown[] = [];
    const ws = new WebSocket(`${world.base.replace("http", "ws")}/ws?token=${world.token}`);
    ws.onmessage = (e) => events.push(JSON.parse(String(e.data)));
    await new Promise((r) => (ws.onopen = r));
    world.setUsage([]);
    await Bun.sleep(100);
    ws.close();
    expect(events).toContainEqual({ type: "event", event: { kind: "usage.updated", usage: { drivers: [] } } });
    expect((await world.api<{ drivers: unknown[] }>("GET", "/usage")).drivers).toEqual([]);
    world.setUsage(defaultUsage());
  });

  test("client messages are reported to listeners until they stop", async () => {
    const seen: string[] = [];
    const stop = world.onClientMessage((m) => seen.push(m));
    const ws = new WebSocket(`${world.base.replace("http", "ws")}/ws?token=${world.token}`);
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: "ping" }));
    await Bun.sleep(100);
    stop();
    ws.send(JSON.stringify({ type: "ping", again: true }));
    await Bun.sleep(100);
    ws.close();
    expect(seen).toEqual([JSON.stringify({ type: "ping" })]);
  });

  test("the daemon can stop and start again on the same home, keeping what was seeded and failing busy runs it didn't start", async () => {
    await world.stopDaemon();
    expect(await fetch(`${world.daemonBase}/health`).then(() => true, () => false)).toBe(false);
    // The proxy answers 502, not a crash, while the daemon is down.
    expect((await fetch(`${world.base}/projects`)).status).toBe(502);
    await world.startDaemonAgain();
    expect((await world.api<unknown[]>("GET", "/projects")).length).toBe(5);
    expect((await ticket("HARNESS-906")).busy).toBe(false);
  });

  test("stopping removes the world's directories", async () => {
    const home = world.home;
    await world.stop();
    expect(existsSync(home)).toBe(false);
    world = undefined as unknown as World;
  });
});
