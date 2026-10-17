import HarnessKit
import SwiftUI
import XCTest
@testable import Harness

/// Screens whose job is to show what the service returned: plan usage, the context gauge, a
/// conductor's header, a transcript's replies, a spec's wide tables and its attachments. The
/// service's side of each is a bun test and the mapping a HarnessKit test; these prove the views
/// read the right fields and lay them out (they replace sim-check checks that read labels off a
/// booted simulator).
extension ScreenSnapshotTests {
    // MARK: Fixtures

    static let claude = DriverInfo(
        id: "claude-code", name: "Claude Code", description: "", available: true, authenticated: true, detail: "", supportsLogin: true,
        sessionActions: SessionActions(compact: true, newSession: true), reportsContextUsage: true)
    static let copilot = DriverInfo(
        id: "github-copilot", name: "GitHub Copilot", description: "", available: true, authenticated: true, detail: "", supportsLogin: true,
        sessionActions: SessionActions(compact: false, newSession: false), reportsContextUsage: true)

    /// A ticket that isn't one of the board's: the gauge, conductor, transcript and attachment fixtures.
    static func extra(
        _ n: Int, _ title: String, kind: TicketKind = .task, status: TicketStatus = .planning, driver: String = "claude-code",
        spec: String = "A short spec.", childCount: Int? = nil, compacting: Bool? = nil, context: ContextUsage? = nil
    ) -> Ticket {
        Ticket(
            id: "t-\(n)", key: "HAR-\(n)", projectId: SnapshotWorld.project.id, kind: kind, title: title, spec: spec, specRevision: 1,
            status: status, sessionId: "s-\(n)", driver: driver, childCount: childCount, compacting: compacting,
            context: context.map { .value($0) } ?? .absent, position: Double(n),
            createdAt: SnapshotWorld.ago(minutes: 600), updatedAt: SnapshotWorld.ago(minutes: 20))
    }

    static func usage(_ input: Int, cacheRead: Int, cacheWrite: Int, misses: Int = 0, missTokens: Int = 0, estimated: Bool = false) -> ContextUsage {
        ContextUsage(input: input, cacheRead: cacheRead, cacheWrite: cacheWrite, prefix: 20_000, at: SnapshotWorld.ago(minutes: 20),
                     estimated: estimated, misses: misses, missTokens: missTokens)
    }

    static let gaugeTickets: [(String, Ticket)] = [
        ("Normal", extra(20, "Gauge normal", context: usage(4_000, cacheRead: 70_000, cacheWrite: 8_000))),
        ("New", extra(21, "Gauge new")),
        ("Over the limit", extra(22, "Gauge over", context: usage(2_000, cacheRead: 330_000, cacheWrite: 120_000))),
        ("Cache misses", extra(23, "Gauge misses", context: usage(4_000, cacheRead: 60_000, cacheWrite: 36_000, misses: 3, missTokens: 377_000))),
        ("Copilot estimate", extra(25, "Gauge copilot", driver: "github-copilot", context: usage(82_000, cacheRead: 0, cacheWrite: 0, estimated: true))),
    ]

    func entry(_ n: Int, _ sessionId: String, _ role: TranscriptRole, _ content: TranscriptContent) -> TranscriptEntry {
        TranscriptEntry(id: "e-\(sessionId)-\(n)", sessionId: sessionId, runId: "r-\(sessionId)", seq: n, role: role, content: content,
                        createdAt: SnapshotWorld.ago(minutes: 60 - Double(n)))
    }

    /// Serves a transcript the way the service does and puts it in the store, so the first frame has it.
    func setTranscript(_ ticket: Ticket, _ entries: [TranscriptEntry]) {
        world.serve("/sessions/\(ticket.sessionId)/transcript", entries)
        world.store.dispatch(.transcript(sessionId: ticket.sessionId, entries: entries))
    }

    func openTicket(_ key: String, _ tab: TicketTab) -> () -> Router {
        {
            let router = Router()
            router.openTicket(key: key, tab: tab)
            return router
        }
    }

    // MARK: Plan usage

