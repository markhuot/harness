import Foundation
import Testing
@testable import HarnessKit

/// One `[key, value]` pair from Fixtures/clientQuery.json.
struct QueryParam: Decodable, Sendable {
    let key: String
    let value: QueryValue?

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        key = try c.decode(String.self)
        if try c.decodeNil() { value = nil }
        else if let n = try? c.decode(Double.self) { value = .number(n) }
        else { value = .string(try c.decode(String.self)) }
    }
}

@Suite("client query parity")
struct QueryTests {
    @Test(arguments: Fixture.cases("clientQuery", "queryCases", input: [QueryParam].self, output: String.self))
    func build(_ c: Fixture.Case<[QueryParam], String>) {
        #expect(Query.build(c.input.map { ($0.key, $0.value) }) == c.output)
    }

    @Test func repeatedKeyKeepsFirstPositionLastValue() {
        #expect(Query.build([("a", "1"), ("b", "2"), ("a", "3")]) == "?a=3&b=2")
    }
}

@Suite("reconnect backoff")
struct BackoffTests {
    @Test func doublesFrom250msAndCapsAt5s() {
        var b = ReconnectBackoff()
        let delays = (0..<8).map { _ in b.next() }
        #expect(delays == [.milliseconds(250), .milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(5), .seconds(5), .seconds(5)])
    }

    @Test func resetReturnsTo250ms() {
        var b = ReconnectBackoff()
        _ = b.next(); _ = b.next(); _ = b.next()
        b.reset()
        #expect(b.next() == .milliseconds(250))
    }
}
