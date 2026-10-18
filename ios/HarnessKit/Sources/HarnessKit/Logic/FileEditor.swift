import Foundation

// The file viewer's editor: @pierre/diffs' editor in a web view (editor/ in the repo, bundled as
// editor.html + editor.js). The page runs editor/src/bridge.ts's `mount`; this file is the native end of that
// bridge, kept free of WebKit so `swift test` covers it.
//
//   host → page: `window.harnessEditor.receive(<command>)` through evaluateJavaScript
//   page → host: the page's `post` stringifies each event to the `editor` WKScriptMessage handler

/// The app theme as the editor takes it: `{appearance, tokens, syntaxTheme}`, every token plus the Shiki
/// theme the code is colored with (editor's `ThemeInput`). The tokens color the chrome (background,
/// selection, the revealed lines); `syntaxTheme` is the one the Changes tab's code blocks use too.
public struct FileEditorTheme: Equatable, Sendable {
    public var appearance: ThemeAppearance
    public var tokens: ThemeTokens
    /// The Shiki theme for `appearance`: the app theme's, else Pierre's own (`SyntaxTheme.name`).
    public var syntaxTheme: String

    public init(appearance: ThemeAppearance, tokens: ThemeTokens, syntaxTheme: String? = nil) {
        self.appearance = appearance
        self.tokens = tokens
        self.syntaxTheme = SyntaxTheme.name(appearance, syntaxTheme)
    }

    public init(_ info: PluginThemeInfo) {
        self.init(appearance: info.appearance, tokens: info.tokens, syntaxTheme: info.syntaxTheme)
    }

    var json: JSONValue {
        let tokens = Dictionary(uniqueKeysWithValues: ThemeToken.allCases.map { ($0.rawValue, JSONValue.string(self.tokens[keyPath: $0.keyPath])) })
        return .object(["appearance": .string(appearance.rawValue), "tokens": .object(tokens), "syntaxTheme": .string(syntaxTheme)])
    }
}

/// What the host tells the editor page (editor's `BridgeCommand`).
public enum FileEditorCommand: Equatable, Sendable {
    /// Opens a fresh editor. `language` is the file's path or name (the editor resolves it).
    /// `saved` is what's on disk when the editor reopens with unsaved edits (it opens dirty).
    case open(contents: String, language: String, theme: FileEditorTheme, range: ClosedRange<Int>?, readOnly: Bool, wrap: Bool, saved: String?)
    /// Opens the side-by-side diff, the original on the left.
    case diff(original: String, modified: String, language: String, theme: FileEditorTheme)
    case theme(FileEditorTheme)
    case reveal(ClosedRange<Int>)
    /// Wraps long lines (or scrolls them sideways), keeping the top line of the view where it is
    case wrap(Bool)
    /// Replaces the document as a clean reload of what's on disk (keeps no undo history)
    case setContents(String)
    /// What `save` handed out is on disk now (nil: the document as it is)
    case markSaved(String?)
    case focus
    /// The keyboard came up: keep the caret in view
    case scrollToCursor
    case getContents(id: String)

    var json: JSONValue {
        func range(_ r: ClosedRange<Int>) -> JSONValue {
            .object(["start": .number(Double(r.lowerBound)), "end": .number(Double(r.upperBound))])
        }
        switch self {
        case let .open(contents, language, theme, r, readOnly, wrap, saved):
            var o: [String: JSONValue] = [
                "type": .string("open"), "contents": .string(contents), "language": .string(language),
                "theme": theme.json, "readOnly": .bool(readOnly), "wrap": .bool(wrap),
            ]
            if let r { o["range"] = range(r) }
            if let saved, saved != contents { o["saved"] = .string(saved) }
            return .object(o)
        case let .diff(original, modified, language, theme):
            return .object([
                "type": .string("diff"), "original": .string(original), "modified": .string(modified),
                "language": .string(language), "theme": theme.json,
            ])
        case let .theme(theme): return .object(["type": .string("theme"), "theme": theme.json])
        case let .reveal(r): return .object(["type": .string("reveal"), "range": range(r)])
        case let .wrap(on): return .object(["type": .string("wrap"), "wrap": .bool(on)])
        case let .setContents(s): return .object(["type": .string("setContents"), "contents": .string(s)])
        case let .markSaved(s):
            var o: [String: JSONValue] = ["type": .string("markSaved")]
            if let s { o["contents"] = .string(s) }
            return .object(o)
        case .focus: return .object(["type": .string("focus")])
        case .scrollToCursor: return .object(["type": .string("scrollToCursor")])
        case let .getContents(id): return .object(["type": .string("getContents"), "id": .string(id)])
        }
    }

