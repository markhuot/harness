import HarnessKit
import SwiftUI

/// Agent markdown: blocks and inline tokens come from HarnessKit's port of the
/// shared parser; web links open in Safari, file links in the file viewer (ContentLinks), ticket
/// keys open the ticket, and wide tables scroll sideways. Fenced code is syntax highlighted
/// (CodeBlockView). Nothing is ever interpreted as markup. Lists nest, with bullets that change by
/// depth (• ◦ ▪). `![alt](attachment:<id>)` alone on its line is a figure: the attachment across the
/// full width (a video as its first frame) with its alt text as the caption. `![alt](attachment:<id>
/// "thumb")` is a 100 pt square thumbnail, and a line of them a wrapping row. A tap opens the
/// full-screen viewer, paging through every attachment in the text; the parser turns remote and file
/// images into links, so nothing an agent wrote gets fetched. Each one is the ticket's own
/// Attachment record (`\.specAttachments`, TicketDetail.attachments), so annotating it adds that
/// attachment, by its id, to the message being written.
///
/// `size` is the body text size and `lineHeight` its line height as a multiple of it; `color` overrides the text color (nil = palette text). File links
/// resolve against `linkContext` when it names a ticket or project, else the nearest
/// `.fileLinkScope(…)`.
///
/// With `previous` (an older revision of `text`, the Spec tab's Show changes) it draws `text` with
/// what changed since marked in place (HarnessKit MarkdownDiff): added words on green, removed
/// ones on red and struck through, inside the same headings, lists, tables and code; whole added or
/// removed blocks get a tint and a bar in the gutter, and unchanged blocks draw as they always do.
struct MarkdownView: View {
    let text: String
    var previous: String?
    var size: CGFloat = 15
    /// Line height as a multiple of `size` (the Spec tab reads at 1.5).
    var lineHeight: CGFloat = 1.45
    /// Space above a heading that follows other blocks, in multiples of the heading's size (the Spec
    /// tab sets sections apart with 2). 0 leaves the usual gap between blocks.
    var headingSpace: CGFloat = 0
    var color: Color?
    /// Where relative file links open (the ticket's folder, else the project's).
    var linkContext = FileLinkContext()
    /// The viewer offers Annotate on its images (a ticket's spec; AttachmentViewer).
    var annotatable = false

    @Environment(\.palette) private var c
    @Environment(BoardStore.self) private var store: BoardStore?
    @Environment(\.annotationSink) private var sink
    @Environment(\.specAttachments) private var known
    @State private var open: AttachmentViewerStart?
    /// Attachments that failed to load as an image and turned out to be videos.
    @State private var learned: [String: AttachmentKind] = [:]

    /// Whether `text` has a block that scrolls sideways (a table or fenced code). Such markdown needs
    /// a container with a definite width rather than a shrink-to-fit bubble.
    static func scrollsSideways(_ text: String) -> Bool {
        MarkdownTable.scrollsSideways(MarkdownCache.shared.blocks(text))
    }

