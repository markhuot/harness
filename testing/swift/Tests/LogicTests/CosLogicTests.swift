import Foundation
import Testing
import HarnessKit

private func event(_ id: String, cos: String? = "c1", status: CosEventStatus = .pending, verdict: CosEventVerdict = .pending, at: Double = 0, reason: String? = nil, source: CosEventSource = .activity) -> CosEvent {
    CosEvent(id: id, cosId: cos, sourceKind: source, title: id, status: status, verdict: verdict, reason: reason, createdAt: at)
}

private func message(_ id: String, at: Double, text: String = "hi", role: String = "assistant") -> CosChatEntry {
    .message(id: id, cosId: "c1", createdAt: at, role: role, text: text)
}

private func project(_ id: String, group: String?) -> Project {
    Project(id: id, key: id.uppercased(), name: id, path: "/\(id)", nextSeq: 1, useWorktrees: true, groupId: group, createdAt: 0, updatedAt: 0)
}

@Suite struct CosLogicTests {
    // MARK: Which chief a board shows

    @Test func theBoardShowsTheChiefOfItsScope() {
        let projects = ["grouped": project("grouped", group: "work"), "loose": project("loose", group: nil)]
        #expect(CosLogic.boardScope(filter: nil, projects: projects) == "all")
        #expect(CosLogic.boardScope(filter: Paging.groupScope("work"), projects: projects) == "group:work")
        #expect(CosLogic.boardScope(filter: "grouped", projects: projects) == "group:work", "a project's board shows its group's chief")
        #expect(CosLogic.boardScope(filter: "loose", projects: projects) == "all", "a project with no group falls back to the All chief")
        #expect(CosLogic.boardScope(filter: "gone", projects: projects) == "all")
    }

    @Test func aBadgeCountsOneChiefsOpenEventsAndReadsZeroUntilItLoads() {
        let badge = CosBadge(total: 5, byCos: ["c1": 3, "c2": 2])
        #expect(CosLogic.badgeCount(badge, cosId: "c1") == 3)
        #expect(CosLogic.badgeCount(badge, cosId: "nobody") == 0)
        #expect(CosLogic.badgeCount(nil, cosId: "c1") == 0)
        #expect(CosLogic.badgeCount(badge, cosId: nil) == 0, "a chief that isn't made yet has no count")
        #expect(CosLogic.badgeText(0) == nil)
        #expect(CosLogic.badgeText(7) == "7")
        #expect(CosLogic.badgeText(100) == "99+")
    }

    // MARK: Inbox

    @Test func theInboxShowsOwnedAndUnassignedEventsNewestFirstAndHidesFilteredOnes() {
        var state = CosState()
        state.mergeEvents([
            event("old", at: 1), event("new", at: 3), event("unassigned", cos: nil, at: 2),
            event("other", cos: "c2", at: 9), event("dropped", verdict: .filtered, at: 8),
            event("reminder", verdict: .filtered, at: 4, source: .schedule),
        ])
        #expect(state.inbox("c1").map(\.id) == ["reminder", "new", "unassigned", "old"], "a reminder is filtered from triage but is for the person, so it shows")
    }

    @Test func aRowReadsAsItsVerdictAndOnlyIgnoredRowsEscalate() {
        #expect(CosLogic.inboxState(event("a", status: .pending)) == .waiting)
        #expect(CosLogic.inboxState(event("a", status: .triaging)) == .waiting)
        #expect(CosLogic.inboxState(event("a", status: .ignored, verdict: .ignore)) == .ignored)
        #expect(CosLogic.inboxState(event("a", status: .handled, verdict: .filtered)) == .filtered, "a filtered verdict wins over the status")
        #expect(CosLogic.canEscalate(event("a", status: .ignored, verdict: .ignore)))
        #expect(!CosLogic.canEscalate(event("a", status: .ignored, verdict: .filtered)))
        for status in [CosEventStatus.pending, .triaging, .escalated, .handling, .handled] {
            #expect(!CosLogic.canEscalate(event("a", status: status)), "\(status) can't be escalated by hand")
        }
    }

