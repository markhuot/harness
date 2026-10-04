import Foundation
import Observation

/// The files waiting to go with the next message from a ticket's composer (MessageBody.attachments):
/// added as their uploads land (deduped by path, capped at maxPromptAttachments), removable before
/// Send, cleared once a send goes through. The list uses the same rules as a New session's prompt
/// attachments (PromptAttachments). Beside the list it keeps the numbered notes on its annotated
/// images (MessageBody.annotations), each naming its file by index; removing a file drops its notes
/// and moves the later ones up, so every note stays on its image.
@MainActor
@Observable
public final class MessageAttachments {
    public private(set) var list: [PromptAttachment] = []
    /// The notes on images in `list`, in attachment order.
    public private(set) var annotations: [MessageAnnotation] = []

    public init(_ list: [PromptAttachment] = [], annotations: [MessageAnnotation] = []) {
        self.list = list
        self.annotations = Annotations.within(annotations, count: list.count)
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

    /// Add an annotated image after what's there, with its notes (`annotation.attachment` is
    /// ignored). False when the list is full or already has that file.
    @discardableResult
    public func addAnnotated(_ added: PromptAttachmentInput, annotation: MessageAnnotation) -> Bool {
        let before = list.count
        let result = PromptAttachments.add(list, [added])
        guard result.list.count > before else { return false }
        list = result.list
        annotations = Annotations.with(annotations, at: before, annotation)
        return true
    }

    /// Put `replacement` in place of the attachment at `index`, with its notes (nil: none), e.g. an
    /// image annotated again. Nothing when there's no attachment there.
    public func replace(at index: Int, with replacement: PromptAttachmentInput, annotation: MessageAnnotation?) {
        guard list.indices.contains(index) else { return }
        list[index] = PromptAttachments.fromInput(replacement)
        annotations = Annotations.with(annotations, at: index, annotation)
    }

    /// The notes on the attachment at `index`, if it has any.
    public func annotation(at index: Int) -> MessageAnnotation? {
        Annotations.annotation(for: index, in: annotations)
    }

    /// Take the attachment at `index` off the message (nothing when there's none), with its notes.
    public func remove(at index: Int) {
        guard list.indices.contains(index) else { return }
        list = PromptAttachments.remove(list, at: index)
        annotations = Annotations.without(annotations, at: index)
    }

    public func clear() {
        list = []
        annotations = []
    }

    /// The notes as POST /tickets/:key/messages sends them: only those on files still in the list.
    public var outgoingAnnotations: [MessageAnnotation] { Annotations.within(annotations, count: list.count) }

    /// The list as POST /tickets/:key/messages sends it (the service decides `source` itself).
    public var inputs: [PromptAttachmentInput] { PromptAttachments.inputs(list) }
}
