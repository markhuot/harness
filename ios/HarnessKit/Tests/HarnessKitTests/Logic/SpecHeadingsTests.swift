import Foundation
import Testing
@testable import HarnessKit

@Suite("Spec headings")
struct SpecHeadingsTests {
    @Test func sizesStepDownFromSevenOverBodyToHalfAPoint() {
        let sizes = (1...6).map { SpecHeadings.size(level: $0, body: 14) }
        #expect(sizes == [21, 18, 16, 14.5, 14.5, 14.5])
    }

    @Test func aHeadingAfterAnotherPullsInFourPoints() {
        #expect(SpecHeadings.lead(level: 3, after: 2, headingSpace: 1.4, body: 14) == -4)
    }

    @Test func aHeadingAfterABlockGetsItsSizeTimesTheSpaceMinusTheStacksOwnTen() {
        // 1.4 × 18 = 25.2 → 25, less the 8 pt stack gap and the heading's 2 pt.
        #expect(SpecHeadings.lead(level: 2, after: nil, headingSpace: 1.4, body: 14) == 15)
        // Bigger headings leave more room above them.
        #expect(SpecHeadings.lead(level: 1, after: nil, headingSpace: 1.4, body: 14) > SpecHeadings.lead(level: 3, after: nil, headingSpace: 1.4, body: 14))
    }

    @Test func noSpaceForABlockThatIsntAHeadingOrWhenSpacingIsOff() {
        #expect(SpecHeadings.lead(level: nil, after: nil, headingSpace: 1.4, body: 14) == 0)
        #expect(SpecHeadings.lead(level: 2, after: nil, headingSpace: 0, body: 14) == 0)
        #expect(SpecHeadings.lead(level: nil, after: 2, headingSpace: 1.4, body: 14) == 0)
    }
}
