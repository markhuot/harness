import Foundation

/// Annotations (DESIGN.md "Annotations"): numbered notes a human draws on an image before sending
/// it to the agent. Press to set an anchor, drag to pull out an arrow that points at it; the number
/// sits where the arrow starts. A port of shared/src/state/annotations.ts with the same rules,
/// constants and tests (AnnotationsTests), so both apps draw and edit marks the same way.
public enum Annotations {
    public struct Point: Sendable, Equatable, Hashable {
        public var x: Double
        public var y: Double

        public init(x: Double, y: Double) {
            self.x = x
            self.y = y
        }
    }

    /// A note while it's being drawn. Points are fractions (0–1) of the image's width and height, so
    /// they hold at any display size. `tail` is where the drag ended; nil for a plain tap, which puts
    /// the number on the anchor itself.
    public struct DraftMark: Sendable, Equatable, Hashable {
        public var anchor: Point
        public var tail: Point?
        public var message: String

        public init(anchor: Point, tail: Point? = nil, message: String = "") {
            self.anchor = anchor
            self.tail = tail
            self.message = message
        }
    }

    /// How far (in display points) the pointer has to move between press and release to make an
    /// arrow rather than a tap.
    public static let dragThreshold: Double = 6

    /// Sizes, in pixels of the surface being drawn on, of a mark's pieces.
    public struct Style: Sendable, Equatable {
        public var badgeRadius: Double
        public var fontSize: Double
        public var lineWidth: Double
        /// The white outline around the badge and the arrow, so they read on light and dark images.
        public var outline: Double
        public var headLength: Double
        public var headHalfWidth: Double
    }

    /// The style for a surface of `width`×`height` pixels. It grows with the image's long side, so
    /// the picture sent to the agent looks like what was on screen at any resolution; very small
    /// surfaces keep a readable minimum.
    public static func style(width: Double, height: Double) -> Style {
        let k = Swift.max(Swift.max(width, height) / 900, 0.75)
        return Style(badgeRadius: 13 * k, fontSize: 15 * k, lineWidth: 3.5 * k, outline: 2 * k, headLength: 16 * k, headHalfWidth: 9 * k)
    }

    static func clamp01(_ v: Double) -> Double {
        v.isFinite ? Swift.min(1, Swift.max(0, v)) : 0
    }

    /// A surface pixel as a fraction of the surface, kept inside the image.
    public static func toUnit(_ p: Point, width: Double, height: Double) -> Point {
        Point(x: clamp01(width > 0 ? p.x / width : 0), y: clamp01(height > 0 ? p.y / height : 0))
    }

    /// A fraction of the surface as a surface pixel.
    public static func toSurface(_ p: Point, width: Double, height: Double) -> Point {
        Point(x: p.x * width, y: p.y * height)
    }

    /// Did the pointer move far enough between press and release to make an arrow? (Display points.)
    public static func isDrag(_ start: Point, _ end: Point, threshold: Double = dragThreshold) -> Bool {
        hypot(end.x - start.x, end.y - start.y) >= threshold
    }

    /// Where a mark's number is drawn: the arrow's tail, or the anchor for a tap.
    public static func badgeCenter(_ m: DraftMark) -> Point {
        m.tail ?? m.anchor
    }

    /// An arrow's pieces in surface pixels.
    public struct Arrow: Sendable, Equatable {
        /// From the edge of the badge to just inside the head's base.
        public var line: (Point, Point)
        /// The head's three points, its tip on the anchor first.
        public var head: (Point, Point, Point)

        public static func == (a: Arrow, b: Arrow) -> Bool {
            a.line == b.line && a.head == b.head
        }
    }

