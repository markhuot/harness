import Foundation
import Testing
@testable import HarnessKit

@Suite("PickerLogic (Features/Pickers glue)")
struct PickerLogicTests {
    static func driver(_ id: String, available: Bool = true, authenticated: Bool = true) -> DriverInfo {
        DriverInfo(id: id, name: id.capitalized, description: "", available: available, authenticated: authenticated, detail: "", supportsLogin: false)
    }

    static func ticket() throws -> Ticket {
        try Fixture.value("protocol", "Ticket", as: [Ticket].self)[0]
    }

    // MARK: Select menus

    @Test func permissionOptionsOfferDefaultOnlyWithSomethingToInherit() {
        let inherited = PickerLogic.permissionOptions(inherited: .ask)
        #expect(inherited.map(\.label) == ["Default (Ask)", "Auto", "Ask", "Read only"])
        #expect(inherited[0].value == nil)
        #expect(inherited[3].subtitle == Permissions.label(for: .readOnly)?.description)
        #expect(PickerLogic.permissionOptions(inherited: nil).map(\.value) == [.auto, .ask, .readOnly])
    }

    @Test func permissionLabelPrefersThePickThenTheInheritedMode() {
        #expect(PickerLogic.permissionLabel(value: .readOnly, inherited: .ask) == "Read only")
        #expect(PickerLogic.permissionLabel(value: nil, inherited: .ask) == "Default · Ask")
        #expect(PickerLogic.permissionLabel(value: nil, inherited: nil) == "Default")
    }

    @Test func modelListProblemTakesTheRequestErrorOverTheDriversAndSkipsEmpty() {
        let driverError = DriverModels(driverId: "x", models: [], error: "not signed in", fetchedAt: 0)
        #expect(PickerLogic.modelListProblem(ModelListState(data: driverError, error: "offline")) == "offline")
        #expect(PickerLogic.modelListProblem(ModelListState(data: driverError)) == "not signed in")
        #expect(PickerLogic.modelListProblem(ModelListState(data: DriverModels(driverId: "x", models: [], error: "", fetchedAt: 0))) == nil)
    }

    // MARK: DriverModelPicker

    @Test func choiceDriversAreSignedInPlusPickedAndResolvedWithoutRepeats() {
        let drivers = [Self.driver("claude"), Self.driver("codex", authenticated: false), Self.driver("dummy"), Self.driver("gone", available: false)]
        let ids = PickerLogic.choiceDriverIds(drivers, value: TriageChoice(driver: "codex", model: nil), resolved: TriageChoice(driver: "claude", model: nil), onlyDriver: nil)
        #expect(ids == ["claude", "dummy", "codex"])
    }

    @Test func onlyDriverReplacesTheSignedInListButKeepsTheResolvedOne() {
        let drivers = [Self.driver("claude"), Self.driver("dummy")]
        let ids = PickerLogic.choiceDriverIds(drivers, value: .init(driver: nil, model: nil), resolved: .init(driver: "claude", model: nil), onlyDriver: "dummy")
        #expect(ids == ["dummy", "claude"])
        // An empty onlyDriver is unset (JS truthiness).
        #expect(PickerLogic.choiceDriverIds(drivers, value: .init(driver: nil, model: nil), resolved: .init(driver: nil, model: nil), onlyDriver: "") == ["claude", "dummy"])
    }

    @Test func choiceStatusSpinsOnlyWhileAListHasNoDataAndNamesTheFirstFailure() {
        let ok = DriverModels(driverId: "a", models: [], fetchedAt: 0)
        let lists: [String: ModelListState] = [
            "a": ModelListState(data: ok, loading: true),
            "b": ModelListState(data: nil, loading: false, error: "boom"),
            "c": ModelListState(data: nil, loading: true),
        ]
        let refreshing = PickerLogic.choiceListsStatus(["a"], lists: { lists[$0] ?? .empty }, name: { $0.uppercased() })
        #expect(refreshing.loading == false)
        let all = PickerLogic.choiceListsStatus(["a", "b", "c"], lists: { lists[$0] ?? .empty }, name: { $0.uppercased() })
        #expect(all.loading)
        #expect(all.problem == "Couldn't list B models: boom")
    }

    @Test func choiceRowLabelIncludesTheDriverHeading() {
        #expect(PickerLogic.choiceRowLabel(section: "Dummy", label: "Dummy Slow") == "Dummy, Dummy Slow")
        #expect(PickerLogic.choiceRowLabel(section: nil, label: "Default (Sonnet)") == "Default (Sonnet)")
    }

    // MARK: Mentions

