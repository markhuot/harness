import { describe, expect, test } from "bun:test";
import { CommandPalette } from "../../app/src/renderer/views/CommandPalette";
import { ProjectSettingsView } from "../../app/src/renderer/views/ProjectSettings";
import { Sidebar } from "../../app/src/renderer/views/Sidebar";
import { all, click, edited, mount, text, type } from "./render";

const blur = (m: Awaited<ReturnType<typeof mount>>, input: HTMLInputElement) => m.settle(() => void input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const groupNameInput = (m: Awaited<ReturnType<typeof mount>>) =>
  all(m.container, ".settings-row").find((r) => text(r).startsWith("Group name"))?.querySelector<HTMLInputElement>("input");

describe("project groups on ids", () => {
  test("the command palette opens a group's board by its id, labelled with its name", async () => {
    const m = await mount(<CommandPalette origin={document.body} onClose={() => {}} onShortcuts={() => {}} />);
    const row = all(m.container, '[role="option"]').find((r) => text(r).startsWith("Board: Work"));
    expect(row).toBeDefined();
    await click(m, row!);
    expect(location.hash).toBe("#/board/group/group-work");
  });

  test("the sidebar lists each group once and marks the one on screen, even from a link that names it", async () => {
    const m = await mount(
      <Sidebar onNewSession={() => {}} onNewTerminal={() => {}} />,
      { hash: "#/board/group/Work" },
    );
    const groups = all(m.container, '[data-testid="nav-group"]');
    expect(groups.map((g) => text(g).replace(/\d+/g, "").trim())).toEqual(["Personal", "Work"]);
    expect(groups.map((g) => g.className.includes("active"))).toEqual([false, true]);
  });

  test("project settings rename the group by its id, once, and not for a blank or unchanged name", async () => {
    const m = await mount(<ProjectSettingsView />, { hash: "#/project/project-HARNESS" });
    m.client.overrides.set("PATCH /groups/group-work", () => ({ id: "group-work", name: "Clients", createdAt: 0 }));
    const input = groupNameInput(m)!;
    expect(input.value).toBe("Work");
    await type(m, input, "   ");
    await blur(m, input);
    await type(m, input, "Work");
    await blur(m, input);
    expect(m.client.bodies.filter((b) => b.request.startsWith("PATCH /groups"))).toEqual([]);
    await type(m, input, "  Clients ");
    await blur(m, input);
    expect(m.client.bodies.filter((b) => b.request.startsWith("PATCH /groups"))).toEqual([{ request: "PATCH /groups/group-work", body: { name: "Clients" } }]);
  });

  test("a project with no group has no rename row", async () => {
    const m = await mount(<ProjectSettingsView />, { hash: "#/project/project-SCRATCH" });
    expect(groupNameInput(m)).toBeUndefined();
  });

  test("a rename pushed as project updates shows the new name and keeps the board", async () => {
    const m = await mount(<Sidebar onNewSession={() => {}} onNewTerminal={() => {}} />, { hash: "#/board/group/group-work" });
    const members = m.client.world.projects.filter((p) => p.groupId === "group-work");
    await m.settle(() => {
      for (const p of members) m.client.push({ kind: "project.upserted", project: { ...p, group: "Clients" } });
    });
    const names = all(m.container, '[data-testid="nav-group"]').map((g) => text(g).replace(/\d+/g, "").trim());
    expect(names).toEqual(["Clients", "Personal"]);
    expect(all(m.container, '[data-testid="nav-group"]')[0]!.className).toContain("active");
  });

  test("picking an existing group sends its id; typing a new name sends the name", async () => {
    const world = edited((w) => {
      w.projects.find((p) => p.key === "SCRATCH")!.color = null;
    });
    const m = await mount(<ProjectSettingsView />, { hash: "#/project/project-SCRATCH", world });
    m.client.overrides.set("PATCH /projects/project-SCRATCH", () => m.client.world.projects.find((p) => p.key === "SCRATCH"));
    await click(m, m.container.querySelector('[aria-label="Group"]')!);
    const option = all(document.body, '[role="option"]').find((o) => text(o) === "Personal")!;
    await click(m, option);
    expect(m.client.bodies.at(-1)).toEqual({ request: "PATCH /projects/project-SCRATCH", body: { groupId: "group-personal" } });
    await click(m, m.container.querySelector('[aria-label="Group"]')!);
    await type(m, document.body.querySelector<HTMLInputElement>('[aria-label="Search groups"]')!, "Ideas");
    await click(m, all(document.body, '[role="option"]').find((o) => text(o).startsWith("New group"))!);
    expect(m.client.bodies.at(-1)).toEqual({ request: "PATCH /projects/project-SCRATCH", body: { group: "Ideas" } });
  });
});
