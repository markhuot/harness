import HarnessKit
import SwiftUI

// A chief of staff's pane: the Chat and Inbox tabs and the memory sheet. It is a card of the ticket
// sheets (`TicketSheet.Root.cos`): a sheet on the iPhone, the side panel on the iPad and Duo.

/// What the board's Chief of Staff button does: opens the chief of the board's scope, making the
/// group's chief the first time.
@MainActor
func openCos(scope: String, store: BoardStore, router: Router, actions: Actions) {
    if store.cos.chief(scope: scope) != nil {
        router.openCos(scope: scope)
        return
    }
    Task {
        guard let chief = await actions.run({ try await store.connectedAPI().openCos(scope: scope) }) else { return }
        store.updateCos { $0.chiefs[chief.ticketId] = chief }
        router.openCos(scope: scope)
    }
}

struct CosScreen: View {
    let scope: String

    init(scope: String, tab: CosTab = .chat) {
        self.scope = scope
        _tab = State(initialValue: tab)
    }

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @State private var tab: CosTab
    @State private var memoryOpen = false

    var body: some View {
        let state = store.state
        let chief = store.cos.chief(scope: scope)
        let groupName = state.projectGroups().first { CosLogic.scopeKey(groupId: $0.id) == scope }?.name
        VStack(spacing: 0) {
            header(chief, title: CosLogic.title(scope: scope, groupName: groupName))
            if let chief {
                notes(chief)
                switch tab {
                case .chat: CosChatView(chief: chief)
                case .inbox: CosInboxView(chief: chief, onChat: { tab = .chat })
                }
            } else {
                Spacer()
                ProgressView()
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.bg)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $memoryOpen) {
            if let chief { CosMemorySheet(chief: chief) }
        }
        .task(id: scope) {
            // A link to a chief that isn't made yet makes it, like the board's button.
            guard store.cos.chief(scope: scope) == nil else { return }
            if let chief = await actions.run({ try await store.connectedAPI().openCos(scope: scope) }) {
                store.updateCos { $0.chiefs[chief.ticketId] = chief }
            }
        }
        .accessibilityIdentifier("cos-view")
    }

