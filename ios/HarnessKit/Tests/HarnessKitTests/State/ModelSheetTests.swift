import Testing
@testable import HarnessKit

struct ChoiceSectionsInput: Decodable, Sendable {
    struct Choices: Decodable, Sendable {
        let `default`: ModelOption?
        let groups: [ChoiceGroup]
    }
    let choices: Choices
    let query: String
    let driverNames: [String: String]?
}

@Suite("mobile/src/lib/modelSheet.ts parity")
struct ModelSheetTests {
    @Test(arguments: Fixture.cases("mobileModelSheet", "choiceSectionsCases", input: ChoiceSectionsInput.self, output: [ChoiceSection].self))
    func choiceSections(_ c: Fixture.Case<ChoiceSectionsInput, [ChoiceSection]>) {
        let got = ModelSheet.choiceSections(
            default: c.input.choices.default, groups: c.input.choices.groups, query: c.input.query, driverNames: c.input.driverNames ?? [:]
        )
        #expect(got == c.output)
    }

    @Test func choiceOptionsOverloadUsesItsDefaultAndGroups() {
        let def = ModelOption(value: "", label: "Default (Opus)")
        let group = ChoiceGroup(driver: "claude-code", label: nil, options: [ModelOption(value: "claude-code\u{1}opus", label: "Opus")])
        let choices = ChoiceOptions(default: def, groups: [group], selectedLabel: "Opus")
        #expect(ModelSheet.choiceSections(choices, query: "").map(\.key) == ["", "claude-code"])
        #expect(ModelSheet.choiceSections(choices, query: "default").map(\.key) == [""])
    }
}
