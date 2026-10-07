import Foundation
import Testing
@testable import HarnessKit

@Suite("Settings screen rules (settings, project settings)")
struct SettingsRulesTests {
    static func net(_ mode: ListenMode, host: String? = nil, override: String? = nil) -> NetworkStatus {
        NetworkStatus(mode: mode, host: host, port: 4317, bound: [], active: mode, override: override)
    }

    static func watcher(_ id: String, _ name: String, mode: WatcherMode = .loop, interval: Int = 300, driver: String? = nil,
                        models: [String: String]? = nil, cwd: String? = nil, lastRunAt: Double? = nil) -> Watcher {
        Watcher(id: id, name: name, command: "x", cwd: cwd, mode: mode, intervalSec: interval, enabled: true, driver: driver,
                models: models, lastRunAt: lastRunAt, createdAt: 1, updatedAt: 1)
    }

    static func ticket(_ id: String, _ status: TicketStatus, project: String = "p1") -> Ticket {
        Ticket(id: id, key: "K-\(id)", projectId: project, title: "T", spec: "", status: status, sessionId: "s\(id)", driver: "dummy",
               position: 0, createdAt: 1, updatedAt: 1)
    }

    static func driver(_ id: String, available: Bool = true, authenticated: Bool = true, login: Bool = false, description: String = "", detail: String = "") -> DriverInfo {
        DriverInfo(id: id, name: id.capitalized, description: description, available: available, authenticated: authenticated, detail: detail, supportsLogin: login)
    }

    // MARK: network

    @Test func listenOffersEveryModeButCustom() {
        #expect(SettingsRules.listenChoices == [.localhost, .tailscale, .any])
    }

    @Test func customListenShowsItsHost() {
        #expect(SettingsRules.listenTriggerLabel(Self.net(.custom, host: "10.0.0.2")) == "Custom · 10.0.0.2")
        #expect(SettingsRules.listenTriggerLabel(Self.net(.custom)) == "Custom · ")
        #expect(SettingsRules.listenTriggerLabel(Self.net(.tailscale, host: "ignored")) == "Tailscale")
        #expect(SettingsRules.listenLabel(.unknown("vpn")) == "vpn")
    }

    @Test func overrideTakesTheFooter() {
        #expect(SettingsRules.networkFooter(Self.net(.any, override: "0.0.0.0")) == "HARNESS_HOST=0.0.0.0 overrides this setting.")
        #expect(SettingsRules.networkFooter(Self.net(.any, override: "")).hasPrefix("Where the service"))
    }

    @Test func localhostIsConfirmedAndTheCurrentModeIsANoOp() {
        #expect(SettingsRules.listenChange(from: .any, to: .any) == .none)
        #expect(SettingsRules.listenChange(from: .any, to: .localhost) == .confirm)
        #expect(SettingsRules.listenChange(from: .localhost, to: .tailscale) == .apply)
    }

    @Test func boundAddressDropsOnlyAnHttpScheme() {
        #expect(SettingsRules.boundLabel("http://100.1.2.3:4317") == "100.1.2.3:4317")
        #expect(SettingsRules.boundLabel("https://mac.ts.net") == "mac.ts.net")
        #expect(SettingsRules.boundLabel("ws://x") == "ws://x")
    }

    // MARK: general

    @Test(arguments: [
        ("4", 4), (" 7 ", 7), ("2.5", 3), ("0", 1), ("-3", 1), ("99", 32), ("32", 32), ("", 1), ("0x10", 16),
    ])
    func maxConcurrentRunsRoundsAndClamps(_ text: String, _ expected: Int) {
        #expect(SettingsRules.maxConcurrentRuns(text) == expected)
    }

    @Test(arguments: ["abc", "Infinity", "1e400", "4 runs"])
    func maxConcurrentRunsIgnoresNonNumbers(_ text: String) {
        #expect(SettingsRules.maxConcurrentRuns(text) == nil)
    }

    @Test(arguments: [
        ("5", 5), (" 12 ", 12), ("2.5", 3), ("0", 0), ("-3", 0), ("1440", 1440), ("1441", 1440), ("0x10", 16),
    ])
    func browserIdleTabMinutesRoundsAndClamps(_ text: String, _ expected: Int) {
        #expect(SettingsRules.browserIdleTabMinutes(text) == expected)
    }

    @Test(arguments: ["", "  ", "abc", "Infinity", "5 min"])
    func browserIdleTabMinutesIgnoresBlankAndNonNumbers(_ text: String) {
        #expect(SettingsRules.browserIdleTabMinutes(text) == nil)
    }

