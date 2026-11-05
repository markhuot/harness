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
        let router = Router()
        router.openTicket(key: "HARNESS-4", tab: .spec)
        router.dockSheet()
        try await screen("board-docked", router: router) { RootView() }
    }

    /// A ticket open with another one docked: the composer sits above the card.
    func testTicketWithDockedCard() async throws {
        let router = Router()
        router.openTicket(key: "HARNESS-4", tab: .spec)
        router.dockSheet()
        router.openTicket(key: "HARNESS-5", tab: .spec)
        try await screen("ticket-docked-card", router: router) { RootView() }
    }

    /// The iPad turned to landscape: the card stays phone-wide and rests above the sheet's composer.
    func testTicketWithDockedCardLandscape() async throws {
        try XCTSkipUnless(ReferenceImages.device == "ipad", "the iPad's form sheet")
        let router = Router()
        router.openTicket(key: "HARNESS-4", tab: .spec)
        router.dockSheet()
        router.openTicket(key: "HARNESS-5", tab: .spec)
        try await screen("ticket-docked-card-landscape", router: router, landscape: true) { RootView() }
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

    /// The board's Chief of Staff button, with its count pill, opened: the chat in the ticket sheet
    /// (the iPhone's sheet, the iPad's side panel).
    func testCosChat() async throws {
        let router = Router()
        router.openCos(scope: "all")
        try await screen("cos-chat", router: router) { RootView() }
    }

    /// The chief's composer holding a draft another device started: its text and a file in the tray
    /// over the glass field, with (+) and Send.
    func testCosChatDraft() async throws {
        let draft = MessageDraft(
            text: "Can you hold the migration until I answer?",
            attachments: [Attachment(id: "att-draft", path: "/uploads/att-draft/notes.txt", name: "notes.txt", source: .upload, kind: .file, mimeType: "text/plain", size: 120)],
            origin: "phone", updatedAt: 1)
        world.store.updateCos { $0.chiefs["cos-all"]?.messageDraft = .value(draft) }
        let router = Router()
        router.openCos(scope: "all")
        try await screen("cos-chat-draft", router: router) { RootView() }
    }

    /// The chief waiting on a permission request: the approval card under the chat, Allow once and
    /// Deny only (a watcher call is never allowed for good), and the composer without its (+).
    func testCosChatApproval() async throws {
        let approval = PendingApproval(id: "pa-cos", runId: "run-cos", toolName: "update_watcher", input: .object(["watcher": .string("work-feed"), "enabled": .bool(true)]),
                                       requestedAt: 0, summary: "Update watcher work-feed", onceOnly: true)
        world.store.updateCos { $0.chiefs["cos-all"]?.pendingApproval = approval }
        let router = Router()
        router.openCos(scope: "all")
        try await screen("cos-chat-approval", router: router) { RootView() }
    }

    /// The Inbox in every state: waiting, handling, ignored with its reason and Escalate anyway,
    /// escalated, handled, and a watcher item and a schedule.
    func testCosInbox() async throws {
        try await screen("cos-inbox") { NavigationStack { CosScreen(scope: "all", tab: .inbox) } }
    }

    /// The Work group's chief: nothing in its chat or Inbox yet.
    func testCosEmpty() async throws {
        try await screen("cos-empty") { NavigationStack { CosScreen(scope: "group:group-work", tab: .inbox) } }
    }

    /// The All chief's Listeners tab: an active listener with its next run, a paused loop and one whose last run failed.
    func testCosListeners() async throws {
        try await screen("cos-listeners") { NavigationStack { CosScreen(scope: "all", tab: .listeners) } }
    }

    /// The Work group's chief owns no watchers yet: the tab says so.
    func testCosListenersEmpty() async throws {
        try await screen("cos-listeners-empty") { NavigationStack { CosScreen(scope: "group:group-work", tab: .listeners) } }
    }

    /// The chiefs' bus events reach the store through the socket, which delivers them as events
    /// HarnessEvent doesn't know: the badge and a chat entry land in the CoS state.
    func testCosEventsFromTheSocketReachTheStore() async throws {
        let badge = try JSONDecoder().decode(HarnessEvent.self, from: Data(#"{"kind":"cos.badge","total":9,"byCos":{"cos-all":9}}"#.utf8))
        let chat = try JSONDecoder().decode(HarnessEvent.self, from: Data(#"{"kind":"cos.transcript.appended","cosId":"cos-all","entry":{"id":"live-1","cosId":"cos-all","createdAt":1,"kind":"message","role":"assistant","text":"hello"}}"#.utf8))
        world.socket.push(badge)
        world.socket.push(chat)
        var spins = 0
        while world.store.cos.badge?.total != 9 && spins < 500 { await FrameClock.tick(); spins += 1 }
        XCTAssertEqual(world.store.cos.badge?.total, 9)
        XCTAssertTrue(world.store.cos.chat["cos-all"]?.contains { $0.id == "live-1" } == true)
    }

    func testCosMemory() async throws {
        let chief = try XCTUnwrap(world.store.cos.chief(scope: "all"))
        try await screen("cos-memory") { CosMemorySheet(chief: chief) }
    }

    /// Settings → General, with the event history field (7 days from the world's settings).
    func testGeneralSettings() async throws {
        let settings = try XCTUnwrap(world.store.state.settings)
        try await screen("general-settings") {
            Form { SettingsGeneralSection(settings: settings) }
                .settingsFormStyle(Palette(world.app.resolvedTheme(systemDark: false)))
        }
    }

    /// The chief of staff's switch, column boxes and model: the app's (Review checked; Default is the Work model),
    /// and a project that chose its own columns and model.
    func testCosSettings() async throws {
        var settings = try XCTUnwrap(world.store.state.settings)
        settings.cosStatuses = [.review]
        var notes = try XCTUnwrap(world.store.state.projects["project-NOTES"])
        notes.cosModel = PhaseChoice(driver: "claude-code", model: "haiku")
        notes.cosStatuses = .value([.blocked, .done])
        try await screen("cos-settings") {
            Form {
                SettingsCosSection(settings: settings)
                ProjectCosSection(project: notes, settings: settings) { _ in }
            }
            .settingsFormStyle(Palette(world.app.resolvedTheme(systemDark: false)))
        }
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

    /// A bare `label:`: the picker lists the labels (colored dot, name, count), the tickets stay out of it.
    func testPaletteLabelPicker() async throws {
        try await screen("palette-label-picker") { NavigationStack { PaletteScreen(startInFiles: false, initialText: "label:", autofocus: false) } }
    }

    /// "Add label…" on a ticket: the labels it lacks, and Create for a name nobody has.
    func testPaletteAddLabel() async throws {
        try await screen("palette-add-label") {
            NavigationStack { PaletteScreen(startInFiles: false, initialText: "Needs copy", autofocus: false, initialLabelPick: ("HARNESS-3", false)) }
        }
    }

    /// "Remove label…": only the ticket's own labels.
    func testPaletteRemoveLabel() async throws {
        try await screen("palette-remove-label") {
            NavigationStack { PaletteScreen(startInFiles: false, autofocus: false, initialLabelPick: ("HARNESS-3", true)) }
        }
    }

    /// Two qualifiers AND (`label:"Release 1.2.3" label:Performance`) and list the tickets carrying both.
    func testPaletteLabelQualifiers() async throws {
        try await screen("palette-label-qualifiers") {
            NavigationStack { PaletteScreen(startInFiles: false, initialText: "label:\"Release 1.2.3\" label:Performance ", autofocus: false) }
        }
    }

    /// More than ten labels with tickets in flight: the Labels section stops at ten and offers More.
    func testProjectsSheetLabelsMore() async throws {
        let extra = (0..<8).map { LabelInfo(name: "Extra \($0)", color: "blue", createdAt: 1, lastUsedAt: 1, count: $0 + 1) }
        world.store.dispatch(.event(.labelsChanged(labels: world.store.state.labels + extra)))
        // The sheet's detent cuts the list short; the sidebar column (no title bar to animate) shows the whole section.
        try await screen("projects-labels-more") { NavigationStack { ProjectsSidebar(column: true) } }
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

    /// The iPhone Duo held in the book pose: the ticket sheet covers only the right half of the screen.
    func testTicketSheetBookPose() async throws {
        try XCTSkipUnless(ReferenceImages.device == "duo", "the Duo's hinge")
        try await screen("ticket-sheet-book", router: ticket("HARNESS-5", .spec), landscape: true) { RootView().environment(\.devicePosture, .book) }
    }

    /// The ticket sheet quarter open: the board above it isn't dimmed, since it takes touches there.
    func testTicketSheetQuarterOpen() async throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "the form sheet doesn't take detents")
        try await screen("ticket-sheet-quarter-open", router: ticket("HARNESS-5", .spec)) { RootView().environment(\.ticketSheetStartsQuarterOpen, true) }
    }

    func testTicketActivity() async throws {
        try await screen("ticket-activity", router: ticket("HARNESS-5", .activity)) { RootView() }
    }

    func testTicketDetails() async throws {
        try await screen("ticket-details", router: ticket("HARNESS-5", .details)) { RootView() }
    }

    /// HARNESS-7 is done: its Labels row still has the × on each chip and the Add a label field.
    func testTicketDetailsDoneLabels() async throws {
        try await screen("ticket-details-done-labels", router: ticket("HARNESS-7", .details)) { RootView() }
    }

    /// HARNESS-5's finished run: a message, the agent's text, a tool call and its result.
    func testTicketTranscript() async throws {
        try await screen("ticket-transcript", router: ticket("HARNESS-5", .transcript)) { RootView() }
    }

    /// HARNESS-4: blocked on a question for the human, no restart time, and a spec that asks
    /// nothing: the bar reads "Needs you · 1" with the block's question under it, no Unblock, and the
    /// composer's placeholder says a message answers the block.
    func testTicketBlocked() async throws {
        try await screen("ticket-blocked", router: ticket("HARNESS-4", .spec)) { RootView() }
    }

    /// A spec asking questions mid-spec (under Plan) and under Open questions, one already checked.
    private static let questionsSpec = "# Choose a storage backend\n\n## Goal\n\nPick where hosted tickets live.\n\n## Plan\n\nMove the tickets to Postgres, then decide:\n\n- [ ] Should backups run hourly or nightly?\n- [ ] Do we keep SQLite for local installs?\n\n## Open questions\n\n- [ ] Which region hosts the database?\n- [x] Do we need read replicas?\n"

    /// HARNESS-4 at work, its spec asking three questions, with `replies` drafted.
    private func questionsWorld(blocked: Bool = false, replies: [[String: String]] = []) async throws -> ScreenWorld {
        var json = try WorldJSON.load()
        let draft: [String: Any] = ["text": "", "attachments": [], "questionReplies": replies, "origin": NSNull(), "updatedAt": json.now]
        var patch: [String: Any] = ["spec": Self.questionsSpec, "openQuestionCount": 3, "messageDraft": draft]
        if !blocked {
            patch["status"] = "in_progress"
            patch["blockedReason"] = NSNull()
        }
        json.patch("HARNESS-4", patch)
        return await ScreenWorld(json)
    }

    /// The inline layout (every iPhone, an iPad in portrait): each open question in the spec, mid-spec
    /// included, shows its text with an answer field under it, the checked one stays a checked line,
    /// and the bar above the composer reads "Needs you · 3".
    func testTicketOpenQuestions() async throws {
        let world = try await questionsWorld()
        let image = try await render(world, router: ticket("HARNESS-4", .spec)) { RootView() }
        ReferenceImages.assert(image, named: "ticket-open-questions")
        XCTAssertEqual(world.transport.unrouted, [])
    }

    /// Two answers drafted inline: they show in their fields and the bar becomes "2 answers ready · Send".
    func testTicketOpenQuestionsAnswered() async throws {
        try XCTSkipIf(ReferenceImages.device == "ipad", "the inline layout is the iPhone's; the iPad's portrait render is ticket-open-questions")
        let world = try await questionsWorld(replies: [
            ["question": "Should backups run hourly or nightly?", "body": "Nightly is enough."],
            ["question": "Do we keep SQLite for local installs?", "body": "Yes, local stays on SQLite."],
        ])
        let image = try await render(world, router: ticket("HARNESS-4", .spec)) { RootView() }
        ReferenceImages.assert(image, named: "ticket-open-questions-answered")
        XCTAssertEqual(world.transport.unrouted, [])
    }

    /// A full ticket window on the iPad in landscape (the ticket sheet is never 700pt wide) is large
    /// enough for the panel: the Needs you panel above the composer
    /// lists the block's question (no Unblock), then each open question with its answer field (one
    /// holding a drafted reply), then the answered one folded away. The spec keeps its checkboxes.
    func testTicketOpenQuestionsPanel() async throws {
        try XCTSkipUnless(ReferenceImages.device == "ipad", "only a large landscape view gets the panel")
        let world = try await questionsWorld(blocked: true, replies: [["question": "Do we keep SQLite for local installs?", "body": "Yes, local stays on SQLite."]])
        let router = Router(ticket: .ticket(key: "HARNESS-4", tab: .spec))
        let image = try await render(world, router: router, landscape: true) {
            RequireStore { TabStack(tab: .board) { RouteScreen(route: .ticket(key: "HARNESS-4", tab: .spec)) } }
        }
        ReferenceImages.assert(image, named: "ticket-open-questions-panel")
        XCTAssertEqual(world.transport.unrouted, [])
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

    /// HARNESS-5 with a spec holding a table in a list item and a table in a block quote.
    func testTicketSpecNested() async throws {
        var json = try WorldJSON.load()
        json.patch("HARNESS-5", ["spec": "# Status\n\n- Checked the rollout\n\n  | File | Change |\n  | --- | --- |\n  | board.ts | faster |\n  | api.ts | cached |\n\n> | Metric | Value |\n> | --- | --- |\n> | p50 | 120ms |\n>\n> - one\n> - two"])
        let nested = await ScreenWorld(json)
        let image = try await render(nested, router: ticket("HARNESS-5", .spec)) { RootView() }
        ReferenceImages.assert(image, named: "ticket-spec-nested")
        XCTAssertEqual(nested.transport.unrouted, [])
    }

    /// HARNESS-8: a conductor, with its two children on the Tickets tab.
    func testTicketChildren() async throws {
        try await screen("ticket-children", router: ticket("HARNESS-8", .children)) { RootView() }
    }

    /// HARNESS-8's Events tab: what woke the conductor (a child's change, a subscription), listed with the Inbox's rows.
    func testTicketEvents() async throws {
        try await screen("ticket-events", router: ticket("HARNESS-8", .events)) { RootView() }
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

    /// An image file, drawn from its bytes instead of "Binary file".
    func testFileViewerImage() async throws {
        try await screen("file-image") { NavigationStack { FileViewerScreen(params: FileRouteParams(path: "assets/logo.png", ticket: "HARNESS-5")) } }
    }
}