    @Test func aLeadingCommandWinsOverAnInnerMentionOnlyWhenCommandsAreOn() {
        let text = "/co@READ"
        let caret = MentionCaret(at: 8)
        #expect(PickerLogic.mentionTarget(text, caret: caret, commands: true)?.lookup == "/co@READ")
        // Without commands the @ inside the word isn't at a boundary, so nothing is typed.
        #expect(PickerLogic.mentionTarget(text, caret: caret, commands: false) == nil)
        #expect(PickerLogic.mentionTarget("see @src/a", caret: MentionCaret(at: 10), commands: true)?.lookup == "@src/a")
        // A range selection has no caret.
        #expect(PickerLogic.mentionTarget("see @src/a", caret: MentionCaret(at: nil), commands: true) == nil)
    }

    @Test func pickingAFileReplacesTheMentionAndMovesTheCaretPastTheSpace() throws {
        let text = "Summarize @READ"
        let target = try #require(PickerLogic.mentionTarget(text, caret: MentionCaret(at: 15), commands: false))
        let next = try #require(PickerLogic.pickMention(text, target: target, item: .file(FileMatch(path: "README.md", kind: .file))))
        #expect(next.text == "Summarize @README.md ")
        #expect(next.caret == next.text.utf16.count)
        // A folder keeps the mention open inside it.
        let dir = try #require(PickerLogic.pickMention(text, target: target, item: .file(FileMatch(path: "src/", kind: .dir))))
        #expect(dir.text == "Summarize @src/")
        #expect(PickerLogic.mentionTarget(dir.text, caret: MentionCaret.onPick(dir.caret), commands: false)?.query == "src/")
    }

    @Test func aRowOfTheOtherKindDoesNothing() throws {
        let target = try #require(PickerLogic.mentionTarget("/co", caret: MentionCaret(at: 3), commands: true))
        #expect(PickerLogic.pickMention("/co", target: target, item: .file(FileMatch(path: "a.ts", kind: .file))) == nil)
        #expect(PickerLogic.pickMention("/co", target: target, item: .command(CommandMatch(name: "code-walk", description: "")))?.text == "/code-walk ")
    }

    @Test func mentionRowsSplitNameFromFolder() {
        let file = PickerLogic.mentionRow(.file(FileMatch(path: "src/lib/app.ts", kind: .file)))
        #expect([file.icon, file.name, file.detail, file.label] == ["fileText", "app.ts", "src/lib/", "src/lib/app.ts"])
        let dir = PickerLogic.mentionRow(.file(FileMatch(path: "src/lib/", kind: .dir)))
        #expect([dir.icon, dir.name, dir.detail, dir.label] == ["folder", "lib/", "src/", "src/lib/"])
        let root = PickerLogic.mentionRow(.file(FileMatch(path: "README.md", kind: .file)))
        #expect([root.name, root.detail] == ["README.md", ""])
        let cmd = PickerLogic.mentionRow(.command(CommandMatch(name: "code-walk", description: "Walk through code")))
        #expect([cmd.icon, cmd.name, cmd.detail, cmd.label] == ["zap", "/code-walk", "Walk through code", "/code-walk"])
        #expect(!cmd.truncateHead && file.truncateHead)
    }

    @Test func utf16OffsetsRoundTripAroundEmojiAndCombiningMarks() {
        let text = "a😀e\u{301}b"
        // a=1, 😀=2 units, e=1, U+0301=1, b=1
        #expect(PickerLogic.utf16Offset(text.endIndex, in: text) == 6)
        let afterEmoji = PickerLogic.index(utf16: 3, in: text)
        #expect(String(text.unicodeScalars[afterEmoji...]) == "e\u{301}b")
        #expect(PickerLogic.utf16Offset(afterEmoji, in: text) == 3)
        // Inside the surrogate pair snaps back to the emoji's start; past the end clamps.
        #expect(PickerLogic.utf16Offset(PickerLogic.index(utf16: 2, in: text), in: text) == 1)
        #expect(PickerLogic.index(utf16: 99, in: text) == text.endIndex)
        // Between e and its combining mark (a scalar boundary, not a Character one).
        #expect(PickerLogic.utf16Offset(PickerLogic.index(utf16: 4, in: text), in: text) == 4)
    }

    // MARK: Project colors

    @Test func customGridMatchesTheRNGrid() {
        // Values from the 1.x React Native app's custom project color grid (computed with bun).
        let g = PickerLogic.customGrid
        #expect(g.count == 7 && g.allSatisfy { $0.count == 12 })
        #expect(g[0][0] == "#f6acac")
        #expect(g[0][11] == "#f6acea")
        #expect(g[2][9] == "#3040e8")
        #expect(g[3][2] == "#cfa117")
        #expect(g[5][5] == "#0d732f")
        #expect(g[6] == ["#ebebeb", "#d6d6d6", "#c4c4c4", "#b0b0b0", "#9c9c9c", "#8a8a8a", "#757575", "#636363", "#4f4f4f", "#3b3b3b", "#292929", "#141414"])
    }

