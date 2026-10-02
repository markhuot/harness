import Foundation

// Port of shared/src/commands.ts. Slash commands and skills in prompts and messages, like Claude
// Code's: `/code-walk this branch`. The agent's driver lists what its agent offers (claude-code: the
// CLI's own commands, skills and plugin commands for the working directory) and passes the text
// through untouched; the agent expands the command itself. Like the CLI, only a `/` that starts the
// text is a command. The composers use activeCommand and insertCommand to autocomplete it; the
// service uses rankCommands to answer the autocomplete. Offsets are UTF-16 code units.
//
// CommandMatch (the driver's list entry) lives in Protocol/Files.swift.

/// The command the caret is in: text[start, end) (UTF-16 offsets) is replaced when one is picked.
public struct ActiveCommand: Codable, Equatable, Sendable {
    public var start: Int
    public var end: Int
    /// What's typed between the / and the caret.
    public var query: String

    public init(start: Int, end: Int, query: String) {
        self.start = start
        self.end = end
        self.query = query
    }
}

public enum Commands {
    private typealias JS = Mentions.JS

    /// The command being typed at `caret`: a `/` at the very start of the text, then no whitespace
    /// up to the caret.
    public static func activeCommand(_ text: String, caret: Int) -> ActiveCommand? {
        let t = JS.units(text)
        if caret < 1 || caret > t.count || t[0] != JS.slash { return nil }
        let query = t[1..<caret]
        if query.contains(where: JS.isSpace) { return nil }
        var end = caret
        while end < t.count && !JS.isSpace(t[end]) { end += 1 }
        return ActiveCommand(start: 0, end: end, query: JS.string(query))
    }

    /// Replace the active command with `/name `, the caret after the space so the arguments follow.
    public static func insertCommand(_ text: String, command: ActiveCommand, name: String) -> TextInsertion {
        let t = JS.units(text)
        let token = [JS.slash] + JS.units(name)
        let after = JS.slice(t, command.end)
        let space: [UInt16] = after.first.map(JS.isSpace) == true ? [] : [JS.space]
        let next = Array(JS.slice(t, 0, command.start)) + token + space + Array(after)
        return TextInsertion(text: JS.string(next), caret: command.start + token.count + 1)
    }

    /// Rank `commands` for the autocomplete, best first: the name starts with the query, then a part
    /// of it after a ":" or "-" does ("deploy" → vercel:deploy), then the name contains it. Only when
    /// no name matches do descriptions count ("summary" → compact): next to real matches they're
    /// noise (every skill that mentions "code"). Case-insensitive; ties keep the driver's order,
    /// which puts the user's own skills first. An empty query lists everything. Names with
    /// whitespace (MCP prompts like "claude.ai Figma:… (MCP)") can't be typed as one word, so
    /// they're left out.
    public static func rankCommands(_ commands: [CommandMatch], query: String, limit: Int = 50) -> [CommandMatch] {
        let q = JS.units(JS.lowercase(query))
        var scored: [(c: CommandMatch, score: Int, i: Int)] = []
        for (i, c) in commands.enumerated() {
            if c.name.isEmpty || c.name.utf16.contains(where: JS.isSpace) { continue }
            let score = q.isEmpty ? 0 : commandScore(c, q)
            if score >= 0 { scored.append((c, score, i)) }
        }
        let named = scored.filter { $0.score < byDescription }
        var kept = named.isEmpty ? scored : named
        kept.sort { $0.score != $1.score ? $0.score < $1.score : $0.i < $1.i }
        return JS.slice(kept, 0, limit).map(\.c)
    }

    private static let byDescription = 3
    private static let separators = Set(":-_".utf16)

    private static func commandScore(_ c: CommandMatch, _ q: [UInt16]) -> Int {
        let name = JS.units(JS.lowercase(c.name))
        if name.starts(with: q) { return 0 }
        if name.split(omittingEmptySubsequences: false, whereSeparator: separators.contains).contains(where: { $0.starts(with: q) }) { return 1 }
        if JS.contains(name, q) { return 2 }
        if JS.contains(JS.units(JS.lowercase(c.description)), q) { return byDescription }
        return -1
    }
}
