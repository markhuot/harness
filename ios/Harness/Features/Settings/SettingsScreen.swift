import HarnessKit
import SwiftUI

/// The Settings tab: connection (saved Macs, token rotation), network,
/// appearance and themes, drivers (each opens DriverSettingsScreen) with the default model,
/// general, permissions, triage, prompts, watchers and projects. Pull to refresh reloads the board snapshot. A settings deep link's theme
/// picks (`harness://settings?lightTheme=…`) are applied by the shell before this screen shows.
///
/// A modifier on a Form `Section` lands on every row of it, so the sections don't present or load
/// anything themselves: they set `SettingsModel`'s dialogs, and the screen presents them and runs
/// the loads once.
struct SettingsScreen: View {
    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c

    @State private var model = SettingsModel()
    @State private var promptText = ""

    var body: some View {
        Form {
            SettingsConnectionSection()
            SettingsNetworkSection()
            SettingsAppearanceSection()
            SettingsDriversSection()
            if let settings = store.state.settings {
                SettingsGeneralSection(settings: settings)
                SettingsPermissionsSection(settings: settings)
                SettingsTriageSection(settings: settings)
            }
            SettingsPromptsSection()
            SettingsWatchersSection()
            SettingsProjectsSection()
        }
        .settingsFormStyle(c)
        .refreshable { await store.refresh() }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner() }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
        .environment(model)
        .task(id: "\(store.epoch)#\(store.state.settings?.listen?.mode.rawValue ?? "")#\(model.networkReloads)") {
            guard let api = store.api else { return }
            let net = try? await api.network()
            if !Task.isCancelled { model.network = net }
        }
        .task(id: store.epoch) { if store.epoch > 0 { await model.reloadDrivers(store, actions) } }
        .loadingPrompts(model.prompts)
        .choiceSheet(Bindable(model).menu)
        .confirmation(Bindable(model).confirm)
        .alert(model.textPrompt?.title ?? "", isPresented: Binding(get: { model.textPrompt != nil }, set: { if !$0 { model.textPrompt = nil } }), presenting: model.textPrompt) { p in
            TextField(p.placeholder, text: $promptText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button(p.action) { p.onSubmit(promptText) }
        } message: { p in
            if let m = p.message { Text(m) }
        }
        .onChange(of: model.textPrompt?.id) { promptText = model.textPrompt?.initial ?? "" }
    }
}

/// What the Settings sections share: the dialogs the screen presents for them, the network status
/// and driver reload state it loads, and the prompt catalog.
@MainActor
@Observable
final class SettingsModel {
    var menu: ChoiceSheet?
    var confirm: Confirmation?
    var textPrompt: SettingsTextPrompt?

    var network: NetworkStatus?
    /// Bumped to load the network status again (after a listen change has had time to apply).
    var networkReloads = 0
    var driversLoading = false

    let prompts = PromptCatalog()

    func reloadDrivers(_ store: BoardStore, _ actions: Actions) async {
        let client = store.client
        driversLoading = true
        if let drivers = await actions.run(nil, { try await client.listDrivers() }) { store.dispatch(.drivers(drivers)) }
        driversLoading = false
    }
}

/// An alert with one text field.
struct SettingsTextPrompt: Identifiable {
    let id = UUID()
    var title: String
    var message: String?
    var placeholder = ""
    var initial = ""
    var action = "OK"
    var onSubmit: @MainActor (String) -> Void
}

// MARK: - Connection

/// Saved Macs (switch, rename, forget), pairing another, and rotating the token.
private struct SettingsConnectionSection: View {
    @Environment(AppModel.self) private var app
    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(SettingsModel.self) private var model
    @Environment(\.palette) private var c

