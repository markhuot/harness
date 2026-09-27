// Static shell-command policy for the PermissionGate (DESIGN.md "Permissions"):
//  - isReadOnlyCommand: a conservative allowlist of commands that can't change anything
//  - hardDenyReason:    patterns that are never allowed, whatever the mode or classifier says
//
// The allowlist parser errs on the side of "not read-only": anything it can't fully account
// for (command substitution, subshells, variables, redirects to files, env-var prefixes,
// unknown commands or flags) falls through to the mode's slow path (a human or the classifier).

export type Segment = string[];

export interface ParsedCommand {
  /** Simple commands, split on ; && || | & and newlines, as argv lists (quotes removed) */
  segments: Segment[];
  /** Why the command can't be fast-allowed, when the parser saw something it won't reason about */
  unsafe: string | null;
}

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "\n"]);

/**
 * Tokenize a bash command line into simple commands. Handles single/double quotes and
 * backslash escapes. Output redirects are only accepted when they go to /dev/null or
 * duplicate a file descriptor (2>&1); anything else marks the command unsafe.
 */
export function parseCommand(command: string): ParsedCommand {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let unsafe: string | null = null;
  const flag = (why: string) => {
    unsafe ??= why;
  };
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };

  const s = command;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) {
        flag("unterminated quote");
        break;
      }
      word += s.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        const d = s[j]!;
        if (d === "\\" && j + 1 < s.length) {
          word += s[++j];
          continue;
        }
        if (d === "$") flag("variable or command substitution");
        if (d === "`") flag("command substitution");
        word += d;
      }
      if (j >= s.length) {
        flag("unterminated quote");
        break;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (s[i + 1] === "\n") {
        i += 2; // line continuation
        continue;
      }
      if (i + 1 < s.length) word += s[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "$") flag("variable or command substitution");
    if (c === "`") flag("command substitution");
    if (c === "(" || c === ")") flag("subshell or process substitution");
    if (c === "{" || c === "}") {
      // brace expansion inside a word (file.{ts,js}) is harmless; a bare { } is a command group
      if (!inWord && (s[i + 1] === undefined || /[\s;]/.test(s[i + 1]!))) flag("command group");
    }
    if (c === "#" && !inWord) flag("comment");
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "\n" || c === ";") {
      endSegment();
      i++;
      continue;
    }
    if (c === "&") {
      if (s[i + 1] === "&") {
        endSegment();
        i += 2;
        continue;
      }
      if (s[i + 1] === ">") {
        // &>file / &>>file
        endWord();
        i += s[i + 2] === ">" ? 3 : 2;
        i = redirectTarget(s, i, flag);
        continue;
      }
      flag("background job");
      endSegment();
      i++;
      continue;
    }
    if (c === "|") {
      if (s[i + 1] === "|") {
        endSegment();
        i += 2;
        continue;
      }
      endSegment();
      i += s[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === ">" || c === "<") {
      // A digits-only word right before the operator is its file descriptor (2>).
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      if (c === "<") {
        if (s[i + 1] === "<") {
          flag("heredoc");
          i += 2;
          continue;
        }
        if (s[i + 1] === "(") {
          flag("process substitution");
          i++;
          continue;
        }
        // input redirect: `< file` reads, which is fine; the file name is not an argument
        i++;
        i = skipWord(s, i);
        continue;
      }
      i += s[i + 1] === ">" ? 2 : 1;
      if (s[i] === "&") {
        // >&2, 2>&1: fd duplication
        i++;
        const m = /^\s*(\d+|-)/.exec(s.slice(i));
        if (!m) flag("redirect");
        else i += m[0].length;
        continue;
      }
      if (s[i] === "(") {
        flag("process substitution");
        continue;
      }
      i = redirectTarget(s, i, flag);
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endSegment();
  return { segments, unsafe };
}

function skipWord(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  const m = /^("[^"]*"|'[^']*'|[^\s;&|<>()]+)/.exec(s.slice(i));
  return i + (m ? m[0].length : 0);
}

/** Parse an output-redirect target; only /dev/null keeps the command read-only. */
function redirectTarget(s: string, i: number, flag: (why: string) => void): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  const m = /^("[^"]*"|'[^']*'|[^\s;&|<>()]+)/.exec(s.slice(i));
  const target = m ? m[0].replace(/^["']|["']$/g, "") : "";
  if (target !== "/dev/null") flag(target ? `writes to ${target}` : "redirect");
  return i + (m ? m[0].length : 0);
}

// ---------------------------------------------------------------------------
// Read-only allowlist
// ---------------------------------------------------------------------------

/** Commands that only read, whatever their flags (no flag of theirs writes or executes). */
const ALWAYS_READ_ONLY = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "grep", "egrep", "fgrep", "which", "file", "stat", "du", "df",
  "tree", "diff", "cmp", "cut", "tr", "basename", "dirname", "realpath", "readlink", "true", "false", "nl", "jq",
  "whoami", "uname", "test", "[", "comm", "column", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cd",
  "type", "printf", "rev", "fold", "expand", "hexdump", "xxd", "od", "strings", "lsof",
]);

