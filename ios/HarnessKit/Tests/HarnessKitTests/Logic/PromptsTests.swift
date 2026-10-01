import Foundation
import Testing
@testable import HarnessKit

private func same<T: Encodable>(_ a: T, _ b: T) throws -> Bool {
    try jsonEqual(JSONEncoder().encode(a), JSONEncoder().encode(b))
}

extension PromptsTests {
    struct ErrorLineInput: Decodable, Sendable {
        let entry: PromptEntry
        let draft: String?
        let serverError: String?
    }

    struct DraftInput: Decodable, Sendable {
        let entry: PromptEntry
        let draft: String
    }

    struct PatchInput: Decodable, Sendable {
        let entry: PromptEntry
        let draft: String?
    }

    struct InsertInput: Decodable, Sendable {
        let text: String
        let start: Int
        let end: Int
        let insert: String
    }

    struct DiffInput: Decodable, Sendable {
        let from: String
        let to: String
    }

    struct LoadErrorInput: Decodable, Sendable {
        struct API: Decodable, Sendable {
            let status: Int
            let message: String
        }
        let api: API?
        let message: String?
        let thrown: String?
    }

    /// Stands in for a JS `Error` (or a thrown string) that isn't a HarnessApiError.
    struct OtherError: LocalizedError {
        let errorDescription: String?
    }
}

@Suite("prompts.ts parity")
struct PromptsTests {
    @Test func groups() throws {
        let want = try Fixture.value("prompts", "promptGroups", as: [Prompts.GroupInfo].self)
        #expect(Prompts.groups == want)
    }

    @Test func stateLabels() throws {
        let want = try Fixture.value("prompts", "promptStateLabels", as: [String: String].self)
        #expect(Set(want.keys) == Set(Prompts.State.allCases.map(\.rawValue)))
        for state in Prompts.State.allCases { #expect(state.label == want[state.rawValue]) }
    }

    @Test(arguments: Fixture.cases("prompts", "groupPromptsCases", input: [PromptEntry].self, output: [Prompts.Group].self))
    func groupPrompts(_ c: Fixture.Case<[PromptEntry], [Prompts.Group]>) throws {
        #expect(try same(Prompts.groupPrompts(c.input), c.output))
    }

    @Test(arguments: Fixture.cases("prompts", "promptStateCases", input: PromptEntry.self, output: Prompts.State.self))
    func promptState(_ c: Fixture.Case<PromptEntry, Prompts.State>) {
        #expect(Prompts.promptState(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("prompts", "promptCountsCases", input: [PromptEntry].self, output: Prompts.Counts.self))
    func promptCounts(_ c: Fixture.Case<[PromptEntry], Prompts.Counts>) {
        #expect(Prompts.promptCounts(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("prompts", "promptsSummaryCases", input: [PromptEntry].self, output: String.self))
    func promptsSummary(_ c: Fixture.Case<[PromptEntry], String>) {
        #expect(Prompts.promptsSummary(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("prompts", "promptErrorLineCases", input: ErrorLineInput.self, output: String?.self))
    func promptErrorLine(_ c: Fixture.Case<ErrorLineInput, String?>) {
        #expect(Prompts.promptErrorLine(c.input.entry, draft: c.input.draft, serverError: c.input.serverError) == c.output)
    }

    @Test(arguments: Fixture.cases("prompts", "brokenOverrideMessageCases", input: PromptEntry.self, output: String.self))
    func brokenOverrideMessage(_ c: Fixture.Case<PromptEntry, String>) {
        #expect(Prompts.brokenOverrideMessage(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("prompts", "promptDraftErrorCases", input: DraftInput.self, output: String?.self))
    func promptDraftError(_ c: Fixture.Case<DraftInput, String?>) {
        #expect(Prompts.promptDraftError(c.input.entry, draft: c.input.draft) == c.output)
    }

    @Test(arguments: Fixture.cases("prompts", "promptStartTextCases", input: PromptEntry.self, output: String.self))
    func promptStartText(_ c: Fixture.Case<PromptEntry, String>) {
        #expect(Prompts.promptStartText(c.input) == c.output)
    }

    @Test(arguments: Fixture.cases("prompts", "promptDraftDirtyCases", input: DraftInput.self, output: Bool.self))
    func promptDraftDirty(_ c: Fixture.Case<DraftInput, Bool>) {
        #expect(Prompts.promptDraftDirty(c.input.entry, draft: c.input.draft) == c.output)
    }

    @Test(arguments: Fixture.cases("prompts", "promptOverrideForCases", input: DraftInput.self, output: String?.self))
    func promptOverrideFor(_ c: Fixture.Case<DraftInput, String?>) throws {
        #expect(try same(Prompts.promptOverrideFor(c.input.entry, draft: c.input.draft), c.output))
    }

    @Test(arguments: Fixture.cases("prompts", "promptSavePatchCases", input: PatchInput.self, output: SettingsPatch.self))
    func promptSavePatch(_ c: Fixture.Case<PatchInput, SettingsPatch>) throws {
        let got = Prompts.promptSavePatch(c.input.entry, draft: c.input.draft)
        #expect(got == c.output)
        #expect(try same(got, c.output))
    }

    @Test(arguments: Fixture.cases("prompts", "insertTextCases", input: InsertInput.self, output: TextInsertion.self))
    func insertText(_ c: Fixture.Case<InsertInput, TextInsertion>) throws {
        #expect(try same(Prompts.insertText(c.input.text, start: c.input.start, end: c.input.end, insert: c.input.insert), c.output))
    }

    @Test(arguments: Fixture.cases("prompts", "lineDiffCases", input: DiffInput.self, output: [Prompts.DiffLine].self))
    func lineDiff(_ c: Fixture.Case<DiffInput, [Prompts.DiffLine]>) throws {
        let got = Prompts.lineDiff(from: c.input.from, to: c.input.to)
        #expect(try same(got, c.output))
        // Both sides rebuild from the diff.
        #expect(got.filter { $0.type != .add }.map(\.text).joined(separator: "\n").utf16.elementsEqual(c.input.from.utf16))
        #expect(got.filter { $0.type != .del }.map(\.text).joined(separator: "\n").utf16.elementsEqual(c.input.to.utf16))
    }

    @Test(arguments: Fixture.cases("prompts", "promptsLoadErrorCases", input: LoadErrorInput.self, output: String.self))
    func promptsLoadError(_ c: Fixture.Case<LoadErrorInput, String>) {
        let error: Error = if let api = c.input.api {
            HarnessAPIError(status: api.status, message: api.message)
        } else {
            OtherError(errorDescription: c.input.message ?? c.input.thrown)
        }
        #expect(Prompts.promptsLoadError(error) == c.output)
    }
}
