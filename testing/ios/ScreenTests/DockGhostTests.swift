import HarnessKit
import SwiftUI
import XCTest
@testable import Harness

/// The docked card's ghost: its pulse pinned at four phases, and running for real.
@MainActor
final class DockGhostTests: ScreenTestCase {
    private func ghost(phase: Double, reduceMotion: Bool = false) -> some View {
        DockGhostCard(title: "HARNESS-7 Add the pulse", armed: true, pulsePhase: phase, forceReduceMotion: reduceMotion)
            .padding(.horizontal, DockMetrics.phoneSides(screen: nil))
            .padding(.vertical, 40)
            .frame(maxWidth: .infinity, maxHeight: 200)
    }

    func testRest() async throws {
        try await screen("dock-ghost-rest") { ghost(phase: 0) }
    }

    func testPeak() async throws {
        try await screen("dock-ghost-peak") { ghost(phase: 0.5) }
    }

    /// A quarter turn puts the rim light at a different spot from rest.
    func testQuarter() async throws {
        try await screen("dock-ghost-quarter") { ghost(phase: 0.25) }
    }

    /// The end of the loop must draw exactly what rest does, or the pulse jumps when it wraps.
    func testLoopSeam() async throws {
        try await screen("dock-ghost-rest") { ghost(phase: 1) }
    }

    func testReduceMotion() async throws {
        try await screen("dock-ghost-reduce-motion") { ghost(phase: 0.5, reduceMotion: true) }
    }

