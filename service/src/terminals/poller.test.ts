import { describe, expect, test } from "bun:test";
import { parseLsof, parsePs, pollTerminals, processName } from "./poller";

const PS = `
  100   100   500 -zsh
  200   200   200 -zsh
  300   300   300 /usr/bin/vim
  310   500   500 node
  400   400   410 -zsh
  410   410   410 sleep
`;
const LSOF = `p100
fcwd
n/tmp
p200
fcwd
n/Users/mark/My Docs
p400
fcwd
n/var
`;

describe("pollTerminals", () => {
  test("maps each shell to its cwd and foreground process, with one ps and one lsof for all", async () => {
    let psCalls = 0;
    let lsofCalls = 0;
    const result = await pollTerminals(
      [
        { id: "a", pid: 100 },
        { id: "b", pid: 200 },
        { id: "c", pid: 400 },
      ],
      {
        ps: async () => (psCalls++, PS),
        lsof: async (pids) => (lsofCalls++, expect(pids).toEqual([100, 200, 400]), LSOF),
      },
    );
    expect(psCalls).toBe(1);
    expect(lsofCalls).toBe(1);
    // a: foreground group 500 is not a shell group, its leader is gone; a member (node, pgid 500) names it
    expect(result.get("a")).toEqual({ cwd: "/tmp", process: "node" });
    // b: the shell is its own foreground group
    expect(result.get("b")).toEqual({ cwd: "/Users/mark/My Docs", process: "zsh" });
    // c: foreground group 410 led by sleep
    expect(result.get("c")).toEqual({ cwd: "/var", process: "sleep" });
  });

  test("a shell that vanished from ps has no process, and an empty target list runs nothing", async () => {
    const runners = { ps: async () => "", lsof: async () => "" };
    expect((await pollTerminals([{ id: "x", pid: 9 }], runners)).get("x")).toEqual({ cwd: null, process: null });
    let ran = false;
    await pollTerminals([], { ps: async () => ((ran = true), ""), lsof: async () => "" });
    expect(ran).toBe(false);
  });

  test("parsers and names", () => {
    expect(parsePs(PS).get(300)?.comm).toBe("/usr/bin/vim");
    expect(parseLsof(LSOF).get(200)).toBe("/Users/mark/My Docs");
    expect(processName("-zsh")).toBe("zsh");
    expect(processName("/usr/bin/vim")).toBe("vim");
  });
});
