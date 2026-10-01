import Foundation
import Testing
@testable import HarnessKit

@Suite("heroCollapse.ts parity")
struct HeroCollapseTests {
    struct Input: Decodable, Sendable {
        let from: Collapse
        let heroHeight: Double
        let events: [CollapseEvent]
    }

    struct Constants: Decodable {
        let COLLAPSE_THRESHOLD: Double
        let SHOWN: Collapse
    }

    @Test("COLLAPSE_THRESHOLD and SHOWN match the TS")
    func constants() throws {
        let c = try Fixture.value("heroCollapse", "constants", as: Constants.self)
        #expect(HeroCollapse.threshold == c.COLLAPSE_THRESHOLD)
        #expect(HeroCollapse.shown == c.SHOWN)
    }

    @Test(arguments: Fixture.cases("heroCollapse", "collapseStepCases", input: Input.self, output: [Collapse].self))
    func step(_ c: Fixture.Case<Input, [Collapse]>) {
        var s = c.input.from
        var out: [Collapse] = []
        for e in c.input.events {
            s = HeroCollapse.step(s, e, heroHeight: c.input.heroHeight)
            out.append(s)
        }
        #expect(out == c.output)
    }

    private static func at(_ offset: Double) -> ScrollMetrics { ScrollMetrics(offset: offset, contentHeight: 2000, viewportHeight: 600) }

    @Test("a drag phase, then a fling: begin, end with momentum, then momentum end")
    func phases() {
        let m = Self.at(300)
        #expect(HeroCollapse.events(from: .idle, to: .interacting, metrics: m) == [.beginDrag(m)])
        #expect(HeroCollapse.events(from: .interacting, to: .decelerating, metrics: m) == [.endDrag(velocity: 1)])
        #expect(HeroCollapse.events(from: .decelerating, to: .idle, metrics: m) == [.momentumEnd])
        #expect(HeroCollapse.events(from: .interacting, to: .idle, metrics: m) == [.endDrag(velocity: 0)])
        // A finger catching the deceleration ends the momentum and starts a new drag.
        #expect(HeroCollapse.events(from: .decelerating, to: .interacting, metrics: m) == [.momentumEnd, .beginDrag(m)])
        #expect(HeroCollapse.events(from: .idle, to: .animating, metrics: m) == [])
    }

    @Test("phase-driven flick hides the hero, and the clamp that follows doesn't bring it back")
    func drivenByPhases() {
        var s = HeroCollapse.shown
        func feed(_ events: [CollapseEvent]) { for e in events { s = HeroCollapse.step(s, e, heroHeight: 200) } }
        feed(HeroCollapse.events(from: .idle, to: .interacting, metrics: Self.at(300)))
        feed([.scroll(Self.at(310))])
        feed(HeroCollapse.events(from: .interacting, to: .decelerating, metrics: Self.at(310)))
        feed([.scroll(Self.at(400))])
        #expect(s.hidden)
        feed([.scroll(Self.at(200))])
        #expect(s.hidden)
        feed(HeroCollapse.events(from: .decelerating, to: .idle, metrics: Self.at(200)))
        #expect(!s.live)
    }
}
