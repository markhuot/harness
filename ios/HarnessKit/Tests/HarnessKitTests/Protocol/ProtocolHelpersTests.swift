import Foundation
import Testing
@testable import HarnessKit

struct ProtocolConstants: Decodable, Sendable {
    let DEFAULT_PORT: Int
    let PERMISSION_MODES: [String]
    let CLASSIFIER_BACKENDS: [String]
    let TICKET_STATUSES: [String]
    let COMPLETION_ACTIONS: [String]
    let PROMPT_IDS: [String]
    let RENAMED_PROMPT_IDS: [String: String]
    let LISTEN_MODES: [String]
}

struct ConductorInput: Decodable, Sendable {
    let kind: TicketKind
    let childCount: Int?
}

@Suite("protocol.ts helpers parity")
struct ProtocolHelpersTests {
    @Test func constantsMatch() throws {
        let ts = try Fixture.value("protocolHelpers", "constants", as: ProtocolConstants.self)
        #expect(HarnessProtocol.defaultPort == ts.DEFAULT_PORT)
        #expect(HarnessProtocol.permissionModes.map(\.rawValue) == ts.PERMISSION_MODES)
        #expect(HarnessProtocol.classifierBackends.map(\.rawValue) == ts.CLASSIFIER_BACKENDS)
        #expect(HarnessProtocol.ticketStatuses.map(\.rawValue) == ts.TICKET_STATUSES)
        #expect(HarnessProtocol.completionActions.map(\.rawValue) == ts.COMPLETION_ACTIONS)
        #expect(HarnessProtocol.promptIds.map(\.rawValue) == ts.PROMPT_IDS)
        #expect(HarnessProtocol.renamedPromptIds.mapValues(\.rawValue) == ts.RENAMED_PROMPT_IDS)
        #expect(HarnessProtocol.listenModes.map(\.rawValue) == ts.LISTEN_MODES)
    }

    @Test(arguments: Fixture.cases("protocolHelpers", "reviewPassedCases", input: ReviewState.self, output: Bool.self))
    func reviewPassed(_ c: Fixture.Case<ReviewState, Bool>) {
        #expect(HarnessProtocol.reviewPassed(c.input) == c.output)
        #expect(c.input.passed == c.output)
    }

    @Test func unknownReviewStateHasNotPassed() {
        #expect(!HarnessProtocol.reviewPassed(.unknown("escalated")))
    }

    @Test(arguments: Fixture.cases("protocolHelpers", "isConductorCases", input: ConductorInput.self, output: Bool.self))
    func isConductor(_ c: Fixture.Case<ConductorInput, Bool>) {
        #expect(HarnessProtocol.isConductor(kind: c.input.kind, childCount: c.input.childCount) == c.output)
    }
}
