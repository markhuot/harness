import Foundation
import Testing
@testable import HarnessKit

private func same<T: Encodable>(_ a: T, _ b: T) throws -> Bool {
    try jsonEqual(JSONEncoder().encode(a), JSONEncoder().encode(b))
}

extension MentionCaretTests {
    struct Step: Decodable, Sendable {
        let select: [Int]?
        let pick: Int?
        /// Distinguishes `before: null` from no `before` (both mean "no stale caret").
        let before: Int?
    }

    struct Run: Decodable, Sendable {
        let value: String
        let steps: [Step]
    }

    struct State: Codable, Sendable {
        let caret: MentionCaret
        let selection: MentionCaret.Selection?
        let mention: ActiveMention?
        let command: ActiveCommand?
    }
}

@Suite("mentionCaret.ts parity")
struct MentionCaretTests {
    /// Replays the input events and checks the state after every one.
    @Test(arguments: Fixture.cases("mentionCaret", "replayCases", input: Run.self, output: [State].self))
    func replay(_ c: Fixture.Case<Run, [State]>) throws {
        var caret = MentionCaret.none
        var got: [State] = []
        for step in c.input.steps {
            if let s = step.select {
                caret = caret.onSelection(start: s[0], end: s[1])
            } else {
                caret = MentionCaret.onPick(try #require(step.pick), before: step.before)
            }
            got.append(State(caret: caret, selection: caret.forcedSelection, mention: caret.mentionAt(c.input.value), command: caret.commandAt(c.input.value)))
        }
        #expect(got.count == c.output.count)
        for (g, want) in zip(got, c.output) {
            #expect(g.caret == want.caret)
            #expect(try same(g, want))
        }
    }
}
