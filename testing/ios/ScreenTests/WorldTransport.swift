import Foundation
import HarnessKit
import UIKit

/// The service, answered from the world: the real HarnessClient sends its real requests, and this
/// routes each one by method and path to a slice of world.json. A path no route answers is a 404 and
/// is recorded in `unrouted`, which every test asserts empty, so a screen that asks for something
/// the world doesn't hold fails loudly instead of rendering a quiet blank.
final class WorldTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let world: WorldJSON
    private var _unrouted: [String] = []
    private var _inflight = 0

    init(_ world: WorldJSON) { self.world = world }

    var unrouted: [String] { lock.withLock { _unrouted } }
    /// Requests started and not yet answered: a render waits for 0 so a screen isn't captured mid-load.
    var inflight: Int { lock.withLock { _inflight } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { _inflight += 1 }
        defer { lock.withLock { _inflight -= 1 } }
        // One turn, as a network hop is: callers never see a response before they've awaited it.
        await Task.yield()
        let query = Dictionary(
            (URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") },
            uniquingKeysWith: { a, _ in a })
        // An image file's bytes (FileView.image): a picture drawn here, since the world holds JSON only.
        if request.method == "GET", request.url.path.hasSuffix("/file/raw"),
           let view = fileEntries("views", path: query["path"]) as? [String: Any], view["image"] is String {
            return HTTPResponse(status: 200, body: Self.picture)
        }
        if request.method == "GET", let data = answer(request.url.path, query) {
            let body = try JSONSerialization.data(withJSONObject: ["data": data])
            return HTTPResponse(status: 200, body: body)
        }
        // A file sent in a message is still there: the attachment list checks with a HEAD.
        if request.method == "HEAD", request.url.path.hasPrefix("/attachments/") { return HTTPResponse(status: 200, body: Data()) }
        // The store asks for plan usage on every refresh; the world has none, and an unreported usage is a valid state.
        if request.url.path != "/usage" { lock.withLock { _unrouted.append("\(request.method) \(request.url.path)") } }
        return HTTPResponse(status: 404, body: Data(#"{"error":"the world has no such route"}"#.utf8))
    }

    /// A 320×200 PNG: a two-tone mark on a transparent ground, so the viewer's frame and fit show.
    static let picture: Data = {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 200), format: format).image { ctx in
            UIColor(red: 0.2, green: 0.4, blue: 0.9, alpha: 1).setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 40, y: 30, width: 140, height: 140))
            UIColor(red: 0.95, green: 0.6, blue: 0.2, alpha: 1).setFill()
            ctx.fill(CGRect(x: 160, y: 60, width: 120, height: 80))
        }
        return image.pngData()!
    }()

    private func answer(_ path: String, _ q: [String: String]) -> Any? {
        let w = world
        switch path {
        case "/health": return ["ok": true]
        case "/projects": return w.list("projects")
        case "/labels": return w.list("labels")
        case "/sessions": return w.list("sessions").filter { q["kind"] == nil || $0["kind"] as? String == q["kind"] }
        case "/watchers": return w.list("watchers")
        case "/settings": return w.root["settings"]
        case "/cos": return w.list("chiefs")
        case "/cos/events/badge": return w.root["cosBadge"]
        case "/drivers": return w.list("drivers")
        case "/terminals", "/prompts", "/plugins": return [Any]()
        case "/network": return ["mode": "localhost", "host": NSNull(), "port": 7717, "bound": [Any](), "active": "localhost", "tailscale": NSNull(), "error": NSNull(), "override": NSNull()] as [String: Any]
        case "/notifications": return ["keyDir": "/Users/dev/.appstoreconnect/private_keys", "keys": [Any](), "devices": [Any](), "presence": [Any]()] as [String: Any]
        case "/browser-extensions": return ["extensions": [Any](), "running": false] as [String: Any]
        case "/pairing": return ["url": "http://127.0.0.1:7717", "token": "world", "pairUrl": "harness://pair"]
        case "/tickets":
            let statuses = q["status"]?.split(separator: ",").map(String.init)
            return w.list("tickets").filter { t in
                (statuses == nil || statuses!.contains(t["status"] as? String ?? "")) && (q["projectId"] == nil || t["projectId"] as? String == q["projectId"])
            }
        case "/tickets/page":
            let status = q["status"] ?? "done"
            let when = { (t: [String: Any]) in (t["completedAt"] as? NSNumber ?? t["updatedAt"] as? NSNumber)?.doubleValue ?? 0 }
            let all = w.list("tickets").filter { $0["status"] as? String == status }.sorted { when($0) > when($1) }
            let page = Array(all.prefix(Int(q["limit"] ?? "") ?? all.count))
            return ["tickets": page, "nextCursor": NSNull(), "total": all.count] as [String: Any]
        case "/plugins/git/api/changes": return (changesFor(q["ticket"]))?["changes"]
        case "/plugins/git/api/log": return (changesFor(q["ticket"]))?["log"]
        default: break
        }
        let parts = path.split(separator: "/").map(String.init)
        if parts.count == 3, parts[0] == "tickets", parts[2] == "events" {
            // A chief's page is its Inbox (its own rows and the unassigned ones); any other ticket's is the rows aimed at it. By key or id.
            let id = w.list("tickets").first { $0["key"] as? String == parts[1] }?["id"] as? String ?? parts[1]
            let chief = w.list("chiefs").contains { $0["ticketId"] as? String == id }
            return ["items": w.list("ticketEvents").filter { ($0["targetId"] as? String == id) || (chief && $0["targetId"] is NSNull) }, "nextCursor": NSNull()] as [String: Any]
        }
        // A ticket's Browser tab, which the regular-width pager mounts beside the tab on screen: the world's sessions have no browser.
        if parts.count == 2, parts[0] == "browser" { return NSNull() }
        if parts.count == 3, parts[0] == "cos", parts[2] == "transcript" {
            // Newest page first, as the service sends it; the world's chat is one page.
            return ["entries": Array(w.list("cosChat").filter { $0["cosId"] as? String == parts[1] }.reversed()), "nextCursor": NSNull()] as [String: Any]
        }
        if parts.count == 3, parts[0] == "tickets", parts[2] == "memory", w.list("chiefs").contains(where: { $0["key"] as? String == parts[1] }) { return w.root["cosMemory"] }
        if parts.count == 3, parts[0] == "projects", parts[2] == "branches" { return [["name": "main", "lastCommitAt": w.now - 3_600_000] as [String: Any]] }
        if parts.count == 3, parts[0] == "drivers", parts[2] == "models" {
            return ["driverId": parts[1], "models": [["id": "claude-opus-5-5", "name": "Opus 5.5", "default": true] as [String: Any]], "error": NSNull(), "fetchedAt": w.now] as [String: Any]
        }
        if parts.count == 2, parts[0] == "tickets" { return (w.root["details"] as? [String: Any])?[parts[1]] }
        if parts.count == 3, parts[0] == "tickets", let ticket = w.list("tickets").first(where: { $0["key"] as? String == parts[1] }) {
            switch parts[2] {
            case "activity": return w.list("activity").filter { $0["ticketId"] as? String == ticket["id"] as? String }
            case "tabs": return [Any]()
            case "file": return fileEntries("views", path: q["path"])
            default: return nil
            }
        }
        if parts.count == 4, parts[0] == "tickets", parts[2] == "file", parts[3] == "diff" { return fileEntries("diffs", path: q["path"]) }
        if parts.count == 4, parts[0] == "tickets", parts[2] == "spec", parts[3] == "revisions",
           let t = w.list("tickets").first(where: { $0["key"] as? String == parts[1] }) {
            return [["rev": t["specRevision"] ?? 1, "author": "agent", "note": "Plan drafted", "approvedBaseline": false, "createdAt": t["createdAt"] ?? 0] as [String: Any]]
        }
        if parts.count == 3, parts[0] == "sessions", parts[2] == "transcript" {
            let after = Double(q["after"] ?? "") ?? 0
            return w.list("transcript").filter { $0["sessionId"] as? String == parts[1] && ($0["seq"] as? NSNumber)?.doubleValue ?? 0 > after }
        }
        if parts.count == 3, parts[0] == "sessions", parts[2] == "subagents" { return [Any]() }
        return nil
    }

    private func changesFor(_ ticket: String?) -> [String: Any]? {
        guard let ticket else { return nil }
        return (world.root["changes"] as? [String: Any])?[ticket] as? [String: Any]
    }

    private func fileEntries(_ kind: String, path: String?) -> Any? {
        let files = world.root["files"] as? [String: Any]
        return (files?[kind] as? [[String: Any]])?.first { $0["path"] as? String == path }
    }
}
