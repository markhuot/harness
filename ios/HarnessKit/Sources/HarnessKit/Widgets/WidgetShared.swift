import Foundation

/// Where the widgets reach the service, written by the app that knows it: the iPhone/iPad app for
/// its active server, the Mac app's main process for the service it runs. The widget reads it on
/// every timeline refresh, so pairing another server or rotating the token reaches it.
public struct WidgetHost: Codable, Sendable, Equatable {
    public var baseUrl: String
    public var token: String
    /// The server's name ("Mark's MacBook Pro"), shown when the widget can't reach it.
    public var name: String?
    /// The app's color themes (theme ids), so the widget matches the app. nil → the defaults.
    public var lightTheme: String?
    public var darkTheme: String?

    public init(baseUrl: String, token: String, name: String? = nil, lightTheme: String? = nil, darkTheme: String? = nil) {
        self.baseUrl = baseUrl
        self.token = token
        self.name = name
        self.lightTheme = lightTheme
        self.darkTheme = darkTheme
    }
}

/// The files the apps and their widgets share in the App Group container: `widget-host.json`
/// (WidgetHost) and `widget-snapshot.json` (the last WidgetSnapshot anyone saw). Both are small
/// JSON files written atomically; a missing or unreadable file reads as nil.
public struct WidgetShared: Sendable {
    public static let hostFile = "widget-host.json"
    public static let snapshotFile = "widget-snapshot.json"

    /// App Group ids. iOS uses a registered "group." id; a Developer ID Mac app uses a
    /// team-prefixed one, which needs no provisioning profile.
    public static let iosAppGroup = "group.com.markhuot.harness"
    public static let macAppGroup = "47P4ZSALX4.com.markhuot.harness"

    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// The App Group container on this platform, nil when the process isn't entitled to it.
    public static func appGroup() -> WidgetShared? {
        #if os(macOS)
        let id = macAppGroup
        #else
        let id = iosAppGroup
        #endif
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id).map(WidgetShared.init(directory:))
    }

    public func readHost() -> WidgetHost? { read(Self.hostFile) }
    public func readSnapshot() -> WidgetSnapshot? { read(Self.snapshotFile) }

    /// nil removes the file (the app forgot its last server).
    public func writeHost(_ host: WidgetHost?) throws { try write(host, Self.hostFile) }
    public func writeSnapshot(_ snapshot: WidgetSnapshot?) throws { try write(snapshot, Self.snapshotFile) }

    private func read<T: Decodable>(_ name: String) -> T? {
        guard let data = try? Data(contentsOf: directory.appending(path: name)) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func write<T: Encodable>(_ value: T?, _ name: String) throws {
        let url = directory.appending(path: name)
        guard let value else {
            if FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) { try FileManager.default.removeItem(at: url) }
            return
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        #if os(iOS)
        // The token is in here: readable once the device has been unlocked since boot, which a widget
        // refreshing in the background needs, and never before.
        try encoder.encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try encoder.encode(value).write(to: url, options: .atomic)
        #endif
    }
}

/// What a widget timeline entry shows: the snapshot, and whether it came from the service just now
/// or from the last one saved (the service couldn't be reached).
public struct WidgetLoad: Sendable, Equatable {
    public enum Source: Sendable, Equatable {
        /// Fetched from the service just now.
        case live
        /// The last saved snapshot; the fetch failed with this message.
        case saved(String)
        /// Nothing to show: no server paired yet.
        case unpaired
    }

    public var snapshot: WidgetSnapshot
    public var source: Source
    public var host: WidgetHost?

    public init(snapshot: WidgetSnapshot, source: Source, host: WidgetHost?) {
        self.snapshot = snapshot
        self.source = source
        self.host = host
    }

    /// A widget's load: fetch from the host when there is one, save what came back, and fall back to
    /// the saved snapshot when the fetch fails. `fetch` is the seam tests replace.
    public static func load(
        _ shared: WidgetShared?, now: Timestamp,
        fetch: @Sendable (WidgetHost, Timestamp) async throws -> WidgetSnapshot = { host, now in
            try await WidgetFeed.fetch(HarnessClient(baseUrl: host.baseUrl, token: host.token), now: now)
        }
    ) async -> WidgetLoad {
        guard let host = shared?.readHost() else {
            return WidgetLoad(snapshot: shared?.readSnapshot() ?? .empty, source: .unpaired, host: nil)
        }
        do {
            let snapshot = try await fetch(host, now)
            try? shared?.writeSnapshot(snapshot)
            return WidgetLoad(snapshot: snapshot, source: .live, host: host)
        } catch {
            return WidgetLoad(snapshot: shared?.readSnapshot() ?? .empty, source: .saved(localizedErrorMessage(error)), host: host)
        }
    }
}
