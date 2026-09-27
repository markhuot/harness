// TicketDetail carries the parent conductor so clients can render the "Part of …" breadcrumb
// even when the conductor isn't loaded on the board (e.g. it's done and beyond the first page).

import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";

test("a child's detail includes its parent conductor; a top-level ticket's parent is null", async () => {
  const h = makeOrchestrator({ driver: new FakeDriver() });
  const dir = join(h.home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  const conductor = await h.orch.createTicket({ projectId: project.id, prompt: "big job", kind: "conductor", start: false });
  const child = await h.orch.createTicket({ projectId: project.id, prompt: "part one", start: false, parentId: conductor.id });
  await h.orch.idle();

  expect(h.orch.ticketDetail(child.key).parent?.key).toBe(conductor.key);
  expect(h.orch.ticketDetail(conductor.key).parent).toBeNull();
});
