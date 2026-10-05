import HarnessKit
import SwiftUI
import UIKit

/// The file an annotation goes on: an attachment the service already has (a spec image, a prompt
/// or message attachment, a file waiting in a composer or New session), or a browser screenshot,
/// uploaded as it is once Add is pressed.
enum AnnotationImage {
    case existing(Attachment)
    case upload(data: Data, name: String, mimeType: String)

    /// The header's file name.
    var name: String {
        switch self {
        case let .existing(a): a.name
        case let .upload(_, name, _): name
        }
    }
}

/// Where a browser screenshot's marks look up the element under their anchor
/// (POST /browser/:sessionId/element): the session and what the screenshot was of.
struct AnnotationElementLookup {
    let sessionId: String
    let tabId: Int
    let url: String
    let scroll: BrowserScroll
    let viewport: AnnotationViewport
    /// Device pixels per CSS pixel: the screenshot's pixels over the page's.
    let scale: Double

    /// nil for an older service's screenshot (no scroll), which can't look elements up.
    init?(sessionId: String, screenshot shot: BrowserScreenshot) {
        guard let scroll = shot.scroll, shot.scale > 0 else { return nil }
        self.sessionId = sessionId
        tabId = shot.tabId
        url = shot.url
        self.scroll = scroll
        viewport = shot.viewport
        scale = shot.scale
    }

    /// The query for a mark's anchor (a fraction of the `width`×`height` screenshot), in the page's CSS pixels.
    func query(_ anchor: Annotations.Point, width: Double, height: Double) -> BrowserElementQuery {
        BrowserElementQuery(tabId: tabId, x: anchor.x * width / scale, y: anchor.y * height / scale, url: url, scroll: scroll, viewport: viewport)
    }
}

/// An image to annotate, which file the notes go on, and what takes them: the ticket's composer, or
/// a New session. `marks` reopens an earlier annotation to edit it (the image is never changed, so
/// they sit where they were drawn).
struct AnnotationRequest: Identifiable {
    let id = UUID()
    let file: AnnotationImage
    let image: UIImage
    /// The page a browser screenshot shows (AttachmentAnnotation.page).
    var page: AnnotationPage?
    /// A browser screenshot's element lookups (each mark names the element under its anchor).
    var lookup: AnnotationElementLookup?
    var marks: [Annotations.DraftMark] = []
    /// Takes the file and its notes once Add has them.
    let add: @MainActor (AnnotatedAttachment) -> Void

    init(file: AnnotationImage, image: UIImage, page: AnnotationPage? = nil, lookup: AnnotationElementLookup? = nil,
         annotation: AttachmentAnnotation? = nil, add: @escaping @MainActor (AnnotatedAttachment) -> Void) {
        self.file = file
        self.image = image
        self.page = page
        // Only a browser screenshot's marks name elements.
        self.lookup = page == nil ? nil : lookup
        self.marks = annotation.map(Annotations.draftMarks(from:)) ?? []
        self.add = add
    }
}

/// What Add hands back: the attachment (the service's record, by id) and its notes, with the bytes
/// it uploaded (a browser screenshot) so the list can draw them before the service's copy loads.
struct AnnotatedAttachment {
    let attachment: Attachment
    let annotation: AttachmentAnnotation
    var uploaded: Data?
}

/// Full-screen annotator (DESIGN.md "Annotations"). The image is fitted at the top (iPhone) or on
/// the left (iPad at regular width); a press on it sets an anchor and dragging pulls out an arrow
/// whose head points at the anchor, with the number where the drag ended; a plain tap makes a
/// numbered anchor. Pressing a badge (or an arrow's head) drags that mark instead. Only the arrows
/// and badges draw over the image: each number's note is a field in the list below it (iPhone) or
/// beside it (iPad), never on top, with × to delete it (the ones after it renumber). Undo takes back
/// the last add, move or delete. Annotations never message the agent themselves, and never change
/// the image: Add hands the file back with its notes as metadata (AttachmentAnnotation, in the
/// image's pixels), to wait in a composer or a New session beside the human's own words. Only a
/// browser screenshot is uploaded then, as it is. Cancel asks before throwing away changed marks.
struct AnnotatorView: View {
    let request: AnnotationRequest
    /// Closes the annotator, with the file and its notes once Add went through (nil: cancelled).
    let onClose: (_ added: AnnotatedAttachment?) -> Void

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var marks: [Annotations.DraftMark]
    @State private var history: [[Annotations.DraftMark]] = []
    @State private var adding = false
    @State private var confirm: Confirmation?
    @State private var gesture: AnnotatorGesture?
    /// Anchors the page answered no element for (or whose lookup failed): not asked again.
    @State private var settled: Set<Annotations.Point> = []
    @FocusState private var focused: Int?

