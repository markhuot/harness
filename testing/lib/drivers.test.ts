import { expect, test } from "bun:test";
import { daemonEnv } from "./daemon";
import { columnCount, keyboardClearance, labelCenter, labelValue, parseLabels, screenState } from "./ios";
import { macEnv } from "./mac";

test("the daemon starts on port 0 with the dummy driver in the run's home, whatever the host's own Harness settings say", () => {
  const env = daemonEnv({ PATH: "/bin", HARNESS_HOME: "/Users/me/.harness", HARNESS_PORT: "7717", HARNESS_HOST: "any", HARNESS_SUPERVISOR_PID: "1", HARNESS_LAUNCHD: "1", XPC_SERVICE_NAME: "x" }, "/tmp/run/home");
  expect(env.PATH).toBe("/bin");
  expect(env.HARNESS_HOME).toBe("/tmp/run/home");
  expect(env.HARNESS_PORT).toBe("0");
  expect(env.HARNESS_DUMMY_DRIVER).toBe("1");
  expect(Object.keys(env).filter((k) => k.startsWith("HARNESS_")).sort()).toEqual(["HARNESS_DUMMY_DELAY_MS", "HARNESS_DUMMY_DRIVER", "HARNESS_HOME", "HARNESS_PORT"]);
  expect(env.XPC_SERVICE_NAME).toBeUndefined();
});

test("the Mac app is pointed at the run's service and profile, and never inherits another service or electron-as-node", () => {
  const env = macEnv({ PATH: "/bin", HARNESS_URL: "http://elsewhere", HARNESS_TOKEN: "old", ELECTRON_RUN_AS_NODE: "1" }, { url: "http://127.0.0.1:5", token: "t", userData: "/tmp/ud" });
  expect(env).toEqual({ PATH: "/bin", HARNESS_URL: "http://127.0.0.1:5", HARNESS_TOKEN: "t", HARNESS_USER_DATA: "/tmp/ud" });
});

test("AXe's JSON gives every label, unescaping the slashes it escapes", () => {
  const json = '{ "AXLabel" : "Planning, 1" }, { "AXLabel" : "src\\/greeting.ts" }, { "AXValue" : "x" }';
  expect(parseLabels(json)).toEqual(["Planning, 1", "src/greeting.ts"]);
});

test("the open-link prompt is told from the board, and a column chip's count is read only from a real chip", () => {
  expect(screenState(["Open in “Harness”?", "Cancel", "Open"])).toBe("prompt");
  expect(screenState(["Harness", "Planning, 0", "Review, 2"])).toBe("board");
  expect(screenState(["Harness", "Settings"])).toBe("other");
  const labels = ["Planning, 0", "Review, 2", "Review, notes", "In progress, 10"];
  expect(columnCount(labels, "Review")).toBe(2);
  expect(columnCount(labels, "In progress")).toBe(10);
  expect(columnCount(labels, "Done")).toBeUndefined();
});

test("a label's value is the AXValue of its element, null when it has none or the label is absent", () => {
  const tree = JSON.stringify([{ AXLabel: "Harness", children: [{ AXLabel: "Chief of Staff", AXValue: "3 waiting" }, { AXLabel: "Projects", AXValue: "" }] }]);
  expect(labelValue(tree, "Chief of Staff")).toBe("3 waiting");
  expect(labelValue(tree, "Projects")).toBeNull();
  expect(labelValue(tree, "Nope")).toBeNull();
  expect(labelValue("not json", "Chief of Staff")).toBeNull();
});

test("a label's centre comes from its frame, and is null when it's absent or laid out off the screen", () => {
  const tree = JSON.stringify([{ AXLabel: "Harness", AXFrame: "{{0, 0}, {834, 1210}}", children: [{ AXLabel: "Cancel", AXFrame: "{{10, 20}, {100, 40}}", children: [] }, { children: [{ AXLabel: "Open", AXFrame: "{{200.5, 400}, {120, 50}}" }] }, { AXLabel: "Review, 1", AXFrame: "{{1040, 40}, {120, 36}}" }, { AXLabel: "Done, 3", AXFrame: "{{800, 40}, {100, 36}}" }] }]);
  expect(labelCenter(tree, "Open")).toEqual({ x: 260.5, y: 425 });
  expect(labelCenter(tree, "Nope")).toBeNull();
  expect(labelCenter(tree, "Review, 1")).toBeNull();
  // Half scrolled off the right edge: tapped on the half that shows.
  expect(labelCenter(tree, "Done, 3")).toEqual({ x: 817, y: 58 });
  expect(labelCenter("not json", "Open")).toBeNull();
});

test("the composer's bottom and the keyboard's top come from the tree, so a composer behind the keyboard is told from one above it", () => {
  const tree = (composerY: number) => JSON.stringify([{ AXFrame: "{{0, 0}, {402, 874}}", children: [{ AXLabel: "Message the agent", AXFrame: `{{16, ${composerY}}, {300, 44}}` }, { type: "Keyboard", AXFrame: "{{0, 560}, {402, 314}}" }, { AXLabel: "space", AXFrame: "{{100, 800}, {200, 44}}" }] }]);
  expect(keyboardClearance(tree(500), "Message the agent")).toEqual({ elementBottom: 544, keyboardTop: 560 });
  expect(keyboardClearance(tree(600), "Message the agent").elementBottom).toBeGreaterThan(560);
  expect(keyboardClearance(JSON.stringify([{ AXFrame: "{{0, 0}, {1, 1}}" }]), "Message the agent")).toEqual({ elementBottom: null, keyboardTop: null });
});

test("a keyboard without a keyboard element in the tree is found by its space bar", () => {
  const tree = JSON.stringify([{ AXFrame: "{{0, 0}, {402, 874}}", children: [{ AXLabel: "Message the agent", AXFrame: "{{16, 480}, {300, 44}}" }, { AXLabel: "space", AXFrame: "{{100, 780}, {200, 44}}" }] }]);
  expect(keyboardClearance(tree, "Message the agent")).toEqual({ elementBottom: 524, keyboardTop: 780 });
});
