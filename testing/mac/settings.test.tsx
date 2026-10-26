import { describe, expect, test } from "bun:test";
import { SettingsView } from "../../app/src/renderer/views/Settings";
import { all, edited, mount, text, type } from "./render";

const driverRow = (m: { container: HTMLElement }, name: string) => all(m.container, "*").find((e) => text(e).startsWith(name) && e.children.length > 0 && text(e).length < 120);

describe("Settings", () => {
  test("a driver that is installed and signed in is ready; one that isn't installed is unavailable", async () => {
    const m = await mount(<SettingsView />, { hash: "#/settings" });
    await m.until("drivers", () => text(m.container).includes("Claude Code"));
    expect(text(driverRow(m, "Claude Code"))).toContain("Ready");
    expect(text(driverRow(m, "Codex"))).toContain("Unavailable");
  });

  test("installing the driver changes its row", async () => {
    const world = edited((w) => {
      const codex = w.drivers.find((d) => d.id === "codex")!;
      codex.available = true;
      codex.authenticated = true;
    });
    const m = await mount(<SettingsView />, { hash: "#/settings", world });
    await m.until("drivers", () => text(m.container).includes("Codex"));
    expect(text(driverRow(m, "Codex"))).toContain("Ready");
  });

  test("the concurrency limit field shows the service's value", async () => {
    const m = await mount(<SettingsView />, { hash: "#/settings" });
    await m.until("general", () => text(m.container).includes("Max concurrent runs"));
    const inputs = all(m.container, "input").map((i) => (i as HTMLInputElement).value);
    expect(inputs).toContain("3");
    expect(inputs).toContain("250000");
  });

  test("a settings update pushed by the service replaces the shown value", async () => {
    const m = await mount(<SettingsView />, { hash: "#/settings" });
    await m.until("general", () => text(m.container).includes("Max concurrent runs"));
    await m.settle(() => m.client.push({ kind: "settings.updated", settings: { ...m.client.world.settings, maxConcurrentRuns: 7 } }));
    expect(all(m.container, "input").map((i) => (i as HTMLInputElement).value)).toContain("7");
  });

  test("the event history field shows the service's days and saves a whole number of them kept within 1 to 365", async () => {
    const m = await mount(<SettingsView />, { hash: "#/settings" });
    await m.until("general", () => text(m.container).includes("Keep event history for"));
    m.client.overrides.set("PATCH /settings", () => m.client.world.settings);
    const field = all(m.container, 'input[aria-label="Keep event history for"]')[0] as HTMLInputElement;
    expect(field.value).toBe("7");
    for (const typed of ["30", "0", "9999", "", "soon"]) {
      field.focus();
      await type(m, field, typed);
      await m.settle(() => void field.blur());
    }
    const sent = m.client.bodies.filter((b) => b.request === "PATCH /settings").map((b) => b.body);
    // Zero clamps up to a day and 9999 down to a year; blank and text save nothing.
    expect(sent).toEqual([{ eventRetentionDays: 30 }, { eventRetentionDays: 1 }, { eventRetentionDays: 365 }]);
  });

  test("every endpoint the page asks for is one the world answers", async () => {
    const m = await mount(<SettingsView />, { hash: "#/settings" });
    await m.settle();
    expect(m.client.unrouted).toEqual([]);
  });
});
