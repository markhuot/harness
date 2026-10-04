import Foundation

/// Every file attached anywhere (DESIGN.md "Attachments"): a spec's media (referenced from the
/// spec as `![alt](attachment:<id>)`, TicketDetail.attachments), a New session's files
/// (Ticket.promptAttachments), a message's files (MessageBody.attachments, the transcript entry,
/// Run.attachments). One record, one id: GET /attachments/:id serves the file
/// (HarnessClient.attachmentUrl; 404 once it's gone).
public struct Attachment: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    /// Absolute path on the service's machine
    public var path: String
    /// Display name: the file name when it was attached ("Pasted image.png" for a paste, the alt
    /// text for spec media)
    public var name: String
    public var source: AttachmentSource
    public var kind: AttachmentKind
    /// e.g. "image/png", "video/mp4"; "" when unknown
    public var mimeType: String
    /// Bytes, when known
    public var size: Int?
    /// Pixels, when known from the file header (images only)
    public var width: Int?
    public var height: Int?
    /// The human's numbered notes on this image (DESIGN.md "Annotations"). It belongs to this use
    /// of the file: the same image can carry different notes in two messages. The file itself is
    /// never changed.
    public var annotation: AttachmentAnnotation?

    public init(
        id: String, path: String, name: String, source: AttachmentSource = .file, kind: AttachmentKind, mimeType: String = "",
        size: Int? = nil, width: Int? = nil, height: Int? = nil, annotation: AttachmentAnnotation? = nil
    ) {
        self.id = id
        self.path = path
        self.name = name
        self.source = source
        self.kind = kind
        self.mimeType = mimeType
        self.size = size
        self.width = width
        self.height = height
        self.annotation = annotation
    }

    private enum CodingKeys: String, CodingKey {
        case id, path, name, source, kind, mimeType, size, width, height, annotation
    }

    /// `path` and `name` are required (a record without them can't be shown or sent); the rest
    /// falls back the way `attachmentFromInput` fills an input, so an older service's records
    /// (no id, kind or mimeType) still decode.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        name = try c.decode(String.self, forKey: .name)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        source = try c.decodeIfPresent(AttachmentSource.self, forKey: .source) ?? .file
        kind = try c.decodeIfPresent(AttachmentKind.self, forKey: .kind) ?? PromptAttachments.kindByName(name.isEmpty ? path : name)
        mimeType = try c.decodeIfPresent(String.self, forKey: .mimeType) ?? ""
        size = try c.decodeIfPresent(Int.self, forKey: .size)
        width = try c.decodeIfPresent(Int.self, forKey: .width)
        height = try c.decodeIfPresent(Int.self, forKey: .height)
        annotation = try c.decodeIfPresent(AttachmentAnnotation.self, forKey: .annotation)
    }
}

/// An attachment as clients send it: `id` reuses an attachment the service already has (a spec
/// image, an upload, a registered file, a file from an earlier message); `path` registers a file
/// on the service's machine (agents and the CLI). A full Attachment is a valid input: the service
/// reads only `id` (or `path`), `name` and `annotation`, and works out the rest itself.
public struct AttachmentInput: Codable, Sendable, Equatable {
    public var id: String?
    public var path: String?
    public var name: String?
    public var annotation: AttachmentAnnotation?
    public var source: AttachmentSource?
    public var kind: AttachmentKind?
    public var mimeType: String?
    public var size: Int?
    public var width: Int?
    public var height: Int?

    public init(
        id: String? = nil, path: String? = nil, name: String? = nil, annotation: AttachmentAnnotation? = nil,
        source: AttachmentSource? = nil, kind: AttachmentKind? = nil, mimeType: String? = nil,
        size: Int? = nil, width: Int? = nil, height: Int? = nil
    ) {
        self.id = id
        self.path = path
        self.name = name
        self.annotation = annotation
        self.source = source
        self.kind = kind
        self.mimeType = mimeType
        self.size = size
        self.width = width
        self.height = height
    }

    /// The whole attachment as an input (`attachmentInputs` sends each one this way).
    public init(_ a: Attachment) {
        self.init(
            id: a.id, path: a.path, name: a.name, annotation: a.annotation, source: a.source, kind: a.kind,
            mimeType: a.mimeType, size: a.size, width: a.width, height: a.height
        )
    }
}

/// `MAX_PROMPT_ATTACHMENTS`: most attachments one New session or message takes.
public let maxPromptAttachments = 20
