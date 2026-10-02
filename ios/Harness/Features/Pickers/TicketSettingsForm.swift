import HarnessKit
import SwiftUI

/// A ticket's settings rows, the same for a launched ticket (the Details
/// tab) and a draft (New session's Options): Model, Permissions, Skip agent review, Skip human review, Branch (with the
/// hint under it), Base branch, Remote ID (launched tickets) and Depends on. Which rows show and
/// which can change come from Drafts.ticketSettingsRows; every change goes out as one
/// UpdateTicketBody through `onPatch` (a PATCH for a launched ticket, applyTicketPatch on a draft's
/// local state).
///
/// The rows render bare, one Form row each, so the caller puts them in its own `Form` `Section`
/// (Details follows them with its read-only rows). `branches` shares the branch list with a caller
/// that also reads the hint (New session opens Options when it needs attention); that caller
/// attaches `.trackingBranches(branches, for: ticket)` itself. Without it the form keeps its own.
struct TicketSettingsForm: View {
    let ticket: Ticket
    var branches: TicketBranches?
    let onPatch: (UpdateTicketBody) -> Void

    @State private var own = TicketBranches()

    init(ticket: Ticket, branches: TicketBranches? = nil, onPatch: @escaping (UpdateTicketBody) -> Void) {
        self.ticket = ticket
        self.branches = branches
        self.onPatch = onPatch
    }

    var body: some View {
        if let branches {
            TicketSettingsRows(ticket: ticket, branches: branches, onPatch: onPatch)
        } else {
            TicketSettingsRows(ticket: ticket, branches: own, onPatch: onPatch)
                .trackingBranches(own, for: ticket)
        }
    }
}

/// What the branch rows need from the project's branch list: the branch the
/// project directory has checked out (a draft's "no worktree" pick), the branches the hint can
/// classify against, and the hint itself.
@MainActor
@Observable
final class TicketBranches {
    var branches = TicketBranchList()

    /// The project directory's branch, from the list.
    func checkout(_ project: Project?) -> BranchInfo? {
        project.flatMap { Branches.checkoutBranch(branches.list, projectPath: $0.path) }
    }

    /// The line under the Branch row.
    func hint(_ ticket: Ticket?, project: Project?, settings: PublicSettings?) -> BranchHint? {
        guard let ticket, let project else { return nil }
        return Drafts.ticketBranchHint(ticket, project: project, settings: settings.map(DraftSettings.init), known: branches.known, checkout: checkout(project))
    }

    /// The branch picked in the sheet comes with its entry, which the list may not reach (it's capped).
    func remember(_ b: BranchInfo?) { branches.remember(b) }

    /// The branch-listing project for a ticket: none outside git.
    static func projectId(_ project: Project?) -> String {
        guard let project, project.isGit != false else { return "" }
        return project.id
    }

    fileprivate func load(_ client: (any PickerClient)?, projectId: String) async {
        branches = TicketBranchList()
        guard !projectId.isEmpty, let client else { return }
        if let list = try? await client.projectBranches(projectId, q: nil, limit: nil), !Task.isCancelled {
            branches.list = list
        }
    }

    fileprivate func lookUp(_ client: (any PickerClient)?, projectId: String, requested: String?) async {
        guard !projectId.isEmpty, let client, let requested, branches.needsLookup(requested) else { return }
        if let list = try? await client.projectBranches(projectId, q: requested, limit: nil), !Task.isCancelled {
            branches.found(list, for: requested)
        }
    }
}

extension View {
    /// Keeps `branches` filled for `ticket`'s project: the list on appear and on every reconnect,
    /// and a lookup for a requested branch the list doesn't have.
    func trackingBranches(_ branches: TicketBranches, for ticket: Ticket?) -> some View {
        modifier(TrackBranches(branches: branches, ticket: ticket))
    }
}

private struct TrackBranches: ViewModifier {
    let branches: TicketBranches
    let ticket: Ticket?

    @Environment(BoardStore.self) private var store

