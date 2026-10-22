import Foundation

// What the phone's command palette lists: its commands (the Mac's, minus what means nothing on a
// phone), the ticket rows, and which of them a query shows. Pure, so the rules are testable; the
// view (Features/Palette) draws the rows and runs their actions.

/// A command row and what choosing it does.
public struct PaletteCommand: PaletteRankable, Identifiable, Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case newSession
        /// A terminal in the project being viewed (All projects when none), opened in a sheet and on the Mac.
        case newTerminal
        case toggleChildren
        case goAllProjects, goSettings
        case goGroup(String)
        case goProject(String)
        /// Switches the palette into file mode.
        case openFile
        /// One of the focused ticket's actions, as its screen runs it.
        case ticket(TicketAction)
        /// One of Approve's other ways ("Approve and open PR", "Approve and…").
        case approve(Approve.Choice)
        case copyKey
        case openTracker(URL)
    }

    public var id: String
    public var label: String
    /// "Ticket", "General", "Go to"
    public var group: String
    public var keywords: [String]
    public var recentRank: Int?
    public var action: Action
    public var symbol: String
    public var destructive: Bool

    public init(id: String, label: String, group: String, keywords: [String] = [], symbol: String, destructive: Bool = false, action: Action) {
        self.id = id
        self.label = label
        self.group = group
        self.keywords = keywords
        self.symbol = symbol
        self.destructive = destructive
        self.action = action
    }
}

public enum PaletteCommands {
    public static let showChildren = "Show child tickets"
    public static let hideChildren = "Hide child tickets"

    /// The commands for now: the focused ticket's actions first (as on the Mac), then the general
    /// ones, then the "Go to" rows. Left out because they mean nothing on a phone: panes, pop out,
    /// the sidebar and the keyboard-only rows. (Terminals are here: New Terminal, and each terminal
    /// the service hosts as a row of its own, see `PaletteRows.rows`.)
    /// - `focused`: the ticket the palette opened over (a ticket sheet, presented or docked).
    /// - `canOpenFile`: there's a folder to search (`PaletteFileRoot.pick` found one).
    public static func build(_ state: BoardState, prefs: Prefs, focused: Ticket?, canOpenFile: Bool) -> [PaletteCommand] {
        var out: [PaletteCommand] = []
        if let t = focused { out += ticketCommands(t, state) }
        out.append(PaletteCommand(id: "new-session", label: "New Session…", group: "General", symbol: "square.and.pencil", action: .newSession))
        out.append(PaletteCommand(id: "new-terminal", label: "New Terminal", group: "General", keywords: ["shell", "console"], symbol: "terminal", action: .newTerminal))
        if canOpenFile {
            out.append(PaletteCommand(id: "open-file", label: "Open File…", group: "General", keywords: ["file", "find file", "go to file"], symbol: "doc.text.magnifyingglass", action: .openFile))
        }
        out.append(PaletteCommand(
            id: "board.children", label: prefs.hideChildren ? showChildren : hideChildren, group: "General",
            keywords: ["children", "child tickets", "hide", "show", prefs.hideChildren ? hideChildren : showChildren],
            symbol: "arrow.turn.down.right", action: .toggleChildren))
        out.append(PaletteCommand(id: "board", label: "Go to All Projects", group: "Go to", keywords: ["Board: All Projects"], symbol: "square.grid.2x2", action: .goAllProjects))
        for g in state.projectGroups() {
            out.append(PaletteCommand(id: "group:\(g.id)", label: "Board: \(g.name)", group: "Go to", keywords: ["group"], symbol: "folder", action: .goGroup(g.id)))
        }
        for p in state.sortedProjects() {
            out.append(PaletteCommand(id: "project:\(p.id)", label: "Board: \(p.name)", group: "Go to", keywords: [p.key], symbol: "square.grid.2x2", action: .goProject(p.id)))
        }
        out.append(PaletteCommand(id: "settings", label: "Open Settings", group: "Go to", keywords: ["preferences"], symbol: "gearshape", action: .goSettings))
        return out
    }

    /// The focused ticket's actions: what its screen offers now (`TicketActions.set`, the enabled
    /// ones), Approve as its primary way plus one row for each other way, then Copy ticket key and,
    /// when the ticket links to a tracker, Open in source tracker.
    public static func ticketCommands(_ t: Ticket, _ state: BoardState) -> [PaletteCommand] {
        let set = TicketActions.set(
            for: t, project: state.projects[t.projectId], parent: t.parentId.flatMap { state.tickets[$0] },
            deps: state.dependencyStates(t), settingsBaseBranch: state.settings?.baseBranch)
        var out: [PaletteCommand] = []
        for a in set.enabledActions {
            switch a {
            case let .approve(title, _, choices, _):
                out.append(row("ticket.approve", title, a, keywords: ["Approve ticket", "Complete ticket", "Finalize"]))
                for (i, c) in choices.enumerated() {
                    guard let label = c.label, label != title else { continue }
                    out.append(PaletteCommand(id: "ticket.approve.\(i)", label: label, group: "Ticket", symbol: symbol(a), action: .approve(c.value)))
                }
            case .start: out.append(row("ticket.start", a.title, a, keywords: ["Start ticket"]))
            case .unblock: out.append(row("ticket.unblock", "Unblock…", a, keywords: ["Resume ticket", "Answer block"]))
            case .requestChanges: out.append(row("ticket.requestChanges", "Request changes…", a, keywords: ["Reject", "Send back"]))
            case .reopen: out.append(row("ticket.reopen", "Re-open…", a, keywords: ["Reopen ticket"]))
            case let .rerunAgentReview(title): out.append(row("ticket.rerunReview", title, a, keywords: ["Rerun agent review"]))
            case .moveToDone: out.append(row("ticket.markDone", "Move to done", a, keywords: ["Mark done", "Complete"]))
            case .cancelStart: out.append(row("ticket.cancelStart", "Cancel auto start", a, keywords: ["Stop auto start"]))
            case let .withdrawApproval(title): out.append(row("ticket.withdrawApproval", title, a, keywords: ["Require human review", "Rescind approval"]))
            case .cancelRun: out.append(row("ticket.cancelRun", "Cancel run", a, keywords: ["Stop run"]))
            case .delete: out.append(row("ticket.delete", "Delete ticket…", a))
            }
        }
        out.append(PaletteCommand(id: "ticket.copyKey", label: "Copy ticket key", group: "Ticket", symbol: "doc.on.doc", action: .copyKey))
        if let url = t.externalRef?.url.flatMap(URL.init(string:)) {
            out.append(PaletteCommand(id: "ticket.openTracker", label: "Open in source tracker", group: "Ticket", keywords: ["Jira", "external link"], symbol: "arrow.up.right.square", action: .openTracker(url)))
        }
        return out
    }

