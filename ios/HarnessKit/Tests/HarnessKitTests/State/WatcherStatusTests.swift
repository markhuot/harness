import Foundation
import Testing
@testable import HarnessKit

struct UntilTimeInput: Decodable, Sendable {
    let ts: Double
    let now: Double
}

struct WatcherStatusInput: Decodable, Sendable {
    let watcher: Watcher
    let now: Double
}

@Suite("state/watchers.ts parity")
struct WatcherStatusTests {
    @Test(arguments: Fixture.cases("stateWatchers", "untilTimeCases", input: UntilTimeInput.self, output: String.self))
    func untilTime(_ c: Fixture.Case<UntilTimeInput, String>) {
        #expect(Watchers.untilTime(c.input.ts, now: c.input.now) == c.output)
    }

    @Test(arguments: Fixture.cases("stateWatchers", "watcherStatusCases", input: WatcherStatusInput.self, output: WatcherStatus.self))
    func watcherStatus(_ c: Fixture.Case<WatcherStatusInput, WatcherStatus>) {
        #expect(Watchers.watcherStatus(c.input.watcher, now: c.input.now) == c.output)
    }

    @Test func errorEncodesAsExplicitNull() throws {
        let s = WatcherStatus(label: "Running", tone: .green, detail: "started just now", error: nil)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: Any]
        #expect(json?.keys.contains("error") == true)
        #expect(json?["error"] is NSNull)
    }
}
