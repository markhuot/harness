import Foundation
import Testing
@testable import HarnessKit
import struct HarnessKit.Attachment

@Suite("Message attachments on the wire")
struct MessageAttachmentsProtocolTests {
    private func decode<T: Decodable>(_ type: T.Type, _ s: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(s.utf8))
    }

    private func encoded(_ v: some Encodable) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(v))
    }

    /// An older service (and every agent message) sends text without `attachments`.
    @Test func textWithoutAttachmentsDecodesAsNilAndEncodesWithoutTheKey() throws {
        let c = try decode(TranscriptContent.self, #"{"type":"text","text":"hi"}"#)
        #expect(c == .text(text: "hi", attachments: nil))
        #expect(try encoded(c) == JSONValue.object(["type": .string("text"), "text": .string("hi")]))
    }

    @Test func textWithAttachmentsKeepsThemInOrder() throws {
        let c = try decode(TranscriptContent.self, #"{"type":"text","text":"","attachments":[{"id":"a1","path":"/u/a.png","name":"a.png","source":"upload","kind":"image","mimeType":"image/png"},{"id":"att_1","path":"/h/att_1.png","name":"Mock","source":"spec","kind":"image","mimeType":"image/png","width":4,"height":3},{"id":"a2","path":"/x/notes.pdf","name":"Notes","source":"file","kind":"file","mimeType":""}]}"#)
        guard case let .text(text, attachments) = c else {
            Issue.record("not text: \(c)")
            return
        }
        #expect(text == "")
        #expect(attachments == [
            Attachment(id: "a1", path: "/u/a.png", name: "a.png", source: .upload, kind: .image, mimeType: "image/png"),
            Attachment(id: "att_1", path: "/h/att_1.png", name: "Mock", source: .spec, kind: .image, mimeType: "image/png", width: 4, height: 3),
            Attachment(id: "a2", path: "/x/notes.pdf", name: "Notes", source: .file, kind: .file, mimeType: ""),
        ])
        // and back out unchanged
        #expect(try decode(TranscriptContent.self, String(decoding: JSONEncoder().encode(c), as: UTF8.self)) == c)
    }

    @Test func aBadAttachmentFailsTheEntryRatherThanDroppingIt() {
        #expect(throws: (any Error).self) {
            try decode(TranscriptContent.self, #"{"type":"text","text":"x","attachments":[{"name":"no path"}]}"#)
        }
    }

    @Test func runAttachmentsAreOptional() throws {
        let bare = #"{"id":"r","sessionId":"s","kind":"chat","status":"queued","driver":"dummy","prompt":"","error":null,"createdAt":1,"startedAt":null,"endedAt":null}"#
        #expect(try decode(Run.self, bare).attachments == nil)
        let with = bare.replacingOccurrences(of: #""prompt":"""#, with: #""prompt":"","attachments":[{"id":"a1","path":"/u/a.png","name":"a.png","source":"upload","kind":"image","mimeType":"image/png"}]"#)
        #expect(try decode(Run.self, with).attachments?.map(\.id) == ["a1"])
    }
}
