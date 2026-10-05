import HarnessKit
import os
import SwiftUI

// Pieces the ticket screen shares with its tab bodies:
// the hero's collapse state, the scroll trackers a tab body attaches, the tab opener the Agents and
// Transcript slots use to open a sub-agent, and a wrapping row layout.

/// The ticket hero's collapse: HeroCollapse's rules fed by the tab body's
/// scroll gestures. `show()` brings it back (another tab, news on the ticket); `measured` takes the
/// hero's height while it's shown.
///
/// Hiding or showing the hero changes no layout. The tab strip and pager are always laid out as if
/// the hero were gone, under it, and sit `distance` lower while it shows (HeroSlide, a render-time
/// offset); a toggle animates only that offset, and the tab bodies keep the hero's room at their
/// end (`distance` as a bottom inset). Changing the layout instead re-laid out the tab body twice
/// per toggle, as the slide started and as it ended, which on a long transcript dropped frames.
///
/// Only TicketHeroSlot, HeroSlide and HeroRoom read its state, never the ticket screen's body: a
/// toggle runs in the middle of a scroll, and re-rendering the screen from there redrew every tab
/// body on the frame the slide starts.
@MainActor
@Observable
final class TicketDetailHeroCollapse {
    private(set) var hidden = false
    /// 1 hidden, 0 shown, animated between them: how far the slide has gone.
    private(set) var progress: Double = 0
    /// The hero's height (while it last showed): how far below it the tab strip sits while it shows,
    /// and the room the tab bodies keep at their end.
    private(set) var distance: Double = 0
    /// The slide is under way. A global frame read inside the sliding views moves with the slide's
    /// offset until it ends, so geometry the screen lays out from ignores readings until then.
    @ObservationIgnored private(set) var sliding = false
    @ObservationIgnored private var state = HeroCollapse.shown
    @ObservationIgnored private var slides = 0

    func send(_ e: CollapseEvent) {
        let next = HeroCollapse.step(state, e, heroHeight: distance)
        state = next
        guard next.hidden != hidden else { return }
        // Instruments' Points of Interest: each toggle, to line up with the hitches around it.
        Self.signposter.emitEvent("Hero toggle", "\(next.hidden ? "hide" : "show")")
        var instant = Transaction(animation: nil)
        instant.disablesAnimations = true
        withTransaction(instant) { hidden = next.hidden }
        slides += 1
        let slide = slides
        sliding = true
        withAnimation(.easeInOut(duration: 0.22), completionCriteria: .removed) {
            progress = next.hidden ? 1 : 0
        } completion: { [weak self] in
            guard let self, slide == slides else { return }
            sliding = false
        }
    }

    func show() { send(.show) }

    func measured(_ height: Double) {
        guard !state.hidden, height != distance else { return }
        var instant = Transaction(animation: nil)
        instant.disablesAnimations = true
        withTransaction(instant) { distance = height }
    }

    /// Where the tab strip and pager sit below their layout once a slide is over.
    var restingOffset: Double { hidden ? 0 : distance }

    private static let signposter = OSSignposter(subsystem: "com.markhuot.harness", category: .pointsOfInterest)
}

/// On the hero: hidden, it keeps drawing under the tab strip and pager, which cover it (HeroSlide),
/// but takes no taps and is out of VoiceOver.
struct TicketHeroSlot: ViewModifier {
    let hero: TicketDetailHeroCollapse

    func body(content: Content) -> some View {
        content
            .allowsHitTesting(!hero.hidden)
            .accessibilityHidden(hero.hidden)
    }
}

/// On the tab strip and pager: `distance` lower while the hero shows, sliding up over it as it
/// hides. Only `progress` is interpolated, and only into a visual effect, so no frame of the slide
/// lays anything out.
struct HeroSlide: ViewModifier {
    let hero: TicketDetailHeroCollapse

    func body(content: Content) -> some View {
        content.modifier(HeroSlideOffset(progress: hero.progress, distance: hero.distance))
    }
}

private struct HeroSlideOffset: ViewModifier, Animatable {
    var progress: Double
    let distance: Double

    nonisolated var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Content) -> some View {
        let y = distance * (1 - progress)
        content.visualEffect { c, _ in c.offset(y: y) }
    }
}

/// On a tab page: its bottom inset, the composer's overlap plus the hero's room. While the hero
/// shows, the page sits `distance` lower, so its last `distance` is below the screen; keeping that
/// room at the end at all times means a toggle changes no inset (and lays nothing out).
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
    private var hero: TicketDetailHeroCollapse?
    private var onTab: (TicketTab) -> Void = { _ in }
    private var annotate: (AnnotationRequest) -> Void = { _ in }
    private var focusComposer: () -> Void = {}
    private var cachedSink: (holder: ObjectIdentifier, sink: AnnotationSink)?

    func update(hero: TicketDetailHeroCollapse, onTab: @escaping (TicketTab) -> Void,
                annotate: @escaping (AnnotationRequest) -> Void, focusComposer: @escaping () -> Void) {
        self.hero = hero
        self.onTab = onTab
        self.annotate = annotate
        self.focusComposer = focusComposer
    }

    private(set) lazy var tabOpener = TicketDetailTabOpener { [weak self] t in
        self?.hero?.show()
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
    /// On a tab body's ScrollView or List: its drags and flings hide and bring back the ticket hero.
    /// Does nothing outside a ticket screen.
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

