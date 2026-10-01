import Foundation
import Testing
@testable import HarnessKit

/// The encoding rules request bodies rely on, checked from Swift-built values (the round-trip
/// test only sees what decoding produced).
@Suite("Patch, Nullable and OpenEnum encoding")
struct PatchAndOpenEnumTests {
    func json<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    @Test func absentPatchFieldsAreOmitted() throws {
        #expect(try json(UpdateTicketBody()) == "{}")
        #expect(try json(SettingsPatch()) == "{}")
    }

    @Test func nullPatchIsSentAsNull() throws {
        #expect(try json(UpdateTicketBody(model: .null, externalRef: .null)) == #"{"externalRef":null,"model":null}"#)
        #expect(try json(SettingsPatch(anthropicApiKey: .null)) == #"{"anthropicApiKey":null}"#)
    }

    @Test func valuePatchIsSent() throws {
        let body = UpdateTicketBody(baseBranch: .value("main"), externalRef: .value(ExternalRefInput(key: "FOO-1", url: .null)))
        #expect(try json(body) == #"{"baseBranch":"main","externalRef":{"key":"FOO-1","url":null}}"#)
    }

    @Test func patchInitFromOptional() {
        #expect(Patch<String>(nil) == .null)
        #expect(Patch("x") == .value("x"))
        #expect(Patch<String>.absent.optional == nil)
        #expect(Patch<String>.null.optional == nil)
        #expect(!Patch<String>.absent.isPresent)
        #expect(Patch<String>.null.isPresent)
    }

    @Test func decodingTellsAbsentFromNull() throws {
        let absent = try JSONDecoder().decode(UpdateTicketBody.self, from: Data("{}".utf8))
        let null = try JSONDecoder().decode(UpdateTicketBody.self, from: Data(#"{"model":null}"#.utf8))
        let value = try JSONDecoder().decode(UpdateTicketBody.self, from: Data(#"{"model":"opus"}"#.utf8))
        #expect(absent.model == .absent)
        #expect(null.model == .null)
        #expect(value.model == .value("opus"))
    }

    @Test func nilMapValuesAreSentAsNull() throws {
        let patch = SettingsPatch(defaultModels: ["claude-code": nil], prompts: [PromptId.systemIntro.rawValue: nil])
        #expect(try json(patch) == #"{"defaultModels":{"claude-code":null},"prompts":{"system.intro":null}}"#)
    }

    @Test func nullableFieldsAlwaysEncode() throws {
        let run = Run(id: "r", sessionId: "s", kind: .work, status: .queued, driver: "d", prompt: "p", createdAt: 1)
        let text = try json(run)
        #expect(text.contains(#""error":null"#))
        #expect(text.contains(#""startedAt":null"#))
        #expect(text.contains(#""endedAt":null"#))
    }

    @Test func nullableFieldMissingFromAnOlderServiceDecodesAsNil() throws {
        let body = #"{"build":"abc","stale":false}"#
        #expect(try JSONDecoder().decode(ServiceStatus.self, from: Data(body.utf8)).build == "abc")
        let missing = #"{"stale":true}"#
        #expect(try JSONDecoder().decode(ServiceStatus.self, from: Data(missing.utf8)).build == nil)
    }

    @Test func openEnumKeepsUnknownValues() throws {
        let decoded = try JSONDecoder().decode(TicketStatus.self, from: Data(#""archived""#.utf8))
        #expect(decoded == .unknown("archived"))
        #expect(!decoded.isKnown)
        #expect(try json(decoded) == #""archived""#)
        #expect(TicketStatus(rawValue: "in_progress") == .inProgress)
        #expect(PromptId(rawValue: "system.complete_pr") == .systemCompletePr)
    }

    @Test func discriminatedUnionNeedsItsDiscriminator() {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(HarnessEvent.self, from: Data(#"{"id":"x"}"#.utf8))
        }
    }

    @Test func knownEventWithBadPayloadThrowsRatherThanBecomingUnknown() {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(HarnessEvent.self, from: Data(#"{"kind":"ticket.deleted"}"#.utf8))
        }
    }

    @Test func timestampsConvertToDates() {
        let date = Date(harnessMillis: 1_759_190_400_000)
        #expect(date.timeIntervalSince1970 == 1_759_190_400)
        #expect(date.harnessMillis == 1_759_190_400_000)
    }
}
