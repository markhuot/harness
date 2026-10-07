import HarnessKit
import SwiftUI

/// Create or edit a watcher (on HarnessKit's WatcherDraft), in a sheet:
/// the shell's Cancel on the leading side, Create / Save on the trailing side once the name and
/// command are filled in. nil `id` is a new watcher. The body always sends `args: []`, so saving a
/// legacy direct-exec watcher turns it into a shell watcher running the line shown.
struct WatcherFormScreen: View {
    let id: String?

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c

    @State private var draft = WatcherDraft()
    @State private var edited = false
    @State private var busy = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        let existing = id.flatMap { store.state.watchers[$0] }
        let settings = store.state.settings
        let valid = !trimmed(draft.name).isEmpty && !trimmed(draft.command).isEmpty
        // What the Default pick falls back to: the app-wide watcher driver and its model.
        let resolvedDriver = settings.map { Watchers.watcherDriver(nil, settings: $0) }
        let resolved = Watchers.TriageChoice(driver: resolvedDriver, model: resolvedDriver.flatMap { Watchers.watcherModel($0, watcher: nil, settings: settings) })

        Form {
            Section("Name") {
                field(TextField("", text: edit(\.name), prompt: prompt("jira")).focused($nameFocused))
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel("Name")
            }
            Section {
                field(TextField("", text: edit(\.command), prompt: prompt("node ~/Sites/Jira/watch-jira.js"), axis: .vertical).font(.mono(14)))
                    .lineLimit(3...12)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Command")
            } header: {
                Text("Command")
            } footer: {
                Text("Runs in your login shell, so pipes, PATH and loops like while true; do curl -s …; sleep 60; done work. Whatever it prints shows up in the Inbox.")
            }
            Section {
                field(TextField("", text: edit(\.prompt), prompt: prompt("If this event is assigned to me and has actionable next steps, dispatch it to an agent."), axis: .vertical))
                    .lineLimit(3...12)
                    .accessibilityLabel("Prompt")
            } header: {
                Text("Prompt")
            } footer: {
                Text("Optional. What triage should do with the output.")
            }
            Section("Working directory") {
                field(TextField("", text: edit(\.cwd), prompt: prompt("Optional")).font(.mono(15)))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Working directory")
            }
            Section {
                SettingsRow(label: "Model") {
                    DriverModelPicker(value: draft.choice, resolved: resolved) { choice in
                        edited = true
                        draft.choice = choice
                    }
                }
            } footer: {
                Text("The driver and model this watcher's triage sessions use.")
            }
            Section {
                Picker("Mode", selection: edit(\.mode)) {
                    Text("Loop").tag(WatcherMode.loop)
                    Text("Interval").tag(WatcherMode.interval)
                }
                .pickerStyle(.segmented)
                .settingsRowBackground(c)
                if draft.mode == .interval {
                    HStack(spacing: 8) {
                        TextField("", text: edit(\.intervalSec))
                            .keyboardType(.numberPad)
                            .foregroundStyle(c.text)
                            .frame(width: 110)
                            .accessibilityLabel("Interval in seconds")
                        Text("seconds").foregroundStyle(c.text2)
                        Spacer()
                    }
                    .settingsRowBackground(c)
                }
            } header: {
                Text("Mode")
            } footer: {
                Text(draft.mode == .loop ? "Re-runs as soon as the command exits." : "Runs on a fixed schedule.")
            }
            Section {
                Toggle("Enabled", isOn: edit(\.enabled))
                    .tint(c.accent)
                    .foregroundStyle(c.text)
                    .settingsRowBackground(c)
            }
        }
        .settingsFormStyle(c)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(existing != nil ? "Edit watcher" : "New watcher")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(existing != nil ? "Save" : "Create", systemImage: "checkmark") { submit(existing) }
                    .disabled(!valid || busy)
            }
        }
        // A cold start through a deep link renders before the snapshot has the watcher: fill the
        // form once it (and the settings) arrive, unless the user has already started typing.
        .task(id: "\(existing?.id ?? "")#\(settings != nil)") {
            if !edited { draft = WatcherDraft.toDraft(existing, settings: settings) }
        }
        .onAppear { if id == nil { nameFocused = true } }
    }

    private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func prompt(_ text: String) -> Text { Text(text).foregroundStyle(c.text3) }

    private func field(_ f: some View) -> some View {
        f.foregroundStyle(c.text).settingsRowBackground(c)
    }

    /// A binding into the draft that marks it edited.
    private func edit<V>(_ key: WritableKeyPath<WatcherDraft, V>) -> Binding<V> {
        Binding(get: { draft[keyPath: key] }, set: {
            edited = true
            draft[keyPath: key] = $0
        })
    }

    private func submit(_ existing: Watcher?) {
        let name = trimmed(draft.name)
        let command = trimmed(draft.command)
        guard !name.isEmpty, !command.isEmpty, !busy, let api = store.api else { return }
        busy = true
        let body = WatcherDraft.watcherBody(draft, existing: existing)
        Task {
            let ok: Watcher?
            if let existing {
                ok = await actions.run { try await api.updateWatcher(existing.id, body) }
            } else {
                ok = await actions.run { try await api.createWatcher(name: name, command: command, body) }
            }
            busy = false
            if ok != nil { router.sheet = nil }
        }
    }
}
