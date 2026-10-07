import Foundation
import Testing
@testable import HarnessKit
import struct HarnessKit.Attachment

@Suite("state/messageDrafts.ts parity")
struct MessageDraftsParityTests {
    struct AdoptInput: Decodable, Sendable {
        let saved: MessageDraft?
        let origin: String
        let focused: Bool
        let dirty: Bool
        let shown: MessageDraftValue
    }

    struct BodyInput: Decodable, Sendable {
        let value: MessageDraftValue
        let origin: String
    }

    @Test(arguments: Fixture.cases("messageDrafts", "adoptMessageDraftCases", input: AdoptInput.self, output: MessageDraftValue?.self))
    func adopt(_ c: Fixture.Case<AdoptInput, MessageDraftValue?>) {
        let i = c.input
        #expect(MessageDrafts.adopt(saved: i.saved, origin: i.origin, focused: i.focused, dirty: i.dirty, shown: i.shown) == c.output, "\(c.name)")
    }

    @Test(arguments: Fixture.cases("messageDrafts", "hasMessageDraftCases", input: MessageDraft?.self, output: Bool.self))
    func has(_ c: Fixture.Case<MessageDraft?, Bool>) {
        #expect(MessageDrafts.has(c.input) == c.output, "\(c.name)")
    }

    @Test(arguments: Fixture.cases("messageDrafts", "messageDraftBodyCases", input: BodyInput.self, output: JSONValue.self))
    func body(_ c: Fixture.Case<BodyInput, JSONValue>) throws {
        try expectJSONMatchesTS(MessageDrafts.body(c.input.value, origin: c.input.origin), c.output)
    }

    @Test func originsAreUniquePerComposer() {
        let a = MessageDrafts.newOrigin()
        #expect(a.count == 16)
        #expect(a != MessageDrafts.newOrigin())
    }
}

/// The composer's saving (MessageDraftSync): a fake service answers the PUTs; ManualTimers stands
/// in for the debounce.
@MainActor
@Suite("MessageDraftSync")
struct MessageDraftSyncTests {
    static let shot = Attachment(id: "a1", path: "/u/a.png", name: "a.png", source: .upload, kind: .image, mimeType: "image/png")

    @MainActor
    final class Service {
        var puts: [MessageDraftBody] = []
        var fail = false
        /// Holds each PUT until `release()` (when set)
        var hold = false
        private var held: [CheckedContinuation<Void, Never>] = []

        func save(_ key: String, _ body: MessageDraftBody) async throws -> Ticket {
            puts.append(body)
            if hold { await withCheckedContinuation { held.append($0) } }
            if fail { throw HarnessAPIError(status: 500, message: "offline", data: nil) }
            return Ticket(id: "t1", key: key, projectId: "p1", title: "t", spec: "", status: .blocked, sessionId: "s1", driver: "dummy", createdAt: 0, updatedAt: 0)
        }

        func release() {
            let all = held
            held = []
            for c in all { c.resume() }
        }
    }

    @MainActor
    struct Rig {
        let service = Service()
        let timers = ManualTimers()
        let sync: MessageDraftSync
        var saved: [Ticket] { savedBox.list }
        private let savedBox = Box()
        @MainActor final class Box { var list: [Ticket] = [] }

        init(stored: MessageDraft? = nil) {
            let service = service
            let box = savedBox
            sync = MessageDraftSync(key: "WEB-1", stored: stored, save: { try await service.save($0, $1) }, onSaved: { box.list.append($0) },
                                    delayMs: 20, timers: timers, origin: "me")
        }

        func wait(_ ms: Double = 40) async {
            timers.advance(by: ms)
            for _ in 0..<50 { await Task.yield() }
        }
    }

    static func draft(_ text: String, _ origin: String?) -> MessageDraft {
        MessageDraft(text: text, origin: origin, updatedAt: 1)
    }

