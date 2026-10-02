import HarnessKit
import SwiftUI

/// A ticket's screen (screens/TicketDetail.tsx): the header menu, the hero (crumb, title, badges,
/// approval card, actions), the tab strip and tab bodies, and the message composer. `key` may be
/// an old key (from before a project rename), which it follows, or a remote ID, which lists the
/// tickets sharing it (harness://ticket/JIRA-62). `initialTab` is the link's `?tab=`, already
/// checked with Tabs.isTicketTab; nil opens Summaries, or the Transcript when the ticket turns out
/// to have no summaries.
struct TicketDetailScreen: View {
    let key: String
    let initialTab: TicketTab?

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    /// The ticket's current key once the detail said the link's key was an old one.
    @State private var renamedTo: String?
    @State private var missing = false
    @State private var tab: TicketTab
    /// Whether the tab is settled: a linked tab, a pick, or the one-time switch to the Transcript.
    @State private var opened: Bool
    @State private var pluginTabs: [PluginTab]?
    @State private var hero = TicketDetailHeroCollapse()

    init(key: String, initialTab: TicketTab?) {
        self.key = key
        self.initialTab = initialTab
        _tab = State(initialValue: initialTab ?? .summaries)
        _opened = State(initialValue: initialTab != nil)
    }

    private var ticketKey: String { renamedTo ?? key }

    /// What has to change for the detail to load again: another key, a reconnect, or the detail's
    /// extras (dependents, children) gone after a snapshot.
    private struct LoadTrigger: Hashable {
        let key: String
        let epoch: Int
        let hasDetail: Bool
    }

