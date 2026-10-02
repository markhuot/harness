import HarnessKit
import SwiftUI

// Settings sections that edit the service: Drivers (with the default model), General,
// Permissions, Triage.

/// Every driver with its status, each opening its own settings (DriverSettingsScreen), and the
/// app's default model right under them. The screen reloads the list on every reconnect.
struct SettingsDriversSection: View {
    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(Router.self) private var router
    @Environment(SettingsModel.self) private var model
    @Environment(\.palette) private var c

    var body: some View {
        let drivers = store.state.drivers
        let settings = store.state.settings
        Section {
            if drivers.isEmpty {
                Text("No drivers reported by the service.").font(.system(size: 15)).foregroundStyle(c.text2).settingsRowBackground(c)
            }
            ForEach(drivers) { d in row(d, isDefault: settings?.defaultDriver == d.id) }
            if let settings {
                let models = ModelSettings(settings)
                SettingsRow(label: "Default model", hint: "Used for new sessions unless the project or ticket picks its own.") {
                    DriverModelPicker(
                        value: Models.settingsChoice(models),
                        resolved: Watchers.TriageChoice(driver: settings.defaultDriver, model: nil),
                        title: "Default model",
                        defaultLabel: "Driver default"
                    ) { choice in
                        guard let api = store.settingsAPI else { return }
                        let patch = Models.settingsChoicePatch(choice, models)
                        actions.perform { _ = try await api.updateSettings(patch) }
                    }
                }
            }
        } header: {
            SettingsSectionHeader(title: "Drivers", icon: "refresh", label: "Refresh drivers", loading: model.driversLoading) {
                Task { await model.reloadDrivers(store, actions) }
            }
        } footer: {
            Text("Open a driver for its sign-in and models. Tickets and projects can pick their own model; the default applies when they don't.")
        }
    }

    private func row(_ d: DriverInfo, isDefault: Bool) -> some View {
        SettingsButtonRow(chevron: true, action: { router.push(.driver(id: d.id)) }) {
            HStack(spacing: 6) {
                Text(d.name).font(.system(size: 16)).foregroundStyle(c.text)
                DriverStatusBadge(driver: d)
                if isDefault { Badge("Default", tone: .accent) }
            }
        } subtitle: {
            if !d.description.isEmpty { Text(d.description).font(.system(size: 13)).foregroundStyle(c.text3) }
        } trailing: {
            EmptyView()
        }
    }
}

/// Max concurrent runs and the app-wide base branch. (The Anthropic API key is on the
/// anthropic-api driver's own screen.)
struct SettingsGeneralSection: View {
    let settings: PublicSettings

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var c

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
        }
    }

    private func save(_ patch: SettingsPatch, ok: String? = nil) {
        guard let api = store.settingsAPI else { return }
        actions.perform(ok) { _ = try await api.updateSettings(patch) }
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