    var body: some View {
        let media = previous.map { MarkdownCache.shared.media($0, text) } ?? MarkdownCache.shared.media(text)
        let style = MarkdownStyle(size: size, lineHeight: lineHeight, color: color ?? c.text, palette: c, linkable: linkable, media: mediaScope(media))
        VStack(alignment: .leading, spacing: 8) {
            if let previous {
                let diff = MarkdownCache.shared.diff(previous, text)
                ForEach(diff.indices, id: \.self) { i in
                    MarkdownDiffBlockView(diff: diff[i], style: style)
                        .padding(.top, i > 0 ? headingLead(Self.headingLevel(diff[i]), after: Self.headingLevel(diff[i - 1]), style) : 0)
                }
            } else {
                let blocks = MarkdownCache.shared.blocks(text)
                ForEach(blocks.indices, id: \.self) { i in
                    MarkdownBlockView(block: blocks[i], style: style)
                        .padding(.top, i > 0 ? headingLead(Self.headingLevel(blocks[i]), after: Self.headingLevel(blocks[i - 1]), style) : 0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tint(c.accentText)
        .modifier(ContentLinkHandling(override: linkContext))
        .fullScreenCover(item: $open) { start in
            AttachmentViewer(attachments: media.map(attachment), start: start.index,
                             annotate: annotatable ? sink.map { sink in { a, image in sink.request(.existing(a), image: image) } } : nil) {
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { open = nil }
            }
        }
    }

    /// The kind to show: one learned by playing it, else the ticket's record of it (an image's alt
    /// text often has no extension to go by), else what the markdown says.
    private func kind(_ m: Markdown.Media) -> AttachmentKind {
        if let k = learned[m.id] { return k }
        if let k = known?.first(where: { $0.id == m.id })?.kind, k == .image || k == .video { return k }
        return m.video ? .video : .image
    }

    /// What the viewer pages through: the ticket's own record of the attachment, shown as the kind
    /// it plays as. An older service lists none, so markdown's id and alt text stand in.
    private func attachment(_ m: Markdown.Media) -> Attachment {
        var a = known?.first { $0.id == m.id }
            ?? Attachment(id: m.id, path: "", name: m.alt.isEmpty ? m.id : m.alt, source: .spec, kind: kind(m))
        a.kind = kind(m)
        return a
    }

    private func mediaScope(_ media: [Markdown.Media]) -> MarkdownMediaScope {
        MarkdownMediaScope(
            kind: kind,
            learn: { id, k in learned[id] = k },
            open: { id in
                guard let i = media.firstIndex(where: { $0.id == id }) else { return }
                // The viewer fades itself in over a clear cover.
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { open = AttachmentViewerStart(index: i) }
            }
        )
    }

    /// The space `headingSpace` adds over the stack's 8 pt and the heading's own 2 pt, so a heading sits
    /// headingSpace × its size below the block before it. A heading straight after another heading
    /// (`previous`) gets none of that and pulls in 4 pt closer than the usual gap.
    private func headingLead(_ level: Int?, after previous: Int?, _ style: MarkdownStyle) -> CGFloat {
        SpecHeadings.lead(level: level, after: previous, headingSpace: headingSpace, body: style.size)
    }

    private static func headingLevel(_ block: Markdown.Block) -> Int? {
        if case let .h(level, _) = block { level } else { nil }
    }

    private static func headingLevel(_ diff: MarkdownDiff.DiffBlock) -> Int? {
        switch diff {
        case let .plain(_, block): headingLevel(block)
        case let .edit(.h(level, _)): level
        case .edit: nil
        }
    }

    /// A ticket key links when the store can resolve it (or it's in a project's key space);
    /// look-alikes such as UTF-8 stay text. Without a store nothing links.
    private var linkable: (String) -> Bool {
        guard let store else { return { _ in false } }
        return { store.state.ticketLinkable($0) }
    }
}

/// What every block draws with.
@MainActor
struct MarkdownStyle {
    let size: CGFloat
    /// Line height as a multiple of `size`.
    var lineHeight: CGFloat = 1.45
    let color: Color
    let palette: Palette
    let linkable: (String) -> Bool
    let media: MarkdownMediaScope
    /// Draws everything as removed (Show changes, a block only in the older revision): struck
    /// through in text2, attachments faded.
    var removed = false

    /// This style, drawing everything as removed.
    var struck: MarkdownStyle {
        var s = self
        s.removed = true
        return s
    }

    /// Bullets by nesting depth (repeating past the third level).
    static let bullets = ["•", "◦", "▪"]

    var font: Font { .scaled(size: size) }
    /// A heading's text size: a scale down from the body size + 7 pt (level 1) through +4, +2 and +0.5.
    func headingSize(_ level: Int) -> CGFloat {
        SpecHeadings.size(level: level, body: size)
    }
    /// A line height of round(size × lineHeight), as extra spacing over the font's own line height.
    var lineSpacing: CGFloat { (size * lineHeight).rounded() - size * 1.2 }

    /// Inline tokens as one AttributedString: code spans in mono on bgActive, bold, italic, links
    /// and linkable ticket keys (both in the tint, accentText). An attachment can't sit inside a
    /// Text, so it's its alt text here (headings and table cells); `runs` lays it out instead.
    func inline(_ text: String, size: CGFloat? = nil, bold: Bool = false) -> AttributedString {
        var out = AttributedString()
        for token in MarkdownCache.shared.inline(text) { out.append(run(token, size: size, bold: bold)) }
        return out
    }

    /// `text` split at its attachments: the text between them as AttributedStrings, and each
    /// attachment on its own. Whitespace-only text between attachments is dropped.
    func runs(_ text: String) -> [MarkdownRun] {
        var out: [MarkdownRun] = []
        var cur = AttributedString()
        func flush() {
            if !String(cur.characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(.text(cur)) }
            cur = AttributedString()
        }
        for token in MarkdownCache.shared.inline(text) {
            if case let .img(m) = token {
                flush()
                out.append(.media(m))
            } else {
                cur.append(run(token))
            }
        }
        flush()
        return out.isEmpty ? [.text(cur)] : out
    }

    /// Body text: wraps, selectable.
    func paragraph(_ s: AttributedString, color: Color? = nil) -> some View {
        Text(s)
            .foregroundStyle(color ?? self.color)
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    /// Changed text (Show changes) as one AttributedString, each run styled as `inline` styles its
    /// token and marked by its change. A code span split into runs keeps its padding at its ends only.
    func diffInline(_ runs: [MarkdownDiff.Run], size: CGFloat? = nil, bold: Bool = false) -> AttributedString {
        var out = AttributedString()
        for (i, r) in runs.enumerated() {
            let lead = i == 0 || !Self.isCode(runs[i - 1].token)
            let trail = i == runs.count - 1 || !Self.isCode(runs[i + 1].token)
            out.append(mark(run(r.token, size: size, bold: bold, codeLead: lead, codeTrail: trail), r.change))
        }
        return out
    }

    /// Changed text cut at its attachments, like `runs`.
    func diffRuns(_ runs: [MarkdownDiff.Run]) -> [MarkdownDiffPiece] {
        var out: [MarkdownDiffPiece] = []
        var cur: [MarkdownDiff.Run] = []
        func flush() {
            let s = diffInline(cur)
            if !String(s.characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(.text(s)) }
            cur = []
        }
        for r in runs {
            if case let .img(m) = r.token {
                flush()
                out.append(.media(m, r.change))
            } else {
                cur.append(r)
            }
        }
        flush()
        return out.isEmpty ? [.text(AttributedString())] : out
    }

    /// Added text on greenSoft; removed text on redSoft, struck through, in text2.
    func mark(_ s: AttributedString, _ change: MarkdownDiff.Change) -> AttributedString {
        var s = s
        switch change {
        case .same: break
        case .add: s.backgroundColor = palette.greenSoft
        case .del:
            s.backgroundColor = palette.redSoft
            strike(&s)
        }
        return s
    }

    private func strike(_ s: inout AttributedString) {
        s.swiftUI.strikethroughStyle = Text.LineStyle(pattern: .solid, color: palette.red.opacity(0.7))
        s.foregroundColor = palette.text2
    }

    private static func isCode(_ t: Markdown.InlineToken) -> Bool {
        if case .code = t { true } else { false }
    }

    private func run(_ token: Markdown.InlineToken, size: CGFloat? = nil, bold: Bool = false, codeLead: Bool = true, codeTrail: Bool = true) -> AttributedString {
        var run = plainRun(token, size: size, bold: bold, codeLead: codeLead, codeTrail: codeTrail)
        if removed { strike(&run) }
        return run
    }

    private func plainRun(_ token: Markdown.InlineToken, size: CGFloat?, bold: Bool, codeLead: Bool, codeTrail: Bool) -> AttributedString {
        let size = size ?? self.size
        let base = Font.scaled(size: size, weight: bold ? .bold : .regular)
        var run: AttributedString
        switch token {
        case let .text(s):
            run = AttributedString(s)
            run.font = base
        case let .code(s):
            run = AttributedString((codeLead ? " " : "") + s + (codeTrail ? " " : ""))
            run.font = .mono(13)
            run.backgroundColor = palette.bgActive
            run.foregroundColor = palette.text
        case let .strong(s):
            run = AttributedString(s)
            run.font = .scaled(size: size, weight: .bold)
        case let .em(s):
            run = AttributedString(s)
            run.font = base.italic()
        case let .link(text, url):
            run = AttributedString(text)
            run.font = base
            run.link = ContentLinkURL.link(url)
        case let .ticket(key, text):
            run = AttributedString(text ?? key)
            run.font = base
            if linkable(key) { run.link = ContentLinkURL.ticket(key) }
        case let .img(m):
            run = AttributedString(m.alt)
            run.font = base
        }
        return run
    }
}

/// Parsed blocks and inline tokens by source text, so a long transcript re-renders without
/// re-parsing every message. Bounded; the oldest entries go first.
@MainActor
final class MarkdownCache {
    static let shared = MarkdownCache()

    private var blocks = Bounded<[Markdown.Block]>(capacity: 400)
    private var inlines = Bounded<[Markdown.InlineToken]>(capacity: 2000)
    private var media = Bounded<[Markdown.Media]>(capacity: 400)
    private var diffs = Bounded<[MarkdownDiff.DiffBlock]>(capacity: 16)

    func blocks(_ text: String) -> [Markdown.Block] {
        blocks.value(text) { Markdown.parseBlocks($0) }
    }

    /// `after` compared with `before` (MarkdownDiff.specDiff).
    func diff(_ before: String, _ after: String) -> [MarkdownDiff.DiffBlock] {
        // Keyed by both texts, `before`'s length first so no two pairs share a key.
        diffs.value("\(before.unicodeScalars.count):\(before)\(after)") { _ in MarkdownDiff.specDiff(before, after) }
    }

    /// The attachments in `text`, in the order the viewer pages through them.
    func media(_ text: String) -> [Markdown.Media] {
        media.value(text) { [self] in Markdown.mediaIn(blocks($0)) }
    }

    /// The attachments of a diff of `before` to `after` (MarkdownDiff.media): `after`'s, then those
    /// only `before` has, built from each text's cached list.
    func media(_ before: String, _ after: String) -> [Markdown.Media] {
        var seen = Set<String>()
        return (media(after) + media(before)).filter { seen.insert($0.id).inserted }
    }

    func inline(_ text: String) -> [Markdown.InlineToken] {
        inlines.value(text) { Markdown.inlineTokens($0) }
    }

    private struct Bounded<V> {
        let capacity: Int
        var entries: [String: V] = [:]
        var order: [String] = []

        mutating func value(_ key: String, make: (String) -> V) -> V {
            if let v = entries[key] { return v }
            let v = make(key)
            entries[key] = v
            order.append(key)
            if order.count > capacity {
                let drop = order.count - capacity * 3 / 4
                for k in order.prefix(drop) { entries[k] = nil }
                order.removeFirst(drop)
            }
            return v
        }
    }
}

/// How attachments in one piece of markdown behave: their kind (a guess from the name, corrected
/// when an image fails to load and plays as a video), and opening the viewer on one.
@MainActor
struct MarkdownMediaScope {
    let kind: (Markdown.Media) -> AttachmentKind
    let learn: (String, AttachmentKind) -> Void
    let open: (String) -> Void
}

/// Inline text cut at its attachments (MarkdownStyle.runs).
enum MarkdownRun {
    case text(AttributedString)
    case media(Markdown.Media)
}

/// Changed inline text cut at its attachments (MarkdownStyle.diffRuns), each attachment with its change.
enum MarkdownDiffPiece {
    case text(AttributedString)
    case media(Markdown.Media, MarkdownDiff.Change)
}

private struct MarkdownBlockView: View {
    let block: Markdown.Block
    let style: MarkdownStyle
    /// How deep in nested lists this block sits.
    var depth = 0

    private var c: Palette { style.palette }

    var body: some View {
        switch block {
        case let .p(text):
            MarkdownRichText(text: text, style: style)
        case let .h(level, text):
            style.paragraph(style.inline(text, size: style.headingSize(level), bold: true))
                .padding(.top, 2)
        case let .ul(items):
            MarkdownListView(items: items, ordered: false, start: 1, depth: depth, style: style)
        case let .ol(start, items):
            MarkdownListView(items: items, ordered: true, start: start, depth: depth, style: style)
        case let .img(media):
            VStack(alignment: .leading, spacing: 6) {
                MarkdownMediaView(media: media, style: style, figure: true, captioned: !media.alt.isEmpty)
                if !media.alt.isEmpty {
                    Text(media.alt)
                        .font(.scaled(size: style.size - 2))
                        .foregroundStyle(c.text2)
                        .strikethrough(style.removed, color: c.red.opacity(0.7))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .padding(.leading, 8)
                        .overlay(alignment: .leading) { Rectangle().fill(c.borderStrong).frame(width: 2) }
                }
            }
            .padding(.vertical, 2)
        case let .thumbs(items):
            FlowLayout(spacing: 10) {
                ForEach(items.indices, id: \.self) { k in
                    VStack(alignment: .leading, spacing: 4) {
                        MarkdownMediaView(media: items[k], style: style, captioned: !items[k].alt.isEmpty)
                        if !items[k].alt.isEmpty {
                            Text(items[k].alt)
                                .font(.scaled(size: 11))
                                .foregroundStyle(c.text2)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .frame(width: MarkdownMediaView.thumbSize, alignment: .topLeading)
                }
            }
        case let .code(lang, text):
            CodeBlockView(code: text, language: lang, struck: style.removed)
        case let .quote(text):
            MarkdownRichText(text: text, style: style, color: c.text2)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(c.borderStrong).frame(width: 3)
                }
        case let .table(align, header, rows):
            let size = MarkdownTableView.fontSize(style)
            MarkdownTableView(align: align, cells: ([header] + rows).enumerated().map { r, row in
                row.map { style.inline($0, size: size, bold: r == 0) }
            }, style: style)
        case .hr:
            HairlineRule(color: c.border).padding(.vertical, 4)
        }
    }
}

/// Paragraph text, with any attachments in it laid out between its lines of text.
private struct MarkdownRichText: View {
    let text: String
    let style: MarkdownStyle
    var color: Color?

    var body: some View {
        let runs = style.runs(text)
        if runs.count == 1, case let .text(s) = runs[0] {
            style.paragraph(s, color: color)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(runs.indices, id: \.self) { i in
                    switch runs[i] {
                    case let .text(s): style.paragraph(s, color: color)
                    case let .media(m): MarkdownMediaView(media: m, style: style)
                    }
                }
            }
        }
    }
}

/// A list: its marker (a bullet by depth, or the item's number from the list's start) beside each
/// item's text, with the item's nested lists under the text, indented to it.
private struct MarkdownListView: View {
    let items: [Markdown.ListItem]
    let ordered: Bool
    let start: Int
    let depth: Int
    let style: MarkdownStyle

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items.indices, id: \.self) { j in
                MarkdownListRow(ordered: ordered, number: start + j, depth: depth, style: style) {
                    MarkdownRichText(text: items[j].text, style: style)
                    ForEach(items[j].children.indices, id: \.self) { k in
                        MarkdownBlockView(block: items[j].children[k], style: style, depth: depth + 1)
                    }
                }
            }
        }
    }
}

/// One list item: its marker (a bullet by depth, or its number) beside its content. `marker`
/// overrides the marker's color (Show changes: green for an added item, red for a removed one).
private struct MarkdownListRow<Content: View>: View {
    let ordered: Bool
    let number: Int
    let depth: Int
    let style: MarkdownStyle
    var marker: Color?
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(ordered ? "\(number)." : MarkdownStyle.bullets[depth % MarkdownStyle.bullets.count])
                .font(style.font)
                .foregroundStyle(marker ?? style.palette.text3)
                .frame(minWidth: ordered ? 18 : 10, alignment: .trailing)
                .accessibilityHidden(!ordered)
            VStack(alignment: .leading, spacing: 4) { content }
        }
        .padding(.trailing, 4)
    }
}

