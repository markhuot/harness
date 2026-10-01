import Foundation
import Testing
@testable import HarnessKit

private func same<T: Encodable>(_ a: T, _ b: T) throws -> Bool {
    try jsonEqual(JSONEncoder().encode(a), JSONEncoder().encode(b))
}

extension TemplatesTests {
    /// `{ ok }` or `{ error }`, as the case file records a call that may throw.
    struct Attempt<T: Codable & Sendable>: Codable, Sendable {
        var ok: T?
        var error: String?
    }

    struct ErrorInput: Decodable, Sendable {
        let src: String
        let allowed: [String]
    }

    struct RenderInput: Decodable, Sendable {
        let template: String
        let vars: [String: TemplateValue]
    }
}

private func attempt<T: Codable & Sendable>(_ fn: () throws(TemplateError) -> T) -> TemplatesTests.Attempt<T> {
    do { return .init(ok: try fn()) } catch { return .init(error: error.message) }
}

@Suite("templates.ts parity")
struct TemplatesTests {
    @Test(arguments: Fixture.cases("templates", "parseTemplateCases", input: String.self, output: Attempt<[TemplateNode]>.self))
    func parse(_ c: Fixture.Case<String, Attempt<[TemplateNode]>>) throws {
        let got = attempt { () throws(TemplateError) in try Templates.parse(c.input) }
        #expect(got.error == c.output.error)
        #expect(try same(got, c.output))
    }

    @Test(arguments: Fixture.cases("templates", "templateVariablesCases", input: String.self, output: [String].self))
    func variables(_ c: Fixture.Case<String, [String]>) throws {
        #expect(try Templates.variables(Templates.parse(c.input)) == c.output)
    }

    @Test(arguments: Fixture.cases("templates", "templateErrorCases", input: ErrorInput.self, output: String?.self))
    func templateError(_ c: Fixture.Case<ErrorInput, String?>) {
        #expect(Templates.error(c.input.src, allowed: c.input.allowed) == c.output)
    }

    @Test(arguments: Fixture.cases("templates", "renderTemplateCases", input: RenderInput.self, output: Attempt<String>.self))
    func render(_ c: Fixture.Case<RenderInput, Attempt<String>>) throws {
        let got = attempt { () throws(TemplateError) in try Templates.render(c.input.template, c.input.vars) }
        #expect(got.error == c.output.error)
        #expect(try same(got, c.output))
    }

    /// Parsed nodes render the same as the source they came from (the overload the service uses to
    /// parse once and render per run).
    @Test(arguments: Fixture.cases("templates", "renderTemplateCases", input: RenderInput.self, output: Attempt<String>.self))
    func renderParsed(_ c: Fixture.Case<RenderInput, Attempt<String>>) throws {
        let got = attempt { () throws(TemplateError) in try Templates.render(Templates.parse(c.input.template), c.input.vars) }
        #expect(try same(got, c.output))
    }

    /// The parsed tree round-trips through the TS node JSON.
    @Test(arguments: Fixture.cases("templates", "parseTemplateCases", input: String.self, output: Attempt<[TemplateNode]>.self))
    func nodeCoding(_ c: Fixture.Case<String, Attempt<[TemplateNode]>>) throws {
        guard let nodes = c.output.ok else { return }
        let decoded = try JSONDecoder().decode([TemplateNode].self, from: JSONEncoder().encode(nodes))
        #expect(decoded == nodes)
    }
}
