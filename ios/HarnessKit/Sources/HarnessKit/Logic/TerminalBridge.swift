import Foundation

// The terminal sheet's web view: ghostty-web in terminal.html (terminal/src/bridge.ts, bundled as
// terminal.js). This is the native end of that bridge, free of WebKit so `swift test` covers it.
// The socket stays in Swift (HarnessSocket, through BoardStore), so auth and reconnects live in one
// place; the page only draws and reports.
//
//   host → page: `window.harnessTerminal.receive(<command>)` through evaluateJavaScript
//   page → host: the page's `post` stringifies each event to the `terminal` WKScriptMessage handler

/// What the host tells the terminal page (terminal's `BridgeCommand`).
public enum TerminalCommand: Equatable, Sendable {
    /// Starts the terminal `id`, drawn in `theme`'s colors; the page says `ready`.
    case open(id: String, theme: FileEditorTheme, fontSize: Double)
    /// A terminal.* message from the service (snapshot, output, exit).
    case message(ServerMessage)
    /// The socket dropped: draw nothing until the next snapshot.
    case reconnecting
    /// New colors: the page rebuilds its terminal and asks for a fresh snapshot.
    case theme(FileEditorTheme)
    case focus
    case blur
    case paste(String)
    /// The Ctrl accessory key: the next typed letter becomes its control character.
    case ctrl(Bool)
    /// The soft keyboard covers this many points of the web view (0: hidden).
    case inset(Double)
    /// The web view's size in points: the page is exactly that big whatever the keyboard does, so the
    /// rows it reports never change with it.
    case frame(width: Double, height: Double)

    var json: JSONValue {
        switch self {
        case let .open(id, theme, fontSize):
            return .object(["type": .string("open"), "id": .string(id), "theme": theme.json, "fontSize": .number(fontSize)])
        case let .message(message):
            // A ServerMessage always encodes; fall back to null rather than crash on a bad one.
            let value = (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(message))) ?? .null
            return .object(["type": .string("message"), "message": value])
        case .reconnecting: return .object(["type": .string("reconnecting")])
        case let .theme(theme): return .object(["type": .string("theme"), "theme": theme.json])
        case .focus: return .object(["type": .string("focus")])
        case .blur: return .object(["type": .string("blur")])
        case let .paste(text): return .object(["type": .string("paste"), "text": .string(text)])
        case let .ctrl(on): return .object(["type": .string("ctrl"), "on": .bool(on)])
        case let .inset(bottom): return .object(["type": .string("inset"), "bottom": .number(bottom)])
        case let .frame(width, height): return .object(["type": .string("frame"), "width": .number(width), "height": .number(height)])
        }
    }

    /// The script for `evaluateJavaScript`.
    public var script: String {
        "window.harnessTerminal.receive(\(PluginHost.jsLiteral(json))); true;"
    }
}

/// What the terminal page reports (terminal's `BridgeEvent`).
public enum TerminalEvent: Equatable, Sendable {
    case ready
    /// Typed, pasted or answered input for the shell.
    case input(String)
    /// How many columns and rows the web view could show; the service sizes the shell to the smallest client.
    case viewport(cols: Int, rows: Int)
    case title(String)
    case exit(Int?)
    /// Output was lost: detach and attach again.
    case resync
    case truncated
    /// The Ctrl key's armed state changed (it disarms after one key).
    case ctrl(Bool)
    case bell
    case error(String)

    public static func decode(body: Any) -> TerminalEvent? {
        guard let text = body as? String else { return nil }
        return decode(json: text)
    }

    public static func decode(json: String) -> TerminalEvent? {
        guard case let .object(o)? = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)),
              case let .string(type)? = o["type"]
        else { return nil }
        func string(_ key: String) -> String? {
            if case let .string(s)? = o[key] { s } else { nil }
        }
        func int(_ key: String) -> Int? {
            if case let .number(n)? = o[key], n.isFinite { Int(n) } else { nil }
        }
        switch type {
        case "ready": return .ready
        case "input": return string("data").map(TerminalEvent.input)
        case "viewport":
            guard let cols = int("cols"), let rows = int("rows"), cols > 0, rows > 0 else { return nil }
            return .viewport(cols: cols, rows: rows)
        case "title": return .title(string("title") ?? "")
        case "exit": return .exit(int("exitCode"))
        case "resync": return .resync
        case "truncated": return .truncated
        case "ctrl":
            if case let .bool(on)? = o["on"] { return .ctrl(on) }
            return nil
        case "bell": return .bell
        case "error": return .error(string("message") ?? "")
        default: return nil
        }
    }
}

