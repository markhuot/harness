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
//      scrolls into older pages, and the Search tab finds the unloaded done ticket; paging-*.png in light
//      and dark
//
//   7. --stick: only the stick-to-bottom checks: a ticket with a long brief and a long transcript;
//      swipes the Transcript and Summaries tabs and checks they follow new content at the bottom,
//      stay put once scrolled up, and follow again after scrolling back down
//
//   8. --keyboard: only the keyboard checks: with the on-screen keyboard up, the ticket composer
//      sits right on top of it and the New session sheet scrolls to its last button above it.
//      Needs the simulator's software keyboard (I/O → Keyboard → uncheck Connect Hardware
//      Keyboard); keyboard-*.png
//
//   9. --mentions: only the @-mention checks: in New session and the ticket composer, typing `@…`
//      lists the project's files, tapping one completes it, and the run the prompt starts gets the
//      file attached ("Attached @…" in the transcript); mentions-*.png in light and dark
//
//  10. --attachments: only the summary attachment checks (needs ffmpeg): a summary with a tall and a
//      wide PNG, an H.264 clip and a PNG that won't decode; checks every thumbnail shows, a tap opens
//      the viewer on that attachment, swiping pages, Close and swipe-down close it;
//      attachments-*.png (thumbnails in light and dark, the viewer on an image, the video, the failed file)
//
//   DEVELOPER_DIR=/Applications/Xcode-27.0.0.app/Contents/Developer bun scripts/sim-check.ts [--no-build] [--app=path] [--udid=…] [--keep] [--only=name,name] [--themes=id,id] [--paging] [--stick] [--keyboard] [--mentions] [--attachments]
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPairUrl, type Project, type Ticket, type TicketDetail, type TicketPage, type TranscriptEntry, type Watcher } from "@harness/shared";
import { findTheme } from "@harness/shared/themes";

const here = resolve(import.meta.dir, "..");
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DEVELOPER_DIR = process.env.DEVELOPER_DIR ?? "/Applications/Xcode-27.0.0.app/Contents/Developer";
const env = { ...process.env, DEVELOPER_DIR };
const shots = join(here, "build", "screens");
const appPath = process.argv.find((a) => a.startsWith("--app="))?.slice(6) ?? join(here, "build", "dd", "Build", "Products", "Release-iphonesimulator", "Harness.app");
const only = opt("only")?.split(",");
const themeShots = opt("themes")?.split(",").filter(Boolean) ?? [];
const pagingOnly = flag("paging");
const stickOnly = flag("stick");
const keyboardOnly = flag("keyboard");
const mentionsOnly = flag("mentions");
const attachmentsOnly = flag("attachments");
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
  // AXe's JSON escapes "/" (src\/app.ts); labels are compared as they read on screen.
  return [...(await axe("describe-ui", "--udid", udid)).matchAll(/"AXLabel" : "([^"]*)"/g)].map((m) => m[1]!.replace(/\\\//g, "/"));
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

// Whether iOS has asked "Open in “Harness”?" for a deep link this run. Some simulators never ask;
// once a link opened without the prompt, later links check for it once instead of polling for 3 s
// (each describe-ui is ~0.4 s, so a full poll cost ~8 s per link).
let openPrompt: "unknown" | "shown" | "never" = "unknown";

