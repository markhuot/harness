import SwiftUI
import UIKit

/// Renders a SwiftUI view in a real window at a fixed size and appearance, and returns the pixels.
///
/// The window sits in the host app's scene, so the view gets the real traits (size class, safe
/// areas, dynamic type) of the simulator it runs on. Output is deterministic: scale 2, animations
/// off, and the render repeats until two consecutive frames are identical (SwiftUI settles over a
/// few run-loop turns), so a screen that never settles fails instead of recording a half-drawn frame.
@MainActor
enum SnapshotRenderer {
    enum Appearance: String, CaseIterable {
        case light, dark
        var style: UIUserInterfaceStyle { self == .dark ? .dark : .light }
    }

    struct Unsettled: Error, CustomStringConvertible {
        var description: String { "the view kept changing for \(SnapshotRenderer.maxFrames) frames (an animation, a timer or a request that never finishes)" }
    }

    nonisolated static let scale: CGFloat = 2
    nonisolated static let maxFrames = 150
    nonisolated static let minFrames = 6
    nonisolated static let stableFrames = 3

    /// The simulator's screen: the window every snapshot fills.
    static var screenSize: CGSize {
        (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.size ?? CGSize(width: 402, height: 874)
    }

    static func render<V: View>(_ view: V, appearance: Appearance, size: CGSize? = nil) async throws -> UIImage {
        UIView.setAnimationsEnabled(false)
        let size = size ?? screenSize
        let root = UIHostingController(rootView: view.transaction { $0.animation = nil; $0.disablesAnimations = true })
        root.overrideUserInterfaceStyle = appearance.style
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
        window.frame = CGRect(origin: .zero, size: size)
        window.windowLevel = .alert + 100
        window.overrideUserInterfaceStyle = appearance.style
        window.rootViewController = root
        window.isHidden = false
        defer { window.isHidden = true; window.rootViewController = nil }

        // A sheet or a push starts a few frames after the first draw, so a single repeat doesn't
        // mean settled: wait for `stableFrames` identical captures in a row, after at least `minFrames`.
        var previous: Data?
        var stable = 0
        for frame in 0..<maxFrames {
            try await Task.sleep(for: .milliseconds(40))
            window.layoutIfNeeded()
            let image = capture(window, size: size)
            let png = image.pngData()
            stable = png != nil && png == previous ? stable + 1 : 0
            previous = png
            if stable >= stableFrames && frame >= minFrames { return image }
        }
        throw Unsettled()
    }

    private static func capture(_ window: UIWindow, size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        format.preferredRange = .standard
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            window.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: true)
        }
    }
}
