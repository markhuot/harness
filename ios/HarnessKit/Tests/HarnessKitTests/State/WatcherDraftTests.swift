import Foundation
import Testing
@testable import HarnessKit

struct ToDraftInput: Decodable, Sendable {
    let watcher: Watcher?
    let settings: WatcherDraft.DriverSettings?
}

struct WatcherDraftBodyInput: Decodable, Sendable {
    struct Existing: Decodable, Sendable { let models: [String: String]? }
    let draft: WatcherDraft
    let existing: Existing?
}

@Suite("WatcherDraft")
struct WatcherDraftTests {
    @Test(arguments: Fixture.cases("mobileWatcherDraft", "toDraftCases", input: ToDraftInput.self, output: WatcherDraft.self))
    func toDraft(_ c: Fixture.Case<ToDraftInput, WatcherDraft>) {
        let got = WatcherDraft.toDraft(c.input.watcher, settings: c.input.settings)
        #expect(got == c.output)
        #expect(Array(got.command.unicodeScalars) == Array(c.output.command.unicodeScalars))
    }

    /// Decoding the fixture's output as a WatcherBody keeps absent vs null (cwd, driver), and maps
    /// `intervalSec: null` (JS Infinity, which JSON can't hold) to nil, which Swift omits.
    @Test(arguments: Fixture.cases("mobileWatcherDraft", "watcherBodyCases", input: WatcherDraftBodyInput.self, output: WatcherBody.self))
    func watcherBody(_ c: Fixture.Case<WatcherDraftBodyInput, WatcherBody>) {
        let got = WatcherDraft.watcherBody(c.input.draft, existingModels: c.input.existing?.models.map { $0.mapValues { $0 } })
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("mobileWatcherDraft", "jsNumberCases", input: String.self, output: String.self))
    func jsNumber(_ c: Fixture.Case<String, String>) {
        #expect(JSCompat.string(JSNumber.parse(c.input)) == c.output)
    }

    @Test func watcherOverloadsMatchTheMapForms() throws {
        let samples = try Fixture.value("protocol", "Watcher", as: [Watcher].self)
        let settings = try Fixture.value("protocol", "PublicSettings", as: [PublicSettings].self)[0]
        let w = samples[0]
        // PublicSettings[0] routes watchers to anthropic-api, so a driverless watcher with a model
        // there opens on that pick (it would open on Default if the conversion lost watcherDriver).
        var driverless = samples[1]
        driverless.models = ["anthropic-api": "m"]
        #expect(WatcherDraft.toDraft(driverless, settings: settings).choice == TriageChoice(driver: "anthropic-api", model: "m"))
        let draft = WatcherDraft(name: "n", command: "c", choice: TriageChoice(driver: "codex", model: nil))
        let body = WatcherDraft.watcherBody(draft, existing: w)
        let cleared: [String: String?] = ["anthropic-api": nil, "codex": nil]
        let codexOnly: [String: String?] = ["codex": nil]
        #expect(body.models == cleared)
        #expect(WatcherDraft.watcherBody(draft).models == codexOnly)
    }

    @Test func intervalBeyondIntRangeIsLeftOut() {
        #expect(WatcherDraft.intervalSec("1e20") == nil)
        #expect(WatcherDraft.intervalSec("9e18") == 9_000_000_000_000_000_000)
        #expect(WatcherDraft.intervalSec("-1e20") == 1)
    }
}
