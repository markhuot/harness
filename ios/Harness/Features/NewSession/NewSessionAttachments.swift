import HarnessKit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Uploads files for a New session's prompt attachments (DESIGN.md "Prompt attachments"). The
/// phone's files aren't on the Mac, so every one goes through POST /uploads, then onto the draft
/// with the editor (deduped and capped, which saves the draft). HEIC/HEIF photos go up as JPEG.
/// It keeps a thumbnail of each uploaded image, so the strip draws it before the draft is saved.
@MainActor
@Observable
final class PromptAttachmentUploader {
    /// Something to upload: its name, MIME type and a way to read its bytes.
    struct Source {
        let name: String
        let mimeType: String?
        let load: @MainActor () async throws -> Data
    }

    enum UploadError: LocalizedError {
        case unreadable
        case notConnected

        var errorDescription: String? {
            switch self {
            case .unreadable: "Couldn't read the file."
            case .notConnected: "Not connected to the Mac."
            }
        }
    }

    private(set) var pending: [PromptAttachmentPending] = []
    /// Thumbnails of images this device uploaded, by their path on the service's machine.
    private(set) var thumbnails: [String: UIImage] = [:]

    /// Upload `sources` in order and attach each as it lands. Toasts a failure per file, and once
    /// when the 20-attachment limit left some out (those aren't uploaded at all).
    func upload(_ sources: [Source], client: HarnessClient?, editor: NewSessionEditor, toasts: ToastCenter) async {
        guard !sources.isEmpty else { return }
        guard let client else {
            haptic(.error)
            toasts.show(UploadError.notConnected.localizedDescription, kind: .error)
            return
        }
        let room = PromptAttachments.room(current: editor.local?.promptAttachments?.count ?? 0, pending: pending.count, incoming: sources.count)
        var skipped = sources.count - room
        let batch = sources.prefix(room).map { (PromptAttachmentPending(name: $0.name), $0) }
        pending += batch.map(\.0)
        for (placeholder, source) in batch {
            defer { pending.removeAll { $0.id == placeholder.id } }
            do {
                var data = try await source.load()
                var name = source.name
                var mime = source.mimeType
                if PromptAttachments.needsJPEG(mimeType: mime, name: name) {
                    guard let jpeg = await Self.jpeg(data) else { throw UploadError.unreadable }
                    data = jpeg
                    name = PromptAttachments.jpegName(name)
                    mime = "image/jpeg"
                }
                let thumb = PromptAttachments.isImage(name: name, path: name) ? await Self.thumbnail(data) : nil
                let a = try await client.uploadPromptAttachment(data: data, name: name, mimeType: mime)
                if let thumb { thumbnails[a.path] = thumb }
                skipped += editor.addAttachments([PromptAttachmentInput(path: a.path, name: a.name, source: a.source)])
            } catch {
                haptic(.error)
                toasts.show("Couldn't attach \(source.name): \(localizedErrorMessage(error))", kind: .error)
            }
        }
        if skipped > 0 {
            haptic(.warning)
            toasts.show(PromptAttachments.limitMessage(skipped: skipped), kind: .error)
        }
    }

    // MARK: Sources

    /// Photos from the PhotosPicker: "Photo 3.heic" and so on (the picker doesn't give file names).
    static func sources(_ items: [PhotosPickerItem], startingAt n: Int) -> [Source] {
        items.enumerated().map { i, item in
            let type = item.supportedContentTypes.first { $0.conforms(to: .image) } ?? item.supportedContentTypes.first
            return Source(name: "Photo \(n + i).\(type?.preferredFilenameExtension ?? "jpg")", mimeType: type?.preferredMIMEType) {
                guard let data = try await item.loadTransferable(type: Data.self) else { throw UploadError.unreadable }
                return data
            }
        }
    }

    /// Files from `.fileImporter`, read under their security scope.
    static func sources(_ urls: [URL]) -> [Source] {
        urls.map { url in
            Source(name: url.lastPathComponent, mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType) {
                try await Task.detached(priority: .userInitiated) {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    return try Data(contentsOf: url)
                }.value
            }
        }
    }

    /// Whether a dropped or pasted item is something to attach: an image, or a named file. Plain
    /// text and links (a drag from the prompt itself) aren't.
    static func attachable(_ p: NSItemProvider) -> Bool {
        let types = p.registeredContentTypes
        if types.contains(where: { $0.conforms(to: .image) }) { return true }
        if types.allSatisfy({ $0.conforms(to: .text) || $0.conforms(to: .url) }) {
            return !((p.suggestedName ?? "") as NSString).pathExtension.isEmpty
        }
        return types.contains { $0.conforms(to: .data) }
    }

    /// Dropped items (iPad drag and drop) and pasted ones: images first by their own type, else
    /// the item's data. A paste without a name is "Pasted image.png".
    static func sources(_ providers: [NSItemProvider], pasted: Bool) -> [Source] {
        providers.filter(attachable).map { p in
            let types = p.registeredContentTypes
            let type = types.first { $0.conforms(to: .image) } ?? types.first { $0.conforms(to: .data) } ?? .data
            let mime = type.preferredMIMEType
            var name: String
            if let suggested = p.suggestedName, !suggested.isEmpty {
                name = suggested
                if (suggested as NSString).pathExtension.isEmpty, let ext = type.preferredFilenameExtension { name += ".\(ext)" }
            } else if type.conforms(to: .image) {
                name = pasted ? PromptAttachments.pastedImageName(mime) : "Image.\(type.preferredFilenameExtension ?? "png")"
            } else {
                name = "File\(type.preferredFilenameExtension.map { ".\($0)" } ?? "")"
            }
            let identifier = type.identifier
            return Source(name: name, mimeType: mime) {
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, any Error>) in
                    _ = p.loadDataRepresentation(forTypeIdentifier: identifier) { data, error in
                        if let data { cont.resume(returning: data) } else { cont.resume(throwing: error ?? UploadError.unreadable) }
                    }
                }
            }
        }
    }

    // MARK: Images

    private nonisolated static func jpeg(_ data: Data) async -> Data? {
        await Task.detached(priority: .userInitiated) { UIImage(data: data)?.jpegData(compressionQuality: 0.9) }.value
    }

    private nonisolated static func thumbnail(_ data: Data) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 240, height: 240))
        }.value
    }
}

