import HarnessKit
import SwiftUI

/// A project's settings: name, identifier (renamed with the live
/// preview), color, folder (a text field: there's no folder picker on the phone), default driver /
/// model / permission mode, worktrees, base branch and "When approved" (git projects), human
/// review, auto-complete, and removing it. Every change goes out as an updateProject PATCH.
struct ProjectSettingsScreen: View {
    let projectId: String

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    var body: some View {
        if let project = store.state.projects[projectId] {
            ProjectSettingsForm(project: project).id(project.id)
        } else {
            EmptyState(icon: "folder", title: "This project no longer exists")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(c.bg)
                .navigationTitle("Project settings")
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct ProjectSettingsForm: View {
    let project: Project

    @Environment(BoardStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(Actions.self) private var actions
    @Environment(ToastCenter.self) private var toasts
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    /// Done tickets page in, so Remove project's count asks the service for its done total.
    @State private var doneTotal: Int?
    @State private var path = ""
    @State private var pendingPath: String?
    @State private var confirm: Confirmation?
    @State private var latest = PickerLatest<(Project, String)>()
    @FocusState private var pathFocused: Bool

    var body: some View {
        let _ = latest.set((project, path))
        let state = store.state
        let settings = state.settings
        let inherited = settings?.permissionMode ?? .auto
        let modelProject = ModelProject(project)
        let modelSettings = settings.map(ModelSettings.init)
        let count = SettingsRules.projectTicketCount(project.id, tickets: state.tickets.values, doneTotal: doneTotal)
        let isGit = project.isGit == true

        Form {
            Section("General") {
                SettingsRow(label: "Name") {
                    DraftField(value: project.name, prompt: "Name") { v in
                        let name = v.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !name.isEmpty { save(UpdateProjectBody(name: name)) }
                    }
                    .accessibilityLabel("Name")
                }
                ProjectSettingsKeyRow(project: project)
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Text("Color").font(.scaled(size: 15)).foregroundStyle(c.text)
                        ProjectKeyBadge(project.key, color: project.color)
                    }
                    Text("Tints the project's key badge on cards, tickets and lists.").font(.scaled(size: 12.5)).foregroundStyle(c.text3)
                    ProjectColorPicker(value: project.color) { save(UpdateProjectBody(color: Patch($0))) }
                }
                .settingsRowBackground(c)
                VStack(alignment: .leading, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Folder").font(.scaled(size: 15)).foregroundStyle(c.text)
                        Text("Absolute path on the Mac").font(.scaled(size: 12.5)).foregroundStyle(c.text3)
                    }
                    TextField("", text: $path)
                        .font(.mono(14))
                        .foregroundStyle(c.text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($pathFocused)
                        .onSubmit(commitPath)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 38)
                        .background(c.bgSunken, in: .rect(cornerRadius: 8))
                        .accessibilityLabel("Folder")
                }
                .settingsRowBackground(c)
            }

            Section("Agents") {
                SettingsRow(label: "Default model", hint: "Used for new sessions in this project. Global default follows the app setting.") {
                    DriverModelPicker(
                        value: Models.projectChoice(modelProject, modelSettings),
                        resolved: settings.map { Watchers.TriageChoice(driver: $0.defaultDriver, model: Models.inheritedModel($0.defaultDriver, level: .project, project: modelProject, settings: modelSettings)) }
                            ?? Watchers.defaultTriageChoice,
                        title: "Default model",
                        defaultLabel: "Global default",
                        inheritedModel: { Models.inheritedModel($0, level: .project, project: modelProject, settings: modelSettings) }
                    ) { save(Models.projectChoicePatch($0, modelProject)) }
                }
                SettingsRow(label: "Permission mode", hint: "\(Permissions.label(for: project.permissionMode ?? inherited)?.description ?? "") Tickets can override it.") {
                    PermissionPicker(value: project.permissionMode, inherited: inherited) { save(UpdateProjectBody(permissionMode: Patch($0))) }
                }
                toggleRow("Worktree per ticket", hint: "Each ticket works on its own branch (harness/<key>) when the folder is a git repo.", on: project.useWorktrees) {
                    save(UpdateProjectBody(useWorktrees: $0))
                }
                if isGit {
                    SettingsRow(label: "Base branch", hint: "Tickets merge into it when they complete, and new branches start from it. Empty follows the app setting.") {
                        DraftField(
                            value: project.baseBranch.optional ?? "",
                            prompt: Branches.inheritedBaseLabel(Branches.resolveBaseBranch(ticket: nil, project: nil, settings: settings?.baseBranch)),
                            mono: true
                        ) { v in
                            switch SettingsRules.projectBaseBranchCommit(v) {
                            case .none: break
                            case let .invalid(error): toasts.show("Not a valid branch name: \(error)", kind: .error)
                            case let .save(name): save(UpdateProjectBody(baseBranch: Patch(name)))
                            }
                        }
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .frame(maxWidth: 180)
                        .accessibilityLabel("Base branch")
                    }
                }
                toggleRow("Require human review", hint: "When off, the agent reviewer alone can clear a ticket for completion.", on: project.requireHumanReview) {
                    save(UpdateProjectBody(requireHumanReview: $0))
                }
                toggleRow("Complete when approved", hint: "Once both reviews approve, run the completion step (merge the branch, clean up) and move the ticket to Done.", on: project.autoComplete) {
                    save(UpdateProjectBody(autoComplete: $0))
                }
                if isGit {
                    let info = Completion.ProjectInfo(project)
                    SettingsRow(label: "When approved", hint: "What the Approve button does by default: merge the branch, open a pull request, or follow instructions you give. Each approval can pick another.") {
                        SelectMenu(
                            value: Completion.projectCompletionDefault(info),
                            options: Approve.completionActionOptions(Completion.offeredCompletionActions(info)).map {
                                PickerOption(value: $0.value, label: $0.label ?? $0.value.rawValue, subtitle: $0.subtitle, disabled: $0.disabled == true)
                            },
                            title: "When approved",
                            accessibilityName: "When approved"
                        ) { save(UpdateProjectBody(completionAction: $0)) }
                    }
                }
            }

            Section("Danger zone") {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Remove project").font(.scaled(size: 15)).foregroundStyle(c.text)
                        Text(SettingsRules.removeProjectHint(count)).font(.scaled(size: 12.5)).foregroundStyle(c.text3)
                    }
                    HButton("Remove project…", icon: "trash", variant: .dangerSolid, haptic: .warning) { remove(count) }
                }
                .settingsRowBackground(c)
            }
        }
        .settingsFormStyle(c)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .confirmation($confirm)
        .alert("Change the project folder?", isPresented: Binding(get: { pendingPath != nil }, set: { if !$0 { pendingPath = nil } }), presenting: pendingPath) { p in
            Button("Cancel", role: .cancel) { path = project.path }
            Button("Change") { save(UpdateProjectBody(path: p), ok: "Project folder updated") }
        } message: { p in
            Text("Agents start new runs in \(p).")
        }
        .onAppear { path = project.path }
        .onChange(of: project.path) { _, p in path = p }
        .onChange(of: pathFocused) { _, now in if !now { commitPath() } }
        .task(id: project.id) {
            guard let api = store.api else { return }
            if let page = try? await api.ticketPage(status: .done, projectId: project.id, limit: 1), !Task.isCancelled { doneTotal = page.total }
        }
    }

    private func toggleRow(_ label: String, hint: String, on: Bool, set: @escaping (Bool) -> Void) -> some View {
        SettingsRow(label: label, hint: hint) {
            Toggle(label, isOn: Binding(get: { on }, set: set)).labelsHidden().tint(c.accent).accessibilityLabel(label)
        }
    }

    private func save(_ body: UpdateProjectBody, ok: String? = nil) {
        guard let api = store.api else { return }
        let id = project.id
        actions.perform(ok) { _ = try await api.updateProject(id, body) }
    }

    /// On return or blur: confirm a changed folder (Cancel puts the old one back); an empty or
    /// unchanged one just resets.
    private func commitPath() {
        guard let (project, path) = latest.value, pendingPath == nil else { return }
        if let p = SettingsRules.projectPathCommit(path, current: project.path) {
            pendingPath = p
        } else {
            self.path = project.path
        }
    }

    /// Leaves this screen through the Router rather than `dismiss`: the socket's projectDeleted
    /// can land before the request returns, which swaps this form for the empty state, so the
    /// form's own dismiss action may no longer be the screen's. Pops only when the selected tab's
    /// stack still ends at this project.
    private func pop(_ router: Router, projectId id: String) {
        let tab = router.selectedTab
        var path = router.path(tab)
        guard case let .project(top)? = path.last, top == id else { return }
        path.removeLast()
        router.setPath(tab, path)
    }

    private func remove(_ count: Int) {
        let copy = SettingsRules.removeProjectConfirm(name: project.name, key: project.key, count: count)
        let id = project.id
        confirm = Confirmation(title: copy.title, message: copy.message, action: "Remove") {
            guard let api = store.api else { return }
            Task {
                if await actions.run("Project removed", { try await api.deleteProject(id) }) != nil {
                    if app.prefs.boardProject == id { app.setPref(\.boardProject, nil) }
                    pop(router, projectId: id)
                }
            }
        }
    }
}

