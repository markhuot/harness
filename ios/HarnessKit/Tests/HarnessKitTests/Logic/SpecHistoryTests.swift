import Foundation
import Testing
@testable import HarnessKit

@Suite("Spec history")
struct SpecHistoryTests {
    @Test func followsTheNewestUntilTheUserStepsBack() {
        var s = SpecScrubber()
        #expect(s.following)
        #expect(s.shown(latest: 3) == 3)
        // A revision landing while following shows at once.
        #expect(s.shown(latest: 4) == 4)
        s.step(-1, latest: 4)
        #expect(!s.following)
        #expect(s.shown(latest: 4) == 3)
        // One landing while the user reads rev 3 doesn't move them.
        #expect(s.shown(latest: 5) == 3)
    }

    @Test func steppingOrScrubbingToTheNewestFollowsAgain() {
        var s = SpecScrubber()
        s.show(2, latest: 5)
        #expect(s.pinned == 2)
        s.step(1, latest: 5)
        s.step(1, latest: 5)
        #expect(s.pinned == 4)
        s.step(1, latest: 5)
        #expect(s.following)
        #expect(s.shown(latest: 6) == 6)
        s.show(3, latest: 6)
        s.show(6, latest: 6)
        #expect(s.following)
    }

    @Test func clampsToTheRevisionsThatExist() {
        var s = SpecScrubber()
        s.show(0, latest: 4)
        #expect(s.pinned == 1)
        #expect(!s.canStep(-1, latest: 4))
        #expect(s.canStep(1, latest: 4))
        s.step(-1, latest: 4)
        #expect(s.shown(latest: 4) == 1)
        s.show(99, latest: 4)
        #expect(s.following)
        #expect(!s.canStep(1, latest: 4))
        // A pin past a newest that shrank (another service, a reset) shows the newest.
        #expect(SpecScrubber(pinned: 9).shown(latest: 3) == 3)
        // A single revision has nowhere to go, and a bogus latest counts as one.
        #expect(!SpecScrubber().canStep(-1, latest: 1))
        #expect(SpecScrubber().shown(latest: 0) == 1)
    }

    @Test func followDropsThePin() {
        var s = SpecScrubber(pinned: 2)
        s.follow()
        #expect(s.following)
    }

    @Test func showChangesComparesWithThePreviousRevision() {
        #expect(SpecHistory.previous(1) == nil)
        #expect(SpecHistory.previous(7) == 6)
    }

    @Test func barLineWithAndWithoutMetadata() {
        let info = SpecRevisionInfo(rev: 7, author: .agent, note: "  Status: button color fixed ", approvedBaseline: true, createdAt: 1_000)
        let l = SpecHistory.line(rev: 7, latest: 7, info: info, now: 1_000 + 3 * 60_000)
        #expect(l.title == "Rev 7 of 7")
        #expect(l.meta == "Agent · 3m ago")
        #expect(l.note == "Status: button color fixed")
        #expect(l.baseline)
        #expect(SpecHistory.accessibilityLabel(l) == "Rev 7 of 7, Agent · 3m ago, Approved plan, Status: button color fixed")
        let bare = SpecHistory.line(rev: 2, latest: 5, info: nil, now: 0)
        #expect(bare == SpecHistoryLine(title: "Rev 2 of 5", meta: "", note: "", baseline: false))
        // A revision event from an older service has no time.
        let human = SpecHistory.line(rev: 3, latest: 3, info: SpecRevisionInfo(rev: 3, author: .human, note: "", createdAt: 0), now: 5)
        #expect(human.meta == "You")
    }

    @Test func revisionListIsRefetchedWhenItLacksTheNewest() {
        var s = BoardState()
        #expect(SpecHistory.needsRevisions(s, ticketId: "t1", latest: 1))
        s.specRevisions["t1"] = [SpecRevisionInfo(rev: 1, author: .human, note: "Created", createdAt: 1)]
        #expect(!SpecHistory.needsRevisions(s, ticketId: "t1", latest: 1))
        #expect(SpecHistory.needsRevisions(s, ticketId: "t1", latest: 2))
        #expect(SpecHistory.info(s, ticketId: "t1", rev: 1)?.note == "Created")
        #expect(SpecHistory.info(s, ticketId: "t1", rev: 2) == nil)
    }

