import HarnessKit
import SwiftUI

/// A summary's attachments as a horizontal thumbnail row; tapping one opens
/// the full-screen viewer there. Sizing, paging and swipe math live in HarnessKit's Attachments.
struct AttachmentRow: View {
    let attachments: [SummaryAttachment]

    @State private var open: AttachmentViewerStart?

    var body: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(Array(attachments.enumerated()), id: \.element.id) { i, a in
                        AttachmentThumb(attachment: a) {
                            // The viewer fades itself in over a clear cover.
                            var t = Transaction()
                            t.disablesAnimations = true
                            withTransaction(t) { open = AttachmentViewerStart(index: i) }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .padding(.top, 4)
            .fullScreenCover(item: $open) { start in
                AttachmentViewer(attachments: attachments, start: start.index) {
                    var t = Transaction()
                    t.disablesAnimations = true
                    withTransaction(t) { open = nil }
                }
            }
        }
    }
}

struct AttachmentViewerStart: Identifiable {
    let index: Int
    var id: Int { index }
}

extension SummaryAttachment {
    /// "Image phone.png" / "Video flow.mp4": the thumbnail's and the page's accessibility label.
    var accessibilityName: String { "\(kind == .video ? "Video" : "Image") \(name)" }
}

/// One thumbnail: the image (or a video's first frame with a play badge) cropped to its box,
/// "Couldn't load" when it fails.
private struct AttachmentThumb: View {
    let attachment: SummaryAttachment
    let onTap: () -> Void

    @Environment(\.palette) private var c
    @Environment(\.displayScale) private var scale
    @Environment(BoardStore.self) private var store: BoardStore?
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        let size = Attachments.thumbSize(attachment)
        let url = AttachmentMedia.url(store, attachment.id)
        Button {
            haptic(.tap)
            onTap()
        } label: {
            ZStack {
                c.bgActive
                if failed {
                    AttachmentFailed(name: attachment.name, compact: true)
                } else if let image = image ?? url.flatMap({ AttachmentMedia.shared.cached($0, poster: attachment.kind == .video) }) {
                    Image(uiImage: image).resizable().scaledToFill()
                }
                if attachment.kind == .video && !failed {
                    Image(systemName: "play.fill")
                        .font(.scaled(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .offset(x: 1)
                        .frame(width: 34, height: 34)
                        .background(.black.opacity(0.55), in: .circle)
                }
            }
            .frame(width: size.width, height: size.height)
            .clipShape(.rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.border, lineWidth: 1 / scale))
            .contentShape(.rect(cornerRadius: 8))
        }
        .buttonStyle(AttachmentThumbStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(attachment.accessibilityName)
        .accessibilityHint("Opens full screen")
        .accessibilityAddTraits([.isButton, .isImage])
        .task(id: url) {
            guard let url, image == nil else { return }
            do {
                image = attachment.kind == .video
                    ? try await AttachmentMedia.shared.poster(url)
                    : try await AttachmentMedia.shared.image(url)
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }
}

private struct AttachmentThumbStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.75 : 1)
    }
}