    /// What GET /usage returns: Claude's four windows (one full), and Copilot, which can't be read.
    func reportUsage() {
        func window(_ id: PlanWindowId, _ label: String, _ used: Double, _ seconds: Double, elapsed: Double) -> PlanWindow {
            PlanWindow(id: id, label: label, usedPercent: used, resetsAt: SnapshotWorld.now + (1 - elapsed) * seconds * 1000, windowSeconds: seconds)
        }
        let week = 7.0 * 86_400
        world.store.setUsage(PlanUsageReport(drivers: [
            DriverPlanUsage(
                driver: "claude-code", name: "Claude Code",
                windows: [
                    window(.fiveHour, "5-hour", 82, 18_000, elapsed: 1 - (2 * 3_600 + 14 * 60) / 18_000),
                    window(.sevenDay, "Weekly", 45, week, elapsed: 0.8),
                    window(.sevenDayOpus, "Weekly · Opus", 2, week, elapsed: 0.05),
                    window(.sevenDaySonnet, "Weekly · Sonnet", 100, week, elapsed: 0.5),
                ],
                fetchedAt: SnapshotWorld.ago(minutes: 3)),
            DriverPlanUsage(driver: "github-copilot", name: "GitHub Copilot", windows: [], error: "Sign in to GitHub to see Copilot usage", fetchedAt: SnapshotWorld.ago(minutes: 3)),
        ]))
    }

    /// One row per window with its reset, "updated 3m ago", and the unreadable driver's reason with no bar.
    func testPlanUsageUsedSoFar() async throws {
        reportUsage()
        try await snapshot("plan-usage-used") { SnapshotPage { PlanUsageSection(report: self.world.store.usage) } }
    }

    /// Pace text, "too early to project", and a full window still limited.
    func testPlanUsageProjected() async throws {
        reportUsage()
        try await snapshot("plan-usage-projected", router: {
            UserDefaults.standard.set("projected", forKey: "planUsageMode")
            return Router()
        }) { SnapshotPage { PlanUsageSection(report: self.world.store.usage) } }
    }

    /// A usage.updated report replaces the rows: 82% → 91%.
    func testPlanUsageAfterAnUpdate() async throws {
        reportUsage()
        let drivers = world.store.usage!.drivers
        var claude = drivers[0]
        claude.windows[0].usedPercent = 91
        world.store.setUsage(PlanUsageReport(drivers: [claude, drivers[1]]))
        try await snapshot("plan-usage-updated") { SnapshotPage { PlanUsageSection(report: self.world.store.usage) } }
    }

    // MARK: Context gauge

