#if DEBUG
import HarnessKit
import SwiftUI

/// DEBUG: every picker and form control against the paired service, before the screens that host
/// them exist. Opens with `-debugScreen pickers` (dev-sim's seeded GREET project has real branches
/// and the dummy driver's models). `-debugSection <name>` scrolls to one section: selects, model,
/// branch, color, mentions, settings, draft.
struct PickerGalleryView: View {
    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @AppStorage("debugSection") private var section = ""

    @State private var model: String?
    @State private var permission: PermissionMode?
    @State private var choice = Watchers.defaultTriageChoice
    @State private var branch: String?
    @State private var color: String? = "blue"
    @State private var prompt = ""
    @State private var message = ""
    @State private var draft: Ticket?

    var body: some View {
        let project = store.state.projects.values.sorted { $0.key < $1.key }.first { $0.isGit != false }
        let ticket = project.flatMap { p in store.state.tickets.values.filter { $0.projectId == p.id && $0.status == .planning && $0.draft != true }.sorted { $0.key < $1.key }.first }
        ScrollViewReader { proxy in
            Form {
                Section("Selects") {
                    TicketSettingsRow(label: "Model") { ModelPicker(driver: "dummy", value: model, inherited: nil) { model = $0 } }
                    TicketSettingsRow(label: "Permissions") { PermissionPicker(value: permission, inherited: .ask) { permission = $0 } }
                    TicketSettingsRow(label: "Disabled") { PermissionPicker(value: .readOnly, inherited: .ask, disabled: true) { _ in } }
                }
                .id("selects")
                Section("Driver + model") {
                    TicketSettingsRow(label: "Default model") {
                        DriverModelPicker(value: choice, resolved: .init(driver: "dummy", model: nil), title: "Default model") { choice = $0 }
                    }
                    TicketSettingsRow(label: "Only dummy") {
                        DriverModelPicker(value: choice, resolved: .init(driver: "dummy", model: nil), onlyDriver: "dummy") { choice = $0 }
                    }
                }
                .id("model")
                if let project {
                    Section("Branch · \(project.key)") {
                        TicketSettingsRow(label: "Branch") {
                            BranchPicker(projectId: project.id, value: branch, defaultLabel: Branches.newTicketBranchLabel("\(project.key)-99"), newLabel: { "Create \($0) from main" }) { name, _ in branch = name }
                        }
                    }
                    .id("branch")
                }
                Section("Project color") {
                    ProjectColorPicker(value: color) { color = $0 }
                    Text("Stored \(color ?? "nil")").foregroundStyle(c.text2)
                }
                .id("color")
                if let project {
                    Section("Mentions · \(project.key)") {
                        MentionTextEditor(text: $prompt, placeholder: "Prompt", projectId: project.id, minHeight: 90)
                    }
                    .id("mentions")
                }
                if let ticket {
                    Section("Ticket settings · \(ticket.key)") {
                        TicketSettingsForm(ticket: ticket) { patch in
                            actions.perform {
                                guard let client = store.api else { return }
                                _ = try await client.updateTicket(ticket.key, patch)
                            }
                        }
                    }
                    .id("settings")
                }
                if let draft {
                    Section("Draft settings · \(draft.key)") {
                        TicketSettingsForm(ticket: draft) { patch in self.draft = Drafts.applyTicketPatch(draft, patch) }
                    }
                    .id("draft")
                }
            }
            .scrollContentBackground(.hidden)
            .background(c.bg)
            .navigationTitle("Pickers")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                if let ticket {
                    MentionTextEditor(text: $message, placeholder: "Message the agent…", ticketKey: ticket.key, minHeight: 0, maxLines: 6, suggestionsEdge: .top, suggestionsMaxHeight: 200)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(c.bg)
                }
            }
            .task(id: project?.id) {
                if draft == nil, let project {
                    draft = Drafts.blankDraftTicket(project: project, settings: store.state.settings.map(DraftSettings.init), key: Branches.predictedTicketKey(project))
                }
            }
            .task(id: "\(section)#\(store.state.tickets.count)") {
                guard !section.isEmpty else { return }
                try? await Task.sleep(for: .milliseconds(300))
                proxy.scrollTo(section, anchor: .top)
            }
        }
    }
}
#endif
