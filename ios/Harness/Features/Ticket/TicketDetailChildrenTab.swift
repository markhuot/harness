import HarnessKit
import SwiftUI

/// A conductor's Tickets tab: progress across its children, then the
/// children grouped by status, each with what it's waiting on or its latest Activity note.
struct TicketDetailChildrenTab: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    /// Children whose Activity was asked for already (cleared on reconnect).
    @State private var fetched = Set<String>()

    var body: some View {
        let state = store.state
        let children = Conductor.childrenOfTicket(state.tickets, conductorId: ticket.id)
        // Until the conductor's detail lands, only its unfinished children are known (done ones page in).
        let complete = state.childrenLoaded[ticket.id] == true
        Group {
            if children.isEmpty && !complete {
                Spinner().frame(maxWidth: .infinity).padding(30)
                    .frame(maxHeight: .infinity, alignment: .top)
            } else if children.isEmpty {
                EmptyState(icon: "conductor", title: "No tickets yet", message: "The conductor hasn't created any tickets yet.")
            } else {
                list(children, complete: complete)
            }
        }
        // Keyed on the epoch too, so a fetch that failed while the connection was down runs again
        // once it's back (the reconnect clears `fetched` first).
        .task(id: ChildActivityFetch(ids: children.map(\.id), epoch: store.epoch)) { fetchActivity(children) }
        .onChange(of: store.epoch) { fetched = [] }
    }

    private func list(_ children: [Ticket], complete: Bool) -> some View {
        let progress = Conductor.progressOf(children)
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 8) {
                        Text(Conductor.progressLabel(progress)).font(.scaled(size: 14.5, weight: .medium)).foregroundStyle(c.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !complete { Spinner() }
                    }
                    ProgressBar(progress: progress)
                    if progress.attention > 0 {
                        HStack(spacing: 5) {
                            Icon("alert", size: 12, weight: .semibold)
                            Text(TicketDetailLogic.waitingOnYou(progress.attention)).font(.scaled(size: 13.5))
                        }
                        .foregroundStyle(c.red)
                    }
                }
                .padding(13)
                .background(c.bgElev, in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 1 / 3))
                ForEach(Conductor.groupChildren(children), id: \.status) { group in
                    VStack(alignment: .leading, spacing: 7) {
                        HStack(spacing: 7) {
                            StatusDot(status: group.status)
                            Text(statusLabel(group.status)).font(.scaled(size: 14, weight: .semibold)).foregroundStyle(c.text)
                            Text("\(group.tickets.count)").font(.scaled(size: 13)).foregroundStyle(c.text3)
                        }
                        .padding(.horizontal, 2)
                        .accessibilityElement(children: .combine)
                        Card {
                            ForEach(Array(group.tickets.enumerated()), id: \.element.id) { i, child in
                                TicketDetailChildRow(child: child, first: i == 0)
                            }
                        }
                    }
                }
            }
            .padding(14)
            .padding(.bottom, 16)
        }
        .ticketHeroScroll()
    }

    private func fetchActivity(_ children: [Ticket]) {
        guard let api = store.api else { return }
        for child in children where store.state.activity[child.sessionId] == nil && !fetched.contains(child.id) {
            fetched.insert(child.id)
            let key = child.key
            let sessionId = child.sessionId
            Task {
                guard let activity = try? await api.listActivity(key) else { return }
                store.dispatch(.activity(sessionId: sessionId, activity: activity))
            }
        }
    }
}

/// What the children's Activity fetch is keyed on.
private struct ChildActivityFetch: Equatable {
    let ids: [String]
    let epoch: Int
}

/// One child: key, title, its state, then why it needs you (or its latest Activity note), what it waits
/// on and its driver and model. Tapping it opens it. The row isn't a Button: a Button's label
/// swallows the taps of the dependency chips' own buttons, so the row takes a tap gesture (the
/// chips, being buttons, win their own taps) and tells VoiceOver it's a button.
private struct TicketDetailChildRow: View {
    let child: Ticket
    let first: Bool

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        let state = store.state
        let deps = state.dependencyStates(child)
        let attention = Conductor.attentionOf(child)
        let showDriver = state.hasCustomDriver(child)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                TicketKeyLabel(ticket: child).fixedSize()
                Text(child.title.isEmpty ? "Untitled" : child.title)
                    .font(.scaled(size: 14.5, weight: .medium))
                    .foregroundStyle(c.text)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if Conductor.isWorking(state.tickets, child) { Spinner().accessibilityLabel(Conductor.workingTitle(child)) }
                if child.status == .review {
                    HStack(spacing: 3) {
                        ReviewMark(who: .agent, state: child.agentReview)
                        ReviewMark(who: .human, state: child.humanReview)
                    }
                }
            }
            if let approval = child.pendingApproval {
                Text("\(Image(icon: "lock")) Needs approval: \(Text(Format.shortToolName(approval.toolName)).font(.mono(13)))")
                    .font(.scaled(size: 13))
                    .foregroundStyle(c.amber)
            } else if child.status == .blocked {
                Text(child.blockedReason.flatMap { $0.isEmpty ? nil : $0 } ?? "Blocked")
                    .font(.scaled(size: 13)).foregroundStyle(c.red).lineLimit(3)
            } else if let news = state.latestActivity(child.sessionId, kinds: ActivityRows.newsKinds) {
                Text(Markdown.plainText(news.body)).font(.scaled(size: 13)).foregroundStyle(c.text2).lineLimit(2)
            }
            if !deps.isEmpty || showDriver || child.model != nil {
                HStack(alignment: .center, spacing: 5) {
                    FlowLayout(spacing: 5) {
                        ForEach(deps, id: \.key) { d in
                            let opens = Related.depOpens(key: d.key, missing: d.missing, byRemoteKey: store.related.byRemoteKey)
                            DepChip(label: d.ticket.map { Keys.keyLabel($0) } ?? d.key, done: d.done, prefix: d.done ? "after" : "waiting on",
                                    unknown: d.state == .unknown,
                                    onTap: opens ? { router.push(.ticket(key: d.ticket?.key ?? d.key, tab: nil)) } : nil)
                        }
                    }
                    Spacer(minLength: 0)
                    if showDriver { DriverBadge(driver: child.driver, drivers: state.drivers) }
                    if let model = child.model { Badge(model, outline: true) }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .onTapGesture(perform: open)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(.default, open)
        .accessibilityActions {
            ForEach(deps, id: \.key) { d in
                if Related.depOpens(key: d.key, missing: d.missing, byRemoteKey: store.related.byRemoteKey) {
                    let target = d.ticket?.key ?? d.key
                    Button("Open \(d.ticket.map { Keys.keyLabel($0) } ?? d.key)") { router.push(.ticket(key: target, tab: nil)) }
                }
            }
        }
        .overlay(alignment: .leading) {
            if let attention { Rectangle().fill(attention == .approval ? c.amber : c.red).frame(width: 3) }
        }
        .overlay(alignment: .top) { if !first { Rectangle().fill(c.border).frame(height: 1 / 3) } }
        .opacity(child.status == .done ? 0.7 : 1)
    }

    private func open() { router.push(.ticket(key: child.key, tab: nil)) }
}
