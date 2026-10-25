import HarnessKit
import SwiftUI

// A chief of staff's pane: the Chat, Inbox and Listeners tabs and the memory sheet. It is a card of the ticket
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
    @State private var openFailure: String?

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
                case .listeners: CosListenersView(chief: chief, onChat: { tab = .chat })
                }
            } else if let openFailure {
                Spacer()
                VStack(spacing: 10) {
                    Text(openFailure).font(.scaled(size: 14)).foregroundStyle(c.red).multilineTextAlignment(.center)
                    Button("Try again") { Task { await makeChief() } }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("cos-open-retry")
                }
                .padding(24)
                .accessibilityIdentifier("cos-open-failure")
                Spacer()
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
        .task(id: scope) { await makeChief() }
        .accessibilityIdentifier("cos-view")
    }

    /// A link to a chief that isn't made yet makes it, like the board's button.
    private func makeChief() async {
        guard store.cos.chief(scope: scope) == nil else { return }
        openFailure = nil
        do {
            let chief = try await store.connectedAPI().openCos(scope: scope)
            store.updateCos { $0.chiefs[chief.ticketId] = chief }
        } catch {
            haptic(.error)
            openFailure = Connection.describeError(error, baseUrl: store.baseUrl)
        }
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
    @State private var sending = false
    @State private var focused = false
    @State private var failure: String?
    @State private var uploader = PromptAttachmentUploader()

    private static let page = 30
    private static let bottom = "cos-chat-bottom"

    var body: some View {
        let entries = store.cos.chat[chief.ticketId] ?? []
        let rows = CosLogic.rows(entries)
        let attachTarget: (any PromptAttachmentTarget)? = chief.enabled ? store.messageDraft(forChief: chief).attachments : nil
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
            if let failure { CosFailureBanner(text: failure) { self.failure = nil } }
            composer
        }
        .task(id: "\(chief.ticketId)#\(store.epoch)") { await loadFirst() }
        .modifier(PromptAttachmentDrop(target: attachTarget, uploader: uploader))
        .modifier(PromptAttachmentPickers(target: attachTarget, uploader: uploader))
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
        case let .message(_, fromHuman, text, attachments):
            if fromHuman {
                VStack(alignment: .trailing, spacing: 4) {
                    // A message of only files has no bubble.
                    if !TicketDetailLogic.trim(text).isEmpty || attachments.isEmpty {
                        // Shrinks to fit a short message; a table or code block needs a definite width.
                        TranscriptBubbleWidth(fraction: 0.92, fill: MarkdownView.scrollsSideways(text)) {
                            MarkdownView(text: text)
                                .padding(11)
                                .background(c.accentSoft, in: UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14, bottomTrailingRadius: 14, topTrailingRadius: 4))
                        }
                    }
                    if !attachments.isEmpty {
                        TranscriptMessageAttachments(list: attachments)
                    }
                }
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

    /// The ticket composer's pieces on the chief's hidden ticket: the glass field with /commands (no
    /// @file: the chief's folder is the service home), (+) for Photos/Files/Paste, the tray of
    /// uploaded files and Send. The text and files are the chief's message draft, saved as typed.
    private var composer: some View {
        let draft = store.messageDraft(forChief: chief)
        let outgoing = draft.attachments
        let empty = TicketDetailLogic.trim(draft.text).isEmpty
        let canSend = chief.enabled && TicketDetailLogic.canSendMessage(text: draft.text, attachments: outgoing.count, uploading: uploader.pending.count,
                                                                        sending: sending, approvalPending: false)
        return VStack(spacing: 4) {
            if !outgoing.isEmpty || !uploader.pending.isEmpty {
                ComposerAttachmentTray(uploader: uploader, outgoing: outgoing, sending: sending)
            }
            HStack(alignment: .bottom, spacing: 8) {
                if chief.enabled {
                    ComposerAttachButton(uploader: uploader, outgoing: outgoing, sending: sending)
                }
                MentionTextEditor(text: Binding(get: { draft.text }, set: { draft.setText($0) }),
                                  placeholder: chief.enabled ? "Message the chief of staff" : "Switched off",
                                  ticketKey: chief.key,
                                  minLines: 1,
                                  maxLines: 6,
                                  suggestionsEdge: .top,
                                  suggestionsMaxHeight: 200,
                                  search: { _ in [] },
                                  fieldLabel: "Message the chief of staff",
                                  onFocusChange: { now in
                                      focused = now
                                      draft.focus(now, stored: chief.messageDraft.optional)
                                  },
                                  fieldBox: MentionFieldBox(border: nil, cornerRadius: 22,
                                                            padding: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16),
                                                            glass: true),
                                  onSubmit: { send() })
                    .disabled(!chief.enabled)
                    .accessibilityIdentifier("cos-composer")
                ComposerSendButton(sending: sending, active: chief.enabled && (focused || !empty || !outgoing.isEmpty), disabled: !canSend,
                                   hint: !uploader.pending.isEmpty ? "Wait for the attachments to upload" : "Write a message first") { send() }
                    .accessibilityIdentifier("cos-send")
            }
        }
        .padding(.top, 6)
        // Inset and concentric with the phone's corners at rest, over the keyboard while writing,
        // as the ticket composer is.
        .concentricBottomPadding(barHeight: DockMetrics.barHeight, raised: focused, horizontal: 12, bottom: 8)
        .animation(.snappy, value: focused)
        // Another device's edit (or its send) shows here, unless this one is being typed in.
        .onChange(of: chief.messageDraft.optional, initial: true) { _, saved in draft.sync(saved) }
        .onAppear { draft.onError = { _ in haptic(.error) } }
        // Leaving the chat with the field focused sends no blur: the draft isn't being typed in anymore.
        .onDisappear { draft.focus(false, stored: chief.messageDraft.optional) }
    }

    private func send() {
        let draft = store.messageDraft(forChief: chief)
        let outgoing = draft.attachments
        guard chief.enabled, TicketDetailLogic.canSendMessage(text: draft.text, attachments: outgoing.count, uploading: uploader.pending.count,
                                                              sending: sending, approvalPending: false) else { return }
        let text = TicketDetailLogic.trim(draft.text)
        let files = outgoing.list
        let attachments = outgoing.inputs
        let id = chief.ticketId
        sending = true
        failure = nil
        Task {
            // No draft save may land after the message: the service clears the draft when it goes.
            await draft.beforeSend()
            do {
                _ = try await store.connectedAPI().sendCosMessage(id, text: text, attachments: attachments)
                haptic(.success)
                // Files attached while it was sending stay for the next message.
                draft.sent(files: files)
            } catch {
                haptic(.error)
                failure = Connection.describeError(error, baseUrl: store.baseUrl)
                draft.sendFailed()
            }
            sending = false
        }
    }

    private func loadFirst() async {
        let page: CosChatPage
        do {
            page = try await store.connectedAPI().cosTranscript(chief.ticketId, limit: Self.page)
        } catch {
            haptic(.error)
            failure = Connection.describeError(error, baseUrl: store.baseUrl)
            return
        }
        var hole = false
        store.updateCos { hole = $0.loadNewestChat(chief.ticketId, page.entries, hasOlder: page.nextCursor != nil) }
        // A refetch after a reconnect keeps the older pages already loaded, unless the new page
        // doesn't reach them: then paging starts again from this page.
        if cursor == nil || hole { cursor = .some(page.nextCursor) }
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

/// A failed request, in words, above the composer or list it came from. Tapping dismisses it.
struct CosFailureBanner: View {
    let text: String
    let dismiss: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        Button(action: dismiss) {
            Text(text)
                .font(.scaled(size: 13))
                .foregroundStyle(c.red)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(c.redSoft)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Dismisses the message")
        .accessibilityIdentifier("cos-failure")
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
    @State private var failure: String?

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
            if let failure { CosFailureBanner(text: failure) { self.failure = nil } }
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
        let page: TicketEventPage
        do {
            page = try await store.connectedAPI().ticketEvents(chief.ticketId, before: before, limit: Self.page)
        } catch {
            haptic(.error)
            failure = Connection.describeError(error, baseUrl: store.baseUrl)
            return
        }
        failure = nil
        var hole = false
        if before == nil {
            store.updateCos { hole = $0.loadNewestEvents(chief.ticketId, page.items, hasOlder: page.nextCursor != nil) }
        } else {
            store.updateCos { $0.mergeEvents(page.items) }
        }
        // A reload of the newest page keeps the cursor of older pages already loaded, unless the
        // new page doesn't reach them: then paging starts again from this page.
        if before != nil || cursor == nil || hole { cursor = .some(page.nextCursor) }
    }

    private func escalate(_ e: TicketEvent) {
        failure = nil
        Task {
            do {
                let next = try await store.connectedAPI().escalateCosEvent(e.id)
                store.updateCos { $0.mergeEvents([next]) }
            } catch {
                haptic(.error)
                failure = Connection.describeError(error, baseUrl: store.baseUrl)
            }
        }
    }
}

struct CosEventRow: View {
    let event: TicketEvent
    let escalate: () -> Void
    let openTicket: (String) -> Void

    @Environment(\.palette) private var c
    @State private var lookingUp = false

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
                    .accessibilityIdentifier(st == .acted || st == .noAction || st == .needsUser ? "cos-outcome" : "cos-reason")
            }
            HStack {
                Text("\(e.actor) · ").font(.scaled(size: 12)).foregroundStyle(c.text3) + Text(Format.relativeTime(e.createdAt, now: Date().timeIntervalSince1970 * 1000)).font(.scaled(size: 12)).foregroundStyle(c.text3)
                Spacer()
                if e.triageSessionId != nil {
                    Button("What triage looked up") { lookingUp = true }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityIdentifier("cos-triage-run")
                }
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
        .sheet(isPresented: $lookingUp) {
            if let session = e.triageSessionId {
                NavigationStack {
                    TranscriptView(sessionId: session, emptyHint: "The triage run left no transcript.") { EmptyView() }
                        .navigationTitle("Triage")
                        .navigationBarTitleDisplayMode(.inline)
                }
            }
        }
    }

    private func tone(_ s: CosInboxState) -> Tone {
        switch s {
        case .waiting, .escalated, .handling, .needsUser: .amber
        case .acted: .green
        case .ignored, .filtered, .noAction, .reviewed: .neutral
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
    @State private var failure: String?

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
                    Text("This chief of staff is switched off, so it can't act on this until it is on.")
                        .font(.scaled(size: 13)).foregroundStyle(c.text3)
                }
                if let failure { Text(failure).font(.scaled(size: 13)).foregroundStyle(c.red) }
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
        failure = nil
        Task {
            defer { sending = false }
            do {
                _ = try await store.connectedAPI().sendCosMessage(chief.ticketId, text: body)
                sent()
            } catch {
                haptic(.error)
                failure = Connection.describeError(error, baseUrl: store.baseUrl)
            }
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
                    VStack(spacing: 0) {
                        if let failure { CosFailureBanner(text: "Not saved: \(failure)") { self.failure = nil } }
                        TextEditor(text: $text)
                            .font(.mono(14))
                            .scrollContentBackground(.hidden)
                            .padding(10)
                            .background(c.bgSunken, in: .rect(cornerRadius: 10))
                            .padding(16)
                            .accessibilityIdentifier("cos-memory-text")
                    }
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
        failure = nil
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

/// The Chief of Staff star in its own capsule on the board's bar: opens the chief of the board's
/// scope (VoiceOver reads the count of events awaiting a verdict or being handled; nothing is drawn).
/// There is no on/off switch here: the app and per-project defaults live in Settings.
struct CosButton: View {
    let scope: String

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions

    var body: some View {
        let count = CosLogic.badgeCount(store.cos.badge, cosId: store.cos.chief(scope: scope)?.ticketId)
        Button {
            openCos(scope: scope, store: store, router: router, actions: actions)
        } label: {
            Image(systemName: "sparkle")
        }
        .accessibilityLabel("Chief of Staff")
        .accessibilityValue(count > 0 ? "\(count) waiting" : "")
        .accessibilityIdentifier("cos-callout")
    }
}
