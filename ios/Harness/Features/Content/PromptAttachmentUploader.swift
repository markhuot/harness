import HarnessKit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What picked files are attached to: a New session's draft (NewSessionEditor) or the next message
/// from a ticket's composer (MessageAttachments).
@MainActor
protocol PromptAttachmentTarget: AnyObject, Sendable {
    /// How many are attached now
    var attachmentCount: Int { get }
    /// What the limit toast says takes them
    var attachmentHolder: PromptAttachments.Holder { get }
    /// Attach `added` (deduped and capped); returns how many the limit left out.
    func attach(_ added: [PromptAttachmentInput]) -> Int
}

extension NewSessionEditor: PromptAttachmentTarget {
    var attachmentCount: Int { local?.promptAttachments?.count ?? 0 }
    var attachmentHolder: PromptAttachments.Holder { .session }
    func attach(_ added: [PromptAttachmentInput]) -> Int { addAttachments(added) }
}

extension MessageAttachments: PromptAttachmentTarget {
    var attachmentCount: Int { count }
    var attachmentHolder: PromptAttachments.Holder { .message }
    func attach(_ added: [PromptAttachmentInput]) -> Int { add(added) }
}

/// Uploads files for attachments (DESIGN.md "Prompt attachments"): a New session's prompt, or a
/// message from a ticket's composer. The phone's files aren't on the Mac, so every one goes
/// through POST /uploads, then onto the target (deduped and capped). HEIC/HEIF photos go up as
/// JPEG. It keeps a thumbnail of each uploaded image, so the list draws it before the service has
/// it.
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
    /// The Attach menu asked for the photo picker or the file importer. They're presented from a
    /// whole screen (PromptAttachmentPickers): presented from a Form section, they'd attach to every row.
    var pickingPhotos = false
    var importing = false
    /// Thumbnails of images this device uploaded, by their path on the service's machine.
    private(set) var thumbnails: [String: UIImage] = [:]

    /// Upload `sources` in order and attach each as it lands. Toasts a failure per file, and once
    /// when the 20-attachment limit left some out (those aren't uploaded at all).
    func upload(_ sources: [Source], client: HarnessClient?, target: any PromptAttachmentTarget, toasts: ToastCenter) async {
        guard !sources.isEmpty else { return }
        guard let client else {
            haptic(.error)
            toasts.show(UploadError.notConnected.localizedDescription, kind: .error)
            return
        }
        let room = PromptAttachments.room(current: target.attachmentCount, pending: pending.count, incoming: sources.count)
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
                skipped += target.attach([PromptAttachmentInput(path: a.path, name: a.name, source: a.source)])
            } catch {
                haptic(.error)
                toasts.show("Couldn't attach \(source.name): \(localizedErrorMessage(error))", kind: .error)
            }
        }
        if skipped > 0 {
            haptic(.warning)
            toasts.show(PromptAttachments.limitMessage(skipped: skipped, holder: target.attachmentHolder), kind: .error)
        }
    }

    /// Attach what's on the pasteboard (an image or a file), or say there's nothing to paste.
    func paste(client: HarnessClient?, target: any PromptAttachmentTarget, toasts: ToastCenter) {
        let sources = Self.sources(UIPasteboard.general.itemProviders, pasted: true)
        if sources.isEmpty {
            toasts.show("Nothing to paste: copy an image or a file first.", kind: .info)
            return
        }
        Task { await upload(sources, client: client, target: target, toasts: toasts) }
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

/// The Attach menu's items, the same in the New session and the ticket composer: Photos and Files
/// (multi-select, presented by PromptAttachmentPickers) and Paste.
struct PromptAttachmentMenuItems: View {
    let uploader: PromptAttachmentUploader
    let target: any PromptAttachmentTarget

    @Environment(BoardStore.self) private var store
    @Environment(ToastCenter.self) private var toasts

    var body: some View {
        Button("Photos", systemImage: "photo.on.rectangle") { uploader.pickingPhotos = true }
        Button("Files", systemImage: "folder") { uploader.importing = true }
        Button("Paste", systemImage: "doc.on.clipboard") { uploader.paste(client: store.api, target: target, toasts: toasts) }
    }
}

/// The photo picker and file importer the Attach menu opens, presented from a whole screen.
struct PromptAttachmentPickers: ViewModifier {
    let target: (any PromptAttachmentTarget)?
    @Bindable var uploader: PromptAttachmentUploader

    @Environment(BoardStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @State private var photos: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        let count = target?.attachmentCount ?? 0
        content
            .photosPicker(isPresented: $uploader.pickingPhotos, selection: $photos, maxSelectionCount: max(1, maxPromptAttachments - count), matching: .images)
            .onChange(of: photos) { _, items in
                guard !items.isEmpty else { return }
                photos = []
                upload(PromptAttachmentUploader.sources(items, startingAt: count + 1))
            }
            .fileImporter(isPresented: $uploader.importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case let .success(urls): upload(PromptAttachmentUploader.sources(urls))
                case let .failure(error): toasts.show("Couldn't open the file: \(localizedErrorMessage(error))", kind: .error)
                }
            }
    }

    private func upload(_ sources: [PromptAttachmentUploader.Source]) {
        guard let target, !sources.isEmpty else { return }
        let client = store.api
        let toasts = toasts
        let uploader = uploader
        Task { await uploader.upload(sources, client: client, target: target, toasts: toasts) }
    }
}

/// Drag and drop onto a screen (iPad, or between apps): images and files are uploaded and
/// attached; the screen shows an accent outline while something is over it. No target: drops
/// aren't taken.
struct PromptAttachmentDrop: ViewModifier {
    let target: (any PromptAttachmentTarget)?
    let uploader: PromptAttachmentUploader

    @Environment(BoardStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.palette) private var c
    @State private var targeted = false

    func body(content: Content) -> some View {
        content
            .onDrop(of: [.image, .item], isTargeted: $targeted) { providers in
                guard let target else { return false }
                let sources = PromptAttachmentUploader.sources(providers, pasted: false)
                guard !sources.isEmpty else { return false }
                let client = store.api
                Task { await uploader.upload(sources, client: client, target: target, toasts: toasts) }
                return true
            }
            .overlay {
                if targeted && target != nil {
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
