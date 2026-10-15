import Foundation

/// The terminals the service hosts, kept in step with terminal.* events (shared/src/state: the Mac's
/// applyTerminalEvent) and shaped for the palette.
public enum TerminalList {
    /// The list after a terminal.created / updated / removed event; any other event leaves it as it is.
    public static func apply(_ list: [TerminalInfo], _ event: HarnessEvent) -> [TerminalInfo] {
        switch event {
        case let .terminalCreated(t), let .terminalUpdated(t):
            var next = list
            if let i = next.firstIndex(where: { $0.id == t.id }) { next[i] = t } else { next.append(t) }
            return next
        case let .terminalRemoved(id):
            return list.contains { $0.id == id } ? list.filter { $0.id != id } : list
        default:
            return list
        }
    }

    /// `/Users/me/Sites` → `~/Sites` (a macOS or Linux home folder), for display.
    public static func tildePath(_ path: String) -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        // ["", "Users", "me", ...]
        guard parts.count >= 3, parts[0].isEmpty, parts[1] == "Users" || parts[1] == "home", !parts[2].isEmpty else { return path }
        let rest = parts.dropFirst(3).joined(separator: "/")
        return rest.isEmpty ? "~" : "~/\(rest)"
    }

    /// What a terminal is called in lists: the title its program set, else the program's name.
    public static func label(_ t: TerminalInfo) -> String {
        let title = t.title.trimmingCharacters(in: .whitespaces)
        if !title.isEmpty { return title }
        return t.process.isEmpty ? "Terminal" : t.process
    }

    /// The second line of a list row: where it is and what runs ("~/Sites · node"), or "ended".
    public static func subtitle(_ t: TerminalInfo) -> String {
        [tildePath(t.cwd), t.state == .exited ? "ended" : t.process].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The words a palette query matches a terminal on: title, program and folder.
    public static func keywords(_ t: TerminalInfo) -> [String] {
        [t.cwd, t.process, t.title].filter { !$0.isEmpty }
    }
}