    func body(content: Content) -> some View {
        let projectId = TicketBranches.projectId(ticket.flatMap { store.state.projects[$0.projectId] })
        let requested = ticket?.requestedBranch.optional
        let listed = !branches.branches.needsLookup(requested)
        content
            .task(id: "\(projectId)#\(store.epoch)") { await branches.load(store.pickerClient, projectId: projectId) }
            .task(id: "\(projectId)#\(requested ?? "")#\(listed)") {
                if !listed { await branches.lookUp(store.pickerClient, projectId: projectId, requested: requested) }
            }
    }
}

/// The rows themselves.
private struct TicketSettingsRows: View {
    let ticket: Ticket
    let branches: TicketBranches
    let onPatch: (UpdateTicketBody) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c

    var body: some View {
        let state = store.state
        let project = state.projects[ticket.projectId]
        let settings = state.settings
        let modelProject = project.map(ModelProject.init)
        let modelSettings = settings.map(ModelSettings.init)
        let rows = Drafts.ticketSettingsRows(ticket, project: project)
        let hints = PickerLogic.ticketSettingsHints(ticket, rows: rows)
        let draft = ticket.draft == true
        let base = Branches.resolveBaseBranch(ticket: ticket, project: project, settingsBaseBranch: settings?.baseBranch).branch
        let inheritedBase = Branches.resolveBaseBranch(ticket: nil, project: project, settingsBaseBranch: settings?.baseBranch)
        let checkout = branches.checkout(project)

        TicketSettingsRow(label: "Model", hint: hints.model) {
            DriverModelPicker(
                value: Models.ticketChoice(ticket, modelProject, modelSettings),
                resolved: Models.ticketResolvedChoice(modelProject, modelSettings),
                onlyDriver: rows.onlyDriver,
                disabled: !rows.editable,
                inheritedModel: { Models.inheritedModel($0, level: .ticket, project: modelProject, settings: modelSettings) }
            ) { onPatch(Models.ticketChoicePatch($0, modelProject, modelSettings)) }
        }
        TicketSettingsRow(label: "Permissions", hint: hints.permissions) {
            PermissionPicker(
                value: ticket.permissionMode,
                inherited: Permissions.resolvePermissionMode(ticket: nil, project: project, settings: settings?.permissionMode ?? .auto).mode,
                disabled: !rows.editable
            ) { onPatch(UpdateTicketBody(permissionMode: Patch($0))) }
        }
        TicketSettingsRow(label: "Skip agent review", hint: rows.editable ? NewSession.skipReviewHint(ticket) : nil) {
            Toggle("Skip agent review", isOn: Binding(get: { ticket.skipAgentReview == true }, set: { onPatch(UpdateTicketBody(skipAgentReview: $0)) }))
                .labelsHidden()
                .tint(c.accent)
                .disabled(!rows.editable)
        }
        TicketSettingsRow(label: "Skip human review", hint: rows.editable ? NewSession.skipHumanReviewHint(ticket) : nil) {
            Toggle("Skip human review", isOn: Binding(get: { ticket.skipHumanReview == true }, set: { onPatch(UpdateTicketBody(skipHumanReview: $0)) }))
                .labelsHidden()
                .tint(c.accent)
                .disabled(!rows.editable)
        }
        if rows.branch.show, let project {
            let hint = rows.branch.editable ? branches.hint(ticket, project: project, settings: settings) : nil
            TicketSettingsRow(label: "Branch", hint: hints.branch) {
                if rows.branch.editable {
                    if draft {
                        BranchPicker(
                            projectId: project.id,
                            value: Drafts.draftBranchValue(ticket, project: project, checkout: checkout),
                            defaultLabel: Drafts.draftDefaultBranchLabel(key: ticket.key, project: project, checkout: checkout),
                            newLabel: { "Create \($0) from \(base)" }
                        ) { name, info in
                            branches.remember(info)
                            onPatch(Drafts.draftBranchPatch(Drafts.draftBranchPick(name, checkout: checkout), project: project))
                        }
                    } else {
                        BranchPicker(
                            projectId: project.id,
                            value: ticket.requestedBranch.optional,
                            defaultLabel: Branches.newTicketBranchLabel(ticket.key),
                            newLabel: { "Create \($0) from \(base)" }
                        ) { name, info in
                            branches.remember(info)
                            onPatch(UpdateTicketBody(branch: Patch(name)))
                        }
                    }
                } else {
                    Text(Branches.plannedBranch(ticket)).font(.mono(12.5)).foregroundStyle(c.text).textSelection(.enabled)
                }
            } footer: {
                if let hint {
                    Text(hint.text)
                        .font(.scaled(size: 13))
                        .foregroundStyle(hint.tone == .warn ? c.amber : hint.tone == .error ? c.red : c.text3)
                }
            }
        }
        if rows.base.show, let project {
            TicketSettingsRow(label: "Base branch", hint: hints.base) {
                if rows.base.editable {
                    BranchPicker(
                        projectId: project.id,
                        value: ticket.baseBranch.optional,
                        defaultLabel: Branches.inheritedBaseLabel(inheritedBase),
                        newLabel: { "Merge into \($0)" },
                        title: "Base branch"
                    ) { name, _ in onPatch(UpdateTicketBody(baseBranch: Patch(name))) }
                } else {
                    let set = ticket.baseBranch.optional?.nilIfEmpty
                    Text(set ?? Branches.inheritedBaseLabel(inheritedBase))
                        .font(.mono(12.5))
                        .foregroundStyle(set != nil ? c.text : c.text3)
                        .textSelection(.enabled)
                }
            }
        }
        if !draft { TicketRemoteIdRow(ticket: ticket, onPatch: onPatch) }
        TicketDependsOnRow(ticket: ticket, project: project, editable: rows.editable, onPatch: onPatch)
    }
}

