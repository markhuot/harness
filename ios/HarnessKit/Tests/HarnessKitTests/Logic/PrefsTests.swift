import Foundation
import Testing
@testable import HarnessKit

@Suite("prefs.ts parity")
struct PrefsTests {
    struct Defaults: Decodable {
        let DEFAULT_PREFS: Prefs
        let HIDE_CHILDREN_DEFAULT: Bool
    }

    /// The TS output as Prefs. TS passes lastProject/boardProject/activeServer through untyped; the
    /// Swift port keeps only strings, so a non-string expected value means nil here.
    static func expected(_ out: JSONValue) throws -> Prefs {
        var o = try #require({ if case let .object(o) = out { o } else { nil } }())
        for k in ["lastProject", "boardProject", "activeServer"] where o[k]?.stringValue == nil { o[k] = .null }
        return try JSONValue.object(o).decode(as: Prefs.self)
    }

    @Test func defaultsMatchTS() throws {
        let d = try Fixture.value("prefs", "defaults", as: Defaults.self)
        #expect(d.DEFAULT_PREFS == Prefs.defaults)
        #expect(d.HIDE_CHILDREN_DEFAULT == Conductor.hideChildrenDefault)
    }

    @Test(arguments: Fixture.cases("prefs", "normalizePrefsCases", input: JSONValue.self, output: JSONValue.self))
    func normalizePrefs(_ c: Fixture.Case<JSONValue, JSONValue>) throws {
        let got = Prefs.normalize(c.input)
        #expect(got == (try Self.expected(c.output)))
        // Normalizing is idempotent: what we'd store comes back unchanged.
        let stored = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(got))
        #expect(Prefs.normalize(stored) == got)
    }

    /// After the one-time v2 reset, the user's own choice sticks (prefs.test.ts).
    @Test func migrationRunsOnce() throws {
        let migrated = Prefs.normalize(.object(["hideChildren": .bool(false), "theme": .string("dark")]))
        #expect(migrated.hideChildren == true)
        #expect(migrated.theme == .dark)
        var chosen = migrated
        chosen.hideChildren = false
        let stored = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(chosen))
        #expect(Prefs.normalize(stored).hideChildren == false)
    }

    @Test func rawBytes() {
        #expect(Prefs.normalize(data: nil) == Prefs.defaults)
        #expect(Prefs.normalize(data: Data("not json".utf8)) == Prefs.defaults)
        #expect(Prefs.normalize(data: Data(#"{"theme":"light","version":2,"hideChildren":false}"#.utf8)).hideChildren == false)
    }
}