/** simctl openurl, then accept iOS's "Open in “Harness”?" confirmation. */
async function openUrl(udid: string, url: string) {
  await simctl("openurl", udid, url);
  if (!hasAxe) return;
  const polls = openPrompt === "never" ? 1 : 12;
  for (let i = 0; i < polls; i++) {
    await Bun.sleep(250);
    const l = await labels(udid);
    if (l.some((x) => x.startsWith("Open in"))) {
      await tapLabel(udid, "Open");
      openPrompt = "shown";
      return;
    }
  }
  if (openPrompt === "unknown") openPrompt = "never";
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
  const watcherCall = { name: "create_watcher", input: { name: "events", command: "while true; do curl -s -H \"Authorization: Bearer $EVENTS_TOKEN\" 'https://api.example.com/events?since=1m'; sleep 60; done", mode: "loop", prompt: "If this event is assigned to me and has actionable next steps, dispatch it to an agent in SITE.", env: { EVENTS_TOKEN: "evt_live_2f9c" } } };
  const configApproval = await create(other.id, `Watch the events API\n/tools ${JSON.stringify([watcherCall])}`);
  const blocked = await create(other.id, "Sign the build\n/block Which Apple Developer team should sign the build: Happy Cog or your personal account?");
  const plan = await create(other.id, "Write a landing page for the install link", { start: false });
  // Sub-agents: two, the second starting a nested third (the dummy driver's /agents).
  const agents = await create(project.id, "Survey the greeter before the rewrite\n/agents 3");

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
  await settle(configApproval.key, (t) => !!t.pendingApproval);
  await settle(blocked.key, (t) => t.status === "blocked" && !t.busy);
  await settle(plan.key, (t) => t.status === "planning" && !t.busy);
  await settle(browse.key, (t) => !t.busy, 90000);
  await settle(agents.key, (t) => t.status === "review" && !t.busy);
  const nestedAgent = (await api<TicketDetail>("GET", `/tickets/${agents.key}`)).subagents!.find((s) => s.parentId)!;
  await until("conductor children", async () => (await api<TicketDetail>("GET", `/tickets/${conductor.key}`)).children.length >= 3, 60000);
  // A watcher-less triage item for the Inbox.
  // The prompt names the project; the dummy triager reads the [dummy:project KEY] marker.
  const prompt = "If this issue is assigned to me and has actionable next steps, dispatch it to an agent in GREET.";
  await api("POST", "/watchers/inject", { source: "jira", text: JSON.stringify({ key: "FOO-123", summary: "Greeter crashes on an empty name", url: "https://example.com/FOO-123", updated: "1" }), prompt: `${prompt} [dummy:project ${project.key}]` });
  // A paused shell watcher, so Settings and the watcher form have one to show (and it never runs).
  const watcher = await api<Watcher>("POST", "/watchers", {
    name: "jira",
    command: "while true; do curl -s https://example.com/api/events | jq -c '.[]'; sleep 60; done",
    args: [],
    prompt,
    mode: "loop",
    enabled: false,
    driver: "dummy",
  });
  // Live watchers for the Inbox's watcher strip: one whose process stays up (and prints nothing),
  // one that fails at once and sits in its backoff with the error.
  await api<Watcher>("POST", "/watchers", { name: "heartbeat", command: "while true; do sleep 3600; done", mode: "loop", driver: "dummy" });
  await api<Watcher>("POST", "/watchers", { name: "jira-sprint", command: "echo 'watch-jira: 401 Unauthorized (check JIRA_TOKEN)' >&2; exit 1", mode: "loop", driver: "dummy" });
  await Bun.sleep(1500);
  return { project, other, hello, changes, conductor, browse, approval, configApproval, blocked, plan, watcher, agents, nestedAgent };
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
  // The strip scrolls to follow the page, so a tap can land on a neighbour: tap until a Done card is on
  // screen. Frames are in screen points and a card sits 14pt into its page, so from the Review page the
  // Done column's first card is at x≈416, just off the right edge: only a card near the left edge counts.
  const openDone = async () => {
    const top = p.history.at(-1)!.key;
    for (let i = 0; i < 4; i++) {
      await tapWhere(udid, (l) => l.startsWith("Done,"));
      await Bun.sleep(1200);
      const card = await findElement(udid, (l) => l.startsWith(`${top} `));
      if (card && card.frame.x >= 0 && card.frame.x < 100) return;
    }
    throw new Error("couldn't open the Done column");
  };
  // Search is its own tab; AXe descends into neither the tab bar nor the header holding the native
  // field, so tap where each sits.
  const tapSearch = async () => {
    await axe("tap", "-x", "328", "-y", "821", "--udid", udid); // Search, last in the tab bar
    await Bun.sleep(900);
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
    await axe("tap", "-x", "308", "-y", "84", "--udid", udid); // Board options (…), in the header
    await Bun.sleep(900);
    await tapWhere(udid, "Show child tickets");
    await until("children visible", () => has(`${p.kids[2]!.key} `), 6000);
    await axe("tap", "-x", "308", "-y", "84", "--udid", udid); // Board options (…), in the header
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

/** --stick: one ticket whose brief and transcript are both taller than the screen. */
const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ";
const stickText = (n: number, repeat = 3) => `Stick ${n}: ${LOREM.repeat(repeat)}`;
async function sayStick(key: string, n: number) {
  await api("POST", `/tickets/${key}/messages`, { text: stickText(n) });
  return settle(key, (t) => t.status === "review" && !t.busy && t.agentReview === "approved");
}
async function seedStick() {
  await api("PATCH", "/settings", { defaultDriver: "dummy", classifier: "off" });
  mkdirSync(join(scratch, "sticky"), { recursive: true });
  const project = await api<Project>("POST", "/projects", { path: join(scratch, "sticky"), name: "sticky", key: "STICK", defaultDriver: "dummy" });
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: stickText(0, 14), driver: "dummy", start: true });
  await settle(ticket.key, (t) => t.status === "review" && !t.busy && t.agentReview === "approved");
  for (let n = 1; n <= 5; n++) await sayStick(ticket.key, n);
  return { project, ticket };
}