    @Test func aHandledRowShowsTheChiefsOutcomeAndOneWithoutIsOnlyReviewed() {
        func handled(_ kind: CosOutcomeKind?) -> CosEvent {
            CosEvent(id: "a", cosId: "c1", title: "a", status: .handled, verdict: .escalate, outcome: kind.map { CosOutcome(kind: $0, text: "text for \($0.rawValue)") }, createdAt: 0)
        }
        #expect(CosLogic.inboxState(handled(.acted)) == .acted)
        #expect(CosLogic.inboxState(handled(.noAction)) == .noAction)
        #expect(CosLogic.inboxState(handled(.needsUser)) == .needsUser)
        #expect(CosLogic.inboxState(handled(nil)) == .reviewed)
        #expect(CosLogic.verdictLine(handled(.needsUser)) == "text for needs_user")
        #expect(CosLogic.verdictLine(handled(nil)) == nil)
        #expect(CosInboxState.reviewed.label == "Reviewed, no outcome recorded")
    }

    @Test func aRowSaysWhyItWasIgnoredOrEscalated() {
        #expect(CosLogic.verdictLine(event("a", status: .ignored, verdict: .ignore, reason: "Routine move")) == "Routine move")
        #expect(CosLogic.verdictLine(event("a", status: .escalated, verdict: .escalate, reason: "A customer is waiting")) == "A customer is waiting")
        #expect(CosLogic.verdictLine(event("a", status: .ignored, verdict: .ignore, reason: "")) == nil)
        #expect(CosLogic.verdictLine(event("a", status: .pending)) == nil)
    }

    @Test func eventsMergeByIdWithTheIncomingCopyWinning() {
        let merged = CosLogic.mergeEvents([event("a", at: 1, reason: "old")], [event("a", status: .ignored, at: 1, reason: "new"), event("b", at: 2)])
        #expect(merged.map { $0.id } == ["b", "a"])
        #expect(merged.last?.reason == "new")
        #expect(CosLogic.mergeEvents([event("x", at: 5), event("y", at: 5)], []).map { $0.id } == ["y", "x"], "the same time breaks on the id, newest first")
    }

    // MARK: Chat

    @Test func chatPagesMergeOldestFirstWithoutDuplicates() {
        let page1 = [message("m3", at: 3), message("m4", at: 4)]
        let page2 = [message("m1", at: 1), message("m2", at: 2), message("m3", at: 3)]
        #expect(CosLogic.mergeChat(page1, page2).map(\.id) == ["m1", "m2", "m3", "m4"])
    }

    @Test func aLiveEntryThatArrivedBeforeItsPageIsKeptOnceWithTheNewerCopy() {
        let live = [message("m1", at: 1, text: "live")]
        let paged = [message("m1", at: 1, text: "paged")]
        let merged = CosLogic.mergeChat(live, paged)
        #expect(merged.count == 1)
        #expect(merged == paged)
        #expect(CosLogic.mergeChat(merged, paged) == merged, "merging the same page again changes nothing")
    }

    @Test func aReloadThatMissesWhatIsLoadedDropsItSoPagingFillsTheHole() {
        var state = CosState()
        state.mergeChat("c1", [message("m1", at: 1), message("m2", at: 2)])
        let hole = state.loadNewestChat("c1", [message("m9", at: 9), message("m10", at: 10)], hasOlder: true)
        #expect(hole)
        #expect(state.chat["c1"]?.map(\.id) == ["m9", "m10"])
    }

    @Test func aReloadThatOverlapsOrHasNoOlderPagesKeepsWhatIsLoaded() {
        var state = CosState()
        state.mergeChat("c1", [message("m1", at: 1), message("m2", at: 2)])
        let overlapped = state.loadNewestChat("c1", [message("m2", at: 2), message("m3", at: 3)], hasOlder: true)
        #expect(!overlapped)
        #expect(state.chat["c1"]?.map(\.id) == ["m1", "m2", "m3"])
        let complete = state.loadNewestChat("c1", [message("m9", at: 9)], hasOlder: false)
        #expect(!complete, "the page is all there is: nothing is missing")
        #expect(state.chat["c1"]?.map(\.id) == ["m1", "m2", "m3", "m9"])
    }

