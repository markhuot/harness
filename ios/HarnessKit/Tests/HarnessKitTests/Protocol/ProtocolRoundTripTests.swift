import Foundation
import Testing
@testable import HarnessKit
import struct HarnessKit.Attachment

/// Drift guard for the Swift port of shared/src/protocol.ts. Fixtures/protocol.json holds
/// hand-written samples typed with the TS types (shared/fixtures/cases/protocol.ts); every sample
/// must decode into its Swift type and re-encode to the same JSON.
@Suite("protocol.ts round trip")
struct ProtocolRoundTripTests {
    typealias RoundTrip = @Sendable (Data) throws -> Data

    static func rt<T: Codable>(_: T.Type) -> RoundTrip {
        { data in try JSONEncoder().encode(try JSONDecoder().decode(T.self, from: data)) }
    }

    /// Export name in protocol.json → the Swift type its samples decode as.
    static let table: [String: RoundTrip] = [
        "Project": rt(Project.self),
        "Ticket": rt(Ticket.self),
        "TicketPage": rt(TicketPage.self),
        "PendingApproval": rt(PendingApproval.self),
        "ExternalRef": rt(ExternalRef.self),
        "RelatedTicket": rt(RelatedTicket.self),
        "ExternalRefInput": rt(ExternalRefInput.self),
        "PermissionDecisionLog": rt(PermissionDecisionLog.self),
        "Session": rt(Session.self),
        "Run": rt(Run.self),
        "ToolResultContent": rt(ToolResultContent.self),
        "TranscriptContent": rt(TranscriptContent.self),
        "TranscriptEntry": rt(TranscriptEntry.self),
        "Subagent": rt(Subagent.self),
        "TaskOutput": rt(TaskOutput.self),
        "Attachment": rt(Attachment.self),
        "AttachmentInput": rt(AttachmentInput.self),
        "AnnotationMark": rt(AnnotationMark.self),
        "AnnotationPage": rt(AnnotationPage.self),
        "AttachmentAnnotation": rt(AttachmentAnnotation.self),
        "BrowserScreenshot": rt(BrowserScreenshot.self),
        "BrowserElementQuery": rt(BrowserElementQuery.self),
        "BrowserElement": rt(BrowserElement.self),
        "ActivityMeta": rt(ActivityMeta.self),
        "ActivityEntry": rt(ActivityEntry.self),
        "SpecRevisionInfo": rt(SpecRevisionInfo.self),
        "SpecRevision": rt(SpecRevision.self),
        "SpecDiff": rt(SpecDiff.self),
        "SpecConflict": rt(SpecConflict.self),
        "WatcherLive": rt(WatcherLive.self),
        "Watcher": rt(Watcher.self),
        "DriverInfo": rt(DriverInfo.self),
        "ModelInfo": rt(ModelInfo.self),
        "DriverModels": rt(DriverModels.self),
        "ListenSetting": rt(ListenSetting.self),
        "Settings": rt(Settings.self),
        "PublicSettings": rt(PublicSettings.self),
        "SettingsPatch": rt(SettingsPatch.self),
        "PromptVariable": rt(PromptVariable.self),
        "PromptEntry": rt(PromptEntry.self),
        "BoundAddress": rt(BoundAddress.self),
        "NetworkStatus": rt(NetworkStatus.self),
        "PairingInfo": rt(PairingInfo.self),
        "ServiceStatus": rt(ServiceStatus.self),
        "Health": rt(Health.self),
        "BrowserState": rt(BrowserState.self),
        "BranchInfo": rt(BranchInfo.self),
        "FileGitState": rt(FileGitState.self),
        "FileView": rt(FileView.self),
        "FileDiff": rt(FileDiff.self),
        "FileSearchOptions": rt(FileSearchOptions.self),
        "FileMatch": rt(FileMatch.self),
        "CommandMatch": rt(CommandMatch.self),
        "TicketDetail": rt(TicketDetail.self),
        "RemoteKeyMatches": rt(RemoteKeyMatches.self),
        "ApiError": rt(ApiError.self),
        "PluginTab": rt(PluginTab.self),
        "PluginInfo": rt(PluginInfo.self),
        "PluginThemeFields": rt(PluginThemeFields.self),
        "PluginHostMessage": rt(PluginHostMessage.self),
        "PluginFrameMessage": rt(PluginFrameMessage.self),
        "HarnessEvent": rt(HarnessEvent.self),
        "BrowserInput": rt(BrowserInput.self),
        "ClientMessage": rt(ClientMessage.self),
        "ServerMessage": rt(ServerMessage.self),
        "CreateProjectBody": rt(CreateProjectBody.self),
        "UpdateProjectBody": rt(UpdateProjectBody.self),
        "CreateTicketBody": rt(CreateTicketBody.self),
        "UpdateTicketBody": rt(UpdateTicketBody.self),
        "SubmitTicketBody": rt(SubmitTicketBody.self),
        "HumanReviewBody": rt(HumanReviewBody.self),
        "MessageBody": rt(MessageBody.self),
        "ReopenBody": rt(ReopenBody.self),
        "ApprovalBody": rt(ApprovalBody.self),
        "CompleteBody": rt(CompleteBody.self),
        "WatcherBody": rt(WatcherBody.self),
        "InjectOutputBody": rt(InjectOutputBody.self),
        "NavigateBody": rt(NavigateBody.self),
        "OkResponse": rt(OkResponse.self),
        "DriverLoginResponse": rt(DriverLoginResponse.self),
        "RotateTokenResponse": rt(RotateTokenResponse.self),
    ]

