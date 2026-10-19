import Foundation
import Testing
import HarnessKit

@Suite struct AttachmentsLogicTests {
    @Test func toolOutputMediaKeepsImagesInOrderPointingBackPastText() {
        let media = Attachments.toolOutputMedia(callId: "call-1", tool: "screenshot", output: [
            .text(text: "before"), .image(data: "AAAA", mimeType: "image/png"), .text(text: "between"), .image(data: "BBBB", mimeType: "image/jpeg"),
        ])
        #expect(media.map(\.at) == [1, 3])
        #expect(media.map(\.url) == ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"])
    }

    @Test func toolOutputMediaNumbersNamesOnlyWhenThereAreSeveral() {
        let one = Attachments.toolOutputMedia(callId: "call-1", tool: "screenshot", output: [.image(data: "AAAA", mimeType: "image/png")])
        #expect(one.map(\.attachment.name) == ["screenshot output"])
        let two = Attachments.toolOutputMedia(callId: "call-1", tool: "screenshot", output: [.image(data: "AAAA", mimeType: "image/png"), .image(data: "BBBB", mimeType: "image/png")])
        #expect(two.map(\.attachment.name) == ["screenshot output 1", "screenshot output 2"])
        #expect(Set((one + two).map(\.attachment.id)).count == 2, "the same call and block share an id")
    }

    @Test func toolOutputMediaOpensVideoAsVideoAndSkipsTextOnlyResults() {
        #expect(Attachments.toolOutputMedia(callId: "c", tool: "record", output: [.image(data: "AAAA", mimeType: "video/mp4")]).first?.attachment.kind == .video)
        #expect(Attachments.toolOutputMedia(callId: "c", tool: "Read", output: [.text(text: "class HarnessSocket {}")]).isEmpty)
    }
}
