import { describe, expect, test } from "bun:test";
import { ALL_SCOPE, groupScope } from "@harness/shared/state";
import { THEMES } from "@harness/shared/themes";
import type { TerminalExit, TerminalSession } from "../../main/types";
import { appOwnsKey, createAttach, exitLabel, menuKey, terminalColors, terminalCwd, terminalScope } from "./terminal";

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
    end: 0,
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
  const size = { cols: 80, rows: 24 };

  test("a chunk the scrollback already holds is skipped, whichever side of ensure's reply it arrives", () => {
    // Output so far: "ab" (ends at 2) then "cd" (ends at 4). ensure() snapshotted after both.
    const before = harness();
    before.attach.data("ab", 2); // sent and received before the reply
    before.attach.attached(session({ scrollback: "abcd", end: 4 }), size);
    before.attach.data("cd", 4); // sent before the reply, received after it
    before.attach.data("ef", 6);
    expect(before.log).toEqual(["write abcd", "write ef"]);
  });

  test("a chunk sent after the reply but received before it is held, not lost", () => {
    const { log, attach } = harness();
    attach.data("ef", 6);
    attach.attached(session({ scrollback: "abcd", end: 4 }), size);
    attach.data("gh", 8);
    expect(log).toEqual(["write abcd", "write ef", "write gh"]);
  });

  test("a chunk straddling the scrollback's end writes only its new part", () => {
    const { log, attach } = harness();
    attach.attached(session({ scrollback: "abc", end: 3 }), size);
    attach.data("bcdef", 6);
    attach.data("def", 6); // a repeat of what's written
    expect(log).toEqual(["write abc", "write def"]);
  });

  test("a trimmed scrollback still lines up: offsets count all output, not what's kept", () => {
    const { log, attach } = harness();
    attach.attached(session({ scrollback: "6789", end: 10 }), size);
    attach.data("89xy", 12);
    expect(log).toEqual(["write 6789", "write xy"]);
  });

  test("a re-attached pane resizes the PTY to itself (ensure ignores cols/rows for an existing shell)", () => {
    const { log, attach } = harness();
    attach.attached(session({ created: false, cols: 80, rows: 24 }), { cols: 132, rows: 40 });
    expect(log).toEqual(["resize 132x40"]);
  });

  test("a fresh shell spawned at the pane's size isn't resized again; one the pane outgrew meanwhile is", () => {
    const fresh = harness();
    fresh.attach.attached(session(), size);
    expect(fresh.log).toEqual([]);
    const grew = harness();
    grew.attach.attached(session(), { cols: 100, rows: 24 });
    expect(grew.log).toEqual(["resize 100x24"]);
  });

  test("an empty scrollback writes nothing (ghostty-web throws on write(''))", () => {
    const { log, attach } = harness();
    attach.attached(session(), size);
    attach.data("", 0);
    expect(log).toEqual([]);
  });

  test("a shell that exited while no pane showed it reports the exit on attach", () => {
    const { log, attach } = harness();
    attach.attached(session({ created: false, scrollback: "bye\r\n", end: 5, exit: { exitCode: 3, signal: null } }), size);
    expect(log).toEqual(["write bye\r\n", "resize 80x24", "exit 3"]);
  });

  test("an exit that arrives before the reply is held until attach; one after is reported as it comes", () => {
    const early = harness();
    early.attach.exit(exit0);
    expect(early.log).toEqual([]);
    early.attach.attached(session(), size);
    expect(early.log).toEqual(["exit 0"]);
    const late = harness();
    late.attach.attached(session(), size);
    late.attach.exit({ exitCode: 7, signal: null });
    expect(late.log).toEqual(["exit 7"]);
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
