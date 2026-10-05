import Testing
@testable import HarnessKit

@Suite("extensions.ts")
struct ExtensionsTests {
    @Test(arguments: Fixture.cases("extensions", "extensionNoteCases", input: BrowserExtension.self, output: Extensions.Note.self))
    func note(_ c: Fixture.Case<BrowserExtension, Extensions.Note>) {
        #expect(Extensions.note(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("extensions", "extensionsWaitingCases", input: BrowserExtensionList.self, output: Int.self))
    func waiting(_ c: Fixture.Case<BrowserExtensionList, Int>) {
        #expect(Extensions.waiting(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("extensions", "runnableExtensionsCases", input: BrowserExtensionList.self, output: [BrowserExtension].self))
    func runnable(_ c: Fixture.Case<BrowserExtensionList, [BrowserExtension]>) {
        #expect(Extensions.runnable(c.input).map(\.id) == c.output.map(\.id))
    }

    @Test func aStatusFromANewerServiceShowsItsErrorWithoutALabel() {
        let ext = BrowserExtension(id: "x", name: "X", version: "1", source: .webstore, enabled: true, status: .unknown("updating"), error: "Updating", hasAction: false)
        #expect(Extensions.note(ext) == Extensions.Note(text: "Updating", tone: .error))
    }
}
