import HarnessKit
import SwiftUI
import XCTest
@testable import Harness

/// The app's primary screens, rendered from the shared world through the real client and stores,
/// one configuration per device (light, default type size). What a render needs from the world is
/// named in the test; changing the world changes these images (SeamTests proves it).
@MainActor
final class ScreenTests: ScreenTestCase {
    func testBoard() async throws {
        try await screen("board") { RootView() }
    }

    func testProjectsSheet() async throws {
        let router = Router()
        router.present(.projects)
        try await screen("projects", router: router) { RootView() }
    }

    func testInbox() async throws {
        try await screen("inbox", router: Router(selectedTab: .inbox)) { RootView() }
    }

    func testSettings() async throws {
        try await screen("settings", router: Router(selectedTab: .settings)) { RootView() }
    }

    func testPalette() async throws {
        try await screen("palette") { NavigationStack { PaletteScreen(startInFiles: false, autofocus: false) } }
    }

    private func ticket(_ key: String, _ tab: TicketTab) -> Router {
        let router = Router()
        router.openTicket(key: key, tab: tab)
        return router
    }

    /// HARNESS-5: in review, agent review passed, a branch with changes: the approve actions show.
    func testTicketSpec() async throws {
        try await screen("ticket-spec", router: ticket("HARNESS-5", .spec)) { RootView() }
    }

    func testTicketActivity() async throws {
        try await screen("ticket-activity", router: ticket("HARNESS-5", .activity)) { RootView() }
    }

    func testTicketDetails() async throws {
        try await screen("ticket-details", router: ticket("HARNESS-5", .details)) { RootView() }
    }

    /// HARNESS-5's finished run: a message, the agent's text, a tool call and its result.
    func testTicketTranscript() async throws {
        try await screen("ticket-transcript", router: ticket("HARNESS-5", .transcript)) { RootView() }
    }

    /// HARNESS-8: a conductor, with its two children on the Tickets tab.
    func testTicketChildren() async throws {
        try await screen("ticket-children", router: ticket("HARNESS-8", .children)) { RootView() }
    }

    /// A markdown file on its rendered view, drawn by the Spec tab's renderer.
    func testFileViewerRendered() async throws {
        try await screen("file-rendered") { NavigationStack { FileViewerScreen(params: FileRouteParams(path: "README.md", ticket: "HARNESS-5"), startRendered: true) } }
    }

    func testFileViewer() async throws {
        try await screen("file") { NavigationStack { FileViewerScreen(params: FileRouteParams(path: "src/board.ts", ticket: "HARNESS-5")) } }
    }
}
