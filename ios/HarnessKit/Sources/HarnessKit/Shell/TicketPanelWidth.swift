import Foundation

/// The iPad ticket side panel's width. The panel starts at `defaultWidth` points and, once the
/// person drags its edge, keeps their width as a fraction of the window (persisted under
/// `defaultsKey`), so a rotation or a resized window scales it rather than pinning a point width.
/// Whatever the source, the width is clamped to `minFraction`…`maxFraction` of the window.
public enum TicketPanelWidth {
    public static let minFraction = 0.25
    public static let maxFraction = 0.80
    /// The width before anyone resizes the panel.
    public static let defaultWidth = 800.0
    /// The UserDefaults key the app keeps the dragged fraction under.
    public static let defaultsKey = "ticketPanelWidthFraction"

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
}
