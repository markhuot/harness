import Foundation
import Observation

// Port of shared/src/state/messageDrafts.ts, plus the composer's saving (the desktop's
// app/src/renderer/state/messageDraftSession.ts). Message drafts (DESIGN.md "Message drafts"): the
// message the human is writing to a ticket's agent lives on the ticket (Ticket.messageDraft), so it
// can be started on one device and finished on another. The composer saves it as it's typed
// (debounced PUTs of the whole draft, each tagged with the editor's origin), and the saved copy
// replaces what it shows only when:
//   • it isn't the composer's own save coming back (same origin), however late it arrives;
//   • the field doesn't have focus: what's under the caret is the user's, and their next save wins;
//   • nothing typed here is still unsaved.

/// What a composer shows and saves.
public struct MessageDraftValue: Codable, Sendable, Equatable {
    public var text: String
    public var attachments: [Attachment]

    public init(text: String = "", attachments: [Attachment] = []) {
        self.text = text
        self.attachments = attachments
    }

    public static let empty = MessageDraftValue()
}

public enum MessageDrafts {
    /// `messageDraftValue`: the saved draft as a composer shows it (none: empty).
    public static func value(_ d: MessageDraft?) -> MessageDraftValue {
        d.map { MessageDraftValue(text: $0.text, attachments: $0.attachments) } ?? .empty
    }

    /// `sameMessageDraft`
    public static func same(_ a: MessageDraftValue, _ b: MessageDraftValue) -> Bool {
        a.text.unicodeScalars.elementsEqual(b.text.unicodeScalars) && PromptAttachments.same(a.attachments, b.attachments)
    }

    /// `messageDraftBody`: the PUT that saves `v` from the editor `origin` (empty clears it).
    public static func body(_ v: MessageDraftValue, origin: String) -> MessageDraftBody {
        MessageDraftBody(text: v.text, attachments: PromptAttachments.inputs(v.attachments), origin: origin)
    }

    /// `adoptMessageDraft`: what the editor should show instead of `shown` now that the store has
    /// `saved`, or nil to keep what it shows.
    public static func adopt(saved: MessageDraft?, origin: String, focused: Bool, dirty: Bool, shown: MessageDraftValue) -> MessageDraftValue? {
        if focused || dirty { return nil }
        if let saved, let from = saved.origin, from.unicodeScalars.elementsEqual(origin.unicodeScalars) { return nil }
        let next = value(saved)
        return same(next, shown) ? nil : next
    }

    /// `newDraftOrigin`: unique per open composer.
    public static func newOrigin() -> String {
        (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }
}

/// Why a message draft couldn't be saved, besides the service's own errors.
public enum MessageDraftError: Error, Equatable, Sendable, LocalizedError {
    case offline

    public var errorDescription: String? { "No connection" }
}

/// A ticket's message draft as its composer edits it: the text and the files waiting to go
/// (`attachments`, which the uploader and Annotate add to). One per ticket for the store's life
/// (BoardStore.messageDraft), so leaving the ticket and coming back keeps what's typed and the
/// save on its way.
@MainActor
@Observable
public final class MessageDraftSync {
    /// The message's text, as the composer shows it
    public private(set) var text: String
    /// The files waiting to go with it
    public let attachments: MessageAttachments
    /// This composer's origin: its own saves coming back are skipped.
    public let origin: String
    /// The ticket's current key (a project rename changes it)
    @ObservationIgnored public var key: String
    /// A save failed (the composer toasts it)
    @ObservationIgnored public var onError: ((any Error) -> Void)?

    @ObservationIgnored private let save: @MainActor (String, MessageDraftBody) async throws -> Ticket
    @ObservationIgnored private let onSaved: @MainActor (Ticket) -> Void
    @ObservationIgnored private let delayMs: Double
    @ObservationIgnored private let timers: any Timers
    /// What the service has from this composer (or had when it started)
    @ObservationIgnored private var saved: MessageDraftValue
    @ObservationIgnored private var focused = false
    @ObservationIgnored private var timer: TimerHandle?
    @ObservationIgnored private var inflight: Task<Void, Never>?
    @ObservationIgnored private var failed = false
    /// A send is on its way: nothing is saved until it's done.
    @ObservationIgnored private var sending = false

