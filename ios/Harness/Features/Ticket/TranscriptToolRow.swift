import HarnessKit
import SwiftUI
import UIKit

/// A tool call with its result: chevron, icon, short name, a mono preview of the
/// input and a spinner, ✓ or ✗. Expanded, it shows the input as JSON and the output (text pretty
/// printed and capped, images inline). A call that started a sub-agent links to its transcript, one
/// that left a background task running to its output.
struct TranscriptToolRow: View {
    let call: TranscriptEntry?
    let result: TranscriptEntry?
    /// The sub-agent or background task this call started, when it started one
    let agent: Subagent?

    @Environment(\.palette) private var c
    @Environment(\.ticketDetailOpenTab) private var openTab
    @State private var open = false

    var body: some View {
        let name = TranscriptLogic.toolName(call: call, result: result)
        let input: JSONValue? = if case let .toolCall(_, _, input)? = call?.content { input } else { nil }
        let label = input.map { Format.toolLabel(name, input: $0) } ?? Format.ToolLabel(label: "", detail: "")
        let state = TranscriptLogic.toolState(result: result)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 7) {
                    Icon(open ? "chevronDown" : "chevronRight", size: 12).foregroundStyle(c.text3)
                    Icon(Format.toolIcon(name).rawValue, size: 13).foregroundStyle(c.text2)
                    Text(name).font(.mono(13, weight: .semibold)).foregroundStyle(c.text)
                    (Text(label.label) + Text(label.detail.isEmpty ? "" : " " + label.detail).foregroundColor(c.text3.opacity(0.6)))
                        .font(.mono(12.5)).foregroundStyle(c.text3).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ToolElapsed(call: call, result: result)
                    switch state {
                    case .running: Spinner().controlSize(.small)
                    case .failed: Icon("x", size: 13, weight: .bold).foregroundStyle(c.red)
                    case .ok: Icon("check", size: 13, weight: .bold).foregroundStyle(c.green)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Expanded" : "Collapsed")

            if let agent, let openTab {
                Button {
                    openTab(Tabs.subagentTabRoute(agent.id))
                } label: {
                    HStack(spacing: 7) {
                        Icon(Subagents.isTask(agent) ? "terminal" : "bot", size: 13).foregroundStyle(c.text2)
                        Text("\(Subagents.title(agent)) · \(Subagents.statusLabel(agent.status))")
                            .font(.scaled(size: 13)).foregroundStyle(c.text2).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(Subagents.openLabel(agent)).font(.scaled(size: 13)).foregroundStyle(c.accent)
                        Icon("chevronRight", size: 12).foregroundStyle(c.accent)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .contentShape(.rect)
                }
                .buttonStyle(TranscriptPressedRowStyle())
                .overlay(alignment: .top) { Rectangle().fill(c.border).frame(height: 1 / 3) }
                .accessibilityLabel("\(Subagents.openLabel(agent)): \(Subagents.title(agent))")
                .accessibilityAddTraits(.isLink)
            }

            if open {
                VStack(alignment: .leading, spacing: 6) {
                    if let input {
                        TranscriptLabel("Input")
                        TranscriptCodeBox(text: TranscriptLogic.inputJSON(input))
                    }
                    if case let .toolResult(callId, _, output, isError)? = result?.content {
                        TranscriptLabel(isError ? "Error" : "Output")
                        TranscriptToolOutput(callId: callId, tool: name, output: output)
                    } else {
                        Text("Running…").font(.scaled(size: 15)).foregroundStyle(c.text3)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .top) { Rectangle().fill(c.border).frame(height: 1 / 3) }
            }
        }
        .background(c.bgElev)
        .clipShape(.rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(state == .failed ? c.red : c.border, lineWidth: 1 / 3))
    }
}

/// A tappable row that tints while pressed (`bgHover`).
struct TranscriptPressedRowStyle: ButtonStyle {
    @Environment(\.palette) private var c

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? c.bgHover : .clear)
    }
}

/// "INPUT" / "OUTPUT" over a code box.
struct TranscriptLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    @Environment(\.palette) private var c

    var body: some View {
        Text(text.uppercased()).font(.scaled(size: 11.5, weight: .semibold)).foregroundStyle(c.text3)
    }
}

/// Mono text on the sunken surface, scrolling sideways, and down once it's taller than 320 pt.
///
/// Two single-axis scroll views, never one that scrolls both ways: a two-axis one has no
/// direction lock, so a drag that starts on it takes the gesture from the transcript and slides
/// the text sideways and down together. A sideways scroll view lets vertical drags through to the
/// transcript, and the vertical one around it exists only when there's something to scroll.
struct TranscriptCodeBox: View {
    let text: String
    @Environment(\.palette) private var c
    @State private var height: CGFloat = 0

