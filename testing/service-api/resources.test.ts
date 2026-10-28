import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cos, Group, Project, PublicSettings, Ticket } from "@harness/shared";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

test("an unknown path is 404, a known path with the wrong method is 405, and both answer {error}", async () => {
  const rig = await boot();
  expect(await rig.call("GET", "/nothing-here")).toMatchObject({ status: 404, body: { error: "Not found" } });
  expect(await rig.call("PUT", "/projects")).toMatchObject({ status: 405, body: { error: "Method not allowed" } });
  expect(await rig.call("DELETE", "/settings")).toMatchObject({ status: 405 });
});

test("a body that isn't JSON is 400 on every route that reads one", async () => {
  const rig = await boot();
  for (const [method, path] of [["POST", "/projects"], ["POST", "/tickets"], ["PATCH", "/settings"]] as const) {
    const res = await rig.call(method, path, undefined, { raw: "{nope" });
    expect([path, res.status, res.body]).toEqual([path, 400, { error: "Invalid JSON body" }]);
  }
});

test("a project is created, listed, renamed and deleted through the API, and each change is announced", async () => {
  const rig = await boot();
  const project = await rig.project("SITE");
  expect(await rig.ok<Project[]>("GET", "/projects")).toEqual([project]);

  const renamed = await rig.ok<Project>("PATCH", `/projects/${project.id}`, { name: "Site" });
  expect(renamed).toMatchObject({ id: project.id, key: "SITE", name: "Site" });
  expect((await rig.ok<Project[]>("GET", "/projects"))[0]!.name).toBe("Site");

  await rig.ok("DELETE", `/projects/${project.id}`);
  expect(await rig.ok<Project[]>("GET", "/projects")).toEqual([]);
  const kinds = rig.busEvents.map((e) => e.kind).filter((k) => k.startsWith("project."));
  expect(kinds).toEqual(["project.upserted", "project.upserted", "project.deleted"]);
});

test("a project is refused for a missing folder, a file, or a key another project holds, and nothing is created", async () => {
  const rig = await boot();
  const first = await rig.project("ACME");
  const file = join(rig.harness.paths.home, "file.txt");
  writeFileSync(file, "x");
  expect(await rig.call("POST", "/projects", { path: join(rig.harness.paths.home, "nope") })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Not a directory/) } });
  expect(await rig.call("POST", "/projects", { path: file })).toMatchObject({ status: 400 });
  expect(await rig.call("POST", "/projects", { path: first.path, key: "ACME" })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already used/) } });
  expect(await rig.call("PATCH", "/projects/missing", { name: "x" })).toMatchObject({ status: 404 });
  expect(await rig.ok<Project[]>("GET", "/projects")).toHaveLength(1);
});

test("a ticket drafted without starting is in planning with the next key, and can be read, retitled and deleted", async () => {
  const rig = await boot();
  const project = await rig.project();
  const a = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "First", start: false });
  const b = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Second", start: false });
  expect([a.key, b.key, a.status]).toEqual(["ACME-1", "ACME-2", "planning"]);

  const detail = await rig.ok<{ ticket: Ticket }>("GET", `/tickets/${a.key}`);
  expect(detail.ticket).toMatchObject({ id: a.id, spec: "First" });
  const patched = await rig.ok<Ticket>("PATCH", `/tickets/${a.key}`, { title: "Renamed" });
  expect(patched.title).toBe("Renamed");

  const listed = await rig.ok<Ticket[]>("GET", `/tickets?projectId=${project.id}&status=planning`);
  expect(listed.map((t) => t.key).sort()).toEqual(["ACME-1", "ACME-2"]);
  expect(await rig.ok<Ticket[]>("GET", "/tickets?status=review")).toEqual([]);

  await rig.ok("DELETE", `/tickets/${a.key}`);
  expect(await rig.call("GET", `/tickets/${a.key}`)).toMatchObject({ status: 404 });
  expect(await rig.call("DELETE", `/tickets/${a.key}`)).toMatchObject({ status: 404 });
  expect((await rig.ok<Ticket[]>("GET", "/tickets")).map((t) => t.key)).toEqual(["ACME-2"]);
});

test("a ticket needs a spec and a real project, and an unknown key is 404 on every action", async () => {
  const rig = await boot();
  const project = await rig.project();
  expect(await rig.call("POST", "/tickets", { projectId: project.id })).toMatchObject({ status: 400, body: { error: "spec is required" } });
  expect(await rig.call("POST", "/tickets", { projectId: "missing", spec: "x" })).toMatchObject({ status: 404 });
  for (const [method, path] of [["GET", "/tickets/ACME-9"], ["POST", "/tickets/ACME-9/start"], ["POST", "/tickets/ACME-9/cancel"], ["GET", "/tickets/ACME-9/activity"]] as const) {
    expect([path, (await rig.call(method, path)).status]).toEqual([path, 404]);
  }
});

