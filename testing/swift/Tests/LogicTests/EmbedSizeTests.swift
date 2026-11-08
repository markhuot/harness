import Foundation
import Testing
import HarnessKit

/// EmbedSize follows the same rules as shared/src/state/embeds.ts (testing/l0/state/embeds.test.ts).
@Suite struct EmbedSizeTests {
    /// The size after each report in turn, `gap` seconds apart (a page answering its own resize comes within a frame).
    private func after(_ reports: [Double?], gap: TimeInterval = 0.016, from: EmbedSize = EmbedSize()) -> EmbedSize {
        reports.enumerated().reduce(from) { s, r in s.after(r.element, now: 1 + Double(r.offset) * gap) }
    }

    @Test func followsThePageUpAndDown() {
        #expect(EmbedSize().height == EmbedSize.defaultHeight)
        #expect(after([812.4]).height == 813)
        #expect(after([812, 120]).height == 120)
    }

    @Test func heldToTheCeiling() {
        #expect(after([EmbedSize.maxHeight * 3]).height == EmbedSize.maxHeight)
    }

    @Test func ignoresNonPositiveAndNonFinite() {
        for bad in [0, -5, Double.nan, Double.infinity, nil] as [Double?] { #expect(after([500, bad]).height == 500) }
    }

    @Test func stopsFollowingAPageTrackingItsFrame() {
        let s = after([376, 392, 408, 424, 440, 456])
        #expect(s.locked)
        #expect(s.height == 408)
        #expect(s.after(100, now: 999).height == 408)
    }

    @Test func keepsFollowingUnevenGrowth() {
        let s = after([400, 450, 470, 900, 1300, 1310])
        #expect(s.height == 1310)
        #expect(!s.locked)
    }

    @Test func keepsFollowingSameHeightRowsAddedOverTime() {
        let s = after([380, 400, 420, 440, 460, 480, 500, 520], gap: EmbedSize.trackingWindow + 0.05)
        #expect(s.height == 520)
        #expect(!s.locked)
    }
}
