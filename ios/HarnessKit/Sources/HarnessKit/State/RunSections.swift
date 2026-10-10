import Foundation

// Port of shared/src/state/runSections.ts: the transcript as run sections, each opening with a
// sticky header ("Work • Claude Code, Opus 5.5" and its start time). Pure, and kept in step with
// TypeScript by shared/fixtures/cases/runSections.ts.

public enum RunSections {
    /// What a row says about its run, for splitting. nil for rows that belong to no run (streaming
    /// text, "Working…").
    public struct RowRun: Sendable, Equatable {
        public var runId: String?
        /// The text of a "Run started (…)" status: the header draws instead, so the row is dropped.
        public var startText: String?
        public var createdAt: Double

        public init(runId: String?, startText: String? = nil, createdAt: Double) {
            self.runId = runId
            self.startText = startText
            self.createdAt = createdAt
        }
    }

    public struct Section<T> {
        /// nil: a section of the human's messages, or the rows before the first run (no header)
        public var runId: String?
        /// The run's "Run started (…)" text, when its entry is in the list: the header's fallback
        /// when the run isn't loaded.
        public var startText: String?
        /// When the section's first row was written: the header's last-resort time.
        public var firstAt: Double?
        public var rows: [T]
    }

    /// The text of a run-start status ("Run started (work · opus)"), else nil.
    public static func runStartedText(_ text: String) -> String? {
        text.wholeMatch(of: /Run started \([^)]*\)/) != nil ? text : nil
    }

    /// Split rows into run sections. A section starts at the first row whose run differs from the
    /// current section's. The human's messages have no run: they form sections of their own with no
    /// header (so no run's header sticks above them), and so do rows before the first run. A run that
    /// carries on after such a message opens another section, with its header again. Rows that tell
    /// nothing about their run (`at` returns nil) go to the last section. "Run started" rows are
    /// consumed (they become the header).
    public static func split<T>(_ rows: [T], at: (T) -> RowRun?) -> [Section<T>] {
        var sections: [Section<T>] = []
        for row in rows {
            let info = at(row)
            if sections.isEmpty || (info != nil && info?.runId != sections[sections.count - 1].runId) {
                sections.append(Section(runId: info?.runId, startText: nil, firstAt: nil, rows: []))
            }
            let i = sections.count - 1
            if let start = info?.startText, info?.runId == sections[i].runId {
                if sections[i].startText == nil { sections[i].startText = start }
                if sections[i].firstAt == nil { sections[i].firstAt = info?.createdAt }
                continue
            }
            if let info, sections[i].firstAt == nil { sections[i].firstAt = info.createdAt }
            sections[i].rows.append(row)
        }
        return sections
    }

    /// A grouped transcript item's run, for `split`. The human's messages with no run are their own
    /// section; anything else the service wrote without a run ("Moved to review") says nothing about
    /// its run (nil), so it stays where it is.
    public static func itemRun(_ item: Format.TranscriptItem) -> RowRun? {
        let e: TranscriptEntry
        switch item {
        case let .tool(call, _): e = call
        case let .entry(entry): e = entry
        }
        var isMessage = false
        var start: String?
        switch (item, e.content) {
        case (.entry, .text): isMessage = e.role == .user
        case let (.entry, .status(text, permission)): if permission == nil { start = runStartedText(text) }
        default: break
        }
        if (e.runId ?? "").isEmpty && !isMessage { return nil }
        return RowRun(runId: e.runId, startText: start, createdAt: e.createdAt)
    }

    /// A transcript row's run: its entry's, nothing for streaming text and "Working…".
    public static func rowRun(_ row: TranscriptLogic.Row) -> RowRun? {
        if case let .item(item) = row { return itemRun(item) }
        return nil
    }

    public struct Header: Sendable, Equatable {
        /// "Work • Claude Code, Opus 5.5"
        public var title: String
        /// When the run started (ms), for the right-aligned time
        public var at: Double?
    }

    /// A run's header. The phase, driver and model come from the run; the model is the driver's list
    /// name when the list is loaded, else the id made readable. A run on the driver's default model
    /// names it when the list is loaded and says just the driver otherwise. A run the client hasn't
    /// loaded falls back to the kind in its "Run started (kind · …)" text, and to the first row's time.
    public static func header(run: Run?, startText: String? = nil, firstAt: Double? = nil, drivers: [DriverInfo]? = nil,
                              models: [ModelInfo]? = nil) -> Header {
        guard let run else {
            var kind = ""
            if let startText, let m = startText.wholeMatch(of: /Run started \(([^)]*)\)/) {
                kind = JSCompat.trim(String(m.1.components(separatedBy: " · ")[0]))
            }
            return Header(title: kind.isEmpty ? "Run" : phaseOrKindLabel(kind), at: firstAt)
        }
        let parts = "\(phaseOrKindLabel(run.kind.rawValue)) • \(Format.driverLabel(run.driver, drivers: drivers))"
        let model: String?
        if let id = run.model, !id.isEmpty {
            model = models?.first(where: { $0.id == id })?.name ?? Subagents.modelLabel(id)
        } else {
            model = models?.first(where: { $0.default == true })?.name
        }
        let start = run.startedAt ?? 0
        let at = start != 0 ? start : (run.createdAt != 0 ? run.createdAt : firstAt)
        return Header(title: model.map { "\(parts), \($0)" } ?? parts, at: at)
    }

    /// Which header the transcript pins, and how far the next section has pushed it up. `tops` is
    /// each section's top in the scroll view's own space (nil: not measured yet), in section order;
    /// `headed` says which sections have a header (a run's), as opposed to the human's messages. The
    /// current section is the last one at or above the top (0.5pt below still reads as at it); its
    /// header is pinned while it scrolls, and the next section pushes it up by the overlap, so a
    /// header never sticks above the messages after its run. nil: the current section has no header,
    /// or none has scrolled to the top yet, so the inline headers are all on screen.
    public static func pinned(tops: [Double?], headed: [Bool], height: Double) -> (index: Int, offset: Double)? {
        guard let index = tops.lastIndex(where: { ($0 ?? .infinity) <= 0.5 }), headed[index] else { return nil }
        let next = tops[(index + 1)...].compactMap { $0 }.first
        return (index, next.map { min(0, $0 - height) } ?? 0)
    }

    private static func phaseOrKindLabel(_ kind: String) -> String {
        let k = RunKind(rawValue: kind)
        // runPhase maps every kind but plan, review, complete and triage to work: name the others by kind.
        if let phase = RunRows.runPhase(k), kind == "work" || phase != .work { return phase.label }
        return kind.prefix(1).uppercased() + kind.dropFirst()
    }
}
