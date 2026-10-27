import HarnessKit
import SwiftUI

/// A label's color as a dot (the sidebar and the palette's picker). nil → the theme accent, like a project badge.
struct LabelDot: View {
    let color: String?
    var size: CGFloat = 9
    @Environment(\.palette) private var c

    var body: some View {
        let colors = ProjectKeyColors.for(color, tokens: c.tokens)
        Circle()
            .fill(Color(css: colors.fg) ?? c.accentText)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// A label as a chip: the project key badge's colors (a wash of the label's color, readable text),
/// a long name cut short with "…".
struct LabelChip: View {
    let name: String
    let color: String?
    var onRemove: (() -> Void)?
    @Environment(\.palette) private var c

    var body: some View {
        let colors = ProjectKeyColors.for(color, tokens: c.tokens)
        let fg = Color(css: colors.fg) ?? c.accentText
        HStack(spacing: 4) {
            Text(name)
                .font(.scaled(size: 11, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove label \(name)")
            }
        }
        .foregroundStyle(fg)
        .padding(.horizontal, 7)
        .frame(minHeight: 19)
        .background(Color(css: colors.bg) ?? c.accentSoft, in: .capsule)
        .frame(maxWidth: 180, alignment: .leading)
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Label \(name)")
    }
}

/// A ticket's labels, wrapping, in the collection's colors.
struct LabelChips: View {
    let names: [String]
    @Environment(BoardStore.self) private var store

    var body: some View {
        FlowLayout(spacing: 5) {
            ForEach(names, id: \.self) { name in
                LabelChip(name: name, color: LabelList.colorId(name, in: store.state.labels))
            }
        }
    }
}
