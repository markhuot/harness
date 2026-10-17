import HarnessKit
import SwiftUI
import XCTest
@testable import Harness

/// The app's main screens rendered from fixture models (SnapshotWorld), in light and dark, on the
/// simulator the run uses (iPhone or iPad: References/<device>/). Flows that need real taps, a
/// daemon or the keyboard stay in sim-check.
@MainActor
final class ScreenSnapshotTests: XCTestCase {
    var world: SnapshotWorld!

    override func setUp() async throws {
        continueAfterFailure = true
        Self.resetPersistedState()
        world = await SnapshotWorld()
    }

    override func tearDown() async throws {
        Self.resetPersistedState()
    }

    /// RootView saves and restores what the user left open (the docked tickets) and a few view
    /// settings in UserDefaults, so a screen would otherwise render whatever the last test, or the
    /// last real session on this simulator, left behind.
    static func resetPersistedState() {
        let defaults = UserDefaults.standard
        for key in [Router.persistedDockKey, "planUsageFilter", "planUsageMode", "browserSizeRowOpen", "harness.git.viewed", "harness.git.diffStyle", PaletteCommandRecents.key, PaletteRecents.filesKey] {
            defaults.removeObject(forKey: key)
        }
    }

    /// Renders `content` in both appearances and checks each against its reference.
    func snapshot<V: View>(_ name: String, router makeRouter: () -> Router = { Router() }, file: StaticString = #filePath, line: UInt = #line, @ViewBuilder _ content: () -> V) async throws {
        let view = content()
        for appearance in SnapshotRenderer.Appearance.allCases {
            let scheme: ColorScheme = appearance == .dark ? .dark : .light
            let image: UIImage
            // A fresh router and clean defaults per render: tearing down the light render's window
            // closes the tickets on the shared router, so the dark one would show the board.
            Self.resetPersistedState()
            let router = makeRouter()
            do {
                image = try await SnapshotRenderer.render(
                    world.environment(view, router: router, scheme: scheme).preferredColorScheme(scheme), appearance: appearance)
            } catch {
                XCTFail("\(name)-\(appearance.rawValue): render threw \(type(of: error)): \(String(reflecting: error))", file: file, line: line)
                continue
            }
            SnapshotAssert.assert(image, named: "\(name)-\(appearance.rawValue)", file: file, line: line)
        }
    }

    func testBoard() async throws {
        try await snapshot("board") { RootView() }
    }

    /// The palette's rows: its commands, then tickets matching a query, and the focused ticket's actions
    /// when a ticket sheet is open; and the commands at an accessibility text size.
    func testPaletteCommands() async throws {
        try await snapshot("palette-commands") { NavigationStack { PaletteScreen(startInFiles: false, autofocus: false) } }
    }

    func testPaletteTickets() async throws {
        try await snapshot("palette-tickets") { NavigationStack { PaletteScreen(startInFiles: false, initialText: "har", autofocus: false) } }
    }

    func testPaletteCommandsOnly() async throws {
        try await snapshot("palette-commands-only") { NavigationStack { PaletteScreen(startInFiles: false, initialText: "> set", autofocus: false) } }
    }

    func testPaletteTicketActions() async throws {
        try await snapshot("palette-ticket-actions", router: {
            let router = Router()
            router.openTicket(key: "HAR-7", tab: .spec)
            return router
        }) { NavigationStack { PaletteScreen(startInFiles: false, autofocus: false) } }
    }

    /// Terminals are rows of their own: the title or program, the folder and the program, newest first.
    func testPaletteTerminals() async throws {
        try await snapshot("palette-terminals") { NavigationStack { PaletteScreen(startInFiles: false, initialText: "term", autofocus: false) } }
    }

    /// A terminal sheet: its chrome and the accessory bar (the page itself is a web view, empty here).
    func testTerminalSheet() async throws {
        try await snapshot("terminal-sheet", router: {
            let router = Router()
            router.openTerminal(id: "t-dev")
            return router
        }) { RootView() }
    }

    /// A terminal docked beside tickets: its card shows the title, folder and program.
    func testDockWithTerminal() async throws {
        try await snapshot("dock-terminal", router: {
            let router = Router()
            router.openTicket(key: "HAR-7", tab: .spec)
            router.openTerminal(id: "t-dev")
            router.dockSheet()
            return router
        }) { RootView() }
    }

