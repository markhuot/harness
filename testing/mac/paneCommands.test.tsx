import { afterEach, describe, expect, test } from "bun:test";
import { usePaneCommands } from "../../app/src/renderer/components/paneCommands";
import { runCommand } from "../../app/src/renderer/components/commands";
import { getPanes, updatePanes } from "../../app/src/renderer/state/panes";
import { layoutPanes } from "../../app/src/renderer/state/paneModel";
import { mount } from "./render";
import { board, row, st, ticket } from "../l0/renderer/paneBuild";

function Host({ scope }: { scope: string | null }) {
  usePaneCommands(scope, false);
  return <div className="pane-workspace" />;
}

/** The workspace measures 1600px wide in the command's own `.pane-workspace` query (happy-dom has no layout). */
const stubWorkspace = (m: { container: HTMLElement }, width: number, height: number) => {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  const el = m.container.querySelector<HTMLElement>(".pane-workspace")!;
  Object.defineProperty(el, "clientWidth", { value: width });
  Object.defineProperty(el, "clientHeight", { value: height });
};
const widthOf = (scope: string, id: string) => {
  const s = getPanes(scope);
  return Math.round(layoutPanes(s, { width: 1600, height: 900 }).leaves.find((l) => l.leaf.id === id)!.rect.w * 1600);
};

const INNER_WIDTH = window.innerWidth;
afterEach(() => void Object.defineProperty(window, "innerWidth", { value: INNER_WIDTH, configurable: true }));

describe("pane.cycleWidth command", () => {
  test("measures the pane workspace and steps the focused pane to the next preset width", async () => {
    const scope = "cycle-test";
    const m = await mount(<Host scope={scope} />);
    updatePanes(scope, () => st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]), "a"));
    stubWorkspace(m, 1600, 900);
    expect(widthOf(scope, "a")).toBe(800);
    await m.settle(() => void expect(runCommand("pane.cycleWidth")).toBe(true));
    expect(widthOf(scope, "a")).toBe(400); // 800px wraps to the 25% preset, measured against the 1600px workspace
  });

  test("a different workspace width gives different widths (the measurement is used, not the window)", async () => {
    const scope = "cycle-test-narrow";
    const m = await mount(<Host scope={scope} />);
    updatePanes(scope, () => st(row("r", [board("B"), ticket("a", "A-1")], [0.5, 0.5]), "a"));
    stubWorkspace(m, 800, 900);
    await m.settle(() => void runCommand("pane.cycleWidth"));
    // at 800px the ticket was 400px, the next wider preset isn't the 25% (200px) the 1600px case lands on
    const w = Math.round(layoutPanes(getPanes(scope), { width: 800, height: 900 }).leaves.find((l) => l.leaf.id === "a")!.rect.w * 800);
    expect(w).toBeGreaterThanOrEqual(360); // never the 25% (200px) stop, which would leave the ticket below its minimum
  });
});
