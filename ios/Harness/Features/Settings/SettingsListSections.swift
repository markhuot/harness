import HarnessKit
import SwiftUI

// Settings sections that list things: Prompts (a summary row), Projects.

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