/// One settings row: the label with its hint under it, the control on the right, and
/// an optional footer across the row.
struct TicketSettingsRow<Control: View, Footer: View>: View {
    let label: String
    var hint: String?
    @ViewBuilder var control: Control
    @ViewBuilder var footer: Footer

    @Environment(\.palette) private var c

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.scaled(size: 15)).foregroundStyle(c.text)
                    if let hint { Text(hint).font(.scaled(size: 12.5)).foregroundStyle(c.text3) }
                }
                .layoutPriority(1)
                Spacer(minLength: 8)
                control
            }
            footer.frame(maxWidth: .infinity, alignment: .leading)
        }
        .listRowBackground(c.bgElev)
    }
}

extension TicketSettingsRow where Footer == EmptyView {
    init(label: String, hint: String? = nil, @ViewBuilder control: () -> Control) {
        self.init(label: label, hint: hint, control: control, footer: { EmptyView() })
    }
}

/// Depends on: ticket keys typed comma- or space-separated, saved on blur / return; chips open them.
private struct TicketDependsOnRow: View {
    let ticket: Ticket
    let project: Project?
    let editable: Bool
    let onPatch: (UpdateTicketBody) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @State private var text = ""
    @State private var latest = PickerLatest<(Ticket, (UpdateTicketBody) -> Void)>()
    @FocusState private var focused: Bool