/** --stick: real swipes on the Transcript and Summaries tabs. Returns false when a check failed. */
async function stickChecks(udid: string, p: Awaited<ReturnType<typeof seedStick>>): Promise<boolean> {
  const results: [string, boolean, string][] = [];
  const check = async (name: string, fn: () => Promise<string | boolean>) => {
    try {
      const r = await fn();
      results.push([name, r !== false, typeof r === "string" ? r : ""]);
    } catch (e) {
      results.push([name, false, (e as Error).message.split("\n")[0]!]);
    }
  };
  const key = p.ticket.key;
  const fresh = async (tab: string) => {
    await simctl("terminate", udid, "com.markhuot.harness").catch(() => {});
    await sh(["xcrun", "simctl", "launch", udid, "com.markhuot.harness"], { allowFail: true });
    await Bun.sleep(2000);
    await openUrl(udid, `harness://ticket/${encodeURIComponent(key)}?tab=${tab}`);
    await Bun.sleep(3000);
  };
  const H = (await tree())[0]!.frame.height;
  async function tree() {
    const out = await axe("describe-ui", "--udid", udid);
    return JSON.parse(out.slice(out.indexOf("["))) as AXNode[];
  }
  // The list's viewport: below the tab strip, above the composer.
  async function listView() {
    const all: AXNode[] = [];
    const walk = (n: AXNode) => (all.push(n), (n.children ?? []).forEach(walk));
    (await tree()).forEach(walk);
    const tab = all.find((n) => n.AXLabel === "Transcript" || n.AXLabel?.startsWith("Summaries"));
    const composer = all.find((n) => n.AXLabel?.startsWith("Message the agent"));
    const top = tab ? tab.frame.y + tab.frame.height : 100;
    const bottom = composer ? composer.frame.y : H - 60;
    // Every row rendered below the tab strip, on screen or not (FlatList keeps rows around the
    // viewport). Starting below it leaves out the app window and the header.
    const rows = all.filter((n) => n.AXLabel && n !== composer && n.AXLabel !== "Send" && n.frame.y >= top);
    return { rows, top, bottom };
  }
  /** At the bottom: the lowest rendered row is the list's last row and ends just above the composer. */
  const atBottom = async (last: (l: string) => boolean) => {
    const { rows, bottom } = await listView();
    const lowest = rows.reduce<AXNode | null>((a, n) => (!a || n.frame.y + n.frame.height > a.frame.y + a.frame.height ? n : a), null);
    const end = lowest ? lowest.frame.y + lowest.frame.height : 0;
    const ok = !!lowest && last(lowest.AXLabel!) && end <= bottom + 2 && end >= bottom - 70;
    return ok ? `last row "${lowest!.AXLabel!.slice(0, 32)}" ends at ${Math.round(end)}, composer at ${Math.round(bottom)}` : null;
  };
  /** A uniquely labelled row inside the viewport, to check that the view doesn't move. */
  const anchor = async () => {
    const { rows, top, bottom } = await listView();
    const count = new Map<string, number>();
    for (const n of rows) count.set(n.AXLabel!, (count.get(n.AXLabel!) ?? 0) + 1);
    const n = rows.find((r) => count.get(r.AXLabel!) === 1 && r.frame.y > top + 20 && r.frame.y + r.frame.height < bottom - 20);
    return n ? { label: n.AXLabel!, y: Math.round(n.frame.y) } : null;
  };
  const yOf = async (label: string) => {
    const n = (await listView()).rows.find((r) => r.AXLabel === label);
    return n ? Math.round(n.frame.y) : null;
  };
  const swipe = async (dir: "up" | "down", times = 4) => {
    // Finger moving down scrolls toward the top.
    const [from, to] = dir === "down" ? [H * 0.45, H * 0.8] : [H * 0.8, H * 0.45];
    for (let i = 0; i < times; i++) {
      await axe("swipe", "--start-x", "200", "--start-y", String(Math.round(from)), "--end-x", "200", "--end-y", String(Math.round(to)), "--duration", "0.25", "--udid", udid);
      await Bun.sleep(700);
    }
    await Bun.sleep(800);
  };

  let n = 5;
  // Every message ends with the reviewer's run: its last transcript row and its last summary.
  const tabs: [string, string, (l: string) => boolean][] = [
    ["transcript", "transcript", (l) => l.startsWith("Run finished (review)")],
    ["summaries", "summaries", (l) => l.startsWith("Review approved")],
  ];
  for (const [name, tab, last] of tabs) {
    await check(`${name} opens at the bottom`, async () => {
      await fresh(tab);
      return until("at the bottom", () => atBottom(last), 10000);
    });
    await check(`${name} follows new content while at the bottom`, async () => {
      await sayStick(key, ++n);
      await Bun.sleep(1500);
      return until("at the bottom", () => atBottom(last), 10000);
    });
    await check(`${name} stays put after the user scrolls up`, async () => {
      await swipe("down");
      const ref = await until("a row to watch", anchor, 5000);
      await sayStick(key, ++n);
      await Bun.sleep(2000);
      const y = await yOf(ref.label);
      if (y === null || Math.abs(y - ref.y) > 2) throw new Error(`"${ref.label.slice(0, 32)}" ${ref.y}→${y}`);
      if (await atBottom(last)) throw new Error("jumped to the bottom");
      return `"${ref.label.slice(0, 32)}" stayed at y=${y}`;
    });
    await check(`${name} follows again after scrolling back to the bottom`, async () => {
      // Swipe back down until the user has reached the end (the list grew a lot meanwhile).
      for (let i = 0; i < 25 && !(await atBottom(last)); i++) await swipe("up", 1);
      if (!(await atBottom(last))) throw new Error("couldn't swipe back to the bottom");
      await sayStick(key, ++n);
      await Bun.sleep(1500);
      return until("at the bottom", () => atBottom(last), 10000);
    });
  }

  for (const [name, ok, detail] of results) console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  await simctl("io", udid, "screenshot", join(shots, "stick-summaries.png"));
  return results.every((r) => r[1]);
}