    /// Commands that move the view or the cursor: meaningless (and unwanted) while the editor is hidden
    /// under a rendered view.
    public var needsVisibleEditor: Bool {
        switch self {
        case .reveal, .focus, .scrollToCursor: true
        default: false
        }
    }

    /// The script for `evaluateJavaScript`.
    public var script: String {
        "window.harnessEditor.receive(\(PluginHost.jsLiteral(json))); true;"
    }
}

/// What the editor page reports (editor's `BridgeEvent`).
public enum FileEditorEvent: Equatable, Sendable {
    case ready
    case change(contents: String, dirty: Bool)
    case dirty(Bool)
    /// Cmd/Ctrl+S inside the editor
    case save(contents: String)
    /// The editor lost focus
    case blur
    case error(String)
    case contents(id: String?, contents: String)

    /// A WKScriptMessage body: the page's JSON string. Nil for anything else (an unknown or
    /// malformed event is dropped, not guessed at).
    public static func decode(body: Any) -> FileEditorEvent? {
        guard let text = body as? String else { return nil }
        return decode(json: text)
    }

    public static func decode(json: String) -> FileEditorEvent? {
        guard case let .object(o)? = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)),
              case let .string(type)? = o["type"]
        else { return nil }
        func string(_ key: String) -> String? {
            if case let .string(s)? = o[key] { s } else { nil }
        }
        func bool(_ key: String) -> Bool? {
            if case let .bool(b)? = o[key] { b } else { nil }
        }
        switch type {
        case "ready": return .ready
        case "blur": return .blur
        case "change":
            guard let c = string("contents"), let d = bool("dirty") else { return nil }
            return .change(contents: c, dirty: d)
        case "dirty": return bool("dirty").map(FileEditorEvent.dirty)
        case "save": return string("contents").map { .save(contents: $0) }
        case "error": return .error(string("message") ?? "")
        case "contents": return string("contents").map { .contents(id: string("id"), contents: $0) }
        default: return nil
        }
    }
}

/// When edits are saved, and what a reload may overwrite.
public enum FileEditRules {
    /// A file is editable when its text came whole: not binary, not too large, not cut short while
    /// it was read (saving a truncated file would clobber the rest of it).
    public static func canEdit(_ view: FileView) -> Bool {
        view.contents != nil && !view.binary && !view.tooLarge && !view.truncated
    }

    public enum Leave: Equatable, Sendable {
        /// Nothing unsaved
        case none
        /// Save, then go (Save on blur is on)
        case save
        /// Ask: save or discard (Save on blur is off)
        case prompt
    }

    /// The screen is popped or swapped. Dirty edits are never dropped silently.
    public static func leave(dirty: Bool, saveOnBlur: Bool) -> Leave {
        guard dirty else { return .none }
        return saveOnBlur ? .save : .prompt
    }

    /// The editor lost focus or the app went to the background: saves only with Save on blur.
    public static func saveOnBlur(dirty: Bool, saveOnBlur: Bool) -> Bool { dirty && saveOnBlur }

    /// The app came back: a clean editor reloads from disk silently; a dirty one keeps its edits.
    public static func reloadOnForeground(dirty: Bool) -> Bool { !dirty }

    /// "Saving…", "Save failed: …" or nil, for the file bar.
    public static func statusLabel(saving: Bool, error: String?) -> String? {
        if saving { return "Saving…" }
        return error.map { "Save failed: \($0)" }
    }
}
