import Foundation

/// A file attached to a New session's prompt (Ticket.promptAttachments). Unlike an Attachment it
/// isn't copied: `path` is where the file is on the service's machine, so it can go missing.
public struct PromptAttachment: Codable, Sendable, Equatable, Hashable {
    /// Absolute path on the service's machine
    public var path: String
    /// Display name: the file name when it was attached ("Pasted image.png" for a paste)
    public var name: String
    /// "file": a file that was already on disk (dropped or picked on the Mac), referenced in place.
    /// "upload": bytes the service stored with POST /uploads (a paste, or anything from the
    /// iPhone/iPad), deleted with the ticket.
    public var source: PromptAttachmentSource
    /// The human's numbered notes on this image (DESIGN.md "Annotations"); the file itself is untouched.
    public var annotation: AttachmentAnnotation?

    public init(path: String, name: String, source: PromptAttachmentSource = .file, annotation: AttachmentAnnotation? = nil) {
        self.path = path
        self.name = name
        self.source = source
        self.annotation = annotation
    }
}

/// A prompt attachment as clients send it: the name defaults to the file's. `source` is ignored by
/// the service, which decides it from where the file is; clients keep it in their local copy.
public struct PromptAttachmentInput: Codable, Sendable, Equatable {
    /// An absolute path on the service's machine, or `attachment:<id>` for one of the ticket's spec
    /// images (the service stores its file's path).
    public var path: String
    public var name: String?
    public var source: PromptAttachmentSource?
    public var annotation: AttachmentAnnotation?

    public init(path: String, name: String? = nil, source: PromptAttachmentSource? = nil, annotation: AttachmentAnnotation? = nil) {
        self.path = path
        self.name = name
        self.source = source
        self.annotation = annotation
    }
}

/// `MAX_PROMPT_ATTACHMENTS`: most prompt attachments one ticket takes.
public let maxPromptAttachments = 20