/// An attachment in the text: the image fitted to the width (never past its own size), across the
/// full width in a figure, or cropped to a square as a thumbnail (`media.thumb`); a video shows its
/// first frame with a play badge. A tap opens the viewer. An image that won't decode is tried as a
/// video before it shows "Couldn't load". Without a service to load from, the alt text (nothing when
/// `captioned`: the caption beside it already shows it).
private struct MarkdownMediaView: View {
    let media: Markdown.Media
    let style: MarkdownStyle
    var figure = false
    var captioned = false

    static let thumbSize: CGFloat = 100

    @Environment(BoardStore.self) private var store: BoardStore?
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?
    @State private var failed = false

    private var c: Palette { style.palette }

    var body: some View {
        let kind = style.media.kind(media)
        if let url = AttachmentMedia.url(store, media.id) {
            Button {
                haptic(.tap)
                style.media.open(media.id)
            } label: {
                content(url: url, kind: kind)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(kind == .video ? "Video" : "Image") \(media.alt)")
            .accessibilityHint("Opens full screen")
            .accessibilityAddTraits([.isButton, .isImage])
            .opacity(style.removed ? 0.55 : 1)
            .task(id: "\(kind)|\(url)") { await load(url: url, kind: kind) }
        } else if !captioned {
            style.paragraph(AttributedString(media.alt))
        }
    }

    private func content(url: String, kind: AttachmentKind) -> some View {
        ZStack {
            let shown = failed ? nil : image ?? AttachmentMedia.shared.cached(url, poster: kind == .video)
            if failed {
                AttachmentFailed(name: media.alt, compact: true)
                    .frame(width: media.thumb ? Self.thumbSize : figure ? nil : 160, height: media.thumb ? Self.thumbSize : 100)
                    .frame(maxWidth: figure ? .infinity : nil)
                    .background(c.bgActive)
            } else if media.thumb {
                // Cropped to fill the square; the viewer shows the whole image.
                Group {
                    if let shown {
                        Image(uiImage: shown).resizable().scaledToFill()
                    } else {
                        c.bgActive
                    }
                }
                .frame(width: Self.thumbSize, height: Self.thumbSize)
                .clipped()
            } else if figure {
                // Across the full width, a tall image letterboxed at 480 pt on the sunken background.
                Group {
                    if let shown {
                        Image(uiImage: shown).resizable().aspectRatio(shown.size, contentMode: .fit)
                    } else {
                        c.bgActive.aspectRatio(16 / 10, contentMode: .fit)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: 480)
                .background(c.bgSunken)
            } else if let shown {
                // Never wider than its own pixels, nor than keeps it 480 pt tall, so the frame
                // (and its border) hugs the image instead of letterboxing it.
                Image(uiImage: shown)
                    .resizable()
                    .aspectRatio(shown.size, contentMode: .fit)
                    .frame(maxWidth: shown.size.height > 0 ? min(shown.size.width, 480 * shown.size.width / shown.size.height) : nil)
            } else {
                c.bgActive.frame(width: 200, height: 150)
            }
            if kind == .video && !failed {
                Image(systemName: "play.fill")
                    .font(.scaled(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .offset(x: 1)
                    .frame(width: 34, height: 34)
                    .background(.black.opacity(0.55), in: .circle)
            }
        }
        .clipShape(.rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.border, lineWidth: 1 / scale))
        .contentShape(.rect(cornerRadius: 8))
    }

    private func load(url: String, kind: AttachmentKind) async {
        image = nil
        failed = false
        do {
            image = kind == .video ? try await AttachmentMedia.shared.poster(url) : try await AttachmentMedia.shared.image(url)
        } catch {
            guard !Task.isCancelled else { return }
            // The parser guesses the kind from a name; an id without one may still be a video.
            if kind == .image && !media.video { style.media.learn(media.id, .video) } else { failed = true }
        }
    }
}

// MARK: Show changes

/// One block of a compared document: unchanged blocks as MarkdownBlockView draws them, whole added
/// or removed ones tinted with a bar in the gutter, edited ones with their changes marked in place.
private struct MarkdownDiffBlockView: View {
    let diff: MarkdownDiff.DiffBlock
    let style: MarkdownStyle
    var depth = 0

    var body: some View {
        switch diff {
        case let .plain(.same, block):
            MarkdownBlockView(block: block, style: style, depth: depth)
        case let .plain(change, block):
            MarkdownBlockView(block: block, style: change == .del ? style.struck : style, depth: depth)
                .modifier(MarkdownDiffMark(change: change, palette: style.palette))
        case let .edit(block):
            MarkdownEditBlockView(block: block, style: style, depth: depth)
        }
    }
}

/// A whole added (green) or removed (red) block: a soft tint with a 3pt bar, pulled into the
/// gutter so the block's text stays where unchanged text sits.
private struct MarkdownDiffMark: ViewModifier {
    let change: MarkdownDiff.Change
    let palette: Palette

    func body(content: Content) -> some View {
        let add = change == .add
        content
            .padding(.leading, 8)
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(add ? palette.greenSoft : palette.redSoft, in: UnevenRoundedRectangle(bottomTrailingRadius: 4, topTrailingRadius: 4))
            .overlay(alignment: .leading) { Rectangle().fill(add ? palette.green : palette.red).frame(width: 3) }
            .padding(.leading, -11)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(add ? "Added" : "Removed")
    }
}

/// A block in both revisions with its changes marked, laid out as MarkdownBlockView lays out the block.
private struct MarkdownEditBlockView: View {
    let block: MarkdownDiff.EditBlock
    let style: MarkdownStyle
    let depth: Int

    private var c: Palette { style.palette }

    var body: some View {
        switch block {
        case let .p(runs):
            MarkdownDiffRichText(runs: runs, style: style)
        case let .h(level, runs):
            style.paragraph(style.diffInline(runs, size: style.headingSize(level), bold: true))
                .padding(.top, 2)
        case let .quote(runs):
            MarkdownDiffRichText(runs: runs, style: style, color: c.text2)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    Rectangle().fill(c.borderStrong).frame(width: 3)
                }
        case let .ul(items):
            MarkdownDiffListView(items: items, ordered: false, start: 1, depth: depth, style: style)
        case let .ol(start, items):
            MarkdownDiffListView(items: items, ordered: true, start: start, depth: depth, style: style)
        case let .code(lang, lines):
            CodeBlockView(code: lines.map(\.text).joined(separator: "\n"), language: lang, lineChanges: lines.map(\.change))
        case let .table(align, header, rows):
            table(align: align, header: header, rows: rows)
        }
    }

    private func table(align: [Markdown.Align?], header: [[MarkdownDiff.Run]], rows: [MarkdownDiff.Row]) -> some View {
        let size = MarkdownTableView.fontSize(style)
        var cells = [header.map { style.diffInline($0, size: size, bold: true) }]
        var tints: [Color?] = [nil]
        for row in rows {
            switch row {
            case let .plain(change, text):
                let s = change == .del ? style.struck : style
                cells.append(text.map { s.inline($0, size: size) })
                tints.append(change == .add ? c.greenSoft : change == .del ? c.redSoft : nil)
            case let .edit(runs):
                cells.append(runs.map { style.diffInline($0, size: size) })
                tints.append(nil)
            }
        }
        return MarkdownTableView(align: align, cells: cells, tints: tints, style: style)
    }
}

/// Changed paragraph text, with any attachments in it laid out between its lines (an added one
/// outlined green, a removed one red and faded).
private struct MarkdownDiffRichText: View {
    let runs: [MarkdownDiff.Run]
    let style: MarkdownStyle
    var color: Color?

    var body: some View {
        let pieces = style.diffRuns(runs)
        if pieces.count == 1, case let .text(s) = pieces[0] {
            style.paragraph(s, color: color)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(pieces.indices, id: \.self) { i in
                    switch pieces[i] {
                    case let .text(s): style.paragraph(s, color: color)
                    case let .media(m, change): media(m, change)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func media(_ m: Markdown.Media, _ change: MarkdownDiff.Change) -> some View {
        if change == .same {
            MarkdownMediaView(media: m, style: style)
        } else {
            MarkdownMediaView(media: m, style: change == .del ? style.struck : style)
                .padding(3)
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(change == .add ? style.palette.green : style.palette.red, lineWidth: 2))
        }
    }
}

/// A list in both revisions: unchanged items as MarkdownListView draws them, added ones on green
/// and removed ones on red (struck through), their markers colored to match, and edited ones with
/// their text's changes marked and their nested lists compared.
private struct MarkdownDiffListView: View {
    let items: [MarkdownDiff.Item]
    let ordered: Bool
    let start: Int
    let depth: Int
    let style: MarkdownStyle

    private var c: Palette { style.palette }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items.indices, id: \.self) { j in
                switch items[j] {
                case let .plain(change, item):
                    let s = change == .del ? style.struck : style
                    MarkdownListRow(ordered: ordered, number: start + j, depth: depth, style: style,
                                    marker: change == .add ? c.green : change == .del ? c.red : nil) {
                        MarkdownRichText(text: item.text, style: s)
                        ForEach(item.children.indices, id: \.self) { k in
                            MarkdownBlockView(block: item.children[k], style: s, depth: depth + 1)
                        }
                    }
                    .background(change == .add ? c.greenSoft : change == .del ? c.redSoft : .clear, in: .rect(cornerRadius: 3))
                case let .edit(runs, children):
                    MarkdownListRow(ordered: ordered, number: start + j, depth: depth, style: style) {
                        MarkdownDiffRichText(runs: runs, style: style)
                        ForEach(children.indices, id: \.self) { k in
                            MarkdownDiffBlockView(diff: children[k], style: style, depth: depth + 1)
                        }
                    }
                }
            }
        }
    }
}

/// A one-pixel line.
struct HairlineRule: View {
    let color: Color
    var vertical = false
    @Environment(\.displayScale) private var scale

    var body: some View {
        Rectangle().fill(color)
            .frame(width: vertical ? 1 / scale : nil, height: vertical ? nil : 1 / scale)
    }
}

/// A GFM table: columns as wide as their widest cell up to MarkdownTable.maxColumnWidth (longer
/// cells wrap), rows as tall as their tallest cell, scrolling sideways when wider than the screen.
/// `cells` are the rows' styled text, the header first (built at `fontSize`); `tints` optionally
/// colors whole rows by the same index (Show changes' added and removed rows).
private struct MarkdownTableView: View {
    let align: [Markdown.Align?]
    let cells: [[AttributedString]]
    var tints: [Color?] = []
    let style: MarkdownStyle

    @Environment(\.displayScale) private var scale
    private var c: Palette { style.palette }

    static func fontSize(_ style: MarkdownStyle) -> CGFloat { style.size - 1.5 }

    var body: some View {
        let all = cells
        let columns = all.first?.count ?? 0
        ScrollView(.horizontal) {
            MarkdownTableLayout(columns: columns) {
                ForEach(all.indices, id: \.self) { r in
                    ForEach(0..<columns, id: \.self) { j in
                        cell(j < all[r].count ? all[r][j] : AttributedString(), row: r, column: j, last: r == all.count - 1)
                    }
                }
            }
            .clipShape(.rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.border, lineWidth: 1 / scale))
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    private func cell(_ text: AttributedString, row: Int, column j: Int, last: Bool) -> some View {
        let fontSize = Self.fontSize(style)
        let a = j < align.count ? align[j] : nil
        let tint = row < tints.count ? tints[row] : nil
        return Text(text)
            .foregroundStyle(style.color)
            .lineSpacing((fontSize * 1.4).rounded() - fontSize * 1.2)
            .multilineTextAlignment(a == .center ? .center : a == .right ? .trailing : .leading)
            .textSelection(.enabled)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: a == .center ? .top : a == .right ? .topTrailing : .topLeading)
            .background(tint ?? (row == 0 ? c.bgSunken : .clear), in: .rect)
            .overlay(alignment: .leading) { if j > 0 { HairlineRule(color: c.border, vertical: true) } }
            .overlay(alignment: .bottom) { if !last { HairlineRule(color: c.border) } }
    }
}

/// Lays out `columns` × n cells (row-major) on MarkdownTable's grid.
struct MarkdownTableLayout: Layout {
    let columns: Int

    struct Grid {
        var widths: [CGFloat] = []
        var heights: [CGFloat] = []
    }

    func makeCache(subviews: Subviews) -> Grid { grid(subviews) }

    func updateCache(_ cache: inout Grid, subviews: Subviews) { cache = grid(subviews) }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Grid) -> CGSize {
        CGSize(width: cache.widths.reduce(0, +), height: cache.heights.reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Grid) {
        guard columns > 0 else { return }
        var y = bounds.minY
        for (r, h) in cache.heights.enumerated() {
            var x = bounds.minX
            for (j, w) in cache.widths.enumerated() {
                let i = r * columns + j
                guard i < subviews.count else { return }
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: w, height: h))
                x += w
            }
            y += h
        }
    }

    private func grid(_ subviews: Subviews) -> Grid {
        guard columns > 0 else { return Grid() }
        let rows = subviews.count / columns
        let cells = (0..<rows).map { r in (0..<columns).map { subviews[r * columns + $0] } }
        let natural = cells.map { $0.map { Double($0.sizeThatFits(.unspecified).width) } }
        let widths = MarkdownTable.columnWidths(natural, columns: columns)
        let heights = MarkdownTable.rowHeights(cells.map { row in
            row.enumerated().map { j, cell in Double(cell.sizeThatFits(ProposedViewSize(width: widths[j], height: nil)).height) }
        })
        return Grid(widths: widths.map { CGFloat($0) }, heights: heights.map { CGFloat($0) })
    }
}
