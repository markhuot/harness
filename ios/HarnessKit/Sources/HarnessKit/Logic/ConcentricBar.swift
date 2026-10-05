import CoreGraphics

/// Where a phone's bottom glass bar sits so its rounded ends are concentric with the screen's
/// corners, as Calendar's and the system toolbars' are: the gap to the bottom edge and to each side
/// is the display's corner radius less half the bar's height, so the bar's corner and the screen's
/// share a center. iOS has no public API for the display's corner radius, so it comes from the
/// screen's width (its short side), which tells the iPhone families apart.
public enum ConcentricBar {
    /// The screen as the bar sees it: its size, the safe area's leading plus trailing insets, and
    /// the home indicator's inset at the bottom (the safe area without the keyboard).
    public struct Screen: Equatable, Sendable {
        public var width: CGFloat
        public var height: CGFloat
        public var sideInsets: CGFloat
        public var homeIndicator: CGFloat
        public init(width: CGFloat, height: CGFloat, sideInsets: CGFloat = 0, homeIndicator: CGFloat) {
            self.width = width
            self.height = height
            self.sideInsets = sideInsets
            self.homeIndicator = homeIndicator
        }

        public var shortSide: CGFloat { min(width, height) }

        /// A bar spans the screen's bottom edge, from corner to corner, only in portrait. In
        /// landscape it sits between the side insets (and on a Plus or Pro Max, in a split view's
        /// column), away from the corners.
        public var portrait: Bool { height > width && sideInsets == 0 }
    }

    /// The bar's padding: on each side, and at the bottom measured from the safe area's edge (so
    /// it's negative when the bar dips into the home indicator's inset).
    public struct Padding: Equatable, Sendable {
        public var horizontal: CGFloat
        public var bottom: CGFloat
        public init(horizontal: CGFloat, bottom: CGFloat) {
            self.horizontal = horizontal
            self.bottom = bottom
        }
    }

    /// The tightest gap to the screen's edges, for screens whose corners are barely rounded.
    static let minimumMargin: CGFloat = 8

    /// The display's corner radius in points, by the screen's short side, or nil for a screen with
    /// square corners (a phone with a Home button has no home indicator).
    public static func displayCornerRadius(_ screen: Screen) -> CGFloat? {
        guard screen.homeIndicator > 0 else { return nil }
        switch screen.shortSide.rounded() {
        case 360: return 44 // 12 mini, 13 mini
        case 375: return 39 // X, XS, 11 Pro
        case 390: return 47.33 // 12, 13, 14, 16e
        case 393: return 55 // 14 Pro, 15, 15 Pro, 16
        case 414: return 41.5 // XR, XS Max, 11, 11 Pro Max
        case 428: return 53.33 // 12 Pro Max, 13 Pro Max, 14 Plus
        case 430: return 55 // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
        // 16 Pro (402), Air (420), 16 Pro Max (440), and the 17 and 18 lines; the newest phones
        // are the likeliest unknown widths, so they share it.
        default: return 62
        }
    }

    /// The padding that makes a bar `height` tall concentric with the screen's corners, or nil
    /// when it can't be (no screen measured yet, landscape, or square corners): the caller keeps
    /// its own.
    public static func padding(_ screen: Screen?, barHeight: CGFloat) -> Padding? {
        guard let screen, screen.portrait, let radius = displayCornerRadius(screen) else { return nil }
        let margin = max(radius - barHeight / 2, minimumMargin)
        return Padding(horizontal: margin, bottom: margin - screen.homeIndicator)
    }
}
