import { expect, test } from "bun:test";
import { parseLsof, parsePs, pollTerminals, processName } from "../../../service/src/terminals/poller";

test("parsePs reads pid, pgid, tpgid and the command, ignoring junk lines", () => {
  const rows = parsePs("  10   10   20 -zsh\n  20   20   20 /usr/bin/vim a b\nnot a row\n 30 30 -1 weird name\n");
  expect(rows.get(10)).toEqual({ pid: 10, pgid: 10, tpgid: 20, comm: "-zsh" });
  expect(rows.get(20)!.comm).toBe("/usr/bin/vim a b");
  expect(rows.get(30)).toMatchObject({ tpgid: -1, comm: "weird name" });
  expect(rows.size).toBe(3);
});

test("parseLsof pairs each p line with the n line after it", () => {
  expect([...parseLsof("p10\nfcwd\nn/home/a\np11\nn/tmp/b c\n")]).toEqual([[10, "/home/a"], [11, "/tmp/b c"]]);
  expect(parseLsof("n/orphan\n").size).toBe(0);
});

test("processName drops a login shell's dash and the directory", () => {
  expect(processName("-zsh")).toBe("zsh");
  expect(processName("/usr/bin/vim")).toBe("vim");
});

test("pollTerminals names the foreground process when it differs from the shell, else the shell, and reads cwd by pid", async () => {
  const ps = "100 100 100 -zsh\n200 200 100 -zsh\n300 300 300 /usr/bin/vim\n400 300 300 helper\n";
  const result = await pollTerminals(
    [{ id: "idle", pid: 100 }, { id: "vim", pid: 200 }, { id: "gone", pid: 999 }],
    { ps: async () => ps.replace("200 200 100", "200 200 300"), lsof: async (pids) => (pids.includes(100) ? "p100\nn/work\np200\nn/other\n" : "") },
  );
  expect(result.get("idle")).toEqual({ cwd: "/work", process: "zsh" });
  expect(result.get("vim")).toEqual({ cwd: "/other", process: "vim" });
  expect(result.get("gone")).toEqual({ cwd: null, process: null });
});

test("asking about nobody runs nothing", async () => {
  const calls: string[] = [];
  const out = await pollTerminals([], { ps: async () => (calls.push("ps"), ""), lsof: async () => (calls.push("lsof"), "") });
  expect(out.size).toBe(0);
  expect(calls).toEqual([]);
});