    @Test func hexCommitAcceptsShortAndBareHexAndRevertsJunk() {
        #expect(PickerLogic.commitHex("abc", current: nil) == .pick("#aabbcc"))
        #expect(PickerLogic.commitHex("#5E6AD2", current: "red") == .pick("#5e6ad2"))
        #expect(PickerLogic.commitHex("#5e6ad2", current: "#5e6ad2") == .keep)
        #expect(PickerLogic.commitHex("zzz", current: "#5e6ad2") == .revert("#5e6ad2"))
        #expect(PickerLogic.commitHex("red", current: "red") == .revert(""))
        #expect(PickerLogic.commitHex("", current: nil) == .revert(""))
    }

    // MARK: Ticket settings

    @Test func hintsFollowDraftBusyAndBranchState() throws {
        var t = try Self.ticket()
        t.draft = nil
        t.busy = true
        t.branch = nil
        t.baseBranch = .absent
        let editable = Drafts.TicketSettingsRows(editable: true, onlyDriver: nil, worktree: true, branch: .init(show: true, editable: true, offerCheckout: false), base: .init(show: true, editable: true))
        var h = PickerLogic.ticketSettingsHints(t, rows: editable)
        #expect(h.model == "Applies from the next run. The driver can't change while a run is going.")
        #expect(h.branch == "Until work starts")
        #expect(h.base == "Inherited")

        t.busy = false
        t.branch = "harness/x"
        t.baseBranch = .value("develop")
        var locked = editable
        locked.branch.editable = false
        h = PickerLogic.ticketSettingsHints(t, rows: locked)
        #expect(h.model == "Applies from the next run")
        #expect(h.branch == nil)
        #expect(h.base == "Applies from the next run")
        t.branch = nil
        #expect(PickerLogic.ticketSettingsHints(t, rows: locked).branch == "When work starts")

        t.draft = true
        #expect(PickerLogic.ticketSettingsHints(t, rows: editable) == PickerLogic.TicketSettingsHints())
    }

    @Test func dependsOnSplitsOnCommasAndSpacesAndUppercases() {
        let (keys, bad) = PickerLogic.parseDependsOn(" web-3,web-4\n  nope , ")
        #expect(keys == ["WEB-3", "WEB-4", "NOPE"])
        #expect(bad == ["NOPE"])
        #expect(PickerLogic.dependsOnSave("web-3 web-4", current: ["WEB-3", "WEB-4"]) == nil)
        #expect(PickerLogic.dependsOnSave("web-3, nope", current: []) == nil)
        #expect(PickerLogic.dependsOnSave("web-4", current: ["WEB-3"]) == ["WEB-4"])
        #expect(PickerLogic.dependsOnSave("", current: ["WEB-3"]) == [])
    }

    @Test func remoteIdBodiesLinkWithNullURLUnlinkAndDropErrors() throws {
        let link = try #require(PickerLogic.remoteIdBody(.link(key: "JIRA-62", url: nil)))
        #expect(link.externalRef == .value(ExternalRefInput(key: "JIRA-62", url: .null)))
        let withURL = try #require(PickerLogic.remoteIdBody(.link(key: "JIRA-62", url: "https://x")))
        #expect(withURL.externalRef == .value(ExternalRefInput(key: "JIRA-62", url: .value("https://x"))))
        #expect(PickerLogic.remoteIdBody(.unlink)?.externalRef == .null)
        #expect(PickerLogic.remoteIdBody(.error("nope")) == nil)
    }

    @Test func branchListLooksUpAnUnlistedRequestAndRemembersPicks() {
        var b = TicketBranchList(list: [BranchInfo(name: "main", lastCommitAt: 1)])
        #expect(!b.needsLookup(nil) && !b.needsLookup("") && !b.needsLookup("main"))
        #expect(b.needsLookup("feature/x"))
        b.found([BranchInfo(name: "feature/x-2", lastCommitAt: 2), BranchInfo(name: "feature/x", lastCommitAt: 3)], for: "feature/x")
        #expect(b.picked.map(\.name) == ["feature/x"])
        #expect(!b.needsLookup("feature/x"))
        b.remember(BranchInfo(name: "main", lastCommitAt: 9, checkedOutAt: "/Users/a/p"))
        #expect(b.known.map(\.name) == ["main", "feature/x", "main"])
        #expect(b.known.first?.checkedOutAt == "/Users/a/p")
        b.remember(BranchInfo(name: "main", lastCommitAt: 10))
        #expect(b.picked.map(\.lastCommitAt) == [10, 3])
    }
}
