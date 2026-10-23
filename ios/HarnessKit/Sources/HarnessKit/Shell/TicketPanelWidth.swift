import Foundation

/// The iPad ticket side panel's width. The panel starts at `defaultWidth` points and, once the
/// person drags its edge, keeps their width as a fraction of the window (persisted as the
/// `ticketPanelWidth` pref), so a rotation or a resized window scales it rather than pinning a point width.
/// Whatever the source, the width is clamped to `minFraction`…`maxFraction` of the window.
public enum TicketPanelWidth {
    public static let minFraction = 0.25
    public static let maxFraction = 0.80
    /// The width before anyone resizes the panel.
    public static let defaultWidth = 800.0

    /// `fraction` held to the allowed range; a non-finite one falls back to the maximum.
    public static func clamp(_ fraction: Double) -> Double {
        guard fraction.isFinite else { return maxFraction }
        return min(max(fraction, minFraction), maxFraction)
    }

    /// The default width as a fraction of `windowWidth`, clamped: a window narrower than
    /// 800 / 0.8 = 1000pt gets 80%, a very wide one never drops below 25%.
    public static func defaultFraction(windowWidth: Double) -> Double {
        guard windowWidth > 0 else { return maxFraction }
        return clamp(defaultWidth / windowWidth)
    }

    /// The fraction the panel uses in `windowWidth`: the stored one when there is one, otherwise
    /// the default's, either way clamped.
    public static func fraction(windowWidth: Double, stored: Double?) -> Double {
        if let stored, stored.isFinite { return clamp(stored) }
        return defaultFraction(windowWidth: windowWidth)
    }

    /// The panel's width in points for `windowWidth`.
    public static func width(windowWidth: Double, stored: Double?) -> Double {
        guard windowWidth > 0 else { return 0 }
        return windowWidth * fraction(windowWidth: windowWidth, stored: stored)
    }

    /// A dragged width (points) as the clamped fraction to store.
    public static func fraction(forWidth width: Double, windowWidth: Double) -> Double {
        guard windowWidth > 0 else { return maxFraction }
        return clamp(width / windowWidth)
    }

    /// A dragged width held to what the window allows, in points, for live feedback during a drag.
    public static func clampedWidth(_ width: Double, windowWidth: Double) -> Double {
        guard windowWidth > 0 else { return 0 }
        return windowWidth * fraction(forWidth: width, windowWidth: windowWidth)
    }

    /// How the panel lays out against a window whose trailing safe-area inset it runs into (a
    /// phone in landscape with a camera housing or a rounded corner on that side: the Duo open,
    /// a Pro Max). `width` is what the person sized, measured from the safe edge like the stored
    /// fraction, so a rotation keeps the same meaning; the panel's frame adds `inset` so its
    /// background reaches the screen's edge.
    public struct Layout: Equatable, Sendable {
        /// The window's width without the trailing inset: what the stored fraction is of.
        public var window: Double
        /// The panel's width from the safe edge, the one reported to what sits beside it.
        public var width: Double
        public var inset: Double

        /// The panel's frame: the width plus the overhang into the inset.
        public var frameWidth: Double { width + inset }

        /// How far a docked or flung panel travels to leave no sliver on screen, shadow included.
        public func slideAway(shadowReach: Double) -> Double { width + inset + shadowReach }
    }

    /// The layout in a frame `totalWidth` wide that already includes `inset` points of trailing
    /// safe area. `dragged` is a width being dragged, which wins over `stored`.
    public static func layout(totalWidth: Double, inset: Double, stored: Double?, dragged: Double? = nil) -> Layout {
        let inset = max(0, inset.isFinite ? inset : 0)
        let window = max(0, totalWidth - inset)
        return Layout(window: window, width: dragged ?? width(windowWidth: window, stored: stored), inset: inset)
    }
}