    /// The arrow from `tail` to `anchor` (surface pixels): a line from the edge of the badge to the
    /// base of the head, and the head's three points with its tip on the anchor. nil when the two are
    /// too close for an arrow to show past the badge; the badge alone marks the spot then.
    public static func arrowGeometry(tail: Point, anchor: Point, style: Style) -> Arrow? {
        let dx = anchor.x - tail.x
        let dy = anchor.y - tail.y
        let length = hypot(dx, dy)
        if length <= style.badgeRadius + style.headLength * 0.5 { return nil }
        let ux = dx / length
        let uy = dy / length
        let base = Point(x: anchor.x - ux * style.headLength, y: anchor.y - uy * style.headLength)
        let start = Point(x: tail.x + ux * style.badgeRadius, y: tail.y + uy * style.badgeRadius)
        // The line stops a little inside the head, so its round cap doesn't poke past the head's sides.
        let end = Point(x: base.x + ux * style.headLength * 0.3, y: base.y + uy * style.headLength * 0.3)
        let px = -uy * style.headHalfWidth
        let py = ux * style.headHalfWidth
        return Arrow(
            line: (start, end),
            head: (Point(x: anchor.x, y: anchor.y), Point(x: base.x + px, y: base.y + py), Point(x: base.x - px, y: base.y - py))
        )
    }

    /// Which mark a press lands on: its badge, or (for an arrow) the anchor its head points at.
    public struct MarkHit: Sendable, Equatable {
        public enum Part: Sendable, Equatable { case badge, anchor }
        public var index: Int
        public var part: Part

        public init(index: Int, part: Part) {
            self.index = index
            self.part = part
        }
    }

    /// The mark under surface point `p`, so a press there moves it instead of starting a new one.
    /// Badges win over anchors, and a later mark over an earlier one (it's drawn on top).
    public static func hitTest(_ marks: [DraftMark], _ p: Point, width: Double, height: Double, style: Style) -> MarkHit? {
        func near(_ u: Point, _ r: Double) -> Bool {
            let s = toSurface(u, width: width, height: height)
            return hypot(s.x - p.x, s.y - p.y) <= r
        }
        for i in marks.indices.reversed() where near(badgeCenter(marks[i]), style.badgeRadius + 4) {
            return MarkHit(index: i, part: .badge)
        }
        let anchorRadius = Swift.max(style.headLength, 10)
        for i in marks.indices.reversed() where marks[i].tail != nil && near(marks[i].anchor, anchorRadius) {
            return MarkHit(index: i, part: .anchor)
        }
        return nil
    }

    /// `marks` with the hit part moved to `to` (a fraction of the surface). A tap's badge is its
    /// anchor, so it moves the anchor.
    public static func move(_ marks: [DraftMark], _ hit: MarkHit, to: Point) -> [DraftMark] {
        let at = Point(x: clamp01(to.x), y: clamp01(to.y))
        return marks.enumerated().map { i, m in
            guard i == hit.index else { return m }
            var out = m
            if hit.part == .badge && m.tail != nil { out.tail = at } else { out.anchor = at }
            return out
        }
    }

    /// `marks` without the one at `index`; the ones after it move up a number.
    public static func remove(_ marks: [DraftMark], at index: Int) -> [DraftMark] {
        marks.enumerated().filter { $0.offset != index }.map(\.element)
    }

    /// `marks` with the message of the one at `index` replaced.
    public static func setMessage(_ marks: [DraftMark], at index: Int, _ message: String) -> [DraftMark] {
        marks.enumerated().map { i, m in
            guard i == index else { return m }
            var out = m
            out.message = message
            return out
        }
    }

    /// The marks as a message sends them (MessageAnnotation.marks): numbered 1…n in order, in pixels
    /// of the `width`×`height` image, with trimmed messages.
    public static func marksForMessage(_ marks: [DraftMark], width: Double, height: Double) -> [AnnotationMark] {
        marks.enumerated().map { i, m in
            var out = AnnotationMark(n: i + 1, x: JSCompat.round(m.anchor.x * width), y: JSCompat.round(m.anchor.y * height), message: JSCompat.trim(m.message))
            if let tail = m.tail {
                out.tailX = JSCompat.round(tail.x * width)
                out.tailY = JSCompat.round(tail.y * height)
            }
            return out
        }
    }

