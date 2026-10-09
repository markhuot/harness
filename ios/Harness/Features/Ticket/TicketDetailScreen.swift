import HarnessKit
import SwiftUI

/// A ticket's screen: the header menu, the hero (crumb, title, badges,
/// approval card, actions), the tab strip and tab bodies, and the message composer. `key` may be
/// an old key (from before a project rename), which it follows, or a remote ID, which lists the
/// tickets sharing it (harness://ticket/JIRA-62). `initialTab` is the link's `?tab=`, already
/// checked with ChangesTab.ticketTabFrom (an old "summaries" link is the Spec); nil opens the Spec
/// (Tabs.openingTab). `pinned` is the pinned window (iPad) showing only one of its tabs, or the
/// composer: the hero collapses to its title line and there's no tab strip, pager or composer.
struct TicketDetailScreen: View {
    let key: String
    let initialTab: TicketTab?
    var pinned: TicketWindowValue?

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    /// The ticket's current key once the detail said the link's key was an old one.
    @State private var renamedTo: String?
    @State private var missing = false
    @State private var tab: TicketTab
    @State private var pluginTabs: [PluginTab]?
    @State private var hero: TicketDetailHeroCollapse

    init(key: String, initialTab: TicketTab?, pinned: TicketWindowValue? = nil) {
        self.key = key
        self.initialTab = initialTab
        self.pinned = pinned
        let opening = initialTab ?? Tabs.openingTab()
        _tab = State(initialValue: opening)
        _hero = State(initialValue: TicketDetailHeroCollapse(expanded: HeroDisclosure.expandedOnOpen(opening)))
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
                if let pinned, let pinnedTab = pinned.tab {
                    TicketPinnedBody(ticket: ticket, value: pinned, tab: pinnedTab, pluginTabs: pluginTabs)
                } else {
                    TicketDetailBody(ticket: ticket, tab: tab, pluginTabs: pluginTabs, hero: hero) { pick($0) }
                }
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
    }

    private func pick(_ t: TicketTab) {
        hero.moved(to: t)
        tab = t
    }

    /// Off this screen's place on the stack (the last ticket route with the link's key; a ticket
    /// window's root closes the window), into the New session editor.
    private func openDraft() {
        let draftKey = ticketKey
        router.removeTicket { $0 == key }
        // A ticket window closing on its draft hands the editor to a main window.
        if router.closeRequested {
            WindowDirectory.shared.openInMain(.sheet(.newSession(projectId: nil, key: draftKey)))
        } else {
            router.present(.newSession(projectId: nil, key: draftKey))
        }
    }

