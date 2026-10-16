import Foundation
import Testing
import HarnessKit

private func json(_ body: some Encodable) throws -> [String: Any] {
    let data = try JSONEncoder().encode(body)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// The service treats an absent field as "leave it" and a null as "clear it", so a nil that
/// encoded as null would wipe what the person never touched.
@Suite struct RequestBodyTests {
    @Test func aCompleteWithNothingSetSendsAnEmptyObject() throws {
        #expect(try json(CompleteBody()).isEmpty)
    }

    @Test func aCompleteSendsOnlyWhatWasSet() throws {
        let sent = try json(CompleteBody(instructions: "merge into main", skipAgent: true))
        #expect(Set(sent.keys) == ["instructions", "skipAgent"])
        #expect(sent["skipAgent"] as? Bool == true)
    }

    @Test func aMessageWithoutAttachmentsOmitsTheKey() throws {
        #expect(Set(try json(MessageBody(text: "hi")).keys) == ["text"])
    }

    @Test func aHumanReviewWithoutNotesOrInstructionsSendsOnlyTheDecision() throws {
        let sent = try json(HumanReviewBody(decision: .approve))
        #expect(Set(sent.keys) == ["decision"])
        #expect(sent["decision"] as? String == "approve")
    }
}
