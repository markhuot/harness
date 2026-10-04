import HarnessKit
import SwiftUI
import UIKit

// The transcript's rows: messages, thinking, status dividers and permission decisions, errors, and tool calls
// with their results.

/// "3:04 PM": the locale's short time.
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
        case let .text(text, attachments, annotations) where entry.role == .user:
            VStack(alignment: .trailing, spacing: 4) {
                TranscriptWho(icon: "user", label: "You", time: time)
                // A message of only attachments has no bubble.
                if !TicketDetailLogic.trim(text).isEmpty || (attachments ?? []).isEmpty {
                    // Shrinks to fit a short message; a table or code block needs a definite width.
                    TranscriptBubbleWidth(fraction: 0.92, fill: MarkdownView.scrollsSideways(text)) {
                        MarkdownView(text: text)
                            .padding(11)
                            .background(c.accentSoft, in: UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14, bottomTrailingRadius: 14, topTrailingRadius: 4))
                    }
                }
                if let attachments, !attachments.isEmpty {
                    TranscriptMessageAttachments(entryId: entry.id, list: attachments, annotations: annotations)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        case let .text(text, _, _) where entry.role == .system:
            MarkdownView(text: text, size: 13.5, color: c.text2).padding(.horizontal, 6)
        case let .text(text, _, _):
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

/// The files sent with a message, under its bubble: the shared read-only list (thumbnails, a
/// missing state once a file is gone from the Mac), images opening full screen and other files in
/// Quick Look, served from GET /transcript/:entryId/attachments/:index. An image sent with
/// numbered notes (MessageBody.annotations) gets a compact "3 notes" disclosure under the list that
/// opens to the numbered notes.
struct TranscriptMessageAttachments: View {
    let entryId: String
    let list: [PromptAttachment]
    var annotations: [MessageAnnotation]?

    @Environment(\.palette) private var c
    @State private var downloading = false

    var body: some View {
        let tiles = list.enumerated().map { i, a in
            PromptAttachmentTile(attachment: a, index: i, remote: .message(entryId: entryId, index: i))
        }
        let notes = Annotations.byAttachment(annotations, attachments: list.count).sorted { $0.key < $1.key }
        VStack(alignment: .leading, spacing: 2) {
            OpenablePromptAttachmentList(tiles: tiles, downloading: $downloading)
            ForEach(notes, id: \.key) { index, annotation in
                TranscriptAnnotationNotes(name: list[index].name, annotation: annotation, named: list.count > 1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(c.accentSoft.opacity(0.5), in: .rect(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .topTrailing) {
            if downloading { ProgressView().controlSize(.mini).padding(6) }
        }
        .frame(maxWidth: 320)
    }
}

/// "3 notes" (with the image's name when the message had several files); tapping it lists each
/// number with its note.
struct TranscriptAnnotationNotes: View {
    let name: String
    let annotation: MessageAnnotation
    let named: Bool

    @Environment(\.palette) private var c
    @State private var open = false

    var body: some View {
        let label = Annotations.notesLabel(annotation.marks.count)
        VStack(alignment: .leading, spacing: 6) {
            Button {
                haptic(.select)
                withAnimation(.easeOut(duration: 0.18)) { open.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Image(systemName: "pencil.and.scribble").font(.system(size: 11, weight: .semibold))
                    Text(named ? "\(label) on \(name)" : label)
                        .font(.scaled(size: 12.5, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .foregroundStyle(c.accentText)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(named ? "\(label) on \(name)" : label)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(annotation.marks, id: \.n) { m in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\(m.n)")
                                .font(.scaled(size: 11, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 20, height: 20)
                                .background(c.accent, in: .circle)
                                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                            Text(m.message.isEmpty ? "(no note)" : m.message)
                                .font(.scaled(size: 13.5))
                                .foregroundStyle(m.message.isEmpty ? c.text3 : c.text)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.bottom, 6)
                .transition(.opacity)
            }
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
