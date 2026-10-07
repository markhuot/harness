import Foundation

// System notifications for card activity (DESIGN.md "Notifications"): the port of
// shared/src/notifications.ts. The service decides what to push; clients register their APNs
// token (POST /devices), report what's on screen (the `presence` socket message) and open the
// ticket a tapped notification names.

/// The switchable groups of activity (`NOTIFICATION_CATEGORIES`).
public enum NotificationCategory: OpenEnum {
    case status, review, notes, spec, other
    case unknown(String)
    public static let allKnown: [Self] = [.status, .review, .notes, .spec, .other]
    public var rawValue: String {
        switch self {
        case .status: "status"
        case .review: "review"
        case .notes: "notes"
        case .spec: "spec"
        case .other: "other"
        case let .unknown(r): r
        }
    }

    /// `NOTIFICATION_CATEGORY_INFO`: the Settings label.
    public var label: String {
        switch self {
        case .status: "Status changes"
        case .review: "Review decisions"
        case .notes: "Agent notes"
        case .spec: "Spec revisions"
        case .other: "Other"
        case let .unknown(r): r
        }
    }

    /// `NOTIFICATION_CATEGORY_INFO`: the Settings description.
    public var detail: String {
        switch self {
        case .status: "Moves between columns, submitted for review, blocked, unblocked and reopened"
        case .review: "Approvals and requested changes by an agent or a conductor"
        case .notes: "Progress notes an agent posts to a ticket"
        case .spec: "An agent revised a ticket's spec"
        case .other: "Failed runs, tool approvals and other service entries"
        case .unknown: ""
        }
    }
}

/// `Settings.notifications`.
public struct NotificationSettings: Codable, Sendable, Equatable {
    /// Master switch: false sends nothing.
    public var enabled: Bool
    /// One switch per category, keyed by `NotificationCategory.rawValue`; a missing one counts as on.
    public var categories: [String: Bool]
    /// Folder holding the APNs keys; nil → `~/.appstoreconnect/private_keys`.
    @Nullable public var apnsKeyDir: String?
    /// The Apple developer team that owns the keys.
    public var apnsTeamId: String

    public init(enabled: Bool, categories: [String: Bool] = [:], apnsKeyDir: String? = nil, apnsTeamId: String) {
        self.enabled = enabled
        self.categories = categories
        self.apnsKeyDir = apnsKeyDir
        self.apnsTeamId = apnsTeamId
    }

    /// Whether `category` notifies (a missing switch counts as on).
    public func isOn(_ category: NotificationCategory) -> Bool {
        categories[category.rawValue] ?? true
    }
}

/// PATCH /settings `notifications` (`NotificationSettingsPatch`): any of the fields, merged over
/// the stored block (categories per category).
public struct NotificationSettingsPatch: Codable, Sendable, Equatable {
    public var enabled: Bool?
    /// Keyed by `NotificationCategory.rawValue`.
    public var categories: [String: Bool]?
    public var apnsKeyDir: Patch<String>
    public var apnsTeamId: String?

    public init(enabled: Bool? = nil, categories: [String: Bool]? = nil, apnsKeyDir: Patch<String> = .absent, apnsTeamId: String? = nil) {
        self.enabled = enabled
        self.categories = categories
        self.apnsKeyDir = apnsKeyDir
        self.apnsTeamId = apnsTeamId
    }

    /// A patch that flips one category.
    public static func category(_ category: NotificationCategory, _ on: Bool) -> Self {
        Self(categories: [category.rawValue: on])
    }
}

/// `ApnsEnvironment`: "sandbox" for development builds, "production" for TestFlight / App Store
/// and Developer ID builds.
public enum ApnsEnvironment: OpenEnum {
    case sandbox, production
    case unknown(String)
    public static let allKnown: [Self] = [.sandbox, .production]
    public var rawValue: String {
        switch self {
        case .sandbox: "sandbox"
        case .production: "production"
        case let .unknown(r): r
        }
    }
}

