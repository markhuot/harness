import Foundation
import Testing
@testable import HarnessKit

@Suite("state/promptAttachments.ts parity")
struct PromptAttachmentsTests {
    struct SameInput: Decodable, Sendable {
        let x: [PromptAttachment]
        let y: [PromptAttachment]
    }

    struct AddInput: Decodable, Sendable {
        let list: [PromptAttachment]
        let added: [PromptAttachmentInput]
        let max: Int?
    }

    struct AddOutput: Decodable, Sendable, Equatable {
        let list: [PromptAttachment]
        let skipped: Int
    }

    struct RemoveInput: Decodable, Sendable {
        let list: [PromptAttachment]
        let index: Int
    }

    struct NamePath: Decodable, Sendable {
        let name: String
        let path: String
    }

    @Test(arguments: Fixture.cases("promptAttachments", "fileBaseNameCases", input: String.self, output: String.self))
    func fileBaseName(_ c: Fixture.Case<String, String>) {
        #expect(PromptAttachments.fileBaseName(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "promptAttachmentFromInputCases", input: PromptAttachmentInput.self, output: PromptAttachment.self))
    func fromInput(_ c: Fixture.Case<PromptAttachmentInput, PromptAttachment>) {
        #expect(PromptAttachments.fromInput(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "promptAttachmentInputsCases", input: [PromptAttachment].self, output: JSONValue.self))
    func inputs(_ c: Fixture.Case<[PromptAttachment], JSONValue>) throws {
        try expectJSONMatchesTS(PromptAttachments.inputs(c.input), c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "samePromptAttachmentsCases", input: SameInput.self, output: Bool.self))
    func same(_ c: Fixture.Case<SameInput, Bool>) {
        #expect(PromptAttachments.same(c.input.x, c.input.y) == c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "addPromptAttachmentsCases", input: AddInput.self, output: AddOutput.self))
    func add(_ c: Fixture.Case<AddInput, AddOutput>) {
        let r = c.input.max.map { PromptAttachments.add(c.input.list, c.input.added, max: $0) } ?? PromptAttachments.add(c.input.list, c.input.added)
        #expect(AddOutput(list: r.list, skipped: r.skipped) == c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "removePromptAttachmentCases", input: RemoveInput.self, output: [PromptAttachment].self))
    func remove(_ c: Fixture.Case<RemoveInput, [PromptAttachment]>) {
        #expect(PromptAttachments.remove(c.input.list, at: c.input.index) == c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "promptAttachmentIsImageCases", input: NamePath.self, output: Bool.self))
    func isImage(_ c: Fixture.Case<NamePath, Bool>) {
        #expect(PromptAttachments.isImage(name: c.input.name, path: c.input.path) == c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "pastedImageNameCases", input: String?.self, output: String.self))
    func pastedImageName(_ c: Fixture.Case<String?, String>) {
        #expect(PromptAttachments.pastedImageName(c.input) == c.output)
    }

    /// The default cap is MAX_PROMPT_ATTACHMENTS (fixtures only pin an explicit `max`).
    @Test func defaultCapIsTwenty() {
        let added = (0..<25).map { PromptAttachmentInput(path: "/\($0).png") }
        let r = PromptAttachments.add([], added)
        #expect(r.list.count == 20)
        #expect(r.skipped == 5)
    }

    /// JS compares paths by code units: a precomposed é and e + U+0301 are two files.
    @Test func canonicallyEquivalentPathsAreDistinct() {
        let r = PromptAttachments.add([], [PromptAttachmentInput(path: "/caf\u{E9}.png"), PromptAttachmentInput(path: "/cafe\u{301}.png")])
        #expect(r.list.count == 2)
    }

    /// Local edits keep where a file came from; the wire body doesn't send it.
    @Test func inputsKeepingSourceKeepsUploads() {
        let up = PromptAttachment(path: "/u/a.png", name: "a.png", source: .upload)
        let t = Drafts.applyTicketPatch(sample(), UpdateTicketBody(promptAttachments: PromptAttachments.inputsKeepingSource([up])))
        #expect(t.promptAttachments == [up])
        #expect(PromptAttachments.inputs([up]).first?.source == nil)
    }

    private func sample() -> Ticket {
        Ticket(id: "t", key: "A-1", projectId: "p", title: "", spec: "", status: .planning, sessionId: "s", driver: "d", createdAt: 0, updatedAt: 0)
    }
}

@Suite("PromptAttachments phone-only upload rules")
struct PromptAttachmentUploadRulesTests {
    @Test func heicAndHeifConvertByTypeOrExtension() {
        #expect(PromptAttachments.needsJPEG(mimeType: "image/HEIC", name: "x"))
        #expect(PromptAttachments.needsJPEG(mimeType: "image/heif", name: "x.png"))
        #expect(PromptAttachments.needsJPEG(mimeType: nil, name: "IMG_1.HEIC"))
        #expect(PromptAttachments.needsJPEG(mimeType: "application/octet-stream", name: "a.heif"))
        #expect(!PromptAttachments.needsJPEG(mimeType: "image/png", name: "a.png"))
        #expect(!PromptAttachments.needsJPEG(mimeType: nil, name: "heic"))
        #expect(!PromptAttachments.needsJPEG(mimeType: nil, name: "/a.heic/file"))
    }

    @Test func jpegNameSwapsOnlyARealExtension() {
        #expect(PromptAttachments.jpegName("IMG_1.HEIC") == "IMG_1.jpg")
        #expect(PromptAttachments.jpegName("a.b.heic") == "a.b.jpg")
        #expect(PromptAttachments.jpegName("photo") == "photo.jpg")
        #expect(PromptAttachments.jpegName(".heic") == ".heic.jpg")
    }

    @Test func roomStopsAtTheLimit() {
        #expect(PromptAttachments.room(current: 0, pending: 0, incoming: 3) == 3)
        #expect(PromptAttachments.room(current: 17, pending: 1, incoming: 5) == 2)
        #expect(PromptAttachments.room(current: 20, pending: 0, incoming: 1) == 0)
        #expect(PromptAttachments.room(current: 19, pending: 3, incoming: 1) == 0)
    }

    @Test func limitMessageCountsFiles() {
        #expect(PromptAttachments.limitMessage(skipped: 1) == "A session takes up to 20 attachments: 1 file was left out.")
        #expect(PromptAttachments.limitMessage(skipped: 3, max: 5) == "A session takes up to 5 attachments: 3 files were left out.")
    }
}
