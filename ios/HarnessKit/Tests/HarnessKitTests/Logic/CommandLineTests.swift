import Testing
@testable import HarnessKit

struct CommandLineInput: Decodable, Sendable {
    let command: String
    let args: [String]?
}

@Suite("commandLine.ts parity")
struct CommandLineTests {
    @Test(arguments: Fixture.cases("commandLine", "commandLineCases", input: CommandLineInput.self, output: String.self))
    func commandLine(_ c: Fixture.Case<CommandLineInput, String>) {
        let got = c.input.args.map { ShellCommandLine.commandLine(c.input.command, args: $0) } ?? ShellCommandLine.commandLine(c.input.command)
        #expect(Array(got.unicodeScalars) == Array(c.output.unicodeScalars))
    }
}
