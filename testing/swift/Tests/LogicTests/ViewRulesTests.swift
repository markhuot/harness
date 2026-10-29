import Foundation
import Testing
import HarnessKit

private func project(_ key: String, isGit: Bool? = true) -> Project {
    Project(id: "p-\(key)", key: key, name: key, path: "/\(key)", nextSeq: 1, useWorktrees: true, isGit: isGit, createdAt: 0, updatedAt: 0)
}

private func ticket(_ key: String, project: String = "p-A", status: TicketStatus = .planning, draft: Bool? = nil, workdir: String? = nil) -> Ticket {
    Ticket(id: "t-\(key)", key: key, projectId: project, title: key, spec: "", status: status, sessionId: "s-\(key)", driver: "d", workdir: workdir, draft: draft, createdAt: 0, updatedAt: 0)
}

private func ext(_ id: String, _ source: BrowserExtensionSource) -> BrowserExtension {
    BrowserExtension(id: id, name: id, version: "1", source: source, enabled: true, status: .loaded, hasAction: false)
}

@Suite struct CosTicketHiddenTests {
    private func t(_ key: String, kind: TicketKind) -> Ticket {
        Ticket(id: "t-\(key)", key: key, projectId: "p", kind: kind, title: key, spec: "", status: .done, sessionId: "s", driver: "d", createdAt: 0, updatedAt: 0)
    }

    @Test func aChiefOfStaffTicketIsNeverHeldInTicketState() {
        let cos = t("COS-1", kind: .cos), task = t("A-1", kind: .task)
        var state = BoardState()
        state.apply(.ticketUpserted(ticket: cos))
        state.apply(.ticketUpserted(ticket: task))
        #expect(Set(state.tickets.keys) == [task.id])
        var fetched = BoardState()
        fetched.reduce(.tickets([cos, task]))
        #expect(Set(fetched.tickets.keys) == [task.id], "a fetched merge drops it")
        state.tickets[cos.id] = cos
        state.reduce(.snapshot(BoardSnapshot(tickets: [task])))
        #expect(Set(state.tickets.keys) == [task.id], "a snapshot purges one already held")
    }
}

@Suite struct ViewRulesTests {
    @Test func galleryProjectIsTheLowestKeyThatIsNotKnownToBeNonGit() {
        #expect(ViewRules.galleryProject([]) == nil)
        let picked = ViewRules.galleryProject([project("C"), project("A", isGit: false), project("B", isGit: nil)])
        #expect(picked?.key == "B", "isGit unknown still counts; only an explicit false is skipped")
        #expect(ViewRules.galleryProject([project("A", isGit: false)]) == nil)
    }

    @Test func galleryTicketIsTheLowestPlanningNonDraftOfThatProject() {
        let a = project("A")
        let tickets = [
            ticket("A-9", status: .planning), ticket("A-2", status: .planning, draft: true), ticket("A-3", status: .inProgress),
            ticket("A-5", status: .planning), ticket("B-1", project: "p-B", status: .planning),
        ]
        #expect(ViewRules.galleryTicket(in: a, tickets: tickets)?.key == "A-5")
        #expect(ViewRules.galleryTicket(in: a, tickets: []) == nil)
        #expect(ViewRules.galleryTicket(in: nil, tickets: tickets) == nil)
    }

    @Test func nextWorkdirTicketWrapsAndIgnoresTicketsWithoutAWorktree() {
        let tickets = [
            ticket("A-1", workdir: "/w/1"), ticket("A-2"), ticket("A-3", workdir: "/w/3"), ticket("A-4", workdir: "/w/4"), ticket("B-1", project: "p-B", workdir: "/w/b"),
        ]
        #expect(ViewRules.nextWorkdirTicket(after: tickets[0], in: tickets) == "A-3")
        #expect(ViewRules.nextWorkdirTicket(after: tickets[3], in: tickets) == "A-1", "wraps to the first")
        #expect(ViewRules.nextWorkdirTicket(after: tickets[1], in: tickets) == nil, "a ticket without a worktree isn't in the cycle")
        #expect(ViewRules.nextWorkdirTicket(after: tickets[4], in: tickets) == nil, "the only one in its project has no next")
    }

    @Test func splitExtensionsSeparatesChromeOwnedFromAddedOnes() {
        let split = ViewRules.splitExtensions([ext("a", .webstore), ext("b", .chrome), ext("c", .unpacked)])
        #expect(split.mine.map(\.id) == ["a", "c"])
        #expect(split.others.map(\.id) == ["b"])
        let empty = ViewRules.splitExtensions([])
        #expect(empty.mine.isEmpty && empty.others.isEmpty)
    }

