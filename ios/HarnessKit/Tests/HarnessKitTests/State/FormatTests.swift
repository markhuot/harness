import Foundation
import Testing
@testable import HarnessKit

struct DriverLabelInput: Decodable, Sendable {
    let id: String
    let drivers: [DriverInfo]?
}

struct TimeInput: Decodable, Sendable {
    let ts: Double?
    let now: Double
}

struct MoveSwitchInput: Decodable, Sendable {
    let status: TicketStatus
    let pendingApproval: PendingApproval?
}

struct ComposerHintInput: Decodable, Sendable {
    let busy: Bool
    let status: TicketStatus
    let move: Bool?
}

struct ToolInput: Decodable, Sendable {
    let toolName: String
    let input: JSONValue?
}

struct ApprovalToastInput: Decodable, Sendable {
    let decision: ApprovalDecision
    let tool: String
    let ticketKey: String
}

struct PermissionVerbInput: Decodable, Sendable {
    let decision: PermissionDecision
    let source: PermissionSource
}

struct DecisionSourceInput: Decodable, Sendable {
    let source: PermissionSource
    let backend: String?
    let latencyMs: Double?
}

struct TranscriptItemSummary: Decodable, Sendable, Equatable {
    let kind: String
    let id: String?
    let call: String?
    let result: String?

    init(_ item: Format.TranscriptItem) {
        switch item {
        case let .entry(e): (kind, id, call, result) = ("entry", e.id, nil, nil)
        case let .tool(c, r): (kind, id, call, result) = ("tool", nil, c.id, r?.id)
        }
    }
}

struct ToolPreviewInput: Decodable, Sendable {
    let name: String
    let input: JSONValue?
}

struct KeyOrderInput: Decodable, Sendable {
    let fn: String
    let name: String
    let input: JSONValue
}

struct KeyOrderOutput: Decodable, Sendable {
    let ts: String?
    let sortedKeys: String?
}

struct FormatJsonInput: Decodable, Sendable {
    let text: String
    let max: Int?
}

struct FitRectInput: Decodable, Sendable {
    let boxW: Double
    let boxH: Double
    let w: Double
    let h: Double
}

struct PagePointInput: Decodable, Sendable {
    let local: Format.Point
    let drawn: Format.Rect
    let page: Format.Size
}

/// A `[TicketStatus: V]` table against the TS `Record<TicketStatus, V>` export: same entries, and
/// every known status covered.
private func expectStatusTable<V: Equatable & Decodable>(_ swift: [TicketStatus: V], _ export: String) throws {
    let ts = try Fixture.value("stateFormat", export, as: [String: V].self)
    #expect(Dictionary(uniqueKeysWithValues: swift.map { ($0.key.rawValue, $0.value) }) == ts)
    #expect(Set(swift.keys) == Set(TicketStatus.allKnown))
}

@Suite("state/format.ts parity")
struct FormatTests {
    @Test func statusTables() throws {
        try expectStatusTable(Format.statusLabel, "statusLabel")
        try expectStatusTable(Format.columnEmptyText, "columnEmptyText")
        try expectStatusTable(Format.composerPlaceholder, "composerPlaceholder")
    }

    @Test func classifierAndTriageLabels() throws {
        let classifier = try Fixture.value("stateFormat", "classifierLabels", as: [String: String].self)
        #expect(Dictionary(uniqueKeysWithValues: Format.classifierLabels.map { ($0.key.rawValue, $0.value) }) == classifier)
        #expect(Set(Format.classifierLabels.keys) == Set(ClassifierBackend.allKnown))
        let triage = try Fixture.value("stateFormat", "triageLabel", as: [String: Format.TriageLabel].self)
        #expect(Dictionary(uniqueKeysWithValues: Format.triageLabel.map { ($0.key.rawValue, $0.value) }) == triage)
        #expect(Set(Format.triageLabel.keys) == Set(TriageStatus.allKnown))
    }

