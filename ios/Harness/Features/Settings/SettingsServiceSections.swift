import HarnessKit
import SwiftUI

// Settings sections that edit the service: Drivers, General, Models, Permissions, Triage.

/// Every driver with its status, the app default, and a login button where the driver has one.
/// The screen reloads the list on every reconnect.
struct SettingsDriversSection: View {
    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(ToastCenter.self) private var toasts
    @Environment(SettingsModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Environment(\.palette) private var c

    var body: some View {
        let drivers = store.state.drivers
        Section {
            if drivers.isEmpty {
                Text("No drivers reported by the service.").font(.system(size: 15)).foregroundStyle(c.text2).settingsRowBackground(c)
            }
            ForEach(drivers) { d in row(d) }
        } header: {
            SettingsSectionHeader(title: "Drivers", icon: "refresh", label: "Refresh drivers", loading: model.driversLoading) {
                Task { await model.reloadDrivers(store, actions) }
            }
        }
    }

    private func row(_ d: DriverInfo) -> some View {
        let status = SettingsRules.driverStatus(d)
        let subtitle = SettingsRules.driverSubtitle(d)
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(d.name).font(.system(size: 16)).foregroundStyle(c.text)
                    switch status {
                    case .unavailable: Badge(status.label, tone: .red)
                    case .signedOut: Badge(status.label, tone: .amber)
                    case .ready: Badge(status.label, tone: .green, icon: "check")
                    }
                    if store.state.settings?.defaultDriver == d.id { Badge("Default", tone: .accent) }
                }
                if !subtitle.isEmpty { Text(subtitle).font(.system(size: 13)).foregroundStyle(c.text3) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let label = SettingsRules.loginLabel(d) {
                HButton(label, icon: "key", small: true, fullWidth: false) { login(d) }
            }
        }
        .settingsRowBackground(c)
    }

    /// POST /drivers/:id/login, then its page in Safari (or the system, for another scheme); the
    /// message toasts once the page closes.
    private func login(_ d: DriverInfo) {
        guard let api = store.settingsAPI else { return }
        Task {
            guard let res = await actions.run(nil, { try await api.loginDriver(d.id) }) else { return }
            if let s = res.url, let url = URL(string: s) {
                if SettingsWebPage.canShow(url) {
                    model.page = SettingsWebPage(url: url, message: res.message)
                    return
                }
                openURL(url)
            }
            if !res.message.isEmpty { toasts.show(res.message, kind: .info) }
        }
    }
}

/// Max concurrent runs, the app-wide base branch and the Anthropic API key.
struct SettingsGeneralSection: View {
    let settings: PublicSettings

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var c

    @State private var apiKey = ""
    @State private var replacing = false

    var body: some View {
        Section("General") {
            SettingsRow(label: "Max concurrent runs", hint: "Agent runs across all sessions. Extra runs wait in the queue.") {
                DraftField(value: String(settings.maxConcurrentRuns)) { v in
                    if let n = SettingsRules.maxConcurrentRuns(v) { save(SettingsPatch(maxConcurrentRuns: n)) }
                }
                .keyboardType(.numberPad)
                .frame(maxWidth: 80)
                .accessibilityLabel("Max concurrent runs")
            }
            SettingsRow(label: "Base branch", hint: "Completed tickets merge into it and new ticket branches start from it. Projects and tickets can override it.") {
                DraftField(value: settings.baseBranch ?? Branches.defaultBaseBranch, prompt: Branches.defaultBaseBranch, mono: true) { v in
                    switch SettingsRules.settingsBaseBranchCommit(v, current: settings.baseBranch) {
                    case .none: break
                    case let .invalid(error): toasts.show("Not a valid branch name: \(error)", kind: .error)
                    case let .save(name): save(SettingsPatch(baseBranch: name))
                    }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .frame(maxWidth: 160)
                .accessibilityLabel("Base branch")
            }
            apiKeyRow
        }
    }

    private var apiKeyRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Anthropic API key").font(.system(size: 15)).foregroundStyle(c.text)
                Text("Stored by the service; falls back to ANTHROPIC_API_KEY.").font(.system(size: 12.5)).foregroundStyle(c.text3)
            }
            if settings.anthropicApiKeySet && !replacing {
                HStack(spacing: 8) {
                    Icon("checkCircle", size: 15).foregroundStyle(c.green)
                    Text("Key saved").font(.system(size: 15)).foregroundStyle(c.green).frame(maxWidth: .infinity, alignment: .leading)
                    HButton("Replace", small: true, fullWidth: false) { replacing = true }
                    HButton("Clear", variant: .danger, small: true, fullWidth: false) {
                        save(SettingsPatch(anthropicApiKey: .null), ok: "API key cleared")
                    }
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
    }

    private func saveKey() {
        guard let key = SettingsRules.apiKeyToSave(apiKey), let api = store.settingsAPI else { return }
        Task {
            if await actions.run("API key saved", { try await api.updateSettings(SettingsPatch(anthropicApiKey: .value(key))) }) != nil {
                apiKey = ""
                replacing = false
            }
        }
    }

    private func save(_ patch: SettingsPatch, ok: String? = nil) {
        guard let api = store.settingsAPI else { return }
        actions.perform(ok) { _ = try await api.updateSettings(patch) }
    }
}

/// The app's default driver and model, and each driver's model for agent review runs.
struct SettingsModelsSection: View {
    let settings: PublicSettings

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions

