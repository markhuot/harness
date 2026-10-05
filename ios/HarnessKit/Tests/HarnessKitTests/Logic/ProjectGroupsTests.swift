import Foundation
import Testing
@testable import HarnessKit

/// shared/src/projectGroups.ts and shared/src/state/groups.ts parity (Fixtures/projectGroups.json),
/// plus Return in the Group picker, which is Swift's own.
@Suite("ProjectGroups")
struct ProjectGroupsTests {
    struct Normalized: Decodable, Sendable {
        let name: String?
        let refused: Bool?
    }

    @Test(arguments: Fixture.cases("projectGroups", "normalizeCases", input: String?.self, output: Normalized.self))
    func normalize(_ c: Fixture.Case<String?, Normalized>) {
        switch ProjectGroups.normalize(c.input) {
        case .absent: #expect(c.output.refused == true)
        case .null: #expect(c.output.refused == nil && c.output.name == nil)
        case let .value(v): #expect(v == c.output.name)
        }
    }

    struct CanonicalInput: Decodable, Sendable {
        let name: String
        let existing: [String]
    }

    @Test(arguments: Fixture.cases("projectGroups", "canonicalCases", input: CanonicalInput.self, output: String.self))
    func canonical(_ c: Fixture.Case<CanonicalInput, String>) {
        #expect(ProjectGroups.canonical(c.input.name, existing: c.input.existing) == c.output)
    }

    struct Carrier: Decodable, Sendable {
        let group: String?
    }

    @Test(arguments: Fixture.cases("projectGroups", "listCases", input: [Carrier].self, output: [String].self))
    func list(_ c: Fixture.Case<[Carrier], [String]>) {
        let projects = c.input.enumerated().map { i, p in
            Project(id: "p\(i)", key: "P\(i)", name: "p\(i)", path: "/p\(i)", nextSeq: 1, useWorktrees: false, group: p.group, createdAt: 1, updatedAt: 1)
        }
        #expect(ProjectGroups.list(projects) == c.output)
    }

    struct RowsInput: Decodable, Sendable {
        let groups: [String]
        let query: String
    }

    struct Row: Decodable, Sendable, Equatable {
        let kind: String
        let value: String?
        let label: String
    }

    struct RowsOutput: Decodable, Sendable {
        let rows: [Row]
        let ids: [String]
    }

    @Test(arguments: Fixture.cases("projectGroups", "rowCases", input: RowsInput.self, output: RowsOutput.self))
    func rows(_ c: Fixture.Case<RowsInput, RowsOutput>) {
        let rows = ProjectGroups.rows(c.input.groups, query: c.input.query)
        let got = rows.map { r -> Row in
            let kind = switch r {
            case .none: "none"
            case .group: "group"
            case .new: "new"
            case .invalid: "invalid"
            }
            return Row(kind: kind, value: r.value, label: r.label)
        }
        #expect(got == c.output.rows)
        #expect(rows.compactMap(\.id) == c.output.ids)
    }

    /// Return picks the best match, as Enter does on the Mac: the group the typed text completes
    /// to, else the typed name as a new group. An empty field or an overlong name picks nothing.
    @Test func returnPicksTheBestMatch() {
        let groups = ["Client Work", "Network", "Personal", "Work"]
        func submit(_ q: String) -> GroupRow? { ProjectGroups.submitRow(ProjectGroups.rows(groups, query: q), query: q) }
        #expect(submit("wo") == .group("Work"))
        #expect(submit("  work ") == .group("Work"))
        #expect(submit("net") == .group("Network"))
        #expect(submit("Open  source") == .new("Open source"))
        #expect(submit("") == nil)
        #expect(submit("   ") == nil)
        #expect(submit(String(repeating: "x", count: 61)) == nil)
    }
}
