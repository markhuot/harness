import { describe, expect, test } from "bun:test";
import { ALL_SCOPE, groupScope } from "@harness/shared/state";
import { THEMES } from "@harness/shared/themes";
import type { TerminalInfo } from "@harness/shared";
import { appOwnsKey, applyTerminalEvent, exitLabel, menuKey, terminalColors, terminalCwd, terminalOpenScope, terminalRow, terminalScope, tildePath } from "./terminal";

describe("terminalCwd", () => {
  const projects = { p1: { path: "/Users/me/Sites/harness" }, p2: { path: "" } };

  test("a project board opens in the project's folder", () => {
    expect(terminalCwd("p1", projects)).toBe("/Users/me/Sites/harness");
  });

  test("All projects, a group's board, a project that isn't loaded, or one without a path opens at home", () => {
    expect(terminalCwd(ALL_SCOPE, projects)).toBe("~");
    expect(terminalCwd(groupScope("p1"), projects)).toBe("~");
    expect(terminalCwd("gone", projects)).toBe("~");
    expect(terminalCwd("p2", projects)).toBe("~");
  });

  test("a focused ticket opens in its workdir (worktree or checkout), even on another board", () => {
    const wt = "/Users/me/.harness/worktrees/A-1";
    expect(terminalCwd("p1", projects, { workdir: wt, projectId: "p1" })).toBe(wt);
    expect(terminalCwd(ALL_SCOPE, projects, { workdir: wt, projectId: "p1" })).toBe(wt);
  });

  test("a focused ticket that hasn't started opens in its own project's folder, else home", () => {
    expect(terminalCwd(ALL_SCOPE, projects, { workdir: null, projectId: "p1" })).toBe("/Users/me/Sites/harness");
    expect(terminalCwd("p1", projects, { workdir: null, projectId: "gone" })).toBe("~");
  });
});

describe("terminalScope", () => {
  test("the board on screen", () => {
    expect(terminalScope({ view: "board", projectId: "p1", ticketKey: "A-1", tab: "spec" }, "p9")).toBe("p1");
    expect(terminalScope({ view: "board", projectId: null, ticketKey: null, tab: "spec" }, "p9")).toBe(ALL_SCOPE);
    expect(terminalScope({ view: "board", projectId: null, group: "Work", ticketKey: null, tab: "spec" }, "p9")).toBe(groupScope("Work"));
  });

  test("a project's settings page opens on that project's board", () => {
    expect(terminalScope({ view: "project", projectId: "p2" }, "p9")).toBe("p2");
  });

  test("Inbox and Settings use the board last shown, else All projects", () => {
    expect(terminalScope({ view: "inbox", sessionId: null }, "p9")).toBe("p9");
    expect(terminalScope({ view: "settings", section: null }, null)).toBe(ALL_SCOPE);
  });
});

const info = (over: Partial<TerminalInfo> = {}): TerminalInfo => ({ id: "t-1", cwd: "/Users/me/Sites", title: "", process: "zsh", projectId: null, state: "running", exitCode: null, createdAt: 0, createdBy: "", cols: 80, rows: 24, ...over });

describe("applyTerminalEvent", () => {
  test("created adds, updated replaces in place, removed drops; an unknown id or event changes nothing", () => {
    const a = info({ id: "t-a" });
    const b = info({ id: "t-b" });
    let list = applyTerminalEvent([], { kind: "terminal.created", terminal: a });
    list = applyTerminalEvent(list, { kind: "terminal.created", terminal: b });
    expect(list.map((t) => t.id)).toEqual(["t-a", "t-b"]);
    list = applyTerminalEvent(list, { kind: "terminal.updated", terminal: { ...a, title: "vim" } });
    expect(list.map((t) => t.title)).toEqual(["vim", ""]);
    // an update that arrives before its created (a reconnect gap) still lists it
    expect(applyTerminalEvent(list, { kind: "terminal.updated", terminal: info({ id: "t-c" }) })).toHaveLength(3);
    const same = applyTerminalEvent(list, { kind: "terminal.removed", id: "t-zzz" });
    expect(same).toBe(list);
    expect(applyTerminalEvent(list, { kind: "terminal.removed", id: "t-a" }).map((t) => t.id)).toEqual(["t-b"]);
    expect(applyTerminalEvent(list, { kind: "devices.changed" })).toBe(list);
  });
});

