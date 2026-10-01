import HarnessKit
import SwiftUI

/// A session's conversation (screens/Transcript.tsx), or with `subagentId` one of its sub-agents':
/// the REST backfill merged with live transcript.appended events, the streaming delta of the
/// current run, tool calls paired with their results as collapsible rows, and permission audit
/// rows. It opens at the bottom and sticks there while the user is at the bottom.
///
/// Inside a ticket screen the tool rows that started sub-agents link to their `agent:<id>` tabs
/// (`\.ticketDetailOpenTab`). `header` scrolls with the transcript, above the first entry.
struct TranscriptView<Header: View>: View {
    let sessionId: String
    var subagentId: String?
    var emptyHint: String?
    @ViewBuilder var header: Header

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @State private var error: String?
    @State private var memo = TranscriptItemsMemo()
    @State private var limit = TranscriptLogic.windowStep

    var body: some View {
        let state = store.state
        let transcript = state.transcripts[BoardState.transcriptKey(sessionId, subagentId)]
        let items = memo.items(transcript?.entries ?? [])
        let deltas = TranscriptLogic.deltas(state, sessionId: sessionId, subagentId: subagentId)
        let working = TranscriptLogic.working(state, sessionId: sessionId, subagentId: subagentId)
        let rows = TranscriptLogic.rows(items: items, deltas: deltas, working: working)
        let subagents = state.subagentsOf(sessionId)
        let who = TranscriptLogic.who(subagentId: subagentId)
        let loading = transcript?.loaded != true && error == nil
        let window = TranscriptLogic.window(rows, limit: limit)

        ScrollViewReader { proxy in
            ScrollView {
                list(window, empty: rows.isEmpty, loading: loading, who: who, subagents: subagents) { first in
                    // The next batch, keeping the row the user was reading at the top.
                    limit += TranscriptLogic.windowStep
                    if let first { DispatchQueue.main.async { proxy.scrollTo(first, anchor: .top) } }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .ticketStickToBottom()
            .ticketHeroScroll()
        }
        .task(id: "\(sessionId)/\(subagentId ?? "")/\(store.epoch)") { await backfill() }
    }

    /// A plain stack of the window's rows (not a lazy one: see TranscriptLogic.windowStep).
    private func list(_ window: (rows: ArraySlice<TranscriptLogic.Row>, hidden: Int), empty: Bool, loading: Bool, who: String,
                      subagents: [Subagent]?, showEarlier: @escaping (String?) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if window.hidden > 0 {
                HButton("Show earlier messages (\(window.hidden))", icon: "arrowUp", variant: .ghost, small: true) {
                    showEarlier(window.rows.first?.id)
                }
            }
            if let error {
                HStack(alignment: .top, spacing: 6) {
                    Icon("alert", size: 14).foregroundStyle(c.red)
                    Text("Couldn't load the transcript: \(error)").font(.system(size: 15)).foregroundStyle(c.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(10)
                .background(c.redSoft, in: .rect(cornerRadius: 8))
            }
            if empty {
                if loading {
                    Spinner().padding(30).frame(maxWidth: .infinity)
                } else {
                    EmptyState(icon: "message", title: "No messages yet", message: emptyHint ?? defaultHint)
                        .padding(.top, 30)
                }
            }
            ForEach(window.rows) { row in
                TranscriptRowView(row: row, who: who, agent: agent(for: row, in: subagents))
                    .equatable()
                    .id(row.id)
            }
        }
        .padding(14)
        .padding(.bottom, 10)
    }

    private var defaultHint: String {
        subagentId == nil ? "The agent's conversation will stream in here." : "The sub-agent's conversation will stream in here."
    }

    private func agent(for row: TranscriptLogic.Row, in subagents: [Subagent]?) -> Subagent? {
        guard case let .item(.tool(call, _)) = row else { return nil }
        return TranscriptLogic.agent(for: call, in: subagents)
    }

    private func backfill() async {
        error = nil
        guard let api = store.client as? HarnessClient else { return }
        do {
            let entries = try await api.transcript(sessionId, after: 0, subagentId: subagentId)
            guard !Task.isCancelled else { return }
            store.dispatch(.transcript(sessionId: sessionId, subagentId: Patch(subagentId), entries: entries))
        } catch {
            guard !Task.isCancelled else { return }
            self.error = Connection.describeError(error)
        }
    }
}

extension TranscriptView where Header == EmptyView {
    init(sessionId: String, subagentId: String? = nil, emptyHint: String? = nil) {
        self.init(sessionId: sessionId, subagentId: subagentId, emptyHint: emptyHint) { EmptyView() }
    }
}

/// `groupTranscript` of the last entries it saw. A delta re-renders the transcript many times a
/// second while its entries stay the same array (same buffer, so `==` is immediate), so the
/// grouping only reruns when an entry lands.
@MainActor
final class TranscriptItemsMemo {
    private var entries: [TranscriptEntry] = []
    private var cached: [Format.TranscriptItem] = []

    func items(_ next: [TranscriptEntry]) -> [Format.TranscriptItem] {
        if next != entries || (cached.isEmpty && !next.isEmpty) {
            entries = next
            cached = Format.groupTranscript(next)
        }
        return cached
    }
}
