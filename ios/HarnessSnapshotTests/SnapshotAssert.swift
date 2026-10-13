import CoreGraphics
import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest

/// Compares a rendered image with its reference PNG under `References/<device>/`.
///
/// - Missing reference: the test fails and says how to record it (a new screen is never silently
///   accepted), unless recording.
/// - A mismatch writes `<name>.actual.png` and `<name>.diff.png` (differing pixels in red over a
///   faded copy of the reference) to `ios/build/snapshots/failures/` and fails with the count.
/// - `SNAPSHOT_RECORD=1` writes the reference instead. `SNAPSHOT_OUT=<dir>` also writes every
///   rendered image there, which is how a spec's Status screenshots are made without a daemon.
///   Pass them to xcodebuild as `TEST_RUNNER_SNAPSHOT_RECORD` and `TEST_RUNNER_SNAPSHOT_OUT`
///   (`bun run sim snapshots` does).
enum SnapshotAssert {
    /// A pixel differs when any channel is further than this from the reference (anti-aliasing noise).
    static let channelTolerance = 2
    /// The share of pixels allowed to differ before the snapshot fails.
    static let pixelTolerance = 0.0002

    static let env = ProcessInfo.processInfo.environment
    static var recording: Bool { env["SNAPSHOT_RECORD"] == "1" }
    static var outDir: String? { env["SNAPSHOT_OUT"].flatMap { $0.isEmpty ? nil : $0 } }
    /// The checkout's `ios/` directory, found from this file's path.
    static let iosDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    static var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone" }
    static var referenceDir: URL { iosDir.appending(path: "HarnessSnapshotTests/References/\(device)") }
    static var failureDir: URL { iosDir.appending(path: "build/snapshots/failures/\(device)") }

    struct Diff: Equatable {
        var differing: Int
        var total: Int
        var fraction: Double { total == 0 ? 0 : Double(differing) / Double(total) }
        /// RGBA, red where the images differ, a faded reference elsewhere.
        var picture: [UInt8]
        static func == (a: Diff, b: Diff) -> Bool { a.differing == b.differing && a.total == b.total }
    }

    /// Pixel comparison of two same-size RGBA buffers; nil when the sizes differ.
    static func compare(_ a: Pixels, _ b: Pixels, channelTolerance: Int = channelTolerance) -> Diff? {
        guard a.width == b.width, a.height == b.height else { return nil }
        var differing = 0
        var picture = [UInt8](repeating: 255, count: a.bytes.count)
        for p in 0..<(a.width * a.height) {
            let i = p * 4
            var off = false
            for c in 0..<3 where abs(Int(a.bytes[i + c]) - Int(b.bytes[i + c])) > channelTolerance { off = true }
            if off {
                differing += 1
                picture[i] = 255; picture[i + 1] = 0; picture[i + 2] = 0
            } else {
                for c in 0..<3 { picture[i + c] = UInt8(255 - (255 - Int(b.bytes[i + c])) / 3) }
            }
        }
        return Diff(differing: differing, total: a.width * a.height, picture: picture)
    }

    struct Pixels {
        var width: Int
        var height: Int
        var bytes: [UInt8]

        init?(_ image: CGImage) {
            width = image.width
            height = image.height
            bytes = [UInt8](repeating: 0, count: width * height * 4)
            let drew = bytes.withUnsafeMutableBytes { buffer -> Bool in
                guard let ctx = CGContext(
                    data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                else { return false }
                ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                return true
            }
            if !drew { return nil }
        }

        func png() -> Data? {
            var copy = bytes
            return copy.withUnsafeMutableBytes { buffer -> Data? in
                guard let ctx = CGContext(
                    data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
                      let image = ctx.makeImage() else { return nil }
                return SnapshotAssert.pngData(image)
            }
        }
    }

    static func pngData(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, nil)
        return CGImageDestinationFinalize(dest) ? data as Data : nil
    }

    static func cgImage(_ data: Data) -> CGImage? {
        CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
    }

    /// Checks `image` against `<name>.png`; reports through XCTest at `file:line`.
    static func assert(_ image: UIImage, named name: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let cg = image.cgImage, let actual = Pixels(cg), let png = pngData(cg) else {
            XCTFail("\(name): couldn't read the rendered image", file: file, line: line)
            return
        }
        let fm = FileManager.default
        if let out = outDir {
            try? fm.createDirectory(atPath: out, withIntermediateDirectories: true)
            try? png.write(to: URL(fileURLWithPath: out).appending(path: "\(name).png"))
        }
        let referenceURL = referenceDir.appending(path: "\(name).png")
        if recording {
            try? fm.createDirectory(at: referenceDir, withIntermediateDirectories: true)
            do { try png.write(to: referenceURL) } catch { XCTFail("\(name): couldn't write \(referenceURL.path): \(error)", file: file, line: line) }
            return
        }
        guard let data = try? Data(contentsOf: referenceURL), let refImage = cgImage(data), let reference = Pixels(refImage) else {
            XCTFail("\(name): no reference image at \(referenceURL.path). Record it: bun run sim snapshots --record", file: file, line: line)
            return
        }
        try? fm.createDirectory(at: failureDir, withIntermediateDirectories: true)
        let actualURL = failureDir.appending(path: "\(name).actual.png")
        let diffURL = failureDir.appending(path: "\(name).diff.png")
        guard let diff = compare(actual, reference) else {
            try? png.write(to: actualURL)
            XCTFail("\(name): the image is \(actual.width)x\(actual.height) px, the reference \(reference.width)x\(reference.height). Actual: \(actualURL.path)", file: file, line: line)
            return
        }
        if diff.fraction <= pixelTolerance {
            try? fm.removeItem(at: actualURL)
            try? fm.removeItem(at: diffURL)
            return
        }
        try? png.write(to: actualURL)
        if let picture = Pixels(width: actual.width, height: actual.height, bytes: diff.picture).png() { try? picture.write(to: diffURL) }
        let percent = String(format: "%.2f", diff.fraction * 100)
        XCTFail("\(name): \(diff.differing) of \(diff.total) pixels differ (\(percent)%).\n  reference: \(referenceURL.path)\n  actual:    \(actualURL.path)\n  diff:      \(diffURL.path)\nIf the change is intended: bun run sim snapshots --record", file: file, line: line)
    }
}

extension SnapshotAssert.Pixels {
    init(width: Int, height: Int, bytes: [UInt8]) {
        self.width = width
        self.height = height
        self.bytes = bytes
    }
}
