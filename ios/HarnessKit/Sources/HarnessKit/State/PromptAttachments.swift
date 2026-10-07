import Foundation

// Port of shared/src/state/promptAttachments.ts. Attachment lists (DESIGN.md "Attachments"): the
// files a human attaches to a New session or a message, each one an Attachment the service
// registered (an upload, a registered file, a spec image, a file from an earlier message), with
// its annotation if any. The pure pieces both apps use: the list a draft or composer keeps, what a
// create, PATCH or message sends, and which files get an image preview. Paths and ids compare as
// JS strings do (code units, not canonical equivalence).

public enum PromptAttachments {
    /// The last path component: "/a/b/shot.png" → "shot.png".
    public static func fileBaseName(_ path: String) -> String {
        var scalars = Array(path.unicodeScalars)
        while scalars.last == "/" { scalars.removeLast() }
        guard let i = scalars.lastIndex(of: "/") else { return string(scalars[...]) }
        return string(scalars[(i + 1)...])
    }

    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "tiff"]
    private static let videoExtensions: Set<String> = ["mp4", "webm", "mov", "m4v"]

    /// A kind guessed from a file name, for an input the service hasn't described yet.
    static func kindByName(_ name: String) -> AttachmentKind {
        let ext = fileExtension(name).map(Mentions.JS.lowercase) ?? ""
        return imageExtensions.contains(ext) ? .image : videoExtensions.contains(ext) ? .video : .file
    }

    /// `attachmentFromInput`: an input as a list keeps it. A full Attachment stays as it is; a bare
    /// `{ id }` or `{ path }` gets the defaults the service would fill in (its name from the path,
    /// its kind from the name). Applied to a draft's own PATCH before the service answers.
    public static func fromInput(_ a: AttachmentInput) -> Attachment {
        let path = a.path ?? ""
        let base = fileBaseName(path)
        let name = a.name.map(JSCompat.trim).flatMap { $0.isEmpty ? nil : $0 } ?? (base.isEmpty ? "file" : base)
        return Attachment(
            id: a.id ?? "", path: path, name: name, source: a.source ?? .file, kind: a.kind ?? kindByName(name.isEmpty ? path : name),
            mimeType: a.mimeType ?? "", size: a.size, width: a.width, height: a.height, annotation: a.annotation
        )
    }

    /// `attachmentInputs`: the list as a create, PATCH or message body sends it, each attachment
    /// whole (the service reads its id, name and annotation).
    public static func inputs(_ list: [Attachment]) -> [AttachmentInput] {
        list.map(AttachmentInput.init)
    }

    /// `sameAttachments`: same attachments, same names, same annotations, same order.
    public static func same(_ a: [Attachment], _ b: [Attachment]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy {
            jsEqual($0.id, $1.id) && jsEqual($0.path, $1.path) && jsEqual($0.name, $1.name) && Annotations.same($0.annotation, $1.annotation)
        }
    }

    /// The same file: by id once the service has registered it, else by path.
    static func sameFile(_ a: Attachment, _ b: Attachment) -> Bool {
        !a.id.isEmpty && !b.id.isEmpty ? jsEqual(a.id, b.id) : jsEqual(a.path, b.path)
    }

    /// `addAttachments`: `list` with `added` appended. A file already in the list (or twice in
    /// `added`) is attached once, and nothing goes past `max`. `skipped` counts what was left out
    /// for the limit, so the editor can say so.
    public static func add(_ list: [Attachment], _ added: [Attachment], max: Int = maxPromptAttachments) -> (list: [Attachment], skipped: Int) {
        var out = list
        var skipped = 0
        for a in added {
            if out.contains(where: { sameFile($0, a) }) { continue }
            if out.count >= max {
                skipped += 1
                continue
            }
            out.append(a)
        }
        return (out, skipped)
    }

    /// `annotateAttachment`: `list` with `attachment` annotated (DESIGN.md "Annotations"). The
    /// same file already in the list gets `annotation` in place (nil takes it off), or `attachment`
    /// is added at the end with it. `skipped` is true when it wasn't there and the list was full.
    public static func annotate(
        _ list: [Attachment], _ attachment: Attachment, annotation: AttachmentAnnotation?, max: Int = maxPromptAttachments
    ) -> (list: [Attachment], skipped: Bool) {
        func set(_ a: Attachment) -> Attachment {
            var out = a
            out.annotation = annotation
            return out
        }
        if let i = list.firstIndex(where: { sameFile($0, attachment) }) {
            var out = list
            out[i] = set(list[i])
            return (out, false)
        }
        if list.count >= max { return (list, true) }
        return (list + [set(attachment)], false)
    }

    /// `removeAttachment`: `list` without the attachment at `index` (unchanged when there's none).
    public static func remove(_ list: [Attachment], at index: Int) -> [Attachment] {
        list.enumerated().filter { $0.offset != index }.map(\.element)
    }

    /// `attachmentIsImage`: whether the apps draw an image preview for it (and offer Annotate);
    /// other files show as a named chip.
    public static func isImage(kind: AttachmentKind) -> Bool { kind == .image }

    public static func isImage(_ a: Attachment) -> Bool { isImage(kind: a.kind) }

    private static let pasteExtensions: [String: String] = [
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/bmp": "bmp",
        "image/tiff": "tiff",
        "image/heic": "heic",
    ]

    /// The file name a pasted image is uploaded as: "Pasted image.png", by its MIME type (png when
    /// unknown).
    public static func pastedImageName(_ mimeType: String?) -> String {
        "Pasted image.\(pasteExtensions[Mentions.JS.lowercase(mimeType ?? "")] ?? "png")"
    }

    // MARK: Phone-only (uploads from the iPhone/iPad)

    /// HEIC/HEIF photos go up as JPEG: the agent APIs don't take HEIC images.
    public static func needsJPEG(mimeType: String?, name: String) -> Bool {
        let type = Mentions.JS.lowercase(mimeType ?? "")
        if ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"].contains(type) { return true }
        guard let ext = fileExtension(name).map(Mentions.JS.lowercase) else { return false }
        return ext == "heic" || ext == "heif"
    }

    /// `name` with its extension swapped for .jpg ("IMG_1.HEIC" → "IMG_1.jpg"; "photo" → "photo.jpg").
    public static func jpegName(_ name: String) -> String {
        let scalars = Array(name.unicodeScalars)
        if fileExtension(name) != nil, let dot = scalars.lastIndex(of: "."), dot > 0 {
            return string(scalars[..<dot]) + ".jpg"
        }
        return name + ".jpg"
    }

    /// How many of `incoming` new files fit next to `current` attachments and `pending` uploads,
    /// so the phone doesn't upload what the limit would leave out.
    public static func room(current: Int, pending: Int, incoming: Int, max: Int = maxPromptAttachments) -> Int {
        Swift.max(0, Swift.min(incoming, max - current - pending))
    }

    // MARK: Helpers

    /// `/\.([^./]+)$/.exec(s)?.[1]`: what follows the last dot, when it's non-empty and has no slash.
    static func fileExtension(_ s: String) -> String? {
        let scalars = Array(s.unicodeScalars)
        guard let dot = scalars.lastIndex(of: ".") else { return nil }
        let tail = scalars[(dot + 1)...]
        guard !tail.isEmpty, !tail.contains("/") else { return nil }
        return string(tail)
    }

    private static func string(_ s: ArraySlice<Unicode.Scalar>) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: s)
        return String(v)
    }

    private static func jsEqual(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }
}
