import HarnessKit
import SwiftUI

// Pieces the ticket screen shares with its tab bodies (ui/heroCollapse.tsx, ui/stickToBottom.ts):
// the hero's collapse state, the scroll trackers a tab body attaches, the tab opener the Agents and
// Transcript slots use to open a sub-agent, and a wrapping row layout.

/// The ticket hero's collapse (RN `useHeroCollapse`): HeroCollapse's rules fed by the tab body's
/// scroll gestures. `show()` brings it back (another tab, news on the ticket); `measured` takes the
/// hero's height while it's shown, which is how much room hiding it gives the tab body.
@MainActor
@Observable
final class TicketDetailHeroCollapse {
    private(set) var hidden = false
    @ObservationIgnored private var state = HeroCollapse.shown
    @ObservationIgnored private var heroHeight: Double = 0

    func send(_ e: CollapseEvent) {
        let next = HeroCollapse.step(state, e, heroHeight: heroHeight)
        state = next
        guard next.hidden != hidden else { return }
        withAnimation(.easeInOut(duration: 0.22)) { hidden = next.hidden }
    }

    func show() { send(.show) }

    func measured(_ height: Double) {
        if !state.hidden { heroHeight = height }
    }
}

/// Opens a tab on the ticket screen that hosts the view (a sub-agent's `agent:<id>`, or back to
/// `agents`). Nil outside a ticket screen.
struct TicketDetailTabOpener: Sendable {
    let open: @MainActor @Sendable (TicketTab) -> Void

    @MainActor func callAsFunction(_ tab: TicketTab) { open(tab) }
}

extension EnvironmentValues {
    /// The hero collapse of the ticket screen around a tab body; nil elsewhere.
    @Entry var ticketDetailHero: TicketDetailHeroCollapse?
    /// `openTab(Tabs.subagentTabRoute(id))` from inside a ticket tab body.
    @Entry var ticketDetailOpenTab: TicketDetailTabOpener?
}

extension View {
    /// On a tab body's ScrollView or List: its drags and flings hide and bring back the ticket hero
    /// (RN `useHeroScroll`). Does nothing outside a ticket screen.
    func ticketHeroScroll() -> some View { modifier(TicketDetailHeroScroll()) }

    /// On a ScrollView whose newest content is last (RN `useStickToBottom`): opens at the bottom,
    /// follows new content while the user is at the bottom, stays put once they scroll up, and
    /// follows again when they come back down.
    func ticketStickToBottom() -> some View { modifier(TicketDetailStickToBottom()) }
}

private func scrollMetrics(_ g: ScrollGeometry) -> ScrollMetrics {
    ScrollMetrics(contentOffsetY: g.contentOffset.y, contentHeight: g.contentSize.height, containerHeight: g.containerSize.height,
                  topInset: g.contentInsets.top, bottomInset: g.contentInsets.bottom)
}

private func scrollPhase(_ p: ScrollPhase) -> StickScrollPhase {
    switch p {
    case .idle: .idle
    case .tracking: .tracking
    case .interacting: .interacting
    case .decelerating: .decelerating
    case .animating: .animating
    @unknown default: .idle
    }
}

private struct TicketDetailHeroScroll: ViewModifier {
    @Environment(\.ticketDetailHero) private var hero
    @State private var metrics = ScrollMetrics(offset: 0, contentHeight: 0, viewportHeight: 0)

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: ScrollMetrics.self, of: scrollMetrics) { _, m in
                metrics = m
                hero?.send(.scroll(m))
            }
            .onScrollPhaseChange { old, new in
                for e in HeroCollapse.events(from: scrollPhase(old), to: scrollPhase(new), metrics: metrics) { hero?.send(e) }
            }
    }
}

private struct TicketDetailStickToBottom: ViewModifier {
    @State private var stick = StickToBottom.stuck
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var metrics = ScrollMetrics(offset: 0, contentHeight: 0, viewportHeight: 0)

    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: ScrollMetrics.self, of: scrollMetrics) { old, m in
                metrics = m
                apply(.scroll(m))
                // Content grew or shrank, or the viewport changed (the hero, the keyboard).
                if old.contentHeight != m.contentHeight || old.viewportHeight != m.viewportHeight { apply(.resize) }
            }
            .onScrollPhaseChange { old, new in
                for e in StickToBottom.events(from: scrollPhase(old), to: scrollPhase(new), metrics: metrics) { apply(e) }
            }
    }

    private func apply(_ e: StickEvent) {
        let step = StickToBottom.stickStep(stick, e)
        stick = step.stick
        if step.follow { position.scrollTo(edge: .bottom) }
    }
}

/// Lays its children out in rows, wrapping onto as many as they need (RN `flexWrap: "wrap"`).
/// `alignment` places each row: leading, or trailing for a value column.
struct TicketDetailFlow: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat?
    var alignment: HorizontalAlignment = .leading

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + (lineSpacing ?? spacing) * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: min(proposal.width ?? width, width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = alignment == .trailing ? bounds.maxX - row.width : bounds.minX
            for i in row.items {
                let size = Self.size(of: subviews[i], width: bounds.width)
                subviews[i].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + (lineSpacing ?? spacing)
        }
    }

    private struct Row {
        var items: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows = [Row()]
        for (i, view) in subviews.enumerated() {
            let size = Self.size(of: view, width: width)
            let last = rows.count - 1
            let extra = rows[last].items.isEmpty ? size.width : size.width + spacing
            if rows[last].width + extra > width, !rows[last].items.isEmpty {
                rows.append(Row())
            }
            let r = rows.count - 1
            rows[r].width += rows[r].items.isEmpty ? size.width : size.width + spacing
            rows[r].items.append(i)
            rows[r].height = max(rows[r].height, size.height)
        }
        return rows
    }

    /// Its natural size; a child wider than the row (a long branch name) gets the row and truncates.
    private static func size(of view: LayoutSubview, width: CGFloat) -> CGSize {
        let size = view.sizeThatFits(.unspecified)
        return size.width > width ? view.sizeThatFits(ProposedViewSize(width: width, height: nil)) : size
    }
}
