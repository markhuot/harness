import HarnessKit
import SwiftUI
import UIKit

/// One prompt attachment (Ticket.promptAttachments) as the list draws it.
struct PromptAttachmentTile: Identifiable {
    let attachment: PromptAttachment
    /// Its place in the list it came from (what removing it takes out)
    let index: Int
    /// A thumbnail of bytes this device uploaded, drawn before the service has the draft
    var local: UIImage?
    /// The ticket and index the service serves it at (GET /tickets/:key/prompt-attachments/:index),
    /// once it's saved
    var remote: (key: String, index: Int)?

    var id: String { attachment.path }
    var isImage: Bool { PromptAttachments.isImage(attachment) }
}

/// A file being uploaded for the list (a spinner row until it's attached).
struct PromptAttachmentPending: Identifiable, Equatable {
    let id = UUID()
    let name: String
}

/// What the service says about a saved attachment: a saved image loads its thumbnail (a 404 is
/// missing); any other saved file asks for a HEAD.
enum PromptAttachmentCheck {
    struct Result {
        var image: UIImage?
        /// nil: unknown (left as it was)
        var missing: Bool?
        var failed = false
    }

    @MainActor
    static func run(_ tile: PromptAttachmentTile, url: String?, api: HarnessClient?) async -> Result? {
        guard let remote = tile.remote, let url, let api else { return nil }
        if tile.isImage {
            if tile.local != nil {
                // Drawn from this device's bytes; still find out when the file is gone.
                return await api.promptAttachmentExists(key: remote.key, index: remote.index) == false ? Result(missing: true) : Result()
            }
            do {
                return Result(image: try await AttachmentMedia.shared.image(url), missing: false)
            } catch AttachmentMedia.LoadError.status(404) {
                return Task.isCancelled ? nil : Result(missing: true)
            } catch {
                return Task.isCancelled ? nil : Result(failed: true)
            }
        }
        return Result(missing: await api.promptAttachmentExists(key: remote.key, index: remote.index) == false)
    }
}

/// Prompt attachments as a vertical list, the same in the New session (editable) and at the bottom
/// of the Spec tab (read-only): one row each, a same-size square (the image's thumbnail, or a file
/// icon) then the name, so the names line up. Each saved one is checked against the service: an
/// image whose file 404s, or a file whose HEAD 404s, shows dimmed with the path it was at.
/// `onRemove` adds a remove button to each row, `pending` adds a spinner row per upload in flight,
/// and `onOpen` opens a row that isn't missing.
struct PromptAttachmentList: View {
    let tiles: [PromptAttachmentTile]
    var pending: [PromptAttachmentPending] = []
    var onRemove: ((PromptAttachmentTile) -> Void)?
    var onOpen: ((PromptAttachmentTile) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(tiles) { tile in
                PromptAttachmentRow(tile: tile, onOpen: onOpen.map { open in { open(tile) } }, onRemove: onRemove.map { remove in { remove(tile) } })
            }
            ForEach(pending) { p in
                PromptAttachmentUploadingRow(name: p.name)
            }
        }
    }
}

enum PromptAttachmentRowMetrics {
    /// The thumbnail and the file icon's square: the same for every row, so names line up
    static let side: CGFloat = 40
    static let radius: CGFloat = 8
}

private struct PromptAttachmentRow: View {
    let tile: PromptAttachmentTile
    let onOpen: (() -> Void)?
    let onRemove: (() -> Void)?

    @Environment(BoardStore.self) private var store: BoardStore?
    @Environment(\.palette) private var c
    @State private var image: UIImage?
    @State private var missing = false
    @State private var failed = false

    private var url: String? {
        tile.remote.flatMap { store?.api?.promptAttachmentUrl(key: $0.key, index: $0.index) }
    }

    var body: some View {
        let name = tile.attachment.name
        let label = missing ? "\(name), missing, was at \(tile.attachment.path)" : "\(tile.isImage ? "Image" : "File") \(name)"
        HStack(spacing: 8) {
            Group {
                if let onOpen, !missing {
                    Button {
                        haptic(.tap)
                        onOpen()
                    } label: {
                        content
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(label)
                } else {
                    content
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(label)
                }
            }
            if let onRemove {
                Button {
                    haptic(.tap)
                    onRemove()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(c.text3)
                        .frame(width: 32, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(name)")
            }
        }
        .task(id: url) {
            guard let result = await PromptAttachmentCheck.run(tile, url: url, api: store?.api) else { return }
            if let i = result.image { image = i }
            if let m = result.missing { missing = m }
            if result.failed { failed = true }
        }
    }

    private var content: some View {
        HStack(spacing: 12) {
            media
            VStack(alignment: .leading, spacing: 2) {
                Text(tile.attachment.name)
                    .font(.scaled(size: 15))
                    .foregroundStyle(missing ? c.text3 : c.text)
                    .strikethrough(missing, color: c.text3)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if missing {
                    Text("Missing — was at \(tile.attachment.path)")
                        .font(.scaled(size: 12))
                        .foregroundStyle(c.text3)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .contentShape(.rect)
    }

    private var media: some View {
        let shape = RoundedRectangle(cornerRadius: PromptAttachmentRowMetrics.radius, style: .continuous)
        return ZStack {
            if missing {
                Color.clear
                Icon(tile.isImage ? "image" : "fileText", size: 18).foregroundStyle(c.text3)
            } else if tile.isImage, let shown = tile.local ?? image ?? url.flatMap({ AttachmentMedia.shared.cached($0) }) {
                c.bgSunken
                Image(uiImage: shown).resizable().scaledToFill()
            } else if tile.isImage, !failed, url != nil {
                c.bgSunken
                ProgressView().controlSize(.mini)
            } else {
                c.bgSunken
                Icon(tile.isImage ? "image" : "fileText", size: 18).foregroundStyle(c.text2)
            }
        }
        .frame(width: PromptAttachmentRowMetrics.side, height: PromptAttachmentRowMetrics.side)
        .clipShape(shape)
        .overlay(shape.strokeBorder(missing ? c.borderStrong : c.border, style: StrokeStyle(lineWidth: 1, dash: missing ? [3, 2] : [])))
    }
}

/// An upload in flight: a spinner in the row's square, then the file's name.
private struct PromptAttachmentUploadingRow: View {
    let name: String

    @Environment(\.palette) private var c

    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
                .controlSize(.small)
                .frame(width: PromptAttachmentRowMetrics.side, height: PromptAttachmentRowMetrics.side)
                .background(c.bgSunken, in: .rect(cornerRadius: PromptAttachmentRowMetrics.radius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: PromptAttachmentRowMetrics.radius, style: .continuous).strokeBorder(c.border, lineWidth: 1))
            Text(name)
                .font(.scaled(size: 15))
                .foregroundStyle(c.text3)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Uploading \(name)")
    }
}
