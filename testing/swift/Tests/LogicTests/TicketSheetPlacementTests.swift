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
