import SwiftUI
import XCTest
@testable import Harness

/// The world is the one source of truth: change a field in it and the render changes. And a render
/// is repeatable, or a changed image would prove nothing.
@MainActor
final class SeamTests: ScreenTestCase {
    private func pixels(_ image: UIImage) throws -> ReferenceImages.Pixels {
        try XCTUnwrap(image.cgImage.flatMap(ReferenceImages.Pixels.init))
    }

    func testEditingATicketTitleInTheWorldChangesTheBoardImage() async throws {
        let first = try pixels(try await render { RootView() })
        let again = try pixels(try await render { RootView() })
        let same = try XCTUnwrap(ReferenceImages.compare(first, again))
        XCTAssertEqual(same.differing, 0, "two renders of the same world must match, or a difference below proves nothing")

        var edited = world.json
        edited.retitle("HARNESS-4", to: "A much longer title that wraps onto a second line of the card on the board")
        let other = await ScreenWorld(edited)
        let changed = try pixels(try await render(other) { RootView() })
        let difference = try XCTUnwrap(ReferenceImages.compare(first, changed))
        XCTAssertGreaterThan(difference.fraction, ReferenceImages.pixelBudget, "the edit changed the world, so it must change the image")
    }
}
