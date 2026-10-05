import HarnessKit
import SwiftUI

/// Settings → Extensions: the Chrome extensions of the browser every ticket's tabs share
/// (GET /browser-extensions), as on the Mac. Web Store extensions install through Chrome itself, so
/// the organization's Chrome policy applies; an unpacked folder is a path on the Mac running the
/// service. A Web Store install lands when Chrome next starts, which Restart browser does on demand.
struct ExtensionSettingsScreen: View {
    @Environment(BoardStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var c

    @State private var list: BrowserExtensionList?
    @State private var loadError: String?
    @State private var draft = ""
    @State private var adding = false
    @State private var addError: String?
    @State private var busy: Set<String> = []
    @State private var restarting = false
    @State private var confirmRestart = false
    @State private var removing: BrowserExtension?
    @State private var folderPrompt = false
    @State private var folderPath = ""

    var body: some View {
        let mine = list?.extensions.filter { $0.source != .chrome } ?? []
        let others = list?.extensions.filter { $0.source == .chrome } ?? []
        let waiting = list.map(Extensions.waiting) ?? 0
        Form {
            Section {
                HStack(spacing: 8) {
                    TextField("Chrome Web Store link or extension ID", text: $draft)
                        .font(.scaled(size: 16))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .submitLabel(.go)
                        .onSubmit(addWebStore)
                        .disabled(adding)
                        .accessibilityIdentifier("extensions-webstore")
                    if adding {
                        ProgressView()
                    } else {
                        Button("Add", action: addWebStore)
                            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("extensions-add")
                    }
                }
                .settingsRowBackground(c)
                SettingsButtonRow(action: { folderPath = ""; folderPrompt = true }) {
                    Text("Add unpacked folder…").font(.scaled(size: 16)).foregroundStyle(adding ? c.text3 : c.accent)
                } subtitle: {
                    Text("A folder on the Mac running Harness, for an extension you're building.").font(.scaled(size: 13)).foregroundStyle(c.text3)
                } trailing: { EmptyView() }
                .disabled(adding)
                if let addError {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Icon("alert", size: 13).foregroundStyle(c.red)
                        Text(addError).font(.scaled(size: 14)).foregroundStyle(c.red)
                    }
                    .settingsRowBackground(c)
                    .accessibilityIdentifier("extensions-add-error")
                }
            } header: {
                Text("Add")
            } footer: {
                Text("Your organization's Chrome policy applies, as it does in Chrome. Run an extension's toolbar button from the puzzle menu in a ticket's browser.")
            }

            if waiting > 0 {
                Section {
                    SettingsButtonRow(action: { confirmRestart = true }) {
                        Text(waiting == 1 ? "1 extension installs when the browser restarts" : "\(waiting) extensions install when the browser restarts")
                            .font(.scaled(size: 16)).foregroundStyle(c.text)
                    } subtitle: {
                        Text("The browser restarts on its own once no ticket uses it, or restart it now (open pages reload).").font(.scaled(size: 13)).foregroundStyle(c.text3)
                    } trailing: {
                        if restarting { ProgressView() } else { Text("Restart").font(.scaled(size: 16)).foregroundStyle(c.accent) }
                    }
                    .disabled(restarting)
                    .accessibilityIdentifier("extensions-restart")
                }
            }

            Section {
                if list == nil {
                    HStack {
                        if let loadError { Text(loadError).font(.scaled(size: 14)).foregroundStyle(c.red) } else { ProgressView() }
                    }
                    .settingsRowBackground(c)
                } else if mine.isEmpty {
                    Text("No extensions added yet.").font(.scaled(size: 15)).foregroundStyle(c.text3).settingsRowBackground(c)
                }
                ForEach(mine) { ext in
                    ExtensionRow(ext: ext, busy: busy.contains(ext.id)) { on in
                        change(ext) { try await $0.setBrowserExtensionEnabled(ext.id, enabled: on) }
                    }
                    .swipeActions {
                        Button("Remove", role: .destructive) { removing = ext }
                    }
                    .contextMenu {
                        Button("Remove", systemImage: "trash", role: .destructive) { removing = ext }
                    }
                }
            } header: {
                Text("Added")
            }

            if !others.isEmpty {
                Section {
                    ForEach(others) { ExtensionRow(ext: $0) }
                } header: {
                    Text("Also in the browser")
                }
            }
        }
        .settingsFormStyle(c)
        .navigationTitle("Extensions")
        .refreshable { await load() }
        .task(id: store.epoch) { await load() }
        // Chrome also restarts on its own once every tab is idle: look again now and then while one waits.
        .task(id: list?.extensions.contains { $0.status == .pending } ?? false) {
            guard list?.extensions.contains(where: { $0.status == .pending }) == true else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if Task.isCancelled { return }
                await load()
            }
        }
        .confirmationDialog("Restart the browser?", isPresented: $confirmRestart, titleVisibility: .visible) {
            Button("Restart browser") { Task { await restart() } }
        } message: {
            Text("Every ticket's open pages reload.")
        }
        .confirmationDialog(removing.map { "Remove \($0.name) from the browser?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { ext in
            Button("Remove", role: .destructive) { change(ext) { _ = try await $0.removeBrowserExtension(ext.id) } }
        }
        .alert("Add an unpacked extension", isPresented: $folderPrompt) {
            TextField("~/code/my-extension", text: $folderPath)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Add") { add(.path(folderPath.trimmingCharacters(in: .whitespaces))) }
        } message: {
            Text("The extension's folder on the Mac running Harness.")
        }
    }