    @Test func startsFromTheTicketsSavedDraft() {
        let r = Rig(stored: Self.draft("from the phone", "phone"))
        #expect(r.sync.text == "from the phone")
        #expect(!r.sync.dirty)
    }

    @Test func typingAndAttachingIsDebouncedIntoOnePutOfTheWholeDraft() async {
        let r = Rig()
        r.sync.setText("h")
        r.sync.setText("hi")
        r.sync.attachments.add([Self.shot])
        #expect(r.service.puts.isEmpty)
        await r.wait()
        #expect(r.service.puts == [MessageDraftBody(text: "hi", attachments: [AttachmentInput(Self.shot)], origin: "me")])
        #expect(!r.sync.dirty)
        #expect(r.saved.count == 1)
    }

    @Test func itsOwnEchoNeverRewritesTheField() async {
        let r = Rig()
        r.sync.setText("hel")
        await r.wait()
        r.sync.setText("hello")
        await r.wait()
        r.sync.sync(Self.draft("hel", "me"))
        #expect(r.sync.text == "hello")
    }

    @Test func anotherDevicesEditWaitsForTheFieldToLoseFocus() {
        let r = Rig()
        r.sync.focus(true, stored: nil)
        r.sync.sync(Self.draft("from the phone", "phone"))
        #expect(r.sync.text == "")
        r.sync.focus(false, stored: Self.draft("from the phone", "phone"))
        #expect(r.sync.text == "from the phone")
        // What it took counts as saved: nothing goes back.
        #expect(!r.sync.dirty)
    }

    @Test func anotherDevicesFilesReplaceTheListWithoutSavingThemBack() async {
        let r = Rig()
        r.sync.sync(MessageDraft(text: "", attachments: [Self.shot], origin: "phone", updatedAt: 1))
        #expect(r.sync.attachments.list == [Self.shot])
        await r.wait()
        #expect(r.service.puts.isEmpty)
    }

    @Test func aFailedSaveKeepsTheEditAndIsReported() async {
        let r = Rig()
        r.service.fail = true
        var errors = 0
        r.sync.onError = { _ in errors += 1 }
        r.sync.setText("keep")
        await r.wait()
        #expect(errors == 1)
        #expect(r.sync.dirty)
        r.sync.sync(Self.draft("theirs", "phone"))
        #expect(r.sync.text == "keep")
    }

    @Test func noSaveGoesOutDuringASendAndTheTextGoesWhenItsSent() async {
        let r = Rig()
        r.sync.setText("go")
        await r.wait()
        r.sync.setText("go!")
        r.sync.attachments.add([Self.shot])
        await r.sync.beforeSend()
        await r.wait()
        #expect(r.service.puts.map(\.text) == ["go"])
        let late = Attachment(id: "a2", path: "/u/b.png", name: "b.png", source: .upload, kind: .image, mimeType: "image/png")
        r.sync.attachments.add([late])
        r.sync.sent(files: [Self.shot])
        #expect(r.sync.text == "")
        #expect(r.sync.attachments.list == [late])
        await r.wait()
        // What was attached while it sent is the new draft.
        #expect(r.service.puts.last == MessageDraftBody(text: "", attachments: [AttachmentInput(late)], origin: "me"))
    }

    @Test func beforeSendWaitsForTheSaveOnItsWay() async {
        let r = Rig()
        r.service.hold = true
        r.sync.setText("a")
        await r.wait()
        #expect(r.service.puts.count == 1)
        var done = false
        let waiting = Task { await r.sync.beforeSend(); done = true }
        for _ in 0..<20 { await Task.yield() }
        #expect(!done)
        r.service.release()
        await waiting.value
        #expect(done)
    }

    @Test func aFailedSendPicksSavingBackUp() async {
        let r = Rig()
        r.sync.setText("retry me")
        await r.sync.beforeSend()
        r.sync.setText("retry me!")
        await r.wait()
        #expect(r.service.puts.isEmpty)
        r.sync.sendFailed()
        await r.wait()
        #expect(r.service.puts.map(\.text) == ["retry me!"])
    }
}
