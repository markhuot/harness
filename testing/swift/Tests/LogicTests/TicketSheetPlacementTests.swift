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
    /// Up at full height on an iPhone: 430 wide, 870 tall, its top 62 down.
    private func atFullHeight() -> TicketSheetRest {
        var rest = TicketSheetRest()
        rest.read(width: 430, height: 870, top: 62)
        return rest
    }

    @Test func atRestTheContentFollowsTheSheet() {
        let rest = atFullHeight()
        #expect(!rest.displaced)
        #expect(!rest.pinsContent(quarterOpen: false))
    }

    @Test func draggedDownTheContentKeepsItsFullHeightLayout() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 600, top: 332)
        #expect(rest.displaced)
        #expect(rest.pinsContent(quarterOpen: false))
        #expect(rest.fullHeight == 870)
    }

    @Test func backInPlaceTheContentFollowsTheSheetAgain() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 600, top: 332)
        rest.read(width: 430, height: 870, top: 62)
        #expect(!rest.displaced)
    }

    @Test func theKeyboardShrinksTheSheetWithoutPinningTheContent() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 520, top: 62)
        #expect(!rest.pinsContent(quarterOpen: false))
    }

    @Test func aFractionOfAPointIsNotAMove() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 869.7, top: 62.3)
        #expect(!rest.displaced)
    }

    @Test func quarterOpenPinsTheContentBeforeTheSheetHasBeenUp() {
        var rest = TicketSheetRest()
        rest.read(width: 430, height: 232, top: 700)
        #expect(!rest.displaced)
        #expect(rest.pinsContent(quarterOpen: true))
    }

    @Test func aRotationStartsOver() {
        var rest = atFullHeight()
        rest.read(width: 932, height: 380, top: 20)
        #expect(rest.fullHeight == 380)
        #expect(rest.restTop == 20)
        rest.read(width: 932, height: 300, top: 100)
        #expect(rest.displaced)
    }

    @Test func aDragChangesTheStateOnlyWhenItLeavesOrReachesThePlace() {
        var rest = atFullHeight()
        rest.read(width: 430, height: 800, top: 132)
        let left = rest
        rest.read(width: 430, height: 700, top: 232)
        #expect(rest == left)
        rest.read(width: 430, height: 870, top: 62)
        #expect(rest != left)
    }
}
