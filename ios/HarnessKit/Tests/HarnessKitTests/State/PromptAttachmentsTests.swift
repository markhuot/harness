import Foundation
import Testing
@testable import HarnessKit
import struct HarnessKit.Attachment

@Suite("state/promptAttachments.ts parity")
struct PromptAttachmentsTests {
    struct SameInput: Decodable, Sendable {
        let x: [Attachment]
        let y: [Attachment]
    }

    struct AddInput: Decodable, Sendable {
        let list: [Attachment]
        let added: [Attachment]
        let max: Int?
    }

    struct AddOutput: Decodable, Sendable, Equatable {
        let list: [Attachment]
        let skipped: Int
    }

    struct RemoveInput: Decodable, Sendable {
        let list: [Attachment]
        let index: Int
    }

    struct KindOnly: Decodable, Sendable {
        let kind: AttachmentKind
    }

    @Test(arguments: Fixture.cases("promptAttachments", "fileBaseNameCases", input: String.self, output: String.self))
    func fileBaseName(_ c: Fixture.Case<String, String>) {
        #expect(PromptAttachments.fileBaseName(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "attachmentFromInputCases", input: AttachmentInput.self, output: Attachment.self))
    func fromInput(_ c: Fixture.Case<AttachmentInput, Attachment>) {
        #expect(PromptAttachments.fromInput(c.input) == c.output, "\(c.name)")
    }

    @Test(arguments: Fixture.cases("promptAttachments", "attachmentInputsCases", input: [Attachment].self, output: JSONValue.self))
    func inputs(_ c: Fixture.Case<[Attachment], JSONValue>) throws {
        try expectJSONMatchesTS(PromptAttachments.inputs(c.input), c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "sameAttachmentsCases", input: SameInput.self, output: Bool.self))
    func same(_ c: Fixture.Case<SameInput, Bool>) {
        #expect(PromptAttachments.same(c.input.x, c.input.y) == c.output, "\(c.name)")
    }

    @Test(arguments: Fixture.cases("promptAttachments", "addAttachmentsCases", input: AddInput.self, output: AddOutput.self))
    func add(_ c: Fixture.Case<AddInput, AddOutput>) {
        let r = c.input.max.map { PromptAttachments.add(c.input.list, c.input.added, max: $0) } ?? PromptAttachments.add(c.input.list, c.input.added)
        #expect(AddOutput(list: r.list, skipped: r.skipped) == c.output, "\(c.name)")
    }

    @Test(arguments: Fixture.cases("promptAttachments", "removeAttachmentCases", input: RemoveInput.self, output: [Attachment].self))
    func remove(_ c: Fixture.Case<RemoveInput, [Attachment]>) {
        #expect(PromptAttachments.remove(c.input.list, at: c.input.index) == c.output)
    }

    @Test(arguments: Fixture.cases("promptAttachments", "attachmentIsImageCases", input: KindOnly.self, output: Bool.self))
    func isImage(_ c: Fixture.Case<KindOnly, Bool>) {
        #expect(PromptAttachments.isImage(kind: c.input.kind) == c.output)
    }

    struct AnnotateInput: Decodable, Sendable {
        let list: [Attachment]
        let attachment: Attachment
        let annotation: AttachmentAnnotation?
        let max: Int?
    }

    struct AnnotateOutput: Decodable, Sendable, Equatable {
        let list: [Attachment]
        let skipped: Bool
    }

    @Test(arguments: Fixture.cases("promptAttachments", "annotateAttachmentCases", input: AnnotateInput.self, output: AnnotateOutput.self))
    func annotate(_ c: Fixture.Case<AnnotateInput, AnnotateOutput>) {
        let r = c.input.max.map { PromptAttachments.annotate(c.input.list, c.input.attachment, annotation: c.input.annotation, max: $0) }
            ?? PromptAttachments.annotate(c.input.list, c.input.attachment, annotation: c.input.annotation)
        #expect(AnnotateOutput(list: r.list, skipped: r.skipped) == c.output, "\(c.name)")
    }

    @Test(arguments: Fixture.cases("promptAttachments", "pastedImageNameCases", input: String?.self, output: String.self))
    func pastedImageName(_ c: Fixture.Case<String?, String>) {
        #expect(PromptAttachments.pastedImageName(c.input) == c.output)
    }

    static func file(_ id: String, _ path: String) -> Attachment {
        Attachment(id: id, path: path, name: PromptAttachments.fileBaseName(path), source: .upload, kind: .image, mimeType: "image/png")
    }

    /// The default cap is MAX_PROMPT_ATTACHMENTS (fixtures only pin an explicit `max`).
    @Test func defaultCapIsTwenty() {
        let added = (0..<25).map { Self.file("a\($0)", "/\($0).png") }
        let r = PromptAttachments.add([], added)
        #expect(r.list.count == 20)
        #expect(r.skipped == 5)
    }

    /// JS compares ids and paths by code units: a precomposed é and e + U+0301 are two files.
    @Test func canonicallyEquivalentPathsAreDistinct() {
        let r = PromptAttachments.add([], [Self.file("", "/caf\u{E9}.png"), Self.file("", "/cafe\u{301}.png")])
        #expect(r.list.count == 2)
    }

    /// An older service's record (no id, kind or mimeType) still decodes, its kind from its name;
    /// one without a path doesn't.
    @Test func anOlderServicesRecordDecodesWithDefaults() throws {
        let old = try JSONDecoder().decode(Attachment.self, from: Data(#"{"path":"/u/a.MOV","name":"a.MOV","source":"upload"}"#.utf8))
        #expect(old == Attachment(id: "", path: "/u/a.MOV", name: "a.MOV", source: .upload, kind: .video, mimeType: ""))
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Attachment.self, from: Data(#"{"name":"x.png","id":"a1"}"#.utf8)) }
    }

    /// Local edits keep where a file came from: the body sends each attachment whole.
    @Test func applyingTheDraftsOwnPatchKeepsUploads() {
        let up = Self.file("a1", "/u/a.png")
        let t = Drafts.applyTicketPatch(sample(), UpdateTicketBody(promptAttachments: PromptAttachments.inputs([up])))
        #expect(t.promptAttachments == [up])
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
}


@Suite("Message attachments (the composer's list)")
@MainActor
struct MessageAttachmentsTests {
    static func upload(_ id: String, _ name: String) -> Attachment {
        Attachment(id: id, path: "/u/\(id)/\(name)", name: name, source: .upload, kind: PromptAttachments.kindByName(name), mimeType: "")
    }

    @Test func addDedupesByIdNotByName() {
        let m = MessageAttachments()
        #expect(m.add([Self.upload("a1", "shot.png"), Self.upload("a2", "notes.pdf"), Self.upload("a1", "shot.png")]) == 0)
        #expect(m.list.map(\.id) == ["a1", "a2"])
        // Same name, another upload: a second file.
        #expect(m.add([Self.upload("a3", "shot.png")]) == 0)
        #expect(m.count == 3)
    }

    @Test func addStopsAtTheLimitAndCountsWhatWasLeftOut() {
        let m = MessageAttachments()
        _ = m.add((0..<19).map { Self.upload("a\($0)", "\($0).png") })
        #expect(m.add([Self.upload("x", "x.png"), Self.upload("y", "y.png"), Self.upload("z", "z.png")]) == 2)
        #expect(m.count == maxPromptAttachments)
        #expect(m.list.last?.id == "x")
    }

    @Test func removeTakesOutOnlyThatIndexAndClearEmpties() {
        let m = MessageAttachments()
        _ = m.add([Self.upload("a", "a.png"), Self.upload("b", "b.png"), Self.upload("c", "c.png")])
        m.remove(at: 1)
        #expect(m.list.map(\.id) == ["a", "c"])
        m.remove(at: 7)
        #expect(m.count == 2)
        m.clear()
        #expect(m.isEmpty)
    }

    static func note(_ message: String) -> AttachmentAnnotation {
        AttachmentAnnotation(width: 10, height: 10, marks: [AnnotationMark(n: 1, x: 1, y: 1, message: message)])
    }

    /// The notes live on the attachment itself: annotating a waiting file edits it in place (it
    /// keeps its place and name), a spec image is added at the end as itself (its id and source),
    /// and removing or clearing takes the notes with the file.
    @Test func annotatingSetsTheNotesOnTheAttachmentItself() {
        let m = MessageAttachments()
        m.add([Self.upload("a", "a.png"), Self.upload("b", "b.png")])
        #expect(m.annotate(m.list[1], annotation: Self.note("b")))
        #expect(m.list.map(\.id) == ["a", "b"])
        #expect(m.list[1].annotation == Self.note("b"))
        #expect(m.list[1].name == "b.png")
        // Annotated again: replaced in place, not added twice.
        #expect(m.annotate(Self.upload("b", "b.png"), annotation: Self.note("again")))
        #expect(m.count == 2 && m.list[1].annotation == Self.note("again"))
        // A spec image comes in as itself, at the end.
        let spec = Attachment(id: "att_1", path: "/h/attachments/att_1.png", name: "Mock", source: .spec, kind: .image, mimeType: "image/png", width: 640, height: 480)
        #expect(m.annotate(spec, annotation: Self.note("spec")))
        var noted = spec
        noted.annotation = Self.note("spec")
        #expect(m.list.last == noted)
        // The body carries each file whole, with its notes.
        #expect(m.inputs.map(\.annotation) == [nil, Self.note("again"), Self.note("spec")])
        #expect(m.inputs.last == AttachmentInput(noted))
        // nil takes the notes off and leaves the file.
        m.annotate(Self.upload("b", "b.png"), annotation: nil)
        #expect(m.list[1].annotation == nil && m.count == 3)
        m.remove(at: 2)
        #expect(m.inputs.allSatisfy { $0.annotation == nil })
    }

    @Test func aFullListTakesNoNewAnnotatedImageButStillEditsOneInIt() {
        let m = MessageAttachments()
        m.add((0..<maxPromptAttachments).map { Self.upload("a\($0)", "\($0).png") })
        #expect(!m.annotate(Self.upload("new", "new.png"), annotation: Self.note("x")))
        #expect(m.count == maxPromptAttachments && m.list.allSatisfy { $0.annotation == nil })
        #expect(m.annotate(Self.upload("a3", "3.png"), annotation: Self.note("x")))
        #expect(m.list[3].annotation == Self.note("x"))
    }
}
