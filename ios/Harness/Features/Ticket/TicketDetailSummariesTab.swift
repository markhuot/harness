import HarnessKit
import SwiftUI

/// The Summaries tab: the brief (the plan while planning), what the
/// ticket depends on, and the summaries its agent and humans posted, newest last. It opens scrolled
/// to the newest and follows new ones until the user scrolls up.
struct TicketDetailSummariesTab: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c

    var body: some View {
        let state = store.state
        let list = state.summaries[ticket.sessionId] ?? []
        let deps = state.dependencyStates(ticket)
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !ticket.description.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionTitle(ticket.status == .planning ? "Plan" : "Brief")
                        MarkdownView(text: ticket.description)
                    }
                    .padding(13)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(c.bgElev, in: .rect(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.border, lineWidth: 1 / 3))
                }
                if !deps.isEmpty {
                    FlowLayout(spacing: 6) {
                        SectionTitle("Depends on")
                        ForEach(deps, id: \.key) { d in
                            let opens = Related.depOpens(key: d.key, missing: d.missing, byRemoteKey: store.related.byRemoteKey)
                            DepChip(label: d.ticket.map { Keys.keyLabel($0) } ?? d.key, done: d.done, unknown: d.state == .unknown,
                                    onTap: opens ? { router.push(.ticket(key: d.ticket?.key ?? d.key, tab: nil)) } : nil)
                        }
                    }
                }
                if list.isEmpty {
                    EmptyState(icon: "fileText", title: "No summaries yet", message: "The agent posts short progress updates here as it works.")
                } else {
                    NowReader { now in
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(list) { s in TicketDetailSummaryRow(summary: s, now: now) }
                        }
                    }
                }
            }
            .padding(14)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .ticketStickToBottom()
        .ticketHeroScroll()
    }
}

/// One summary: the author's avatar, who and when, the markdown and its attachments.
private struct TicketDetailSummaryRow: View {
    let summary: Summary
    let now: Double

    @Environment(\.palette) private var c

    var body: some View {
        let (icon, fill, ink): (String, Color, Color) = switch summary.author {
        case .human: ("user", c.bgActive, c.text2)
        case .agent: ("sparkle", c.accentSoft, c.accent)
        default: ("zap", c.amberSoft, c.amber)
        }
        HStack(alignment: .top, spacing: 10) {
            Icon(icon, size: 12, weight: .semibold)
                .foregroundStyle(ink)
                .frame(width: 26, height: 26)
                .background(fill, in: .circle)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(TicketDetailLogic.authorLabel(summary.author)).font(.scaled(size: 14, weight: .semibold)).foregroundStyle(c.text)
                    Text(Format.relativeTime(summary.createdAt, now: now)).font(.scaled(size: 12.5)).foregroundStyle(c.text3)
                }
                MarkdownView(text: summary.body)
                if !summary.attachments.isEmpty { AttachmentRow(attachments: summary.attachments) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
