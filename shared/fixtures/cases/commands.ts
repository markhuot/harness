// Slash commands (shared/src/commands.ts) for HarnessKit's Commands.swift. Carets are UTF-16 offsets.
import { type ActiveCommand, activeCommand, type CommandMatch, insertCommand, rankCommands } from "../../src/commands";
import { cases } from "../case";

/** `|` marks the caret (as in commands.test.ts). */
const at = (s: string) => ({ text: s.replace("|", ""), caret: s.indexOf("|") });

export const activeCommandCases = cases(({ text, caret }: { text: string; caret: number }) => activeCommand(text, caret), {
  // commands.test.ts
  "slash at the start": at("/co|"),
  "bare slash": at("/|"),
  "slash after text": at("see /co|"),
  "slash after a space": at(" /co|"),
  "slash inside a path": at("src/co|"),
  "caret in the arguments": at("/code-walk this|"),
  "caret right after the space": at("/code-walk |"),
  "caret before the slash": at("|/code"),
  "caret mid-name": at("/co|de-walk this branch"),
  // more
  "empty text": { text: "", caret: 0 },
  "caret past the end": { text: "/co", caret: 4 },
  "negative caret": { text: "/co", caret: -1 },
  "name ends at a newline": at("/co|de\nmore"),
  "name ends at NBSP": at("/co|de x"),
  "NEL is not whitespace": at("/co|de\u0085x"),
  "tab in the query": at("/a\tb|"),
  "emoji name": at("/😀|x y"),
  "combining mark name": at("/é|"),
  "second line slash": at("x\n/co|"),
});

type InsertInput = { text: string; command: ActiveCommand; name: string };
const pick = (s: string, name: string): InsertInput => {
  const { text, caret } = at(s);
  return { text, command: activeCommand(text, caret)!, name };
};

export const insertCommandCases = cases(({ text, command, name }: InsertInput) => insertCommand(text, command, name), {
  // commands.test.ts
  "replaces the typed name": pick("/co|", "code-walk"),
  "keeps the arguments": pick("/co| this branch", "code-walk"),
  "replaces the whole word mid-name": pick("/co|walk", "code-walk"),
  // more
  "newline after keeps it": pick("/co|\nmore", "code-walk"),
  "NBSP after keeps it": pick("/co| more", "code-walk"),
  "emoji name counts UTF-16": pick("/|", "😀"),
  "namespaced name": pick("/dep|", "vercel:deploy"),
  "empty name": pick("/|", ""),
});

const cmds: CommandMatch[] = [
  { name: "code-walk", description: "Walk a user through code (user)" },
  { name: "vercel:deploy", description: "Deploy the current project to Vercel" },
  { name: "review-on-staging", description: "Merge into staging for a code review" },
  { name: "code-review", description: "Review the current diff" },
  { name: "compact", description: "Clear history but keep a summary" },
  { name: "claude.ai Figma:create_rules (MCP)", description: "Figma rules" },
];

type RankInput = { commands: CommandMatch[]; query: string; limit?: number };

export const rankCommandsCases = cases(({ commands, query, limit }: RankInput) => rankCommands(commands, query, limit), {
  // commands.test.ts
  review: { commands: cmds, query: "review" },
  deploy: { commands: cmds, query: "deploy" },
  ode: { commands: cmds, query: "ode" },
  "description only": { commands: cmds, query: "summary" },
  "description current": { commands: cmds, query: "current" },
  "names beat descriptions": { commands: cmds, query: "code" },
  "ties keep driver order": { commands: cmds, query: "co" },
  "case-insensitive": { commands: cmds, query: "VERCEL" },
  "empty lists everything typeable": { commands: cmds, query: "" },
  "whitespace names never show": { commands: cmds, query: "figma" },
  "no match": { commands: cmds, query: "zzz" },
  "limit 2": { commands: cmds, query: "", limit: 2 },
  // more
  "limit 0": { commands: cmds, query: "", limit: 0 },
  "negative limit slices from the end": { commands: cmds, query: "", limit: -2 },
  "underscore part": { commands: [{ name: "a_bc", description: "" }, { name: "xbc", description: "" }], query: "bc" },
  "empty name skipped": { commands: [{ name: "", description: "anything" }, { name: "x", description: "anything" }], query: "any" },
  "tab and NBSP names skipped": { commands: [{ name: "a\tb", description: "" }, { name: "a b", description: "" }, { name: "a\u0085b", description: "" }], query: "a" },
  "argument hint kept": { commands: [{ name: "pr", description: "Open a PR", argumentHint: "[number]" }], query: "p" },
  "final sigma in a description": { commands: [{ name: "x", description: "ΟΔΟΣ" }], query: "οδος" },
  "unicode lower-casing in a name": { commands: [{ name: "Über", description: "" }], query: "üb" },
  "colon part prefix ranks before contains": { commands: [{ name: "xdeploy", description: "" }, { name: "a:deploy", description: "" }], query: "dep" },
} satisfies Record<string, RankInput>);