    init(request: AnnotationRequest, onClose: @escaping (_ added: AnnotatedAttachment?) -> Void) {
        self.request = request
        self.onClose = onClose
        _marks = State(initialValue: request.marks)
    }

    /// Something worth asking about before Cancel throws it away.
    private var changed: Bool { marks != request.marks }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(c.border)
            GeometryReader { geo in
                if sizeClass == .regular && geo.size.width > geo.size.height * 0.9 {
                    HStack(spacing: 0) {
                        stage
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        Divider().overlay(c.border)
                        notes
                            .frame(width: min(380, geo.size.width * 0.4))
                    }
                } else {
                    VStack(spacing: 0) {
                        stage
                            .frame(height: stageHeight(geo.size))
                        Divider().overlay(c.border)
                        notes
                    }
                }
            }
        }
        .background(c.bg.ignoresSafeArea())
        .confirmation($confirm)
        .toastOverlay()
        .interactiveDismissDisabled(changed || adding)
        .task(id: pendingLookups) { await lookUpElements(pendingLookups) }
    }

    // MARK: Elements (browser screenshots)

    /// The marks whose element is still to look up, with their anchors (the task's identity: a
    /// placed or moved anchor starts it over, so the latest wins).
    private var pendingLookups: [PendingLookup] {
        guard request.lookup != nil else { return [] }
        return Annotations.marksNeedingElement(marks, settled: settled).map { PendingLookup(index: $0, anchor: marks[$0].anchor) }
    }

    /// After a short pause (a drag that keeps going cancels it), ask the page what's under each
    /// anchor and keep it on the mark that's still there. Failures leave the mark without one.
    private func lookUpElements(_ pending: [PendingLookup]) async {
        guard let lookup = request.lookup, !pending.isEmpty, let api = store.api else { return }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        let px = AnnotationDrawing.pixelSize(request.image)
        for p in pending {
            let element = try? await api.browserElementAt(lookup.sessionId, lookup.query(p.anchor, width: px.width, height: px.height))
            guard !Task.isCancelled else { return }
            if let element {
                marks = Annotations.resolveElement(marks, at: p.index, anchor: p.anchor, element)
            } else {
                settled.insert(p.anchor)
            }
        }
    }

    /// On a phone the image takes up to 55% of the height, less when the image is wide.
    private func stageHeight(_ size: CGSize) -> CGFloat {
        let px = AnnotationDrawing.pixelSize(request.image)
        let fitted = px.width > 0 ? size.width * px.height / px.width : size.height
        return max(160, min(size.height * 0.55, fitted + 24))
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            Button("Cancel") { cancel() }
                .font(.scaled(size: 16))
                .foregroundStyle(c.accentText)
                .disabled(adding)
                .keyboardShortcut(.cancelAction)
            VStack(spacing: 1) {
                Text("Annotate").font(.scaled(size: 15, weight: .semibold)).foregroundStyle(c.text)
                Text(request.file.name)
                    .font(.scaled(size: 12))
                    .foregroundStyle(c.text3)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity)
            Button {
                haptic(.tap)
                undo()
            } label: {
                Image(systemName: "arrow.uturn.backward")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .foregroundStyle(history.isEmpty || adding ? c.text3 : c.text2)
            .disabled(history.isEmpty || adding)
            // ⌘Z, unless a note is being typed: then it's the field's own undo.
            .keyboardShortcut(focused == nil ? KeyboardShortcut("z") : nil)
            .accessibilityLabel("Undo")
            Button { add() } label: {
                Group {
                    if adding {
                        ProgressView().tint(c.onAccent)
                    } else {
                        Text("Add").font(.scaled(size: 15, weight: .semibold))
                    }
                }
                .frame(minWidth: 52, minHeight: 22)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(c.accent)
            .disabled(marks.isEmpty || adding)
            .submitShortcut()
            .accessibilityLabel("Add")
            .accessibilityHint(marks.isEmpty ? "Add a note first" : "Adds the image with its notes to your message")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(c.bgElev)
    }

    // MARK: Image

    private var stage: some View {
        GeometryReader { geo in
            let px = AnnotationDrawing.pixelSize(request.image)
            // Fitted to the stage, but never blown up past one point per pixel (like the Mac's 1:1 cap).
            let box = CGSize(width: max(0, geo.size.width - 24), height: max(0, geo.size.height - 24))
            let fit = Format.fitRect(boxW: min(box.width, px.width), boxH: min(box.height, px.height), w: px.width, h: px.height)
                .centered(in: box, from: CGSize(width: min(box.width, px.width), height: min(box.height, px.height)))
            let size = CGSize(width: fit.w, height: fit.h)
            ZStack(alignment: .topLeading) {
                Image(uiImage: request.image)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: size.width, height: size.height)
                    .accessibilityHidden(true)
                AnnotationOverlay(marks: shown, accent: c.accent)
                    .frame(width: size.width, height: size.height)
                BrowserTouchSurface(
                    enabled: !adding,
                    began: { p, _ in began(p, size: size) },
                    moved: { p, _ in moved(p, size: size) },
                    ended: { p, _ in ended(p, size: size) },
                    cancelled: { gesture = nil })
                    .frame(width: size.width, height: size.height)
                    .accessibilityElement()
                    .accessibilityLabel("Image. Tap to add a numbered note, or drag to point an arrow at something.")
                    .accessibilityValue(Annotations.notesLabel(marks.count))
            }
            .frame(width: size.width, height: size.height)
            .clipShape(Rectangle())
            .overlay(Rectangle().strokeBorder(c.border, lineWidth: 0.5))
            .offset(x: fit.x + 12, y: fit.y + 12)
        }
        .background(c.bgSunken)
    }

    /// The marks with the one being drawn or dragged.
    private var shown: [Annotations.DraftMark] {
        switch gesture {
        case let .drawing(anchor, _, tail?):
            return marks + [Annotations.DraftMark(anchor: anchor, tail: tail)]
        case let .drawing(anchor, _, nil):
            return marks + [Annotations.DraftMark(anchor: anchor)]
        case let .moving(_, _, current):
            return current
        case nil:
            return marks
        }
    }

    private func unit(_ p: CGPoint, _ size: CGSize) -> Annotations.Point {
        Annotations.toUnit(Annotations.Point(x: p.x, y: p.y), width: size.width, height: size.height)
    }

    private func began(_ p: CGPoint, size: CGSize) {
        focused = nil
        let style = Annotations.style(width: size.width, height: size.height)
        if let hit = Annotations.hitTest(marks, Annotations.Point(x: p.x, y: p.y), width: size.width, height: size.height, style: style) {
            gesture = .moving(hit, start: p, current: marks)
            return
        }
        guard Annotations.canAdd(marks) else {
            haptic(.warning)
            return
        }
        gesture = .drawing(anchor: unit(p, size), start: p, tail: nil)
    }

    private func moved(_ p: CGPoint, size: CGSize) {
        switch gesture {
        case let .drawing(anchor, start, _):
            let drag = Annotations.isDrag(Annotations.Point(x: start.x, y: start.y), Annotations.Point(x: p.x, y: p.y))
            gesture = .drawing(anchor: anchor, start: start, tail: drag ? unit(p, size) : nil)
        case let .moving(hit, start, _):
            gesture = .moving(hit, start: start, current: Annotations.move(marks, hit, to: unit(p, size)))
        case nil:
            break
        }
    }

    private func ended(_ p: CGPoint, size: CGSize) {
        defer { gesture = nil }
        switch gesture {
        case let .drawing(anchor, start, _):
            let drag = Annotations.isDrag(Annotations.Point(x: start.x, y: start.y), Annotations.Point(x: p.x, y: p.y))
            change(marks + [Annotations.DraftMark(anchor: anchor, tail: drag ? unit(p, size) : nil)])
            haptic(.tap)
        case let .moving(hit, start, _):
            // A press on a badge that never moved leaves it alone (and focuses its note).
            if Annotations.isDrag(Annotations.Point(x: start.x, y: start.y), Annotations.Point(x: p.x, y: p.y)) {
                change(Annotations.move(marks, hit, to: unit(p, size)))
            } else {
                focused = hit.index
            }
        case nil:
            break
        }
    }

    /// Replace the marks, remembering the old ones for Undo.
    private func change(_ next: [Annotations.DraftMark]) {
        history = Annotations.pushHistory(history, marks)
        marks = next
    }

    private func undo() {
        guard let last = history.popLast() else { return }
        // Undo restores where the marks were, but keeps the notes typed since for marks still there.
        marks = last.enumerated().map { i, m in
            var out = m
            if i < marks.count, marks[i].anchor == m.anchor || (m.tail != nil && marks[i].tail == m.tail) { out.message = marks[i].message }
            return out
        }
    }

    // MARK: Notes

    private var notes: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if marks.isEmpty {
                        Text("Tap the image to add a numbered note, or drag to point an arrow at something. Add puts the image in your message, where you can say more before sending.")
                            .font(.scaled(size: 14))
                            .foregroundStyle(c.text3)
                            .padding(.vertical, 6)
                    }
                    ForEach(Array(marks.enumerated()), id: \.offset) { i, _ in
                        markRow(i).id(i)
                    }
                }
                .padding(14)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: marks.count) { old, new in
                guard new > old else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(new - 1, anchor: .bottom) }
            }
        }
        .background(c.bg)
    }

    private func markRow(_ i: Int) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(i + 1)")
                .font(.scaled(size: 13, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(c.accent, in: .circle)
                .overlay(Circle().strokeBorder(.white, lineWidth: 1.5))
                .padding(.top, 5)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
            TextField("What about this spot?", text: Binding(
                get: { marks.indices.contains(i) ? marks[i].message : "" },
                set: { v in if marks.indices.contains(i) { marks = Annotations.setMessage(marks, at: i, Annotations.clampMessage(v)) } }
            ), axis: .vertical)
                .font(.scaled(size: 15))
                .foregroundStyle(c.text)
                .lineLimit(1...5)
                .focused($focused, equals: i)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(c.bgSunken, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(focused == i ? c.accent : c.border, lineWidth: focused == i ? 1 : 0.5))
                .accessibilityLabel("Note \(i + 1)")
                .disabled(adding)
                if let element = marks.indices.contains(i) ? marks[i].element : nil {
                    Text(Annotations.elementLabel(element))
                        .font(.scaled(size: 11.5, design: .monospaced))
                        .foregroundStyle(c.text3)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .padding(.horizontal, 4)
                        .accessibilityLabel("Points at \(Annotations.elementLabel(element))")
                }
            }
            Button {
                haptic(.tap)
                if focused == i { focused = nil }
                change(Annotations.remove(marks, at: i))
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(c.text3)
                    .frame(width: 30, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(adding)
            .accessibilityLabel("Delete note \(i + 1)")
        }
    }

    // MARK: Actions

    private func cancel() {
        guard changed else {
            onClose(nil)
            return
        }
        confirm = Confirmation(title: "Discard these notes?", message: "The marks and notes on this image will be lost.", action: "Discard") {
            onClose(nil)
        }
    }

    /// Hand the file back with its notes, in the image's pixels. A browser screenshot is uploaded
    /// first, as it is. Nothing is sent to the agent.
    private func add() {
        guard !marks.isEmpty, !adding else { return }
        focused = nil
        adding = true
        let file = request.file
        let px = AnnotationDrawing.pixelSize(request.image)
        let annotation = AttachmentAnnotation(
            width: px.width, height: px.height,
            marks: Annotations.marksForMessage(marks, width: px.width, height: px.height),
            page: request.page
        )
        Task {
            let result = await actions.run { () async throws -> AnnotatedAttachment in
                switch file {
                case let .existing(a):
                    return AnnotatedAttachment(attachment: a, annotation: annotation)
                case let .upload(data, name, mimeType):
                    let a = try await store.connectedAPI().uploadAttachment(data: data, name: name, mimeType: mimeType)
                    return AnnotatedAttachment(attachment: a, annotation: annotation, uploaded: data)
                }
            }
            adding = false
            if let result {
                haptic(.success)
                onClose(result)
            }
        }
    }
}

