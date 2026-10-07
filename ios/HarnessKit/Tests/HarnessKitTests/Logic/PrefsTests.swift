import Foundation
import Testing
@testable import HarnessKit

@Suite("Prefs")
struct PrefsTests {
    struct Defaults: Decodable {
        let DEFAULT_PREFS: Prefs
        let HIDE_CHILDREN_DEFAULT: Bool
    }

    /// The fixture's output as Prefs. The output passes lastProject/boardProject/activeServer through
    /// untyped; Swift keeps only strings, so a non-string expected value means nil here.
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

    /// After the one-time v2 reset, the user's own choice sticks.
    @Test func migrationRunsOnce() throws {
        let migrated = Prefs.normalize(.object(["hideChildren": .bool(false), "theme": .string("dark")]))
        #expect(migrated.hideChildren == true)
        #expect(migrated.theme == .dark)
        var chosen = migrated
        chosen.hideChildren = false
        let stored = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(chosen))
        #expect(Prefs.normalize(stored).hideChildren == false)
    }

    /// The iPad sidebar's visibility: a bool is kept and round-trips, anything else means shown.
    @Test func sidebarHidden() throws {
        #expect(Prefs.normalize(.object([:])).sidebarHidden == nil)
        #expect(Prefs.normalize(.object(["sidebarHidden": .string("yes")])).sidebarHidden == nil)
        let hidden = Prefs.normalize(.object(["sidebarHidden": .bool(true), "version": .number(2)]))
        #expect(hidden.sidebarHidden == true)
        let stored = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(hidden))
        #expect(Prefs.normalize(stored).sidebarHidden == true)
    }

    /// The iPad panel's width: a number is clamped to the panel's range and round-trips; anything
    /// else (a string, or none) means the default width.
    @Test func ticketPanelWidth() throws {
        #expect(Prefs.normalize(.object([:])).ticketPanelWidth == nil)
        #expect(Prefs.normalize(.object(["ticketPanelWidth": .string("0.5")])).ticketPanelWidth == nil)
        #expect(Prefs.normalize(.object(["ticketPanelWidth": .number(0.1)])).ticketPanelWidth == TicketPanelWidth.minFraction)
        #expect(Prefs.normalize(.object(["ticketPanelWidth": .number(0.95)])).ticketPanelWidth == TicketPanelWidth.maxFraction)
        let half = Prefs.normalize(.object(["ticketPanelWidth": .number(0.5)]))
        #expect(half.ticketPanelWidth == 0.5)
        let stored = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(half))
        #expect(Prefs.normalize(stored).ticketPanelWidth == 0.5)
    }

    @Test func rawBytes() {
        #expect(Prefs.normalize(data: nil) == Prefs.defaults)
        #expect(Prefs.normalize(data: Data("not json".utf8)) == Prefs.defaults)
        #expect(Prefs.normalize(data: Data(#"{"theme":"light","version":2,"hideChildren":false}"#.utf8)).hideChildren == false)
    }
}
