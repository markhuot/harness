import Foundation

// What this device shows, for the service's notifications (DESIGN.md "Notifications"): each window
// (iPadOS scene) reports its phase and the tickets on screen; PresenceTracker folds them into the
// one `presence` message the active server's socket sends.

/// One window's part of the presence.
public struct ScenePresence: Equatable, Sendable {
    public enum Phase: Sendable { case active, inactive, background }

    public var phase: Phase
    /// The ticket keys on screen in this window.
    public var tickets: [String]

    public init(phase: Phase, tickets: [String]) {
        self.phase = phase
        self.tickets = tickets
    }
}

public enum PresenceRules {
    /// The tickets on screen in `router`'s window. `board` lists the board's cards (as the board
    /// filters them) and is only asked for when the board is showing.
    /// - A ticket window shows its ticket: the last one pushed on its stack, else its root.
    /// - A main window under a full-screen cover (the scanner) shows nothing.
    /// - A presented ticket sheet covering the board (the iPhone's): just the ticket on top of it.
    /// - Otherwise the selected section: the last ticket pushed on its stack, else the board's
    ///   cards when it's the board at its root; plus the ticket on top of the sheet beside it
    ///   (`sheetIsBesideBoard`, the iPad's panel) or of the docked sheet, whose bar sits under it.
    @MainActor
    public static func tickets(_ router: Router, board: () -> [String]) -> [String] {
        switch router.scope {
        case .ticket:
            if let key = lastTicket(router.path(.board)) { return [key] }
            if case let .ticket(key, _)? = router.root { return [key] }
            return []
        case .main:
            if router.cover != nil { return [] }
            if !router.sheetIsBesideBoard, let sheet = router.ticketSheet {
                return sheet.topTicketKey.map { [$0] } ?? []
            }
            var out: [String] = []
            let path = router.path(router.selectedTab)
            if let key = lastTicket(path) {
                out.append(key)
            } else if path.isEmpty, router.selectedTab == .board {
                out += board()
            }
            if let key = (router.ticketSheet ?? router.dock)?.topTicketKey { out.append(key) }
            return out
        }
    }

    /// The presence for all the windows: visible while any of them is active (in front and taking
    /// input), listing the tickets of every window still in the foreground. Tickets are
    /// deduplicated and sorted.
    public static func presence(deviceId: String, platform: DevicePlatform = .ios, scenes: [ScenePresence]) -> Presence {
        let visible = scenes.contains { $0.phase == .active }
        let tickets = scenes.filter { $0.phase != .background }.flatMap(\.tickets)
        return Presence(deviceId: deviceId, platform: platform, visible: visible, tickets: tickets).normalized
    }

    private static func lastTicket(_ path: [Route]) -> String? {
        for route in path.reversed() {
            if case let .ticket(key, _) = route { return key }
        }
        return nil
    }
}

/// Collects each window's ScenePresence and hands the combined Presence to `send` whenever it
/// changes. A window that closes is removed.
@MainActor
public final class PresenceTracker {
    public let deviceId: String
    private let send: @MainActor (Presence) -> Void
    private var scenes: [String: ScenePresence] = [:]
    private var last: Presence?

    public init(deviceId: String, send: @escaping @MainActor (Presence) -> Void) {
        self.deviceId = deviceId
        self.send = send
    }

    /// The presence now.
    public var presence: Presence { PresenceRules.presence(deviceId: deviceId, scenes: Array(scenes.values)) }

    public func update(_ sceneId: String, _ scene: ScenePresence) {
        scenes[sceneId] = scene
        flush()
    }

    public func remove(_ sceneId: String) {
        guard scenes.removeValue(forKey: sceneId) != nil else { return }
        flush()
    }

    private func flush() {
        let next = presence
        guard next != last else { return }
        last = next
        send(next)
    }
}