    /// The gauge's label in each state: cached/fresh split (Normal), grey New, "over the limit",
    /// the miss badge and Copilot's estimate (the compacting spinner animates, so it stays in sim-check) (asterisk, one tone).
    func testContextGaugeStates() async throws {
        world.add(Self.gaugeTickets.map(\.1))
        world.store.dispatch(.drivers([Self.claude, Self.copilot]))
        try await snapshot("context-gauge-states") {
            SnapshotPage {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(Self.gaugeTickets, id: \.0) { name, ticket in
                        HStack {
                            Text(name).font(.scaled(size: 15))
                            Spacer()
                            TicketContextGauge(ticket: self.world.store.state.tickets[ticket.id] ?? ticket).frame(height: 24)
                        }
                    }
                }
            }
        }
    }

    /// The expanded header's meta row: the project key, the ticket key, then the gauge; no status or Conductor pill.
    func testTicketHeroEndsInTheGauge() async throws {
        world.add(Self.gaugeTickets.map(\.1))
        world.store.dispatch(.drivers([Self.claude, Self.copilot]))
        try await snapshot("ticket-hero-gauge", router: openTicket("HAR-20", .spec)) { RootView() }
    }

    /// The git line is its own row under the meta row: "branch → base", with no icon or border; the review marks
    /// sit at the meta row's trailing edge.
    func testTicketHeroGitLine() async throws {
        var ticket = Self.extra(26, "Git line", status: .review, context: Self.usage(4_000, cacheRead: 70_000, cacheWrite: 8_000))
        ticket.branch = "harness/har-26"
        ticket.agentReview = .approved
        world.add([ticket])
        world.store.dispatch(.drivers([Self.claude, Self.copilot]))
        try await snapshot("ticket-hero-git", router: openTicket("HAR-26", .spec)) { RootView() }
    }

    /// A conductor's hero has no Conductor pill.
    func testConductorHero() async throws {
        world.add([Self.extra(26, "Ship the greeter v2", kind: .conductor, driver: "claude-code", childCount: 2)])
        world.store.dispatch(.drivers([Self.claude]))
        try await snapshot("conductor-hero", router: openTicket("HAR-26", .spec)) { RootView() }
    }

    /// A child's ref sits on its own line above its title on the conductor's Tickets tab.
    func testConductorTicketsTab() async throws {
        var a = Self.extra(27, "L2 service API tests: in-process HTTP and /ws on port 0")
        a.parentId = "t-26"
        var b = Self.extra(28, "L3 contract tests: wire fixtures and Swift decoding")
        b.parentId = "t-26"
        b.dependsOn = ["HAR-27"]
        let conductor = Self.extra(26, "Test strategy", kind: .conductor, driver: "claude-code", childCount: 2)
        world.add([conductor, a, b])
        world.store.dispatch(.drivers([Self.claude]))
        // The tab spins until the conductor's detail has landed.
        let session = Session(id: conductor.sessionId, key: conductor.key, kind: .ticket, ticketId: conductor.id, driver: conductor.driver,
                              cwd: SnapshotWorld.project.path, createdAt: conductor.createdAt, updatedAt: conductor.updatedAt)
        world.store.dispatch(.detail(TicketDetail(ticket: conductor, session: session, children: [a, b]), requestedKey: "HAR-26"))
        try await snapshot("conductor-tickets", router: openTicket("HAR-26", .children)) { RootView() }
    }

    // MARK: Transcript and spec layout

    /// A reply's list items show their text, not a bullet with a zero-width item.
    func testTranscriptReplyList() async throws {
        let ticket = Self.extra(30, "Pick a branch strategy", status: .review)
        world.add([ticket])
        setTranscript(ticket, [
            entry(1, ticket.sessionId, .user, .text(text: "Which branch should this land on?")),
            entry(2, ticket.sessionId, .assistant, .text(text: "Two options:\n\n- Keep plain main\n- Ship it\n\nI'd keep plain main.")),
            entry(3, ticket.sessionId, .system, .status(text: "Run finished (work)")),
        ])
        try await snapshot("transcript-reply-list", router: openTicket("HAR-30", .transcript)) { RootView() }
    }

    /// A tool call with a description shows it, the raw command faint after it; a Read shows the file
    /// name and line range; a summarized thinking block shows above them.
    func testTranscriptToolLabels() async throws {
        let ticket = Self.extra(31, "Label tool calls", status: .review)
        world.add([ticket])
        let sid = ticket.sessionId
        setTranscript(ticket, [
            entry(1, sid, .user, .text(text: "Why is the build slow?")),
            entry(2, sid, .assistant, .thinking(text: "The build output suggests the cache is cold, so I'll check the config first.")),
            entry(3, sid, .assistant, .toolCall(callId: "c1", name: "Bash", input: .object(["command": .string("bun run build --verbose"), "description": .string("Build and show timings")]))),
            entry(4, sid, .tool, .toolResult(callId: "c1", name: "Bash", output: [.text(text: "done")], isError: false)),
            entry(5, sid, .assistant, .toolCall(callId: "c2", name: "Read", input: .object(["file_path": .string("/work/app/ios/HarnessKit/Sources/HarnessKit/State/Format.swift"), "offset": .number(100), "limit": .number(76)]))),
            entry(6, sid, .tool, .toolResult(callId: "c2", name: "Read", output: [.text(text: "…")], isError: false)),
            entry(7, sid, .assistant, .toolCall(callId: "c3", name: "Bash", input: .object(["command": .string("git status --short")]))),
            entry(8, sid, .tool, .toolResult(callId: "c3", name: "Bash", output: [.text(text: "")], isError: false)),
        ])
        try await snapshot("transcript-tool-labels", router: openTicket("HAR-31", .transcript)) { RootView() }
    }

    static let tableBrief = [
        "Speed up the simulator walk-through",
        "",
        "### Budget",
        "| Phase | Budget | How |",
        "|---|---|---|",
        "| Daemon up and seed | ≤ 8 s, overlapping install | `HARNESS_DUMMY_DELAY_MS=1`; settle all tickets with `Promise.all`; take the browse ticket off the critical path; drop the 1.5 s sleep |",
        "| Install, launch and pair | ≤ 6 s | Wait on conditions, not the `2500 + 4000` ms sleeps |",
        "| 21 screens, both themes | ≤ 30 s | 2 simulators in parallel, warm links, wait for each screen's own label, both themes in one visit |",
        "",
        "### Where the time goes today",
        "| Area | Cost | Why |",
        "|---|---|---|",
        "| 21 screens, light and dark | about 300 s | Every shot is a `coldOpen`: terminate, cold launch (about 4 s), then wait for the accessibility tree to stay unchanged for 800 ms (each `describe-ui` takes about 0.4 s). Then a fixed 1 s sleep (3.5 s for browser, 2.5 s for changes), then `running()`. That's 42 cold launches. |",
        "| Seeding | tens of seconds | The dummy driver streams at 40 ms per word, about 3× its default. `settle(browse)` allows up to 90 s. `Bun.sleep(1500)` at the end. |",
        "",
        "Measure with:",
        "```",
        "time bun scripts/sim-check.ts --no-build --shards=2",
        "```",
    ].joined(separator: "\n")

    /// A spec with wide tables in the transcript stays readable (a long cell keeps a column's width)
    /// and the replies after it stay on screen above the composer.
    func testTranscriptAfterWideTables() async throws {
        let ticket = Self.extra(31, "Speed up the walk-through", status: .review)
        world.add([ticket])
        setTranscript(ticket, [
            entry(1, ticket.sessionId, .user, .text(text: Self.tableBrief)),
            entry(2, ticket.sessionId, .system, .status(text: "Run started (work)")),
            entry(3, ticket.sessionId, .assistant, .text(text: "Done: the walk-through now runs in two shards.")),
            entry(4, ticket.sessionId, .system, .status(text: "Run finished (work)")),
            entry(5, ticket.sessionId, .system, .status(text: "Run finished (review)")),
        ])
        try await snapshot("transcript-wide-tables", router: openTicket("HAR-31", .transcript)) { RootView() }
    }

    // MARK: Attachments

    /// Inline in the spec: three 100 pt square thumbnails in a row, a recording as a figure across the
    /// width with its play badge, and one attachment that won't load.
    func testSpecAttachments() async throws {
        let spec = [
            "Show the greeting screen",
            "",
            "Here's the new greeting screen, before and after, plus a recording of the flow.",
            "",
            #"![phone.png](attachment:att_phone "thumb") ![wide.png](attachment:att_wide "thumb") ![small.png](attachment:att_small "thumb")"#,
            "",
            "![flow.mp4](attachment:att_flow)",
            "",
            "![broken.png](attachment:att_missing)",
        ].joined(separator: "\n")
        let ticket = Self.extra(32, "Show the greeting screen", status: .review, spec: spec)
        world.add([ticket])
        world.setSpec(ticket, spec)
        func attachment(_ id: String, _ name: String, _ kind: AttachmentKind, _ mime: String) -> Attachment {
            Attachment(id: id, path: "/Users/dev/harness/shots/\(name)", name: name, source: .spec, kind: kind, mimeType: mime)
        }
        let session = world.store.state.sessions[ticket.sessionId]!
        world.serve("/tickets/\(ticket.key)", TicketDetail(ticket: ticket, session: session, attachments: [
            attachment("att_phone", "phone.png", .image, "image/png"),
            attachment("att_wide", "wide.png", .image, "image/png"),
            attachment("att_small", "small.png", .image, "image/png"),
            attachment("att_flow", "flow.mp4", .video, "video/mp4"),
        ]))
        // The bytes the service would serve: solid fills that crop and fit the way real screenshots do.
        func seed(_ id: String, _ color: UIColor, _ size: CGSize, poster: Bool = false) {
            let image = UIGraphicsImageRenderer(size: size).image { ctx in
                color.setFill()
                ctx.fill(CGRect(origin: .zero, size: size))
                UIColor.white.withAlphaComponent(0.6).setStroke()
                ctx.cgContext.setLineWidth(6)
                ctx.cgContext.stroke(CGRect(origin: .zero, size: size).insetBy(dx: 20, dy: 20))
            }
            AttachmentMedia.shared.seed(image, url: "http://127.0.0.1:1/attachments/\(id)?token=snapshot", poster: poster)
        }
        seed("att_phone", .systemIndigo, CGSize(width: 295, height: 640))
        seed("att_wide", .systemTeal, CGSize(width: 480, height: 270))
        seed("att_small", .systemBlue, CGSize(width: 300, height: 652))
        seed("att_flow", .systemOrange, CGSize(width: 640, height: 360), poster: true)
        try await snapshot("spec-attachments", router: openTicket("HAR-32", .spec)) { RootView() }
    }
}

/// A screen's worth of one view on the app's background, for the pieces that aren't screens of their own.
struct SnapshotPage<Content: View>: View {
    @Environment(\.palette) private var c
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(c.bg)
    }
}
