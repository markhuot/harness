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

    public init(path: String, name: String, source: PromptAttachmentSource = .file) {
        self.path = path
        self.name = name
        self.source = source
    }
}

/// A prompt attachment as clients send it: the name defaults to the file's. `source` is ignored by
/// the service, which decides it from where the file is; clients keep it in their local copy.
public struct PromptAttachmentInput: Codable, Sendable, Equatable {
    public var path: String
    public var name: String?
    public var source: PromptAttachmentSource?

    public init(path: String, name: String? = nil, source: PromptAttachmentSource? = nil) {
        self.path = path
        self.name = name
        self.source = source
    }
}

/// `MAX_PROMPT_ATTACHMENTS`: most prompt attachments one ticket takes.
public let maxPromptAttachments = 20
