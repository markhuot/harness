import Foundation

// Annotations (DESIGN.md "Annotations"): numbered notes a human draws on an image before sending it
// to the agent, ports of protocol.ts's AnnotationMark, AnnotationPage, AttachmentAnnotation and
// BrowserScreenshot.

/// `MAX_ANNOTATION_MARKS`: most notes one image takes.
public let maxAnnotationMarks = 50
/// `MAX_ANNOTATION_MESSAGE`: most characters (UTF-16) in one note.
public let maxAnnotationMessage = 2000
/// `MAX_ANNOTATION_TEXT`: longest AnnotationMark.text (the anchored element's visible text).
public let maxAnnotationText = 200
/// `MAX_ANNOTATION_PATH`: longest AnnotationMark.path (a CSS selector).
public let maxAnnotationPath = 1000

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
    /// On a browser screenshot (AttachmentAnnotation.page): a CSS selector for the element under
    /// the anchor and its visible text (BrowserElement), so the agent can find it in the page and
    /// the source. Absent when the page couldn't tell (it had moved on) or on other images.
    public var path: String?
    public var text: String?

    public init(n: Int, x: Double, y: Double, tailX: Double? = nil, tailY: Double? = nil, message: String, path: String? = nil, text: String? = nil) {
        self.n = n
        self.x = x
        self.y = y
        self.tailX = tailX
        self.tailY = tailY
        self.message = message
        self.path = path
        self.text = text
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

/// A human's numbered notes on an image attachment (Attachment.annotation). Metadata only:
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
    /// How far the page was scrolled when it was captured, in CSS pixels (BrowserElementQuery
    /// checks it). nil from an older service, which can't look up elements either.
    public var scroll: BrowserScroll?

    public init(
        data: String, width: Double, height: Double, viewport: AnnotationViewport, scale: Double, tabId: Int, url: String, title: String,
        scroll: BrowserScroll? = nil
    ) {
        self.data = data
        self.width = width
        self.height = height
        self.viewport = viewport
        self.scale = scale
        self.tabId = tabId
        self.url = url
        self.title = title
        self.scroll = scroll
    }

    /// The PNG's bytes (nil when `data` isn't base64).
    public var png: Data? { Data(base64Encoded: data, options: .ignoreUnknownCharacters) }

    /// The page it shows, for AttachmentAnnotation.page.
    public var page: AnnotationPage {
        AnnotationPage(url: url, title: title, tabId: tabId, viewport: viewport, scale: scale)
    }
}

/// A page's scroll offset in CSS pixels.
public struct BrowserScroll: Codable, Sendable, Equatable, Hashable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// POST /browser/:sessionId/element: what's under a point of a captured screenshot, so an
/// annotation's mark can name it (AnnotationMark.path and .text). `url`, `scroll` and `viewport`
/// are the screenshot's: when the tab has since navigated, scrolled or been resized (a viewer's
/// pane changed size), the answer is null rather than whatever is there now.
public struct BrowserElementQuery: Codable, Sendable, Equatable {
    public var tabId: Int
    /// The point in the page's CSS pixels (the screenshot's pixels divided by its scale).
    public var x: Double
    public var y: Double
    public var url: String
    public var scroll: BrowserScroll
    /// The screenshot's viewport in CSS pixels (BrowserScreenshot.viewport).
    public var viewport: AnnotationViewport

    public init(tabId: Int, x: Double, y: Double, url: String, scroll: BrowserScroll, viewport: AnnotationViewport) {
        self.tabId = tabId
        self.x = x
        self.y = y
        self.url = url
        self.scroll = scroll
        self.viewport = viewport
    }
}

/// The element under a point of the page (BrowserElementQuery).
public struct BrowserElement: Codable, Sendable, Equatable, Hashable {
    /// A CSS selector that finds it (an id when it has a unique one, else a tag/nth-of-type chain
    /// from the nearest id or body).
    public var path: String
    /// Its visible text, whitespace collapsed, at most `maxAnnotationText` characters ("" when it
    /// has none).
    public var text: String

    public init(path: String, text: String) {
        self.path = path
        self.text = text
    }
}
