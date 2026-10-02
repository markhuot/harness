import HarnessKit
import SwiftUI

/// The status chips over the board: dot, label and count for each column. Tapping one pages to
/// that column, and the strip keeps the current chip in view.
struct BoardStatusStrip: View {
    let page: TicketStatus
    let count: (TicketStatus) -> Int
    let onTap: (TicketStatus) -> Void

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
            .background(on ? c.bgElev : .clear, in: .capsule)
            .overlay(Capsule().strokeBorder(on ? c.border : .clear, lineWidth: 1 / 3))
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(statusLabel(s)), \(n)")
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

/// One of the iPad's side-by-side columns, as on the Mac: a rounded panel with a header (dot,
/// label, count) over its cards. The header reads "Planning, 3" like a phone chip (sim-check and
/// dev-sim look for it), and a tap scrolls the column into view.
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
                        .onAppear { if i >= cards.count - Self.endThreshold { onEnd() } }
                }
                if cards.isEmpty { empty }
                footer
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
                EmptyState(title: "No sessions yet", message: "Start one with the pencil button in the bottom right.",
                           systemImage: BoardScreen.newSessionSymbol)
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
