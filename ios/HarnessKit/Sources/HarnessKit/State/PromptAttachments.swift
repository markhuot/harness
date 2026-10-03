import Foundation

// Port of shared/src/state/promptAttachments.ts. Prompt attachments (DESIGN.md "Prompt
// attachments"): files a human attaches to a New session. The pure pieces both apps use: turning
// what a client has into the list a draft keeps, the PATCH side of it, and which ones get an image
// preview. Paths compare as JS strings do (code units, not canonical equivalence).

public enum PromptAttachments {
    /// The last path component: "/a/b/shot.png" → "shot.png".
    public static func fileBaseName(_ path: String) -> String {
        var scalars = Array(path.unicodeScalars)
        while scalars.last == "/" { scalars.removeLast() }
        guard let i = scalars.lastIndex(of: "/") else { return string(scalars[...]) }
        return string(scalars[(i + 1)...])
    }

    /// What a client sent, as the draft keeps it: the file's name when none was given, "file"
    /// unless it says otherwise.
    public static func fromInput(_ a: PromptAttachmentInput) -> PromptAttachment {
        let name = a.name.map(JSCompat.trim).flatMap { $0.isEmpty ? nil : $0 } ?? fileBaseName(a.path)
        return PromptAttachment(path: a.path, name: name, source: a.source ?? .file)
    }

    /// The list as a create or PATCH body sends it (the service decides `source` itself).
    public static func inputs(_ list: [PromptAttachment]) -> [PromptAttachmentInput] {
        list.map { PromptAttachmentInput(path: $0.path, name: $0.name) }
    }

    /// The list as inputs that keep `source`, for a local edit (`applyTicketPatch` would otherwise
    /// turn every upload into "file" until the service answers).
    public static func inputsKeepingSource(_ list: [PromptAttachment]) -> [PromptAttachmentInput] {
        list.map { PromptAttachmentInput(path: $0.path, name: $0.name, source: $0.source) }
    }

    /// Same files, same names, same order.
    public static func same(_ a: [PromptAttachment], _ b: [PromptAttachment]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy { jsEqual($0.path, $1.path) && jsEqual($0.name, $1.name) }
    }

    /// `list` with `added` appended: a path already in the list (or twice in `added`) is attached
    /// once, and nothing goes past `max`. `skipped` counts what was left out for the limit, so the
    /// editor can say so.
    public static func add(_ list: [PromptAttachment], _ added: [PromptAttachmentInput], max: Int = maxPromptAttachments) -> (list: [PromptAttachment], skipped: Int) {
        var out = list
        var seen = Set(list.map { key($0.path) })
        var skipped = 0
        for a in added {
            let k = key(a.path)
            if seen.contains(k) { continue }
            if out.count >= max {
                skipped += 1
                continue
            }
            seen.insert(k)
            out.append(fromInput(a))
        }
        return (out, skipped)
    }

    /// `list` without the attachment at `index` (unchanged when there's none).
    public static func remove(_ list: [PromptAttachment], at index: Int) -> [PromptAttachment] {
        list.enumerated().filter { $0.offset != index }.map(\.element)
    }

    private static let previewExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp"]

    /// Whether the apps draw an image preview for it (from its extension); other files show as a
    /// named chip.
    public static func isImage(name: String, path: String) -> Bool {
        guard let ext = fileExtension(name) ?? fileExtension(path) else { return false }
        return previewExtensions.contains(Mentions.JS.lowercase(ext))
    }

    public static func isImage(_ a: PromptAttachment) -> Bool { isImage(name: a.name, path: a.path) }

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

    /// The toast when the limit left files out.
    public static func limitMessage(skipped: Int, max: Int = maxPromptAttachments) -> String {
        "A session takes up to \(max) attachments: \(skipped) \(skipped == 1 ? "file was" : "files were") left out."
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

    /// A JS-equality key: Swift's String hashing would merge canonically equivalent paths.
    private static func key(_ s: String) -> [UInt32] { s.unicodeScalars.map(\.value) }

    private static func jsEqual(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }
}
