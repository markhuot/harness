import HarnessKit
import os
import SwiftUI

// Pieces the ticket screen shares with its tab bodies:
// the hero's collapse state, the scroll trackers a tab body attaches, the tab opener the Agents and
// Transcript slots use to open a sub-agent, and a wrapping row layout.

/// The ticket hero's disclosure, shared by every tab: in full (crumb, title, badges, actions) or
/// collapsed to its title line with a chevron (HeroDisclosure). Only the Spec opens it in full; a
/// forward scroll gesture on the tab body (HeroCollapse's rules) or another tab collapses it, and
/// only the chevron (`toggle`) expands it again. `measured` takes the hero's height.
///
/// The tab strip and pager are laid out as if the hero were gone, under it, and sit `distance`
/// lower (HeroSlide, a render-time offset); when the hero's height changes they slide there, and
/// the tab bodies keep the hero's room at their end (`distance` as a bottom inset). Moving them
/// through layout instead would re-lay out the tab body on every frame of the slide, which on a
/// long transcript dropped frames.
///
/// Only the hero, HeroSlide, PagerSlide and HeroRoom read its state, never the ticket screen's body:
/// a collapse runs in the middle of a scroll, and re-rendering the screen from there redrew every
/// tab body on the frame the slide starts.
@MainActor
@Observable
final class TicketDetailHeroCollapse {
    private(set) var expanded: Bool
    /// The hero's height: how far below it the tab strip and pager sit, and the room the tab bodies
    /// keep at their end. Changes at once.
    private(set) var distance: Double = 0
    /// The tab strip's offset, animated toward `distance` as the hero changes height.
    private(set) var stripOffset: Double = 0
    /// The slide is under way. A global frame read inside the sliding views moves with the slide's
    /// offset until it ends, so geometry the screen lays out from ignores readings until then.
    @ObservationIgnored private(set) var sliding = false
    /// The pager's paging scroll view (PagerYieldsToBackSwipe finds it), whose layer the slide runs on.
    @ObservationIgnored weak var pager: UIView?
    @ObservationIgnored private var state = HeroCollapse.shown
    @ObservationIgnored private var slides = 0

    private static let slideDuration = 0.22
    private static let slide = Animation.easeInOut(duration: slideDuration)

    init(expanded: Bool) { self.expanded = expanded }

    /// A scroll event from the tab body on screen: a forward gesture collapses the hero; nothing a
    /// scroll does expands it.
    func send(_ e: CollapseEvent) {
        let next = HeroCollapse.step(state, e, heroHeight: 0)
        let keep = HeroDisclosure.expanded(expanded, scrolledFrom: state, to: next)
        state = next
        if !keep { set(expanded: false) }
    }

    /// The chevron on the hero's title.
    func toggle() { set(expanded: !expanded) }

    /// Another tab is showing: any but the Spec collapses the hero.
    func moved(to tab: TicketTab) {
        if !HeroDisclosure.expanded(expanded, afterMovingTo: tab) { set(expanded: false) }
    }

    private func set(expanded value: Bool) {
        guard value != expanded else { return }
        // Instruments' Points of Interest: each toggle, to line up with the hitches around it.
        Self.signposter.emitEvent("Hero toggle", "\(value ? "expand" : "collapse")")
        // A fresh gesture has to scroll forward again before the hero collapses once more.
        state = HeroCollapse.shown
        withAnimation(Self.slide) { expanded = value }
    }

    func measured(_ height: Double) {
        guard height != distance else { return }
        let old = distance
        var instant = Transaction(animation: nil)
        instant.disablesAnimations = true
        withTransaction(instant) { distance = height }
        // The first measurement: nothing to slide from.
        guard old > 0 else {
            withTransaction(instant) { stripOffset = height }
            return
        }
        // The pager takes its new place at once (PagerSlide) and slides there on its layer, an
        // additive Core Animation the render server runs: moving it through SwiftUI instead
        // recomputed the geometry and hit testing of every view in the tab body on every frame,
        // which a long transcript couldn't keep up with. Additive, so a slide cut short by the next
        // change carries on from where it was.
        if let layer = pager?.layer {
            let slide = CABasicAnimation(keyPath: "transform.translation.y")
            slide.fromValue = old - height
            slide.toValue = 0.0
            slide.isAdditive = true
            slide.duration = Self.slideDuration
            // SwiftUI's easeInOut, so the pager keeps pace with the tab strip.
            slide.timingFunction = CAMediaTimingFunction(controlPoints: 0.42, 0, 0.58, 1)
            layer.add(slide, forKey: nil)
        }
        slides += 1
        let slide = slides
        sliding = true
        withAnimation(Self.slide, completionCriteria: .removed) {
            stripOffset = height
        } completion: { [weak self] in
            guard let self, slide == slides else { return }
            sliding = false
        }
    }

    private static let signposter = OSSignposter(subsystem: "com.markhuot.harness", category: .pointsOfInterest)
}