/** --keyboard: the composer and a sheet's last control stay above the on-screen keyboard. */
async function keyboardChecks(udid: string, p: Awaited<ReturnType<typeof seedStick>>): Promise<boolean> {
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
    await openUrl(udid, url);
    await Bun.sleep(2500);
  };
  const nodes = async () => {
    const out = await axe("describe-ui", "--udid", udid);
    const all: AXNode[] = [];
    const walk = (n: AXNode) => (all.push(n), (n.children ?? []).forEach(walk));
    (JSON.parse(out.slice(out.indexOf("["))) as AXNode[]).forEach(walk);
    return all;
  };
  // The keyboard's top edge: the highest key row. Keys are the only single-letter labels on screen.
  const keyboardTop = async () => {
    const keys = (await nodes()).filter((n) => /^[a-zA-Z]$/.test(n.AXLabel ?? "") || n.AXLabel === "space");
    return keys.length >= 10 ? Math.min(...keys.map((k) => k.frame.y)) - 8 : null;
  };
  const bottomOf = (n: AXNode) => n.frame.y + n.frame.height;

  await check("ticket composer sits on top of the keyboard", async () => {
    await fresh(`harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=transcript`);
    await tapWhere(udid, (l) => l.startsWith("Message the agent"));
    const top = await until("keyboard up", keyboardTop, 8000);
    await Bun.sleep(800);
    const field = (await nodes()).find((n) => n.AXLabel?.startsWith("Message the agent"));
    await simctl("io", udid, "screenshot", join(shots, "keyboard-composer.png"));
    if (!field) throw new Error("the composer is gone from the screen (behind the keyboard)");
    const gap = Math.round(top - bottomOf(field));
    if (gap < 0) throw new Error(`the composer's field ends ${-gap}pt behind the keyboard (field ends at ${Math.round(bottomOf(field))}, keyboard at ${Math.round(top)})`);
    if (gap > 40) throw new Error(`${gap}pt gap between the composer and the keyboard`);
    return `field ends ${gap}pt above the keyboard`;
  });

  await check("New session scrolls to its last button above the keyboard", async () => {
    await fresh("harness://new");
    const top = await until("keyboard up", keyboardTop, 8000);
    await Bun.sleep(800);
    for (let i = 0; i < 3; i++) {
      await axe("swipe", "--start-x", "200", "--start-y", String(Math.round(top - 30)), "--end-x", "200", "--end-y", "160", "--duration", "0.3", "--udid", udid);
      await Bun.sleep(700);
    }
    await Bun.sleep(800);
    await simctl("io", udid, "screenshot", join(shots, "keyboard-new-session.png"));
    const button = (await nodes()).find((n) => n.AXLabel === "Start session" || n.AXLabel === "Plan first");
    if (!button) throw new Error("no Start session / Plan first button");
    const gap = Math.round(top - bottomOf(button));
    if (gap < 0) throw new Error(`the last button ends ${-gap}pt behind the keyboard (button ends at ${Math.round(bottomOf(button))}, keyboard at ${Math.round(top)})`);
    return `"${button.AXLabel}" ends ${gap}pt above the keyboard`;
  });

  for (const [name, ok, detail] of results) console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return results.every((r) => r[1]);
}