private extension Format.Rect {
    /// This rect (fitted into `inner`) re-centered in the larger `box`.
    func centered(in box: CGSize, from inner: CGSize) -> Format.Rect {
        Format.Rect(x: x + (box.width - inner.width) / 2, y: y + (box.height - inner.height) / 2, w: w, h: h)
    }
}

/// A mark waiting for the element under its anchor.
private struct PendingLookup: Hashable {
    let index: Int
    let anchor: Annotations.Point
}

/// What a press on the image is doing: drawing a new mark (`tail` once it's a drag) or moving one.
private enum AnnotatorGesture {
    case drawing(anchor: Annotations.Point, start: CGPoint, tail: Annotations.Point?)
    case moving(Annotations.MarkHit, start: CGPoint, current: [Annotations.DraftMark])
}

/// Presents the annotator. On Add the request's `add` takes the file and its notes, then `then` runs
/// (e.g. to close the viewer it was opened from).
struct AnnotatorPresenter: ViewModifier {
    @Binding var request: AnnotationRequest?
    var then: (() -> Void)?

    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        content.fullScreenCover(item: $request) { r in
            AnnotatorView(request: r) { added in
                request = nil
                guard let added else { return }
                r.add(added)
                then?()
            }
            // The app's appearance, even over the attachment viewer (which is always dark).
            .preferredColorScheme(scheme)
        }
    }

    /// The app's theme setting, else the system's (not the presenting view's, which the viewer forces dark).
    private var scheme: ColorScheme {
        switch app.prefs.theme {
        case .dark: return .dark
        case .light: return .light
        default:
            let screen = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.screen }.first
            return screen?.traitCollection.userInterfaceStyle == .dark ? .dark : .light
        }
    }
}

extension View {
    func annotator(_ request: Binding<AnnotationRequest?>, then: (() -> Void)? = nil) -> some View {
        modifier(AnnotatorPresenter(request: request, then: then))
    }
}