    @Test func aLiveEntryNewerThanTheReloadedPageSurvivesTheDrop() {
        var state = CosState()
        state.mergeChat("c1", [message("m1", at: 1), message("live", at: 20)])
        state.loadNewestChat("c1", [message("m9", at: 9)], hasOlder: true)
        #expect(state.chat["c1"]?.map(\.id) == ["m9", "live"])
    }

    @Test func anInboxReloadThatMissesWhatIsLoadedDropsItsRowsAndKeepsOtherChiefs() {
        var state = CosState()
        state.mergeEvents([event("old", at: 1), event("unassigned", cos: nil, at: 2), event("other", cos: "c2", at: 3)])
        let dropped = state.loadNewestEvents("c1", [event("new", at: 50)], hasOlder: true)
        #expect(dropped)
        #expect(state.events.keys.sorted() == ["new", "other"])
        let kept = state.loadNewestEvents("c1", [event("new", at: 50), event("newer", at: 60)], hasOlder: true)
        #expect(!kept, "an overlapping page leaves the rows alone")
        #expect(state.events.keys.sorted() == ["new", "newer", "other"])
    }

    @Test func chatRowsAreMessagesShortLinesAndTicketCards() {
        let entries: [CosChatEntry] = [
            message("m1", at: 1, text: "question", role: "user"),
            .ticketCreated(id: "t1", cosId: "c1", createdAt: 2, key: "A-1", title: "Follow up", status: "planning"),
            .ticketMoved(id: "t2", cosId: "c1", createdAt: 3, key: "A-2", title: "Reorder", from: "in_progress", to: "review"),
            .eventBatch(id: "w1", cosId: "c1", createdAt: 4, wakeId: "wake", eventIds: ["e1", "e2", "e3"], digest: "ignored 3 routine moves"),
            .eventBatch(id: "w2", cosId: "c1", createdAt: 5, wakeId: "wake", eventIds: ["e1"], digest: ""),
            .unknown(id: "u", cosId: "c1", createdAt: 6, kind: "future", raw: .null),
        ]
        #expect(CosLogic.rows(entries) == [
            .message(id: "m1", fromHuman: true, text: "question"),
            .ticket(id: "t1", key: "A-1", title: "Follow up", status: "planning", moved: false),
            .ticket(id: "t2", key: "A-2", title: "Reorder", status: "review", moved: true),
            .line(id: "w1", text: "Woke for 3 events: ignored 3 routine moves"),
            .line(id: "w2", text: "Woke for 1 event"),
        ])
    }

    @Test func aStatusReadsTheWayACardSaysIt() {
        #expect(CosLogic.statusLabel("in_progress") == "In progress")
        #expect(CosLogic.statusLabel("review") == "Review")
    }

    // MARK: Settings

    @Test func theAppDefaultsAreOnForTheChiefAndOffForUnblocking() {
        #expect(CosSettings.enabled(nil))
        #expect(!CosSettings.canUnblock(nil))
    }

    @Test func theTriStateSavesNullToInherit() {
        #expect(CosTriState(.absent) == .inherit)
        #expect(CosTriState(.null) == .inherit)
        #expect(CosTriState(.value(true)) == .on)
        #expect(CosTriState(.value(false)) == .off)
        #expect(CosTriState.inherit.patch == .null)
        #expect(CosTriState.on.patch == .value(true))
        #expect(CosTriState.off.patch == .value(false))
        #expect(CosSettings.label(.inherit, inherited: true) == "Inherit (on)")
        #expect(CosSettings.label(.inherit, inherited: false) == "Inherit (off)")
    }

    @Test func projectSettingsSendOnlyWhatChanged() throws {
        func json(_ body: UpdateProjectBody) throws -> [String: Any] {
            try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        }
        #expect(try json(UpdateProjectBody()).isEmpty)
        let off = try json(UpdateProjectBody(cosEnabled: .value(false)))
        #expect(off["cosEnabled"] as? Bool == false)
        #expect(off["cosCanUnblock"] == nil)
        #expect(try json(UpdateProjectBody(cosCanUnblock: .null))["cosCanUnblock"] is NSNull, "Inherit sends an explicit null")
    }

    @Test func theChiefModelResolvesProjectThenAppThenWork() throws {
        let work = PhaseChoice(driver: "claude-code", model: "sonnet")
        let app = PhaseChoice(driver: "copilot", model: "gpt")
        let own = PhaseChoice(driver: "claude-code", model: "haiku")
        func settings(cosModel: PhaseChoice?) -> PublicSettings {
            PublicSettings(phaseModels: PhaseModels(work: work), defaultDriver: "claude-code", maxConcurrentRuns: 4, permissionMode: .auto, classifier: .claudeCli, anthropicApiKeySet: false, cosModel: cosModel)
        }
        #expect(CosSettings.appModel(settings(cosModel: nil)) == work, "an install that never chose one runs on Work")
        #expect(CosSettings.appModel(settings(cosModel: app)) == app)
        #expect(CosSettings.appModel(nil) == PhaseChoice(driver: "claude-code", model: nil))
        let project = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"p","key":"A","name":"A","path":"/a","nextSeq":1,"useWorktrees":true,"defaultModels":{},"cosEnabled":null,"cosCanUnblock":null,"cosModel":{"driver":"claude-code","model":"haiku"},"createdAt":1,"updatedAt":1}"#.utf8))
        #expect(CosSettings.model(project: project, settings: settings(cosModel: app)) == own)
        #expect(CosSettings.model(project: nil, settings: settings(cosModel: app)) == app)
    }

    @Test func aPickedModelSavesAndTheDefaultRowClearsIt() throws {
        func json(_ body: UpdateProjectBody) throws -> [String: Any] {
            try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        }
        let picked = try json(UpdateProjectBody(cosModel: CosSettings.patch(.init(driver: "claude-code", model: "opus"))))
        #expect((picked["cosModel"] as? [String: Any])?["model"] as? String == "opus")
        #expect(try json(UpdateProjectBody(cosModel: CosSettings.patch(.init(driver: nil, model: nil))))["cosModel"] is NSNull)
        #expect(try json(UpdateProjectBody())["cosModel"] == nil)
    }
}

