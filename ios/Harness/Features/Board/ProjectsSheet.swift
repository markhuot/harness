import HarnessKit
import SwiftUI

/// The desktop sidebar on a phone: ProjectsSidebar, presented with medium/large detents by the
/// shell, which closes it by its grabber (no Cancel button). A row's link closes it.
struct ProjectsSheet: View {
    var body: some View { ProjectsSidebar() }
}

/// The desktop sidebar, and how the app moves between its sections: Inbox, All projects, each
/// project group's board (alphabetically, under All projects), and each project with its open
/// count and a settings gear (pick one to filter the board), and Settings at
/// the bottom with the connection. Add a project by its path on the Mac. The phone shows it as the
/// Projects sheet; the iPad (regular width) keeps it in the split view's sidebar column
/// (`column`), where a gear pushes on the detail column's stack.
struct ProjectsSidebar: View {
    /// In the iPad's sidebar column (the desktop sidebar's background), not the phone's sheet.
    var column = false

    @Environment(BoardStore.self) private var store
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c

    @State private var adding = false
    @State private var newPath = ""

    var body: some View {
        let state = store.state
        let projects = state.sortedProjects()
        let counts = BoardScreenRules.openCounts(state.tickets.values)
        let totalOpen = counts.values.reduce(0, +)
        let groups = state.projectGroups()
        let groupCounts = BoardScreenRules.groupOpenCounts(counts, projects: projects)
        let triaging = state.triageSessions().filter { $0.triageStatus == .triaging || $0.busy }.count
        let row = SidebarRow.current(tab: router.selectedTab, board: state.boardFilter(app.prefs.boardProject))
        let bg = column ? c.bgSidebar : c.bg

        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Card {
                    ProjectsNavRow(icon: "inbox", label: "Inbox", badge: triaging, active: row == .inbox) {
                        select(.inbox)
                    }
                    Divider().overlay(c.border)
                    ProjectsNavRow(icon: "layers", label: "All projects", count: totalOpen, active: row == .allProjects) {
                        select(.allProjects)
                    }
                    // Each group's board, like All projects with only its projects.
                    ForEach(groups, id: \.self) { g in
                        Divider().overlay(c.border)
                        ProjectsNavRow(icon: "folder", label: g, count: groupCounts[g] ?? 0, active: row == .group(g)) {
                            select(.group(g))
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        SectionTitle("Projects")
                        Spacer()
                        Button { startAdding() } label: {
                            Icon("plus", size: 18, weight: .semibold).foregroundStyle(c.accent).frame(width: 34, height: 28)
                        }
                        .accessibilityLabel("Add project")
                    }
                    .padding(.horizontal, 4)
                    Card {
                        ForEach(Array(projects.enumerated()), id: \.element.id) { i, p in
                            if i > 0 { Divider().overlay(c.border) }
                            projectRow(p, count: counts[p.id] ?? 0, active: row == .project(p.id))
                        }
                        if projects.isEmpty {
                            Button { startAdding() } label: {
                                HStack(spacing: 10) {
                                    Icon("folder", size: 16).foregroundStyle(c.accent)
                                    Text("Add a project folder…").font(.scaled(size: 16)).foregroundStyle(c.accent)
                                    Spacer()
                                }
                                .padding(.horizontal, 14)
                                .frame(minHeight: 50)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(16)
        }
        // Settings and the connection stay at the bottom while the projects scroll.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Card {
                    ProjectsNavRow(icon: "settings", label: "Settings", active: row == .settings) {
                        select(.settings)
                    }
                }
                HStack(spacing: 8) {
                    Circle().fill(state.connected ? c.green : c.amber).frame(width: 8, height: 8).accessibilityHidden(true)
                    Text(state.connected ? "Connected" : "Reconnecting…").font(.scaled(size: 13)).foregroundStyle(c.text2)
                    Spacer()
                    Text(MobilePair.displayHost(store.baseUrl)).font(.mono(12)).foregroundStyle(c.text3).lineLimit(1)
                }
                .padding(.horizontal, 4)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(bg)
        }
        .background(bg)
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
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
    }

    private func projectRow(_ p: Project, count: Int, active: Bool) -> some View {
        HStack(spacing: 0) {
            Button { select(.project(p.id)) } label: {
                HStack(spacing: 10) {
                    ProjectKeyBadge(p.key, color: p.color)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(p.name).font(.scaled(size: 16)).foregroundStyle(c.text).lineLimit(1)
                        Text(Format.tildify(p.path)).font(.mono(12)).foregroundStyle(c.text3).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    if count > 0 { Text("\(count)").font(.scaled(size: 14)).monospacedDigit().foregroundStyle(c.text3) }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(p.name)
            .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
            Button {
                router.sheet = nil
                router.push(.project(id: p.id))
            } label: {
                Icon("settings", size: 17).foregroundStyle(c.text3).frame(width: 40, height: 40).contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(p.name) settings")
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .frame(minHeight: 50)
        .background(active ? c.accentSoft : .clear)
    }

    /// Show a row's section at its root (a board row filters it first); the link closes the sheet.
    private func select(_ row: SidebarRow) {
        haptic(.select)
        router.select(row, app: app)
    }

    private func startAdding() {
        newPath = ""
        adding = true
    }

    private func addProject() {
        let path = newPath
        Task {
            if let p = await store.addProject(path: path, actions: actions) { select(.project(p.id)) }
        }
    }
}

/// An Inbox / All projects / project group row: icon, label, and the open count or an amber badge.
private struct ProjectsNavRow: View {
    let icon: String
    let label: String
    var count = 0
    var badge = 0
    var active = false
    let action: () -> Void
    @Environment(\.palette) private var c

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Icon(icon, size: 18).foregroundStyle(active ? c.accentText : c.text2)
                Text(label).font(.scaled(size: 16)).foregroundStyle(c.text).lineLimit(1)
                Spacer()
                if badge > 0 {
                    Text("\(badge)")
                        .font(.scaled(size: 12, weight: .bold))
                        .foregroundStyle(c.onAmber)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(c.amber, in: .capsule)
                } else if count > 0 {
                    Text("\(count)").font(.scaled(size: 14)).monospacedDigit().foregroundStyle(c.text3)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .background(active ? c.accentSoft : .clear)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}
