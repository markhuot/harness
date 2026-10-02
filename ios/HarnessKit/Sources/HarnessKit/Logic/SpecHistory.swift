import Foundation

// The Spec tab's history bar (DESIGN.md "Spec revisions and attachments"): which revision is on
// screen, stepping and scrubbing through the others, and the bar's copy. Bodies and metadata load
// lazily (BoardState.specBody / specRevisions); this only decides what to show and what to fetch.

/// Which revision the Spec tab shows. It follows the newest revision (`pinned` nil) until the user
/// steps or scrubs back; stepping or scrubbing to the newest follows again, so a revision that
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

    /// One revision back (`delta` -1) or forward (+1) from the one on screen.
    public mutating func step(_ delta: Int, latest: Int) {
        show(shown(latest: latest) + delta, latest: latest)
    }

    /// Whether `step(delta)` would move.
    public func canStep(_ delta: Int, latest: Int) -> Bool {
        let target = shown(latest: latest) + delta
        return target >= 1 && target <= max(1, latest)
    }

    /// Back to the newest revision.
    public mutating func follow() { pinned = nil }
}

public enum SpecHistory {
    /// The ticket's newest revision (1 for services that don't send it).
    public static func latest(_ t: Ticket) -> Int { max(1, t.specRevision ?? 1) }

    /// The revision "Show changes" compares `rev` with: the one before it; nil for the first.
    public static func previous(_ rev: Int) -> Int? { rev > 1 ? rev - 1 : nil }

    /// Who wrote a revision, as the bar names them.
    public static func authorLabel(_ a: SpecRevisionAuthor) -> String {
        switch a {
        case .agent: "Agent"
        case .human: "You"
        default: "Harness"
        }
    }

    /// The bar's first line: "Rev 7 of 7", then "Agent · 3m ago" once the revision's metadata has
    /// loaded. The note and the baseline tag sit beside it (`SpecHistoryLine`).
    public static func line(rev: Int, latest: Int, info: SpecRevisionInfo?, now: Double) -> SpecHistoryLine {
        var meta: [String] = []
        if let info {
            meta.append(authorLabel(info.author))
            if info.createdAt > 0 { meta.append(Format.relativeTime(info.createdAt, now: now)) }
        }
        let note = info.map { JSCompat.trim($0.note) } ?? ""
        return SpecHistoryLine(
            title: "Rev \(rev) of \(max(rev, latest))", meta: meta.joined(separator: " · "), note: note,
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

    /// Whether the revision list needs (re)fetching for a ticket whose newest revision is `latest`:
    /// not loaded yet, or a revision the list doesn't have (a spec.revised that arrived before the
    /// list did, or a reconnect that missed events).
    public static func needsRevisions(_ state: BoardState, ticketId: String, latest: Int) -> Bool {
        guard let list = state.specRevisions[ticketId] else { return true }
        return !list.contains { $0.rev == latest }
    }

    /// A spec diff (SpecDiff.diff) as one file of the Changes tab's patch, so its rows draw the same
    /// way. The service's diff starts at `---` with no `diff --git` line, which the patch parser
    /// needs to find the file. Nil when the diff is empty.
    public static func diff(_ unified: String) -> ChangesFileDiff? {
        guard !JSCompat.trim(unified).isEmpty else { return nil }
        let patch = unified.hasPrefix("diff --git") ? unified : "diff --git a/spec.md b/spec.md\n" + unified
        return ChangesPatch.parse(patch).first
    }
}

/// The history bar's copy for one revision.
public struct SpecHistoryLine: Equatable, Sendable {
    /// "Rev 7 of 7"
    public var title: String
    /// "Agent · 3m ago" ("" until the metadata loads)
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
