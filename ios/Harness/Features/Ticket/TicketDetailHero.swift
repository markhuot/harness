import HarnessKit
import SwiftUI

/// The top of the ticket screen: the "Part of" crumb, the title, badges,
/// the approval card and the actions for the ticket's state. A plain stack, as tall as its content
/// (it doesn't scroll, so a drag on the sheet has nothing in it to lay out). Collapsed, it shrinks to the title on one line with a chevron that expands it (an
/// approval card waiting on the human still shows). `disclosure` is the ticket screen's, shared by
/// every tab (HeroDisclosure); without one (a pinned window) it starts collapsed and keeps its own.
struct TicketDetailHero: View {
    let ticket: Ticket
    var disclosure: TicketDetailHeroCollapse?
    /// The screen's navigation bar is hidden, so the hero draws the Back button itself, level with
    /// the title, when there's something to go back to.
    var navigable = false

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.inTicketSheet) private var inTicketSheet
    @Environment(\.inTicketPanel) private var inTicketPanel
    @Environment(\.ticketPanelTitleInset) private var panelInset
    @Environment(\.ticketPanelTrailingInset) private var cornerInset
    @Environment(\.dismiss) private var dismiss
    @Environment(\.isPresented) private var isPresented
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(\.openURL) private var openURL
    @State private var localExpanded = false
    /// Runs the actions and hosts what they ask for (the notes and instructions sheets, the delete confirmation).
    @State private var runner = TicketActionRunner()

    private var expanded: Bool { disclosure?.expanded ?? localExpanded }

    private func toggle() {
        if let disclosure {
            disclosure.toggle()
        } else {
            withAnimation(.snappy) { localExpanded.toggle() }
        }
    }

    var body: some View {
        let compact = !expanded
        VStack(alignment: .leading, spacing: 10) {
            content(compact: compact)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
        .modifier(TicketActionHost(runner: runner))
    }

    @ViewBuilder private func content(compact: Bool) -> some View {
        let state = store.state
        let project = state.projects[ticket.projectId]
        let parent = ticket.parentId.flatMap { state.tickets[$0] }
        let crumb = parent.flatMap { parent in
            compact ? nil : ParentCrumb(parent: parent) { router.push(.ticket(key: $0, tab: .children)) }
        }
        header(compact: compact, crumb: crumb)
        if !compact {
            // Project, key and gauge lead; the review marks sit at the trailing edge.
            HStack(spacing: 6) {
                if let project { ProjectKeyBadge(project.key, color: project.color) }
                TicketKeyLabel(ticket: ticket, size: 12.5, color: c.text2)
                // Its 44pt tap target overflows the 24pt the row gives it, so it
                // doesn't make the row taller.
                if TicketContextGauge.isShown(for: ticket, drivers: state.drivers) {
                    TicketContextGauge(ticket: ticket).frame(height: 24)
                }
                if state.hasCustomDriver(ticket) { DriverBadge(driver: ticket.driver, drivers: state.drivers) }
                ModelBadge(ticket: ticket, state: state)
                Spacer(minLength: 6)
                if ticket.status == .review {
                    ReviewMark(who: .agent, state: ticket.agentReview)
                    ReviewMark(who: .human, state: ticket.humanReview)
                }
            }
            if ticket.branch != nil || !ticket.pullRequests.isEmpty {
                FlowLayout(spacing: 6) {
                    if let branch = ticket.branch {
                        let base = Branches.resolveBaseBranch(ticket: ticket, project: project, settingsBaseBranch: state.settings?.baseBranch, parent: parent).branch
                        Text("\(branch) → \(base)")
                            .font(.scaled(size: 12, design: .monospaced))
                            .foregroundStyle(c.text2)
                            .accessibilityLabel("Branch \(branch) into \(base)")
                    }
                    ForEach(ticket.pullRequests, id: \.url) { pullRequestBadge($0) }
                }
            }
        }
        if let approval = ticket.pendingApproval {
            TicketDetailApprovalCard(ticketKey: ticket.key, approval: approval).id(approval.id)
        }
        // Always there when expanded: the More menu's Delete always applies.
        if !compact {
            // While the session compacts the service refuses ticket actions; Cancel run in More stays.
            FlowLayout(spacing: 8) {
                let deps = state.dependencyStates(ticket)
                let set = TicketActions.set(for: ticket, project: project, parent: parent, deps: deps, settingsBaseBranch: state.settings?.baseBranch)
                Group { buttons(set, deps: deps, parent: parent) }.disabled(ticket.compacting == true)
                moreMenu(set)
            }
        }
        // A child's conductor acts as its human reviewer and lands it, so its Approve is off.
        if !compact, ticket.status == .review, let conductor = Completion.managingConductor(ticket: ticket, parent: parent) {
            Text(Completion.conductorManagedReason(conductorKey: conductor.key))
                .font(.scaled(size: 13))
                .foregroundStyle(c.text3)
        }
    }

    private var showsBack: Bool {
        // `isPresented` is false at the root of a stack (a ticket window, the board card preview),
        // where there's nothing to go back to.
        navigable && isPresented && !((inTicketSheet || inTicketPanel) && router.showsAsSheetRoot(ticket.key))
    }

    /// The crumb and title, with the Back button at their leading edge when there is one, centered
    /// on the two together. In the iPad panel the header is as tall as the floating window buttons
    /// and level with them, so the title, its chevron and the buttons share one middle.
    @ViewBuilder private func header(compact: Bool, crumb: ParentCrumb?) -> some View {
        let back = showsBack
        let row = HStack(alignment: inTicketPanel ? .center : .top, spacing: 0) {
            if back { backButton }
            // With a crumb the title block's own top padding (clear of the sheet's corner) isn't
            // needed, so the crumb sits close to the status row.
            VStack(alignment: .leading, spacing: inTicketPanel ? 4 : crumb == nil ? 10 : 2) {
                if let crumb { crumb }
                title(compact: compact, hasBack: back, hasCrumb: crumb != nil)
            }
        }
        if inTicketPanel {
            row
                .frame(minHeight: TicketSidePanel<EmptyView>.buttonSize)
                // The hero's 10pt top padding up to the buttons' 4; below, what the title had.
                .padding(.top, -6)
                .padding(.bottom, compact ? -8 : -4)
        } else {
            row
        }
    }

    private var backButton: some View {
        Button { dismiss() } label: {
            Image(systemName: "chevron.left")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(c.text)
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .padding(.trailing, 10)
        // Pinned to the top of the row, whatever the title wraps to or whether it is collapsed, and
        // dropped so its top inset equals its 14pt leading inset: the circle then shares the sheet
        // corner's center.
        .offset(y: inTicketPanel ? 0 : 4)
        .accessibilityLabel("Back")
        .accessibilityIdentifier("ticket-back")
    }

    private func title(compact: Bool, hasBack: Bool, hasCrumb: Bool) -> some View {
        let text = Text(ticket.title.isEmpty ? "Untitled" : ticket.title)
            .font(.scaled(size: compact ? 16 : 19, weight: .bold))
            .foregroundStyle(c.text)
            .lineLimit(compact ? 1 : nil)
            .frame(maxWidth: .infinity, alignment: .leading)
        // The whole header row takes the tap, its padding included, not just the text and chevron.
        return Button(action: toggle) {
            VStack(alignment: .leading, spacing: compact ? 0 : 6) {
                if !compact {
                    HStack(spacing: 4) {
                        StatusDot(status: ticket.status, size: 10)
                        Text(statusLabel(ticket.status))
                            .font(.scaled(size: 14, weight: .semibold))
                            .foregroundStyle(c.text)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    text
                    Icon(expanded ? "chevronDown" : "chevronRight", size: 14).foregroundStyle(c.text3)
                }
            }
            // The iPad panel's buttons float over the ticket's top corner; the row is as tall as
            // they are, so the title, its chevron and the buttons share one middle.
            // The buttons sit that far inside the screen's corner, so the title keeps clear of them
            // by the trailing safe area too.
            .padding(.trailing, inTicketPanel ? panelInset + cornerInset : 0)
            // Both states use 14pt to align with the Spec tab's 14pt padding. Expanded gets 5pt
            // more above, clear of the sheet's rounded corner. The hero's 14pt horizontal padding
            // is the space on both sides, so the title adds none extra.
            .padding(.leading, hasBack ? 0 : 14)
            .padding(.trailing, 14)
            .padding(.top, inTicketPanel || hasCrumb ? 10 : compact ? 20 : 25)
            .padding(.bottom, compact ? 10 : 5)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        // In the iPad's panel, a long press lists the other docked tickets to switch to (the iPhone's
        // dock is over the ticket, so its cards are how you switch).
        .dockedTicketsMenu(router, inSheet: inTicketPanel)
        .padding(.leading, hasBack ? 0 : -14)
        .padding(.trailing, -14)
        .padding(.top, -10)
        .padding(.bottom, compact ? -10 : -5)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel("\(ticket.title.isEmpty ? "Untitled" : ticket.title), \(statusLabel(ticket.status))")
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Hides the ticket's status and actions" : "Shows the ticket's status and actions")
    }

    /// One of the ticket's pull requests, as a tappable badge. The title lives in the label, not on the
    /// badge, to keep the row short.
    private func pullRequestBadge(_ link: PullRequestLink) -> some View {
        Link(destination: URL(string: link.url) ?? URL(string: "about:blank")!) {
            Badge(TicketDetailLogic.pullRequestBadge(link.url), tone: .violet, icon: "external")
        }
        .accessibilityLabel(TicketDetailLogic.pullRequestAccessibilityLabel(link))
        .accessibilityHint("Opens it in the browser")
    }

    /// The status action, Approve and the like come from the shared list (`TicketActions`, also the
    /// board card's menu); the disabled stand-ins for a state with no action of its own are drawn here.
    @ViewBuilder private func buttons(_ set: TicketActionSet, deps: [DepState], parent: Ticket?) -> some View {
        // Started while its dependencies were open: the service starts it once they're done, so
        // Start is off (it would skip the wait and run it now).
        let waiting = Conductor.autoStartWaitingOn(ticket, deps)
        let startMode = Conductor.startState(ticket, deps)
        if startMode == .approved {
            HButton("Starts after planning", icon: "clock", variant: .primary, small: true, fullWidth: false,
                    accessibilityLabel: Conductor.approvedTitle) {}
                .disabled(true)
        }
        if !waiting.isEmpty {
            HButton("Starts automatically", icon: "clock", variant: .primary, small: true, fullWidth: false,
                    accessibilityLabel: Conductor.autoStartTitle(waiting)) {}
                .disabled(true)
        }
        // Stopped on a usage limit: the service restarts it on its own after the limit resets.
        if let restart = Conductor.restartsAt(ticket) {
            let time = Date(timeIntervalSince1970: restart / 1000).formatted(date: .omitted, time: .shortened)
            HButton("Restarts at \(time)", icon: "clock", variant: .primary, small: true, fullWidth: false,
                    accessibilityLabel: Conductor.restartTitle(time)) {}
                .disabled(true)
        }
        ForEach(Array(set.primary.enumerated()), id: \.offset) { _, item in
            primaryButton(item)
        }
        // Approved review: no Approve to draw, so a disabled button says what it's waiting on.
        if let standIn = Conductor.approvedStandIn(ticket, managed: Completion.managingConductor(ticket: ticket, parent: parent) != nil) {
            HButton(standIn.label, icon: "clock", small: true, fullWidth: false, accessibilityLabel: standIn.title) {}
                .disabled(true)
        }
        // A running ticket has no action of its own: a disabled stand-in keeps the row from looking empty.
        if ticket.status == .inProgress {
            HButton("Working…", icon: "clock", small: true, fullWidth: false) {}
                .disabled(true)
        }
    }

    @ViewBuilder private func primaryButton(_ item: TicketActionItem) -> some View {
        switch item.action {
        case .start:
            HButton(item.action.title, icon: "play", variant: .primary, small: true, fullWidth: false, haptic: nil) { run(item.action) }
                .disabled(!item.enabled)
        case let .approve(title, _, choices, managedReason):
            HStack(spacing: 2) {
                HButton(title, icon: "check", variant: .primary, small: true, fullWidth: false, haptic: nil,
                        accessibilityLabel: TicketDetailLogic.approveButtonLabel(title, managedReason: managedReason)) { run(item.action) }
                    .disabled(!item.enabled)
                approveMenu(choices).disabled(!item.enabled)
            }
        case .unblock:
            HButton(item.action.title, icon: "play", variant: .primary, small: true, fullWidth: false, haptic: nil) { run(item.action) }
                .disabled(!item.enabled)
        case .reopen:
            HButton(item.action.title, icon: "refresh", small: true, fullWidth: false) { run(item.action) }
                .disabled(!item.enabled)
        default:
            HButton(item.action.title, icon: "edit", small: true, fullWidth: false) { run(item.action) }
                .disabled(!item.enabled)
        }
    }

    /// The secondary […] after the actions: the agent review (in review), Move to done (not in
    /// review, where Approve and take no action does it), Cancel run while a run is busy, and Delete.
    private func moreMenu(_ set: TicketActionSet) -> some View {
        Menu {
            // One per pull request, titled when it has a title, then the rest of the menu.
            ForEach(ticket.pullRequests, id: \.url) { link in
                Button(TicketDetailLogic.pullRequestMenuTitle(link), systemImage: "arrow.up.right.square") {
                    if let url = URL(string: link.url) { openURL(url) }
                }
            }
            ForEach(Array(set.more.enumerated()), id: \.offset) { _, item in
                Button(item.action.title, systemImage: item.action.symbol, role: item.action.isDestructive ? .destructive : nil) { run(item.action) }
                    .disabled(!item.enabled)
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 13 * 0.92, weight: .semibold)).frame(width: 13, height: 13)
        }
        .menuStyle(.button)
        .menuOrder(.fixed)
        .buttonStyle(.harness(.secondary, small: true, fullWidth: false))
        .accessibilityLabel("More")
        .accessibilityIdentifier("ticket-more")
    }

    private func run(_ action: TicketAction) {
        runner.run(action, ticket: ticket, api: store.api, actions: actions, onDeleted: pop)
    }

    /// Back off the deleted ticket's screen.
    private func pop(_ key: String) {
        let state = store.state
        router.removeTicket { $0.uppercased() == key.uppercased() || state.ticketByKey($0) == nil }
    }

    /// The chevron beside Approve: every way to approve, then approving without an action.
    private func approveMenu(_ choices: [Approve.MenuChoice]) -> some View {
        Menu {
            Section {
                ForEach(Array(choices.dropLast().enumerated()), id: \.offset) { _, choice in
                    Button(choice.label ?? "") { approve(choice.value) }
                }
            } header: {
                Text("Approve \(Keys.keyLabel(ticket))")
            }
            if let last = choices.last {
                Section { Button(last.label ?? "") { approve(last.value) } }
            }
        } label: {
            Icon("chevronDown", size: 13, weight: .semibold)
        }
        .menuStyle(.button)
        .menuOrder(.fixed)
        .buttonStyle(.harness(.primary, small: true, fullWidth: false))
        .accessibilityLabel("More ways to approve")
    }

    private func approve(_ choice: Approve.Choice) {
        runner.approve(choice, ticket: ticket, api: store.api, actions: actions)
    }
}
