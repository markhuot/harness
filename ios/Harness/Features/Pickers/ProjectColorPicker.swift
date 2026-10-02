import HarnessKit
import SwiftUI

/// A project's key color (ui/ProjectColor.tsx, ProjectColors.swift): Default (the theme accent),
/// the eleven presets, and Custom, which opens a hue × shade grid (like the Grid tab of the
/// system color picker) with a hex field for an exact value. nil = the accent.
struct ProjectColorPicker: View {
    let value: String?
    let onChange: (String?) -> Void

    @Environment(\.palette) private var c
    @State private var open: Bool?
    @State private var hex = ""
    @State private var latest = PickerLatest<(String?, (String?) -> Void)>()
    @FocusState private var hexFocused: Bool

    var body: some View {
        let current = ProjectColors.normalize(value).stored
        let _ = latest.set((current, onChange))
        let custom = current?.hasPrefix("#") == true ? current : nil
        let showGrid = open ?? (custom != nil)
        VStack(alignment: .leading, spacing: 12) {
            FlowLayout(spacing: 4) {
                ProjectColorSwatch(fill: c.accentSoft, selected: current == nil, label: "Default") {
                    open = false
                    onChange(nil)
                } content: {
                    Circle().fill(c.accentText).frame(width: 12, height: 12)
                }
                ForEach(ProjectColors.presets) { p in
                    ProjectColorSwatch(fill: Color(css: p.hex) ?? c.accent, selected: current == p.id, label: p.name) {
                        open = false
                        onChange(p.id)
                    } content: { EmptyView() }
                }
                ProjectColorSwatch(fill: custom.flatMap { Color(css: $0) } ?? c.bgActive, selected: custom != nil || showGrid, label: "Custom") {
                    open = true
                } content: {
                    if custom == nil {
                        Text("+").font(.system(size: 16, weight: .semibold)).foregroundStyle(c.text2)
                    }
                }
            }
            if showGrid {
                grid(current: current)
                HStack(spacing: 10) {
                    Text("Hex").font(.system(size: 14)).foregroundStyle(c.text2)
                    TextField("", text: $hex, prompt: Text("#5e6ad2").foregroundStyle(c.text3))
                        .font(.mono(14))
                        .foregroundStyle(c.text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($hexFocused)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(c.bgSunken, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.border))
                        .onChange(of: hex) { _, v in if v.count > 7 { hex = String(v.prefix(7)) } }
                        .onSubmit(commitHex)
                        .onChange(of: hexFocused) { _, now in if !now { commitHex() } }
                        .accessibilityLabel("Custom color hex")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Project color")
        .onAppear { hex = custom ?? "" }
        .onChange(of: custom) { _, v in hex = v ?? "" }
    }

    private func grid(current: String?) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(PickerLogic.customGrid.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 0) {
                    ForEach(row, id: \.self) { fill in
                        Button {
                            haptic(.select)
                            onChange(fill)
                        } label: {
                            Rectangle()
                                .fill(Color(css: fill) ?? .clear)
                                .aspectRatio(1, contentMode: .fit)
                                .overlay { if current == fill { Rectangle().strokeBorder(c.text, lineWidth: 2) } }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Custom \(fill)")
                        .accessibilityAddTraits(current == fill ? .isSelected : [])
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Custom colors")
    }

    private func commitHex() {
        guard let (current, onChange) = latest.value else { return }
        switch PickerLogic.commitHex(hex, current: current) {
        case let .pick(n): onChange(n)
        case .keep: break
        case let .revert(v): hex = v
        }
    }
}

/// A round swatch with a ring when selected (ProjectColor.tsx Swatch).
private struct ProjectColorSwatch<Content: View>: View {
    let fill: Color
    let selected: Bool
    let label: String
    var size: CGFloat = 30
    let action: () -> Void
    @ViewBuilder var content: Content

    @Environment(\.palette) private var c

    var body: some View {
        Button {
            haptic(.select)
            action()
        } label: {
            Circle()
                .fill(fill)
                .frame(width: size, height: size)
                .overlay { content }
                .padding(3)
                .overlay { Circle().strokeBorder(selected ? c.text : .clear, lineWidth: 2) }
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

