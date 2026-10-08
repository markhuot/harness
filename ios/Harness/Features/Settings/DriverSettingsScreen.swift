import HarnessKit
import SwiftUI

/// One driver's settings, opened from Settings → Drivers: its status
/// and sign-in, the Anthropic API key for anthropic-api, and the long-lived
/// Claude token for claude-code.
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
    @Environment(\.openURL) private var openURL
    @Environment(\.palette) private var c

    @State private var page: SettingsWebPage?
    /// The login's instructions (Copilot's device code, say), read before its page opens.
    @State private var loginPrompt: LoginPrompt?

    private struct LoginPrompt {
        let message: String
        let url: URL?
    }

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
                        Text(label).font(.scaled(size: 16)).foregroundStyle(c.accent)
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
            if d.id == "claude-code", let settings {
                DriverTokenSection(token: .claude, isSet: settings.hasClaudeOauthToken)
            }
            if d.id == "github-copilot", let settings, settings.copilotGithubTokenSet != nil {
                DriverTokenSection(token: .copilot, isSet: settings.hasCopilotGithubToken)
            }
        }
        .settingsFormStyle(c)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(d.name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $page) { p in
            SettingsSafariView(url: p.url)
                .ignoresSafeArea()
        }
        .alert(d.name, isPresented: Binding(get: { loginPrompt != nil }, set: { if !$0 { loginPrompt = nil } }), presenting: loginPrompt) { p in
            if let url = p.url {
                Button("Cancel", role: .cancel) {}
                Button("Open") { open(url) }
            } else {
                Button("OK", role: .cancel) {}
            }
        } message: { p in
            Text(p.message)
        }
    }

    /// POST /drivers/:id/login, then its page in Safari (or the system, for another scheme). A
    /// login with instructions shows them first, with Open to go on to the page.
    private func login() {
        guard let api = store.api else { return }
        let id = driver.id
        Task {
            guard let res = await actions.run({ try await api.loginDriver(id) }) else { return }
            let url = res.url.flatMap { URL(string: $0) }
            if !res.message.isEmpty {
                loginPrompt = LoginPrompt(message: res.message, url: url)
            } else if let url {
                open(url)
            }
        }
    }

    private func open(_ url: URL) {
        if SettingsWebPage.canShow(url) {
            page = SettingsWebPage(url: url)
        } else {
            openURL(url)
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
                Text("Anthropic API key").font(.scaled(size: 15)).foregroundStyle(c.text)
                if settings.anthropicApiKeySet && !replacing {
                    HStack(spacing: 8) {
                        Icon("checkCircle", size: 15).foregroundStyle(c.green)
                        Text("Key saved").font(.scaled(size: 15)).foregroundStyle(c.green).frame(maxWidth: .infinity, alignment: .leading)
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
        guard let key = SettingsRules.apiKeyToSave(apiKey), let api = store.api else { return }
        Task {
            if await actions.run({ try await api.updateSettings(SettingsPatch(anthropicApiKey: .value(key))) }) != nil {
                apiKey = ""
                replacing = false
                reloadModels()
            }
        }
    }

    private func clearKey() {
        guard let api = store.api else { return }
        Task {
            if await actions.run({ try await api.updateSettings(SettingsPatch(anthropicApiKey: .null)) }) != nil {
                reloadModels()
            }
        }
    }
}

/// The long-lived Claude token (`claude setup-token`) the service hands the claude CLI, for when it
/// can't read the CLI's Keychain login: saved (Replace / Clear) or a field to enter one. Saving or
/// clearing it can change whether the driver is signed in, so the driver list reloads.
private struct DriverTokenSection: View {
    /// Which driver's token this section stores.
    struct Kind: Sendable {
        let name: String
        let placeholder: String
        let footer: String
        let patch: @Sendable (Patch<String>) -> SettingsPatch

        static let claude = Kind(
            name: "Claude token", placeholder: "sk-ant-oat01-…",
            footer: "Run `claude setup-token` in a terminal on the Mac and paste the token here. Runs use it instead of the Claude login in the Mac's Keychain, which the service can't always read.",
            patch: { SettingsPatch(claudeOauthToken: $0) })
        static let copilot = Kind(
            name: "GitHub token", placeholder: "github_pat_…",
            footer: "A fine-grained personal access token with the Copilot Requests permission (GitHub → Settings → Developer settings → Fine-grained tokens), or the output of `gh auth token`. Classic ghp_ tokens don't work. Runs use it instead of the Copilot login in the Mac's Keychain, which the service can't always read.",
            patch: { SettingsPatch(copilotGithubToken: $0) })
    }

    let token: Kind
    let isSet: Bool

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c

    @State private var value = ""
    @State private var replacing = false

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(token.name).font(.scaled(size: 15)).foregroundStyle(c.text)
                if isSet && !replacing {
                    HStack(spacing: 8) {
                        Icon("checkCircle", size: 15).foregroundStyle(c.green)
                        Text("Token saved").font(.scaled(size: 15)).foregroundStyle(c.green).frame(maxWidth: .infinity, alignment: .leading)
                        HButton("Replace", small: true, fullWidth: false) { replacing = true }
                        HButton("Clear", variant: .danger, small: true, fullWidth: false, action: clearToken)
                    }
                } else {
                    HStack(spacing: 8) {
                        SecureField("", text: $value, prompt: Text(token.placeholder).foregroundStyle(c.text3))
                            .font(.mono(14))
                            .foregroundStyle(c.text)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .onSubmit(saveToken)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 36)
                            .background(c.bgSunken, in: .rect(cornerRadius: 8))
                            .accessibilityLabel(token.name)
                        HButton("Save", variant: .primary, fullWidth: false, action: saveToken)
                            .disabled(SettingsRules.apiKeyToSave(value) == nil)
                        if replacing { HButton("Cancel", variant: .ghost, fullWidth: false) { replacing = false } }
                    }
                }
            }
            .settingsRowBackground(c)
        } header: {
            Text("Long-lived token")
        } footer: {
            Text(LocalizedStringKey(token.footer))
        }
    }

    /// GET /drivers again, so the status above reflects the new token.
    private func reloadDrivers() async {
        let client = store.client
        if let drivers = await actions.run({ try await client.listDrivers() }) { store.dispatch(.drivers(drivers)) }
    }

    private func saveToken() {
        guard let saved = SettingsRules.apiKeyToSave(value), let api = store.api else { return }
        Task {
            if await actions.run({ try await api.updateSettings(token.patch(.value(saved))) }) != nil {
                value = ""
                replacing = false
                await reloadDrivers()
            }
        }
    }

    private func clearToken() {
        guard let api = store.api else { return }
        Task {
            if await actions.run({ try await api.updateSettings(token.patch(.null)) }) != nil {
                await reloadDrivers()
            }
        }
    }
}