    /// Exports that aren't sample lists; the tests below check them.
    static let special: Set<String> = ["enums", "discriminators", "forwardCompat", "BrowserSizeConstants"]

    /// The JSON of each sample in one export.
    static func samples(_ export: String) throws -> [Data] {
        let list = try Fixture.value("protocol", export, as: [JSONValue].self)
        return try list.map { try JSONEncoder().encode($0) }
    }

    static func compact(_ data: Data) -> String {
        let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        let pretty = object.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys, .fragmentsAllowed]) }
        return String(decoding: pretty ?? data, as: UTF8.self)
    }

    @Test func everyExportHasASwiftMapping() throws {
        let exports = Set(try Fixture.exports("protocol"))
        let unmapped = exports.subtracting(Self.table.keys).subtracting(Self.special)
        #expect(unmapped.isEmpty, "protocol.json exports with no Swift type in ProtocolRoundTripTests.table: \(unmapped.sorted())")
        let stale = Set(Self.table.keys).union(Self.special).subtracting(exports)
        #expect(stale.isEmpty, "table entries with no export in protocol.json: \(stale.sorted())")
    }

    @Test(arguments: Self.table.keys.sorted())
    func roundTrip(_ export: String) throws {
        let roundTrip = try #require(Self.table[export])
        let list = try Self.samples(export)
        #expect(!list.isEmpty, "\(export) has no samples")
        for (i, sample) in list.enumerated() {
            let reencoded: Data
            do {
                reencoded = try roundTrip(sample)
            } catch {
                Issue.record("\(export)[\(i)] failed to decode: \(error)\n\(Self.compact(sample))")
                continue
            }
            #expect(try jsonEqual(sample, reencoded), "\(export)[\(i)] changed in the round trip\n  in:  \(Self.compact(sample))\n  out: \(Self.compact(reencoded))")
        }
    }

    struct SizeConstants: Decodable {
        struct Side: Decodable {
            let width: Int
            let height: Int
        }
        let BROWSER_DESKTOP: Side
        let BROWSER_MOBILE: Side
        let BROWSER_MIN_SIDE: Int
        let BROWSER_MAX_SIDE: Int
    }

    @Test func browserSizeConstantsMatchTheTS() throws {
        let c = try Fixture.value("protocol", "BrowserSizeConstants", as: SizeConstants.self)
        #expect(BrowserSize.desktop == (c.BROWSER_DESKTOP.width, c.BROWSER_DESKTOP.height))
        #expect(BrowserSize.mobile == (c.BROWSER_MOBILE.width, c.BROWSER_MOBILE.height))
        #expect(BrowserSize.minSide == c.BROWSER_MIN_SIDE)
        #expect(BrowserSize.maxSide == c.BROWSER_MAX_SIDE)
    }

    // MARK: String unions

    struct EnumCheck: Sendable {
        let known: [String]
        let isKnown: @Sendable (String) -> Bool
        let roundTrips: @Sendable (String) throws -> Bool
    }

    static func en<E: OpenEnum>(_: E.Type) -> EnumCheck {
        EnumCheck(
            known: E.allKnown.map(\.rawValue),
            isKnown: { E(rawValue: $0).isKnown },
            roundTrips: { raw in
                let data = try JSONEncoder().encode(raw)
                return try JSONEncoder().encode(JSONDecoder().decode(E.self, from: data)) == data
            }
        )
    }

    static let enums: [String: EnumCheck] = [
        "PermissionMode": en(PermissionMode.self),
        "ClassifierBackend": en(ClassifierBackend.self),
        "PermissionDecision": en(PermissionDecision.self),
        "PermissionSource": en(PermissionSource.self),
        "TicketStatus": en(TicketStatus.self),
        "ReviewState": en(ReviewState.self),
        "TicketKind": en(TicketKind.self),
        "CompletionAction": en(CompletionAction.self),
        "SessionKind": en(SessionKind.self),
        "TriageStatus": en(TriageStatus.self),
        "RunKind": en(RunKind.self),
        "RunStatus": en(RunStatus.self),
        "TranscriptRole": en(TranscriptRole.self),
        "SubagentStatus": en(SubagentStatus.self),
        "SubagentKind": en(SubagentKind.self),
        "ActivityAuthor": en(ActivityAuthor.self),
        "ActivityKind": en(ActivityKind.self),
        "SpecRevisionAuthor": en(SpecRevisionAuthor.self),
        "AttachmentKind": en(AttachmentKind.self),
        "AttachmentSource": en(AttachmentSource.self),
        "WatcherMode": en(WatcherMode.self),
        "WatcherLiveState": en(WatcherLiveState.self),
        "PromptId": en(PromptId.self),
        "PromptGroup": en(PromptGroup.self),
        "ListenMode": en(ListenMode.self),
        "FileKind": en(FileKind.self),
        "HumanReviewDecision": en(HumanReviewDecision.self),
        "ApprovalDecision": en(ApprovalDecision.self),
        "TicketTabWhen": en(TicketTabWhen.self),
        "PluginSource": en(PluginSource.self),
        "Appearance": en(Appearance.self),
        "MouseAction": en(MouseAction.self),
        "MouseButton": en(MouseButton.self),
        "KeyAction": en(KeyAction.self),
        "BrowserDevice": en(BrowserDevice.self),
    ]

    @Test func everyStringUnionMatchesItsOpenEnum() throws {
        let fixture = try Fixture.value("protocol", "enums", as: [String: [String]].self)
        #expect(Set(fixture.keys) == Set(Self.enums.keys), "enums in protocol.json vs Swift: \(Set(fixture.keys).symmetricDifference(Self.enums.keys).sorted())")
        for (name, values) in fixture {
            guard let check = Self.enums[name] else { continue }
            #expect(check.known == values, "\(name): Swift allKnown \(check.known) != TS \(values)")
            for value in values {
                #expect(check.isKnown(value), "\(name): \"\(value)\" decodes as unknown")
                #expect(try check.roundTrips(value), "\(name): \"\(value)\" doesn't round-trip")
            }
            #expect(!check.isKnown("not-a-\(name)"), "\(name) accepted a made-up value")
            #expect(try check.roundTrips("not-a-\(name)"), "\(name) lost an unknown value")
        }
    }

    // MARK: Discriminated unions

    /// Decodes a sample and returns its discriminator, or nil when it decoded as `.unknown`.
    typealias Discriminate = @Sendable (Data) throws -> String?

    static func disc<T: Decodable>(_: T.Type, _ known: @escaping @Sendable (T) -> String?) -> Discriminate {
        { data in known(try JSONDecoder().decode(T.self, from: data)) }
    }

    static let unions: [String: Discriminate] = [
        "HarnessEvent": disc(HarnessEvent.self) { if case .unknown = $0 { nil } else { $0.kind } },
        "TranscriptContent": disc(TranscriptContent.self) { if case .unknown = $0 { nil } else { $0.type } },
        "ToolResultContent": disc(ToolResultContent.self) { if case .unknown = $0 { nil } else { $0.type } },
        "ClientMessage": disc(ClientMessage.self) { if case .unknown = $0 { nil } else { $0.type } },
        "ServerMessage": disc(ServerMessage.self) { if case .unknown = $0 { nil } else { $0.type } },
        "BrowserInput": disc(BrowserInput.self) { if case .unknown = $0 { nil } else { $0.type } },
        "PluginHostMessage": disc(PluginHostMessage.self) { if case .unknown = $0 { nil } else { $0.type } },
        "PluginFrameMessage": disc(PluginFrameMessage.self) { if case .unknown = $0 { nil } else { $0.type } },
    ]

    /// Each union's samples cover every discriminator TS declares, and Swift knows each one.
    @Test func everyDiscriminatorIsSampledAndKnown() throws {
        let fixture = try Fixture.value("protocol", "discriminators", as: [String: [String]].self)
        #expect(Set(fixture.keys) == Set(Self.unions.keys))
        for (name, expected) in fixture {
            guard let discriminate = Self.unions[name] else { continue }
            let seen = try Self.samples(name).compactMap(discriminate)
            #expect(Set(seen) == Set(expected), "\(name): samples decode to \(Set(seen).sorted()), TS declares \(expected.sorted())")
        }
        #expect(fixture["HarnessEvent"] == HarnessEvent.knownKinds)
        #expect(HarnessEvent.knownKinds.count == 18)
    }

    // MARK: Forward compatibility

    /// Per type: does the decoded value carry something this build doesn't know?
    static let unknownCheck: [String: @Sendable (Data) throws -> Bool] = [
        "HarnessEvent": { if case .unknown = try JSONDecoder().decode(HarnessEvent.self, from: $0) { true } else { false } },
        "ServerMessage": {
            switch try JSONDecoder().decode(ServerMessage.self, from: $0) {
            case .unknown, .event(.unknown): true
            default: false
            }
        },
        "ClientMessage": { if case .unknown = try JSONDecoder().decode(ClientMessage.self, from: $0) { true } else { false } },
        "TranscriptContent": {
            switch try JSONDecoder().decode(TranscriptContent.self, from: $0) {
            case .unknown: true
            case let .toolResult(_, _, output, _): output.contains { if case .unknown = $0 { true } else { false } }
            default: false
            }
        },
        "ToolResultContent": { if case .unknown = try JSONDecoder().decode(ToolResultContent.self, from: $0) { true } else { false } },
        "BrowserInput": { if case .unknown = try JSONDecoder().decode(BrowserInput.self, from: $0) { true } else { false } },
        "PluginHostMessage": { if case .unknown = try JSONDecoder().decode(PluginHostMessage.self, from: $0) { true } else { false } },
        "PluginFrameMessage": { if case .unknown = try JSONDecoder().decode(PluginFrameMessage.self, from: $0) { true } else { false } },
        "Ticket": {
            let t = try JSONDecoder().decode(Ticket.self, from: $0)
            return !t.status.isKnown && !t.kind.isKnown && !t.agentReview.isKnown && !t.humanReview.isKnown
                && !(t.permissionMode?.isKnown ?? true) && !(t.completionAction.optional?.isKnown ?? true)
        },
        "Run": {
            let r = try JSONDecoder().decode(Run.self, from: $0)
            return !r.kind.isKnown && !r.status.isKnown
        },
        "ActivityEntry": {
            let e = try JSONDecoder().decode(ActivityEntry.self, from: $0)
            return !e.kind.isKnown && !e.author.isKnown
        },
        "TranscriptEntry": { !(try JSONDecoder().decode(TranscriptEntry.self, from: $0)).role.isKnown },
        "PublicSettings": {
            let s = try JSONDecoder().decode(PublicSettings.self, from: $0)
            return !s.permissionMode.isKnown && !s.classifier.isKnown && !(s.listen?.mode.isKnown ?? true)
        },
    ]

    struct ForwardCompat: Decodable {
        let type: String
        let samples: [JSONValue]
    }

    @Test func newerPayloadsDecodeAsUnknownAndRoundTrip() throws {
        let entries = try Fixture.value("protocol", "forwardCompat", as: [ForwardCompat].self)
        #expect(!entries.isEmpty)
        for entry in entries {
            let roundTrip = try #require(Self.table[entry.type], "forwardCompat type \(entry.type) has no Swift mapping")
            let isUnknown = try #require(Self.unknownCheck[entry.type], "forwardCompat type \(entry.type) has no unknown check")
            for (i, value) in entry.samples.enumerated() {
                let sample = try JSONEncoder().encode(value)
                #expect(try isUnknown(sample), "\(entry.type) forwardCompat[\(i)] decoded without an unknown value")
                #expect(try jsonEqual(sample, roundTrip(sample)), "\(entry.type) forwardCompat[\(i)] changed in the round trip")
            }
        }
    }
}

@Suite("Activity meta detail")
struct ActivityMetaDetailTests {
    func decode(_ json: String) throws -> ActivityMeta {
        try JSONDecoder().decode(ActivityMeta.self, from: Data(json.utf8))
    }

    @Test func decodesTheFullTextWhenPresent() throws {
        let m = try decode(#"{"round":2,"by":"agent","detail":"All the notes"}"#)
        #expect(m.detail == "All the notes")
        #expect(m.round == 2)
        #expect(try jsonEqual(Data(#"{"round":2,"by":"agent","detail":"All the notes"}"#.utf8), JSONEncoder().encode(m)))
    }

    /// Entries from older services carry no detail, and must still decode and re-encode without one.
    @Test func olderEntriesWithoutItStillDecode() throws {
        let m = try decode(#"{"round":1,"commit":null}"#)
        #expect(m.detail == nil)
        #expect(try jsonEqual(Data(#"{"round":1,"commit":null}"#.utf8), JSONEncoder().encode(m)))
    }
}
