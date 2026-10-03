import HarnessKit
import SwiftUI
import UIKit

/// One prompt attachment (Ticket.promptAttachments) as the strip draws it.
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

/// A file being uploaded for the strip (a spinner tile until it's attached).
struct PromptAttachmentPending: Identifiable, Equatable {
    let id = UUID()
    let name: String
}

/// A horizontal strip of prompt attachments: image thumbnails and named chips for other files,
/// spinner tiles for uploads in flight. Each saved one is checked against the service: an image
/// whose file 404s, or a file whose HEAD 404s, shows as missing (dashed and dimmed, with the path it
/// was at). `onRemove` adds a remove button to each tile (the New session); `onOpen` opens one that
/// isn't missing (the Spec tab).
struct PromptAttachmentStrip: View {
    let tiles: [PromptAttachmentTile]
    var pending: [PromptAttachmentPending] = []
    var onRemove: ((PromptAttachmentTile) -> Void)?
    var onOpen: ((PromptAttachmentTile) -> Void)?

    private static let end = "end"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(tiles) { tile in
                        PromptAttachmentTileView(tile: tile, onRemove: onRemove.map { remove in { remove(tile) } }, onOpen: onOpen.map { open in { open(tile) } })
                    }
                    ForEach(pending) { p in
                        PromptAttachmentUploadingTile(name: p.name)
                    }
                    Color.clear.frame(width: 1, height: 1).id(Self.end)
                }
                // Room for the remove buttons that sit over the tiles' corners.
                .padding(.top, 6)
                .padding(.trailing, 6)
            }
            .scrollClipDisabled()
            // Something new (an upload starting or landing) scrolls into view.
            .onChange(of: tiles.count + pending.count) { old, new in
                guard new > old else { return }
                withAnimation(.snappy) { proxy.scrollTo(Self.end, anchor: .trailing) }
            }
        }
    }
}

/// Tile metrics.
enum PromptAttachmentMetrics {
    static let height: CGFloat = 76
    static let radius: CGFloat = 10
}

private struct PromptAttachmentTileView: View {
    let tile: PromptAttachmentTile
    let onRemove: (() -> Void)?
    let onOpen: (() -> Void)?

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
        let label = missing
            ? "\(name), missing, was at \(tile.attachment.path)"
            : "\(tile.isImage ? "Image" : "File") \(name)"
        Group {
            if let onOpen, !missing {
                // A button, so a tap (and VoiceOver's activate) opens it even inside the scroll view.
                Button {
                    haptic(.tap)
                    onOpen()
                } label: {
                    face.contentShape(.rect(cornerRadius: PromptAttachmentMetrics.radius))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(label)
            } else {
                face
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(label)
            }
        }
        .overlay(alignment: .topTrailing) {
            if let onRemove {
                Button {
                    haptic(.tap)
                    onRemove()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(c.text)
                        .frame(width: 22, height: 22)
                        .background(c.bgElev, in: .circle)
                        .overlay(Circle().strokeBorder(c.borderStrong, lineWidth: 1))
                        .frame(width: 34, height: 34)
                        .contentShape(.circle)
                }
                .buttonStyle(.plain)
                .offset(x: 10, y: -10)
                .accessibilityLabel("Remove \(name)")
            }
        }
        .task(id: url) { await check() }
    }

    // MARK: Tiles

    @ViewBuilder private var face: some View {
        if missing {
            missingChip
        } else if tile.isImage {
            thumbnail
        } else {
            fileChip
        }
    }

    @ViewBuilder private var thumbnail: some View {
        let shape = RoundedRectangle(cornerRadius: PromptAttachmentMetrics.radius, style: .continuous)
        ZStack {
            c.bgSunken
            if let shown = tile.local ?? image ?? url.flatMap({ AttachmentMedia.shared.cached($0) }) {
                Image(uiImage: shown).resizable().scaledToFill()
            } else if failed {
                AttachmentFailed(name: tile.attachment.name, compact: true)
            } else if url != nil {
                ProgressView().controlSize(.small)
            } else {
                Icon("image", size: 22).foregroundStyle(c.text3)
            }
        }
        .frame(width: PromptAttachmentMetrics.height, height: PromptAttachmentMetrics.height)
        .clipShape(shape)
        .overlay(shape.strokeBorder(c.border, lineWidth: 1))
    }

    private var fileChip: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc")
                .font(.system(size: 20))
                .foregroundStyle(c.text2)
            VStack(alignment: .leading, spacing: 2) {
                Text(tile.attachment.name)
                    .font(.scaled(size: 13, weight: .medium))
                    .foregroundStyle(c.text)
                    .lineLimit(2)
                    .truncationMode(.middle)
                if let ext = Self.ext(tile.attachment.name) {
                    Text(ext).font(.mono(11)).foregroundStyle(c.text3)
                }
            }
        }
        .padding(.horizontal, 10)
        .frame(minWidth: 110, maxWidth: 180, minHeight: PromptAttachmentMetrics.height, maxHeight: PromptAttachmentMetrics.height, alignment: .leading)
        .background(c.bgSunken, in: .rect(cornerRadius: PromptAttachmentMetrics.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: PromptAttachmentMetrics.radius, style: .continuous).strokeBorder(c.border, lineWidth: 1))
    }

    private var missingChip: some View {
        HStack(alignment: .top, spacing: 8) {
            Icon("alert", size: 16).foregroundStyle(c.text3).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(tile.attachment.name)
                    .font(.scaled(size: 13, weight: .medium))
                    .foregroundStyle(c.text2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("Missing — was at \(tile.attachment.path)")
                    .font(.scaled(size: 11.5))
                    .foregroundStyle(c.text3)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
        }
        .padding(.horizontal, 10)
        .frame(width: 210, height: PromptAttachmentMetrics.height, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: PromptAttachmentMetrics.radius, style: .continuous)
                .strokeBorder(c.borderStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
        .opacity(0.8)
    }

    // MARK: Checks

    /// A saved image loads its thumbnail (a 404 is missing); any other saved file asks for a HEAD.
    private func check() async {
        guard let remote = tile.remote, let url, let api = store?.api else { return }
        if tile.isImage {
            if tile.local != nil {
                // Drawn from this device's bytes; still find out when the file is gone.
                if await api.promptAttachmentExists(key: remote.key, index: remote.index) == false { missing = true }
                return
            }
            do {
                image = try await AttachmentMedia.shared.image(url)
                missing = false
            } catch AttachmentMedia.LoadError.status(404) {
                if !Task.isCancelled { missing = true }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        } else {
            missing = await api.promptAttachmentExists(key: remote.key, index: remote.index) == false
        }
    }

    /// "PDF" for notes.pdf; nil without an extension.
    private static func ext(_ name: String) -> String? {
        let e = (name as NSString).pathExtension
        return e.isEmpty ? nil : e.uppercased()
    }
}

/// An upload in flight: a spinner with the file's name.
private struct PromptAttachmentUploadingTile: View {
    let name: String

    @Environment(\.palette) private var c

    var body: some View {
        VStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text(name)
                .font(.scaled(size: 11.5))
                .foregroundStyle(c.text3)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 8)
        .frame(width: 96, height: PromptAttachmentMetrics.height)
        .background(c.bgSunken, in: .rect(cornerRadius: PromptAttachmentMetrics.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: PromptAttachmentMetrics.radius, style: .continuous).strokeBorder(c.border, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Uploading \(name)")
    }
}