const FIND_BAD = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** git subcommands that never change the repository or the working tree. */
const GIT_READ_ONLY = new Set([
  "status", "diff", "log", "show", "blame", "shortlog", "describe", "rev-parse", "ls-files", "ls-tree", "cat-file",
  "grep", "rev-list", "merge-base", "show-ref", "name-rev", "whatchanged", "count-objects", "check-ignore", "help", "version",
]);
const GIT_BAD_ARGS = /^(--output(=|$)|--ext-diff$|-O|--open-files-in-pager)/;
const GIT_BRANCH_MUTATING = /^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|--edit-description|--track|--no-track)(=|$)/;

function gitReadOnly(args: string[]): boolean {
  let i = 0;
  // global options before the subcommand
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    if (a === "--no-pager" || a === "--no-optional-locks" || a === "-P") i++;
    else if (a === "-C") i += 2;
    else return false; // -c key=value, --git-dir, --exec-path, ... can run arbitrary code
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return false;
  if (rest.some((a) => GIT_BAD_ARGS.test(a))) return false;
  if (GIT_READ_ONLY.has(sub)) return true;
  switch (sub) {
    case "branch":
      if (rest.some((a) => GIT_BRANCH_MUTATING.test(a))) return false;
      // positional args create a branch unless listing (--list / -l / --contains <x> / ...)
      return rest.every((a) => a.startsWith("-")) || rest.some((a) => a === "--list" || a === "-l");
    case "tag":
      if (rest.some((a) => /^(-d|-a|-s|-u|-f|-m|-F|--delete|--annotate|--sign|--force|--message|--file)(=|$)/.test(a))) return false;
      return rest.length === 0 || rest.some((a) => a === "-l" || a === "--list");
    case "remote":
      return rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) || rest[0] === "get-url";
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "worktree":
      return rest[0] === "list";
    case "config":
      return rest.some((a) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(a)) && !rest.some((a) => /^--(add|unset|replace-all|edit|rename-section|remove-section)/.test(a) || a === "-e");
    case "reflog":
      return rest.length === 0 || rest[0] === "show";
    default:
      return false;
  }
}

function segmentReadOnly(argv: Segment): boolean {
  const [cmd, ...args] = argv;
  if (!cmd) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) return false; // VAR=value prefix (GIT_PAGER=..., PATH=...)
  if (cmd.includes("/")) return false; // ./script, /tmp/ls: not the real tool
  if (ALWAYS_READ_ONLY.has(cmd)) return true;
  switch (cmd) {
    case "find":
      return !args.some((a) => FIND_BAD.has(a));
    case "rg":
      return !args.some((a) => a.startsWith("--pre"));
    case "sort":
      return !args.some((a) => a === "-o" || a.startsWith("--output") || /^-[a-zA-Z]*o/.test(a));
    case "uniq":
      return args.filter((a) => !a.startsWith("-")).length <= 1; // a second path is the output file
    case "git":
      return gitReadOnly(args);
    default:
      return false;
  }
}