    /// The service's diff (no `diff --git` header) parses into the Changes tab's rows.
    @Test func serviceDiffParsesIntoChangesRows() throws {
        let sample = try Fixture.value("protocol", "SpecDiff", as: [SpecDiff].self)
        let d = try #require(SpecHistory.diff(sample[0].diff))
        #expect(d.hunks.count == 1)
        let lines: [ChangesLine] = ChangesRows.rows(d).compactMap { row -> ChangesLine? in if case let .line(l) = row { l } else { nil } }
        #expect(lines == [ChangesLine(kind: .add, text: "## Goal", oldLine: nil, newLine: 1)])
        #expect(SpecHistory.diff(sample[1].diff) == nil)
        let change = "--- a/spec.md\n+++ b/spec.md\n@@ -1,3 +1,3 @@\n # Goal\n-old\n+new\n keep\n"
        let rows = ChangesRows.rows(try #require(SpecHistory.diff(change)))
        let kinds: [ChangesLineKind] = rows.compactMap { row -> ChangesLineKind? in if case let .line(l) = row { l.kind } else { nil } }
        #expect(kinds == [.ctx, .del, .add, .ctx])
    }
}

@Suite("Activity rows")
struct ActivityRowsTests {
    static func e(_ kind: ActivityKind, author: ActivityAuthor = .agent, body: String = "b", meta: ActivityMeta = .init(), id: String = "a") -> ActivityEntry {
        ActivityEntry(id: id, sessionId: "s", ticketId: "t", kind: kind, author: author, body: body, meta: meta, createdAt: 1)
    }

    @Test func looksPerKind() {
        #expect(ActivityRows.look(Self.e(.blocked)) == .attention)
        #expect(ActivityRows.look(Self.e(.message, author: .human)) == .mine)
        #expect(ActivityRows.look(Self.e(.answer)) == .reply)
        #expect(ActivityRows.look(Self.e(.changesRequested)) == .changes)
        #expect(ActivityRows.look(Self.e(.reviewApproved)) == .approved)
        #expect(ActivityRows.look(Self.e(.failed)) == .muted)
        #expect(ActivityRows.look(Self.e(.system, author: .system)) == .muted)
        #expect(ActivityRows.look(Self.e(.note)) == .plain)
        #expect(ActivityRows.look(Self.e(.unknown("deployed"))) == .plain)
    }

    @Test func reviewDecisionsShowRoundAndShortCommit() {
        let r = Self.e(.changesRequested, meta: ActivityMeta(round: 2, commit: .value("9f1c2ab77e0d"), by: "agent"))
        #expect(ActivityRows.title(r) == "Changes requested")
        #expect(ActivityRows.detail(r) == "Round 2 · 9f1c2ab")
        let conductor = Self.e(.reviewApproved, meta: ActivityMeta(round: 1, commit: .null, by: "conductor"))
        #expect(ActivityRows.title(conductor) == "Conductor approved the review")
        #expect(ActivityRows.detail(conductor) == "Round 1")
        #expect(ActivityRows.detail(Self.e(.reviewApproved)) == "")
        #expect(ActivityRows.detail(Self.e(.submitted, meta: ActivityMeta(specRevision: 4))) == "at rev 4")
        #expect(ActivityRows.detail(Self.e(.note, meta: ActivityMeta(round: 3))) == "")
    }

    @Test func blockedCardAsksTheQuestionOnce() {
        let same = Self.e(.blocked, body: "Which color?", meta: ActivityMeta(question: "Which color?"))
        #expect(ActivityRows.question(same) == "Which color?")
        #expect(ActivityRows.body(same) == "")
        let more = Self.e(.blocked, body: "I tried red and blue.", meta: ActivityMeta(question: "Which color?"))
        #expect(ActivityRows.body(more) == "I tried red and blue.")
        let noMeta = Self.e(.blocked, body: "Which color?")
        #expect(ActivityRows.question(noMeta) == "Which color?")
        #expect(ActivityRows.body(noMeta) == "")
    }

    @Test func onlyTheNewestBlockOfABlockedTicketIsOpen() {
        let old = Self.e(.blocked, id: "b1")
        let new = Self.e(.blocked, id: "b2")
        let list = [old, Self.e(.unblocked, id: "u"), new]
        let blocked = Ticket(id: "t", key: "T-1", projectId: "p", title: "t", spec: "", status: .blocked, sessionId: "s", driver: "d", createdAt: 0, updatedAt: 0)
        #expect(ActivityRows.isOpenQuestion(new, in: list, ticket: blocked))
        #expect(!ActivityRows.isOpenQuestion(old, in: list, ticket: blocked))
        var working = blocked
        working.status = .inProgress
        #expect(!ActivityRows.isOpenQuestion(new, in: list, ticket: working))
    }

