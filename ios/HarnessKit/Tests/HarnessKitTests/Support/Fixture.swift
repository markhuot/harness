import Foundation
import Testing

/// Loads the JSON that `bun shared/scripts/export-fixtures.ts` writes to Fixtures/<module>.json.
///
/// Each file is `{ "<exportName>": <value> }`, one entry per named export of
/// shared/fixtures/cases/<module>.ts. By convention a case list is `[{ name, input, output }]`
/// with `output` computed by calling the real TypeScript function.
enum Fixture {
    struct Case<Input: Decodable & Sendable, Output: Decodable & Sendable>: Decodable, Sendable, CustomTestStringConvertible {
        let name: String
        let input: Input
        let output: Output
        var testDescription: String { name }
    }

    /// The raw bytes of Fixtures/<module>.json.
    static func data(_ module: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: module, withExtension: "json", subdirectory: "Fixtures") else {
            throw FixtureError.missing(module)
        }
        return try Data(contentsOf: url)
    }

    /// One named export decoded as `T`.
    static func value<T: Decodable>(_ module: String, _ export: String, as type: T.Type = T.self) throws -> T {
        let root = try JSONSerialization.jsonObject(with: data(module), options: [.fragmentsAllowed])
        guard let dict = root as? [String: Any], let value = dict[export] else { throw FixtureError.missingExport(module, export) }
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        return try JSONDecoder().decode(T.self, from: bytes)
    }

    /// A case list (`[{ name, input, output }]`) for parameterized tests. Traps when the fixture
    /// is missing so `@Test(arguments:)` fails loudly instead of running zero cases.
    static func cases<Input, Output>(_ module: String, _ export: String, input: Input.Type = Input.self, output: Output.Type = Output.self) -> [Case<Input, Output>] {
        do {
            let list = try value(module, export, as: [Case<Input, Output>].self)
            precondition(!list.isEmpty, "Fixture \(module).\(export) has no cases")
            return list
        } catch {
            fatalError("Fixture \(module).\(export): \(error)")
        }
    }

    /// Every export name in a module, for tests that walk them all.
    static func exports(_ module: String) throws -> [String] {
        let root = try JSONSerialization.jsonObject(with: data(module))
        guard let dict = root as? [String: Any] else { return [] }
        return dict.keys.sorted()
    }
}

enum FixtureError: Error, CustomStringConvertible {
    case missing(String)
    case missingExport(String, String)
    var description: String {
        switch self {
        case let .missing(m): "No Fixtures/\(m).json. Run `bun shared/scripts/export-fixtures.ts`."
        case let .missingExport(m, e): "Fixtures/\(m).json has no export \(e). Run `bun shared/scripts/export-fixtures.ts`."
        }
    }
}

/// Key-order-insensitive JSON equality (numbers compared as NSNumber, so 1 == 1.0).
func jsonEqual(_ a: Data, _ b: Data) throws -> Bool {
    let x = try JSONSerialization.jsonObject(with: a, options: [.fragmentsAllowed])
    let y = try JSONSerialization.jsonObject(with: b, options: [.fragmentsAllowed])
    return (x as AnyObject).isEqual(y)
}
