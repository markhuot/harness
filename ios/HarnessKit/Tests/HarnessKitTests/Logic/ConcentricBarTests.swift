import CoreGraphics
import Testing
@testable import HarnessKit

@Suite("ConcentricBar")
struct ConcentricBarTests {
    @Test("a Home-button phone has square corners, so the bar keeps its own padding")
    func squareCorners() {
        let screen = ConcentricBar.Screen(shortSide: 375, homeIndicator: 0)
        #expect(ConcentricBar.displayCornerRadius(screen) == nil)
        #expect(ConcentricBar.padding(screen, barHeight: 50) == nil)
    }

    @Test("nothing measured yet keeps the bar's own padding")
    func unmeasured() {
        #expect(ConcentricBar.padding(nil, barHeight: 50) == nil)
    }

    @Test("a 15 Pro Max (430pt, 55pt corners) puts a 50pt bar 30pt from the edges, 4pt into the home indicator's inset")
    func proMax() {
        let p = ConcentricBar.padding(.init(shortSide: 430, homeIndicator: 34), barHeight: 50)
        #expect(p == .init(horizontal: 30, bottom: -4))
    }

    @Test("an unknown width is taken for one of the newest phones (62pt corners)")
    func unknownWidth() {
        let p = ConcentricBar.padding(.init(shortSide: 402, homeIndicator: 34), barHeight: 50)
        #expect(p == .init(horizontal: 37, bottom: 3))
        #expect(ConcentricBar.displayCornerRadius(.init(shortSide: 450, homeIndicator: 34)) == 62)
    }

    @Test("a fractional width from the geometry still finds its phone")
    func roundsWidth() {
        #expect(ConcentricBar.displayCornerRadius(.init(shortSide: 392.6, homeIndicator: 34)) == 55)
    }

    @Test("a bar taller than the corner's diameter keeps a minimum gap rather than touching the edge")
    func minimumMargin() {
        let p = ConcentricBar.padding(.init(shortSide: 375, homeIndicator: 34), barHeight: 80)
        #expect(p?.horizontal == ConcentricBar.minimumMargin)
        #expect(p?.bottom == ConcentricBar.minimumMargin - 34)
    }
}
