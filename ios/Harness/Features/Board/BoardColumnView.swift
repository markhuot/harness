import HarnessKit
import SwiftUI

/// The status chips over the board: dot, label and count for each column. Tapping one pages to
/// that column, the strip keeps the current chip in view, and a card dragged onto a chip moves there.
struct BoardStatusStrip: View {
    let page: TicketStatus
    let count: (TicketStatus) -> Int
    let dropChip: TicketStatus?
    let onTap: (TicketStatus) -> Void
    let onDrop: (String, TicketStatus) -> Bool
    let onTarget: (TicketStatus, Bool) -> Void

    @Environment(\.palette) private var c

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 4) {
                    ForEach(TicketStatus.allKnown, id: \.self) { s in chip(s).id(s) }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .scrollIndicators(.hidden)
            .onChange(of: page, initial: true) { _, p in
                withAnimation(.snappy) { proxy.scrollTo(p, anchor: .center) }
            }
        }
    }

    private func chip(_ s: TicketStatus) -> some View {
        let on = s == page
        let target = dropChip == s
        let n = count(s)
        return Button { onTap(s) } label: {
            HStack(spacing: 7) {
                StatusDot(status: s)
                Text(statusLabel(s))
                    .font(.system(size: 14, weight: on ? .semibold : .medium))
                    .foregroundStyle(on ? c.text : c.text2)
                Text("\(n)")
                    .font(.system(size: 13))
                    .monospacedDigit()
                    .foregroundStyle(c.text3)
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(target ? c.accentSoft : on ? c.bgElev : .clear, in: .capsule)
            .overlay(Capsule().strokeBorder(target ? c.accent : on ? c.border : .clear, lineWidth: target ? 1.5 : 1 / 3))
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(statusLabel(s)), \(n)")
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .dropDestination(for: String.self) { keys, _ in
            guard let key = keys.first else { return false }
            return onDrop(key, s)
        } isTargeted: { onTarget(s, $0) }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

/// One column's page: its cards with pull to refresh, Done's older pages (and search results') as
/// it nears the end, and the empty and footer states.
struct BoardColumnView: View {
    let status: TicketStatus
    let ctx: BoardContext
    let onMove: (Ticket, TicketStatus, BoardColumns.Where) -> Void
    /// A card (by key) dropped above `before` (nil: at the end).
    let onDrop: (String, String?) -> Bool
    let onDiscard: (Ticket) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    /// How close to the end (in cards) a column asks for the next page.
    private static let endThreshold = 6

    var body: some View {
        let cards = ctx.shown[status]
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(Array(cards.enumerated()), id: \.element.id) { i, t in
                    BoardTicketCard(ticket: t, showProject: ctx.projectId == nil, onMove: onMove, onDiscard: onDiscard)
                        .draggable(t.key) { BoardDragPreview(ticket: t) }
                        .dropDestination(for: String.self) { keys, _ in
                            guard let key = keys.first else { return false }
                            return onDrop(key, t.id)
                        }
                        .onAppear { if i >= cards.count - Self.endThreshold { onEnd() } }
                }
                if cards.isEmpty { empty }
                footer
                // The rest of the column takes drops at the end.
                Color.clear
                    .frame(maxWidth: .infinity, minHeight: 80)
                    .contentShape(.rect)
                    .dropDestination(for: String.self) { keys, _ in
                        guard let key = keys.first else { return false }
                        return onDrop(key, nil)
                    }
                    .accessibilityHidden(true)
            }
            .padding(14)
        }
        .refreshable { await store.refresh() }
    }

    private func onEnd() {
        if ctx.searching {
            store.loader.loadMoreSearch()
        } else if status == .done {
            store.loader.loadMoreDone(ctx.projectId)
        }
    }

    @ViewBuilder private var empty: some View {
        let p = ctx.paging
        Group {
            if ctx.total == 0 && status == .planning && !ctx.searchTab {
                EmptyState(icon: "plus", title: "No sessions yet", message: "Start one with + in the top right.")
            } else if ctx.searching && ctx.pending {
                emptyText("Searching…")
            } else if !ctx.searching && status == .done && !store.loader.legacy && (p == nil || p!.loading || store.loader.canLoadMoreDone(ctx.projectId)) && p?.error == nil {
                Spinner()
            } else {
                emptyText(ctx.searching ? "No matches" : Format.columnEmptyText[status] ?? "")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .padding(.horizontal, 12)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.borderStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .dropDestination(for: String.self) { keys, _ in
            guard let key = keys.first else { return false }
            return onDrop(key, nil)
        }
    }

    private func emptyText(_ s: String) -> some View {
        Text(s).font(.system(size: 14)).foregroundStyle(c.text3).multilineTextAlignment(.center)
    }

    /// Under the cards: the next page loading, or a failed Done page with Retry.
    @ViewBuilder private var footer: some View {
        if ctx.searching {
            // Search pages are shared by every column; the status line above carries errors.
            if let s = ctx.search, s.loading, s.ids != nil {
                Spinner().padding(.vertical, 16)
            }
        } else if status == .done, let p = ctx.paging {
            if p.error != nil {
                Button { store.loader.retryDone(ctx.projectId) } label: {
                    Text("Couldn't load older tickets. \(Text("Retry").fontWeight(.semibold).foregroundStyle(c.accentText))")
                        .font(.system(size: 13))
                        .foregroundStyle(c.text3)
                        .multilineTextAlignment(.center)
                        .padding(.vertical, 16)
                }
                .buttonStyle(.plain)
            } else if p.loading && p.nextCursor != nil {
                Spinner()
                    .padding(.vertical, 16)
                    .accessibilityElement()
                    .accessibilityLabel("Loading older tickets")
            }
        }
    }
}

/// What a dragged card looks like under the finger: its key and title.
private struct BoardDragPreview: View {
    let ticket: Ticket
    @Environment(\.palette) private var c

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TicketKeyLabel(ticket: ticket)
            Text(BoardScreenRules.cardTitle(ticket)).font(.system(size: 15, weight: .medium)).foregroundStyle(c.text).lineLimit(2)
        }
        .padding(12)
        .frame(width: 260, alignment: .leading)
        .background(c.bgElev, in: .rect(cornerRadius: 12))
    }
}
