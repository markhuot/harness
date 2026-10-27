import HarnessKit
import SwiftUI

/// The command palette, the phone's port of the Mac's ⌘K: one field and a list under it. Plain text
/// finds tickets and commands (and, for a query that reads as a path, nothing more: files are `@`,
/// or Open file…), `>` limits it to commands, `#` to tickets and `@` to the focused ticket's (else
/// the board's project's) files. The ranking, prefixes and rows are HarnessKit's (`PaletteRows`).
///
/// It comes up as a sheet (`SheetRoute.palette`) from the board's bottom-bar field, ⌘K and ⌘P, over
/// a ticket sheet too, so the ticket sheet's actions are on offer while one is open.
struct PaletteScreen: View {
    /// ⌘P: open in file mode.
    let startInFiles: Bool
    /// What the field starts with (snapshots).
    var initialText = ""
    /// Snapshots turn it off: a blinking caret and the keyboard would differ from run to run.
    var autofocus = true
    /// Snapshots open straight into the label picker of a ticket (key, removing).
    var initialLabelPick: (ticketKey: String, removing: Bool)?

    @Environment(BoardStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(\.openURL) private var openURL

    @State private var raw = ""
    @State private var terminalError: String?
    @State private var runner = TicketActionRunner()
    /// Set once an action asked for input (notes, a confirmation): the palette goes when that's answered.
    @State private var awaitingInput = false
    @State private var files: FileResults?
    @State private var fileRecents = PaletteRecents.read()
    @State private var commandRecents = PaletteCommandRecents.read()
    /// The folder `@` searches, fixed when the palette opened.
    @State private var root: PaletteFileRoot?
    @State private var rootLabel = ""
    @State private var opened = false
    /// Set while the palette picks a label for the ticket it opened over (Add label…, Remove label…).
    @State private var labelPick: LabelPick?
    @FocusState private var focused: Bool

    struct LabelPick: Equatable {
        var ticketKey: String
        var removing: Bool
    }

    struct FileResults: Equatable {
        var key: String
        var files: [FileMatch]
    }

    private var query: PaletteQuery { PaletteQuery.parse(raw) }
    private var fileQuery: PaletteFileQuery { PaletteFileQuery.parse(query.text) }

    /// The ticket the palette opened over: the ticket sheet, presented or docked.
    private var focusedTicket: Ticket? {
        (router.ticketSheet ?? router.dock)?.topTicketKey.flatMap { store.state.ticketByKey($0) }
    }

    private var boardFilter: String? { store.state.boardFilter(app.prefs.boardProject) }

    private var commands: [PaletteCommand] {
        PaletteCommands.build(store.state, prefs: app.prefs, focused: focusedTicket, canOpenFile: currentRoot != nil)
    }

    /// Chosen when the palette opens, so a ticket opening behind it doesn't change what `@` searches.
    private var currentRoot: PaletteFileRoot? {
        root ?? PaletteFileRoot.pick(focusedTicket: focusedTicket?.key, project: WindowShortcuts.boardProject(store.state, app.prefs))
    }

    private var rows: [PaletteRow] {
        let state = store.state
        let search = state.search.flatMap { $0.q == query.text ? $0.ids : nil }
        return PaletteRows.rows(query, commands: commands, state: state, searchIDs: search, recents: commandRecents, terminals: store.terminals)
    }

    private var fileRows: [FileRow] {
        guard query.wantsFiles, let root = currentRoot else { return [] }
        let q = fileQuery.search
        if q.isEmpty {
            return PaletteRecents.paths(fileRecents, root: root).map { FileRow(path: $0, ranges: [], ignored: false) }
        }
        guard let files, files.key == filesKey(root, q) else { return [] }
        return files.files.prefix(Self.fileLimit).map { f in
            FileRow(path: f.path, ranges: PaletteRanker.match(q.lowercased(), f.path)?.ranges ?? [], ignored: f.ignored == true)
        }
    }

    static let fileLimit = 50

    struct FileRow: Identifiable, Equatable {
        var path: String
        var ranges: [Range<Int>]
        var ignored: Bool
        var id: String { path }
    }

    var body: some View {
        VStack(spacing: 0) {
            field
            Divider().overlay(c.border)
            list
        }
        .background(c.bg)
        .environment(runner)
        .modifier(TicketActionHost(runner: runner))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !opened else { return }
            opened = true
            raw = startInFiles ? "@" : initialText
            if let p = initialLabelPick { labelPick = LabelPick(ticketKey: p.ticketKey, removing: p.removing) }
            root = PaletteFileRoot.pick(focusedTicket: focusedTicket?.key, project: WindowShortcuts.boardProject(store.state, app.prefs))
            rootLabel = describe(root)
            focused = autofocus
        }
        // The board's loader searches the service for the ticket rows (and keeps what's loaded), so
        // there's no second request; the board itself ignores it (BoardContext).
        .onChange(of: TicketSearchKey(text: query.wantsTickets ? query.text : "", filter: boardFilter), initial: true) { _, k in
            store.loader.setQuery(k.text, board: k.filter)
        }
        .onDisappear { store.loader.setQuery("", board: boardFilter) }
        .task(id: FilesTaskKey(wants: query.wantsFiles, root: root, search: fileQuery.search)) { await searchFiles() }
        .onChange(of: runner.prompt?.id) { _, _ in dismissWhenAnswered() }
        .onChange(of: runner.confirm == nil) { _, _ in dismissWhenAnswered() }
        .task { await store.refreshTerminals() }
        .alert("Couldn't start a terminal", isPresented: Binding(get: { terminalError != nil }, set: { if !$0 { terminalError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(terminalError ?? "") }
    }

    // MARK: Field

    private var field: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(c.text2)
            TextField("", text: $raw, prompt: Text(labelPick.map { $0.removing ? "Find a label to remove" : "Find or create a label" } ?? "Search tickets, run a command").foregroundStyle(c.text3))
                .font(.scaled(size: 17))
                .foregroundStyle(c.text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(runFirst)
                .accessibilityLabel("Command palette")
            if !raw.isEmpty {
                Button("Clear", systemImage: "xmark.circle.fill") { raw = "" }
                    .labelStyle(.iconOnly)
                    .font(.system(size: 17))
                    .foregroundStyle(c.text3)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
    }

    // MARK: List

    @ViewBuilder private var list: some View {
        let rows = labelPick == nil ? rows : []
        let fileRows = labelPick == nil ? fileRows : []
        List {
            if labelPick != nil {
                ForEach(labelOptions) { o in
                    Button { choose(o) } label: { optionLabel(o) }
                        .listRowBackground(c.bg)
                        .accessibilityIdentifier("palette-label-\(o.name)")
                }
                if labelOptions.isEmpty {
                    Text(labelPick?.removing == true ? "This ticket has no matching labels" : "Type a name to create a label")
                        .font(.scaled(size: 15)).foregroundStyle(c.text3).listRowBackground(c.bg)
                }
            } else if query.wantsFiles {
                if currentRoot != nil {
                    Section {
                        ForEach(fileRows) { f in
                            Button { open(f) } label: { fileLabel(f) }
                                .listRowBackground(c.bg)
                        }
                    } header: {
                        Text("Files in \(rootLabel)")
                            .font(.scaled(size: 12, weight: .semibold))
                            .foregroundStyle(c.text3)
                    }
                } else {
                    Text("Open a ticket or pick a project to search its files.")
                        .font(.scaled(size: 15)).foregroundStyle(c.text3).listRowBackground(c.bg)
                }
                if fileRows.isEmpty, currentRoot != nil {
                    Text(fileQuery.search.isEmpty ? "Type a file name. Recently opened files show here." : (files?.key == currentRoot.map { filesKey($0, fileQuery.search) } ? "No files" : "Searching…"))
                        .font(.scaled(size: 15)).foregroundStyle(c.text3).listRowBackground(c.bg)
                }
            } else {
                ForEach(rows) { row in
                    Button { run(row) } label: { label(row) }
                        .listRowBackground(c.bg)
                }
                if rows.isEmpty {
                    Text("Nothing matches").font(.scaled(size: 15)).foregroundStyle(c.text3).listRowBackground(c.bg)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder private func optionLabel(_ o: LabelList.Option) -> some View {
        HStack(spacing: 12) {
            switch o {
            case let .existing(info):
                LabelDot(color: info.color).frame(width: 22)
                Text(info.name).font(.scaled(size: 16)).foregroundStyle(c.text).lineLimit(1)
            case let .create(name):
                Image(systemName: "plus").font(.system(size: 15, weight: .medium)).frame(width: 22).foregroundStyle(c.accent)
                Text("Create “\(name)”").font(.scaled(size: 16)).foregroundStyle(c.text).lineLimit(1)
            }
            Spacer(minLength: 8)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func label(_ row: PaletteRow) -> some View {
        switch row.content {
        case let .command(cmd):
            HStack(spacing: 12) {
                Image(systemName: cmd.symbol)
                    .font(.system(size: 15, weight: .medium))
                    .frame(width: 22)
                    .foregroundStyle(cmd.destructive ? c.red : c.accent)
                Text(Self.highlight(cmd.label, row.ranges, c))
                    .font(.scaled(size: 16))
                    .foregroundStyle(cmd.destructive ? c.red : c.text)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(cmd.group).font(.scaled(size: 12)).foregroundStyle(c.text3).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
        case let .terminal(t):
            HStack(spacing: 12) {
                Image(systemName: "terminal")
                    .font(.system(size: 15, weight: .medium))
                    .frame(width: 22)
                    .foregroundStyle(t.state == .exited ? c.text3 : c.accent)
                VStack(alignment: .leading, spacing: 1) {
                    Text(Self.highlight(TerminalList.label(t), row.ranges, c))
                        .font(.scaled(size: 16))
                        .foregroundStyle(c.text)
                        .lineLimit(1)
                    Text(TerminalList.subtitle(t))
                        .font(.scaled(size: 12))
                        .foregroundStyle(c.text3)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer(minLength: 8)
                Text("Terminal").font(.scaled(size: 12)).foregroundStyle(c.text3).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("palette-terminal-\(t.id)")
        case let .qualifier(q):
            HStack(spacing: 12) {
                if q.field == .label {
                    LabelDot(color: q.color).frame(width: 22)
                } else {
                    ProjectKeyBadge(q.value, color: q.color, size: .sm).frame(width: 22)
                }
                Text(q.title)
                    .font(.scaled(size: 16))
                    .foregroundStyle(c.text)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let n = q.count, n > 0 { Text("\(n)").font(.scaled(size: 12)).foregroundStyle(c.text3) }
                Text(q.field == .label ? "Label" : "Project").font(.scaled(size: 12)).foregroundStyle(c.text3).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("palette-qualifier-\(q.field.rawValue)-\(q.value)")
        case let .ticket(t):
            HStack(spacing: 10) {
                StatusDot(status: t.status)
                Text(Self.highlight("\(Keys.keyLabel(t)) \(t.title)", row.ranges, c))
                    .font(.scaled(size: 16))
                    .foregroundStyle(c.text)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(statusLabel(t.status)).font(.scaled(size: 12)).foregroundStyle(c.text3).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func fileLabel(_ f: FileRow) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.text").font(.system(size: 15)).frame(width: 22).foregroundStyle(c.text2)
            Text(Self.highlight(f.path, f.ranges, c))
                .font(.mono(14))
                .foregroundStyle(f.ignored ? c.text3 : c.text)
                .lineLimit(2)
                .truncationMode(.head)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    /// `text` with the matched Character ranges in the accent color and bold.
    static func highlight(_ text: String, _ ranges: [Range<Int>], _ c: Palette) -> AttributedString {
        var out = AttributedString(text)
        let chars = Array(text.indices)
        for r in ranges where r.lowerBound >= 0 && r.upperBound <= chars.count && r.lowerBound < r.upperBound {
            let lo = chars[r.lowerBound]
            let hi = r.upperBound < chars.count ? chars[r.upperBound] : text.endIndex
            if let range = Range(lo..<hi, in: out) {
                out[range].foregroundColor = c.accentText
                out[range].inlinePresentationIntent = .stronglyEmphasized
            }
        }
        return out
    }

    // MARK: Running

    /// The label picker's rows for what's typed, while it's open.
    private var labelOptions: [LabelList.Option] {
        guard let pick = labelPick, let ticket = store.state.ticketByKey(pick.ticketKey) else { return [] }
        return LabelList.options(raw, labels: store.state.labels, current: ticket.labels ?? [], removing: pick.removing)
    }

    /// Sends the ticket's whole new label list, as the Details tab does, and closes the palette.
    private func choose(_ option: LabelList.Option) {
        guard let pick = labelPick, let ticket = store.state.ticketByKey(pick.ticketKey) else { return }
        let current = ticket.labels ?? []
        let next = pick.removing ? LabelName.removing(option.name, from: current) : (LabelName.adding(option.name, to: current) ?? current)
        let key = pick.ticketKey
        if next != current {
            actions.perform { _ = try await store.connectedAPI().updateTicket(key, UpdateTicketBody(labels: next)) }
        }
        close()
    }

    private func runFirst() {
        if labelPick != nil {
            if let o = labelOptions.first { choose(o) }
        } else if query.wantsFiles {
            if let f = fileRows.first { open(f) }
        } else if let r = rows.first {
            run(r)
        }
    }

    private func run(_ row: PaletteRow) {
        switch row.content {
        case let .qualifier(q):
            // Finish the qualifier in the field and keep typing; a "#" or ">" prefix stays.
            let prefix = String(raw.drop { $0.isWhitespace }.prefix(1))
            raw = (query.mode == .tickets ? prefix : "") + SearchQuery.complete(query.text, field: q.field, value: q.value)
            focused = autofocus
        case let .ticket(t):
            router.openTicket(key: t.key, tab: nil)
        case let .terminal(t):
            router.openTerminal(id: t.id)
        case let .command(cmd):
            commandRecents = PaletteCommandRecents.push(cmd.id)
            run(cmd)
        }
    }

    private func run(_ cmd: PaletteCommand) {
        let ticket = focusedTicket
        switch cmd.action {
        case .openFile:
            raw = "@"
        case .addLabel, .removeLabel:
            guard let ticket else { return }
            labelPick = LabelPick(ticketKey: ticket.key, removing: cmd.action == .removeLabel)
            raw = ""
            focused = autofocus
        case .newSession:
            router.present(.newSession(projectId: WindowShortcuts.boardProject(store.state, app.prefs), key: nil))
        case .newTerminal:
            // In the project being viewed (All projects when none), and a pane on the Mac at once.
            let project = WindowShortcuts.boardProject(store.state, app.prefs)
            let device = app.deviceId()
            Task {
                do {
                    let info = try await store.createTerminal(projectId: project, deviceId: device, openOnMac: true)
                    router.openTerminal(id: info.id)
                } catch {
                    terminalError = Connection.describeError(error, baseUrl: store.baseUrl)
                }
            }
        case .toggleChildren:
            app.setPref(\.hideChildren, !app.prefs.hideChildren)
            close()
        case .goAllProjects: router.select(.allProjects, app: app)
        case let .goGroup(g): router.select(.group(g), app: app)
        case let .goProject(id): router.select(.project(id), app: app)
        case .goSettings: router.open(.tab(.settings))
        case let .ticket(action):
            guard let ticket else { return }
            runner.run(action, ticket: ticket, api: store.api, actions: actions, onDeleted: popDeleted)
            afterTicketAction()
        case let .approve(choice):
            guard let ticket else { return }
            runner.approve(choice, ticket: ticket, api: store.api, actions: actions)
            afterTicketAction()
        case .copyKey:
            if let ticket { UIPasteboard.general.string = ticket.key }
            close()
        case let .openTracker(url):
            openURL(url)
            close()
        }
    }

    /// Notes, instructions and the delete confirmation come up over the palette; it goes once they're
    /// answered. An action that needs nothing more is sent and the palette goes at once.
    private func afterTicketAction() {
        if runner.prompt != nil || runner.confirm != nil { awaitingInput = true } else { close() }
    }

    private func dismissWhenAnswered() {
        guard awaitingInput, runner.prompt == nil, runner.confirm == nil else { return }
        awaitingInput = false
        close()
    }

    private func close() { router.sheet = nil }

    private func popDeleted(_ key: String) {
        let state = store.state
        router.removeTicket { $0.uppercased() == key.uppercased() || state.ticketByKey($0) == nil }
    }

    private func open(_ f: FileRow) {
        guard let root = currentRoot else { return }
        fileRecents = PaletteRecents.push(root.fileID(f.path))
        let q = fileQuery
        var params = FileRouteParams(path: f.path, start: q.startLine.map(String.init), end: q.endLine.map(String.init))
        switch root {
        case let .ticket(key): params.ticket = key
        case let .project(id): params.project = id
        }
        router.push(.file(params))
    }

    // MARK: Files

    private struct TicketSearchKey: Equatable {
        let text: String
        let filter: String?
    }

    private struct FilesTaskKey: Equatable {
        let wants: Bool
        let root: PaletteFileRoot?
        let search: String
    }

    private func filesKey(_ root: PaletteFileRoot, _ q: String) -> String { "\(root.fileID(""))\(q)" }

    private func describe(_ root: PaletteFileRoot?) -> String {
        switch root {
        case let .ticket(key): store.state.ticketByKey(key).map { Keys.keyLabel($0) } ?? key
        case let .project(id): store.state.projects[id]?.name ?? "this project"
        case nil: ""
        }
    }

    /// Every file under the root, git-ignored ones included, after a short pause; a task that's been
    /// replaced (the query changed) is cancelled, so a late answer never lands.
    private func searchFiles() async {
        guard query.wantsFiles, let root = currentRoot, !fileQuery.search.isEmpty, let api = store.api else { return }
        let q = fileQuery.search
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled else { return }
        let options = FileSearchOptions(limit: Self.fileLimit, ignored: true, kind: .file)
        let found: [FileMatch]
        do {
            switch root {
            case let .ticket(key): found = try await api.ticketFiles(key, q: q, options)
            case let .project(id): found = try await api.projectFiles(id, q: q, options)
            }
        } catch {
            guard !Task.isCancelled else { return }
            files = FileResults(key: filesKey(root, q), files: [])
            return
        }
        guard !Task.isCancelled else { return }
        files = FileResults(key: filesKey(root, q), files: ViewRules.fileResults(found))
    }
}

/// The commands run most recently (their ids, most recent first), kept in UserDefaults like the
/// Mac's recents; an empty query lists them first.
enum PaletteCommandRecents {
    static let key = "harness.palette.recent"
    static let max = 8

    static func read() -> [String: Int] {
        ViewRules.recentRanks(UserDefaults.standard.stringArray(forKey: key) ?? [], limit: max)
    }

    @discardableResult
    static func push(_ id: String) -> [String: Int] {
        UserDefaults.standard.set(ViewRules.pushedRecent(id, onto: UserDefaults.standard.stringArray(forKey: key) ?? [], limit: max), forKey: key)
        return read()
    }
}
