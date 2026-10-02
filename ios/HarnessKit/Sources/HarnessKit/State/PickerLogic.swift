import Foundation

// The decisions behind the app's pickers and form controls (Features/Pickers: the select menus,
// DriverModelPicker, BranchPicker, ProjectColorPicker, MentionTextEditor, TicketSettingsForm),
// pulled out of the views so they can be tested. The option lists themselves come from the shared
// ports (Models, BranchRows, Drafts, Permissions); this file only holds the glue between them and
// the views.

/// One row of a select menu (a typed SelectOption).
public struct PickerOption<Value: Hashable & Sendable>: Hashable, Sendable {
    public var value: Value
    public var label: String
    public var subtitle: String?
    public var disabled: Bool

    public init(value: Value, label: String, subtitle: String? = nil, disabled: Bool = false) {
        self.value = value
        self.label = label
        self.subtitle = subtitle
        self.disabled = disabled
    }
}

/// A row of the @-mention / slash-command list.
public enum MentionItem: Equatable, Sendable {
    case file(FileMatch)
    case command(CommandMatch)
}

/// What the caret is in: a leading /command or an @mention.
public enum MentionTarget: Equatable, Sendable {
    case command(ActiveCommand)
    case mention(ActiveMention)

    /// The lookup key: "/" and "@" keep the two lookups apart when the query text is the same.
    public var lookup: String {
        switch self {
        case let .command(c): "/\(c.query)"
        case let .mention(m): "@\(m.query)"
        }
    }

    public var query: String {
        switch self {
        case let .command(c): c.query
        case let .mention(m): m.query
        }
    }

    public var isCommand: Bool {
        if case .command = self { return true }
        return false
    }
}

/// How a mention row draws (MentionList): an icon, the name, the muted detail after it, and the AX label.
public struct MentionRowDisplay: Equatable, Sendable {
    /// Shared icon name: "folder", "fileText" or "zap"
    public var icon: String
    public var name: String
    public var detail: String
    /// The row's accessibility label: the full path, or "/name" (sim-check taps these)
    public var label: String
    /// A file's directory is cut at its start when it doesn't fit ("…src/lib/"), a description at its end
    public var truncateHead: Bool
}

/// What the hex field does with what was typed.
public enum HexCommit: Equatable, Sendable {
    /// A new custom color to save
    case pick(String)
    /// The same color as now: nothing to save
    case keep
    /// Not a color: put the field back to this (the current custom color, or "")
    case revert(String)
}

public enum PickerLogic {
    // MARK: Select menus

    /// The menu's error line when a driver's model list failed: `error ?? data.error`.
    public static func modelListProblem(_ s: ModelListState) -> String? {
        Models.nonEmpty(s.error ?? s.data?.error)
    }

    /// PermissionPicker's options: "Default (<inherited>)" when there's something to inherit, then
    /// every known mode with its description. nil is the Default row.
    public static func permissionOptions(inherited: PermissionMode?) -> [PickerOption<PermissionMode?>] {
        var out: [PickerOption<PermissionMode?>] = []
        if let inherited { out.append(PickerOption(value: nil, label: "Default (\(Format.permissionModeLabel(inherited)))")) }
        for m in PermissionMode.allKnown {
            out.append(PickerOption(value: m, label: Format.permissionModeLabel(m), subtitle: Permissions.label(for: m)?.description))
        }
        return out
    }

    /// PermissionPicker's trigger: the mode, "Default · <inherited>", or "Default".
    public static func permissionLabel(value: PermissionMode?, inherited: PermissionMode?) -> String {
        if let value { return Format.permissionModeLabel(value) }
        if let inherited { return "Default · \(Format.permissionModeLabel(inherited))" }
        return "Default"
    }

    // MARK: DriverModelPicker

    /// The drivers whose model lists the picker loads: every installed, signed-in driver (or only
    /// `onlyDriver`), plus the picked and the resolved driver, without repeats, in that order.
    public static func choiceDriverIds(_ drivers: [DriverInfo], value: TriageChoice, resolved: TriageChoice, onlyDriver: String?) -> [String] {
        let signedIn = Models.nonEmpty(onlyDriver).map { [$0] } ?? drivers.filter { $0.available && $0.authenticated }.map(\.id)
        var seen = Set<String>()
        var out: [String] = []
        for id in signedIn + [value.driver, resolved.driver].compactMap({ $0 }) where !id.isEmpty && seen.insert(id).inserted {
            out.append(id)
        }
        return out
    }

