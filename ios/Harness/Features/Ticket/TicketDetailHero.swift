import HarnessKit
import SwiftUI

/// The top of the ticket screen (TicketDetail.tsx Hero): the "Part of" crumb, the title, badges,
/// the approval card and the actions for the ticket's state. It scrolls on its own, up to
/// `maxHeight`. On the Browser, plugin and sub-agent tabs (`compactTab`) it shrinks to the title on
/// one line, which expands it on tap.
struct TicketDetailHero: View {
    let ticket: Ticket
    let compactTab: Bool
    let maxHeight: CGFloat

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @State private var expanded = false
    @State private var contentHeight: CGFloat = 0
    @State private var requestingChanges = false
    @State private var reopening = false
    @State private var completing: Completing?
    @State private var approvingCustom = false

    /// The Complete sheet, opened by the button (the preselected action) or a menu's Custom.
    private struct Completing: Identifiable {
        let id = UUID()
        var action: CompletionAction?
    }

    private var api: HarnessClient? { store.client as? HarnessClient }

    var body: some View {
        let compact = compactTab && !expanded
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
        .sheet(item: $completing) { TicketDetailCompleteSheet(ticket: ticket, initialAction: $0.action) }
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
            TicketDetailFlow(spacing: 6) {
                if let project { ProjectKeyBadge(project.key, color: project.color) }
                StatusPill(status: ticket.status)
                if state.hasCustomDriver(ticket) { DriverBadge(driver: ticket.driver, drivers: state.drivers) }
                ModelBadge(model: ticket.model, models: nil)
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
            TicketDetailFlow(spacing: 8) { buttons(project: project, parent: parent) }
        }
    }

    private func title(compact: Bool) -> some View {
        let text = Text(ticket.title.isEmpty ? "Untitled" : ticket.title)
            .font(.system(size: compact ? 16 : 19, weight: .bold))
            .foregroundStyle(c.text)
            .lineLimit(compact ? 1 : nil)
            .frame(maxWidth: .infinity, alignment: .leading)
        return Group {
            if compactTab {
                Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                    HStack(spacing: 8) {
                        text
                        Icon(expanded ? "chevronDown" : "chevronRight", size: 14).foregroundStyle(c.text3)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows the ticket's status and actions")
            } else {
                text.textSelection(.enabled)
            }
        }
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
        let opts = Completion.completionOptions(ticket: ticket, project: project, parent: parent)
        let ready = BoardState.isReady(ticket)
        let label = Keys.keyLabel(ticket)
        if ticket.status == .planning {
            HButton("Start work", icon: "play", variant: .primary, small: true, fullWidth: false, haptic: .success) {
                perform(nil) { try await $0.startTicket($1) }
            }
        }
        if ticket.status == .review && ticket.humanReview != .approved {
            HStack(spacing: 2) {
                HButton(Completion.approveLabel(opts) ?? "Approve", icon: "check", variant: .primary, small: true, fullWidth: false, haptic: .success) {
                    send(Approve.primaryApproveRequest(opts, ticket: ticket), toast: "Approved")
                }
                approveMenu(opts, label: label)
            }
            HButton("Request changes", icon: "edit", small: true, fullWidth: false) { requestingChanges = true }
        }
        if ticket.status == .review {
            HStack(spacing: 2) {
                HButton("Complete", icon: "checkCircle", variant: ready ? .primary : .secondary, small: true, fullWidth: false,
                        accessibilityLabel: TicketDetailLogic.completeButtonLabel(ready: ready, busy: ticket.busy)) { completing = Completing() }
                    .disabled(!ready || ticket.busy)
                if ticket.humanReview == .approved { completeMenu(opts, ready: ready, label: label) }
            }
            HButton(TicketDetailLogic.agentReviewButton(ticket.agentReview), icon: "refresh", variant: .ghost, small: true, fullWidth: false) {
                perform("Agent review queued") { try await $0.rerunAgentReview($1) }
            }
            .disabled(ticket.busy)
        }
        if ticket.status == .done {
            HButton("Re-open", icon: "refresh", small: true, fullWidth: false) { reopening = true }
        }
        if ticket.busy {
            HButton("Cancel run", icon: "stop", variant: .danger, small: true, fullWidth: false, haptic: .warning) {
                perform("Run cancelled") { try await $0.cancelTicket($1) }
            }
        }
    }

    /// The chevron beside Approve: every way to approve, then approving without an action.
    private func approveMenu(_ opts: Completion.Options, label: String) -> some View {
        let choices = Approve.approveMenuChoices(opts)
        return Menu {
            Section {
                ForEach(Array(choices.dropLast().enumerated()), id: \.offset) { _, choice in
                    Button(choice.label ?? "") { approve(choice.value, label: label) }
                }
            } header: {
                Text(TicketDetailLogic.parentBranchMessage(opts) ?? "Approve \(label)")
            }
            if let last = choices.last {
                Section { Button(last.label ?? "") { approve(last.value, label: label) } }
            }
        } label: {
            Icon("chevronDown", size: 13, weight: .semibold)
        }
        .menuStyle(.button)
        .menuOrder(.fixed)
        .buttonStyle(.harness(.primary, small: true, fullWidth: false))
        .accessibilityLabel("More ways to approve")
    }

    private func approve(_ choice: Approve.Choice, label: String) {
        if choice == .action(.custom) {
            approvingCustom = true
            return
        }
        haptic(.success)
        send(Approve.approveRequest(choice), toast: Approve.approveToast(choice, key: label))
    }

    /// After the human approved: complete another way, or take no action (no agent run).
    private func completeMenu(_ opts: Completion.Options, ready: Bool, label: String) -> some View {
        let choices = Approve.completeMenuChoices(opts, canRun: ready && !ticket.busy)
        return Menu {
            Section {
                ForEach(Array(choices.dropLast().enumerated()), id: \.offset) { _, choice in
                    Button(choice.label ?? "") { complete(choice.value, label: label) }
                }
            } header: {
                Text(TicketDetailLogic.parentBranchMessage(opts) ?? "Complete \(label)")
            }
            if let last = choices.last {
                Section { Button(last.label ?? "") { complete(last.value, label: label) } }
            }
        } label: {
            Icon("chevronDown", size: 13, weight: .semibold)
        }
        .menuStyle(.button)
        .menuOrder(.fixed)
        .buttonStyle(.harness(ready ? .primary : .secondary, small: true, fullWidth: false))
        .accessibilityLabel("More ways to complete")
    }

    private func complete(_ choice: Approve.Choice, label: String) {
        if choice == .action(.custom) {
            completing = Completing(action: .custom)
            return
        }
        haptic(.success)
        let body = Approve.completeMenuRequest(choice)
        perform(TicketDetailLogic.completeMenuToast(choice, label: label)) { try await $0.completeTicket($1, body) }
    }

    private func send(_ request: Approve.Request, toast: String) {
        switch request {
        case let .review(body): perform(toast) { try await $0.humanReview($1, body) }
        case let .complete(body): perform(toast) { try await $0.completeTicket($1, body) }
        }
    }

    /// `act(() => client.…(key))` with the ticket's key.
    private func perform<T: Sendable>(_ toast: String?, _ fn: @escaping @MainActor (HarnessClient, String) async throws -> T) {
        guard let api else { return }
        let key = ticket.key
        actions.perform(toast) { _ = try await fn(api, key) }
    }
}
