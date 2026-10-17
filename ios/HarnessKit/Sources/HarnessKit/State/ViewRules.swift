import Foundation

/// Small rules the iPhone and iPad screens used to compute inline in their view bodies, here so the
/// views only call them and testing/swift covers their edges (ties, empty lists, boundaries).
public enum ViewRules {
    // MARK: Projects sheet

    /// The Inbox row's badge: triage sessions still working (their status says so, or the session is busy).
    public static func triagingCount(_ sessions: [Session]) -> Int {
        sessions.filter { $0.triageStatus == .triaging || $0.busy }.count
    }

    // MARK: Picker gallery

    /// The project the picker gallery borrows to show real data: the lowest key, skipping projects known not to be git.
    public static func galleryProject(_ projects: [Project]) -> Project? {
        projects.sorted { $0.key < $1.key }.first { $0.isGit != false }
    }

    /// The ticket the gallery's pickers act on: the lowest key among the project's planning tickets that aren't drafts.
    public static func galleryTicket(in project: Project?, tickets: [Ticket]) -> Ticket? {
        guard let project else { return nil }
        return tickets.filter { $0.projectId == project.id && $0.status == .planning && $0.draft != true }.sorted { $0.key < $1.key }.first
    }

    // MARK: Browser debug screen

    /// The next ticket key (by key order, wrapping) in `ticket`'s project that has a worktree. Nil when
    /// the ticket is the only one, or isn't among them.
    public static func nextWorkdirTicket(after ticket: Ticket, in tickets: [Ticket]) -> String? {
        let keys = tickets.filter { $0.projectId == ticket.projectId && $0.workdir != nil }.map(\.key).sorted()
        guard let i = keys.firstIndex(of: ticket.key), keys.count > 1 else { return nil }
        return keys[(i + 1) % keys.count]
    }

    // MARK: Extensions settings

    /// The extensions the user added, and the ones Chrome already had (installed by the browser or by policy).
    public static func splitExtensions(_ list: [BrowserExtension]) -> (mine: [BrowserExtension], others: [BrowserExtension]) {
        (list.filter { $0.source != .chrome }, list.filter { $0.source == .chrome })
    }

    // MARK: Palette

    /// File search results: files only; the service also returns folders, which the palette doesn't open.
    public static func fileResults(_ found: [FileMatch]) -> [FileMatch] {
        found.filter { $0.kind == .file }
    }

    /// Command ids, most recent first → each one's rank (0 is the most recent), keeping `limit`.
    public static func recentRanks(_ ids: [String], limit: Int) -> [String: Int] {
        var out: [String: Int] = [:]
        for (i, id) in ids.prefix(limit).enumerated() { out[id] = i }
        return out
    }

    /// The recents after running `id`: it moves to the front (never listed twice), and the list keeps `limit`.
    public static func pushedRecent(_ id: String, onto ids: [String], limit: Int) -> [String] {
        Array(([id] + ids.filter { $0 != id }).prefix(limit))
    }

    // MARK: Attachment viewer

    /// The viewer's second title line: "2 of 5 · 1.2 MB". The position only shows with more than one
    /// attachment, the size only when the service reported one (an older service's spec media has none).
    public static func viewerCaption(size: Int?, index: Int, count: Int) -> String {
        let formatted = size.flatMap { $0 > 0 ? Attachments.formatSize(Double($0)) : nil } ?? ""
        return [count > 1 ? "\(index + 1) of \(count)" : "", formatted].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Prompt attachments

    /// Previewed as an image: by its kind, or because it's annotated (only images are).
    public static func showsAsImage(_ a: Attachment) -> Bool {
        PromptAttachments.isImage(a) || a.annotation != nil
    }
}

extension ContextGauge {
    /// The gauge button's accessibility label: the summary, then the miss badge; "compacting" while it runs.
    public func accessibilityLabel(compacting: Bool) -> String {
        compacting ? "Context, compacting" : summary + (missBadge.map { ", \($0)" } ?? "")
    }
}
