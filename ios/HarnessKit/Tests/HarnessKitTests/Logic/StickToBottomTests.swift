import Foundation
import Testing
@testable import HarnessKit

struct NextPinnedInput: Decodable, Sendable {
    let pinned: Bool
    let prevOffset: Double
    let m: ScrollMetrics
    let threshold: Double?
}

struct StickStepInput: Decodable, Sendable {
    let from: Stick
    let events: [StickEvent]
}

struct StickConstants: Decodable {
    let STICK_THRESHOLD: Double
    let STUCK: Stick
}

@Suite("stickToBottom.ts parity")
struct StickToBottomTests {
    @Test("STICK_THRESHOLD and STUCK match the TS")
    func constants() throws {
        let c = try Fixture.value("stickToBottom", "constants", as: StickConstants.self)
        #expect(StickToBottom.threshold == c.STICK_THRESHOLD)
        #expect(StickToBottom.stuck == c.STUCK)
    }

    @Test(arguments: Fixture.cases("stickToBottom", "distanceFromBottomCases", input: ScrollMetrics.self, output: Double.self))
    func distanceFromBottom(_ c: Fixture.Case<ScrollMetrics, Double>) {
        #expect(StickToBottom.distanceFromBottom(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("stickToBottom", "nextPinnedCases", input: NextPinnedInput.self, output: Bool.self))
    func nextPinned(_ c: Fixture.Case<NextPinnedInput, Bool>) {
        let i = c.input
        let got = i.threshold.map { StickToBottom.nextPinned(i.pinned, prevOffset: i.prevOffset, i.m, threshold: $0) }
            ?? StickToBottom.nextPinned(i.pinned, prevOffset: i.prevOffset, i.m)
        #expect(got == c.output)
    }

    @Test(arguments: Fixture.cases("stickToBottom", "stickStepCases", input: StickStepInput.self, output: [StickStep].self))
    func stickStep(_ c: Fixture.Case<StickStepInput, [StickStep]>) {
        var stick = c.input.from
        var steps: [StickStep] = []
        for e in c.input.events {
            let r = StickToBottom.stickStep(stick, e)
            stick = r.stick
            steps.append(r)
        }
        #expect(steps == c.output)
    }

    @Test("ScrollGeometry insets fold in so the bottom is distance zero")
    func insets() {
        // 2000pt content, 600pt container, 50pt top and 80pt bottom insets: SwiftUI's offset runs
        // from -50 at the top to 2000 + 80 - 600 = 1480 at the bottom.
        let top = ScrollMetrics(contentOffsetY: -50, contentHeight: 2000, containerHeight: 600, topInset: 50, bottomInset: 80)
        let bottom = ScrollMetrics(contentOffsetY: 1480, contentHeight: 2000, containerHeight: 600, topInset: 50, bottomInset: 80)
        #expect(top.offset == 0)
        #expect(StickToBottom.distanceFromBottom(top) == 2130 - 600)
        #expect(StickToBottom.distanceFromBottom(bottom) == 0)
    }

    private static func at(_ offset: Double) -> ScrollMetrics { ScrollMetrics(offset: offset, contentHeight: 2000, viewportHeight: 600) }

    /// Feeds SwiftUI phase changes (with the geometry at each) and offset changes through
    /// events(from:to:metrics:) and stickStep, returning the last step's state and follows.
    private static func drive(_ from: Stick, _ script: [(StickScrollPhase?, ScrollMetrics?)]) -> (Stick, [Bool]) {
        var stick = from
        var phase = StickScrollPhase.idle
        var follows: [Bool] = []
        for (next, m) in script {
            var events: [StickEvent] = []
            if let next {
                events = StickToBottom.events(from: phase, to: next, metrics: m ?? at(stick.lastOffset))
                phase = next
            } else if let m {
                events = [.scroll(m)]
            } else {
                events = [.resize]
            }
            for e in events {
                let r = StickToBottom.stickStep(stick, e)
                stick = r.stick
                follows.append(r.follow)
            }
        }
        return (stick, follows)
    }

    @Test("phases: dragging up unpins; a fling back to the bottom re-pins when deceleration ends")
    func phasesFling() {
        let start = Stick(pinned: true, dragging: false, gesture: false, lastOffset: 1400)
        let (up, _) = Self.drive(start, [(.interacting, Self.at(1400)), (nil, Self.at(1100)), (.idle, Self.at(1000))])
        #expect(up.pinned == false)
        #expect(up.gesture == false)
        let (back, follows) = Self.drive(up, [(.interacting, Self.at(1000)), (.decelerating, Self.at(1200)), (nil, Self.at(1390)), (.idle, Self.at(1400))])
        #expect(back.pinned)
        #expect(back.gesture == false)
        #expect(follows.last == true)
    }

    @Test("phases: an offset change outside a gesture (a relayout nudge) doesn't unpin")
    func phasesNudge() {
        let start = Stick(pinned: true, dragging: false, gesture: false, lastOffset: 1400)
        let (s, follows) = Self.drive(start, [(nil, Self.at(1100)), (nil, nil)])
        #expect(s.pinned)
        #expect(follows == [false, true])
    }

    @Test("phase mapping: each transition's UIKit events")
    func phaseMapping() {
        let m = Self.at(10)
        #expect(StickToBottom.events(from: .idle, to: .interacting, metrics: m) == [.beginDrag(m)])
        #expect(StickToBottom.events(from: .tracking, to: .interacting, metrics: m) == [.beginDrag(m)])
        #expect(StickToBottom.events(from: .interacting, to: .idle, metrics: m) == [.endDrag(velocity: 0, m)])
        #expect(StickToBottom.events(from: .interacting, to: .decelerating, metrics: m) == [.endDrag(velocity: 1, m), .momentumBegin])
        #expect(StickToBottom.events(from: .decelerating, to: .idle, metrics: m) == [.momentumEnd(m)])
        // A finger catching the deceleration: UIKit ends the momentum, then starts a drag.
        #expect(StickToBottom.events(from: .decelerating, to: .interacting, metrics: m) == [.momentumEnd(m), .beginDrag(m)])
        #expect(StickToBottom.events(from: .idle, to: .animating, metrics: m) == [])
        #expect(StickToBottom.events(from: .idle, to: .tracking, metrics: m) == [])
        #expect(StickToBottom.events(from: .interacting, to: .interacting, metrics: m) == [])
    }
}
