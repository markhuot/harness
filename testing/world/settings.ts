import type { DriverInfo, PublicSettings } from "@harness/shared";

export const settings: PublicSettings = {
  defaultDriver: "claude-code",
  maxConcurrentRuns: 3,
  contextGaugeLimit: 250_000,
  permissionMode: "auto",
  classifier: "claude-cli",
  defaultModels: { "claude-code": "claude-opus-5-5" },
  reviewModels: {},
  baseBranch: "main",
  anthropicApiKeySet: false,
  cosEnabled: true,
  cosCanUnblock: false,
};

export const drivers: DriverInfo[] = [
  { id: "claude-code", name: "Claude Code", description: "Claude's coding agent", available: true, authenticated: true, detail: "Logged in", supportsLogin: false, reportsContextUsage: true },
  { id: "codex", name: "Codex", description: "OpenAI's coding agent", available: false, authenticated: false, detail: "Not installed", supportsLogin: false },
];
