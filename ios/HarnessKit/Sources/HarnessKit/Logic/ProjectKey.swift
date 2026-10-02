import Foundation

// Port of shared/src/state/projectKey.ts. Live validation + preview for the project identifier
// field (Project settings → Identifier). Mirrors the service's rules (checkProjectKey +
// Orchestrator.updateProject collisions) so the field can explain a rename before it's saved; the
// service stays the authority.
//
// Keys and ids compare by code point (JS `===`), not with Swift's canonical String equality.

public enum ProjectKey {
    /// The project fields the preview reads.
    public struct ProjectInfo: Codable, Sendable, Equatable {
        public var id: String
        public var key: String
        public var name: String
        public var nextSeq: Int
        public init(id: String, key: String, name: String, nextSeq: Int) {
            self.id = id
            self.key = key
            self.name = name
            self.nextSeq = nextSeq
        }
        public init(_ p: Project) { self.init(id: p.id, key: p.key, name: p.name, nextSeq: p.nextSeq) }
    }

    /// The ticket fields the preview reads.
    public struct TicketInfo: Codable, Sendable, Equatable, TicketKeyed {
        public var id: String
        public var key: String
        public var projectId: String
        /// `externalRef?.key`
        public var externalRefKey: String?
        public init(id: String, key: String, projectId: String, externalRefKey: String? = nil) {
            self.id = id
            self.key = key
            self.projectId = projectId
            self.externalRefKey = externalRefKey
        }
        public init(_ t: Ticket) { self.init(id: t.id, key: t.key, projectId: t.projectId, externalRefKey: t.externalRef?.key) }

