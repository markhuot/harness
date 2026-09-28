// Show a watcher's command as one shell-style line, for approval cards and tool summaries.
// Display only: nothing parses it back. A shell command line is shown as-is: a command with no
// args (HARNESS-22 runs it through the login shell) or `/bin/zsh -lc "<line>"`. Other command +
// args (spawned without a shell) are quoted as the argv they are.

const SAFE = /^[A-Za-z0-9_@%+=:,./~-]+$/;

/**
 * POSIX single-quoting when needed: `it's` → `'it'\''s'`, `a b` → `'a b'`, `ls` → `ls`. Not
 * exported: HARNESS-22 adds shellQuote / watcherCommandLine to shared/src/watchers.ts, and
 * commandLine can defer to those once it lands.
 */
function quote(arg: string): string {
  if (arg !== "" && SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** `/bin/zsh -lc "<line>"` and friends: a shell running one command line. */
const SHELL = /(^|\/)(zsh|bash|sh)$/;

export function commandLine(command: string, args: readonly string[] = []): string {
  if (args.length === 0) return command;
  // A shell running one line (the form agents are taught) shows that line as the user wrote it,
  // not re-quoted into one word.
  if (args.length === 2 && /^-l?c$/.test(args[0]!) && SHELL.test(command)) return args[1]!;
  return [command, ...args].map(quote).join(" ");
}
