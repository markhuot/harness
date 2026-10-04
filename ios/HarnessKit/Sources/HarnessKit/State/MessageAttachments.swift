import Foundation
import Observation

/// The files waiting to go with the next message from a ticket's composer (MessageBody.attachments):
/// added as their uploads land (deduped by path, capped at maxPromptAttachments), removable before
/// Send, cleared once a send goes through. The list uses the same rules as a New session's prompt
/// attachments (PromptAttachments).
@MainActor
@Observable
public final class MessageAttachments {
    public private(set) var list: [PromptAttachment] = []

    public init(_ list: [PromptAttachment] = []) {
        self.list = list
    }

    public var isEmpty: Bool { list.isEmpty }
    public var count: Int { list.count }

    /// Add `added` after what's there. Returns how many the limit left out.
    @discardableResult
    public func add(_ added: [PromptAttachmentInput]) -> Int {
        let result = PromptAttachments.add(list, added)
        list = result.list
        return result.skipped
    }

    /// Take the attachment at `index` off the message (nothing when there's none).
    public func remove(at index: Int) {
        list = PromptAttachments.remove(list, at: index)
    }

    public func clear() {
        list = []
    }

    /// The list as POST /tickets/:key/messages sends it (the service decides `source` itself).
    public var inputs: [PromptAttachmentInput] { PromptAttachments.inputs(list) }
}
