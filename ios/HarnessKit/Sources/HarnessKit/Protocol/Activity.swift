import Foundation

/// A ticket's image or video (DESIGN.md "Spec revisions and attachments"), referenced from its spec
/// as `![alt](attachment:<id>)` and served at GET /attachments/:id. It lives until the ticket is
/// deleted.
public struct Attachment: Codable, Sendable, Equatable, Identifiable {
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

/// ActivityEntry.meta: typed extras per kind. Every field is optional.
public struct ActivityMeta: Codable, Sendable, Equatable {
    /// blocked: the question (same as the ticket's blockedReason when it was posted)
    public var question: String?
    /// review_approved / changes_requested: the agent review round, 1 for the first review
    public var round: Int?
    /// review_approved / changes_requested: the commit the reviewer looked at (git rev-parse HEAD)
    public var commit: Patch<String>
    /// review_approved / changes_requested / approved: who decided ("agent", "human", "conductor")
    public var by: String?
    /// unblocked: what resolved it
    public var note: String?
    /// submitted: the spec revision the work was submitted at
    public var specRevision: Int?

    public init(
        question: String? = nil, round: Int? = nil, commit: Patch<String> = .absent, by: String? = nil,
        note: String? = nil, specRevision: Int? = nil
    ) {
        self.question = question
        self.round = round
        self.commit = commit
        self.by = by
        self.note = note
        self.specRevision = specRevision
    }
}

/// One entry of a ticket's Activity: a typed timeline of notes, submits, blocks, review decisions,
/// logged messages and so on (DESIGN.md "Activity").
public struct ActivityEntry: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var sessionId: String
    @Nullable public var ticketId: String?
    public var kind: ActivityKind
    public var author: ActivityAuthor
    /// Short markdown, e.g. "Fixed the button color; tests pass"
    public var body: String
    public var meta: ActivityMeta
    public var createdAt: Timestamp

    public init(
        id: String, sessionId: String, ticketId: String? = nil, kind: ActivityKind = .note, author: ActivityAuthor,
        body: String, meta: ActivityMeta = .init(), createdAt: Timestamp
    ) {
        self.id = id
        self.sessionId = sessionId
        self.ticketId = ticketId
        self.kind = kind
        self.author = author
        self.body = body
        self.meta = meta
        self.createdAt = createdAt
    }
}

/// GET /tickets/:key/spec/revisions: one revision's metadata, oldest first.
public struct SpecRevisionInfo: Codable, Sendable, Equatable, Identifiable {
    public var rev: Int
    public var author: SpecRevisionAuthor
    /// The run that wrote it (agent revisions), else nil
    @Nullable public var runId: String?
    @Nullable public var runKind: RunKind?
    /// What changed, in a few words (the edit_spec / update_spec note, "Created", "Edited by hand")
    public var note: String
    /// True on the revision the human approved by pressing Start
    public var approvedBaseline: Bool
    public var createdAt: Timestamp

    public var id: Int { rev }

    public init(
        rev: Int, author: SpecRevisionAuthor, runId: String? = nil, runKind: RunKind? = nil, note: String,
        approvedBaseline: Bool = false, createdAt: Timestamp
    ) {
        self.rev = rev
        self.author = author
        self.runId = runId
        self.runKind = runKind
        self.note = note
        self.approvedBaseline = approvedBaseline
        self.createdAt = createdAt
    }
}

/// GET /tickets/:key/spec/revisions/:rev: a revision with its body.
public struct SpecRevision: Codable, Sendable, Equatable {
    public var rev: Int
    public var author: SpecRevisionAuthor
    @Nullable public var runId: String?
    @Nullable public var runKind: RunKind?
    public var note: String
    public var approvedBaseline: Bool
    public var createdAt: Timestamp
    public var body: String

    public init(_ info: SpecRevisionInfo, body: String) {
        rev = info.rev
        author = info.author
        runId = info.runId
        runKind = info.runKind
        note = info.note
        approvedBaseline = info.approvedBaseline
        createdAt = info.createdAt
        self.body = body
    }

    /// The metadata without the body.
    public var info: SpecRevisionInfo {
        SpecRevisionInfo(
            rev: rev, author: author, runId: runId, runKind: runKind, note: note, approvedBaseline: approvedBaseline,
            createdAt: createdAt)
    }
}

/// GET /tickets/:key/spec/revisions/:rev?diff=<otherRev>: a unified diff (`Diff.parse` reads it)
/// from revision `from` to `to`. `diff` is "" when they're the same.
public struct SpecDiff: Codable, Sendable, Equatable {
    public var from: Int
    public var to: Int
    public var diff: String

    public init(from: Int, to: Int, diff: String) {
        self.from = from
        self.to = to
        self.diff = diff
    }
}

/// The `data` of PATCH /tickets/:key's 409 when baseRevision isn't the current spec revision.
public struct SpecConflict: Codable, Sendable, Equatable {
    public var currentRevision: Int
    public var spec: String

    public init(currentRevision: Int, spec: String) {
        self.currentRevision = currentRevision
        self.spec = spec
    }
}
