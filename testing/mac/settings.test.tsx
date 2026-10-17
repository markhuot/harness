import { describe, expect, test } from "bun:test";
import { SettingsView } from "../../app/src/renderer/views/Settings";
import { all, edited, mount, text } from "./render";

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

  test("every endpoint the page asks for is one the world answers", async () => {
    const m = await mount(<SettingsView />, { hash: "#/settings" });
    await m.settle();
    expect(m.client.unrouted).toEqual([]);
  });
});
