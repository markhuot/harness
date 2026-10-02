import SwiftUI
import UIKit

/// The UIKit bar styling SwiftUI has no modifier for (title colors and the
/// tab bar's badgeBackgroundColor): navigation titles in the theme's `text`, tab
/// badges in `redSolid`. Backgrounds stay the system's: the default material once content scrolls
/// under the bar, transparent at the scroll edge. RootView calls `apply` with the palettes for a
/// light and a dark trait whenever either changes, and the colors resolve per trait: a bar keeps a
/// UIColor it was given, so a static color would stay on the old appearance's text color after
/// a light/dark flip. The appearance proxies style bars made from then on; bars already on screen
/// are restyled in place.
@MainActor enum BarAppearance {
    static func apply(light: Palette, dark: Palette) {
        let titleColor = dynamic(light.text, dark.text)
        let badgeColor = dynamic(light.redSolid, dark.redSolid)

        let standard = UINavigationBarAppearance()
        standard.configureWithDefaultBackground()
        let edge = UINavigationBarAppearance()
        edge.configureWithTransparentBackground()
        for a in [standard, edge] {
            a.titleTextAttributes[.foregroundColor] = titleColor
            a.largeTitleTextAttributes[.foregroundColor] = titleColor
        }

        let nav = UINavigationBar.appearance()
        nav.standardAppearance = standard
        nav.compactAppearance = standard
        nav.scrollEdgeAppearance = edge
        nav.compactScrollEdgeAppearance = edge
        UITabBarItem.appearance().badgeColor = badgeColor

        for window in windows {
            restyle(window, standard: standard, edge: edge, badge: badgeColor)
        }
    }

    private static func dynamic(_ light: Color, _ dark: Color) -> UIColor {
        let l = UIColor(light), d = UIColor(dark)
        return UIColor { $0.userInterfaceStyle == .dark ? d : l }
    }

    private static var windows: [UIWindow] {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    }

    private static func restyle(_ view: UIView, standard: UINavigationBarAppearance, edge: UINavigationBarAppearance, badge: UIColor) {
        if let bar = view as? UINavigationBar {
            bar.standardAppearance = standard
            bar.compactAppearance = standard
            bar.scrollEdgeAppearance = edge
            bar.compactScrollEdgeAppearance = edge
        } else if let bar = view as? UITabBar {
            for item in bar.items ?? [] { item.badgeColor = badge }
        }
        for sub in view.subviews { restyle(sub, standard: standard, edge: edge, badge: badge) }
    }
}
