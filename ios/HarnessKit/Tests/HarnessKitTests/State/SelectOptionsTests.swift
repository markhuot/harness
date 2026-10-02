import Testing
@testable import HarnessKit

struct SelectedLabelInput: Decodable, Sendable {
    let options: [SelectOption]
    let value: String
    let fallback: String
}

@Suite("SelectOptions")
struct SelectOptionsTests {
    @Test(arguments: Fixture.cases("mobileSelectOptions", "selectedLabelCases", input: SelectedLabelInput.self, output: String.self))
    func selectedLabel(_ c: Fixture.Case<SelectedLabelInput, String>) {
        #expect(SelectOptions.selectedLabel(c.input.options, value: c.input.value, fallback: c.input.fallback) == c.output)
    }
}
