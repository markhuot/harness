import Testing
@testable import HarnessKit

enum ServerOp: Decodable, Sendable {
    case upsert(baseUrl: String, now: Int)
    case remove(id: String, activeId: String?)
    case rename(id: String, name: String)

    private enum Keys: String, CodingKey { case op, baseUrl, now, id, activeId, name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .op) {
        case "upsert": self = .upsert(baseUrl: try c.decode(String.self, forKey: .baseUrl), now: try c.decode(Int.self, forKey: .now))
        case "remove": self = .remove(id: try c.decode(String.self, forKey: .id), activeId: try c.decodeIfPresent(String.self, forKey: .activeId))
        case "rename": self = .rename(id: try c.decode(String.self, forKey: .id), name: try c.decode(String.self, forKey: .name))
        case let other: throw DecodingError.dataCorruptedError(forKey: .op, in: c, debugDescription: "unknown op \(other)")
        }
    }
}

struct ServersInput: Decodable, Sendable {
    let list: [SavedServer]
    let ops: [ServerOp]
}

/// One step's TS output: upsert → list/server/added, remove → list/active, rename → list.
struct ServerStep: Decodable, Sendable, Equatable {
    let list: [SavedServer]
    let server: SavedServer?
    let added: Bool?
    let active: String?
}

@Suite("mobile servers.ts parity")
struct ServersTests {
    @Test(arguments: Fixture.cases("mobileServers", "serverCases", input: ServersInput.self, output: [ServerStep].self))
    func sequence(_ c: Fixture.Case<ServersInput, [ServerStep]>) {
        var n = 0
        let makeId = { () -> String in
            n += 1
            return "s\(n)"
        }
        var current = c.input.list
        var steps: [ServerStep] = []
        for op in c.input.ops {
            switch op {
            case let .upsert(baseUrl, now):
                let r = Servers.upsertServer(current, baseUrl: baseUrl, now: now, makeId: makeId)
                steps.append(ServerStep(list: r.list, server: r.server, added: r.added, active: nil))
                current = r.list
            case let .remove(id, activeId):
                let r = Servers.removeServer(current, id: id, activeId: activeId)
                steps.append(ServerStep(list: r.list, server: nil, added: nil, active: r.active))
                current = r.list
            case let .rename(id, name):
                current = Servers.renameServer(current, id: id, name: name)
                steps.append(ServerStep(list: current, server: nil, added: nil, active: nil))
            }
        }
        #expect(steps == c.output)
    }
}
