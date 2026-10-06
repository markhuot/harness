import Foundation
import Testing
@testable import HarnessKit

@Suite("HeroDisclosure")
struct HeroDisclosureTests {
    private static func at(_ offset: Double) -> ScrollMetrics { ScrollMetrics(offset: offset, contentHeight: 2000, viewportHeight: 600) }

    @Test("only the Spec opens the hero in full")
    func open() {
        #expect(HeroDisclosure.expandedOnOpen(.spec))
        #expect(!HeroDisclosure.expandedOnOpen(.activity))
        #expect(!HeroDisclosure.expandedOnOpen(.changes))
        #expect(!HeroDisclosure.expandedOnOpen(.transcript))
    }

    @Test("another tab collapses it; back on the Spec it stays collapsed")
    func tabs() {
        #expect(!HeroDisclosure.expanded(true, afterMovingTo: .activity))
        #expect(!HeroDisclosure.expanded(false, afterMovingTo: .spec))
        #expect(HeroDisclosure.expanded(true, afterMovingTo: .spec))
        #expect(!HeroDisclosure.expanded(false, afterMovingTo: .changes))
    }

    @Test("scrolling forward collapses it, and scrolling back or to the top never expands it")
    func scroll() {
        var expanded = true
        var s = HeroCollapse.shown
        func feed(_ events: [CollapseEvent]) {
            for e in events {
                let next = HeroCollapse.step(s, e, heroHeight: 0)
                expanded = HeroDisclosure.expanded(expanded, scrolledFrom: s, to: next)
                s = next
            }
        }
        feed([.beginDrag(Self.at(0)), .scroll(Self.at(40))])
        #expect(!expanded)
        feed([.endDrag(velocity: 0), .beginDrag(Self.at(40)), .scroll(Self.at(0))])
        #expect(!s.hidden)
        #expect(!expanded)
        feed([.show])
        #expect(!expanded)
    }
}
