import Foundation
import Testing
import HarnessKit

/// testing/world/world.json is what the iPhone and iPad screen tests load through the real client, so
/// every part of it has to decode through the production models. A field the world gains that Swift
/// can't read fails here with the model's name, not as a blank screen in a render.
@Suite struct WorldDecodeTests {
    private static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("world/world.json")

    private static func world() throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]))
    }

    private func decodeAll<T: Decodable>(_ type: T.Type, key: String) throws -> [T] {
        let list = try #require(Self.world()[key] as? [Any], "world.json has no \(key)")
        #expect(!list.isEmpty, "\(key) is empty")
        return try list.map { try decode(T.self, $0) }
    }

    @Test func everyEntityListDecodesThroughHarnessKit() throws {
        let projects = try decodeAll(Project.self, key: "projects")
        let tickets = try decodeAll(Ticket.self, key: "tickets")
        let sessions = try decodeAll(Session.self, key: "sessions")
        _ = try decodeAll(Run.self, key: "runs")
        _ = try decodeAll(TranscriptEntry.self, key: "transcript")
        _ = try decodeAll(ActivityEntry.self, key: "activity")
        _ = try decodeAll(Watcher.self, key: "watchers")
        _ = try decodeAll(DriverInfo.self, key: "drivers")
        _ = try decode(PublicSettings.self, try #require(Self.world()["settings"]))
        #expect(Set(tickets.map(\.projectId)).isSubset(of: Set(projects.map(\.id))))
        #expect(Set(tickets.map(\.status)) == Set(TicketStatus.allKnown), "the world shows a ticket in every status")
        #expect(!sessions.contains { $0.kind == .triage }, "triage is gone: the chiefs of staff have the events now")
        let chiefs = try decodeAll(Cos.self, key: "chiefs")
        let events = try decodeAll(TicketEvent.self, key: "ticketEvents")
        _ = try decodeAll(CosChatEntry.self, key: "cosChat")
        _ = try decode(CosBadge.self, try #require(Self.world()["cosBadge"]))
        _ = try decode(CosMemory.self, try #require(Self.world()["cosMemory"]))
        #expect(Set(events.map(\.status)) == Set(TicketEventStatus.allKnown).subtracting([.triaging]), "the world's Inbox shows every state a row can rest in (triaging reads like pending)")
        #expect(Set(events.compactMap(\.cosId)).isSubset(of: Set(chiefs.map(\.ticketId))))
        #expect(projects.contains { $0.cosEnabled == .value(false) }, "a project with its chief switched off")
    }

    @Test func everyTicketDetailAndFileDecodes() throws {
        let details = try #require(Self.world()["details"] as? [String: Any])
        #expect(details.count == (try decodeAll(Ticket.self, key: "tickets")).count)
        for (key, value) in details {
            let detail = try decode(TicketDetail.self, value)
            #expect(detail.ticket.key == key)
        }
        let changes = try #require(Self.world()["changes"] as? [String: [String: Any]])
        #expect(!changes.isEmpty)
        for (_, pair) in changes {
            _ = try decode(Changes.self, try #require(pair["changes"]))
            _ = try decode(ChangesLog.self, try #require(pair["log"]))
        }
        let files = try #require(Self.world()["files"] as? [String: Any])
        for view in try #require(files["views"] as? [Any]) { _ = try decode(FileView.self, view) }
        for diff in try #require(files["diffs"] as? [Any]) { _ = try decode(FileDiff.self, diff) }
    }
}