    var body: some View {
        let _ = latest.set((ticket, onPatch))
        let bad = PickerLogic.parseDependsOn(text).bad
        let deps = store.state.dependencyStates(ticket)
        let example = project?.key ?? "WEB"
        TicketSettingsRow(label: "Depends on") {
            if editable {
                TextField("", text: $text, prompt: Text("e.g. \(example)-3, \(example)-4").foregroundStyle(c.text3))
                    .font(.mono(13.5))
                    .foregroundStyle(c.text)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($focused)
                    .frame(minWidth: 160)
                    .onSubmit(save)
                    .onChange(of: focused) { _, now in if !now { save() } }
                    .accessibilityLabel("Depends on")
            } else {
                Text(ticket.dependsOn.isEmpty ? "None" : ticket.dependsOn.joined(separator: ", "))
                    .font(.mono(13.5))
                    .foregroundStyle(ticket.dependsOn.isEmpty ? c.text3 : c.text)
                    .textSelection(.enabled)
            }
        } footer: {
            if !bad.isEmpty {
                Text("Not a ticket key: \(bad.joined(separator: ", "))").font(.scaled(size: 13)).foregroundStyle(c.red)
            } else if !deps.isEmpty {
                // The chips wrap and pack to the right.
                FlowLayout(spacing: 6, alignment: .trailing) {
                    ForEach(deps, id: \.key) { d in
                        let opens = Related.depOpens(key: d.key, missing: d.missing, byRemoteKey: store.related.byRemoteKey)
                        DepChip(label: d.ticket.map(Keys.keyLabel) ?? d.key, done: d.done, unknown: d.state == .unknown,
                                onTap: opens ? { router.push(.ticket(key: d.ticket?.key ?? d.key, tab: nil)) } : nil)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .onAppear { text = ticket.dependsOn.joined(separator: ", ") }
        .onChange(of: ticket.dependsOn) { _, v in text = v.joined(separator: ", ") }
    }

    private func save() {
        guard let (ticket, onPatch) = latest.value else { return }
        if let keys = PickerLogic.dependsOnSave(text, current: ticket.dependsOn) { onPatch(UpdateTicketBody(dependsOn: keys)) }
    }
}

/// Remote ID: the remote item (a Jira issue, a PR) the ticket is linked to, shown in place of its
/// key (DESIGN.md "Remote IDs"). Key and optional link, saved together on blur / return as a
/// manual link; clearing the key or Unlink removes it.
private struct TicketRemoteIdRow: View {
    let ticket: Ticket
    let onPatch: (UpdateTicketBody) -> Void

    @Environment(\.palette) private var c
    @State private var key = ""
    @State private var url = ""
    @State private var error: String?
    @State private var latest = PickerLatest<(Ticket, (UpdateTicketBody) -> Void)>()
    @FocusState private var focus: Field?

    private enum Field { case key, url }

    var body: some View {
        let _ = latest.set((ticket, onPatch))
        let ref = ticket.externalRef
        TicketSettingsRow(label: "Remote ID", hint: "Shown in place of the key") {
            TextField("", text: $key, prompt: Text("e.g. JIRA-62").foregroundStyle(c.text3))
                .font(.mono(13.5))
                .foregroundStyle(c.text)
                .multilineTextAlignment(.trailing)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(!url.isEmpty || key.isEmpty ? .done : .next)
                .focused($focus, equals: .key)
                .frame(minWidth: 160)
                .onSubmit { if !url.isEmpty || key.isEmpty { save() } else { focus = .url } }
                .accessibilityLabel("Remote ID")
        } footer: {
            VStack(alignment: .trailing, spacing: 6) {
                TextField("", text: $url, prompt: Text("Link (optional), e.g. https://…").foregroundStyle(c.text3))
                    .font(.scaled(size: 13.5))
                    .foregroundStyle(c.text)
                    .multilineTextAlignment(.trailing)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($focus, equals: .url)
                    .onSubmit(save)
                    .accessibilityLabel("Remote ID link")
                if let error { Text(error).font(.scaled(size: 13)).foregroundStyle(c.red) }
                if let ref {
                    HButton("Unlink \(ref.key)", icon: "x", variant: .ghost, small: true, fullWidth: false) { onPatch(UpdateTicketBody(externalRef: .null)) }
                }
            }
        }
        .onAppear(perform: reset)
        .onChange(of: ref?.key) { reset() }
        .onChange(of: ref?.url) { reset() }
        // Blur from either field saves; moving between the two saves too.
        .onChange(of: focus) { old, _ in if old != nil { save() } }
    }

    private func reset() {
        key = ticket.externalRef?.key ?? ""
        url = ticket.externalRef?.url ?? ""
        error = nil
    }

    private func save() {
        guard let (ticket, onPatch) = latest.value else { return }
        let ref = ticket.externalRef
        guard let patch = Related.remoteIdPatch(current: ref.map { (key: $0.key, url: $0.url) }, key: key, url: url) else {
            error = nil
            return
        }
        if case let .error(message) = patch {
            error = message
            return
        }
        error = nil
        if let body = PickerLogic.remoteIdBody(patch) { onPatch(body) }
    }
}