    /// "1 note", "3 notes": the Transcript's line under an annotated image.
    public static func notesLabel(_ count: Int) -> String {
        "\(count) \(count == 1 ? "note" : "notes")"
    }

    /// The marks of a sent or waiting annotation, back as fractions of its image, so the annotator
    /// can reopen them to edit (over the original image, which has the same size as the annotated one).
    public static func draftMarks(from a: MessageAnnotation) -> [DraftMark] {
        draftMarks(width: a.width, height: a.height, marks: a.marks)
    }

    /// `draftMarksFrom` on a width, height and marks (marks stay in their order).
    public static func draftMarks(width: Double, height: Double, marks: [AnnotationMark]) -> [DraftMark] {
        marks.map { m in
            let unit = { (x: Double, y: Double) in toUnit(Point(x: x, y: y), width: width, height: height) }
            let tail: Point? = if let tx = m.tailX, let ty = m.tailY { unit(tx, ty) } else { nil }
            return DraftMark(anchor: unit(m.x, m.y), tail: tail, message: m.message)
        }
    }

    // A message (or New session) keeps its annotations beside its attachments, each naming its
    // attachment by index. These keep them pointed at the right file as the list changes.

    /// The annotation on `attachments[index]`, if it has one.
    public static func annotation(for index: Int, in annotations: [MessageAnnotation]) -> MessageAnnotation? {
        annotations.first { $0.attachment == index }
    }

    /// `annotations` with the one on `attachments[index]` set to `a` (its own `attachment` is
    /// ignored; nil removes it), in attachment order.
    public static func with(_ annotations: [MessageAnnotation], at index: Int, _ a: MessageAnnotation?) -> [MessageAnnotation] {
        var rest = annotations.filter { $0.attachment != index }
        if var a {
            a.attachment = index
            rest.append(a)
        }
        // A stable sort, as Array.prototype.sort is.
        return rest.enumerated().sorted { ($0.element.attachment, $0.offset) < ($1.element.attachment, $1.offset) }.map(\.element)
    }

    /// `annotations` once `attachments[index]` is removed: its own goes, and later ones move up an index.
    public static func without(_ annotations: [MessageAnnotation], at index: Int) -> [MessageAnnotation] {
        annotations.filter { $0.attachment != index }.map { a in
            guard a.attachment > index else { return a }
            var out = a
            out.attachment -= 1
            return out
        }
    }

    /// Only the annotations whose attachment is still in a list of `count` (what a send or save carries).
    public static func within(_ annotations: [MessageAnnotation], count: Int) -> [MessageAnnotation] {
        annotations.filter { $0.attachment >= 0 && $0.attachment < count }
    }

    /// Same annotations, same order, same contents.
    public static func same(_ a: [MessageAnnotation], _ b: [MessageAnnotation]) -> Bool {
        a == b
    }

    // MARK: Phone-only rules around the shared ones

    /// Whether another mark fits (MAX_ANNOTATION_MARKS).
    public static func canAdd(_ marks: [DraftMark]) -> Bool {
        marks.count < maxAnnotationMarks
    }

    /// `message` cut to MAX_ANNOTATION_MESSAGE UTF-16 units, never inside a character.
    public static func clampMessage(_ message: String) -> String {
        guard message.utf16.count > maxAnnotationMessage else { return message }
        var out = ""
        var units = 0
        for ch in message {
            let n = ch.utf16.count
            if units + n > maxAnnotationMessage { break }
            out.append(ch)
            units += n
        }
        return out
    }

    /// The annotation each image of a sent message carries, by attachment index (the Transcript's
    /// "N notes" under that image). Entries naming no attachment in range, and empty ones, are left out.
    public static func byAttachment(_ annotations: [MessageAnnotation]?, attachments: Int) -> [Int: MessageAnnotation] {
        var out: [Int: MessageAnnotation] = [:]
        for a in annotations ?? [] where a.attachment >= 0 && a.attachment < attachments && !a.marks.isEmpty && out[a.attachment] == nil {
            out[a.attachment] = a
        }
        return out
    }

