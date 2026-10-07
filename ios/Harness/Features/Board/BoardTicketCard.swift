import HarnessKit
import SwiftUI

/// A board card with everything the desktop card shows. Touch and hold
/// previews the ticket's screen on its Spec tab above the context menu (open the parent, copy the
/// key). Only agents move cards between columns, so neither the menu, VoiceOver nor a drag does.
/// On iPad at regular width a card also drags out of the window into a ticket window of its own
/// (TearOff.swift); the board has no drop destination. A draft (a New session saved before launch)
/// is dashed and dimmed with a Draft badge, opens in the New session editor, offers Discard with
/// no preview, and doesn't drag.
struct BoardTicketCard: View {
    let ticket: Ticket
    let showProject: Bool
    let onDiscard: (Ticket) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    @Environment(\.supportsMultipleWindows) private var multipleWindows
    /// The card's width, which the preview takes as its own.
    @State private var width: CGFloat = 360

    var body: some View {
        let t = ticket
        let state = store.state
        let parent = t.parentId.flatMap { state.tickets[$0] }
        let waiting = Conductor.autoStartWaitingOn(t, state.dependencyStates(t))
        Button { open() } label: { card(state: state, parent: parent, waiting: waiting) }
            .buttonStyle(BoardCardPressStyle())
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .modifier(CardMenu(ticket: t, width: width) { menu(parent: parent) })
            .modifier(CardDrag(ticket: t))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(BoardScreenRules.cardAccessibilityLabel(t) + (waiting.isEmpty ? "" : ", " + Conductor.autoStartTitle(waiting).replacingOccurrences(of: "Starts", with: "starts")) + restartLabel(t))
            .accessibilityHint(t.draft == true ? "Opens the draft. Touch and hold to discard it." : "Opens the ticket. Touch and hold to preview it.")
            .accessibilityAddTraits(.isButton)
    }

    /// ", restarts on its own at 2:35 PM, …" for a ticket stopped on a usage limit; "" otherwise.
    private func restartLabel(_ t: Ticket) -> String {
        guard let at = Conductor.restartsAt(t) else { return "" }
        let time = Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .shortened)
        return ", " + Conductor.restartTitle(time).replacingOccurrences(of: "Restarts", with: "restarts")
    }

    private func open() {
        if ticket.draft == true {
            router.present(.newSession(projectId: nil, key: ticket.key))
        } else {
            router.push(.ticket(key: ticket.key, tab: nil))
        }
    }

    // MARK: Card

    /// `waiting`: the open dependencies an auto-start ticket waits on (a clock beside its key).
    @ViewBuilder private func card(state: BoardState, parent: Ticket?, waiting: [String]) -> some View {
        let t = ticket
        let draft = t.draft == true
        let dim = Conductor.dimOnBoard(t)
        let deps = state.dependencyStates(t)
        let progress = t.isConductor ? Conductor.progressOf(state.childrenOf(t.id)) : nil
        let news = state.latestActivity(t.sessionId, kinds: ActivityRows.newsKinds)
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
                if Conductor.isWorking(state.tickets, t) {
                    Spinner().controlSize(.small)
                } else if !waiting.isEmpty || Conductor.restartsAt(t) != nil {
                    Icon("clock", size: 13, weight: .semibold).foregroundStyle(c.accent)
                }
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

            if let news, t.status != .blocked, t.pendingApproval == nil {
                Text(Markdown.plainText(news.body))
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

            if customDriver || state.hasCustomModel(t) {
                FlowLayout(spacing: 5) {
                    if customDriver { DriverBadge(driver: t.driver, drivers: state.drivers) }
                    ModelBadge(ticket: t, state: state)
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
        // iPad: the ticket in a window of its own (Windows.swift).
        if multipleWindows && t.draft != true {
            Button("Open in New Window", systemImage: "macwindow.badge.plus") {
                WindowDirectory.shared.openTicket(TicketWindowValue(key: t.key, tab: nil), from: nil)
            }
        }
    }

    @ViewBuilder private func menuItems(_ t: Ticket, parent: Ticket?) -> some View {
        ForEach(Array(BoardScreenRules.cardMenu(t, parent: parent).enumerated()), id: \.offset) { _, item in
            switch item {
            case .discardDraft:
                Button("Discard draft", systemImage: "trash", role: .destructive) { onDiscard(t) }
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

/// The card's context menu. A launched ticket's lifts its ticket screen, on the Spec tab, as the
/// preview; a draft's lifts the card itself, as it opens in the New session editor instead.
private struct CardMenu<Items: View>: ViewModifier {
    let ticket: Ticket
    let width: CGFloat
    @ViewBuilder let items: () -> Items

    // The menu's preview is hosted outside the window's view tree and gets none of its environment
    // objects (a missing one traps), so the card hands them on.
    @Environment(AppModel.self) private var app
    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(Actions.self) private var actions
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        if ticket.draft == true {
            content.contextMenu { items() }
        } else {
            content.contextMenu { items() } preview: {
                BoardCardPreview(key: ticket.key, width: width)
                    .environment(app)
                    .environment(store)
                    .environment(router)
                    .environment(actions)
                    .environment(toasts)
                    .environment(\.palette, palette)
            }
        }
    }
}

/// The ticket's screen as the card's preview: its bar, hero and Spec tab in a navigation stack of
/// its own, about the size of the ticket sheet. Only a look: the ticket opens with a tap.
private struct BoardCardPreview: View {
    let key: String
    let width: CGFloat

    var body: some View {
        let w = min(width, 500)
        NavigationStack {
            TicketDetailScreen(key: key, initialTab: .spec)
        }
        .frame(width: w, height: min(w * 1.45, 640))
        .allowsHitTesting(false)
    }
}

/// A launched ticket's card drags out into its ticket window; a draft's doesn't drag.
private struct CardDrag: ViewModifier {
    let ticket: Ticket

    func body(content: Content) -> some View {
        if ticket.draft == true {
            content
        } else {
            content.tearOffDrag(TicketWindowValue(key: ticket.key, tab: nil))
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
