import CoreGraphics
import Testing
@testable import HarnessKit

@Suite("ConcentricBar")
struct ConcentricBarTests {
    @Test("a Home-button phone has square corners, so the bar keeps its own padding")
    func squareCorners() {
        let screen = ConcentricBar.Screen(width: 375, height: 667, homeIndicator: 0)
        #expect(ConcentricBar.displayCornerRadius(screen) == nil)
        #expect(ConcentricBar.padding(screen, barHeight: 50) == nil)
    }

    @Test("nothing measured yet keeps the bar's own padding")
    func unmeasured() {
        #expect(ConcentricBar.padding(nil, barHeight: 50) == nil)
    }

    @Test("a 15 Pro Max (430pt, 55pt corners) puts a 50pt bar 30pt from the edges, 4pt into the home indicator's inset")
    func proMax() {
        let p = ConcentricBar.padding(.init(width: 430, height: 932, homeIndicator: 34), barHeight: 50)
        #expect(p == .init(horizontal: 30, bottom: -4))
    }

    @Test("an unknown width is taken for one of the newest phones (62pt corners)")
    func unknownWidth() {
        let p = ConcentricBar.padding(.init(width: 402, height: 874, homeIndicator: 34), barHeight: 50)
        #expect(p == .init(horizontal: 37, bottom: 3))
        #expect(ConcentricBar.displayCornerRadius(.init(width: 450, height: 980, homeIndicator: 34)) == 62)
    }

    @Test("a fractional width from the geometry still finds its phone")
    func roundsWidth() {
        #expect(ConcentricBar.displayCornerRadius(.init(width: 392.6, height: 852, homeIndicator: 34)) == 55)
    }

    @Test("landscape, where the bar sits between the side insets, keeps the bar's own padding")
    func landscape() {
        let screen = ConcentricBar.Screen(width: 874, height: 402, sideInsets: 124, homeIndicator: 21)
        #expect(!screen.portrait)
        #expect(ConcentricBar.padding(screen, barHeight: 50) == nil)
        // Wider than tall even without side insets (a Plus or Pro Max's split view) still opts out.
        #expect(ConcentricBar.padding(.init(width: 932, height: 430, homeIndicator: 21), barHeight: 50) == nil)
    }

    @Test("a bar taller than the corner's diameter keeps a minimum gap rather than touching the edge")
    func minimumMargin() {
        let p = ConcentricBar.padding(.init(width: 375, height: 812, homeIndicator: 34), barHeight: 80)
        #expect(p?.horizontal == ConcentricBar.minimumMargin)
        #expect(p?.bottom == ConcentricBar.minimumMargin - 34)
    }
}
