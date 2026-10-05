import Foundation

/// Where an extension of the service's browser came from: "webstore", installed from the Chrome Web
/// Store in Settings; "unpacked", a folder on the service's machine added in Settings; "chrome", in
/// the browser without Settings adding it (an organization's policy installs some), which Settings
/// lists but doesn't change.
public enum BrowserExtensionSource: OpenEnum {
    case webstore, unpacked, chrome
    case unknown(String)
    public static let allKnown: [Self] = [.webstore, .unpacked, .chrome]
    public var rawValue: String {
        switch self {
        case .webstore: "webstore"
        case .unpacked: "unpacked"
        case .chrome: "chrome"
        case let .unknown(r): r
        }
    }
}

/// `BrowserExtension.status`: "loaded" running; "pending" on, waiting for Chrome to start; "off";
/// "blocked" the organization's Chrome policy doesn't allow it; "error" Chrome couldn't install or load it.
public enum BrowserExtensionStatus: OpenEnum {
    case loaded, pending, off, blocked, error
    case unknown(String)
    public static let allKnown: [Self] = [.loaded, .pending, .off, .blocked, .error]
    public var rawValue: String {
        switch self {
        case .loaded: "loaded"
        case .pending: "pending"
        case .off: "off"
        case .blocked: "blocked"
        case .error: "error"
        case let .unknown(r): r
        }
    }
}

/// An extension in the service's browser (GET /browser-extensions). Every session's tabs share them.
public struct BrowserExtension: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var version: String
    public var description: String?
    public var source: BrowserExtensionSource
    /// An unpacked extension's folder.
    public var path: String?
    /// Installed by the organization's Chrome policy.
    public var byPolicy: Bool?
    public var enabled: Bool
    public var status: BrowserExtensionStatus
    public var error: String?
    /// It has a toolbar button (an action), which POST /browser/:sessionId/extension-action runs.
    public var hasAction: Bool
    /// Its options page, to open in a tab.
    public var optionsUrl: String?
    /// When it was added in Settings (absent for "chrome" ones).
    public var addedAt: Double?

    public init(
        id: String, name: String, version: String, description: String? = nil, source: BrowserExtensionSource, path: String? = nil, byPolicy: Bool? = nil,
        enabled: Bool, status: BrowserExtensionStatus, error: String? = nil, hasAction: Bool, optionsUrl: String? = nil, addedAt: Double? = nil
    ) {
        self.id = id
        self.name = name
        self.version = version
        self.description = description
        self.source = source
        self.path = path
        self.byPolicy = byPolicy
        self.enabled = enabled
        self.status = status
        self.error = error
        self.hasAction = hasAction
        self.optionsUrl = optionsUrl
        self.addedAt = addedAt
    }
}

/// GET /browser-extensions. `running`: Chrome is running, so a "pending" extension waits for a restart (POST /browser/restart).
public struct BrowserExtensionList: Codable, Sendable, Equatable {
    public var extensions: [BrowserExtension]
    public var running: Bool

    public init(extensions: [BrowserExtension], running: Bool) {
        self.extensions = extensions
        self.running = running
    }
}

/// POST /browser-extensions: a Chrome Web Store link or 32-letter extension ID, or an unpacked
/// extension's folder on the service's machine.
public enum AddBrowserExtensionBody: Codable, Sendable, Equatable {
    case webstore(String)
    case path(String)

    private enum CodingKeys: String, CodingKey { case webstore, path }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let w = try c.decodeIfPresent(String.self, forKey: .webstore) {
            self = .webstore(w)
        } else {
            self = .path(try c.decode(String.self, forKey: .path))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .webstore(w): try c.encode(w, forKey: .webstore)
        case let .path(p): try c.encode(p, forKey: .path)
        }
    }
}

/// POST /browser/:sessionId/extension-action: the tab its popup opened in, or nil when the action had no popup.
public struct BrowserExtensionActionResult: Codable, Sendable, Equatable {
    @Nullable public var tab: Int?

    public init(tab: Int?) {
        self.tab = tab
    }
}

/// PATCH /browser-extensions/:id.
public struct BrowserExtensionEnabledBody: Codable, Sendable, Equatable {
    public var enabled: Bool
    public init(enabled: Bool) { self.enabled = enabled }
}

/// POST /browser/:sessionId/extension-action.
public struct BrowserExtensionActionBody: Codable, Sendable, Equatable {
    public var id: String
    public var tabId: Int?
    public init(id: String, tabId: Int? = nil) {
        self.id = id
        self.tabId = tabId
    }
}