test("a ticket's list filters validate: an unknown status is 400, and a page takes exactly one", async () => {
  const rig = await boot();
  expect(await rig.call("GET", "/tickets?status=bogus")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Unknown status: bogus/) } });
  expect(await rig.call("GET", "/tickets/page?status=review,planning")).toMatchObject({ status: 400, body: { error: "status must be exactly one ticket status" } });
  expect(await rig.call("GET", "/sessions?kind=x")).toMatchObject({ status: 400 });
});

test("a ticket that isn't in review can't be reviewed, completed or re-opened (409), and a review needs a decision (400)", async () => {
  const rig = await boot();
  const project = await rig.project();
  const t = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "x", start: false });
  expect(await rig.call("POST", `/tickets/${t.key}/review`, { decision: "maybe" })).toMatchObject({ status: 400 });
  expect(await rig.call("POST", `/tickets/${t.key}/review`, { decision: "approve" })).toMatchObject({ status: 409, body: { error: `${t.key} is not in review` } });
  expect(await rig.call("POST", `/tickets/${t.key}/complete`, {})).toMatchObject({ status: 409 });
  expect(await rig.call("POST", `/tickets/${t.key}/reopen`, {})).toMatchObject({ status: 409 });
  expect(await rig.call("POST", `/tickets/${t.key}/unblock`, {})).toMatchObject({ status: 409 });
  expect(await rig.call("POST", `/tickets/${t.key}/session`, { action: "fork" })).toMatchObject({ status: 400 });
  expect((await rig.ok<{ ticket: Ticket }>("GET", `/tickets/${t.key}`)).ticket.status).toBe("planning");
});

test("cancel-start and withdraw-approval answer 409 when there is nothing to cancel or withdraw", async () => {
  const rig = await boot();
  const project = await rig.project();
  const t = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "x", start: false });
  expect(await rig.call("POST", `/tickets/${t.key}/cancel-start`)).toMatchObject({ status: 409, body: { error: `${t.key} is not set to start automatically` } });
  expect(await rig.call("POST", `/tickets/${t.key}/withdraw-approval`)).toMatchObject({ status: 409 });
  expect(await rig.call("POST", "/tickets/ACME-9/cancel-start")).toMatchObject({ status: 404 });
});

test("settings are patched and read back, an invalid value is 400 and leaves the stored one alone, and an unknown driver is refused", async () => {
  const rig = await boot();
  expect((await rig.ok<PublicSettings>("PATCH", "/settings", { maxConcurrentRuns: 3 })).maxConcurrentRuns).toBe(3);
  expect(await rig.call("PATCH", "/settings", { maxConcurrentRuns: 0 })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/between 1 and 64/) } });
  expect(await rig.call("PATCH", "/settings", { defaultDriver: "nope" })).toMatchObject({ status: 400, body: { error: "Unknown driver: nope" } });
  expect(await rig.call("PATCH", "/settings", [1])).toMatchObject({ status: 400 });
  expect((await rig.ok<PublicSettings>("GET", "/settings")).maxConcurrentRuns).toBe(3);
});

test("a settings change reaches every connected socket as settings.updated", async () => {
  const rig = await boot();
  const [a, b] = [await rig.socket(), await rig.socket()];
  await rig.ok("PATCH", "/settings", { maxConcurrentRuns: 7 });
  for (const ws of [a, b]) expect((await ws.event("settings.updated")).settings.maxConcurrentRuns).toBe(7);
});

test("drivers and their models come from the registered drivers, and an unknown driver is 404", async () => {
  const rig = await boot();
  expect((await rig.ok<{ id: string }[]>("GET", "/drivers")).map((d) => d.id)).toEqual(["fake"]);
  const models = await rig.ok<{ driverId: string; models: { id: string }[] }>("GET", "/drivers/fake/models");
  expect(models).toMatchObject({ driverId: "fake", models: [{ id: "fake-model" }] });
  expect(await rig.call("GET", "/drivers/nope/models")).toMatchObject({ status: 404 });
});

test("restarting is refused when nothing supervises the service (409) and the service keeps answering", async () => {
  const rig = await boot();
  expect(await rig.call("POST", "/service/restart")).toMatchObject({ status: 409 });
  expect((await rig.call("GET", "/projects")).status).toBe(200);
});