/// The keys the accessory bar sends that a phone keyboard lacks.
public enum TerminalKey: CaseIterable, Sendable {
    case escape, tab, up, down, left, right, pipe, tilde, slash, dash

    /// What the shell gets.
    public var sequence: String {
        switch self {
        case .escape: "\u{1b}"
        case .tab: "\t"
        case .up: "\u{1b}[A"
        case .down: "\u{1b}[B"
        case .right: "\u{1b}[C"
        case .left: "\u{1b}[D"
        case .pipe: "|"
        case .tilde: "~"
        case .slash: "/"
        case .dash: "-"
        }
    }

    public var label: String {
        switch self {
        case .escape: "esc"
        case .tab: "tab"
        case .up: "↑"
        case .down: "↓"
        case .left: "←"
        case .right: "→"
        case .pipe: "|"
        case .tilde: "~"
        case .slash: "/"
        case .dash: "-"
        }
    }
}

/// Where the key bar sits against the keyboard. The bar is laid out below the web view; with the
/// keyboard up it rides above it, covering the web view's bottom edge.
public enum TerminalKeyBarRules {
    /// How far to lift the bar (and how much of the web view's bottom the page must pan clear of):
    /// the bar's bottom edge sits at `webViewBottom + barHeight`, the keyboard starts at `keyboardTop`.
    public static func cover(webViewBottom: Double, barHeight: Double, keyboardTop: Double) -> Double {
        max(0, webViewBottom + barHeight - keyboardTop)
    }
}

/// Which layout changes of the terminal's web view reach the rows the shell is given.
public enum TerminalViewportRules {
    /// A height drop of at most this many points is the keyboard's accessory or the home indicator's
    /// inset, not a different amount of room (a soft keyboard covers the page without resizing it).
    public static let keyboardShrink = 120.0

    /// Whether going from `old` to `new` points tall (at the same width) is such a shrink, which keeps `old`.
    public static func ignoresShrink(from old: Double, to new: Double) -> Bool {
        old > 0 && new < old && old - new <= keyboardShrink
    }
}

/// What a terminal sheet asks of the service as it comes and goes, kept pure so it's testable.
public struct TerminalAttachRules: Equatable, Sendable {
    public private(set) var viewport: (cols: Int, rows: Int)?
    public private(set) var attached = false
    /// The sheet is on screen, the app is in the foreground and the page is ready to draw.
    public var visible = false

    public init() {}

    public enum Action: Equatable, Sendable {
        case attach(cols: Int, rows: Int)
        case resize(cols: Int, rows: Int)
        case detach
    }

    /// The page measured its viewport.
    public mutating func viewportChanged(cols: Int, rows: Int) -> Action? {
        viewport = (cols, rows)
        guard visible else { return nil }
        if attached { return .resize(cols: cols, rows: rows) }
        attached = true
        return .attach(cols: cols, rows: rows)
    }

    /// The sheet or the app became visible (true) or hid (false: backgrounded, a sheet over it, closed).
    public mutating func visibilityChanged(_ now: Bool) -> Action? {
        visible = now
        if now {
            guard !attached, let v = viewport else { return nil }
            attached = true
            return .attach(cols: v.cols, rows: v.rows)
        }
        guard attached else { return nil }
        attached = false
        return .detach
    }

    /// The socket was rebuilt (foregrounding) or dropped: the service forgot this attachment.
    public mutating func socketReset() -> Action? {
        attached = false
        guard visible, let v = viewport else { return nil }
        attached = true
        return .attach(cols: v.cols, rows: v.rows)
    }

    /// The page asked for a fresh snapshot (lost output): detach, then attach again.
    public mutating func resync() -> [Action] {
        guard attached, let v = viewport else { return [] }
        return [.detach, .attach(cols: v.cols, rows: v.rows)]
    }

    public static func == (a: TerminalAttachRules, b: TerminalAttachRules) -> Bool {
        a.attached == b.attached && a.visible == b.visible && a.viewport?.cols == b.viewport?.cols && a.viewport?.rows == b.viewport?.rows
    }
}
