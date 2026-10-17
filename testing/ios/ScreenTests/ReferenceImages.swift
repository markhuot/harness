import CoreGraphics
import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest

/// Compares a rendered screen with its reference PNG in testing/ios/references/<device>/.
///
/// - A pixel counts as different when any colour channel is more than `channelTolerance` off (the
///   anti-aliasing noise between two renders of the same view), and the screen fails when more than
///   `pixelBudget` of its pixels differ: a few stray pixels pass, a moved or recoloured element doesn't.
/// - A missing reference fails and says how to record it. References are written only when
///   `HARNESS_RECORD=1` (`bun run testing ios --record`), never as a side effect of a run.
/// - A mismatch writes the actual image and a diff (differing pixels red over a faded reference) to
///   `HARNESS_FAILURES` (the runner's temp dir) and says where.
/// - `HARNESS_OUT=<dir>` also writes every rendered image there (for a spec's screenshots).
enum ReferenceImages {
    static let channelTolerance = 2
    static let pixelBudget = 0.0005

    static let env = ProcessInfo.processInfo.environment
    static var recording: Bool { env["HARNESS_RECORD"] == "1" }
    static var outDir: URL? { env["HARNESS_OUT"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } }
    static let testingDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone" }
    static var referenceDir: URL { testingDir.appending(path: "ios/references/\(device)") }
    static var failureDir: URL {
        (env["HARNESS_FAILURES"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory.appending(path: "harness-screens")).appending(path: device)
    }

    struct Pixels {
        var width: Int
        var height: Int
        var bytes: [UInt8]

        init(width: Int, height: Int, bytes: [UInt8]) {
            self.width = width
            self.height = height
            self.bytes = bytes
        }

        init?(_ image: CGImage) {
            width = image.width
            height = image.height
            bytes = [UInt8](repeating: 0, count: width * height * 4)
            let w = width, h = height
            let drew = bytes.withUnsafeMutableBytes { buffer -> Bool in
                guard let context = CGContext(
                    data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                else { return false }
                context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
                return true
            }
            if !drew { return nil }
        }

        func png() -> Data? {
            var copy = bytes
            let w = width, h = height
            return copy.withUnsafeMutableBytes { buffer -> Data? in
                guard let context = CGContext(
                    data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
                    let image = context.makeImage() else { return nil }
                return ReferenceImages.png(image)
            }
        }
    }

    struct Difference {
        var differing: Int
        var total: Int
        var fraction: Double { total == 0 ? 0 : Double(differing) / Double(total) }
        /// RGBA: red where the images differ, a faded reference elsewhere.
        var picture: [UInt8]
    }

    /// Nil when the images aren't the same size.
    static func compare(_ a: Pixels, _ b: Pixels, channelTolerance: Int = channelTolerance) -> Difference? {
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
        return Difference(differing: differing, total: a.width * a.height, picture: picture)
    }

    static func png(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }

    static func cgImage(_ data: Data) -> CGImage? {
        CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
    }

    /// Checks `image` against `<name>.png`, reporting through XCTest at `file:line`.
    static func assert(_ image: UIImage, named name: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let cg = image.cgImage, let actual = Pixels(cg), let data = png(cg) else {
            XCTFail("\(name): couldn't read the rendered image", file: file, line: line)
            return
        }
        let fm = FileManager.default
        if let out = outDir?.appending(path: device) {
            try? fm.createDirectory(at: out, withIntermediateDirectories: true)
            try? data.write(to: out.appending(path: "\(name).png"))
        }
        let referenceURL = referenceDir.appending(path: "\(name).png")
        if recording {
            try? fm.createDirectory(at: referenceDir, withIntermediateDirectories: true)
            do { try data.write(to: referenceURL) } catch { XCTFail("\(name): couldn't write \(referenceURL.path): \(error)", file: file, line: line) }
            return
        }
        guard let stored = try? Data(contentsOf: referenceURL), let refImage = cgImage(stored), let reference = Pixels(refImage) else {
            XCTFail("\(name): no reference image at \(referenceURL.path). Record it: bun run testing ios --record", file: file, line: line)
            return
        }
        try? fm.createDirectory(at: failureDir, withIntermediateDirectories: true)
        let actualURL = failureDir.appending(path: "\(name).actual.png")
        let diffURL = failureDir.appending(path: "\(name).diff.png")
        guard let difference = compare(actual, reference) else {
            try? data.write(to: actualURL)
            XCTFail("\(name): the image is \(actual.width)x\(actual.height) px, the reference \(reference.width)x\(reference.height). Actual: \(actualURL.path)", file: file, line: line)
            return
        }
        if difference.fraction <= pixelBudget { return }
        try? data.write(to: actualURL)
        if let picture = Pixels(width: actual.width, height: actual.height, bytes: difference.picture).png() { try? picture.write(to: diffURL) }
        let percent = String(format: "%.2f", difference.fraction * 100)
        XCTFail("\(name): \(difference.differing) of \(difference.total) pixels differ (\(percent)%).\n  reference: \(referenceURL.path)\n  actual:    \(actualURL.path)\n  diff:      \(diffURL.path)\nIf the change is intended: bun run testing ios --record", file: file, line: line)
    }
}