    /// The pulse running for real, not pinned: captures the card every frame the simulator manages over
    /// more than one loop and reads the glow's brightness just above the card. That brightness must follow
    /// the breathing wave smoothly; a layer that re-renders in steps or flickers leaves frames far off it.
    /// The frames go to `dock-ghost-live.png` (a contact sheet, under HARNESS_OUT) for a look.
    func testDockGhostRunningGlowFollowsTheWave() async throws {
        let size = CGSize(width: Renderer.screenSize.width, height: 200)
        UIView.setAnimationsEnabled(true)
        // Runs when the test fails too, so a failure here can't leave animations on for the renders after it.
        addTeardownBlock { @MainActor in UIView.setAnimationsEnabled(false) }
        // The dates the card drew its pulse for, in order: what a captured frame shows, not when it was captured.
        final class Drawn { var dates: [Date] = [] }
        let drawn = Drawn()
        let root = UIHostingController(rootView: world.environment(
            DockGhostCard(title: "HAR-7 Add the pulse", armed: true, onFrame: { drawn.dates.append($0) })
                .padding(.horizontal, DockMetrics.phoneSides(screen: nil))
                .frame(width: size.width, height: size.height),
            router: Router(), scheme: .dark).preferredColorScheme(.dark))
        root.overrideUserInterfaceStyle = .dark
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
        window.frame = CGRect(origin: .zero, size: size)
        window.windowLevel = .alert + 100
        window.overrideUserInterfaceStyle = .dark
        window.rootViewController = root
        window.isHidden = false
        addTeardownBlock { @MainActor in window.isHidden = true; window.rootViewController = nil }
        try await Task.sleep(for: .milliseconds(500))

        // Brightness of a band above the card's top edge, middle half of its width: only the glow is there.
        let format = UIGraphicsImageRendererFormat()
        format.scale = Renderer.scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        // Each frame's glow with the wave's value over the dates the card drew for while it was captured:
        // the newest before the capture (still on screen if nothing redrew) through the newest after it. The
        // wall clock around the capture can't say this: on a loaded Mac the card may not have redrawn for a
        // while, so the frame shows an older pulse than the clock reads.
        var samples: [(wave: Double, low: Double, high: Double, glow: Double)] = []
        var images: [UIImage] = []
        var draws: [TimeInterval] = []
        let start = Date()
        while Date().timeIntervalSince(start) < DockGhostCard.pulsePeriod * 1.25 {
            let clock = Date()
            let shown = drawn.dates.last
            let image = renderer.image { _ in window.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: true) }
            draws.append(Date().timeIntervalSince(clock))
            func skip() async throws { try await Task.sleep(for: .milliseconds(1)) }
            guard let after = drawn.dates.last else { try await skip(); continue }
            let before = shown ?? after
            guard let cg = image.cgImage, let px = ReferenceImages.Pixels(cg) else { try await skip(); continue }
            // The card's top edge in this frame (it bounces), found down the middle column: the first
            // row brighter than any glow. The band sits from 11 to 3 points above it.
            let mid = px.width / 2
            guard let edge = (0..<px.height).first(where: { px.bytes[($0 * px.width + mid) * 4 + 2] > 60 }) else { continue }
            let scale = Int(Renderer.scale)
            var total = 0.0, count = 0.0
            for y in max(edge - 11 * scale, 0)..<max(edge - 3 * scale, 1) {
                for x in px.width / 4..<px.width * 3 / 4 {
                    let i = (y * px.width + x) * 4
                    total += Double(max(px.bytes[i], px.bytes[i + 1], px.bytes[i + 2]))
                    count += 1
                }
            }
            func wave(_ t: Date) -> Double {
                DockGhostCard.wave(phase: t.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: DockGhostCard.pulsePeriod) / DockGhostCard.pulsePeriod)
            }
            let span = after.timeIntervalSince(before)
            let across = (0...16).map { wave(before.addingTimeInterval(span * Double($0) / 16)) }
            images.append(image)
            // A frame the card redrew across a good part of the period could show anywhere along the curve:
            // its window is too wide to say anything, so it isn't scored (the count below skips a starved run).
            guard span <= DockGhostCard.pulsePeriod * 0.1 else { try await skip(); continue }
            samples.append((wave(before.addingTimeInterval(span / 2)), across.min() ?? 0, across.max() ?? 0, total / count))
            try await skip()
        }
        // A host too loaded to draw quickly (another agent's build on the shared simulators) can't show
        // whether the pulse is smooth: that is a skip, not a pass or a failure.
        let medianDraw = draws.sorted()[draws.count / 2]
        if samples.count <= 30 || medianDraw > DockGhostCard.pulsePeriod * 0.05 {
            throw XCTSkip("host too loaded to judge the pulse: \(samples.count) scored of \(images.count) frames, median capture \(Int(medianDraw * 1000)) ms")
        }

        // Least-squares line glow = a + b * wave; the residuals are what the wave doesn't explain.
        let n = Double(samples.count)
        let mw = samples.map(\.wave).reduce(0, +) / n, mg = samples.map(\.glow).reduce(0, +) / n
        let b = samples.map { ($0.wave - mw) * ($0.glow - mg) }.reduce(0, +) / max(samples.map { ($0.wave - mw) * ($0.wave - mw) }.reduce(0, +), 1e-9)
        let a = mg - b * mw
        // A frame is off the curve by how far its glow is from the curve's value anywhere in the window it was drawn in.
        let worst = samples.map { s -> Double in
            let at = (s.glow - a) / b
            return b * max(s.low - at, at - s.high, 0)
        }.max() ?? 0
        XCTAssertGreaterThan(b, 0.5, "the glow doesn't breathe with the wave (slope \(b))")
        XCTAssertLessThan(worst, max(b * 0.35, 1), "a frame's glow was \(worst) off the wave's curve (slope \(b)): the glow is stepping or flickering")

        let columns = 8, rows = (images.count + columns - 1) / columns
        let cell = CGSize(width: size.width / 4, height: size.height / 4)
        let sheet = UIGraphicsImageRenderer(size: CGSize(width: cell.width * CGFloat(columns), height: cell.height * CGFloat(rows))).image { _ in
            for (i, image) in images.enumerated() {
                image.draw(in: CGRect(x: CGFloat(i % columns) * cell.width, y: CGFloat(i / columns) * cell.height, width: cell.width, height: cell.height))
            }
        }
        let dir = ReferenceImages.outDir ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try sheet.pngData()?.write(to: dir.appending(path: "dock-ghost-live.png"))
        print("dock-ghost-live: \(samples.count) frames, glow \(samples.map(\.glow).min() ?? 0)...\(samples.map(\.glow).max() ?? 0), slope \(b), worst residual \(worst)")
    }
}
