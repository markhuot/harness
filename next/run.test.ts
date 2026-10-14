import { describe, expect, test } from "bun:test";
import { nameMetrics, parseMetrics, parseResults, splitTiers, summarize } from "./run";

describe("the runner", () => {
  test("contract files run apart from the guarded tier", () => {
    const { unit, contract } = splitTiers(["next/orchestrator/a.test.ts", "next/contract/real-git.test.ts", "next/git/memory-git.test.ts"]);
    expect(unit).toEqual(["next/orchestrator/a.test.ts", "next/git/memory-git.test.ts"]);
    expect(contract).toEqual(["next/contract/real-git.test.ts"]);
  });

  test("the summary lists the most CPU-hungry tests first and totals CPU, whatever the wall time", () => {
    const metrics = [
      { file: "a", name: "fast", wallMs: 9000, cpuMs: 5 },
      { file: "a", name: "hot", wallMs: 10, cpuMs: 400 },
      { file: "b", name: "warm", wallMs: 20, cpuMs: 90 },
    ];
    const s = summarize(metrics, 2);
    expect(s.slowest.map((m) => m.name)).toEqual(["hot", "warm"]);
    expect(s.cpuMs).toBe(495);
    expect(s.tests).toBe(3);
  });

  test("the JUnit report's testcases name the guard's measurements, in order, with the file", () => {
    const junit = [
      `<testcase name="one" classname="group" time="0.001" file="next/a.test.ts" line="3" assertions="1" />`,
      `<testcase name="the run&apos;s two" classname="group" time="0.003" file="next/a.test.ts" line="9" assertions="1" />`,
      `<testcase name="three" classname="" time="0" file="next/b.test.ts" line="2" assertions="1" />`,
    ].join("\n");
    const measured = parseMetrics('{"wallMs":1.2,"cpuMs":1}\n{"wallMs":3,"cpuMs":2}\n{"wallMs":0.1,"cpuMs":3}\n');
    expect(nameMetrics(measured, parseResults(junit)).map((m) => [m.file, m.name, m.cpuMs])).toEqual([
      ["next/a.test.ts", "group > one", 1],
      ["next/a.test.ts", "group > the run's two", 2],
      ["next/b.test.ts", "three", 3],
    ]);
  });

  test("when the counts disagree no measurement is given a wrong name", () => {
    const named = nameMetrics([{ wallMs: 1, cpuMs: 1 }], parseResults(`<testcase name="a" classname="g" time="0" file="f" line="1" /><testcase name="b" classname="g" time="0" file="f" line="2" />`));
    expect(named[0]!.name).toMatch(/names unavailable: 1 measured, 2 reported/);
  });
});
