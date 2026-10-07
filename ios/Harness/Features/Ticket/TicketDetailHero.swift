import HarnessKit
import SwiftUI

/// The top of the ticket screen: the "Part of" crumb, the title, badges,
/// the approval card and the actions for the ticket's state. It scrolls on its own, up to
/// `maxHeight`. Collapsed, it shrinks to the title on one line with a chevron that expands it (an
/// approval card waiting on the human still shows). `disclosure` is the ticket screen's, shared by
/// every tab (HeroDisclosure); without one (a pinned window) it starts collapsed and keeps its own.
struct TicketDetailHero: View {
    let ticket: Ticket
    var disclosure: TicketDetailHeroCollapse?
    let maxHeight: CGFloat

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @State private var localExpanded = false
    @State private var contentHeight: CGFloat = 0
    @State private var requestingChanges = false
    @State private var reopening = false
    @State private var approvingCustom = false

    private var api: HarnessClient? { store.api }
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
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                content(compact: compact)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(contentHeight, maxHeight))
        .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }
        .sheet(isPresented: $requestingChanges) { TicketDetailNotesSheet(ticket: ticket) }
        .sheet(isPresented: $reopening) { TicketDetailNotesSheet(ticket: ticket, reopen: true) }
        .sheet(isPresented: $approvingCustom) { TicketDetailApproveCustomSheet(ticket: ticket) }
    }

    @ViewBuilder private func content(compact: Bool) -> some View {
        let state = store.state
        let project = state.projects[ticket.projectId]
        let parent = ticket.parentId.flatMap { state.tickets[$0] }
        if let parent, !compact {
            ParentCrumb(parent: parent) { router.push(.ticket(key: $0, tab: .children)) }
        }
        title(compact: compact)
        if !compact {
            FlowLayout(spacing: 6) {
                if let project { ProjectKeyBadge(project.key, color: project.color) }
                StatusPill(status: ticket.status)
                if state.hasCustomDriver(ticket) { DriverBadge(driver: ticket.driver, drivers: state.drivers) }
                ModelBadge(ticket: ticket, state: state)
                KindBadge(ticket: ticket, childCount: ticket.isConductor ? state.childrenOf(ticket.id).count : nil)
                if let branch = ticket.branch { Badge(branch, outline: true, icon: "branch") }
                if let url = ticket.pullRequestUrl.optional { pullRequestBadge(url) }
                if ticket.status == .review {
                    ReviewMark(who: .agent, state: ticket.agentReview)
                    ReviewMark(who: .human, state: ticket.humanReview)
                }
            }
        }
        if let approval = ticket.pendingApproval {
            TicketDetailApprovalCard(ticket: ticket, approval: approval).id(approval.id)
        }
        if !compact && (ticket.busy || [.planning, .review, .done].contains(ticket.status)) {
            FlowLayout(spacing: 8) { buttons(project: project, parent: parent) }
        }
        // A child's conductor acts as its human reviewer and lands it, so its Approve is off.
        if !compact, ticket.status == .review, let conductor = Completion.managingConductor(ticket: ticket, parent: parent) {
            Text(Completion.conductorManagedReason(conductorKey: conductor.key))
                .font(.scaled(size: 13))
                .foregroundStyle(c.text3)
        }
    }

    private func title(compact: Bool) -> some View {
        let text = Text(ticket.title.isEmpty ? "Untitled" : ticket.title)
            .font(.scaled(size: compact ? 16 : 19, weight: .bold))
            .foregroundStyle(c.text)
            .lineLimit(compact ? 1 : nil)
            .frame(maxWidth: .infinity, alignment: .leading)
        // The whole header row takes the tap, its padding included, not just the text and chevron.
        return Button(action: toggle) {
            HStack(spacing: 8) {
                text
                Icon(expanded ? "chevronDown" : "chevronRight", size: 14).foregroundStyle(c.text3)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, compact ? 10 : 5)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, -14)
        .padding(.top, -10)
        .padding(.bottom, compact ? -10 : -5)
        .accessibilityValue(expanded ? "Expanded" : "Collapsed")
        .accessibilityHint(expanded ? "Hides the ticket's status and actions" : "Shows the ticket's status and actions")
    }

    /// The PR a "pr" completion opened, as a tappable badge.
    private func pullRequestBadge(_ url: String) -> some View {
        Link(destination: URL(string: url) ?? URL(string: "about:blank")!) {
            Badge(TicketDetailLogic.pullRequestBadge(url), tone: .violet, icon: "external")
        }
        .accessibilityLabel(TicketDetailLogic.pullRequestNumber(url).map { "Pull request #\($0)" } ?? "Pull request")
        .accessibilityHint("Opens it in the browser")
    }

    @ViewBuilder private func buttons(project: Project?, parent: Ticket?) -> some View {
        // A ticket on its base branch offers no merge or pull request, only clean up.
        let opts = Completion.completionOptions(ticket: ticket, project: project, parent: parent, settingsBaseBranch: store.state.settings?.baseBranch)
        let label = Keys.keyLabel(ticket)
        let managedReason = Completion.managingConductor(ticket: ticket, parent: parent).map { Completion.conductorManagedReason(conductorKey: $0.key) }
        let managed = managedReason != nil
        // Started while its dependencies were open: the service starts it once they're done, so
        // Start is off (it would skip the wait and run it now).
        let waiting = Conductor.autoStartWaitingOn(ticket, store.state.dependencyStates(ticket))
        if ticket.status == .planning && waiting.isEmpty {
            HButton("Start work", icon: "play", variant: .primary, small: true, fullWidth: false, haptic: .success) {
                perform { try await $0.startTicket($1) }
            }
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
        // Approving lands the work once both reviews pass; there's no separate Complete step. A
        // conductor's child keeps its (turned off) Approve once approved: the conductor lands it.
        if ticket.status == .review && (ticket.humanReview != .approved || managed) {
            HStack(spacing: 2) {
                let approveTitle = Completion.approveLabel(opts) ?? "Approve"
                HButton(approveTitle, icon: "check", variant: .primary, small: true, fullWidth: false, haptic: .success,
                        accessibilityLabel: TicketDetailLogic.approveButtonLabel(approveTitle, managedReason: managedReason)) {
                    send(Approve.primaryApproveRequest(opts, ticket: ticket))
                }
                .disabled(managed)
                approveMenu(opts, label: label).disabled(managed)
            }
        }
        if ticket.status == .review && ticket.humanReview != .approved {
            HButton("Request changes", icon: "edit", small: true, fullWidth: false) { requestingChanges = true }
        }
        if ticket.status == .review {
            HButton(TicketDetailLogic.agentReviewButton(ticket.agentReview), icon: "refresh", variant: .ghost, small: true, fullWidth: false) {
                perform { try await $0.rerunAgentReview($1) }
            }
            .disabled(ticket.busy)
        }
        if ticket.status == .done {
            HButton("Re-open", icon: "refresh", small: true, fullWidth: false) { reopening = true }
        }
        if ticket.busy {
            HButton("Cancel run", icon: "stop", variant: .danger, small: true, fullWidth: false, haptic: .warning) {
                perform { try await $0.cancelTicket($1) }
            }
        }
    }

    /// The chevron beside Approve: every way to approve, then approving without an action.
    private func approveMenu(_ opts: Completion.Options, label: String) -> some View {
        let choices = Approve.approveMenuChoices(opts)
        return Menu {
            Section {
                ForEach(Array(choices.dropLast().enumerated()), id: \.offset) { _, choice in
                    Button(choice.label ?? "") { approve(choice.value) }
                }
            } header: {
                Text("Approve \(label)")
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
        if choice == .action(.custom) {
            approvingCustom = true
            return
        }
        haptic(.success)
        send(Approve.approveRequest(choice))
    }

    private func send(_ request: Approve.Request) {
        switch request {
        case let .review(body): perform { try await $0.humanReview($1, body) }
        case let .complete(body): perform { try await $0.completeTicket($1, body) }
        }
    }

    /// `act(() => client.…(key))` with the ticket's key.
    private func perform<T: Sendable>(_ fn: @escaping @MainActor (HarnessClient, String) async throws -> T) {
        guard let api else { return }
        let key = ticket.key
        actions.perform { _ = try await fn(api, key) }
    }
}
