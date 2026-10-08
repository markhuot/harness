import HarnessKit
import SwiftUI

/// The ticket's Agents & tasks tab: the sub-agents its agent started inside its session and the
/// background tasks (Bash commands, Monitors) it left running, in one list, the latest updated
/// first. A row opens its `agent:<id>` tab on the hosting ticket screen: a sub-agent's transcript
/// (SubagentView) or a task's output (TaskOutputView). Only shown once the session has any
/// (Tabs.effectiveTab falls back to the Spec until then). The Agents and Tasks toggles above the
/// list narrow it to one kind; both or neither show everything (Subagents.filter), as on the Mac.
struct AgentsTabView: View {
    let ticket: Ticket

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @Environment(\.ticketDetailOpenTab) private var openTab

    var body: some View {
        let state = store.state
        let list = AgentsLogic.list(state.subagentsOf(ticket.sessionId) ?? [])
        let counts = Subagents.counts(list)
        let filter = AgentsFilters.shared.filter(ticket.sessionId)
        let shown = Subagents.filter(list, filter)
        let running = shown.contains { $0.status == .running }
        VStack(spacing: 0) {
            AgentsFilterBar(filter: filter, counts: counts) { AgentsFilters.shared.set(ticket.sessionId, $0) }
            ScrollView {
                TimelineView(.periodic(from: .now, by: AgentsLogic.tickSeconds(running: running))) { ctx in
                    let now = ctx.date.timeIntervalSince1970 * 1000
                    VStack(alignment: .leading, spacing: 16) {
                        if !shown.isEmpty {
                            Card {
                                ForEach(Array(shown.enumerated()), id: \.element.id) { i, a in
                                    AgentsRow(agent: a, parent: a.parentId.flatMap { state.subagentById(ticket.sessionId, $0) }, now: now, first: i == 0) {
                                        openTab?(Tabs.subagentTabRoute(a.id))
                                    }
                                }
                            }
                        } else if !list.isEmpty {
                            Text(AgentsLogic.emptyNote(filter))
                                .font(.scaled(size: 13.5)).foregroundStyle(c.text3)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 32)
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
}

/// Each session's Agents & tasks filter, kept while the app runs so opening a row and coming back
/// (which rebuilds the tab) doesn't reset it. Not saved across launches: it's a quick view, not a preference.
@MainActor @Observable
final class AgentsFilters {
    static let shared = AgentsFilters()

    private var bySession: [String: Subagents.Filter] = [:]

    func filter(_ sessionId: String) -> Subagents.Filter { bySession[sessionId] ?? Subagents.Filter() }

    func set(_ sessionId: String, _ filter: Subagents.Filter) { bySession[sessionId] = filter }
}

/// The Agents and Tasks toggles, each with its count ("Agents 15"), pinned above the list.
private struct AgentsFilterBar: View {
    let filter: Subagents.Filter
    let counts: Subagents.Counts
    let onChange: (Subagents.Filter) -> Void

    var body: some View {
        HStack(spacing: 8) {
            AgentsFilterChip(label: "Agents", count: counts.agents, on: filter.agents) {
                onChange(Subagents.Filter(agents: !filter.agents, tasks: filter.tasks))
            }
            AgentsFilterChip(label: "Tasks", count: counts.tasks, on: filter.tasks) {
                onChange(Subagents.Filter(agents: filter.agents, tasks: !filter.tasks))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Show agents, tasks or both")
    }
}

/// A capsule toggle like the board's status chips: filled and outlined while pressed.
private struct AgentsFilterChip: View {
    let label: String
    let count: Int
    let on: Bool
    let onTap: () -> Void

    @Environment(\.palette) private var c

    var body: some View {
        Button {
            haptic(.select)
            onTap()
        } label: {
            HStack(spacing: 6) {
                Text(label)
                    .font(.scaled(size: 14, weight: on ? .semibold : .medium))
                    .foregroundStyle(on ? c.text : c.text2)
                Text("\(count)")
                    .font(.scaled(size: 13))
                    .monospacedDigit()
                    .foregroundStyle(c.text3)
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(on ? c.bgElev : .clear, in: .capsule)
            .overlay(Capsule().strokeBorder(c.border, lineWidth: on ? 1 / 3 : 0.5))
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label), \(count)")
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

/// A sub-agent's or task's status: a spinner while it runs, else check / x / stop on its tone.
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

/// The type chip ("Explore", or "Bash" / "Monitor" for a task), mono on an outlined badge.
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

/// The model a sub-agent runs on ("Haiku 4.5"), like the ticket's model badge; nothing until the
/// driver has said, and never for a task.
struct AgentsModelBadge: View {
    let agent: Subagent

    var body: some View {
        if let label = Subagents.modelLabel(agent) {
            Badge(label, outline: true, icon: "layers")
                .accessibilityLabel("Model \(label)")
        }
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
        let model = Subagents.modelLabel(a)
        let preview = AgentsLogic.preview(a)
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    AgentsStatusMark(status: a.status)
                    Text(Subagents.title(a)).font(.scaled(size: 14.5, weight: .medium))
                        .foregroundStyle(a.status == .running ? c.text : c.text2).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(Subagents.duration(a, now: now)).font(.scaled(size: 12.5).monospacedDigit()).foregroundStyle(c.text3)
                    Icon("chevronRight", size: 13).foregroundStyle(c.text3)
                }
                if !preview.isEmpty {
                    // A task's command (or its result) is shell text, not markdown.
                    Group {
                        if Subagents.isTask(a) {
                            Text(preview).font(.mono(12.5))
                        } else {
                            Text(Markdown.plainText(preview)).font(.scaled(size: 13))
                        }
                    }
                    .foregroundStyle(c.text2).lineLimit(2)
                    .multilineTextAlignment(.leading)
                }
                if type != nil || model != nil || parent != nil {
                    FlowLayout(spacing: 6) {
                        if let type { AgentsTypeBadge(type: type) }
                        if model != nil { AgentsModelBadge(agent: a) }
                        if let parent {
                            Text("started by \(Subagents.title(parent))").font(.scaled(size: 12.5)).foregroundStyle(c.text3)
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
