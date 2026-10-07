import HarnessKit
import SwiftUI

// Settings sections that list things: Prompts (a summary row), Watchers and Projects.

/// The prompt catalog's summary ("2 customized · 1 broken"), opening Prompts.
struct SettingsPromptsSection: View {
    @Environment(Router.self) private var router
    @Environment(SettingsModel.self) private var model
    @Environment(\.palette) private var c

    var body: some View {
        let catalog = model.prompts
        let broken = catalog.prompts.map { Prompts.promptCounts($0).broken } ?? 0
        let summary = catalog.error ?? catalog.prompts.map(Prompts.promptsSummary) ?? "Loading…"
        Section {
            SettingsButtonRow(chevron: true, accessibilityLabel: "Prompts, \(summary)", action: { router.push(.prompts) }) {
                Text("Prompts").font(.scaled(size: 16)).foregroundStyle(c.text)
            } subtitle: {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if broken > 0 { Icon("alert", size: 12, weight: .bold).foregroundStyle(c.red) }
                    Text(summary).font(.scaled(size: 13)).foregroundStyle(catalog.error != nil || broken > 0 ? c.red : c.text3)
                }
            } trailing: { EmptyView() }
        } header: {
            Text("Prompts")
        } footer: {
            Text(promptsIntro)
        }
    }
}

/// Browser: the extensions every ticket's tabs share (opens ExtensionSettingsScreen).
struct SettingsExtensionsSection: View {
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        Section {
            SettingsButtonRow(chevron: true, action: { router.push(.extensions) }) {
                HStack(spacing: 8) {
                    Icon("puzzle", size: 15).foregroundStyle(c.text3)
                    Text("Extensions").font(.scaled(size: 16)).foregroundStyle(c.text)
                }
            } subtitle: {
                Text("Chrome extensions for the browser every ticket's tabs share.").font(.scaled(size: 13)).foregroundStyle(c.text3)
            } trailing: { EmptyView() }
            .accessibilityIdentifier("settings-extensions")
        } header: {
            Text("Browser")
        }
    }
}

/// Watchers: add, enable/pause, and a menu per watcher (Run now, Edit…, Delete).
struct SettingsWatchersSection: View {
    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(SettingsModel.self) private var model
    @Environment(\.palette) private var c

    var body: some View {
        let watchers = SettingsRules.sortedWatchers(store.state.watchers.values)
        Section {
            if watchers.isEmpty {
                SettingsButtonRow(action: { router.present(.watcher(id: nil)) }) {
                    Text("No watchers yet").font(.scaled(size: 16)).foregroundStyle(c.text)
                } subtitle: {
                    Text("Add a command like watch-jira, or a curl loop, to feed its output into triage.").font(.scaled(size: 13)).foregroundStyle(c.text3)
                } trailing: { EmptyView() }
            }
            ForEach(watchers) { w in
                SettingsWatcherRow(watcher: w, onTap: { openMenu(w) }) { on in
                    guard let api = store.api else { return }
                    actions.perform { _ = try await api.updateWatcher(w.id, WatcherBody(enabled: on)) }
                }
            }
        } header: {
            SettingsSectionHeader(title: "Watchers", icon: "plus", label: "Add watcher") { router.present(.watcher(id: nil)) }
        } footer: {
            Text("Shell commands whose output lands in the Inbox. Each new batch of output opens a triage session with the watcher's prompt.")
        }
    }

    private func openMenu(_ w: Watcher) {
        guard let api = store.api else { return }
        model.menu = ChoiceSheet(title: w.name, choices: [
            Choice(label: "Run now") { actions.perform { _ = try await api.runWatcher(w.id) } },
            Choice(label: "Edit…") { router.present(.watcher(id: w.id)) },
            Choice(label: "Delete", destructive: true) {
                model.confirm = Confirmation(title: "Delete watcher “\(w.name)”?", message: "", action: "Delete") {
                    actions.perform { _ = try await api.deleteWatcher(w.id) }
                }
            },
        ])
    }
}

/// One watcher: name, schedule and Paused badges, the command line, its prompt, where triage runs
/// and the last run, the last error, and the enable switch.
private struct SettingsWatcherRow: View {
    let watcher: Watcher
    let onTap: () -> Void
    let onEnable: (Bool) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    var body: some View {
        let w = watcher
        let target = SettingsRules.watcherTriageTarget(w, settings: store.state.settings)
        let cache = store.sharedModelCache
        let models = target.model != nil ? cache.get(target.driver).data?.models : nil
        let triage = SettingsRules.watcherTriageLabel(target, drivers: store.state.drivers, models: models)
        HStack(spacing: 10) {
            Button(action: onTap) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(w.name).font(.scaled(size: 16)).foregroundStyle(c.text)
                        Badge(SettingsRules.watcherScheduleLabel(w))
                        if !w.enabled { Badge("Paused", outline: true) }
                    }
                    Text(Watchers.watcherCommandLine(w)).font(.mono(12.5)).foregroundStyle(c.text3).lineLimit(2)
                    if !w.prompt.isEmpty { Text(w.prompt).font(.scaled(size: 12.5)).foregroundStyle(c.text2).lineLimit(2) }
                    NowReader { now in
                        Text(SettingsRules.watcherMetaLine(triage: triage, w, now: now)).font(.scaled(size: 12.5)).foregroundStyle(c.text3)
                    }
                    if let error = w.lastError, !error.isEmpty { Text(error).font(.scaled(size: 12.5)).foregroundStyle(c.red) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            Toggle("Enable \(w.name)", isOn: Binding(get: { w.enabled }, set: onEnable))
                .labelsHidden()
                .tint(c.accent)
                .accessibilityLabel("Enable \(w.name)")
        }
        .settingsRowBackground(c)
        .task(id: "\(target.model != nil ? target.driver : "")#\(store.epoch)") {
            guard target.model != nil, !target.driver.isEmpty else { return }
            cache.syncEpoch(store.epoch)
            await cache.load(target.driver)
        }
    }
}

/// Projects: add one by its path on the Mac; each row opens its settings.
struct SettingsProjectsSection: View {
    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(SettingsModel.self) private var model
    @Environment(\.palette) private var c

    var body: some View {
        let projects = store.state.sortedProjects()
        Section {
            if projects.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("No projects yet").font(.scaled(size: 16)).foregroundStyle(c.text)
                    Text("Add one with +.").font(.scaled(size: 13)).foregroundStyle(c.text3)
                }
                .settingsRowBackground(c)
            }
            ForEach(projects) { p in
                SettingsButtonRow(chevron: true, action: { router.push(.project(id: p.id)) }) {
                    HStack(spacing: 8) {
                        ProjectKeyBadge(p.key, color: p.color)
                        Text(p.name).font(.scaled(size: 16)).foregroundStyle(c.text)
                    }
                } subtitle: {
                    Text(Format.tildify(p.path)).font(.mono(12)).foregroundStyle(c.text3).lineLimit(1).truncationMode(.middle)
                } trailing: { EmptyView() }
            }
        } header: {
            SettingsSectionHeader(title: "Projects", icon: "plus", label: "Add project", action: add)
        } footer: {
            Text("Name, identifier, folder, driver and review settings are set per project.")
        }
    }

    private func add() {
        model.textPrompt = SettingsTextPrompt(
            title: "Add project",
            message: "The folder's absolute path on the Mac, e.g. /Users/you/Sites/app",
            placeholder: "/Users/you/Sites/app",
            action: "Add"
        ) { text in
            Task { await store.addProject(path: text, actions: actions) }
        }
    }
}
