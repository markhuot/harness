import Testing
@testable import HarnessKit

struct PermissionModeRef: Decodable, Sendable {
    let permissionMode: PermissionMode?
}

struct SettingsPermissionModeRef: Decodable, Sendable {
    let permissionMode: PermissionMode
}

struct ResolvePermissionModeInput: Decodable, Sendable {
    let ticket: PermissionModeRef?
    let project: PermissionModeRef?
    let settings: SettingsPermissionModeRef
}

struct ResolvePermissionModeEntityInput: Decodable, Sendable {
    let ticket: Ticket?
    let project: Project?
    let settings: Settings
}

@Suite("permissions.ts parity")
struct PermissionsTests {
    @Test(arguments: Fixture.cases("permissions", "resolvePermissionModeCases", input: ResolvePermissionModeInput.self, output: Permissions.ResolvedMode.self))
    func resolvePermissionMode(_ c: Fixture.Case<ResolvePermissionModeInput, Permissions.ResolvedMode>) {
        let got = Permissions.resolvePermissionMode(
            ticket: c.input.ticket?.permissionMode, project: c.input.project?.permissionMode, settings: c.input.settings.permissionMode
        )
        #expect(got == c.output)
        // An unknown mode must survive with its wire string, not collapse into a known one.
        #expect(got.mode.rawValue == c.output.mode.rawValue)
    }

    @Test(arguments: Fixture.cases("permissions", "resolvePermissionModeEntityCases", input: ResolvePermissionModeEntityInput.self, output: Permissions.ResolvedMode.self))
    func resolvePermissionModeEntities(_ c: Fixture.Case<ResolvePermissionModeEntityInput, Permissions.ResolvedMode>) {
        #expect(Permissions.resolvePermissionMode(ticket: c.input.ticket, project: c.input.project, settings: c.input.settings.permissionMode) == c.output)
    }

    @Test func labels() throws {
        let ts = try Fixture.value("permissions", "permissionModeLabels", as: [String: Permissions.Label].self)
        let swift = Dictionary(uniqueKeysWithValues: Permissions.labels.map { ($0.key.rawValue, $0.value) })
        #expect(swift == ts)
        // Every known mode has a label, and only known modes do.
        for mode in PermissionMode.allKnown { #expect(Permissions.label(for: mode) == ts[mode.rawValue]) }
        #expect(Permissions.label(for: .unknown("yolo")) == nil)
    }
}
