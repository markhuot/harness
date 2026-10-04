import HarnessKit
import QuickLook
import SwiftUI
import UIKit

/// Where the service serves an attachment's file.
enum PromptAttachmentRemote: Equatable {
    /// A ticket's prompt attachment: GET /tickets/:key/prompt-attachments/:index
    case prompt(key: String, index: Int)
    /// A file sent with a message: GET /transcript/:entryId/attachments/:index
    case message(entryId: String, index: Int)
    /// One of the ticket's spec images, waiting in a composer or New session as `attachment:<id>`
    /// (the service resolves it when the message is sent): GET /attachments/:id
    case spec(id: String)

    func url(_ api: HarnessClient) -> String {
        switch self {
        case let .prompt(key, index): api.promptAttachmentUrl(key: key, index: index)
        case let .message(entryId, index): api.messageAttachmentUrl(entryId: entryId, index: index)
        case let .spec(id): api.attachmentUrl(id)
        }
    }

    /// A waiting attachment that refers to a spec image by `attachment:<id>`.
    static func waiting(_ a: PromptAttachment) -> PromptAttachmentRemote? {
        PromptAttachments.specAttachmentId(of: a.path).map { .spec(id: $0) }
    }
}

/// One attachment (a ticket's prompt attachment, or one going with or sent with a message) as the
/// list draws it.
struct PromptAttachmentTile: Identifiable {
    let attachment: PromptAttachment
    /// Its place in the list it came from (what removing it takes out)
    let index: Int
    /// A thumbnail of bytes this device uploaded, drawn before the service has the draft
    var local: UIImage?
    /// Where the service serves it, once it's saved (nil: only on this device so far)
    var remote: PromptAttachmentRemote?

    var id: String { attachment.path }
    var isImage: Bool { PromptAttachments.isImage(attachment) }
    /// The human's notes on it (drawn over its thumbnail, listed under its row)
    var annotation: AttachmentAnnotation? { attachment.annotation.flatMap { $0.marks.isEmpty ? nil : $0 } }
    /// The file as a message or New session sends it, for annotating it.
    var input: PromptAttachmentInput { PromptAttachmentInput(path: attachment.path, name: attachment.name) }
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
        guard tile.remote != nil, let url, let api else { return nil }
        if tile.isImage {
            if tile.local != nil {
                // Drawn from this device's bytes; still find out when the file is gone.
                return await api.fileExists(url) == false ? Result(missing: true) : Result()
            }
            do {
                return Result(image: try await AttachmentMedia.shared.image(url), missing: false)
            } catch AttachmentMedia.LoadError.status(404) {
                return Task.isCancelled ? nil : Result(missing: true)
            } catch {
                return Task.isCancelled ? nil : Result(failed: true)
            }
        }
        return Result(missing: await api.fileExists(url) == false)
    }
}