/** --mentions: a project with a few files, and a ticket in review to message. */
async function seedMentions() {
  await api("PATCH", "/settings", { defaultDriver: "dummy", classifier: "off" });
  const dir = join(scratch, "mentions");
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Mentions\n\nThe readme the agent gets without reading it.\n");
  writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(dir, "src", "lib", "format.ts"), "export const format = 2;\n");
  const project = await api<Project>("POST", "/projects", { path: dir, name: "mentions", key: "MENT", defaultDriver: "dummy" });
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: "Warm up", driver: "dummy", start: true });
  await settle(ticket.key, (t) => t.status === "review" && !t.busy && t.agentReview === "approved");
  return { project, ticket };
}

/** --mentions: real typing and taps in New session and the composer. Returns false when a check failed. */
async function mentionChecks(udid: string, p: Awaited<ReturnType<typeof seedMentions>>): Promise<boolean> {
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
    await openUrl(udid, url);
    await Bun.sleep(2500);
  };
  const has = async (label: string) => (await labels(udid)).includes(label);
  const texts = async (key: string) => {
    const d = await api<TicketDetail>("GET", `/tickets/${key}`);
    return (await api<TranscriptEntry[]>("GET", `/sessions/${d.ticket.sessionId}/transcript`)).map((e) => ("text" in e.content ? e.content.text : ""));
  };
  const newSession = `harness://new?projectId=${encodeURIComponent(p.project.id)}`;
  const composer = `harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=transcript`;

  await check("New session: @READ lists README.md, a tap completes it, the run gets the file", async () => {
    await fresh(newSession);
    await tapWhere(udid, (l) => l.startsWith("Prompt"));
    await axe("type", "Summarize @READ", "--udid", udid);
    await until("README.md suggested", () => has("README.md"), 8000);
    await Bun.sleep(400);
    await tapWhere(udid, "README.md");
    await until("list closed", async () => !(await has("README.md")), 4000);
    await tapWhere(udid, "Start session");
    const t = await until("ticket created", async () => (await api<Ticket[]>("GET", `/tickets?projectId=${p.project.id}`)).find((x) => x.key !== p.ticket.key), 10000);
    if (t.description !== "Summarize @README.md") throw new Error(`brief is ${JSON.stringify(t.description)}`);
    await until("Attached status", async () => (await texts(t.key)).includes("Attached @README.md"), 15000);
    return `${t.key}: ${t.description}`;
  });

  await check("New session: a folder keeps the list open inside it", async () => {
    await fresh(newSession);
    await tapWhere(udid, (l) => l.startsWith("Prompt"));
    await axe("type", "@sr", "--udid", udid);
    await until("src/ suggested", () => has("src/"), 8000);
    await tapWhere(udid, "src/");
    await until("src/app.ts suggested", () => has("src/app.ts"), 8000);
    return (await has("src/lib/")) ? "src/app.ts, src/lib/ …" : "src/app.ts";
  });

  await check("composer: @src/a lists src/app.ts, the message's run gets the file", async () => {
    await fresh(composer);
    await tapWhere(udid, (l) => l.startsWith("Message the agent"));
    // iOS may capitalize the first word, so the message is compared without case.
    await axe("type", "see @src/a", "--udid", udid);
    await until("src/app.ts suggested", () => has("src/app.ts"), 8000);
    await Bun.sleep(400); // let the list settle before aiming at a row
    await tapWhere(udid, "src/app.ts");
    // Picking closes the list and the composer shrinks, which moves Send.
    await until("list closed", async () => !(await has("src/app.ts")), 4000);
    await Bun.sleep(300);
    await tapWhere(udid, "Send");
    await until("message with the mention", async () => (await texts(p.ticket.key)).some((t) => t.toLowerCase() === "see @src/app.ts"), 10000).catch(async (e) => {
      throw new Error(`${(e as Error).message}; transcript ends ${JSON.stringify((await texts(p.ticket.key)).slice(-4))}`);
    });
    await until("Attached status", async () => (await texts(p.ticket.key)).includes("Attached @src/app.ts"), 15000);
    return "see @src/app.ts";
  });

  for (const [name, ok, detail] of results) console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  for (const theme of ["light", "dark"] as const) {
    await simctl("ui", udid, "appearance", theme);
    await fresh(newSession);
    await tapWhere(udid, (l) => l.startsWith("Prompt")).catch(() => {});
    await axe("type", "Read @", "--udid", udid);
    await until("suggestions", () => has("README.md"), 8000).catch(() => {});
    await Bun.sleep(600);
    await simctl("io", udid, "screenshot", join(shots, `mentions-new-session-${theme}.png`));
    await fresh(composer);
    await tapWhere(udid, (l) => l.startsWith("Message the agent")).catch(() => {});
    await axe("type", "@src/", "--udid", udid);
    await until("suggestions", () => has("src/app.ts"), 8000).catch(() => {});
    await Bun.sleep(600);
    await simctl("io", udid, "screenshot", join(shots, `mentions-composer-${theme}.png`));
  }
  await simctl("ui", udid, "appearance", "light");
  return results.every((r) => r[1]);
}

