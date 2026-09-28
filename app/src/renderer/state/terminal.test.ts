import { describe, expect, test } from "bun:test";
import { ALL_SCOPE } from "@harness/shared/state";
import { THEMES } from "@harness/shared/themes";
import type { TerminalExit, TerminalSession } from "../../main/types";
import { appOwnsKey, createAttach, exitLabel, terminalColors, terminalCwd, terminalScope } from "./terminal";

describe("terminalCwd", () => {
  const projects = { p1: { path: "/Users/me/Sites/harness" }, p2: { path: "" } };

  test("a project board opens in the project's folder", () => {
    expect(terminalCwd("p1", projects)).toBe("/Users/me/Sites/harness");
  });

  test("All projects, a project that isn't loaded, or one without a path opens at home", () => {
    expect(terminalCwd(ALL_SCOPE, projects)).toBe("~");
    expect(terminalCwd("gone", projects)).toBe("~");
    expect(terminalCwd("p2", projects)).toBe("~");
  });
});

describe("terminalScope", () => {
  test("the board on screen", () => {
    expect(terminalScope({ view: "board", projectId: "p1", ticketKey: "A-1", tab: "summaries" }, "p9")).toBe("p1");
    expect(terminalScope({ view: "board", projectId: null, ticketKey: null, tab: "summaries" }, "p9")).toBe(ALL_SCOPE);
  });

  test("a project's settings page opens on that project's board", () => {
    expect(terminalScope({ view: "project", projectId: "p2" }, "p9")).toBe("p2");
  });

  test("Inbox and Settings use the board last shown, else All projects", () => {
    expect(terminalScope({ view: "inbox", sessionId: null }, "p9")).toBe("p9");
    expect(terminalScope({ view: "settings", section: null }, null)).toBe(ALL_SCOPE);
  });
});

describe("createAttach", () => {
  const session = (over: Partial<TerminalSession> = {}): TerminalSession => ({
    id: "t:1",
    pid: 1,
    shell: "/bin/zsh",
    cwd: "/",
    cols: 80,
    rows: 24,
    created: true,
    scrollback: "",
    exit: null,
    ...over,
  });
  function harness() {
    const log: string[] = [];
    const attach = createAttach({
      write: (d) => log.push(`write ${d}`),
      resizePty: (c, r) => log.push(`resize ${c}x${r}`),
      exited: (e) => log.push(`exit ${e.exitCode}`),
    });
    return { log, attach };
  }
  const exit0: TerminalExit = { exitCode: 0, signal: null };

  test("output before ensure resolves is dropped (it's in the scrollback), then the scrollback, then live data in order", () => {
    const { log, attach } = harness();
    attach.data("early"); // already folded into the scrollback by the manager
    attach.attached(session({ created: false, scrollback: "history\r\n" }), { cols: 80, rows: 24 });
    attach.data("a");
    attach.data("b");
    expect(log).toEqual(["write history\r\n", "resize 80x24", "write a", "write b"]);
  });

  test("a re-attached pane resizes the PTY to itself (ensure ignores cols/rows for an existing shell)", () => {
    const { log, attach } = harness();
    attach.attached(session({ created: false, cols: 80, rows: 24 }), { cols: 132, rows: 40 });
    expect(log).toEqual(["resize 132x40"]);
  });

  test("a fresh shell spawned at the pane's size isn't resized again; one the pane outgrew meanwhile is", () => {
    const fresh = harness();
    fresh.attach.attached(session(), { cols: 80, rows: 24 });
    expect(fresh.log).toEqual([]);
    const grew = harness();
    grew.attach.attached(session(), { cols: 100, rows: 24 });
    expect(grew.log).toEqual(["resize 100x24"]);
  });

  test("an empty scrollback or chunk writes nothing (ghostty-web throws on write(''))", () => {
    const { log, attach } = harness();
    attach.attached(session(), { cols: 80, rows: 24 });
    attach.data("");
    expect(log).toEqual([]);
  });

  test("a shell that exited while no pane showed it reports the exit on attach", () => {
    const { log, attach } = harness();
    attach.exit(exit0); // before attach: dropped, the session carries it
    attach.attached(session({ created: false, scrollback: "bye\r\n", exit: { exitCode: 3, signal: null } }), { cols: 80, rows: 24 });
    expect(log).toEqual(["write bye\r\n", "resize 80x24", "exit 3"]);
  });

  test("an exit after attach is reported; after detach (a restart) events drop again", () => {
    const { log, attach } = harness();
    attach.attached(session(), { cols: 80, rows: 24 });
    attach.exit(exit0);
    attach.detach();
    expect(attach.isAttached).toBe(false);
    attach.data("old shell");
    attach.exit(exit0);
    expect(log).toEqual(["exit 0"]);
  });
});

test("exitLabel names the code, or the signal that killed the shell", () => {
  expect(exitLabel({ exitCode: 1, signal: null })).toBe("Process exited (code 1)");
  expect(exitLabel({ exitCode: 0, signal: 9 })).toBe("Process exited (signal 9)");
});

test("⌘ shortcuts stay with the app, except ⌘C/⌘V; ⌃ and plain keys go to the shell", () => {
  const key = (code: string, metaKey = false) => appOwnsKey({ code, metaKey });
  for (const code of ["KeyN", "KeyT", "KeyW", "Digit1", "Comma", "KeyK"]) expect(key(code, true)).toBe(true);
  expect(key("KeyC", true)).toBe(false);
  expect(key("KeyV", true)).toBe(false);
  expect(key("KeyC")).toBe(false); // ⌃C arrives with ctrlKey, not metaKey
  expect(key("Escape")).toBe(false);
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
