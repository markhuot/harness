// Show a watcher's command as one line for approval cards and tool summaries. Display only:
// nothing parses it back. Like watcherCommandLine (a bare command is already a shell command
// line; legacy command + args are quoted as the argv they are), except that a legacy shell
// running one line (`/bin/zsh -lc "<line>"`) shows that line as written instead of re-quoting it,
// so the human approving it reads the command the user asked for.

import { watcherCommandLine } from "./watchers";

const SHELL = /(^|\/)(zsh|bash|sh)$/;

export function commandLine(command: string, args: readonly string[] = []): string {
  if (args.length === 2 && /^-l?c$/.test(args[0]!) && SHELL.test(command)) return args[1]!;
  return watcherCommandLine({ command, args: [...args] });
}