/// Attachments as a vertical list, the same in the New session and the message composer (editable),
/// and at the bottom of the Spec tab and under a sent message in the Transcript (read-only): one row each, a same-size square (the image's thumbnail, or a file
/// icon) then the name, so the names line up. An annotated image draws its marks over the
/// thumbnail and has an "N notes" disclosure under its row. Each saved one is checked against the
/// service: an image whose file 404s, or a file whose HEAD 404s, shows dimmed with the path it was at.
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
        tile.remote.flatMap { remote in store?.api.map(remote.url) }
    }

    var body: some View {
        let name = tile.attachment.name
        let notes = tile.annotation.map { ", \(Annotations.notesLabel($0.marks.count))" } ?? ""
        let label = missing ? "\(name), missing, was at \(tile.attachment.path)" : "\(tile.isImage ? "Image" : "File") \(name)\(notes)"
        VStack(alignment: .leading, spacing: 0) {
            row(name: name, label: label)
            if let annotation = tile.annotation {
                AttachmentAnnotationNotes(annotation: annotation)
                    .padding(.leading, PromptAttachmentRowMetrics.side + 12)
            }
        }
        .task(id: url) {
            guard let result = await PromptAttachmentCheck.run(tile, url: url, api: store?.api) else { return }
            if let i = result.image { image = i }
            if let m = result.missing { missing = m }
            if result.failed { failed = true }
        }
    }

    private func row(name: String, label: String) -> some View {
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
                if let annotation = tile.annotation {
                    AnnotationThumbnailOverlay(annotation: annotation, accent: c.accent)
                }
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

/// A read-only list whose rows open: images in the full-screen viewer (paging through the list's
/// images, with their marks drawn over them), other files downloaded into Quick Look. The Spec
/// tab's prompt attachments and a sent message's attachments in the Transcript, whose images the
/// viewer offers to annotate into the ticket's composer (`\.annotationSink`): the notes go on that
/// same file, starting from the ones it already has.
/// `downloading` is on while a file is being fetched.
struct OpenablePromptAttachmentList: View {
    let tiles: [PromptAttachmentTile]
    @Binding var downloading: Bool

    @Environment(BoardStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.annotationSink) private var sink
    @State private var viewing: AttachmentViewerStart?
    @State private var preview: URL?

    var body: some View {
        let images = tiles.filter(\.isImage)
        PromptAttachmentList(tiles: tiles, onOpen: { tile in
            if tile.isImage {
                guard let i = images.firstIndex(where: { $0.index == tile.index }) else { return }
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { viewing = AttachmentViewerStart(index: i) }
            } else {
                open(tile)
            }
        })
        .fullScreenCover(item: $viewing) { start in
            let api = store.api
            AttachmentViewer(
                attachments: images.enumerated().map { i, tile in Attachment(id: String(i), kind: .image, mimeType: "", name: tile.attachment.name, size: 0) },
                start: start.index,
                url: { a in
                    guard let api, let i = Int(a.id), images.indices.contains(i) else { return nil }
                    return images[i].remote?.url(api)
                },
                annotation: { a in Int(a.id).flatMap { images.indices.contains($0) ? images[$0].annotation : nil } },
                annotate: sink.map { sink in { a, image in
                    guard let i = Int(a.id), images.indices.contains(i) else { return nil }
                    return sink.request(.existing(images[i].input), image: image, annotation: images[i].annotation)
                } }
            ) {
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { viewing = nil }
            }
        }
        .quickLookPreview($preview)
    }

    /// Download a file into a temporary folder under its own name, then show it in Quick Look.
    private func open(_ tile: PromptAttachmentTile) {
        guard !downloading, let api = store.api, let remote = tile.remote, let url = URL(string: remote.url(api)) else { return }
        downloading = true
        let name = tile.attachment.name
        Task {
            defer { downloading = false }
            do {
                let (temp, response) = try await URLSession.shared.download(from: url)
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    throw HarnessAPIError(status: http.statusCode, message: http.statusCode == 404 ? "The file is gone from the Mac." : HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
                }
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent("prompt-attachments/\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let dest = dir.appendingPathComponent(name.isEmpty ? "file" : name)
                try FileManager.default.moveItem(at: temp, to: dest)
                preview = dest
            } catch {
                haptic(.error)
                toasts.show("Couldn't open \(name): \(localizedErrorMessage(error))", kind: .error)
            }
        }
    }
}

/// "3 notes" under an annotated attachment's row; tapping it lists each number with its note.
struct AttachmentAnnotationNotes: View {
    let annotation: AttachmentAnnotation

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
                    Text(label)
                        .font(.scaled(size: 12.5, weight: .semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(c.accentText)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
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

/// An editable list (a composer's or a New session's attachments): rows with remove buttons and
/// upload spinners, marks over annotated thumbnails with "N notes" under them, and images opening
/// full screen with Annotate. Annotate works on any image there (a reopened draft's too): the notes
/// go on that same attachment, starting from the ones it has (`onAnnotate` sets them in place).
struct EditablePromptAttachmentList: View {
    let tiles: [PromptAttachmentTile]
    let pending: [PromptAttachmentPending]
    let uploader: PromptAttachmentUploader
    var onRemove: ((PromptAttachmentTile) -> Void)?
    /// Set the notes on the attachment `input` names.
    let onAnnotate: @MainActor (PromptAttachmentInput, AttachmentAnnotation) -> Void

    @Environment(BoardStore.self) private var store
    @State private var viewing: AttachmentViewerStart?

    var body: some View {
        let images = tiles.filter { $0.isImage && url($0) != nil }
        PromptAttachmentList(tiles: tiles, pending: pending, onRemove: onRemove, onOpen: { tile in
            guard let i = images.firstIndex(where: { $0.index == tile.index }) else { return }
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) { viewing = AttachmentViewerStart(index: i) }
        })
        .fullScreenCover(item: $viewing) { start in
            let add = onAnnotate
            AttachmentViewer(
                attachments: images.enumerated().map { i, tile in Attachment(id: String(i), kind: .image, mimeType: "", name: tile.attachment.name, size: 0) },
                start: start.index,
                url: { a in Int(a.id).flatMap { images.indices.contains($0) ? url(images[$0]) : nil } },
                annotation: { a in Int(a.id).flatMap { images.indices.contains($0) ? images[$0].annotation : nil } },
                annotate: { a, image in
                    guard let i = Int(a.id), images.indices.contains(i) else { return nil }
                    return AnnotationRequest(file: .existing(images[i].input), image: image, annotation: images[i].annotation) { add($0.input, $0.annotation) }
                }
            ) {
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { viewing = nil }
            }
        }
    }

    /// This device's copy, else the service's once it has the file (a spec image's right away).
    private func url(_ tile: PromptAttachmentTile) -> String? {
        if let local = uploader.localFiles[tile.attachment.path] { return local.absoluteString }
        return tile.remote.flatMap { remote in store.api.map(remote.url) }
    }
}