/** --attachments: a ticket whose summary carries real images, a video and one file that won't decode. */
async function seedAttachments() {
  await api("PATCH", "/settings", { defaultDriver: "dummy", classifier: "off" });
  const dir = join(scratch, "media");
  mkdirSync(join(dir, "shots"), { recursive: true });
  const ff = (...a: string[]) => sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a], { cwd: dir });
  // A tall phone screenshot, a wide one, a short H.264 clip, and a PNG that's only its header.
  await ff("-f", "lavfi", "-i", "testsrc2=size=1179x2556:rate=1", "-frames:v", "1", "shots/phone.png");
  await ff("-f", "lavfi", "-i", "smptehdbars=size=1600x900:rate=1", "-frames:v", "1", "shots/wide.png");
  await ff("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-movflags", "+faststart", "shots/flow.mp4");
  writeFileSync(join(dir, "shots/broken.png"), Buffer.concat([readFileSync(join(dir, "shots/wide.png")).subarray(0, 64)]));
  const project = await api<Project>("POST", "/projects", { path: dir, name: "media", key: "MEDIA", defaultDriver: "dummy" });
  const files = ["phone.png", "wide.png", "flow.mp4", "broken.png"].map((f) => join(dir, "shots", f));
  const call = { name: "post_summary", input: { summary: "Here's the new greeting screen, before and after, plus a recording of the flow.", attachments: files } };
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: `Show the greeting screen\n/tools ${JSON.stringify([call])}`, driver: "dummy", start: true });
  await settle(ticket.key, (t) => t.status === "review" && !t.busy);
  const summaries = await api<{ attachments: unknown[] }[]>("GET", `/tickets/${encodeURIComponent(ticket.key)}/summaries`);
  if (!summaries.some((s) => s.attachments.length === files.length)) throw new Error(`no summary with ${files.length} attachments`);
  return { project, ticket };
}