    private func header(_ chief: Cos?, title: String) -> some View {
        let open = CosLogic.badgeCount(store.cos.badge, cosId: chief?.ticketId)
        return VStack(spacing: 10) {
            HStack(spacing: 10) {
                Icon("sparkle", size: 16, weight: .semibold).foregroundStyle(c.accent)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Chief of Staff").font(.scaled(size: 17, weight: .semibold)).foregroundStyle(c.text)
                    Text(title).font(.scaled(size: 13)).foregroundStyle(c.text3)
                }
                Spacer(minLength: 8)
                Button { memoryOpen = true } label: {
                    Label("Memory", systemImage: "brain")
                        .font(.scaled(size: 14, weight: .medium))
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(chief == nil)
                .accessibilityIdentifier("cos-memory-open")
            }
            Picker("Chief of Staff", selection: $tab) {
                ForEach(CosTab.allCases, id: \.self) { t in
                    Text(t == .inbox ? inboxLabel(open) : t.label).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("cos-tabs")
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
    }

    private func inboxLabel(_ open: Int) -> String {
        CosLogic.badgeText(open).map { "Inbox · \($0)" } ?? "Inbox"
    }

    @ViewBuilder private func notes(_ chief: Cos) -> some View {
        if !chief.enabled {
            noteLine("Switched off: events wait in the Inbox until it is on.")
        }
        if let why = chief.triageUnavailable.optional {
            noteLine("Triage can't run (\(why)), so its events escalate instead.")
        }
    }

    private func noteLine(_ text: String) -> some View {
        Text(text)
            .font(.scaled(size: 13))
            .foregroundStyle(c.text2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(c.amberSoft)
            .accessibilityIdentifier("cos-note")
    }
}

// MARK: Chat

/// The chief's chat: one continuous conversation, newest at the bottom. Older entries load as the
/// top comes into view, and the reader stays on the entry they were on.
struct CosChatView: View {
    let chief: Cos

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    /// nil until the first page loaded; then the next older page's cursor, nil when there is none.
    @State private var cursor: String??
    @State private var loading = false
    @State private var draft = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    private static let page = 30
    private static let bottom = "cos-chat-bottom"

    var body: some View {
        let entries = store.cos.chat[chief.ticketId] ?? []
        let rows = CosLogic.rows(entries)
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if case let .some(.some(next)) = cursor {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .onAppear { loadOlder(next, proxy: proxy, first: rows.first?.id) }
                        }
                        if rows.isEmpty, cursor != nil {
                            emptyState
                        }
                        ForEach(rows) { row in
                            rowView(row).id(row.id)
                        }
                        Color.clear.frame(height: 1).id(Self.bottom)
                    }
                    .padding(16)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: rows.last?.id) { _, _ in
                    withAnimation(.snappy) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                }
            }
            composer
        }
        .task(id: "\(chief.ticketId)#\(store.epoch)") { await loadFirst() }
        .accessibilityIdentifier("cos-chat")
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Icon("sparkle", size: 22).foregroundStyle(c.text3)
            Text("Ask the chief of staff anything, or tell it what to keep an eye on.")
                .font(.scaled(size: 14)).foregroundStyle(c.text3).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    @ViewBuilder private func rowView(_ row: CosLogic.ChatRow) -> some View {
        switch row {
        case let .message(_, fromHuman, text):
            if fromHuman {
                MarkdownView(text: text)
                    .padding(11)
                    .background(c.accentSoft, in: UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14, bottomTrailingRadius: 14, topTrailingRadius: 4))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            } else {
                MarkdownView(text: text).frame(maxWidth: .infinity, alignment: .leading)
            }
        case let .line(_, text):
            HStack(spacing: 8) {
                Text(text).font(.scaled(size: 12)).foregroundStyle(c.text3).layoutPriority(1)
                Rectangle().fill(c.border).frame(height: 1 / 3).frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("cos-wake-line")
        case let .ticket(_, key, title, status, moved):
            CosTicketCard(key: key, title: title, status: status, moved: moved) { router.openTicket(key: key, tab: nil) }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message the chief of staff", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(c.bgSunken, in: .rect(cornerRadius: 18))
                .accessibilityIdentifier("cos-composer")
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 30)).foregroundStyle(canSend ? c.accent : c.text3)
            }
            .disabled(!canSend)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("cos-send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(c.bg)
        .overlay(alignment: .top) { Rectangle().fill(c.border).frame(height: 1 / 3) }
    }

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        Task {
            let sent = await actions.run { try await store.connectedAPI().sendCosMessage(chief.ticketId, text: text) }
            sending = false
            if sent != nil { draft = "" }
        }
    }

    private func loadFirst() async {
        guard let page = await actions.run({ try await store.connectedAPI().cosTranscript(chief.ticketId, limit: Self.page) }) else { return }
        store.updateCos { $0.mergeChat(chief.ticketId, page.entries) }
        // A refetch after a reconnect keeps the older pages already loaded.
        if cursor == nil { cursor = .some(page.nextCursor) }
    }

    private func loadOlder(_ before: String, proxy: ScrollViewProxy, first: String?) {
        guard !loading else { return }
        loading = true
        Task {
            defer { loading = false }
            guard let page = await actions.run({ try await store.connectedAPI().cosTranscript(chief.ticketId, before: before, limit: Self.page) }) else { return }
            store.updateCos { $0.mergeChat(chief.ticketId, page.entries) }
            cursor = .some(page.nextCursor)
            // The entry the reader was on stays where it was under their thumb.
            if let first { proxy.scrollTo(first, anchor: .top) }
        }
    }
}

/// A ticket the chief made or moved, as a compact card: key, title and status. Tapping opens it.
struct CosTicketCard: View {
    let key: String
    let title: String
    let status: String
    let moved: Bool
    let open: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                StatusDot(status: TicketStatus(rawValue: status), size: 10)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(key).font(.mono(12)).foregroundStyle(c.text2)
                        Text(moved ? "Moved to \(CosLogic.statusLabel(status))" : "Created · \(CosLogic.statusLabel(status))")
                            .font(.scaled(size: 12)).foregroundStyle(c.text3)
                    }
                    Text(title).font(.scaled(size: 15, weight: .medium)).foregroundStyle(c.text).lineLimit(2).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(c.text3)
            }
            .padding(12)
            .background(c.bgElev, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 1 / 3))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(key), \(title), \(CosLogic.statusLabel(status))")
        .accessibilityHint("Opens the ticket")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("cos-ticket-card")
    }
}

// MARK: Inbox

/// A plain list of the events the chief owns (and the unassigned ones): what happened and the
/// verdict. "Escalate anyway" shows on ignored rows only; "+" asks the chief to listen for something.
struct CosInboxView: View {
    let chief: Cos
    let onChat: () -> Void

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @State private var cursor: String??
    @State private var loading = false
    @State private var asking = false

    private static let page = 50

