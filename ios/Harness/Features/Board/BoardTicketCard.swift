import HarnessKit
import SwiftUI

/// A board card with everything the desktop card shows. Touch and hold
/// opens the context menu (move between columns, reorder, open the parent, copy the key); VoiceOver
/// gets the moves as custom actions; the card drags by its key onto another card (to sit above it)
/// or onto a status chip. A draft (a New session saved before launch) is dashed and dimmed with a
/// Draft badge, opens in the New session editor, and offers Discard instead of the moves.
struct BoardTicketCard: View {
    let ticket: Ticket
    let showProject: Bool
    let onMove: (Ticket, TicketStatus, BoardColumns.Where) -> Void
    let onDiscard: (Ticket) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        let t = ticket
        let state = store.state
        let parent = t.parentId.flatMap { state.tickets[$0] }
        Button { open() } label: { card(state: state, parent: parent) }
            .buttonStyle(BoardCardPressStyle())
            .contextMenu { menu(parent: parent) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(BoardScreenRules.cardAccessibilityLabel(t))
            .accessibilityHint(t.draft == true ? "Opens the draft. Touch and hold to discard it." : "Opens the ticket. Touch and hold to move it.")
            .accessibilityAddTraits(.isButton)
            .accessibilityActions {
                ForEach(BoardScreenRules.accessibilityMoves(t), id: \.self) { s in
                    Button("Move to \(statusLabel(s))") { onMove(t, s, .bottom) }
                }
            }
    }

    private func open() {
        if ticket.draft == true {
            router.present(.newSession(projectId: nil, key: ticket.key))
        } else {
            router.push(.ticket(key: ticket.key, tab: nil))
        }
    }

    // MARK: Card

    @ViewBuilder private func card(state: BoardState, parent: Ticket?) -> some View {
        let t = ticket
        let draft = t.draft == true
        let dim = Conductor.dimOnBoard(t)
        let deps = state.dependencyStates(t)
        let progress = t.isConductor ? Conductor.progressOf(state.childrenOf(t.id)) : nil
        let summary = state.latestSummary(t.sessionId)
        let customDriver = !dim && state.hasCustomDriver(t)
        let project = state.projects[t.projectId]

        VStack(alignment: .leading, spacing: dim ? 5 : 8) {
            HStack(spacing: 6) {
                if showProject, let project { ProjectKeyBadge(project.key, color: project.color, size: .sm) }
                TicketKeyLabel(ticket: t).layoutPriority(-1)
                if let parent {
                    Text("↳ \(Keys.keyLabel(parent))")
                        .font(.mono(11))
                        .foregroundStyle(c.violet)
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .frame(height: 19)
                        .frame(maxWidth: 150)
                        .background(c.violetSoft, in: .rect(cornerRadius: 5))
                        .fixedSize(horizontal: true, vertical: false)
                }
                Spacer(minLength: 0)
                if draft { Badge("Draft", icon: "edit") }
                if t.status == .review {
                    HStack(spacing: 3) {
                        ReviewMark(who: .agent, state: t.agentReview)
                        ReviewMark(who: .human, state: t.humanReview)
                    }
                }
                if t.busy { Spinner().controlSize(.small) }
                if let ext = t.externalRef { Badge(ext.source, icon: "link") }
                if t.status == .done, case .value = t.pullRequestUrl { Badge("PR", tone: .violet, icon: "external") }
            }
            .frame(minHeight: 21)

            Text(BoardScreenRules.cardTitle(t))
                .font(.scaled(size: dim ? 14.5 : 15.5, weight: .medium))
                .foregroundStyle(dim ? c.text2 : c.text)
                .lineLimit(dim ? 2 : 3)
                .lineSpacing(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)

            if let approval = t.pendingApproval {
                note(icon: "lock", tone: .amber) {
                    Text("Needs approval: \(Text(Format.shortToolName(approval.toolName)).font(.mono(13, weight: .semibold)))")
                        .lineLimit(2)
                }
            } else if t.status == .blocked, let reason = t.blockedReason, !reason.isEmpty {
                note(icon: "alert", tone: .red) { Text(reason).lineLimit(3) }
            }

            if let summary, t.status != .blocked, t.pendingApproval == nil {
                Text(Markdown.plainText(summary.body))
                    .font(.scaled(size: 13.5))
                    .foregroundStyle(dim ? c.text3 : c.text2)
                    .lineLimit(dim ? 1 : 2)
                    .lineSpacing(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .multilineTextAlignment(.leading)
            }

            if let progress { ConductorRollup(progress: progress) }

            if !deps.isEmpty {
                FlowLayout(spacing: 5) {
                    ForEach(deps, id: \.key) { d in
                        DepChip(label: d.ticket.map { Keys.keyLabel($0) } ?? d.key, done: d.done, unknown: d.state == .unknown)
                    }
                }
            }

            if customDriver || (t.model?.isEmpty == false) {
                FlowLayout(spacing: 5) {
                    if customDriver { DriverBadge(driver: t.driver, drivers: state.drivers) }
                    ModelBadge(model: t.model, driver: t.driver)
                }
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, dim ? 9 : 13)
        .background(dim || draft ? c.bgColumn : c.bgElev, in: .rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(draft ? c.text3 : c.border, style: StrokeStyle(lineWidth: draft ? 1 : 1 / 3, dash: draft ? [4, 3] : []))
        }
        .opacity(draft ? 0.75 : 1)
        .contentShape(.rect(cornerRadius: 12))
    }

    private func note<Content: View>(icon: String, tone: Tone, @ViewBuilder content: () -> Content) -> some View {
        let t = c.tone(tone)
        return HStack(alignment: .firstTextBaseline, spacing: 7) {
            Icon(icon, size: 12, weight: .semibold)
            content().font(.scaled(size: 13)).frame(maxWidth: .infinity, alignment: .leading).multilineTextAlignment(.leading)
        }
        .foregroundStyle(t.fg)
        .padding(.vertical, 7)
        .padding(.horizontal, 9)
        .background(t.bg, in: .rect(cornerRadius: 8))
    }

    // MARK: Menu

    @ViewBuilder private func menu(parent: Ticket?) -> some View {
        let t = ticket
        // The ticket's key and title, as the menu's header.
        Section(BoardScreenRules.menuTitle(t)) { menuItems(t, parent: parent) }
    }

    @ViewBuilder private func menuItems(_ t: Ticket, parent: Ticket?) -> some View {
        ForEach(Array(BoardScreenRules.cardMenu(t, parent: parent).enumerated()), id: \.offset) { _, item in
            switch item {
            case .discardDraft:
                Button("Discard draft", systemImage: "trash", role: .destructive) { onDiscard(t) }
            case let .move(s):
                Button("Move to \(statusLabel(s))", systemImage: "arrow.right") {
                    haptic(.success)
                    onMove(t, s, .bottom)
                }
            case .moveTo(.top):
                Button("Move to top", systemImage: "arrow.up.to.line") { onMove(t, t.status, .top) }
            case .moveTo(.bottom):
                Button("Move to bottom", systemImage: "arrow.down.to.line") { onMove(t, t.status, .bottom) }
            case let .openParent(key):
                Button("Open \(parent.map { Keys.keyLabel($0) } ?? key)", systemImage: "arrow.turn.left.up") {
                    router.push(.ticket(key: key, tab: nil))
                }
            case .copyKey:
                Button("Copy key", systemImage: "doc.on.doc") { UIPasteboard.general.string = t.key }
            }
        }
    }
}

/// The card's press feedback: a little dimmer and smaller while held.
private struct BoardCardPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
