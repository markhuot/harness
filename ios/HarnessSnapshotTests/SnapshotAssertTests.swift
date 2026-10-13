import XCTest

/// The comparison the snapshot tests rely on: it has to fail when a screen changes, and not on noise.
final class SnapshotAssertTests: XCTestCase {
    private func solid(_ w: Int, _ h: Int, _ value: UInt8) -> SnapshotAssert.Pixels {
        SnapshotAssert.Pixels(width: w, height: h, bytes: [UInt8](repeating: value, count: w * h * 4))
    }

    func testIdenticalImagesDoNotDiffer() {
        XCTAssertEqual(SnapshotAssert.compare(solid(10, 10, 200), solid(10, 10, 200))?.differing, 0)
    }

    func testOneChangedPixelIsFound() {
        var changed = solid(10, 10, 200)
        changed.bytes[4 * 13] = 0
        let diff = SnapshotAssert.compare(changed, solid(10, 10, 200))
        XCTAssertEqual(diff?.differing, 1)
        XCTAssertEqual(diff?.total, 100)
        // The diff picture marks that pixel red and leaves the rest faded.
        XCTAssertEqual(Array(diff!.picture[4 * 13..<4 * 13 + 3]), [255, 0, 0])
    }

    func testAntiAliasingNoiseWithinTheTolerancePasses() {
        let near = solid(10, 10, 200 - UInt8(SnapshotAssert.channelTolerance))
        XCTAssertEqual(SnapshotAssert.compare(near, solid(10, 10, 200))?.differing, 0)
        let far = solid(10, 10, 200 - UInt8(SnapshotAssert.channelTolerance) - 1)
        XCTAssertEqual(SnapshotAssert.compare(far, solid(10, 10, 200))?.differing, 100)
    }

    func testDifferentSizesDoNotCompare() {
        XCTAssertNil(SnapshotAssert.compare(solid(10, 10, 0), solid(10, 11, 0)))
    }
}
