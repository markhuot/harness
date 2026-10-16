// Fixtures the walkthrough's iPhone worlds share: a long file for the file
// viewer to scroll to a linked range, and the plan-usage report the app reads through a proxy.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A file long enough that the file viewer has to scroll to a linked range. `edited` is the version a
 * ticket's worktree changes (greetingFor rewritten, greet_da removed, greet_ja changed, greet_eo added).
 */
export const GREETINGS_PATH = "src/greetings.ts";
const LOCALES: [string, string][] = [
  ["en", "Hello"], ["de", "Hallo"], ["fr", "Bonjour"], ["es", "Hola"], ["it", "Ciao"], ["pt", "Olá"],
  ["nl", "Hallo"], ["sv", "Hej"], ["da", "Hej"], ["fi", "Hei"], ["pl", "Cześć"], ["cs", "Ahoj"],
  ["tr", "Merhaba"], ["ja", "Konnichiwa"], ["ko", "Annyeong"], ["hi", "Namaste"], ["sw", "Jambo"], ["haw", "Aloha"],
];
export function greetingsLines(edited: boolean): string[] {
  const out = ["// Greetings by locale, for main() and the API.", "", "export const GREETINGS: Record<string, string> = {", ...LOCALES.map(([k, v]) => `  ${k}: "${v}",`), "};", ""];
  out.push('/** The greeting for a locale: "de-AT" falls back to "de", anything unknown to English. */', "export function greetingFor(locale: string): string {");
  if (edited) out.push("  const [lang] = locale.toLowerCase().split(/[-_]/);", "  return GREETINGS[lang!] ?? GREETINGS.en!;");
  else out.push('  const lang = locale.split("-")[0];', '  return GREETINGS[lang] || "Hello";');
  out.push("}", "");
  for (const [k] of LOCALES) {
    if (edited && k === "da") continue;
    out.push(`export function greet_${k}(name: string): string {`, edited && k === "ja" ? "  return `${GREETINGS.ja}, ${name}-san!`;" : `  return \`\${GREETINGS.${k}}, \${name}!\`;`, "}", "");
  }
  if (edited) out.push("export function greet_eo(name: string): string {", "  return `Saluton, ${name}!`;", "}", "");
  return out;
}
export const greetings = (edited: boolean) => greetingsLines(edited).join("\n");
/** 1-based lines of the function whose first line starts with `head`, closing brace included. */
export function functionLines(lines: string[], head: string): [number, number] {
  const start = lines.findIndex((l) => l.startsWith(head));
  return [start + 1, lines.indexOf("}", start) + 1];
}
export const GREETING_FOR = functionLines(greetingsLines(false), "export function greetingFor");
/** Far enough down that the viewer has to scroll to it. */
export const GREET_JA = functionLines(greetingsLines(true), "export function greet_ja");

// The dummy driver reports no plan usage and the real ones read the account's login, so the app talks
// to a proxy that answers GET /usage from this report.
export type UsageReport = { drivers: unknown[] };
const WEEK_S = 7 * 86400;
const usageNow = () => Date.now();
/** A window `elapsed` of the way through `windowSeconds`. */
const usageWindow = (id: string, label: string, used: number, windowSeconds: number, elapsed: number) => ({
  id, label, usedPercent: used, windowSeconds, resetsAt: Math.round(usageNow() + (1 - elapsed) * windowSeconds * 1000),
});
/** Claude: amber 5-hour (red when projected), a weekly that's green projected, an Opus week too early to project, a Sonnet week that's full. Copilot can't be read. */
export const usageFixture = (): UsageReport => ({
  drivers: [
    {
      driver: "claude-code", name: "Claude Code", fetchedAt: usageNow() - 180_000,
      windows: [
        usageWindow("five_hour", "5-hour", 82, 18000, 1 - (2 * 3600 + 14 * 60) / 18000),
        usageWindow("seven_day", "Weekly", 45, WEEK_S, 0.8),
        usageWindow("seven_day_opus", "Weekly · Opus", 2, WEEK_S, 0.05),
        usageWindow("seven_day_sonnet", "Weekly · Sonnet", 100, WEEK_S, 0.5),
      ],
    },
    { driver: "github-copilot", name: "GitHub Copilot", windows: [], error: "Sign in to GitHub to see Copilot usage", fetchedAt: usageNow() - 180_000 },
  ],
});

