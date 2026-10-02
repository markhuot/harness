import Foundation
import Testing
@testable import HarnessKit

/// Every harness:// link ios/Tools/sim-check.ts opens, and the edges around them.
@Suite("DeepLink")
struct DeepLinkTests {
    @Test(arguments: [
        ("harness://board", DeepLink.tab(.board)),
        ("harness://search", .tab(.search)),
        ("harness://inbox", .tab(.inbox)),
        ("harness://settings", .tab(.settings)),
        ("HARNESS://Board/", .tab(.board)),
        ("harness://projects", .sheet(.projects(fromSearch: false))),
        ("harness://projects?from=search", .sheet(.projects(fromSearch: true))),
        ("harness://connect", .sheet(.connect)),
        ("harness://scan", .cover(.scan)),
        ("harness://prompts", .push(.prompts)),
        ("harness://driver/claude-code", .push(.driver(id: "claude-code"))),
        ("harness://driver/anthropic%2Dapi", .push(.driver(id: "anthropic-api"))),
        ("harness://prompt/run.review", .push(.prompt(id: "run.review"))),
        ("harness://project/p-123", .push(.project(id: "p-123"))),
        ("harness://inbox/s%2F1", .push(.triage(sessionId: "s/1"))),
        ("harness://watcher", .sheet(.watcher(id: nil))),
        ("harness://watcher?id=w%201", .sheet(.watcher(id: "w 1"))),
        ("harness://new", .sheet(.newSession(projectId: nil, key: nil))),
        ("harness://new?projectId=p1", .sheet(.newSession(projectId: "p1", key: nil))),
        ("harness://new?key=GREET-4", .sheet(.newSession(projectId: nil, key: "GREET-4"))),
        ("harness://new?projectId=", .sheet(.newSession(projectId: nil, key: nil))),
    ] as [(String, DeepLink)])
    func routes(_ url: String, _ expected: DeepLink) {
        #expect(DeepLink.parse(url) == expected)
    }

    @Test(arguments: [
        ("harness://ticket/GREET-1", Route.ticket(key: "GREET-1", tab: nil)),
        ("harness://ticket/GREET-1?tab=summaries", .ticket(key: "GREET-1", tab: .summaries)),
        ("harness://ticket/GREET-1?tab=transcript", .ticket(key: "GREET-1", tab: .transcript)),
        ("harness://ticket/GREET-1?tab=details", .ticket(key: "GREET-1", tab: .details)),
        ("harness://ticket/GREET-1?tab=children", .ticket(key: "GREET-1", tab: .children)),
        ("harness://ticket/GREET-1?tab=agents", .ticket(key: "GREET-1", tab: .agents)),
        ("harness://ticket/GREET-1?tab=browser", .ticket(key: "GREET-1", tab: .browser)),
        // sim-check encodes the sub-agent tab's colon.
        ("harness://ticket/GREET-1?tab=agent%3Atoolu_01", .ticket(key: "GREET-1", tab: TicketTab("agent:toolu_01"))),
        // Changes is built in: its old plugin id maps to it.
        ("harness://ticket/GREET-1?tab=plugin:git:changes", .ticket(key: "GREET-1", tab: .changes)),
        ("harness://ticket/GREET-1?tab=changes", .ticket(key: "GREET-1", tab: .changes)),
        ("harness://ticket/GREET-1?tab=plugin:notes:list", .ticket(key: "GREET-1", tab: TicketTab("plugin:notes:list"))),
        // A tab the app doesn't know is dropped, not passed on.
        ("harness://ticket/GREET-1?tab=bogus", .ticket(key: "GREET-1", tab: nil)),
        ("harness://ticket/GREET-1?tab=plugin:Git:changes", .ticket(key: "GREET-1", tab: nil)),
        // A remote ID, and a percent-encoded key.
        ("harness://ticket/JIRA-62", .ticket(key: "JIRA-62", tab: nil)),
        ("harness://ticket/MH%2D62", .ticket(key: "MH-62", tab: nil)),
        ("harness://ticket/GREET-1#ignored", .ticket(key: "GREET-1", tab: nil)),
    ] as [(String, Route)])
    func ticketLinks(_ url: String, _ route: Route) {
        #expect(DeepLink.parse(url) == .push(route))
    }

    @Test func fileLinksKeepTheLineAnchor() {
        let link = DeepLink.parse("harness://file/src/greetings.ts?ticket=GREET-7#L3-L9")
        #expect(link == .push(.file(FileRouteParams(path: "src/greetings.ts", ticket: "GREET-7", start: "3", end: "9"))))
        #expect(DeepLink.parse("harness://file/a%20b/c.md?project=p1#L5")
            == .push(.file(FileRouteParams(path: "a b/c.md", project: "p1", start: "5"))))
        // No root: the viewer still opens and says it can't tell where.
        #expect(DeepLink.parse("harness://file/README.md") == .push(.file(FileRouteParams(path: "README.md"))))
    }

    @Test func settingsLinksCarryOnlyValidThemePicks() throws {
        let link = DeepLink.parse("harness://settings?darkTheme=catppuccin-mocha&theme=dark")
        guard case let .tab(.settings, themes?) = link else {
            Issue.record("not a settings link with themes: \(String(describing: link))")
            return
        }
        #expect(themes == ThemePicker.ThemePrefsPatch(theme: .dark, darkTheme: "catppuccin-mocha"))
        // A light theme given as the dark pick, and an unknown appearance, change nothing.
        let light = try #require(Themes.themes(for: .light).first?.id)
        #expect(DeepLink.parse("harness://settings?darkTheme=\(light)&theme=sepia") == .tab(.settings, themes: nil))
    }

    @Test func pairLinksDecodeTheirParams() {
        let url = Pairing.buildPairUrl(baseUrl: "http://100.64.0.2:7717", token: "a+b/c=&d")
        #expect(DeepLink.parse(url) == .sheet(.pair(url: "http://100.64.0.2:7717", token: "a+b/c=&d")))
        #expect(DeepLink.parse("harness://pair?url=http%3A%2F%2Fmac%3A1") == .sheet(.pair(url: "http://mac:1", token: nil)))
        // A damaged value is passed through as written, for PairScreen to explain.
        #expect(DeepLink.parse("harness://pair?url=%E0%A4%A&token=t") == .sheet(.pair(url: "%E0%A4%A", token: "t")))
    }

    @Test(arguments: [
        "https://board", "harness:board", "harness://", "harness://nope", "harness://ticket", "harness://ticket/",
        "harness://project", "harness://prompt/", "harness://driver", "harness://driver/", "",
    ])
    func ignores(_ url: String) {
        #expect(DeepLink.parse(url) == nil)
    }
}
