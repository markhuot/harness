import HarnessKit
import SwiftUI

/// One driver's settings (screens/DriverSettings.tsx), opened from Settings → Drivers: its status
/// and sign-in, the review model, and the Anthropic API key for anthropic-api.
struct DriverSettingsScreen: View {
    let driverId: String

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    var body: some View {
        if let driver = store.state.drivers.first(where: { $0.id == driverId }) {
            DriverSettingsForm(driver: driver)
        } else {
            EmptyState(icon: "bot", title: "The service doesn't report this driver")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(c.bg)
        }
    }
}

/// A driver's status badge: Unavailable, Not signed in or Ready (Settings' driver rows use it too).
struct DriverStatusBadge: View {
    let driver: DriverInfo

    var body: some View {
        let status = SettingsRules.driverStatus(driver)
        switch status {
        case .unavailable: Badge(status.label, tone: .red)
        case .signedOut: Badge(status.label, tone: .amber)
        case .ready: Badge(status.label, tone: .green, icon: "check")
        }
    }
}

private struct DriverSettingsForm: View {
    let driver: DriverInfo

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.openURL) private var openURL
    @Environment(\.palette) private var c

    @State private var page: SettingsWebPage?

    var body: some View {
        let d = driver
        let settings = store.state.settings
        Form {
            Section {
                SettingsRow(label: "Status", hint: d.detail.isEmpty ? nil : d.detail) {
                    HStack(spacing: 6) {
                        DriverStatusBadge(driver: d)
                        if settings?.defaultDriver == d.id { Badge("Default", tone: .accent) }
                    }
                }
                if let label = SettingsRules.loginLabel(d) {
                    SettingsButtonRow(action: login) {
                        Text(label).font(.system(size: 16)).foregroundStyle(c.accent)
                    } subtitle: {
                        EmptyView()
                    } trailing: {
                        EmptyView()
                    }
                }
            } footer: {
                if !d.description.isEmpty { Text(d.description) }
            }
            if d.id == "anthropic-api", let settings {
                DriverAnthropicKeySection(settings: settings)
            }
            if let settings {
                Section {
                    SettingsRow(label: "Review model") {
                        ModelPicker(driver: d.id, value: settings.reviewModels[d.id] ?? nil, defaultLabel: "Same as work", plainDefault: true, title: "Review model") { m in
                            guard let api = store.settingsAPI else { return }
                            actions.perform { _ = try await api.updateSettings(SettingsPatch(reviewModels: [d.id: m])) }
                        }
                    }
                } header: {
                    Text("Models")
                } footer: {
                    Text("The model agent reviews run on for tickets on this driver. Same as work uses the ticket's own model.")
                }
            }
        }
        .settingsFormStyle(c)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(d.name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $page) { p in
            SettingsSafariView(url: p.url)
                .ignoresSafeArea()
                .onDisappear { if let m = p.message, !m.isEmpty { toasts.show(m, kind: .info) } }
        }
    }

    /// POST /drivers/:id/login, then its page in Safari (or the system, for another scheme); the
    /// message toasts once the page closes.
    private func login() {
        guard let api = store.settingsAPI else { return }
        let id = driver.id
        Task {
            guard let res = await actions.run(nil, { try await api.loginDriver(id) }) else { return }
            if let s = res.url, let url = URL(string: s) {
                if SettingsWebPage.canShow(url) {
                    page = SettingsWebPage(url: url, message: res.message)
                    return
                }
                openURL(url)
            }
            if !res.message.isEmpty { toasts.show(res.message, kind: .info) }
        }
    }
}

/// The Anthropic API key: saved (Replace / Clear) or a field to enter one. A new or cleared key
/// changes which models the driver can list, so its model list reloads.
private struct DriverAnthropicKeySection: View {
    let settings: PublicSettings

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c

    @State private var apiKey = ""
    @State private var replacing = false

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text("Anthropic API key").font(.system(size: 15)).foregroundStyle(c.text)
                if settings.anthropicApiKeySet && !replacing {
                    HStack(spacing: 8) {
                        Icon("checkCircle", size: 15).foregroundStyle(c.green)
                        Text("Key saved").font(.system(size: 15)).foregroundStyle(c.green).frame(maxWidth: .infinity, alignment: .leading)
                        HButton("Replace", small: true, fullWidth: false) { replacing = true }
                        HButton("Clear", variant: .danger, small: true, fullWidth: false, action: clearKey)
                    }
                } else {
                    HStack(spacing: 8) {
                        SecureField("", text: $apiKey, prompt: Text("sk-ant-…").foregroundStyle(c.text3))
                            .font(.mono(14))
                            .foregroundStyle(c.text)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .onSubmit(saveKey)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 36)
                            .background(c.bgSunken, in: .rect(cornerRadius: 8))
                            .accessibilityLabel("Anthropic API key")
                        HButton("Save", variant: .primary, fullWidth: false, action: saveKey)
                            .disabled(SettingsRules.apiKeyToSave(apiKey) == nil)
                        if replacing { HButton("Cancel", variant: .ghost, fullWidth: false) { replacing = false } }
                    }
                }
            }
            .settingsRowBackground(c)
        } header: {
            Text("API key")
        } footer: {
            Text("Stored by the service; falls back to ANTHROPIC_API_KEY.")
        }
    }

    private func reloadModels() {
        let cache = store.sharedModelCache
        Task { await cache.load("anthropic-api", refresh: true) }
    }

    private func saveKey() {
        guard let key = SettingsRules.apiKeyToSave(apiKey), let api = store.settingsAPI else { return }
        Task {
            if await actions.run("API key saved", { try await api.updateSettings(SettingsPatch(anthropicApiKey: .value(key))) }) != nil {
                apiKey = ""
                replacing = false
                reloadModels()
            }
        }
    }

    private func clearKey() {
        guard let api = store.settingsAPI else { return }
        Task {
            if await actions.run("API key cleared", { try await api.updateSettings(SettingsPatch(anthropicApiKey: .null)) }) != nil {
                reloadModels()
            }
        }
    }
}
