import Foundation

// Annotations (DESIGN.md "Annotations"): numbered notes a human draws on an image before sending it
// to the agent, ports of protocol.ts's AnnotationSource, AnnotationMark, MessageAnnotation and
// BrowserScreenshot.

/// `MAX_ANNOTATION_MARKS`: most notes one image takes.
public let maxAnnotationMarks = 50
/// `MAX_ANNOTATION_MESSAGE`: most characters (UTF-16) in one note.
public let maxAnnotationMessage = 2000

/// A page's viewport in CSS pixels.
public struct AnnotationViewport: Codable, Sendable, Equatable, Hashable {
    public var width: Double
    public var height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

/// Where an annotated image came from, discriminated by `kind`. An unknown `kind` decodes to
/// `.unknown(kind:raw:)` and re-encodes `raw` unchanged.
public enum AnnotationSource: Codable, Sendable, Equatable, Hashable {
    /// An image in the ticket's spec (`attachment:<id>`).
    case attachment(id: String, name: String)
    /// One of the ticket's prompt attachments (Ticket.promptAttachments[index]).
    case promptAttachment(index: Int, name: String)
    /// A file sent with an earlier message (that transcript entry's attachments[index]).
    case messageAttachment(entryId: String, index: Int, name: String)
    /// An image that was waiting in a composer or a New session, annotated before it was sent (it
    /// takes that file's place).
    case file(name: String)
    /// A screenshot of a session browser tab (BrowserScreenshot).
    case browser(url: String, title: String, tabId: Int, viewport: AnnotationViewport, scale: Double)
    case unknown(kind: String, raw: JSONValue)

    /// The wire discriminator.
    public var kind: String {
        switch self {
        case .attachment: "attachment"
        case .promptAttachment: "prompt-attachment"
        case .messageAttachment: "message-attachment"
        case .file: "file"
        case .browser: "browser"
        case let .unknown(kind, _): kind
        }
    }

    /// The file name the annotator's header shows (a browser page's title, else its URL).
    public var displayName: String {
        switch self {
        case let .attachment(_, name), let .promptAttachment(_, name), let .messageAttachment(_, _, name), let .file(name): name
        case let .browser(url, title, _, _, _): title.isEmpty ? url : title
        case .unknown: ""
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        let kind = try c.decode(String.self, forKey: "kind")
        switch kind {
        case "attachment":
            self = .attachment(id: try c.decode(String.self, forKey: "id"), name: try c.decode(String.self, forKey: "name"))
        case "prompt-attachment":
            self = .promptAttachment(index: try c.decode(Int.self, forKey: "index"), name: try c.decode(String.self, forKey: "name"))
        case "message-attachment":
            self = .messageAttachment(
                entryId: try c.decode(String.self, forKey: "entryId"),
                index: try c.decode(Int.self, forKey: "index"),
                name: try c.decode(String.self, forKey: "name")
            )
        case "file":
            self = .file(name: try c.decode(String.self, forKey: "name"))
        case "browser":
            self = .browser(
                url: try c.decode(String.self, forKey: "url"),
                title: try c.decode(String.self, forKey: "title"),
                tabId: try c.decode(Int.self, forKey: "tabId"),
                viewport: try c.decode(AnnotationViewport.self, forKey: "viewport"),
                scale: try c.decode(Double.self, forKey: "scale")
            )
        default: self = .unknown(kind: kind, raw: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case let .unknown(_, raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(kind, forKey: "kind")
        switch self {
        case let .attachment(id, name):
            try c.encode(id, forKey: "id")
            try c.encode(name, forKey: "name")
        case let .promptAttachment(index, name):
            try c.encode(index, forKey: "index")
            try c.encode(name, forKey: "name")
        case let .messageAttachment(entryId, index, name):
            try c.encode(entryId, forKey: "entryId")
            try c.encode(index, forKey: "index")
            try c.encode(name, forKey: "name")
        case let .file(name):
            try c.encode(name, forKey: "name")
        case let .browser(url, title, tabId, viewport, scale):
            try c.encode(url, forKey: "url")
            try c.encode(title, forKey: "title")
            try c.encode(tabId, forKey: "tabId")
            try c.encode(viewport, forKey: "viewport")
            try c.encode(scale, forKey: "scale")
        case .unknown: break
        }
    }
}

/// One numbered note. `x`/`y` is the anchor the arrow points at, `tailX`/`tailY` where the arrow
/// starts (where the number sits); both in the annotated image's pixels. No tail: a plain tap, with
/// the number on the anchor.
public struct AnnotationMark: Codable, Sendable, Equatable, Hashable {
    public var n: Int
    public var x: Double
    public var y: Double
    public var tailX: Double?
    public var tailY: Double?
    public var message: String

    public init(n: Int, x: Double, y: Double, tailX: Double? = nil, tailY: Double? = nil, message: String) {
        self.n = n
        self.x = x
        self.y = y
        self.tailX = tailX
        self.tailY = tailY
        self.message = message
    }
}

/// Numbered notes on one image sent with a message: MessageBody.attachments[attachment].
public struct MessageAnnotation: Codable, Sendable, Equatable, Hashable {
    public var attachment: Int
    public var source: AnnotationSource
    /// The annotated image's size in pixels.
    public var width: Double
    public var height: Double
    /// Numbered 1…n in order.
    public var marks: [AnnotationMark]

    public init(attachment: Int, source: AnnotationSource, width: Double, height: Double, marks: [AnnotationMark]) {
        self.attachment = attachment
        self.source = source
        self.width = width
        self.height = height
        self.marks = marks
    }
}

/// GET /browser/:sessionId/screenshot?tab=: a PNG of the tab's viewport, to annotate. `width` and
/// `height` are the PNG's pixels; the page's CSS pixels are those divided by `scale`.
public struct BrowserScreenshot: Codable, Sendable, Equatable {
    /// base64 PNG
    public var data: String
    public var width: Double
    public var height: Double
    /// The page's viewport in CSS pixels.
    public var viewport: AnnotationViewport
    /// Device pixels per CSS pixel.
    public var scale: Double
    public var tabId: Int
    public var url: String
    public var title: String

    public init(data: String, width: Double, height: Double, viewport: AnnotationViewport, scale: Double, tabId: Int, url: String, title: String) {
        self.data = data
        self.width = width
        self.height = height
        self.viewport = viewport
        self.scale = scale
        self.tabId = tabId
        self.url = url
        self.title = title
    }

    /// The PNG's bytes (nil when `data` isn't base64).
    public var png: Data? { Data(base64Encoded: data, options: .ignoreUnknownCharacters) }

    /// Where the annotated screenshot came from, for MessageAnnotation.source.
    public var source: AnnotationSource {
        .browser(url: url, title: title, tabId: tabId, viewport: viewport, scale: scale)
    }
}
