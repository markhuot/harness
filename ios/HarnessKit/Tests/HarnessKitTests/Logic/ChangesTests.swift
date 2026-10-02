import Foundation
import Testing
@testable import HarnessKit

/// The Changes tab's ports against shared/fixtures/cases/changes.ts: the git plugin's payloads,
/// @pierre/diffs' parse and the plugin's viewed.ts.
@Suite struct ChangesFixtureTests {
    struct ParsedHunk: Decodable, Sendable, Equatable {
        var deletionStart: Int
        var deletionCount: Int
        var additionStart: Int
        var additionCount: Int
        var context: String?
    }

    struct ParsedFile: Decodable, Sendable, Equatable {
        var name: String
        var prevName: String?
        var type: String
        var mode: String?
        var prevMode: String?
        var hunks: [ParsedHunk]
        var deletionLines: [String]
        var additionLines: [String]
        var fingerprint: String
    }

    struct PruneIn: Decodable, Sendable {
        var viewed: [[String]]
        var current: [String: String]
        var changed: [String]
    }

    struct CollapseIn: Decodable, Sendable {
        struct Toggle: Decodable, Sendable {
            var fp: String
            var collapsed: Bool
        }
        var viewed: Bool
        var toggle: Toggle?
        var fp: String
    }

    struct Sequence: Decodable, Sendable, CustomTestStringConvertible {
        struct Op: Decodable, Sendable {
            var op: String
            var ticket: String
            var files: [[String]]?
            var now: Double?
        }
        struct Out: Decodable, Sendable, Equatable {
            var tickets: [String]
            var read: [[String]]
        }
        var name: String
        var ops: [Op]
        var outputs: [Out]
        var testDescription: String { name }
    }

    @Test func payloadsRoundTrip() throws {
        for export in ["changesSamples", "logSamples", "fileSamples"] {
            let raw = try Fixture.value("changes", export, as: [JSONValue].self)
            for sample in raw {
                let data = try JSONEncoder().encode(sample)
                let reencoded: Data = switch export {
                case "changesSamples": try JSONEncoder().encode(JSONDecoder().decode(Changes.self, from: data))
                case "logSamples": try JSONEncoder().encode(JSONDecoder().decode(ChangesLog.self, from: data))
                default: try JSONEncoder().encode(JSONDecoder().decode(ChangesFileContents.self, from: data))
                }
                #expect(try jsonEqual(data, reencoded), "\(export): \(String(decoding: data, as: UTF8.self))")
            }
        }
    }

    @Test func pinnedWorktreeKeepsAbsentNullAndValueApart() throws {
        let samples = try Fixture.value("changes", "changesSamples", as: [Changes].self)
        #expect(samples.map(\.worktree) == [.absent, .absent, .value(String(repeating: "e", count: 40)), .null])
        #expect(samples[2].worktreeSha == String(repeating: "e", count: 40))
        #expect(samples[1].baseSha == nil && samples[1].mode == .workdir)
        #expect(samples[0].files.map(\.status) == [.untracked, .added, .modified, .renamed])
    }

    @Test(arguments: Fixture.cases("changes", "parseCases", input: String.self, output: [ParsedFile].self))
    func parseMatchesPierre(_ c: Fixture.Case<String, [ParsedFile]>) {
        let got = ChangesPatch.parse(c.input).map { d in
            ParsedFile(
                name: d.name, prevName: d.prevName, type: d.type.rawValue, mode: d.mode, prevMode: d.prevMode,
                hunks: d.hunks.map { ParsedHunk(deletionStart: $0.deletionStart, deletionCount: $0.deletionCount, additionStart: $0.additionStart, additionCount: $0.additionCount, context: $0.context) },
                deletionLines: d.deletionLines, additionLines: d.additionLines, fingerprint: d.fingerprint
            )
        }
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("changes", "hashCases", input: String.self, output: String.self))
    func hashMatches(_ c: Fixture.Case<String, String>) {
        #expect(ChangesPatch.hash(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("changes", "pruneCases", input: PruneIn.self, output: [[String]].self))
    func pruneMatches(_ c: Fixture.Case<PruneIn, [[String]]>) {
        let viewed = ChangesViewed(c.input.viewed.map { ($0[0], $0[1]) })
        let got = ChangesViewedStore.prune(viewed, current: c.input.current, changed: Set(c.input.changed))
        #expect(got.entries.map { [$0.path, $0.fingerprint] } == c.output)
    }

    @Test(arguments: Fixture.cases("changes", "isCollapsedCases", input: CollapseIn.self, output: Bool.self))
    func isCollapsedMatches(_ c: Fixture.Case<CollapseIn, Bool>) {
        let t = c.input.toggle.map { (fingerprint: $0.fp, collapsed: $0.collapsed) }
        #expect(ChangesViewedStore.isCollapsed(viewed: c.input.viewed, toggle: t, fingerprint: c.input.fp) == c.output)
    }

    @Test(arguments: try! Fixture.value("changes", "viewedSequences", as: [Sequence].self))
    func viewedStorageMatches(_ s: Sequence) {
        let store = MemoryChangesDefaults()
        for (op, want) in zip(s.ops, s.outputs) {
            if op.op == "save" {
                ChangesViewedStore.save(op.ticket, ChangesViewed((op.files ?? []).map { ($0[0], $0[1]) }), to: store, now: op.now ?? 0)
            }
            #expect(ChangesViewedStore.tickets(in: store) == want.tickets)
            #expect(ChangesViewedStore.read(op.ticket, from: store).entries.map { [$0.path, $0.fingerprint] } == want.read)
        }
    }

    @Test func limitsMatchThePlugin() throws {
        struct Limits: Decodable { var key: String; var maxTickets: Int; var maxFiles: Int }
        let l = try Fixture.value("changes", "limits", as: Limits.self)
        #expect(l.key == ChangesViewedStore.key)
        #expect(l.maxTickets == ChangesViewedStore.maxTickets)
        #expect(l.maxFiles == ChangesViewedStore.maxFiles)
    }
}

@Suite struct ChangesViewedTests {
    @Test func garbageStorageReadsAsNothingViewed() {
        for raw in ["", "not json", "[]", #"{"A-1":5}"#, #"{"A-1":{"files":[["a","1"]]}}"#] {
            let store = MemoryChangesDefaults([ChangesViewedStore.key: raw])
            #expect(ChangesViewedStore.read("A-1", from: store).isEmpty, "\(raw)")
        }
    }

    @Test func malformedMarksAreSkippedAndDroppedOnTheNextSave() {
        let store = MemoryChangesDefaults([ChangesViewedStore.key: #"{"A-1":{"at":1,"files":[["a.ts","1"],["b.ts"],[3,"x"],"c"]},"B-2":"junk"}"#])
        #expect(ChangesViewedStore.read("A-1", from: store).entries.map(\.path) == ["a.ts"])
        ChangesViewedStore.save("C-3", ChangesViewed([("z", "9")]), to: store, now: 2)
        #expect(ChangesViewedStore.tickets(in: store) == ["A-1", "C-3"])
    }

    @Test func settingAMarkAgainMovesItToTheEnd() {
        var v = ChangesViewed([("a", "1"), ("b", "2")])
        v.set("a", "3")
        #expect(v.entries.map(\.path) == ["b", "a"])
        #expect(v["a"] == "3")
        v.remove("b")
        #expect(v.entries.map(\.path) == ["a"])
    }
}
