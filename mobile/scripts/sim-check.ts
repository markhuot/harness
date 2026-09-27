// Simulator walk-through against a REAL daemon on a throwaway HARNESS_HOME:
//   1. boots service/src/daemon.ts (temp home, random port, dummy driver, HARNESS_DUMMY_DELAY_MS=40)
//   2. seeds a project with a hello-world ticket, a conductor with children, a /browse ticket,
//      an approval, a blocked question, a plan-first ticket and a git-worktree ticket with changes
//   3. builds the Release app for the simulator (skip with --no-build), installs and launches it
//   4. pairs via `simctl openurl harness://pair?…`, deep-links to every screen and saves
//      screenshots in light and dark to mobile/build/screens/
//
//   5. --themes=catppuccin-mocha,rose-pine-dawn: per theme, applies it with the settings deep link
//      (harness://settings?darkTheme=…) and saves board-<id>.png + settings-<id>.png
//
//   6. --paging: only the paging checks: seeds 125+ done tickets (one old "haystack" ticket deep in
//      the history), a conductor with done children and a ticket depending on the old one; checks
//      child tickets are hidden by default, the Done count is the server total, the Done column
//      scrolls into older pages, and search finds the unloaded done ticket; paging-*.png in light
//      and dark
//
//   DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer bun scripts/sim-check.ts [--no-build] [--udid=…] [--keep] [--only=name,name] [--themes=id,id] [--paging]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPairUrl, type Project, type Ticket, type TicketDetail, type TicketPage } from "@harness/shared";
import { findTheme } from "@harness/shared/themes";

const here = resolve(import.meta.dir, "..");
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DEVELOPER_DIR = process.env.DEVELOPER_DIR ?? "/Applications/Xcode-27.0.0.app/Contents/Developer";
const env = { ...process.env, DEVELOPER_DIR };
const shots = join(here, "build", "screens");
const appPath = join(here, "build", "dd", "Build", "Products", "Release-iphonesimulator", "Harness.app");
const only = opt("only")?.split(",");
const themeShots = opt("themes")?.split(",").filter(Boolean) ?? [];
const pagingOnly = flag("paging");
for (const id of themeShots) if (!findTheme(id)) throw new Error(`--themes: unknown theme ${id}`);

