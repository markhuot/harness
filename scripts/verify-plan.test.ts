import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_REASON, IOS_FEATURE_CHECKS, RENDERER_CHECKS, RENDERER_FALLBACK, allLayers, newTestsInOldDirs, planLayers } from "./verify-plan";

const root = join(import.meta.dir, "..");
const ids = (files: string[]) => planLayers(files).layers.map((l) => l.id);

describe("planLayers", () => {
  test("a service file runs the service's tests and the typecheck, not every package", () => {
    expect(ids(["service/src/api/tickets.ts"])).toEqual(["bun:service", "typecheck"]);
  });

  test("the new suite runs when it changes, and when the git adapter or what drives it changes", () => {
    expect(ids(["next/support/guard.ts"])).toEqual(["typecheck", "next"]);
    expect(ids(["service/src/orchestrator/worktree.ts"])).toEqual(["bun:service", "typecheck", "next"]);
    expect(ids(["service/src/api/tickets.ts"])).toEqual(["bun:service", "typecheck"]);
  });

  test("shared and repo-wide config widen to every package's tests", () => {
    expect(ids(["shared/src/types.ts"])).toEqual(["bun:all", "typecheck"]);
    expect(ids(["bun.lock"])).toEqual(["bun:all", "typecheck"]);
    expect(ids(["scripts/typecheck.ts"])).toEqual(["bun:all", "typecheck"]);
  });

  test("a scoped bun layer folds into bun:all, keeping its reasons", () => {
    const { layers } = planLayers(["service/src/a.ts", "shared/src/b.ts"]);
    expect(layers.map((l) => l.id)).toEqual(["bun:all", "typecheck"]);
    expect(layers[0]!.reasons).toEqual(["shared/src/b.ts", "service/src/a.ts"].sort((a, b) => (a === "shared/src/b.ts" ? -1 : 1)));
  });

  test("editor source reruns the app's tests and both apps' file checks, since the editor is what they show", () => {
    expect(ids(["editor/src/x.ts"])).toEqual(["bun:editor", "bun:app", "typecheck", "app-build", "app-check:file-pane-check", expect.stringMatching(/^sim-check/)]);
  });

  test("an editor test alone needs only the editor's tests", () => {
    expect(ids(["editor/src/x.test.ts"])).toEqual(["bun:editor", "typecheck"]);
  });

  test("a plugin runs its own tests; the sdk runs everything", () => {
    expect(ids(["plugins/git/src/x.ts"])).toEqual(["bun:plugins/git", "typecheck"]);
    expect(ids(["plugins/sdk/src/x.ts"])).toEqual(["bun:all", "typecheck"]);
  });

  test("a renderer component runs the check that drives it, after one app build", () => {
    expect(ids(["app/src/renderer/components/TicketSettings.tsx"])).toEqual(["bun:app", "typecheck", "app-build", "app-check:ticket-settings-check"]);
  });

  test("a renderer file no check names gets the smoke test", () => {
    expect(ids(["app/src/renderer/views/Inbox.tsx"])).toEqual(["bun:app", "typecheck", "app-build", `app-check:${RENDERER_FALLBACK}`]);
  });

  test("a renderer unit test or stylesheet needs no Electron run", () => {
    expect(ids(["app/src/renderer/state/activity.test.ts"])).toEqual(["bun:app", "typecheck"]);
    expect(ids(["app/src/renderer/app.css"])).toEqual(["bun:app", "typecheck"]);
  });

  test("two renderer files share one app build", () => {
    const got = ids(["app/src/renderer/components/ContextGauge.tsx", "app/src/renderer/views/PlanUsage.tsx"]);
    expect(got.filter((i) => i === "app-build")).toHaveLength(1);
    expect(got).toContain("app-check:context-gauge-check");
    expect(got).toContain("app-check:plan-usage-check");
    expect(got.indexOf("app-build")).toBeLessThan(got.indexOf("app-check:plan-usage-check"));
  });

  test("editing a check script reruns that check", () => {
    expect(ids(["app/scripts/groups-check.ts"])).toEqual(["bun:app", "typecheck", "app-build", "app-check:groups-check"]);
  });

  test("an iPhone screen runs snapshots plus the sim-check run for its feature", () => {
    expect(ids(["ios/Harness/Features/Prompts/PromptsScreen.swift"])).toEqual(["snapshots", "sim-check --only=prompt-editor"]);
    expect(ids(["ios/Harness/App/TicketSheetHost.swift"])).toEqual(["snapshots", "sim-check --sheets"]);
  });

  test("an iPhone screen with no sim-check chain gets snapshots only", () => {
    expect(ids(["ios/Harness/Features/Inbox/InboxScreen.swift"])).toEqual(["snapshots"]);
  });

  test("project.yml and sim-check itself run the walk-through", () => {
    expect(ids(["ios/project.yml"])).toEqual(["snapshots", "sim-check"]);
    expect(ids(["ios/Tools/sim-check.ts"])).toEqual(["bun:ios", "typecheck", "sim-check"]);
  });

  test("other ios tooling runs the ios tests, no simulator", () => {
    expect(ids(["ios/Tools/sim.ts"])).toEqual(["bun:ios", "typecheck"]);
  });

  test("HarnessKit source also builds the app through snapshots; its tests need only swift test", () => {
    expect(ids(["ios/HarnessKit/Sources/HarnessKit/Shell/DebugState.swift"])).toEqual(["swift-test", "snapshots"]);
    expect(ids(["ios/HarnessKit/Package.swift"])).toEqual(["swift-test", "snapshots"]);
    expect(ids(["ios/HarnessKit/Tests/HarnessKitTests/DebugStateTests.swift"])).toEqual(["swift-test"]);
  });

  test("build tooling that makes the app build runs snapshots, with the reason on the layer", () => {
    for (const f of ["ios/Tools/build.ts", "ios/Tools/build-cache.ts", "ios/Tools/snapshots.ts"]) {
      expect(ids([f])).toEqual(["bun:ios", "typecheck", "snapshots"]);
    }
    expect(planLayers(["ios/Tools/build.ts"]).layers.find((l) => l.id === "snapshots")?.reasons).toEqual(["ios/Tools/build.ts"]);
    expect(ids(["ios/Tools/build.test.ts"])).toEqual(["bun:ios", "typecheck"]);
  });

  test("light layers come before app checks, which come before simulator layers", () => {
    const got = ids(["ios/Harness/Features/Files/FileViewerScreen.swift", "app/src/renderer/views/PlanUsage.tsx", "service/src/x.ts"]);
    expect(got).toEqual(["bun:app", "bun:service", "typecheck", "app-build", "app-check:plan-usage-check", "snapshots", "sim-check --only=file-link,save-on-blur,file-edit"]);
  });

  test("docs-only diffs plan nothing, on purpose", () => {
    const plan = planLayers(["CHANGELOG.md", "CLAUDE.md"]);
    expect(plan.layers).toEqual([]);
    expect(plan.notes[0]).toContain("only docs");
  });

  test("a file no rule claims falls back to bun tests + typecheck, alongside what the rest need", () => {
    const plan = planLayers(["mystery/thing.rs", "ios/HarnessKit/Sources/X.swift"]);
    expect(plan.unmatched).toEqual(["mystery/thing.rs"]);
    expect(plan.layers.map((l) => l.id)).toEqual(["bun:all", "typecheck", "swift-test", "snapshots"]);
    expect(plan.layers[0]!.reasons[0]).toContain(FALLBACK_REASON);
  });

  test("an empty diff also falls back rather than verifying nothing", () => {
    expect(ids([])).toEqual(["bun:all", "typecheck"]);
  });
});