/// `DevicePlatform`.
public enum DevicePlatform: OpenEnum {
    case mac, ios
    case unknown(String)
    public static let allKnown: [Self] = [.mac, .ios]
    public var rawValue: String {
        switch self {
        case .mac: "mac"
        case .ios: "ios"
        case let .unknown(r): r
        }
    }
}

/// A device registered for pushes. The APNs token itself isn't sent back.
public struct Device: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var platform: DevicePlatform
    public var name: String
    public var topic: String
    public var environment: ApnsEnvironment
    /// Last 8 characters of the token
    public var tokenSuffix: String
    public var createdAt: Timestamp
    public var lastSeen: Timestamp

    public init(id: String, platform: DevicePlatform, name: String, topic: String, environment: ApnsEnvironment, tokenSuffix: String, createdAt: Timestamp, lastSeen: Timestamp) {
        self.id = id
        self.platform = platform
        self.name = name
        self.topic = topic
        self.environment = environment
        self.tokenSuffix = tokenSuffix
        self.createdAt = createdAt
        self.lastSeen = lastSeen
    }
}

/// POST /devices: register a device, or update its token, name or environment.
public struct RegisterDeviceBody: Codable, Sendable, Equatable {
    /// Stable per-install UUID
    public var id: String
    public var platform: DevicePlatform
    public var name: String
    /// Hex APNs device token
    public var apnsToken: String
    public var environment: ApnsEnvironment
    /// nil → APNS_TOPIC
    public var topic: String?

    public init(id: String, platform: DevicePlatform, name: String, apnsToken: String, environment: ApnsEnvironment, topic: String? = nil) {
        self.id = id
        self.platform = platform
        self.name = name
        self.apnsToken = apnsToken
        self.environment = environment
        self.topic = topic
    }
}

/// One environment's signing key, as GET /notifications reports it.
public struct ApnsKeyStatus: Codable, Sendable, Equatable {
    public struct Result: Codable, Sendable, Equatable {
        public var at: Timestamp
        public var ok: Bool
        public var status: Int
        @Nullable public var reason: String?
    }

    public var environment: ApnsEnvironment
    @Nullable public var keyId: String?
    @Nullable public var path: String?
    @Nullable public var lastResult: Result?
}

/// GET /notifications: what the service can send and to whom.
public struct NotificationStatus: Codable, Sendable, Equatable {
    public var keyDir: String
    public var keys: [ApnsKeyStatus]
    public var devices: [Device]
}

/// POST /notifications/test.
public struct TestNotificationResult: Codable, Sendable, Equatable {
    public struct DeviceResult: Codable, Sendable, Equatable {
        public var deviceId: String
        public var ok: Bool
        public var status: Int
        @Nullable public var reason: String?
    }

    public var sent: Int
    public var results: [DeviceResult]
}

/// WebSocket `presence` (client → service): what this socket shows. `tickets` lists every ticket
/// key on screen; `visible` is false while the app is in the background (a hidden presence
/// suppresses nothing).
public struct Presence: Codable, Sendable, Equatable, Hashable {
    public var deviceId: String
    public var platform: DevicePlatform
    public var visible: Bool
    public var tickets: [String]

    public init(deviceId: String, platform: DevicePlatform, visible: Bool, tickets: [String]) {
        self.deviceId = deviceId
        self.platform = platform
        self.visible = visible
        self.tickets = tickets
    }

    /// Tickets deduplicated and sorted, as `HarnessSocket.setPresence` sends them (so an unchanged
    /// set in another order isn't sent again).
    public var normalized: Presence {
        Presence(deviceId: deviceId, platform: platform, visible: visible, tickets: Array(Set(tickets)).sorted())
    }
}

/// Constants from shared/src/notifications.ts.
public enum Notifications {
    /// `APNS_TOPIC`: the Mac and iPhone/iPad apps share this bundle ID.
    public static let apnsTopic = "com.markhuot.harness"
    /// `PUSH_TICKET_KEY`: the custom payload key carrying the ticket key.
    public static let pushTicketKey = "ticketKey"
}