async function sh(cmd: string[], opts: { cwd?: string; quiet?: boolean; allowFail?: boolean } = {}) {
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? here, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd.join(" ")} → ${code}\n${err || out}`);
  return out.trim();
}
const simctl = (...a: string[]) => sh(["xcrun", "simctl", ...a], { allowFail: false });

// AXe (brew install cameroncooke/axe/axe) drives taps. It looks for SimulatorKit under
// Developer/Library/PrivateFrameworks, which Xcode 27 moved to Contents/SharedFrameworks, so give
// it a symlinked Xcode bundle with the framework where it expects it.
function xcodeShim(): string {
  const real = resolve(DEVELOPER_DIR, "..");
  const contents = join(here, "build", "xcode-shim", "Xcode.app", "Contents");
  const dev = join(contents, "Developer");
  if (existsSync(join(dev, "Library", "PrivateFrameworks", "SimulatorKit.framework"))) return dev;
  rmSync(join(here, "build", "xcode-shim"), { recursive: true, force: true });
  mkdirSync(join(dev, "Library", "PrivateFrameworks"), { recursive: true });
  const link = (from: string, to: string) => Bun.spawnSync(["ln", "-s", from, to]);
  for (const e of readdirSync(real)) if (e !== "Developer") link(join(real, e), join(contents, e));
  for (const e of readdirSync(DEVELOPER_DIR)) if (e !== "Library") link(join(DEVELOPER_DIR, e), join(dev, e));
  for (const e of readdirSync(join(DEVELOPER_DIR, "Library"))) if (e !== "PrivateFrameworks") link(join(DEVELOPER_DIR, "Library", e), join(dev, "Library", e));
  const priv = join(DEVELOPER_DIR, "Library", "PrivateFrameworks");
  if (existsSync(priv)) for (const e of readdirSync(priv)) link(join(priv, e), join(dev, "Library", "PrivateFrameworks", e));
  link(join(real, "SharedFrameworks", "SimulatorKit.framework"), join(dev, "Library", "PrivateFrameworks", "SimulatorKit.framework"));
  return dev;
}
const hasAxe = Bun.spawnSync(["which", "axe"]).exitCode === 0;
let shim = "";
async function axe(...a: string[]) {
  if (!hasAxe) return "";
  shim ||= xcodeShim();
  const p = Bun.spawn(["axe", ...a], { env: { ...env, DEVELOPER_DIR: shim }, stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return out;
}
async function labels(udid: string): Promise<string[]> {
  return [...(await axe("describe-ui", "--udid", udid)).matchAll(/"AXLabel" : "([^"]*)"/g)].map((m) => m[1]!);
}
async function tapLabel(udid: string, label: string) {
  await axe("tap", "--label", label, "--udid", udid);
}
interface AXNode {
  AXLabel: string | null;
  frame: { x: number; y: number; width: number; height: number };
  children?: AXNode[];
}
async function findElement(udid: string, match: (label: string) => boolean): Promise<AXNode | null> {
  const walk = (n: AXNode): AXNode | null => (n.AXLabel && match(n.AXLabel) ? n : (n.children ?? []).map(walk).find(Boolean) ?? null);
  try {
    const out = await axe("describe-ui", "--udid", udid);
    return (JSON.parse(out.slice(out.indexOf("["))) as AXNode[]).map(walk).find(Boolean) ?? null;
  } catch {
    return null;
  }
}
async function tapWhere(udid: string, label: string | ((l: string) => boolean), opts: { longPress?: number; timeout?: number } = {}) {
  const match = typeof label === "string" ? (l: string) => l === label : label;
  const el = await until(`element ${label}`, () => findElement(udid, match), opts.timeout ?? 8000).catch(async (e) => {
    throw new Error(`${(e as Error).message}; on screen: ${(await labels(udid)).slice(0, 12).join(" | ")}`);
  });
  const x = String(Math.round(el.frame.x + el.frame.width / 2));
  const y = String(Math.round(el.frame.y + el.frame.height / 2));
  if (opts.longPress) await axe("touch", "-x", x, "-y", y, "--down", "--up", "--delay", String(opts.longPress), "--udid", udid);
  else await axe("tap", "-x", x, "-y", y, "--udid", udid);
}

/** simctl openurl, then accept iOS's "Open in “Harness”?" confirmation. */
async function openUrl(udid: string, url: string) {
  await simctl("openurl", udid, url);
  if (!hasAxe) return;
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(250);
    const l = await labels(udid);
    if (l.some((x) => x.startsWith("Open in"))) {
      await tapLabel(udid, "Open");
      return;
    }
  }
}
async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(250);
  }
  throw new Error(`timed out: ${label}${last ? ` (${(last as Error).message})` : ""}`);
}
async function git(cwd: string, ...a: string[]) {
  await sh(["git", "-c", "user.name=Harness Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...a], { cwd });
}

// ---------------------------------------------------------------- simulator
async function pickDevice(): Promise<string> {
  if (opt("udid")) return opt("udid")!;
  const list = JSON.parse(await simctl("list", "devices", "available", "--json")) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
  const all = Object.values(list.devices).flat();
  const d = all.find((x) => x.name === "iPhone 18 Pro") ?? all.find((x) => /^iPhone/.test(x.name));
  if (!d) throw new Error("no iPhone simulator available");
  if (d.state !== "Booted") {
    await simctl("boot", d.udid);
    await sh(["xcrun", "simctl", "bootstatus", d.udid, "-b"]);
  }
  return d.udid;
}

// ---------------------------------------------------------------- daemon
const home = mkdtempSync(join(tmpdir(), "harness-sim-home-"));
const scratch = mkdtempSync(join(tmpdir(), "harness-sim-projects-"));
const port = 7830 + Math.floor(Math.random() * 60);
const base = `http://127.0.0.1:${port}`;
console.log(`daemon: ${base} (HARNESS_HOME=${home})`);
const daemon = Bun.spawn(["bun", join(repoRoot, "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DELAY_MS: "40" },
  stdout: Bun.file(join(home, "daemon.out")),
  stderr: Bun.file(join(home, "daemon.err")),
});

let token = "";
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? ""}`);
  return json.data as T;
}
const ticketOf = async (key: string) => (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket;
const settle = (key: string, pred: (t: Ticket) => boolean, ms = 60000) => until(`${key} settles`, async () => ((t) => (pred(t) ? t : null))(await ticketOf(key)), ms);

async function seed() {
  await api("PATCH", "/settings", { defaultDriver: "dummy", classifier: "off" });
  // A git repo so tickets get worktrees and the git plugin's Changes tab.
  const repo = join(scratch, "greeter");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Greeter\n\nSays hello.\n");
  writeFileSync(join(repo, "src/app.ts"), 'export function main(name = "world") {\n  console.log("Hello, " + name);\n}\n');
  writeFileSync(join(repo, "config.json"), '{\n  "verbose": false\n}\n');
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "Initial commit");
  const project = await api<Project>("POST", "/projects", { path: repo, name: "greeter", key: "GREET", useWorktrees: true, defaultDriver: "dummy" });
  const other = await api<Project>("POST", "/projects", { path: join(scratch, "harness-site"), name: "harness-site", key: "SITE", defaultDriver: "dummy" }).catch(async () => {
    mkdirSync(join(scratch, "harness-site"), { recursive: true });
    return api<Project>("POST", "/projects", { path: join(scratch, "harness-site"), name: "harness-site", key: "SITE", defaultDriver: "dummy" });
  });
  const create = (projectId: string, prompt: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId, prompt, driver: "dummy", start: true, ...extra });

  const hello = await create(project.id, "hello world");
  const changes = await create(project.id, "Add a greet helper with an excited mode");
  const conductor = await create(project.id, "Ship the greeter v2\n- Add a greet helper\n- Wire it into main\n- Update the README", { kind: "conductor" });
  const browse = await create(other.id, "/browse https://example.com");
  const approval = await create(other.id, 'Install the dependencies\n/approve Bash {"command":"npm install","description":"Install dependencies"}');
  const blocked = await create(other.id, "Sign the build\n/block Which Apple Developer team should sign the build: Happy Cog or your personal account?");
  const plan = await create(other.id, "Write a landing page for the install link", { start: false });

  await settle(hello.key, (t) => t.status === "review" && !t.busy && t.agentReview === "approved");
  const ch = await settle(changes.key, (t) => t.status === "review" && !t.busy && !!t.workdir);
  // Edit the worktree the way an agent would: a commit on the branch plus uncommitted changes.
  const wd = ch.workdir!;
  mkdirSync(join(wd, "src/lib"), { recursive: true });
  writeFileSync(join(wd, "src/lib/greet.ts"), 'export function greet(name: string, excited = false) {\n  const base = "Hello, " + name;\n  return excited ? base + "!" : base;\n}\n');
  await git(wd, "add", "-A");
  await git(wd, "commit", "-qm", "Add greet helper");
  writeFileSync(join(wd, "src/app.ts"), 'import { greet } from "./lib/greet";\n\nexport function main(name = "world") {\n  console.log(greet(name, true));\n}\n');
  writeFileSync(join(wd, "config.json"), '{\n  "verbose": true\n}\n');
  writeFileSync(join(wd, "CHANGELOG.md"), "# Changelog\n\n- Greet with an exclamation mark\n");
  await settle(approval.key, (t) => !!t.pendingApproval);
  await settle(blocked.key, (t) => t.status === "blocked" && !t.busy);
  await settle(plan.key, (t) => t.status === "planning" && !t.busy);
  await settle(browse.key, (t) => !t.busy, 90000);
  await until("conductor children", async () => (await api<TicketDetail>("GET", `/tickets/${conductor.key}`)).children.length >= 3, 60000);
  // A watcher-less triage item for the Inbox.
  await api("POST", "/mappings", { pattern: "FOO", projectId: project.id, notes: "Jira FOO board" });
  await api("POST", "/watchers/inject", { source: "jira", item: { key: "FOO-123", summary: "Greeter crashes on an empty name", url: "https://example.com/FOO-123", updated: "1" } });
  await Bun.sleep(1500);
  return { project, other, hello, changes, conductor, browse, approval, blocked, plan };
}

/** --paging: a long Done history on its own project, a conductor with done children, and a dependency on an old done ticket. */
async function seedPaging() {
  mkdirSync(join(scratch, "archive"), { recursive: true });
  const project = await api<Project>("POST", "/projects", { path: join(scratch, "archive"), name: "archive", key: "ARCH", defaultDriver: "dummy" });
  const create = (prompt: string, extra: Record<string, unknown> = {}) => api<Ticket>("POST", "/tickets", { projectId: project.id, prompt, driver: "dummy", start: false, ...extra });
  const finish = (t: Ticket) => api<Ticket>("PATCH", `/tickets/${t.key}`, { status: "done" });
  // Oldest first: the haystack ticket finishes before everything else, so it sits pages deep.
  const needle = await create("Needle in the haystack: rotate the signing certificate");
  await finish(needle);
  const history: Ticket[] = [];
  for (let i = 1; i <= 125; i += 8) {
    const batch = await Promise.all(Array.from({ length: Math.min(8, 126 - i) }, (_, j) => create(`Archived chore ${String(i + j).padStart(3, "0")}`)));
    for (const t of batch) {
      await finish(t);
      history.push(t);
    }
  }
  const conductor = await create("Release train: ship 2.0", { kind: "conductor" });
  const kids: Ticket[] = [];
  for (const title of ["Cut the release branch", "Write the changelog", "Tag the build", "Announce the release"]) kids.push(await create(title, { parentId: conductor.id }));
  // The newest completions are children: if they weren't hidden they'd top the Done column.
  for (const k of kids.slice(0, 3)) await finish(k);
  const dependent = await create("Renew the provisioning profile", { dependsOn: [needle.key] });
  return { project, needle, history, conductor, kids, dependent };
}

/** --paging: real taps against the seeded Done history. Returns false when a check failed. */
async function pagingChecks(udid: string, p: Awaited<ReturnType<typeof seedPaging>>): Promise<boolean> {
  const results: [string, boolean, string][] = [];
  const check = async (name: string, fn: () => Promise<string | boolean>) => {
    try {
      const r = await fn();
      results.push([name, r !== false, typeof r === "string" ? r : ""]);
    } catch (e) {
      results.push([name, false, (e as Error).message.split("\n")[0]!]);
    }
  };
  const fresh = async (url = "") => {
    await simctl("terminate", udid, "com.markhuot.harness").catch(() => {});
    await sh(["xcrun", "simctl", "launch", udid, "com.markhuot.harness"], { allowFail: true });
    await Bun.sleep(2000);
    if (url) await openUrl(udid, url);
    else await until("board loaded", async () => (await labels(udid)).some((l) => /^ARCH-\d+ /.test(l)), 20000);
    await Bun.sleep(url ? 1500 : 800);
  };
  const has = async (prefix: string) => (await labels(udid)).some((l) => l.startsWith(prefix));
  const shot = async (name: string, theme: string) => {
    const file = join(shots, `paging-${name}-${theme}.png`);
    await simctl("io", udid, "screenshot", file);
    console.log(`  ${file}`);
  };
  const swipeUp = () => axe("swipe", "--start-x", "200", "--start-y", "720", "--end-x", "200", "--end-y", "220", "--duration", "0.25", "--udid", udid);
  // The strip scrolls to follow the page, so a tap can land on a neighbour: tap until a Done card is on screen.
  const openDone = async () => {
    const top = p.history.at(-1)!.key;
    for (let i = 0; i < 4; i++) {
      await tapWhere(udid, (l) => l.startsWith("Done,"));
      await Bun.sleep(1200);
      const card = await findElement(udid, (l) => l.startsWith(`${top} `));
      if (card && card.frame.x >= 0 && card.frame.x < 440) return;
    }
    throw new Error("couldn't open the Done column");
  };
  // The native search field lives in the header, which AXe doesn't descend into: tap where it sits.
  const tapSearch = async () => {
    await axe("tap", "-x", "200", "-y", "139", "--udid", udid);
    await Bun.sleep(700);
  };
  const total = (await api<TicketPage>("GET", "/tickets/page?status=done&limit=1")).total;
  const k = (t: Ticket) => encodeURIComponent(t.key);
  const deep = p.history[10]!; // ~118th newest: two pages down

  await check("child tickets are hidden by default (Done's newest completions are children)", async () => {
    await fresh();
    await openDone();
    const newest = p.history.at(-1)!;
    await until(`${newest.key} on the board`, () => has(`${newest.key} `), 8000);
    const leaked = p.kids.slice(0, 3);
    const shown = (await labels(udid)).filter((l) => leaked.some((kid) => l.startsWith(`${kid.key} `)));
    if (shown.length) throw new Error(`children visible: ${shown.join(" | ")}`);
    return `newest non-child ${newest.key} on top`;
  });
  await check("Show child tickets (header menu) shows them; toggling back hides them", async () => {
    await axe("tap", "-x", "342", "-y", "84", "--udid", udid); // Board options (…), in the header
    await Bun.sleep(900);
    await tapWhere(udid, "Show child tickets");
    await until("children visible", () => has(`${p.kids[2]!.key} `), 6000);
    await axe("tap", "-x", "342", "-y", "84", "--udid", udid); // Board options (…), in the header
    await Bun.sleep(900);
    await tapWhere(udid, "Show child tickets");
    await until("children hidden", async () => !(await has(`${p.kids[2]!.key} `)), 6000);
    return true;
  });
  await check("the Done count is the server's total", async () => {
    await until(`Done, ${total}`, () => has(`Done, ${total}`), 6000);
    return `Done, ${total}`;
  });
  await check("the Done column scrolls into older pages", async () => {
    for (let i = 0; i < 45; i++) {
      if (await has(`${deep.key} `)) return `${deep.key} after ${i} swipes`;
      await swipeUp();
      await Bun.sleep(350);
    }
    throw new Error(`${deep.key} never appeared`);
  });
  await simctl("io", udid, "screenshot", join(shots, "paging-done-scrolled-light.png"));
  await check("search finds a done ticket that isn't loaded", async () => {
    await fresh();
    await tapSearch();
    await axe("type", "haystack", "--udid", udid);
    await until(`${p.needle.key} in the results`, () => has(`${p.needle.key} `), 10000);
    return p.needle.key;
  });
  await check("a dependency on an unloaded done ticket resolves", async () => {
    await fresh(`harness://ticket/${k(p.dependent)}?tab=summaries`);
    await until("dependency chip", () => has(p.needle.key), 8000);
    return true;
  });
  await check("the conductor's Tickets tab lists its done children", async () => {
    await fresh(`harness://ticket/${k(p.conductor)}?tab=children`);
    await until("done children", async () => (await Promise.all(p.kids.slice(0, 3).map((kid) => has(kid.key)))).every(Boolean), 8000);
    return true;
  });

  for (const [name, ok, detail] of results) console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  for (const theme of ["light", "dark"] as const) {
    await simctl("ui", udid, "appearance", theme);
    await fresh();
    await shot("board", theme);
    await openDone();
    await shot("done", theme);
    await tapSearch();
    await axe("type", "haystack", "--udid", udid);
    await until("results", () => has(`${p.needle.key} `), 10000).catch(() => {});
    await Bun.sleep(600);
    await shot("search", theme);
    await fresh(`harness://ticket/${k(p.conductor)}?tab=children`);
    await Bun.sleep(1200);
    await shot("conductor", theme);
    await fresh(`harness://ticket/${k(p.dependent)}?tab=summaries`);
    await Bun.sleep(1200);
    await shot("dependency", theme);
  }
  await simctl("ui", udid, "appearance", "light");
  return results.every((r) => r[1]);
}

