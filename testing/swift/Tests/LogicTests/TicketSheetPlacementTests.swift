import Testing
import HarnessKit

@Suite struct TicketSheetPlacementTests {
    @Test func partlyOpenAndWideIsTheBookPose() {
        #expect(DevicePosture.resolve(hingePartlyOpen: true, windowWidth: 1114, windowHeight: 720) == .book)
    }

    @Test func fullyOpenOrClosedIsFlatWhateverTheShape() {
        #expect(DevicePosture.resolve(hingePartlyOpen: false, windowWidth: 1114, windowHeight: 720) == .flat)
        #expect(DevicePosture.resolve(hingePartlyOpen: false, windowWidth: 720, windowHeight: 1114) == .flat)
    }

    @Test func partlyOpenWithATallWindowIsTheFoldRunningTheOtherWay() {
        #expect(DevicePosture.resolve(hingePartlyOpen: true, windowWidth: 720, windowHeight: 1114) == .flat)
        #expect(DevicePosture.resolve(hingePartlyOpen: true, windowWidth: 800, windowHeight: 800) == .flat)
    }

    @Test func onlyTheBookPoseMovesTheSheetToTheRightHalf() {
        #expect(TicketSheetPlacement.placement(for: .book) == .trailing)
        #expect(TicketSheetPlacement.placement(for: .flat) == .system)
    }
}

@Suite struct TicketSheetTicketChangeTests {
    @Test func aTicketOpenedOverAQuarterOpenSheetComesUpAtFullHeight() {
        #expect(TicketSheetPlacement.opensFullHeightAfterTicketChange(quarterOpen: true))
    }

    @Test func aSheetAlreadyAtFullHeightIsLeftAlone() {
        #expect(!TicketSheetPlacement.opensFullHeightAfterTicketChange(quarterOpen: false))
    }
}

@Suite struct TicketSheetRestTests {
    /// Up at full height on an iPhone: 430 wide, 870 tall.
    private func atFullHeight() -> TicketSheetRest {
        var rest = TicketSheetRest()
        rest.read(width: 430, height: 870)
        return rest
    }

    @Test func atFullHeightTheContentFollowsTheSheet() {
        let rest = atFullHeight()
        #expect(!rest.displaced)
        #expect(!rest.pinsContent(quarterOpen: false))
    }

    @Test func draggedDownTheContentKeepsItsFullHeightLayout() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 600)
        #expect(rest.displaced)
        #expect(rest.pinsContent(quarterOpen: false))
        #expect(rest.fullHeight == 870)
    }

    @Test func backAtFullHeightTheContentFollowsTheSheetAgain() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 600)
        rest.read(width: 430, height: 870)
        #expect(!rest.displaced)
    }

    @Test func theKeyboardShrinksTheSheetWithoutPinningTheContent() {
        var rest = atFullHeight()
        rest.keyboard(true)
        rest.read(width: 430, height: 520)
        #expect(!rest.pinsContent(quarterOpen: false))
        rest.keyboard(false)
        #expect(rest.displaced)
    }

    @Test func aFractionOfAPointIsNotAMove() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 869.7)
        #expect(!rest.displaced)
    }

    @Test func quarterOpenPinsTheContentBeforeTheSheetHasBeenUp() {
        var rest = TicketSheetRest()
        rest.read(width: 430, height: 232)
        #expect(!rest.displaced)
        #expect(rest.pinsContent(quarterOpen: true))
    }

    @Test func aPassingInsetWidthOnTheWayToQuarterOpenKeepsTheFullHeight() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 232)
        rest.read(width: 414, height: 224)
        rest.read(width: 430, height: 232)
        #expect(rest.fullHeight == 870)
    }

    @Test func aRotationHasAFullHeightOfItsOwn() {
        var rest = atFullHeight()
        rest.read(width: 932, height: 380)
        #expect(rest.fullHeight == 380)
        #expect(!rest.displaced)
        rest.read(width: 932, height: 300)
        #expect(rest.displaced)
    }

    @Test func aDragChangesTheStateOnlyWhenItLeavesOrReachesFullHeight() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 800)
        let left = rest
        rest.read(width: 430, height: 700)
        #expect(rest == left)
        rest.read(width: 430, height: 870)
        #expect(rest != left)
    }
}
