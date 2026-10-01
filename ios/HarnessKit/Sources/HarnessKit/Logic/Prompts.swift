import Foundation

// Port of shared/src/prompts.ts. Prompt overrides, client side (DESIGN.md "Prompt overrides"): the
// pure logic behind the Settings → Prompts screens. The service owns the catalog (GET /prompts);
// this groups it, labels each prompt's state, validates a draft the way the service will, and turns
// a draft into the settings PATCH.
//
// Text comparisons are by UTF-16 code unit (JS `===`), not Swift's canonical-equivalence `==`: a
// draft that differs from the built-in only in Unicode normalization is still a different override.

public enum Prompts {
    private typealias JS = Mentions.JS

    /// What to show when GET /prompts fails: a service from before prompt overrides answers 404.
    public static func promptsLoadError(_ error: Error) -> String {
        if let api = error as? HarnessAPIError {
            return api.status == 404 ? "This service doesn't support prompt overrides yet. Update Harness to customize prompts." : api.message
        }
        return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    /// A section of the Prompts screen (PROMPT_GROUPS).
    public struct GroupInfo: Codable, Equatable, Sendable {
        public var group: PromptGroup
        public var title: String
        public var description: String
    }

    /// `PROMPT_GROUPS`, in display order.
    public static let groups: [GroupInfo] = [
        GroupInfo(group: .system, title: "System prompt", description: "Sections of a run's system prompt. Harness picks which sections a run gets and puts them in order."),
        GroupInfo(group: .run, title: "Run messages", description: "The message that starts a run."),
    ]

    /// A group with its catalog entries.
    public struct Group: Codable, Equatable, Sendable {
        public var group: PromptGroup
        public var title: String
        public var description: String
        public var entries: [PromptEntry]
    }

    /// The catalog split by group, in `groups` order (catalog order within each); empty groups are
    /// left out, and so are entries in a group this build doesn't know.
    public static func groupPrompts(_ entries: [PromptEntry]) -> [Group] {
        groups
            .map { g in Group(group: g.group, title: g.title, description: g.description, entries: entries.filter { $0.group == g.group }) }
            .filter { !$0.entries.isEmpty }
    }

    /// builtin: no override. customized: the override is what runs get. broken: an override is
    /// stored but no longer validates (usually an app update renamed a variable), so runs get the
    /// built-in.
    public enum State: String, Codable, Sendable, CaseIterable {
        case builtin, customized, broken

        /// PROMPT_STATE_LABELS
        public var label: String {
            switch self {
            case .builtin: "Built-in"
            case .customized: "Customized"
            case .broken: "Not in use"
            }
        }
    }

    public static func promptState(override: String?, overrideError: String?) -> State {
        guard override != nil else { return .builtin }
        // JS truthiness: an empty error string doesn't make it broken.
        return overrideError?.isEmpty == false ? .broken : .customized
    }

    public static func promptState(_ entry: PromptEntry) -> State {
        promptState(override: entry.override, overrideError: entry.overrideError)
    }

    public struct Counts: Codable, Equatable, Sendable {
        public var customized: Int
        public var broken: Int
    }

    /// For a list header: prompts with a stored override (broken ones included), and how many of
    /// those are broken.
    public static func promptCounts(_ entries: [PromptEntry]) -> Counts {
        let states = entries.map(promptState)
        return Counts(customized: states.filter { $0 != .builtin }.count, broken: states.filter { $0 == .broken }.count)
    }

    /// One line for a Settings row: "All built-in", "2 customized" or "2 customized · 1 not in use".
    public static func promptsSummary(_ entries: [PromptEntry]) -> String {
        let c = promptCounts(entries)
        if c.customized == 0 { return "All built-in" }
        return c.broken > 0 ? "\(c.customized) customized · \(c.broken) \(State.broken.label.lowercased())" : "\(c.customized) customized"
    }

    /// The error line under the editor: the service's 400, else the live check of `draft` (nil
    /// while showing the built-in read-only). A broken override's banner already says what's wrong,
    /// so the line stays empty until the user changes the stored text.
    public static func promptErrorLine(_ entry: PromptEntry, draft: String?, serverError: String?) -> String? {
        if let serverError, !serverError.isEmpty { return serverError }
        guard let draft else { return nil }
        if promptState(entry) == .broken, let stored = entry.override, JS.same(draft, stored) { return nil }
        return promptDraftError(entry, draft: draft)
    }

    /// Why the broken override isn't used, for the editor.
    public static func brokenOverrideMessage(_ entry: PromptEntry) -> String {
        JSCompat.trim("Your customization isn't in effect: runs use the built-in prompt until you fix it or reset it. \(entry.overrideError ?? "")")
    }

    /// The error the service would give for saving `draft` as this prompt, or nil. Blank is fine
    /// (it resets).
    public static func promptDraftError(_ entry: PromptEntry, draft: String) -> String? {
        if JSCompat.trim(draft).isEmpty { return nil }
        return Templates.error(draft, allowed: entry.variables.map(\.name))
    }

    /// The text in effect for the editor to start from: the user's override, else the built-in.
    public static func promptStartText(_ entry: PromptEntry) -> String {
        entry.override ?? entry.builtin
    }

    /// True when saving `draft` would change what's stored.
    public static func promptDraftDirty(_ entry: PromptEntry, draft: String) -> Bool {
        switch (promptOverrideFor(entry, draft: draft), entry.override) {
        case (nil, nil): false
        case let (a?, b?): !JS.same(a, b)
        default: true
        }
    }

    /// What storing `draft` means: nil (the built-in) when it's blank, as the service treats it, or
    /// exactly the built-in, so the prompt keeps picking up built-in improvements; otherwise the text.
    public static func promptOverrideFor(_ entry: PromptEntry, draft: String) -> String? {
        JSCompat.trim(draft).isEmpty || JS.same(draft, entry.builtin) ? nil : draft
    }

    /// The settings PATCH that saves `draft` (or resets with nil).
    public static func promptSavePatch(_ entry: PromptEntry, draft: String?) -> SettingsPatch {
        let value = draft.flatMap { promptOverrideFor(entry, draft: $0) }
        return SettingsPatch(prompts: [entry.id.rawValue: value])
    }

    /// `insert` put in place of text[start, end) (UTF-16 offsets), with the caret after it.
    public static func insertText(_ text: String, start: Int, end: Int, insert: String) -> TextInsertion {
        let t = JS.units(text)
        let a = max(0, min(start, t.count))
        let b = max(a, min(end, t.count))
        let ins = JS.units(insert)
        return TextInsertion(text: JS.string(t[..<a] + ins + t[b...]), caret: a + ins.count)
    }

    public struct DiffLine: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable { case same, add, del }
        public var type: Kind
        public var text: String

        public init(type: Kind, text: String) {
            self.type = type
            self.text = text
        }
    }