    /// The trigger's state over those lists: a spinner while any list has nothing yet, else a warning
    /// naming the first driver whose list failed.
    public static func choiceListsStatus(_ ids: [String], lists: (String) -> ModelListState, name: (String) -> String) -> (loading: Bool, problem: String?) {
        let loading = ids.contains { lists($0).loading && lists($0).data == nil }
        for id in ids {
            if let error = modelListProblem(lists(id)) { return (loading, "Couldn't list \(name(id)) models: \(error)") }
        }
        return (loading, nil)
    }

    /// The accessibility label of a row in the model sheet: "<driver>, <model>" under a heading.
    public static func choiceRowLabel(section: String?, label: String) -> String {
        Models.nonEmpty(section).map { "\($0), \(label)" } ?? label
    }

    // MARK: MentionTextEditor

    /// What the caret is typing. With commands on, a /command at the start of the text wins over an
    /// @ inside it.
    public static func mentionTarget(_ text: String, caret: MentionCaret, commands: Bool) -> MentionTarget? {
        if commands, let c = caret.commandAt(text) { return .command(c) }
        return caret.mentionAt(text).map(MentionTarget.mention)
    }

    /// The text and caret after picking `item` for `target`; nil when the row doesn't fit the target
    /// (a stale file row while a command is typed, or the other way round).
    public static func pickMention(_ text: String, target: MentionTarget, item: MentionItem) -> TextInsertion? {
        switch (target, item) {
        case let (.command(c), .command(m)): Commands.insertCommand(text, command: c, name: m.name)
        case let (.mention(a), .file(f)): Mentions.insertMention(text, mention: a, path: f.path)
        default: nil
        }
    }

    /// A row's icon, name and detail: a file shows its name with its folder after it, a folder its
    /// name with a trailing "/", a command "/name" and its description.
    public static func mentionRow(_ item: MentionItem) -> MentionRowDisplay {
        switch item {
        case let .command(m):
            let name = "/\(m.name)"
            return MentionRowDisplay(icon: "zap", name: name, detail: m.description, label: name, truncateHead: false)
        case let .file(f):
            var scalars = Array(f.path.unicodeScalars)
            if scalars.last == "/" { scalars.removeLast() }
            let dir = f.kind == .dir
            let slash = scalars.lastIndex(of: "/")
            let base = String(String.UnicodeScalarView(slash.map { scalars[($0 + 1)...] } ?? scalars[...]))
            let detail = slash.map { String(String.UnicodeScalarView(scalars[...$0])) } ?? ""
            return MentionRowDisplay(icon: dir ? "folder" : "fileText", name: base + (dir ? "/" : ""), detail: detail, label: f.path, truncateHead: true)
        }
    }

    // MARK: Text offsets

    /// A String.Index as a UTF-16 offset (MentionCaret's unit), clamped to the text.
    public static func utf16Offset(_ index: String.Index, in text: String) -> Int {
        let i = min(max(index, text.startIndex), text.endIndex)
        return text.utf16.distance(from: text.startIndex, to: i)
    }

    /// A UTF-16 offset as a String.Index, clamped to the text and moved off a split surrogate pair.
    public static func index(utf16 offset: Int, in text: String) -> String.Index {
        let u = text.utf16
        let i = u.index(u.startIndex, offsetBy: max(0, min(offset, u.count)))
        return i.samePosition(in: text.unicodeScalars) ?? u.index(before: i)
    }

    // MARK: ProjectColorPicker

    static let gridHues: [Double] = [0, 30, 45, 60, 90, 140, 170, 190, 210, 235, 270, 310]
    static let gridLightness: [Double] = [82, 68, 55, 45, 35, 25]

    /// HSL (degrees, percent, percent) as "#rrggbb", rounded like `Math.round`.
    public static func hslHex(_ h: Double, _ s: Double, _ l: Double) -> String {
        let sat = s / 100
        let lig = l / 100
        let a = sat * min(lig, 1 - lig)
        func f(_ n: Double) -> String {
            let k = (n + h / 30).truncatingRemainder(dividingBy: 12)
            let v = lig - a * max(-1, min(k - 3, 9 - k, 1))
            return String(format: "%02x", Int(JSCompat.round(v * 255)))
        }
        return "#\(f(0))\(f(8))\(f(4))"
    }

