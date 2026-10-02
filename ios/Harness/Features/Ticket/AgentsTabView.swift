import HarnessKit
import SwiftUI

/// The ticket's Agents tab (screens/AgentsTab.tsx): the sub-agents its agent started inside its
/// session, running ones first, then finished ones, newest first. A row opens the sub-agent's
/// `agent:<id>` tab on the hosting ticket screen. Only shown once the session has sub-agents
/// (Tabs.effectiveTab falls back to Summaries until then).
struct AgentsTabView: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @Environment(\.ticketDetailOpenTab) private var openTab

    var body: some View {
        let state = store.state
        let sections = AgentsLogic.sections(state.subagentsOf(ticket.sessionId) ?? [])
        let running = sections.contains { $0.id == "running" }
        ScrollView {
            TimelineView(.periodic(from: .now, by: AgentsLogic.tickSeconds(running: running))) { ctx in
                let now = ctx.date.timeIntervalSince1970 * 1000
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(sections) { s in
                        VStack(alignment: .leading, spacing: 7) {
                            HStack(spacing: 7) {
                                Text(s.label).font(.system(size: 14, weight: .semibold)).foregroundStyle(c.text)
                                Text("\(s.items.count)").font(.system(size: 13)).foregroundStyle(c.text3)
                            }
                            .padding(.horizontal, 2)
                            .accessibilityElement(children: .combine)
                            Card {
                                ForEach(Array(s.items.enumerated()), id: \.element.id) { i, a in
                                    AgentsRow(agent: a, parent: a.parentId.flatMap { state.subagentById(ticket.sessionId, $0) }, now: now, first: i == 0) {
                                        openTab?(Tabs.subagentTabRoute(a.id))
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(14)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .ticketHeroScroll()
    }
}

/// A sub-agent's status: a spinner while it runs, else check / x / stop on its tone.
struct AgentsStatusMark: View {
    let status: SubagentStatus
    @Environment(\.palette) private var c

    var body: some View {
        if status == .running {
            Spinner().controlSize(.small).frame(width: 18, height: 18)
        } else {
            let mark = AgentsLogic.mark(status)
            let t = c.tone(Tone(rawValue: mark.tone.rawValue) ?? .neutral)
            Icon(mark.icon, size: 11, weight: status == .stopped ? .semibold : .bold)
                .foregroundStyle(t.fg)
                .frame(width: 18, height: 18)
                .background(t.bg, in: .circle)
                .accessibilityElement()
                .accessibilityLabel(Subagents.statusLabel(status))
        }
    }
}

/// The agent type chip ("Explore"), mono on an outlined badge.
struct AgentsTypeBadge: View {
    let type: String
    @Environment(\.palette) private var c

    var body: some View {
        Text(type).font(.mono(11.5)).foregroundStyle(c.text2).lineLimit(1)
            .padding(.horizontal, 7)
            .frame(minHeight: 21)
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(c.border, lineWidth: 1 / 3))
    }
}

private struct AgentsRow: View {
    let agent: Subagent
    let parent: Subagent?
    let now: Double
    let first: Bool
    let onOpen: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        let a = agent
        let type = Subagents.typeLabel(a)
        let preview = AgentsLogic.preview(a)
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    AgentsStatusMark(status: a.status)
                    Text(Subagents.title(a)).font(.system(size: 14.5, weight: .medium))
                        .foregroundStyle(a.status == .running ? c.text : c.text2).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(Subagents.duration(a, now: now)).font(.system(size: 12.5).monospacedDigit()).foregroundStyle(c.text3)
                    Icon("chevronRight", size: 13).foregroundStyle(c.text3)
                }
                if !preview.isEmpty {
                    Text(Markdown.plainText(preview)).font(.system(size: 13)).foregroundStyle(c.text2).lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                if type != nil || parent != nil {
                    FlowLayout(spacing: 6) {
                        if let type { AgentsTypeBadge(type: type) }
                        if let parent {
                            Text("started by \(Subagents.title(parent))").font(.system(size: 12.5)).foregroundStyle(c.text3)
                        }
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(TranscriptPressedRowStyle())
        .overlay(alignment: .top) { if !first { Rectangle().fill(c.border).frame(height: 1 / 3) } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(AgentsLogic.rowLabel(a))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onOpen() }
    }
}
