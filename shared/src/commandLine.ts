// Show an argv (a watcher's command + args, spawned without a shell) as one shell-style line,
// for approval cards and tool summaries. Display only: nothing parses it back.

const SAFE = /^[A-Za-z0-9_@%+=:,./~-]+$/;

/** POSIX single-quoting when needed: `it's` → `'it'\''s'`, `a b` → `'a b'`, `ls` → `ls`. */
export function shellQuote(arg: string): string {
  if (arg !== "" && SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(shellQuote).join(" ");
}
