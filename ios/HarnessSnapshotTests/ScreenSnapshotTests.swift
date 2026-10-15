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
