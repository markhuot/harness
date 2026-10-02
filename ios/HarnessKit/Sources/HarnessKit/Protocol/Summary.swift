import Foundation

/// A file an agent attached to a summary; served at GET /attachments/:id.
public struct SummaryAttachment: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var kind: AttachmentKind
    /// e.g. "image/png", "video/mp4"
    public var mimeType: String
    /// The original file name, e.g. "after.png"
    public var name: String
    /// Bytes
    public var size: Int
    /// Pixels, when known from the file header (images only)
    public var width: Int?
    public var height: Int?

    public init(id: String, kind: AttachmentKind, mimeType: String, name: String, size: Int, width: Int? = nil, height: Int? = nil) {
        self.id = id
        self.kind = kind
        self.mimeType = mimeType
        self.name = name
        self.size = size
        self.width = width
        self.height = height
    }
}

public struct Summary: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var sessionId: String
    @Nullable public var ticketId: String?
    public var author: SummaryAuthor
    /// Short markdown update, e.g. "Implemented X; tests pass; next: Y"
    public var body: String
    public var createdAt: Timestamp
    /// In the order the agent listed them; [] when there are none
    public var attachments: [SummaryAttachment]

    public init(
        id: String, sessionId: String, ticketId: String? = nil, author: SummaryAuthor, body: String,
        createdAt: Timestamp, attachments: [SummaryAttachment] = []
    ) {
        self.id = id
        self.sessionId = sessionId
        self.ticketId = ticketId
        self.author = author
        self.body = body
        self.createdAt = createdAt
        self.attachments = attachments
    }
}
