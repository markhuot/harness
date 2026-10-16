import { expect, test } from "bun:test";
import { reportedPresence } from "../../../app/src/renderer/state/presenceReport";

test("an away person reports nothing on screen, even a visible window with tickets", () => {
  expect(reportedPresence(true, true, ["A-1"], ["t1"])).toEqual({ visible: false, tickets: [], terminals: [] });
});

test("not away passes the window's state through", () => {
  expect(reportedPresence(true, false, ["A-1"], ["t1"])).toEqual({ visible: true, tickets: ["A-1"], terminals: ["t1"] });
  expect(reportedPresence(false, false, ["A-1"], [])).toEqual({ visible: false, tickets: ["A-1"], terminals: [] });
});