    /// The custom grid: one row per shade across every hue, then a gray ramp (`CUSTOM_GRID`).
    public static let customGrid: [[String]] =
        gridLightness.map { l in gridHues.map { hslHex($0, 80, l) } }
        + [gridHues.indices.map { i in hslHex(0, 0, JSCompat.round(92 - Double(i) * 84 / Double(gridHues.count - 1))) }]

    /// The hex field's commit: a valid "#rrggbb" or "#rgb" (with or without the "#") that differs
    /// from `current` is picked; anything else puts the field back.
    public static func commitHex(_ typed: String, current: String?) -> HexCommit {
        let custom = current.flatMap { $0.hasPrefix("#") ? $0 : nil }
        let n = ProjectColors.normalize(typed.hasPrefix("#") ? typed : "#\(typed)").stored
        guard let n, n.hasPrefix("#") else { return .revert(custom ?? "") }
        return n == current ? .keep : .pick(n)
    }

    // MARK: TicketSettingsForm

    /// The hints beside each row's label. A draft (New session's Options) shows none of them.
    public struct TicketSettingsHints: Equatable, Sendable {
        public var model: String?
        public var permissions: String?
        public var branch: String?
        public var base: String?
    }

    public static func ticketSettingsHints(_ t: Ticket, rows: Drafts.TicketSettingsRows) -> TicketSettingsHints {
        if t.draft == true { return TicketSettingsHints() }
        return TicketSettingsHints(
            model: t.busy ? "Applies from the next run. The driver can't change while a run is going." : "Applies from the next run",
            permissions: "Applies from the next tool call",
            branch: rows.branch.editable ? "Until work starts" : Models.nonEmpty(t.branch) == nil ? "When work starts" : nil,
            base: Models.nonEmpty(t.baseBranch.optional) != nil ? "Applies from the next run" : "Inherited"
        )
    }

    /// The Depends on field's keys (split on commas and whitespace, upper-cased) and the ones that
    /// aren't ticket keys.
    public static func parseDependsOn(_ text: String) -> (keys: [String], bad: [String]) {
        let keys = text.unicodeScalars
            .split { $0 == "," || JSCompat.isWhitespace($0) }
            .map { String(String.UnicodeScalarView($0)).uppercased() }
            .filter { !$0.isEmpty }
        return (keys, keys.filter { !Keys.isTicketKey($0) })
    }

    /// What saving the Depends on field sends: nil while a key is bad or nothing changed.
    public static func dependsOnSave(_ text: String, current: [String]) -> [String]? {
        let (keys, bad) = parseDependsOn(text)
        guard bad.isEmpty, keys != current else { return nil }
        return keys
    }

    /// A Remote ID save as the ticket PATCH: a link (with its URL or null), or unlink. nil for errors.
    public static func remoteIdBody(_ patch: Related.RemoteIdPatch) -> UpdateTicketBody? {
        switch patch {
        case let .link(key, url): UpdateTicketBody(externalRef: .value(ExternalRefInput(key: key, url: url.map(Patch.value) ?? .null)))
        case .unlink: UpdateTicketBody(externalRef: .null)
        case .error: nil
        }
    }
}

/// The project's branches the Branch row's hint classifies against: the list the service returns
/// (capped), plus branches picked in the sheet or looked up by name, which the capped list may not
/// reach. Picked entries win.
public struct TicketBranchList: Equatable, Sendable {
    public var list: [BranchInfo] = []
    public var picked: [BranchInfo] = []

    public init(list: [BranchInfo] = [], picked: [BranchInfo] = []) {
        self.list = list
        self.picked = picked
    }

    public var known: [BranchInfo] { picked + list }

    /// Whether `requested` needs its own lookup: it's set and neither list has it.
    public func needsLookup(_ requested: String?) -> Bool {
        guard let requested = Models.nonEmpty(requested) else { return false }
        return !known.contains { Branches.jsEqual($0.name, requested) }
    }

    /// A lookup by name came back: keep the exact match.
    public mutating func found(_ results: [BranchInfo], for requested: String) {
        picked += results.filter { Branches.jsEqual($0.name, requested) }
    }

    /// The branch picked in the sheet goes first (replacing an older entry of the same name).
    public mutating func remember(_ b: BranchInfo?) {
        guard let b else { return }
        picked = [b] + picked.filter { !Branches.jsEqual($0.name, b.name) }
    }
}