    /// A line diff turning `from` into `to` (longest common subsequence): deletions come before the
    /// additions that replace them. Prompts are a few hundred lines at most, so O(n·m) is fine.
    /// Lines split on "\n" only, so a CRLF line keeps its "\r".
    public static func lineDiff(from: String, to: String) -> [DiffLine] {
        let a = JS.units(from).split(separator: JS.newline, omittingEmptySubsequences: false).map(Array.init)
        let b = JS.units(to).split(separator: JS.newline, omittingEmptySubsequences: false).map(Array.init)
        let n = a.count
        let m = b.count
        // lcs[i * (m + 1) + j]: the LCS length of a[i...] and b[j...]
        var lcs = [Int](repeating: 0, count: (n + 1) * (m + 1))
        func at(_ i: Int, _ j: Int) -> Int { lcs[i * (m + 1) + j] }
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                lcs[i * (m + 1) + j] = a[i] == b[j] ? at(i + 1, j + 1) + 1 : max(at(i + 1, j), at(i, j + 1))
            }
        }
        var out: [DiffLine] = []
        var i = 0
        var j = 0
        while i < n && j < m {
            if a[i] == b[j] {
                out.append(DiffLine(type: .same, text: JS.string(a[i])))
                i += 1
                j += 1
            } else if at(i + 1, j) >= at(i, j + 1) {
                out.append(DiffLine(type: .del, text: JS.string(a[i])))
                i += 1
            } else {
                out.append(DiffLine(type: .add, text: JS.string(b[j])))
                j += 1
            }
        }
        while i < n { out.append(DiffLine(type: .del, text: JS.string(a[i]))); i += 1 }
        while j < m { out.append(DiffLine(type: .add, text: JS.string(b[j]))); j += 1 }
        return out
    }
}