/** --attachments: thumbnails in the Summaries tab, then the viewer (open, page, close, swipe down). */
async function attachmentChecks(udid: string, p: Awaited<ReturnType<typeof seedAttachments>>): Promise<boolean> {
  const results: [string, boolean, string][] = [];
  const check = async (name: string, fn: () => Promise<string | boolean>) => {
    try {
      const r = await fn();
      results.push([name, r !== false, typeof r === "string" ? r : ""]);
    } catch (e) {
      results.push([name, false, (e as Error).message.split("\n")[0]!]);
    }
  };
  const summaries = `harness://ticket/${encodeURIComponent(p.ticket.key)}?tab=summaries`;
  const fresh = async () => {
    await simctl("terminate", udid, "com.markhuot.harness").catch(() => {});
    await sh(["xcrun", "simctl", "launch", udid, "com.markhuot.harness"], { allowFail: true });
    await Bun.sleep(2000);
    await openUrl(udid, summaries);
    await until("thumbnails", async () => (await labels(udid)).includes("Image phone.png"), 10000);
    await Bun.sleep(1500); // let the images and the video's first frame load
  };
  const has = async (pred: (l: string) => boolean) => (await labels(udid)).some(pred);
  const counter = (n: number) => (l: string) => l.startsWith(`${n} of 4`);
  const swipeLeft = () => axe("swipe", "--start-x", "340", "--start-y", "450", "--end-x", "40", "--end-y", "450", "--duration", "0.3", "--udid", udid);
  const swipeDown = () => axe("swipe", "--start-x", "200", "--start-y", "330", "--end-x", "205", "--end-y", "760", "--duration", "0.25", "--udid", udid);

  await check("every attachment has a thumbnail", async () => {
    await fresh();
    const want = ["Image phone.png", "Image wide.png", "Video flow.mp4", "Image broken.png"];
    const l = await labels(udid);
    const missing = want.filter((w) => !l.includes(w));
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
    return want.join(", ");
  });
  await check("tapping a thumbnail opens the viewer on it; swiping pages; Close closes", async () => {
    await fresh();
    await tapWhere(udid, "Image wide.png");
    await until("viewer on 2 of 4", () => has(counter(2)), 5000);
    await Bun.sleep(900); // the modal's fade-in swallows gestures
    await swipeLeft();
    await until("paged to 3 of 4", () => has(counter(3)), 5000);
    await tapWhere(udid, "Close");
    await until("viewer closed", async () => !(await has((l) => / of 4/.test(l))), 5000);
    return "2 of 4 → 3 of 4 → closed";
  });
  await check("swiping down closes the viewer", async () => {
    await fresh();
    await tapWhere(udid, "Image phone.png");
    await until("viewer open", () => has(counter(1)), 5000);
    await Bun.sleep(900);
    await swipeDown();
    await until("viewer closed", async () => !(await has((l) => / of 4/.test(l))), 5000);
    return "closed";
  });
  await check("the video page plays and swiping down closes it too", async () => {
    await fresh();
    await tapWhere(udid, "Image wide.png");
    await until("viewer open", () => has(counter(2)), 5000);
    await Bun.sleep(900);
    await swipeLeft();
    await until("on the video", () => has(counter(3)), 5000);
    await Bun.sleep(1500);
    await swipeDown();
    await until("viewer closed", async () => !(await has((l) => / of 4/.test(l))), 5000);
    return "closed";
  });
  for (const [name, ok, detail] of results) console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);

  // Screenshots: the thumbnails, an image in the viewer, the playing video, the failed file.
  for (const theme of ["light", "dark"] as const) {
    await simctl("ui", udid, "appearance", theme);
    await fresh().catch(() => {});
    await simctl("io", udid, "screenshot", join(shots, `attachments-thumbnails-${theme}.png`));
    // The video and the broken file sit past the screen edge in the row, so page to them in the viewer.
    await fresh().catch(() => {});
    await tapWhere(udid, "Image wide.png").catch(() => {});
    await Bun.sleep(1500);
    await simctl("io", udid, "screenshot", join(shots, `attachments-viewer-image-${theme}.png`));
    if (theme === "dark") continue; // the viewer is black in both themes
    await swipeLeft();
    await Bun.sleep(2500);
    await simctl("io", udid, "screenshot", join(shots, "attachments-viewer-video-light.png"));
    await swipeLeft();
    await Bun.sleep(1500);
    await simctl("io", udid, "screenshot", join(shots, "attachments-viewer-failed-light.png"));
  }
  await simctl("ui", udid, "appearance", "light");
  return results.every((r) => r[1]);
}