    @Test func fileResultsDropFolders() {
        let found = [FileMatch(path: "a", kind: .file), FileMatch(path: "d", kind: .dir), FileMatch(path: "b", kind: .file)]
        #expect(ViewRules.fileResults(found).map(\.path) == ["a", "b"])
    }

    @Test func recentsRankMostRecentFirstAndKeepTheLimit() {
        #expect(ViewRules.recentRanks(["x", "y", "z"], limit: 2) == ["x": 0, "y": 1])
        #expect(ViewRules.recentRanks([], limit: 8).isEmpty)
    }

    @Test func runningACommandMovesItToTheFrontOnce() {
        #expect(ViewRules.pushedRecent("b", onto: ["a", "b", "c"], limit: 8) == ["b", "a", "c"])
        #expect(ViewRules.pushedRecent("d", onto: ["a", "b", "c"], limit: 3) == ["d", "a", "b"], "the oldest falls off at the limit")
        #expect(ViewRules.pushedRecent("a", onto: [], limit: 3) == ["a"])
    }

    @Test func viewerCaptionShowsPositionOnlyForSeveralAndSizeOnlyWhenKnown() {
        #expect(ViewRules.viewerCaption(size: nil, index: 0, count: 1) == "")
        #expect(ViewRules.viewerCaption(size: 0, index: 0, count: 1) == "", "a zero size is unknown")
        #expect(ViewRules.viewerCaption(size: nil, index: 1, count: 3) == "2 of 3")
        #expect(ViewRules.viewerCaption(size: 1_258_291, index: 1, count: 3) == "2 of 3 · 1.2 MB")
        #expect(ViewRules.viewerCaption(size: 2048, index: 0, count: 1) == "2 KB")
    }

    @Test func anAnnotatedFileIsPreviewedAsAnImage() {
        let plain = Attachment(id: "1", path: "/a.txt", name: "a.txt", kind: .file)
        let image = Attachment(id: "2", path: "/a.png", name: "a.png", kind: .image)
        #expect(!ViewRules.showsAsImage(plain))
        #expect(ViewRules.showsAsImage(image))
        var annotated = plain
        annotated.annotation = AttachmentAnnotation(width: 10, height: 10, marks: [])
        #expect(ViewRules.showsAsImage(annotated))
    }

    @Test func gaugeLabelNamesCompactingAndAppendsTheMissBadge() {
        let usage = ContextUsage(input: 1000, cacheRead: 9000, cacheWrite: 0, output: 10, prefix: 500, at: 0, estimated: false, misses: 2, missTokens: 4000)
        let gauge = ContextGauge(usage: usage, limit: 250_000)
        #expect(gauge.accessibilityLabel(compacting: true) == "Context, compacting")
        #expect(gauge.accessibilityLabel(compacting: false) == "Context 10k of 250k: 9k cached, 1k fresh, 2 misses")
        let clean = ContextGauge(usage: ContextUsage(input: 1000, cacheRead: 9000, cacheWrite: 0, output: 10, prefix: 500, at: 0, estimated: false, misses: 0, missTokens: 0), limit: 250_000)
        #expect(!clean.accessibilityLabel(compacting: false).hasSuffix("misses"))
    }
}

@Suite struct DockCardsTests {
    private func shape(_ count: Int, _ maxVisible: Int, fitting: Int? = nil) -> [Int] {
        let s = DockCards.split(count: count, maxVisible: maxVisible, fitting: fitting)
        return [s.cards, s.more]
    }

    @Test func phoneShowsThreeCardsBeforeAMoreRow() {
        #expect(shape(0, DockCards.phoneVisible) == [0, 0])
        #expect(shape(3, DockCards.phoneVisible) == [3, 0])
        #expect(shape(4, DockCards.phoneVisible) == [2, 2])
        #expect(shape(7, DockCards.phoneVisible) == [2, 5])
        #expect(DockCards.rows(count: 3, maxVisible: DockCards.phoneVisible) == 3)
        #expect(DockCards.rows(count: 9, maxVisible: DockCards.phoneVisible) == 3)
    }

    @Test func aShortWindowKeepsItsRowCap() {
        #expect(shape(3, DockCards.phoneVisible, fitting: 3) == [3, 0])
        #expect(shape(4, DockCards.phoneVisible, fitting: 2) == [1, 3])
        #expect(DockCards.rows(count: 4, maxVisible: DockCards.phoneVisible, fitting: 2) == 2)
    }
}