    private func load() async {
        guard let api = store.api else { return }
        do {
            list = try await api.listBrowserExtensions()
            loadError = nil
        } catch {
            loadError = localizedErrorMessage(error)
        }
    }

    private func addWebStore() {
        let value = draft.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, !adding else { return }
        add(.webstore(value))
    }

    private func add(_ body: AddBrowserExtensionBody) {
        guard let api = store.api else { return }
        if case let .path(p) = body, p.isEmpty { return }
        adding = true
        addError = nil
        Task {
            do {
                let ext = try await api.addBrowserExtension(body)
                if case .webstore = body { draft = "" }
                toasts.show(ext.status == .pending ? "\(ext.name) installs when the browser restarts." : "Added \(ext.name).", kind: .info)
            } catch {
                addError = localizedErrorMessage(error)
            }
            adding = false
            await load()
        }
    }

    /// Run a change to one extension, showing its row busy and any error as a toast.
    private func change(_ ext: BrowserExtension, _ fn: @escaping @MainActor (HarnessClient) async throws -> Void) {
        guard let api = store.api else { return }
        busy.insert(ext.id)
        Task {
            do {
                try await fn(api)
            } catch {
                toasts.show(localizedErrorMessage(error), kind: .error)
            }
            busy.remove(ext.id)
            await load()
        }
    }

    private func restart() async {
        guard let api = store.api else { return }
        restarting = true
        do {
            _ = try await api.restartBrowser()
        } catch {
            toasts.show(localizedErrorMessage(error), kind: .error)
        }
        restarting = false
        await load()
    }
}

/// One extension: name, version, status badge and note, its folder, and (for one added in
/// Settings) its switch.
private struct ExtensionRow: View {
    let ext: BrowserExtension
    var busy = false
    var onToggle: ((Bool) -> Void)?

    @Environment(\.palette) private var c

    var body: some View {
        let note = Extensions.note(ext)
        HStack(alignment: .top, spacing: 10) {
            Icon("puzzle", size: 18).foregroundStyle(note.tone == .error ? c.red : c.text3).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(ext.name).font(.scaled(size: 16)).foregroundStyle(c.text).lineLimit(1)
                    if !ext.version.isEmpty { Text(ext.version).font(.mono(12)).foregroundStyle(c.text3) }
                }
                if let badge = note.badge { Badge(badge, tone: note.tone == .error ? .red : .neutral) }
                if let text = note.text { Text(text).font(.scaled(size: 13)).foregroundStyle(note.tone == .error ? c.red : c.text3).lineLimit(3) }
                if let path = ext.path { Text(path).font(.mono(12)).foregroundStyle(c.text3).lineLimit(1).truncationMode(.middle) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let onToggle {
                if busy { ProgressView() }
                Toggle("\(ext.name) on", isOn: Binding(get: { ext.enabled }, set: onToggle))
                    .labelsHidden()
                    .tint(c.accent)
                    .disabled(busy)
                    .accessibilityLabel("\(ext.name) on")
            }
        }
        .settingsRowBackground(c)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("extension-row-\(ext.id)")
    }
}
