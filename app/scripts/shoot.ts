// Visual check: boot the mock service, launch the built app against it once per route/theme and
// capture the window via webContents.capturePage (HARNESS_CAPTURE, see src/main/main.ts).
//
//   bun scripts/shoot.ts [outDir] [--only=board-light,ticket-dark]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const appDir = resolve(import.meta.dir, "..");
const outDir = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? join(appDir, "out", "screenshots"));
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
mkdirSync(outDir, { recursive: true });

const port = 7700 + Math.floor(Math.random() * 90);
const token = "shoot-token";
const mock = Bun.spawn(["bun", join(appDir, "scripts/mock-service.ts")], {
  env: { ...process.env, MOCK_PORT: String(port), MOCK_TOKEN: token },
  stdout: "ignore",
  stderr: "inherit",
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(base + "/health")).ok) break;
  } catch {}
  await Bun.sleep(100);
}

const projects = (await (await fetch(base + "/projects", { headers: { authorization: `Bearer ${token}` } })).json()).data as { id: string; key: string }[];
const hello = projects.find((p) => p.key === "HELLOHARNESS")?.id ?? projects[0]!.id;

const shots: { name: string; route: string; delay?: number }[] = [
  { name: "board", route: "#/board/all" },
  { name: "ticket", route: "#/board/all/ticket/NYTIMES-4" },
  { name: "transcript", route: "#/board/all/ticket/NYTIMES-1/transcript", delay: 4200 },
  { name: "blocked", route: "#/board/all/ticket/NYTIMES-3" },
  { name: "details", route: "#/board/all/ticket/HARNESS-1/details" },
  { name: "browser", route: "#/board/all/ticket/NYTIMES-1/browser", delay: 3500 },
  { name: "inbox", route: "#/inbox" },
  { name: "settings", route: "#/settings" },
  { name: "project", route: `#/project/${hello}/settings` },
  { name: "approval", route: "#/board/all/ticket/HARNESS-9" },
  { name: "compose", route: "#/compose" },
  { name: "streaming", route: "#/board/all/ticket/NYTIMES-1/transcript", delay: 700 },
  { name: "error", route: "#/board/all" },
];

const electron = join(appDir, "..", "node_modules", ".bin", "electron");
try {
  for (const theme of ["light", "dark"] as const) {
    for (const s of shots) {
      const name = `${s.name}-${theme}`;
      if (only && !only.includes(name) && !only.includes(s.name)) continue;
      const file = join(outDir, `${name}.png`);
      const env: Record<string, string | undefined> = {
        ...process.env,
        HARNESS_URL: base,
        HARNESS_TOKEN: token,
        HARNESS_THEME: theme,
        HARNESS_ROUTE: s.route,
        HARNESS_CAPTURE: file,
        HARNESS_CAPTURE_DELAY: String(s.delay ?? 2500),
      };
      if (s.name === "error") {
        // Exercise the real ensure path against a repo root with no service in it.
        delete env.HARNESS_URL;
        delete env.HARNESS_TOKEN;
        env.HARNESS_REPO_ROOT = "/nonexistent/harness";
      }
      const p = Bun.spawn([electron, appDir], { env, stdout: "inherit", stderr: "inherit" });
      const timer = setTimeout(() => p.kill(), 20_000);
      await p.exited;
      clearTimeout(timer);
    }
  }
} finally {
  mock.kill();
}
console.log(`screenshots in ${outDir}`);
