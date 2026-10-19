import CoreGraphics

/// The bar the phone's docked cards float above: the board's system bottom bar, or the ticket's
/// message composer. The cards take the bar's own edges (never a figure worked out from the device),
/// so they sit the same on an iPhone and on the Duo, whose system bar spreads its buttons differently.
public struct DockBar: Equatable, Sendable {
    /// How far the bar's top is above the screen's bottom edge.
    public var inset: CGFloat
    /// The bar's leading and trailing edges, in the window.
    public var leading: CGFloat
    public var trailing: CGFloat
    /// A button the system lifted out of the bar's row (the Duo moves search up into its margin): the
    /// cards share its row, beside it, rather than float above the bar.
    public var raised: CGRect?

    public init(inset: CGFloat, leading: CGFloat, trailing: CGFloat, raised: CGRect? = nil) {
        self.inset = inset
        self.leading = leading
        self.trailing = trailing
        self.raised = raised
    }

    /// Buttons whose centers are this much above the lowest one's have left the bar's row.
    static let rowTolerance: CGFloat = 12

    /// The system bottom bar made of `items` (their frames in the window), reaching `inset` up from the
    /// screen's edge. Nil with no items (not measured yet), where the cards use the screen's corners.
    public static func bar(items: [CGRect], inset: CGFloat) -> DockBar? {
        guard let lowest = items.map(\.midY).max() else { return nil }
        let lifted = items.filter { $0.midY < lowest - rowTolerance }
        let row = items.filter { $0.midY >= lowest - rowTolerance }
        let raised = lifted.dropFirst().reduce(lifted.first) { $0?.union($1) }
        return DockBar(inset: inset,
                       leading: items.map(\.minX).min() ?? 0,
                       trailing: row.map(\.maxX).max() ?? 0,
                       raised: raised)
    }

    /// A bar that is the single row `row` (the composer's field row and its buttons, in the window),
    /// on a screen `screenHeight` tall.
    public static func above(row: CGRect, screenHeight: CGFloat) -> DockBar {
        DockBar(inset: max(0, screenHeight - row.minY), leading: row.minX, trailing: row.maxX)
    }
}

/// Where the phone's docked card stack sits: the gaps to the safe area's bottom and to the screen's sides.
public struct DockPlacement: Equatable, Sendable {
    public var leading: CGFloat
    public var trailing: CGFloat
    public var bottom: CGFloat
}

extension DockMetrics {
    /// The gap between the cards and the bar's edge or a lifted button beside them.
    public static let barSideGap: CGFloat = 8

    /// The stack's gaps for a `bar` (nil before it is measured: the screen's corners decide the sides
    /// and nothing lifts the cards) on `screen`. Over a bar the cards span its width and float
    /// `phoneBottomGap` above it; beside a lifted button the bottom card is centered on it and ends
    /// `barSideGap` short of it.
    public static func phonePlacement(bar: DockBar?, screen: ConcentricBar.Screen?) -> DockPlacement {
        let home = screen?.homeIndicator ?? 0
        let sides = phoneSides(screen: screen)
        guard let bar, let screen else {
            return DockPlacement(leading: sides, trailing: sides, bottom: phoneBottomGap)
        }
        var leading = max(0, bar.leading)
        var trailing = max(0, screen.width - bar.trailing)
        guard let raised = bar.raised else {
            return DockPlacement(leading: leading, trailing: trailing, bottom: phoneBottomGap + max(0, bar.inset - home))
        }
        if raised.midX > screen.width / 2 {
            trailing = max(0, screen.width - raised.minX + barSideGap)
        } else {
            leading = max(0, raised.maxX + barSideGap)
        }
        // The card's bottom edge is half a card below the lifted button's center, measured from the
        // safe area's bottom.
        let bottom = max(0, screen.height - home - (raised.midY + height / 2))
        return DockPlacement(leading: leading, trailing: trailing, bottom: bottom)
    }
}