/// The New session's Attachments section: the strip (with remove buttons) and the Attach menu
/// (Photos, Files, Paste).
struct NewSessionAttachmentsSection: View {
    let editor: NewSessionEditor
    let ticket: Ticket
    let uploader: PromptAttachmentUploader

    @Environment(BoardStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var c
    @State private var pickingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var importing = false

    var body: some View {
        let list = ticket.promptAttachments ?? []
        let full = list.count + uploader.pending.count >= maxPromptAttachments
        Section {
            if !list.isEmpty || !uploader.pending.isEmpty {
                PromptAttachmentStrip(
                    tiles: tiles(list),
                    pending: uploader.pending,
                    onRemove: { editor.removeAttachment(at: $0.index) }
                )
                .listRowBackground(c.bgElev)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }
            Menu {
                Button("Photos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
                Button("Files", systemImage: "folder") { importing = true }
                Button("Paste", systemImage: "doc.on.clipboard") { paste() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "paperclip")
                        .font(.scaled(size: 15, weight: .semibold))
                        .foregroundStyle(full ? c.text3 : c.accentText)
                        .frame(width: 18)
                    Text(list.isEmpty ? "Attach files" : "Attach more")
                        .font(.scaled(size: 15))
                        .foregroundStyle(full ? c.text3 : c.accentText)
                    Spacer(minLength: 0)
                    if !list.isEmpty {
                        Text("\(list.count) of \(maxPromptAttachments)").font(.scaled(size: 13)).foregroundStyle(c.text3)
                    }
                }
                .frame(minHeight: 36)
                .contentShape(Rectangle())
            }
            .disabled(full)
            .accessibilityLabel("Attach")
            .accessibilityValue(list.isEmpty ? "" : "\(list.count) of \(maxPromptAttachments) attached")
            .listRowBackground(c.bgElev)
        } header: {
            if !list.isEmpty || !uploader.pending.isEmpty {
                Text("Attachments")
            }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: max(1, maxPromptAttachments - list.count), matching: .images)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            upload(PromptAttachmentUploader.sources(items, startingAt: list.count + 1))
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case let .success(urls): upload(PromptAttachmentUploader.sources(urls))
            case let .failure(error): toasts.show("Couldn't open the file: \(localizedErrorMessage(error))", kind: .error)
            }
        }
    }

    /// The draft's attachments as tiles: this device's thumbnail when it has one, else the
    /// service's copy once the saved draft has it.
    private func tiles(_ list: [PromptAttachment]) -> [PromptAttachmentTile] {
        let saved = editor.savedId.flatMap { store.state.tickets[$0] }
        let savedList = saved?.promptAttachments ?? []
        return list.enumerated().map { i, a in
            let remote = saved.flatMap { s in savedList.firstIndex { $0.path == a.path }.map { (key: s.key, index: $0) } }
            return PromptAttachmentTile(attachment: a, index: i, local: uploader.thumbnails[a.path], remote: remote)
        }
    }

    private func paste() {
        let sources = PromptAttachmentUploader.sources(UIPasteboard.general.itemProviders, pasted: true)
        if sources.isEmpty {
            toasts.show("Nothing to paste: copy an image or a file first.", kind: .info)
            return
        }
        upload(sources)
    }

    private func upload(_ sources: [PromptAttachmentUploader.Source]) {
        guard !sources.isEmpty else { return }
        let client = store.api
        Task { await uploader.upload(sources, client: client, editor: editor, toasts: toasts) }
    }
}

/// Drag and drop onto the New session (iPad, or between apps): images and files are uploaded and
/// attached; the screen shows an accent outline while something is over it.
struct PromptAttachmentDrop: ViewModifier {
    let editor: NewSessionEditor?
    let uploader: PromptAttachmentUploader

    @Environment(BoardStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var c
    @State private var targeted = false

    func body(content: Content) -> some View {
        content
            .onDrop(of: [.image, .item], isTargeted: $targeted) { providers in
                guard let editor else { return false }
                let sources = PromptAttachmentUploader.sources(providers, pasted: false)
                guard !sources.isEmpty else { return false }
                let client = store.api
                Task { await uploader.upload(sources, client: client, editor: editor, toasts: toasts) }
                return true
            }
            .overlay {
                if targeted {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(c.accent, style: StrokeStyle(lineWidth: 2, dash: [8, 5]))
                        .background(c.accentSoft.opacity(0.35), in: .rect(cornerRadius: 14, style: .continuous))
                        .overlay {
                            Label("Drop to attach", systemImage: "paperclip")
                                .font(.scaled(size: 16, weight: .semibold))
                                .foregroundStyle(c.accentText)
                        }
                        .padding(8)
                        .allowsHitTesting(false)
                }
            }
    }
}
