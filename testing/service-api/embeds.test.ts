import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, Ticket, TicketDetail } from "@harness/shared";
import { toolCall } from "../service/fake-driver";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

/** A ticket whose agent embedded a report folder (a page, a script, a binary-ish asset) in its spec; the page attachment's id. */
async function embedded() {
  const rig = await boot();
  const project = await rig.project();
  mkdirSync(join(project.path, "report"), { recursive: true });
  writeFileSync(join(project.path, "report/index.html"), "<!doctype html><html><head><script src=app.js></script></head><body>graph</body></html>");
  writeFileSync(join(project.path, "report/app.js"), "window.x = 1;");
  writeFileSync(join(project.path, "report/data.json"), '{"points":[0,1,2,3,4,5,6,7,8,9]}');
  writeFileSync(join(project.path, "report/.env"), "SECRET=1");
  rig.driver.script(toolCall("update_spec", { base_revision: 1, note: "Embedded the report", spec: "[Flame graph](report)" }));
  const ws = await rig.socket();
  const ticket = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Profile it", skipAgentReview: true });
  await ws.event("ticket.upserted", (e: Extract<HarnessEvent, { kind: "ticket.upserted" }>) => e.ticket.key === ticket.key && e.ticket.status === "review");
  const detail = await rig.ok<TicketDetail>("GET", `/tickets/${ticket.key}`);
  const page = detail.attachments!.find((a) => a.kind === "page")!;
  expect(detail.ticket.spec).toBe(`[Flame graph](attachment:${page.id})`);
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${rig.harness.url}/embeds/${page.id}${path}`, { headers: { authorization: `Bearer ${rig.harness.token}`, ...headers } });
  return { rig, page, get };
}

test("an embed's entry page is served as HTML with the sizing script before its own scripts", async () => {
  const { get } = await embedded();
  for (const path of ["/", "/index.html", ""]) {
    const res = await get(path);
    expect([path, res.status]).toEqual([path, 200]);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const html = await res.text();
    expect(html.indexOf("harnessEmbedHeight")).toBeGreaterThan(html.indexOf("<head>"));
    expect(html.indexOf("harnessEmbedHeight")).toBeLessThan(html.indexOf("app.js"));
  }
});

test("assets keep their own type, untouched, and honour Range; files the manifest doesn't list are 404", async () => {
  const { get } = await embedded();
  const js = await get("/app.js");
  expect(js.headers.get("content-type")).toStartWith("text/javascript");
  expect(await js.text()).toBe("window.x = 1;");
  const part = await get("/data.json", { range: "bytes=0-9" });
  expect(part.status).toBe(206);
  expect(await part.text()).toBe('{"points":');
  for (const path of ["/.env", "/../manifest.json", "/%2e%2e/manifest.json", "/nope.js", "/site/index.html"]) expect([path, (await get(path)).status]).toEqual([path, 404]);
});

test("embeds need the bearer token: no ?token=, and a non-page attachment isn't served", async () => {
  const { rig, page, get } = await embedded();
  expect((await fetch(`${rig.harness.url}/embeds/${page.id}/`)).status).toBe(401);
  expect((await fetch(`${rig.harness.url}/embeds/${page.id}/?token=${rig.harness.token}`)).status).toBe(401);
  expect((await get("/")).status).toBe(200);
  expect((await fetch(`${rig.harness.url}/embeds/nope/`, { headers: { authorization: `Bearer ${rig.harness.token}` } })).status).toBe(404);
});