describe("the mapping points at things that exist", () => {
  const checks = new Set([...RENDERER_CHECKS.map(([, n]) => n), RENDERER_FALLBACK]);
  for (const name of checks) test(`app/scripts/${name}.ts exists`, () => expect(existsSync(join(root, "app/scripts", `${name}.ts`))).toBe(true));

  const simCheck = readFileSync(join(root, "ios/Tools/sim-check.ts"), "utf8");
  const mapped = IOS_FEATURE_CHECKS.flatMap(([, args]) => args);
  for (const arg of mapped) {
    if (arg.startsWith("--only=")) {
      for (const name of arg.slice(7).split(",")) test(`sim-check has a chain named ${name}`, () => expect(simCheck).toContain(`chain("${name}"`));
    } else test(`sim-check documents ${arg}`, () => expect(simCheck).toContain(`//   ${arg}`));
  }

  test("every RENDERER_CHECKS pattern matches a real renderer file", () => {
    const files = new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(root, "app/src/renderer") });
    const all = [...files].map((f) => `app/src/renderer/${f}`);
    for (const [re] of RENDERER_CHECKS) expect(all.some((f) => re.test(f))).toBe(true);
  });
});

describe("allLayers", () => {
  test("runs every package, swift test, the given app checks and both simulator layers", () => {
    expect(allLayers(["smoke", "groups-check"]).map((l) => l.id)).toEqual(["bun:all", "typecheck", "next", "swift-test", "app-build", "app-check:smoke", "app-check:groups-check", "snapshots", "sim-check"]);
  });
});

describe("newTestsInOldDirs", () => {
  test("a new test or check in a directory the new suite replaces is refused", () => {
    expect(
      newTestsInOldDirs([
        "service/src/orchestrator/new-thing.test.ts",
        "app/scripts/foo-check.ts",
        "ios/HarnessSnapshotTests/NewScreenTests.swift",
        "shared/src/x.test.ts",
      ]),
    ).toEqual(["service/src/orchestrator/new-thing.test.ts", "app/scripts/foo-check.ts", "ios/HarnessSnapshotTests/NewScreenTests.swift", "shared/src/x.test.ts"]);
  });

  test("the new suite, HarnessKit's swift tests, the repo's own tooling tests and non-test files pass", () => {
    expect(newTestsInOldDirs(["next/orchestrator/x.test.ts", "ios/HarnessKit/Tests/FooTests.swift", "scripts/verify.test.ts", "service/src/orchestrator/x.ts"])).toEqual([]);
  });
});

describe("service code the new suite drives", () => {
  test("a change under service/src/orchestrator runs the new suite and the service's old tests and typecheck", () => {
    expect(planLayers(["service/src/orchestrator/orchestrator.ts"]).layers.map((l) => l.id)).toEqual(["bun:service", "typecheck", "next"]);
  });
});
