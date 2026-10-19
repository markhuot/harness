import SwiftUI
import UIKit
@testable import Harness

/// Renders a SwiftUI view in a real window of the host app and returns its pixels.
///
/// The window sits in the app's scene, so the view gets the simulator's real traits (size class,
/// safe areas). It is deterministic: scale 2, animations off, and the capture repeats until
/// `stableFrames` consecutive frames are identical and the world's transport has nothing in flight.
/// A screen that never settles (an animation, a request that never ends) fails instead of
/// recording a half-drawn frame.
@MainActor
enum Renderer {
    struct Unsettled: Error, CustomStringConvertible {
        let inflight: Int
        var description: String { "the view kept changing for \(Renderer.maxFrames) frames (an animation, a timer, or \(inflight) request(s) that never finish)" }
    }

    nonisolated static let scale: CGFloat = 2
    nonisolated static let maxFrames = 300
    nonisolated static let minFrames = 4
    nonisolated static let stableFrames = 3

    static var screenSize: CGSize {
        (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.size ?? CGSize(width: 402, height: 874)
    }

    /// Turns the scene to landscape or back to portrait and waits until the screen has the new shape,
    /// so the render gets the real landscape size, safe areas and size classes.
    static func rotate(landscape: Bool) async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        func isLandscape() -> Bool { scene.screen.bounds.width > scene.screen.bounds.height }
        guard isLandscape() != landscape else { return }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: landscape ? .landscapeRight : .portrait)) { _ in }
        for _ in 0..<100 where isLandscape() != landscape { try await Task.sleep(for: .milliseconds(50)) }
        guard isLandscape() == landscape else { throw Rotation.stuck(landscape) }
        try await Task.sleep(for: .milliseconds(300))
    }

    enum Rotation: Error { case stuck(Bool) }

    /// The iPad's safe area the references were recorded under (an iPad Pro 11-inch, portrait, Full Screen Apps):
    /// the status bar's 32 points on top and 25 below. A fresh simulator starts in Windowed Apps (20 below, and
    /// a window the walkthrough's taps don't get through), and an older one has been seen drawing every
    /// screen 22 points higher. Another state draws every screen at another offset, so the render stops with the values
    /// rather than correcting them: a layout regression can't hide behind a normalisation, and a diff that
    /// is only a shifted image isn't read as one.
    struct SceneMismatch: Error, CustomStringConvertible {
        let found: String
        var description: String {
            "the simulator isn't in the state the iPad references were recorded in: \(found); expected the iPad Pro 11-inch in portrait (834 x 1210), safe area top 32 and bottom 25 (Settings > Multitasking & Gestures > Full Screen Apps). Put it back and render again; re-recording would bake the shifted layout into the references."
        }
    }

    static func checkSceneMatchesReferences(window: UIWindow, scene: UIWindowScene?, size: CGSize) throws {
        guard UIDevice.current.userInterfaceIdiom == .pad, size.width == 834 || size.width == 1210 else { return }
        let insets = window.safeAreaInsets
        let portrait = size.width < size.height
        // A landscape iPad turns the insets; only portrait is pinned.
        guard portrait, insets.top != 32 || insets.bottom != 25 else { return }
        throw SceneMismatch(found: "screen \(size.width) x \(size.height), safe area top \(insets.top) bottom \(insets.bottom), status bar \(scene?.statusBarManager?.statusBarFrame.height ?? -1)")
    }

    /// `regularWidth` renders a landscape phone as a Plus or Pro Max does: regular width, compact height.
    static func render<V: View>(_ view: V, world: ScreenWorld, dark: Bool = false, landscape: Bool = false, regularWidth: Bool = false) async throws -> UIImage {
        UIView.setAnimationsEnabled(false)
        try await rotate(landscape: landscape)
        let size = screenSize
        let style: UIUserInterfaceStyle = dark ? .dark : .light
        let root = UIHostingController(rootView: view.transaction { $0.animation = nil; $0.disablesAnimations = true })
        root.overrideUserInterfaceStyle = style
        let host: UIViewController
        if regularWidth {
            let parent = UIViewController()
            parent.addChild(root)
            root.view.frame = parent.view.bounds
            root.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            parent.view.addSubview(root.view)
            root.didMove(toParent: parent)
            parent.setOverrideTraitCollection(UITraitCollection(horizontalSizeClass: .regular), forChild: root)
            host = parent
        } else {
            host = root
        }
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
        window.frame = CGRect(origin: .zero, size: size)
        window.windowLevel = .alert + 100
        window.overrideUserInterfaceStyle = style
        window.rootViewController = host
        window.isHidden = false
        try checkSceneMatchesReferences(window: window, scene: scene, size: size)
        defer {
            window.isHidden = true
            window.rootViewController = nil
            docks(in: scene).forEach { $0.isHidden = true; $0.rootViewController = nil }
        }

        var previous: Data?
        var stable = 0
        for frame in 0..<maxFrames {
            await FrameClock.tick()
            window.layoutIfNeeded()
            freezeLoops(in: window)
            // The phone's dock is a window of its own above the screen (RootView makes it): drawn over it.
            let dockWindows = docks(in: scene)
            for dock in dockWindows {
                dock.overrideUserInterfaceStyle = style
                dock.rootViewController?.overrideUserInterfaceStyle = style
                dock.layoutIfNeeded()
            }
            dockWindows.forEach { freezeLoops(in: $0) }
            let image = capture([window] + dockWindows, size: size)
            let png = image.pngData()
            // A frame only counts as settled while the service has nothing left to answer.
            stable = png != nil && png == previous && world.transport.inflight == 0 ? stable + 1 : 0
            previous = png
            if stable >= stableFrames && frame >= minFrames { return image }
        }
        throw Unsettled(inflight: world.transport.inflight)
    }

    /// A spinner or a pulse that repeats forever would make every frame differ from the last, so a
    /// busy ticket's indicator never settles. Frozen where it stands, as Reduce Motion would leave it.
    private static func freezeLoops(in window: UIWindow) {
        func freeze(_ view: UIView) {
            (view as? UIActivityIndicatorView).map { $0.hidesWhenStopped = false; $0.stopAnimating() }
            freeze(view.layer)
            view.subviews.forEach(freeze)
        }
        func freeze(_ layer: CALayer) {
            for key in layer.animationKeys() ?? [] {
                guard let animation = layer.animation(forKey: key) else { continue }
                if animation.repeatCount == .infinity || animation.repeatDuration == .infinity { layer.removeAnimation(forKey: key) }
            }
            layer.sublayers?.forEach(freeze)
        }
        freeze(window)
    }

    private static func docks(in scene: UIWindowScene?) -> [UIWindow] {
        (scene?.windows ?? []).filter { $0 is DockWindow }
    }

    /// `windows` drawn in order, the first as the base. A transparent window drawn straight over it
    /// blacks the base out, so each later window is drawn over a picture of what is below it.
    private static func capture(_ windows: [UIWindow], size: CGSize) -> UIImage {
        func format() -> UIGraphicsImageRendererFormat {
            let f = UIGraphicsImageRendererFormat()
            f.scale = scale
            f.opaque = true
            f.preferredRange = .standard
            return f
        }
        func draw(_ window: UIWindow, below: UIImage?) -> UIImage {
            let backdrop = below.map { UIImageView(image: $0) }
            if let backdrop {
                backdrop.frame = CGRect(origin: .zero, size: size)
                window.insertSubview(backdrop, at: 0)
            }
            defer { backdrop?.removeFromSuperview() }
            return UIGraphicsImageRenderer(size: size, format: format()).image { _ in
                window.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: true)
            }
        }
        return windows.dropFirst().reduce(draw(windows[0], below: nil)) { base, window in
            guard let dock = window as? DockWindow, dock.hit.fullScreen || !dock.hit.rects.isEmpty else { return base }
            let over = draw(window, below: base)
            let clip = dock.hit.fullScreen ? CGRect(origin: .zero, size: size)
                : dock.hit.rects.dropFirst().reduce(dock.hit.rects[0]) { $0.union($1) }.insetBy(dx: -40, dy: -40)
            return UIGraphicsImageRenderer(size: size, format: format()).image { context in
                base.draw(at: .zero)
                context.cgContext.clip(to: clip)
                over.draw(at: .zero)
            }
        }
    }
}