    var body: some View {
        let rows = store.cos.inbox(chief.ticketId)
        VStack(spacing: 0) {
            HStack {
                Text("What this chief of staff has seen").font(.scaled(size: 13)).foregroundStyle(c.text3)
                Spacer()
                Button { asking = true } label: { Label("Listen", systemImage: "plus").font(.scaled(size: 14, weight: .medium)) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("Listen for something")
                    .accessibilityIdentifier("cos-listen")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            ScrollView {
                LazyVStack(spacing: 10) {
                    if rows.isEmpty, cursor != nil {
                        VStack(spacing: 8) {
                            Icon("inbox", size: 22).foregroundStyle(c.text3)
                            Text("Nothing yet. Ticket moves, watcher items and schedules show up here.")
                                .font(.scaled(size: 14)).foregroundStyle(c.text3).multilineTextAlignment(.center)
                        }
                        .padding(.vertical, 40)
                        .accessibilityIdentifier("cos-inbox-empty")
                    }
                    ForEach(rows) { e in
                        CosEventRow(event: e, escalate: { escalate(e) }, openTicket: { key in router.openTicket(key: key, tab: nil) })
                    }
                    if case let .some(.some(next)) = cursor {
                        Button(loading ? "Loading…" : "Load more") { Task { await load(before: next) } }
                            .disabled(loading)
                            .padding(.vertical, 8)
                            .accessibilityIdentifier("cos-more")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            .refreshable { await load(before: nil) }
        }
        .task(id: "\(chief.ticketId)#\(store.epoch)") { await load(before: nil) }
        .sheet(isPresented: $asking) {
            CosListenSheet(chief: chief) {
                asking = false
                onChat()
            }
        }
        .accessibilityIdentifier("cos-inbox")
    }

    private func load(before: String?) async {
        loading = true
        defer { loading = false }
        guard let page = await actions.run({ try await store.connectedAPI().cosEvents(chief.ticketId, before: before, limit: Self.page) }) else { return }
        store.updateCos { $0.mergeEvents(page.items) }
        // A reload of the newest page keeps the cursor of older pages already loaded.
        if before != nil || cursor == nil { cursor = .some(page.nextCursor) }
    }

    private func escalate(_ e: CosEvent) {
        Task {
            guard let next = await actions.run({ try await store.connectedAPI().escalateCosEvent(e.id) }) else { return }
            store.updateCos { $0.mergeEvents([next]) }
        }
    }
}

struct CosEventRow: View {
    let event: CosEvent
    let escalate: () -> Void
    let openTicket: (String) -> Void

    @Environment(\.palette) private var c

    var body: some View {
        let e = event
        let st = CosLogic.inboxState(e)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Badge(CosLogic.sourceLabel(e.sourceKind))
                if let key = e.ticketKey {
                    Button { openTicket(key) } label: { Text(key).font(.mono(12)).foregroundStyle(c.accent) }
                        .buttonStyle(.plain)
                } else if let project = e.projectKey {
                    Text(project).font(.mono(12)).foregroundStyle(c.text3)
                }
                Spacer(minLength: 0)
                Badge(st.label, tone: tone(st))
                    .accessibilityIdentifier("cos-verdict")
            }
            Text(e.title).font(.scaled(size: 15, weight: .medium)).foregroundStyle(c.text).frame(maxWidth: .infinity, alignment: .leading)
            if !e.summary.isEmpty {
                Text(e.summary).font(.scaled(size: 13)).foregroundStyle(c.text2).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let line = CosLogic.verdictLine(e) {
                Text(line).font(.scaled(size: 13)).foregroundStyle(c.text2).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier(st == .handled ? "cos-handled" : "cos-reason")
            }
            HStack {
                Text("\(e.actor) · ").font(.scaled(size: 12)).foregroundStyle(c.text3) + Text(Format.relativeTime(e.createdAt, now: Date().timeIntervalSince1970 * 1000)).font(.scaled(size: 12)).foregroundStyle(c.text3)
                Spacer()
                if CosLogic.canEscalate(e) {
                    Button("Escalate anyway", action: escalate)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityIdentifier("cos-escalate")
                }
            }
        }
        .padding(12)
        .background(c.bgElev, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 1 / 3))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("cos-event")
    }

    private func tone(_ s: CosInboxState) -> Tone {
        switch s {
        case .waiting, .escalated, .handling: .amber
        case .handled: .green
        case .ignored, .filtered: .neutral
        }
    }
}

/// The "+": what to listen for, sent to the chief as a chat message; it sets the listener up itself.
struct CosListenSheet: View {
    let chief: Cos
    let sent: () -> Void

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var c
    @State private var text = ""
    @State private var sending = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("Tell the chief of staff what to listen for. It sets up the listener itself and asks if it needs more.")
                    .font(.scaled(size: 14)).foregroundStyle(c.text2)
                TextField("Listen to GitHub for PR feedback on …", text: $text, axis: .vertical)
                    .lineLimit(4...10)
                    .padding(12)
                    .background(c.bgSunken, in: .rect(cornerRadius: 10))
                    .accessibilityIdentifier("cos-listen-input")
                if !chief.enabled {
                    Text("This chief of staff is off: turn it on in Settings to have it act on this.")
                        .font(.scaled(size: 13)).foregroundStyle(c.text3)
                }
                Spacer()
            }
            .padding(16)
            .background(c.bg)
            .navigationTitle("Listen for something")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ask", action: ask)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending || !chief.enabled)
                        .accessibilityIdentifier("cos-listen-send")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func ask() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        Task {
            let ok = await actions.run { try await store.connectedAPI().sendCosMessage(chief.ticketId, text: body) }
            sending = false
            if ok != nil { sent() }
        }
    }
}

// MARK: Memory

/// The chief's memory document, triage guidance included, viewable and editable. A save against a
/// stale revision asks whether to load the chief's version or keep yours.
struct CosMemorySheet: View {
    let chief: Cos

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var c
    @State private var text = ""
    @State private var revision: String?
    @State private var loaded = false
    @State private var saving = false
    @State private var conflict: MemoryConflict?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Group {
                if loaded {
                    TextEditor(text: $text)
                        .font(.mono(14))
                        .scrollContentBackground(.hidden)
                        .padding(10)
                        .background(c.bgSunken, in: .rect(cornerRadius: 10))
                        .padding(16)
                        .accessibilityIdentifier("cos-memory-text")
                } else if let failure {
                    Text(failure).font(.scaled(size: 14)).foregroundStyle(c.red).padding(16)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(c.bg)
            .navigationTitle("Memory")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(base: revision) }
                        .disabled(!loaded || saving)
                        .accessibilityIdentifier("cos-memory-save")
                }
            }
        }
        .presentationDetents([.large])
        .task { await load() }
        .confirmationDialog("The chief changed its memory", isPresented: Binding(get: { conflict != nil }, set: { if !$0 { conflict = nil } }), titleVisibility: .visible, presenting: conflict) { latest in
            Button("Load the chief's version") {
                text = latest.text
                revision = latest.currentRevision
            }
            Button("Keep mine") { save(base: latest.currentRevision) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its memory changed while you were editing. Load its version, losing your edits, or keep yours and replace it.")
        }
    }

    private func load() async {
        do {
            let memory = try await store.connectedAPI().getCosMemory(chief.key)
            text = memory.text
            revision = memory.revision
            loaded = true
        } catch {
            failure = Connection.describeError(error, baseUrl: store.baseUrl)
        }
    }

    private func save(base: String?) {
        guard let base else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                let saved = try await store.connectedAPI().putCosMemory(chief.key, text: text, baseRevision: base)
                revision = saved.revision
                dismiss()
            } catch let e as HarnessAPIError where e.memoryConflict != nil {
                conflict = e.memoryConflict
            } catch {
                haptic(.error)
                failure = Connection.describeError(error, baseUrl: store.baseUrl)
            }
        }
    }
}

// MARK: The board's button

/// "Chief of Staff" beside the Projects button on the board's bar: opens the chief of the board's
/// scope, with the count of events awaiting a verdict or being handled. There is no on/off switch
/// here: the app and per-project defaults live in Settings.
struct CosButton: View {
    let scope: String

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c

    var body: some View {
        let count = CosLogic.badgeCount(store.cos.badge, cosId: store.cos.chief(scope: scope)?.ticketId)
        Button {
            openCos(scope: scope, store: store, router: router, actions: actions)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "sparkle")
                Text("Chief of Staff").font(.scaled(size: 15, weight: .medium))
                if let text = CosLogic.badgeText(count) {
                    Text(text)
                        .font(.scaled(size: 11, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(c.onAmber)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 17, minHeight: 17)
                        .background(c.amber, in: .capsule)
                        .accessibilityIdentifier("cos-callout-badge")
                }
            }
        }
        .accessibilityLabel("Chief of Staff")
        .accessibilityValue(count > 0 ? "\(count) waiting" : "")
        .accessibilityIdentifier("cos-callout")
    }
}
