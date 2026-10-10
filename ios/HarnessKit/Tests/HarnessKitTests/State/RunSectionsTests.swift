import Foundation
import Testing
@testable import HarnessKit

// Run sections and run headers against shared/fixtures/cases/runSections.ts, plus the Swift-only rows
// (streaming text and "Working…") that TypeScript's transcript view handles outside the split.

struct SectionSummary: Decodable, Sendable, Equatable {
    let runId: String?
    let startText: String?
    let firstAt: Double?
    let rows: [String]
}

struct HeaderInput: Decodable, Sendable {
    struct Driver: Decodable, Sendable { let id: String; let name: String }
    let run: Run?
    let startText: String?
    let firstAt: Double?
    let drivers: [Driver]?
    let models: [ModelInfo]?
}

struct HeaderOutput: Decodable, Sendable, Equatable {
    let title: String
    let at: Double?
}

@Suite("Run sections")
struct RunSectionsTests {
    @Test(arguments: Fixture.cases("runSections", "runSectionCases", input: [TranscriptEntry].self, output: [SectionSummary].self))
    func split(_ c: Fixture.Case<[TranscriptEntry], [SectionSummary]>) {
        let sections = RunSections.split(Format.groupTranscript(c.input), at: RunSections.itemRun)
        let got = sections.map { s in
            SectionSummary(runId: s.runId, startText: s.startText, firstAt: s.firstAt, rows: s.rows.map(\.id))
        }
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("runSections", "modelLabelCases", input: String?.self, output: String?.self))
    func modelLabel(_ c: Fixture.Case<String?, String?>) {
        #expect(Subagents.modelLabel(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("runSections", "runHeaderCases", input: HeaderInput.self, output: HeaderOutput.self))
    func header(_ c: Fixture.Case<HeaderInput, HeaderOutput>) {
        let drivers = c.input.drivers?.map {
            DriverInfo(id: $0.id, name: $0.name, description: "", available: true, authenticated: true, detail: "", supportsLogin: false)
        }
        let h = RunSections.header(run: c.input.run, startText: c.input.startText, firstAt: c.input.firstAt, drivers: drivers, models: c.input.models)
        #expect(HeaderOutput(title: h.title, at: h.at) == c.output)
    }

    @Test("streaming text and Working… join the last section")
    func streamingJoinsLast() {
        func entry(_ id: String, _ run: String?, _ content: TranscriptContent) -> TranscriptEntry {
            TranscriptEntry(id: id, sessionId: "s", runId: run, seq: 0, role: .assistant, content: content, createdAt: 1)
        }
        let items = Format.groupTranscript([entry("s1", "a", .status(text: "Run started (work)")), entry("t1", "a", .text(text: "hi")),
                                            entry("s2", "b", .status(text: "Run started (review)")), entry("t2", "b", .text(text: "ok"))])
        let rows = TranscriptLogic.rows(items: items, deltas: [LiveDelta(runId: "b", text: "Hel")], working: true)
        let sections = RunSections.split(rows, at: RunSections.rowRun)
        #expect(sections.map(\.runId) == ["a", "b"])
        #expect(sections.map { $0.rows.map(\.id) } == [["t1"], ["t2", "delta-b"]])
    }

    @Test("nothing is pinned until a section reaches the top")
    func pinnedNone() {
        #expect(RunSections.pinned(tops: [120, 400], headed: [true, true], height: 32) == nil)
        #expect(RunSections.pinned(tops: [], headed: [], height: 32) == nil)
        #expect(RunSections.pinned(tops: [nil, nil], headed: [true, true], height: 32) == nil)
    }

    @Test("the last section at the top is pinned; the next one pushes it up once it is within a header's height")
    func pinnedPush() throws {
        let both = [true, true, true]
        var p = try #require(RunSections.pinned(tops: [-300, -20, 500], headed: both, height: 32))
        #expect(p.index == 1 && p.offset == 0)
        p = try #require(RunSections.pinned(tops: [-300, -20, 20], headed: both, height: 32))
        #expect(p.index == 1 && p.offset == -12)
        // Fully pushed off the moment the next header sits at the top, and it takes over.
        p = try #require(RunSections.pinned(tops: [-300, -20, 0], headed: both, height: 32))
        #expect(p.index == 2 && p.offset == 0)
        // A header at 0.5pt reads as at the top.
        #expect(RunSections.pinned(tops: [0.4], headed: [true], height: 32)?.index == 0)
        // An unmeasured next section doesn't push; a measured one past it does.
        #expect(RunSections.pinned(tops: [-5, nil, 10], headed: both, height: 32)?.offset == -22)
        #expect(RunSections.pinned(tops: [-5, nil], headed: [true, true], height: 32)?.offset == 0)
    }

    @Test("a header leaves with its run: nothing is pinned over the human's messages after it")
    func pinnedNotOverMessages() throws {
        let headed = [true, false, true]
        // The message's section is pushing the first run's header off...
        let p = try #require(RunSections.pinned(tops: [-300, 10, 200], headed: headed, height: 32))
        #expect(p.index == 0 && p.offset == -22)
        // ...and once it is at the top, there is nothing to pin until the next run's header arrives.
        #expect(RunSections.pinned(tops: [-300, -5, 200], headed: headed, height: 32) == nil)
        #expect(RunSections.pinned(tops: [-300, -100, 0], headed: headed, height: 32)?.index == 2)
    }
}
