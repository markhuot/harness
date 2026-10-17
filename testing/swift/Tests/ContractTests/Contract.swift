import Foundation
import HarnessKit

/// One way Swift disagrees with a fixture. `dropped` names the `Type.field` Swift doesn't model,
/// so a deliberate gap can be listed in Registry.swift's `ignoredFields`.
struct Problem: Sendable {
    let message: String
    var dropped: String? = nil
}

/// What decoding one fixture case and encoding it again found wrong: empty when Swift agrees.
struct Codec: Sendable {
    let check: @Sendable (_ json: Data, _ owners: [String: String]) -> [Problem]

    /// Decode with the Swift type, refuse any `.unknown` fallback, encode again and compare to the
    /// original JSON. A field Swift drops is missing from the re-encoding, a mistyped one throws,
    /// and a renamed tag or enum value lands on `.unknown`, which a round trip would hide because
    /// `.unknown` re-encodes the raw value unchanged.
    static func codable<T: Codable>(_: T.Type) -> Codec {
        Codec { data, owners in
            let value: T
            do {
                value = try JSONDecoder().decode(T.self, from: data)
            } catch {
                return [Problem(message: "does not decode: \(error)")]
            }
            var problems = unknownPaths(in: value, path: "$").map { Problem(message: "\($0): decoded to .unknown (a tag or value Swift doesn't know)") }
            do {
                let encoded = try JSONEncoder().encode(value)
                problems += differences(expected: try parse(data), actual: try parse(encoded), path: "$", owners: owners)
            } catch {
                problems.append(Problem(message: "does not re-encode: \(error)"))
            }
            return problems
        }
    }
}

private func parse(_ data: Data) throws -> Any {
    try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
}

private func isBool(_ value: Any) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
}

/// Every place `expected` and `actual` differ. Key order is ignored and numbers compare by value
/// (`3` and `3.0` agree); an absent key and a null stay different, as they do on the wire.
func differences(expected: Any, actual: Any, path: String, owners: [String: String]) -> [Problem] {
    switch (expected, actual) {
    case let (e as [String: Any], a as [String: Any]):
        var out: [Problem] = []
        for key in e.keys.sorted() {
            guard let theirs = a[key] else {
                let dropped = owners[path].map { "\($0).\(key)" }
                out.append(Problem(message: "\(path).\(key): Swift drops this field" + (dropped.map { " (\($0), or list it in ignoredFields)" } ?? ""), dropped: dropped))
                continue
            }
            out += differences(expected: e[key]!, actual: theirs, path: "\(path).\(key)", owners: owners)
        }
        for key in a.keys.sorted() where e[key] == nil { out.append(Problem(message: "\(path).\(key): Swift adds a field the fixture lacks")) }
        return out
    case let (e as [Any], a as [Any]):
        guard e.count == a.count else { return [Problem(message: "\(path): \(e.count) items became \(a.count)")] }
        return zip(e, a).enumerated().flatMap { differences(expected: $1.0, actual: $1.1, path: "\(path)[\($0)]", owners: owners) }
    case is (NSNull, NSNull):
        return []
    default:
        let changed = [Problem(message: "\(path): \(expected) became \(actual)")]
        if isBool(expected) != isBool(actual) { return changed }
        if let e = expected as? NSNumber, let a = actual as? NSNumber { return e.doubleValue == a.doubleValue ? [] : changed }
        if let e = expected as? String, let a = actual as? String { return e == a ? [] : changed }
        return changed
    }
}

/// Paths of every enum case named `unknown` inside `value`: HarnessKit's open enums and tagged
/// unions fall back to one, and `Patch`, optionals, arrays and dictionaries are walked through.
func unknownPaths(in value: Any, path: String) -> [String] {
    let mirror = Mirror(reflecting: value)
    var out: [String] = []
    for child in mirror.children {
        let label = child.label ?? ""
        if mirror.displayStyle == .enum && label == "unknown" { out.append(path) }
        let next = mirror.displayStyle == .enum || label.isEmpty || label == "some" ? path : "\(path).\(label)"
        out += unknownPaths(in: child.value, path: next)
    }
    return out
}

struct FixtureCase: Decodable, Sendable {
    let label: String
    let json: AnyJSON
    let owners: [String: String]
}

/// A fixture's JSON kept as bytes: the cases are decoded by HarnessKit's types, not by this struct.
struct AnyJSON: Decodable, Sendable {
    let data: Data
    init(from decoder: any Decoder) throws {
        let value = try JSONValue(from: decoder)
        data = try JSONEncoder().encode(value)
    }
}

struct Fixtures: Decodable, Sendable {
    let types: [String: [FixtureCase]]
    let literals: [String: [String]]
    let consts: [String: [String]]
}

/// What `testing/contract/swift.test.ts` wrote; nil when this was run by hand without it.
func loadFixtures() -> Result<Fixtures, FixtureError> {
    guard let path = ProcessInfo.processInfo.environment["HARNESS_CONTRACT_FIXTURES"] else {
        return .failure(FixtureError("HARNESS_CONTRACT_FIXTURES is not set: run these through `bun test testing/contract`, which writes the fixtures"))
    }
    do {
        return .success(try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: URL(fileURLWithPath: path))))
    } catch {
        return .failure(FixtureError("can't read the fixtures at \(path): \(error)"))
    }
}

struct FixtureError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
