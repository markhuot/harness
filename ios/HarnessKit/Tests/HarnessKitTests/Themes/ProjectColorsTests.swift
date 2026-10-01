import Testing
@testable import HarnessKit

struct NormalizedOutput: Decodable, Sendable {
    let value: String?
    let invalid: Bool?

    var expected: NormalizedProjectColor {
        if invalid == true { return .invalid }
        return value.map(NormalizedProjectColor.color) ?? NormalizedProjectColor.none
    }
}

@Suite("projectColors.ts parity")
struct ProjectColorsTests {
    @Test func presetsInSwatchOrder() {
        #expect(ProjectColors.presets.map(\.id) == ["red", "orange", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "purple", "pink"])
        #expect(ProjectColors.presets.allSatisfy { ProjectColors.normalize($0.hex) == .color($0.hex) })
    }

    @Test(arguments: Fixture.cases("projectColors", "isProjectColorIdCases", input: JSONValue.self, output: Bool.self))
    func isProjectColorId(_ c: Fixture.Case<JSONValue, Bool>) {
        #expect(ProjectColors.isProjectColorId(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("projectColors", "normalizeProjectColorCases", input: JSONValue.self, output: NormalizedOutput.self))
    func normalizeProjectColor(_ c: Fixture.Case<JSONValue, NormalizedOutput>) {
        #expect(ProjectColors.normalize(c.input) == c.output.expected)
    }

    @Test(arguments: Fixture.cases("projectColors", "projectColorHexCases", input: String?.self, output: String?.self))
    func projectColorHex(_ c: Fixture.Case<String?, String?>) {
        #expect(ProjectColors.hex(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("projectColors", "projectColorNameCases", input: String?.self, output: String.self))
    func projectColorName(_ c: Fixture.Case<String?, String>) {
        #expect(ProjectColors.name(c.input) == c.output)
    }
}
