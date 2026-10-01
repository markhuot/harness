import HarnessKit
import SwiftUI

/// FEATURE SLOT (Settings ticket): the Settings tab (screens/Settings.tsx): Macs, appearance and
/// themes, network, drivers and models, permissions, prompts, watchers. Replace the body.
///
/// Until then the placeholder has what the shell needs to be usable: the saved Macs (switch,
/// rename, forget, add) and the appearance and theme pickers. A settings deep link's theme picks
/// are applied by the shell before this screen shows.
struct SettingsScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @Environment(\.colorScheme) private var scheme
    @State private var confirm: Confirmation?

    var body: some View {
        Form {
            Section("Macs") {
                ForEach(app.servers) { s in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            DraftField(value: s.name, prompt: MobilePair.displayHost(s.baseUrl), alignment: .leading) { app.rename(s.id, to: $0) }
                            Text(MobilePair.displayHost(s.baseUrl)).font(.mono(12.5)).foregroundStyle(c.text3)
                        }
                        Spacer()
                        if app.active?.id == s.id {
                            Icon("check", size: 16, weight: .bold).foregroundStyle(c.accent)
                        } else {
                            Button("Use") { app.activate(s.id) }.buttonStyle(.borderless)
                        }
                    }
                    .swipeActions {
                        Button("Forget", role: .destructive) {
                            confirm = Confirmation(title: "Forget \(s.name)?", message: "Its token is deleted from this iPhone. Pair again to use it.", action: "Forget") {
                                app.forget(s.id)
                            }
                        }
                    }
                }
                Button("Add a Mac") { router.present(.connect) }
            }
            Section("Appearance") {
                Picker("Theme", selection: Binding(get: { app.prefs.theme }, set: { app.setPref(\.theme, $0) })) {
                    Text("System").tag(Prefs.ThemePreference.system)
                    Text("Light").tag(Prefs.ThemePreference.light)
                    Text("Dark").tag(Prefs.ThemePreference.dark)
                }
                themePicker(.light)
                themePicker(.dark)
            }
            Section {
                SlotPlaceholder(name: "Settings")
            }
        }
        .scrollContentBackground(.hidden)
        .background(c.bg)
        .navigationTitle("Settings")
        .confirmation($confirm)
    }

    private func themePicker(_ appearance: ThemeAppearance) -> some View {
        let key = ThemePicker.themePrefKey(appearance).keyPath
        return Picker(appearance == .light ? "Light theme" : "Dark theme", selection: Binding(get: { app.prefs[keyPath: key] }, set: { app.setPref(key, $0) })) {
            ForEach(Themes.themes(for: appearance)) { t in Text(t.name).tag(t.id) }
        }
    }
}