/// Identifier (the ticket key prefix): upper case, live validation and the rename preview, then
/// Cancel / Rename.
private struct ProjectSettingsKeyRow: View {
    let project: Project

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c

    @State private var draft = ""
    @State private var busy = false
    @State private var latest = PickerLatest<ProjectKey.KeyPreview>()

    var body: some View {
        let state = store.state
        let preview = ProjectKey.previewProjectKey(project, projects: Array(state.projects.values), tickets: Array(state.tickets.values), draft: draft)
        let _ = latest.set(preview)
        let tint = preview.error != nil ? c.red : preview.changed ? c.amber : c.text3
        VStack(alignment: .leading, spacing: 8) {
            Text("Identifier").font(.scaled(size: 15)).foregroundStyle(c.text)
            TextField("", text: Binding(get: { draft }, set: { draft = SettingsRules.identifierDraft($0) }))
                .font(.mono(16))
                .foregroundStyle(c.text)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit(commit)
                .padding(.horizontal, 10)
                .frame(minHeight: 38)
                .background(c.bgSunken, in: .rect(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(preview.error != nil ? c.red : c.border, lineWidth: 0.5) }
                .accessibilityLabel("Identifier")
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if preview.error != nil { Icon("alert", size: 12).foregroundStyle(c.red) }
                Text(preview.message).font(.scaled(size: 13)).foregroundStyle(tint).frame(maxWidth: .infinity, alignment: .leading)
            }
            if preview.changed {
                HStack(spacing: 8) {
                    Spacer()
                    HButton("Cancel", variant: .ghost, small: true, fullWidth: false) { draft = project.key }
                        .disabled(busy)
                    HButton("Rename", variant: .primary, small: true, loading: busy, fullWidth: false, action: commit)
                        .disabled(preview.error != nil)
                }
            }
        }
        .settingsRowBackground(c)
        .onAppear { draft = project.key }
        .onChange(of: project.key) { _, k in draft = k }
    }

    private func commit() {
        guard let preview = latest.value, preview.changed, preview.error == nil, !busy, let api = store.api else { return }
        busy = true
        let id = project.id
        Task {
            await actions.run(SettingsRules.renameToast(preview)) { try await api.updateProject(id, UpdateProjectBody(key: preview.key)) }
            busy = false
        }
    }
}
