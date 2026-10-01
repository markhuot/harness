import Foundation
import Testing
@testable import HarnessKit

private func same<T: Encodable>(_ a: T, _ b: T) throws -> Bool {
    try jsonEqual(JSONEncoder().encode(a), JSONEncoder().encode(b))
}

extension CommandsTests {
    struct CaretInput: Decodable, Sendable {
        let text: String
        let caret: Int
    }

    struct InsertInput: Decodable, Sendable {
        let text: String
        let command: ActiveCommand
        let name: String
    }

    struct RankInput: Decodable, Sendable {
        let commands: [CommandMatch]
        let query: String
        let limit: Int?
    }
}

@Suite("commands.ts parity")
struct CommandsTests {
    @Test(arguments: Fixture.cases("commands", "activeCommandCases", input: CaretInput.self, output: ActiveCommand?.self))
    func activeCommand(_ c: Fixture.Case<CaretInput, ActiveCommand?>) throws {
        #expect(try same(Commands.activeCommand(c.input.text, caret: c.input.caret), c.output))
    }

    @Test(arguments: Fixture.cases("commands", "insertCommandCases", input: InsertInput.self, output: TextInsertion.self))
    func insertCommand(_ c: Fixture.Case<InsertInput, TextInsertion>) throws {
        #expect(try same(Commands.insertCommand(c.input.text, command: c.input.command, name: c.input.name), c.output))
    }

    @Test(arguments: Fixture.cases("commands", "rankCommandsCases", input: RankInput.self, output: [CommandMatch].self))
    func rankCommands(_ c: Fixture.Case<RankInput, [CommandMatch]>) throws {
        #expect(try same(Commands.rankCommands(c.input.commands, query: c.input.query, limit: c.input.limit ?? 50), c.output))
    }
}
