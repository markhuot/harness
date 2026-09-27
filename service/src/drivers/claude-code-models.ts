// claude-code model list. The authoritative source is the CLI itself: in stream-json input
// mode it answers an SDK `initialize` control request with (among other things) the models
// the account may use: the same list `/model` shows, already filtered by the org's
// availableModels policy. No user message is sent, so no tokens are spent.

import { tmpdir } from "node:os";
import type { ModelInfo } from "@harness/shared";
import { ModelListError } from "./types";

/** Used when the CLI can't be asked: the aliases every CLI version understands. */
export const CLAUDE_MODEL_ALIASES: ModelInfo[] = [
  { id: "sonnet", name: "Sonnet", description: "Latest Sonnet" },
  { id: "opus", name: "Opus", description: "Latest Opus" },
  { id: "fable", name: "Fable", description: "Latest Fable" },
  { id: "haiku", name: "Haiku", description: "Latest Haiku" },
];

export const INITIALIZE_REQUEST_ID = "harness-models-1";

export function initializeRequest(): string {
  return JSON.stringify({ type: "control_request", request_id: INITIALIZE_REQUEST_ID, request: { subtype: "initialize" } });
}

interface CliModel {
  value?: unknown;
  displayName?: unknown;
  description?: unknown;
  resolvedModel?: unknown;
}

/**
 * Translate the initialize response's `models` into ModelInfo[]. The CLI lists a synthetic
 * "default" entry (what runs without --model); a null model already means that, so the entry
 * is dropped and the real model it resolves to is marked default instead. When no listed
 * model matches, the "default" entry is kept (as the default) so nothing is lost.
 */
export function parseClaudeModels(models: unknown): ModelInfo[] {
  if (!Array.isArray(models)) throw new Error("initialize response has no models list");
  const entries = (models as CliModel[]).filter((m) => m && typeof m.value === "string" && m.value);
  const def = entries.find((m) => m.value === "default");
  const defResolved = typeof def?.resolvedModel === "string" ? def.resolvedModel : null;
  const out: ModelInfo[] = [];
  let marked = false;
  for (const m of entries) {
    if (m === def) continue;
    const info: ModelInfo = {
      id: m.value as string,
      name: typeof m.displayName === "string" && m.displayName ? m.displayName : (m.value as string),
    };
    if (typeof m.description === "string" && m.description) info.description = m.description;
    if (!marked && defResolved && (m.resolvedModel === defResolved || m.value === defResolved)) {
      info.default = true;
      marked = true;
    }
    out.push(info);
  }
  if (def && !marked) {
    const desc = typeof def.description === "string" ? def.description : "";
    // "Opus 5.5 · Best for everyday, complex tasks" → "Opus 5.5"
    const name = desc.split(" · ")[0]?.trim() || (typeof def.displayName === "string" ? def.displayName : "Default");
    out.unshift({ id: "default", name, ...(desc ? { description: desc } : {}), default: true });
  }
  return out;
}

/**
 * Ask the CLI for its models: start it in stream-json input mode, send `initialize`, read
 * lines until the matching control_response, then kill it.
 */
export async function queryClaudeModels(opts: { bin: string; env: Record<string, string>; timeoutMs?: number; cwd?: string }): Promise<ModelInfo[]> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([opts.bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
      cwd: opts.cwd ?? tmpdir(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env,
    });
  } catch (err) {
    throw new ModelListError(`Could not start claude: ${err instanceof Error ? err.message : String(err)}`, CLAUDE_MODEL_ALIASES);
  }
  let stderr = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
      stderr += decoder.decode(chunk, { stream: true });
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
    }
  })().catch(() => {});
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write(initializeRequest() + "\n");
    await stdin.flush();
    const response = await readControlResponse(proc.stdout as ReadableStream<Uint8Array>);
    if (!response) {
      const exit = await Promise.race([proc.exited, Bun.sleep(200).then(() => null)]);
      const tail = stderr.trim().split("\n").filter((l) => l && !/extra certs/i.test(l)).slice(-3).join("\n");
      const why = timedOut ? `timed out after ${timeoutMs} ms` : `exited${exit !== null ? ` with code ${exit}` : ""} without answering`;
      throw new ModelListError(`claude ${why}${tail ? `: ${tail}` : ""}`, CLAUDE_MODEL_ALIASES);
    }
    if (response.subtype !== "success") {
      throw new ModelListError(`claude initialize failed: ${String(response.error ?? response.subtype ?? "unknown error")}`, CLAUDE_MODEL_ALIASES);
    }
    try {
      const models = parseClaudeModels(response.response?.models);
      if (!models.length) throw new Error("claude reported no models");
      return models;
    } catch (err) {
      throw new ModelListError(err instanceof Error ? err.message : String(err), CLAUDE_MODEL_ALIASES);
    }
  } finally {
    clearTimeout(timer);
    try {
      (proc.stdin as import("bun").FileSink).end();
    } catch {}
    if (proc.exitCode === null) proc.kill("SIGTERM");
  }
}

async function readControlResponse(stream: ReadableStream<Uint8Array>): Promise<any | null> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg?.type === "control_response" && msg.response?.request_id === INITIALIZE_REQUEST_ID) return msg.response;
    }
  }
  return null;
}
