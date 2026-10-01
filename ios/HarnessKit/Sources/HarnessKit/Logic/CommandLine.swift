import Foundation

// Port of shared/src/commandLine.ts: a watcher's (or tool call's) command as one line for approval
// cards and tool summaries. Display only: nothing parses it back. Like `watcherCommandLine`,
// except that a shell running one line (`/bin/zsh -lc "<line>"`) shows that line as written
// instead of re-quoting it, so the human approving it reads the command the user asked for.
//
// Named `ShellCommandLine` so it doesn't shadow Swift's `CommandLine`. The regexes are matched on
// Unicode scalars, as JS matches code units (a trailing combining mark is part of the string).

public enum ShellCommandLine {
    public static func commandLine(_ command: String, args: [String] = []) -> String {
        if args.count == 2, isShellFlag(args[0]), isShell(command) { return args[1] }
        return Watchers.watcherCommandLine(command: command, args: args)
    }

    /// `/^-l?c$/`
    static func isShellFlag(_ s: String) -> Bool {
        let scalars = Array(s.unicodeScalars)
        return scalars == ["-", "c"] || scalars == ["-", "l", "c"]
    }

    /// `/(^|\/)(zsh|bash|sh)$/`
    static func isShell(_ command: String) -> Bool {
        let s = Array(command.unicodeScalars)
        for name in ["zsh", "bash", "sh"] {
            let n = Array(name.unicodeScalars)
            guard s.count >= n.count, Array(s.suffix(n.count)) == n else { continue }
            let rest = s.dropLast(n.count)
            if rest.isEmpty || rest.last == "/" { return true }
        }
        return false
    }
}
