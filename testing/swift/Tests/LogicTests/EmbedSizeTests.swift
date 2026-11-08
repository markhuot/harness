import Testing
import HarnessKit

/// EmbedSize follows the same rules as shared/src/state/embeds.ts (testing/l0/state/embeds.test.ts).
@Suite struct EmbedSizeTests {
    private func after(_ reports: [Double?], from: EmbedSize = EmbedSize()) -> EmbedSize {
        reports.reduce(from) { $0.after($1) }
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
        #expect(s.after(100).height == 408)
    }

    @Test func keepsFollowingUnevenGrowth() {
        let s = after([400, 450, 470, 900, 1300, 1310])
        #expect(s.height == 1310)
        #expect(!s.locked)
    }
}
