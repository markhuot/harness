import Foundation

/// A session's browser as one viewer sees it: the tab it is on (`tabId`, with that tab's url,
/// title and loading) and every open tab. Services from before browser tabs omit `tabId` and
/// `tabs` (both nil; they encode only when set, so a round trip keeps the wire shape).
public struct BrowserState: Codable, Sendable, Equatable {
    public var sessionId: String
    public var tabId: Int?
    public var url: String
    public var title: String
    public var loading: Bool
    /// Every open tab, ascending id.
    public var tabs: [BrowserTab]?

    public init(sessionId: String, tabId: Int? = nil, url: String, title: String, loading: Bool, tabs: [BrowserTab]? = nil) {
        self.sessionId = sessionId
        self.tabId = tabId
        self.url = url
        self.title = title
        self.loading = loading
        self.tabs = tabs
    }
}

/// One tab of a session's browser. Ids count up from 1 per session and are never reused.
public struct BrowserTab: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    public var url: String
    public var title: String
    public var loading: Bool

    public init(id: Int, url: String, title: String, loading: Bool) {
        self.id = id
        self.url = url
        self.title = title
        self.loading = loading
    }
}

/// Input for the session browser (ClientMessage `browser.input`), discriminated by `type`. An
/// unknown `type` decodes to `.unknown(type:raw:)`.
public enum BrowserInput: Codable, Sendable, Equatable {
    public struct Mouse: Codable, Sendable, Equatable {
        public var action: MouseAction
        public var x: Double
        public var y: Double
        public var button: MouseButton?
        public var clickCount: Int?
        public var deltaX: Double?
        public var deltaY: Double?

        public init(
            action: MouseAction, x: Double, y: Double, button: MouseButton? = nil, clickCount: Int? = nil,
            deltaX: Double? = nil, deltaY: Double? = nil
        ) {
            self.action = action
            self.x = x
            self.y = y
            self.button = button
            self.clickCount = clickCount
            self.deltaX = deltaX
            self.deltaY = deltaY
        }
    }

    public struct Key: Codable, Sendable, Equatable {
        public var action: KeyAction
        public var key: String
        public var code: String
        public var text: String?
        public var modifiers: Int?

        public init(action: KeyAction, key: String, code: String, text: String? = nil, modifiers: Int? = nil) {
            self.action = action
            self.key = key
            self.code = code
            self.text = text
            self.modifiers = modifiers
        }
    }

    case mouse(Mouse)
    case key(Key)
    case text(text: String)
    case navigate(url: String)
    case back
    case forward
    case reload
    /// The size of every tab in the session.
    case resize(width: Int, height: Int)
    /// Open a tab (at `url`, else about:blank) and switch this socket to it.
    case newTab(url: String?)
    /// Close the input's tab (ClientMessage `browserInput`'s `tabId`); closing the last one
    /// leaves a blank tab in its place.
    case closeTab
    case unknown(type: String, raw: JSONValue)

    public var type: String {
        switch self {
        case .mouse: "mouse"
        case .key: "key"
        case .text: "text"
        case .navigate: "navigate"
        case .back: "back"
        case .forward: "forward"
        case .reload: "reload"
        case .resize: "resize"
        case .newTab: "newTab"
        case .closeTab: "closeTab"
        case let .unknown(type, _): type
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let type = try c.decode(String.self, forKey: "type")
        switch type {
        case "mouse": self = .mouse(try Mouse(from: decoder))
        case "key": self = .key(try Key(from: decoder))
        case "text": self = .text(text: try c.decode(String.self, forKey: "text"))
        case "navigate": self = .navigate(url: try c.decode(String.self, forKey: "url"))
        case "back": self = .back
        case "forward": self = .forward
        case "reload": self = .reload
        case "resize": self = .resize(width: try c.decode(Int.self, forKey: "width"), height: try c.decode(Int.self, forKey: "height"))
        case "newTab": self = .newTab(url: try c.decodeIfPresent(String.self, forKey: "url"))
        case "closeTab": self = .closeTab
        default: self = .unknown(type: type, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case let .unknown(_, raw): return try raw.encode(to: encoder)
        case let .mouse(m): try m.encode(to: encoder)
        case let .key(k): try k.encode(to: encoder)
        default: break
        }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(type, forKey: "type")
        switch self {
        case let .text(text): try c.encode(text, forKey: "text")
        case let .navigate(url): try c.encode(url, forKey: "url")
        case let .resize(width, height):
            try c.encode(width, forKey: "width")
            try c.encode(height, forKey: "height")
        case let .newTab(url): try c.encodeIfPresent(url, forKey: "url")
        default: break
        }
    }
}
