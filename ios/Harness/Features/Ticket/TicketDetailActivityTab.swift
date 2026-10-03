import HarnessKit
import SwiftUI

/// The Activity tab: the ticket's timeline, oldest first, opening at the newest and following new
/// entries until the user scrolls up. Each kind has its own icon and look (ActivityRows): a block is
/// a card with the question, review decisions show their round and commit, an entry whose body is a
/// one-line summary can open its full text (meta.detail), messages and answers logged by older
/// services read as a conversation, and failures and the service's notes stay quiet.
struct TicketDetailActivityTab: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store

    var body: some View {
        let list = store.state.activity[ticket.sessionId] ?? []
        ScrollView {
            if list.isEmpty {
                EmptyState(icon: "clock", title: "No activity yet",
                           message: "Notes, submits, questions and review decisions show here.")
                    .padding(.top, 30)
            } else {
                NowReader { now in
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(list) { e in
                            ActivityRow(entry: e, open: ActivityRows.isOpenQuestion(e, in: list, ticket: ticket), now: now)
                        }
                    }
                }
                .padding(14)
                .padding(.bottom, 16)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .ticketStickToBottom()
        .ticketHeroScroll()
    }
}

private struct ActivityRow: View {
    let entry: ActivityEntry
    /// The ticket's current question (the newest block while it's still blocked)
    let open: Bool
    let now: Double

    @Environment(\.palette) private var c
    @State private var expanded = false

    var body: some View {
        switch ActivityRows.look(entry) {
        case .attention: blocked
        case .mine: bubble(mine: true)
        case .reply: bubble(mine: false)
        case .muted: muted
        case .approved: row(icon: c.green, fill: c.greenSoft, title: c.green)
        case .changes: row(icon: c.amber, fill: c.amberSoft, title: c.amber)
        case .plain: row(icon: c.accent, fill: c.accentSoft, title: c.text)
        }
    }

    /// The full text behind a one-line body (ActivityRows.fullText), behind a Show/Hide button.
    @ViewBuilder private var fullText: some View {
        if let text = ActivityRows.fullText(entry) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(expanded ? "Hide details" : "Show details")
                    Icon("chevronDown", size: 10, weight: .semibold).rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .font(.scaled(size: 12.5, weight: .medium))
                .foregroundStyle(c.accent)
            }
            .buttonStyle(.plain)
            if expanded {
                MarkdownView(text: text, size: 13.5, color: c.text2)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(c.bgElev, in: .rect(cornerRadius: 10))
            }
        }
    }

    private var time: String { Format.relativeTime(entry.createdAt, now: now) }

    private func heading(_ color: Color) -> some View {
        let detail = ActivityRows.detail(entry)
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(ActivityRows.heading(entry)).font(.scaled(size: 14, weight: .semibold)).foregroundStyle(color)
            if !detail.isEmpty { Text(detail).font(.mono(12)).foregroundStyle(c.text2) }
            Text(time).font(.scaled(size: 12.5)).foregroundStyle(c.text3)
        }
    }

    private func row(icon: Color, fill: Color, title: Color) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Icon(ActivityRows.icon(entry), size: 12, weight: .semibold)
                .foregroundStyle(icon)
                .frame(width: 26, height: 26)
                .background(fill, in: .circle)
            VStack(alignment: .leading, spacing: 4) {
                heading(title)
                if !TicketDetailLogic.trim(entry.body).isEmpty { MarkdownView(text: entry.body, size: 14.5) }
                fullText
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// A question for the human: loud while it's the ticket's open question, quieter once answered.
    private var blocked: some View {
        let tint = open ? c.red : c.amber
        let body = ActivityRows.body(entry)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Icon("alert", size: 14, weight: .semibold).foregroundStyle(tint)
                Text(ActivityRows.withMove(open ? ActivityRows.title(entry) : "Asked you", entry)).font(.scaled(size: 14, weight: .semibold)).foregroundStyle(tint)
                Spacer(minLength: 0)
                Text(time).font(.scaled(size: 12.5)).foregroundStyle(c.text3)
            }
            MarkdownView(text: ActivityRows.question(entry), size: 15.5)
            if !TicketDetailLogic.trim(body).isEmpty { MarkdownView(text: body, size: 14, color: c.text2) }
            if open {
                Text("Answer below. The conversation continues in the Transcript.").font(.scaled(size: 12.5)).foregroundStyle(c.text3)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(open ? c.redSoft : c.amberSoft, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(tint.opacity(open ? 0.6 : 0.3), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private func bubble(mine: Bool) -> some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
            HStack(spacing: 6) {
                if !mine { Icon("sparkle", size: 11, weight: .semibold).foregroundStyle(c.accent) }
                Text(ActivityRows.heading(entry)).font(.scaled(size: 12.5, weight: .semibold)).foregroundStyle(c.text2)
                Text(time).font(.scaled(size: 12)).foregroundStyle(c.text3)
            }
            MarkdownView(text: entry.body, size: 14.5)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(mine ? c.accentSoft : c.bgElev, in: .rect(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(mine ? .clear : c.border, lineWidth: 1 / 3))
                .frame(maxWidth: 520, alignment: mine ? .trailing : .leading)
        }
        .padding(mine ? .leading : .trailing, 36)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .accessibilityElement(children: .combine)
    }

    private var muted: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Icon(ActivityRows.icon(entry), size: 11, weight: .semibold).foregroundStyle(entry.kind == .failed ? c.red.opacity(0.8) : c.text3)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(ActivityRows.heading(entry)).font(.scaled(size: 12.5, weight: .semibold)).foregroundStyle(c.text3)
                    Text(time).font(.scaled(size: 12)).foregroundStyle(c.text3)
                }
                if !TicketDetailLogic.trim(entry.body).isEmpty { MarkdownView(text: entry.body, size: 13, color: c.text3) }
                fullText
            }
        }
        .padding(.leading, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