/** What the fake claude CLI (service/src/drivers/__fixtures__/fake-claude.ts) lists as the agent's slash commands. */
export const SLASH_COMMANDS = [
  { name: "code-walk", description: "Walk a user through a piece of code so they can perform a detailed code review. (user)", argumentHint: "" },
  { name: "commit-and-pr", description: "Commit and PR (user)", argumentHint: "" },
  { name: "vercel:deploy", description: "(vercel) Deploy the current project to Vercel.", argumentHint: "[prod]" },
];

/** The media ticket's small.png, in pixels: narrower and shorter than the viewer's page on an iPhone, so it shows at its own size (1 px = 1 pt). */
export const SMALL_IMAGE = { width: 300, height: 652 };

/** The files the media ticket's spec shows, in the viewer's order (1 of 5 … 4 of 5); the 5th is a reference to an attachment that doesn't exist. */
export const MEDIA_FILES = ["phone.png", "wide.png", "small.png", "flow.mp4"];

/** The media ticket's spec: three screenshots as a row of thumbnails, a recording as a captioned figure, and an attachment that won't load (its viewer page is the failure page). */
export const MEDIA_SPEC = [
  "Show the greeting screen",
  "",
  "Here's the new greeting screen, before and after, plus a recording of the flow.",
  "",
  `![phone.png](shots/phone.png "thumb") ![wide.png](shots/wide.png "thumb") ![small.png](shots/small.png "thumb")`,
  "",
  "![flow.mp4](shots/flow.mp4)",
  "",
  "![broken.png](attachment:att_missing)",
].join("\n");

/** Writes `shots/` under `dir`: a tall phone screenshot, a wide one, one smaller than the screen both ways (a solid colour, so a pixel read finds its edges on the viewer's black page) and a short H.264 clip. Needs ffmpeg. */
export async function writeMedia(dir: string) {
  mkdirSync(join(dir, "shots"), { recursive: true });
  const ff = async (...a: string[]) => {
    const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...a], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`ffmpeg ${a.join(" ")} → ${code}\n${err}`);
  };
  await Promise.all([
    ff("-f", "lavfi", "-i", "testsrc2=size=1179x2556:rate=1", "-frames:v", "1", "shots/phone.png"),
    ff("-f", "lavfi", "-i", "smptehdbars=size=1600x900:rate=1", "-frames:v", "1", "shots/wide.png"),
    ff("-f", "lavfi", "-i", `color=c=0x3478f6:size=${SMALL_IMAGE.width}x${SMALL_IMAGE.height}`, "-frames:v", "1", "shots/small.png"),
    ff("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-movflags", "+faststart", "shots/flow.mp4"),
  ]);
}

/**
 * Where a screenshot isn't black, in points, between `top` and `bottom` points from its edges (the
 * header and the home indicator): ffmpeg's cropdetect over that band, scaled by the screenshot's
 * pixels per point. The viewer's page is black, so on an image page that's the image.
 */
export async function litBox(file: string, screenWidthPt: number, top: number, bottom: number) {
  const run = async (cmd: string[]) => {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  const probe = await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", file]);
  const scale = Number(probe.out) / screenWidthPt;
  const [t, b] = [Math.round(top * scale), Math.round(bottom * scale)];
  // skip=0: cropdetect skips the first two frames by default, and a screenshot has one. Its x1…y2 are the exact bounds.
  const { err, code } = await run(["ffmpeg", "-hide_banner", "-i", file, "-vf", `crop=iw:ih-${t + b}:0:${t},cropdetect=limit=24:round=1:reset=0:skip=0`, "-frames:v", "1", "-f", "null", "-"]);
  const m = [...err.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)].at(-1);
  if (code !== 0 || !m) throw new Error(`cropdetect on ${file} → ${code}\n${err.slice(-500)}`);
  const [x1, x2, y1, y2] = m.slice(1).map(Number) as [number, number, number, number];
  return { x: x1 / scale, y: (y1 + t) / scale, width: (x2 - x1 + 1) / scale, height: (y2 - y1 + 1) / scale };
}