test("a chief of staff is listed only once opened, POST /cos is idempotent, and PATCH switches it off", async () => {
  const rig = await boot();
  const project = await rig.project("ACME");
  const group = (await rig.ok<Project>("PATCH", `/projects/${project.id}`, { group: "Work" })).groupId!;
  expect(await rig.ok<Cos[]>("GET", "/cos")).toEqual([]);
  const all = await rig.ok<Cos>("POST", "/cos", { scope: "all" });
  expect(await rig.ok<Cos>("POST", "/cos", { scope: "all" })).toEqual(all);
  const work = await rig.ok<Cos>("POST", "/cos", { scope: `group:${group}` });
  expect(work).toMatchObject({ scope: `group:${group}`, groupId: group, enabled: true });
  expect((await rig.ok<Cos[]>("GET", "/cos")).map((c) => c.scope)).toEqual(["all", `group:${group}`]);
  expect(await rig.ok<Cos>("PATCH", `/cos/${all.ticketId}`, { enabled: false })).toMatchObject({ ticketId: all.ticketId, enabled: false });
  expect((await rig.ok<Cos[]>("GET", "/cos"))[0]!.enabled).toBe(false);
  expect(await rig.call("POST", "/cos", { scope: "everything" })).toMatchObject({ status: 400 });
  expect(await rig.call("POST", "/cos", { scope: "group:nope" })).toMatchObject({ status: 404 });
  expect(await rig.call("PATCH", `/cos/${all.ticketId}`, { enabled: "off" })).toMatchObject({ status: 400 });
  expect(await rig.call("PATCH", "/cos/missing", { enabled: true })).toMatchObject({ status: 404 });
  // Nothing about it shows on the board's lists.
  expect((await rig.ok<Project[]>("GET", "/projects")).map((p) => p.key)).toEqual(["ACME"]);
  expect((await rig.ok<Group[]>("GET", "/groups")).map((g) => g.id)).toEqual([group]);
  expect(await rig.call("DELETE", `/tickets/${all.key}`)).toMatchObject({ status: 409 });
});

test("a project's CoS overrides come back from the API and clear with null", async () => {
  const rig = await boot();
  const project = await rig.project("ACME");
  expect(project).toMatchObject({ cosEnabled: null, cosStatuses: null });
  expect(await rig.ok<Project>("PATCH", `/projects/${project.id}`, { cosStatuses: ["review", "blocked"] })).toMatchObject({ cosEnabled: null, cosStatuses: ["blocked", "review"] });
  expect(await rig.ok<Project>("PATCH", `/projects/${project.id}`, { cosStatuses: [] })).toMatchObject({ cosStatuses: [] });
  expect(await rig.call("PATCH", `/projects/${project.id}`, { cosStatuses: ["nope"] })).toMatchObject({ status: 400 });
  expect(await rig.ok<Project>("PATCH", `/projects/${project.id}`, { cosStatuses: null })).toMatchObject({ cosStatuses: null });
  expect(await rig.call("PATCH", `/projects/${project.id}`, { cosEnabled: "yes" })).toMatchObject({ status: 400 });
  expect(await rig.ok<PublicSettings>("PATCH", "/settings", { cosEnabled: false })).toMatchObject({ cosEnabled: false, cosStatuses: [] });
  expect(await rig.ok<PublicSettings>("PATCH", "/settings", { cosStatuses: ["done"] })).toMatchObject({ cosStatuses: ["done"] });
});

test("the chief-of-staff model is saved on the app and on a project, and clears with null", async () => {
  const rig = await boot();
  const project = await rig.project("ACME");
  expect(project.cosModel ?? null).toBeNull();
  expect(await rig.ok<PublicSettings>("PATCH", "/settings", { cosModel: { driver: rig.driver.id, model: "d1" } })).toMatchObject({ cosModel: { driver: rig.driver.id, model: "d1" } });
  expect(await rig.ok<Project>("PATCH", `/projects/${project.id}`, { cosModel: { driver: rig.driver.id, model: null } })).toMatchObject({ cosModel: { driver: rig.driver.id, model: null } });
  expect((await rig.ok<Project[]>("GET", "/projects")).find((p) => p.id === project.id)).toMatchObject({ cosModel: { driver: rig.driver.id, model: null } });
  expect(await rig.ok<Project>("PATCH", `/projects/${project.id}`, { cosModel: null })).toMatchObject({ cosModel: null });
  expect(await rig.ok<PublicSettings>("PATCH", "/settings", { cosModel: null })).toMatchObject({ cosModel: null });
  expect(await rig.call("PATCH", `/projects/${project.id}`, { cosModel: { driver: "nope", model: null } })).toMatchObject({ status: 400 });
  expect(await rig.call("PATCH", "/settings", { cosModel: "opus" })).toMatchObject({ status: 400 });
});

test("DELETE /labels/:name finds a label by its URL-encoded name in any case, drops it from tickets, and 404s once it's gone", async () => {
  const rig = await boot();
  const project = await rig.project("LBL");
  const ticket = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "x", start: false, labels: ["Odd / name #1 %", "Keep"] });
  const path = `/labels/${encodeURIComponent("odd / NAME #1 %")}`;
  expect(await rig.ok("DELETE", path)).toEqual({ ok: true });
  expect(((await rig.ok<{ name: string }[]>("GET", "/labels")).map((l) => l.name))).toEqual(["Keep"]);
  expect((await rig.ok<{ ticket: Ticket }>("GET", `/tickets/${ticket.key}`)).ticket.labels).toEqual(["Keep"]);
  expect(await rig.call("DELETE", path)).toMatchObject({ status: 404, body: { error: expect.stringMatching(/Unknown label/) } });
});
