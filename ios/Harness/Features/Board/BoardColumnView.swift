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
                    .font(.scaled(size: 14, weight: on ? .semibold : .medium))
                    .foregroundStyle(on ? c.text : c.text2)
                Text("\(n)")
                    .font(.scaled(size: 13))
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

/// One of the iPad's side-by-side columns, as on the Mac: a rounded panel with a header (dot,
/// label, count) over its cards. The header reads "Planning, 3" like a phone chip (sim-check and
/// dev-sim look for it), and a tap scrolls the column into view. Like the Mac's board, it has no
/// drag and drop: cards move from their menu.
struct BoardColumnFrame<Content: View>: View {
    let status: TicketStatus
    let count: Int
    let onTap: () -> Void
    @ViewBuilder let content: Content

    @Environment(\.palette) private var c

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onTap) {
                HStack(spacing: 8) {
                    StatusDot(status: status)
                    Text(statusLabel(status))
                        .font(.scaled(size: 14, weight: .semibold))
                        .foregroundStyle(c.text)
                    Text("\(count)")
                        .font(.scaled(size: 13, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(c.text3)
                    Spacer(minLength: 0)
                }
                .lineLimit(1)
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(statusLabel(status)), \(count)")
            .accessibilityAddTraits([.isButton, .isHeader])
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            content
        }
        .background(c.bgColumn, in: .rect(cornerRadius: 14))
    }
}

/// One column's page: its cards with pull to refresh, Done's older pages (and search results') as
/// it nears the end, and the empty and footer states.
struct BoardColumnView: View {
    let status: TicketStatus
    let ctx: BoardContext
    let onMove: (Ticket, TicketStatus, BoardColumns.Where) -> Void
    /// A card (by key) dropped above `before` (nil: at the end). Nil: no drag and drop (the iPad's
    /// side-by-side columns, like the Mac's).
    let onDrop: ((String, String?) -> Bool)?
    let onDiscard: (Ticket) -> Void
    /// Around the cards: the pager's page, or tighter inside a side-by-side column's frame.
    var inset = EdgeInsets(top: 14, leading: 14, bottom: 14, trailing: 14)

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
                        .cardDrag(t, onDrop.map { drop in { drop($0, t.id) } })
                        .onAppear { if i >= cards.count - Self.endThreshold { onEnd() } }
                }
                if cards.isEmpty { empty }
                footer
                // The rest of the column takes drops at the end.
                if let onDrop {
                    Color.clear
                        .frame(maxWidth: .infinity, minHeight: 80)
                        .contentShape(.rect)
                        .dropDestination(for: String.self) { keys, _ in
                            guard let key = keys.first else { return false }
                            return onDrop(key, nil)
                        }
                        .accessibilityHidden(true)
                }
            }
            .padding(inset)
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
            if ctx.total == 0 && status == .planning && !ctx.searching {
                EmptyState(icon: "plus", title: "No sessions yet", message: "Start one with + in the bottom right.")
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
        .cardDrop(onDrop.map { drop in { drop($0, nil) } })
    }

    private func emptyText(_ s: String) -> some View {
        Text(s).font(.scaled(size: 14)).foregroundStyle(c.text3).multilineTextAlignment(.center)
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
                        .font(.scaled(size: 13))
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

private extension View {
    /// A card that drags (its key) and takes drops above itself; neither without a handler.
    @ViewBuilder func cardDrag(_ t: Ticket, _ onDrop: ((String) -> Bool)?) -> some View {
        if let onDrop {
            draggable(t.key) { BoardDragPreview(ticket: t) }.cardDrop(onDrop)
        } else {
            self
        }
    }

    @ViewBuilder func cardDrop(_ onDrop: ((String) -> Bool)?) -> some View {
        if let onDrop {
            dropDestination(for: String.self) { keys, _ in
                guard let key = keys.first else { return false }
                return onDrop(key)
            }
        } else {
            self
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
            Text(BoardScreenRules.cardTitle(ticket)).font(.scaled(size: 15, weight: .medium)).foregroundStyle(c.text).lineLimit(2)
        }
        .padding(12)
        .frame(width: 260, alignment: .leading)
        .background(c.bgElev, in: .rect(cornerRadius: 12))
    }
}