    var body: some View {
        Section {
            ForEach(app.servers) { s in
                let active = app.active?.id == s.id
                let connected = store.state.connected
                SettingsButtonRow(action: { openMenu(s) }) {
                    HStack(spacing: 8) {
                        if active { Circle().fill(connected ? c.green : c.amber).frame(width: 8, height: 8).accessibilityHidden(true) }
                        Text(s.name).font(.scaled(size: 16)).foregroundStyle(c.text)
                    }
                } subtitle: {
                    if let host = SettingsRules.serverHost(s) { Text(host).font(.mono(12.5)).foregroundStyle(c.text3) }
                } trailing: {
                    if active {
                        Badge(connected ? "Connected" : "Reconnecting", tone: connected ? .green : .amber)
                    } else {
                        Icon("chevronRight", size: 13).foregroundStyle(c.text3)
                    }
                }
            }
            SettingsButtonRow(action: { router.present(.connect) }) {
                Text("Pair a Mac…").font(.scaled(size: 16)).foregroundStyle(c.accent)
            } subtitle: { EmptyView() } trailing: { EmptyView() }
            SettingsButtonRow(action: rotate) {
                Text("Rotate token…").font(.scaled(size: 16)).foregroundStyle(c.red)
            } subtitle: {
                Text("Invalidates the current token for every client.").font(.scaled(size: 13)).foregroundStyle(c.text3)
            } trailing: { EmptyView() }
        } header: {
            Text("Connection")
        } footer: {
            Text("Pair another Mac by scanning the QR code in Harness → Settings → Network on that Mac.")
        }
    }

    private func openMenu(_ s: SavedServer) {
        var choices: [Choice] = []
        if app.active?.id != s.id { choices.append(Choice(label: "Connect") { app.activate(s.id) }) }
        choices.append(Choice(label: "Rename…") {
            model.textPrompt = SettingsTextPrompt(title: "Rename", placeholder: "Name", initial: s.name) { app.rename(s.id, to: $0) }
        })
        choices.append(Choice(label: "Forget this Mac", destructive: true) {
            model.confirm = Confirmation(title: "Forget \(s.name)?", message: "Its token is removed from this \(deviceName).", action: "Forget") {
                app.forget(s.id)
            }
        })
        model.menu = ChoiceSheet(title: s.name, message: s.baseUrl, choices: choices)
    }

    private func rotate() {
        model.confirm = Confirmation(
            title: "Rotate the token?",
            message: "Every client using the current token is disconnected, including the desktop app until it reconnects. This \(deviceName) switches to the new token.",
            action: "Rotate"
        ) {
            guard let api = store.api else { return }
            let baseUrl = store.baseUrl
            Task {
                if let res = await actions.run("Token rotated", { try await api.rotateToken() }) {
                    _ = await app.pair(ServerAddress(baseUrl: baseUrl, token: res.token), skipProbe: true)
                }
            }
        }
    }
}

// MARK: - Network

/// Where the service listens (GET /network, loaded by the screen). Hidden until it loads.
private struct SettingsNetworkSection: View {
    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(SettingsModel.self) private var model
    @Environment(\.palette) private var c

    var body: some View {
        if let net = model.network {
            Section {
                SettingsRow(label: "Listen on", hint: net.error) {
                    SelectMenu(
                        value: net.mode,
                        options: SettingsRules.listenChoices.map { PickerOption(value: $0, label: SettingsRules.listenLabel($0)) },
                        label: SettingsRules.listenTriggerLabel(net),
                        title: "Listen on",
                        disabled: net.override?.isEmpty == false,
                        accessibilityName: "Listen on"
                    ) { change(net.mode, to: $0) }
                }
                addressRow("Addresses", net.bound.map { (SettingsRules.boundLabel($0.url), false) })
                if let ts = net.tailscale {
                    addressRow("Tailscale", [(ts.ip, false)] + (ts.dnsName.map { [($0, true)] } ?? []))
                }
            } header: {
                Text("Network")
            } footer: {
                Text(SettingsRules.networkFooter(net))
            }
        }
    }

    private func addressRow(_ label: String, _ lines: [(String, Bool)]) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(.scaled(size: 15)).foregroundStyle(c.text)
            Spacer(minLength: 12)
            VStack(alignment: .trailing, spacing: 2) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line.0).font(.mono(line.1 ? 11.5 : 12.5)).foregroundStyle(line.1 ? c.text3 : c.text2).textSelection(.enabled)
                }
            }
        }
        .settingsRowBackground(c)
    }

    private func change(_ current: ListenMode, to next: ListenMode) {
        switch SettingsRules.listenChange(from: current, to: next) {
        case .none: return
        case .confirm:
            model.confirm = Confirmation(title: "Listen on this Mac only?", message: "This \(deviceName) will lose its connection until you change it back on the Mac.", action: "Change") {
                apply(next)
            }
        case .apply: apply(next)
        }
    }

    private func apply(_ mode: ListenMode) {
        guard let api = store.api else { return }
        let model = model
        Task {
            await actions.run("Network updated") { try await api.updateSettings(SettingsPatch(listen: ListenSetting(mode: mode))) }
            try? await Task.sleep(for: .milliseconds(800))
            model.networkReloads += 1
        }
    }
}
