import HarnessKit
import SwiftUI
import UIKit

// The transcript's rows (screens/Transcript.tsx RowView, EntryRow, Thinking, PermissionRow,
// ToolRow): messages, thinking, status dividers and permission decisions, errors, and tool calls
// with their results.

/// "3:04 PM" (RN `toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })`).
func transcriptTime(_ ms: Double) -> String {
    Date(timeIntervalSince1970: ms / 1000).formatted(date: .omitted, time: .shortened)
}

/// One row. Equatable on its inputs, so a re-render for a streaming delta skips the rows it didn't change.
struct TranscriptRowView: View, Equatable {
    let row: TranscriptLogic.Row
    let who: String
    /// The sub-agent a tool row's call started
    let agent: Subagent?

    @Environment(\.palette) private var c

    nonisolated static func == (a: Self, b: Self) -> Bool {
        a.row == b.row && a.who == b.who && a.agent == b.agent
    }

    var body: some View {
        switch row {
        case let .item(.tool(call, result)):
            TranscriptToolRow(call: call, result: result, agent: agent)
        case let .item(.entry(entry)):
            TranscriptEntryRow(entry: entry, who: who)
        case let .delta(_, text):
            VStack(alignment: .leading, spacing: 4) {
                TranscriptWho(icon: "sparkle", label: "Agent")
                Text("\(text)\(Text("▍").foregroundStyle(c.accent))")
                    .font(.scaled(size: 15))
                    .foregroundStyle(c.text)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .working:
            HStack(spacing: 8) {
                Spinner()
                Text("Working…").font(.scaled(size: 14)).foregroundStyle(c.text3)
            }
            .padding(.vertical, 4)
        }
    }
}

/// "✦ Agent 3:04 PM" over a message.
struct TranscriptWho: View {
    let icon: String
    let label: String
    var time: String?

    @Environment(\.palette) private var c

    var body: some View {
        HStack(spacing: 5) {
            Icon(icon, size: 12, weight: .semibold).foregroundStyle(icon == "sparkle" ? c.accent : c.text2)
            Text(label).font(.scaled(size: 12.5, weight: .semibold)).foregroundStyle(c.text2)
            if let time { Text(time).font(.scaled(size: 12)).foregroundStyle(c.text3) }
        }
    }
}

struct TranscriptEntryRow: View {
    let entry: TranscriptEntry
    let who: String

    @Environment(\.palette) private var c

    var body: some View {
        let time = transcriptTime(entry.createdAt)
        switch entry.content {
        case let .text(text) where entry.role == .user:
            VStack(alignment: .trailing, spacing: 4) {
                TranscriptWho(icon: "user", label: "You", time: time)
                // Shrinks to fit a short message; a table or code block needs a definite width.
                TranscriptBubbleWidth(fraction: 0.92, fill: MarkdownView.scrollsSideways(text)) {
                    MarkdownView(text: text)
                        .padding(11)
                        .background(c.accentSoft, in: UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14, bottomTrailingRadius: 14, topTrailingRadius: 4))
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        case let .text(text) where entry.role == .system:
            MarkdownView(text: text, size: 13.5, color: c.text2).padding(.horizontal, 6)
        case let .text(text):
            VStack(alignment: .leading, spacing: 4) {
                TranscriptWho(icon: "sparkle", label: who, time: time)
                MarkdownView(text: text)
            }
        case let .thinking(text):
            TranscriptThinking(text: text)
        case let .status(text, permission):
            if let permission {
                TranscriptPermissionRow(log: permission, time: time)
            } else {
                HStack(spacing: 8) {
                    Rectangle().fill(c.border).frame(height: 1 / 3).frame(maxWidth: .infinity)
                    Text("\(text) · \(time)").font(.scaled(size: 12)).foregroundStyle(c.text3).multilineTextAlignment(.center)
                        .layoutPriority(1)
                    Rectangle().fill(c.border).frame(height: 1 / 3).frame(maxWidth: .infinity)
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            }
        case let .error(text):
            HStack(alignment: .top, spacing: 8) {
                Icon("alert", size: 14, weight: .semibold).foregroundStyle(c.red)
                Text(text).font(.scaled(size: 14)).foregroundStyle(c.red).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .background(c.redSoft, in: .rect(cornerRadius: 8))
        case .toolResult:
            TranscriptToolRow(call: nil, result: entry, agent: nil)
        case .toolCall, .unknown:
            EmptyView()
        }
    }
}

/// Sizes a bubble to its content, up to `fraction` of the row (`maxWidth: "92%"`), or exactly that
/// when `fill` (a table or code block, which scrolls sideways inside a definite width).
struct TranscriptBubbleWidth: Layout {
    var fraction: CGFloat
    var fill: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        let width = width(for: view, proposal: proposal)
        return CGSize(width: width, height: view.sizeThatFits(ProposedViewSize(width: width, height: nil)).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }

    private func width(for view: LayoutSubview, proposal: ProposedViewSize) -> CGFloat {
        let most = (proposal.width ?? 360) * fraction
        if fill { return most }
        return min(view.sizeThatFits(.unspecified).width, most)
    }
}

/// A collapsible italic "Thinking" with a one-line preview.
struct TranscriptThinking: View {
    let text: String
    @State private var open = false
    @Environment(\.palette) private var c

    var body: some View {
        Button {
            open.toggle()
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    Icon(open ? "chevronDown" : "chevronRight", size: 12).foregroundStyle(c.text3)
                    Text("Thinking").font(.scaled(size: 13).italic()).foregroundStyle(c.text3)
                    if !open {
                        Text(text).font(.scaled(size: 13)).foregroundStyle(c.text3).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if open {
                    Text(text).font(.scaled(size: 13.5)).foregroundStyle(c.text2).lineSpacing(5).textSelection(.enabled)
                        .padding(.leading, 17)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityValue(open ? "Expanded" : "Collapsed")
    }
}

/// A permission decision on the transcript: shield, the decision's colored edge, verb, the input's
/// summary, the reason and "source · mode mode · time".
struct TranscriptPermissionRow: View {
    let log: PermissionDecisionLog
    var time: String?

    @Environment(\.palette) private var c

    var body: some View {
        let color: Color = switch TranscriptLogic.decisionTone(log.decision) {
        case .green: c.green
        case .amber: c.amber
        case .red: c.red
        }
        let verb = Format.permissionVerb(log)
        HStack(alignment: .top, spacing: 8) {
            Icon("shield", size: 12, weight: .semibold).foregroundStyle(color).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(Text(verb).fontWeight(.semibold).foregroundStyle(color)) \(Text(log.summary).font(.mono(12.5)))")
                    .font(.scaled(size: 13))
                    .foregroundStyle(c.text)
                if !log.reason.isEmpty {
                    Text(log.reason).font(.scaled(size: 12.5)).foregroundStyle(c.text2)
                }
                Text(TranscriptLogic.permissionFooter(log, time: time)).font(.scaled(size: 11.5)).foregroundStyle(c.text3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(9)
        .background(c.bgSunken)
        .overlay(alignment: .leading) { Rectangle().fill(color).frame(width: 2) }
        .clipShape(.rect(cornerRadius: 8))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(verb): \(log.summary)")
    }
}