    var body: some View {
        let models = ModelSettings(settings)
        Section {
            SettingsRow(label: "Default model", hint: "Used for new sessions unless the project or ticket picks its own.") {
                DriverModelPicker(
                    value: Models.settingsChoice(models),
                    resolved: Watchers.TriageChoice(driver: settings.defaultDriver, model: nil),
                    title: "Default model",
                    defaultLabel: "Driver default"
                ) { save(Models.settingsChoicePatch($0, models)) }
            }
            ForEach(store.state.drivers) { d in
                SettingsRow(label: d.name, hint: "Model for agent review runs") {
                    ModelPicker(driver: d.id, value: settings.reviewModels[d.id] ?? nil, defaultLabel: "Same as work", plainDefault: true, title: "Review model") { m in
                        save(SettingsPatch(reviewModels: [d.id: m]))
                    }
                }
            }
        } header: {
            Text("Models")
        } footer: {
            Text("Tickets and projects can pick their own model; these apply when they don't.")
        }
    }

    private func save(_ patch: SettingsPatch) {
        guard let api = store.settingsAPI else { return }
        actions.perform { _ = try await api.updateSettings(patch) }
    }
}

/// The default permission mode and the auto-mode classifier.
struct SettingsPermissionsSection: View {
    let settings: PublicSettings

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions

    var body: some View {
        Section {
            SettingsRow(label: "Default mode", hint: Permissions.label(for: settings.permissionMode)?.description) {
                PermissionPicker(value: settings.permissionMode) { m in
                    if let m { save(SettingsPatch(permissionMode: m)) }
                }
            }
            SettingsRow(label: "Auto-mode classifier", hint: "Judges actions in auto mode for the Anthropic API driver. Claude Code tickets use Claude Code's own classifier.") {
                SelectMenu(
                    value: settings.classifier,
                    options: ClassifierBackend.allKnown.map { PickerOption(value: $0, label: Format.classifierLabels[$0] ?? $0.rawValue) },
                    title: "Auto-mode classifier",
                    accessibilityName: "Auto-mode classifier"
                ) { save(SettingsPatch(classifier: $0)) }
            }
        } header: {
            Text("Permissions")
        } footer: {
            Text("How much agents may do without asking. Projects and tickets can override the mode. Plan runs are always read-only.")
        }
    }

    private func save(_ patch: SettingsPatch) {
        guard let api = store.settingsAPI else { return }
        actions.perform { _ = try await api.updateSettings(patch) }
    }
}

/// The driver and model watchers' triage sessions use when they don't pick their own.
struct SettingsTriageSection: View {
    let settings: PublicSettings

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions

    var body: some View {
        Section {
            SettingsRow(label: "Default model") {
                DriverModelPicker(
                    value: Watchers.settingsWatcherChoice(settings),
                    resolved: Watchers.TriageChoice(driver: settings.defaultDriver, model: settings.defaultModels[settings.defaultDriver] ?? nil),
                    title: "Default model",
                    defaultLabel: "Same as default"
                ) { choice in
                    guard let api = store.settingsAPI else { return }
                    let patch = Watchers.settingsWatcherChoicePatch(choice, settings: settings)
                    actions.perform { _ = try await api.updateSettings(patch) }
                }
            }
        } header: {
            Text("Triage")
        } footer: {
            Text("Used by watchers that don't pick their own.")
        }
    }
}
