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

    /// Every kind TS declares decodes to its own case and encodes back to the same JSON.
    @Test(arguments: [
        #"{"kind":"attachment","id":"att_1","name":"shot.png"}"#,
        #"{"kind":"prompt-attachment","index":2,"name":"Pasted image.png"}"#,
        #"{"kind":"message-attachment","entryId":"ent_5","index":0,"name":"a.png"}"#,
        #"{"kind":"browser","url":"http://localhost:3000/","title":"Home","tabId":3,"viewport":{"width":1280,"height":800},"scale":2}"#,
    ])
    func sourceKindsRoundTrip(_ text: String) throws {
        let source = try decode(AnnotationSource.self, text)
        if case let .object(o) = try json(text) { #expect(source.kind == o["kind"]?.stringValue) }
        if case .unknown = source { Issue.record("known kind decoded as unknown: \(text)") }
        #expect(try encoded(source) == json(text))
    }

    /// A newer service's kind doesn't fail the message: it's kept and sent back as it came.
    @Test func anUnknownSourceKindIsKeptRaw() throws {
        let text = #"{"kind":"canvas","id":"c1","extra":[1,2]}"#
        let source = try decode(AnnotationSource.self, text)
        #expect(source == .unknown(kind: "canvas", raw: try json(text)))
        #expect(try encoded(source) == json(text))
    }

    @Test func aMarkWithoutATailOmitsTheTailKeys() throws {
        let mark = AnnotationMark(n: 1, x: 10, y: 20, message: "here")
        #expect(try encoded(mark) == json(#"{"n":1,"x":10,"y":20,"message":"here"}"#))
        #expect(try decode(AnnotationMark.self, #"{"n":2,"x":1,"y":2,"tailX":3,"tailY":4,"message":""}"#).tailY == 4)
    }

    @Test func transcriptTextKeepsItsAnnotations() throws {
        let text = #"{"type":"text","text":"","attachments":[{"path":"/u/a.png","name":"a.png","source":"upload"}],"annotations":[{"attachment":0,"source":{"kind":"attachment","id":"att_1","name":"a.png"},"width":800,"height":600,"marks":[{"n":1,"x":1,"y":2,"message":"m"}]}]}"#
        let c = try decode(TranscriptContent.self, text)
        guard case let .text(_, attachments, annotations) = c else {
            Issue.record("not text: \(c)")
            return
        }
        #expect(attachments?.count == 1)
        #expect(annotations?.first?.marks.first?.message == "m")
        #expect(annotations?.first?.source == .attachment(id: "att_1", name: "a.png"))
        #expect(try encoded(c) == json(text))
        // Without annotations, no key.
        #expect(try encoded(TranscriptContent.text(text: "hi")) == json(#"{"type":"text","text":"hi"}"#))
    }

    @Test func runAnnotationsAreOptional() throws {
        let bare = #"{"id":"r","sessionId":"s","kind":"chat","status":"queued","driver":"dummy","prompt":"","error":null,"createdAt":1,"startedAt":null,"endedAt":null}"#
        #expect(try decode(Run.self, bare).annotations == nil)
        let with = bare.replacingOccurrences(of: #""prompt":"""#, with: #""prompt":"","annotations":[{"attachment":0,"source":{"kind":"prompt-attachment","index":0,"name":"a.png"},"width":2,"height":2,"marks":[]}]"#)
        #expect(try decode(Run.self, with).annotations?.first?.source == .promptAttachment(index: 0, name: "a.png"))
    }

    @Test func aMalformedScreenshotFails() {
        #expect(throws: (any Error).self) {
            try decode(BrowserScreenshot.self, #"{"data":"","width":1,"height":1,"scale":1,"tabId":1,"url":"","title":""}"#)
        }
    }
}