    static let maxHeight: CGFloat = 320
    static let lineSpacing: CGFloat = 3

    var body: some View {
        Group {
            if height > Self.maxHeight {
                ScrollView(.vertical) { sideways }
            } else {
                sideways
            }
        }
        .frame(height: min(max(height, 1), Self.maxHeight))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.bgSunken, in: .rect(cornerRadius: 6))
        .clipShape(.rect(cornerRadius: 6))
    }

    private var sideways: some View {
        ScrollView(.horizontal) {
            // A Text per run of lines, very long lines broken (TranscriptLogic.codeChunks): a Text
            // hundreds of lines tall or thousands of characters wide shows blank.
            let chunks = TranscriptLogic.codeChunks(text)
            VStack(alignment: .leading, spacing: Self.lineSpacing) {
                ForEach(chunks.indices, id: \.self) { i in
                    Text(chunks[i]).font(.mono(12)).lineSpacing(Self.lineSpacing).foregroundStyle(c.text).textSelection(.enabled)
                        .fixedSize()
                }
            }
            .padding(8)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }
}

/// A tool result's blocks: text (pretty printed when it's JSON, capped) and inline images. A tap on
/// an image opens the attachment viewer over the result's images.
struct TranscriptToolOutput: View {
    let callId: String
    let tool: String
    let output: [ToolResultContent]
    @State private var viewing: AttachmentViewerStart?
    @Environment(\.palette) private var c

    var body: some View {
        if output.isEmpty {
            Text("(no output)").font(.scaled(size: 15)).foregroundStyle(c.text3)
        } else {
            let media = Attachments.toolOutputMedia(callId: callId, tool: tool, output: output)
            // One stack, so the cover below attaches once rather than to every block.
            VStack(alignment: .leading, spacing: 6) {
                ForEach(output.indices, id: \.self) { i in
                    switch output[i] {
                    case let .text(text): TranscriptCodeBox(text: Format.formatMaybeJson(text, max: TranscriptLogic.outputLimit))
                    case let .image(data, _):
                        if let n = media.firstIndex(where: { $0.at == i }) {
                            TranscriptOutputImage(base64: data, url: media[n].url) {
                                var t = Transaction()
                                t.disablesAnimations = true
                                withTransaction(t) { viewing = AttachmentViewerStart(index: n) }
                            }
                        }
                    case .unknown: EmptyView()
                    }
                }
            }
            .fullScreenCover(item: $viewing) { start in
                AttachmentViewer(attachments: media.map(\.attachment), start: start.index, url: { a in media.first { $0.attachment.id == a.id }?.url }) {
                    var t = Transaction()
                    t.disablesAnimations = true
                    withTransaction(t) { viewing = nil }
                }
            }
        }
    }
}

/// A base64 image from a tool result, decoded off the main thread once. The decoded image goes in
/// the attachment cache under its data: URL, so the viewer shows it without decoding it again.
struct TranscriptOutputImage: View {
    let base64: String
    /// Its data: URL, the viewer's key for it
    let url: String
    let onOpen: () -> Void
    @State private var image: UIImage?
    @Environment(\.palette) private var c

    var body: some View {
        Button(action: onOpen) {
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                } else {
                    c.bgSunken
                }
            }
            .frame(maxWidth: .infinity)
            .aspectRatio(16 / 10, contentMode: .fit)
            .clipShape(.rect(cornerRadius: 6))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Tool output image")
        .accessibilityHint("Opens it full screen")
        .task(id: url) {
            if let hit = AttachmentMedia.shared.cached(url) {
                image = hit
                return
            }
            let data = base64
            guard let decoded = await Task.detached(operation: { Data(base64Encoded: data, options: .ignoreUnknownCharacters).flatMap(UIImage.init(data:)) }).value else { return }
            AttachmentMedia.shared.seed(decoded, url: url)
            image = decoded
        }
    }
}

/// A tool call's elapsed time, right-aligned before the spinner or ✓/✗. It counts up every second
/// while the call runs, in its own `TimelineView` so the row's equality check and the list around
/// it don't re-render, and stops at the result's time once it lands.
private struct ToolElapsed: View {
    let call: TranscriptEntry?
    let result: TranscriptEntry?

    @Environment(\.palette) private var c

    var body: some View {
        if call != nil {
            TimelineView(.periodic(from: .now, by: result == nil ? 1 : 3600)) { ctx in
                if let text = Format.toolElapsed(call: call, result: result, now: ctx.date.timeIntervalSince1970 * 1000) {
                    Text(text).font(.mono(11)).monospacedDigit().foregroundStyle(c.text3).lineLimit(1)
                        .accessibilityIdentifier("tool-elapsed")
                }
            }
        }
    }
}
