import Foundation
import Testing
@testable import HarnessKit

@Suite("Annotations on the wire")
struct AnnotationsProtocolTests {
    private func decode<T: Decodable>(_ type: T.Type, _ s: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(s.utf8))
    }

    private func encoded(_ v: some Encodable) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(v))
    }

    @Test func aMarkWithoutATailOmitsTheTailKeys() throws {
        let mark = AnnotationMark(n: 1, x: 10, y: 20, message: "here")
        #expect(try encoded(mark) == json(#"{"n":1,"x":10,"y":20,"message":"here"}"#))
        #expect(try decode(AnnotationMark.self, #"{"n":2,"x":1,"y":2,"tailX":3,"tailY":4,"message":""}"#).tailY == 4)
    }

    /// An annotation rides on its attachment, wherever the attachment goes: a transcript message's
    /// list keeps it, page and all, and sends it back unchanged.
    @Test func transcriptAttachmentsKeepTheirAnnotation() throws {
        let text = #"{"type":"text","text":"","attachments":[{"path":"/u/a.png","name":"a.png","source":"upload","annotation":{"width":800,"height":600,"marks":[{"n":1,"x":1,"y":2,"tailX":5,"tailY":6,"message":"m"}],"page":{"url":"http://localhost:3000/","title":"Home","tabId":3,"viewport":{"width":400,"height":300},"scale":2}}},{"path":"/u/b.pdf","name":"b.pdf","source":"file"}]}"#
        let c = try decode(TranscriptContent.self, text)
        guard case let .text(_, attachments) = c else {
            Issue.record("not text: \(c)")
            return
        }
        #expect(attachments?.first?.annotation?.marks.first?.tailY == 6)
        #expect(attachments?.first?.annotation?.page?.viewport == AnnotationViewport(width: 400, height: 300))
        #expect(attachments?.last?.annotation == nil)
        #expect(try encoded(c) == json(text))
    }

    /// Without notes, an attachment (and its input) has no `annotation` key at all, and a message
    /// body sends each input's notes with it.
    @Test func anAttachmentWithoutNotesHasNoAnnotationKey() throws {
        #expect(try encoded(PromptAttachment(path: "/a.png", name: "a.png")) == json(#"{"path":"/a.png","name":"a.png","source":"file"}"#))
        #expect(try encoded(PromptAttachmentInput(path: "attachment:att_1")) == json(#"{"path":"attachment:att_1"}"#))
        let noted = AttachmentAnnotation(width: 2, height: 2, marks: [AnnotationMark(n: 1, x: 1, y: 1, message: "x")])
        let body = MessageBody(text: "why", attachments: [PromptAttachmentInput(path: "attachment:att_1", name: "a.png", annotation: noted)])
        #expect(try encoded(body) == json(#"{"text":"why","attachments":[{"path":"attachment:att_1","name":"a.png","annotation":{"width":2,"height":2,"marks":[{"n":1,"x":1,"y":1,"message":"x"}]}}]}"#))
    }

    @Test func aMalformedScreenshotFails() {
        #expect(throws: (any Error).self) {
            try decode(BrowserScreenshot.self, #"{"data":"","width":1,"height":1,"scale":1,"tabId":1,"url":"","title":""}"#)
        }
    }
}
