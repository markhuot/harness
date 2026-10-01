import HarnessKit
import SwiftUI

// SwiftUI bridge for HarnessKit's theme tokens: CSS color strings → Color, box-shadow tokens → shadows.

extension Color {
    /// A parsed CSS color. Channels are clamped to 0...255 and alpha to 0...1 (NaN draws as 0),
    /// the way a browser clamps out-of-range rgb() values.
    init(rgba: RGBA) {
        func unit(_ v: Double, scale: Double) -> Double {
            v.isNaN ? 0 : min(1, max(0, v / scale))
        }
        self.init(.sRGB, red: unit(rgba.r, scale: 255), green: unit(rgba.g, scale: 255), blue: unit(rgba.b, scale: 255), opacity: unit(rgba.a, scale: 1))
    }

    /// nil when `css` isn't a color HarnessKit's parser (parseColor) accepts.
    init?(css: String) {
        guard let rgba = RGBA(css: css) else { return nil }
        self.init(rgba: rgba)
    }

    /// A theme token as a color. Shadow tokens draw as their first layer's color; anything
    /// unparseable (never a bundled theme) draws as clear.
    init(_ token: ThemeToken, in tokens: ThemeTokens) {
        let value = tokens[token]
        if token.isShadow, let color = BoxShadow.parse(value)?.color {
            self.init(rgba: color)
        } else {
            self = Color(css: value) ?? .clear
        }
    }
}

extension ThemeTokens {
    /// `tokens.color(.bgElev)`.
    func color(_ token: ThemeToken) -> Color { Color(token, in: self) }
}

extension View {
    /// Draws a CSS box-shadow list (a theme's shadowSm / shadow / shadowLg) as stacked SwiftUI
    /// shadows. SwiftUI has no spread or inset shadow, so those layers draw without spread and
    /// inset layers are skipped. CSS blur is roughly twice SwiftUI's radius.
    func boxShadow(_ css: String) -> some View {
        let layers = (BoxShadow.parseList(css) ?? []).filter { !$0.inset }
        return layers.reversed().reduce(AnyView(self)) { view, s in
            AnyView(view.shadow(color: s.color.map(Color.init(rgba:)) ?? .black, radius: s.blur / 2, x: s.x, y: s.y))
        }
    }
}
