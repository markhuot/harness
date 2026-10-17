import { describe, expect, test } from "bun:test";
import ChangesView from "../../app/src/renderer/views/ChangesView";
import { world } from "../world";
import { edited, mount, text } from "./render";

const ticket = world.tickets.find((t) => t.key === "HARNESS-5")!;

describe("Changes", () => {
  test("summarises the branch against its base: commits, line counts, files", async () => {
    const m = await mount(<ChangesView ticket={ticket} />);
    await m.until("the summary", () => text(m.container).includes("across 2 files"));
    const body = text(m.container);
    expect(body).toContain("harness/harness-5→main");
    expect(body).toContain("1 commit");
    expect(body).toContain("+3");
    expect(body).toContain("−1");
    expect(body).toContain("0 / 2 viewed");
    expect(m.client.unrouted).toEqual([]);
  });

  test("marking a file viewed moves the viewed count", async () => {
    const m = await mount(<ChangesView ticket={ticket} />);
    await m.until("the summary", () => text(m.container).includes("0 / 2 viewed"));
    const box = m.container.querySelector<HTMLInputElement>('label.changes-viewed[data-path="src/board.ts"] input')!;
    await m.settle(() => void box.click());
    expect(text(m.container)).toContain("1 / 2 viewed");
    // Unmarking it takes the count back.
    await m.settle(() => void m.container.querySelector<HTMLInputElement>('label.changes-viewed[data-path="src/board.ts"] input')!.click());
    expect(text(m.container)).toContain("0 / 2 viewed");
  });

  test("a ticket whose changes can't be loaded shows the failure, not an empty diff", async () => {
    const m = await mount(<ChangesView ticket={ticket} />, { world: edited((w) => void delete w.changes["HARNESS-5"]) });
    await m.until("the error", () => text(m.container).includes("Couldn't load changes"));
    expect(text(m.container)).not.toContain("viewed");
  });
});
