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

    /// Landscape: no title bar, Projects bottom left, search and New session bottom right (the
    /// system's bottom bar, which the Duo moves into its margins), the board running under them.
    func testBoardLandscape() async throws {
        // The iPad's portrait board is already this layout (iPad scenes don't take the geometry request).
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "the iPad board is chromeless in portrait too")
        try await screen("board-landscape", landscape: true) { RootView() }
    }

    /// A Plus or Pro Max phone in landscape is regular width, which brings the iPad's sidebar layout.
    func testBoardLandscapeRegularWidth() async throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad || ReferenceImages.device == "duo", "a phone's layout")
        try await screen("board-landscape-regular", landscape: true, regularWidth: true) { RootView() }
    }

    /// A ticket docked: its card floats above the system bottom bar, which stays where the system puts it.
    func testBoardDocked() async throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "the iPad's cards are a corner stack beside its panel")
        let router = Router()
        router.openTicket(key: "HARNESS-4", tab: .spec)
        router.dockSheet()
        try await screen("board-docked", router: router) { RootView() }
    }

    /// A ticket open with another one docked: the composer sits above the card.
    func testTicketWithDockedCard() async throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "the iPad's cards are a corner stack beside its panel")
        let router = Router()
        router.openTicket(key: "HARNESS-4", tab: .spec)
        router.dockSheet()
        router.openTicket(key: "HARNESS-5", tab: .spec)
        try await screen("ticket-docked-card", router: router) { RootView() }
    }

    func testProjectsSheet() async throws {
        let router = Router()
        router.present(.projects)
        try await screen("projects", router: router) { RootView() }
    }

    /// A grouped project's settings: the Group picker and, under it, the Group name row that renames the group for every project in it.
    func testProjectSettingsGroup() async throws {
        let router = Router()
        router.push(.project(id: "project-HARNESS"))
        try await screen("project-settings-group", router: router) { RootView() }
    }

    func testInbox() async throws {
        try await screen("inbox", router: Router(selectedTab: .inbox)) { RootView() }
    }

    func testSettings() async throws {
        // A sheet on the phone (Router.open decides by width), a section on the iPad.
        let router = UIDevice.current.userInterfaceIdiom == .pad ? Router(selectedTab: .settings) : Router()
        if router.selectedTab != .settings { router.present(.settings) }
        try await screen("settings", router: router) { RootView() }
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

    /// HARNESS-4: blocked on a question for the human, no restart time: the Unblock button shows.
    func testTicketBlocked() async throws {
        try await screen("ticket-blocked", router: ticket("HARNESS-4", .spec)) { RootView() }
    }

    /// HARNESS-5 with the human review approved and its complete run going: the disabled "Moving to done…" shows.
    func testTicketCompleting() async throws {
        var json = try WorldJSON.load()
        json.patch("HARNESS-5", ["humanReview": "approved", "busy": true, "completing": true])
        let completing = await ScreenWorld(json)
        let image = try await render(completing, router: ticket("HARNESS-5", .spec)) { RootView() }
        ReferenceImages.assert(image, named: "ticket-completing")
        XCTAssertEqual(completing.transport.unrouted, [])
    }

    /// HARNESS-8: a conductor, with its two children on the Tickets tab.
    func testTicketChildren() async throws {
        try await screen("ticket-children", router: ticket("HARNESS-8", .children)) { RootView() }
    }

    /// HARNESS-9, a child of HARNESS-8 pushed onto its sheet: the glass Back circle and the "Part of" row.
    func testTicketChild() async throws {
        let router = ticket("HARNESS-8", .children)
        router.push(.ticket(key: "HARNESS-9", tab: .spec))
        try await screen("ticket-child", router: router) { RootView() }
    }

    /// The same child on a tab that collapses the hero: the Back circle keeps its inset from the sheet's corner.
    func testTicketChildCollapsed() async throws {
        let router = ticket("HARNESS-8", .children)
        router.push(.ticket(key: "HARNESS-9", tab: .activity))
        try await screen("ticket-child-collapsed", router: router) { RootView() }
    }

    /// A markdown file on its rendered view, drawn by the Spec tab's renderer.
    func testFileViewerRendered() async throws {
        try await screen("file-rendered") { NavigationStack { FileViewerScreen(params: FileRouteParams(path: "README.md", ticket: "HARNESS-5"), startRendered: true) } }
    }

    func testFileViewer() async throws {
        try await screen("file") { NavigationStack { FileViewerScreen(params: FileRouteParams(path: "src/board.ts", ticket: "HARNESS-5")) } }
    }
}
