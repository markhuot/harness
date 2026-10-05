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
    /// The tab's page is closed to save memory; it reloads its URL when opened. nil: false.
    public var suspended: Bool?
    /// Every open tab, ascending id.
    public var tabs: [BrowserTab]?
    /// The tab's input mode and viewport. Services from before per-tab sizes omit it.
    public var size: BrowserSize?
    /// True only in the state sent to the viewer whose pane the tab follows (`size.responsive`):
    /// that viewer sends its stage size as `resize` input; everyone else's `resize` is dropped.
    public var sizeOwner: Bool?

    public init(
        sessionId: String, tabId: Int? = nil, url: String, title: String, loading: Bool, suspended: Bool? = nil, tabs: [BrowserTab]? = nil,
        size: BrowserSize? = nil, sizeOwner: Bool? = nil
    ) {
        self.sessionId = sessionId
        self.tabId = tabId
        self.url = url
        self.title = title
        self.loading = loading
        self.suspended = suspended
        self.tabs = tabs
        self.size = size
        self.sizeOwner = sizeOwner
    }

    /// Whether this viewer's stage size drives the tab (an older service never sends it).
    public var ownsSize: Bool { sizeOwner ?? false }
}

/// How a tab's page is shown, per tab. `device` is the input mode; `width`/`height` are the
/// viewport in CSS pixels, free in either mode; `responsive`: the tab follows the stage of the
/// viewer that switched it on.
public struct BrowserSize: Codable, Sendable, Equatable {
    public var device: BrowserDevice
    public var width: Int
    public var height: Int
    public var responsive: Bool

    public init(device: BrowserDevice, width: Int, height: Int, responsive: Bool) {
        self.device = device
        self.width = width
        self.height = height
        self.responsive = responsive
    }

    /// The size the Desktop button (and every new tab) resets to.
    public static let desktop = (width: 1280, height: 800)
    /// The size the Mobile button resets to: an iPhone (16/17 Pro) in CSS points.
    public static let mobile = (width: 393, height: 852)
    /// The smallest and largest viewport side the service accepts; anything else is clamped.
    public static let minSide = 100
    public static let maxSide = 4096

    /// A typed side held to minSide…maxSide; nil when it isn't a number.
    public static func clampSide(_ raw: String) -> Int? {
        guard let n = Double(raw.trimmingCharacters(in: .whitespaces)), n.isFinite else { return nil }
        return min(maxSide, max(minSide, Int(n.rounded())))
    }
}

/// One tab of a session's browser. Ids count up from 1 per session and are never reused.
public struct BrowserTab: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    public var url: String
    public var title: String
    public var loading: Bool
    /// Its page is closed to save memory; watching it or an agent using it reloads its URL. nil: false.
    public var suspended: Bool?
    /// Its input mode and viewport. Services from before per-tab sizes omit it.
    public var size: BrowserSize?

    public init(id: Int, url: String, title: String, loading: Bool, suspended: Bool? = nil, size: BrowserSize? = nil) {
        self.id = id
        self.url = url
        self.title = title
        self.loading = loading
        self.suspended = suspended
        self.size = size
    }

    /// Whether its page is closed (an older service never sends it).
    public var isSuspended: Bool { suspended ?? false }
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
    /// The viewer's stage size. Applied only while the tab is responsive and this viewer switched
    /// it on (BrowserState.sizeOwner); dropped otherwise.
    case resize(width: Int, height: Int)
    /// The Desktop | Mobile buttons: set the input mode, reset to its preset size, switch
    /// responsive off and reload, even when the mode didn't change.
    case device(BrowserDevice)
    /// The width × height inputs: resize the tab, keeping its mode; switches responsive off.
    case size(width: Int, height: Int)
    /// The Responsive switch. On: the tab follows this viewer's stage (`width`/`height`, its
    /// current size) and this viewer becomes the owner. Off: the tab keeps its current size.
    case responsive(on: Bool, width: Int?, height: Int?)
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
        case .device: "device"
        case .size: "size"
        case .responsive: "responsive"
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
        case "device": self = .device(try c.decode(BrowserDevice.self, forKey: "device"))
        case "size": self = .size(width: try c.decode(Int.self, forKey: "width"), height: try c.decode(Int.self, forKey: "height"))
        case "responsive":
            self = .responsive(
                on: try c.decode(Bool.self, forKey: "on"), width: try c.decodeIfPresent(Int.self, forKey: "width"),
                height: try c.decodeIfPresent(Int.self, forKey: "height"))
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
        case let .resize(width, height), let .size(width, height):
            try c.encode(width, forKey: "width")
            try c.encode(height, forKey: "height")
        case let .device(device): try c.encode(device, forKey: "device")
        case let .responsive(on, width, height):
            try c.encode(on, forKey: "on")
            try c.encodeIfPresent(width, forKey: "width")
            try c.encodeIfPresent(height, forKey: "height")
        case let .newTab(url): try c.encodeIfPresent(url, forKey: "url")
        default: break
        }
    }
}
