import HarnessKit
import SwiftUI

extension EnvironmentValues {
    /// The phone's screen for bottom bars to sit concentric with its corners (ConcentricBar), or nil
    /// on an iPad or before it's measured.
    @Entry var concentricScreen: ConcentricBar.Screen?
}

/// Measures the window for `\.concentricScreen`: its size, side insets and the home indicator's
/// inset, without the keyboard's. Phones only, since an iPad's corners are barely rounded;
/// ConcentricBar leaves landscape alone.
struct ConcentricScreenReader: ViewModifier {
    @State private var screen: ConcentricBar.Screen?

    func body(content: Content) -> some View {
        content
            .environment(\.concentricScreen, screen)
            .background {
                Color.clear
                    .ignoresSafeArea(.keyboard)
                    .onGeometryChange(for: ConcentricBar.Screen.self) { g in
                        let s = g.size, i = g.safeAreaInsets
                        return ConcentricBar.Screen(width: s.width + i.leading + i.trailing, height: s.height + i.top + i.bottom,
                                                    sideInsets: i.leading + i.trailing, homeIndicator: i.bottom)
                    } action: { s in
                        screen = UIDevice.current.userInterfaceIdiom == .phone ? s : nil
                    }
            }
    }
}

/// A bottom bar's horizontal and bottom padding: concentric with the phone's corners at rest, and
/// `horizontal`/`bottom` while `raised` (over the keyboard, where there are no corners to follow)
/// or where the screen has none.
private struct ConcentricBottomPadding: ViewModifier {
    let barHeight: CGFloat
    let raised: Bool
    let horizontal: CGFloat
    let bottom: CGFloat
    @Environment(\.concentricScreen) private var screen

    func body(content: Content) -> some View {
        let p = (raised ? nil : ConcentricBar.padding(screen, barHeight: barHeight))
            ?? ConcentricBar.Padding(horizontal: horizontal, bottom: bottom)
        content
            .padding(.horizontal, p.horizontal)
            .padding(.bottom, p.bottom)
    }
}

extension View {
    /// Pads a bottom bar `barHeight` tall (its single row) so its ends are concentric with the
    /// phone's corners; see ConcentricBottomPadding.
    func concentricBottomPadding(barHeight: CGFloat, raised: Bool, horizontal: CGFloat, bottom: CGFloat) -> some View {
        modifier(ConcentricBottomPadding(barHeight: barHeight, raised: raised, horizontal: horizontal, bottom: bottom))
    }
}
