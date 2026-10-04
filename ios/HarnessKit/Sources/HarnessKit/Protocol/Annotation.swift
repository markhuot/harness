import Foundation

// Annotations (DESIGN.md "Annotations"): numbered notes a human draws on an image before sending it
// to the agent, ports of protocol.ts's AnnotationMark, AnnotationPage, AttachmentAnnotation and
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

/// One numbered note. `x`/`y` is the anchor the arrow points at, `tailX`/`tailY` where the arrow
/// starts (where the number sits); both in the image's pixels. No tail: a plain tap, with
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

/// The page a browser screenshot shows (BrowserScreenshot), so the agent can find the marks on it
/// in CSS pixels.
public struct AnnotationPage: Codable, Sendable, Equatable, Hashable {
    public var url: String
    public var title: String
    public var tabId: Int
    /// The page's viewport in CSS pixels.
    public var viewport: AnnotationViewport
    /// Device pixels per CSS pixel.
    public var scale: Double

    public init(url: String, title: String, tabId: Int, viewport: AnnotationViewport, scale: Double) {
        self.url = url
        self.title = title
        self.tabId = tabId
        self.viewport = viewport
        self.scale = scale
    }
}

/// A human's numbered notes on an image attachment (PromptAttachment.annotation). Metadata only:
/// the image file is never changed, and the apps draw the marks over it.
public struct AttachmentAnnotation: Codable, Sendable, Equatable, Hashable {
    /// The image's size in pixels; the marks are in these pixels.
    public var width: Double
    public var height: Double
    /// Numbered 1…n in order.
    public var marks: [AnnotationMark]
    /// Set when the image is a screenshot of a session browser tab.
    public var page: AnnotationPage?

    public init(width: Double, height: Double, marks: [AnnotationMark], page: AnnotationPage? = nil) {
        self.width = width
        self.height = height
        self.marks = marks
        self.page = page
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

    /// The page it shows, for AttachmentAnnotation.page.
    public var page: AnnotationPage {
        AnnotationPage(url: url, title: title, tabId: tabId, viewport: viewport, scale: scale)
    }
}
