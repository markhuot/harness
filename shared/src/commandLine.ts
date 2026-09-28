// Show a watcher's command as one shell-style line, for approval cards and tool summaries.
// Display only: nothing parses it back. With no args the command already is a shell command
// line (run through the login shell) and is shown as-is; legacy command + args (spawned without
// a shell) are quoted as the argv they are.

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

export function commandLine(command: string, args: readonly string[] = []): string {
  if (args.length === 0) return command;
  return [command, ...args].map(quote).join(" ");
}