    func testPaletteLargeType() async throws {
        try await snapshot("palette-large-type") {
            NavigationStack { PaletteScreen(startInFiles: false, autofocus: false) }.dynamicTypeSize(.accessibility2)
        }
    }

    func testTicketSpec() async throws {
        try await snapshot("ticket-spec", router: {
            let router = Router()
            router.openTicket(key: "HAR-7", tab: .spec)
            return router
        }) { RootView() }
    }

    func testTicketActivity() async throws {
        try await snapshot("ticket-activity", router: {
            let router = Router()
            router.openTicket(key: "HAR-7", tab: .activity)
            return router
        }) { RootView() }
    }

    /// The sheet a page's HTTP Basic Auth challenge opens over the Browser tab: first ask, a refused
    /// attempt, and an unencrypted origin.
    func testBrowserAuthSheet() async throws {
        try await snapshot("browser-auth") {
            BrowserAuthSheet(auth: BrowserAuth(origin: "https://staging.example.com", realm: "Staging"), submit: { _, _ in })
        }
        try await snapshot("browser-auth-refused-plain") {
            BrowserAuthSheet(auth: BrowserAuth(origin: "http://192.168.1.20:8080", realm: "Admin", failed: true), submit: { _, _ in })
        }
    }

    func testSheetFrame() async throws {
        try await snapshot("sheet-request-changes") {
            TicketDetailSheetFrame(title: "Request changes", subtitle: "HAR-7") {
                HButton("Send", variant: .primary, fullWidth: false, haptic: nil) {}
            } content: {
                Text("What should the agent change?").font(.scaled(size: 14))
                RoundedRectangle(cornerRadius: 10).strokeBorder(.secondary).frame(height: 110)
            }
        }
    }

    func testDockGhostRest() async throws {
        try await snapshot("dock-ghost-rest") { ghost(phase: 0) }
    }

    func testDockGhostPeak() async throws {
        try await snapshot("dock-ghost-peak") { ghost(phase: 0.5) }
    }

    /// A quarter turn puts the rim light at a different spot from rest.
    func testDockGhostQuarter() async throws {
        try await snapshot("dock-ghost-quarter") { ghost(phase: 0.25) }
    }

    /// The end of the loop must draw exactly what rest does, or the pulse jumps when it wraps.
    func testDockGhostLoopSeam() async throws {
        try await snapshot("dock-ghost-rest") { ghost(phase: 1) }
    }