describe("terminalRow", () => {
  test("label is the title, else the program; the subtitle says where it is and what runs", () => {
    expect(terminalRow(info({ title: "npm run dev", process: "node" }))).toEqual({
      label: "npm run dev",
      subtitle: "~/Sites · node",
      keywords: ["/Users/me/Sites", "node", "npm run dev"],
    });
    expect(terminalRow(info()).label).toBe("zsh");
    expect(terminalRow(info({ state: "exited", cwd: "/tmp/x" })).subtitle).toBe("/tmp/x · ended");
  });
  test("tildePath only shortens inside the home folder", () => {
    expect(tildePath("/Users/me")).toBe("~");
    expect(tildePath("/Users/me/Sites/harness")).toBe("~/Sites/harness");
    expect(tildePath("/home/me/x")).toBe("~/x");
    expect(tildePath("/var/Users/me")).toBe("/var/Users/me");
  });
});

describe("terminalOpenScope", () => {
  test("the terminal's project when it is loaded, else All projects", () => {
    expect(terminalOpenScope({ projectId: "p1" }, { p1: {} })).toBe("p1");
    expect(terminalOpenScope({ projectId: "gone" }, { p1: {} })).toBe(ALL_SCOPE);
    expect(terminalOpenScope({ projectId: null }, { p1: {} })).toBe(ALL_SCOPE);
  });
});

test("exitLabel names the code; a terminal the service lost has none", () => {
  expect(exitLabel(1)).toBe("Process exited (code 1)");
  expect(exitLabel(null)).toBe("This terminal has ended");
});

test("⌘ shortcuts stay with the app, except ⌘C/⌘V; ⌃ and plain keys go to the shell", () => {
  const key = (code: string, metaKey = false) => appOwnsKey({ code, metaKey });
  for (const code of ["KeyN", "KeyT", "KeyW", "Digit1", "Comma", "KeyK"]) expect(key(code, true)).toBe(true);
  expect(key("KeyC", true)).toBe(false);
  expect(key("KeyV", true)).toBe(false);
  expect(key("KeyC")).toBe(false); // ⌃C arrives with ctrlKey, not metaKey
  expect(key("Escape")).toBe(false);
});

test("menu shortcuts bypass the terminal; ⌃⌘ ones (the renderer's own) and copy/paste don't", () => {
  const k = (code: string, ctrlKey = false) => menuKey({ code, metaKey: true, ctrlKey });
  expect(k("KeyT")).toBe(true);
  expect(k("KeyW")).toBe(true);
  expect(k("KeyS", true)).toBe(false); // ⌃⌘S: the window listener toggles the sidebar
  expect(k("KeyC")).toBe(false);
  expect(menuKey({ code: "KeyT", metaKey: false, ctrlKey: true })).toBe(false); // ⌃T goes to the shell
});

describe("terminalColors", () => {
  test("every built-in theme gives the VT core #rrggbb colors (it reads anything else as black)", () => {
    for (const theme of THEMES) {
      const colors = terminalColors(theme.tokens, theme.appearance === "dark" ? "dark" : "light");
      for (const [slot, value] of Object.entries(colors)) expect(`${theme.id} ${slot} ${value}`).toMatch(/ #[0-9a-f]{6}$/);
    }
  });

  test("uses the theme's background, text and tones, flattening translucent ones over the background", () => {
    const base = THEMES[0]!.tokens;
    const colors = terminalColors({ ...base, bg: "#101010", text: "#eeeeee", red: "#ff0000", selection: "rgba(255, 255, 255, 0.5)" }, "dark");
    expect(colors.background).toBe("#101010");
    expect(colors.foreground).toBe("#eeeeee");
    expect(colors.red).toBe("#ff0000");
    expect(colors.selectionBackground).toBe("#888888");
  });

  test("the slots themes don't define differ between light and dark", () => {
    const tokens = THEMES[0]!.tokens;
    expect(terminalColors(tokens, "light").blue).not.toBe(terminalColors(tokens, "dark").blue);
  });
});
