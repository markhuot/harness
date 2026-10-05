import HarnessKit
import SwiftUI

/// New session edits a draft ticket (DESIGN.md "Drafts"): the project
/// with Task | Conductor, the prompt, its attachments (photos, files, pastes and drops, uploaded to
/// the Mac: NewSessionAttachments), and an Options disclosure holding the same TicketSettings rows
/// as ticket Details. The draft is saved lazily (DraftSync, through HarnessKit's NewSessionEditor):
/// nothing until it has something worth keeping, then a POST and debounced PATCHes. The toolbar's
/// Plan first and Start session launch it; Cancel asks whether to save or discard a non-empty
/// draft, and a swipe down saves it. `key` reopens a saved draft (a draft card on the board, or
/// /ticket/<key> for one).
struct NewSessionScreen: View {
    let projectId: String?
    let key: String?

    @Environment(BoardStore.self) private var store

    var body: some View {
        // A new store (another Mac, a new token) starts the editor over.
        NewSessionEditorView(projectId: projectId, reopen: key)
            .id(ObjectIdentifier(store))
    }
}

private struct NewSessionEditorView: View {
    let projectId: String?
    let reopen: String?

    @Environment(BoardStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(ToastCenter.self) private var toasts
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c

    @State private var editor: NewSessionEditor?
    @State private var branches = TicketBranches()
    @State private var optionsOpen = false
    @State private var askingCancel = false
    @State private var adding = false
    @State private var newPath = ""
    @State private var releaseKey: (@MainActor () -> Void)?
    @State private var uploader = PromptAttachmentUploader()

    var body: some View {
        let state = store.state
        let view = editor?.view(state)
        content(state, view)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(c.bg)
            .navigationTitle(reopen != nil ? "Draft" : "New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { cancel() }
                }
                // Plan first and Start session each get their own glass; Start is the prominent one.
                ToolbarItem(placement: .topBarTrailing) {
                    launchButton("Plan first", systemImage: "doc.text") { submit(start: false) }
                        .disabled(!canSubmit(view))
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .confirmationAction) {
                    launchButton("Start session", systemImage: "paperplane.fill") { submit(start: true) }
                        .primaryToolbarItem(c)
                        .disabled(!canSubmit(view))
                }
            }
            .trackingBranches(branches, for: view)
            // An alert, not an action sheet: iOS 26 drops an action sheet's cancel button, and
            // "Keep editing" has to stay a choice.
            .alert("Save this draft?", isPresented: $askingCancel) {
                Button("Save draft") { saveAndClose() }
                Button("Discard draft", role: .destructive) { discardAndClose() }
                Button("Keep editing", role: .cancel) {}
            }
            .alert("Add project", isPresented: $adding) {
                TextField("/Users/you/Sites/app", text: $newPath)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.mono(14))
                Button("Cancel", role: .cancel) {}
                Button("Add") { addProject() }
            } message: {
                Text("The folder's absolute path on the Mac, e.g. /Users/you/Sites/app")
            }
            // Start the editor once the store has what it needs: the reopened draft, or a project.
            .onChange(of: BeginInputs(state: state, reopen: reopen, projectId: projectId, prefs: app.prefs), initial: true) { begin() }
            // The store's copy of the saved draft: launched or discarded elsewhere.
            .onChange(of: SavedInputs(state: state, savedId: editor?.savedId), initial: true) { storeChanged() }
            .onChange(of: attention(view), initial: true) { _, needs in
                // Options start collapsed, and open by themselves when the branch pick needs a look.
                if needs { optionsOpen = true }
            }
            .onAppear {
                // Reopening a draft: keep its key resolved while the store may not have it yet.
                if let reopen, releaseKey == nil { releaseKey = store.watchKey(reopen) }
            }
            .onDisappear {
                // Swiping the sheet down (or any other way the screen goes) saves the draft.
                editor?.screenGone()
                releaseKey?()
                releaseKey = nil
            }
    }

    /// A toolbar launch button: always just its icon. It's disabled (through canSubmit) while a
    /// launch is in flight; swapping the icon for a spinner made the toolbar show the title instead.
    private func launchButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(title, systemImage: systemImage, action: action)
            .labelStyle(.iconOnly)
            .accessibilityLabel(title)
    }

    // MARK: Content

    @ViewBuilder private func content(_ state: BoardState, _ view: Ticket?) -> some View {
        if let editor, let view {
            form(editor, view, state)
        } else if let reopen, state.ticketByKey(reopen) == nil, state.missingKeys[reopen.uppercased()] == true {
            EmptyState(icon: "alert", title: "\(reopen) not found", message: "It may have been discarded.") { EmptyView() }
        } else if state.ready && state.projects.isEmpty {
            EmptyState(icon: "folder", title: "No projects yet", message: "Add the folder a session should work in.") {
                HButton("Add a project", icon: "plus", variant: .primary, fullWidth: false) { startAdding() }
            }
        } else {
            LoadingScreen()
        }
    }

    private func form(_ editor: NewSessionEditor, _ t: Ticket, _ state: BoardState) -> some View {
        let project = state.projects[t.projectId]
        let projects = state.sortedProjects()
        let kind = t.kind
        let summary = project.map { p in
            Drafts.newSessionOptionsSummary(t, project: p, settings: state.settings.map(DraftSettings.init), labels: .init(
                driver: { Format.driverLabel($0, drivers: state.drivers) },
                checkoutName: branches.checkout(p)?.name
            ))
        } ?? []
        let needsLook = attention(t)

        return Form {
            Section {
                HStack(spacing: 8) {
                    if let project { ProjectKeyBadge(project.key, color: project.color) }
                    SelectMenu(
                        value: t.projectId,
                        options: projects.map { PickerOption(value: $0.id, label: "\($0.name) (\($0.key))") },
                        placeholder: projects.isEmpty ? "Add a project" : "Choose a project",
                        title: "Project",
                        actions: [SelectMenuAction(label: "Add a project…", systemImage: "folder.badge.plus") { startAdding() }],
                        accessibilityName: "Project"
                    ) { editor.changeProject($0) }
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .listRowBackground(c.bgElev)
                // The segmented control plays the select haptic on a change.
                Picker("Kind", selection: Binding(get: { kind }, set: { next in
                    if next != kind { haptic(.select) }
                    editor.edit(UpdateTicketBody(kind: next))
                })) {
                    Text("Task").tag(TicketKind.task)
                    Text("Conductor").tag(TicketKind.conductor)
                }
                .pickerStyle(.segmented)
                .listRowBackground(c.bgElev)
            }
            Section {
                MentionTextEditor(
                    text: Binding(get: { editor.local?.spec ?? "" }, set: { editor.setSpec($0) }),
                    placeholder: Format.newSessionPlaceholder(kind),
                    projectId: t.projectId,
                    minHeight: 150,
                    commandDriver: editor.commandDriver(state),
                    boxed: false,
                    fieldLabel: "Spec",
                    autofocus: reopen == nil
                )
                .listRowBackground(c.bgElev)
            } footer: {
                if kind == .conductor {
                    Text("Orchestrates child tickets.").font(.scaled(size: 13)).foregroundStyle(c.text3)
                }
            }
            NewSessionAttachmentsSection(editor: editor, ticket: t, uploader: uploader)
            Section {
                Button {
                    haptic(.select)
                    withAnimation(.snappy) { optionsOpen.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: optionsOpen ? "chevron.down" : "chevron.right")
                            .font(.scaled(size: 14, weight: .semibold))
                            .foregroundStyle(needsLook ? c.amber : c.text2)
                            .frame(width: 18)
                        Text(summary.isEmpty ? "Options" : summary.joined(separator: " · "))
                            .font(.scaled(size: 15))
                            .foregroundStyle(summary.isEmpty ? c.text2 : c.text)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(summary.isEmpty ? "Options" : "Options, \(summary.joined(separator: ", "))")
                .accessibilityAddTraits(.isButton)
                .accessibilityValue(optionsOpen ? "Expanded" : "Collapsed")
                .listRowBackground(c.bgElev)
                if optionsOpen {
                    TicketSettingsForm(ticket: t, branches: branches) { editor.edit($0) }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .modifier(PromptAttachmentDrop(target: editor, uploader: uploader))
        .modifier(PromptAttachmentPickers(target: editor, uploader: uploader))
    }

    // MARK: Decisions (HarnessKit's NewSessionEditor makes them; these read the live state)

    private func hint(_ t: Ticket?) -> BranchHint? {
        guard let t else { return nil }
        let state = store.state
        return branches.hint(t, project: state.projects[t.projectId], settings: state.settings)
    }

    private func attention(_ t: Ticket?) -> Bool {
        hint(t).map(Drafts.optionsNeedAttention) ?? false
    }

    private func canSubmit(_ t: Ticket?) -> Bool {
        editor?.canSubmit(store.state, hint: hint(t)) ?? false
    }

    private func begin() {
        if editor == nil {
            guard let client = store.api else { return }
            let store = store
            let toasts = toasts
            editor = NewSessionEditor(
                reopen: reopen,
                api: HarnessDraftAPI(client: client),
                state: { store.state },
                onSaved: { store.dispatch(.tickets([$0])) },
                onError: { e in
                    haptic(.error)
                    toasts.show("Couldn't save the draft: \(localizedErrorMessage(e))", kind: .error)
                }
            )
        }
        guard let editor else { return }
        if case let .redirect(key) = editor.begin(projectId: projectId, candidates: store.state.composerCandidates(app.prefs.boardProject, last: app.prefs.lastProject)) {
            router.open(.push(.ticket(key: key, tab: nil)))
        }
    }

    private func storeChanged() {
        guard let editor else { return }
        switch editor.storeChanged(store.state) {
        case .none: break
        case .discarded:
            toasts.show("This draft was discarded on another device.", kind: .info)
            dismiss()
        case let .launched(key):
            router.open(.push(.ticket(key: key, tab: nil)))
        }
    }

    private func submit(start: Bool) {
        guard let editor, canSubmit(editor.view(store.state)) else { return }
        Task {
            guard let t = await actions.run(nil, { try await editor.submit(start: start) }) else { return }
            haptic(.success)
            store.dispatch(.tickets([t]))
            app.setPref(\.lastProject, t.projectId)
            router.open(.push(.ticket(key: t.key, tab: start ? .transcript : .spec)))
        }
    }

    private func cancel() {
        guard let editor else { return dismiss() }
        switch editor.cancelStep {
        case .dismiss:
            dismiss()
        case .discardAndDismiss:
            let discarding = editor.discard()
            actions.perform { try await discarding.value }
            dismiss()
        case .ask:
            askingCancel = true
        }
    }

    private func saveAndClose() {
        guard let editor else { return dismiss() }
        let saving = editor.save()
        actions.perform { try await saving.value }
        dismiss()
    }

    private func discardAndClose() {
        guard let editor else { return dismiss() }
        let discarding = editor.discard()
        actions.perform { try await discarding.value }
        dismiss()
    }

    private func startAdding() {
        newPath = ""
        adding = true
    }

    private func addProject() {
        let path = newPath
        Task {
            guard let p = await store.addProject(path: path, actions: actions) else { return }
            // The socket's upsert may not be in yet; the editor switches only to a project it knows.
            store.dispatch(.event(.projectUpserted(project: p)))
            if let editor, editor.sync != nil { editor.changeProject(p.id) } else { begin() }
        }
    }

    /// Close this sheet, unless a link has already replaced it with another.
    private func dismiss() {
        if router.sheet == .newSession(projectId: projectId, key: reopen) { router.sheet = nil }
    }
}

/// What starting the editor depends on: the reopened ticket, or the project it would start in.
private struct BeginInputs: Equatable {
    var stored: Ticket?
    var project: String
    var hasSettings: Bool

    @MainActor
    init(state: BoardState, reopen: String?, projectId: String?, prefs: Prefs) {
        stored = reopen.flatMap { state.ticketByKey($0) }
        project = reopen == nil ? state.composerProject(projectId ?? "", candidates: state.composerCandidates(prefs.boardProject, last: prefs.lastProject)) : ""
        hasSettings = state.settings != nil
    }
}

/// What the store's copy of the saved draft looks like now.
private struct SavedInputs: Equatable {
    var ticket: Ticket?
    var ready: Bool
    var savedId: String?

    @MainActor
    init(state: BoardState, savedId: String?) {
        ticket = savedId.flatMap { state.tickets[$0] }
        ready = state.ready
        self.savedId = savedId
    }
}