    private func replaceSelf(with newKey: String) {
        router.replaceTicket(key, with: newKey)
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
    /// Bumped to focus the composer's field (an annotated image just joined the message).
    @State private var focusComposer = 0
    @State private var uploader = PromptAttachmentUploader()
    /// Where the composer starts and the tab's page ends, on screen: the pages run on under the
    /// composer's glass, so their content gets the overlap as a bottom inset instead.
    @State private var composerTop: CGFloat = 0
    @State private var pageBottom: CGFloat = 0
    /// The annotator a tab body opened (the Browser tab's Annotate): presented here, outside the
    /// pager, so a page redrawing under it can't take it down.
    @State private var annotating: AnnotationRequest?
    /// The spec's media (the detail's attachments), refetched when a new revision may show more.
    @State private var specAttachments: [Attachment]?
    @State private var relay = TicketDetailRelay()
    @Environment(\.shortcutTargets) private var shortcutTargets

    /// What has to change for the spec's media to load again.
    private struct SpecAttachmentsTrigger: Hashable {
        let key: String
        let revision: Int?
        let epoch: Int
    }

    var body: some View {
        let state = store.state
        // The message being written (DESIGN.md "Message drafts"), saved to the ticket as it's typed.
        // Its files are here rather than in the composer, so a drop anywhere on the ticket attaches.
        let draft = store.messageDraft(for: ticket)
        let outgoing = draft.attachments
        let attachTarget: (any PromptAttachmentTarget)? = TicketDetailLogic.acceptsMessageAttachments(ticket) ? outgoing : nil
        let shown = ChangesTab.effectiveTab(tab, conductor: ticket.isConductor, workdir: ticket.workdir, pluginTabs: pluginTabs, subagents: state.subagentsOf(ticket.sessionId))
        let tornOff = WindowDirectory.shared.tornOff(ticket.key)
        let tabs = ChangesTab.visibleTabs(conductor: ticket.isConductor, workdir: ticket.workdir, subagents: state.subagentsOf(ticket.sessionId), pluginTabs: pluginTabs)
        let _ = relay.update(onTab: onTab, annotate: { annotating = $0 }, focusComposer: { focusComposer += 1 },
                             tabs: tabs, shown: shown)
        ZStack(alignment: .top) {
            // The tab strip and pager are laid out over the hero, as if it were gone, and sit below it
            // (HeroSlide, PagerSlide), sliding as it collapses or expands. No layout changes, so a
            // collapse mid-scroll re-lays out no tab body. The hero's state is read only in the hero
            // and the modifiers, so a toggle doesn't re-render this body either.
            TicketDetailHero(ticket: ticket, disclosure: hero, maxHeight: height * 0.45)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { hero.measured($0) }
            // Opaque, so they cover the hero as they slide over it. Not into the safe area: running
            // up under the bar, the strip's background would slide down over the hero.
            VStack(spacing: 0) {
                TicketDetailTabStrip(ticket: ticket, tab: shown, pluginTabs: pluginTabs, tornOff: tornOff) { t in
                    onTab(t)
                }
                .background(c.bg, ignoresSafeAreaEdges: [])
                .modifier(HeroSlide(hero: hero))
                pager(shown, tornOff: tornOff)
                    .environment(\.ticketDetailOpenTab, relay.tabOpener)
                    .environment(\.annotationSink, relay.sink(outgoing: outgoing, uploader: uploader))
                    .environment(\.openAnnotator, relay.annotatorOpener)
                    .environment(\.specAttachments, specAttachments)
                    .modifier(PagerSlide(hero: hero))
            }
            .zIndex(1)
        }
        .task(id: SpecAttachmentsTrigger(key: ticket.key, revision: ticket.specRevision, epoch: store.epoch)) {
            guard let api = store.api, let detail = try? await api.getTicket(ticket.key), !Task.isCancelled else { return }
            specAttachments = detail.attachments
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Group {
                // Torn off into a window of its own: one line to bring it back instead.
                if let window = tornOff.window(ticket.key, tab: TicketWindowValue.composer) {
                    ComposerReturnBar(value: window)
                } else {
                    VStack(spacing: 0) {
                        ComposerGrip(ticketKey: ticket.key)
                        TicketDetailComposer(ticket: ticket, tab: shown, draft: draft, uploader: uploader, focusRequest: focusComposer, onTab: onTab).id(ticket.id)
                    }
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { composerTop = $0 }
        }
        // ⇧⌘] and ⇧⌘[ step through the tabs, round the ends, as on the desktop.
        // ⇧⌘] and ⇧⌘[ (the window's WindowShortcuts) step this screen's tabs while it's the one showing.
        .onAppear { shortcutTargets?.addTabStepper(relay) { [relay] in relay.step($0) } }
        .onDisappear { shortcutTargets?.removeTabStepper(relay) }
        .modifier(PromptAttachmentDrop(target: attachTarget, uploader: uploader))
        .modifier(PromptAttachmentPickers(target: attachTarget, uploader: uploader))
        .modifier(TicketDetailHeader(ticket: ticket))
        .annotator($annotating)
    }

    /// The tab bodies side by side in strip order, a page each: a sideways swipe moves to the
    /// neighbouring tab, showing its content as it comes in. The Agents page shows the sub-agent or
    /// task open in it. Only the page on screen drives the hero, so a page coming into view (the
    /// Transcript jumping to its bottom, say) can't hide or show it.
    private func pager(_ shown: TicketTab, tornOff: TornOffTabs) -> some View {
        let strip = Tabs.tabStripTab(shown)
        var pages = ChangesTab.visibleTabs(conductor: ticket.isConductor, workdir: ticket.workdir, subagents: store.state.subagentsOf(ticket.sessionId), pluginTabs: pluginTabs)
        // A plugin tab from a link, before the ticket's plugin tabs have loaded.
        if !pages.contains(strip) { pages.append(strip) }
        let selection = Binding<TicketTab>(get: { strip }, set: { t in
            guard t != strip else { return }
            haptic(.select)
            onTab(t)
        })
        return TabView(selection: selection) {
            ForEach(pages, id: \.self) { page in
                let t = page == strip ? shown : page
                pageBody(t, strip: page, tornOff: tornOff)
                    .modifier(HeroRoom(hero: hero, overlap: max(0, pageBottom - composerTop)))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // A page's frame, not the pager's: the pager reports its frame before it reached
                    // under the composer, and a page keeps the home indicator's inset of its own.
                    // The frame includes PagerSlide's offset, so it's taken back to the layout's
                    // (the hero's height off). Readings while a slide is under way are skipped.
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { y in
                        guard page == strip, !hero.sliding else { return }
                        let laidOut = y - hero.distance
                        if pageBottom != laidOut { pageBottom = laidOut }
                    }
                    .environment(\.ticketDetailHero, page == strip ? hero : nil)
                    .background { PagerYieldsToBackSwipe(hero: hero) }
                    // Opaque, as the page slides over the hero on the pager's layer.
                    .background(c.bg)
                    .tag(page)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        // Down to the bottom of the screen, under the composer, so its glass shows the tab through
        // it (the page TabView clips its pages to its own frame).
        .ignoresSafeArea(.container, edges: .bottom)
    }

    /// A page: its tab, or Return to this window when the tab is torn off.
    @ViewBuilder private func pageBody(_ t: TicketTab, strip: TicketTab, tornOff: TornOffTabs) -> some View {
        if let window = tornOff.window(ticket.key, tab: strip) {
            TornOffPlaceholder(value: window, name: TornOffTabs.name(strip, pluginTabs: pluginTabs)) { onTab(strip) }
        } else {
            TicketTabBody(ticket: ticket, tab: t, pluginTabs: pluginTabs)
        }
    }
}

/// One tab's body (`tab` already through Tabs.effectiveTab), as the ticket screen's pager and a
/// pinned window show it. `browserTab` pins the Browser tab to one browser tab.
struct TicketTabBody: View {
    let ticket: Ticket
    let tab: TicketTab
    let pluginTabs: [PluginTab]?
    var browserTab: Int?

    @Environment(BoardStore.self) private var store

    var body: some View {
        let shown = tab
        let agent = Tabs.parseSubagentTab(shown)
        let plugin = Tabs.parsePluginTab(shown)
        if let agent {
            // A background task has output, not a conversation.
            if store.state.subagentById(ticket.sessionId, agent).map(Subagents.isTask) == true {
                TaskOutputView(ticket: ticket, subagentId: agent).id(agent)
            } else {
                SubagentView(ticket: ticket, subagentId: agent).id(agent)
            }
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
            case .browser: BrowserTabView(ticket: ticket, pinnedTab: browserTab)
            case .details: TicketDetailDetailsTab(ticket: ticket)
            case .activity: TicketDetailActivityTab(ticket: ticket)
            default: TicketDetailSpecTab(ticket: ticket)
            }
        }
    }
}

/// A pinned window's ticket (iPad): only its one tab, fully working, under the hero collapsed to
/// its title line (the approval card still shows there); or, for the composer, only the composer.
/// The Agents & tasks tab still opens a sub-agent or task in place.
private struct TicketPinnedBody: View {
    let ticket: Ticket
    let value: TicketWindowValue
    let tab: TicketTab
    let pluginTabs: [PluginTab]?

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @State private var height: CGFloat = 800
    /// A sub-agent or task the pinned Agents & tasks tab opened.
    @State private var agentTab: TicketTab?
    @State private var uploader = PromptAttachmentUploader()

    private var isComposer: Bool { tab == TicketWindowValue.composer }

    var body: some View {
        let draft = store.messageDraft(for: ticket)
        let outgoing = draft.attachments
        let attachTarget: (any PromptAttachmentTarget)? = isComposer && TicketDetailLogic.acceptsMessageAttachments(ticket) ? outgoing : nil
        VStack(spacing: 0) {
            TicketDetailHero(ticket: ticket, maxHeight: height * 0.45)
            if isComposer {
                Spacer(minLength: 0)
            } else {
                let shown = ChangesTab.effectiveTab(agentTab ?? tab, conductor: ticket.isConductor, workdir: ticket.workdir, pluginTabs: pluginTabs,
                                                    subagents: store.state.subagentsOf(ticket.sessionId))
                TicketTabBody(ticket: ticket, tab: shown, pluginTabs: pluginTabs, browserTab: value.browserTab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .environment(\.ticketDetailOpenTab, TicketDetailTabOpener { t in
                        guard tab == .agents else { return }
                        agentTab = Tabs.parseSubagentTab(t) != nil ? t : nil
                    })
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if isComposer {
                // `.transcript`: a send has no tab to move to here.
                TicketDetailComposer(ticket: ticket, tab: .transcript, draft: draft, uploader: uploader, onTab: { _ in }).id(ticket.id)
            }
        }
        .modifier(PromptAttachmentDrop(target: attachTarget, uploader: uploader))
        .modifier(PromptAttachmentPickers(target: attachTarget, uploader: uploader))
        .modifier(TicketPinnedHeader(ticket: ticket, value: value, name: TornOffTabs.name(tab, browserTab: value.browserTab, pluginTabs: pluginTabs)))
    }
}

/// A pinned window's bar: the key and what's pinned, and Return to ticket, which closes the window
/// so the tab shows in the ticket again.
private struct TicketPinnedHeader: ViewModifier {
    let ticket: Ticket
    let value: TicketWindowValue
    let name: String

    @Environment(\.palette) private var c

    func body(content: Content) -> some View {
        let label = Keys.keyLabel(ticket)
        content
            .navigationTitle("\(label) · \(name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        Text(label).font(.mono(17, weight: .semibold)).foregroundStyle(c.text)
                        Text(name).font(.scaled(size: 17)).foregroundStyle(c.text2)
                    }
                    .lineLimit(1)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(label) · \(name)")
                    .accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Return to ticket", systemImage: "arrow.down.right.and.arrow.up.left") {
                        WindowDirectory.shared.returnToTicket(value)
                    }
                }
            }
    }
}

/// Keeps a right swipe on the first tab going back, as it did before the tabs paged: the TabView's
/// paging scroll view would otherwise take it from the navigation controller's back swipe (iOS 26's,
/// from anywhere on the content). The pager's pan waits for that back swipe to fail, and a gate on the
/// pager, which won't run alongside the back swipe, begins for every swipe but a rightward one on the
/// first page: it shuts the back swipe out, so the pager pages; on the first page it stays out of the
/// way and the back swipe goes. A page's background, inside the paging scroll view; the gate only sees
/// touches on the pager, so the back swipe elsewhere is untouched. It also turns off the pager's
/// automatic safe-area insets (see `hook`) and hands the pager to the hero collapse, which slides it.
private struct PagerYieldsToBackSwipe: UIViewRepresentable {
    let hero: TicketDetailHeroCollapse

    func makeUIView(context: Context) -> Probe {
        let v = Probe()
        v.isUserInteractionEnabled = false
        v.hero = hero
        return v
    }

    func updateUIView(_ uiView: Probe, context: Context) { uiView.hero = hero }

    final class Probe: UIView {
        weak var hero: TicketDetailHeroCollapse?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            // The navigation controller is in the responder chain once the page is laid out in it.
            DispatchQueue.main.async { [weak self] in self?.hook() }
        }

        private func hook() {
            guard let pager = sequence(first: superview, next: { $0?.superview }).lazy.compactMap({ $0 as? UIScrollView }).first(where: \.isPagingEnabled)
            else { return }
            // The hero's slide runs on the pager's layer.
            hero?.pager = pager
            // While the hero shows, the pager sits lower than its layout (PagerSlide) and runs past
            // the screen's bottom safe area; UIKit would inset it for that, which lets the whole
            // page scroll up and down by the inset once a tab body reaches its end.
            if pager.contentInsetAdjustmentBehavior != .never {
                pager.contentInsetAdjustmentBehavior = .never
                pager.alwaysBounceVertical = false
                pager.contentOffset.y = 0
            }
            guard !(pager.gestureRecognizers ?? []).contains(where: { $0 is PagingGate }),
                  let back = sequence(first: next, next: { $0?.next }).lazy.compactMap({ $0 as? UIViewController }).first?
                      .navigationController?.interactiveContentPopGestureRecognizer
            else { return }
            let gate = PagingGate(pager: pager, back: back)
            pager.addGestureRecognizer(gate)
            pager.panGestureRecognizer.require(toFail: back)
        }
    }

    /// Begins when a swipe on the pager is the pager's to take: anything but rightward on the first page.
    final class PagingGate: UIPanGestureRecognizer, UIGestureRecognizerDelegate {
        private weak var pager: UIScrollView?
        private weak var back: UIGestureRecognizer?

        init(pager: UIScrollView, back: UIGestureRecognizer) {
            self.pager = pager
            self.back = back
            super.init(target: nil, action: nil)
            delegate = self
            cancelsTouchesInView = false
            delaysTouchesBegan = false
            delaysTouchesEnded = false
        }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let pager else { return true }
            let v = velocity(in: pager)
            let first = pager.contentOffset.x <= -pager.adjustedContentInset.left + 1
            return !(first && v.x > 0 && abs(v.x) > abs(v.y))
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { other !== back }
    }
}

/// The navigation bar: the ticket's key names it for the Back button of whatever's pushed above.
/// The title itself is in the hero, so at the root of the ticket sheet or panel there's no bar;
/// a ticket pushed inside keeps one (a Back button, no title). The More menu is in the hero.
private struct TicketDetailHeader: ViewModifier {
    let ticket: Ticket

    @Environment(Router.self) private var router
    @Environment(\.inTicketSheet) private var inTicketSheet
    @Environment(\.inTicketPanel) private var inTicketPanel

    func body(content: Content) -> some View {
        // The sheet's and panel's root ticket has nothing to go back to.
        let isRoot = (inTicketSheet || inTicketPanel) && router.showsAsSheetRoot(ticket.key)
        content
            .navigationTitle(Keys.keyLabel(ticket))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(isRoot ? .hidden : .automatic, for: .navigationBar)
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
