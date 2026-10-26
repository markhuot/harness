import HarnessKit
import SwiftUI

// MARK: Events

/// A list of a ticket's events, newest first: a chief's Inbox (CosInboxView) and any ticket's Events
/// tab (TicketTabBody) are this same view. Each row says what kind of event it is, what happened, the
/// verdict and, once handled, who handled it. Only a chief's Inbox can escalate an ignored row.
struct EventsView: View {
    let ticketId: String
    /// A chief's Inbox: also lists the unassigned events and offers "Escalate anyway".
    let chief: Bool
    let emptyText: String
    /// The view's accessibility identifier ("cos-inbox", "ticket-events")
    let identifier: String

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @State private var cursor: String??
    @State private var loading = false
    @State private var failure: String?

    private static let page = 50

    var body: some View {
        let rows = store.cos.rows(ticketId: ticketId, chief: chief)
        VStack(spacing: 0) {
            if let failure { CosFailureBanner(text: failure) { self.failure = nil } }
            ScrollView {
                LazyVStack(spacing: 10) {
                    if rows.isEmpty, cursor != nil {
                        VStack(spacing: 8) {
                            Icon("inbox", size: 22).foregroundStyle(c.text3)
                            Text(emptyText)
                                .font(.scaled(size: 14)).foregroundStyle(c.text3).multilineTextAlignment(.center)
                        }
                        .padding(.vertical, 40)
                        .accessibilityIdentifier("cos-inbox-empty")
                    }
                    ForEach(rows) { e in
                        EventRow(event: e, chief: chief, escalate: { escalate(e) }, openTicket: { key in router.openTicket(key: key, tab: nil) })
                    }
                    if case let .some(.some(next)) = cursor {
                        Button(loading ? "Loading…" : "Load more") { Task { await load(before: next) } }
                            .disabled(loading)
                            .padding(.vertical, 8)
                            .accessibilityIdentifier("cos-more")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, chief ? 0 : 8)
                .padding(.bottom, 16)
            }
            .refreshable { await load(before: nil) }
        }
        .task(id: "\(ticketId)#\(store.epoch)") { await load(before: nil) }
        .accessibilityIdentifier(identifier)
    }

    private func load(before: String?) async {
        loading = true
        defer { loading = false }
        let page: TicketEventPage
        do {
            page = try await store.connectedAPI().ticketEvents(ticketId, before: before, limit: Self.page)
        } catch {
            haptic(.error)
            failure = Connection.describeError(error, baseUrl: store.baseUrl)
            return
        }
        failure = nil
        var hole = false
        if before == nil {
            store.updateCos { hole = $0.loadNewestEvents(ticketId, page.items, hasOlder: page.nextCursor != nil, chief: chief) }
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

struct EventRow: View {
    let event: TicketEvent
    /// In a chief's Inbox: the verdict wording and "Escalate anyway"; else the delivery wording.
    let chief: Bool
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
                Badge(st.label(chief: chief), tone: tone(st))
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
                if chief, CosLogic.canEscalate(e) {
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
