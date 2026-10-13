import Foundation

/// The debug state probe's JSON: what ios/Tools/sim-check.ts reads to assert on app state and to
/// wait for the app to settle, instead of reading accessibility values and sleeping.
///
/// The app writes it (only in a SIM_CHECK build, so never in a release) to
/// `<app container>/tmp/harness-debug-state.json` about every 50 ms, atomically. The shape is
/// stable: sim-check parses it, so changing a key means changing both. ios/ARCHITECTURE.md
/// ("Debug state probe") documents it.
///
/// ```json
/// {
///   "version": 1, "seq": 42, "settled": true, "quietMs": 812, "busy": [],
///   "router": {
///     "selectedTab": "board", "path": ["ticket:HARNESS-1:spec"], "sheet": null, "cover": null,
///     "ticketSheet": "presented",
///     "dock": [{"id": 0, "kind": "ticket", "title": "HARNESS-1", "path": ["ticket:HARNESS-2"]}]
///   },
///   "editor": {
///     "markedLines": ["let x = 1"], "selection": {"anchor": 0, "head": 0}, "dirty": false,
///     "scrollY": 0, "lineCount": 12
///   }
/// }
/// ```
public struct DebugState: Codable, Equatable, Sendable {
    public static let version = 1
    public static let fileName = "harness-debug-state.json"

    public var version = DebugState.version
    /// Counts the writes, so a reader can tell the app is still alive and writing.
    public var seq = 0
    /// Nothing is loading and nothing has changed for `DebugSettle.quietWindowMs`: the screen is at rest.
    public var settled = false
    /// How long the state (everything but `seq`, `settled` and `quietMs`) has stayed the same.
    public var quietMs = 0
    /// What keeps the screen from being at rest: "editor" (a page that hasn't said ready),
    /// "animating:<layer>:<key>" (an animation in flight) and "scrolling" (a scroll view being
    /// dragged or coasting).
    public var busy: [String] = []
    public var router: RouterState
    /// The editor on screen, nil when none is.
    public var editor: EditorState?

    public init(busy: [String] = [], router: RouterState, editor: EditorState? = nil) {
        self.busy = busy
        self.router = router
        self.editor = editor
    }

    public struct RouterState: Codable, Equatable, Sendable {
        public var selectedTab: String
        /// The selected tab's stack, one `DebugState.describe(_:)` string per screen.
        public var path: [String]
        public var sheet: String?
        public var cover: String?
        /// "presented", "docked" or "gone".
        public var ticketSheet: String
        /// Every ticket sheet, most recently used first.
        public var dock: [DockEntry]
    }

    public struct DockEntry: Codable, Equatable, Sendable {
        public var id: Int
        /// "ticket", "newSession" or "file".
        public var kind: String
        public var title: String
        /// The screens pushed above its root.
        public var path: [String]
    }

    public struct EditorState: Codable, Equatable, Sendable {
        /// The text of each line the editor marks for a linked range (`.cm-revealed-line`).
        public var markedLines: [String]
        public var selection: Selection
        /// The editor holds edits that aren't saved.
        public var dirty: Bool
        /// The page's scroll offset in points, so a scroll in flight keeps the state moving.
        public var scrollY: Int
        public var lineCount: Int

        public struct Selection: Codable, Equatable, Sendable {
            public var anchor: Int
            public var head: Int
        }
    }

    // MARK: building

    @MainActor
    public static func router(_ router: Router) -> RouterState {
        RouterState(
            selectedTab: router.selectedTab.rawValue,
            path: router.path(router.selectedTab).map(describe),
            sheet: router.sheet.map(describe),
            cover: router.cover.map { "\($0)" },
            ticketSheet: "\(router.ticketSheetState)",
            dock: router.dockedSheets.map { sheet in
                DockEntry(id: sheet.id, kind: kind(of: sheet.root), title: sheet.title, path: sheet.path.map(describe))
            })
    }

    private static func kind(of root: TicketSheet.Root) -> String {
        switch root {
        case .ticket: "ticket"
        case .newSession: "newSession"
        case .file: "file"
        }
    }

    /// A screen as one short string: `kind:detail`.
    public static func describe(_ route: Route) -> String {
        switch route {
        case let .ticket(key, tab): tab.map { "ticket:\(key):\($0.rawValue)" } ?? "ticket:\(key)"
        case let .triage(id): "triage:\(id)"
        case let .file(params): "file:\(params.path)"
        case let .project(id): "project:\(id)"
        case let .driver(id): "driver:\(id)"
        case .prompts: "prompts"
        case .extensions: "extensions"
        case let .prompt(id): "prompt:\(id)"
        }
    }

    public static func describe(_ sheet: SheetRoute) -> String {
        switch sheet {
        case .projects: "projects"
        case let .newSession(projectId, key): ["newSession", projectId, key].compactMap { $0 }.joined(separator: ":")
        case let .watcher(id): id.map { "watcher:\($0)" } ?? "watcher"
        case .connect: "connect"
        case .pair: "pair"
        }
    }

    // MARK: JSON

    /// Sorted keys, so two equal states encode to the same bytes (the diff the settle tracker takes).
    public func json() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }

    public static func decode(_ data: Data) throws -> DebugState {
        try JSONDecoder().decode(DebugState.self, from: data)
    }
}

/// Turns a stream of states into `quietMs` and `settled`: the screen is at rest once it has
/// stopped changing for the quiet window and nothing is `busy`. Animations don't show up in the
/// state, so the window has to outlast them; the editor's scroll offset is part of the state, so its
/// scrolling counts.
public struct DebugSettle: Sendable {
    public static let quietWindowMs = 250

    private var fingerprint: Data?
    private var changedAt: TimeInterval = 0
    private var writes = 0

    public init() {}

    /// Stamps `state` with `seq`, `quietMs` and `settled` as of `now` (seconds on any steady clock).
    public mutating func stamp(_ state: DebugState, now: TimeInterval) -> DebugState {
        var stamped = state
        stamped.seq = 0
        stamped.quietMs = 0
        stamped.settled = false
        let print = try? stamped.json()
        if print != fingerprint {
            fingerprint = print
            changedAt = now
        }
        writes += 1
        stamped.seq = writes
        stamped.quietMs = max(0, Int((now - changedAt) * 1000))
        stamped.settled = stamped.busy.isEmpty && stamped.quietMs >= Self.quietWindowMs
        return stamped
    }
}
