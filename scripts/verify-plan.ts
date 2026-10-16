// The path-to-layer mapping behind `bun run verify` (scripts/verify.ts): which test layers a set of
// changed files needs, and why. Pure data and one function, so it's unit-tested (verify-plan.test.ts)
// and `verify --dry-run` can print the plan without running anything.
//
// Every changed file is matched against RULES. A file no rule claims falls back to "bun tests +
// typecheck" for the whole diff, so a new directory is never silently unchecked. A rule with no
// layers (docs) claims a file on purpose.

export type LayerKind = "light" | "app" | "sim";

export interface Layer {
  id: string;
  title: string;
  /** Command and args, run from the repo root. */
  cmd: string[];
  /** light: runs alongside other light layers. app: the Electron checks, one at a time. sim: needs a simulator. */
  kind: LayerKind;
}

export interface PlannedLayer extends Layer {
  /** The changed files (or the flag) that put this layer in the plan. */
  reasons: string[];
}

const BUN = "bun";

const bunAll: Layer = { id: "bun:all", title: "bun tests (every package)", cmd: [BUN, "run", "test"], kind: "light" };
const bunIn = (dir: string): Layer => ({ id: `bun:${dir}`, title: `bun tests (${dir})`, cmd: [BUN, "run", "--cwd", dir, "test"], kind: "light" });
const typecheck: Layer = { id: "typecheck", title: "typecheck (tsc, all projects)", cmd: [BUN, "run", "typecheck"], kind: "light" };
/** The new in-process suite (next/): its guarded tier and its contract tier against real git. */
const nextSuite: Layer = { id: "next", title: "new suite (next/: guarded tier and contract tier)", cmd: [BUN, "run", "test:next"], kind: "light" };
const swiftTest: Layer = { id: "swift-test", title: "swift test (HarnessKit)", cmd: ["swift", "test", "--package-path", "ios/HarnessKit"], kind: "light" };
const snapshots: Layer = { id: "snapshots", title: "iOS snapshot tests (iPhone, iPad)", cmd: [BUN, "run", "sim", "snapshots"], kind: "sim" };
/** The iPhone walkthrough (next/walkthrough/ios.ts), all screens or just the named ones; `bun run walk:ios` takes the simulator lock itself. */
export const walkIos = (screens: string[] = []): Layer => ({
  id: screens.length ? `walk:ios ${screens.join(",")}` : "walk:ios",
  title: screens.length ? `iPhone walkthrough: ${screens.join(", ")}` : "iPhone walkthrough (all screens)",
  cmd: [BUN, "run", "walk:ios", ...(screens.length ? [`--only=${screens.join(",")}`] : [])],
  kind: "sim",
});
const appBuild: Layer = { id: "app-build", title: "build the Mac app renderer", cmd: [BUN, "run", "--cwd", "app", "build"], kind: "app" };
/** An app/scripts/<name>.ts check against the built renderer. */
export const appCheck = (name: string): Layer => ({ id: `app-check:${name}`, title: `app check: ${name}`, cmd: [BUN, `app/scripts/${name}.ts`], kind: "app" });

/** The whole iPhone walkthrough. */
export const walkThrough = walkIos();

/** Every renderer file (by regex) to the closest app/scripts check. */
export const RENDERER_CHECKS: [RegExp, string][] = [
  [/components\/TicketSettings\.tsx$/, "ticket-settings-check"],
  [/components\/ContextGauge\.tsx$|state\/contextGauge/, "context-gauge-check"],
  [/views\/ActivityTab\.tsx$|state\/activity\.|components\/Markdown\.tsx$/, "spec-activity"],
  [/components\/Markdown\.tsx$|views\/SpecTab\.tsx$/, "spec-headings-check"],
  [/views\/TicketDetails\.tsx$/, "agent-notes-check"],
  [/views\/TerminalPane\.tsx$/, "terminal-pane-check"],
  [/views\/Board\.tsx$|components\/PaneWorkspace\.tsx$|state\/panes/, "cmd-click-check"],
  [/views\/BrowserView\.tsx$|state\/browser/, "browser-size-check"],
  [/components\/Annotat|annotationDraw/, "annotate-check"],
  [/views\/Transcript\.tsx$|components\/Attachments\.tsx$/, "composer-attachments-check"],
  [/components\/(Prompt)?Attachments\.tsx$|usePromptAttachmentInput|views\/DraftEditor\.tsx$/, "attachments-check"],
  [/views\/File(Pane|Viewer)\.tsx$/, "file-pane-check"],
  [/views\/CommandPalette\.tsx$/, "palette-files-check"],
  [/components\/(PaneWorkspace|ResizeHandle)\.tsx$|paneDrag|paneFocus/, "pane-resize-check"],
  [/components\/(PopoutWindow\.tsx|popoutOpen)/, "popout-check"],
  [/components\/TornOff\.tsx$/, "tear-off-check"],
  [/components\/GroupSelect\.tsx$|views\/Sidebar\.tsx$|state\/groups?/, "groups-check"],
  [/views\/Board\.tsx$|state\/boardNav/, "card-menu-check"],
  [/views\/PlanUsage\.tsx$/, "plan-usage-check"],
  [/views\/DraftEditor\.tsx$/, "new-session-focus-check"],
  [/components\/MentionTextarea\.tsx$|components\/commands\.tsx$/, "slash-commands-check"],
  [/views\/(Settings|ProjectSettings)\.tsx$/, "smoke"],
];