    /// The largest picture that still goes to the agent inline (the API takes 5 MB of base64 per
    /// image; 3.75 MB of bytes is that once encoded). The Mac app's INLINE_IMAGE_LIMIT.
    public static let inlineImageLimit = Int(3.75 * 1024 * 1024)

    /// The JPEG qualities tried, best first, when the PNG is too big.
    public static let jpegQualities: [Double] = [0.9, 0.8, 0.7, 0.6, 0.5]

    /// How many steps Undo keeps (the Mac app's HISTORY_LIMIT).
    public static let historyLimit = 100

    /// An encoded picture: its bytes, and whether they're a JPEG (else a PNG).
    public struct Encoded: Sendable, Equatable {
        public var data: Data
        public var jpeg: Bool

        public init(data: Data, jpeg: Bool) {
            self.data = data
            self.jpeg = jpeg
        }
    }

    /// The annotated picture as a PNG, or when that's over `limit` as the best JPEG that fits (none
    /// fits: the smallest one tried, and the service decides what to do with it). `encode(nil)` is
    /// the PNG, `encode(q)` a JPEG at quality q; nil when it couldn't encode. The Mac app's
    /// encodeWithinLimit.
    public static func encodeWithinLimit(limit: Int = inlineImageLimit, _ encode: (Double?) -> Data?) -> Encoded? {
        let png = encode(nil)
        if let png, png.count <= limit { return Encoded(data: png, jpeg: false) }
        var smallest = png.map { Encoded(data: $0, jpeg: false) }
        for q in jpegQualities {
            guard let jpeg = encode(q) else { continue }
            if jpeg.count <= limit { return Encoded(data: jpeg, jpeg: true) }
            if smallest == nil || jpeg.count < smallest!.data.count { smallest = Encoded(data: jpeg, jpeg: true) }
        }
        return smallest
    }

    /// `history` with `snapshot` pushed, keeping the newest historyLimit.
    public static func pushHistory<T>(_ history: [T], _ snapshot: T) -> [T] {
        let next = history + [snapshot]
        return next.count > historyLimit ? Array(next.suffix(historyLimit)) : next
    }

    // Names, as the Mac app gives them (app/src/renderer/state/annotator.ts), so the agent sees the
    // same file names from either app.

    /// A file's name without its folders and extension ("/a/Screen Shot.jpeg" → "Screen Shot"); a
    /// dot that isn't an extension ("release 1.2") stays.
    public static func stripExtension(_ name: String) -> String {
        let leaf = name.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        return leaf.replacingOccurrences(of: #"\.[A-Za-z][A-Za-z0-9]{0,4}\z"#, with: "", options: .regularExpression)
    }

    /// The file name of the annotated picture: `annotated-<base>.png` (or .jpg), the base made safe
    /// for a file name.
    public static func annotatedName(_ base: String, jpeg: Bool) -> String {
        let ext = jpeg ? "jpg" : "png"
        var safe = base.replacingOccurrences(of: #"[^A-Za-z0-9_.-]+"#, with: "-", options: .regularExpression)
        safe = safe.replacingOccurrences(of: #"^[-.]+|[-.]+\z"#, with: "", options: .regularExpression)
        safe = String(safe.prefix(80))
        return "annotated-\(safe.isEmpty ? "image" : safe).\(ext)"
    }

    /// A browser page's name for its picture: the host, else the title, else "page".
    public static func browserShotName(url: String, title: String) -> String {
        if let host = URL(string: url)?.host(percentEncoded: false), !host.isEmpty { return host.lowercased() }
        let t = JSCompat.trim(title)
        return t.isEmpty ? "page" : t
    }

    /// The annotated picture's file name for an image from `source`.
    public static func annotatedName(_ source: AnnotationSource, jpeg: Bool) -> String {
        switch source {
        case let .browser(url, title, _, _, _): annotatedName(browserShotName(url: url, title: title), jpeg: jpeg)
        default: annotatedName(stripExtension(source.displayName), jpeg: jpeg)
        }
    }
}