    @Test(arguments: Fixture.cases("stateFormat", "driverLabelCases", input: DriverLabelInput.self, output: String.self))
    func driverLabel(_ c: Fixture.Case<DriverLabelInput, String>) {
        #expect(Format.driverLabel(c.input.id, drivers: c.input.drivers) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "driverIconCases", input: String.self, output: Format.DriverIcon.self))
    func driverIcon(_ c: Fixture.Case<String, Format.DriverIcon>) {
        #expect(Format.driverIcon(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "relativeTimeCases", input: TimeInput.self, output: String.self))
    func relativeTime(_ c: Fixture.Case<TimeInput, String>) {
        #expect(Format.relativeTime(c.input.ts, now: c.input.now) == c.output)
    }

    /// Past 30 days TS prints toLocaleDateString (locale-dependent), so this only pins the branch:
    /// a date, not one of the relative strings, and different for different days.
    @Test func relativeTimeOlderThanAMonthIsADate() {
        let now = 1_800_000_000_000.0
        let day = 86_400_000.0
        let a = Format.relativeTime(now - 29.5 * day, now: now)
        let b = Format.relativeTime(now - 400 * day, now: now)
        for s in [a, b] {
            #expect(!s.hasSuffix("ago") && s != "never" && s != "just now" && !s.isEmpty)
            let hasDigit = s.contains { $0.isNumber }
            #expect(hasDigit)
        }
        #expect(a != b)
        #expect(Format.relativeTime(now - 29 * day, now: now) == "29d ago")
    }

    @Test(arguments: Fixture.cases("stateFormat", "tildifyCases", input: String.self, output: String.self))
    func tildify(_ c: Fixture.Case<String, String>) {
        #expect(Format.tildify(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "moveSwitchLabelCases", input: MoveSwitchInput.self, output: String?.self))
    func moveSwitchLabel(_ c: Fixture.Case<MoveSwitchInput, String?>) {
        #expect(Format.moveSwitchLabel(status: c.input.status, hasPendingApproval: c.input.pendingApproval != nil) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "composerHintCases", input: ComposerHintInput.self, output: String.self))
    func composerHint(_ c: Fixture.Case<ComposerHintInput, String>) {
        let hint = c.input.move.map { Format.composerHint(busy: c.input.busy, status: c.input.status, move: $0) }
            ?? Format.composerHint(busy: c.input.busy, status: c.input.status)
        #expect(hint == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "newSessionPlaceholderCases", input: TicketKind.self, output: String.self))
    func newSessionPlaceholder(_ c: Fixture.Case<TicketKind, String>) {
        #expect(Format.newSessionPlaceholder(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "shortToolNameCases", input: String.self, output: String.self))
    func shortToolName(_ c: Fixture.Case<String, String>) {
        #expect(Format.shortToolName(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "describeApprovalInputCases", input: ToolInput.self, output: Format.ApprovalInput.self))
    func describeApprovalInput(_ c: Fixture.Case<ToolInput, Format.ApprovalInput>) {
        #expect(Format.describeApprovalInput(c.input.toolName, input: c.input.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "approvalToastCases", input: ApprovalToastInput.self, output: String.self))
    func approvalToast(_ c: Fixture.Case<ApprovalToastInput, String>) {
        #expect(Format.approvalToast(c.input.decision, tool: c.input.tool, ticketKey: c.input.ticketKey) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "permissionVerbCases", input: PermissionVerbInput.self, output: String.self))
    func permissionVerb(_ c: Fixture.Case<PermissionVerbInput, String>) {
        #expect(Format.permissionVerb(decision: c.input.decision, source: c.input.source) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "decisionSourceCases", input: DecisionSourceInput.self, output: String.self))
    func decisionSource(_ c: Fixture.Case<DecisionSourceInput, String>) {
        #expect(Format.decisionSource(source: c.input.source, backend: c.input.backend, latencyMs: c.input.latencyMs) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "permissionModeLabelCases", input: PermissionMode.self, output: String.self))
    func permissionModeLabel(_ c: Fixture.Case<PermissionMode, String>) {
        #expect(Format.permissionModeLabel(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "groupTranscriptCases", input: [TranscriptEntry].self, output: [TranscriptItemSummary].self))
    func groupTranscript(_ c: Fixture.Case<[TranscriptEntry], [TranscriptItemSummary]>) {
        #expect(Format.groupTranscript(c.input).map(TranscriptItemSummary.init) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "toolPreviewCases", input: ToolPreviewInput.self, output: String.self))
    func toolPreview(_ c: Fixture.Case<ToolPreviewInput, String>) {
        #expect(Format.toolPreview(c.input.name, input: c.input.input) == c.output)
    }

    /// The documented deviation: objects print with sorted keys. Each case differs in TS (so the
    /// deviation is real) and Swift must match what TS prints for the key-sorted input.
    @Test(arguments: Fixture.cases("stateFormat", "keyOrderDeviationCases", input: KeyOrderInput.self, output: KeyOrderOutput.self))
    func keyOrderDeviation(_ c: Fixture.Case<KeyOrderInput, KeyOrderOutput>) {
        #expect(c.output.ts != c.output.sortedKeys)
        let swift = c.input.fn == "toolPreview"
            ? Format.toolPreview(c.input.name, input: c.input.input)
            : Format.describeApprovalInput(c.input.name, input: c.input.input).primary?.value
        #expect(swift == c.output.sortedKeys)
    }

    @Test(arguments: Fixture.cases("stateFormat", "toolIconCases", input: String.self, output: Format.ToolIcon.self))
    func toolIcon(_ c: Fixture.Case<String, Format.ToolIcon>) {
        #expect(Format.toolIcon(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "formatMaybeJsonCases", input: FormatJsonInput.self, output: String.self))
    func formatMaybeJson(_ c: Fixture.Case<FormatJsonInput, String>) {
        let out = c.input.max.map { Format.formatMaybeJson(c.input.text, max: $0) } ?? Format.formatMaybeJson(c.input.text)
        #expect(out == c.output)
    }

    @Test func formatMaybeJsonDefaultCap() {
        let long = String(repeating: "x", count: 20_001)
        #expect(Format.formatMaybeJson(long) == String(repeating: "x", count: 20_000) + "\n… (1 more characters)")
        #expect(Format.formatMaybeJson(String(repeating: "x", count: 20_000)).count == 20_000)
    }

    @Test(arguments: Fixture.cases("stateFormat", "dispatchedKeyCases", input: String?.self, output: String?.self))
    func dispatchedKey(_ c: Fixture.Case<String?, String?>) {
        #expect(Format.dispatchedKey(outcome: c.input) == c.output)
    }

    @Test func dispatchedKeyFromSession() {
        let s = Session(id: "s", key: "TRIAGE-1", kind: .triage, driver: "dummy", cwd: "/", outcome: "Dispatched to ACME-12", createdAt: 0, updatedAt: 0)
        #expect(Format.dispatchedKey(s) == "ACME-12")
        var none = s
        none.outcome = nil
        #expect(Format.dispatchedKey(none) == nil)
    }

    @Test(arguments: Fixture.cases("stateFormat", "normalizeUrlCases", input: String.self, output: String.self))
    func normalizeUrl(_ c: Fixture.Case<String, String>) {
        #expect(Format.normalizeUrl(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "fitRectCases", input: FitRectInput.self, output: Format.Rect.self))
    func fitRect(_ c: Fixture.Case<FitRectInput, Format.Rect>) {
        #expect(Format.fitRect(boxW: c.input.boxW, boxH: c.input.boxH, w: c.input.w, h: c.input.h) == c.output)
    }

    @Test(arguments: Fixture.cases("stateFormat", "toPagePointCases", input: PagePointInput.self, output: Format.Point?.self))
    func toPagePoint(_ c: Fixture.Case<PagePointInput, Format.Point?>) {
        #expect(Format.toPagePoint(c.input.local, drawn: c.input.drawn, page: c.input.page) == c.output)
    }
}
