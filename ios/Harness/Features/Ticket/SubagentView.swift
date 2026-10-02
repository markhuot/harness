import HarnessKit
import SwiftUI

/// One sub-agent (the `agent:<id>` tab, screens/AgentsTab.tsx SubagentView): back to the list
/// through its parents, its status, title and type, the task it was given, and its transcript.
struct SubagentView: View {
    let ticket: Ticket
    let subagentId: String

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @Environment(\.ticketDetailOpenTab) private var openTab
    @State private var promptOpen = false

    var body: some View {
        let state = store.state
        let agent = state.subagentById(ticket.sessionId, subagentId)
        let path = state.subagentPath(ticket.sessionId, subagentId)
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 7) {
                breadcrumb(path)
                if let agent {
                    NowReader(interval: agent.status == .running ? .live : .standard) { now in
                        HStack(spacing: 8) {
                            AgentsStatusMark(status: agent.status)
                            Text(Subagents.title(agent)).font(.scaled(size: 16, weight: .semibold)).foregroundStyle(c.text).lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text("\(Subagents.statusLabel(agent.status)) · \(Subagents.duration(agent, now: now))")
                                .font(.scaled(size: 12.5).monospacedDigit()).foregroundStyle(c.text3)
                        }
                    }
                    if let type = Subagents.typeLabel(agent) { AgentsTypeBadge(type: type) }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }

            TranscriptView(sessionId: ticket.sessionId, subagentId: subagentId, emptyHint: "The sub-agent's conversation will stream in here.") {
                if let prompt = agent?.prompt, !prompt.isEmpty { task(prompt) }
            }
        }
    }

    private func breadcrumb(_ path: [Subagent]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                Button {
                    openTab?(.agents)
                } label: {
                    HStack(spacing: 3) {
                        Icon("chevronLeft", size: 14).foregroundStyle(c.accent)
                        Text("Agents").font(.scaled(size: 14.5)).foregroundStyle(c.accent)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to Agents")
                ForEach(path.dropLast()) { p in
                    Button {
                        openTab?(Tabs.subagentTabRoute(p.id))
                    } label: {
                        HStack(spacing: 4) {
                            Icon("chevronRight", size: 11).foregroundStyle(c.text3)
                            Text(Subagents.title(p)).font(.scaled(size: 14.5)).foregroundStyle(c.accent).lineLimit(1)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 2)
        }
    }

    /// "Task from the agent": two lines of the prompt, or all of it as markdown when open.
    private func task(_ prompt: String) -> some View {
        Button {
            promptOpen.toggle()
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Icon(promptOpen ? "chevronDown" : "chevronRight", size: 12).foregroundStyle(c.text3)
                    Text("TASK FROM THE AGENT").font(.scaled(size: 11.5, weight: .semibold)).foregroundStyle(c.text3)
                }
                if promptOpen {
                    MarkdownView(text: prompt, size: 14)
                } else {
                    Text(Markdown.plainText(prompt)).font(.scaled(size: 14)).foregroundStyle(c.text2).lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(c.bgElev, in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.border, lineWidth: 1 / 3))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityValue(promptOpen ? "Expanded" : "Collapsed")
    }
}