@Suite struct CosWireTests {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func aChatEntryOfAFutureKindSurvivesARoundTrip() throws {
        let raw = #"{"id":"x","cosId":"c1","createdAt":5,"kind":"future","shiny":true}"#
        let entry: CosChatEntry = try decode(raw)
        guard case let .unknown(id, _, _, kind, _) = entry else { Issue.record("decoded as \(entry)"); return }
        #expect(id == "x")
        #expect(kind == "future")
        let again = try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any]
        #expect(again?["shiny"] as? Bool == true)
    }

    @Test func theBusEventsComeOutOfAnUnknownHarnessEvent() throws {
        let badge: HarnessEvent = try decode(#"{"kind":"cos.badge","total":4,"byCos":{"c1":4}}"#)
        #expect(CosBusEvent(event: badge) == .badge(CosBadge(total: 4, byCos: ["c1": 4])))

        let appended: HarnessEvent = try decode(#"{"kind":"cos.transcript.appended","cosId":"c1","entry":{"id":"m","cosId":"c1","createdAt":1,"kind":"message","role":"user","text":"hi"}}"#)
        #expect(CosBusEvent(event: appended) == .transcriptAppended(cosId: "c1", entry: .message(id: "m", cosId: "c1", createdAt: 1, role: "user", text: "hi")))

        let upserted: HarnessEvent = try decode(#"{"kind":"cos.event.upserted","event":{"id":"e","cosId":null,"projectKey":null,"sourceKind":"watcher","title":"t","summary":"","actor":"watcher:jira","status":"ignored","verdict":"ignore","reason":"noise","model":null,"ticketKey":null,"wakeId":null,"handledBy":null,"createdAt":1}}"#)
        guard case let .eventUpserted(e)? = CosBusEvent(event: upserted) else { Issue.record("not an upserted event"); return }
        #expect(e.cosId == nil)
        #expect(e.status == .ignored)
        #expect(e.sourceKind == .watcher)
    }

    @Test func anEventThatIsNotACosEventOrIsMalformedIsNotABusEvent() throws {
        let other: HarnessEvent = try decode(#"{"kind":"future.thing","x":1}"#)
        #expect(CosBusEvent(event: other) == nil)
        let broken: HarnessEvent = try decode(#"{"kind":"cos.badge","total":"many"}"#)
        #expect(CosBusEvent(event: broken) == nil)
        #expect(CosBusEvent(event: .devicesChanged) == nil)
    }

    @Test func aBusEventUpdatesTheState() {
        var state = CosState()
        state.apply(.eventUpserted(event("a", status: .pending)))
        state.apply(.eventUpserted(event("a", status: .ignored, verdict: .ignore)))
        state.apply(.badge(CosBadge(total: 1, byCos: ["c1": 1])))
        state.apply(.transcriptAppended(cosId: "c1", entry: message("m", at: 1)))
        state.apply(.transcriptAppended(cosId: "c1", entry: message("m", at: 1)))
        #expect(state.events["a"]?.status == .ignored)
        #expect(state.badge?.total == 1)
        #expect(state.chat["c1"]?.count == 1, "the same entry arriving twice is kept once")
    }

    @Test func aStaleMemoryWriteCarriesTheChiefsVersion() throws {
        let data: JSONValue = .object(["currentRevision": .string("rev-2"), "text": .string("theirs")])
        #expect(HarnessAPIError(status: 409, message: "stale", data: data).memoryConflict == MemoryConflict(currentRevision: "rev-2", text: "theirs"))
        #expect(HarnessAPIError(status: 400, message: "bad", data: data).memoryConflict == nil)
        #expect(HarnessAPIError(status: 409, message: "other", data: .object(["currentRevision": .number(3), "spec": .string("s")])).memoryConflict == nil, "a spec conflict isn't a memory conflict")
    }

    @Test func theCosLinksOpenTheChiefAndTheOldInboxLinksOpenTheBoard() throws {
        #expect(DeepLink.parse(try #require(URL(string: "harness://cos"))) == .push(.cos(scope: "all")))
        #expect(DeepLink.parse(try #require(URL(string: "harness://cos/group-work"))) == .push(.cos(scope: "group:group-work")))
        #expect(DeepLink.parse(try #require(URL(string: "harness://inbox"))) == .tab(.board))
        #expect(DeepLink.parse(try #require(URL(string: "harness://inbox/session-1"))) == .tab(.board))
        #expect(DeepLink.parse(try #require(URL(string: "harness://watcher?id=w1"))) == .tab(.board))
    }

    private func event(_ id: String, status: CosEventStatus, verdict: CosEventVerdict = .pending) -> CosEvent {
        CosEvent(id: id, cosId: "c1", title: id, status: status, verdict: verdict, createdAt: 0)
    }

    private func message(_ id: String, at: Double) -> CosChatEntry {
        .message(id: id, cosId: "c1", createdAt: at, role: "assistant", text: "hi")
    }
}

@MainActor @Suite struct CosRouterTests {
    @Test func openingAChiefIsASheetOfItsOwnAndTheSameChiefComesForwardInsteadOfOpeningTwice() {
        let r = Router()
        r.openCos(scope: "all")
        #expect(r.ticketSheet?.cosScope == "all")
        #expect(r.ticketSheet?.title == "Chief of Staff")
        r.openCos(scope: "group:work")
        #expect(r.dockedSheets.map(\.cosScope) == ["group:work", "all"])
        r.openCos(scope: "all")
        #expect(r.dockedSheets.map(\.cosScope) == ["all", "group:work"], "the open one comes to the top, no second copy")
    }

    @Test func aTicketOpenedFromAChiefsCardJoinsTheDockBesideIt() {
        let r = Router()
        r.openCos(scope: "all")
        r.openTicket(key: "A-1", tab: nil)
        #expect(r.ticketSheet?.topTicketKey == "A-1")
        #expect(r.dockedSheets.count == 2)
    }

    @Test func aChiefLinkOpensItsSheetAndASavedOneComesBack() {
        let r = Router()
        _ = r.open(.push(.cos(scope: "group:work")))
        #expect(r.ticketSheet?.cosScope == "group:work")
        let json = r.persistedState()
        let restored = Router()
        #expect(restored.restorePersistedState(json))
        #expect(restored.dockedSheets.first?.cosScope == "group:work")
    }
}
