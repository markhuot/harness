import Foundation

// Shared wire protocol between the harness service and its clients: the Swift port of
// shared/src/protocol.ts. Everything here is plain JSON-serializable data.
//
// Conventions:
// - **Timestamps are epoch milliseconds, typed `Double`** (`Timestamp`), exactly as JavaScript
//   sends them. Use `Date(harnessMillis:)` / `date.harnessMillis` to convert.
// - Type names are the TS names; property names are the JSON keys.
// - `field?: T` → `T?` (omitted when nil). `field: T | null` → `@Nullable var field: T?` (always
//   encoded, nil as `null`). `field?: T | null` → `Patch<T>` (absent / null / value).
// - String unions → `OpenEnum`s that decode unknown values as `.unknown(raw)`.
// - Discriminated unions (HarnessEvent, TranscriptContent, ServerMessage, …) decode unknown
//   discriminators to `.unknown(<discriminator>:raw:)` and re-encode the raw JSON.
// - Every type decodes then re-encodes to the same JSON (ProtocolRoundTripTests checks it).

/// Epoch milliseconds, as sent by the service.
public typealias Timestamp = Double

extension Date {
    /// A `Date` from a protocol timestamp (epoch ms).
    public init(harnessMillis ms: Timestamp) { self.init(timeIntervalSince1970: ms / 1000) }
    /// This date as a protocol timestamp (epoch ms).
    public var harnessMillis: Timestamp { timeIntervalSince1970 * 1000 }
}

/// protocol.ts's exported constants and helpers.
public enum HarnessProtocol {
    /// DEFAULT_PORT
    public static let defaultPort = 7717

    /// PERMISSION_MODES
    public static let permissionModes: [PermissionMode] = PermissionMode.allKnown
    /// CLASSIFIER_BACKENDS
    public static let classifierBackends: [ClassifierBackend] = ClassifierBackend.allKnown
    /// TICKET_STATUSES
    public static let ticketStatuses: [TicketStatus] = TicketStatus.allKnown
    /// COMPLETION_ACTIONS
    public static let completionActions: [CompletionAction] = CompletionAction.allKnown
    /// PROMPT_IDS
    public static let promptIds: [PromptId] = PromptId.allKnown
    /// LISTEN_MODES
    public static let listenModes: [ListenMode] = ListenMode.allKnown

    /// Prompt ids that were renamed, old → new. Overrides saved under an old id still apply (the
    /// service migrates stored ones and maps any it's sent). RENAMED_PROMPT_IDS
    public static let renamedPromptIds: [String: PromptId] = [
        "system.complete": .systemCompleteMerge,
        "run.complete": .runCompleteMerge,
    ]

    /// An approved or skipped review: nothing left to wait for on that side. reviewPassed
    public static func reviewPassed(_ state: ReviewState) -> Bool {
        state == .approved || state == .skipped
    }

    /// A ticket acts as a conductor (steers child tickets, shows their rollup and Tickets tab) when
    /// it was created as one or once it has children. `kind` only picks the ticket's first prompt.
    /// isConductor
    public static func isConductor(kind: TicketKind, childCount: Int?) -> Bool {
        kind == .conductor || (childCount ?? 0) > 0
    }
}

extension ReviewState {
    /// `HarnessProtocol.reviewPassed(self)`
    public var passed: Bool { HarnessProtocol.reviewPassed(self) }
}
