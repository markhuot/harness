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
        for key in [Router.persistedDockKey, "planUsageFilter", "planUsageMode", "browserSizeRowOpen", "harness.git.viewed", "harness.git.diffStyle"] {
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
}
