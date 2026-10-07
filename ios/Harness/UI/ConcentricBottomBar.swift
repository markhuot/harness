import HarnessKit
import SwiftUI

extension EnvironmentValues {
    /// The phone's screen for bottom bars to sit concentric with its corners (ConcentricBar), or nil
    /// on an iPad or before it's measured.
    @Entry var concentricScreen: ConcentricBar.Screen?
    /// How far above the screen's bottom edge a bottom bar's slot ends, where that isn't the home
    /// indicator's inset: 0 in a full-height sheet (TicketSheetHost), which doesn't keep it clear.
    @Entry var concentricBottomGap: CGFloat?
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
/// or where the screen has none. At rest, `sides` (when given) replaces the concentric side gap.
private struct ConcentricBottomPadding: ViewModifier {
    let barHeight: CGFloat
    let raised: Bool
    let horizontal: CGFloat
    let bottom: CGFloat
    let sides: CGFloat?
    @Environment(\.concentricScreen) private var screen
    @Environment(\.concentricBottomGap) private var bottomGap

    func body(content: Content) -> some View {
        let p = (raised ? nil : ConcentricBar.padding(screen, barHeight: barHeight, bottomGap: bottomGap))
            ?? ConcentricBar.Padding(horizontal: horizontal, bottom: bottom)
        content
            .padding(.horizontal, raised ? p.horizontal : sides ?? p.horizontal)
            .padding(.bottom, p.bottom)
    }
}

extension View {
    /// Pads a bottom bar `barHeight` tall (its single row) so its ends are concentric with the
    /// phone's corners; see ConcentricBottomPadding.
    func concentricBottomPadding(barHeight: CGFloat, raised: Bool, horizontal: CGFloat, bottom: CGFloat, sides: CGFloat? = nil) -> some View {
        modifier(ConcentricBottomPadding(barHeight: barHeight, raised: raised, horizontal: horizontal, bottom: bottom, sides: sides))
    }
}