    /// The pulse running for real, not pinned: captures the card every frame the simulator manages over
    /// more than one loop and reads the glow's brightness just above the card. That brightness must follow
    /// the breathing wave smoothly; a layer that re-renders in steps or flickers leaves frames far off it.
    /// The frames go to `dock-ghost-live.png` (a contact sheet, under SNAPSHOT_OUT) for a look.
    func testDockGhostRunningGlowFollowsTheWave() async throws {
        let size = CGSize(width: SnapshotRenderer.screenSize.width, height: 200)
        UIView.setAnimationsEnabled(true)
        let root = UIHostingController(rootView: world.environment(
            DockGhostCard(title: "HAR-7 Add the pulse", armed: true)
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
        defer { window.isHidden = true; window.rootViewController = nil }
        try await Task.sleep(for: .milliseconds(500))

        // Brightness of a band above the card's top edge, middle half of its width: only the glow is there.
        let format = UIGraphicsImageRendererFormat()
        format.scale = SnapshotRenderer.scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        var samples: [(wave: Double, glow: Double)] = []
        var images: [UIImage] = []
        let start = Date()
        while Date().timeIntervalSince(start) < DockGhostCard.pulsePeriod * 1.25 {
            let now = Date()
            let image = renderer.image { _ in window.drawHierarchy(in: CGRect(origin: .zero, size: size), afterScreenUpdates: true) }
            guard let cg = image.cgImage, let px = SnapshotAssert.Pixels(cg) else { continue }
            // The card's top edge in this frame (it bounces), found down the middle column: the first
            // row brighter than any glow. The band sits from 11 to 3 points above it.
            let mid = px.width / 2
            guard let edge = (0..<px.height).first(where: { px.bytes[($0 * px.width + mid) * 4 + 2] > 60 }) else { continue }
            let scale = Int(SnapshotRenderer.scale)
            var total = 0.0, count = 0.0
            for y in max(edge - 11 * scale, 0)..<max(edge - 3 * scale, 1) {
                for x in px.width / 4..<px.width * 3 / 4 {
                    let i = (y * px.width + x) * 4
                    total += Double(max(px.bytes[i], px.bytes[i + 1], px.bytes[i + 2]))
                    count += 1
                }
            }
            let phase = now.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: DockGhostCard.pulsePeriod) / DockGhostCard.pulsePeriod
            samples.append((DockGhostCard.wave(phase: phase), total / count))
            images.append(image)
            try await Task.sleep(for: .milliseconds(1))
        }
        XCTAssertGreaterThan(samples.count, 30, "too few frames to judge the pulse")

        // Least-squares line glow = a + b * wave; the residuals are what the wave doesn't explain.
        let n = Double(samples.count)
        let mw = samples.map(\.wave).reduce(0, +) / n, mg = samples.map(\.glow).reduce(0, +) / n
        let b = samples.map { ($0.wave - mw) * ($0.glow - mg) }.reduce(0, +) / max(samples.map { ($0.wave - mw) * ($0.wave - mw) }.reduce(0, +), 1e-9)
        let a = mg - b * mw
        let worst = samples.map { abs($0.glow - (a + b * $0.wave)) }.max() ?? 0
        XCTAssertGreaterThan(b, 0.5, "the glow doesn't breathe with the wave (slope \(b))")
        XCTAssertLessThan(worst, max(b * 0.35, 1), "a frame's glow was \(worst) off the wave's curve (slope \(b)): the glow is stepping or flickering")

        let columns = 8, rows = (images.count + columns - 1) / columns
        let cell = CGSize(width: size.width / 4, height: size.height / 4)
        let sheet = UIGraphicsImageRenderer(size: CGSize(width: cell.width * CGFloat(columns), height: cell.height * CGFloat(rows))).image { _ in
            for (i, image) in images.enumerated() {
                image.draw(in: CGRect(x: CGFloat(i % columns) * cell.width, y: CGFloat(i / columns) * cell.height, width: cell.width, height: cell.height))
            }
        }
        let dir = SnapshotAssert.outDir.map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try sheet.pngData()?.write(to: dir.appending(path: "dock-ghost-live.png"))
        print("dock-ghost-live: \(samples.count) frames, glow \(samples.map(\.glow).min() ?? 0)...\(samples.map(\.glow).max() ?? 0), slope \(b), worst residual \(worst)")
    }

    func testDockGhostReduceMotion() async throws {
        try await snapshot("dock-ghost-reduce-motion") {
            ghost(phase: 0.5, reduceMotion: true)
        }
    }

    private func ghost(phase: Double, reduceMotion: Bool = false) -> some View {
        DockGhostCard(title: "HAR-7 Add the pulse", armed: true, pulsePhase: phase, forceReduceMotion: reduceMotion)
            .padding(.horizontal, DockMetrics.phoneSides(screen: nil))
            .padding(.vertical, 40)
            .frame(maxWidth: .infinity, maxHeight: 200)
    }

    func testDock() async throws {
        try await snapshot("dock", router: {
            let router = Router()
            router.openTicket(key: "HAR-7", tab: .spec)
            router.openTicket(key: "HAR-3", tab: .activity)
            router.openTicket(key: "HAR-5", tab: nil)
            router.dockSheet()
            return router
        }) { RootView() }
    }

    /// A ticket open over the board with two others docked: the dock draws over the sheet, and the
    /// composer sits above it. The iPad's cards sit beside its panel, not over it (the panel's own tests).
    func testDockOverPresentedTicket() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "the phone's dock window")
        try await snapshot("dock-over-ticket", router: {
            let router = Router()
            router.openTicket(key: "HAR-7", tab: .spec)
            router.openTicket(key: "HAR-3", tab: .activity)
            router.openTicket(key: "HAR-5", tab: nil)
            return router
        }) { RootView() }
    }
}
