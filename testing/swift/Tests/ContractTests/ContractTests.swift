import Foundation
import Testing
import HarnessKit

private let fixtures = loadFixtures()

/// Every case of every type, one test per type so a failure names it.
private let typeNames: [String] = (try? fixtures.get().types.keys.sorted()) ?? []

@Suite struct ContractTests {
    @Test func theFixturesAreThere() throws {
        _ = try fixtures.get()
    }

    @Test func everyFixtureHasASwiftTypeAndEveryMappingAFixture() throws {
        let f = try fixtures.get()
        let mapped = Set(codecs.keys).union(swiftExemptions.keys)
        #expect(Set(f.types.keys).subtracting(mapped).sorted() == [], "wire types protocol.ts exports with no Swift type in Registry.swift")
        #expect(mapped.subtracting(f.types.keys).sorted() == [], "Registry.swift names types protocol.ts no longer exports")
        #expect(Set(f.literals.keys).subtracting(enumValues.keys).sorted() == [], "string unions with no Swift enum in Registry.swift")
        #expect(Set(enumValues.keys).subtracting(f.literals.keys).sorted() == [], "Registry.swift names string unions protocol.ts no longer has")
        #expect(Set(f.consts.keys).subtracting(constValues.keys).sorted() == [], "`as const` lists with no Swift port in Registry.swift")
        #expect(Set(constValues.keys).subtracting(f.consts.keys).sorted() == [], "Registry.swift names lists protocol.ts no longer exports")
    }

    /// What Swift drops from every case of every type, as `Type.field`, minus the deliberate gaps.
    private func problems(_ name: String, _ fixture: FixtureCase) -> [Problem] {
        guard let codec = codecs[name] else { return [] }  // exempt: the mapping test accounts for it
        return codec.check(fixture.json.data, fixture.owners)
    }

    @Test(arguments: typeNames)
    func swiftDecodesAndEncodesEveryCase(of name: String) throws {
        for fixture in try #require(try fixtures.get().types[name]) {
            let found = problems(name, fixture).filter { $0.dropped.map { ignoredFields[$0] == nil } ?? true }
            let report = "\(name) [\(fixture.label)] \(String(decoding: fixture.json.data, as: UTF8.self))\n  \(found.map(\.message).joined(separator: "\n  "))"
            #expect(found.isEmpty, Comment(rawValue: report))
        }
    }

    @Test func everyIgnoredFieldIsStillDropped() throws {
        let f = try fixtures.get()
        var dropped: Set<String> = []
        for (name, cases) in f.types { for fixture in cases { dropped.formUnion(problems(name, fixture).compactMap(\.dropped)) } }
        #expect(Set(ignoredFields.keys).subtracting(dropped).sorted() == [], "Swift models these now: remove them from ignoredFields")
    }

    @Test func swiftKnowsExactlyTheValuesOfEveryStringUnion() throws {
        let f = try fixtures.get()
        for (name, values) in f.literals {
            guard let swift = enumValues[name] else { continue }
            #expect(Set(swift) == Set(values), "\(name): TS has \(values.sorted()), Swift knows \(swift.sorted())")
        }
        for (name, values) in f.consts {
            guard let swift = constValues[name] else { continue }
            #expect(swift == values, "\(name): TS lists \(values), Swift lists \(swift)")
        }
    }
}

/// The check has to be able to fail: each kind of drift, applied to a real HarnessKit type, is caught.
@Suite struct ContractCheckCanFail {
    private func problems(_ type: Codec, _ json: String) -> [String] { type.check(Data(json.utf8), ["$": "Owner"]).map(\.message) }

    @Test func aMatchingFixturePasses() {
        #expect(problems(.codable(SpecDiff.self), #"{"from":1,"to":2,"diff":"x"}"#) == [])
        #expect(problems(.codable(HarnessEvent.self), #"{"kind":"devices.changed"}"#) == [])
    }

    @Test func aRenamedFieldIsCaught() {
        let found = problems(.codable(SpecDiff.self), #"{"from":1,"to":2,"patch":"x"}"#)
        #expect(!found.isEmpty)
    }

    @Test func aFieldSwiftDoesNotModelIsCaught() {
        let found = problems(.codable(SpecDiff.self), #"{"from":1,"to":2,"diff":"x","extra":true}"#)
        #expect(found.contains { $0.contains("extra") && $0.contains("drops") })
    }

    @Test func aDroppedFieldNamesTheTypeThatOwnsIt() {
        let found = Codec.codable(SpecDiff.self).check(Data(#"{"from":1,"to":2,"diff":"x","extra":true}"#.utf8), ["$": "SpecDiff"])
        #expect(found.compactMap(\.dropped) == ["SpecDiff.extra"])
    }

    @Test func aRetypedFieldIsCaught() {
        #expect(!problems(.codable(SpecDiff.self), #"{"from":"1","to":2,"diff":"x"}"#).isEmpty)
    }

    @Test func aRenamedUnionTagIsCaughtEvenThoughItWouldRoundTrip() {
        let found = problems(.codable(HarnessEvent.self), #"{"kind":"devices.changed2"}"#)
        #expect(found.contains { $0.contains(".unknown") })
    }

    @Test func aRenamedEnumValueIsCaughtEvenThoughItWouldRoundTrip() {
        #expect(problems(.codable(PermissionMode.self), #""read-only""#).contains { $0.contains(".unknown") })
        #expect(problems(.codable(PermissionMode.self), #""read_only""#) == [])
    }
}
