import Foundation
import Observation

/// The files waiting to go with the next message from a ticket's composer (MessageBody.attachments):
/// added as their uploads land (the same file once, by id; capped at maxPromptAttachments),
/// removable before Send, cleared once a send goes through. The list uses the same rules as a New
/// session's prompt attachments (PromptAttachments). An annotated image carries its notes on its
/// own entry (Attachment.annotation), so they go wherever it goes.
@MainActor
@Observable
public final class MessageAttachments {
    public private(set) var list: [Attachment] = []

    public init(_ list: [Attachment] = []) {
        self.list = list
    }

    public var isEmpty: Bool { list.isEmpty }
    public var count: Int { list.count }

    /// Add `added` after what's there. Returns how many the limit left out.
    @discardableResult
    public func add(_ added: [Attachment]) -> Int {
        let result = PromptAttachments.add(list, added)
        list = result.list
        return result.skipped
    }

    /// Annotate `attachment`: the same waiting file (by id) gets `annotation` (nil takes it off), or
    /// it's added at the end with it. False when it wasn't there and the list is full.
    @discardableResult
    public func annotate(_ attachment: Attachment, annotation: AttachmentAnnotation?) -> Bool {
        let result = PromptAttachments.annotate(list, attachment, annotation: annotation)
        list = result.list
        return !result.skipped
    }

    /// Take the attachment at `index` off the message (nothing when there's none), with its notes.
    public func remove(at index: Int) {
        guard list.indices.contains(index) else { return }
        list = PromptAttachments.remove(list, at: index)
    }

    public func clear() {
        list = []
    }

    /// The list as POST /tickets/:key/messages sends it: each attachment whole, with its notes.
    public var inputs: [AttachmentInput] { PromptAttachments.inputs(list) }
}
