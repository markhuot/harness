import Foundation

// The Approve button and its menu: which request each choice sends. The choices themselves come
// from `Completion.completionOptions`. There's no Complete step: approving lands the work.
//
// Labels for an action this build doesn't know are nil (`COMPLETION_ACTION_LABELS` has no entry,
// so the JSON row has no label), and a choice with such a label stays nil rather than failing.
// Instructions are trimmed with JS `trim()` semantics (NBSP goes, NEL stays).

public enum Approve {
    /// A row of the Approve menu: a completion action, or approving without one. Encodes as the
    /// string union `CompletionAction | "none"`.
    public enum Choice: Codable, Sendable, Hashable {
        case action(CompletionAction)
        case none

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = raw == "none" ? .none : .action(CompletionAction(rawValue: raw))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .none: try c.encode("none")
            case let .action(a): try c.encode(a.rawValue)
            }
        }
    }

    /// One menu row: `{ value, label }`. `label` is nil only for an action this build doesn't know.
    public struct MenuChoice: Codable, Sendable, Equatable {
        public var value: Choice
        public var label: String?

        public init(value: Choice, label: String?) {
            self.value = value
            self.label = label
        }
    }

    /// A row of a select of completion actions: the JSON shape of `SelectOption<CompletionAction>`
    /// (SelectOptions.swift). Local stand-in: dedupe with the SelectOption port
    /// (HARNESS-131) once both land. `label` is nil only for an action this build doesn't know.
    public struct Option: Codable, Sendable, Equatable {
        public var value: CompletionAction
        public var label: String?
        /// Second line in the menu (a description)
        public var subtitle: String?
        public var disabled: Bool?

        public init(value: CompletionAction, label: String?, subtitle: String? = nil, disabled: Bool? = nil) {
            self.value = value
            self.label = label
            self.subtitle = subtitle
            self.disabled = disabled
        }
    }

    /// What a choice sends: a human review (`POST /tickets/:key/review`) or a completion
    /// (`POST /tickets/:key/complete`). Encodes as `{ via, body }`.
    public enum Request: Codable, Sendable, Equatable {
        case review(HumanReviewBody)
        case complete(CompleteBody)

        private enum CodingKeys: String, CodingKey { case via, body }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            switch try c.decode(String.self, forKey: .via) {
            case "review": self = .review(try c.decode(HumanReviewBody.self, forKey: .body))
            case "complete": self = .complete(try c.decode(CompleteBody.self, forKey: .body))
            case let via: throw DecodingError.dataCorruptedError(forKey: .via, in: c, debugDescription: "unknown via \(via)")
            }
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .review(body):
                try c.encode("review", forKey: .via)
                try c.encode(body, forKey: .body)
            case let .complete(body):
                try c.encode("complete", forKey: .via)
                try c.encode(body, forKey: .body)
            }
        }
    }

    /// The menu's rows, in order: the offered actions, then "Approve and take no action".
    public static func approveMenuChoices(_ opts: Completion.Options) -> [MenuChoice] {
        opts.actions.map { MenuChoice(value: .action($0), label: Completion.label(for: $0)) }
            + [MenuChoice(value: .none, label: Completion.approveNoActionLabel)]
    }

    /// What a menu row sends. "none" completes without a run (which records the human approval too);
    /// an action approves with it. Custom carries the instructions from the "Approve and…" sheet.
    public static func approveRequest(_ choice: Choice, instructions: String? = nil) -> Request {
        guard case let .action(action) = choice else { return .complete(CompleteBody(skipAgent: true)) }
        let text = instructions.map(JSCompat.trim)
        let carried = action == .custom ? text.flatMap { $0.isEmpty ? nil : $0 } : nil
        return .review(HumanReviewBody(decision: .approve, action: action, instructions: carried))
    }

    /// The primary button's request: the preselected action. A custom one repeats the instructions the
    /// ticket was approved with before (a re-approval after changes), so a plain "Approve" doesn't drop them.
    public static func primaryApproveRequest(_ opts: Completion.Options, completionAction: CompletionAction?, completionInstructions: String?) -> Request {
        let earlier = opts.defaultAction == .custom && completionAction == .custom ? completionInstructions : nil
        return approveRequest(.action(opts.defaultAction), instructions: earlier)
    }

    /// `primaryApproveRequest` for a protocol ticket.
    public static func primaryApproveRequest(_ opts: Completion.Options, ticket: Ticket) -> Request {
        primaryApproveRequest(opts, completionAction: ticket.completionAction.optional, completionInstructions: ticket.completionInstructions.optional)
    }

    /// Short names for a completion action, in the project's "When approved" select.
    public static let completionActionNames: [CompletionAction: String] = [
        .merge: "Merge",
        .pr: "Open PR",
        .cleanup: "Clean up",
        .custom: "Custom",
    ]

    /// Options for a select of completion actions.
    public static func completionActionOptions(_ actions: [CompletionAction]) -> [Option] {
        actions.map { Option(value: $0, label: completionActionNames[$0]) }
    }
}