/** The check for a renderer file nothing above names: the whole-app smoke test. */
export const RENDERER_FALLBACK = "smoke";

/** Feature folders of the iPhone app to the walkthrough screens that drive them. Anything else under ios/Harness gets snapshots only. */
export const IOS_FEATURE_SCREENS: [RegExp, string[]][] = [
  [/^ios\/Harness\/(App\/(TicketSheetHost|DockedTickets|DockHold|TicketSidePanel)|Features\/Ticket\/TearOff)/, ["ticket sheet", "sheet dock drag", "dock stack", "docked ticket restores"]],
  [/^ios\/Harness\/Features\/Files\//, ["file link", "file editor save", "file relink"]],
  [/^ios\/Harness\/Features\/Prompts\//, ["prompt editor", "prompt variable chip"]],
  [/^ios\/Harness\/Features\/NewSession\//, ["mentions and commands", "new session prompt focus"]],
  [/^ios\/Harness\/Features\/Pickers\/ModelPicker/, ["models picker"]],
  [/^ios\/Harness\/Features\/Ticket\/TicketContextGauge/, ["context gauge", "context gauge limit", "context gauge states"]],
  [/^ios\/Harness\/Features\/Ticket\/TicketDetailApprovalCard/, ["approve and…"]],
  [/^ios\/Harness\/Features\/Ticket\/TicketDetailComposer/, ["blocked composer", "composer draft"]],
  [/^ios\/Harness\/Features\/Ticket\/AgentsTabView/, ["agents & tasks filter"]],
  [/^ios\/Harness\/Features\/Content\/(Attachment|PromptAttachment)/, ["attachments"]],
];

interface Rule {
  name: string;
  match: RegExp;
  /** Layers for a file this rule matches; may depend on the path. */
  layers: (file: string) => Layer[];
}

const none = () => [] as Layer[];
const isTest = (f: string) => /\.test\.tsx?$/.test(f);

/** Renderer files: tests and typecheck, plus the app checks that drive the component (smoke when none does). */
function rendererLayers(file: string): Layer[] {
  const base = [bunIn("app"), typecheck];
  if (isTest(file) || /\.css$/.test(file)) return base;
  const checks = RENDERER_CHECKS.filter(([re]) => re.test(file)).map(([, name]) => name);
  return [...base, appBuild, ...(checks.length ? checks : [RENDERER_FALLBACK]).map(appCheck)];
}

export const RULES: Rule[] = [
  { name: "docs", match: /\.md$/, layers: none },
  { name: "shared package", match: /^shared\//, layers: () => [bunAll, typecheck] },
  { name: "repo-wide config and scripts", match: /^(package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|scripts\/)/, layers: () => [bunAll, typecheck] },
  { name: "new suite", match: /^next\//, layers: () => [nextSuite, typecheck] },
  // The services the new suite runs in process, and the git adapter its contract tier checks against real git.
  { name: "service code the new suite drives", match: /^service\/src\/(orchestrator|browser|testing)\//, layers: () => [nextSuite, bunIn("service"), typecheck] },
  { name: "service", match: /^service\//, layers: () => [bunIn("service"), typecheck] },
  // The editor is the Mac file pane and the iPhone's web page, and its tests can't draw a file (that needs a
  // real layout engine), so both apps' file checks run too.
  {
    name: "editor (the Mac file pane and the iPhone's web page)",
    match: /^editor\//,
    layers: (f) => (isTest(f) ? [bunIn("editor"), typecheck] : [bunIn("editor"), bunIn("app"), typecheck, appBuild, appCheck("file-pane-check"), walkIos(["file link", "file editor save", "file relink"])]),
  },
  { name: "plugin sdk (every plugin builds on it)", match: /^plugins\/sdk\//, layers: () => [bunAll, typecheck] },
  { name: "plugin", match: /^plugins\/[^/]+\//, layers: (f) => [bunIn(f.split("/").slice(0, 2).join("/")), typecheck] },
  { name: "release scripts", match: /^release\//, layers: () => [bunIn("release"), typecheck] },
  { name: "app renderer", match: /^app\/src\/renderer\//, layers: rendererLayers },
  { name: "app main/preload/shared", match: /^app\/src\/(?!renderer\/)/, layers: (f) => [bunIn("app"), typecheck, ...(isTest(f) ? [] : [appBuild, appCheck("smoke")])] },
  {
    name: "app check script",
    match: /^app\/scripts\/[^/]+-check\.ts$|^app\/scripts\/(smoke|spec-activity|changes|shoot|ticket-header|browser-tabs)\.ts$/,
    layers: (f) => [bunIn("app"), typecheck, appBuild, appCheck(f.replace(/^app\/scripts\/|\.ts$/g, ""))],
  },
  { name: "app build and packaging scripts", match: /^app\/(scripts|package\.json|vite|tsconfig)/, layers: () => [bunIn("app"), typecheck] },
  { name: "HarnessKit tests", match: /^ios\/HarnessKit\/Tests\//, layers: () => [swiftTest] },
  // HarnessKit is linked into the app, so a source change can break the app build the snapshot layer makes.
  { name: "HarnessKit (linked into the app)", match: /^ios\/HarnessKit\/(?!Tests\/)/, layers: () => [swiftTest, snapshots] },
  { name: "ios build tooling (a real build)", match: /^ios\/Tools\/(build|build-cache|snapshots)\.ts$/, layers: () => [bunIn("ios"), typecheck, snapshots] },
  { name: "ios tooling", match: /^ios\/Tools\//, layers: () => [bunIn("ios"), typecheck] },
  { name: "snapshot tests and references", match: /^ios\/HarnessSnapshotTests\//, layers: () => [snapshots] },
  { name: "iPhone app project", match: /^ios\/(project\.yml|Harness\/Resources\/)/, layers: () => [snapshots, walkThrough] },
  {
    name: "iPhone app screens",
    match: /^ios\/(Harness|Widgets)\//,
    layers: (f) => [snapshots, ...IOS_FEATURE_SCREENS.filter(([re]) => re.test(f)).map(([, screens]) => walkIos(screens))],
  },
  { name: "ios package config", match: /^ios\/(package\.json|tsconfig[^/]*\.json)$/, layers: () => [bunIn("ios"), typecheck] },
];

/** The layers `--all` runs: every package's tests, the typecheck, swift test, every simulator and Mac app check. */
export function allLayers(appChecks: string[]): PlannedLayer[] {
  const layers = [bunAll, typecheck, nextSuite, swiftTest, appBuild, ...appChecks.map(appCheck), snapshots, walkThrough];
  return layers.map((l) => ({ ...l, reasons: ["--all"] }));
}

/**
 * Test files live in the old suite's directories until the new suite replaces them; a new one added there would
 * make the migration grow instead of shrink. HarnessKit's swift tests stay (they need no simulator), and the
 * repo's own tooling tests (scripts/) aren't part of what the new suite replaces.
 */
const OLD_SUITE_TEST = /^(service|shared|app|editor|plugins|release|ios\/Tools|ios\/HarnessSnapshotTests)\/.*(\.test\.tsx?|Tests?\.swift|-check\.ts)$/;
export const newTestsInOldDirs = (added: string[]): string[] => added.filter((f) => OLD_SUITE_TEST.test(f));

export const FALLBACK_REASON = "no rule for the file, so the default (bun tests + typecheck)";

export interface Plan {
  layers: PlannedLayer[];
  /** Files no rule claims. */
  unmatched: string[];
  /** Why the plan is empty or what rules ignored; for the printout. */
  notes: string[];
}

/** The layers the changed `files` (repo-relative, forward slashes) need, in run order, each with its reasons. */
export function planLayers(files: string[]): Plan {
  const byId = new Map<string, PlannedLayer>();
  const unmatched: string[] = [];
  const add = (layer: Layer, reason: string) => {
    const planned = byId.get(layer.id) ?? { ...layer, reasons: [] };
    if (!planned.reasons.includes(reason)) planned.reasons.push(reason);
    byId.set(layer.id, planned);
  };
  for (const file of files) {
    const rules = RULES.filter((r) => r.match.test(file));
    if (!rules.length) {
      unmatched.push(file);
      continue;
    }
    for (const rule of rules) for (const layer of rule.layers(file)) add(layer, file);
  }
  if (unmatched.length || !files.length) {
    for (const layer of [bunAll, typecheck]) add(layer, files.length ? `${unmatched.join(", ")}: ${FALLBACK_REASON}` : "no changes found, so the default (bun tests + typecheck)");
  }
  // Everything bun:all runs makes a scoped bun layer redundant.
  if (byId.has("bun:all")) {
    const all = byId.get("bun:all")!;
    for (const id of [...byId.keys()]) {
      if (!id.startsWith("bun:") || id === "bun:all") continue;
      for (const r of byId.get(id)!.reasons) if (!all.reasons.includes(r)) all.reasons.push(r);
      byId.delete(id);
    }
  }
  const order: Record<LayerKind, number> = { light: 0, app: 1, sim: 2 };
  const within = (l: Layer) => (l.id === "app-build" || l.id === "bun:all" ? 0 : l.id.startsWith("bun:") ? 1 : l.id === "typecheck" ? 2 : 3);
  const rank = (l: Layer) => order[l.kind] * 10 + within(l);
  const layers = [...byId.values()].sort((a, b) => rank(a) - rank(b));
  const notes = files.length && !layers.length ? ["only docs changed: nothing to run"] : [];
  return { layers, unmatched, notes };
}