// ---------------------------------------------------------------- main
let failed: boolean = false;
try {
  await until("daemon healthy", async () => (await fetch(`${base}/health`)).ok, 20000);
  token = readFileSync(join(home, "token"), "utf8").trim();
  const [udid, seeded, paged, sticky, mentioned, media] = await Promise.all([
    pickDevice(),
    pagingOnly || stickOnly || keyboardOnly || mentionsOnly || attachmentsOnly ? null : seed(),
    pagingOnly ? seedPaging() : null,
    stickOnly || keyboardOnly ? seedStick() : null,
    mentionsOnly ? seedMentions() : null,
    attachmentsOnly ? seedAttachments() : null,
  ]);
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
  if (sticky && stickOnly) failed = !(await stickChecks(udid, sticky));
  if (sticky && keyboardOnly) failed = !(await keyboardChecks(udid, sticky));
  if (mentioned) failed = !(await mentionChecks(udid, mentioned));
  if (media) failed = !(await attachmentChecks(udid, media));
  if (seeded) {
    const k = (t: Ticket) => encodeURIComponent(t.key);
    const screens: [string, string, number?][] = [
      ["board", "harness://board"],
      ["projects", "harness://projects"],
      ["ticket-summaries", `harness://ticket/${k(seeded.hello)}?tab=summaries`],
      ["ticket-transcript", `harness://ticket/${k(seeded.hello)}?tab=transcript`],
      ["ticket-details", `harness://ticket/${k(seeded.hello)}?tab=details`],
      ["conductor-tickets", `harness://ticket/${k(seeded.conductor)}?tab=children`],
      ["ticket-agents", `harness://ticket/${k(seeded.agents)}?tab=agents`],
      ["ticket-subagent", `harness://ticket/${k(seeded.agents)}?tab=${encodeURIComponent(`agent:${seeded.nestedAgent.id}`)}`],
      ["approval", `harness://ticket/${k(seeded.approval)}`],
      ["approval-config", `harness://ticket/${k(seeded.configApproval)}`],
      ["blocked", `harness://ticket/${k(seeded.blocked)}`],
      ["planning", `harness://ticket/${k(seeded.plan)}`],
      ["browser", `harness://ticket/${k(seeded.browse)}?tab=browser`, 6000],
      ["changes", `harness://ticket/${k(seeded.changes)}?tab=plugin:git:changes`, 7000],
      ["new-session", "harness://new"],
      ["inbox", "harness://inbox"],
      ["settings", "harness://settings"],
      ["watcher-new", "harness://watcher"],
      ["watcher-edit", `harness://watcher?id=${encodeURIComponent(seeded.watcher.id)}`],
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
        // A fresh launch per screen, so a modal from the previous one never frames the next. The deep
        // link cold-launches the app straight onto its screen, skipping a launch and its 2 s settle.
        await simctl("terminate", udid, "com.markhuot.harness").catch(() => {});
        if (url === "harness://board") {
          await sh(["xcrun", "simctl", "launch", udid, "com.markhuot.harness"], { allowFail: true });
          await Bun.sleep(2000);
        } else {
          await openUrl(udid, url);
        }
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
      await check("Approve records the human review and auto-completes the ticket", async () => {
        await fresh(`harness://ticket/${k(seeded.hello)}`);
        await tapWhere(udid, "Approve");
        const t = await settle(seeded.hello.key, (x) => x.humanReview === "approved" && x.status === "done", 15000);
        return `${t.key} human=${t.humanReview} → ${t.status}`;
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
