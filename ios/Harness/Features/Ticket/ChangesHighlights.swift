import HarnessHighlight
import HarnessKit
import Observation
import SwiftUI

/// Syntax colors for the Changes tab, one highlighter job per file: the file's rows as a diff
/// (ChangesRows.highlightSource), so each side is tokenized as a whole, the way the plugin's
/// viewer and the code blocks do. Rows ask for their file's colors as they appear; a file whose
/// rows or theme change (context expanded, a new version of the diff, dark mode) asks again. Until colors land, and
/// for files past the highlighter's size limit, rows draw plain.
@MainActor
@Observable
final class ChangesHighlights {
    /// Per path: the source the colors were made from, and the result with one line per code row
    /// (nil: plain)
    private(set) var lines: [String: (source: String, theme: String, result: Highlighted?)] = [:]
    @ObservationIgnored private var inflight: [String: String] = [:]
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]

    /// The colors for a file's current rows, when they've landed: one line per code row.
    func code(_ path: String, source: String, theme: String) -> Highlighted? {
        guard let hit = lines[path], hit.source == source, hit.theme == theme else { return nil }
        return hit.result
    }

    /// Start highlighting a file's rows unless that's done or under way.
    func request(_ path: String, source: String, codeCount: Int, theme: String, appearance: ThemeAppearance) {
        let job = "\(theme)\u{0}\(source)"
        if let hit = lines[path], hit.source == source, hit.theme == theme { return }
        if inflight[path] == job { return }
        let hl = Highlighter.app
        if let hit = hl.cached(source, language: nil, theme: theme, diff: true) {
            lines[path] = (source, theme, Self.codeLines(hit, count: codeCount))
            return
        }
        inflight[path] = job
        tasks[path]?.cancel()
        tasks[path] = Task { @MainActor in
            let result = try? await hl.highlightDiff(source, language: nil, theme: theme, appearance: appearance)
            guard !Task.isCancelled, self.inflight[path] == job else { return }
            self.inflight[path] = nil
            self.lines[path] = (source, theme, Self.codeLines(result ?? nil, count: codeCount))
        }
    }

    /// The highlighted lines that are code (not the headers highlightSource adds), when they line up
    /// with the rows one to one.
    private static func codeLines(_ h: Highlighted?, count: Int) -> Highlighted? {
        guard var h else { return nil }
        h.lines = h.lines.filter { $0.kind == .add || $0.kind == .del || $0.kind == .ctx }
        return h.lines.count == count ? h : nil
    }
}