    @Test func idleTabMinutesFallsBackToTheDefaultForAnOlderService() throws {
        let old = #"{"defaultDriver":"dummy","maxConcurrentRuns":2,"permissionMode":"auto","classifier":"off","defaultModels":{},"reviewModels":{},"anthropicApiKeySet":false}"#
        let decoded = try JSONDecoder().decode(PublicSettings.self, from: Data(old.utf8))
        #expect(decoded.browserIdleTabMinutes == nil)
        #expect(decoded.idleTabMinutes == 5)
        let off = try JSONDecoder().decode(PublicSettings.self, from: Data((old.dropLast() + #","browserIdleTabMinutes":0}"#).utf8))
        #expect(off.idleTabMinutes == 0)
    }

    @Test func claudeOauthTokenReadsAsUnsetForAnOlderService() throws {
        let old = #"{"defaultDriver":"dummy","maxConcurrentRuns":2,"permissionMode":"auto","classifier":"off","defaultModels":{},"reviewModels":{},"anthropicApiKeySet":true}"#
        let decoded = try JSONDecoder().decode(PublicSettings.self, from: Data(old.utf8))
        #expect(decoded.claudeOauthTokenSet == nil)
        #expect(!decoded.hasClaudeOauthToken)
        let set = try JSONDecoder().decode(PublicSettings.self, from: Data((old.dropLast() + #","claudeOauthTokenSet":true}"#).utf8))
        #expect(set.hasClaudeOauthToken)
    }

    @Test func settingsBaseBranchFallsBackToMainAndSkipsUnchanged() {
        #expect(SettingsRules.settingsBaseBranchCommit("  ", current: "develop") == .save("main"))
        #expect(SettingsRules.settingsBaseBranchCommit("", current: "main") == .none)
        #expect(SettingsRules.settingsBaseBranchCommit(" develop ", current: "main") == .save("develop"))
        #expect(SettingsRules.settingsBaseBranchCommit("develop", current: "develop") == .none)
        guard case .invalid = SettingsRules.settingsBaseBranchCommit("a..b", current: nil) else {
            Issue.record("an invalid name was accepted")
            return
        }
    }

    @Test func projectBaseBranchEmptyInherits() {
        #expect(SettingsRules.projectBaseBranchCommit("  ") == .save(nil))
        #expect(SettingsRules.projectBaseBranchCommit("release/1") == .save("release/1"))
        #expect(SettingsRules.projectBaseBranchCommit("bad name") == .invalid(Branches.branchNameError("bad name")!))
    }

    @Test func blankApiKeyIsNotSaved() {
        #expect(SettingsRules.apiKeyToSave("  \n") == nil)
        #expect(SettingsRules.apiKeyToSave(" sk-ant-1 ") == "sk-ant-1")
    }

    // MARK: drivers

    @Test func driverStatusChecksAvailabilityBeforeSignIn() {
        #expect(SettingsRules.driverStatus(Self.driver("a", available: false, authenticated: false)) == .unavailable)
        #expect(SettingsRules.driverStatus(Self.driver("a", available: true, authenticated: false)) == .signedOut)
        #expect(SettingsRules.driverStatus(Self.driver("a")) == .ready)
    }

    @Test func driverLogin() {
        #expect(SettingsRules.loginLabel(Self.driver("a")) == nil)
        #expect(SettingsRules.loginLabel(Self.driver("a", authenticated: false, login: true)) == "Log in")
        #expect(SettingsRules.loginLabel(Self.driver("a", login: true)) == "Log in again")
    }

    // MARK: connection

    @Test func serverHostOnlyWhenTheNameDiffers() {
        let named = SavedServer(id: "1", name: "Studio", baseUrl: "http://mac.local:4317", addedAt: 0)
        #expect(SettingsRules.serverHost(named) == MobilePair.displayHost("http://mac.local:4317"))
        let bare = SavedServer(id: "2", name: MobilePair.displayHost("http://mac.local:4317"), baseUrl: "http://mac.local:4317", addedAt: 0)
        #expect(SettingsRules.serverHost(bare) == nil)
    }

    // MARK: watchers

    @Test func watchersSortByNameThenId() {
        let sorted = SettingsRules.sortedWatchers([Self.watcher("3", "jira"), Self.watcher("1", "Heartbeat"), Self.watcher("2", "jira"), Self.watcher("0", "alpha")])
        #expect(sorted.map(\.id) == ["0", "1", "2", "3"])
    }

    @Test func scheduleLabel() {
        #expect(SettingsRules.watcherScheduleLabel(Self.watcher("1", "a")) == "Loop")
        #expect(SettingsRules.watcherScheduleLabel(Self.watcher("1", "a", mode: .interval, interval: 90)) == "Every 90s")
    }

    @Test func triageLabelNamesTheDriverAndModel() {
        let drivers = [Self.driver("claude-code")]
        let models = [ModelInfo(id: "opus", name: "Opus")]
        let pinned = SettingsRules.watcherTriageTarget(Self.watcher("1", "a", driver: "claude-code", models: ["claude-code": "opus"]), settings: nil)
        #expect(pinned == .init(driver: "claude-code", model: "opus"))
        #expect(SettingsRules.watcherTriageLabel(pinned, drivers: drivers, models: models) == "Claude-Code · Opus")
        // An unknown driver shows its id; no driver at all says so.
        #expect(SettingsRules.watcherTriageLabel(.init(driver: "codex", model: nil), drivers: drivers, models: nil) == "codex")
        #expect(SettingsRules.watcherTriageLabel(SettingsRules.watcherTriageTarget(Self.watcher("1", "a"), settings: nil), drivers: drivers, models: nil) == "Default driver")
    }

    @Test func triageTargetFallsBackToTheSettingsDriver() {
        let settings = PublicSettings(defaultDriver: "dummy", maxConcurrentRuns: 2, permissionMode: .auto, classifier: .off, anthropicApiKeySet: false)
        #expect(SettingsRules.watcherTriageTarget(Self.watcher("1", "a"), settings: settings).driver == "dummy")
    }

    @Test func metaLineAddsTheFolderOnlyWhenSet() {
        let now = 1_000_000.0
        #expect(SettingsRules.watcherMetaLine(triage: "Dummy", Self.watcher("1", "a"), now: now) == "Dummy · last run never")
        #expect(SettingsRules.watcherMetaLine(triage: "Dummy", Self.watcher("1", "a", cwd: "~/x", lastRunAt: now - 5 * 60_000), now: now) == "Dummy · last run 5m ago · in ~/x")
        #expect(!SettingsRules.watcherMetaLine(triage: "D", Self.watcher("1", "a", cwd: ""), now: now).contains(" in "))
    }

    // MARK: project settings

    @Test func identifierIsUpperCasedAndCappedAt20Units() {
        #expect(SettingsRules.identifierDraft("web2") == "WEB2")
        #expect(SettingsRules.identifierDraft(String(repeating: "a", count: 25)) == String(repeating: "A", count: 20))
        // An emoji is two UTF-16 units: it doesn't fit in the last slot.
        #expect(SettingsRules.identifierDraft(String(repeating: "A", count: 19) + "😀") == String(repeating: "A", count: 19))
    }

    @Test func ticketCountUsesTheDoneTotalOnceKnown() {
        let tickets = [Self.ticket("1", .planning), Self.ticket("2", .done), Self.ticket("3", .review), Self.ticket("4", .planning, project: "p2")]
        #expect(SettingsRules.projectTicketCount("p1", tickets: tickets, doneTotal: nil) == 3)
        #expect(SettingsRules.projectTicketCount("p1", tickets: tickets, doneTotal: 40) == 42)
        #expect(SettingsRules.projectTicketCount("p3", tickets: tickets, doneTotal: nil) == 0)
    }

    @Test func removeCopyPluralizes() {
        #expect(SettingsRules.removeProjectHint(0) == "Deletes the project from Harness. Files on disk are left alone.")
        #expect(SettingsRules.removeProjectHint(1) == "Deletes 1 ticket and their history from Harness. Files on disk are left alone.")
        let c = SettingsRules.removeProjectConfirm(name: "Web", key: "WEB", count: 2)
        #expect(c.title == "Remove Web (WEB)?")
        #expect(c.message == "This deletes its 2 tickets and their transcripts. Files on disk, branches and worktrees are left alone.")
        #expect(SettingsRules.removeProjectConfirm(name: "Web", key: "WEB", count: 0).message.hasPrefix("This deletes the project."))
    }

    @Test func pathCommitOnlyWhenChanged() {
        #expect(SettingsRules.projectPathCommit(" /a/b ", current: "/a") == "/a/b")
        #expect(SettingsRules.projectPathCommit("/a ", current: "/a") == nil)
        #expect(SettingsRules.projectPathCommit("  ", current: "/a") == nil)
    }
}