// ---------------------------------------------------------------- main
let failed: boolean = false;
try {
  await until("daemon healthy", async () => (await fetch(`${base}/health`)).ok, 20000);
  token = readFileSync(join(home, "token"), "utf8").trim();
  const [udid, seeded, paged] = await Promise.all([pickDevice(), pagingOnly ? null : seed(), pagingOnly ? seedPaging() : null]);
  if (seeded) console.log(`simulator ${udid}; seeded ${[seeded.hello, seeded.changes, seeded.conductor, seeded.browse, seeded.approval, seeded.blocked, seeded.plan].map((t) => t.key).join(", ")}`);
  if (paged) console.log(`simulator ${udid}; seeded ${paged.history.length + 4} done tickets in ${paged.project.key}, needle ${paged.needle.key}, conductor ${paged.conductor.key}`);

  if (!flag("no-build") || !existsSync(appPath)) {
    console.log("building Release (simulator)…");
    await sh(["xcodebuild", "-workspace", "ios/Harness.xcworkspace", "-scheme", "Harness", "-configuration", "Release", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "-derivedDataPath", "build/dd", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=NO", "build"]);
  }
  await simctl("terminate", udid, "com.markhuot.harness").catch(() => {});
  // Start clean: no saved servers or tokens from earlier runs.
  await sh(["xcrun", "simctl", "uninstall", udid, "com.markhuot.harness"], { allowFail: true });
  await sh(["xcrun", "simctl", "keychain", udid, "reset"], { allowFail: true });
  await simctl("install", udid, appPath);
  await simctl("ui", udid, "appearance", "light");
  if ((await labels(udid)).some((x) => x.startsWith("Open in"))) await tapLabel(udid, "Cancel");
  await until("app launches", async () => (await sh(["xcrun", "simctl", "launch", udid, "com.markhuot.harness"], { allowFail: true }), true) && (await sh(["xcrun", "simctl", "spawn", udid, "launchctl", "list"], { allowFail: true })).includes("com.markhuot.harness"), 30000);
  await Bun.sleep(2500);
  await openUrl(udid, buildPairUrl(base, token));
  await Bun.sleep(4000);

  mkdirSync(shots, { recursive: true });
  if (paged) failed = !(await pagingChecks(udid, paged));
  if (seeded) {
    const k = (t: Ticket) => encodeURIComponent(t.key);
    const screens: [string, string, number?][] = [
      ["board", "harness://board"],
      ["projects", "harness://projects"],
      ["ticket-summaries", `harness://ticket/${k(seeded.hello)}?tab=summaries`],
      ["ticket-transcript", `harness://ticket/${k(seeded.hello)}?tab=transcript`],
      ["ticket-details", `harness://ticket/${k(seeded.hello)}?tab=details`],
      ["conductor-tickets", `harness://ticket/${k(seeded.conductor)}?tab=children`],
      ["approval", `harness://ticket/${k(seeded.approval)}`],
      ["blocked", `harness://ticket/${k(seeded.blocked)}`],
      ["planning", `harness://ticket/${k(seeded.plan)}`],
      ["browser", `harness://ticket/${k(seeded.browse)}?tab=browser`, 6000],
      ["changes", `harness://ticket/${k(seeded.changes)}?tab=plugin:git:changes`, 7000],
      ["new-session", "harness://new"],
      ["inbox", "harness://inbox"],
      ["settings", "harness://settings"],
      ["project-settings", `harness://project/${seeded.project.id}`],
      ["connect", "harness://connect"],
    ];
    const relaunch = async () => {
      await simctl("terminate", udid, "com.markhuot.harness").catch(() => {});
      await sh(["xcrun", "simctl", "launch", udid, "com.markhuot.harness"], { allowFail: true });
      await Bun.sleep(2000);
    };
    for (const id of themeShots) {
      const theme = findTheme(id)!;
      await simctl("ui", udid, "appearance", theme.appearance);
      await relaunch();
      await openUrl(udid, `harness://settings?${theme.appearance}Theme=${id}`);
      await Bun.sleep(2200);
      // Scroll down to the Appearance pickers.
      await axe("swipe", "--start-x", "200", "--start-y", "780", "--end-x", "200", "--end-y", "260", "--duration", "2", "--udid", udid);
      await Bun.sleep(1200);
      await simctl("io", udid, "screenshot", join(shots, `settings-${id}.png`));
      await relaunch();
      // The board needs the connection and the first ticket list, not just the first frame.
      await until("board loaded", async () => (await labels(udid)).some((l) => /^[A-Z]+-\d+ /.test(l)), 20000).catch(() => {});
      await Bun.sleep(1500);
      const file = join(shots, `board-${id}.png`);
      await simctl("io", udid, "screenshot", file);
      console.log(`  ${file}`);
    }
    if (themeShots.length) {
      // Back to the defaults for the light/dark pass.
      await relaunch();
      await openUrl(udid, "harness://settings?lightTheme=harness-light&darkTheme=harness-dark");
      await Bun.sleep(1500);
    }
    for (const theme of flag("interactions-only") ? [] : (["light", "dark"] as const)) {
      await simctl("ui", udid, "appearance", theme);
      for (const [name, url, wait] of screens) {
        if (only && !only.includes(name)) continue;
        // A fresh launch per screen, so a modal from the previous one never frames the next.
        await simctl("terminate", udid, "com.markhuot.harness").catch(() => {});
        await sh(["xcrun", "simctl", "launch", udid, "com.markhuot.harness"], { allowFail: true });
        await Bun.sleep(2000);
        if (url !== "harness://board") await openUrl(udid, url);
        await Bun.sleep(wait ?? 2200);
        const file = join(shots, `${name}-${theme}.png`);
        await simctl("io", udid, "screenshot", file);
        console.log(`  ${file}`);
      }
    }
    await simctl("ui", udid, "appearance", "light");

    // ---------------------------------------------------------------- interactions (real taps)
    if (hasAxe && !only) {
      const results: [string, boolean, string][] = [];
      const check = async (name: string, fn: () => Promise<string | boolean>) => {
        try {
          const r = await fn();
          results.push([name, r !== false, typeof r === "string" ? r : ""]);
        } catch (e) {
          results.push([name, false, (e as Error).message.split("\n")[0]!]);
        }
      };
      const fresh = async (url: string) => {
        await simctl("terminate", udid, "com.markhuot.harness").catch(() => {});
        await sh(["xcrun", "simctl", "launch", udid, "com.markhuot.harness"], { allowFail: true });
        await Bun.sleep(2000);
        if (url) await openUrl(udid, url);
        await Bun.sleep(2000);
      };
      await check("approval card: Allow once resumes the agent", async () => {
        await fresh(`harness://ticket/${k(seeded.approval)}`);
        await tapWhere(udid, "Allow once");
        const t = await settle(seeded.approval.key, (x) => !x.pendingApproval, 15000);
        return `${t.key} → ${t.status}`;
      });
      await check("Approve records the human review", async () => {
        await fresh(`harness://ticket/${k(seeded.hello)}`);
        await tapWhere(udid, "Approve");
        const t = await settle(seeded.hello.key, (x) => x.humanReview === "approved", 15000);
        return `${t.key} human=${t.humanReview}`;
      });
      await check("composer answers a blocked ticket", async () => {
        await fresh(`harness://ticket/${k(seeded.blocked)}`);
        await tapWhere(udid, (l) => l.startsWith("Message the agent"));
        await axe("type", "Use Happy Cog", "--udid", udid);
        await tapWhere(udid, "Send");
        const t = await settle(seeded.blocked.key, (x) => x.status !== "blocked", 15000);
        return `${t.key} → ${t.status}`;
      });
      await check("Start work moves a planning ticket to In progress", async () => {
        await fresh(`harness://ticket/${k(seeded.plan)}`);
        await tapWhere(udid, "Start work");
        const t = await settle(seeded.plan.key, (x) => x.status !== "planning", 15000);
        return `${t.key} → ${t.status}`;
      });
      await check("board context menu moves a card to Done", async () => {
        await fresh("");
        await tapWhere(udid, (l) => l.startsWith("Review,"));
        await Bun.sleep(800);
        await tapWhere(udid, (l) => l.startsWith(`${seeded.browse.key} `), { longPress: 1.2 });
        await Bun.sleep(800);
        await tapWhere(udid, "Move to Done");
        const t = await settle(seeded.browse.key, (x) => x.status === "done", 15000);
        return `${t.key} → ${t.status}`;
      });
      await simctl("io", udid, "screenshot", join(shots, "after-interactions-light.png"));
      for (const [name, ok, detail] of results) console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
      if (results.some((r) => !r[1])) failed = true;
    }
  }
  console.log(failed ? "sim-check finished with failures" : "sim-check done");
} catch (e) {
  failed = true;
  console.error("sim-check failed:", (e as Error).message);
  console.error(readFileSync(join(home, "daemon.err"), "utf8").slice(-2000));
} finally {
  if (flag("keep")) {
    console.log(`--keep: daemon still running at ${base} (pid ${daemon.pid}); token in ${home}/token`);
  } else {
    daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(8000)]);
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
