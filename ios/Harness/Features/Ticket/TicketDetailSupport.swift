import HarnessKit
import SwiftUI

// Pieces the ticket screen shares with its tab bodies:
// the hero's collapse state, the scroll trackers a tab body attaches, the tab opener the Agents and
// Transcript slots use to open a sub-agent, and a wrapping row layout.

/// The ticket hero's collapse: HeroCollapse's rules fed by the tab body's
/// scroll gestures. `show()` brings it back (another tab, news on the ticket); `measured` takes the
/// hero's height while it's shown, which is how much room hiding it gives the tab body.
///
/// A toggle changes the layout once, without animation (`hidden`), and animates only `progress`,
/// which HeroSlide turns into a render-time offset of the tab strip and pager. Animating the hero's
/// frame instead re-lays out the pager and the tab body's scroll view on every frame, which drops
/// frames on a long spec.
@MainActor
@Observable
final class TicketDetailHeroCollapse {
    /// The hero takes no room: changes at once.
    private(set) var hidden = false
    /// 1 hidden, 0 shown, animated between them: how far the slide has gone.
    private(set) var progress: Double = 0
    /// How far the tab strip slides: the hero's height when it last toggled.
    private(set) var distance: Double = 0
    @ObservationIgnored private var state = HeroCollapse.shown
    @ObservationIgnored private var heroHeight: Double = 0

    func send(_ e: CollapseEvent) {
        let next = HeroCollapse.step(state, e, heroHeight: heroHeight)
        state = next
        guard next.hidden != hidden else { return }
        var instant = Transaction(animation: nil)
        instant.disablesAnimations = true
        withTransaction(instant) {
            hidden = next.hidden
            distance = heroHeight
        }
        withAnimation(.easeInOut(duration: 0.22)) { progress = next.hidden ? 1 : 0 }
    }

    func show() { send(.show) }

    func measured(_ height: Double) {
        if !state.hidden { heroHeight = height }
    }
}

/// On the tab strip and pager under the hero: keeps them where they were drawn when the hero's
/// room appears or goes at once, then slides them the rest of the way as `progress` animates. Only
/// `progress` is interpolated, and only into a visual effect, so no frame of the slide lays
/// anything out.
struct HeroSlide: ViewModifier, Animatable {
    var progress: Double
    let hidden: Bool
    let distance: Double

    nonisolated var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func body(content: Content) -> some View {
        // Hidden: the layout moved up `distance`, so start that far down. Shown: it moved down, so
        // start that far up.
        let y = distance * ((hidden ? 1 : 0) - progress)
        content.visualEffect { c, _ in c.offset(y: y) }
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