/// On the tab strip: `distance` lower, under the hero, sliding as the hero changes height. Only the
/// offset is interpolated, and only into a visual effect, so no frame of the slide lays anything
/// out. The strip is small; the pager below it slides on its layer instead (PagerSlide).
struct HeroSlide: ViewModifier {
    let hero: TicketDetailHeroCollapse

    func body(content: Content) -> some View {
        content.modifier(HeroSlideOffset(offset: hero.stripOffset))
    }
}

private struct HeroSlideOffset: ViewModifier, Animatable {
    var offset: Double

    nonisolated var animatableData: Double {
        get { offset }
        set { offset = newValue }
    }

    func body(content: Content) -> some View {
        let y = offset
        content.visualEffect { c, _ in c.offset(y: y) }
    }
}

/// On the pager: `distance` lower, changed at once (no SwiftUI animation); the hero collapse slides
/// it on its layer.
struct PagerSlide: ViewModifier {
    let hero: TicketDetailHeroCollapse

    func body(content: Content) -> some View {
        let y = hero.distance
        content.visualEffect { c, _ in c.offset(y: y) }
    }
}

/// On a tab page: its bottom inset, the composer's overlap plus the hero's room. The page sits
/// `distance` lower, so its last `distance` is below the screen.
struct HeroRoom: ViewModifier {
    let hero: TicketDetailHeroCollapse
    let overlap: CGFloat

    func body(content: Content) -> some View {
        content.safeAreaPadding(.bottom, overlap + hero.distance)
    }
}

extension BoardStore {
    /// `api`, or the "No connection" error a user action should surface (Actions.run/perform toast
    /// it) instead of silently doing nothing when the store has no HarnessClient.
    func connectedAPI() throws -> HarnessClient {
        guard let api else { throw HarnessAPIError(status: 0, message: "No connection", data: nil) }
        return api
    }
}

/// Opens a tab on the ticket screen that hosts the view (a sub-agent's `agent:<id>`, or back to
/// `agents`). Nil outside a ticket screen.
struct TicketDetailTabOpener: Sendable {
    let open: @MainActor @Sendable (TicketTab) -> Void

    @MainActor func callAsFunction(_ tab: TicketTab) { open(tab) }
}

/// The ticket screen's callbacks for its tab bodies (the tab opener, the annotation sink, the
/// annotator opener), made once and kept for the screen's life. Closures never compare equal, so
/// fresh ones on each render would redraw every view that reads them: a transcript row, the spec's
/// markdown. These call through to whatever the screen set last (`update`), so they stay current.
@MainActor
final class TicketDetailRelay {
    private var onTab: (TicketTab) -> Void = { _ in }
    private var annotate: (AnnotationRequest) -> Void = { _ in }
    private var focusComposer: () -> Void = {}
    private var cachedSink: (holder: ObjectIdentifier, sink: AnnotationSink)?
    private var tabs: [TicketTab] = []
    private var shown: TicketTab?

    func update(onTab: @escaping (TicketTab) -> Void,
                annotate: @escaping (AnnotationRequest) -> Void, focusComposer: @escaping () -> Void,
                tabs: [TicketTab], shown: TicketTab) {
        self.onTab = onTab
        self.annotate = annotate
        self.focusComposer = focusComposer
        self.tabs = tabs
        self.shown = shown
    }

    /// Next Tab (1) and Previous Tab (-1), round the ends (Tabs.nextTab), for ⇧⌘] and ⇧⌘[ (WindowShortcuts).
    func step(_ delta: Int) {
        guard tabs.count > 1, let shown, let t = Tabs.nextTab(tabs, current: shown, delta: delta) else { return }
        onTab(t)
    }

    private(set) lazy var tabOpener = TicketDetailTabOpener { [weak self] t in
        self?.onTab(t)
    }

    private(set) lazy var annotatorOpener = AnnotatorOpener { [weak self] in self?.annotate($0) }

    /// Annotated images join the next message, their notes on the attachment itself (a file already
    /// waiting there is edited in place), never sent on their own; the field takes focus so the
    /// human can say why.
    func sink(outgoing: MessageAttachments, uploader: PromptAttachmentUploader, toasts: ToastCenter) -> AnnotationSink {
        if let cachedSink, cachedSink.holder == ObjectIdentifier(outgoing) { return cachedSink.sink }
        let sink = AnnotationSink(current: { a in
            outgoing.list.first { $0.id == a.id }?.annotation
        }, add: { [weak self] added in
            guard outgoing.annotate(added.attachment, annotation: added.annotation) else {
                haptic(.warning)
                toasts.show(PromptAttachments.limitMessage(skipped: 1, holder: .message), kind: .error)
                return
            }
            if let data = added.uploaded { Task { await uploader.keepUploaded(data, for: added.attachment) } }
            self?.focusComposer()
        })
        cachedSink = (ObjectIdentifier(outgoing), sink)
        return sink
    }
}

