// Fixtures the iPhone worlds share (the walkthrough's and sim-check's): a long file for the file
// viewer to scroll to a linked range, and the plan-usage report the app reads through a proxy.

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