        private struct Ref: Codable { var key: String }
        private enum CodingKeys: String, CodingKey { case id, key, projectId, externalRef }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            key = try c.decode(String.self, forKey: .key)
            projectId = try c.decode(String.self, forKey: .projectId)
            externalRefKey = try c.decodeIfPresent(Ref.self, forKey: .externalRef)?.key
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id)
            try c.encode(key, forKey: .key)
            try c.encode(projectId, forKey: .projectId)
            try c.encode(externalRefKey.map { Ref(key: $0) }, forKey: .externalRef)
        }
    }

    public struct Rename: Codable, Sendable, Equatable {
        public var from: String
        public var to: String
        public init(from: String, to: String) {
            self.from = from
            self.to = to
        }
    }

    public struct KeyPreview: Codable, Sendable, Equatable {
        /// Normalized (trimmed, upper-cased) draft
        public var key: String
        /// Why the draft can't be saved, if it can't
        public var error: String?
        /// True when the draft differs from the current key
        public var changed: Bool
        /// Native tickets that would be renamed, in number order
        public var renames: [Rename]
        /// Legacy mirrors (key = remote ID) that keep their keys
        public var kept: [String]
        /// The next two native keys under the draft
        public var next: [String]
        /// One-line description for the field hint
        public var message: String
    }

    public struct NativeTicket: Sendable, Equatable {
        public var ticket: TicketInfo
        public var suffix: String
        /// `Number(suffix)`: a Double, as in JS, so a suffix past Int.max still sorts and prints.
        public var n: Double
    }

    /// Native tickets of a project: `<KEY>-<n>`. A ticket linked to a remote ID is native too; only a
    /// legacy mirror, whose key is its remote ID, keeps its key (`isLegacyMirror`).
    public static func nativeTickets(_ project: ProjectInfo, _ tickets: [TicketInfo]) -> [NativeTicket] {
        let prefix = Array("\(project.key)-".unicodeScalars)
        let native: [NativeTicket] = tickets.compactMap { t in
            let k = Array(t.key.unicodeScalars)
            guard same(t.projectId, project.id), !Keys.isLegacyMirror(t), k.starts(with: prefix) else { return nil }
            let suffix = k[prefix.count...]
            guard !suffix.isEmpty, suffix.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
            let s = string(suffix)
            return NativeTicket(ticket: t, suffix: s, n: Double(s)!)
        }
        // Array.sort is stable in JS; Swift's sort isn't documented to be, so sort indices.
        return native.enumerated().sorted { a, b in a.element.n != b.element.n ? a.element.n < b.element.n : a.offset < b.offset }.map(\.element)
    }

    /// "1…3, 5, 7…8" for a sorted list of numbers.
    public static func formatRuns(_ nums: [Double]) -> String {
        var runs: [String] = []
        var i = 0
        while i < nums.count {
            var j = i
            while j + 1 < nums.count, nums[j + 1] == nums[j] + 1 { j += 1 }
            runs.append(j == i ? JSCompat.string(nums[i]) : "\(JSCompat.string(nums[i]))…\(JSCompat.string(nums[j]))")
            i = j + 1
        }
        return runs.joined(separator: ", ")
    }

    public static func previewProjectKey(_ project: ProjectInfo, projects: [ProjectInfo], tickets: [TicketInfo], draft: String) -> KeyPreview {
        let checked = Keys.checkProjectKey(draft)
        let key = checked.key
        let changed = !same(key, project.key)
        let native = nativeTickets(project, tickets)
        let renaming = Set(native.map { JSKey($0.ticket.id) })
        let kept = tickets.filter { same($0.projectId, project.id) && Keys.isLegacyMirror($0) }.map(\.key)
        let renames = changed && checked.error == nil ? native.map { Rename(from: $0.ticket.key, to: "\(key)-\($0.suffix)") } : []

        var error = checked.error
        if error == nil, changed, let other = projects.first(where: { !same($0.id, project.id) && same($0.key, key) }) {
            error = "Already used by \(other.name)"
        }
        if error == nil, changed {
            // `new Map(...)`: a later duplicate key wins.
            var taken: [JSKey: String] = [:]
            for t in tickets { taken[JSKey(t.key)] = t.id }
            let clashes = renames.filter { r in
                guard let holder = taken[JSKey(r.to)] else { return false }
                return !renaming.contains(JSKey(holder))
            }
            if !clashes.isEmpty {
                let list = clashes.prefix(3).map(\.to).joined(separator: ", ")
                error = "\(list)\(clashes.count > 3 ? "…" : "") already exist\(clashes.count == 1 ? "s" : "")"
            }
        }

        // Next native numbers, skipping keys already taken (the service does the same).
        var next: [String] = []
        if checked.error == nil {
            let taken = Set(tickets.filter { !renaming.contains(JSKey($0.id)) }.map { JSKey($0.key) })
            var n = project.nextSeq
            while next.count < 2 {
                let k = "\(key)-\(n)"
                if !taken.contains(JSKey(k)) { next.append(k) }
                n += 1
            }
        }

        var message: String
        if let error {
            message = error
        } else if !changed {
            message = "New tickets are numbered \(next.joined(separator: ", "))…"
        } else {
            message = "Tickets will be numbered \(next.joined(separator: ", "))…"
            if !renames.isEmpty {
                let runs = formatRuns(native.map(\.n))
                let verb = renames.count == 1 ? "becomes" : "become"
                message += "; existing \(project.key)-\(runs) \(verb) \(key)-\(runs)"
            }
            if !kept.isEmpty {
                message += ". \(kept.count == 1 ? "\(kept[0]) keeps its key" : "\(kept.count) mirrored tickets keep their keys")"
            }
        }
        return KeyPreview(key: key, error: error, changed: changed, renames: renames, kept: kept, next: next, message: message)
    }

    public static func previewProjectKey(_ project: Project, projects: [Project], tickets: [Ticket], draft: String) -> KeyPreview {
        previewProjectKey(ProjectInfo(project), projects: projects.map(ProjectInfo.init), tickets: tickets.map(TicketInfo.init), draft: draft)
    }

    // MARK: Helpers

    /// A string keyed by code points, for Set/Dictionary lookups that agree with JS `===`.
    private struct JSKey: Hashable {
        let scalars: [UInt32]
        init(_ s: String) { scalars = s.unicodeScalars.map(\.value) }
    }

    private static func same(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }

    private static func string(_ s: some Sequence<Unicode.Scalar>) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: s)
        return String(v)
    }
}