/** True only when every part of the command is on the read-only allowlist. */
export function isReadOnlyCommand(command: string): boolean {
  if (!command.trim()) return false;
  const parsed = parseCommand(command);
  if (parsed.unsafe) return false;
  return parsed.segments.length > 0 && parsed.segments.every(segmentReadOnly);
}

// ---------------------------------------------------------------------------
// Hard deny
// ---------------------------------------------------------------------------

const CRITICAL_PATH = /^(\/|\/\*|~|~\/|~\/\*|\$HOME|\$\{HOME\}|\$HOME\/\*?|\$\{HOME\}\/\*?|\/(Users|home|System|Library|usr|bin|sbin|etc|var|private|Applications|opt|Volumes)\/?\*?)$/;

/** Rough, quote-insensitive split of a command into words per simple command (hard-deny only). */
function roughSegments(command: string): string[][] {
  return command
    .replace(/["']/g, "")
    .split(/&&|\|\||[;|&\n()`]|\$\(/)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((w) => w.length > 0);
}

function stripPrefixes(words: string[]): string[] {
  let i = 0;
  while (i < words.length && (["sudo", "command", "exec", "nohup", "time", "env", "xargs"].includes(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || (i > 0 && words[i]!.startsWith("-") && ["sudo", "env", "xargs"].includes(words[i - 1]!)))) i++;
  return words.slice(i);
}

function recursiveOnCritical(args: string[], recursiveFlag: RegExp): boolean {
  const flags = args.filter((a) => a.startsWith("-"));
  const targets = args.filter((a) => !a.startsWith("-"));
  return flags.some((f) => recursiveFlag.test(f)) && targets.some((t) => CRITICAL_PATH.test(t));
}

/**
 * A reason when the command matches a never-allowed pattern (system-destroying deletes,
 * piping a download into a shell, force-pushing main, disk wipes, fork bombs); else null.
 */
export function hardDenyReason(command: string): string | null {
  const flat = command.replace(/\s+/g, " ");
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(flat)) return "fork bomb";
  if (/\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|fi|c|tc)?sh\b/.test(flat)) return "piping a download into a shell";
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(python\d*(\.\d+)?|perl|ruby|node|bun|deno)\s*(-\s*)?($|[;&|)])/.test(flat)) return "piping a download into an interpreter";
  if (/\b(ba|z)?sh\b\s+(-c\s+)?["']?(\$\(|`|<\()\s*(curl|wget)\b/.test(flat)) return "running a downloaded script";
  if (/\bmkfs(\.\w+)?\b/.test(flat) || /\bdiskutil\s+(erase\w*|zeroDisk|secureErase|partitionDisk|reformat)\b/.test(flat)) return "formatting a disk";
  if (/\bdd\b[^;&|]*\bof=\/dev\/(r?disk|sd|nvme|hd)/.test(flat) || />\s*\/dev\/(r?disk|sd[a-z]|nvme)/.test(flat)) return "writing to a raw disk device";

  for (const raw of roughSegments(command)) {
    const words = stripPrefixes(raw);
    const [cmd, ...args] = words;
    if (!cmd) continue;
    const name = cmd.split("/").pop()!;
    if (name === "rm" && recursiveOnCritical(args, /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/)) return `recursive delete of ${args.find((t) => CRITICAL_PATH.test(t))}`;
    if ((name === "chmod" || name === "chown") && recursiveOnCritical(args, /^(-[a-zA-Z]*R[a-zA-Z]*|--recursive)$/)) return `recursive ${name} of ${args.find((t) => CRITICAL_PATH.test(t))}`;
    if (["shutdown", "reboot", "halt", "poweroff"].includes(name)) return `${name} of the machine`;
    if (name === "git") {
      const push = args.indexOf("push");
      if (push === -1) continue;
      const rest = args.slice(push + 1);
      const force = rest.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith("+"));
      const del = rest.some((a) => a === "-d" || a === "--delete" || /^:(main|master)$/.test(a));
      const main = rest.some((a) => /^\+?([^:]*:)?(refs\/heads\/)?(main|master)$/.test(a));
      if (main && force) return "force-pushing main/master";
      if (main && del) return "deleting the remote main/master branch";
    }
  }
  return null;
}
