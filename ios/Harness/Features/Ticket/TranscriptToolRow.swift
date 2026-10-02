import HarnessKit
import SwiftUI
import UIKit

/// A tool call with its result: chevron, icon, short name, a mono preview of the
/// input and a spinner, ✓ or ✗. Expanded, it shows the input as JSON and the output (text pretty
/// printed and capped, images inline). A call that started a sub-agent links to its transcript.
struct TranscriptToolRow: View {
    let call: TranscriptEntry?
    let result: TranscriptEntry?
    /// The sub-agent this call started, when it started one
    let agent: Subagent?

    @Environment(\.palette) private var c
    @Environment(\.ticketDetailOpenTab) private var openTab
    @State private var open = false

    var body: some View {
        let name = TranscriptLogic.toolName(call: call, result: result)
        let input: JSONValue? = if case let .toolCall(_, _, input)? = call?.content { input } else { nil }
        let preview = input.map { Format.toolPreview(name, input: $0) } ?? ""
        let state = TranscriptLogic.toolState(result: result)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 7) {
                    Icon(open ? "chevronDown" : "chevronRight", size: 12).foregroundStyle(c.text3)
                    Icon(Format.toolIcon(name).rawValue, size: 13).foregroundStyle(c.text2)
                    Text(name).font(.mono(13, weight: .semibold)).foregroundStyle(c.text)
                    Text(preview).font(.mono(12.5)).foregroundStyle(c.text3).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
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
                        Icon("bot", size: 13).foregroundStyle(c.text2)
                        Text("\(Subagents.title(agent)) · \(Subagents.statusLabel(agent.status))")
                            .font(.scaled(size: 13)).foregroundStyle(c.text2).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text("Transcript").font(.scaled(size: 13)).foregroundStyle(c.accent)
                        Icon("chevronRight", size: 12).foregroundStyle(c.accent)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .contentShape(.rect)
                }
                .buttonStyle(TranscriptPressedRowStyle())
                .overlay(alignment: .top) { Rectangle().fill(c.border).frame(height: 1 / 3) }
                .accessibilityLabel("Open \(Subagents.title(agent))'s transcript")
                .accessibilityAddTraits(.isLink)
            }

            if open {
                VStack(alignment: .leading, spacing: 6) {
                    if let input {
                        TranscriptLabel("Input")
                        TranscriptCodeBox(text: TranscriptLogic.inputJSON(input))
                    }
                    if case let .toolResult(_, _, output, isError)? = result?.content {
                        TranscriptLabel(isError ? "Error" : "Output")
                        TranscriptToolOutput(output: output)
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
struct TranscriptCodeBox: View {
    let text: String
    @Environment(\.palette) private var c
    @State private var height: CGFloat = 0

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Text(text).font(.mono(12)).lineSpacing(3).foregroundStyle(c.text).textSelection(.enabled)
                .fixedSize()
                .padding(8)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(max(height, 1), 320))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(c.bgSunken, in: .rect(cornerRadius: 6))
    }
}

/// A tool result's blocks: text (pretty printed when it's JSON, capped) and inline images.
struct TranscriptToolOutput: View {
    let output: [ToolResultContent]
    @Environment(\.palette) private var c

    var body: some View {
        if output.isEmpty {
            Text("(no output)").font(.scaled(size: 15)).foregroundStyle(c.text3)
        } else {
            ForEach(output.indices, id: \.self) { i in
                switch output[i] {
                case let .text(text): TranscriptCodeBox(text: Format.formatMaybeJson(text, max: TranscriptLogic.outputLimit))
                case let .image(data, _): TranscriptOutputImage(base64: data)
                case .unknown: EmptyView()
                }
            }
        }
    }
}

/// A base64 image from a tool result, decoded off the main thread once.
struct TranscriptOutputImage: View {
    let base64: String
    @State private var image: UIImage?
    @Environment(\.palette) private var c

    var body: some View {
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
        .accessibilityElement()
        .accessibilityLabel("Tool output image")
        .task(id: base64) {
            let data = base64
            image = await Task.detached { Data(base64Encoded: data, options: .ignoreUnknownCharacters).flatMap(UIImage.init(data:)) }.value
        }
    }
}
