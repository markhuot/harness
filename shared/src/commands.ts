// Slash commands and skills in prompts and messages, like Claude Code's: `/code-walk this branch`.
// The agent's driver lists what its agent offers (claude-code: the CLI's own commands, skills and
// plugin commands for the working directory) and passes the text through untouched; the agent
// expands the command itself. Like the CLI, only a `/` that starts the text is a command. The
// composers use activeCommand and insertCommand to autocomplete it; the service uses
// rankCommands to answer the autocomplete.

/** A slash command or skill the agent offers, as its driver reports it. */
export interface CommandMatch {
  /** Typed after the slash: "code-walk", "vercel:deploy". */
  name: string;
  description: string;
  /** What the command takes after its name ("[pr number]"), when it says. */
  argumentHint?: string;
}

/** The command the caret is in: text[start, end) is replaced when one is picked. */
export interface ActiveCommand {
  start: number;
  end: number;
  /** What's typed between the / and the caret. */
  query: string;
}

/** The command being typed at `caret`: a `/` at the very start of the text, then no whitespace up to the caret. */
export function activeCommand(text: string, caret: number): ActiveCommand | null {
  if (caret < 1 || caret > text.length || text[0] !== "/") return null;
  const query = text.slice(1, caret);
  if (/\s/.test(query)) return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return { start: 0, end, query };
}

/** Replace the active command with `/name `, the caret after the space so the arguments follow. */
export function insertCommand(text: string, command: ActiveCommand, name: string): { text: string; caret: number } {
  const token = `/${name}`;
  const after = text.slice(command.end);
  const space = /^\s/.test(after) ? "" : " ";
  return { text: text.slice(0, command.start) + token + space + after, caret: command.start + token.length + 1 };
}

/**
 * Rank `commands` for the autocomplete, best first: the name starts with the query, then a part
 * of it after a ":" or "-" does ("deploy" → vercel:deploy), then the name contains it. Only when
 * no name matches do descriptions count ("summary" → compact): next to real matches they're noise
 * (every skill that mentions "code"). Case-insensitive; ties keep the driver's order, which puts
 * the user's own skills first. An empty query lists everything. Names with whitespace (MCP prompts
 * like "claude.ai Figma:… (MCP)") can't be typed as one word, so they're left out.
 */
export function rankCommands(commands: readonly CommandMatch[], query: string, limit = 50): CommandMatch[] {
  const q = query.toLowerCase();
  const scored: { c: CommandMatch; score: number; i: number }[] = [];
  commands.forEach((c, i) => {
    if (!c.name || /\s/.test(c.name)) return;
    const score = q ? commandScore(c, q) : 0;
    if (score >= 0) scored.push({ c, score, i });
  });
  const named = scored.filter((s) => s.score < BY_DESCRIPTION);
  const kept = named.length ? named : scored;
  kept.sort((a, b) => a.score - b.score || a.i - b.i);
  return kept.slice(0, limit).map((s) => s.c);
}

const BY_DESCRIPTION = 3;

function commandScore(c: CommandMatch, q: string): number {
  const name = c.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.split(/[:\-_]/).some((part) => part.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  if (c.description.toLowerCase().includes(q)) return BY_DESCRIPTION;
  return -1;
}
