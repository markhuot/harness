import { describe, expect, test } from "bun:test";
import { DraftEditor } from "../../app/src/renderer/views/DraftEditor";
import { click, mount, type, type Mounted } from "./render";

const spec = "Say hello from the board";
const textarea = (m: Mounted) => m.container.querySelector<HTMLTextAreaElement>("textarea[aria-label=Spec]");
const button = (m: Mounted, id: string) => m.container.querySelector<HTMLButtonElement>(`[data-testid=${id}]`)!;

describe("New Ticket form", () => {
  test("typing a spec saves it as a draft, and Plan first submits it to Planning without starting work", async () => {
    const m = await mount(<DraftEditor paneId="p1" zoomed={false} compose={{ kind: "compose", id: "c1", projectId: "project-HARNESS" }} />);
    await m.until("the spec box", () => !!textarea(m));
    expect(button(m, "draft-plan").disabled).toBe(true);
    await type(m, textarea(m)!, spec);
    await m.until("the draft saved", () => m.client.requests.includes("POST /tickets"));
    expect(m.client.bodies.find((b) => b.request === "POST /tickets")?.body).toMatchObject({ projectId: "project-HARNESS", spec, draft: true });
    expect(button(m, "draft-plan").disabled).toBe(false);
    await click(m, button(m, "draft-plan"));
    await m.until("the submit", () => m.client.requests.includes("POST /tickets/HARNESS-11/submit"));
    expect(m.client.bodies.find((b) => b.request === "POST /tickets/HARNESS-11/submit")?.body).toEqual({ start: false });
  });
});