    public init(
        key: String,
        stored: MessageDraft?,
        save: @escaping @MainActor (String, MessageDraftBody) async throws -> Ticket,
        onSaved: @escaping @MainActor (Ticket) -> Void = { _ in },
        delayMs: Double = 500,
        timers: any Timers = TaskTimers(),
        origin: String = MessageDrafts.newOrigin()
    ) {
        let start = MessageDrafts.value(stored)
        self.key = key
        self.text = start.text
        self.attachments = MessageAttachments(start.attachments)
        self.origin = origin
        self.save = save
        self.onSaved = onSaved
        self.delayMs = delayMs
        self.timers = timers
        self.saved = start
        attachments.onChange = { [weak self] in
            self?.schedule()
        }
    }

    /// What the composer shows: the text and the files.
    public var value: MessageDraftValue { MessageDraftValue(text: text, attachments: attachments.list) }

    /// Edits the service doesn't have yet.
    public var dirty: Bool { timer != nil || inflight != nil || !MessageDrafts.same(value, saved) }

    /// The human typed.
    public func setText(_ next: String) {
        guard !next.unicodeScalars.elementsEqual(text.unicodeScalars) else { return }
        text = next
        schedule()
    }

    private func schedule() {
        if let timer { timers.clear(timer) }
        timer = nil
        if sending { return }
        // Strong capture: a pending save still goes out if the composer goes away.
        timer = timers.set(delayMs) {
            self.timer = nil
            Task { await self.flush() }
        }
    }

    /// The field gained or lost focus; on blur, catch up with `stored` (another device's edit).
    public func focus(_ focused: Bool, stored: MessageDraft?) {
        self.focused = focused
        if !focused { sync(stored) }
    }

    /// The store's copy changed: show it when the rules allow (MessageDrafts.adopt).
    public func sync(_ stored: MessageDraft?) {
        guard let next = MessageDrafts.adopt(saved: stored, origin: origin, focused: focused, dirty: dirty, shown: value) else { return }
        replace(next)
        saved = next
    }

    private func replace(_ next: MessageDraftValue) {
        text = next.text
        attachments.replace(next.attachments)
    }

    /// Save whatever hasn't gone out, one PUT at a time. False when one failed.
    @discardableResult
    public func flush() async -> Bool {
        if let timer { timers.clear(timer) }
        timer = nil
        while true {
            if let inflight {
                await inflight.value
                if failed { return false }
                continue
            }
            if sending || MessageDrafts.same(value, saved) { return true }
            let sent = value
            failed = false
            let task = Task { @MainActor in
                do {
                    let t = try await self.save(self.key, MessageDrafts.body(sent, origin: self.origin))
                    self.saved = sent
                    self.onSaved(t)
                } catch {
                    self.failed = true
                    self.onError?(error)
                }
            }
            inflight = task
            await task.value
            inflight = nil
            if failed { return false }
        }
    }

    /// Before a send: no save goes out after it (the service clears the draft when the message
    /// goes, and a late PUT would bring it back). Waits for one already on its way.
    public func beforeSend() async {
        sending = true
        if let timer { timers.clear(timer) }
        timer = nil
        if let inflight { await inflight.value }
    }

    /// The send failed: the draft is still the human's, and saving picks up again.
    public func sendFailed() {
        sending = false
        Task { await flush() }
    }

    /// The message went with `files`: the service cleared the saved draft. The text goes; files
    /// attached while it was sending stay, and are saved as the new draft.
    public func sent(files: [Attachment]) {
        sending = false
        let rest = attachments.list.filter { a in !files.contains { $0.id == a.id && $0.path == a.path } }
        saved = .empty
        replace(.empty)
        if !rest.isEmpty { attachments.add(rest) }
    }
}
