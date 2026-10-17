import { expect, test } from "bun:test";
import { daemonEnv } from "./daemon";
import { columnCount, parseLabels, screenState } from "./ios";
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