extension EnvironmentValues {
    /// The hero collapse of the ticket screen around a tab body; nil elsewhere.
    @Entry var ticketDetailHero: TicketDetailHeroCollapse?
    /// `openTab(Tabs.subagentTabRoute(id))` from inside a ticket tab body.
    @Entry var ticketDetailOpenTab: TicketDetailTabOpener?
    /// Where an image annotated inside a ticket goes: its composer's attachments (AnnotatorView).
    /// nil outside a ticket, where nothing offers Annotate unless it says where the image goes.
    @Entry var annotationSink: AnnotationSink?
    /// Opens the annotator over the ticket (TicketDetailBody presents it).
    @Entry var openAnnotator: AnnotatorOpener?
    /// The ticket's spec media (TicketDetail.attachments) that `attachment:<id>` in its markdown
    /// refers to, so the viewer and the annotator get each one's own record. nil outside a ticket,
    /// or from an older service.
    @Entry var specAttachments: [Attachment]?
}

/// Takes an annotated image into the ticket's composer (the message being written), never
/// sending anything itself.
struct AnnotationSink: Sendable {
    /// The notes the composer already holds on an attachment, so annotating it again edits them.
    let current: @MainActor @Sendable (Attachment) -> AttachmentAnnotation?
    let add: @MainActor @Sendable (AnnotatedAttachment) -> Void

    /// Annotate `image`, the notes going on `file` in the composer. Starts from the composer's notes
    /// on that file, else `annotation` (the notes it was sent with), so they can be edited.
    @MainActor func request(
        _ file: AnnotationImage, image: UIImage, page: AnnotationPage? = nil, lookup: AnnotationElementLookup? = nil, annotation: AttachmentAnnotation? = nil
    ) -> AnnotationRequest {
        let existing: AttachmentAnnotation? = if case let .existing(a) = file { current(a) } else { nil }
        return AnnotationRequest(file: file, image: image, page: existing?.page ?? annotation?.page ?? page, lookup: lookup, annotation: existing ?? annotation, add: add)
    }
}

struct AnnotatorOpener: Sendable {
    let open: @MainActor @Sendable (AnnotationRequest) -> Void

    @MainActor func callAsFunction(_ request: AnnotationRequest) { open(request) }
}

extension View {
    /// On a tab body's ScrollView or List: a forward drag or fling collapses the ticket hero; nothing
    /// a scroll does expands it. Does nothing outside a ticket screen.
    func ticketHeroScroll() -> some View { modifier(TicketDetailHeroScroll()) }

    /// On a ScrollView whose newest content is last: opens at the bottom,
    /// follows new content while the user is at the bottom, stays put once they scroll up, and
    /// follows again when they come back down.
    func ticketStickToBottom() -> some View { modifier(TicketDetailStickToBottom()) }
}

private func scrollMetrics(_ g: ScrollGeometry) -> ScrollMetrics {
    ScrollMetrics(contentOffsetY: g.contentOffset.y, contentHeight: g.contentSize.height, containerHeight: g.containerSize.height,
                  topInset: g.contentInsets.top, bottomInset: g.contentInsets.bottom)
}

private func scrollPhase(_ p: ScrollPhase) -> StickScrollPhase {
    switch p {
    case .idle: .idle
    case .tracking: .tracking
    case .interacting: .interacting
    case .decelerating: .decelerating
    case .animating: .animating
    @unknown default: .idle
    }
}

/// What a scroll tracker remembers between callbacks. A plain class, not @State values: these
/// change on every scrolled frame and nothing draws from them, so writing them mustn't update the view.
private final class ScrollTrack<Value> {
    var metrics = ScrollMetrics(offset: 0, contentHeight: 0, viewportHeight: 0)
    var value: Value

    init(_ value: Value) { self.value = value }
}

private struct TicketDetailHeroScroll: ViewModifier {
    @Environment(\.ticketDetailHero) private var hero
    @State private var track = ScrollTrack(())

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: ScrollMetrics.self, of: scrollMetrics) { _, m in
                track.metrics = m
                hero?.send(.scroll(m))
            }
            .onScrollPhaseChange { old, new in
                for e in HeroCollapse.events(from: scrollPhase(old), to: scrollPhase(new), metrics: track.metrics) { hero?.send(e) }
            }
    }
}

private struct TicketDetailStickToBottom: ViewModifier {
    @State private var track = ScrollTrack(StickToBottom.stuck)
    @State private var position = ScrollPosition(edge: .bottom)

    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: ScrollMetrics.self, of: scrollMetrics) { old, m in
                track.metrics = m
                apply(.scroll(m))
                // Content grew or shrank, or the viewport changed (the hero, the keyboard).
                if old.contentHeight != m.contentHeight || old.viewportHeight != m.viewportHeight { apply(.resize) }
            }
            .onScrollPhaseChange { old, new in
                for e in StickToBottom.events(from: scrollPhase(old), to: scrollPhase(new), metrics: track.metrics) { apply(e) }
            }
    }

    private func apply(_ e: StickEvent) {
        let step = StickToBottom.stickStep(track.value, e)
        track.value = step.stick
        if step.follow { position.scrollTo(edge: .bottom) }
    }
}

