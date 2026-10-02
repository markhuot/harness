import HarnessKit
import SwiftUI

/// Settings → Appearance: System / Light / Dark, then a light and a dark theme picker.
struct SettingsAppearanceSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var c
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let prefs = app.prefs
        // preferredColorScheme pins the scheme to an explicit choice, so the OS side is only known
        // under System; the pickers only consult it then.
        let systemDark = prefs.theme == .system && scheme == .dark
        Section {
            Picker("Theme", selection: Binding(get: { app.prefs.theme }, set: { app.setPref(\.theme, $0) })) {
                Text("System").tag(Prefs.ThemePreference.system)
                Text("Light").tag(Prefs.ThemePreference.light)
                Text("Dark").tag(Prefs.ThemePreference.dark)
            }
            .pickerStyle(.segmented)
            .settingsRowBackground(c)
        } header: {
            Text("Appearance")
        } footer: {
            Text(prefs.theme == .system ? "Follows iOS (currently \(c.isDark ? "dark" : "light"))." : "Stays the same regardless of the iOS setting.")
        }
        ForEach([ThemeAppearance.light, .dark], id: \.self) { appearance in
            SettingsThemePicker(appearance: appearance, prefs: ThemePicker.ThemePrefs(prefs), systemDark: systemDark) { id in
                haptic(.select)
                app.setPref(ThemePicker.themePrefKey(appearance).keyPath, id)
            }
        }
    }
}

/// One appearance's themes as a horizontal strip of swatches, opened scrolled to the pick.
private struct SettingsThemePicker: View {
    let appearance: ThemeAppearance
    let prefs: ThemePicker.ThemePrefs
    let systemDark: Bool
    let onPick: (String) -> Void

    @Environment(\.palette) private var c

    var body: some View {
        let options = ThemePicker.themeOptions(appearance, prefs: prefs, systemDark: systemDark)
        let title = appearance == .light ? "Light theme" : "Dark theme"
        Section {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 10) {
                        ForEach(options) { o in
                            SettingsThemeSwatch(theme: o.theme, selected: o.selected) { onPick(o.theme.id) }.id(o.theme.id)
                        }
                    }
                    .padding(12)
                }
                .onAppear {
                    // The pick one swatch in from the leading edge.
                    let picked = max(0, options.firstIndex { $0.selected } ?? 0)
                    proxy.scrollTo(options[max(0, picked - 1)].theme.id, anchor: .leading)
                }
            }
            .listRowInsets(EdgeInsets())
            .settingsRowBackground(c)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(title)
        } header: {
            Text(title)
        } footer: {
            Text(ThemePicker.pickerCaption(appearance, prefs: prefs, systemDark: systemDark))
        }
    }
}

/// A theme preview: a tiny board (sidebar, a column with a card, the five
/// status dots) drawn in that theme's own tokens, not the current theme's.
struct SettingsThemeSwatch: View {
    let theme: Theme
    let selected: Bool
    let onPress: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        let t = theme.tokens
        Button(action: onPress) {
            VStack(spacing: 6) {
                board(t)
                    .clipShape(.rect(cornerRadius: 8))
                    .padding(selected ? 2 : 1.5)
                    .frame(width: 104, height: 70)
                    .overlay {
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(selected ? c.accent : c.border, lineWidth: selected ? 2 : 0.5)
                    }
                HStack(spacing: 3) {
                    if selected { Icon("check", size: 11, weight: .bold).foregroundStyle(c.accentText) }
                    Text(theme.name)
                        .font(.scaled(size: 12, weight: selected ? .semibold : .regular))
                        .foregroundStyle(selected ? c.text : c.text2)
                        .lineLimit(1)
                }
                .frame(maxWidth: 104)
            }
            .frame(width: 104)
            .contentShape(.rect)
        }
        .buttonStyle(SettingsSwatchPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(theme.name)
        .accessibilityIdentifier("theme-\(theme.id)")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private func board(_ t: ThemeTokens) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Capsule().fill(t.color(.accent)).frame(width: 12, height: 4).padding(.bottom, 2)
                Capsule().fill(t.color(.text3)).frame(width: 12, height: 2.5).opacity(0.8)
                Capsule().fill(t.color(.text3)).frame(width: 10, height: 2.5).opacity(0.8)
                Spacer(minLength: 0)
            }
            .padding(.top, 8)
            .padding(.horizontal, 5)
            .frame(width: 22)
            .frame(maxHeight: .infinity)
            .background(t.color(.bgSidebar))
            .overlay(alignment: .trailing) { Rectangle().fill(t.color(.border)).frame(width: 0.5) }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 3) {
                    ForEach([ThemeToken.planning, .inProgress, .blocked, .review, .done], id: \.self) { s in
                        Circle().fill(t.color(s)).frame(width: 6, height: 6)
                    }
                }
                VStack(alignment: .leading, spacing: 3) {
                    GeometryReader { g in
                        VStack(alignment: .leading, spacing: 3) {
                            Capsule().fill(t.color(.text)).frame(width: g.size.width * 0.8, height: 3)
                            Capsule().fill(t.color(.text2)).frame(width: g.size.width * 0.55, height: 3)
                        }
                    }
                    .frame(height: 9)
                    HStack(spacing: 3) {
                        Capsule().fill(t.color(.accent)).frame(width: 14, height: 5)
                        Capsule().fill(t.color(.greenSoft)).frame(width: 10, height: 5)
                    }
                    .padding(.top, 2)
                }
                .padding(4)
                .background(t.color(.bgElev), in: .rect(cornerRadius: 4))
                .overlay { RoundedRectangle(cornerRadius: 4).strokeBorder(t.color(.border), lineWidth: 0.5) }
                Spacer(minLength: 0)
            }
            .padding(4)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(t.color(.bgColumn), in: .rect(cornerRadius: 5))
            .padding(5)
        }
        .background(t.color(.bg))
    }
}

private struct SettingsSwatchPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}