    @Test func titlesNameWhoActed() {
        #expect(ActivityRows.title(Self.e(.message, author: .human)) == "You")
        #expect(ActivityRows.title(Self.e(.note)) == "Agent")
        #expect(ActivityRows.title(Self.e(.approved, author: .human)) == "You approved")
        #expect(ActivityRows.title(Self.e(.approved, meta: ActivityMeta(by: "conductor"))) == "Approved by the conductor")
        #expect(ActivityRows.icon(Self.e(.unknown("deployed"), author: .human)) == "user")
        for k in ActivityKind.allKnown { #expect(Icons.isIconName(ActivityRows.icon(Self.e(k))), "\(k) icon") }
    }
}

@Suite("Composer log choice")
struct ComposerLogTests {
    static let ticket = Ticket(id: "t", key: "T-1", projectId: "p", title: "t", spec: "", status: .blocked, sessionId: "s", driver: "d", createdAt: 0, updatedAt: 0)

    @Test(arguments: [
        (TicketTab.spec, true), (.activity, true), (.transcript, false), (.details, false), (.children, false),
        (.agents, false), (.browser, false), (.changes, false), (TicketTab("agent:toolu_1"), false), (TicketTab("plugin:notes:list"), false),
    ] as [(TicketTab, Bool)])
    func logsFromSpecAndActivityOnly(_ tab: TicketTab, _ logs: Bool) {
        #expect(TicketDetailLogic.composerLogs(tab) == logs)
    }

    @Test func placeholderSaysWhereTheMessageShows() {
        #expect(TicketDetailLogic.composerPlaceholder(Self.ticket, tab: .spec) == "Answer the agent (shows in Activity)")
        #expect(TicketDetailLogic.composerPlaceholder(Self.ticket, tab: .transcript) == "Answer the agent (transcript only)")
        var review = Self.ticket
        review.status = .review
        #expect(TicketDetailLogic.composerPlaceholder(review, tab: .activity) == "Ask about the work, or ask for a change (shows in Activity)")
    }
}

@Suite("Spec draft")
struct SpecDraftTests {
    static func t(_ spec: String, rev: Int) -> Ticket {
        Ticket(id: "t", key: "T-1", projectId: "p", title: "t", spec: spec, specRevision: rev, status: .inProgress, sessionId: "s", driver: "d", createdAt: 0, updatedAt: 0)
    }

    @Test func savesSendTheRevisionTheEditStartedFrom() {
        var d = SpecDraft(Self.t("## Goal", rev: 3))
        #expect(!d.dirty)
        d.text = "## Goal\n\nMore"
        #expect(d.dirty)
        #expect(d.patch == UpdateTicketBody(spec: "## Goal\n\nMore", baseRevision: 3))
    }

    @Test func followsNewerRevisionsOnlyWhileUnedited() {
        var d = SpecDraft(Self.t("a", rev: 1))
        d.follow(Self.t("b", rev: 2))
        #expect(d.text == "b")
        #expect(d.base == 2)
        d.text = "mine"
        d.follow(Self.t("c", rev: 3))
        // The agent's revision doesn't clobber the edit, and the save still names rev 2.
        #expect(d.text == "mine")
        #expect(d.patch.baseRevision == 2)
        // The save's own echo (the ticket now says what the user wrote) settles it.
        d.follow(Self.t("mine", rev: 4))
        #expect(!d.dirty)
        #expect(d.base == 4)
    }

    @Test func reloadTakesTheNewerSpec_overwriteKeepsMine() {
        let conflict = SpecConflict(currentRevision: 5, spec: "theirs")
        var reload = SpecDraft(Self.t("a", rev: 2))
        reload.text = "mine"
        reload.reload(conflict)
        #expect(reload.text == "theirs")
        #expect(!reload.dirty)
        #expect(reload.base == 5)
        var over = SpecDraft(Self.t("a", rev: 2))
        over.text = "mine"
        over.overwrite(conflict)
        #expect(over.dirty)
        #expect(over.patch == UpdateTicketBody(spec: "mine", baseRevision: 5))
    }

    @Test func revertTakesTheTicketsCurrentSpec() {
        var d = SpecDraft(Self.t("a", rev: 1))
        d.text = "mine"
        d.follow(Self.t("b", rev: 2))
        d.revert(Self.t("b", rev: 2))
        #expect(d.text == "b")
        #expect(d.base == 2)
    }
}
