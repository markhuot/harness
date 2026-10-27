import HarnessKit
import SwiftUI

/// The status control floating over the phone's board: dot, label and count for each column in
/// one glass capsule, the cards scrolling on under it. The focused column sits on a glass pill that
/// slides with the pager as you swipe; tapping a chip pages to that column, and the strip keeps the
/// pill in view.
struct BoardStatusStrip: View {
    let page: TicketStatus
    /// The pager's scroll position in columns (1.5 is halfway from the second to the third).
    let progress: Double
    let count: (TicketStatus) -> Int
    let onTap: (TicketStatus) -> Void

    /// How much room the strip takes at the top of the board, for the cards to start below it.
    static let height: CGFloat = 34 + 8 + 16

    @Environment(\.palette) private var c
    @State private var frames: [TicketStatus: CGRect] = [:]

    private static let space = "status-strip"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                GlassEffectContainer {
                    HStack(spacing: 0) {
                        ForEach(TicketStatus.allKnown, id: \.self) { s in chip(s).id(s) }
                    }
                    .background(alignment: .topLeading) { pill }
                    .padding(4)
                    .coordinateSpace(name: Self.space)
                }
            }
            .scrollIndicators(.hidden)
            .glassEffect(.regular, in: .capsule)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .onChange(of: page, initial: true) { _, p in
                withAnimation(.snappy) { proxy.scrollTo(p, anchor: .center) }
            }
        }
    }

    /// The focused column's pill, between two chips while the pager is between two columns.
    @ViewBuilder private var pill: some View {
        let all = TicketStatus.allKnown
        let at = min(max(progress, 0), Double(all.count - 1))
        let lo = Int(at.rounded(.down))
        let hi = min(lo + 1, all.count - 1)
        if let a = frames[all[lo]], let b = frames[all[hi]] {
            let t = at - Double(lo)
            Capsule()
                .fill(.clear)
                .glassEffect(.regular.tint(c.accent.opacity(0.18)), in: .capsule)
                .frame(width: a.width + (b.width - a.width) * t, height: a.height)
                .offset(x: a.minX + (b.minX - a.minX) * t, y: a.minY)
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
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.space)) } action: { frames[s] = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(statusLabel(s)), \(n)")
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

/// The Duo's column tabs: the five status dots stacked in one glass capsule in the trailing margin,
/// the focused one on a lifted pill, each with its count under it when the margin has room.
struct BoardStatusRail: View {
    let page: TicketStatus
    let count: (TicketStatus) -> Int
    let showsCounts: Bool
    let onTap: (TicketStatus) -> Void

    @Environment(\.palette) private var c

    var body: some View {
        // The rail is the width of the system's bottom-bar buttons and takes the room above them,
        // shrinking its tabs (then dropping counts) rather than running under them.
        GeometryReader { geo in
            let size = BoardScreenRules.railTab(
                availableHeight: geo.size.height, wantsCounts: showsCounts, tabCount: TicketStatus.allKnown.count)
            GlassEffectContainer {
                VStack(spacing: 2) {
                    ForEach(TicketStatus.allKnown, id: \.self) { s in tab(s, height: size.height, counts: size.counts) }
                }
                .padding(4)
                .glassEffect(.regular, in: .capsule)
            }
            .frame(width: BoardScreenRules.railWidth)
            // Flush with the buttons' trailing edge, which the system sets a fixed gap in from the screen's.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
            .padding(.trailing, BoardScreenRules.railTrailingGap)
        }
    }

    private func tab(_ s: TicketStatus, height: Double, counts showsCounts: Bool) -> some View {
        let on = s == page
        let n = count(s)
        return Button { onTap(s) } label: {
            VStack(spacing: 3) {
                StatusDot(status: s, size: 12)
                if showsCounts {
                    Text(BoardScreenRules.railCountLabel(n))
                        .font(.scaled(size: 11, weight: on ? .semibold : .medium))
                        .monospacedDigit()
                        .foregroundStyle(on ? c.text : c.text3)
                }
            }
            .frame(width: BoardScreenRules.railWidth - 8, height: height)
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
/// label, count) over its cards. The header reads "Planning, 3" like a phone chip (the UI tests and
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

/// One column's page: its cards with pull to refresh, Done's older pages as
/// it nears the end, and the empty and footer states.
struct BoardColumnView: View {
    let status: TicketStatus
    let ctx: BoardContext
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
                    BoardTicketCard(ticket: t, showProject: ctx.project == nil, onDiscard: onDiscard)
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
        if status == .done {
            store.loader.loadMoreDone(ctx.filter)
        }
    }

    @ViewBuilder private var empty: some View {
        let p = ctx.paging
        Group {
            if ctx.total == 0 && status == .planning {
                EmptyState(title: "No sessions yet", message: "Start one with the pencil button in the bottom right.",
                           systemImage: BoardScreen.newSessionSymbol)
            } else if status == .done && !store.loader.legacy && (p == nil || p!.loading || store.loader.canLoadMoreDone(ctx.filter)) && p?.error == nil {
                Spinner()
            } else {
                emptyText(Format.columnEmptyText[status] ?? "")
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
        if status == .done, let p = ctx.paging {
            if p.error != nil {
                Button { store.loader.retryDone(ctx.filter) } label: {
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
