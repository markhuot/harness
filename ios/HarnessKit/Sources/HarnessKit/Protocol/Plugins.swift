import Foundation

public struct PluginTab: Codable, Sendable, Equatable {
    public var pluginId: String
    public var id: String
    public var title: String
    /// Icon name from the app's icon set (hosts fall back to a generic icon)
    @Nullable public var icon: String?
    public var when: TicketTabWhen

    public init(pluginId: String, id: String, title: String, icon: String? = nil, when: TicketTabWhen) {
        self.pluginId = pluginId
        self.id = id
        self.title = title
        self.icon = icon
        self.when = when
    }
}

public struct PluginInfo: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var version: String
    public var description: String
    /// "builtin" (<repo>/plugins) or "user" ($HARNESS_HOME/plugins)
    public var source: PluginSource
    public var hasServer: Bool
    public var hasUi: Bool
    public var tabs: [PluginTab]
    /// Set when the manifest or server module failed to load; the plugin's routes and tabs are disabled
    @Nullable public var error: String?

    public init(
        id: String, name: String, version: String, description: String, source: PluginSource, hasServer: Bool,
        hasUi: Bool, tabs: [PluginTab] = [], error: String? = nil
    ) {
        self.id = id
        self.name = name
        self.version = version
        self.description = description
        self.source = source
        self.hasServer = hasServer
        self.hasUi = hasUi
        self.tabs = tabs
        self.error = error
    }
}

/// The app's color theme as sent to plugins, next to the resolved `theme: "light" | "dark"` every
/// plugin already reads. Additive: hosts older than themes omit these fields.
public struct PluginThemeFields: Codable, Sendable, Equatable {
    /// Same as `theme` (the resolved appearance)
    public var appearance: Appearance?
    /// Theme id, e.g. "catppuccin-mocha" (see @harness/shared/themes)
    public var themeId: String?
    public var themeName: String?
    /// Shiki theme matching the app theme, or null when none ships
    public var syntaxTheme: Patch<String>
    /// Semantic color tokens (ThemeTokens): bg, text, accent, status colors, diff colors, …
    public var tokens: [String: String]?

    public init(
        appearance: Appearance? = nil, themeId: String? = nil, themeName: String? = nil,
        syntaxTheme: Patch<String> = .absent, tokens: [String: String]? = nil
    ) {
        self.appearance = appearance
        self.themeId = themeId
        self.themeName = themeName
        self.syntaxTheme = syntaxTheme
        self.tokens = tokens
    }
}

/// Host (app) → plugin iframe. Sent with targetOrigin = the service origin. Discriminated by
/// `type`; the theme fields sit next to the message's own keys.
public enum PluginHostMessage: Codable, Sendable, Equatable {
    public struct Init: Codable, Sendable, Equatable {
        public var baseUrl: String
        public var token: String
        public var ticketKey: String
        public var tabId: String
        public var theme: Appearance

        public init(baseUrl: String, token: String, ticketKey: String, tabId: String, theme: Appearance) {
            self.baseUrl = baseUrl
            self.token = token
            self.ticketKey = ticketKey
            self.tabId = tabId
            self.theme = theme
        }
    }

    /// `harness:init`
    case initialize(Init, PluginThemeFields = PluginThemeFields())
    /// `harness:theme`
    case theme(Appearance, PluginThemeFields = PluginThemeFields())
    /// `harness:ticket`
    case ticket(Ticket)
    case unknown(type: String, raw: JSONValue)

    public var type: String {
        switch self {
        case .initialize: "harness:init"
        case .theme: "harness:theme"
        case .ticket: "harness:ticket"
        case let .unknown(type, _): type
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let type = try c.decode(String.self, forKey: "type")
        switch type {
        case "harness:init": self = .initialize(try Init(from: decoder), try PluginThemeFields(from: decoder))
        case "harness:theme": self = .theme(try c.decode(Appearance.self, forKey: "theme"), try PluginThemeFields(from: decoder))
        case "harness:ticket": self = .ticket(try c.decode(Ticket.self, forKey: "ticket"))
        default: self = .unknown(type: type, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case let .unknown(_, raw): return try raw.encode(to: encoder)
        case let .initialize(payload, fields):
            try payload.encode(to: encoder)
            try fields.encode(to: encoder)
        case let .theme(theme, fields):
            try fields.encode(to: encoder)
            var c = encoder.container(keyedBy: AnyCodingKey.self)
            try c.encode(theme, forKey: "theme")
        case let .ticket(ticket):
            var c = encoder.container(keyedBy: AnyCodingKey.self)
            try c.encode(ticket, forKey: "ticket")
        }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(type, forKey: "type")
    }
}

/// Plugin iframe → host (app). The host only accepts these from its own iframe at the service origin.
public enum PluginFrameMessage: Codable, Sendable, Equatable {
    /// `harness:ready`
    case ready
    /// `harness:openExternal`
    case openExternal(url: String)
    /// `harness:navigate`
    case navigate(ticketKey: String)
    case unknown(type: String, raw: JSONValue)

    public var type: String {
        switch self {
        case .ready: "harness:ready"
        case .openExternal: "harness:openExternal"
        case .navigate: "harness:navigate"
        case let .unknown(type, _): type
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let type = try c.decode(String.self, forKey: "type")
        switch type {
        case "harness:ready": self = .ready
        case "harness:openExternal": self = .openExternal(url: try c.decode(String.self, forKey: "url"))
        case "harness:navigate": self = .navigate(ticketKey: try c.decode(String.self, forKey: "ticketKey"))
        default: self = .unknown(type: type, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(type, forKey: "type")
        switch self {
        case let .openExternal(url): try c.encode(url, forKey: "url")
        case let .navigate(ticketKey): try c.encode(ticketKey, forKey: "ticketKey")
        case .ready, .unknown: break
        }
    }
}
