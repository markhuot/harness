import Foundation

// The Spec tab's history bar (DESIGN.md "Spec revisions and attachments"): which revision is on
// screen, scrubbing through the others, and the bar's copy. Bodies and metadata load
// lazily (BoardState.specBody / specRevisions); this only decides what to show and what to fetch.

/// Which revision the Spec tab shows. It follows the newest revision (`pinned` nil) until the user
/// scrubs back; scrubbing to the newest follows again, so a revision that
/// lands while the user reads an older one doesn't move them, and one that lands while they're on
/// the newest shows at once.
public struct SpecScrubber: Equatable, Sendable {
    /// The revision the user picked; nil follows the newest
    public private(set) var pinned: Int?

    public init(pinned: Int? = nil) {
        self.pinned = pinned
    }

    /// True while it follows the newest revision.
    public var following: Bool { pinned == nil }

    /// The revision on screen when the newest is `latest`: the pinned one (kept within 1...latest),
    /// else the newest.
    public func shown(latest: Int) -> Int {
        let latest = max(1, latest)
        guard let pinned else { return latest }
        return min(max(1, pinned), latest)
    }

    /// Show `rev` (clamped to 1...latest). The newest follows again.
    public mutating func show(_ rev: Int, latest: Int) {
        let latest = max(1, latest)
        let r = min(max(1, rev), latest)
        pinned = r == latest ? nil : r
    }
}

public enum SpecHistory {
    /// The ticket's newest revision (1 for services that don't send it).
    public static func latest(_ t: Ticket) -> Int { max(1, t.specRevision ?? 1) }

    /// The revision "Show changes" compares `rev` with: the one before it; nil for the first.
    public static func previous(_ rev: Int) -> Int? { rev > 1 ? rev - 1 : nil }

    /// The bar's copy for a revision: when it was written ("3m ago", once its metadata has loaded),
    /// its note and the baseline tag. The count ("Rev 7 of 7") isn't on the bar: the timeline's
    /// bubble shows it while dragging, and VoiceOver reads it (`SpecHistoryLine`).
    public static func line(rev: Int, latest: Int, info: SpecRevisionInfo?, now: Double) -> SpecHistoryLine {
        let meta = info.flatMap { $0.createdAt > 0 ? Format.relativeTime($0.createdAt, now: now) : nil } ?? ""
        let note = info.map { JSCompat.trim($0.note) } ?? ""
        return SpecHistoryLine(
            title: "Rev \(rev) of \(max(rev, latest))", meta: meta, note: note,
            baseline: info?.approvedBaseline ?? false)
    }

    /// The bar as VoiceOver reads it.
    public static func accessibilityLabel(_ l: SpecHistoryLine) -> String {
        ([l.title, l.meta] + (l.baseline ? [baselineLabel] : []) + [l.note]).filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// The approved baseline's tag: the revision that was current when the human pressed Start.
    public static let baselineLabel = "Approved plan"

    /// The revision's metadata, if its list has loaded.
    public static func info(_ state: BoardState, ticketId: String, rev: Int) -> SpecRevisionInfo? {
        state.specRevisions[ticketId]?.first { $0.rev == rev }
    }

    /// The approved plan's revision: the ticket's baseline, else the one the revision list marks.
    public static func baseline(_ state: BoardState, ticket: Ticket) -> Int? {
        ticket.specBaselineRevision.optional ?? state.specRevisions[ticket.id]?.first { $0.approvedBaseline }?.rev
    }

    /// The revision under a finger `x` points into the revision timeline, a `width` point strip
    /// split into `latest` equal segments: off either end clamps to the first or newest.
    public static func revisionAt(_ x: Double, width: Double, latest: Int) -> Int {
        guard latest > 1, width > 0 else { return max(1, latest) }
        return min(latest, max(1, Int((x / width * Double(latest)).rounded(.down)) + 1))
    }

    /// How the timeline draws one revision's segment (`segmentTone`).
    public enum SegmentTone: Equatable, Sendable {
        /// The revision on show
        case shown
        /// The approved plan
        case baseline
        /// Before the one on show
        case before
        /// After the one on show
        case after
    }

    /// Segments are neutral: the ones before the revision on show read as passed, the rest as still
    /// ahead. Only the revision on show and the approved plan are marked, and the one on show wins
    /// when it's also the approved plan.
    public static func segmentTone(rev: Int, shown: Int, baseline: Int?) -> SegmentTone {
        if rev == shown { return .shown }
        if rev == baseline { return .baseline }
        return rev < shown ? .before : .after
    }

    /// Whether the revision list needs (re)fetching for a ticket whose newest revision is `latest`:
    /// not loaded yet, or a revision the list doesn't have (a spec.revised that arrived before the
    /// list did, or a reconnect that missed events).
    public static func needsRevisions(_ state: BoardState, ticketId: String, latest: Int) -> Bool {
        guard let list = state.specRevisions[ticketId] else { return true }
        return !list.contains { $0.rev == latest }
    }
}

/// The history bar's copy for one revision.
public struct SpecHistoryLine: Equatable, Sendable {
    /// "Rev 7 of 7": the timeline's bubble and VoiceOver, not the bar
    public var title: String
    /// "3m ago" ("" until the metadata loads, or for a revision with no time)
    public var meta: String
    /// What the revision changed (its note), "" when none
    public var note: String
    /// The approved baseline
    public var baseline: Bool
}

/// The Details tab's spec editor: the text being edited and the revision it started from, which a
/// save sends as `baseRevision` so it can't silently overwrite a revision the user hasn't seen.
/// While the text is unchanged it follows the ticket's newer revisions; once the user has edited it,
/// it keeps their text and the old base, so a save of a stale spec gets the 409 and the user picks
/// Reload (take the newer spec) or Overwrite (save theirs over it).
public struct SpecDraft: Equatable, Sendable {
    /// What the field holds
    public var text: String
    /// The revision `text` started from
    public private(set) var base: Int
    /// That revision's text
    public private(set) var original: String

    public init(_ t: Ticket) {
        text = t.spec
        original = t.spec
        base = SpecHistory.latest(t)
    }

    /// The user changed the text.
    public var dirty: Bool { !Branches.jsEqual(text, original) }

    /// The ticket changed: follow its spec unless the user is editing (or it's now what they wrote).
    public mutating func follow(_ t: Ticket) {
        if !dirty || Branches.jsEqual(text, t.spec) { self = SpecDraft(t) }
    }

    /// The PATCH for a save.
    public var patch: UpdateTicketBody { UpdateTicketBody(spec: text, baseRevision: base) }

    /// Drop the edit for the ticket's current spec.
    public mutating func revert(_ t: Ticket) { self = SpecDraft(t) }

    /// Reload after a conflict: the newer spec replaces the user's text.
    public mutating func reload(_ c: SpecConflict) {
        text = c.spec
        original = c.spec
        base = c.currentRevision
    }

    /// Overwrite after a conflict: keep the user's text, now based on the newer revision, so the
    /// next `patch` replaces it.
    public mutating func overwrite(_ c: SpecConflict) {
        original = c.spec
        base = c.currentRevision
    }
}