    private static func row(_ id: String, _ label: String, _ a: TicketAction, keywords: [String] = []) -> PaletteCommand {
        PaletteCommand(id: id, label: label, group: "Ticket", keywords: keywords, symbol: symbol(a), destructive: a.isDestructive, action: .ticket(a))
    }

    private static func symbol(_ a: TicketAction) -> String {
        switch a {
        case .start: "play"
        case .approve: "checkmark"
        case .unblock: "play"
        case .requestChanges: "pencil"
        case .reopen: "arrow.counterclockwise"
        case .rerunAgentReview: "arrow.clockwise"
        case .moveToDone: "checkmark.circle"
        case .cancelStart: "stop.circle"
        case .withdrawApproval: "arrow.uturn.backward"
        case .cancelRun: "stop.circle"
        case .delete: "trash"
        }
    }
}

/// A ticket row: "KEY · KEY title" ranks on the whole label (the remote ID and the key both match).
public struct PaletteTicket: PaletteRankable, Identifiable, Equatable, Sendable {
    public var ticket: Ticket
    public var label: String
    public var id: String { ticket.key }

    public init(_ t: Ticket) {
        ticket = t
        label = "\(Keys.keyLabel(t)) \(t.title)"
    }
}

/// One row the palette shows, whichever list it came from.
public struct PaletteRow: Identifiable, Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        case command(PaletteCommand)
        case ticket(Ticket)
        /// A terminal the service hosts (this phone's and the Mac's).
        case terminal(TerminalInfo)
    }
    public var id: String
    public var content: Content
    public var ranges: [Range<Int>]
}

/// A terminal as a palette item: named by its title (else its program), found by title, program and folder.
struct PaletteTerminal: PaletteRankable {
    let terminal: TerminalInfo
    var label: String { TerminalList.label(terminal) }
    var keywords: [String] { ["terminal"] + TerminalList.keywords(terminal) }
}

public enum PaletteRows {
    public static let maxRows = 60

    /// The command and ticket rows for `query`, best first, as the Mac lists them: commands, then
    /// tickets (the loaded ones ranked, then the server's other matches). A ">" query lists
    /// commands only and "#" tickets only, so a command search never shows a ticket or a file.
    /// `searchIDs` is `BoardState.search`'s result for this same query (no second request).
    public static func rows(_ query: PaletteQuery, commands: [PaletteCommand], state: BoardState, searchIDs: [String]?, recents: [String: Int] = [:], terminals: [TerminalInfo] = []) -> [PaletteRow] {
        var out: [PaletteRow] = []
        if query.wantsCommands {
            var cs = commands
            for i in cs.indices { cs[i].recentRank = recents[cs[i].id] }
            for m in PaletteRanker.rank(query.text, cs) {
                out.append(PaletteRow(id: "cmd:\(cs[m.index].id)", content: .command(cs[m.index]), ranges: m.ranges))
            }
        }
        if query.wantsCommands && !terminals.isEmpty {
            // Newest first, so an empty query lists the terminal just made on top.
            let items = terminals.sorted { $0.createdAt > $1.createdAt }.map(PaletteTerminal.init)
            for m in PaletteRanker.rank(query.text, items) {
                out.append(PaletteRow(id: "terminal:\(items[m.index].terminal.id)", content: .terminal(items[m.index].terminal), ranges: m.ranges))
            }
        }
        if query.wantsTickets && (query.mode == .tickets || !query.text.isEmpty) {
            // A draft has no title worth finding; it's on the board, not in the palette.
            let all = state.tickets.values.filter { $0.draft != true }.sorted { $0.updatedAt > $1.updatedAt }.map(PaletteTicket.init)
            var shown = Set<String>()
            for m in PaletteRanker.rank(query.text, all) {
                shown.insert(all[m.index].ticket.key)
                out.append(PaletteRow(id: "ticket:\(all[m.index].ticket.key)", content: .ticket(all[m.index].ticket), ranges: m.ranges))
            }
            // The server matched these on more than the label (their description): keep them, after the rest.
            for id in searchIDs ?? [] {
                guard let t = state.tickets[id], t.draft != true, shown.insert(t.key).inserted else { continue }
                out.append(PaletteRow(id: "ticket:\(t.key)", content: .ticket(t), ranges: []))
            }
        }
        return Array(out.prefix(maxRows))
    }
}
