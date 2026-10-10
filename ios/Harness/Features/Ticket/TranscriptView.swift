import HarnessKit
import SwiftUI

/// A session's conversation, or with `subagentId` one of its sub-agents':
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
    @State private var pins = RunHeaderPins()

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
        // Split after the window, so a run the window cuts through still gets its header.
        let sections = RunSections.split(Array(window.rows), at: RunSections.rowRun)
        let headers = sections.map { s in
            s.runId.map { id in
                let h = RunSections.header(run: state.runs[id], startText: s.startText, firstAt: s.firstAt, drivers: state.drivers)
                return RunHeaderInfo(runId: id, title: h.title, time: h.at.map(transcriptTime))
            }
        }

        ScrollViewReader { proxy in
            ScrollView {
                list(window.hidden, sections: sections, headers: headers, empty: rows.isEmpty, loading: loading, who: who, subagents: subagents) { first in
                    // The next batch, keeping the row the user was reading at the top.
                    limit += TranscriptLogic.windowStep
                    if let first { DispatchQueue.main.async { proxy.scrollTo(first, anchor: .top) } }
                }
            }
            .coordinateSpace(name: RunHeaderPins.space)
            .scrollDismissesKeyboard(.interactively)
            .ticketStickToBottom()
            .ticketHeroScroll()
            .overlay(alignment: .top) { TranscriptPinnedHeader(pins: pins, headers: headers.map { $0 }) }
        }
        .task(id: "\(sessionId)/\(subagentId ?? "")/\(store.epoch)") { await backfill() }
    }

    /// A plain stack of the window's rows (not a lazy one: see TranscriptLogic.windowStep).
    private func list(_ hidden: Int, sections: [RunSections.Section<TranscriptLogic.Row>], headers: [RunHeaderInfo?], empty: Bool, loading: Bool,
                      who: String, subagents: [Subagent]?, showEarlier: @escaping (String?) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if hidden > 0 {
                HButton("Show earlier messages (\(hidden))", icon: "arrowUp", variant: .ghost, small: true) {
                    showEarlier(sections.lazy.flatMap(\.rows).first?.id)
                }
            }
            if let error {
                HStack(alignment: .top, spacing: 6) {
                    Icon("alert", size: 14).foregroundStyle(c.red)
                    Text("Couldn't load the transcript: \(error)").font(.scaled(size: 15)).foregroundStyle(c.red)
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
            ForEach(Array(sections.enumerated()), id: \.offset) { i, section in
                VStack(alignment: .leading, spacing: 10) {
                    if let info = headers[i] {
                        TranscriptRunHeaderRow(title: info.title, time: info.time)
                            .id("run-header-\(i)")
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { pins.height = $0 }
                    }
                    ForEach(section.rows) { row in
                        TranscriptRowView(row: row, who: who, agent: agent(for: row, in: subagents))
                            .equatable()
                            .id(row.id)
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(RunHeaderPins.space)).minY } action: { pins.tops[i] = $0 }
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
        do {
            // A dead client is an error to show, not a transcript that never loads.
            let entries = try await store.connectedAPI().transcript(sessionId, after: 0, subagentId: subagentId)
            guard !Task.isCancelled else { return }
            store.dispatch(.transcript(sessionId: sessionId, subagentId: Patch(subagentId), entries: entries))
        } catch {
            guard !Task.isCancelled else { return }
            self.error = Connection.describeError(error)
        }
    }
}

/// One section's header text, for its inline row and the pinned copy.
struct RunHeaderInfo: Equatable {
    let runId: String
    let title: String
    let time: String?
}

/// Where each section sits in the scroll view (its top, in the scroll view's own space).
/// A class with observed properties, so the scroll ticks that write them redraw only the overlay that
/// reads them (TranscriptPinnedHeader), not the transcript's rows.
@MainActor @Observable
final class RunHeaderPins {
    static let space = "transcript-scroll"
    var tops: [Int: CGFloat] = [:]
    var height: CGFloat = 32
}

/// The current run's header, drawn over the top of the transcript. It's picked from where the inline
/// headers sit and shifts up as the next run's header reaches it, so the next one pushes it off. The
/// list is a plain stack (a lazy one with pinned headers breaks stick-to-bottom), so the pinning is
/// done here. It doesn't take taps.
struct TranscriptPinnedHeader: View {
    let pins: RunHeaderPins
    let headers: [RunHeaderInfo?]

    @Environment(\.palette) private var c

    var body: some View {
        let height = Double(pins.height)
        let tops = headers.indices.map { pins.tops[$0].map(Double.init) }
        if let pin = RunSections.pinned(tops: tops, headed: headers.map { $0 != nil }, height: height), let info = headers[pin.index] {
            TranscriptRunHeaderRow(title: info.title, time: info.time, pinned: true)
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity)
                .background(c.bg)
                .offset(y: pin.offset)
                .frame(height: pins.height, alignment: .top)
                .clipped()
                .allowsHitTesting(false)
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
