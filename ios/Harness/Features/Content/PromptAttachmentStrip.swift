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

    private func check() async {
        guard let result = await PromptAttachmentCheck.run(tile, url: url, api: store?.api) else { return }
        if let i = result.image { image = i }
        if let m = result.missing { missing = m }
        if result.failed { failed = true }
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

/// What the service says about a saved attachment: a saved image loads its thumbnail (a 404 is
/// missing); any other saved file asks for a HEAD. Shared by the strip and the list.
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

/// The ticket's attachments as a read-only vertical list (the bottom of the Spec tab): one row
/// each, a same-size square (the image's thumbnail, or a file icon) then the name, so the names
/// line up. A missing file is dimmed and says where it was; the others open with `onOpen`.
struct PromptAttachmentList: View {
    let tiles: [PromptAttachmentTile]
    let onOpen: (PromptAttachmentTile) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(tiles) { tile in
                PromptAttachmentRow(tile: tile) { onOpen(tile) }
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
    let onOpen: () -> Void

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
        Button {
            haptic(.tap)
            onOpen()
        } label: {
            HStack(spacing: 12) {
                media
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
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
        .buttonStyle(.plain)
        .disabled(missing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(missing ? "\(name), missing, was at \(tile.attachment.path)" : "\(tile.isImage ? "Image" : "File") \(name)")
        .accessibilityAddTraits(missing ? [] : .isButton)
        .task(id: url) {
            guard let result = await PromptAttachmentCheck.run(tile, url: url, api: store?.api) else { return }
            if let i = result.image { image = i }
            if let m = result.missing { missing = m }
            if result.failed { failed = true }
        }
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
