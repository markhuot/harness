import HarnessKit
import SwiftUI

/// One background task (the `agent:<id>` tab of a Bash command or Monitor the agent left running):
/// back to Agents & tasks, its status, title and kind, the command, and its output as polled from
/// GET …/subagents/:id/output. The output reads the tail first, then on from where it ended every
/// Subagents.taskOutputPollMs while the task runs, once more when it finishes, and stops when the
/// view goes away. The pane follows new output while the user is at the bottom.
struct TaskOutputView: View {
    let ticket: Ticket
    let subagentId: String

    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @Environment(\.ticketDetailOpenTab) private var openTab
    @State private var error: String?

    var body: some View {
        let state = store.state
        let task = state.subagentById(ticket.sessionId, subagentId)
        let output = state.taskOutputOf(ticket.sessionId, subagentId)
        let running = task?.status == .running
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 7) {
                breadcrumb(state.subagentPath(ticket.sessionId, subagentId))
                if let task {
                    NowReader(interval: running ? .live : .standard) { now in
                        HStack(spacing: 8) {
                            AgentsStatusMark(status: task.status)
                            Text(Subagents.title(task)).font(.scaled(size: 16, weight: .semibold)).foregroundStyle(c.text).lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text("\(Subagents.statusLabel(task.status)) · \(Subagents.duration(task, now: now))")
                                .font(.scaled(size: 12.5).monospacedDigit()).foregroundStyle(c.text3)
                        }
                    }
                    if let type = Subagents.typeLabel(task) { AgentsTypeBadge(type: type) }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { Rectangle().fill(c.border).frame(height: 1 / 3) }

            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if let command = task?.command.optional, !command.isEmpty {
                        TranscriptLabel("Command")
                        TranscriptCodeBox(text: command)
                            .padding(.bottom, 6)
                    }
                    TranscriptLabel("Output")
                    if let error {
                        HStack(alignment: .top, spacing: 6) {
                            Icon("alert", size: 14).foregroundStyle(c.red)
                            Text("Couldn't load the output: \(error)").font(.scaled(size: 15)).foregroundStyle(c.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(10)
                        .background(c.redSoft, in: .rect(cornerRadius: 8))
                    }
                    pane(output, running: running)
                    if !running, let result = task?.result, !result.isEmpty {
                        TranscriptLabel("Result").padding(.top, 6)
                        Text(result).font(.scaled(size: 14)).foregroundStyle(c.text2).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(14)
                .padding(.bottom, 10)
            }
            .ticketStickToBottom()
            .ticketHeroScroll()
        }
        .task(id: "\(ticket.sessionId)/\(subagentId)/\(store.epoch)") { await poll() }
    }

    /// The output so far in a mono pane, or what stands in for it.
    @ViewBuilder private func pane(_ output: TaskOutputState?, running: Bool) -> some View {
        if let note = AgentsLogic.outputNote(output, running: running) {
            Text(note).font(.scaled(size: 15)).foregroundStyle(c.text3)
        } else if let output {
            if output.truncated {
                Text(AgentsLogic.truncatedNote).font(.scaled(size: 13)).foregroundStyle(c.text3)
            }
            // The output's last line break would show as an empty line.
            Text(output.text.hasSuffix("\n") ? String(output.text.dropLast()) : output.text)
                .font(.mono(12)).lineSpacing(3).foregroundStyle(c.text).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(c.bgSunken, in: .rect(cornerRadius: 8))
        } else if error == nil {
            Spinner().padding(30).frame(maxWidth: .infinity)
        }
    }

    private func breadcrumb(_ path: [Subagent]) -> some View {
        let back = Tabs.tabLabel[.agents] ?? "Agents & tasks"
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                Button {
                    openTab?(.agents)
                } label: {
                    HStack(spacing: 3) {
                        Icon("chevronLeft", size: 14).foregroundStyle(c.accent)
                        Text(back).font(.scaled(size: 14.5)).foregroundStyle(c.accent)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to \(back)")
                // A task a sub-agent started sits under it.
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

    /// Reads until the task is done: whether to read again is decided before each read, so a
    /// status that flips to finished between reads still gets one last read.
    private func poll() async {
        let sessionId = ticket.sessionId, id = subagentId
        while !Task.isCancelled {
            let more = AgentsLogic.keepsPolling(store.state.subagentById(sessionId, id)?.status, store.state.taskOutputOf(sessionId, id))
            await read(sessionId, id)
            guard more else { return }
            do {
                try await Task.sleep(for: .milliseconds(Int(Subagents.taskOutputPollMs)))
            } catch {
                return
            }
        }
    }

    private func read(_ sessionId: String, _ id: String) async {
        do {
            // A dead client is an error to show, not output that never loads.
            let offset = AgentsLogic.pollOffset(store.state.taskOutputOf(sessionId, id))
            let output = try await store.connectedAPI().taskOutput(sessionId, subagentId: id, offset: offset)
            guard !Task.isCancelled else { return }
            error = nil
            store.dispatch(.taskOutput(sessionId: sessionId, subagentId: id, output: output))
        } catch {
            guard !Task.isCancelled else { return }
            self.error = Connection.describeError(error)
        }
    }
}