    var body: some View {
        let state = store.state
        let ticket = state.ticketByKey(ticketKey)
        let hasDetail = ticket.map { state.dependents[$0.id] != nil } ?? false
        Group {
            if missing, ticket == nil, let related = store.related.byRemoteKey[ticketKey.uppercased()], !related.isEmpty {
                TicketDetailRemoteIdView(remoteKey: ticketKey.uppercased(), related: related) { replaceSelf(with: $0) }
            } else if let ticket, ticket.draft != true {
                TicketDetailBody(ticket: ticket, tab: tab, pluginTabs: pluginTabs, hero: hero) { pick($0) }
            } else {
                Group {
                    if missing {
                        EmptyState(icon: "alert", title: "\(ticketKey) not found", message: "It may have been deleted.")
                    } else {
                        Spinner()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle(ticketKey)
                .navigationBarTitleDisplayMode(.inline)
            }
        }
        .background(c.bg)
        // RN's ticket screen covers the tabs: the composer sits at the bottom edge.
        .toolbar(.hidden, for: .tabBar)
        .fileLinkScope(ticketKey: ticket?.key ?? ticketKey)
        .pluginTabs(for: ticket, into: $pluginTabs)
        // Done tickets page in: an older one may drop out of the store on a refetch; keep it resolved.
        .task(id: ticketKey) {
            let release = store.watchKey(ticketKey)
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
            release()
        }
        .task(id: LoadTrigger(key: ticketKey, epoch: store.epoch, hasDetail: hasDetail)) {
            guard !hasDetail else { return }
            do {
                let detail = try await store.loadDetail(ticketKey)
                // An old key (from before a project rename) resolves to the current key; follow it.
                if detail.ticket.key != ticketKey { renamedTo = detail.ticket.key }
            } catch is CancellationError {
            } catch {
                if !Task.isCancelled { missing = true }
            }
        }
        // A draft hasn't launched: it opens in the New session editor instead.
        .onChange(of: ticket?.draft == true, initial: true) { _, draft in
            if draft { openDraft() }
        }
        // Without a tab in the link, a ticket with no summaries opens on the Transcript instead.
        // Decided once, when its summaries first load; picking a tab before then settles it.
        .onChange(of: ticket.flatMap { state.summaries[$0.sessionId]?.count }, initial: true) { _, count in
            guard !opened, let t = Tabs.openingTab(summaryCount: count) else { return }
            opened = true
            tab = t
        }
        // News that needs a look brings the hero back.
        .onChange(of: ticket?.status) { hero.show() }
        .onChange(of: ticket?.pendingApproval?.id) { hero.show() }
    }

    private func pick(_ t: TicketTab) {
        hero.show()
        opened = true
        tab = t
    }

    /// This screen's place on the stack (the last ticket route with the link's key).
    private func ownIndex(_ path: [Route]) -> Int? {
        path.lastIndex { if case let .ticket(k, _) = $0 { k == key } else { false } }
    }

    private func openDraft() {
        let tab = router.selectedTab
        var path = router.path(tab)
        if let i = ownIndex(path) { path.remove(at: i) }
        router.setPath(tab, path)
        router.present(.newSession(projectId: nil, key: ticketKey))
    }

    private func replaceSelf(with key: String) {
        let tab = router.selectedTab
        var path = router.path(tab)
        if let i = ownIndex(path) {
            path[i] = .ticket(key: key, tab: nil)
            router.setPath(tab, path)
        } else {
            router.push(.ticket(key: key, tab: nil))
        }
    }
}

/// The loaded ticket: header, hero, tabs and composer.
private struct TicketDetailBody: View {
    let ticket: Ticket
    let tab: TicketTab
    let pluginTabs: [PluginTab]?
    let hero: TicketDetailHeroCollapse
    let onTab: (TicketTab) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @State private var height: CGFloat = 800

    var body: some View {
        let state = store.state
        let shown = ChangesTab.effectiveTab(tab, conductor: ticket.isConductor, workdir: ticket.workdir, pluginTabs: pluginTabs, subagents: state.subagentsOf(ticket.sessionId))
        let agent = Tabs.parseSubagentTab(shown)
        let plugin = Tabs.parsePluginTab(shown)
        let compact = shown == .browser || shown == .changes || plugin != nil || agent != nil
        VStack(spacing: 0) {
            TicketDetailHero(ticket: ticket, compactTab: compact, maxHeight: height * 0.45)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { hero.measured($0) }
                .frame(height: hero.hidden ? 0 : nil, alignment: .top)
                .clipped()
                .accessibilityHidden(hero.hidden)
            TicketDetailTabStrip(ticket: ticket, tab: shown, pluginTabs: pluginTabs) { t in
                hero.show()
                onTab(t)
            }
            tabBody(shown, agent: agent, plugin: plugin)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .environment(\.ticketDetailHero, hero)
                .environment(\.ticketDetailOpenTab, TicketDetailTabOpener { t in
                    hero.show()
                    onTab(t)
                })
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            TicketDetailComposer(ticket: ticket).id(ticket.id)
        }
        .modifier(TicketDetailHeader(ticket: ticket))
    }

    @ViewBuilder private func tabBody(_ shown: TicketTab, agent: String?, plugin: Tabs.ParsedPluginTab?) -> some View {
        if let agent {
            SubagentView(ticket: ticket, subagentId: agent).id(agent)
        } else if shown == .changes {
            ChangesTabView(ticket: ticket).id(ticket.key)
        } else if let plugin {
            if let pluginTabs {
                if let active = pluginTabs.first(where: { $0.pluginId == plugin.pluginId && $0.id == plugin.tabId }) {
                    PluginTabView(ticket: ticket, tab: active).id("\(ticket.key)/\(shown.rawValue)")
                }
            } else {
                Spinner().padding(30).frame(maxHeight: .infinity, alignment: .top)
            }
        } else {
            switch shown.builtin {
            case .children: TicketDetailChildrenTab(ticket: ticket)
            case .transcript: TranscriptView(sessionId: ticket.sessionId)
            case .agents: AgentsTabView(ticket: ticket)
            case .browser: BrowserTabView(ticket: ticket)
            case .details: TicketDetailDetailsTab(ticket: ticket)
            default: TicketDetailSummariesTab(ticket: ticket)
            }
        }
    }
}

/// The navigation bar: the key (the remote ID first when linked) and the More menu.
private struct TicketDetailHeader: ViewModifier {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(\.openURL) private var openURL
    @State private var confirm: Confirmation?

    func body(content: Content) -> some View {
        let label = Keys.keyLabel(ticket)
        content
            .navigationTitle(label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    if Keys.secondaryKey(ticket) != nil {
                        TicketKeyLabel(ticket: ticket, size: 17, color: c.text).fontWeight(.semibold)
                    } else {
                        Text(label).font(.mono(17, weight: .semibold)).foregroundStyle(c.text)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { menu(label) }
            }
            .confirmation($confirm)
    }

    private func menu(_ label: String) -> some View {
        let key = ticket.key
        let api = store.api
        return Menu {
            Button("Copy key", systemImage: "number") { UIPasteboard.general.string = key }
            if let ref = ticket.externalRef, let url = ref.url.flatMap(URL.init(string:)) {
                Button("Open \(ref.key)", systemImage: "arrow.up.right.square") { openURL(url) }
            }
            if ticket.busy {
                Button("Cancel run", systemImage: "stop.circle", role: .destructive) {
                    guard let api else { return }
                    actions.perform("Run cancelled") { _ = try await api.cancelTicket(key) }
                }
            }
            if let url = ticket.pullRequestUrl.optional.flatMap(URL.init(string:)) {
                Button("Open pull request", systemImage: "arrow.triangle.pull") { openURL(url) }
            }
            // In review, the Approve menu's "Approve and take no action" does this (and records the approval).
            if TicketDetailLogic.offersMarkDone(ticket) {
                Button("Mark done", systemImage: "checkmark.circle") {
                    guard let api else { return }
                    actions.perform("\(label) marked done") { _ = try await api.completeTicket(key, CompleteBody(skipAgent: true)) }
                }
            }
            Button("Delete ticket", systemImage: "trash", role: .destructive) {
                confirm = Confirmation(title: "Delete \(label)?", message: "Its transcript and summaries are removed too.", action: "Delete") {
                    guard let api else { return }
                    Task {
                        if await actions.run("\(label) deleted", { try await api.deleteTicket(key) }) != nil { pop(key) }
                    }
                }
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
    }

    /// Back off the deleted ticket's screen (RN `router.back()`).
    private func pop(_ key: String) {
        let tab = router.selectedTab
        var path = router.path(tab)
        guard let i = path.lastIndex(where: {
            if case let .ticket(k, _) = $0 { k.uppercased() == key.uppercased() || store.state.ticketByKey(k) == nil } else { false }
        }) else { return }
        path.remove(at: i)
        router.setPath(tab, path)
    }
}

/// A key that is only a remote ID: the tickets linked to it, to open one.
private struct TicketDetailRemoteIdView: View {
    let remoteKey: String
    let related: [RelatedTicket]
    let onOpen: (String) -> Void

    @Environment(\.palette) private var c

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                EmptyState(icon: "link", title: "Remote ID \(remoteKey)", message: TicketDetailLogic.remoteIdCount(related.count))
                Card { RelatedTicketRows(related: related, onOpen: onOpen) }
            }
            .padding(14)
            .padding(.top, 14)
        }
        .navigationTitle(remoteKey)
        .navigationBarTitleDisplayMode(.inline)
    }
}
