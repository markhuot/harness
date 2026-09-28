// Locating and starting the harness service. The app never hosts agents: it only asks the
// service CLI to make sure the launchd daemon is running, then connects to it over HTTP/WS.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Connection, ConnectionError, ConnectionResult } from "./types";

export interface HarnessResources {
  repoRoot: string;
  bunPath: string;
}

export interface EnsureOutput {
  url: string;
  tokenPath: string;
  home?: string;
  pid?: number;
}

/** resources/harness.json is written by scripts/build.ts; it lives next to dist/ in dev and in the packaged app. */
export function readResources(appRoot: string): HarnessResources | null {
  const file = join(appRoot, "resources", "harness.json");
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (typeof json.repoRoot === "string" && typeof json.bunPath === "string") return json;
  } catch {}
  return null;
}

/** Finder-launched apps get a bare PATH; add the usual places bun, git, claude and node live. */
export function augmentedPath(bunPath: string | null): string {
  const extra = [
    bunPath ? resolve(bunPath, "..") : null,
    join(homedir(), ".bun/bin"),
    join(homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((p): p is string => !!p);
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  return [...new Set([...current, ...extra])].join(":");
}

/** Pull the last JSON object out of CLI stdout (tolerates log lines before it). */
export function parseEnsureOutput(stdout: string): EnsureOutput | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const json = JSON.parse(t);
      if (typeof json.url === "string" && typeof json.tokenPath === "string") return json;
    } catch {}
  }
  // Pretty-printed JSON spanning several lines.
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(stdout.slice(start, end + 1));
      if (typeof json.url === "string" && typeof json.tokenPath === "string") return json;
    } catch {}
  }
  return null;
}

function expandHome(p: string) {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>((done) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ code: null, stdout, stderr, error: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: null, stdout, stderr, error: `Timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

/** Run the service CLI (`<bun> <repoRoot>/service/src/cli.ts …`) from the build's harness.json. */
async function runCli(appRoot: string, env: NodeJS.ProcessEnv, args: string[]) {
  const res = readResources(appRoot);
  // Dev override: point a built app at a different checkout.
  if (res && env.HARNESS_REPO_ROOT) res.repoRoot = env.HARNESS_REPO_ROOT;
  if (!res) {
    return fail(
      "The app wasn't built with a service location.",
      `Missing or invalid ${join(appRoot, "resources", "harness.json")}. Run \`bun run build\` in app/.`,
    );
  }
  const cli = join(res.repoRoot, "service", "src", "cli.ts");
  if (!existsSync(cli)) return fail("Couldn't find the harness service.", `Expected ${cli}`);
  if (!existsSync(res.bunPath)) return fail("Couldn't find bun.", `Expected bun at ${res.bunPath} (from harness.json).`);

  const childEnv = { ...env, PATH: augmentedPath(res.bunPath) };
  const out = await run(res.bunPath, [cli, ...args], childEnv, 45_000);
  const transcript = [`$ ${res.bunPath} ${cli} ${args.join(" ")}`, out.stdout.trim(), out.stderr.trim(), out.error ?? ""]
    .filter(Boolean)
    .join("\n");
  return { out, transcript };
}

/**
 * Restart the service now; running agents are stopped. A service the app started goes through
 * launchd (\`service restart\`), which works on a service of any age, including one from before
 * POST /service/restart existed. Other connections (HARNESS_URL) ask the service to restart itself.
 */
export async function restartService(
  appRoot: string,
  conn: ConnectionResult | null,
  env: NodeJS.ProcessEnv = process.env,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: true } | ConnectionError> {
  if (!conn || "error" in conn) return fail("Not connected to the service.", "");
  if (conn.source === "service") {
    const cli = await runCli(appRoot, env, ["service", "restart", "--json"]);
    if ("error" in cli) return cli;
    return cli.out.code === 0 ? { ok: true } : fail("The harness service didn't restart.", cli.transcript);
  }
  try {
    const res = await doFetch(`${conn.baseUrl.replace(/\/$/, "")}/service/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${conn.token}` },
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return fail("The harness service didn't restart.", body.error ?? `HTTP ${res.status}`);
  } catch (e) {
    return fail("The harness service didn't restart.", (e as Error).message);
  }
}

/**
 * Resolve a connection to the service:
 *  1. HARNESS_URL + HARNESS_TOKEN env overrides (dev / tests / mock service)
 *  2. `<bun> <repoRoot>/service/src/cli.ts service ensure --json` → { url, tokenPath }
 */
export async function ensureService(appRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<ConnectionResult> {
  if (env.HARNESS_URL && env.HARNESS_TOKEN) {
    return { baseUrl: env.HARNESS_URL, token: env.HARNESS_TOKEN, source: "env" } satisfies Connection;
  }

  const cli = await runCli(appRoot, env, ["service", "ensure", "--json"]);
  if ("error" in cli) return cli;
  const { out, transcript } = cli;

  if (out.code !== 0) return fail("The harness service didn't start.", transcript);
  const parsed = parseEnsureOutput(out.stdout);
  if (!parsed) return fail("The harness service returned something unexpected.", transcript);

  const token = readTokenFile(parsed.tokenPath);
  if (typeof token !== "string") return token;
  return { baseUrl: parsed.url, token, source: "service", tokenPath: parsed.tokenPath, home: parsed.home, pid: parsed.pid };
}

/** Read the bearer token file (as written by the service, trailing newline trimmed). */
export function readTokenFile(tokenPath: string): string | ConnectionError {
  let token: string;
  try {
    token = readFileSync(expandHome(tokenPath), "utf8").trim();
  } catch (e) {
    return fail("Couldn't read the service token.", `${tokenPath}: ${(e as Error).message}`);
  }
  if (!token) return fail("The service token is empty.", tokenPath);
  return token;
}

/**
 * After the token was rotated (POST /token/rotate): the same connection with the token re-read from
 * its file. Env connections have no file; they take the token the rotate call returned.
 */
export function reloadToken(conn: ConnectionResult | null, rotated?: string): ConnectionResult {
  if (!conn || "error" in conn) return conn ?? fail("Not connected to the service.", "");
  if (!conn.tokenPath) return rotated ? { ...conn, token: rotated } : conn;
  const token = readTokenFile(conn.tokenPath);
  return typeof token === "string" ? { ...conn, token } : token;
}

function fail(error: string, output: string): ConnectionError {
  return { error, output };
}
