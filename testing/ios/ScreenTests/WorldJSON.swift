import Foundation

/// testing/world/world.json, as JSON. The screens read it through the real client, which decodes it
/// with HarnessKit's own models (and `WorldDecodeTests` in testing/swift decodes all of it), so
/// what's served here is byte for byte what the Mac tests are served from the same world.
struct WorldJSON {
    var root: [String: Any]

    /// testing/world/world.json, found from this file's path (testing/ios/ScreenTests/).
    static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("world/world.json")

    static func load() throws -> WorldJSON {
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        guard let root = object as? [String: Any] else { throw CocoaError(.fileReadCorruptFile) }
        return WorldJSON(root: root)
    }

    /// The world's "now" in epoch milliseconds: what the screens treat as the current time.
    var now: Double { (root["now"] as? NSNumber)?.doubleValue ?? 0 }

    var timeZone: TimeZone { TimeZone(identifier: root["timeZone"] as? String ?? "UTC") ?? .gmt }

    func list(_ key: String) -> [[String: Any]] { root[key] as? [[String: Any]] ?? [] }

    /// Sets fields on one ticket wherever the world holds it (the board's list and its detail).
    mutating func patch(_ key: String, _ fields: [String: Any]) {
        var tickets = list("tickets")
        if let i = tickets.firstIndex(where: { $0["key"] as? String == key }) { tickets[i].merge(fields) { $1 } }
        root["tickets"] = tickets
        var details = root["details"] as? [String: Any] ?? [:]
        if var detail = details[key] as? [String: Any], var ticket = detail["ticket"] as? [String: Any] {
            ticket.merge(fields) { $1 }
            detail["ticket"] = ticket
            details[key] = detail
        }
        root["details"] = details
    }

    /// Changes one ticket's title wherever the world holds it (the board's list and its detail).
    mutating func retitle(_ key: String, to title: String) {
        var tickets = list("tickets")
        if let i = tickets.firstIndex(where: { $0["key"] as? String == key }) { tickets[i]["title"] = title }
        root["tickets"] = tickets
        var details = root["details"] as? [String: Any] ?? [:]
        if var detail = details[key] as? [String: Any], var ticket = detail["ticket"] as? [String: Any] {
            ticket["title"] = title
            detail["ticket"] = ticket
            details[key] = detail
        }
        root["details"] = details
    }
}
