import HarnessKit
import SwiftUI

/// One of the shared icons (shared/src/state/icons.ts) by name, drawn as its SF Symbol
/// (Icons.symbols). `size` is the icon's box in points; `weight` stands in for its stroke width.
struct Icon: View {
    let name: String
    var size: CGFloat = 14
    var weight: Font.Weight = .medium

    init(_ name: String, size: CGFloat = 14, weight: Font.Weight = .medium) {
        self.name = name
        self.size = size
        self.weight = weight
    }

    var body: some View {
        Image(systemName: Icons.symbol(name))
            .font(.system(size: size * 0.92, weight: weight))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

extension Image {
    /// A shared icon name as an Image, for Label/Button APIs that take one.
    init(icon name: String) {
        self.init(systemName: Icons.symbol(name))
    }
}

extension Label where Title == Text, Icon == Image {
    init(_ title: String, icon name: String) {
        self.init(title, systemImage: Icons.symbol(name))
    }
}

/// The icon for a driver's badge (Format.driverIcon).
func driverIconName(_ driver: String) -> String { Format.driverIcon(driver).rawValue }
