import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileView, FileWriteResult, Ticket } from "@harness/shared";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

/** A rig with a project whose folder holds one file, and an idle ticket (a draft: no run starts) that resolves files there. */
async function withFile() {
  const rig = await boot();
  const project = await rig.project("SITE");
  mkdirSync(join(project.path, "src"), { recursive: true });
  writeFileSync(join(project.path, "src/greeting.ts"), 'export const greeting = "hello";\n');
  const ticket = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Edit the greeting", draft: true });
  return { rig, project, ticket };
}

test("GET /tickets/:key/file reads a file of the ticket's folder, and PUT writes it there", async () => {
  const { rig, project, ticket } = await withFile();
  const path = `/tickets/${ticket.key}/file`;
  const read = await rig.ok<FileView>("GET", `${path}?path=${encodeURIComponent("src/greeting.ts")}`);
  expect(read).toMatchObject({ path: "src/greeting.ts", root: project.path, contents: 'export const greeting = "hello";\n', binary: false });

  const edited = '// edited\nexport const greeting = "hello";\n';
  expect(await rig.ok<FileWriteResult>("PUT", path, { path: "src/greeting.ts", contents: edited })).toEqual({ path: "src/greeting.ts", size: Buffer.byteLength(edited) });
  expect(readFileSync(join(project.path, "src/greeting.ts"), "utf8")).toBe(edited);
  expect((await rig.ok<FileView>("GET", `${path}?path=${encodeURIComponent("src/greeting.ts")}`)).contents).toBe(edited);
});

test("a write outside the ticket's folder, or for a ticket that doesn't exist, is refused and writes nothing", async () => {
  const { rig, project, ticket } = await withFile();
  const escape = await rig.call("PUT", `/tickets/${ticket.key}/file`, { path: "../outside.ts", contents: "x" });
  expect(escape.status).toBeGreaterThanOrEqual(400);
  expect(escape.status).toBeLessThan(500);
  expect(existsSync(join(project.path, "..", "outside.ts"))).toBe(false);

  const missing = await rig.call("PUT", "/tickets/SITE-99/file", { path: "src/greeting.ts", contents: "x" });
  expect(missing.status).toBe(404);
  expect(readFileSync(join(project.path, "src/greeting.ts"), "utf8")).toBe('export const greeting = "hello";\n');
});
