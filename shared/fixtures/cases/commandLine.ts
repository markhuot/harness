// Display command lines (shared/src/commandLine.ts) for HarnessKit's CommandLine.swift.
import { commandLine } from "../../src/commandLine";
import { cases } from "../case";

type Input = { command: string; args?: string[] };

export const commandLineCases = cases(({ command, args }: Input) => commandLine(command, args), {
  "bare command": { command: "watch-jira --project=PLAYR --once | jq -c '.[]'" },
  "bare command, empty args": { command: "ls -la", args: [] },
  "login zsh shows the line": { command: "/bin/zsh", args: ["-lc", "while true; do curl -s 'x y'; sleep 60; done"] },
  "bash -c shows the line": { command: "/bin/bash", args: ["-c", "echo $HOME"] },
  "bare sh name": { command: "sh", args: ["-c", "make test"] },
  "bare zsh name": { command: "zsh", args: ["-lc", "ls"] },
  "nested shell path": { command: "/opt/homebrew/bin/bash", args: ["-lc", "it's fine"] },
  "fish isn't a shell here": { command: "/usr/bin/fish", args: ["-c", "ls"] },
  "dash isn't either": { command: "/bin/dash", args: ["-c", "ls"] },
  "name ending in sh": { command: "/usr/bin/ssh", args: ["-c", "host"] },
  "zsh suffix without slash": { command: "myzsh", args: ["-c", "ls"] },
  "shell with trailing newline": { command: "/bin/zsh\n", args: ["-c", "ls"] },
  "shell name with suffix": { command: "/bin/zsh5", args: ["-c", "ls"] },
  "-l alone is argv": { command: "/bin/zsh", args: ["-l", "ls"] },
  "-cl is argv": { command: "/bin/zsh", args: ["-cl", "ls"] },
  "-ic is argv": { command: "/bin/zsh", args: ["-ic", "ls"] },
  "-c with a trailing newline is argv": { command: "/bin/zsh", args: ["-c\n", "ls"] },
  "three args stay argv": { command: "/bin/zsh", args: ["-lc", "ls", "extra"] },
  "one arg stays argv": { command: "/bin/zsh", args: ["-lc"] },
  "empty line shown as is": { command: "/bin/sh", args: ["-c", ""] },
  "legacy argv quoted": { command: "node", args: ["~/Sites/Jira/watch-jira.js", "--project", "FOO BAR", "it's"] },
  "legacy command with space": { command: "/Applications/My Tool/run", args: ["a b"] },
  "trailing slash then name": { command: "/bin//sh", args: ["-c", "ls"] },
  "combining mark after the name": { command: "/bin/sh́", args: ["-c", "ls"] },
  "combining mark after the flag": { command: "/bin/sh", args: ["-ć", "ls"] },
});
